'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const evidence = require('../../scripts/lib/conference-filter-evidence.js');
const discovery = require('../../scripts/lib/conference-discovery.js');
const filter = require('../../scripts/lib/conference-filter.js');

const RUN_ID = '55555555-5555-4555-8555-555555555555';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function createEvidenceHandle({ root, discoveryHandle, runId = RUN_ID, now = '2026-09-06T12:00:00.000Z' }) {
    const evidenceRoot = path.join(root, 'filter-evidence');
    if (!fs.existsSync(evidenceRoot)) fs.mkdirSync(evidenceRoot, { mode: 0o700 });
    const snapshot = discovery.discoveryHandleSnapshot(discoveryHandle);
    evidence.prepareEvidence({ evidenceRunsRoot: evidenceRoot, runId, discoveryHandle, apply: true,
        limit: snapshot.candidateManifest.members.length, now,
        extract: (itemRoot, { request }) => {
            const text = Buffer.from('Abstract\nThis fixture provides sufficiently detailed audio and speech evidence for deterministic authenticated conference filtering tests.\n1 Introduction\nBody.');
            const artifacts = Buffer.from(`${JSON.stringify({
                pages: [{ page: 1, textStart: 0, textEnd: text.length }]
            }, null, 2)}\n`);
            const receipt = Buffer.from('{"fixture":true}\n');
            fs.writeFileSync(path.join(itemRoot, 'text.txt'), text, { mode: 0o600 });
            fs.writeFileSync(path.join(itemRoot, 'artifacts.json'), artifacts, { mode: 0o600 });
            fs.writeFileSync(path.join(itemRoot, 'extraction-receipt.json'), receipt, { mode: 0o600 });
            return { paperId: request.paperId, sourceIdentity: request.sourceIdentity,
                pdf: { sha256: request.source.pdf.sha256 },
                text: { file: 'text.txt', sha256: sha256(text) },
                artifacts: { file: 'artifacts.json', sha256: sha256(artifacts) },
                receipt: { file: 'extraction-receipt.json', fileSha256: sha256(receipt),
                    receiptSha256: 'a'.repeat(64) },
                verification: { verificationSha256: 'b'.repeat(64) } };
        } });
    return { evidenceRoot, runId,
        evidenceHandle: evidence.loadEvidenceHandle({ evidenceRunsRoot: evidenceRoot, runId, discoveryHandle }) };
}

function createFilterSpec({ discoveryHandle, evidenceHandle, overrides = {} }) {
    const catalog = filter.catalogFromDiscoveryHandle(discoveryHandle);
    const snapshot = discovery.discoveryHandleSnapshot(discoveryHandle);
    return {
        contract: filter.SPEC_CONTRACT, version: filter.SPEC_VERSION,
        filterPolicySha256: sha256('policy'), promptSha256: sha256('prompt'),
        model: 'fixture', endpointProtocol: 'openai-responses',
        endpointIdentitySha256: sha256('endpoint identity'), tagCatalogSha256: sha256('tag catalog'),
        evidenceCatalogContract: evidence.CATALOG_CONTRACT,
        discovery: { contract: catalog.contract, conferenceId: catalog.conferenceId,
            catalogSha256: catalog.catalogSha256, reportSha256: snapshot.reportSha256,
            candidateSetSha256: filter.stableHash(catalog.members) },
        evidence: filter.evidenceBindingFromHandle(evidenceHandle, catalog),
        ...overrides
    };
}

// 旧源码由本批前提交直接捕获；只在临时离线样本中运行，不代替当前生产模块。
const LEGACY_FILTER_SOURCE_SHA256 = '862980b2599471e4ff0a67290da69594e02c0d66771e9f37501123447033c0c2';
function loadLegacyFilter(requestLlmJson = async () => { throw new Error('旧样本禁止联网'); }) {
    const Module = require('node:module');
    const filename = path.resolve(__dirname, '../../scripts/lib/conference-filter.js');
    const raw = fs.readFileSync(path.join(__dirname, '../fixtures/conference-filter-v5-source.txt'));
    if (sha256(raw) !== LEGACY_FILTER_SOURCE_SHA256) throw new Error('旧筛选源码归档的内容哈希不匹配');
    const utils = require('../../scripts/utils.js');
    const originalRequest = utils.requestLlmJson;
    try {
        utils.requestLlmJson = requestLlmJson;
        const loaded = new Module(filename, module);
        loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
        loaded._compile(raw.toString('utf8'), filename);
        return loaded.exports;
    } finally { utils.requestLlmJson = originalRequest; }
}

module.exports = { RUN_ID, createEvidenceHandle, createFilterSpec, loadLegacyFilter, LEGACY_FILTER_SOURCE_SHA256 };
