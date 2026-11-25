'use strict';

const crypto = require('crypto');
const {
    extractMarkdownTables,
    maskProtectedMarkdownTableRegions
} = require('../analysis-contract.js');
const {
    findQuantitativeChineseNumerals,
    normalizeIssueBoundReaderQuantitativeNumerals
} = require('../editorial-quality.js');
const {
    paperSourceQuoteBindsOriginalUrl
} = require('./reader-resource-binding.js');
const readerIdentityFormat = require('./reader-identity-format');
const readerResourceClaimsFormat = require('./reader-resource-claims-format');
const { normalizeReaderProseFormatting } = require('./reader-prose-normalization.js');

function stableFingerprint(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function buildApiReaderResourceEvidence(identity, naturalResourceProse = false) {
    if (!identity) return '';
    const { identitySha256, ...identityBody } = identity;
    if (!readerIdentityFormat.hasIdentity(identity, 'resources')
        || identitySha256 !== stableFingerprint(identityBody)
        || !Array.isArray(identity.resources)) {
        throw new Error('为读者文章准备资源证据时，资源身份记录必须包含正确的协议、对应内容的哈希和资源列表。');
    }
    const lines = [
        `[READER_VERIFIED_RESOURCES] ${identity.contract} sha256=${identitySha256}`,
        '只有归属明确的作者资源且 availability=available，才可写“作者资源当前可用/已公开”；third_party 只证明论文提到该链接，不证明作者已开源。unavailable 只说明链接当前不可用；temporarily_unreachable 只说明本次未能确认可达。来源未确认不是论文技术缺陷。'
    ];
    if (identity.resources.length === 0) {
        lines.push('NONE: 未发现来源绑定且完成 HTTPS 状态验证的资源；不得声称代码、模型或数据已公开。');
    }
    for (const [index, resource] of identity.resources.entries()) {
        if (!['available', 'unavailable', 'temporarily_unreachable'].includes(resource?.availability)
            || resource?.sourceQuoteSha256 !== crypto.createHash('sha256')
                .update(String(resource?.sourceQuote || '')).digest('hex')
            || (resource?.documentationEvidence
                && !require('./public-resource-probe.js').validRepositoryDocumentationEvidence(
                    resource.documentationEvidence, resource.originalUrl
                ))
            || (resource?.origin === 'paper_source' && !paperSourceQuoteBindsOriginalUrl(resource))) {
            throw new Error(`资源证据第 ${index + 1} 项的可达状态、引文哈希或来源记录不符合要求。`);
        }
        lines.push(`RESOURCE_${index + 1}: type=${resource.type}; availability=${resource.availability}; `
            + `status=${resource.status === null ? 'null' : resource.status}; url=${resource.originalUrl}`);
        if (resource.documentationEvidence) {
            const capabilities = Object.entries(resource.documentationEvidence.capabilities)
                .filter(([, available]) => available).map(([name]) => name).join(',');
            lines.push(`RESOURCE_${index + 1}_DOCUMENTATION: completeness=`
                + `${resource.documentationEvidence.completeness}; capabilities=${capabilities}; `
                + `source=${resource.documentationEvidence.sourceUrl}; `
                + `sha256=${resource.documentationEvidence.sourceSha256}`);
        }
    }
    const evidence = lines.join('\n');
    return naturalResourceProse
        ? require('./reader-resource-prose').naturalEvidence(evidence, identity) : evidence;
}

const CONFERENCE_READER_RESOURCE_CLAIM_SPECS = Object.freeze({
    code: /(?:\b(?:source\s+code|code(?!\s*[- ]\s*(?:switch(?:ing)?|mix(?:ing)?))|repository|repo)\b|源代码|代码仓库|仓库|代码(?!\s*(?:切换|混合)))/i,
    model: /(?:\b(?:model\s+weights?|weights?|checkpoints?)\b|模型权重|权重|检查点|模型(?=\s*(?:均|都)?\s*(?:已经|已|现已|目前已|当前已|正式)(?:经)?(?:开源|公开|发布|提供|开放|上线)))/i,
    dataset: /(?:\b(?:datasets?|corpus|corpora)\b|数据集|语料库)/i,
    demo: /(?:\b(?:demo|demonstration)\b|在线演示|演示页面|演示链接)/i,
    reproduction: /(?:\b(?:artifacts?|reproduction\s+materials?)\b|复现材料|复现工件)/i
});

function replayVerifiedReaderResourceIdentity(identity, sourceText, options = {}) {
    const { identitySha256, ...identityBody } = identity || {};
    const sourceTextSha256 = crypto.createHash('sha256').update(String(sourceText || '')).digest('hex');
    if (!readerIdentityFormat.hasIdentity(identity, 'resources')
        || identitySha256 !== stableFingerprint(identityBody)
        || identity.sourceTextSha256 !== sourceTextSha256
        || !Array.isArray(identity.resources)
        || identity.resources.some(resource => {
            const available = resource?.availability === 'available';
            const unavailable = resource?.availability === 'unavailable';
            const temporary = resource?.availability === 'temporarily_unreachable';
            return (!Object.hasOwn(CONFERENCE_READER_RESOURCE_CLAIM_SPECS, resource?.type)
                    && resource?.type !== 'third_party')
                || !['paper_source', 'validated_demo'].includes(resource?.origin)
                || !/^https:\/\//.test(String(resource?.originalUrl || ''))
                || !/^https:\/\//.test(String(resource?.finalUrl || ''))
                || !Array.isArray(resource?.redirects)
                || resource?.sourceQuoteSha256 !== crypto.createHash('sha256')
                    .update(String(resource?.sourceQuote || '')).digest('hex')
                || (resource?.documentationEvidence
                    && !require('./public-resource-probe.js').validRepositoryDocumentationEvidence(
                        resource.documentationEvidence, resource.originalUrl
                    ))
                || (resource.origin === 'paper_source' && (!(options.legacySourceBinding === true
                    ? require('./reader-resource-binding').paperSourceQuoteBindsOriginalUrlBinding(resource)
                    : paperSourceQuoteBindsOriginalUrl(resource))
                    || !String(sourceText || '').replace(/\s+/g, ' ').includes(
                        String(resource.sourceQuote || '').replace(/\s+/g, ' ').trim())))
                || !(available || unavailable || temporary)
                || (available && (!Number.isInteger(resource.status)
                    || resource.status < 200 || resource.status >= 400))
                || (unavailable && (!Number.isInteger(resource.status)
                    || resource.status < 400 || resource.status >= 500
                    || [408, 425, 429].includes(resource.status)))
                || (temporary && (resource.retryable !== true
                    || !(resource.status === null
                        || [408, 425, 429].includes(resource.status)
                        || (Number.isInteger(resource.status) && resource.status >= 500))));
        })) {
        throw Object.assign(new Error('会议读者文章的资源身份记录与原文不一致，或其中的资源、来源与可达状态记录不符合要求。'), {
            code: 'READER_RESOURCE_IDENTITY_INVALID', retryable: false
        });
    }
    return identity;
}

function readerResourcePublicationResources(paper, sourceText) {
    const binding = require('./reader-resource-binding');
    const contracts = paper?.analysisManifest?.contracts || {};
    const declaredStage = paper?.analysisManifest?.stages?.apiReaderArticle?.readerResourceClaimsContractVersion;
    const declared = contracts.readerResourceClaims;
    const resourceVersion = paper?.analysisManifest?.stages?.apiReaderArticle?.resourceIdentityContractVersion;
    if ((contracts.apiReaderResourceIdentity !== undefined || resourceVersion !== undefined
            || paper?.analysisManifest?.stages?.apiReaderArticle?.readerIdentityProtocols !== undefined)
        && !readerIdentityFormat.payloadBinding(paper, 'resources')) {
        throw new Error('资源身份协议版本未知，不能按旧声明回放。');
    }
    if (readerResourceClaimsFormat.requiredForSavedPaper(paper)
        && !readerResourceClaimsFormat.matches(paper?.analysisManifest, paper?.analysisManifest?.stages?.apiReaderArticle)) {
        throw new Error('资源声明协议缺失、混用或版本未知，不能回退旧记录。');
    }
    if (crypto.createHash('sha256').update(String(sourceText || '')).digest('hex') !== paper?.sourceSha256) {
        throw new Error('当前资源展示必须绑定原论文封存全文。');
    }
    const legacy = binding.legacyConferenceResourceIdentity(paper);
    const verified = replayVerifiedReaderResourceIdentity(paper.apiReaderResources, sourceText,
        { legacySourceBinding: legacy });
    // This is an unsigned, temporary view after original identity authentication.
    // Do not mutate/re-sign the saved identity or turn URL reachability into release evidence.
    return verified.resources.flatMap(resource => {
        if (Object.hasOwn(resource, 'authenticatedPdfFootnoteEvidence')) return [structuredClone(resource)];
        if (!legacy || resource.origin !== 'paper_source') return [structuredClone(resource)];
        const facets = binding.paperSourceResourceFacets(sourceText, resource.sourceUrlToken || resource.originalUrl);
        return facets.map(type => ({ ...structuredClone(resource), type }));
    });
}

function readerResourceClaimIssues(draft, identity, sourceText, options = {}) {
    if (options.paper && stableFingerprint(identity) !== stableFingerprint(options.paper.apiReaderResources)) {
        throw new Error('当前资源声明重放不能替换原论文资源身份。');
    }
    const verified = options.paper
        ? { resources: readerResourcePublicationResources(options.paper, sourceText) }
        : replayVerifiedReaderResourceIdentity(identity, sourceText);
    const availableTypes = new Set(verified.resources
        .filter(resource => resource.availability === 'available')
        .map(resource => resource.type));
    const unavailableResources = verified.resources.filter(resource => resource.availability !== 'available');
    const nodes = [
        { path: '/readerTitle', text: draft?.readerTitle, kind: 'title' },
        { path: '/oneSentenceThesis', text: draft?.oneSentenceThesis, kind: 'thesis' },
        ...(Array.isArray(draft?.sections) ? draft.sections.map((section, index) => ({
            path: `/sections/${index}/body`, text: section?.body, kind: section?.kind
        })) : []),
        ...(Array.isArray(draft?.conceptBridges) ? draft.conceptBridges.map((bridge, index) => ({
            path: `/conceptBridges/${index}`, text: bridge?.explanation, kind: 'concept_bridge'
        })) : []),
        ...(draft?.implementationSpecs && typeof draft.implementationSpecs === 'object' && !Array.isArray(draft.implementationSpecs)
            ? Object.entries(draft.implementationSpecs).map(([specKey, specText]) => ({
                path: '/implementationSpecs', text: specText, kind: specKey === 'openSourceArtifacts' ? 'reproduction' : 'implementation_spec'
            })) : [])
    ];
    const affirmative = /(?:已经|已|现已|目前已|当前已|正式)(?:经)?(?:开源|公开|发布|提供|开放|上线|可用)|(?<![不未许])可(?:访问|下载|获取|用)(?!性|状态|于)|(?:为|是|属于)(?:一个)?(?:开源|公开|开放)(?:项目|资源|仓库)?|(?:代码|源代码|代码仓库|仓库|模型权重|权重|检查点|数据集|语料库|在线演示|演示页面|复现材料)(?:为|是|属于)?(?:一个)?(?:开源|公开|开放)(?:项目|资源|仓库)?|开源地址|公开仓库|\b(?:public|open[- ]source(?:d)?)\b|\b(?:is|are|was|were|has\s+been|have\s+been)\s+(?:now\s+|publicly\s+)?(?:available|released|open[- ]sourced|accessible|downloadable)\b|\b(?:we|the\s+authors?)\s+(?:release|provide|publish)\b/i;
    const directDenialPrefix = /(?:(?:不(?!但|仅|只)|不能|不应(?:当)?|不可|不宜|不得)(?:再|另行|据此|据此直接)?(?:声称|表示|说明|证明|确认|写|默认|意味着|代表|认为|断言|等同于|视为|当作)[^。！？!?；;，,]{0,36}|(?:不(?!但|仅|只)|不能|不应(?:当)?|不可|不宜|不得)(?:把|将)[^。！？!?；;，,]{0,36}(?:等同于|视为|当作)[^。！？!?；;，,]{0,16}|(?:不含|未含|不包含|没有包含|不包括)[^。！？!?；;，,]{0,24}|(?:没有|尚无|并无|不存在)(?:任何)?(?:该|此|对应)?(?:代码|模型|模型权重|权重|检查点|数据集|语料|演示|复现材料|资源)(?:类型)?(?:的)?|(?:没有|尚无|并无|不存在)(?:公开|开源|开放|当前可用|公开可用)$|(?:没有|未曾|尚未)(?:发现|找到|看到|确认|证明|表明|显示|提供|给出)[^。！？!?；;，,]{0,24}|(?:未|尚未|并未|没有|无)[^。！？!?；;，,]{0,24}(?:记为|标为|列为|判为)[^。！？!?；;，,]{0,16}|(?:未|尚未|并未|没有|无|并非|不是|不(?!但|仅|只)|not\s*))$/i;
    const conditionalPrefix = /(?:是否|能否|若|如果|假设)[^。！？!?；;，,]{0,36}$/i;
    // “手稿本身不构成已发布数据集”“该链接不等于可用资源”是在否定发布/可用
    // 状态，不是作者资源可用声明；只在否定词紧邻前缀时豁免，避免吞掉后文
    // 真正的转折肯定。
    const nonConstitutingPrefix = /(?:不|并不|不能|不足以|无法)(?:构成|等于|算作|视为)(?:任何|一个)?$/u;
    const isConceptDistinction = (value, matchIndex, matchEnd) => {
        // A closed, owner-free instruction enumerates concepts, not resources
        // presently supplied by the paper. Only the exact list span is exempt.
        const property = '(?:代码可运行|(?:模型)?权重可下载|数据可获取|(?:端到端)?系统可运行)';
        const pendingThreeProperties = /((?:模型)?权重可(?:下载|获取)[、，,]代码可运行[、，,](?:端到端)?系统可(?:实时)?运行)是(?:三|3)件独立的事[，,](?:需要|仍需)分别验证/gu;
        for (const list of value.matchAll(pendingThreeProperties)) {
            const before = value.slice(0, list.index);
            const prefix = before.split(/[。！？!?；;，,]/u).at(-1);
            const suffix = value.slice(list.index + list[0].length);
            const quoted = [['“', '”'], ['‘', '’'], ['「', '」']].some(([open, close]) =>
                before.lastIndexOf(open) > before.lastIndexOf(close))
                || ['"', "'", '`'].some(quote => before.split(quote).length % 2 === 0);
            if (!prefix.trim() && !quoted && /^[。！？!?；;]?\s*$/u.test(suffix)
                && matchIndex >= list.index && matchEnd <= list.index + list[1].length) return true;
        }
        const closedLists = [
            new RegExp('复现(?:时)?(?:应|要|需)把(' + property + '(?:[、和与及]' + property + '){1,2})分开表述', 'gu'),
            new RegExp('复现(?:时)?(?:要|应|需)(?:先)?分清(?:三|3)件事[：:](' + property + '(?:[、和与及]' + property + '){2})[，,](?:它们|三者|这三项)是(?:相互)?独立的', 'gu')
        ];
        for (const pattern of closedLists) for (const list of value.matchAll(pattern)) {
            const start = list.index + list[0].indexOf(list[1]), end = start + list[1].length;
            const prefix = value.slice(0, list.index).split(/[。！？!?；;，,]/u).at(-1);
            const suffix = value.slice(list.index + list[0].length);
            if (prefix.trim() || !/^(?:[，,]不要混为已开源)?[。！？!?；;]?\s*$/u.test(suffix)) continue;
            const items = list[1].split(/[、和与及]/u);
            if (new Set(items).size !== items.length) continue;
            if (matchIndex >= start && matchIndex < end) return true;
        }
        // 前置定语同样可以列举待核对概念；只豁免这个完整列表的范围。
        const attributiveLists = /(开源(?:的)?代码\s*[、，,]\s*可下载(?:的)?(?:模型)?权重\s*(?:[、，,]|与|和|及)\s*可(?:一键)?运行(?:的)?系统)\s*(?:是|属于)\s*(?:三|3)件(?:不同|独立|不同的|独立的)?事/gu;
        for (const list of value.matchAll(attributiveLists)) {
            if (matchIndex < list.index || matchIndex >= list.index + list[1].length) continue;
            const before = value.slice(0, list.index);
            const prefix = before.split(/[。！？!?；;，,]/u).at(-1);
            const quoted = [['“', '”'], ['‘', '’'], ['「', '」']].some(([open, close]) =>
                before.lastIndexOf(open) > before.lastIndexOf(close))
                || ['"', "'", '`'].some(quote => before.split(quote).length % 2 === 0);
            // 只接受裸概念列表；已有实物归属前缀不得被句尾免责声明抹掉。
            if (quoted || prefix.trim()) continue;
            // 待核实/明确否定状态必须紧接列表并结束本句，不解析后续代词声明。
            const tail = value.slice(list.index + list[0].length);
            const pendingState = '(?:(?:需要|仍需|需|应|要)(?:分别|逐项)(?:确认|核实|核对|验证)|'
                + '不能据此(?:认为|声称|断言)(?:全部|三者)已公开|三者是否已公开尚无法确认)';
            if (!new RegExp('^(?:\\s*[，,]\\s*' + pendingState + '){1,2}[。！？!?；;]?\\s*$', 'u').test(tail)) continue;
            return true;
        }
        const pendingLists = /(代码开源\s*[、，,]\s*权重可下载\s*(?:[、，,]|和)\s*系统可运行)\s*(?:应视为|是|属于)\s*(?:三|3)件(?:未确认|待确认)的事/gu;
        for (const list of value.matchAll(pendingLists)) {
            const before = value.slice(Math.max(0, list.index - 32), list.index).split(/[。！？!?；;，,]/u).at(-1);
            if (/(?:本文|本论文|本研究|本工作|作者团队|论文作者)[^。！？!?；;，,]{0,24}$/u.test(before)) continue;
            if (matchIndex >= list.index && matchIndex < list.index + list[1].length) return true;
        }
        // 显式列举“不同主张”只豁免列表本身；前后实际发布声明不能借此免责。
        const explicitClaimLists = /分清(?:三|3|两|2)件事[：:]([^。！？!?；;]{1,160}?)是(?:不同|不同的|独立|独立的)主张/gu;
        for (const list of value.matchAll(explicitClaimLists)) {
            const items = list[1].split(/、/u).map(item => item.trim());
            if (items.length < 2 || items.length > 3 || !items.every(item => /^(?:论文提到(?:地址|链接)|(?:模型)?权重可(?:下载|获取)|(?:系统|端到端系统)可运行)$/u.test(item))) continue;
            const listStart = list.index + list[0].indexOf(list[1]);
            if (matchIndex >= listStart && matchIndex < listStart + list[1].length) return true;
        }
        // 「代码开源、权重可下载、系统可运行是三件事」列举待核对概念，
        // 不是把三个条件断言为已经满足。仅豁免概念列举的字节范围；其后
        // 「本文权重已经公开」仍单独判断，不能用前面的限定吞掉真实声明。
        const conceptProperties = [
            '代码(?:开源|公开|可用|可运行|可下载|可访问|可达)',
            '(?:(?:模型)?权重(?:可下载|下载|可获取|公开|可用)|模型可下载)',
            '数据可获取',
            '(?:(?:系统|环境|端到端|在线)(?:可(?:一键|端到端)?运行|可安装|可复现|可部署|可用)|完整实验可运行)'
        ];
        const conceptProperty = '(?:' + conceptProperties.join('|') + ')';
        const conceptList = '(' + conceptProperty + '(?:\\s*[、和与及]\\s*' + conceptProperty + '){1,2})';
        const countedDistinctions = [
            { pattern: new RegExp(conceptList + '\\s*是\\s*([三两二32])\\s*件\\s*(?:不同的?|独立的?)?(?:事项|事)(?=[\\s，,:：。！？!?；;]|$)', 'gu'), listGroup: 1, countGroup: 2 },
            { pattern: new RegExp('(?:(?:复现(?:时)?(?:要|应|需))|需要)?(?:先)?分清\\s*([三两二32])\\s*件事\\s*[，,:：]\\s*'
                + conceptList + '\\s*(?:是(?:相互)?独立的|是不同(?:的)?主张)', 'gu'), listGroup: 2, countGroup: 1 },
            { pattern: new RegExp(conceptList + '\\s*(?:要|应|需)?(?:分开|分别)(?:看|确认|核实|核对|验证|判断)', 'gu'), listGroup: 1 },
            { pattern: new RegExp('复现(?:时)?(?:要|应|需)把' + conceptList + '\\s*([三两二32])\\s*件事分开', 'gu'), listGroup: 1, countGroup: 2 },
            { pattern: new RegExp('(?:(?:复现(?:前|时)?(?:要|应|需))|应|要|需|并)?(?:把|将)' + conceptList
                + '\\s*(?:([三两二32])\\s*件事)?\\s*(?:分开|分别)(?:看|核实|核对|确认|验证|判断)(?=[\\s，,:：。！？!?；;]|$)', 'gu'), listGroup: 1, countGroup: 2 },
            { pattern: new RegExp(conceptList + '\\s*是\\s*([三两二32])\\s*回事', 'gu'), listGroup: 1, countGroup: 2, countedMatters: true },
            { pattern: new RegExp('复现(?:时)?(?:要|应|需)(?:把|将)' + conceptList
                + '\\s*当作\\s*([三两二32])\\s*件(?:相互)?独立的事(?:分别|逐项)(?:确认|核实|核对|验证)', 'gu'), listGroup: 1, countGroup: 2 },
            { pattern: new RegExp(conceptList + '\\s*(?:需要|仍需)(?:另行|分别|逐项)(?:确认|核对)', 'gu'), listGroup: 1, closedPending: true }
        ];
        for (const { pattern, listGroup, countGroup, closedPending, countedMatters } of countedDistinctions) for (const span of value.matchAll(pattern)) {
            const list = span[listGroup];
            const count = countGroup ? span[countGroup] ?? null : null;
            const items = list.split(/\s*[、和与及]\s*/u);
            const declared = count === null ? items.length : { 三: 3, 两: 2, 二: 2 }[count] || Number(count);
            const types = items.map(item => conceptProperties.findIndex(property => new RegExp('^' + property + '$', 'u').test(item)));
            const listStart = span.index + span[0].indexOf(list);
            if (items.length !== declared || new Set(types).size !== items.length
                || matchIndex < listStart || matchEnd > listStart + list.length) continue;
            const before = value.slice(0, span.index);
            const prefix = before.split(/[。！？!?；;，,:：]/u).at(-1);
            const quoted = [['“', '”'], ['‘', '’'], ['「', '」']].some(([open, close]) =>
                before.lastIndexOf(open) > before.lastIndexOf(close))
                || ['"', "'", '`'].some(quote => before.split(quote).length % 2 === 0);
            const after = value.slice(span.index + span[0].length).replace(/^[\s，,:：]+/u, '')
                .replace(/^(?:但是?|不过|然而|可是)[\s，,:：]*/u, '');
            const collectiveAfter = after.replace(/^[\s，,:：；;]+/u, '')
                .replace(/^(?:要|应|需)(?:分别|分开)(?:核实|核对|确认|验证|判断)[\s，,:：；;]*/u, '');
            if (closedPending) {
                const tail = value.slice(span.index + span[0].length);
                const nonEquivalenceInstruction = /^[，,]\s*(?:不能|不应|不可)(?:把|将)(?:代码|权重|数据|系统)(?:开源|公开|可用|可下载|可获取|可运行)(?:直接)?(?:等同于|视为|当作)(?:开箱即用|系统可运行|资源齐全)[。！？!?]?\s*$/u;
                if (!/^[。！？!?]?\s*$/u.test(tail) && !nonEquivalenceInstruction.test(tail)) continue;
            }
            if (countedMatters && declared === 3 && /[；;]\s*$/u.test(value)) continue;
            if (quoted || !/^(?:\s*(?:但|因此))?\s*$/u.test(prefix)
                || /^[“”‘’「」"'`]|^(?:(?:这(?:一|种|个)?|该|上述|的)?(?:说法|判断|结论|声明|区分|否定))?(?:本身|其实|实际)?(?:是|为)?(?:错误|不成立|不属实|不正确|不准确)/u.test(after)
                || /^(?:这(?:一|种|个)?|该|上述)?(?:说法|判断|结论|声明|区分|否定)(?:本身|其实|实际)?(?:并不成立|从未成立)/u.test(after)
                || /^(?:这(?:一|种|个)?|该|上述)?(?:说法|判断|结论|声明|区分|否定)(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定)/u.test(after)
                || /^(?:它们|三者|两者|这三项|这两项|这些资源|上述资源|全部|所有|均已)[^。！？!?；;，,]{0,28}(?:公开|开源|可用|可下载|可获取|发布|提供)/u.test(collectiveAfter)) continue;
            return true;
        }
        const prefix = value.slice(0, matchIndex);
        const markers = [...prefix.matchAll(/(?:区分|区别|辨别|分开看待|分开说|分三件(?:不同的)?事)/g)];
        const marker = markers.at(-1);
        if (!marker || matchIndex - marker.index > 180) return false;
        const end = /[，,；;]/.exec(value.slice(marker.index));
        const scope = value.slice(marker.index, end ? marker.index + end.index : undefined);
        if (matchIndex > marker.index + scope.length) return false;
        const contrastedProperties = [
            /(?:源代码|代码仓库|代码)[^。！？!?；;]{0,20}(?:开源|公开|可用|可运行|可访问)/,
            /(?:模型)?权重[^。！？!?；;]{0,20}(?:可下载|下载|可获取|获取|公开|开放|可用)/,
            /(?:端到端|系统)[^。！？!?；;]{0,20}(?:可(?:一键|端到端)?运行|能运行|可复现)/
        ].filter(pattern => pattern.test(scope));
        return contrastedProperties.length >= 2
            || /分开说三件事[^。！？!?；;]{0,80}未来提供[^。！？!?；;]{0,24}不同状态/.test(scope);
    };
    const unavailableStatus = '(?:不可用|不可达|无法访问|未能确认|暂时无法|HTTP\\s*[45]\\d\\d|unavailable|temporarily[_ -]unreachable|could not verify|not accessible)';
    const resourceTokenEntries = verified.resources.flatMap(resource => [
        resource.originalUrl, resource.finalUrl, resource.sourceUrlToken
    ].filter(Boolean).map(token => ({ resource, token: String(token) })));
    const maskResourceTokens = value => [...new Set(resourceTokenEntries.map(entry => entry.token))]
        .sort((left, right) => right.length - left.length)
        .reduce((masked, token) => masked.split(token).join('[RESOURCE_URL]'), value);
    const tokenOccurrences = value => resourceTokenEntries.flatMap(entry => {
        const occurrences = [];
        let offset = 0;
        while (offset <= value.length - entry.token.length) {
            const index = value.indexOf(entry.token, offset);
            if (index < 0) break;
            occurrences.push({ ...entry, index, end: index + entry.token.length });
            offset = index + Math.max(1, entry.token.length);
        }
        return occurrences;
    });
    const resourceTypesIn = value => new Set(Object.entries(CONFERENCE_READER_RESOURCE_CLAIM_SPECS)
        .filter(([, pattern]) => pattern.test(value))
        .map(([type]) => type));
    const resourceTypeMentions = value => {
        const mentions = Object.entries(CONFERENCE_READER_RESOURCE_CLAIM_SPECS).flatMap(
            ([type, pattern]) => {
                const matcher = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
                return [...value.matchAll(matcher)].map(match => ({
                    type,
                    index: match.index,
                    end: match.index + match[0].length
                }));
            }
        );
        for (const occurrence of tokenOccurrences(value)) {
            if (Object.hasOwn(CONFERENCE_READER_RESOURCE_CLAIM_SPECS, occurrence.resource.type)) {
                mentions.push({
                    type: occurrence.resource.type,
                    index: occurrence.index,
                    end: occurrence.end
                });
            }
        }
        return [...new Map(mentions.map(mention => [
            `${mention.type}:${mention.index}:${mention.end}`, mention
        ])).values()].sort((left, right) => left.index - right.index || left.end - right.end);
    };
    const coordinatedResourceTypes = (value, mentions, nearestMentions) => {
        const connector = /^\s*(?:、|与|和|及|以及|&|\/|and|or)\s*(?:(?:第三方|外部|本文|本研究|本工作)(?:的)?)?\s*$/i;
        const clusters = [];
        for (const mention of mentions) {
            const previous = clusters.at(-1);
            if (previous && (mention.index <= previous.end
                || connector.test(value.slice(previous.end, mention.index)))) {
                previous.mentions.push(mention);
                previous.end = Math.max(previous.end, mention.end);
            } else {
                clusters.push({ start: mention.index, end: mention.end, mentions: [mention] });
            }
        }
        const nearestKeys = new Set(nearestMentions.map(mention => (
            `${mention.type}:${mention.index}:${mention.end}`
        )));
        const selectedIndexes = new Set(clusters.map((cluster, index) => (
            cluster.mentions.some(mention => nearestKeys.has(
                `${mention.type}:${mention.index}:${mention.end}`
            )) ? index : -1
        )).filter(index => index >= 0));
        // 在「代码与检查点在公开仓库」这类说法里，「仓库」指的是共同存放的位置，并没有把
        // 声明缩窄到代码。
        for (const index of [...selectedIndexes]) {
            if (index < 1) continue;
            const cluster = clusters[index];
            const previous = clusters[index - 1];
            const repositoryNoun = /(?:仓库|\brepositor(?:y|ies)\b|\brepo\b)/i
                .test(value.slice(cluster.start, cluster.end));
            const sharedLocation = /^\s*(?:在|位于|托管于|见|发布于|放在)\s*(?:公开|开源)?\s*$/i
                .test(value.slice(previous.end, cluster.start));
            if (repositoryNoun && sharedLocation) selectedIndexes.add(index - 1);
        }
        return new Set([...selectedIndexes]
            .flatMap(index => clusters[index].mentions.map(mention => mention.type)));
    };
    const claimAssociationMaxChars = 80;
    const isThirdPartyTypeAttribution = (segment, type, mentions, matchIndex, matchEnd) => {
        // A postposed owner can describe the weights needed from named upstream
        // models. Bind only this closed acquisition clause, never a later author
        // release claim or an arbitrary model name absent from the paper.
        if (type === 'model') {
            const base = /^(?:(?:本文|本研究|本工作|我们)(?:使用|采用)的)?基座(?:模型)?(?:是|为)开放权重的[ \t]*([A-Za-z][A-Za-z0-9_.+-]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9_.+-]*){0,3})[。！？!?；;]?$/u.exec(segment.trim());
            if (base && !/^(?:Table|Figure|Section|Equation|Appendix|Algorithm)\s+[0-9]/iu.test(base[1])) {
                const source = String(sourceText || '')
                    // Keep a nonempty boundary: removing quoted negation must
                    // never manufacture a new affirmative source sentence.
                    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, ' [quoted material] ')
                    .replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote\s*>/giu, ' [quoted material] ')
                    .replace(/^[ \t]*>.*$/gmu, ' [quoted material] ')
                    .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|"[^"\n]*"/gu, ' [quoted material] ')
                    .replace(/[^\S\r\n]+/gu, ' ');
                const name = base[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ \t]+/gu, '\\s+');
                // A named base is upstream only when the paper explicitly uses
                // that cited open-weight model. Neither a title occurrence nor
                // the author's own release establishes this limited attribution.
                const own = new RegExp('\\bwe\\s+(?:(?:publicly|also|now|hereby|newly)\\s+)?'
                    + '(?:introduce|present|propose|release|develop)\\s+'
                    + '(?:(?:our|a|the)\\s+)?(?:(?:new|own|self[- ]developed)\\s+)?'
                    + '(?:(?:model|(?:weights|checkpoints)\\s+of)\\s+)?' + name
                    + '(?![A-Za-z0-9_+-]|\\.[A-Za-z0-9])', 'iu');
                const ownedModel = new RegExp('\\bour\\s+(?:(?:own|new|newly\\s+developed)\\s+)?'
                    + 'model\\s+' + name + '(?![A-Za-z0-9_+-]|\\.[A-Za-z0-9])', 'iu');
                const used = new RegExp('(?:^|[\r\n.!?;])\\s*We\\s+'
                    + '(?:implement\\s+our\\s+(?:framework|system|method)\\s+using|use|adopt)\\s+'
                    + '(?:the\\s+)?open[- ]weight\\s+'
                    + '(?:(?:audio|language|vision|speech|multimodal|pretrained|pre-trained)[- ]?){0,4}'
                    + 'model\\s+' + name + '\\s*'
                    + '\\((?=[^()]{1,100}\\b(?:19|20)\\d{2}\\b)[A-Za-z][^()]{1,100}\\)\\s*[.!?;]', 'giu');
                if (!own.test(source) && !ownedModel.test(source) && [...source.matchAll(used)].some(span => {
                    const introduction = source.slice(0, span.index).trimEnd().split(/[\r\n]/u).at(-1);
                    if (/\b(?:quotes?|quoted|quotation|example|hypothetical|claim|reported|false|incorrect)\b/iu.test(introduction)) return false;
                    const following = source.slice(span.index + span[0].length).trimStart();
                    return !/^(?:(?:The\s+(?:preceding|previous|above)|This)\s+(?:statement|claim)|These\s+(?:weights|checkpoints))\b[^.!?\r\n]{0,100}\b(?:false|incorrect|withdrawn|unavailable|not\s+(?:true|released|available))\b/iu.test(following)
                        && !/^(?:We\s+(?:did|do)\s+not\s+(?:actually\s+)?(?:use|adopt)\s+(?:this|that)\s+model\b|This\s+(?:was|is)\s+(?:only\s+)?hypothetical\b)/iu.test(following);
                })) return true;
            }
            const acquisition = /^(?:模型)?权重可(?:下载|获取)指([^。！？!?；;，,：:]{1,180})等(?:外部|第三方)模型(?:的权重)?需(?:要)?(?:另行|单独)获取[。！？!?；;]?$/u.exec(segment.trim());
            if (acquisition) {
                const names = acquisition[1].split(/、|与|和|及/u).map(name => name.trim());
                const source = String(sourceText || '').replace(/\s+/gu, ' ');
                const upstreamModel = name => {
                    if (!/^[A-Za-z][A-Za-z0-9_.+-]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9_.+-]*){0,3}$/u.test(name)
                        || /^(?:Table|Figure|Section|Equation|Appendix|Algorithm)\s+[0-9]/iu.test(name)) return false;
                    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ \t]+/gu, '\\s+');
                    if (new RegExp('\\bwe\\s+(?:introduce|present|propose|release)\\s+'
                        + escaped + '(?![A-Za-z0-9_.+-])', 'iu').test(source)) return false;
                    // A citation plus an explicit model kind or upstream model
                    // operation is required; merely occurring in a caption or
                    // an author dataset name does not establish this role.
                    const cited = new RegExp('(?<![A-Za-z0-9_.+-])' + escaped
                        + '\\s*\\[[0-9]+(?:\\s*[,–-]\\s*[0-9]+)*\\]', 'giu');
                    return [...source.matchAll(cited)].some(match => {
                        const before = source.slice(Math.max(0, match.index - 180), match.index).split(/[.!?;]/u).at(-1);
                        const after = source.slice(match.index + match[0].length, match.index + match[0].length + 180).split(/[.!?;]/u)[0];
                        if (/\b(?:not|never|if|would|could|might|may|will|planned|hypothetical|quoted)\b/iu.test(before)) return false;
                        return /\b(?:models?|checkpoints?|encoders?|transcription systems?)\s*(?:such as|including|like)?\s*$/iu.test(before)
                            || /^\s*(?:first\s+)?(?:classifies|predicts|encodes|transcribes)\b/iu.test(after)
                            || (/\b(?:use|using|select|adopt)\s*$/iu.test(before)
                                && /^\s*(?:with\s+(?:the\s+)?(?:music\s+)?)?(?:models?|checkpoints?|encoders?)\b/iu.test(after));
                    });
                };
                if (names.length <= 6 && names.every(upstreamModel)) return true;
            }
        }
        const markers = [...segment.matchAll(/(?:第三方|外部|论文引用的|相关(?:工作|研究|基线|项目|资源|仓库)|已有(?:工作|研究|方法|模型|系统|项目|资源))/g)];
        if (type === 'model') {
            const distance = mention => matchIndex >= mention.end ? matchIndex - mention.end
                : mention.index >= matchEnd ? mention.index - matchEnd : 0;
            const modelMentions = mentions.filter(mention => mention.type === type);
            const nearest = Math.min(...modelMentions.map(distance));
            // An earlier external model does not own the next author-weight
            // predicate, even when both appear in the same comma-free clause.
            if (modelMentions.filter(mention => distance(mention) === nearest).some(mention => {
                const prefix = segment.slice(0, mention.index);
                return /(?:本文|本论文|本研究|本工作|该论文|本项目|论文作者|作者团队|项目团队|我们)(?:的)?(?:(?:自有|自研|自己|自行训练|训练|微调(?:后)?|(?:已经|现已|已|所|新)?(?:发布|提供|公开|开源))(?:的|了)?)?\s*$/u.test(prefix);
            })) return false;
        }
        return markers.some(marker => {
            const markerEnd = marker.index + marker[0].length;
            const following = mentions.filter(mention => mention.index >= markerEnd
                && mention.index - markerEnd <= 48);
            if (!following.length) return false;
            const nearestDistance = Math.min(...following.map(mention => mention.index - markerEnd));
            return following.some(mention => mention.type === type
                && mention.index - markerEnd === nearestDistance);
        });
    };
    const isDataSourceRepositoryAttribution = (segment, type) => type === 'code'
        && (/(?:数据|样本|语料|特征)[^。！？!?；;，,]{0,32}(?:汇聚|汇总|收集|采集|来自|取自|源自)[^。！？!?；;，,]{0,32}(?:公开)?仓库/.test(segment)
            || /(?:数据|样本|语料|特征)[^。！？!?；;，,]{0,32}(?:公开)?仓库[^。！？!?；;，,]{0,24}(?:汇聚|汇总|收集|采集|核对)/.test(segment)
            // 数据集名常以「仓库」结尾，但并不会写成「数据仓库」。如果同一个小句明确是在
            // 列举数据集，又没有代码或仓库的限定词，这个光杆名词不能算成代码可用的声明。
            || (/(?:数据库|数据集|语料|伪造|欺骗|名人)[^。！？!?；;，,]{0,24}仓库/.test(segment)
                && !/(?:代码|源代码|github|repository|repo)/i.test(segment)));
    const isSelfOwnedResourceAvailabilityDenial = (segment, type) => type === 'code'
        && /(?:本文|本研究|本工作|该论文|论文作者|作者团队)[^。！？!?；;，,]{0,24}(?:自有)?(?:代码|源代码|代码仓库)[^。！？!?；;，,]{0,32}(?:不(?:作|做)|未(?:在|被)|没有)[^。！？!?；;，,]{0,24}(?:可用|开源|公开)(?:声明|记录|标记)?/.test(segment);
    const isExistingDatasetAttribution = (segment, type) => {
        if (type !== 'dataset') return false;
        // 已有数据集是输入或对照材料，不是论文新发布的东西。即使同一句话里提到旧的语料库，
        // 明确声称新数据集或自有数据集的说法仍要拦截。
        if (/(?:本文|本研究|本工作|我们)[^。！？!?；;，,]{0,32}(?:新建|自建|构建|收集|采集|发布|开源|公开)[^。！？!?；;，,]{0,24}(?:数据集|语料)/.test(segment)) {
            return false;
        }
        return /(?:旧数据集|已有数据集|现有数据集|现成数据集|公共数据集|公开数据集|NCHLT|Common\s+Voice|LibriSpeech|AudioCaps|VGGSound|AudioSet|Lahaja|LibriTTS|MUSDB18|VCTK|MAESTRO)/i
            .test(segment);
    };
    const isExplicitResourceNonClaim = (segment, type) => {
        const noun = {
            code: '(?:代码|源代码|代码仓库|仓库)',
            model: '(?:模型权重|权重|检查点|模型)',
            dataset: '(?:数据集|语料库|语料)',
            demo: '(?:在线演示|演示页面)',
            reproduction: '(?:复现材料|复现工件|资源)'
        }[type];
        if (!noun) return false;
        // 这些是状态免责说明，不是正面的可用性声明。把它们限制在一个小句内，后面「但事实
        // 上已公开」这类转折仍会交给肯定匹配器处理。
        if (new RegExp(`${noun}[^。！？!?；;，,]{0,48}(?:不是|并非|未被|没有|尚无|并无)`
            + `[^。！？!?；;，,]{0,24}(?:公开|开源|开放)(?:可下载|可获取|可用)?`, 'i').test(segment)) {
            return true;
        }
        if (new RegExp(`(?:没有|未|尚未|无法)(?:验证|确认|核验)[^。！？!?；;，,]{0,40}`
            + `${noun}[^。！？!?；;，,]{0,28}(?:可用|公开|开源|下载|获取)`, 'i').test(segment)) {
            return true;
        }
        if (new RegExp(`(?:没有|未|尚未|无法)(?:验证|确认|核验)`
            + `(?:[^。！？!?；;，,]{0,12})?(?:可用|公开|开源|可下载|可获取)?的?${noun}`, 'i').test(segment)) {
            return true;
        }
        return new RegExp(`(?:不声称|不作(?:可用|公开)(?:声明|断言|保证)?|不做(?:可用|公开)`
            + `(?:声明|断言|保证)?|不写)[^。！？!?；;，,]{0,40}`
            + `(?:${noun}[^。！？!?；;，,]{0,20})?`
            + `(?:已|当前|公开|开源|开放|可下载|可获取|可用)`, 'i').test(segment);
    };
    const isAvailabilityVerificationDisclaimer = (segment, type) => {
        const noun = {
            code: '(?:代码|源代码|代码仓库|仓库)',
            model: '(?:模型权重|权重|检查点|模型)',
            dataset: '(?:数据集|语料库|语料)',
            demo: '(?:在线演示|演示页面)',
            reproduction: '(?:复现材料|复现工件|资源)'
        }[type];
        if (!noun || !new RegExp(noun, 'i').test(segment)) return false;
        // 报出校验失败是明确的否认，不是声明。这里刻意比笼统的「不可用」匹配更窄，后面
        // 转折里出现的正面声明仍然拦截。
        if (new RegExp(`(?:${noun})[^。！？!?；;]{0,96}`
            + `(?:当前不可用|当前不可达|暂时无法访问|本次(?:核验|验证|检查)[^。！？!?；;]{0,48}`
            + `(?:未能确认|无法确认|不可用)|无法据此确认[^。！？!?；;]{0,36}`
            + `(?:公开|开源|可用|可下载|可获取))`, 'i').test(segment)) {
            const denialEnd = Math.max(
                ...['当前不可用', '暂时无法访问', '无法据此确认', '未能确认', '无法确认']
                    .map(marker => segment.lastIndexOf(marker) + marker.length)
            );
            const later = denialEnd > 0 ? segment.slice(denialEnd) : '';
            return !/(?:但|然而|不过|事实上)[^。！？!?；;，,]{0,40}(?:已|现已|当前)?(?:开源|公开|开放|可用|可下载|可获取)/i.test(later)
                && !new RegExp(`${noun}[^。！？!?；;，,]{0,48}(?:已|现已|当前)?(?:开源|公开|开放|可用|可下载|可获取)`, 'i').test(later);
        }
        if (new RegExp(`(?:无法据此确认|本次(?:核验|验证|检查)[^。！？!?；;]{0,48}`
            + `(?:未能确认|无法确认))[^。！？!?；]{0,36}(?:${noun})`
            + `[^。！？!?；]{0,24}(?:公开|开源|开放|可用|可下载|可获取)`, 'i').test(segment)) {
            return true;
        }
        if (new RegExp(`(?:已验证(?:可达)?资源|验证资源|资源身份)[^。！？!?；;，,]{0,24}`
            + `(?:该|本文|本论文|本研究|本工作)?${noun}(?:类型)?[^。！？!?；;，,]{0,16}`
            + `(?:没有|无|未见|不存在)[^。！？!?；;，,]{0,24}`
            + `(?:可用|公开|开源|开放)(?:记录|证据|链接)?`, 'i').test(segment)) {
            return true;
        }
        if (type === 'model' && (
            /只有明确(?:给出)?[^。！？!?；;]{0,32}(?:可达|可访问)[^。！？!?；;]{0,32}(?:链接|证据)[^。！？!?；;]{0,24}(?:才能|方可)[^。！？!?；;]{0,24}(?:写|称|说)[^。！？!?；;]{0,24}(?:公开|开源|可用)/i.test(segment)
            || /(?:需|应|要|先)[^。！？!?；;]{0,16}(?:确认|核对|核验)[^。！？!?；;]{0,48}(?:接口|权重|模型)[^。！？!?；;]{0,32}(?:是否|当前)?(?:真正)?可用/i.test(segment)
            || /(?:开源声明|权重可下载|接口可调用)[^。！？!?；;]{0,32}(?:不是|并非|不等同于|不同事项)/i.test(segment)
        )) return true;
        return false;
    };
    const isFutureVerificationRecommendation = (segment, type) => {
        const noun = {
            code: '(?:代码|源代码|代码仓库|仓库)',
            model: '(?:模型权重|权重|检查点|模型)',
            dataset: '(?:数据集|语料库|语料)',
            demo: '(?:在线演示|演示页面)',
            reproduction: '(?:复现材料|复现工件|资源)'
        }[type];
        if (!noun || !new RegExp(noun, 'i').test(segment)) return false;
        const future = /(?:若要|如果要|如要|如需|继续推进|后续|复现前|下一步)/i.test(segment);
        const action = /(?:应先|需先|需要先|先补做|先确认|先核对|需要补做|应补|补做|补充)/i
            .test(segment);
        const verification = /(?:验证|核验|检查|确认|核对|记录|获取|下载)/i.test(segment);
        if (!future || !action || !verification) return false;
        // 将来的待办清单不构成发布声明。后面若明确正面声明论文自有资源，不能因此豁免。
        if (new RegExp(
            `(?:但|然而|不过|事实上)[^。！？!?；;，,]{0,80}`
            + `(?:本文|本论文|本研究|本工作|作者团队)?[^。！？!?；;，,]{0,20}`
            + `(?:代码|源代码|代码仓库|仓库|模型权重|权重|检查点|数据集|语料|演示|复现材料)`
            + `[^。！？!?；;，,]{0,24}(?:已|现已|当前)?(?:开源|公开|开放|可用|可下载|可获取)`, 'i'
        ).test(segment)) return false;
        return true;
    };
    const isExplicitNonAvailabilityDeclaration = (segment, type) => {
        if (type !== 'code') return false;
        const noun = '(?:代码|源代码|代码仓库|仓库)';
        if (new RegExp(
            `(?:但|然而|不过|事实上)[^。！？!?；;，,]{0,80}`
            + `(?:本文|本论文|本研究|本工作|作者团队|项目团队)?[^。！？!?；;，,]{0,20}`
            + `(?:代码|源代码|代码仓库|仓库)[^。！？!?；;，,]{0,24}`
            + `(?:已|现已|当前)?(?:开源|公开|开放|可用)`, 'i'
        ).test(segment)) return false;
        return new RegExp(
            `(?:论文|正文|作者|本文|本论文)[^。！？!?；;，,]{0,32}`
            + `(?:未|没有|并未|尚未)(?:明确)?(?:声明|说明|声称|确认|公布|承诺)`
            + `[^。！？!?；;，,]{0,32}${noun}`
            + `[^。！？!?；;，,]{0,24}(?:开源|公开|开放|可用)`, 'i'
        ).test(segment) || new RegExp(
            `(?:资源身份|验证资源|资源记录|本次验证)[^。！？!?；;，,]{0,48}`
            + `(?:亦|也)?(?:无|没有|并无|未见|不存在)[^。！？!?；;，,]{0,48}`
            + `(?:本文|本论文|本研究|本工作)?${noun}`
            + `[^。！？!?；;，,]{0,48}(?:可用|公开|开源|记录)`, 'i'
        ).test(segment);
    };
    const isDatasetRepositoryStatusSummary = (segment, type) => type === 'code'
        && availableTypes.has('dataset')
        && !/(?:本文|本研究|本工作|我们)[^。！？!?；;，,]{0,40}(?:代码|源代码|代码仓库|仓库)/.test(segment)
        && /(?:数据集|语料|ASVspoof|DECRO|WildDeepfake|FakeAVCeleb)/i.test(segment)
        && /(?:代码仓库|仓库)/i.test(segment)
        && /(?:资源可达性|本次(?:核验|验证|检查)|已验证)/i.test(segment);
    const isVerifiedDependencyCodeRepositoryAttribution = (segment, type) => {
        if (type !== 'code'
            || /(?:本文|本研究|本工作|该论文|论文作者|作者团队|项目团队)[^。！？!?；;，,]{0,32}(?:代码仓库|工具仓库)/.test(segment)) {
            return false;
        }
        const modelRepository = /(?:视觉语言|音频语言|语音语言|多模态|基础|预训练)模型(?:的)?代码仓库/.test(segment);
        const toolRepository = /(?:人脸|音频|语音|视觉)(?:处理|分析|对齐|评估)?工具仓库/.test(segment);
        if (!modelRepository && !toolRepository) return false;
        return (!modelRepository || availableTypes.has('model') || availableTypes.has('third_party'))
            && (!toolRepository || availableTypes.has('third_party'));
    };
    const isNegatedResourceCompletenessComparison = (
        segment, matchIndex, matchEnd, type
    ) => {
        if (!['model', 'dataset'].includes(type)) return false;
        const matcher = /(?:不|不能|不可|不应)(?:把|将)[^。！？!?；;，,]{0,24}(?:可访问|可获取|可用)[^。！？!?；;，,]{0,24}(?:等同于|视为|当作)(?<target>[^。！？!?；;]{0,64}?(?:完整)?可用)/g;
        let comparison;
        while ((comparison = matcher.exec(segment)) !== null) {
            const comparisonEnd = comparison.index + comparison[0].length;
            if (matchIndex < comparison.index || matchEnd > comparisonEnd) continue;
            const target = comparison.groups?.target || '';
            if (type === 'model' && /(?:模型)?权重|检查点/.test(target)) return true;
            if (type === 'dataset' && /数据(?:集)?|语料(?:库)?/.test(target)) return true;
        }
        return false;
    };
    const isVerifiedThirdPartyCodeLinkDisclaimer = (value, type) => {
        if (type !== 'code' || !availableTypes.has('third_party')) return false;
        if (/(?:本文|本研究|本工作|该论文|论文作者|作者团队|项目团队)[^。！？!?；;]{0,40}(?:代码|源代码)(?:仓库|链接|地址)?[^。！？!?；;]{0,24}(?:当前)?可用/.test(value)) {
            return false;
        }
        const verifiedThirdPartyLink = /第三方(?:的)?(?:代码|源代码)(?:仓库|链接|地址)[^。！？!?；;]{0,24}(?:当前)?可用/.test(value);
        const systemDisclaimer = /(?:但|不过|然而)[^。！？!?；;]{0,96}(?:不是|不等于|不能等同于|不代表)[^。！？!?；;]{0,48}(?:完整系统|端到端系统)[^。！？!?；;]{0,24}(?:保证|可运行|可用)/.test(value);
        return verifiedThirdPartyLink && systemDisclaimer;
    };
    const isVerifiedPostposedThirdPartyCodeAttribution = (value, type, matchIndex, matchEnd) => {
        if (type !== 'code' || !availableTypes.has('third_party')) return false;
        // Only this explicitly verified third-party link predicate is covered.
        // An adjacent author's own release or a quoted/revoked attribution is
        // still checked independently; no whole-clause availability exemption.
        const pattern = /(?:代码|源代码)(?:仓库|链接|地址)(?:经|已经|已)?(?:核验|验证|确认)(?:为|是)第三方(?:资源)?(?:当前)?可用/gu;
        for (const span of value.matchAll(pattern)) {
            if (matchIndex < span.index || matchEnd > span.index + span[0].length) continue;
            const before = value.slice(0, span.index);
            const prefix = before.split(/[。！？!?；;，,]/u).at(-1);
            const suffix = value.slice(span.index + span[0].length).replace(/^[\s，,]+/u, '');
            const quoted = [['“', '”'], ['‘', '’'], ['「', '」']].some(([open, close]) =>
                before.lastIndexOf(open) > before.lastIndexOf(close))
                || ['"', "'", '`'].some(quote => before.split(quote).length % 2 === 0);
            if (quoted || /(?:作者|本文|本论文|本研究|本工作|我们|否认|否定|并非|不是)/u.test(prefix)
                || /^(?:(?:的|这(?:一|种|个)?|该|上述)?(?:说法|判断|结论|声明|归属)(?:本身|其实|实际)?(?:是|为)?)?(?:错误|不属实|不正确|不准确|不成立)|^(?:的|这(?:一|种|个)?|该|上述)?(?:说法|判断|结论|声明|归属)(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定)/u.test(suffix)) continue;
            return true;
        }
        return false;
    };
    const isBroaderThirdPartyCodeAttribution = (segment, type) => {
        if (type !== 'code' || !availableTypes.has('third_party')) return false;
        if (/(?:本文|本研究|本工作|该论文|论文作者|作者团队|项目团队)[^。！？!?；;，,]{0,40}(?:代码|源代码|代码仓库|仓库)/.test(segment)) {
            return false;
        }
        return /(?:第三方仓库|第三方代码|公开仓库|模型库|工具库|视觉库|语音合成库|官方实现|常用(?:Transformer|模型)库|通用代码托管域名)/i
            .test(segment);
    };
    const isThirdPartyNonPaperCodeDisclaimer = (segment, type) => {
        if (type !== 'code' || !availableTypes.has('third_party')) return false;
        if (new RegExp(
            `(?:本文|本论文|本研究|本工作|作者团队|项目团队)[^。！？!?；;，,]{0,40}`
            + `(?:代码|源代码|代码仓库|仓库)[^。！？!?；;，,]{0,24}`
            + `(?:已|现已|当前)?(?:开源|公开|开放|可用)`, 'i'
        ).test(segment)) return false;
        return new RegExp(
            `(?:第三方|外部)[^。！？!?；;，,]{0,80}(?:仓库|代码|实现)[^。！？!?；;，,]{0,48}`
            + `(?:不是|并非|不属于)[^。！？!?；;，,]{0,24}(?:本论文|本文)[^。！？!?；;，,]{0,16}`
            + `(?:代码|实现|仓库)`, 'i'
        ).test(segment) || new RegExp(
            `不要假设[^。！？!?；;，,]{0,24}(?:官方|本文|本论文)?[^。！？!?；;，,]{0,16}`
            + `(?:代码|源代码|代码仓库|仓库)[^。！？!?；;，,]{0,24}`
            + `(?:已|现已|当前)?(?:开源|公开|开放|可用)`, 'i'
        ).test(segment);
    };
    const isNamedDependencyCodeRepositoryAttribution = (segment, type) => {
        if (type !== 'code' || !availableTypes.has('third_party')) return false;
        if (/(?:本文|本研究|本工作|该论文|论文作者|作者团队|项目团队)[^。！？!?；;，,]{0,40}(?:代码|源代码|代码仓库|仓库|链接)/.test(segment)) {
            return false;
        }
        // 具名的上游模型和工具常常不写「第三方」三个字（例如「DeepSeek-VL2的仓库链接」
        // 「OpenFace工具包链接」）。只有当核验过的身份里确实有某个依赖仓库或链接时，才把
        // 它算作第三方。
        return /(?:\b[A-Z][A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*(?:的)?(?:仓库|链接|地址)|(?:DeepSeek|OpenFace|Whisper|HuBERT|WavLM|Transformers|vLLM)(?:工具包|工具|实现)(?:链接|仓库|地址)?|(?:人脸|音频|语音|视觉)(?:对齐|处理|分析|评估)仓库(?:链接|地址)?)/.test(segment);
    };
    const isGenericModelAvailabilityDistinction = (segment, type) => {
        if (type !== 'model') return false;
        if (/(?:本文|本研究|本工作|该论文|论文作者|作者团队|项目团队)[^。！？!?；;，,]{0,40}(?:模型|权重|检查点)/.test(segment)) {
            // 一句话明说论文没有训练任何被评测的模型、只是在描述基线，它仍然是否认，不是
            // 声称自有资源可用。
            if (!/(?:未训练|没有训练|不训练)[^。！？!?；;，,]{0,32}(?:被评测|评测|基线|模型)/.test(segment)) return false;
        }
        return /(?:开放权重模型|公开权重|商业模型|闭源接口|基线|系统|模型)[^。！？!?；;，,]{0,120}(?:不等于|不等同于|不能等同于|不代表|要区分|需区分|必须区分|直接调用|未训练)[^。！？!?；;，,]{0,96}(?:权重|可下载|可获取|接口|系统|模型|基线)/.test(segment)
            || /(?:未训练|没有训练)[^。！？!?；;，,]{0,48}(?:被评测的)?(?:多模态|基础|预训练)?模型[^。！？!?；;，,]{0,80}(?:基线|公开权重|闭源接口)/.test(segment);
    };
    const isExternalModelUsageAttribution = (segment, type) => {
        if (type !== 'model') return false;
        if (/(?:本文|本研究|本工作|论文作者|作者团队)[^。！？!?；;，,]{0,40}(?:模型|权重|检查点)/.test(segment)) {
            return false;
        }
        return new RegExp(
            `(?:受害模型|既有系统|既有模型|预训练模型|基础模型|外部模型|所用模型)[^。！？!?；;]{0,80}`
            + `(?:通过|使用|调用|加载|依赖)[^。！？!?；;]{0,48}`
            + `(?:应用程序接口|API|接口|已发布权重|公开权重|已发布模型|外部服务)`, 'i'
        ).test(segment);
    };
    const isQualifiedResourceAvailabilityDisclaimer = (segment, type) => {
        const text = String(segment || '');
        const noun = {
            code: '(?:代码|源代码|代码仓库|仓库)',
            model: '(?:模型权重|权重|检查点|模型)',
            dataset: '(?:数据集|语料库|语料)',
            demo: '(?:在线演示|演示页面)',
            reproduction: '(?:复现材料|复现工件|资源)'
        }[type];
        if (!noun || !new RegExp(noun, 'i').test(text)) return false;
        if (type === 'model' && isExternalModelUsageAttribution(text, type)) return true;
        const selfOwnedPositive = new RegExp(
            `(?:本文|本论文|本研究|本工作|作者团队|项目团队)[^。！？!?；;，,]{0,48}`
            + `${noun}[^。！？!?；;，,]{0,28}`
            + `(?:已|现已|当前|本次)?(?:开源|公开|开放|可用|可下载|可获取)`, 'i'
        ).test(text);
        // 校验摘要可以提到好几个公开数据集或工具页面，但并没有声称论文自己的代码可用。
        // 复现清单列出一堆获取要求，同样不等于论文提供了模型权重。
        if (!selfOwnedPositive
            && /(?:资源(?:可达|可得|可用)性|本次(?:收到的)?官方验证|正文开源声明涉及的多个链接)/i.test(text)
            && /(?:所列的|多个链接|涉及的多个链接|状态码为二百|可以写当前可用|显示可用)/i.test(text)) {
            return true;
        }
        if (type === 'model' && !selfOwnedPositive
            && /(?:数据与模型访问|模型访问|访问权限|资源要求|复现所需)/i.test(text)
            && /(?:公开基准|闭源|开源|接口权限|默认配置|权重与生成参数|可用版本)/i.test(text)) {
            return true;
        }
        if (type === 'code' && availableTypes.has('third_party')
            && !new RegExp(
                `(?:本文|本论文|本研究|本工作|作者团队|项目团队)[^。！？!?；;，,]{0,40}`
                + `(?:代码|源代码|代码仓库|仓库)[^。！？!?；;，,]{0,32}`
                + `(?:已|现已|当前)?(?:开源|公开|开放|可用)`, 'i'
            ).test(text)
            && new RegExp(
                `(?:本次收到的资源信息显示|资源状态显示|已验证资源身份|本次核验)[^。！？!?；;，,]{0,56}`
                + `(?:项目页面|项目地址|代码仓库|仓库链接|代码链接)[^。！？!?；;，,]{0,32}`
                + `(?:当前|本次)?可用`, 'i'
            ).test(text)) {
            return true;
        }
        const negativeMarker = text.match(/(?:未发现经验证可用的|未能确认可达|当前不可用|不将其表述为已公开|不能声称|资源身份中没有本文代码的可用记录)/i);
        if (negativeMarker && noun) {
            const before = text.slice(0, negativeMarker.index);
            if (new RegExp(
                `(?:本文|本研究|本工作|作者团队|项目团队)[^。！？!?；;，,]{0,96}`
                + `${noun}[^。！？!?；;，,]{0,120}(?:已|现已|当前)?(?:开源|公开|开放|可用)`, 'i'
            ).test(before)) {
                return false;
            }
            const later = text.slice(negativeMarker.index + negativeMarker[0].length);
            const laterPositive = new RegExp(
                `${noun}[^。！？!?；;，,]{0,32}(?:已|现已|当前|本次)?`
                + `(?:开源|公开|开放|可用|可下载|可获取|确认可用)`, 'i'
            );
            const laterNegative = new RegExp(
                `(?:不能声称|不声称|不将|不把|不可|不应|不宜|不要)[^。！？!?；;，,]{0,48}`
                + `${noun}[^。！？!?；;，,]{0,32}(?:已|现已|当前|本次)?`
                + `(?:开源|公开|开放|可用|可下载|可获取|确认可用)`, 'i'
            );
            if (laterPositive.test(later) && !laterNegative.test(later)) {
                return false;
            }
        }
        if (new RegExp(
            `(?:未发现经验证可用的|未能确认可达|当前不可用|不将其表述为已公开|`
            + `不能声称[^。！？!?；;，,]{0,36}(?:已公开|公开|开源|当前可用|可一键运行)|`
            + `资源身份中没有本文代码的可用记录)`, 'i'
        ).test(text)) {
            return true;
        }
        if (new RegExp(
            `(?:以实际可达为准)[^。！？!?；;，,]{0,100}`
            + `(?:若[^。！？!?；;，,]{0,24}(?:不可用|未能确认)|`
            + `不把[^。！？!?；;，,]{0,40}等同于)`, 'i'
        ).test(text)) {
            return true;
        }
        if (type === 'code' && /把代码可用误解为模型可用/i.test(text)) return true;
        if (type === 'model' && new RegExp(
            `不能仅凭[^。！？!?；;，,]{0,24}代码可用[^。！？!?；;，,]{0,32}`
            + `(?:认定|判断|视为|等同于)[^。！？!?；;，,]{0,24}(?:权重|模型)`
            + `[^。！？!?；;，,]{0,16}(?:公开|开源|可用)`, 'i'
        ).test(text)) {
            return true;
        }
        if (type === 'code' && /(?:没有本文代码的可用记录|不将其表述为已公开|不将其表述为.*(?:公开|开源|可用))/i.test(text)) {
            return true;
        }
        return false;
    };
    const isFabricatedResourceAttribution = (segment, type) => {
        if (!['code', 'dataset', 'model', 'demo', 'reproduction'].includes(type)) return false;
        const noun = {
            code: '(?:代码|源代码|代码仓库|仓库|链接|地址)',
            dataset: '(?:数据集|语料|语料库|数据仓库)',
            model: '(?:模型|权重|检查点)',
            demo: '(?:演示|演示页面|demo)',
            reproduction: '(?:复现材料|复现工件|资源|链接|地址)'
        }[type];
        return new RegExp(`(?:伪造|虚构|杜撰)[^。！？!?；;，,]{0,28}${noun}`, 'i').test(segment);
    };
    const isPostfixedNonEquivalence = (segment, matchIndex, matchEnd) => {
        const tail = segment.slice(matchEnd);
        const disclaimerTail = tail.replace(/^[\s，,]+/, '');
        if (/^(?:[^。！？!?；;，,]{0,32})(?:不等于|并不等于|不能等同于|不代表|不能代表|不可视为|不应视为)/
            .test(tail)) return true;
        if (/^(?:[^。！？!?；;，,]{0,64})(?:不(?:对|就)?[^。！？!?；;，,]{0,28}(?:可达|可访问|可下载|可获取|可用)[^。！？!?；;，,]{0,16}(?:做|作)?(?:断言|声明|确认)|不(?:另行)?(?:声称|表示|确认)[^。！？!?；;，,]{0,24}(?:可达|可访问|可下载|可获取|可用))/.test(disclaimerTail)) return true;
        const prefix = segment.slice(Math.max(0, matchIndex - 48), matchIndex);
        if (/(?:不等于|并不等于|不能等同于|不代表|不能代表|不可视为|不应视为|不意味着)[^。！？!?；;，,]{0,64}(?:代码|源代码|数据集|数据|语料|模型|权重|资源)[^。！？!?；;，,]{0,24}$/.test(prefix)) {
            return true;
        }
        return /(?:不能|不应|不可|不宜)(?:把|将)[^。！？!?；;，,]{0,24}$/
            .test(prefix)
            && /^[^。！？!?；;，,]{0,24}(?:等同于|视为|当作)/.test(tail);
    };
    const isDependencyResourceAttribution = (segment, matchIndex, type) => type === 'model'
        && /(?:调用|使用|采用|加载|依赖|初始化(?:为)?|模型用|用的就)(?:的|的是)?(?:第三方|外部|基础|预训练|现成)?[^。！？!?；;，,]{0,24}$/
            .test(segment.slice(Math.max(0, matchIndex - 48), matchIndex));
    const isBoundedResourceDeclarationDenial = (value, matchIndex, matchEnd) => {
        const resource = '(?:源代码|代码仓库|模型权重|数据集|语料库|复现材料|代码|模型|权重|检查点|数据|资源)';
        const connector = '(?:、|或|与|和|及|以及)';
        const released = '(?:已经|现已|已)?(?:开源|公开|发布|开放|可下载|可获取|可用)';
        const evidenceDenial = new RegExp('(?:尚未|并未|未曾|没有|未)在'
            + '(?:本文|论文|原文|证据|已有证据|现有证据|封存原文|原文证据)中'
            + '(?:明确|直接|可靠)?(?:提供|给出)(?:作者|本文|本研究|本工作)?的?'
            + resource + '(?:' + connector + resource + '){0,3}' + released
            + '的?(?:陈述|声明|证据|说明|表述)', 'gu');
        const hypotheticalDenial = /(?<introduction>(?:不能|不应|不可|不得)(?:把|将)[^。！？!?；;，,]{1,48}(?:建立在|寄托于|依赖于))(?<assumption>[^。！？!?；;，,]{1,64})的假设(?:上|之上)/gu;
        const missingReleaseEvidence = /(?:没有|尚无|并无|不存在)[^。！？!?；;，,]{0,48}(?:作者资源|资源|记录|链接|来源)[^。！？!?；;，,]{0,24}(?:可作|作为|支撑|证明)[^。！？!?；;，,]{1,48}(?:已公开|已开源|可用|可下载|可获取)的证据/gu;
        const missingVerifiedAuthorRelease = new RegExp('(?:没有|尚无|并无|不存在)(?:可验证|可核验)的?'
            + '(?:作者|本文|本论文|本研究|本工作)的?' + resource
            + '(?:(?:' + connector + ')?' + resource + '){0,4}'
            + '(?:可|能)(?:写|称|记)(?:为|作|成)(?:已公开|已开源|当前可用)', 'gu');
        const coordinatedDenial = new RegExp('(' + resource + '(?:' + connector + resource + '){1,4})'
            + released + '([二两三四五2-5])(?:件事|项主张|项声明)(?:都|均|皆)不能默认成立', 'gu');
        const qualifiedLinkDenial = new RegExp('(?:本文|本论文|论文|作者(?:团队)?)?(?:尚未|并未|未|没有)'
            + '(?:公开|提供|发布)(?:可用)?的?' + resource + '(?:' + connector + resource + '){0,4}'
            + '(?:链接|下载地址)', 'gu');
        const describedClaim = '(?:(?:作者|本文|本论文|本研究|本工作)(?:已(?:经)?|现已)(?:开源|公开|发布)|'
            + resource + '(?:已(?:经)?|现已)?(?:开源|公开|发布|可下载|可获取|可用))';
        const forbiddenDescription = new RegExp('(?:不能|不应|不得|不可)(?:把|将)'
            + '(?:它|该链接|该地址|该资源|该状态|这个链接|这个地址|这个资源)(?:直接)?(?:写成|表述为)'
            + describedClaim + '(?:' + connector + describedClaim + '){0,3}', 'gu');
        // A closed direct prohibition can omit the object (“不能表述为作者模型
        // 已开源…”). Exempt only the coordinated claim span, never a later
        // affirmative, quotation, denial revocation or double negative.
        const directDescribedClaim = '(?:作者|本文|本论文|本研究|本工作)的?' + resource
            + '(?:已经|现已|已|当前)?(?:开源|公开|发布|开放|可下载|可获取|可用)';
        const directForbiddenDescription = new RegExp('(?:不能|不应|不得|不可)(?:直接)?(?:表述为|写成)'
            + directDescribedClaim + '(?:' + connector + directDescribedClaim + '){0,3}', 'gu');
        const unsupportedReleaseJudgment = new RegExp('(?:不支持|不足以支持)'
            + '(?:作者|本文|本论文|本研究|本工作)?(?:已经|现已|已)(?:提供|发布|开放)'
            + '(?:完整)?(?:训练)?' + resource + '的(?:判断|结论|说法|声明)', 'gu');
        // Only a closed evidence denial, never arbitrary “不是” clauses.
        // Adjacent resource nouns may be unpunctuated, as in “代码权重”.
        const notReleaseProof = new RegExp('不是(?:作者|本文|本论文|本研究|本工作)?的?'
            + resource + '(?:(?:' + connector + ')?' + resource + '){0,3}'
            + '(?:已经|现已|已)(?:公开|开源|发布|开放)的(?:证明|证据)', 'gu');
        const contains = span => matchIndex >= span.index && matchEnd <= span.index + span[0].length;
        const safeDenialIntroduction = span => {
            const before = value.slice(0, span.index);
            const prefix = before.split(/[。！？!?；;，,]/u).at(-1);
            const suffix = value.slice(span.index + span[0].length).replace(/^[\s，,]+/u, '');
            const quoted = [['“', '”'], ['‘', '’'], ['「', '」']].some(([open, close]) =>
                before.lastIndexOf(open) > before.lastIndexOf(close))
                || ['"', "'", '`'].some(quote => before.split(quote).length % 2 === 0);
            // 引述、反驳否定和双重否定不授权隐藏原来的肯定声明。
            return !quoted && !/[“”‘’「」"'`]|(?:并非|不是|并不是|否认|否定|反驳|证伪|推翻|排除|不代表|不意味着)/u.test(prefix)
                && !/^[“”‘’「」"'`]|^(?:(?:这(?:一|种|个)?(?:说法|判断|否定)|上述(?:说法|判断|否定)|的(?:说法|判断|否定))(?:(?:本身|其实|实际)?(?:是|为))?|(?:是|为))(?:错误|不成立|不准确|不属实|不正确)/u.test(suffix);
        };
        for (const span of value.matchAll(notReleaseProof)) {
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,]/u).at(-1).trim();
            const suffix = value.slice(span.index + span[0].length).replace(/^[\s，,]+/u, '');
            if (contains(span) && safeDenialIntroduction(span)
                && /^(?:(?:但|然而|不过)?\s*(?:这|此|该链接|该演示|这个演示)(?:只是|仅是|是)?(?:演示页|演示页面|链接)?\s*)?$/u.test(prefix)
                && !/^(?:这(?:一|种|个)?|该|上述)?(?:证明|证据|说法|判断|否定)(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定)|^(?:这(?:一|种|个)?|该|上述)?(?:证明|证据|说法|判断|否定)(?:并不|从未)成立/u.test(suffix)) return true;
        }
        for (const span of value.matchAll(directForbiddenDescription)) {
            const rawTail = value.slice(span.index + span[0].length).trimStart();
            const tail = rawTail.replace(/^[，,。；;]+/u, '');
            if (contains(span) && /^(?:[。！？!?；;，,]|$)/u.test(rawTail) && safeDenialIntroduction(span)
                && !/^(?:(?:但|然而|不过)[，,]?\s*)?(?:上述|以上|前述|该|此|这一)?(?:说法|判断|否定|声明|限定)?(?:本身|其实|实际)?(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定|不成立|错误|不正确|不属实)/u.test(tail)) return true;
        }
        for (const pattern of [qualifiedLinkDenial, forbiddenDescription]) for (const span of value.matchAll(pattern)) {
            if (contains(span) && safeDenialIntroduction(span)) return true;
        }
        for (const span of value.matchAll(unsupportedReleaseJudgment)) {
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,]/u).at(-1).trim();
            const suffix = value.slice(span.index + span[0].length).replace(/^[\s，,]+/u, '');
            // 仅覆盖闭合的“证据不支持已提供资源的判断”，保留相邻实际发布
            // 声明；引述、双重否定、转折与撤回不能借此掩盖肯定断言。
            if (contains(span) && safeDenialIntroduction(span)
                && /^(?:(?:本篇|本文|本论文|本研究|本工作)?(?:已有|现有)?证据)?$/u.test(prefix)
                && !/^(?:(?:这(?:一|种|个)?|该|上述)?(?:判断|结论|说法|声明|否定))?(?:本身|其实|实际)?(?:是|为)?(?:错误|不成立|不准确|不属实|不正确)|^(?:(?:这(?:一|种|个)?|该|上述)?(?:判断|结论|说法|声明|否定))?(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定)/u.test(suffix)) return true;
        }
        for (const span of value.matchAll(missingVerifiedAuthorRelease)) {
            const suffix = value.slice(span.index + span[0].length).replace(/^[\s，,]+/u, '');
            if (contains(span) && safeDenialIntroduction(span)
                && !/^(?:这(?:一|种|个)?|该|上述)?(?:说法|判断|否定|声明)(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定)|^(?:这(?:一|种|个)?|该|上述)?(?:说法|判断|否定|声明)(?:并不|从未)成立/u.test(suffix)) return true;
        }
        for (const span of value.matchAll(hypotheticalDenial)) {
            const start = span.index + span.groups.introduction.length;
            const end = start + span.groups.assumption.length;
            if (matchIndex >= start && matchEnd <= end && safeDenialIntroduction(span)) return true;
        }
        for (const span of value.matchAll(missingReleaseEvidence)) {
            if (contains(span) && safeDenialIntroduction(span)
                && !/(?:否认|否定|反驳|证伪|推翻|排除|并非|不是)/u.test(span[0])) return true;
        }
        for (const span of value.matchAll(evidenceDenial)) {
            if (contains(span) && safeDenialIntroduction(span)) return true;
        }
        for (const span of value.matchAll(coordinatedDenial)) {
            const count = span[1].split(new RegExp(connector, 'u')).length;
            const declared = { 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 }[span[2]] || Number(span[2]);
            if (count === declared && contains(span) && safeDenialIntroduction(span)) return true;
        }
        return false;
    };
    const isScopedResourceNonClaim = (segment, matchIndex, matchEnd, type) => {
        const prefix = segment.slice(Math.max(0, matchIndex - 56), matchIndex);
        if (/(?:否定|反驳|证伪)[^。！？!?；;，,]{0,48}$/.test(prefix)) return false;
        // 限定当前肯定词之前的否定作用域；后续转折中的实际发布声明仍要核验。
        const currentAssertionPrefix = prefix.split(/(?:但是|然而|不过|事实上|却|(?<!不)但)/u).at(-1);
        const hasDoubleNegation = /(?:并非|不是|并不是|否认|否定|反驳|证伪)[^。！？!?；;，,]{0,16}(?:未|没有|未曾|尚未|尚无|并无|暂无|未见|不存在)/u.test(currentAssertionPrefix);
        if (/(?:不能(?:据此)?(?:直接)?写成|未能(?:直接|可靠|独立|明确)?确认)[^。！？!?；;，,]{0,48}$/u
            .test(currentAssertionPrefix)) return true;
        if (/(?:无法确认|尚无法确认|未确认|未证明|未报告|不证明|不涉及|不讨论|不等于|不代表|不要(?:把|将|默认|声称|写|表示|推断|断言)|不能(?:据此)?(?:確認|确认|认定|推断|断言|宣告|说)|不能仅凭[^。！？!?；;，,]{1,28}就(?:确认|认定|推断|断言))[^。！？!?；;，,]{0,48}$/.test(prefix)) return true;
        // 「原文也没有声称代码模型数据已开源」「原文未披露自有仓库与可下载权重」
        // 「均未随文公开为可下载版本」「当前尚无可验证的公开仓库」是闭合否定：
        // 否定动词或存在否定后接资源名词串不构成作者当前的开放声明，且受转折和双重否定守卫约束。
        if (!hasDoubleNegation && /(?:未|没有|未曾|尚未)(?:实际|独立|完整|可靠|明确|直接)?(?:发现|找到|看到|确认|证明|表明|显示|提供|给出|收到|声明|声称|绑定|验证|分配|设立|建立|开设|公布|披露|公开|发布|开放)[^。！？!?；;，,]{0,48}$/.test(currentAssertionPrefix)) return true;
        if (!hasDoubleNegation && /(?:未|没有|未曾|尚未)随文(?:公开|发布|开放)(?:为)?[^。！？!?；;，,]{0,24}$/.test(currentAssertionPrefix)) return true;
        if (!hasDoubleNegation && /(?:尚无|并无|暂无|未见|不存在)(?:任何)?(?:可验证|可核验|经验证|已验证)(?:的)?[^。！？!?；;，,]{0,36}$/.test(currentAssertionPrefix)) return true;
        if (/需要补(?:充)?(?:的)?(?:验证|检查|步骤)(?:是|包括)?[^。！？!?；;，,]{0,36}$/.test(prefix)) return true;
        if (/(?:先|再|应|需)(?:单独|分别|实际)?(?:验证|核对|确认)[^。！？!?；;，,]{0,16}$/.test(prefix)) return true;
        if (/属于第三方[^。！？!?；;，,]{0,16}$/.test(prefix) && availableTypes.has('third_party')) return true;
        if (/^(?:的)?(?:情况|状况|状态|信息)(?![^。！？!?；;，,]{0,20}(?:但|然而|不过|已|现已|确认可用))[^。！？!?；;，,]{0,20}(?:尚无法确认|无法确认|未确认|未披露|未提及|未说明|空缺)/
            .test(segment.slice(matchEnd))) return true;
        if (type === 'model' && /(?:权重方差|注意力权重|目标权重|损失权重)[^。！？!?；;]{0,64}(?:开放问题|公开讨论)/.test(segment)) return true;
        if (type === 'dataset' && /(?:数据集|语料库)(?:中|内|里|上)[^。！？!?；;]{0,32}(?:标签|真值|标注|样本)/.test(segment)
            && !/(?:本文|本论文|作者团队)[^。！？!?；;]{0,32}(?:数据集|语料库)[^。！？!?；;]{0,16}(?:已|现已|已经)(?:公开|发布|开放)/.test(segment)) return true;
        if (type === 'dataset' && /全量可用下(?:论文)?(?:报告|评测|测试)/.test(segment)) return true;
        return false;
    };
    // 「将在同行评审发表后存档于公开仓库」是计划中的存档动作，不是当前可达声明。
    // 只有明确的将来时前缀才豁免；已完成或现在时的存档/发布仍按原规则核验。
    const isFutureResourceArchivePlan = (segment, matchIndex) => {
        const prefix = segment.slice(Math.max(0, matchIndex - 64), matchIndex);
        if (/(?:已经|现已|目前已|当前已)[^。！？!?；;，,]{0,16}$/.test(prefix)
            || /(?:已经|现已|目前已|当前已|已)[^。！？!?；;，,]{0,10}(?:存档|存放|保存|上传|托管|发布|提供|开源|公开)(?:于|在|到|至)?$/.test(prefix)) return false;
        return /(?<!已)(?<!经)(?:将(?:会)?|拟|计划|预计|打算|日后|以后|后续|发表后|发表之后|录用后|接收后|见刊后|出版后|上线后)[^。！？!?；;，,]{0,56}(?:存档|存放|保存|上传|托管|发布|提供|放到|放在|提交)(?:于|在|到|至)$/.test(prefix)
            || /(?<!已)(?<!经)将(?:会)?(?:在|于)$/.test(prefix);
    };
    const isReportedReleaseWithCurrentQualification = (value, type, matchIndex, matchEnd) => {
        const sourceNouns = {
            code: '(?:implementation\\s+code|source\\s+code|code(?![- ]switch)|repository|repo)',
            model: '(?:model\\s+weights?|weights?|checkpoints?)',
            dataset: '(?:datasets?|corpus|corpora)', demo: '(?:demo|demonstration)',
            reproduction: '(?:artifacts?|reproduction\\s+materials?)'
        };
        const noun = CONFERENCE_READER_RESOURCE_CLAIM_SPECS[type];
        if (!noun || !sourceNouns[type]) return false;
        const source = String(sourceText || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
            .replace(/^[ \t]*>.*$/gm, ' ').replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, ' ')
            .replace(/[^\S\n]+/g, ' ');
        // 归属作者原文的发布说法须确有同类型来源；可达性仍只由资源身份决定。
        const sourceRelease = new RegExp(`\\b${sourceNouns[type]}\\b[^.!?]{0,64}`
            + '\\b(?:is|are|was|were|has been|have been)\\s+(?:now\\s+|publicly(?:\\s+|[^\\n.!?]{0,120}\\n(?:[^\\n.!?]{0,120}\\n)?\\s*))?'
            + '(?:available|released|open[- ]sourced|accessible|downloadable)\\b', 'giu');
        // Active author statements also report a release. One native PDF line
        // may contain the neighbouring column before the continued predicate.
        const authorRelease = new RegExp('\\b(?:we|the\\s+authors?)\\b[^.!?]{0,180}?\\b'
            + '(?:provide|release|publish)\\s+(?:pre[- ]?trained\\s+)?'
            + sourceNouns[type] + '\\b', 'giu');
        if (![...source.matchAll(sourceRelease), ...source.matchAll(authorRelease)].some(span => {
            const start = Math.max(source.lastIndexOf('.', span.index), source.lastIndexOf('!', span.index),
                source.lastIndexOf('?', span.index)) + 1;
            const tail = source.slice(span.index + span[0].length).split(/[.!?]/u)[0];
            if (/^\b(?:we|the\s+authors?)\b/iu.test(span[0])
                && /\b(?:third[- ]party|external|baseline|prior|previous|existing|cited|quoted|false|incorrect|withdrawn)\b/iu.test(tail)) return false;
            const following = source.slice(span.index + span[0].length).replace(/^[\s.!?]+/u, '');
            if (/^(?:This(?:\s+(?:statement|claim|description))?|These\s+(?:weights|checkpoints))\b[^.!?]{0,80}\b(?:false|incorrect|withdrawn|not\s+(?:true|provided|released))\b/iu.test(following)) return false;
            return !/\b(?:not|never|no|if|unless|would|could|might|may|will|future|plans?|planned|said|says?|claim(?:s|ed)?|reports?|reported|reportedly|alleged|assumed|third[- ]party|external|baseline|prior|previous|existing|related|cited|quotes?|quoted|quotation|false|incorrect)\b/i
                .test(source.slice(start, span.index + span[0].length));
        })) return false;
        const reportedNouns = { code: '(?:源代码|代码|代码仓库)', model: '(?:预训练)?(?:模型权重|权重|检查点)',
            dataset: '(?:数据集|语料库|语料)', demo: '(?:在线演示|演示页面)', reproduction: '(?:复现材料|复现工件)' };
        const reports = new RegExp('(?:(?:论文|原文)(?:正文)?(?:称|说|声明|表示|写了|写明|提到)|'
            + reportedNouns[type] + '在(?:论文|原文)?正文中(?:称|说|声明|表示|写明|提到))'
            + '[^。！？!?；;，,]{1,160}', 'gu');
        for (const report of value.matchAll(reports)) {
            const end = report.index + report[0].length;
            if (matchIndex < report.index || matchEnd > end || !noun.test(report[0])) continue;
            const tail = value.slice(end);
            const qualification = /^\s*[，,]\s*(?:但|然而|不过)([^。！？!?；;，,]{1,180})/u.exec(tail);
            if (!qualification) continue;
            const current = qualification[1];
            const types = resourceTypesIn(current);
            if ((types.size && !types.has(type))
                || /(?:并非|不是|并不是|反驳|否定|推翻)[^。！？!?；;，,]{0,32}(?:没有|未|不可|不能)/u.test(current)) continue;
            const qualified = /(?:本次|当前)[^。！？!?；;，,]{0,100}(?:当前不可达|当前不可用|未能确认|未確認|没有确认可达|未确认可达|无法确认可达|没有完成可达性(?:校验|核验)的绑定|(?:没有收到|未收到)(?:可验证|可核验)的下载(?:地址|链接)|HTTP\s*[45]\d\d)/iu.test(current);
            const newCaveat = /没有完成可达性(?:校验|核验)的绑定|(?:没有收到|未收到)(?:可验证|可核验)的下载(?:地址|链接)/u.exec(current);
            if (newCaveat) {
                const afterCaveat = (current.slice(newCaveat.index + newCaveat[0].length)
                    + value.slice(end + qualification[0].length)).replace(/^[\s，,*_~]+/u, '');
                const beforeCaveat = current.slice(0, newCaveat.index);
                // A quoted, disputed or withdrawn disclaimer is not current
                // qualification of the original reported release statement.
                if (/[“”‘’「」"'\x60]|所谓|(?:并非|不是|否定|反驳)/u.test(beforeCaveat)
                    || /^[“”‘’「」"'\x60]/u.test(afterCaveat)
                    || /^(?:[，,]\s*)?(?:这一|这个|这种|该|上述|的)?(?:说法|判断|结论|声明|否定)?(?:本身|其实|实际)?(?:是|为)?(?:错误|不成立|不属实|不正确|不准确)/u.test(afterCaveat)
                    || /^(?:并|却)?(?:不能|无法|不可|不应)(?:否认|否定|反驳)/u.test(afterCaveat)) continue;
            }
            if (qualified) return true; // 仅豁免这条reported span；后续声明仍逐项核验。
        }
        return false;
    };
    const isSourceBackedDependencyUseOrPriorDatasetAccess = (value, type, matchIndex) => {
        if (!Number.isInteger(matchIndex)) return false;
        const source = String(sourceText || '')
            .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
            .replace(/^[ \t]*>.*$/gm, ' ')
            .replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, ' ')
            .replace(/\s+/g, ' ');
        const contains = span => matchIndex >= span.index && matchIndex < span.index + span[0].length;
        if (type === 'model') {
            // Source explicitly describes three cited, frozen encoder/decoder
            // dependencies; bind the translated feature rates/dimensions too.
            const priorPairs = /\bon three encoder\/decoder pairs\b[^.]{0,100}\.\s+The first\b[\s\S]{0,600}?\[\d+\][\s\S]{0,600}?\bThe second\b[\s\S]{0,600}?\[\d+\][\s\S]{0,600}?\bThe third\b[\s\S]{0,300}?\[\d+\]/i;
            if (!priorPairs.test(source)) return false;
            const properties = source.match(/\bThe log-mel encoder runs at (\d+) frames per second with d=(\d+)(?:d=\2)?; the other two operate at (\d+(?:\.\d+)?)\s*kHz and produce (\d+) frames per second with d=(\d+)(?:d=\5)?\. All three are used at their published weights, without fine-tuning\./i);
            if (!properties) return false;
            const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const [rate, width, sampleRate, otherRate, otherWidth] = properties.slice(1).map(escaped);
            const use = new RegExp(`^(?:对数梅尔|log-mel)编码器每秒${rate}帧、维度${width}，另两种在${sampleRate}\\s*kHz下每秒${otherRate}帧、维度${otherWidth}，(?:都|均)(?:使用|用|采用)已发布权重(?:且)?(?:不|未)微调`, 'iu').exec(value);
            return Boolean(use && contains(use));
        }
        if (type !== 'dataset') return false;
        // This is a replication input from a cited existing corpus, not an
        // author-owned release or a current download assertion. Require the
        // same named dataset and both supplied signal types in the real source.
        for (const input of value.matchAll(/复现(?:时)?(?:应|需)?从公开\s*([A-Za-z][A-Za-z0-9_-]{0,70})\s*数据集的已发布预处理信号和出声录音出发/gu)) {
            if (!contains(input)) continue;
            const before = value.slice(0, input.index).split(/[。！？!?；;，,]/u).at(-1);
            const after = value.slice(input.index + input[0].length).replace(/^[\s，,]+/u, '');
            if (before.trim() || /^[“”‘’「」"'`]|^(?:这一|这种|该|上述|的)?(?:说法|判断|结论|声明)(?:是|为)?(?:错误|不成立|不属实)/u.test(after)) continue;
            const name = input[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const evidence = new RegExp('\\bWe used the publicly available ' + name + ' dataset\\s*\\[\\d+\\]'
                + '[\\s\\S]{0,450}\\bWe used the published preprocessed signals\\b'
                + '[\\s\\S]{0,220}\\bwe used the provided vocalized au-?\\s*dio recordings\\b', 'giu');
            for (const span of source.matchAll(evidence)) {
                const prefix = source.slice(0, span.index).split(/[.!?]/u).at(-1);
                if (!/[“”‘’「」"'`]|\b(?:not|never|no|if|unless|would|could|will|future|plan(?:ned)?|quotes?|quoted|claim(?:s|ed)?|reports?|reported|false)\b/iu.test(prefix)) return true;
            }
        }
        // A cited, named public corpus used as training input is not an offer
        // of an author-owned dataset. Bind just this input span to the same
        // source name; it grants neither current download nor availability.
        for (const input of value.matchAll(/训练(?:数据|语料)(?:来自|是|使用|采用|取自)\s*公开\s*([A-Za-z][A-Za-z0-9_-]{0,70})\s*数据集/gu)) {
            if (!contains(input)) continue;
            const before = value.slice(0, input.index).split(/[。！？!?；;，,]/u).at(-1);
            const after = value.slice(input.index + input[0].length);
            if (before.trim()
                || /可下载|可访问|可获取|可用|可达|开放下载|公开下载/u.test(after)) continue;
            const name = input[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const evidence = new RegExp(`\\bWe\\s+(?:use|used)\\b[^.!?]{0,220}?\\bfrom\\b[^.!?]{0,220}?\\b(?:the\\s+)?public\\s+${name}\\s+dataset\\s*\\[\\d+\\]`, 'giu');
            for (const use of source.matchAll(evidence)) {
                const prefix = source.slice(0, use.index).split(/[.!?]/u).at(-1);
                const framing = source.slice(0, use.index).match(/[^.!?]*[.!?]\s*$/u)?.[0] || '';
                const tail = source.slice(use.index + use[0].length).split(/[.!?]/u)[0];
                if (!/^\s*(?:(?:For|In)\s+[^.!?]{0,100}\btraining\s*,\s*)?$/i.test(prefix)
                    || /\b(?:not|never|without|if|unless|hypothetical|future|plan(?:ned)?|propos(?:e|ed)|would|could|quoted?|report(?:ed|s)?|previous|prior)\b/i.test(prefix)
                    || /\b(?:quot(?:e|es|ed)|report(?:s|ed))\b[^.!?]{0,80}\b(?:following|statement|claim)\b/i.test(framing)
                    || /\b(?:no|not|never|nothing|except|excluding|other than|rather than|instead of|if|unless|hypothetical|would|could|plan(?:ned)?|future|release|publish)\b/i.test(use[0] + tail)) continue;
                const next = source.slice(use.index + use[0].length).replace(/^[\s.!?]+/u, '');
                if (/^(?:This(?: (?:statement|claim|description))?|These (?:data|results))\b[^.!?]{0,80}\b(?:false|withdrawn|fabricated|not (?:used|true)|never used)\b/i.test(next)) continue;
                return true;
            }
        }
        // Only the cited, pre-existing corpus's geographically restricted
        // access span is exempt. The next author/current positive is separate.
        const related = source.match(/\bRelated Work\b[\s\S]{0,5000}?\b(?:Two|Three|Several|Existing)\s+[A-Za-z -]{0,60}corpora exist but with limited utility:\s+a nationally funded\s+([^.[\]]{1,80})dataset\s*\[\d+\]\s+is accessible only within\s+([A-Za-z -]{1,40})\s+and\b/i);
        if (!related) return false;
        // Geographic translation aliases, not paper/model identifiers.
        const regions = { Korea: '韩国', China: '中国', Japan: '日本' };
        const region = regions[related[2].trim()];
        if (!region) return false;
        const pattern = new RegExp(`(?:国内|国家)资助的([^。！？!?；;，,]{1,24})数据集仅在${region}境内可访问`, 'gu');
        for (const prior of value.matchAll(pattern)) {
            if (!contains(prior)) continue;
            const prefix = value.slice(0, prior.index).split(/[。！？!?；;，,]/u).at(-1);
            if (/(?:本文|本论文|本研究|本工作|作者团队|论文作者|我们|自建|新建|自有|新发布)/u.test(prefix + prior[1])) continue;
            // Exact same source noun phrase, or a small terminology translation
            // lexicon (music genres, never paper/model/resource identifiers).
            const sourceNoun = related[1].trim().toLowerCase();
            const nounAliases = { gugak: ['国乐'], 'folk music': ['民间音乐'], 'traditional music': ['传统音乐'] };
            if (prior[1].trim().toLowerCase() !== sourceNoun
                && !(nounAliases[sourceNoun] || []).includes(prior[1].trim())) continue;
            return true;
        }
        return false;
    };

    const isSourceBackedBaselineUsage = (value, type, matchIndex) => {
        if (type !== 'model') return false;
        const source = String(sourceText || '').replace(/\s+/g, ' ');
        const within = match => matchIndex >= match.index && matchIndex < match.index + match[0].length;
        // 仅核原文明确记述的基线检查点使用，不把过去的评测输入提升为作者当前提供权重。
        for (const use of value.matchAll(/论文(?:用的|使用的|采用的)(?:是)?已发布检查点(?:加|并采用|并使用)统一评测协议/gu)) {
            if (within(use) && /\bBaselines?\.\s+We compare\b[\s\S]{0,1200}?\bWe use the released checkpoints and evaluate\b[\s\S]{0,160}?\bthe same protocol\b/i.test(source)) return true;
        }
        for (const use of value.matchAll(/([A-Za-z][A-Za-z0-9_.+-]{0,60})\s*(?:为|是)公开权重直接评测/gu)) {
            if (!within(use)) continue;
            const preceding = value.slice(0, use.index).split(/[。！？!?；;，,]/u).at(-1);
            if (/(?:本文|本论文|本研究|本工作|作者团队|论文作者)/u.test(preceding)) continue;
            const name = use[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const namedBaseline = new RegExp(`\\bbaseline methods?\\b[^.]{0,300}\\b${name}\\b`, 'i');
            const usedRelease = new RegExp(`\\bFor\\s+${name},\\s+we\\s+use\\s+(?:the\\s+)?publicly\\s+released\\s+model\\s+weights\\b`, 'i');
            if (namedBaseline.test(source) && usedRelease.test(source)) return true;
        }
        return false;
    };
    const isSourceBackedPriorModelEvaluation = (value, type, matchIndex) => {
        if (type !== 'model'
            || /(?:本文|本论文|本研究|本工作|作者团队)[^。！？!?；;，,]{0,24}(?:模型|权重|检查点)[^。！？!?；;，,]{0,16}(?:已|现已|已经)(?:开源|公开|发布)/.test(value)) return false;
        // Evaluating released checkpoints describes prior experimental inputs,
        // not a current author-owned weight offer. Bind only this affirmative's
        // exact evaluation span, with the same explicit count in the source.
        const source = String(sourceText || '')
            .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
            .replace(/^[ \t]*>.*$/gm, ' ')
            .replace(/“[^”]*”|「[^」]*」|"[^"\n]*"/g, ' ')
            .replace(/[^\S\n]+/g, ' ');
        for (const evaluation of value.matchAll(/(?:评估|评测|比较|测试)\s*(\d{1,4})\s*(?:个|种|套)\s*(?:(?:已(?:经)?发布|已(?:经)?公开|公开(?:发布)?|开放|既有|现有)的?){1,3}[^。！？!?；;，,]{0,24}?(?:检查点|模型权重|权重|模型)/gu)) {
            if (!Number.isInteger(matchIndex) || matchIndex < evaluation.index
                || matchIndex >= evaluation.index + evaluation[0].length
                || /(?:本文|本论文|本研究|本工作|作者团队|论文作者|我们|自研|自有)/u.test(evaluation[0])) continue;
            const evidence = new RegExp('(?:^|[\\n.!?]\\s*)We\\s+(?:evaluate|assess|benchmark|compare|test)\\s+'
                + evaluation[1] + '\\s+(?:public(?:ly)?|released|published|open[- ]source)\\s+'
                + '(?:[A-Za-z0-9_-]+\\s+){0,8}(?:checkpoints?|models?|weights?)\\b', 'i');
            if (evidence.test(source)) return true;
        }
        const withinEvaluation = span => Number.isInteger(matchIndex)
            && matchIndex >= span.index && matchIndex < span.index + span[0].length;
        for (const comparison of value.matchAll(/(?:比较|评估|评测)(?:已发布|已公开|既有|现有)的?(?:系统|模型|检查点)(?:作为[^。！？!?；;，,]{1,48})?/gu)) {
            if (withinEvaluation(comparison)
                && /(?:^|[\n.!?]\s*)(?:The|Our)\s+(?:goal|aim|objective)\s+is\s+to\s+(?:compare|evaluate|assess|benchmark)\s+(?:the\s+)?(?:released|published|public)\s+(?:systems?|models?|checkpoints?)\b/i.test(source)) return true;
        }
        for (const variation of value.matchAll(/(?:已发布|已公开)的?(?:检查点|模型|系统)(?:在|的)[^。！？!?；;，,]{1,96}(?:各不相同|不同|存在差异|有差异)/gu)) {
            if (withinEvaluation(variation)
                && /(?:^|[\n.!?]\s*)(?:Released|Published|Public)\s+(?:checkpoints?|models?|systems?)\s+(?:differ|vary)\b/i.test(source)) return true;
        }
        if (/(?:已发布检查点)[^。！？!?；;]{0,80}(?:校准参照|校准参考|外推诊断)/.test(value)
            && /\b(?:released|published)\s+checkpoints?\b/i.test(String(sourceText || ''))) return true;
        if (/^(?:前[两三二]者|前者|这些基线)是开放权重/.test(value)) {
            const names = value.match(/(?:Qwen[ -]?3(?:[- ]Omni)?|Audio Flamingo|Whisper|HuBERT|WavLM)/g) || [];
            return names.length > 0 && names.every(name => String(sourceText || '').includes(name));
        }
        return false;
    };
    // 论文把「公开的教师检查点」当作第三方实验输入时，说的是被评测的上游模型，
    // 不是作者自己的模型发布；只有来源明确写到 public checkpoints/teachers 时才豁免，
    // 作者自称自有检查点已公开的句子仍按声明处理。
    const isSourceBackedPublicTeacherCheckpointUsage = (segment, type) => {
        if (type !== 'model') return false;
        if (/(?:本文|本论文|本研究|本工作|作者团队|项目团队|我们)[^。！？!?；;，,]{0,48}(?:模型|权重|检查点)[^。！？!?；;，,]{0,24}(?:已|现已|当前|本次)?(?:开源|公开|开放|可用|发布)/.test(segment)) return false;
        if (!/(?:教师|teacher)[^。！？!?；;，,]{0,16}(?:检查点|模型权重|权重|模型|checkpoints?|models?|weights?)/i.test(segment)) return false;
        const source = String(sourceText || '').replace(/\s+/g, ' ');
        return /(?:experiments?\s+(?:use|run)|we\s+(?:use|run|evaluate|adopt))[^.]{0,160}(?:public\s+(?:checkpoints?|teachers?)|released\s+checkpoints?|open[- ]weight\s+checkpoints?)/i.test(source)
            || /(?:public\s+(?:checkpoints?|teachers?)|released\s+checkpoints?|open[- ]weight\s+checkpoints?)[^.]{0,160}(?:are\s+used|used\s+for|run\s+with)/i.test(source);
    };
    const isBoundedResourceMeaningNonClaim = (value, type, matchIndex, matchEnd) => {
        // Only the matched predicate's complete local grammatical span can be
        // non-assertive. Another resource assertion in this sentence stays live.
        const contains = span => matchIndex >= span.index && matchEnd <= span.index + span[0].length;
        const safe = span => {
            const before = value.slice(0, span.index).split(/[。！？!?；;，,：:]/u).at(-1);
            const after = value.slice(span.index + span[0].length).replace(/^[\s，,*_~]+/u, '');
            return !/[“”‘’「」"'`]|所谓|否认|否定|反驳|证伪|推翻|并非|不是/u.test(before)
                && !/^(?:这(?:一|种|个)?|该|上述)?(?:说法|判断|结论|声明|否定|区分)(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定)/u.test(after)
                && !/^(?:[“”‘’「」"'`]|(?:这(?:一|种|个)?|该|上述|的)?(?:说法|判断|结论|声明|否定|区分)?(?:本身|其实|实际)?(?:是|为)?(?:错误|不成立|不属实|不正确|不准确)|(?:并|却)?(?:不能|无法|不可|不应)(?:否认|否定|反驳))/u.test(after);
        };
        const bounded = pattern => [...value.matchAll(pattern)].some(span => contains(span) && safe(span));
        // Public webpages are a training-text input, not a release of the
        // paper's code. Keep the exemption inside this complete input list;
        // later code/weight availability predicates are checked separately.
        if (type === 'code') for (const span of value.matchAll(/输入是公开网页(?:、(?:教育网页|代码|数学)){1,5}等文本词元(?=[，,。！？!?；;]|$)/gu)) {
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,：:]/u).at(-1);
            if (contains(span) && safe(span) && /^\s*$/u.test(prefix)
                && span[0].split('、').includes('代码')) return true;
        }
        // A scalar loss weight trades privacy for usable output speech, not
        // downloadable model weights. Exempt only this closed output predicate;
        // any adjoining model release/download assertion remains live.
        if (type === 'model') for (const span of value.matchAll(/用部分隐私换回可用语音(?:的原因)?(?=[。！？!?；;，,、]|$)/gu)) {
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,]/u).at(-1);
            if (contains(span) && safe(span)
                && /^(?:这正是)?(?:报告)?系统把锚权重提到\s*\d+(?:\.\d+)?\s*、\s*$/u.test(prefix)) return true;
        }
        // This closed prior-work clause owns its released weights; it does
        // not qualify a paper's own model or a following release assertion.
        if (type === 'model') for (const span of value.matchAll(/已有小模型路线多是蒸馏或微调已发布的大权重(?=[，,。！？!?；;]|$)/gu)) {
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,：:]/u).at(-1);
            if (contains(span) && safe(span) && /^\s*$/u.test(prefix)) return true;
        }
        const safeRecoverySpan = span => {
            const before = value.slice(0, span.index);
            const after = value.slice(span.index + span[0].length).replace(/^[\s，,；;：:。.!?！？]+/u, '')
                .replace(/^(?:但是?|不过|然而)[\s，,：:]*/u, '');
            const quoted = [['“', '”'], ['‘', '’'], ['「', '」']].some(([open, close]) =>
                before.lastIndexOf(open) > before.lastIndexOf(close))
                || ['"', "'", '`'].some(quote => before.split(quote).length % 2 === 0);
            return safe(span) && !quoted && !/[；;]\s*$/u.test(value)
                && !/^(?:这(?:一|种|个)?|该|上述)?(?:说法|判断|结论|声明|否定|区分|限定)(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定|不成立)/u.test(after);
        };
        const resource = '(?:源代码|代码仓库|模型权重|数据集|语料库|代码|模型|权重|检查点|数据|资源)';
        const list = resource + '(?:(?:、|或|与|和|及)' + resource + '){0,4}';
        const release = '(?:已(?:经)?|当前)?(?:公开|开源|开放|可下载|可获取|可用)';
        // A requirement to check a bare capability is not confirmation of it.
        // Bind only those predicates, never an embedded completed release or
        // another assertion later in the sentence. Quoted/revoked instructions
        // retain the same conservative boundary as the other nonclaim spans.
        const checkProperty = '(?:源代码|代码仓库|模型权重|数据集|语料库|复现材料|代码|模型|权重|检查点|数据|资源|系统)'
            + '(?:是否)?可(?:访问|下载|获取|用|运行)';
        const pendingCheck = new RegExp('(?:还|仍)?(?:需要?|应(?:当)?|要|必须)(?:先|再)?(?:分别|逐项)?'
            + '(?:确认|核实|核验|验证|检查|核对)' + checkProperty
            + '(?:[、与和及]' + checkProperty + '){0,3}(?=[、与和及，,。！？!?；;：:]|$)', 'gu');
        const localReference = '(?:(?:(?:本文|本论文|本研究|本工作|作者(?:团队)?)的?)?' + resource
            + '|它们|它|其|该资源|这些资源|上述资源)';
        const localReferences = localReference + '(?:[、或与和及]' + localReference + '){0,3}';
        // These qualifiers must govern this exact predicate. In particular no
        // arbitrary intervening prose/coordination can carry a denial forward.
        const closedQualifier = new RegExp('^\\s*(?:'
            + '(?:不能|不应(?:当)?|不可|不得|不要|不)(?:写|说|声称|表示|说明|证明|确认|认为|断言)(?:' + localReferences + ')?'
            + '|(?:本次|当前|目前)?(?:没有|尚未|并未|未|还未|未能|无法)(?:发现|找到|看到|确认|核实|核验|验证|证明|表明|提供|给出)(?:' + localReferences + ')?'
            + '|(?:' + localReferences + ')?(?:没有|尚未|并未|未)'
            + '|(?:若|如果|假设|是否|能否)' + localReferences
            + ')(?:当前|目前)?\\s*$', 'u');
        const pendingSpans = [...value.matchAll(pendingCheck)].filter(span => {
            if (!safeRecoverySpan(span)) return false;
            const before = value.slice(0, span.index).split(/[。！？!?；;，,：:]/u).at(-1);
            return /^(?:\s*(?:复现(?:时|前)?|因此|后续|下一步))?\s*$/u.test(before);
        });
        for (const span of pendingSpans) {
            if (!contains(span)) continue;
            // An independent affirmative may omit its resource noun. Keep the
            // original predicate live rather than infer pronouns/ownership.
            const claims = new RegExp(`${affirmative.source}|${release}`,
                `${affirmative.flags.replace('g', '')}g`);
            let claim, hasOutsideClaim = false;
            while ((claim = claims.exec(value)) !== null) {
                if (pendingSpans.some(other => claim.index >= other.index
                    && claim.index + claim[0].length <= other.index + other[0].length)) continue;
                const prefix = value.slice(0, claim.index).split(/[。！？!?；;，,：:]/u).at(-1);
                if (closedQualifier.test(prefix)) continue;
                hasOutsideClaim = true; break;
            }
            if (hasOutsideClaim) continue;
            return true;
        }
        // 发布限定也可能在资源名前面；否定只覆盖以「证据」闭合的命题，
        // 不把同句后续真正的开放声明藏在整段豁免里。
        for (const span of value.matchAll(new RegExp('(?:没有|尚无|并无|不存在)'
            + '(?:可验证的)?(?:公开|开源|开放)' + list
            + '(?:可用|可下载|可获取)?的证据', 'gu'))) {
            if (contains(span) && safeRecoverySpan(span)) return true;
        }
        // Only the governed resource proposition is denied. An affirmative
        // embedded object such as 本文已经公开的代码 is outside this grammar.
        const inferredProposition = '(?:(?:作者(?:团队)?|本文|本论文|本研究|本工作)的?)?'
            + '(?:官方)?' + resource + '(?:已(?:经)?|现已)?(?:正式)?(?:开源|公开|发布|开放|可下载|可获取|可用)';
        const deniedInference = new RegExp('(?:不能|不应|不可|不得)(?:仅)?据此(?:直接)?(?:断定|认定|推断|断言)'
            + inferredProposition + '(?:(?:、|或|与|和|及)' + inferredProposition + '){0,3}', 'gu');
        for (const span of value.matchAll(deniedInference)) {
            if (contains(span) && safeRecoverySpan(span)) return true;
        }
        if (bounded(new RegExp('(?:没有|尚无|并无)可验证的' + list + release + '的证据', 'gu'))
            || bounded(new RegExp('(?:没有|尚未|并未)(?:明确)?(?:声称|声明)' + list + release, 'gu'))
            || bounded(new RegExp('不(?:作|做)' + list + '(?:开源|公开)(?:与|和)可用(?:断言|声明)', 'gu'))
            || bounded(/(?:代码仓库|作者仓库|模型权重|权重|数据集|资源)的可达性未在[^。！？!?；;，,]{1,20}确认为可用/gu)) return true;
        if (type === 'code' && bounded(/(?:代码仓库|仓库链接|代码链接)(?:在本次(?:证据|核验)中)?未被确认为(?:当前)?可用/gu)) return true;
        if (type === 'dataset' && (bounded(/数据集中单性别可用数据的最大时长/gu)
            || bounded(/(?:部分)?标为公开的数据集实际上通过所给链接无法获取或只部分发布/gu))) return true;
        const property = '(?:代码(?:开源|公开|可得|可跑|可运行)|开源代码|包可下载|(?:模型)?权重(?:可下载|下载)|(?:端到端)?系统可(?:一键)?运行|演示可听|开源|可运行)';
        const properties = property + '(?:(?:、|与|和)' + property + '){1,3}';
        for (const span of value.matchAll(new RegExp('(?:因此)?(?:应|需|要)把('
            + properties + ')分开(?:核对|核实|确认)', 'gu'))) {
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,：:]/u).at(-1);
            if (contains(span) && safeRecoverySpan(span) && !prefix.trim()) return true;
        }
        // Bare, owner-free concepts followed by an explicit distinction or
        // pending state are not present availability. Ownership is not optional.
        const lists = new RegExp('(' + properties + ')(?:是(?:三件独立的事|三件事|不同的)|三件事|要分开说|要当作三件未确认的事|(?:同样)?未确认|在本篇中均未给出明确证据|更需要分别核验|(?:要|应|需)(?:分开|分别)(?:核实|核对|确认))(?=[，,：:。！？!?；;]|$)', 'gu');
        for (const span of value.matchAll(lists)) {
            if (!contains(span) || !safe(span)) continue;
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,：:]/u).at(-1);
            if (!/^(?:\s*(?:但|因此))?\s*$/u.test(prefix)) continue;
            const items = span[1].split(/、|与|和/u);
            if (new Set(items).size !== items.length) continue;
            const tail = value.slice(span.index + span[0].length).split(/[。！？!?；;]/u)[0];
            const followup = value.slice(span.index + span[0].length).replace(/^[\s，,:：；;]+/u, '')
                .replace(/^(?:但是?|不过|然而|可是)[\s，,:：；;]*/u, '')
                .replace(/^(?:要|应|需)(?:分别|分开)(?:核实|核对|确认|验证|判断)[\s，,:：；;]*/u, '');
            if (/(?:它们|三者|这三项|这些资源|上述资源|全部|所有|均已)[^。！？!?；;]{0,28}(?:公开|开源|可用|可下载|可获取)/u.test(tail)
                || /^(?:它们|三者|两者|这三项|这两项|这些资源|上述资源|全部|所有|均已)[^。！？!?；;，,]{0,28}(?:公开|开源|可用|可下载|可获取|发布|提供)/u.test(followup)) continue;
            return true;
        }
        for (const span of value.matchAll(new RegExp('复现(?:前)?(?:要|应|需)(?:分清三件事[：:]|区分)(' + properties + ')(?:三件事)?(?=[。！？!?；;]|$)', 'gu'))) {
            const items = span[1].split(/、|与|和/u);
            if (contains(span) && safe(span) && new Set(items).size === items.length) return true;
        }
        // 接口访问和权重下载是两个裸概念；只放过完整区分中的谓词，
        // 不让作者归属、引述否认或后续真正的权重声明借此获得可用资格。
        for (const span of value.matchAll(/商用接口与可下载(?:模型)?权重是\s*(?:两|2)\s*回事/gu)) {
            const prefix = value.slice(0, span.index).split(/[。！？!?；;，,：:]/u).at(-1);
            if (contains(span) && safe(span) && /^\s*$/u.test(prefix)) return true;
        }
        if (bounded(/不能(?:把|将)代码(?:可用|可访问)(?:当成|等同于|视为|当作)(?:模型)?权重已公开(?:或|与|和)系统可运行/gu)) return true;
        if (bounded(/这与代码公开是两回事/gu)
            || bounded(/即使(?:模型)?权重可下载也不能等同(?:系统|端到端系统)可一键运行/gu)) return true;
        // Functional availability has a different grammatical object from a
        // repository or downloadable model. Mask that predicate only.
        if (type === 'model' && (bounded(/(?:对应)?模态可用(?=时)/gu)
            || bounded(/可用(?:容量|知识)/gu))) return true;
        if (type === 'dataset' && bounded(/临床可用(?=的结论)/gu)) return true;
        if (type === 'dataset' && bounded(/(?:作为|用作)(?:验证|检验|评估)数据集(?:可用|有效|适用)(?:性)?的基线/gu)) return true;
        if (type === 'code' && (bounded(/(?:从)?各模态仓库取出可用线索/gu)
            || bounded(/数据可得指仓库经注册申请后可访问/gu))) return true;
        const source = String(sourceText || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
            .replace(/^[ \t]*>.*$/gm, ' ').replace(/“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/g, ' ');
        const sourceAffirms = (pattern, checkFollowingRetraction = false, boundQuote = null, accepts = null) => [...source.matchAll(pattern)].some(span => {
            if (boundQuote !== null) {
                let offset = source.indexOf(boundQuote), contained = false;
                while (offset >= 0) {
                    if (span.index >= offset && span.index + span[0].length <= offset + boundQuote.length) {
                        contained = true; break;
                    }
                    offset = source.indexOf(boundQuote, offset + 1);
                }
                if (!contained) return false;
            }
            if (accepts && !accepts(span[0])) return false;
            const before = source.slice(Math.max(0, span.index - 240), span.index).split(/[.!?]/u).at(-1);
            if (/\b(?:not|never|no|if|would|could|might|will|future|planned|plans?|unlikely|likely|expected|intended|may|can|should|must|aims?|whether|said|says?|wrote|written|quoted|quote|quotation|false|untrue|incorrect|inaccurate|claims?|claimed|reports?|reported|reportedly|alleged|assumed|third[- ]party)\b/iu.test(before + span[0])) return false;
            if (!checkFollowingRetraction) return true;
            // 先移除URL，避免域名中的点伪装句界；只核当前声明的句尾与紧邻撤回。
            const tail = source.slice(span.index + span[0].length).replace(/https?:\/\/\S+/gu, '');
            const end = tail.search(/[.!?]/u);
            const continuation = end < 0 ? tail : tail.slice(0, end);
            const next = end < 0 ? '' : tail.slice(end + 1).replace(/^[\s.!?]+/u, '');
            return !/\b(?:not|never|no|if|unless|would|could|might|may|will|future|planned|plans?|assuming)\b/iu.test(continuation)
                && !/^(?:This|That|The|These|Those|Above)(?:\s+(?:statement|claim|assertion|release|description))?\s+(?:(?:is|are|was|were)\s+(?:false|untrue|incorrect|inaccurate|not true|withdrawn|revoked)|(?:has|have)\s+been\s+(?:withdrawn|revoked|denied))\b/iu.test(next);
        });
        // 这些是有来源和确切第三方身份的实验输入。只豁免输入的发布谓词，
        // 作者的新数据、实现或微调后权重仍由各自后续断言核验。
        if (type === 'code') for (const span of value.matchAll(/([A-Za-z][A-Za-z0-9_.+-]{0,79})\s*的起点是\s*([A-Za-z][A-Za-z0-9_.+-]{0,79})\s*仓库已发布的(?:函数|功能)标签和边界注释/gu)) {
            if (!contains(span) || !safeRecoverySpan(span)) continue;
            const dependency = span[2].toLowerCase();
            const evidence = verified.resources.filter(resource => resource.type === 'third_party'
                && resource.origin === 'paper_source' && resource.availability === 'available'
                && (() => {
                    try { return new URL(resource.originalUrl).pathname.split('/').filter(Boolean)
                        .some(part => decodeURIComponent(part).toLowerCase() === dependency); }
                    catch { return false; }
                })());
            if (evidence.some(resource => {
                const url = resource.originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Bind this declaration, this quote and its actual URL together;
                // an affirmative about another repository cannot back a denial.
                const statement = new RegExp('\\bWe construct an MSA dataset from the function\\s+'
                    + 'labels and boundary annotations released with\\b[^.!?]{1,400}' + url, 'giu');
                return sourceAffirms(statement, true, resource.sourceQuote);
            })) return true;
        }
        if (type === 'model') for (const span of value.matchAll(/学生(?:用|使用|采用)\s*([A-Za-z][A-Za-z0-9_.+\- \t]*(?:(?:和|与|、)[A-Za-z][A-Za-z0-9_.+\- \t]*){0,3})\s*的已发布权重/gu)) {
            if (!contains(span) || !safeRecoverySpan(span)) continue;
            // HTML文字层会把脚注1排成「11\n 1\n URL」。仅去除这组闭合脚注，
            // 保留模型名、版本和规模，不能把任意数字当脚注抹掉。
            const clean = text => String(text).replace(/([A-Za-z0-9])(\d{1,2})\2\s+\2\s+https:\/\/\S+/gu, '$1')
                .replace(/\s+/gu, ' ').trim();
            const names = span[1].split(/和|与|、/u).map(name => name.trim());
            const escaped = name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const named = (text, name) => new RegExp('(?:^|[^A-Za-z0-9_.+-])'
                + escaped(name) + '(?=$|[^A-Za-z0-9_.+-])', 'u').test(clean(text));
            const thirdParty = verified.resources.filter(resource => resource.type === 'third_party'
                && resource.origin === 'paper_source' && resource.availability === 'available');
            const initialization = /\bWe initialize the students from the publicly released\s+(?:https?:\/\/\S+|[^.!?]){1,600}?\bcheckpoints\b/giu;
            if (names.every(name => thirdParty.some(resource => named(resource.sourceQuote, name)
                && sourceAffirms(initialization, true, resource.sourceQuote, statement =>
                    statement.includes(resource.originalUrl) && names.every(input => named(statement, input)))))) return true;
        }
        if (type === 'model') {
            const own = '\\b(?:Our|The\\s+proposed)\\s+';
            const checkpoint = '(?:model[ \\t]+)?checkpoints?\\s+(?:is|are|have\\s+been)\\s+(?:open[- ]sourced|publicly\\s+released)\\b';
            // Keep an actual ownership/coordination relation. A single raw PDF
            // column line may intervene after "framework and the"; do not
            // scan arbitrary sentences from Our to somebody else's checkpoint.
            const jointlyOwned = '(?:[A-Za-z0-9-]+[ \\t]+){0,5}(?:framework|system|implementation)'
                + '[ \\t]+and(?:[ \\t]+the)?(?:[ \\t]*\\n[^\\n]{1,180}\\n[ \\t]*|\\s+)'
                + '(?:[A-Za-z][A-Za-z0-9-]*[ \\t]+){0,2}' + checkpoint;
            const ownCheckpointRelease = new RegExp(own + '(?:' + checkpoint + '|' + jointlyOwned + ')', 'giu');
            const ownRelease = [...source.matchAll(ownCheckpointRelease)].some(span => {
                const before = source.slice(Math.max(0, span.index - 200), span.index);
                const framing = before.split(/[.!?]\s*/u).at(-1) + span[0];
                const after = source.slice(span.index + span[0].length, span.index + span[0].length + 180)
                    .replace(/^[\s.,;:]+/u, '').replace(/^(?:but|however)\b[\s,:]*/iu, '');
                return !/\b(?:(?:following|quoted|next)\s+(?:statement|claim|assertion|result)[^.!?\n]{0,48}|(?:Other\s+authors?|A\s+previous\s+(?:paper|study))\s+(?:said|reported|wrote))[.!?:]\s*$/iu.test(before)
                    && !/\b(?:not|never|no|if|would|could|might|will|future|planned|plans?|may|can|should|must|aims?|whether|expected|intended|unlikely|likely|said|says?|wrote|written|quotes?|quoted|quotation|false|untrue|incorrect|claims?|claimed|reports?|reported|alleged|assumed|third[- ]party|prior|previous|baseline|existing|another|their|other\s+(?:authors?|team))\b/iu.test(framing)
                    && !/^(?:if|when|provided|assuming|subject\s+to|only\s+if|in\s+(?:the\s+)?future)\b/iu.test(after)
                    && !/^(?:This|That)\s+(?:is|was)\s+(?:false|untrue|incorrect|inaccurate|not\s+true)\b/iu.test(after)
                    && !/^(?:This|That|The|These|Those|Above)\s+(?:claim|statement|assertion|report|release|availability|checkpoints?|weights?)(?:\s+(?:is|are|was|were|has\s+been|have\s+been))?\s+(?:false|untrue|incorrect|inaccurate|not\s+true|withdrawn|revoked|denied|never\s+(?:released|provided))/iu.test(after);
            });
            const reported = /(?:论文|原文)(?:正文)?(?:称|写明|说明)[^。！？!?；;，,]{0,64}(?:模型(?:检查点|权重)|检查点)(?:已(?:经)?)(?:开源|公开)/gu;
            for (const span of value.matchAll(reported)) {
                if (!contains(span) || !safeRecoverySpan(span) || !ownRelease) continue;
                const tail = value.slice(span.index + span[0].length);
                const qualifier = /(?:但|不过|然而)?本次(?:核验|检查|验证)[^。！？!?；;，,]{0,40}(?:链接|镜像|资源|地址)(?:未能|无法)确认可达[^。！？!?；;]{0,120}?(?:应|需)(?:先)?自行(?:确认|核对)[^。！？!?；;]{0,40}是否可(?:下载|用|获取)/gu;
                for (const qualified of tail.matchAll(qualifier)) {
                    const absolute = { 0: qualified[0], index: span.index + span[0].length + qualified.index };
                    const status = { 0: qualified[0].match(/^[\s\S]*?确认可达/u)[0], index: absolute.index };
                    if (safeRecoverySpan(status) && safeRecoverySpan(absolute)) return true;
                }
            }
        }
        if (type === 'model') {
            if (bounded(/从已发布检查点继续(?:微调)?/gu)
                && sourceAffirms(/\bwe\s+initialize from the released checkpoint\b/giu)) return true;
            for (const span of value.matchAll(/需要的材料包括[^。！？!?；;，,]{1,110}(?:表示|预训练|基础)模型的(?<requirement>可用权重)/gu)) {
                const start = span.index + span[0].length - span.groups.requirement.length;
                if (matchIndex >= start && matchEnd <= start + span.groups.requirement.length && safe(span)) return true;
            }
        }
        // Dataset loading software is not the dataset release. The original
        // source must explicitly release loaders, with current use unverified.
        const unrevokedQualification = !/[“”‘’「」"'`]|所谓|(?:说法|判断|结论|声明)(?:本身|其实|实际)?(?:是|为)?(?:错误|不成立|不属实|不正确|不准确)|(?:不能|无法|不可)(?:否认|否定|反驳)/u.test(value);
        if (type === 'dataset' && unrevokedQualification && bounded(/论文称评测脚本与数据集加载已开源并给出了链接/gu)
            && sourceAffirms(/\bAll code and dataset loaders are[ \t]*(?:[^\n]{0,140}\n)?[ \t]*open-sourced\b/gu)
            && /本次没有可验证的作者资源可用性信息/u.test(value)
            && /具体可用性需读者自行核对[。]?$/u.test(value)) return true;
        if (['code', 'dataset'].includes(type) && unrevokedQualification
            && bounded(/原文写了数据集和代码公开链接/gu)
            && sourceAffirms(/Our dataset and code are publicly avail-\n[^\n]{0,180}\n\s*able\s+at:/gu)
            && /但本次只依据论文文本，不能确认链接当前可用，因此不能写成已公开可用/u.test(value)) return true;
        return false;
    };
    const hasUnqualifiedTypeAffirmative = (
        value, type, noun, { qualificationResource = null } = {}
    ) => {
        const matcher = new RegExp(affirmative.source, `${affirmative.flags.replace('g', '')}g`);
        const clauseTypes = resourceTypesIn(value);
        const occurrences = tokenOccurrences(value);
        const verifiedCodeTypeAbsence = type === 'code' && /(?:已验证(?:可达)?资源|验证资源|资源身份)[^。！？!?；;，,]{0,24}(?:该|本文|本论文|本研究|本工作)?代码(?:类型)?[^。！？!?；;，,]{0,16}(?:没有|无|未见|不存在)[^。！？!?；;，,]{0,24}(?:可用|公开|开源|开放)(?:记录|证据|链接)?/i.test(value);
        const laterVerifiedCodePositive = /(?:但|然而|不过|事实上)[^。！？!?；;，,]{0,48}(?:本文|本论文|本研究|本工作|作者团队|项目团队)?[^。！？!?；;，,]{0,20}代码(?![^。！？!?；;，,]{0,24}(?:没有|无|未见|不存在))[^。！？!?；;，,]{0,24}(?:已|现已|当前)?(?:开源|公开|开放|可用)/i.test(value);
        if (verifiedCodeTypeAbsence && !laterVerifiedCodePositive) return false;
        let match;
        while ((match = matcher.exec(value)) !== null) {
            let exactOccurrence = null;
            if (qualificationResource) {
                const matchCenter = match.index + (match[0].length / 2);
                const byDistance = occurrences.map(occurrence => ({
                    occurrence,
                    distance: matchCenter < occurrence.index
                        ? occurrence.index - matchCenter
                        : matchCenter > occurrence.end ? matchCenter - occurrence.end : 0
                })).sort((left, right) => left.distance - right.distance);
                if (!byDistance.length || byDistance[0].occurrence.resource !== qualificationResource) {
                    continue;
                }
                exactOccurrence = byDistance[0].occurrence;
            }
            const commaBefore = Math.max(value.lastIndexOf('，', match.index), value.lastIndexOf(',', match.index),
                value.lastIndexOf('：', match.index));
            const chineseCommaAfter = value.indexOf('，', match.index + match[0].length);
            const asciiCommaAfter = value.indexOf(',', match.index + match[0].length);
            const commaAfter = [chineseCommaAfter, asciiCommaAfter]
                .filter(index => index >= 0)
                .reduce((minimum, index) => Math.min(minimum, index), value.length);
            let segmentStart = commaBefore + 1;
            let segment = value.slice(segmentStart, commaAfter);
            let localMatchIndex = match.index - segmentStart;
            let localMatchEnd = localMatchIndex + match[0].length;
            let mentions = resourceTypeMentions(segment);
            // 「，当前可用」这种简短状态尾巴，只承接紧挨在它前面那个范围明确的资源位置
            // 短语。
            if (!mentions.length && commaBefore >= 0 && localMatchIndex <= 12
                && /^\s*(?:(?:且|并且|并|均|亦)\s*)?$/i.test(segment.slice(0, localMatchIndex))) {
                const previousChineseComma = value.lastIndexOf('，', commaBefore - 1);
                const previousAsciiComma = value.lastIndexOf(',', commaBefore - 1);
                const previousStart = Math.max(previousChineseComma, previousAsciiComma) + 1;
                const previousSegment = value.slice(previousStart, commaBefore);
                if (previousSegment.length <= 160
                    && /(?:仓库|链接|地址|资源|\brepositor(?:y|ies)\b|\brepo\b)\s*$/i
                        .test(previousSegment)
                    && resourceTypeMentions(previousSegment).length) {
                    segmentStart = previousStart;
                    segment = value.slice(segmentStart, commaAfter);
                    localMatchIndex = match.index - segmentStart;
                    localMatchEnd = localMatchIndex + match[0].length;
                    mentions = resourceTypeMentions(segment);
                }
            }
            const mentionDistance = mention => localMatchIndex >= mention.end
                ? localMatchIndex - mention.end
                : mention.index >= localMatchEnd ? mention.index - localMatchEnd : 0;
            const nearbyMentions = mentions.filter(mention => (
                mentionDistance(mention) <= claimAssociationMaxChars
                && !(mention.index >= localMatchEnd
                    && /(?:但|然而|不过|而)/.test(segment.slice(localMatchEnd, mention.index)))
            ));
            const minimumDistance = nearbyMentions.reduce(
                (minimum, mention) => Math.min(minimum, mentionDistance(mention)),
                Number.POSITIVE_INFINITY
            );
            const nearestMentions = nearbyMentions.filter(mention => (
                mentionDistance(mention) === minimumDistance
            ));
            const associatedTypes = coordinatedResourceTypes(
                segment, nearbyMentions, nearestMentions
            );
            if (!associatedTypes.has(type)) continue;
            // “不能否认作者已开源/代码可下载”是肯定；省略归属者也不能
            // 由后面的普通否定或概念守卫吞掉，明确的缺失否定仍保留。
            const assertionPrefix = segment.slice(0, localMatchIndex);
            if (/(?:不是|并非|并不是)(?:不能(?:证明|说明|确认)|不是|(?:未|尚未|并未|没有|尚无)(?:随文)?(?:公开|发布|开放|披露|可验证))[^。！？!?；;，,]{0,40}$/u.test(assertionPrefix)) return true;
            if (/(?:不能|无法|不可|不应)(?:否认|否定)[^。！？!?；;，,]{0,16}(?:作者|本文|本论文|本研究|本工作)?[^。！？!?；;，,]{0,40}$/u.test(assertionPrefix)
                && !/(?:尚未|并未|未曾|没有|未公开|未发布|未确认|未验证|未发现|未找到|不存在|尚无)/u.test(assertionPrefix)) return true;
            if (/(?:不能|无法|不可|不应)(?:说|声称|断言|认为)(?:证据)?不支持(?:作者|本文|本论文|本研究|本工作)?$/u.test(assertionPrefix)) return true;
            if (isBoundedResourceMeaningNonClaim(value, type, match.index, match.index + match[0].length)
                || isThirdPartyTypeAttribution(segment, type, mentions, localMatchIndex, localMatchEnd)
                || isDataSourceRepositoryAttribution(segment, type)
                || isExistingDatasetAttribution(segment, type)
                || isSelfOwnedResourceAvailabilityDenial(segment, type)
                || isExplicitResourceNonClaim(segment, type)
                || isAvailabilityVerificationDisclaimer(segment, type)
                || isFutureVerificationRecommendation(value, type)
                || isExplicitNonAvailabilityDeclaration(value, type)
                || isDatasetRepositoryStatusSummary(value, type)
                || isVerifiedDependencyCodeRepositoryAttribution(segment, type)
                || isVerifiedThirdPartyCodeLinkDisclaimer(value, type)
                || isVerifiedPostposedThirdPartyCodeAttribution(value, type, match.index, match.index + match[0].length)
                || isBroaderThirdPartyCodeAttribution(segment, type)
                || isThirdPartyNonPaperCodeDisclaimer(value, type)
                || isNamedDependencyCodeRepositoryAttribution(segment, type)
                || isGenericModelAvailabilityDistinction(segment, type)
                || isExternalModelUsageAttribution(value, type)
                || isQualifiedResourceAvailabilityDisclaimer(value, type)
                || isFabricatedResourceAttribution(segment, type)
                || isNegatedResourceCompletenessComparison(
                    segment, localMatchIndex, localMatchEnd, type
                )
                || isDependencyResourceAttribution(segment, localMatchIndex, type)
                || isBoundedResourceDeclarationDenial(value, match.index, match.index + match[0].length)
                || isScopedResourceNonClaim(segment, localMatchIndex, localMatchEnd, type)
                || isFutureResourceArchivePlan(segment, localMatchIndex)
                || isReportedReleaseWithCurrentQualification(value, type, match.index, match.index + match[0].length)
                || isSourceBackedDependencyUseOrPriorDatasetAccess(value, type, match.index)
                || isSourceBackedBaselineUsage(value, type, match.index)
                || isSourceBackedPriorModelEvaluation(value, type, match.index)
                || isSourceBackedPublicTeacherCheckpointUsage(segment, type)
                || isPostfixedNonEquivalence(
                    value.slice(segmentStart), localMatchIndex, localMatchEnd
                )) continue;
            const prefix = segment.slice(Math.max(0, localMatchIndex - 48), localMatchIndex);
            if (directDenialPrefix.test(prefix) || nonConstitutingPrefix.test(prefix)
                || conditionalPrefix.test(prefix)
                || isConceptDistinction(value, match.index, match.index + match[0].length)) continue;
            if (unavailableResources.some(resource => resource.type === type)) {
                const tail = value.slice(match.index + match[0].length);
                const statusTail = maskResourceTokens(tail);
                const typeBoundUnavailable = new RegExp(
                    `(?:${noun.source})[^。！？!?；;]{0,32}${unavailableStatus}`
                        + `|${unavailableStatus}[^。！？!?；;]{0,32}(?:${noun.source})`,
                    'i'
                );
                let exactResourceCorrection = false;
                if (exactOccurrence) {
                    const scopeStart = Math.min(match.index, exactOccurrence.index);
                    const scopeEnd = occurrences
                        .filter(occurrence => occurrence.resource !== qualificationResource
                            && occurrence.index > Math.max(match.index + match[0].length, exactOccurrence.end))
                        .reduce((minimum, occurrence) => Math.min(minimum, occurrence.index), value.length);
                    exactResourceCorrection = new RegExp(unavailableStatus, 'i')
                        .test(maskResourceTokens(value.slice(scopeStart, scopeEnd)));
                }
                const soleTypeLinkCorrection = !qualificationResource && clauseTypes.size <= 1
                    && new RegExp(`(?:但|然而|不过)?[^。！？!?；;]{0,24}`
                        + `(?:本次|当前|核验|检查|链接|地址)[^。！？!?；;]{0,48}${unavailableStatus}`, 'i')
                        .test(statusTail);
                if (exactResourceCorrection
                    || (!qualificationResource && typeBoundUnavailable.test(statusTail))
                    || soleTypeLinkCorrection) continue;
            }
            return true;
        }
        return false;
    };
    const selfReference = /(?:本文|本研究|本工作|该论文|论文作者|作者团队|项目团队|\b(?:our|this\s+(?:paper|work|project)|the\s+authors?)\b)/i;
    const explicitThirdPartyReference = /(?:相关(?:工作|研究|基线)|已有(?:工作|研究|方法|模型|系统)|先前(?:工作|研究|方法|模型|系统)|此前(?:工作|研究|方法|模型|系统)|其他(?:工作|研究|方法|模型|系统|论文|项目)|基线(?:方法|模型|系统|工作)|第三方(?:项目|资源|工作|模型|数据集|仓库|工具|软件|代码|链接)|公开基准|社区(?:项目|资源|仓库)|原工作|原论文|\b(?:existing|prior|previous)\s+(?:work|study|method|model|system)|\bbaseline\s+(?:method|model|system|work)|\bthird[- ]party\s+(?:project|resource|repository|model|dataset|tool|software|code|link)|\bother\s+(?:work|study|paper|project)\b)/i;
    const conflictExcerpt = (value, anchor = '') => {
        const normalized = String(value || '').replace(/\s+/g, ' ').trim();
        const maxChars = 240;
        if (normalized.length <= maxChars) return normalized;
        const anchorIndex = anchor ? normalized.indexOf(anchor) : -1;
        let start = anchorIndex >= 0 ? Math.max(0, anchorIndex - 96) : 0;
        let end = Math.min(normalized.length, start + maxChars);
        if (end === normalized.length) start = Math.max(0, end - maxChars);
        let excerpt = normalized.slice(start, end);
        if (start > 0) excerpt = `…${excerpt.slice(1)}`;
        if (end < normalized.length) excerpt = `${excerpt.slice(0, -1)}…`;
        return excerpt;
    };
    const issues = [];
    const isVerifiedCodeTypeAbsence = value => {
        const text = String(value || '');
        if (!/(?:已验证(?:可达)?资源|验证资源|资源身份)[^。！？!?；;，,]{0,24}(?:该|本文|本论文|本研究|本工作)?代码(?:类型)?[^。！？!?；;，,]{0,16}(?:没有|无|未见|不存在)[^。！？!?；;，,]{0,24}(?:可用|公开|开源|开放)(?:记录|证据|链接)?/i.test(text)) return false;
        return !/(?:但|然而|不过|事实上)[^。！？!?；;，,]{0,48}(?:本文|本论文|本研究|本工作|作者团队|项目团队)?[^。！？!?；;，,]{0,20}代码(?![^。！？!?；;，,]{0,24}(?:没有|无|未见|不存在))[^。！？!?；;，,]{0,24}(?:已|现已|当前)?(?:开源|公开|开放|可用)/i.test(text);
    };
    for (const node of nodes) {
        // 原表标题和单元格（例如 Dataset / Open Source）是来源展示，不能
        // 把相邻单元格拼成作者资源的现在时声明；表外正文仍完整核验。
        let prose = maskProtectedMarkdownTableRegions(String(node.text || ''), { excludeQuotes: false });
        for (const table of extractMarkdownTables(prose)) prose = prose.replace(table.markdown, '\n');
        const text = prose.replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const splitClauses = text.split(/(?<=[。！？!?；;])/u).map(item => item.trim()).filter(Boolean);
        // A directly following semicolon claim about the enumerated two/three
        // resources must stay visible to the bounded concept guard. Do not
        // infer referents across sentences or treat a conditional/denial as a claim.
        const clauses = splitClauses.map((clause, index) => {
            const next = splitClauses[index + 1] || '';
            const collective = /[；;]$/u.test(clause) && clause.length <= 300
                && /[三两二32]\s*(?:件\s*(?:不同的?|独立的?)?(?:事项|事)|回事)/u.test(clause)
                && /^(?:它们|三者|两者|这三项|这两项|这些资源|上述资源)(?:都|均|全部)?(?:已经|现已|已|当前已?|目前已?)?(?:(?:公开|开源)(?:可用|可下载|可获取)?|发布|提供|可用|可下载|可获取)[。！？!?]?$/u.test(next);
            // Only a closed, adjacent explicit retraction may refer back to
            // these new nonclaim spans; no general cross-sentence inference.
            const withdrawn = /(?:不能(?:仅)?据此|(?:不能|不应|不得|不可)(?:直接)?(?:表述为|写成)|需要另行(?:确认|核对)|是(?:三|3)件独立的事[，,](?:需要|仍需)分别验证|论文(?:正文)?称|是[三3]回事)/u.test(clause)
                && /^(?:上述|这一|这种|该)(?:说法|判断|结论|声明|否定|区分|限定)(?:已经|已)?(?:被)?(?:撤回|撤销|推翻|否定|不成立)[。！？!?]?$/u.test(next);
            return collective || withdrawn ? clause + next : clause;
        });
        for (const resource of unavailableResources) {
            const tokens = [resource.originalUrl, resource.sourceUrlToken].filter(Boolean);
            if (tokens.some(token => text.includes(token))) {
                let resourceConflict = false;
                for (const token of tokens) {
                    let offset = text.indexOf(token);
                    while (offset >= 0) {
                        const window = text.slice(
                            Math.max(0, offset - 120), offset + token.length + 120
                        );
                        const noun = CONFERENCE_READER_RESOURCE_CLAIM_SPECS[resource.type];
                        if (noun && !isVerifiedCodeTypeAbsence(window)
                            && hasUnqualifiedTypeAffirmative(window, resource.type, noun, {
                                qualificationResource: resource
                            })) {
                            const excerpt = conflictExcerpt(window, token);
                            issues.push({ path: node.path,
                                message: `${node.path} 把 ${resource.type} 链接声明为已开源或当前可用，`
                                    + `但资源身份记录中的可达状态为 ${resource.availability}`,
                                conflictExcerpt: excerpt });
                            resourceConflict = true;
                            break;
                        }
                        offset = text.indexOf(token, offset + Math.max(1, token.length));
                    }
                    if (resourceConflict) break;
                }
            }
        }
        for (const [type, noun] of Object.entries(CONFERENCE_READER_RESOURCE_CLAIM_SPECS)) {
            if (availableTypes.has(type)) continue;
            const conflict = clauses.find(clause => noun.test(clause)
                && hasUnqualifiedTypeAffirmative(clause, type, noun)
                && !isVerifiedCodeTypeAbsence(clause)
                && (node.kind === 'reproduction' || selfReference.test(clause)
                    || !explicitThirdPartyReference.test(clause)));
            if (conflict) {
                const nounMatch = conflict.match(noun);
                issues.push({ path: node.path,
                    message: `${node.path} 声称本文 ${type} 已开源或当前可用，`
                        + '但资源身份记录中没有该类型处于 available 状态的资源',
                    conflictExcerpt: conflictExcerpt(conflict, nounMatch?.[0] || '') });
            }
        }
    }
    return [...new Map(issues.map(issue => [`${issue.path}:${issue.message}`, {
        ...issue, code: 'reader_resource_availability_claim'
    }])).values()];
}

// 日更、会议及历史读取同一份语义规则；来源能力限制仍由各自 capability policy 判断。
function enforceReaderResourceClaims(draft, identity, sourceText, options = {}) {
    const issues = readerResourceClaimIssues(draft, identity, sourceText, options);
    if (!issues.length) return;
    const error = new Error(`读者文章中的资源声明与已验证的可达状态不一致：${issues[0].message}; `
        + `conflictExcerpt=${JSON.stringify(issues[0].conflictExcerpt)}`);
    error.code = 'READER_RESOURCE_AVAILABILITY_CLAIM';
    error.readerIssues = issues;
    throw error;
}

// 已保存的调用方与测试仍可读取旧会议导出名，避免复制另一套规则。
const conferenceReaderResourceClaimIssues = readerResourceClaimIssues;
const enforceConferenceReaderResourceClaims = enforceReaderResourceClaims;

// Reuse the exact heading typography projection already used to replay old
// assembled Readers. This does not edit or resign their saved plan/article.
function readerPlanHeadingForArticle(planHeading, articleHeading) {
    const heading = normalizeReaderProseFormatting(String(planHeading || '').trim());
    if (heading === articleHeading) return heading;
    const issues = findQuantitativeChineseNumerals(heading).map(issue => ({
        ...issue, code: 'quantitative_chinese_numeral'
    }));
    return normalizeReaderProseFormatting(
        normalizeIssueBoundReaderQuantitativeNumerals(heading, issues), issues
    );
}

function readerResourceClaimDraftFromArticle(plan, article) {
    const headings = [...String(article || '').matchAll(/^### ([^\n]+)\n\n/gm)];
    if (!Array.isArray(plan?.sections) || headings.length !== plan.sections.length
        || new Set(headings.map(heading => heading[1])).size !== headings.length
        || headings.some((heading, index) => {
            const planned = plan.sections[index]?.heading;
            return typeof planned !== 'string' || (heading[1] !== planned
                && heading[1] !== readerPlanHeadingForArticle(planned, heading[1]));
        })) {
        throw Object.assign(new Error('资源声明复核需要与正式计划逐节对应的已装配文章'), {
            code: 'READER_RESOURCE_ARTICLE_STRUCTURE_INVALID', retryable: false
        });
    }
    return { readerTitle: plan.readerTitle, oneSentenceThesis: plan.oneSentenceThesis,
        conceptBridges: plan.conceptBridges,
        ...(plan.implementationSpecs && typeof plan.implementationSpecs === 'object' && !Array.isArray(plan.implementationSpecs)
            ? { implementationSpecs: plan.implementationSpecs } : {}),
        sections: plan.sections.map((section, index) => ({ kind: section.kind,
            heading: headings[index][1],
            body: String(article).slice(headings[index].index + headings[index][0].length,
                index + 1 < headings.length ? headings[index + 1].index : String(article).length)
        })) };
}

module.exports = {
    CONFERENCE_READER_RESOURCE_CLAIM_SPECS,
    buildApiReaderResourceEvidence,
    replayVerifiedReaderResourceIdentity,
    readerResourcePublicationResources,
    readerResourceClaimIssues,
    enforceReaderResourceClaims,
    conferenceReaderResourceClaimIssues,
    enforceConferenceReaderResourceClaims,
    readerPlanHeadingForArticle,
    readerResourceClaimDraftFromArticle
};
