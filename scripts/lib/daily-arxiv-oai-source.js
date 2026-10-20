'use strict';

// Opt-in recovery only. An OAI datestamp is a metadata modification day, never
// the publication time. Both official formats and every resumption page must
// survive a byte-backed cold replay before this source can claim coverage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const CONTRACT = 'daily-arxiv-oai-coverage-v1';
const PREFIX_CONTRACT = 'daily-arxiv-atom-prefix-coverage-v1';
const BASE_URL = 'https://oaipmh.arxiv.org/oai';
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 10000;
const SETS = Object.freeze(Object.fromEntries(['eess.AS', 'eess.SP', 'cs.SD', 'cs.LG', 'cs.AI', 'cs.MM', 'cs.CL']
    .map(category => [category, `${category.split('.')[0]}:${category.replace('.', ':')}`])));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sha = value => hash(JSON.stringify(stable(value)));
const text = value => String(value || '').replace(/\s+/g, ' ').trim();
const same = (a, b) => sha(a) === sha(b);

// ElementTree rejects malformed XML; strict expanded names prevent namespace
// impostors and nested lookalike records. It never resolves external entities.
const XML_PARSER = String.raw`
import sys,json,re,xml.etree.ElementTree as ET
sys.path.insert(0,sys.argv[1])
from runtime_guard import require_external_runtime
require_external_runtime('daily-arxiv-oai-source')
s=sys.stdin.buffer.read(16777217)
if len(s)>16777216: raise ValueError('OAI XML exceeds limit')
if re.search(br'<!\s*(DOCTYPE|ENTITY)\b',s,re.I): raise ValueError('OAI DTD/entities forbidden')
r=ET.fromstring(s); O='{http://www.openarchives.org/OAI/2.0/}'
if r.tag!=O+'OAI-PMH': raise ValueError('OAI namespace/root invalid')
def one(e,n,required=True):
 a=e.findall(n)
 if len(a)>1 or (required and len(a)!=1): raise ValueError('OAI field cardinality '+n)
 return a[0] if a else None
def txt(e): return ''.join(e.itertext()).strip() if e is not None else ''
def val(e,n,required=True):
 v=txt(one(e,n,required))
 if required and not v: raise ValueError('OAI empty field '+n)
 return v
if r.findall(O+'error'): raise ValueError('OAI protocol error: '+str([(e.attrib,txt(e)) for e in r.findall(O+'error')]))
q=one(r,O+'request'); p=one(r,O+'ListRecords'); result=[]
if len([e for e in r.iter() if e.tag.rsplit('}',1)[-1]=='record'])!=len(p.findall(O+'record')): raise ValueError('OAI nested/foreign record')
for rec in p.findall(O+'record'):
 h=one(rec,O+'header')
 if h.attrib.get('status'): raise ValueError('OAI deleted/status record cannot establish full source coverage')
 m=one(rec,O+'metadata')
 if len(m)!=1: raise ValueError('OAI metadata cardinality')
 x=m[0]; kind=x.tag
 if kind=='{http://arxiv.org/OAI/arXivRaw/}arXivRaw': prefix='arXivRaw'; ns='{http://arxiv.org/OAI/arXivRaw/}'
 elif kind=='{http://arxiv.org/OAI/arXiv/}arXiv': prefix='arXiv'; ns='{http://arxiv.org/OAI/arXiv/}'
 else: raise ValueError('OAI foreign metadata namespace')
 z={'identifier':val(h,O+'identifier'),'datestamp':val(h,O+'datestamp'),'sets':[txt(e) for e in h.findall(O+'setSpec')],
    'prefix':prefix,'id':val(x,ns+'id'),'title':val(x,ns+'title'),'abstract':val(x,ns+'abstract'),
    'categories':val(x,ns+'categories').split()}
 if prefix=='arXivRaw':
  z['rawAuthors']=val(x,ns+'authors');z['versions']=[{'version':e.attrib.get('version'),'date':val(e,ns+'date')} for e in x.findall(ns+'version')]
 else:
  z['created']=val(x,ns+'created');z['updated']=val(x,ns+'updated',False)
  a=one(x,ns+'authors'); z['authors']=[]
  for e in a.findall(ns+'author'):
   z['authors'].append({'keyname':val(e,ns+'keyname'),'forenames':val(e,ns+'forenames',False),'suffix':val(e,ns+'suffix',False)})
  if len(a)!=len(z['authors']) or not z['authors']: raise ValueError('OAI structured authors invalid')
 result.append(z)
t=one(p,O+'resumptionToken',False)
out={'responseDate':val(r,O+'responseDate'),'request':dict(q.attrib),'requestBase':txt(q),'records':result,'token':txt(t),'tokenAttributes':dict(t.attrib) if t is not None else {}}
print(json.dumps(out,ensure_ascii=False))
`;

function parseOaiXml(xml) {
    require('../env-loader').requireExternalRuntime('daily-arxiv-oai-source');
    const input = Buffer.isBuffer(xml) ? xml : Buffer.from(String(xml), 'utf8');
    if (!input.length || input.length > MAX_BYTES) throw new Error('OAI XML response size invalid');
    const result = spawnSync('bash', [path.join(__dirname, '../python-runtime.sh'), '-c', XML_PARSER,
        path.join(__dirname, '..')], { input, encoding: 'utf8', maxBuffer: MAX_BYTES, timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error(`OAI XML parse failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
    return JSON.parse(result.stdout);
}

function validateBoundary(categoryId, boundary) {
    require('./daily-fetch-boundary').validateDailyFetchBoundary(boundary);
    if (!Object.hasOwn(SETS, categoryId)) throw new Error('Unsupported daily OAI category');
    const witness = boundary.continuity?.required
        ? boundary.continuity.witnesses?.arxiv?.find(item => item.categoryId === categoryId) : null;
    if (boundary.continuity?.required && !witness) throw new Error('OAI missing original continuity witness');
    return witness;
}

function validateTrigger(trigger, boundary, categoryId) {
    const health = trigger?.health || trigger?.sourceHealth || trigger;
    const prefix = health?.provider?.categoryPrefix;
    const date = prefix?.dateQueryFailure?.health;
    const windowMatches = provider => provider?.boundaryIdentity === boundary.identitySha256
        && provider?.window?.since === boundary.since && provider.window.until === boundary.until
        && provider.window.covered === false;
    if (health?.ok !== false || !windowMatches(health?.provider) || !windowMatches(date?.provider)
        || health.provider.window.coverageContract !== PREFIX_CONTRACT
        || prefix?.contract !== PREFIX_CONTRACT || prefix.categoryId !== categoryId
        || prefix.boundaryIdentity !== boundary.identitySha256
        || (health.categoryId || health.id) !== categoryId
        || (health.categoryId !== undefined && health.categoryId !== categoryId)
        || (health.id !== undefined && health.id !== categoryId)
        || !health.failures?.length || !health.failures.every(item => item.error === 'HTTP 429')
        || !date?.failures?.length || !date.failures.every(item => item.error === 'HTTP 429')
        || (date.categoryId || date.id) !== categoryId
        || (date.categoryId !== undefined && date.categoryId !== categoryId)
        || (date.id !== undefined && date.id !== categoryId)
        || date?.provider?.boundaryIdentity !== boundary.identitySha256) {
        throw new Error('OAI recovery requires original date-query and category-prefix HTTP 429 evidence');
    }
}

function urlFor(prefix, categoryId, boundary, token) {
    const url = new URL(BASE_URL);
    url.searchParams.set('verb', 'ListRecords');
    if (token) url.searchParams.set('resumptionToken', token);
    else {
        url.searchParams.set('metadataPrefix', prefix);
        url.searchParams.set('set', SETS[categoryId]);
        url.searchParams.set('from', boundary.since.slice(0, 10));
    }
    return url.href;
}

function isoDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new Error('OAI invalid calendar date');
    }
    return value;
}

function officialDateCursor(token, prefix, categoryId, boundary, responseDate) {
    if (!token) return null;
    // Other OAI implementations can use opaque tokens. Only a query-shaped
    // token claims this official server's quote(urlencode(params + skip)) form;
    // a malformed claimed form must not escape into the opaque-token path.
    const queryShape = /(?:^|%26|&)(?:verb|metadataPrefix|from|set|skip)(?:%|=)/;
    let decoded;
    try { decoded = decodeURIComponent(token); }
    catch {
        if (queryShape.test(token)) throw new Error('OAI official date cursor encoding invalid');
        return null;
    }
    if (!queryShape.test(token) && !queryShape.test(decoded)) return null;
    const entries = [...new URLSearchParams(decoded)];
    const names = entries.map(([name]) => name);
    if (!same([...names].sort(), ['from', 'metadataPrefix', 'set', 'skip', 'verb'])
        || new Set(names).size !== names.length
        || encodeURIComponent(new URLSearchParams(entries).toString()) !== token) {
        throw new Error('OAI official date cursor fields/encoding invalid');
    }
    const values = Object.fromEntries(entries);
    if (values.verb !== 'ListRecords' || values.metadataPrefix !== prefix || values.set !== SETS[categoryId]
        || !/^(?:0|[1-9]\d*)$/.test(values.skip) || !Number.isSafeInteger(Number(values.skip))) {
        throw new Error('OAI official date cursor identity/skip invalid');
    }
    const from = isoDay(values.from);
    if (from < boundary.since.slice(0, 10) || from > responseDate.slice(0, 10)) {
        throw new Error('OAI official date cursor outside original range');
    }
    return { from, skip: Number(values.skip) };
}

function checkOfficialDateCursors(page, prefix, categoryId, boundary, token, seen) {
    const incoming = officialDateCursor(token, prefix, categoryId, boundary, page.responseDate);
    const outgoing = officialDateCursor(page.token, prefix, categoryId, boundary, page.responseDate);
    if (!incoming && !outgoing) return null;
    if ((token && !incoming && outgoing) || (incoming && page.token && !outgoing)) {
        throw new Error('OAI official date cursor changed token format');
    }
    const previous = [...seen.values()];
    const dates = page.records.map(record => isoDay(record.datestamp));
    const lastPrevious = previous.at(-1)?.datestamp;
    if (!dates.length || dates.some((day, index) => index > 0 && day < dates[index - 1])
        || (lastPrevious && dates[0] < lastPrevious)) throw new Error('OAI official date cursor record dates regress');
    if (incoming) {
        const skipped = previous.filter(record => record.datestamp >= incoming.from).length;
        // The server fetched one extra record to produce this token. That
        // record must be the next page's first day, including a day transition
        // with skip=0; termination cannot silently drop the pending day.
        if (incoming.skip !== skipped || dates[0] !== (lastPrevious && lastPrevious > incoming.from ? lastPrevious : incoming.from)) {
            throw new Error('OAI official incoming date cursor does not close previous page');
        }
    }
    if (outgoing) {
        const last = dates.at(-1);
        const minimum = incoming?.from || boundary.since.slice(0, 10);
        const skipped = previous.filter(record => record.datestamp === outgoing.from).length
            + dates.filter(day => day === outgoing.from).length;
        // The source's other explicit branch (first_date == last_date) retains
        // the original active FROM even when that date has no matching records.
        // It advances the actual query offset by the displayed page length.
        const sameDayOffset = outgoing.from === minimum && dates.every(day => day === last)
            && outgoing.skip === previous.filter(record => record.datestamp >= minimum).length + dates.length;
        const lastDayOffset = outgoing.from === last && outgoing.skip === skipped;
        const pendingNextDay = outgoing.from > last && outgoing.skip === 0;
        if (outgoing.from < minimum || (!sameDayOffset && !lastDayOffset && !pendingNextDay)) {
            throw new Error('OAI official outgoing date cursor/skip does not close displayed records');
        }
    }
    return outgoing;
}

function checkPage(page, prefix, categoryId, boundary, token, seen, previousResponse, counts = { total: null }) {
    const expectedRequest = token ? { verb: 'ListRecords', resumptionToken: token }
        : { verb: 'ListRecords', metadataPrefix: prefix, set: SETS[categoryId], from: boundary.since.slice(0, 10) };
    if (!['http://oaipmh.arxiv.org/oai', BASE_URL].includes(page.requestBase)) throw new Error('OAI response request identity mismatch');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(page.responseDate)
        || !Number.isFinite(Date.parse(page.responseDate))
        || new Date(page.responseDate).toISOString().replace('.000Z', 'Z') !== page.responseDate
        || Date.parse(page.responseDate) > Date.now() + 300000
        || Date.parse(page.responseDate) < Date.parse(boundary.until)) {
        throw new Error('OAI responseDate is stale or invalid for the fixed batch boundary');
    }
    const outgoing = checkOfficialDateCursors(page, prefix, categoryId, boundary, token, seen);
    // arXiv/oaipmh fetch_list.py mutates query_data[FROM] in place when creating
    // its date cursor. Accept only that field, closed by the actual output
    // token and displayed records; the sealed initial request URL stays fixed.
    const officialFromEcho = !token && outgoing && page.request.from === outgoing.from
        && same({ ...page.request, from: boundary.since.slice(0, 10) }, expectedRequest);
    if (!same(page.request, expectedRequest) && !officialFromEcho) throw new Error('OAI response request identity mismatch');
    if (!page.records.length && page.token) throw new Error('OAI empty intermediate page');
    if (page.token.length > 16384 || /[\x00-\x1f\x7f]/.test(page.token)) throw new Error('OAI invalid resumption token');
    if (page.tokenAttributes.expirationDate && (!Number.isFinite(Date.parse(page.tokenAttributes.expirationDate))
        || Date.parse(page.tokenAttributes.expirationDate) <= Date.parse(page.responseDate))) throw new Error('OAI expired resumption token');
    const counter = name => {
        const value = page.tokenAttributes[name];
        if (value === undefined) return null;
        if (!/^(?:0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('OAI pagination counter invalid');
        return Number(value);
    };
    const cursor = counter('cursor'), total = counter('completeListSize');
    if (cursor !== null && cursor !== seen.size) throw new Error('OAI pagination cursor mismatch');
    if (total !== null) {
        if (counts.total !== null && counts.total !== total) throw new Error('OAI completeListSize changed');
        counts.total = total;
    }
    const observed = seen.size + page.records.length;
    if (counts.total !== null && (observed > counts.total || (!page.token && observed !== counts.total)
        || (page.token && observed === counts.total))) throw new Error('OAI declared total does not match complete page chain');
    for (const record of page.records) {
        if (record.prefix !== prefix || !/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})$/.test(record.id)
            || record.identifier !== `oai:arXiv.org:${record.id}` || seen.has(record.id)
            || !record.sets.includes(SETS[categoryId]) || new Set(record.sets).size !== record.sets.length
            || !record.categories.includes(categoryId) || new Set(record.categories).size !== record.categories.length) {
            throw new Error('OAI duplicate/foreign record identity or category/set mismatch');
        }
        const date = isoDay(record.datestamp);
        if (date < boundary.since.slice(0, 10) || date > page.responseDate.slice(0, 10)) throw new Error('OAI metadata datestamp outside query range');
        seen.set(record.id, record);
    }
}

function mergeStreams(raw, normal, categoryId, boundary, existingIds) {
    if (!same([...raw.keys()].sort(), [...normal.keys()].sort())) throw new Error('OAI formats have different complete member sets');
    const witness = validateBoundary(categoryId, boundary), old = new Set(existingIds), papers = [];
    let witnessEncounter = null;
    for (const [id, item] of raw) {
        const second = normal.get(id), versions = item.versions;
        if (item.identifier !== `oai:arXiv.org:${id}` || second.identifier !== item.identifier
            || !same([...item.categories].sort(), [...second.categories].sort()) || item.datestamp !== second.datestamp
            || !same([...item.sets].sort(), [...second.sets].sort())
            || !Array.isArray(versions) || !versions.length) throw new Error(`OAI formats identity/category/header drift for ${id}`);
        let prior = -Infinity;
        for (let index = 0; index < versions.length; index++) {
            const version = versions[index], instant = Date.parse(version.date);
            if (version.version !== `v${index + 1}` || !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(version.date)
                || !Number.isFinite(instant) || instant < prior
                || new Date(instant).toUTCString() !== version.date.replace(/^(\w{3},) (\d) /, '$1 0$2 ')
                || new Date(instant).toISOString().slice(0, 10) > item.datestamp) {
                throw new Error('OAI raw version chain/date invalid');
            }
            prior = instant;
        }
        const published = new Date(Date.parse(versions[0].date)).toISOString();
        const updated = new Date(prior).toISOString();
        // Real official records show that the structured 'created' field can
        // track a later metadata/submission cycle (2412.17907, observed 2026-10-20).
        // Keep its raw bytes, validate its own chronology, and use only Raw's
        // explicit v1/version dates for publication and latest submission time.
        const createdDay = isoDay(second.created), updatedDay = isoDay(second.updated || second.created);
        if (createdDay > updatedDay || updatedDay > item.datestamp) throw new Error('OAI structured metadata dates invalid');
        const authors = second.authors.map(a => text([a.forenames, a.keyname, a.suffix].filter(Boolean).join(' ')));
        // arXivRaw retains TeX and a free author/affiliation string; arXiv supplies
        // decoded scientific text and ordered structured authors. Keep both XML
        // streams intact and project each field only from its authoritative
        // format, without inventing a lossy cross-format text/name converter.
        // Continuity is checked before both exact-window filtering and dedup.
        if (witness?.status === 'expected' && id === witness.arxivId) {
            if (Date.parse(published) !== Date.parse(witness.published)) throw new Error('OAI original witness publication changed');
            witnessEncounter = { arxivId: id, published };
        }
        if (Date.parse(published) >= Date.parse(boundary.since) && Date.parse(published) <= Date.parse(boundary.until) && !old.has(id)) {
            papers.push({ arxivId: `${id}v${versions.length}`, title: text(second.title), abstract: text(second.abstract), authors,
                published, updated, categories: second.categories, fetchedFrom: categoryId });
        }
    }
    if (witness?.status === 'expected' && !witnessEncounter) throw new Error('OAI complete source did not encounter original witness');
    papers.sort((a, b) => Date.parse(b.published) - Date.parse(a.published) || a.arxivId.localeCompare(b.arxivId));
    return { papers, witnessEncounter };
}

// Pure reconstruction for byte-backed diagnostics and portable fixtures. It
// grants no source health or publication capability; coverage additionally
// requires the full page chains, HTTP trigger, replays and current RSS below.
function reconstructOaiCandidates(rawRecords, structuredRecords, categoryId, boundary, existingIds = []) {
    const streams = [rawRecords, structuredRecords].map(records => {
        if (!Array.isArray(records)) throw new Error('OAI reconstruction requires record arrays');
        const map = new Map(records.map(record => [record.id, record]));
        if (map.size !== records.length) throw new Error('OAI reconstruction has duplicate records');
        return map;
    });
    return mergeStreams(streams[0], streams[1], categoryId, boundary, existingIds);
}

function safeRead(dir, descriptor) {
    const safeDirectory = () => {
        if (fs.realpathSync(dir) !== dir || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) {
            throw new Error('OAI evidence directory path changed');
        }
    };
    safeDirectory();
    if (!descriptor || !/^[a-f0-9]{64}$/.test(descriptor.responseSha256 || '')
        || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1 || descriptor.bytes > MAX_BYTES
        || path.basename(descriptor.file || '') !== descriptor.file || !/^[a-zA-Z0-9.-]+\.xml$/.test(descriptor.file)) throw new Error('OAI invalid page descriptor');
    const filename = path.join(dir, descriptor.file);
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size !== descriptor.bytes || (stat.mode & 0o777) !== 0o600) throw new Error('OAI page type, links, size or privacy changed');
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd), named = fs.lstatSync(filename);
        if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs
            || after.nlink !== 1 || named.isSymbolicLink() || named.dev !== stat.dev || named.ino !== stat.ino
            || bytes.length !== descriptor.bytes || hash(bytes) !== descriptor.responseSha256) throw new Error('OAI raw XML bytes or path changed');
        safeDirectory();
        return bytes;
    } finally { fs.closeSync(fd); }
}

function replay(health, boundary, categoryId, expectedPapers, expectedExistingIds) {
    require('../env-loader').requireExternalRuntime('daily-arxiv-oai-source');
    validateBoundary(categoryId, boundary);
    const proof = health?.provider?.oai;
    if (proof?.contract !== CONTRACT || health.provider.window?.coverageContract !== CONTRACT
        || proof.categoryId !== categoryId || proof.boundaryIdentity !== boundary.identitySha256
        || !same(proof.boundary, boundary) || health.provider.boundaryIdentity !== boundary.identitySha256
        || health.provider.window.since !== boundary.since || health.provider.window.until !== boundary.until
        || !path.isAbsolute(proof.evidenceDir || '') || fs.realpathSync(proof.evidenceDir) !== proof.evidenceDir
        || !Array.isArray(proof.existingIds) || !same(proof.existingIds, [...new Set(proof.existingIds)].sort())) throw new Error('OAI coverage binding invalid');
    validateTrigger(proof.triggerFailure, boundary, categoryId);
    if (expectedExistingIds !== undefined) {
        const { normalizedId } = require('../utils');
        const baseline = [...new Set(Array.from(expectedExistingIds, normalizedId))].sort();
        if (!same(proof.existingIds, baseline)) throw new Error('OAI exclusion set differs from original external dedup baseline');
    }
    const sets = {};
    for (const prefix of ['arXivRaw', 'arXiv']) {
        const descriptors = proof.streams?.[prefix];
        if (!Array.isArray(descriptors) || !descriptors.length || descriptors.length > MAX_PAGES) throw new Error('OAI missing full page chain');
        const seen = new Map(), tokens = new Set(), counts = { total: null }; let token = '', responseDate = null, firstPage;
        for (let index = 0; index < descriptors.length; index++) {
            const descriptor = descriptors[index];
            if (descriptor.url !== urlFor(prefix, categoryId, boundary, token) || descriptor.status !== 200
                || descriptor.requestToken !== token || descriptor.index !== index) throw new Error('OAI page request chain changed');
            const page = parseOaiXml(safeRead(proof.evidenceDir, descriptor));
            checkPage(page, prefix, categoryId, boundary, token, seen, responseDate, counts);
            if (index === 0) firstPage = page;
            if (page.token && tokens.has(page.token)) throw new Error('OAI resumption token loop');
            if (page.token) tokens.add(page.token);
            if ((index < descriptors.length - 1) !== Boolean(page.token)) throw new Error('OAI incomplete or overrun page chain');
            token = page.token; responseDate = page.responseDate;
        }
        const descriptor = proof.replays?.[prefix];
        if (descriptor?.url !== urlFor(prefix, categoryId, boundary, '') || descriptor.status !== 200
            || descriptor.requestToken !== '' || descriptor.index !== 0) throw new Error('OAI missing first-page replay');
        const repeated = parseOaiXml(safeRead(proof.evidenceDir, descriptor));
        checkPage(repeated, prefix, categoryId, boundary, '', new Map(), responseDate);
        const countIdentity = p => ({ cursor: p.tokenAttributes.cursor, completeListSize: p.tokenAttributes.completeListSize });
        if (!same(repeated.records, firstPage.records) || Boolean(repeated.token) !== Boolean(firstPage.token)
            || !same(countIdentity(repeated), countIdentity(firstPage))) throw new Error('OAI first page changed during full harvest');
        sets[prefix] = seen;
    }
    const merged = mergeStreams(sets.arXivRaw, sets.arXiv, categoryId, boundary, proof.existingIds);
    const announcement = require('./daily-arxiv-announcement-source').replayDailyAnnouncement(proof.announcement, boundary, categoryId);
    if (!announcement.ids.every(id => sets.arXivRaw.has(id) && sets.arXiv.has(id))) {
        throw new Error('OAI complete streams omit current official announcement members');
    }
    const expected = expectedPapers?.map(({ fetchedAt, ...paper }) => {
        if (fetchedAt !== undefined && fetchedAt !== require('../utils').normalizeToBeijingISOString(boundary.until)) {
            throw new Error('OAI fetchedAt differs from original fixed batch instant');
        }
        return paper;
    });
    if (proof.candidateSha256 !== sha(merged.papers) || !same(proof.witnessEncounter, merged.witnessEncounter)
        || (expected && !same(expected, merged.papers))) throw new Error('OAI reconstructed candidates or witness differ');
    return merged;
}

function hasVerifiedOaiCoverage(health, boundary, categoryId = health?.categoryId || health?.id, expectedPapers, expectedExistingIds) {
    try { replay(health, boundary, categoryId, expectedPapers, expectedExistingIds); return true; } catch { return false; }
}

async function fetchDailyOaiCategory(categoryId, boundary, existingIds, options = {}) {
    require('../env-loader').requireExternalRuntime('daily-arxiv-oai-source');
    validateBoundary(categoryId, boundary);
    validateTrigger(options.triggerFailure, boundary, categoryId);
    const { detectHttpConnectProxyUrl, normalizedId } = require('../utils');
    const proxy = detectHttpConnectProxyUrl();
    if (!proxy) throw new Error('Official OAI requires project HTTP CONNECT; direct connection forbidden');
    if (!options.evidenceDir || !path.isAbsolute(options.evidenceDir)) throw new Error('OAI requires an absolute private evidence directory');
    fs.mkdirSync(path.dirname(options.evidenceDir), { recursive: true, mode: 0o700 });
    // Every dispatch owns a new directory. Old responses remain immutable and
    // may be cold-verified, but must not be mixed into a new network harvest.
    fs.mkdirSync(options.evidenceDir, { mode: 0o700 });
    const evidenceDir = fs.realpathSync(options.evidenceDir);
    if (evidenceDir !== options.evidenceDir) throw new Error('OAI evidence directory must be its canonical real path');
    const api = require('../fetch-papers'), { ARXIV_CONFIG } = require('../config');
    const scheduler = options.requestScheduler || require('./fetch-scheduler').createHostTaskScheduler();
    const request = options.requestFn || api.httpsRequestWithProxy;
    const proof = { contract: CONTRACT, categoryId, boundaryIdentity: boundary.identitySha256,
        boundary: structuredClone(boundary), evidenceDir, triggerFailure: structuredClone(options.triggerFailure),
        existingIds: [...new Set(Array.from(existingIds || [], normalizedId))].sort(), streams: { arXivRaw: [], arXiv: [] }, replays: {} };
    const health = { categoryId, source: 'arxiv-oai-official', contract: CONTRACT, attempts: 0, successfulRequests: 0,
        failures: [], coverageComplete: false, ok: false, allFailed: false,
        provider: { boundaryIdentity: boundary.identitySha256,
            window: { since: boundary.since, until: boundary.until, covered: false, coverageContract: CONTRACT }, oai: proof } };
    const sets = {};
    const runNonce = crypto.randomUUID();
    const fetchPage = async (prefix, index, token, replayPage = false) => {
        const url = urlFor(prefix, categoryId, boundary, token);
        const retryableTransportCodes = new Set(['ECONNRESET', 'ETIMEDOUT',
            'ARXIV_REQUEST_DEADLINE_EXCEEDED', 'ARXIV_REQUEST_SOCKET_TIMEOUT']);
        let response, file;
        for (let attempt = 0; attempt < 3; attempt++) {
            health.attempts++;
            let rejectedRequest;
            try {
                response = await scheduler.run('oaipmh.arxiv.org', async () => {
                    // Catch only the real transport promise. Scheduler, XML,
                    // identity and filesystem failures cannot gain a retry.
                    try {
                        return await request(url,
                            { 'User-Agent': 'audio-paper-digest/1.0', Accept: 'application/xml,text/xml;q=0.9' },
                            proxy, ARXIV_CONFIG.fetchTimeoutMs, MAX_BYTES);
                    } catch (error) { rejectedRequest = error; throw error; }
                }, { minimumCooldownMs: 5000 });
            } catch (error) {
                if (error !== rejectedRequest) throw error;
                health.failures.push({ error: error?.message || String(error), code: error?.code || null,
                    url, prefix, index, requestToken: token, replayPage, attempt: attempt + 1 });
                // This uses the same three-attempt page budget as HTTP 503.
                // A rejected request has no response body/file to invent.
                if (!retryableTransportCodes.has(error?.code) || attempt === 2) throw error;
                continue;
            }
            const bytes = Buffer.isBuffer(response.data) ? response.data : Buffer.from(String(response.data || ''), 'utf8');
            if (bytes.length > MAX_BYTES || (response.status === 200 && !bytes.length)) throw new Error('OAI response body size invalid');
            file = `${prefix}-${runNonce}-${replayPage ? 'replay-' : ''}${String(index).padStart(6, '0')}-${attempt}.xml`;
            fs.writeFileSync(path.join(evidenceDir, file), bytes, { mode: 0o600, flag: 'wx' });
            if (response.status === 200) break;
            health.failures.push({ error: `HTTP ${response.status}`, url, prefix, index, requestToken: token,
                replayPage, attempt: attempt + 1, file, bytes: bytes.length, responseSha256: hash(bytes) });
            if (response.status !== 503 || attempt === 2) throw new Error(`OAI HTTP ${response.status}`);
            const wait = api.parseRetryAfterMs(response.headers, { nowMs: Date.now(), maxMs: Number.MAX_SAFE_INTEGER });
            if (typeof scheduler.defer !== 'function') throw new Error('OAI Retry-After requires shared scheduler defer');
            scheduler.defer('oaipmh.arxiv.org', Math.max(5000, wait || 0));
        }
        const bytes = fs.readFileSync(path.join(evidenceDir, file));
        health.successfulRequests++;
        return { page: parseOaiXml(bytes), descriptor: { index, url, requestToken: token,
            status: 200, file, bytes: bytes.length, responseSha256: hash(bytes) } };
    };
    try {
        const announcements = require('./daily-arxiv-announcement-source');
        proof.announcement = options.announcementEvidence ? structuredClone(options.announcementEvidence)
            : await announcements.fetchDailyAnnouncement(categoryId, boundary, {
                evidenceDir, requestScheduler: scheduler, requestFn: options.announcementRequestFn });
        // Reject an old announcement before dispatching an expensive full OAI
        // harvest. Its actual IDs are compared against the unfiltered streams.
        const announcement = announcements.replayDailyAnnouncement(proof.announcement, boundary, categoryId);
        for (const prefix of ['arXivRaw', 'arXiv']) {
            const seen = new Map(), tokens = new Set(), counts = { total: null }; let token = '', responseDate = null, complete = false, firstPage;
            for (let index = 0; index < MAX_PAGES; index++) {
                const { page, descriptor } = await fetchPage(prefix, index, token);
                checkPage(page, prefix, categoryId, boundary, token, seen, responseDate, counts);
                if (index === 0) firstPage = page;
                if (page.token && tokens.has(page.token)) throw new Error('OAI resumption token loop');
                if (page.token) tokens.add(page.token);
                proof.streams[prefix].push(descriptor);
                token = page.token; responseDate = page.responseDate;
                if (!token) { complete = true; break; }
            }
            if (!complete) throw new Error('OAI pagination limit reached before empty resumption token');
            const repeated = await fetchPage(prefix, 0, '', true);
            checkPage(repeated.page, prefix, categoryId, boundary, '', new Map(), responseDate);
            const countIdentity = p => ({ cursor: p.tokenAttributes.cursor, completeListSize: p.tokenAttributes.completeListSize });
            if (!same(repeated.page.records, firstPage.records) || Boolean(repeated.page.token) !== Boolean(firstPage.token)
                || !same(countIdentity(repeated.page), countIdentity(firstPage))) {
                throw new Error('OAI first page changed during full harvest');
            }
            proof.replays[prefix] = repeated.descriptor;
            sets[prefix] = seen;
        }
        const merged = mergeStreams(sets.arXivRaw, sets.arXiv, categoryId, boundary, proof.existingIds);
        if (!announcement.ids.every(id => sets.arXivRaw.has(id) && sets.arXiv.has(id))) {
            throw new Error('OAI complete streams omit current official announcement members');
        }
        proof.candidateSha256 = sha(merged.papers); proof.witnessEncounter = merged.witnessEncounter;
        if (!hasVerifiedOaiCoverage(health, boundary, categoryId, merged.papers, existingIds || [])) throw new Error('OAI raw-byte cold replay failed');
        health.coverageComplete = health.ok = health.provider.window.covered = true;
        health.fetched = merged.papers.length;
        const witness = boundary.continuity?.witnesses?.arxiv?.find(item => item.categoryId === categoryId);
        if (witness) {
            health.continuity = { required: true, encounters: merged.witnessEncounter ? [merged.witnessEncounter] : [] };
            health.provider.continuity = { required: true, status: merged.witnessEncounter ? 'verified' : 'not-applicable',
                expectedId: witness.arxivId, witnessPublished: witness.published,
                matchedIds: merged.witnessEncounter ? [merged.witnessEncounter.arxivId] : [], encounterVerified: Boolean(merged.witnessEncounter), reason: witness.reason };
        }
        Object.defineProperty(merged.papers, '_sourceHealth', { value: health, enumerable: false });
        return merged.papers;
    } catch (cause) {
        health.failures.push({ error: cause.message }); health.allFailed = health.successfulRequests === 0;
        throw Object.assign(new Error(`arXiv ${categoryId} official OAI incomplete: ${cause.message}`, { cause }),
            { code: 'SOURCE_FETCH_FAILED', sourceHealth: health });
    }
}

module.exports = { CONTRACT, BASE_URL, SETS, fetchDailyOaiCategory, hasVerifiedOaiCoverage, parseOaiXml, reconstructOaiCandidates };
