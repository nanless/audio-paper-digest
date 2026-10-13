'use strict';
const clone = value => structuredClone(value);
function readerFields(paper) { return Object.fromEntries(Object.entries(paper || {}).filter(([key]) => /^apiReader/.test(key))); }
function verifiedSource(existing, incoming) {
    const daily = require('./daily-fresh-source-plan'), fresh = require('./fresh-analysis-context');
    if (!existing.sourceSha256 || existing.sourceSha256 !== incoming.sourceSha256
        || incoming.analysisManifest?.sourceAcquisition?.sourceSha256 !== incoming.sourceSha256
        || daily.stableHash(existing.freshRewriteProvenance || null) !== daily.stableHash(incoming.freshRewriteProvenance || null)) return false;
    try {
        const context = fresh.getFreshAnalysisContext();
        if (context) {
            fresh.assertFreshPaper(incoming);
            return Boolean(fresh.readFreshSource(context.runDir, incoming, context));
        }
        const fs = require('node:fs'), path = require('node:path'), cfg = require('../config');
        const runId = incoming.freshRewriteProvenance?.runId;
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(String(runId || ''))) return false;
        const runDir = path.join(cfg.FILES.dailyFreshSourceRunsDir, String(runId || ''));
        const run = JSON.parse(fs.readFileSync(path.join(runDir, 'run.json')));
        return fresh.withFreshAnalysisContext({ runId, runDir, sourceExpectations: run.sourceExpectations }, () => {
            fresh.assertFreshPaper(incoming);
            return Boolean(fresh.readFreshSource(runDir, incoming, fresh.getFreshAnalysisContext()));
        });
    } catch (_) { return false; }
}
function mergeFailedReaderBundle(existing, incoming) {
    const fields = readerFields(incoming);
    if (!Object.keys(fields).length && !incoming.analysisManifest?.stages?.apiReaderArticle) return {};
    const engine = require('../analysis-engine'), daily = require('./daily-fresh-source-plan');
    const candidate = typeof incoming.analysisCheckpoint === 'string'
        ? { ...incoming, analysis: incoming.analysisCheckpoint, parsed: require('../utils').parseAnalysis(incoming.analysisCheckpoint) } : incoming;
    const manifest = clone(incoming.analysisManifest || existing.analysisManifest || {});
    const fees = {};
    for (const key of ['paidResponseHistory', 'llmUsage']) {
        if (incoming[key] === undefined) continue;
        const old = existing[key], added = incoming[key];
        if (old === undefined || daily.stableHash(old) === daily.stableHash(added)) fees[key] = clone(added);
        else if (Array.isArray(old) && Array.isArray(added)) {
            const seen = new Set();
            fees[key] = [...old, ...added].filter(record => {
                const hash = daily.stableHash(record); if (seen.has(hash)) return false; seen.add(hash); return true;
            }).map(clone);
        } else {
            fees[key] = clone(old);
            fees.apiReaderFeeRecordHistory = [...(fees.apiReaderFeeRecordHistory || existing.apiReaderFeeRecordHistory || []),
                { field: key, existing: clone(old), incoming: clone(added) }];
        }
    }
    const histories = {};
    for (const key of ['apiReaderFailedBundleHistory', 'apiReaderFeeRecordHistory']) {
        const records = [...(existing[key] || []), ...(incoming[key] || []), ...(fees[key] || [])];
        const seen = new Set();
        if (records.length) histories[key] = records.filter(record => {
            const hash = daily.stableHash(record); if (seen.has(hash)) return false; seen.add(hash); return true;
        }).map(clone);
    }
    if (verifiedSource(existing, incoming) && engine.hasValidApiReaderV3Records(candidate)) {
        return { ...Object.fromEntries(Object.keys(readerFields(existing)).map(key => [key, undefined])),
            ...clone(fields), ...fees, ...histories, analysisManifest: manifest };
    }
    // 失败的真实 Reader 与请求证明独立保留；旧公开正文只对应它自己的原阶段。
    const packetFields = { ...fields }; delete packetFields.apiReaderFailedBundleHistory;
    const packet = { sourceSha256: incoming.sourceSha256, fields: clone(packetFields),
        stages: Object.fromEntries(Object.entries(incoming.analysisManifest?.stages || {}).filter(([key]) => /^apiReader/.test(key))),
        contracts: Object.fromEntries(Object.entries(incoming.analysisManifest?.contracts || {}).filter(([key]) => /^apiReader/.test(key))) };
    const history = [...(histories.apiReaderFailedBundleHistory || [])];
    if (!history.some(saved => daily.stableHash(saved) === daily.stableHash(packet))) history.push(packet);
    manifest.stages = { ...(manifest.stages || {}) };
    manifest.contracts = { ...(manifest.contracts || {}) };
    for (const key of new Set([...Object.keys(manifest.stages), ...Object.keys(existing.analysisManifest?.stages || {})].filter(key => /^apiReader/.test(key)))) {
        delete manifest.stages[key];
        if (existing.analysisManifest?.stages?.[key]) manifest.stages[key] = clone(existing.analysisManifest.stages[key]);
    }
    for (const key of new Set([...Object.keys(manifest.contracts), ...Object.keys(existing.analysisManifest?.contracts || {})].filter(key => /^apiReader/.test(key)))) {
        delete manifest.contracts[key];
        if (existing.analysisManifest?.contracts?.[key]) manifest.contracts[key] = clone(existing.analysisManifest.contracts[key]);
    }
    const recovery = Object.fromEntries(Object.entries(fields).filter(([key]) => /(?:Draft|Candidate|History|Round|Attempt|Retry|Recovery)/.test(key) && key !== 'apiReaderFailedBundleHistory'));
    return { ...clone(readerFields(existing)), ...clone(recovery), ...fees, ...histories,
        apiReaderFailedBundleHistory: history, analysisManifest: manifest };
}
module.exports = { mergeFailedReaderBundle };
