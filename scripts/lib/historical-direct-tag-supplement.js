'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const aggregate = require('./historical-direct-aggregate.js');
const planApi = require('./historical-direct-rewrite-plan.js');
const runner = require('./historical-direct-rewrite-runner.js');
const fresh = require('./fresh-arxiv-rewrite-source.js');
const pages = require('./historical-direct-page-staging.js');
const tagCatalogApi = require('./tag-catalog.js');
const io = require('./historical-conference-page-projections.js');
const { hasPageTagMetadata } = require('./page-tag-metadata.js');
const CONTRACT = 'historical-direct-taxonomy-supplement-v1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`历史页面标签补充记录被拒绝：${message}`); };

function pageBody(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // 只识别本仓库使用的 YAML 页首格式；正文中的空行和换行符保持原样。
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (!match) fail('页面必须具有起止分隔符完整的 YAML 页首。');
    return text.slice(match[0].length);
}

function classify(canonical, tagCatalog) {
    if (canonical.tagMetadata.registrySha256 !== tagCatalog.registrySha256) fail('分析所用标签词表的 SHA 与指定词表不一致。');
    const resolve = (label, facet) => {
        const matches = tagCatalogApi.resolveLabelCandidates(tagCatalog, label, facet);
        if (matches.length !== 1 || matches[0].status !== 'active') fail(`标签 ${label} 无法唯一对应一个已启用的概念。`);
        return matches[0];
    };
    const task = resolve(canonical.primaryTaskLabel, 'task');
    const method = resolve(canonical.primaryMethodLabel, 'method');
    const concepts = canonical.labels.map(label => {
        const primary = [task, method].filter(c => c.preferredLabel.zh === label);
        return primary.length === 1 ? primary[0] : resolve(label);
    });
    const ids = tagCatalogApi.pruneAncestors(tagCatalog, [...new Set(concepts.map(c => c.id))]).sort();
    if (!ids.includes(task.id) || !ids.includes(method.id)) fail('明确指定的主任务或主方法不在最终概念列表中，或已因上下级关系被移除。');
    return { concepts: ids.map(id => { const c = concepts.find(c => c.id === id); return { id, facet: c.facet, label: c.preferredLabel.zh }; }),
        primaryTaskId: task.id, primaryTaskLabel: task.preferredLabel.zh,
        primaryMethodId: method.id, primaryMethodLabel: method.preferredLabel.zh };
}

function readPlanRegistry({ planFile, registryFile }) {
    const planDocument = io.readStableJson(planFile, '标签补充计划');
    const plan = planApi.normalizePlan(planDocument.value);
    const executionRegistryDocument = io.readStableJson(registryFile, '标签补充的执行登记文件');
    const registry = runner.normalizeRegistry(executionRegistryDocument.value, plan);
    return { plan, registry, planFileSha256: planDocument.fileSha256, registryFileSha256: executionRegistryDocument.fileSha256 };
}

async function buildSupplement(options) {
    const { plan, registry, planFileSha256, registryFileSha256 } = readPlanRegistry(options);
    const tagCatalog = tagCatalogApi.loadTagCatalog(options.registrySnapshot);
    const renderer = pages.currentRendererImplementationSha256();
    const entries = new Map(registry.entries.map(e => [e.paperId, e]));
    const records = {}; const failures = []; const authenticated = [];
    let attempted = 0;
    for (const item of plan.queue) {
        const entry = entries.get(item.paperId);
        if (entry.status !== 'staged' || entry.staging?.pageStaging?.rendererImplementationSha256 !== renderer) continue;
        const selectedPages = item.pages.filter(page => {
            const file = path.resolve(options.blogRoot, page.pagePath);
            if (!file.startsWith(path.resolve(options.blogRoot) + path.sep)) fail('页面路径超出博客仓库目录。');
            const loaded = io.readStableFile(file, '历史页面');
            if (loaded.fileSha256 !== page.pageContentSha256) fail(`页面 ${page.pagePath} 的内容与原保存的 SHA 不一致。`);
            return !hasPageTagMetadata(loaded.bytes);
        });
        if (!selectedPages.length) continue;
        if (options.limit && attempted >= options.limit) break;
        attempted++;
        try {
            const completed = await runner.replayCompletedAnalysisForStaging({ item, active: entry,
                generation: options.generation, executionRoot: options.executionRoot,
                freshArxivSourceRoot: options.freshArxivSourceRoot, readFreshArxivSource: fresh.readFreshArxivRewriteSource });
            const member = aggregate.loadStagedMember({ plan, registryEntry: entry, item,
                stagingRoot: options.stagingRoot, executionRoot: options.executionRoot,
                freshArxivSourceRoot: options.freshArxivSourceRoot,
                publicationMetadataRoot: options.publicationMetadataRoot, currentRendererImplementationSha256: renderer });
            if (aggregate.stableHash(completed.analysis) !== member.canonical.analysisRecordSha256
                || aggregate.stableHash(completed.sourceDescriptor) !== aggregate.stableHash(member.source)) fail('两条核验路径取得的分析记录或来源记录不一致。');
            const classification = classify(member.canonical, tagCatalog);
            const projected = [];
            for (const page of selectedPages) {
                const file = path.resolve(options.blogRoot, page.pagePath);
                const loaded = io.readStableFile(file, '原已保存的历史页面');
                if (loaded.fileSha256 !== page.pageContentSha256) fail(`页面 ${page.pagePath} 的内容与原保存的 SHA 不一致。`);
                const bodySha256 = digest(Buffer.from(pageBody(loaded.bytes), 'utf8'));
                const record = { paperId: item.paperId, runId: item.runId, pageKey: page.pageKey,
                    pageSha256: loaded.fileSha256, bodySha256, pageBodySha256: bodySha256,
                    registrySha256: tagCatalog.registrySha256, registryVersion: tagCatalog.version,
                    canonicalAnalysisSha256: digest(Buffer.from(member.canonical.analysis.analysis, 'utf8')),
                    canonicalAnalysisFileSha256: member.canonical.analysisFileSha256,
                    canonicalAnalysisRecordSha256: member.canonical.analysisRecordSha256,
                    source: structuredClone(member.source), stageProof: { stageFileSha256: member.stageFileSha256,
                        stagingBindingSha256: member.stagingBindingSha256,
                        pageManifestSha256: entry.staging.pageStaging.manifestSha256,
                        rendererImplementationSha256: renderer }, ...classification };
                projected.push([page.pagePath, { ...record, proofSha256: aggregate.stableHash(record) }]);
            }
            for (const [key, value] of projected) { if (records[key]) fail('同一页面路径不能重复写入补充记录。'); records[key] = value; }
            authenticated.push({ paperId: item.paperId, pageCount: projected.length });
        } catch (error) { failures.push({ paperId: item.paperId, pagePaths: selectedPages.map(p => p.pagePath), error: String(error.message) }); }
        if (options.onProgress && (attempted % 50 === 0 || options.limit === attempted)) options.onProgress({ attempted, paperCount: authenticated.length, pageCount: Object.keys(records).length, failures: failures.length });
    }
    const supplement = { contract: CONTRACT, records };
    const report = { contract: `${CONTRACT}-report`, planSha256: plan.planSha256, planFileSha256,
        executionRegistrySha256: registry.registrySha256, registryFileSha256, registrySha256: tagCatalog.registrySha256,
        rendererImplementationSha256: renderer, attempted, authenticated, failures,
        paperCount: authenticated.length, pageCount: Object.keys(records).length,
        supplementSha256: aggregate.stableHash(supplement) };
    return { supplement, report };
}

function writeImmutable(directory, name, value) {
    if (!path.isAbsolute(directory) || !/^[a-z0-9._-]+\.json$/.test(name)) fail('输出目录必须是绝对路径，文件名须只含小写字母、数字、点、下划线或连字符，并以 .json 结尾。');
    io.safeDirectory(directory, '标签补充文件的输出目录', true);
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); const filename = path.join(directory, name);
    try { fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || !io.readStableFile(filename, '不可覆盖的补充文件').bytes.equals(bytes)) throw error; }
    return { filename, fileSha256: digest(bytes) };
}

module.exports = { CONTRACT, pageBody, classify, readPlanRegistry, buildSupplement, writeImmutable };
