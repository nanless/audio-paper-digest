'use strict';

// Historical declarations only. These hashes never grant source, state,
// request, completion or publication authority; normal private handles and
// original record/response/usage verification remain mandatory.
const path = require('node:path');
const crypto = require('node:crypto');
const { strictJson } = require('./strict-json');
const { readRegularBytes, readGitBlob } = require('./git-file-bytes');
const codec = require('./protocol-codec');
const ROOT = path.resolve(__dirname, '../..');
const FILE = path.join(ROOT, 'config/workflow-historical-records.json');
const SHA = /^[a-f0-9]{64}$/;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('Historical workflow declarations are missing, unknown or inconsistent'); };
const exact = (value, fields) => {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
        || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) fail();
};

function validateHistoricalRecords(bytes) {
    const data = strictJson(bytes, 'Historical workflow declarations');
    exact(data, ['filterPolicies', 'keywordMetadataReplay', 'abstractLocatorReplay', 'acquisitionParserReplay']);
    const acquisition = data.acquisitionParserReplay;
    exact(acquisition, ['files', 'originalSourceSha256']);
    exact(acquisition.files, ['scripts/lib/official-conference-acquisition.js', 'scripts/icmc-proceedings.py', 'package-lock.json']);
    if (Object.values(acquisition.files).some(value => !SHA.test(value)) || !SHA.test(acquisition.originalSourceSha256)) fail();
    exact(data.abstractLocatorReplay, ['statement', 'sha256']);
    if (typeof data.abstractLocatorReplay.statement !== 'string'
        || !SHA.test(data.abstractLocatorReplay.sha256)
        || sha(Buffer.from(data.abstractLocatorReplay.statement)) !== data.abstractLocatorReplay.sha256) fail();
    const locator = strictJson(Buffer.from(data.abstractLocatorReplay.statement), 'Original abstract locator');
    exact(locator, ['defaultProfile', 'aaaiProfile', 'profiles']);
    exact(locator.profiles, [locator.defaultProfile, locator.aaaiProfile]);
    for (const profile of Object.values(locator.profiles)) {
        exact(profile, ['rules', 'implementationSha256']);
        if (!SHA.test(profile.implementationSha256)
            || sha(Buffer.from(codec.canonical(profile.rules))) !== profile.implementationSha256) fail();
    }
    const replay = data.keywordMetadataReplay;
    exact(replay, ['policyName', 'implementationPath', 'implementationSha256', 'changes']);
    if (replay.policyName !== 'before-stable-format'
        || replay.implementationPath !== 'scripts/lib/keyword-prefilter.js'
        || !SHA.test(replay.implementationSha256) || !Array.isArray(replay.changes)
        || replay.changes.length !== 3 || replay.changes.some(item => typeof item !== 'string' || !item)) fail();
    const policies = data.filterPolicies;
    exact(policies, ['sourcePins', 'statements', 'recordedHashOnly', 'note']);
    if (!policies.sourcePins || Object.getPrototypeOf(policies.sourcePins) !== Object.prototype
        || !Object.hasOwn(policies.sourcePins, 'scripts/lib/conference-filter.js')
        || !Array.isArray(policies.statements) || policies.statements.length !== 3
        || !Array.isArray(policies.recordedHashOnly) || policies.recordedHashOnly.length !== 2
        || typeof policies.note !== 'string') fail();
    for (const [filename, pin] of Object.entries(policies.sourcePins)) {
        exact(pin, ['oid', 'sha256']);
        if (!/^scripts\/(?:lib\/)?[a-z0-9_-]+\.(?:js|py)$/.test(filename)
            || !/^[a-f0-9]{40}$/.test(pin.oid) || !SHA.test(pin.sha256)) fail();
    }
    const names = new Set(), hashes = new Set();
    const statements = policies.statements.map(record => {
        exact(record, ['name', 'statement', 'sha256']);
        if (!['before-stable-format', 'earlier-keyword-vocabulary', 'preceding-keyword-vocabulary'].includes(record.name)
            || names.has(record.name) || typeof record.statement !== 'string'
            || !SHA.test(record.sha256) || sha(Buffer.from(record.statement, 'utf8')) !== record.sha256
            || hashes.has(record.sha256)) fail();
        names.add(record.name); hashes.add(record.sha256);
        const declaration = strictJson(Buffer.from(record.statement, 'utf8'), 'Original filter policy');
        if (!declaration || Object.getPrototypeOf(declaration) !== Object.prototype
            || typeof declaration.prompt !== 'string' || typeof declaration.parser !== 'string'
            || typeof declaration.keywordPrefilterVersion !== 'string') fail();
        return { ...record, declaration };
    });
    for (const hash of policies.recordedHashOnly) {
        if (!SHA.test(hash) || hashes.has(hash)) fail();
        hashes.add(hash);
    }
    return { sourcePins: structuredClone(policies.sourcePins), statements, keywordMetadataReplay: structuredClone(replay),
        abstractLocatorReplay: structuredClone(locator), acquisitionParserReplay: structuredClone(acquisition),
        recordedHashOnly: [...policies.recordedHashOnly] };
}

let saved;
function originalRecords() {
    if (!saved) {
        const checked = validateHistoricalRecords(readRegularBytes(FILE));
        const pin = checked.sourcePins['scripts/lib/conference-filter.js'];
        const original = readGitBlob(ROOT, pin.oid, pin.sha256).toString('utf8');
        const list = original.match(/const LEGACY_FILTER_POLICY_SHA256_LIST = Object\.freeze\(\[([\s\S]*?)\]\);/);
        const registered = list ? [...list[1].matchAll(/'([a-f0-9]{64})'/g)].map(match => match[1]).sort() : [];
        if (JSON.stringify(registered) !== JSON.stringify([...checked.recordedHashOnly].sort())) fail();
        saved = checked;
    }
    return saved;
}

function filterPolicyHashes() {
    const data = originalRecords();
    return [...data.statements.map(record => record.sha256), ...data.recordedHashOnly];
}
function previousKeywordPolicyHashes() {
    return originalRecords().statements.filter(record => record.name !== 'before-stable-format')
        .map(record => record.sha256);
}
function filterPolicyDeclaration(hash) {
    const found = originalRecords().statements.find(record => record.sha256 === hash);
    if (!found) fail();
    return structuredClone(found.declaration);
}

function originalKeywordMetadata() {
    const found = originalRecords().statements.find(record => record.name === 'before-stable-format');
    return { policySha256: found.sha256, keywordPrefilterVersion: found.declaration.keywordPrefilterVersion,
        conferenceFallbackVersion: found.declaration.coreConferenceFallbackVersion };
}

function originalArxivRequestFormats() {
    const data = originalRecords();
    const read = filename => {
        const pin = data.sourcePins[filename];
        if (!pin) fail();
        return readGitBlob(ROOT, pin.oid, pin.sha256).toString('utf8');
    };
    const identity = read('scripts/lib/paper-identity.js');
    const request = read('scripts/lib/arxiv-source-authority.js');
    const identityTag = identity.match(/const CONTRACT = '([^']+)';/)?.[1];
    const fetcherTag = request.match(/const FETCHER_CONTRACT = '([^']+)';/)?.[1];
    if (!identityTag || !fetcherTag
        || !request.includes('const identity = identityFor(arxivId); const names = namesFor(authorityName, arxivId);')
        || !request.includes('identitySha256: identityApi.identitySha256(identity)')) fail();
    return { identityFormat: codec.recordHeader(identityTag, 'paper-identity'),
        fetcherFormat: codec.recordHeader(fetcherTag, 'official-arxiv-fulltext-extraction') };
}
function originalAbstractLocator() { return structuredClone(originalRecords().abstractLocatorReplay); }
function implementationProfileForOptions(options) {
    if (options.implementationProfile !== undefined && options.promptTextVersion !== undefined) fail();
    if (options.promptTextVersion !== undefined) {
        try { return codec.format(options.promptTextVersion, 'conference-process-implementation-scope', null); }
        catch (error) { throw new Error('会议实现指纹范围没有登记。', { cause: error }); }
    }
    const profile = options.implementationProfile === undefined ? 'active-inputs' : options.implementationProfile;
    if (!['active-inputs', 'frozen-inputs'].includes(profile)) fail();
    return profile;
}
function assertHistoricalAcquisitionParserCompatible() {
    const data = originalRecords(), replay = data.acquisitionParserReplay;
    const pin = data.sourcePins['scripts/lib/official-conference-acquisition.js'];
    if (!pin || pin.sha256 !== replay.originalSourceSha256
        || Object.entries(replay.files).some(([filename, expected]) => sha(readRegularBytes(path.join(ROOT, filename))) !== expected)) fail();
    const original = readGitBlob(ROOT, pin.oid, pin.sha256).toString('utf8');
    const declaration = original.match(/const PARSER_VERSION = '([^']+)';/);
    if (!declaration || declaration[1] !== codec.historicalContract('official-proceedings-parser', 'official-index-identities')) fail();
}

// A formatting view only, selected by the already verified historical window.
// It does not authenticate a window or authorize a request. Every real dispatch
// still checks its actual state/spec/source handles and original request input.
function keywordResultForHistoricalPolicy(result, policySha256) {
    const data = originalRecords(), original = originalKeywordMetadata();
    const replay = data.keywordMetadataReplay;
    if (policySha256 !== original.policySha256
        || sha(readRegularBytes(path.join(ROOT, replay.implementationPath))) !== replay.implementationSha256) fail();
    const profile = result?.profile;
    exact(profile, ['contract', 'schemaFingerprint', 'implementationSha256']);
    if (!codec.isCurrentHeader(profile, 'speech-audio-music-keyword-profile')
        || profile.implementationSha256 !== replay.implementationSha256) fail();
    const { profile: ignored, ...fields } = result;
    return { ...structuredClone(fields), version: original.keywordPrefilterVersion };
}

module.exports = { validateHistoricalRecords, filterPolicyHashes, previousKeywordPolicyHashes, filterPolicyDeclaration,
    originalKeywordMetadata, keywordResultForHistoricalPolicy, originalAbstractLocator, implementationProfileForOptions,
    assertHistoricalAcquisitionParserCompatible, originalArxivRequestFormats };
