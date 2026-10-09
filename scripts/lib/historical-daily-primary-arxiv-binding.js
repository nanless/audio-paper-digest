'use strict';

// 解析旧版每日汇总页里那个范围很窄的主论文标记。历史正文只作身份证据：调用方
// 拿到的是字节偏移和哈希，绝不拿到可能混进重写提示词的正文。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACT = 'historical-daily-primary-arxiv-binding-v1';
const VERSION = 1;
const MAPPING = 'frozen-daily-score-row-primary-arxiv-link';
const SHA_RE = /^[a-f0-9]{64}$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
const SOURCE_RE = /^(?:filename|frontmatter:[A-Za-z0-9_]+|body:(?:arxiv|openreview|ieee)-link)$/;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const SCORE_ROW_RE = /^(?:✅|🔥|📝) \*\*(?:10(?:\.0+)?|[0-9](?:\.[0-9]+)?)\/10\*\*(?: \| [^|\n]+)+ \| \[arxiv\]\((https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?)\)$/u;

class HistoricalDailyPrimaryArxivBindingError extends Error {
    constructor(message) {
        super(`Historical daily primary arXiv binding rejected: ${message}`);
        this.name = 'HistoricalDailyPrimaryArxivBindingError';
        this.code = 'HISTORICAL_DAILY_PRIMARY_ARXIV_BINDING_INTEGRITY';
    }
}

const fail = message => { throw new HistoricalDailyPrimaryArxivBindingError(message); };
const plain = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => JSON.parse(JSON.stringify(value));
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = value => sha256(JSON.stringify(canonical(value)));

function exact(value, fields, label) {
    if (!plain(value)) fail(`${label} 必须是对象`);
    const actual = Object.keys(value).sort(); const expected = [...fields].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail(`${label} has unknown or missing fields`);
    }
}

function safeDirectory(directory, label) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail(`${label} 必须是绝对路径`);
    const absolute = path.resolve(directory);
    if (!fs.existsSync(absolute)) fail(`${label} 未找到`);
    let cursor = path.parse(absolute).root;
    for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, segment);
        const stat = fs.lstatSync(cursor);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} is unsafe`);
    }
    if (fs.realpathSync(absolute) !== absolute) fail(`${label} is unsafe`);
    return absolute;
}

function readFrozenPage(blogRoot, pagePath) {
    const root = safeDirectory(blogRoot, 'blogRoot');
    if (typeof pagePath !== 'string' || !pagePath || path.isAbsolute(pagePath)
        || pagePath.includes('\\') || pagePath.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        fail('pagePath must be a safe relative path');
    }
    const filename = path.resolve(root, ...pagePath.split('/'));
    if (!filename.startsWith(`${root}${path.sep}`)) fail('pagePath 逃出了 blogRoot');
    safeDirectory(path.dirname(filename), '历史页面父目录');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > MAX_PAGE_BYTES) {
            fail('frozen daily page is unsafe or too large');
        }
        const bytes = fs.readFileSync(fd); const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) fail('冻结的每日页面在读取期间发生变化');
        return { bytes, sha256: sha256(bytes) };
    } catch (error) {
        if (error instanceof HistoricalDailyPrimaryArxivBindingError) throw error;
        fail(`cannot read frozen daily page: ${error.message}`);
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// 旧扫描器可能把过长 URL 截成另一个合法 ID。新建目录或计划时重核只靠正文的提示，
// 原页面仍只作身份证据，不把正文写进计划；已保存的清单与计划格式不变。
function verifyBodyOnlyIdentityHints({ inventory, blogRoot } = {}) {
    for (const page of inventory?.pages || []) {
        const hints = page.identityHints;
        if (page.kind !== 'paper' || hints?.status !== 'single' || hints.candidates?.length !== 1) continue;
        const hint = hints.candidates[0];
        if (!Array.isArray(hint.sources) || !hint.sources.length || !hint.sources.every(source => String(source).startsWith('body:'))) continue;
        const read = readFrozenPage(blogRoot, page.path);
        if (read.sha256 !== page.contentSha256) fail('正文身份提示所绑定的历史页面 SHA 已变化');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(read.bytes);
        const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u);
        if (!frontmatter) fail('正文身份提示缺少可分离的历史页面正文');
        const body = text.slice(frontmatter[0].length);
        const expressions = {
            arxiv: /https:\/\/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?(?:\.pdf)?(?![A-Za-z0-9_/%+-]|\.[A-Za-z0-9_./%+-])/gi,
            'openreview-forum-id': /https:\/\/openreview\.net\/(?:forum|pdf)\?id=([A-Za-z0-9_-]{6,128})(?![A-Za-z0-9_/%+-]|\.[A-Za-z0-9_./%+-])/gi,
            'icassp-arnumber': /https:\/\/ieeexplore\.ieee\.org\/(?:document|abstract\/document)\/([1-9]\d*)(?![A-Za-z0-9_/%+-]|\.[A-Za-z0-9_./%+-])/gi
        };
        const expression = expressions[hint.scheme];
        const values = expression ? [...body.matchAll(expression)].map(match => match[1]) : [];
        if (!values.includes(hint.value)) fail(`历史正文没有完整匹配的 ${hint.scheme} 身份链接，拒绝使用旧截断提示`);
    }
}

function frontmatterArxivId(frontmatter) {
    const declarations = frontmatter.split('\n').filter(line => /^paper_digest_arxiv_id\s*:/u.test(line));
    if (!declarations.length) return null;
    if (declarations.length !== 1) fail('paper_digest_arxiv_id 不得重复');
    const match = declarations[0].match(/^paper_digest_arxiv_id:[ \t]*(?:"(\d{4}\.\d{4,5})"|'(\d{4}\.\d{4,5})'|(\d{4}\.\d{4,5}))[ \t]*$/u);
    if (!match) fail('paper_digest_arxiv_id 格式错误');
    return match[1] || match[2] || match[3];
}

function filenameArxivId(pagePath) {
    const match = path.posix.basename(pagePath, '.md').match(/-(\d{4})-(\d{4,5})(?:v[1-9]\d*)?$/u);
    return match ? `${match[1]}.${match[2]}` : null;
}

function selectedCandidate(identityHints, arxivId) {
    if (!plain(identityHints) || !['conflict', 'multiple'].includes(identityHints.status)
        || !Array.isArray(identityHints.candidates)) {
        fail('解析器需要原始的 conflict/multiple identityHints');
    }
    const matches = identityHints.candidates.filter(candidate => plain(candidate)
        && candidate.scheme === 'arxiv' && candidate.value === arxivId);
    if (matches.length !== 1 || !Array.isArray(matches[0].sources)) {
        fail('selected arXiv ID is not a unique frozen identity candidate');
    }
    const sources = [...matches[0].sources];
    if (!sources.length || sources.some(source => typeof source !== 'string' || !SOURCE_RE.test(source))
        || [...sources].sort().some((source, index) => source !== sources[index])
        || new Set(sources).size !== sources.length || !sources.includes('body:arxiv-link')) {
        fail('selected arXiv candidate has invalid or missing body source evidence');
    }
    return sources;
}

function parsePrimaryRow(text, bodyStart) {
    const body = text.slice(bodyStart);
    const labelledStarts = [...body.matchAll(/\[arxiv\]\(/giu)];
    if (labelledStarts.length !== 1) fail('frozen page must contain exactly one [arxiv] link marker');
    const rows = []; let cursor = 0;
    for (const line of body.split('\n')) {
        const match = line.match(SCORE_ROW_RE);
        if (match) rows.push({ line, charStart: bodyStart + cursor, originalUrl: match[1], arxivId: match[2] });
        cursor += line.length + 1;
    }
    if (rows.length !== 1) fail('frozen page must contain exactly one strict score metadata row');
    const selected = rows[0];
    const sourceByteStart = Buffer.byteLength(text.slice(0, selected.charStart), 'utf8');
    const sourceByteEnd = sourceByteStart + Buffer.byteLength(selected.line, 'utf8');
    return { originalUrl: selected.originalUrl, arxivId: selected.arxivId,
        sourceByteStart, sourceByteEnd, semanticLineSha256: sha256(Buffer.from(selected.line, 'utf8')) };
}

function buildDailyPrimaryArxivBinding({ blogRoot, page, identityHints = page?.identityHints } = {}) {
    if (!plain(page) || !PAGE_KEY_RE.test(String(page.pageKey || '')) || typeof page.pagePath !== 'string'
        || !SHA_RE.test(String(page.pageContentSha256 || '')) || page.scope?.type !== 'daily') {
        fail('规范化后的每日清单页面无效');
    }
    const loaded = readFrozenPage(blogRoot, page.pagePath);
    if (loaded.sha256 !== page.pageContentSha256) fail('frozen page bytes differ from inventory');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes); }
    catch { fail('frozen daily page is not strict UTF-8'); }
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/u);
    if (!frontmatter) fail('frozen daily page lacks strict frontmatter');
    const selected = parsePrimaryRow(text, frontmatter[0].length);
    const candidateSources = selectedCandidate(identityHints, selected.arxivId);
    const declaredId = frontmatterArxivId(frontmatter[1]);
    const namedId = filenameArxivId(page.pagePath);
    if (declaredId && declaredId !== selected.arxivId) fail('frontmatter arXiv ID disagrees with score row');
    if (namedId && namedId !== selected.arxivId) fail('filename arXiv ID disagrees with score row');
    if (declaredId && !candidateSources.includes('frontmatter:paper_digest_arxiv_id')) {
        fail('frontmatter arXiv evidence is absent from frozen candidate sources');
    }
    if (namedId && !candidateSources.includes('filename')) {
        fail('文件名的 arXiv 证据不在冻结候选来源中');
    }
    const body = { contract: CONTRACT, version: VERSION, mapping: MAPPING, pageKey: page.pageKey,
        pagePath: page.pagePath, pageContentSha256: page.pageContentSha256,
        sourceByteStart: selected.sourceByteStart, sourceByteEnd: selected.sourceByteEnd,
        semanticLineSha256: selected.semanticLineSha256, linkLabel: 'arxiv',
        originalUrl: selected.originalUrl, arxivId: selected.arxivId, candidateSources,
        frontmatterArxivId: declaredId, filenameArxivId: namedId };
    return { ...body, bindingSha256: stableHash(body) };
}

function normalizeDailyPrimaryArxivBinding(value) {
    exact(value, ['contract', 'version', 'mapping', 'pageKey', 'pagePath', 'pageContentSha256',
        'sourceByteStart', 'sourceByteEnd', 'semanticLineSha256', 'linkLabel', 'originalUrl',
        'arxivId', 'candidateSources', 'frontmatterArxivId', 'filenameArxivId', 'bindingSha256'],
    'daily primary arXiv binding');
    const body = clone(value); delete body.bindingSha256;
    const urlMatch = String(value.originalUrl || '').match(/^https:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5})(?:v[1-9]\d*)?$/u);
    if (value.contract !== CONTRACT || value.version !== VERSION || value.mapping !== MAPPING
        || !PAGE_KEY_RE.test(String(value.pageKey || '')) || typeof value.pagePath !== 'string' || !value.pagePath
        || path.isAbsolute(value.pagePath) || value.pagePath.includes('\\')
        || value.pagePath.split('/').some(segment => !segment || segment === '.' || segment === '..')
        || !SHA_RE.test(String(value.pageContentSha256 || ''))
        || !Number.isSafeInteger(value.sourceByteStart) || value.sourceByteStart < 0
        || !Number.isSafeInteger(value.sourceByteEnd) || value.sourceByteEnd <= value.sourceByteStart
        || !SHA_RE.test(String(value.semanticLineSha256 || '')) || value.linkLabel !== 'arxiv'
        || !ARXIV_ID_RE.test(String(value.arxivId || '')) || !urlMatch || urlMatch[1] !== value.arxivId
        || !Array.isArray(value.candidateSources) || !value.candidateSources.includes('body:arxiv-link')
        || value.candidateSources.some(source => typeof source !== 'string' || !SOURCE_RE.test(source))
        || [...value.candidateSources].sort().some((source, index) => source !== value.candidateSources[index])
        || new Set(value.candidateSources).size !== value.candidateSources.length
        || ![null, value.arxivId].includes(value.frontmatterArxivId)
        || ![null, value.arxivId].includes(value.filenameArxivId)
        || (value.frontmatterArxivId && !value.candidateSources.includes('frontmatter:paper_digest_arxiv_id'))
        || (value.filenameArxivId && !value.candidateSources.includes('filename'))
        || !SHA_RE.test(String(value.bindingSha256 || '')) || stableHash(body) !== value.bindingSha256) {
        fail('daily primary arXiv binding is invalid');
    }
    return clone(value);
}

function verifyDailyPrimaryArxivBinding({ binding, paper, blogRoot } = {}) {
    const normalized = normalizeDailyPrimaryArxivBinding(binding);
    if (!paper || normalized.pageKey !== paper.pageKey || normalized.pagePath !== paper.pagePath
        || normalized.pageContentSha256 !== paper.pageContentSha256) {
        fail('主 arXiv 绑定与冻结页面不一致');
    }
    const replayed = buildDailyPrimaryArxivBinding({ blogRoot, page: paper });
    if (stableHash(replayed) !== stableHash(normalized)) fail('主 arXiv 评分行的原始字节或候选来源已变化');
    return normalized;
}

module.exports = {
    CONTRACT, VERSION, MAPPING, verifyBodyOnlyIdentityHints, verifyDailyPrimaryArxivBinding,
    contract: CONTRACT, mapping: MAPPING,
    HistoricalDailyPrimaryArxivBindingError,
    build: buildDailyPrimaryArxivBinding,
    normalize: normalizeDailyPrimaryArxivBinding,
    buildDailyPrimaryArxivBinding,
    normalizeDailyPrimaryArxivBinding
};
