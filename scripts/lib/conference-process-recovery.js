'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_ATTEMPTS = 3;
const RETRY_COOLDOWN_MS = 15 * 60 * 1000;

function readPrivateJson(filename) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
        throw new Error(`Unsafe conference recovery file: ${filename}`);
    }
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const opened = fs.fstatSync(fd), bytes = fs.readFileSync(fd), after = fs.fstatSync(fd);
        const named = fs.lstatSync(filename);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== bytes.length || after.size !== bytes.length
            || after.mtimeMs !== opened.mtimeMs || named.ino !== opened.ino || named.dev !== opened.dev
            || named.size !== bytes.length || named.nlink !== 1 || (named.mode & 0o777) !== 0o600) {
            throw new Error('Conference recovery file changed while reading');
        }
        return JSON.parse(bytes.toString('utf8'));
    } finally { fs.closeSync(fd); }
}

function classifyFailure(error, now) {
    // Do not persist credentials, URLs, or provider response bodies in the scheduler.
    const message = String(error?.message || error || 'analysis failed')
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/\b(api[_-]?key|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
        .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, '[REDACTED]').slice(0, 2000);
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : null;
    let category = 'paper';
    if (/insufficient.balance|GoUsageLimitError|quota.*exhaust|billing|ACCOUNT_POOL.*EXHAUST/i.test(`${code} ${message}`)) category = 'quota';
    else if (/HTTP\s*(401|403)\b|authentication|invalid.api.key|unauthorized/i.test(message)) category = 'authentication';
    else if (/HTTP\s*429\b|rate.limit/i.test(message)) category = 'rate_limit';
    // Demo/resource verification is optional evidence for one paper. A dead
    // demo host must leave that paper retryable, but must not stop the whole
    // conference batch as if the analyzer transport were unavailable.
    else if (code === 'DEMO_TRANSIENT_FAILURE') category = 'paper';
    else if (/^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|REQUEST_DEADLINE_EXCEEDED|REQUEST_SOCKET_TIMEOUT)$/.test(code)) category = 'paper';
    else if (/HTTP\s*5\d\d\b|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|proxy|CONNECT tunnel/i.test(`${code} ${message}`)) category = 'transport';
    else if (/LLM_ACCOUNT_POOL_|model.*not.found|unsupported.model|missing.*API.key|implementation drifted|deep execution config drifted/i.test(`${code} ${message}`)) category = 'configuration';
    else if (code === 'CONFERENCE_SOURCE_UPGRADE_REBIND_REQUIRED') category = 'source_upgrade';
    else if (/integrity|SHA.*mismatch|authority.*drift|unsafe|non.canonical/i.test(message)) category = 'integrity';
    const systemic = ['quota', 'authentication', 'rate_limit', 'transport', 'configuration'].includes(category);
    return { category, code, message, systemic,
        retryable: !['quota', 'authentication', 'integrity', 'configuration', 'source_upgrade'].includes(category) && error?.retryable !== false, at: now };
}

function eligible(item, now) {
    if (item.status === 'complete') return false;
    if (item.status === 'analyzing') return false; // Interrupted request: outcome may have been billed.
    if (item.lastFailure?.retryable === false && item.retryAuthorizedAtAttempt !== item.attempts) return false;
    if (item.attempts - (item.retryBudgetStart || 0) >= MAX_ATTEMPTS) return false;
    return !item.retryNotBefore || Date.parse(now) >= Date.parse(item.retryNotBefore);
}

function resolveProcess(context, deps, api) {
    const root = deps.files.conferenceProcessDir;
    const derived = api.deterministicUuid(api.stableHash(context.authority), 'conference-process-v1');
    if (!fs.existsSync(root)) return derived;
    const matches = [], older = [];
    const withoutImplementation = value => { const copy = { ...value }; delete copy.implementationSha256; return copy; };
    for (const id of fs.readdirSync(root).filter(name => /^[a-f0-9-]{36}$/.test(name))) {
        const directory = api.safeProcessDirectory(root, id, false), filename = path.join(directory, 'state.json');
        if (!fs.existsSync(filename)) continue;
        const state = readPrivateJson(filename);
        if (api.stableHash(withoutImplementation(state.authority)) !== api.stableHash(withoutImplementation(context.authority))) continue;
        api.assertState(state);
        if (state.processId !== id) throw new Error('Conference process directory identity mismatch');
        if (api.stableHash(state.authority) !== api.stableHash(context.authority)) {
            // A process can fail during shared source preparation before any
            // item is sealed or analyzed. In that narrow no-progress case,
            // an implementation change cannot invalidate analysis (there is
            // none to preserve), so let the new implementation derive a new
            // process namespace while retaining the old checkpoint for audit.
            // Once any item has progressed, normal explicit migration rules
            // remain mandatory.
            const untouched = state.status === 'pending'
                && Object.values(state.items || {}).every(item => item.status === 'pending'
                    && item.attempts === 0 && !item.sourceProof && !item.analysisProof && !item.pageProof);
            older.push({ id, untouched }); continue;
        }
        api.assertState(state, { authority: context.authority, paperIds: context.members.map(item => item.paperId).sort() });
        if (state.sourceUpgradePromotion) {
            sourceImplementation(state, directory, api);
        } else if (id !== derived) {
            const records = fs.readdirSync(directory).filter(name => /^implementation-migration(?:-[a-f0-9]{12})?\.json$/.test(name))
                .map(name => readPrivateJson(path.join(directory, name)));
            const record = records.find(value => value.toImplementationSha256 === state.authority.implementationSha256);
            if (!record && !state.sourceImplementationSha256) throw new Error('Migrated process lacks recovery provenance');
            for (const value of records) {
                const { receiptSha256, ...body } = value;
                if (value.processId !== id || receiptSha256 !== api.stableHash(body)) throw new Error('Migration receipt integrity failed');
            }
            sourceImplementation(state, directory, api);
        }
        matches.push({ id, promoted: Boolean(state.sourceUpgradePromotion), worked: Object.values(state.items).some(item => item.attempts > 0 || item.status !== 'pending') });
    }
    const worked = matches.filter(item => item.worked);
    const promoted = worked.filter(item => item.promoted);
    if (promoted.length === 1) return promoted[0].id;
    if (worked.length > 1) throw new Error('Multiple progressed conference processes match; use explicit migration --from');
    if (worked.length) return worked[0].id;
    if (matches.length) return matches.find(item => item.id === derived)?.id || matches[0].id;
    const untouchedOlder = older.filter(item => item.untouched);
    if (older.length && untouchedOlder.length === older.length) return derived;
    if (older.length) throw new Error(`Conference implementation changed; migrate with --from ${older.map(item => item.id).join(' or ')} to preserve analysis`);
    return derived;
}

function sourceImplementation(state, directory, api) {
    const withoutImplementation = value => { const copy = { ...value }; delete copy.implementationSha256; return copy; };
    if (state.sourceUpgradePromotion) {
        const promotion = state.sourceUpgradePromotion;
        const { planSha256, ...plan } = readPrivateJson(path.join(directory, 'source-upgrade-plan.json'));
        if (planSha256 !== api.stableHash(plan) || planSha256 !== promotion.planSha256
            // A promoted process may subsequently pass through an explicit
            // implementation migration.  The signed source-upgrade plan
            // necessarily retains the authority fingerprint from promotion,
            // while the checkpoint records the current implementation.  The
            // source/filter/member authority must still be identical; only
            // this audited implementation field may advance.
            || api.stableHash(withoutImplementation(plan.authority))
                !== api.stableHash(withoutImplementation(state.authority))
            || plan.fromProcessId !== promotion.originalProcessId
            || plan.sourceImplementationSha256 !== promotion.sourceImplementationSha256
            || api.stableHash(plan.papers.map(item => item.paperId).sort()) !== api.stableHash(Object.keys(state.items).sort())
            || api.deterministicUuid(api.stableHash({ ...plan.authority, implementationSha256: plan.sourceImplementationSha256 }),
                'conference-process-v1') !== plan.fromProcessId) throw new Error('Source upgrade promotion plan integrity failed');
        return promotion.sourceImplementationSha256;
    }
    const bindsOrigin = implementationSha256 => /^[a-f0-9]{64}$/.test(implementationSha256 || '')
        && api.deterministicUuid(api.stableHash({ ...state.authority, implementationSha256 }), 'conference-process-v1') === state.processId;
    if (state.sourceImplementationSha256) {
        if (!bindsOrigin(state.sourceImplementationSha256)) throw new Error('Source implementation does not bind original process UUID');
    }
    const records = fs.readdirSync(directory).filter(name => /^implementation-migration(?:-[a-f0-9]{12})?\.json$/.test(name))
        .map(name => readPrivateJson(path.join(directory, name)));
    for (const value of records) {
        const { receiptSha256, ...body } = value;
        if (value.contract !== 'conference-process-implementation-migration-v1' || value.version !== 1
            || value.processId !== state.processId || value.conferenceId !== state.authority.conferenceId
            || !/^[a-f0-9]{64}$/.test(value.fromImplementationSha256 || '')
            || !/^[a-f0-9]{64}$/.test(value.toImplementationSha256 || '')
            || receiptSha256 !== api.stableHash(body)) throw new Error('Migration receipt integrity failed');
    }
    if (state.sourceImplementationSha256) return state.sourceImplementationSha256;
    let implementation = state.authority.implementationSha256;
    const visited = new Set();
    while (!bindsOrigin(implementation)) {
        if (visited.has(implementation)) throw new Error('Migration provenance contains a cycle');
        visited.add(implementation);
        const parents = [...new Set(records.filter(value => value.toImplementationSha256 === implementation)
            .map(value => value.fromImplementationSha256))];
        if (parents.length !== 1) throw new Error('Migration provenance is missing or ambiguous before original process UUID');
        implementation = parents[0];
    }
    return implementation;
}

module.exports = { MAX_ATTEMPTS, RETRY_COOLDOWN_MS, readPrivateJson, classifyFailure, eligible, resolveProcess, sourceImplementation };
