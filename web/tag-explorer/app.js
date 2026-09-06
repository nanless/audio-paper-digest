(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else { root.TaxonomyExplorer = api; api.mount(root.document, root.fetch.bind(root)); }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const VERSION = 'paper-taxonomy-preview-v1';
    const SHA = /^[a-f0-9]{64}$/;
    const FACETS = { task: '任务', method: '方法', setting: '条件', signal: '研究信号',
        application: '应用', research_focus: '研究重点', artifact: '产物',
        scientific_topic: '科学主题', model_family: '模型族' };
    const norm = value => value.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
    function requireValue(ok, message) { if (!ok) throw new Error('索引数据无效：' + message); }
    function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
    function strings(value) { return Array.isArray(value) && value.every(v => typeof v === 'string' && v.trim()); }
    function valueText(value) { return typeof value === 'string' ? value : JSON.stringify(value); }
    function safePaperUrl(value) {
        if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value) || /%2e|%2f|%5c/i.test(value)) return null;
        try {
            const url = new URL(value);
            if (url.protocol !== 'https:' || url.hostname !== 'nanless.github.io' || url.port
                || url.username || url.password || !url.pathname.startsWith('/audio-paper-digest-blog/')) return null;
            return url.href;
        } catch (_) { return null; }
    }
    function validateIndex(data) {
        requireValue(object(data) && data.version === VERSION, '版本不受支持');
        requireValue(typeof data.taxonomyVersion === 'string' && data.taxonomyVersion.trim()
            && SHA.test(data.registrySha256 || ''), '词表版本或 SHA 缺失');
        requireValue(object(data.source) && object(data.summary), '来源摘要缺失');
        requireValue(Array.isArray(data.concepts) && Array.isArray(data.papers), '概念或论文不是数组');
        const byId = new Map();
        for (const c of data.concepts) {
            requireValue(object(c) && typeof c.id === 'string' && c.id.trim() && !byId.has(c.id), '概念 ID 无效或重复');
            requireValue(typeof c.facet === 'string' && Object.hasOwn(FACETS, c.facet) && object(c.preferredLabel)
                && typeof c.preferredLabel.zh === 'string' && c.preferredLabel.zh.trim()
                && typeof c.preferredLabel.en === 'string' && c.preferredLabel.en.trim()
                && strings(c.aliases) && (c.broaderId == null || typeof c.broaderId === 'string'), '概念标签无效');
            byId.set(c.id, c);
        }
        const ancestors = new Map();
        function chain(id, visiting = new Set()) {
            if (ancestors.has(id)) return ancestors.get(id);
            requireValue(!visiting.has(id), '概念层级包含循环');
            visiting.add(id); const c = byId.get(id); const result = new Set([id]);
            if (c.broaderId) {
                const parent = byId.get(c.broaderId);
                requireValue(parent && parent.facet === c.facet, '父概念缺失或跨分面');
                for (const parentId of chain(parent.id, visiting)) result.add(parentId);
            }
            visiting.delete(id); ancestors.set(id, result); return result;
        }
        for (const id of byId.keys()) chain(id);
        const recordIds = new Set();
        const papers = data.papers.map(p => {
            requireValue(object(p) && typeof p.recordId === 'string' && p.recordId.trim()
                && !recordIds.has(p.recordId), '论文记录 ID 缺失或重复');
            recordIds.add(p.recordId);
            requireValue((p.id === null || typeof p.id === 'string') && typeof p.title === 'string' && p.title.trim()
                && typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date)
                && Number.isFinite(Date.parse(p.date)) && new Date(p.date).toISOString().slice(0, 10) === p.date
                && safePaperUrl(p.url) && SHA.test(p.sourceSha256 || '')
                && typeof p.relativePath === 'string' && p.relativePath, '论文元数据或链接无效');
            for (const key of ['tags', 'mappedIds', 'displayIds', 'unresolvedTags']) requireValue(strings(p[key]), key + ' 不是文字数组');
            for (const id of [...p.mappedIds, ...p.displayIds]) requireValue(byId.has(id), '论文引用未知概念');
            requireValue(p.displayIds.every(id => p.mappedIds.includes(id)), '展示概念不在原映射中');
            for (const key of ['facetIds', 'ancestorIds']) {
                requireValue(object(p[key]), key + ' 缺失');
                for (const [facet, ids] of Object.entries(p[key])) requireValue(strings(ids)
                    && ids.every(id => byId.get(id)?.facet === facet), '分面包含非法概念');
            }
            requireValue(p.primaryTaskId === null || (typeof p.primaryTaskId === 'string'
                && byId.get(p.primaryTaskId)?.facet === 'task' && p.mappedIds.includes(p.primaryTaskId)), '显式主任务无效');
            const primaryUnresolved = p.primaryUnresolved === undefined ? [] : p.primaryUnresolved;
            requireValue(Array.isArray(primaryUnresolved) && primaryUnresolved.every(item => object(item)
                && typeof item.field === 'string' && typeof item.value === 'string' && typeof item.reason === 'string'), '显式主任务待核记录无效');
            const primaryTaskSource = p.primaryTaskSource === undefined ? [] : p.primaryTaskSource;
            requireValue(Array.isArray(primaryTaskSource) && primaryTaskSource.every(item => object(item)
                && typeof item.field === 'string' && typeof item.value === 'string'), '显式主任务来源无效');
            requireValue(['legacy_mapped', 'partial', 'unresolved'].includes(p.classificationStatus), '映射状态无效');
            const closure = new Set(p.mappedIds.flatMap(id => [...ancestors.get(id)]));
            const expectedStatus = !p.mappedIds.length ? 'unresolved' : (p.unresolvedTags.length || primaryUnresolved.length) ? 'partial' : 'legacy_mapped';
            requireValue(p.classificationStatus === expectedStatus && p.unresolvedTags.every(tag => p.tags.includes(tag)), '映射状态与未映射标签不一致');
            requireValue(Object.values(p.facetIds).flat().every(id => p.mappedIds.includes(id))
                && Object.values(p.ancestorIds).flat().every(id => closure.has(id)), '派生分面不属于此论文映射');
            const searchable = norm([p.title, p.id || '', ...p.tags, ...p.unresolvedTags, ...primaryUnresolved.map(item => valueText(item.value)),
                ...[...closure].flatMap(id => { const c = byId.get(id); return [c.preferredLabel.zh, c.preferredLabel.en, ...c.aliases]; })].join(' '));
            return { ...p, primaryUnresolved, closure, searchable };
        });
        const suppliedFacets = Array.isArray(data.facets) ? data.facets : [];
        const facetIds = [...new Set([...['task', 'method', 'setting'], ...data.concepts.map(c => c.facet)])];
        const facets = facetIds.map(id => ({ id, label: suppliedFacets.find(f => f.id === id)?.label || FACETS[id] || id }));
        for (const facet of facets) requireValue(typeof facet.label === 'string', '分面名称无效');
        return { ...data, byId, ancestors, papers, facets };
    }
    function displayConcepts(index, ids) {
        return [...new Set(ids)].filter(id => !ids.some(other => other !== id && index.ancestors.get(other)?.has(id)))
            .map(id => index.byId.get(id)).filter(Boolean);
    }
    function filterPapers(index, filters = {}) {
        requireValue(index?.byId instanceof Map && Array.isArray(index.papers), '索引尚未通过校验');
        const selections = Object.entries(filters.facets || {}).filter(([, ids]) => ids.length);
        for (const [facet, ids] of selections) requireValue(strings(ids)
            && ids.every(id => index.byId.get(id)?.facet === facet), '筛选条件无效');
        const query = norm(String(filters.search || ''));
        return index.papers.filter(p => (!filters.needsReview || p.classificationStatus !== 'legacy_mapped')
            && (!query || p.searchable.includes(query))
            && selections.every(([, ids]) => ids.some(id => p.closure.has(id))));
    }
    function queryPapers(index, filters = {}) {
        const pageSize = filters.pageSize ?? 20;
        requireValue(Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100, '每页数量无效');
        const matches = filterPapers(index, filters); const total = matches.length;
        const pageCount = Math.ceil(total / pageSize);
        const requested = Number.isInteger(filters.page) ? filters.page : 1;
        const page = Math.max(1, Math.min(Math.max(1, pageCount), requested));
        return { total, page, pageCount, items: matches.slice((page - 1) * pageSize, page * pageSize) };
    }
    function mount(doc, fetcher) {
        let index; let state = { facets: {}, search: '', needsReview: false, page: 1, pageSize: 20 };
        const $ = id => doc.getElementById(id);
        const el = (tag, text, className) => {
            const node = doc.createElement(tag);
            if (text !== undefined) node.textContent = text;
            if (className) node.className = className;
            return node;
        };
        function renderFacets() {
            const fragment = doc.createDocumentFragment();
            const counts = new Map();
            for (const paper of index.papers) for (const id of paper.closure) counts.set(id, (counts.get(id) || 0) + 1);
            function tree(concepts) {
                const list = el('ul', undefined, 'concept-tree');
                for (const concept of concepts) {
                    const item = el('li'); const label = el('label', undefined, 'concept-option');
                    const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = concept.id;
                    checkbox.name = concept.facet; checkbox.checked = (state.facets[concept.facet] || []).includes(concept.id);
                    checkbox.addEventListener('change', () => {
                        const selected = new Set(state.facets[concept.facet] || []);
                        checkbox.checked ? selected.add(concept.id) : selected.delete(concept.id);
                        state.facets[concept.facet] = [...selected]; state.page = 1; renderResults();
                    });
                    const title = [concept.preferredLabel.en, concept.definition, concept.scopeNote].filter(Boolean).join(' · ');
                    label.title = title; label.append(checkbox, el('span', concept.preferredLabel.zh),
                        el('span', '(' + (counts.get(concept.id) || 0) + ')', 'concept-count'));
                    item.append(label);
                    const children = index.concepts.filter(c => c.broaderId === concept.id);
                    if (children.length) item.append(tree(children));
                    list.append(item);
                }
                return list;
            }
            const compact = typeof doc.defaultView?.matchMedia === 'function'
                && doc.defaultView.matchMedia('(max-width: 760px)').matches;
            for (const facet of index.facets) {
                const details = el('details', undefined, 'facet');
                details.open = !compact && ['task', 'method', 'setting'].includes(facet.id);
                details.append(el('summary', facet.label));
                const options = el('div', undefined, 'facet-options');
                const roots = index.concepts.filter(c => c.facet === facet.id && !c.broaderId);
                options.append(roots.length ? tree(roots) : el('p', '词表中暂无此分面概念', 'facet-empty'));
                details.append(options); fragment.append(details);
            }
            $('facets').replaceChildren(fragment);
        }
        function card(paper) {
            const item = el('li'); const article = el('article', undefined, 'paper-card');
            const statuses = { legacy_mapped: '历史标签已映射', partial: '映射 / 主任务待核', unresolved: '尚无可用映射' };
            article.append(el('p', paper.date + ' · ' + (paper.id || '论文 ID 未核实') + ' · ' + statuses[paper.classificationStatus], 'paper-meta'));
            const heading = el('h3'); const link = el('a', paper.title);
            link.href = safePaperUrl(paper.url); link.target = '_blank'; link.rel = 'noopener noreferrer';
            heading.append(link); article.append(heading);
            article.append(el('p', paper.primaryTaskId ? '显式主任务：' + index.byId.get(paper.primaryTaskId).preferredLabel.zh
                : '主任务未记录（不从旧标签推断）', 'primary-task'));
            for (const problem of paper.primaryUnresolved) article.append(el('p',
                '显式主任务待核：' + problem.field + ' = ' + valueText(problem.value) + '（' + problem.reason + '）', 'primary-task'));
            const chips = el('div', undefined, 'chips');
            for (const concept of displayConcepts(index, paper.displayIds).filter(c => c.id !== paper.primaryTaskId)) {
                chips.append(el('span', concept.preferredLabel.zh, 'chip'));
            }
            if (!paper.mappedIds.length) chips.append(el('span', '暂无规范映射', 'chip'));
            for (const tag of paper.unresolvedTags) chips.append(el('span', '未映射：' + tag, 'chip unknown'));
            article.append(chips);
            const details = el('details', undefined, 'raw-tags'); details.append(el('summary', '原标签 · ' + paper.tags.length));
            details.append(el('p', paper.tags.length ? paper.tags.join(' · ') : '原页面没有标签'));
            article.append(details); item.append(article); return item;
        }
        function renderResults() {
            if (!index) return;
            const result = queryPapers(index, state); state.page = result.page;
            $('result-count').textContent = result.total + ' 条记录 / 全部 ' + index.papers.length + ' 条（非已证实唯一论文数）';
            $('paper-list').replaceChildren(...result.items.map(card));
            $('empty').hidden = result.total !== 0;
            $('empty').textContent = index.papers.length ? '没有符合当前组合的记录。可清除筛选，或换一个名称/别名。' : '索引已加载，但不包含论文记录。';
            $('page-info').textContent = result.pageCount ? '第 ' + result.page + ' / ' + result.pageCount + ' 页' : '0 页';
            $('previous').disabled = result.page <= 1; $('next').disabled = result.page >= result.pageCount;
        }
        async function load() {
            index = null; $('controls').disabled = true; $('error').hidden = true; $('retry').disabled = true;
            $('dataset-meta').textContent = '正在读取本地预览索引…'; $('result-count').textContent = '正在加载…';
            $('paper-list').replaceChildren(); $('facets').replaceChildren(); $('empty').hidden = true;
            try {
                const response = await fetcher('./index.json', { cache: 'no-store', credentials: 'same-origin' });
                if (!response.ok) throw new Error('索引请求失败（HTTP ' + response.status + '）');
                index = validateIndex(await response.json());
                $('dataset-meta').textContent = '词表 ' + index.taxonomyVersion + ' · registry ' + index.registrySha256.slice(0, 12)
                    + ' · 历史记录 ' + index.papers.length;
                $('controls').disabled = false; renderFacets(); renderResults();
            } catch (error) {
                index = null; $('error').hidden = false; $('controls').disabled = true;
                $('error-message').textContent = '没有显示任何成功结果。' + String(error.message || error)
                    + '。请通过本地 HTTP 预览服务打开，并确认 index.json 由正式预览构建器生成。';
                $('dataset-meta').textContent = '索引不可用'; $('result-count').textContent = '加载失败，记录数未知';
            } finally { $('retry').disabled = false; }
        }
        $('filters').addEventListener('submit', event => event.preventDefault());
        $('search').addEventListener('input', event => { state.search = event.target.value; state.page = 1; renderResults(); });
        $('needs-review').addEventListener('change', event => { state.needsReview = event.target.checked; state.page = 1; renderResults(); });
        $('page-size').addEventListener('change', event => { state.pageSize = Number(event.target.value); state.page = 1; renderResults(); });
        $('clear').addEventListener('click', () => {
            state = { facets: {}, search: '', needsReview: false, page: 1, pageSize: Number($('page-size').value) };
            $('search').value = ''; $('needs-review').checked = false; renderFacets(); renderResults();
        });
        for (const [id, increment] of [['previous', -1], ['next', 1]]) $(id).addEventListener('click', () => {
            state.page += increment; renderResults(); $('results-heading').focus();
        });
        $('retry').addEventListener('click', load);
        return load();
    }
    function validateSnapshot(data) { validateIndex(data); return data; }
    return { validateSnapshot, validateIndex, displayConcepts, filterPapers, queryPapers, safePaperUrl, mount };
}));
