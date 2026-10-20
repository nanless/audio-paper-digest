'use strict';

// RSS is an independent announcement freshness witness, not a replacement for
// complete OAI pagination. Eligibility is always replayed from the saved XML.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const PROJECT = path.resolve(__dirname, '../..');
const CONTRACT = 'daily-arxiv-announcement-evidence-v1';
const MAX_BYTES = 16 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const urlFor = category => `https://rss.arxiv.org/rss/${category}`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// ElementTree supplies strict XML, namespace and matching-tag validation; a
// permissive HTML parser must never repair a truncated feed into valid proof.
const PARSER = String.raw`
import sys,json,re,xml.etree.ElementTree as E
from datetime import datetime,timezone
from email.utils import parsedate_to_datetime
x=json.load(sys.stdin); source=x['xml']; cat=x['category']
def fail(s): raise ValueError('Official announcement RSS: '+s)
if re.search(r'<!\s*(?:DOCTYPE|ENTITY)\b',source,re.I): fail('DTD/entity declarations forbidden')
r=E.fromstring(source)
if r.tag!='rss' or r.get('version')!='2.0' or len(r)!=1 or r[0].tag!='channel': fail('expected complete RSS 2.0 channel')
c=r[0]; atom='{http://www.w3.org/2005/Atom}'; ax='{http://arxiv.org/schemas/atom}'
def one(p,n):
 v=p.findall(n)
 if len(v)!=1 or list(v[0]): fail('missing, duplicate or nested '+n)
 t=(v[0].text or '').strip()
 if not t: fail('empty '+n)
 return t
def stamp(s):
 if not re.fullmatch(r'(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}',s): fail('invalid RFC822 date')
 d=parsedate_to_datetime(s)
 if d.tzinfo is None or d.strftime('%a')!=s[:3]: fail('date timezone/weekday mismatch')
 return d.astimezone(timezone.utc)
def iso(s): return datetime.fromisoformat(s.replace('Z','+00:00'))
def out(d): return d.isoformat(timespec='milliseconds').replace('+00:00','Z')
valid_links={f'http://rss.arxiv.org/rss/{cat}',f'https://rss.arxiv.org/rss/{cat}'}
if one(c,'title')!=cat+' updates on arXiv.org' or one(c,'link') not in valid_links: fail('wrong channel category')
if one(c,'description')!=cat+' updates on the arXiv.org e-print archive.': fail('wrong channel description')
selflinks=c.findall(atom+'link')
if len(selflinks)!=1 or selflinks[0].get('rel')!='self' or selflinks[0].get('type')!='application/rss+xml' or selflinks[0].get('href') not in valid_links: fail('missing/wrong category self link')
for e in c.iter():
 local=e.tag.rsplit('}',1)[-1].lower()
 if local in {'resumptiontoken','totalresults','startindex','itemsperpage','next','previous','truncated'}: fail('pagination/truncation marker')
 if local=='link' and e.get('rel') in {'next','previous','first','last'}: fail('paginated feed')
pub=stamp(one(c,'pubDate')); build=stamp(one(c,'lastBuildDate'))
until=iso(x['until']); retrieved=iso(x['retrievedAt'])
if not (until<=pub<=build<=retrieved): fail('stale/future announcement publication or build date')
if (build-pub).total_seconds()>86400 or (retrieved-build).total_seconds()>172800: fail('uncertain announcement freshness')
# The official daily announcement is midnight Eastern (UTC-04/UTC-05).
rawpub=one(c,'pubDate'); localpub=parsedate_to_datetime(rawpub)
if localpub.hour or localpub.minute or localpub.second or rawpub[-5:] not in {'-0400','-0500'}: fail('announcement is not midnight Eastern')
items=c.findall('item')
if len(items)>=2000: fail('feed reaches possible truncation limit')
if len(items)!=sum(e.tag.rsplit('}',1)[-1]=='item' for e in c.iter()): fail('nested/foreign item')
seen=set(); records=[]
ident=r'((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7}))v([1-9]\d*)'
for item in items:
 g=one(item,'guid'); m=re.fullmatch('oai:arXiv.org:'+ident,g)
 if not m or item.find('guid').get('isPermaLink')!='false': fail('invalid official guid')
 aid,version=m.group(1),int(m.group(2)); link=one(item,'link')
 if link not in {'https://arxiv.org/abs/'+aid,'https://arxiv.org/abs/'+aid+'v'+str(version)}: fail('guid/link identity mismatch')
 if aid in seen: fail('duplicate normalized paper ID')
 seen.add(aid); one(item,'title')
 category_nodes=item.findall('category')
 if any(list(e) for e in category_nodes): fail('nested category element')
 cats=[(e.text or '').strip() for e in category_nodes]
 if cat not in cats or len(cats)!=len(set(cats)) or any(not v for v in cats): fail('item category mismatch')
 kind=one(item,ax+'announce_type')
 if kind not in {'new','cross','replace','replace-cross'}: fail('unknown announcement type')
 desc=one(item,'description')
 prefix='arXiv:'+aid+'v'+str(version)+' Announce Type: '+kind
 if not desc.startswith(prefix) or not re.match(re.escape(prefix)+r'\s+Abstract:\s*\S',desc): fail('description identity/type mismatch')
 if stamp(one(item,'pubDate'))!=pub: fail('mixed announcement dates')
 records.append({'arxivId':aid,'version':version,'announceType':kind})
# A complete, dated official channel with zero item elements represents an
# empty announcement. Missing dates/identity never become an inferred empty day.
print(json.dumps({'ids':[v['arxivId'] for v in records],'items':records,'pubDate':out(pub),'lastBuildDate':out(build),'empty':not records}))
`;

function validateInput(categoryId, boundary) {
    if (!/^[a-z]+\.[A-Z]{2}$/.test(categoryId || '') || !SHA.test(boundary?.identitySha256 || '')
        || !Number.isFinite(Date.parse(boundary?.since)) || !Number.isFinite(Date.parse(boundary?.until))
        || Date.parse(boundary.since) >= Date.parse(boundary.until)) throw new Error('Announcement requires exact daily boundary and category');
}

function safePath(filename, directory = false) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || path.resolve(filename) !== filename) {
        throw new Error('Announcement evidence requires an absolute canonical path');
    }
    const parts = filename.split(path.sep).filter(Boolean);
    let current = path.parse(filename).root;
    for (let index = 0; index < parts.length; index++) {
        current = path.join(current, parts[index]);
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink() || (index < parts.length - 1 || directory ? !st.isDirectory() : !st.isFile())) {
            throw new Error('Announcement evidence path must contain only real directories and a regular file');
        }
    }
}

function readEvidenceBytes(evidence, categoryId) {
    safePath(evidence.filePath);
    if (path.basename(evidence.filePath) !== `rss-${categoryId}-${evidence.sha256}.xml`) throw new Error('Announcement file identity mismatch');
    const fd = fs.openSync(evidence.filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes;
    try {
        const before = fs.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || (before.mode & 0o777) !== 0o600
            || before.size !== evidence.bytes || before.size > MAX_BYTES) throw new Error('Unsafe announcement evidence file mode, links or size');
        bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || after.nlink !== 1 || (after.mode & 0o777) !== 0o600
            || before.mtimeMs !== after.mtimeMs || bytes.length !== evidence.bytes || sha(bytes) !== evidence.sha256) {
            throw new Error('Announcement evidence bytes changed');
        }
        const named = fs.lstatSync(evidence.filePath);
        if (named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino) throw new Error('Announcement evidence path changed');
        safePath(evidence.filePath);
    } finally { fs.closeSync(fd); }
    return bytes;
}

function replayDailyAnnouncement(evidence, boundary, categoryId) {
    require('../env-loader').requireExternalRuntime('daily-arxiv-announcement-source');
    validateInput(categoryId, boundary);
    const fields = ['contract', 'categoryId', 'boundaryIdentity', 'url', 'retrievedAt', 'filePath', 'bytes', 'sha256'].sort();
    if (!evidence || Object.getPrototypeOf(evidence) !== Object.prototype
        || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(fields)
        || evidence.contract !== CONTRACT || evidence.categoryId !== categoryId
        || evidence.boundaryIdentity !== boundary.identitySha256 || evidence.url !== urlFor(categoryId)
        || !SHA.test(evidence.sha256 || '') || !Number.isSafeInteger(evidence.bytes)
        || evidence.bytes < 1 || evidence.bytes > MAX_BYTES
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(evidence.retrievedAt || '')
        || !Number.isFinite(Date.parse(evidence.retrievedAt))
        || Date.parse(evidence.retrievedAt) > Date.now() + 300000) throw new Error('Invalid announcement file descriptor');
    const bytes = readEvidenceBytes(evidence, categoryId);
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const result = spawnSync('bash', [path.join(PROJECT, 'scripts/python-runtime.sh'), '-c', PARSER], {
        cwd: PROJECT, encoding: 'utf8', timeout: 30000, maxBuffer: MAX_BYTES,
        input: JSON.stringify({ xml, category: categoryId, until: boundary.until, retrievedAt: evidence.retrievedAt })
    });
    if (result.error || result.status !== 0) throw new Error(`Announcement XML replay failed: ${result.error?.message || result.stderr?.trim() || result.status}`);
    readEvidenceBytes(evidence, categoryId);
    return JSON.parse(result.stdout);
}

async function fetchDailyAnnouncement(categoryId, boundary, options = {}) {
    require('../env-loader').requireExternalRuntime('daily-arxiv-announcement-source');
    validateInput(categoryId, boundary);
    const { detectHttpConnectProxyUrl } = require('../utils');
    const proxy = detectHttpConnectProxyUrl();
    if (!options.requestFn && !proxy) throw new Error('Official announcement RSS requires project HTTP CONNECT');
    const directory = options.evidenceDir;
    // Caller creates its private evidence directory as part of the normal run.
    safePath(directory, true);
    const scheduler = options.requestScheduler || require('./fetch-scheduler').createHostTaskScheduler();
    const request = options.requestFn || require('../fetch-papers').httpsRequestWithProxy;
    const url = urlFor(categoryId);
    const response = await scheduler.run('rss.arxiv.org', () => request(url,
        { 'User-Agent': 'audio-paper-digest/1.0', Accept: 'application/rss+xml' }, proxy, 60000, MAX_BYTES),
    { minimumCooldownMs: 3000 });
    if (response.status !== 200) throw new Error(`Official announcement RSS HTTP ${response.status}`);
    const retrievedAt = new Date(Date.now()).toISOString();
    const bytes = Buffer.isBuffer(response.data) ? response.data : Buffer.from(String(response.data), 'utf8');
    if (bytes.length < 1 || bytes.length > MAX_BYTES) throw new Error('Announcement response size is invalid');
    const digest = sha(bytes), filePath = path.join(directory, `rss-${categoryId}-${digest}.xml`);
    const evidence = { contract: CONTRACT, categoryId, boundaryIdentity: boundary.identitySha256,
        url, retrievedAt, filePath, bytes: bytes.length, sha256: digest };
    try {
        const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.fchmodSync(fd, 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    replayDailyAnnouncement(evidence, boundary, categoryId);
    return Object.freeze(evidence);
}

module.exports = { CONTRACT, fetchDailyAnnouncement, replayDailyAnnouncement };
