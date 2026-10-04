'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const aggregate = require('./historical-direct-aggregate.js');
const planApi = require('./historical-direct-rewrite-plan.js');
const runner = require('./historical-direct-rewrite-runner.js');
const fresh = require('./fresh-arxiv-rewrite-source.js');
const pages = require('./historical-direct-page-staging.js');
const tagCatalogApi = require('./paper-taxonomy.js');
const io = require('./historical-conference-page-projections.js');
const CONTRACT = 'historical-direct-taxonomy-supplement-v1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Historical taxonomy supplement rejected: ${message}`); };

function pageBody(bytes) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // This contract supports the repository's YAML front matter only. Preserve
    // the body byte for byte, including blank lines and line endings.
    const match = text.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    if (!match) fail('page needs a closed YAML front matter');
    return text.slice(match[0].length);
}

function classify(canonical, taxonomy) {
    if (canonical.taxonomy.registrySha256 !== taxonomy.registrySha256) fail('canonical registry snapshot SHA differs');
    const resolve = (label, facet) => {
        const matches = tagCatalogApi.resolveLabelCandidates(taxonomy, label, facet);
        if (matches.length !== 1 || matches[0].status !== 'active') fail(`canonical label is unknown, ambiguous or inactive: ${label}`);
        return matches[0];
    };
    const task = resolve(canonical.primaryTaskLabel, 'task');
    const method = resolve(canonical.primaryMethodLabel, 'method');
    const concepts = canonical.labels.map(label => {
        const primary = [task, method].filter(c => c.preferredLabel.zh === label);
        return primary.length === 1 ? primary[0] : resolve(label);
    });
    const ids = tagCatalogApi.pruneAncestors(taxonomy, [...new Set(concepts.map(c => c.id))]).sort();
    if (!ids.includes(task.id) || !ids.includes(method.id)) fail('explicit primary role is absent or ancestor-pruned');
    return { concepts: ids.map(id => { const c = concepts.find(c => c.id === id); return { id, facet: c.facet, label: c.preferredLabel.zh }; }),
        primaryTaskId: task.id, primaryTaskLabel: task.preferredLabel.zh,
        primaryMethodId: method.id, primaryMethodLabel: method.preferredLabel.zh };
}

function readPlanRegistry({ planFile, registryFile }) {
    const p = io.readStableJson(planFile, 'taxonomy supplement plan');
    const plan = planApi.normalizePlan(p.value);
    const r = io.readStableJson(registryFile, 'taxonomy supplement registry');
    const registry = runner.normalizeRegistry(r.value, plan);
    return { plan, registry, planFileSha256: p.fileSha256, registryFileSha256: r.fileSha256 };
}

async function buildSupplement(options) {
    const { plan, registry, planFileSha256, registryFileSha256 } = readPlanRegistry(options);
    const taxonomy = tagCatalogApi.loadTagCatalog(options.registrySnapshot);
    const renderer = pages.currentRendererImplementationSha256();
    const entries = new Map(registry.entries.map(e => [e.paperId, e]));
    const records = {}; const failures = []; const authenticated = [];
    let attempted = 0;
    for (const item of plan.queue) {
        const entry = entries.get(item.paperId);
        if (entry.status !== 'staged' || entry.staging?.pageStaging?.rendererImplementationSha256 !== renderer) continue;
        const selectedPages = item.pages.filter(page => {
            const file = path.resolve(options.blogRoot, page.pagePath);
            if (!file.startsWith(path.resolve(options.blogRoot) + path.sep)) fail('page path escapes blog root');
            const loaded = io.readStableFile(file, 'historical page');
            return !/^paper_digest_taxonomy_contract:\s*["']?paper-taxonomy-flat-tags-compat-v1/m.test(loaded.bytes.toString('utf8').split('---', 3)[1] || '');
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
                || aggregate.stableHash(completed.sourceDescriptor) !== aggregate.stableHash(member.source)) fail('authenticated source/canonical differs across validators');
            const classification = classify(member.canonical, taxonomy);
            const projected = [];
            for (const page of selectedPages) {
                const file = path.resolve(options.blogRoot, page.pagePath);
                const loaded = io.readStableFile(file, 'historical frozen page');
                if (loaded.fileSha256 !== page.pageContentSha256) fail(`${page.pagePath}: frozen page bytes changed`);
                const bodySha256 = digest(Buffer.from(pageBody(loaded.bytes), 'utf8'));
                const record = { paperId: item.paperId, runId: item.runId, pageKey: page.pageKey,
                    pageSha256: loaded.fileSha256, bodySha256, pageBodySha256: bodySha256,
                    registrySha256: taxonomy.registrySha256, registryVersion: taxonomy.version,
                    canonicalAnalysisSha256: digest(Buffer.from(member.canonical.analysis.analysis, 'utf8')),
                    canonicalAnalysisFileSha256: member.canonical.analysisFileSha256,
                    canonicalAnalysisRecordSha256: member.canonical.analysisRecordSha256,
                    source: structuredClone(member.source), stageProof: { stageFileSha256: member.stageFileSha256,
                        stagingBindingSha256: member.stagingBindingSha256,
                        pageManifestSha256: entry.staging.pageStaging.manifestSha256,
                        rendererImplementationSha256: renderer }, ...classification };
                projected.push([page.pagePath, { ...record, proofSha256: aggregate.stableHash(record) }]);
            }
            for (const [key, value] of projected) { if (records[key]) fail('duplicate page identity'); records[key] = value; }
            authenticated.push({ paperId: item.paperId, pageCount: projected.length });
        } catch (error) { failures.push({ paperId: item.paperId, pagePaths: selectedPages.map(p => p.pagePath), error: String(error.message) }); }
        if (options.onProgress && (attempted % 50 === 0 || options.limit === attempted)) options.onProgress({ attempted, paperCount: authenticated.length, pageCount: Object.keys(records).length, failures: failures.length });
    }
    const supplement = { contract: CONTRACT, records };
    const report = { contract: `${CONTRACT}-report`, planSha256: plan.planSha256, planFileSha256,
        executionRegistrySha256: registry.registrySha256, registryFileSha256, registrySha256: taxonomy.registrySha256,
        rendererImplementationSha256: renderer, attempted, authenticated, failures,
        paperCount: authenticated.length, pageCount: Object.keys(records).length,
        supplementSha256: aggregate.stableHash(supplement) };
    return { supplement, report };
}

function writeImmutable(directory, name, value) {
    if (!path.isAbsolute(directory) || !/^[a-z0-9._-]+\.json$/.test(name)) fail('output path invalid');
    io.safeDirectory(directory, 'taxonomy supplement output', true);
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); const filename = path.join(directory, name);
    try { fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST' || !io.readStableFile(filename, 'immutable supplement').bytes.equals(bytes)) throw error; }
    return { filename, fileSha256: digest(bytes) };
}

module.exports = { CONTRACT, pageBody, classify, readPlanRegistry, buildSupplement, writeImmutable };
