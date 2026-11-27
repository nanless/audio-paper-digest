'use strict';

/**
 * 官方会议录获取扩展模块。
 *
 * 设计约束：
 * - scripts/lib/official-conference-acquisition.js 受 config/workflow-historical-records.json
 *   与 tests/acquisition-parser-compatibility.test.js 的 SHA-256 逐字节锁死，绝不修改该原文件。
 * - 本伴生模块与冻结获取模块保持同等安全、流式限流、目录边界、去重键 JSON 校验与不可变凭证契约，
 *   新增对下列 2025/2026 音频/语音/音乐及通用 AI/NLP/CV 核心会议的支持：
 *   - 垂直音频/语音/音乐：DCASE 2026、SMC 2026、AVSP 2026、MLCSLM 2026、WOCHAT 2026、ISCA DC 2026、
 *     SIGDIAL 2026、IWSDS 2026、SIGUL 2026、SPEAKABLE 2026、SALMA 2026、ImpactSpeech 2026、
 *     NLP4MusA 2026、TrustAudio 2026、Audio-AAAI 2026（PMLR v312）、ISMIR 2026、WASPAA 2025、ASRU 2025
 *   - 通用 AI/NLP/CV：EMNLP 2026、ECCV 2026、LREC 2026、WACV 2026、IJCAI 2026、
 *     AACL 2026、CoNLL 2026、*SEM 2026、NeurIPS 2026
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const cheerio = require('cheerio');
const { writeImmutableFile, recoverImmutableFileLink } = require('./immutable-file.js');

const EXTENDED_CATALOG_RECEIPT_CONTRACT = 'official-conference-catalog-receipt-extended';
const EXTENDED_PDF_RECEIPT_CONTRACT = 'official-conference-pdf-receipt-extended';
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 180000;
const MAX_JSON_PAGES = 40;
const SHA_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,200}$/;
const DOI_RE = /^10\.\d{4,9}\/[A-Za-z0-9._;()/:+-]{2,160}$/;
const PAPER_FIELDS = Object.freeze(['abstract', 'authors', 'doi', 'id', 'pdfFile', 'pdfUrl', 'recordUrl', 'title', 'track']);
const TEMP_FILE_RE = /^\..+\.[a-f0-9]{16}\.[1-9]\d*\.[a-f0-9-]{36}\.tmp$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

class OfficialConferenceAcquisitionExtendedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'OfficialConferenceAcquisitionExtendedError';
        this.code = 'OFFICIAL_CONFERENCE_ACQUISITION_EXTENDED_ERROR';
    }
}

function fail(message) {
    throw new OfficialConferenceAcquisitionExtendedError(message);
}

function compareCodePoints(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value).sort(compareCodePoints).map(k => [k, canonicalize(value[k])])
        );
    }
    return value;
}

function stableHash(value) {
    return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8'));
}

function prettyBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function exact(value, expectedKeys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`${label} 必须是 JSON 对象`);
    }
    const actual = Object.keys(value).sort(compareCodePoints);
    const expected = [...expectedKeys].sort(compareCodePoints);
    if (actual.length !== expected.length || actual.some((k, idx) => k !== expected[idx])) {
        fail(`${label} 字段集合不符合契约`);
    }
    return value;
}

function cleanText(value) {
    return String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function stripHtmlTags(value) {
    const raw = String(value || '');
    if (!raw.trim()) return '';
    // 仅当包含 HTML 标签样式或实体时交由 cheerio 解析，避免把数学不等式 "a < b and c > d" 当成标签吞掉。
    if (/<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>|&(?:#\d+|#x[0-9a-f]+|[a-z]+);/i.test(raw)) {
        const $ = cheerio.load(`<div>${raw}</div>`);
        return cleanText($('div').first().text());
    }
    return cleanText(raw);
}

function isPublicDnsHostname(hostname) {
    const host = String(hostname || '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost')
        || host.endsWith('.local') || host.includes(':') || net.isIP(host) !== 0
        || !host.includes('.') || host.length > 253) {
        return false;
    }
    return host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function assertCanonicalPublicHttpsUrl(value, label, { allowQuery = false } = {}) {
    const text = cleanText(value);
    if (!text) fail(`${label} 不能为空`);
    let parsed;
    try {
        parsed = new URL(text);
    } catch (_) {
        fail(`${label} 不是有效的 URL`);
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || parsed.hash || !isPublicDnsHostname(parsed.hostname)) {
        fail(`${label} 必须是不含凭证、端口和片段的公开 HTTPS URL`);
    }
    if (!allowQuery && parsed.search) {
        fail(`${label} 不得包含查询参数`);
    }
    const rawPathAndQuery = text.slice(`https://${parsed.host}`.length);
    const expectedPathAndQuery = `${parsed.pathname}${parsed.search}`;
    if (parsed.pathname === '/' || rawPathAndQuery !== expectedPathAndQuery
        || parsed.pathname.includes('//') || parsed.pathname.includes('/..') || parsed.pathname.includes('/./')
        || /%(?:2e|2f|5c)/i.test(parsed.pathname)) {
        fail(`${label} 必须使用规范且无目录穿越的路径`);
    }
    if (parsed.toString() !== text) fail(`${label} 必须使用规范 URL 拼写`);
    return text;
}

function normalizeDoi(rawDoi) {
    if (rawDoi === null || rawDoi === undefined) return null;
    let s = cleanText(rawDoi);
    if (!s) return null;
    s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim();
    if (!DOI_RE.test(s)) fail(`DOI 格式无效：${s}`);
    return s;
}

function normalizePaperRecord(raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        fail(`第 ${index + 1} 条论文记录必须是对象`);
    }
    const id = cleanText(raw.id);
    if (!ID_RE.test(id)) fail(`论文 ID 非法：${id}`);
    const title = cleanText(raw.title);
    if (!title) fail(`论文 ${id} 缺少标题`);
    const rawAuthors = (Array.isArray(raw.authors) ? raw.authors : []).map(cleanText).filter(Boolean);
    const authors = [...new Set(rawAuthors)];
    if (authors.length < 1 || authors.length > 1000) {
        fail(`论文 ${id} 必须包含 1 至 1000 位去重后的有效作者`);
    }
    const abstract = cleanText(raw.abstract || '');
    const doi = normalizeDoi(raw.doi);
    const track = cleanText(raw.track || 'main');
    if (!track) fail(`论文 ${id} 缺少 track`);
    // conference-discovery & paper-identity 均要求 recordUrl 非空且不含查询串
    const recordUrl = assertCanonicalPublicHttpsUrl(raw.recordUrl, `论文 ${id} 的 recordUrl`, { allowQuery: false });
    const pdfUrl = raw.pdfUrl ? assertCanonicalPublicHttpsUrl(raw.pdfUrl, `论文 ${id} 的 pdfUrl`, { allowQuery: true }) : null;
    if (pdfUrl && pdfUrl === recordUrl) fail(`论文 ${id} 的 recordUrl 与 pdfUrl 不得相同`);
    const pdfFile = (pdfUrl || raw.pdfFile) ? cleanText(raw.pdfFile || `pdfs/${id}.pdf`) : null;
    if (pdfFile && (!/^pdfs\/[A-Za-z0-9._-]+\.pdf$/i.test(pdfFile) || pdfFile.includes('..'))) {
        fail(`论文 ${id} 的 pdfFile 路径非法：${pdfFile}`);
    }
    const record = { abstract, authors, doi, id, pdfFile, pdfUrl, recordUrl, title, track };
    exact(record, PAPER_FIELDS, `论文 ${id}`);
    return record;
}

const ZENODO_PDF_PATH_RE = /^\/(?:(?:api\/)?records\/\d+\/files\/[^/?#]+\.pdf(?:\/content)?|api\/files\/[A-Za-z0-9-]+\/[^/?#]+\.pdf)$/i;

function makeAclVolumeProvider(id, year, volumeSlug, trackLabel) {
    const escaped = volumeSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Object.freeze({
        conference: Object.freeze({ id, year }),
        parser: 'acl-anthology-html',
        indexUrl: `https://aclanthology.org/volumes/${year}.${volumeSlug}/`,
        allowedHosts: Object.freeze(['aclanthology.org']),
        recordPath: new RegExp(`^\\/${year}\\.${escaped}\\.\\d+\\/?$`),
        pdfPath: new RegExp(`^\\/${year}\\.${escaped}\\.\\d+\\.pdf$`),
        volumePrefixes: Object.freeze([
            Object.freeze({ prefix: `${year}.${volumeSlug}.`, track: trackLabel })
        ])
    });
}

function makeIscaProvider(id, year, dirSlug, defaultTrack, { abstractOnlyIds = [] } = {}) {
    const escaped = dirSlug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return Object.freeze({
        conference: Object.freeze({ id, year }),
        parser: 'isca-html',
        indexUrl: `https://www.isca-archive.org/${dirSlug}/index.html`,
        allowedHosts: Object.freeze(['www.isca-archive.org']),
        recordPath: new RegExp(`^\\/${escaped}\\/(?!(?:index|author_index|committees?|search)\\.html$)[A-Za-z0-9_-]+\\.html$`),
        pdfPath: new RegExp(`^\\/${escaped}\\/[A-Za-z0-9_-]+\\.pdf$`),
        ...(abstractOnlyIds.length > 0 ? { abstractOnlyIds: Object.freeze([...abstractOnlyIds]) } : {}),
        defaultTrack
    });
}

function makeZenodoProvider(id, year, community) {
    return Object.freeze({
        conference: Object.freeze({ id, year }),
        parser: 'zenodo-json',
        community,
        stopBeforeYear: true,
        indexUrl: `https://zenodo.org/api/records?communities=${community}&size=25&sort=mostrecent`,
        allowedHosts: Object.freeze(['zenodo.org']),
        apiPath: /^\/api\/records$/,
        recordPath: /^\/records\/\d+$/,
        pdfPath: ZENODO_PDF_PATH_RE
    });
}

const EXTENDED_PROVIDERS = Object.freeze({
    // ===== Vertical Audio / Speech / Music =====
    'dcase-2026': Object.freeze({
        conference: Object.freeze({ id: 'dcase-2026', year: 2026 }),
        parser: 'dcase-proceedings-html',
        indexUrl: 'https://dcase.community/workshop2026/proceedings',
        allowedHosts: Object.freeze(['dcase.community']),
        recordPath: /^\/workshop2026\/proceedings$/,
        pdfPath: /^\/documents\/workshop2026\/proceedings\/DCASE2026Workshop_(?:[A-Za-z0-9._~'+-]|%[0-9A-Fa-f]{2})+_\d+\.pdf$/,
        defaultTrack: 'DCASE 2026'
    }),
    'smc-2026': makeZenodoProvider('smc-2026', 2026, 'smc'),
    // ISCA AVSP 2026 官方目录中 4 篇为纯摘要报告（记录页无 citation_pdf_url 且官方 .pdf 返回 404），按来源门禁跳过
    'avsp-2026': makeIscaProvider('avsp-2026', 2026, 'avsp_2026', 'AVSP 2026', {
        abstractOnlyIds: ['altuntas26_avsp', 'bosker26_avsp', 'martin26_avsp', 'shu26_avsp']
    }),
    'mlcslm-2026': makeIscaProvider('mlcslm-2026', 2026, 'mlcslm_2026', 'MLCSLM 2026'),
    'wochat-2026': makeIscaProvider('wochat-2026', 2026, 'wochat_2026', 'WOCHAT 2026'),
    'dc-2026': makeIscaProvider('dc-2026', 2026, 'dc_2026', 'ISCA DC 2026'),
    'sigdial-2026': makeAclVolumeProvider('sigdial-2026', 2026, 'sigdial-1', 'SIGDIAL 2026'),
    'iwsds-2026': makeAclVolumeProvider('iwsds-2026', 2026, 'iwsds-1', 'IWSDS 2026'),
    'sigul-2026': makeAclVolumeProvider('sigul-2026', 2026, 'sigul-1', 'SIGUL 2026'),
    'speakable-2026': makeAclVolumeProvider('speakable-2026', 2026, 'speakable-1', 'SPEAKABLE 2026'),
    'salma-2026': makeAclVolumeProvider('salma-2026', 2026, 'salma-1', 'SALMA 2026'),
    'impactspeech-2026': makeAclVolumeProvider('impactspeech-2026', 2026, 'impactspeech-1', 'ImpactSpeech 2026'),
    'nlp4musa-2026': makeAclVolumeProvider('nlp4musa-2026', 2026, 'nlp4musa-1', 'NLP4MusA 2026'),
    'trustaudio-2026': makeAclVolumeProvider('trustaudio-2026', 2026, 'trustaudio-1', 'TrustAudio 2026'),
    'audio-aaai-2026': Object.freeze({
        conference: Object.freeze({ id: 'audio-aaai-2026', year: 2026 }),
        parser: 'pmlr-html',
        volume: 'v312',
        indexUrl: 'https://proceedings.mlr.press/v312/',
        allowedHosts: Object.freeze(['proceedings.mlr.press', 'raw.githubusercontent.com']),
        recordHosts: Object.freeze(['proceedings.mlr.press']),
        recordPath: /^\/v312\/[A-Za-z0-9_-]+\.html$/,
        pdfPath: /^\/v312\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/,
        alternatePdfAuthorities: Object.freeze([
            Object.freeze({
                host: 'raw.githubusercontent.com',
                path: /^\/mlresearch\/v312\/main\/assets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/
            })
        ]),
        defaultTrack: 'Audio-AAAI 2026'
    }),
    'ismir-2026': makeZenodoProvider('ismir-2026', 2026, 'ismir'),
    'waspaa-2025': Object.freeze({
        conference: Object.freeze({ id: 'waspaa-2025', year: 2025 }),
        parser: 'ieee-local-manifest',
        indexUrl: 'https://ieeexplore.ieee.org/xpl/conhome/1000837/all-proceedings',
        allowedHosts: Object.freeze(['ieeexplore.ieee.org']),
        recordPath: /^\/document\/[1-9]\d*\/?$/,
        pdfPath: /^\/stamp\/stamp\.jsp$/,
        defaultTrack: 'WASPAA 2025'
    }),
    'asru-2025': Object.freeze({
        conference: Object.freeze({ id: 'asru-2025', year: 2025 }),
        parser: 'ieee-local-manifest',
        indexUrl: 'https://ieeexplore.ieee.org/xpl/conhome/1000043/all-proceedings',
        allowedHosts: Object.freeze(['ieeexplore.ieee.org']),
        recordPath: /^\/document\/[1-9]\d*\/?$/,
        pdfPath: /^\/stamp\/stamp\.jsp$/,
        defaultTrack: 'ASRU 2025'
    }),

    // ===== General AI / NLP / CV =====
    'emnlp-2026': Object.freeze({
        conference: Object.freeze({ id: 'emnlp-2026', year: 2026 }),
        parser: 'acl-anthology-html',
        indexUrl: 'https://aclanthology.org/events/emnlp-2026/',
        indexUrls: Object.freeze([
            'https://aclanthology.org/volumes/2026.emnlp-main/',
            'https://aclanthology.org/volumes/2026.findings-emnlp/'
        ]),
        allowedHosts: Object.freeze(['aclanthology.org']),
        recordPath: /^\/2026\.(?:emnlp-(?:main|short)|findings-emnlp)\.\d+\/?$/,
        pdfPath: /^\/2026\.(?:emnlp-(?:main|short)|findings-emnlp)\.\d+\.pdf$/,
        volumePrefixes: Object.freeze([
            Object.freeze({ prefix: '2026.emnlp-main.', track: 'EMNLP 2026 Main' }),
            Object.freeze({ prefix: '2026.emnlp-short.', track: 'EMNLP 2026 Short' }),
            Object.freeze({ prefix: '2026.findings-emnlp.', track: 'Findings of EMNLP 2026' })
        ])
    }),
    'eccv-2026': Object.freeze({
        conference: Object.freeze({ id: 'eccv-2026', year: 2026 }),
        parser: 'eccv-virtual-json',
        indexUrl: 'https://eccv.ecva.net/static/virtual/data/eccv-2026-orals-posters.json',
        allowedHosts: Object.freeze(['eccv.ecva.net', 'media.eventhosts.cc']),
        recordHosts: Object.freeze(['eccv.ecva.net']),
        pdfHosts: Object.freeze(['media.eventhosts.cc']),
        recordPath: /^\/virtual\/2026\/(?:oral|spotlight|poster)\/\d+$/,
        pdfPath: /^\/Conferences\/ECCV2026\/pdfs\/\d+\.pdf$/
    }),
    'lrec-2026': makeAclVolumeProvider('lrec-2026', 2026, 'lrec-main', 'LREC 2026 Main'),
    'wacv-2026': Object.freeze({
        conference: Object.freeze({ id: 'wacv-2026', year: 2026 }),
        parser: 'cvf-html',
        indexUrl: 'https://openaccess.thecvf.com/WACV2026?day=all',
        allowedHosts: Object.freeze(['openaccess.thecvf.com']),
        recordPath: /^\/content\/WACV2026\/html\/[A-Za-z0-9._-]+\.html$/,
        pdfPath: /^\/content\/WACV2026\/papers\/[A-Za-z0-9._-]+\.pdf$/,
        pdfBasePath: '/content/WACV2026/papers/',
        defaultTrack: 'WACV 2026'
    }),
    'ijcai-2026': Object.freeze({
        conference: Object.freeze({ id: 'ijcai-2026', year: 2026 }),
        parser: 'ijcai-html',
        indexUrl: 'https://www.ijcai.org/proceedings/2026/',
        allowedHosts: Object.freeze(['www.ijcai.org']),
        recordPath: /^\/proceedings\/2026\/\d+\/?$/,
        pdfPath: /^\/proceedings\/2026\/\d+\.pdf$/,
        defaultTrack: 'IJCAI 2026'
    }),
    'aacl-2026': Object.freeze({
        conference: Object.freeze({ id: 'aacl-2026', year: 2026 }),
        parser: 'acl-anthology-html',
        indexUrl: 'https://aclanthology.org/events/aacl-2026/',
        indexUrls: Object.freeze([
            'https://aclanthology.org/volumes/2026.aacl-long/',
            'https://aclanthology.org/volumes/2026.aacl-short/',
            'https://aclanthology.org/volumes/2026.findings-aacl/'
        ]),
        allowedHosts: Object.freeze(['aclanthology.org']),
        recordPath: /^\/2026\.(?:aacl-(?:long|short)|findings-aacl)\.\d+\/?$/,
        pdfPath: /^\/2026\.(?:aacl-(?:long|short)|findings-aacl)\.\d+\.pdf$/,
        volumePrefixes: Object.freeze([
            Object.freeze({ prefix: '2026.aacl-long.', track: 'AACL 2026 Long' }),
            Object.freeze({ prefix: '2026.aacl-short.', track: 'AACL 2026 Short' }),
            Object.freeze({ prefix: '2026.findings-aacl.', track: 'Findings of AACL 2026' })
        ])
    }),
    'conll-2026': makeAclVolumeProvider('conll-2026', 2026, 'conll-main', 'CoNLL 2026'),
    'starsem-2026': makeAclVolumeProvider('starsem-2026', 2026, 'starsem-conference', '*SEM 2026'),
    'neurips-2026': Object.freeze({
        conference: Object.freeze({ id: 'neurips-2026', year: 2026 }),
        parser: 'neurips-proceedings-html',
        indexUrl: 'https://proceedings.neurips.cc/paper_files/paper/2026',
        allowedHosts: Object.freeze(['proceedings.neurips.cc']),
        recordPath: /^\/paper_files\/paper\/2026\/hash\/[A-Za-z0-9]+-Abstract-[A-Za-z0-9_]+\.html$/,
        pdfPath: /^\/paper_files\/paper\/2026\/file\/[A-Za-z0-9]+-Paper-[A-Za-z0-9_]+\.pdf$/
    })
});

function hasProvider(providerId) {
    return Object.prototype.hasOwnProperty.call(EXTENDED_PROVIDERS, providerId);
}

function providerFor(providerId) {
    if (!hasProvider(providerId)) {
        fail(`不受支持的扩展官方会议提供方：${providerId}`);
    }
    return EXTENDED_PROVIDERS[providerId];
}

function listProviderIds() {
    return Object.keys(EXTENDED_PROVIDERS);
}

function implementationSha256() {
    return readStableFile(__filename, 'official-conference-acquisition-extended.js', MAX_INDEX_BYTES, { requireMode0600: false }).sha256;
}

function isAllowedIndexRedirectTarget(requestedUrl, targetUrl) {
    if (targetUrl === requestedUrl) return true;
    if (!requestedUrl.endsWith('/') && !requestedUrl.includes('?') && targetUrl === `${requestedUrl}/`) {
        return true;
    }
    return false;
}

function validateUrlForProvider(provider, rawUrl, kind) {
    const indexCandidates = Array.isArray(provider.indexUrls) && provider.indexUrls.length > 0
        ? [...provider.indexUrls, ...(provider.indexUrl ? [provider.indexUrl] : [])]
        : (provider.indexUrl ? [provider.indexUrl] : []);
    const allowIndexQuery = (kind === 'index' || kind === 'json-index')
        && indexCandidates.some(candidate => candidate.includes('?'));
    const cleaned = assertCanonicalPublicHttpsUrl(rawUrl, `official ${kind} URL`, {
        allowQuery: kind === 'api'
            || allowIndexQuery
            || (kind === 'pdf' && (provider.parser === 'ieee-local-manifest' || provider.parser === 'zenodo-json'))
    });
    const parsed = new URL(cleaned);
    const host = parsed.hostname.toLowerCase();
    if (!provider.allowedHosts.includes(host)) {
        fail(`官方请求主机不在白名单中：${host}（允许：${provider.allowedHosts.join(', ')}）`);
    }
    if (kind === 'index') {
        const matched = indexCandidates.some(candidate => isAllowedIndexRedirectTarget(candidate, cleaned));
        if (!matched) {
            fail(`官方 index URL 必须严格等于固定入口：${indexCandidates.join(', ')}`);
        }
    } else if (kind === 'json-index') {
        if (cleaned !== provider.indexUrl) {
            fail(`官方 json-index URL 必须严格等于固定入口：${provider.indexUrl}`);
        }
    } else if (kind === 'record') {
        if (provider.recordHosts && !provider.recordHosts.includes(host)) {
            fail(`官方 record 主机不在白名单中：${host}（允许：${provider.recordHosts.join(', ')}）`);
        }
        if (provider.recordPath && !provider.recordPath.test(parsed.pathname)) {
            fail(`官方 record 路径不符合白名单：${parsed.pathname}`);
        }
    } else if (kind === 'api') {
        if (!provider.apiPath || !provider.apiPath.test(parsed.pathname)) {
            fail(`官方 API 路径不符合契约：${parsed.pathname}`);
        }
        if (provider.parser === 'zenodo-json') {
            const allowedParams = new Set(['communities', 'page', 'size', 'sort']);
            if (provider.apiQuery) allowedParams.add('q');
            const seenParamCounts = new Map();
            for (const key of parsed.searchParams.keys()) {
                if (!allowedParams.has(key)) {
                    fail(`Zenodo 分页 URL 包含未允许的查询参数：${key}`);
                }
                seenParamCounts.set(key, (seenParamCounts.get(key) || 0) + 1);
                if (seenParamCounts.get(key) > 1) {
                    fail(`Zenodo 分页 URL 不得包含重复查询参数：${key}`);
                }
            }
            const communities = parsed.searchParams.getAll('communities');
            if (communities.length !== 1 || communities[0] !== provider.community) {
                fail(`Zenodo 分页 URL 必须保留唯一固定社区参数 communities=${provider.community}`);
            }
            if (provider.stopBeforeYear) {
                const sorts = parsed.searchParams.getAll('sort');
                if (sorts.length !== 1 || sorts[0] !== 'mostrecent') {
                    fail('Zenodo 早停分页 URL 必须保留固定排序参数 sort=mostrecent');
                }
            }
            if (parsed.searchParams.has('page') && !/^[1-9]\d*$/.test(parsed.searchParams.get('page') || '')) {
                fail(`Zenodo 分页 URL 的 page 参数无效：${parsed.searchParams.get('page')}`);
            }
            if (parsed.searchParams.has('size') && !/^[1-9]\d*$/.test(parsed.searchParams.get('size') || '')) {
                fail(`Zenodo 分页 URL 的 size 参数无效：${parsed.searchParams.get('size')}`);
            }
            if (provider.apiQuery && parsed.searchParams.get('q') !== provider.apiQuery) {
                fail('Zenodo 分页 URL 的 q 参数与固定配置不匹配');
            }
        }
    } else if (kind === 'pdf') {
        if (provider.pdfHosts && !provider.pdfHosts.includes(host)) {
            fail(`官方 PDF 主机不在白名单中：${host}（允许：${provider.pdfHosts.join(', ')}）`);
        }
        if (Array.isArray(provider.alternatePdfAuthorities) && provider.alternatePdfAuthorities.length > 0) {
            const primaryHost = provider.recordHosts ? provider.recordHosts[0] : provider.allowedHosts[0];
            const matchesPrimary = host === primaryHost && (!provider.pdfPath || provider.pdfPath.test(parsed.pathname));
            const matchesAlternate = provider.alternatePdfAuthorities.some(authority => (
                host === authority.host && authority.path.test(parsed.pathname)
            ));
            if (!matchesPrimary && !matchesAlternate) {
                fail(`官方 PDF 路径不符合白名单：${host}${parsed.pathname}`);
            }
        } else if (provider.pdfPath && !provider.pdfPath.test(parsed.pathname)) {
            fail(`官方 PDF 路径不符合白名单：${parsed.pathname}`);
        }
        if (provider.parser === 'ieee-local-manifest') {
            const arnumber = parsed.searchParams.get('arnumber') || '';
            if (!/^[1-9]\d*$/.test(arnumber) || parsed.search !== `?arnumber=${arnumber}`) {
                fail(`IEEE 官方 PDF URL 必须包含规范的 ?arnumber=<digits>：${cleaned}`);
            }
        } else if (provider.parser === 'zenodo-json') {
            if (parsed.search && parsed.search !== '?download=1') {
                fail(`Zenodo 官方 PDF URL 仅允许空查询或 ?download=1：${cleaned}`);
            }
        }
    } else {
        fail(`未知的官方请求类型：${kind}`);
    }
    return cleaned;
}

function validateRedirectChain(provider, requestedUrl, finalUrl, redirects, kind, label) {
    const rootUrl = validateUrlForProvider(provider, requestedUrl, kind);
    let current = rootUrl;
    for (const hop of redirects) {
        exact(hop, ['from', 'status', 'to'], `${label}.redirects`);
        if (![301, 302, 303, 307, 308].includes(hop.status)) {
            fail(`${label} 重定向状态码无效`);
        }
        if (hop.from !== current) {
            fail(`${label} 重定向链中断：期望 from=${current}，实际 ${hop.from}`);
        }
        const nextUrl = validateUrlForProvider(provider, hop.to, kind);
        if (kind === 'index' && !isAllowedIndexRedirectTarget(rootUrl, nextUrl)) {
            fail(`${label} 官方 index 重定向偏离固定入口：期望 ${rootUrl}，实际 ${nextUrl}`);
        }
        current = nextUrl;
    }
    if (finalUrl !== current) {
        fail(`${label} finalUrl 与重定向链终点不一致：期望 ${current}，实际 ${finalUrl}`);
    }
    return current;
}

async function readResponseBytes(response, maxBytes, label) {
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        fail(`${label} 超过字节上限 ${maxBytes}`);
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > maxBytes) {
            fail(`${label} 为空或超过字节上限 ${maxBytes}`);
        }
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            total += chunk.length;
            if (total > maxBytes) {
                await reader.cancel();
                fail(`${label} 超过字节上限 ${maxBytes}`);
            }
            chunks.push(chunk);
        }
    } finally {
        reader.releaseLock?.();
    }
    if (!total) fail(`${label} 为空`);
    return Buffer.concat(chunks, total);
}

const TRANSIENT_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_FETCH_MAX_RETRIES = 3;
const DEFAULT_FETCH_RETRY_BASE_DELAY_MS = 500;
const MAX_FETCH_RETRY_DELAY_MS = 30000;

function parseRetryAfterMs(headers) {
    const raw = headers?.get?.('retry-after');
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed);
        return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_FETCH_RETRY_DELAY_MS) : null;
    }
    const parsedDate = Date.parse(trimmed);
    if (Number.isFinite(parsedDate)) {
        return Math.min(Math.max(0, parsedDate - Date.now()), MAX_FETCH_RETRY_DELAY_MS);
    }
    return null;
}

function computeJitteredRetryDelayMs(attempt, baseDelayMs, randomFn, retryAfterMs = null) {
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
        return Math.min(MAX_FETCH_RETRY_DELAY_MS, Math.round(retryAfterMs));
    }
    const exp = Math.min(MAX_FETCH_RETRY_DELAY_MS, baseDelayMs * (2 ** attempt));
    const factor = 0.75 + 0.5 * (typeof randomFn === 'function' ? randomFn() : Math.random());
    return Math.min(MAX_FETCH_RETRY_DELAY_MS, Math.max(0, Math.round(exp * factor)));
}

async function fetchOfficialExtended({ provider, url, kind, maxBytes, timeoutMs = REQUEST_TIMEOUT_MS, maxRetries } = {}, dependencies = {}) {
    const requestedUrl = validateUrlForProvider(provider, url, kind);
    const fetchImpl = dependencies.fetch || dependencies.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') fail('当前运行时缺少 fetch 实现');

    let dispatcher;
    const useProxyDispatcher = (!dependencies.fetch && !dependencies.fetchImpl)
        || Boolean(dependencies.detectProxy || dependencies.createDispatcher);
    if (useProxyDispatcher) {
        const utils = require('../utils.js');
        const proxyUrl = (dependencies.detectProxy || utils.detectHttpConnectProxyUrl)();
        if (!proxyUrl) fail('官方会议获取必须配置项目 .env 中的 HTTP CONNECT 代理（HTTPS_PROXY/HTTP_PROXY）');
        // utils.createProxyDispatcher 返回进程级缓存单例，绝不能在单次请求结束后 close()
        dispatcher = (dependencies.createDispatcher || utils.createProxyDispatcher)(proxyUrl);
    }

    const retriesRaw = maxRetries ?? dependencies.maxRetries ?? DEFAULT_FETCH_MAX_RETRIES;
    const totalRetries = Number.isInteger(retriesRaw) ? Math.max(0, Math.min(retriesRaw, 5)) : DEFAULT_FETCH_MAX_RETRIES;
    const retryBaseDelayMs = Number.isFinite(dependencies.retryBaseDelayMs) && dependencies.retryBaseDelayMs >= 0
        ? dependencies.retryBaseDelayMs
        : DEFAULT_FETCH_RETRY_BASE_DELAY_MS;
    const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const randomFn = dependencies.random || Math.random;

    for (let attempt = 0; attempt <= totalRetries; attempt += 1) {
        let current = requestedUrl;
        const redirects = [];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref?.();
        let transientRetry = null;
        try {
            for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
                const accept = kind === 'pdf'
                    ? 'application/pdf, application/octet-stream;q=0.9, */*;q=0.8'
                    : (kind === 'api' || kind === 'json-index')
                        ? 'application/json'
                        : 'text/html,application/xhtml+xml';
                const response = await fetchImpl(current, {
                    method: 'GET',
                    redirect: 'manual',
                    ...(dispatcher ? { dispatcher } : {}),
                    signal: controller.signal,
                    headers: {
                        Accept: accept,
                        'User-Agent': 'audio-research-workbench-official-conference/2.0'
                    }
                });
                if ([301, 302, 303, 307, 308].includes(response.status)) {
                    await response.body?.cancel?.();
                    if (hop >= MAX_REDIRECTS) fail('官方响应超过重定向上限');
                    const location = response.headers?.get?.('location');
                    if (!location) fail('官方重定向缺少 Location 头');
                    let resolved;
                    try {
                        resolved = new URL(location, current).toString();
                    } catch (_) {
                        fail(`官方重定向目标不是合法 URL：${location}`);
                    }
                    const nextUrl = validateUrlForProvider(provider, resolved, kind);
                    if (kind === 'index' && !isAllowedIndexRedirectTarget(requestedUrl, nextUrl)) {
                        fail(`官方 index 重定向偏离固定入口：期望 ${requestedUrl}，实际 ${nextUrl}`);
                    }
                    redirects.push({ status: response.status, from: current, to: nextUrl });
                    current = nextUrl;
                    continue;
                }
                if (response.status !== 200) {
                    const retryAfterMs = parseRetryAfterMs(response.headers);
                    await response.body?.cancel?.();
                    if (TRANSIENT_HTTP_STATUSES.has(response.status) && attempt < totalRetries) {
                        transientRetry = { retryAfterMs };
                        break;
                    }
                    fail(`official ${kind} returned HTTP ${response.status}`);
                }
                const contentType = String(response.headers?.get?.('content-type') || '').trim();
                const okContentType = kind === 'pdf'
                    ? /^(?:application\/pdf|application\/octet-stream)(?:\s*;|$)/iu.test(contentType)
                    : (kind === 'api' || kind === 'json-index')
                        ? /^(?:application\/json|application\/vnd\.zenodo\.v1\+json)(?:\s*;|$)/iu.test(contentType)
                        : /^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/iu.test(contentType);
                if (!okContentType) {
                    await response.body?.cancel?.();
                    fail(`官方 ${kind} 响应 Content-Type 无效：${contentType || '(empty)'}`);
                }
                const buf = await readResponseBytes(response, maxBytes, `官方 ${kind} 响应`);
                if (kind === 'pdf' && buf.subarray(0, 5).toString('ascii') !== '%PDF-') {
                    fail('官方 PDF 响应缺少 %PDF- 文件头');
                }
                const observedAt = (dependencies.now || (() => new Date().toISOString()))();
                return {
                    bytes: buf,
                    requestedUrl,
                    finalUrl: current,
                    redirects,
                    responseStatus: response.status,
                    contentType,
                    observedAt
                };
            }
            if (!transientRetry) {
                fail('官方响应超过重定向上限');
            }
        } catch (error) {
            if (error instanceof OfficialConferenceAcquisitionExtendedError) throw error;
            if (attempt < totalRetries) {
                transientRetry = { retryAfterMs: null };
            } else {
                if (error?.name === 'AbortError') fail(`official ${kind} request timed out`);
                const reason = String(error?.cause?.code || error?.code || error?.message || 'network error')
                    .replace(/[^A-Za-z0-9_.: -]/g, '').slice(0, 160);
                fail(`official ${kind} request failed: ${reason}`);
            }
        } finally {
            clearTimeout(timer);
        }
        if (transientRetry) {
            const delayMs = computeJitteredRetryDelayMs(attempt, retryBaseDelayMs, randomFn, transientRetry.retryAfterMs);
            if (delayMs > 0) await sleep(delayMs);
        }
    }
    fail(`official ${kind} request failed after retries`);
}

function hrefUrl(href, base) {
    try {
        return new URL(String(href || '').trim(), base).toString();
    } catch (_) {
        return null;
    }
}

function splitAuthorLine(value) {
    return [...new Set(
        cleanText(value)
            .replace(/[,;\s]+$/u, '')
            .split(/\s*;\s*|,\s+(?:and\s+)?|\s+and\s+/u)
            .map(cleanText)
            .filter(Boolean)
    )];
}

function stripBalancedParens(value) {
    let out = '';
    let depth = 0;
    for (const ch of String(value || '')) {
        if (ch === '(') depth += 1;
        else if (ch === ')') {
            if (depth > 0) depth -= 1;
        } else if (depth === 0) {
            out += ch;
        }
    }
    return cleanText(out);
}

function parseDcaseAuthors(rawText) {
    const text = cleanText(rawText);
    if (!text) return [];
    const parts = [];
    let current = '';
    let depth = 0;
    for (const ch of text) {
        if (ch === '(') depth += 1;
        else if (ch === ')' && depth > 0) depth -= 1;
        if (ch === ';' && depth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += ch;
        }
    }
    if (current) parts.push(current);
    return parts
        .map(part => stripBalancedParens(part).replace(/^and\s+/i, '').replace(/[,;\s]+$/g, '').trim())
        .filter(Boolean);
}

function extractPublicationYear(pubDate) {
    const m = /^(\d{4})(?:$|[-/T])/.exec(String(pubDate || '').trim());
    return m ? Number(m[1]) : null;
}

/**
 * 判断 Zenodo 分页是否已全部进入目标年份之前（按 sort=mostrecent 降序排列时用于安全早停）。
 * 当记录携带 created 时间戳时，必须同时满足 created 年份 < 目标年份 与 publication_date 年份 < 目标年份，
 * 避免 2026 年补传历史年份论文时过早终止分页。
 */
function shouldStopZenodoPagination(parsedPage, provider) {
    if (!provider?.stopBeforeYear || !Number.isInteger(provider?.conference?.year)) return false;
    const hits = Array.isArray(parsedPage?.hits?.hits) ? parsedPage.hits.hits : [];
    if (hits.length === 0) return false;
    const anyHasCreated = hits.some(hit => hit?.created !== undefined && hit?.created !== null && String(hit.created).trim() !== '');
    return hits.every(hit => {
        const pubYear = extractPublicationYear(hit?.metadata?.publication_date);
        if (pubYear === null || pubYear >= provider.conference.year) return false;
        if (!anyHasCreated) return true;
        const createdYear = extractPublicationYear(hit?.created);
        return createdYear !== null && createdYear < provider.conference.year;
    });
}

/**
 * 解析 ACL Anthology 会议/卷页面 HTML（支持单卷字符串或多卷字符串数组，兼容旧 p.d-sm-flex 与新 div.d-sm-flex）。
 */
function parseEmnlpCatalogHtml(htmlInput, provider = EXTENDED_PROVIDERS['emnlp-2026']) {
    const htmlList = Array.isArray(htmlInput) ? htmlInput : [htmlInput];
    const byId = new Map();
    for (const htmlText of htmlList) {
        const $ = cheerio.load(String(htmlText || ''));
        $('p.d-sm-flex, div.d-sm-flex').each((_, el) => {
            const $p = $(el);
            if ($p.find('.d-sm-flex').length > 0) return;
            const $titleLink = $p.find('strong a.align-middle[href], strong a[href]').first();
            const href = cleanText($titleLink.attr('href'));
            if (!href) return;
            let parsed;
            try {
                parsed = new URL(href, 'https://aclanthology.org');
            } catch (_) {
                return;
            }
            if (parsed.protocol !== 'https:'
                || parsed.hostname.toLowerCase() !== 'aclanthology.org'
                || parsed.search
                || parsed.hash
                || !provider.recordPath.test(parsed.pathname)) {
                return;
            }
            const paperId = parsed.pathname.replace(/^\/|\/$/g, '');
            if (/\.0$/.test(paperId)) return;
            const matchedVol = provider.volumePrefixes.find(v => paperId.startsWith(v.prefix));
            if (!matchedVol) return;
            const title = cleanText($titleLink.text());
            if (!title) return;
            const authors = [];
            let $authorLinks = $p.find('span.d-block a[href^="/people/"]');
            if ($authorLinks.length === 0) $authorLinks = $p.find('a[href^="/people/"]');
            $authorLinks.each((__, a) => {
                const name = cleanText($(a).text());
                if (name) authors.push(name);
            });
            const recordUrl = `https://aclanthology.org/${paperId}/`;
            const pdfUrl = `https://aclanthology.org/${paperId}.pdf`;
            const doi = `10.18653/v1/${paperId}`;
            const abstractId = `abstract-${paperId.replace(/\./g, '--')}`;
            const abstract = cleanText(
                $(`#${abstractId} .card-body`).text()
                || $p.next('div.abstract-collapse').find('.card-body').text()
                || $p.next('div.abstract-collapse').text()
            );
            if (!byId.has(paperId)) {
                byId.set(paperId, normalizePaperRecord({
                    id: paperId,
                    title,
                    authors,
                    abstract,
                    doi,
                    track: matchedVol.track,
                    recordUrl,
                    pdfUrl,
                    pdfFile: `pdfs/${paperId}.pdf`
                }, byId.size));
            }
        });
    }
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} HTML 目录未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 DCASE Workshop 官方会议录 HTML（https://dcase.community/workshop2026/proceedings）。
 */
function parseDcaseProceedingsHtml(htmlText, provider = EXTENDED_PROVIDERS['dcase-2026']) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    $('a[href]').each((_, el) => {
        const $a = $(el);
        const href = cleanText($a.attr('href'));
        if (!href || !/\.pdf(?:$|[?#])/i.test(href)) return;
        const resolvedPdfUrl = hrefUrl(href, provider.indexUrl);
        if (!resolvedPdfUrl) return;
        let parsedPdf;
        try {
            parsedPdf = new URL(resolvedPdfUrl);
        } catch (_) {
            return;
        }
        if (parsedPdf.protocol !== 'https:' || !provider.allowedHosts.includes(parsedPdf.hostname.toLowerCase())
            || parsedPdf.search || parsedPdf.hash || !provider.pdfPath.test(parsedPdf.pathname)) {
            return;
        }
        const numMatch = /_(\d+)\.pdf$/i.exec(parsedPdf.pathname);
        if (!numMatch) return;
        const id = `dcase${provider.conference.year}-${numMatch[1]}`;
        let $card = $a.parents('.row, .panel, .tab, article, li')
            .filter((__, node) => $(node).find('h4').length > 0)
            .first();
        if (!$card.length) {
            $card = $a.parents('div').filter((__, node) => $(node).find('h4').length > 0).first();
        }
        const title = cleanText($card.find('h4 strong').first().text() || $card.find('h4').first().text());
        if (!title) return;
        const rawAuthors = cleanText($card.find('p em').first().text() || $card.find('em').first().text());
        const authors = parseDcaseAuthors(rawAuthors);
        let abstract = '';
        const $collapseTrigger = $card.find('a[href^="#collapse-"], button[data-target^="#collapse-"], a[data-target^="#collapse-"], [data-bs-target^="#collapse-"]').first();
        const collapseSelector = cleanText(
            $collapseTrigger.attr('href')
            || $collapseTrigger.attr('data-target')
            || $collapseTrigger.attr('data-bs-target')
        );
        if (collapseSelector && /^#[A-Za-z0-9_-]+$/.test(collapseSelector)) {
            const $target = $(collapseSelector);
            abstract = cleanText(
                $target.find('p.text-justify').text()
                || $target.find('.panel-body p').text()
                || $target.find('.panel-body').text()
                || $target.text()
            );
        }
        if (!abstract) {
            abstract = cleanText(
                $card.find('.collapse p.text-justify').text()
                || $card.find('.collapse .panel-body p').text()
                || $card.find('.collapse .panel-body').text()
            );
        }
        const track = cleanText($card.find('.item-tag').first().text()) || provider.defaultTrack || `DCASE ${provider.conference.year}`;
        const recordUrl = validateUrlForProvider(provider, provider.indexUrl, 'record');
        const pdfUrl = validateUrlForProvider(provider, resolvedPdfUrl, 'pdf');
        if (!byId.has(id)) {
            byId.set(id, normalizePaperRecord({
                id,
                title,
                authors,
                abstract,
                doi: null,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${id}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} DCASE 官方会议录 HTML 未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 Zenodo REST API 分页 JSON（ISMIR / SMC 等官方会议录）。
 */
function parseZenodoRecordsPages(pages, provider) {
    if (!Array.isArray(pages) || pages.length === 0) {
        fail(`${provider.conference.id} 缺少 Zenodo 分页响应`);
    }
    const byId = new Map();
    for (const page of pages) {
        const hits = Array.isArray(page?.hits?.hits) ? page.hits.hits : [];
        for (const hit of hits) {
            const recordId = String(hit?.id ?? '').trim();
            if (!/^\d+$/.test(recordId)) continue;
            const meta = hit?.metadata || {};
            const pubDate = String(meta.publication_date || '');
            if (provider.conference?.year && pubDate && !pubDate.startsWith(String(provider.conference.year))) {
                continue;
            }
            const title = cleanText(meta.title);
            if (!title) continue;
            const authors = (Array.isArray(meta.creators) ? meta.creators : [])
                .map(c => cleanText(c?.name))
                .filter(Boolean);
            if (authors.length === 0) continue;
            const abstract = stripHtmlTags(meta.description || '');
            const rawDoi = cleanText(hit.doi || meta.doi || '');
            const doi = rawDoi && DOI_RE.test(rawDoi.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')) ? rawDoi : null;
            const files = Array.isArray(hit.files) ? hit.files : [];
            const pdfEntry = files.find(f => /\.pdf$/i.test(String(f?.key || f?.filename || '')));
            const rawPdfUrl = pdfEntry?.links?.self || pdfEntry?.links?.content || pdfEntry?.links?.download || '';
            let pdfUrl = null;
            if (rawPdfUrl) {
                try {
                    const candidate = new URL(rawPdfUrl).toString();
                    pdfUrl = validateUrlForProvider(provider, candidate, 'pdf');
                } catch (_) {
                    pdfUrl = null;
                }
            }
            const id = `zenodo-${recordId}`;
            const recordUrl = validateUrlForProvider(provider, `https://zenodo.org/records/${recordId}`, 'record');
            const track = cleanText(meta.conference?.title || meta.conference?.acronym || `${provider.community.toUpperCase()} ${provider.conference.year}`);
            if (!byId.has(id)) {
                byId.set(id, normalizePaperRecord({
                    id,
                    title,
                    authors,
                    abstract,
                    doi,
                    track,
                    recordUrl,
                    pdfUrl,
                    pdfFile: pdfUrl ? `pdfs/${id}.pdf` : null
                }, byId.size));
            }
        }
    }
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} Zenodo 响应未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 ISCA Archive 官方会议目录 HTML（AVSP / MLCSLM / WOCHAT / ISCA DC 等，限定论文卡片并自动跳过 Keynote 与导航链接）。
 */
function parseIscaCatalogHtml(htmlText, provider) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    const $cards = $('.w3-card');
    const $anchors = $cards.length > 0 ? $cards.find('a[href]') : $('a[href]');
    $anchors.each((_, el) => {
        const $a = $(el);
        if ($a.closest('nav, header, footer').length > 0) return;
        const resolvedRecord = hrefUrl($a.attr('href'), provider.indexUrl);
        if (!resolvedRecord) return;
        let parsed;
        try {
            parsed = new URL(resolvedRecord);
        } catch (_) {
            return;
        }
        if (parsed.protocol !== 'https:' || !provider.allowedHosts.includes(parsed.hostname.toLowerCase())
            || parsed.search || parsed.hash || !provider.recordPath.test(parsed.pathname)) {
            return;
        }
        const $card = $a.closest('.w3-card');
        const heading = cleanText($card.find('h4').first().text());
        if (/keynote/iu.test(heading)) return;
        const id = path.posix.basename(parsed.pathname, '.html');
        if (Array.isArray(provider.abstractOnlyIds) && provider.abstractOnlyIds.includes(id)) return;
        const titleNode = $a.find('p').first().clone();
        titleNode.find('.w3-text-theme, br').remove();
        const title = cleanText($a.attr('data-title') || $a.find('.title').text() || titleNode.text() || $a.text());
        if (!title) return;
        let authors = $a.find('.w3-text-theme').toArray()
            .flatMap(node => splitAuthorLine($(node).text()));
        if (!authors.length && $a.find('p br').length > 0) {
            const pNodes = $a.find('p').first().contents().toArray();
            const brIndex = pNodes.findIndex(node => node.type === 'tag' && node.name === 'br');
            if (brIndex >= 0) {
                const afterBr = pNodes.slice(brIndex + 1).map(node => $(node).text()).join(' ');
                authors = splitAuthorLine(afterBr);
            }
        }
        if (!authors.length) {
            const $singleContainer = ($card.length && $card.find('a[href]').length === 1)
                ? $card
                : $a.closest('tr, li, article, p, .paper');
            if ($singleContainer.length) {
                authors = $singleContainer.find('[data-author], .authors .author, .authors a, [itemprop="author"], .author')
                    .toArray()
                    .map(node => cleanText($(node).text()))
                    .filter(Boolean);
            }
        }
        if (!authors.length) return;
        const recordUrl = validateUrlForProvider(provider, resolvedRecord, 'record');
        const pdfUrl = validateUrlForProvider(provider, new URL(`${id}.pdf`, provider.indexUrl).toString(), 'pdf');
        const track = cleanText($card.attr('data-track') || heading || provider.defaultTrack || provider.conference.id);
        if (!byId.has(id)) {
            byId.set(id, normalizePaperRecord({
                id,
                title,
                authors,
                abstract: '',
                doi: null,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${id}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} ISCA HTML 目录未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

function assertPmlrPdfIdentity(provider, pdfUrl, expectedId) {
    const parsed = new URL(pdfUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const basename = path.posix.basename(parsed.pathname, '.pdf');
    const parent = parts.at(-2);
    if (basename !== expectedId || parent !== expectedId) {
        fail(`PMLR PDF 身份与其官方 record 不一致：${expectedId}`);
    }
    if (parsed.hostname.toLowerCase() === 'proceedings.mlr.press' && parts[0] !== provider.volume) {
        fail(`PMLR PDF 离开了固定卷 ${provider.volume}`);
    }
    if (parsed.hostname.toLowerCase() === 'raw.githubusercontent.com'
        && (parts[0] !== 'mlresearch' || parts[1] !== provider.volume || parts[2] !== 'main' || parts[3] !== 'assets')) {
        fail(`PMLR 原始 PDF 离开了固定仓库路径 ${provider.volume}`);
    }
}

/**
 * 解析 PMLR 卷目录 HTML（如 Audio-AAAI 2026 PMLR v312，支持 raw.githubusercontent.com PDF 源）。
 */
function parsePmlrCatalogHtml(htmlText, provider = EXTENDED_PROVIDERS['audio-aaai-2026']) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    const $papers = $('.paper');
    $papers.each((_, el) => {
        const $paper = $(el);
        const $recordLink = $paper.find('a[href]').filter((__, a) => {
            const candidate = hrefUrl($(a).attr('href'), provider.indexUrl);
            if (!candidate) return false;
            try {
                validateUrlForProvider(provider, candidate, 'record');
                return true;
            } catch (_) {
                return false;
            }
        }).first();
        if (!$recordLink.length) return;
        const recordUrl = validateUrlForProvider(provider, hrefUrl($recordLink.attr('href'), provider.indexUrl), 'record');
        const id = path.posix.basename(new URL(recordUrl).pathname, '.html');
        const $pdfLink = $paper.find('a[href]').filter((__, a) => {
            const candidate = hrefUrl($(a).attr('href'), provider.indexUrl);
            if (!candidate) return false;
            try {
                validateUrlForProvider(provider, candidate, 'pdf');
                assertPmlrPdfIdentity(provider, candidate, id);
                return true;
            } catch (_) {
                return false;
            }
        }).first();
        if (!$pdfLink.length) fail(`PMLR record ${id} 缺少绑定身份的官方 PDF 链接`);
        const pdfUrl = validateUrlForProvider(provider, hrefUrl($pdfLink.attr('href'), provider.indexUrl), 'pdf');
        const title = cleanText($paper.find('.title, .paper-title').first().text() || $recordLink.attr('data-title') || '');
        const rawAuthors = String($paper.find('.authors, .paper-authors').first().text() || '').replace(/\u00a0/g, ' ');
        let authors = rawAuthors
            .split(/\s*,\s*/)
            .map(cleanText)
            .filter(Boolean);
        if (!authors.length) {
            authors = $paper.find('[itemprop="author"], .author').toArray()
                .map(node => cleanText($(node).text()))
                .filter(Boolean);
        }
        const track = cleanText($paper.attr('data-track') || provider.defaultTrack || 'Main');
        if (!byId.has(id)) {
            byId.set(id, normalizePaperRecord({
                id,
                title,
                authors,
                abstract: '',
                doi: null,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${id}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} PMLR HTML 目录未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 ECCV 官方虚拟会议 JSON（eccv.ecva.net/static/virtual/data/eccv-2026-orals-posters.json）。
 */
function parseEccvVirtualJson(jsonInput, provider = EXTENDED_PROVIDERS['eccv-2026']) {
    const jsonObj = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
    const results = Array.isArray(jsonObj?.results) ? jsonObj.results : [];
    const byId = new Map();
    for (const row of results) {
        const rawId = String(row?.id ?? '').trim();
        if (!/^\d+$/.test(rawId)) continue;
        const id = `eccv2026-${rawId}`;
        const title = cleanText(row.name);
        if (!title) continue;
        const authors = (Array.isArray(row.authors) ? row.authors : [])
            .map(author => cleanText(typeof author === 'string' ? author : author?.fullname))
            .filter(Boolean);
        const rawVirtualUrl = cleanText(row.virtualsite_url);
        if (!rawVirtualUrl) continue;
        const resolvedRecord = hrefUrl(rawVirtualUrl, 'https://eccv.ecva.net');
        if (!resolvedRecord) continue;
        const recordUrl = validateUrlForProvider(provider, resolvedRecord, 'record');
        const rawPdfUrl = cleanText(row.paper_pdf_url);
        const pdfUrl = rawPdfUrl ? validateUrlForProvider(provider, rawPdfUrl, 'pdf') : null;
        const abstract = stripHtmlTags(row.abstract || '');
        const track = cleanText(row.decision || row.eventtype || 'ECCV 2026');
        if (!byId.has(id)) {
            byId.set(id, normalizePaperRecord({
                id,
                title,
                authors,
                abstract,
                doi: null,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: pdfUrl ? `pdfs/${id}.pdf` : null
            }, byId.size));
        }
    }
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} ECCV JSON 目录未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

function cvfFallbackAuthorLine($, $container) {
    const values = [];
    for (const node of $container.contents().toArray()) {
        if (node.type === 'tag' && node.name === 'br') break;
        values.push($(node).text());
    }
    return splitAuthorLine(values.join(' '));
}

/**
 * 解析 CVF Open Access HTML 目录（如 WACV 2026：openaccess.thecvf.com/WACV2026?day=all）。
 */
function parseCvfCatalogHtml(htmlText, provider = EXTENDED_PROVIDERS['wacv-2026']) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    $('dt.ptitle a[href], .ptitle a[href]').each((_, el) => {
        const $a = $(el);
        const resolvedRecord = hrefUrl($a.attr('href'), provider.indexUrl);
        if (!resolvedRecord) return;
        let parsedRecord;
        try {
            parsedRecord = new URL(resolvedRecord);
        } catch (_) {
            return;
        }
        if (parsedRecord.protocol !== 'https:'
            || !provider.allowedHosts.includes(parsedRecord.hostname.toLowerCase())
            || parsedRecord.search || parsedRecord.hash
            || !provider.recordPath.test(parsedRecord.pathname)) {
            return;
        }
        const recordUrl = validateUrlForProvider(provider, resolvedRecord, 'record');
        const id = path.posix.basename(parsedRecord.pathname, '.html');
        const title = cleanText($a.text());
        if (!title) return;
        const $heading = $a.closest('dt, .ptitle');
        const $authorDd = $heading.is('dt') ? $heading.next('dd') : $heading.parent();
        const $nextDd = $heading.is('dt') ? $authorDd.next('dd') : $();
        let authors = $authorDd.find('form.authsearch input[name="query_author"]').toArray()
            .map(node => cleanText($(node).attr('value')))
            .filter(Boolean);
        if (!authors.length) {
            authors = $authorDd.find('form.authsearch a').toArray()
                .map(node => cleanText($(node).text()).replace(/,+\s*$/, ''))
                .filter(Boolean);
        }
        if (!authors.length) {
            authors = $authorDd.find('[itemprop="author"], .author').toArray()
                .map(node => cleanText($(node).text()))
                .filter(Boolean);
        }
        if (!authors.length) {
            authors = cvfFallbackAuthorLine($, $authorDd);
        }
        const findPdfIn = $scope => $scope.find('a[href]').filter((__, anchor) => {
            const candidate = hrefUrl($(anchor).attr('href'), provider.indexUrl);
            if (!candidate) return false;
            try {
                validateUrlForProvider(provider, candidate, 'pdf');
                return path.posix.basename(new URL(candidate).pathname, '.pdf') === id;
            } catch (_) {
                return false;
            }
        }).first();
        let $pdfAnchor = findPdfIn($authorDd);
        if (!$pdfAnchor.length && $nextDd.length) $pdfAnchor = findPdfIn($nextDd);
        const fallbackPdfUrl = `https://${parsedRecord.hostname}${provider.pdfBasePath}${id}.pdf`;
        const pdfUrl = validateUrlForProvider(
            provider,
            $pdfAnchor.length ? hrefUrl($pdfAnchor.attr('href'), provider.indexUrl) : fallbackPdfUrl,
            'pdf'
        );
        if (path.posix.basename(new URL(pdfUrl).pathname, '.pdf') !== id) {
            fail(`CVF record 与 PDF 身份不一致：${id}`);
        }
        const track = cleanText(provider.defaultTrack || 'Main');
        if (!byId.has(id)) {
            byId.set(id, normalizePaperRecord({
                id,
                title,
                authors,
                abstract: '',
                doi: null,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${id}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} CVF HTML 目录未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 IJCAI 官方会议录 HTML（https://www.ijcai.org/proceedings/2026/）。
 */
function parseIjcaiCatalogHtml(htmlText, provider = EXTENDED_PROVIDERS['ijcai-2026']) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    const $rows = $('.paper-row').length ? $('.paper-row') : $('.paper_wrapper');
    $rows.each((_, el) => {
        const $row = $(el);
        const $pdfLink = $row.find('.paper-row__actions a[href], a[href]').filter((__, a) => {
            const candidate = hrefUrl($(a).attr('href'), provider.indexUrl);
            if (!candidate) return false;
            try {
                validateUrlForProvider(provider, candidate, 'pdf');
                return true;
            } catch (_) {
                return false;
            }
        }).first();
        if (!$pdfLink.length) return;
        const pdfUrl = validateUrlForProvider(provider, hrefUrl($pdfLink.attr('href'), provider.indexUrl), 'pdf');
        const pdfStem = path.posix.basename(new URL(pdfUrl).pathname, '.pdf');
        const id = `ijcai${provider.conference.year}-${pdfStem}`;
        const $titleLink = $row.find('a.title[href], .title a[href]').first();
        const title = cleanText($titleLink.length ? $titleLink.text() : $row.find('.title').first().text());
        let recordUrl = null;
        if ($titleLink.length) {
            const titleCandidate = hrefUrl($titleLink.attr('href'), provider.indexUrl);
            if (titleCandidate) {
                try {
                    recordUrl = validateUrlForProvider(provider, titleCandidate, 'record');
                } catch (_) {
                    recordUrl = null;
                }
            }
        }
        if (!recordUrl) {
            const $recLink = $row.find('.paper-row__actions a[href], a[href]').filter((__, a) => {
                const candidate = hrefUrl($(a).attr('href'), provider.indexUrl);
                if (!candidate) return false;
                try {
                    validateUrlForProvider(provider, candidate, 'record');
                    return true;
                } catch (_) {
                    return false;
                }
            }).first();
            if ($recLink.length) {
                recordUrl = validateUrlForProvider(provider, hrefUrl($recLink.attr('href'), provider.indexUrl), 'record');
            }
        }
        if (!title || !recordUrl) return;
        let authors = $row.find('.authors a').toArray()
            .map(node => cleanText($(node).text()))
            .filter(Boolean);
        if (!authors.length) {
            authors = cleanText($row.find('.authors').first().text())
                .split(/\s*,\s*/)
                .map(cleanText)
                .filter(Boolean);
        }
        const rawDoiHref = cleanText($row.find('a[href*="doi.org/"]').first().attr('href'));
        const doiCandidate = rawDoiHref ? rawDoiHref.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').trim() : '';
        const doi = doiCandidate && DOI_RE.test(doiCandidate) ? doiCandidate : null;
        const track = cleanText(
            $row.closest('.subsection').children('h3, h4').first().text()
            || $row.closest('.section, section').children('h2, h3').first().text()
            || $row.prevAll('h3, h2').first().text()
            || provider.defaultTrack
            || 'IJCAI 2026'
        );
        if (!byId.has(id)) {
            byId.set(id, normalizePaperRecord({
                id,
                title,
                authors,
                abstract: '',
                doi,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${id}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} IJCAI HTML 目录未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析 NeurIPS 官方论文集页面 HTML（proceedings.neurips.cc，严格无查询串 canonical URL）。
 */
function parseNeuripsProceedingsHtml(htmlText, provider = EXTENDED_PROVIDERS['neurips-2026']) {
    const $ = cheerio.load(String(htmlText || ''));
    const byId = new Map();
    const year = provider.conference.year;
    $('li').each((_, el) => {
        const $li = $(el);
        const $link = $li.find(`a[href*="/paper_files/paper/${year}/hash/"]`).first();
        const href = cleanText($link.attr('href'));
        if (!href) return;
        let pathname;
        try {
            pathname = new URL(href, 'https://proceedings.neurips.cc').pathname;
        } catch (_) {
            return;
        }
        const m = /^\/paper_files\/paper\/(\d{4})\/hash\/([A-Za-z0-9]+)-Abstract-([A-Za-z0-9_]+)\.html$/.exec(pathname);
        if (!m || Number(m[1]) !== year) return;
        const hashId = m[2];
        const trackSlug = m[3];
        const title = cleanText($link.text());
        if (!title) return;
        const rawAuthorText = cleanText($li.find('i').first().text());
        const authors = rawAuthorText
            ? rawAuthorText.split(/\s*,\s*/).map(cleanText).filter(Boolean)
            : [];
        const recordUrl = `https://proceedings.neurips.cc${pathname}`;
        const pdfUrl = `https://proceedings.neurips.cc/paper_files/paper/${year}/file/${hashId}-Paper-${trackSlug}.pdf`;
        const track = trackSlug.includes('Datasets')
            ? `NeurIPS ${year} Datasets and Benchmarks`
            : `NeurIPS ${year} Conference`;
        if (!byId.has(hashId)) {
            byId.set(hashId, normalizePaperRecord({
                id: hashId,
                title,
                authors,
                abstract: '',
                doi: null,
                track,
                recordUrl,
                pdfUrl,
                pdfFile: `pdfs/${hashId}.pdf`
            }, byId.size));
        }
    });
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} 官方论文集 HTML 未解析出任何有效论文`);
    return { conference: { ...provider.conference }, papers };
}

/**
 * 解析并校验 IEEE / 官方本地 proceedings.json 离线清单（WASPAA / ASRU 等防爬虫会议）。
 */
function parseIeeeLocalManifest(manifestJson, provider) {
    const parsed = typeof manifestJson === 'string' ? JSON.parse(manifestJson) : manifestJson;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.papers)) {
        fail(`${provider.conference.id} 本地 proceedings.json 缺少 papers 数组`);
    }
    const byId = new Map();
    const seenPdfFiles = new Set();
    for (let idx = 0; idx < parsed.papers.length; idx += 1) {
        const item = parsed.papers[idx];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            fail(`${provider.conference.id} 清单第 ${idx + 1} 条不是合法对象`);
        }
        const rawArnumber = item.arnumber !== undefined && item.arnumber !== null ? String(item.arnumber).trim() : '';
        if (rawArnumber && !/^[1-9]\d*$/.test(rawArnumber)) {
            fail(`${provider.conference.id} 清单第 ${idx + 1} 条 arnumber 非法：${rawArnumber}`);
        }
        const rawId = cleanText(item.id || rawArnumber);
        const rawRecordUrl = item.recordUrl
            ? cleanText(item.recordUrl)
            : (rawArnumber ? `https://ieeexplore.ieee.org/document/${rawArnumber}` : '');
        if (!rawRecordUrl) {
            fail(`${provider.conference.id} 清单论文 ${rawId || idx + 1} 必须提供 arnumber 或规范的官方 recordUrl`);
        }
        const recordUrl = validateUrlForProvider(provider, rawRecordUrl, 'record');
        const rawPdfUrl = item.pdfUrl
            ? cleanText(item.pdfUrl)
            : (rawArnumber ? `https://ieeexplore.ieee.org/stamp/stamp.jsp?arnumber=${rawArnumber}` : null);
        if (!rawPdfUrl) {
            fail(`${provider.conference.id} 清单论文 ${rawId || idx + 1} 必须提供 arnumber 或规范的官方 pdfUrl`);
        }
        const pdfUrl = validateUrlForProvider(provider, rawPdfUrl, 'pdf');
        const rawPdfFile = cleanText(item.pdfFile || (rawId ? `pdfs/${rawId}.pdf` : ''));
        const normalizedPdfFile = rawPdfFile
            ? (rawPdfFile.startsWith('pdfs/') ? rawPdfFile : `pdfs/${rawPdfFile}`)
            : null;
        if (!normalizedPdfFile || !/^pdfs\/[A-Za-z0-9._-]+\.pdf$/i.test(normalizedPdfFile) || normalizedPdfFile.includes('..')) {
            fail(`${provider.conference.id} 清单中的 pdfFile 不合法：${rawPdfFile}`);
        }
        if (seenPdfFiles.has(normalizedPdfFile)) {
            fail(`${provider.conference.id} 清单存在重复的 pdfFile 绑定：${normalizedPdfFile}`);
        }
        seenPdfFiles.add(normalizedPdfFile);
        const normalized = normalizePaperRecord({
            id: rawId,
            title: item.title,
            authors: item.authors,
            abstract: item.abstract || '',
            doi: item.doi || null,
            track: item.track || provider.defaultTrack,
            recordUrl,
            pdfUrl,
            pdfFile: normalizedPdfFile
        }, idx);
        if (byId.has(normalized.id)) fail(`${provider.conference.id} 清单存在重复论文 ID：${normalized.id}`);
        byId.set(normalized.id, normalized);
    }
    const papers = [...byId.values()].sort((a, b) => compareCodePoints(a.id, b.id));
    if (papers.length === 0) fail(`${provider.conference.id} 本地 proceedings.json 不能为空`);
    return { conference: { ...provider.conference }, papers };
}

function safeDirectory(directory, label, create) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory) {
        fail(`${label} 必须是规范化的绝对路径`);
    }
    if (!fs.existsSync(directory)) {
        if (!create) fail(`${label} 不存在`);
        const parent = path.dirname(directory);
        safeDirectory(parent, `${label} parent`, false);
        fs.mkdirSync(directory, { mode: 0o700 });
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
        fail(`${label} 目录不安全或为符号链接`);
    }
    return directory;
}

function plannedRoot(outputRoot) {
    if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)
        || path.resolve(outputRoot) !== outputRoot || outputRoot === path.parse(outputRoot).root) {
        fail('outputRoot 必须是规范化的绝对非根路径');
    }
    let cursor = outputRoot;
    while (!fs.existsSync(cursor)) {
        const parent = path.dirname(cursor);
        if (parent === cursor) fail('outputRoot 没有可安全使用的已有祖先目录');
        cursor = parent;
    }
    safeDirectory(cursor, 'outputRoot existing ancestor', false);
    return outputRoot;
}

function acquisitionPaths(outputRoot, create = false) {
    const root = plannedRoot(outputRoot);
    if (create && !fs.existsSync(root)) {
        const missing = [];
        let cursor = root;
        while (!fs.existsSync(cursor)) {
            missing.push(cursor);
            cursor = path.dirname(cursor);
        }
        for (const dir of missing.reverse()) {
            fs.mkdirSync(dir, { mode: 0o700 });
            safeDirectory(dir, 'outputRoot', false);
        }
    }
    safeDirectory(root, 'outputRoot', false);
    const paths = {
        root,
        responses: path.join(root, 'responses'),
        pdfs: path.join(root, 'pdfs'),
        receipts: path.join(root, 'receipts'),
        metadataFile: path.join(root, 'metadata.json'),
        catalogReceiptFile: path.join(root, 'catalog.receipt.json')
    };
    for (const [dir, label] of [[paths.responses, 'responses'], [paths.pdfs, 'pdfs'], [paths.receipts, 'receipts']]) {
        if (create && !fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
        if (create || fs.existsSync(dir)) safeDirectory(dir, label, false);
    }
    return paths;
}

function readStableFile(filename, label, maxBytes, { requireMode0600 = true } = {}) {
    const parent = safeDirectory(path.dirname(filename), `${label} parent`, false);
    const absolute = path.resolve(filename);
    if (path.dirname(absolute) !== parent) fail(`${label} 路径超出其父目录`);
    let fd;
    try {
        fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const opened = fs.fstatSync(fd);
        const named = fs.lstatSync(absolute);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino
            || opened.size < 1 || opened.size > maxBytes) {
            fail(`${label} 文件不安全或超出字节范围`);
        }
        if (process.platform !== 'win32') {
            const mode = opened.mode & 0o777;
            if (requireMode0600 && mode !== 0o600) fail(`${label} 权限必须为 0600`);
            if (!requireMode0600 && (mode & 0o022) !== 0) fail(`${label} 不得对同组或其他用户可写`);
        }
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd);
        if (bytes.length !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size) {
            fail(`读取时 ${label} 发生变化`);
        }
        return { bytes, sha256: sha256(bytes), size: bytes.length };
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionExtendedError) throw error;
        fail(`无法读取 ${label}：${error.code || error.message}`);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

function rejectDuplicateJsonKeys(text, label) {
    const stack = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack.at(-1);
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) fail(`${label} 含重复键：${key}`);
            top.keys.add(key);
            top.expectKey = false;
        }
    }
}

function readCanonicalJson(filename, label, maxBytes, options = {}) {
    const loaded = readStableFile(filename, label, maxBytes, options);
    let text;
    let value;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(loaded.bytes);
        rejectDuplicateJsonKeys(text, label);
        value = JSON.parse(text);
    } catch (error) {
        if (error instanceof OfficialConferenceAcquisitionExtendedError) throw error;
        fail(`${label} 必须为合法的严格 UTF-8 JSON`);
    }
    return { ...loaded, value };
}

function resolveSafePdfPath(paths, paper) {
    const rel = String(paper?.pdfFile || '');
    if (!/^pdfs\/[A-Za-z0-9._-]+\.pdf$/i.test(rel) || rel.includes('..')) {
        fail(`论文 ${paper?.id || '(unknown)'} 的 pdfFile 路径不合法：${rel}`);
    }
    const full = path.resolve(paths.root, rel);
    if (path.dirname(full) !== paths.pdfs) {
        fail(`论文 ${paper?.id || '(unknown)'} 的 PDF 路径越界：${rel}`);
    }
    return full;
}

function resolveSafeResponsePath(paths, relFile) {
    if (typeof relFile !== 'string' || !/^responses\/(?:index\.html|index\.json|vol-\d{3}\.html|page-\d{3}\.json|proceedings\.json)$/.test(relFile)) {
        fail(`响应文件相对路径不合法：${relFile}`);
    }
    const full = path.resolve(paths.root, relFile);
    if (path.dirname(full) !== paths.responses) {
        fail(`响应文件路径越界：${relFile}`);
    }
    return full;
}

function rejectInterruptedTemporaryFiles(directories) {
    for (const dir of directories) {
        if (!fs.existsSync(dir)) continue;
        safeDirectory(dir, '抓取目录', false);
        for (const entry of fs.readdirSync(dir)) {
            if (TEMP_FILE_RE.test(entry)) {
                fail(`发现未完成写入的临时文件：${path.join(dir, entry)}`);
            }
        }
    }
}

function writeExclusiveOrCompare(filename, bytes, label, maxBytes) {
    const status = writeImmutableFile(filename, bytes, message => fail(`${label}：${message}`));
    const stored = readStableFile(filename, label, maxBytes, { requireMode0600: true });
    if (!stored.bytes.equals(Buffer.from(bytes))) {
        fail(`拒绝覆盖内容不同的 ${label}`);
    }
    return status;
}

function validateObservedAt(value, label) {
    if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value) || !Number.isFinite(Date.parse(value))) {
        fail(`${label} 必须是标准 UTC ISO 时间戳`);
    }
    return value;
}

function buildCatalogReceipt(provider, responseEntries, metadataBytes, papers) {
    const core = {
        contract: EXTENDED_CATALOG_RECEIPT_CONTRACT,
        providerId: provider.conference.id,
        conference: { ...provider.conference },
        parser: provider.parser,
        implementationSha256: implementationSha256(),
        responses: responseEntries,
        metadataFile: 'metadata.json',
        metadataSha256: sha256(metadataBytes),
        paperSetSha256: stableHash(papers)
    };
    return { ...core, receiptSha256: stableHash(core) };
}

function buildPdfReceipt(provider, paper, metadataSha256, {
    acquisitionMode,
    pdfBytes,
    requestedUrl,
    finalUrl,
    redirects = [],
    responseStatus = 200,
    observedAt
}) {
    const core = {
        contract: EXTENDED_PDF_RECEIPT_CONTRACT,
        acquisitionMode,
        providerId: provider.conference.id,
        metadataSha256,
        paperId: paper.id,
        pdfFile: paper.pdfFile,
        pdfBytes: pdfBytes.length,
        pdfSha256: sha256(pdfBytes),
        requestedUrl,
        finalUrl,
        redirects,
        responseStatus,
        observedAt
    };
    return { ...core, receiptSha256: stableHash(core) };
}

const SINGLE_HTML_PARSERS = Object.freeze({
    'acl-anthology-html': parseEmnlpCatalogHtml,
    'neurips-proceedings-html': parseNeuripsProceedingsHtml,
    'dcase-proceedings-html': parseDcaseProceedingsHtml,
    'isca-html': parseIscaCatalogHtml,
    'pmlr-html': parsePmlrCatalogHtml,
    'cvf-html': parseCvfCatalogHtml,
    'ijcai-html': parseIjcaiCatalogHtml
});

async function acquireCatalog({ providerId, outputRoot, apply = false } = {}, dependencies = {}) {
    const provider = providerFor(providerId);
    plannedRoot(outputRoot);
    const hasMultiVolumes = provider.parser === 'acl-anthology-html'
        && Array.isArray(provider.indexUrls)
        && provider.indexUrls.length > 0;
    if (!apply) {
        return {
            command: 'catalog',
            mode: 'dry-run',
            providerId: provider.conference.id,
            parser: provider.parser,
            indexUrl: provider.indexUrl,
            ...(hasMultiVolumes ? { indexUrls: [...provider.indexUrls] } : {}),
            outputRoot
        };
    }
    const paths = acquisitionPaths(outputRoot, true);
    recoverImmutableFileLink(paths.metadataFile, fail, MAX_INDEX_BYTES);
    recoverImmutableFileLink(paths.catalogReceiptFile, fail, MAX_RECEIPT_BYTES);
    rejectInterruptedTemporaryFiles([paths.root, paths.responses]);

    const responseEntries = [];
    let metadata;

    if (hasMultiVolumes) {
        const htmlList = [];
        for (let idx = 0; idx < provider.indexUrls.length; idx += 1) {
            const volUrl = provider.indexUrls[idx];
            const fetched = await fetchOfficialExtended({
                provider, url: volUrl, kind: 'index', maxBytes: MAX_INDEX_BYTES
            }, dependencies);
            const rel = `responses/vol-${String(idx + 1).padStart(3, '0')}.html`;
            writeExclusiveOrCompare(path.join(paths.root, rel), fetched.bytes, `${providerId} volume ${idx + 1} HTML`, MAX_INDEX_BYTES);
            responseEntries.push({
                file: rel,
                sha256: sha256(fetched.bytes),
                bytes: fetched.bytes.length,
                requestedUrl: fetched.requestedUrl,
                finalUrl: fetched.finalUrl,
                redirects: fetched.redirects,
                responseStatus: fetched.responseStatus,
                observedAt: fetched.observedAt
            });
            htmlList.push(new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes));
        }
        metadata = parseEmnlpCatalogHtml(htmlList, provider);
    } else if (Object.prototype.hasOwnProperty.call(SINGLE_HTML_PARSERS, provider.parser)) {
        const fetched = await fetchOfficialExtended({
            provider, url: provider.indexUrl, kind: 'index', maxBytes: MAX_INDEX_BYTES
        }, dependencies);
        const rel = 'responses/index.html';
        writeExclusiveOrCompare(path.join(paths.root, rel), fetched.bytes, `${providerId} index HTML`, MAX_INDEX_BYTES);
        responseEntries.push({
            file: rel,
            sha256: sha256(fetched.bytes),
            bytes: fetched.bytes.length,
            requestedUrl: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            redirects: fetched.redirects,
            responseStatus: fetched.responseStatus,
            observedAt: fetched.observedAt
        });
        const htmlText = new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes);
        metadata = SINGLE_HTML_PARSERS[provider.parser](htmlText, provider);
    } else if (provider.parser === 'eccv-virtual-json') {
        const fetched = await fetchOfficialExtended({
            provider, url: provider.indexUrl, kind: 'json-index', maxBytes: MAX_INDEX_BYTES
        }, dependencies);
        const rel = 'responses/index.json';
        const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes);
        rejectDuplicateJsonKeys(jsonText, `${providerId} index.json`);
        const parsedJson = JSON.parse(jsonText);
        writeExclusiveOrCompare(path.join(paths.root, rel), fetched.bytes, `${providerId} index JSON`, MAX_INDEX_BYTES);
        responseEntries.push({
            file: rel,
            sha256: sha256(fetched.bytes),
            bytes: fetched.bytes.length,
            requestedUrl: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            redirects: fetched.redirects,
            responseStatus: fetched.responseStatus,
            observedAt: fetched.observedAt
        });
        metadata = parseEccvVirtualJson(parsedJson, provider);
    } else if (provider.parser === 'zenodo-json') {
        const pages = [];
        const seenUrls = new Set();
        let nextUrl = provider.indexUrl;
        for (let pageNo = 1; pageNo <= MAX_JSON_PAGES && nextUrl; pageNo += 1) {
            const validatedUrl = validateUrlForProvider(provider, nextUrl, 'api');
            if (seenUrls.has(validatedUrl)) fail(`${providerId} Zenodo 分页出现循环 URL：${validatedUrl}`);
            seenUrls.add(validatedUrl);
            const fetched = await fetchOfficialExtended({
                provider, url: validatedUrl, kind: 'api', maxBytes: MAX_INDEX_BYTES
            }, dependencies);
            const rel = `responses/page-${String(pageNo).padStart(3, '0')}.json`;
            const pageText = new TextDecoder('utf-8', { fatal: true }).decode(fetched.bytes);
            rejectDuplicateJsonKeys(pageText, `${providerId} Zenodo page ${pageNo}`);
            const parsedPage = JSON.parse(pageText);
            writeExclusiveOrCompare(path.join(paths.root, rel), fetched.bytes, `${providerId} Zenodo page ${pageNo}`, MAX_INDEX_BYTES);
            pages.push(parsedPage);
            responseEntries.push({
                file: rel,
                sha256: sha256(fetched.bytes),
                bytes: fetched.bytes.length,
                requestedUrl: fetched.requestedUrl,
                finalUrl: fetched.finalUrl,
                redirects: fetched.redirects,
                responseStatus: fetched.responseStatus,
                observedAt: fetched.observedAt
            });
            if (shouldStopZenodoPagination(parsedPage, provider)) {
                nextUrl = null;
            } else {
                const rawNext = parsedPage?.links?.next;
                nextUrl = typeof rawNext === 'string' && rawNext.trim() ? rawNext.trim() : null;
            }
        }
        if (nextUrl) {
            fail(`${providerId} Zenodo 分页超过上限 ${MAX_JSON_PAGES} 页，拒绝封存不完整目录`);
        }
        metadata = parseZenodoRecordsPages(pages, provider);
    } else if (provider.parser === 'ieee-local-manifest') {
        const localFile = path.join(paths.responses, 'proceedings.json');
        if (!fs.existsSync(localFile)) {
            fail(`${providerId} 需要先放置官方 proceedings.json 至 ${localFile}`);
        }
        const loaded = readCanonicalJson(localFile, `${providerId} proceedings.json`, MAX_INDEX_BYTES, { requireMode0600: false });
        responseEntries.push({
            file: 'responses/proceedings.json',
            sha256: loaded.sha256,
            bytes: loaded.size,
            requestedUrl: provider.indexUrl,
            finalUrl: provider.indexUrl,
            redirects: [],
            responseStatus: 200,
            observedAt: (dependencies.now || (() => new Date().toISOString()))()
        });
        metadata = parseIeeeLocalManifest(loaded.value, provider);
    } else {
        fail(`不支持的扩展解析器类型：${provider.parser}`);
    }

    const metadataBytes = prettyBytes(metadata);
    writeExclusiveOrCompare(paths.metadataFile, metadataBytes, `${providerId} metadata.json`, MAX_INDEX_BYTES);
    const receipt = buildCatalogReceipt(provider, responseEntries, metadataBytes, metadata.papers);
    writeExclusiveOrCompare(paths.catalogReceiptFile, prettyBytes(receipt), `${providerId} catalog.receipt.json`, MAX_RECEIPT_BYTES);
    replayCatalog(provider.conference.id, outputRoot);
    return {
        command: 'catalog',
        mode: 'apply',
        providerId: provider.conference.id,
        outputRoot,
        papers: metadata.papers.length,
        metadataSha256: sha256(metadataBytes),
        catalogReceiptSha256: receipt.receiptSha256
    };
}

function validateResponseEntry(provider, entry, index, paths) {
    exact(entry, ['bytes', 'file', 'finalUrl', 'observedAt', 'redirects', 'requestedUrl', 'responseStatus', 'sha256'], `responses[${index}]`);
    const full = resolveSafeResponsePath(paths, entry.file);
    if (!SHA_RE.test(entry.sha256 || '') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
        fail(`responses[${index}] 字节数或 SHA 格式无效`);
    }
    if (entry.responseStatus !== 200) fail(`responses[${index}] responseStatus 必须为 200`);
    validateObservedAt(entry.observedAt, `responses[${index}].observedAt`);
    if (!Array.isArray(entry.redirects) || entry.redirects.length > MAX_REDIRECTS) {
        fail(`responses[${index}].redirects 非法`);
    }
    const kind = provider.parser === 'zenodo-json'
        ? 'api'
        : provider.parser === 'eccv-virtual-json'
            ? 'json-index'
            : 'index';
    validateRedirectChain(provider, entry.requestedUrl, entry.finalUrl, entry.redirects, kind, `responses[${index}]`);
    const requireMode0600 = provider.parser !== 'ieee-local-manifest';
    const loaded = readStableFile(full, entry.file, MAX_INDEX_BYTES, { requireMode0600 });
    if (loaded.sha256 !== entry.sha256 || loaded.size !== entry.bytes) {
        fail(`${provider.conference.id} 原始响应文件 SHA 或长度不一致：${entry.file}`);
    }
    return { entry, bytes: loaded.bytes };
}

function replayCatalog(providerId, outputRoot) {
    const provider = providerFor(providerId);
    const paths = acquisitionPaths(outputRoot, false);
    if (!fs.existsSync(paths.catalogReceiptFile) || !fs.existsSync(paths.metadataFile)) {
        fail(`${providerId} 缺少 catalog.receipt.json 或 metadata.json`);
    }
    const receiptLoaded = readCanonicalJson(paths.catalogReceiptFile, `${providerId} catalog.receipt.json`, MAX_RECEIPT_BYTES);
    const receipt = receiptLoaded.value;
    exact(receipt, [
        'conference', 'contract', 'implementationSha256', 'metadataFile',
        'metadataSha256', 'paperSetSha256', 'parser', 'providerId', 'receiptSha256', 'responses'
    ], `${providerId} catalog.receipt.json`);
    const acceptedCatalogContracts = new Set([
        EXTENDED_CATALOG_RECEIPT_CONTRACT,
        'official-conference-catalog-receipt-v2'
    ]);
    if (!acceptedCatalogContracts.has(receipt.contract)
        || receipt.providerId !== provider.conference.id
        || receipt.parser !== provider.parser
        || receipt.metadataFile !== 'metadata.json'
        || receipt.conference?.id !== provider.conference.id
        || receipt.conference?.year !== provider.conference.year
        || !SHA_RE.test(receipt.implementationSha256 || '')
        || !SHA_RE.test(receipt.metadataSha256 || '')
        || !SHA_RE.test(receipt.paperSetSha256 || '')) {
        fail(`${providerId} catalog.receipt.json 契约或会议身份不匹配`);
    }
    const { receiptSha256, ...core } = receipt;
    if (!SHA_RE.test(receiptSha256 || '') || stableHash(core) !== receiptSha256) {
        fail(`${providerId} catalog.receipt.json 摘要校验失败`);
    }
    if (!receiptLoaded.bytes.equals(prettyBytes(receipt))) {
        fail(`${providerId} catalog.receipt.json 不是规范 JSON 字节`);
    }
    if (!Array.isArray(receipt.responses) || receipt.responses.length === 0) {
        fail(`${providerId} catalog.receipt.json 必须至少包含一条原始响应记录`);
    }
    const rawResponses = receipt.responses.map((entry, idx) => validateResponseEntry(provider, entry, idx, paths));
    const expectedFiles = new Set(receipt.responses.map(e => path.basename(e.file)));
    if (expectedFiles.size !== receipt.responses.length) {
        fail(`${providerId} catalog.receipt.json 包含重复响应文件路径`);
    }

    const hasMultiVolumes = provider.parser === 'acl-anthology-html'
        && Array.isArray(provider.indexUrls)
        && provider.indexUrls.length > 0;
    let replayedMetadata;
    if (hasMultiVolumes) {
        if (rawResponses.length !== provider.indexUrls.length) {
            fail(`${providerId} 多卷 HTML 目录必须绑定全部 ${provider.indexUrls.length} 个官方卷响应`);
        }
        const htmlList = [];
        for (let idx = 0; idx < provider.indexUrls.length; idx += 1) {
            const expectedFile = `responses/vol-${String(idx + 1).padStart(3, '0')}.html`;
            const expectedUrl = provider.indexUrls[idx];
            if (rawResponses[idx].entry.file !== expectedFile
                || rawResponses[idx].entry.requestedUrl !== expectedUrl
                || !isAllowedIndexRedirectTarget(expectedUrl, rawResponses[idx].entry.finalUrl)) {
                fail(`${providerId} 第 ${idx + 1} 卷响应文件或 URL 不匹配：期望 ${expectedFile}`);
            }
            htmlList.push(new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[idx].bytes));
        }
        replayedMetadata = parseEmnlpCatalogHtml(htmlList, provider);
    } else if (Object.prototype.hasOwnProperty.call(SINGLE_HTML_PARSERS, provider.parser)) {
        if (rawResponses.length !== 1 || rawResponses[0].entry.file !== 'responses/index.html'
            || rawResponses[0].entry.requestedUrl !== provider.indexUrl
            || !isAllowedIndexRedirectTarget(provider.indexUrl, rawResponses[0].entry.finalUrl)) {
            fail(`${providerId} HTML 目录必须绑定唯一的 responses/index.html`);
        }
        const htmlText = new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[0].bytes);
        replayedMetadata = SINGLE_HTML_PARSERS[provider.parser](htmlText, provider);
    } else if (provider.parser === 'eccv-virtual-json') {
        if (rawResponses.length !== 1 || rawResponses[0].entry.file !== 'responses/index.json'
            || rawResponses[0].entry.requestedUrl !== provider.indexUrl) {
            fail(`${providerId} JSON 目录必须绑定唯一的 responses/index.json`);
        }
        const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[0].bytes);
        rejectDuplicateJsonKeys(jsonText, `${providerId} index.json`);
        replayedMetadata = parseEccvVirtualJson(JSON.parse(jsonText), provider);
    } else if (provider.parser === 'zenodo-json') {
        if (rawResponses.length > MAX_JSON_PAGES) {
            fail(`${providerId} Zenodo 分页数量超过上限 ${MAX_JSON_PAGES}`);
        }
        if (rawResponses[0].entry.requestedUrl !== provider.indexUrl) {
            fail(`${providerId} Zenodo 第 1 页必须始于固定入口 URL`);
        }
        const parsedPages = [];
        const seenReplayUrls = new Set();
        for (let idx = 0; idx < rawResponses.length; idx += 1) {
            const expectedName = `responses/page-${String(idx + 1).padStart(3, '0')}.json`;
            if (rawResponses[idx].entry.file !== expectedName) {
                fail(`${providerId} Zenodo 分页文件命名不连续：期望 ${expectedName}`);
            }
            if (seenReplayUrls.has(rawResponses[idx].entry.requestedUrl)) {
                fail(`${providerId} Zenodo 分页重放检测到循环 URL：${rawResponses[idx].entry.requestedUrl}`);
            }
            seenReplayUrls.add(rawResponses[idx].entry.requestedUrl);
            const pageText = new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[idx].bytes);
            rejectDuplicateJsonKeys(pageText, `${providerId} ${expectedName}`);
            const page = JSON.parse(pageText);
            parsedPages.push(page);
            const nextLink = typeof page?.links?.next === 'string' && page.links.next.trim()
                ? page.links.next.trim()
                : null;
            const stopHere = shouldStopZenodoPagination(page, provider);
            if (idx < rawResponses.length - 1) {
                if (stopHere) {
                    fail(`${providerId} Zenodo 第 ${idx + 1} 页已触发早停条件，不应包含多余分页`);
                }
                if (!nextLink || rawResponses[idx + 1].entry.requestedUrl !== nextLink) {
                    fail(`${providerId} Zenodo 第 ${idx + 1} 页与第 ${idx + 2} 页分页链不匹配`);
                }
            } else if (nextLink && !stopHere) {
                fail(`${providerId} Zenodo 末页仍包含未抓取的 links.next，目录不完整`);
            }
        }
        replayedMetadata = parseZenodoRecordsPages(parsedPages, provider);
    } else if (provider.parser === 'ieee-local-manifest') {
        if (rawResponses.length !== 1 || rawResponses[0].entry.file !== 'responses/proceedings.json') {
            fail(`${providerId} 本地清单必须绑定唯一的 responses/proceedings.json`);
        }
        const text = new TextDecoder('utf-8', { fatal: true }).decode(rawResponses[0].bytes);
        rejectDuplicateJsonKeys(text, `${providerId} proceedings.json`);
        replayedMetadata = parseIeeeLocalManifest(JSON.parse(text), provider);
    } else {
        fail(`不支持的扩展解析器：${provider.parser}`);
    }

    const storedMetadataLoaded = readCanonicalJson(paths.metadataFile, `${providerId} metadata.json`, MAX_INDEX_BYTES);
    if (storedMetadataLoaded.sha256 !== receipt.metadataSha256) {
        fail(`${providerId} metadata.json SHA 与 catalog.receipt.json 不一致`);
    }
    const expectedMetadataBytes = prettyBytes(replayedMetadata);
    if (!storedMetadataLoaded.bytes.equals(expectedMetadataBytes)) {
        fail(`${providerId} 重放解析结果与已保存 metadata.json 字节不一致`);
    }
    if (stableHash(replayedMetadata.papers) !== receipt.paperSetSha256) {
        fail(`${providerId} paperSetSha256 与重放论文集合不一致`);
    }
    return {
        provider,
        paths,
        receipt,
        metadata: storedMetadataLoaded.value,
        metadataSha256: receipt.metadataSha256
    };
}

function replayPdfReceipt(replayed, paper) {
    const pdfPath = resolveSafePdfPath(replayed.paths, paper);
    const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
    if (!fs.existsSync(pdfPath) || !fs.existsSync(receiptPath)) {
        fail(`论文 ${paper.id} 缺少 PDF 文件或 PDF receipt`);
    }
    const requireMode0600 = replayed.provider.parser !== 'ieee-local-manifest';
    const pdfLoaded = readStableFile(pdfPath, `${paper.id} PDF`, MAX_PDF_BYTES, { requireMode0600 });
    if (pdfLoaded.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
        fail(`论文 ${paper.id} 的 PDF 缺少 %PDF- 文件头`);
    }
    const receiptLoaded = readCanonicalJson(receiptPath, `${paper.id} PDF receipt`, MAX_RECEIPT_BYTES);
    const receipt = receiptLoaded.value;
    exact(receipt, [
        'acquisitionMode', 'contract', 'finalUrl', 'metadataSha256', 'observedAt',
        'paperId', 'pdfBytes', 'pdfFile', 'pdfSha256', 'providerId',
        'receiptSha256', 'redirects', 'requestedUrl', 'responseStatus'
    ], `${paper.id} PDF receipt`);
    const expectedMode = replayed.provider.parser === 'ieee-local-manifest' ? 'local-sealed-pdf' : 'official-http-pdf';
    const acceptedPdfContracts = new Set([
        EXTENDED_PDF_RECEIPT_CONTRACT,
        'official-conference-pdf-receipt-v2'
    ]);
    if (!acceptedPdfContracts.has(receipt.contract)
        || receipt.acquisitionMode !== expectedMode
        || receipt.providerId !== replayed.provider.conference.id
        || receipt.metadataSha256 !== replayed.metadataSha256
        || receipt.paperId !== paper.id
        || receipt.pdfFile !== paper.pdfFile
        || receipt.pdfBytes !== pdfLoaded.size
        || receipt.pdfSha256 !== pdfLoaded.sha256
        || receipt.requestedUrl !== paper.pdfUrl
        || receipt.responseStatus !== 200
        || !Array.isArray(receipt.redirects)
        || receipt.redirects.length > MAX_REDIRECTS) {
        fail(`论文 ${paper.id} PDF receipt 身份、会议、元数据或 PDF 绑定不匹配`);
    }
    validateObservedAt(receipt.observedAt, `${paper.id} PDF receipt observedAt`);
    if (expectedMode === 'official-http-pdf') {
        validateRedirectChain(replayed.provider, receipt.requestedUrl, receipt.finalUrl, receipt.redirects, 'pdf', `${paper.id} PDF receipt`);
    } else {
        validateUrlForProvider(replayed.provider, receipt.requestedUrl, 'pdf');
        if (receipt.finalUrl !== paper.pdfUrl || receipt.redirects.length !== 0) {
            fail(`论文 ${paper.id} 本地 PDF receipt 的 URL 或 redirects 异常`);
        }
    }
    const { receiptSha256, ...core } = receipt;
    if (!SHA_RE.test(receiptSha256 || '') || stableHash(core) !== receiptSha256) {
        fail(`论文 ${paper.id} PDF receipt 摘要校验失败`);
    }
    if (!receiptLoaded.bytes.equals(prettyBytes(receipt))) {
        fail(`论文 ${paper.id} PDF receipt 不是规范 JSON 字节`);
    }
    return receipt;
}

async function downloadPapers(
    { providerId, outputRoot, apply = false, limit = null, concurrency = 1, retries = 0 } = {},
    dependencies = {}
) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) fail('limit 必须是正整数');
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 5) fail('concurrency 必须是 1 到 5 的整数');
    if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) fail('retries 必须是 0 到 5 的整数');
    const replayed = replayCatalog(providerId, outputRoot);
    const downloadable = replayed.metadata.papers.filter(p => p.pdfUrl !== null && p.pdfFile !== null);
    if (apply) {
        for (const paper of downloadable) {
            recoverImmutableFileLink(resolveSafePdfPath(replayed.paths, paper), fail, MAX_PDF_BYTES);
            recoverImmutableFileLink(path.join(replayed.paths.receipts, `${paper.id}.json`), fail, MAX_RECEIPT_BYTES);
        }
        rejectInterruptedTemporaryFiles([replayed.paths.pdfs, replayed.paths.receipts]);
    }
    const before = acquisitionStatus({ providerId, outputRoot });
    if (!apply) {
        return {
            command: 'download',
            mode: 'dry-run',
            providerId,
            outputRoot,
            total: downloadable.length,
            downloaded: before.pdfVerified,
            pending: before.missingCount,
            limit,
            concurrency,
            retries
        };
    }

    let created = 0;
    let reused = 0;
    let attempted = 0;
    let cursor = 0;
    let firstError = null;
    const sleep = dependencies.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));

    async function processPaper(paper) {
        const pdfPath = resolveSafePdfPath(replayed.paths, paper);
        const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
        const hasPdf = fs.existsSync(pdfPath);
        const hasReceipt = fs.existsSync(receiptPath);
        if (hasReceipt && !hasPdf) {
            fail(`${paper.id} 的 receipt 存在，却缺少对应 PDF`);
        }
        if (hasPdf && hasReceipt) {
            replayPdfReceipt(replayed, paper);
            reused += 1;
            return;
        }
        if (limit !== null && attempted >= limit) return;
        attempted += 1;

        if (replayed.provider.parser === 'ieee-local-manifest') {
            if (!hasPdf) {
                fail(`${providerId} 为本地清单模式，请先放置官方 PDF 至 ${pdfPath}`);
            }
            const loadedPdf = readStableFile(pdfPath, `${paper.id} local PDF`, MAX_PDF_BYTES, { requireMode0600: false });
            if (loadedPdf.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
                fail(`论文 ${paper.id} 的本地 PDF 缺少 %PDF- 文件头`);
            }
            const receipt = buildPdfReceipt(replayed.provider, paper, replayed.metadataSha256, {
                acquisitionMode: 'local-sealed-pdf',
                pdfBytes: loadedPdf.bytes,
                requestedUrl: paper.pdfUrl,
                finalUrl: paper.pdfUrl,
                redirects: [],
                responseStatus: 200,
                observedAt: (dependencies.now || (() => new Date().toISOString()))()
            });
            writeExclusiveOrCompare(receiptPath, prettyBytes(receipt), `${paper.id} PDF receipt`, MAX_RECEIPT_BYTES);
            replayPdfReceipt(replayed, paper);
            created += 1;
            return;
        }

        let fetched;
        for (let attempt = 0; ; attempt += 1) {
            try {
                fetched = await fetchOfficialExtended({
                    provider: replayed.provider,
                    url: paper.pdfUrl,
                    kind: 'pdf',
                    maxBytes: MAX_PDF_BYTES
                }, dependencies);
                break;
            } catch (error) {
                const transient = /request failed|request timed out|HTTP (?:429|5\d\d)/u.test(String(error?.message || ''));
                if (!transient || attempt >= retries) throw error;
                await sleep(Math.min(8000, 500 * (2 ** attempt)));
            }
        }
        const pdfStatus = writeExclusiveOrCompare(pdfPath, fetched.bytes, `${paper.id} PDF`, MAX_PDF_BYTES);
        const receipt = buildPdfReceipt(replayed.provider, paper, replayed.metadataSha256, {
            acquisitionMode: 'official-http-pdf',
            pdfBytes: fetched.bytes,
            requestedUrl: fetched.requestedUrl,
            finalUrl: fetched.finalUrl,
            redirects: fetched.redirects,
            responseStatus: fetched.responseStatus,
            observedAt: fetched.observedAt
        });
        writeExclusiveOrCompare(receiptPath, prettyBytes(receipt), `${paper.id} PDF receipt`, MAX_RECEIPT_BYTES);
        replayPdfReceipt(replayed, paper);
        if (pdfStatus === 'created') created += 1;
        else reused += 1;
    }

    async function worker() {
        while (!firstError && cursor < downloadable.length) {
            const paper = downloadable[cursor];
            cursor += 1;
            try {
                await processPaper(paper);
            } catch (error) {
                firstError ||= error;
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    if (firstError) throw firstError;
    const after = acquisitionStatus({ providerId, outputRoot });
    return {
        command: 'download',
        mode: 'apply',
        providerId,
        outputRoot,
        downloaded: created,
        reused,
        total: downloadable.length,
        verified: after.pdfVerified,
        missing: after.missingCount,
        complete: after.complete,
        concurrency,
        retries
    };
}

function acquisitionStatus({ providerId, outputRoot }) {
    const provider = providerFor(providerId);
    plannedRoot(outputRoot);
    if (!fs.existsSync(outputRoot)) {
        return {
            command: 'status',
            providerId: provider.conference.id,
            outputRoot,
            catalog: 'missing',
            papers: 0,
            pdfExpected: 0,
            pdfVerified: 0,
            partialCount: 0,
            missingCount: 0,
            complete: false
        };
    }
    const replayed = replayCatalog(providerId, outputRoot);
    const withPdf = replayed.metadata.papers.filter(p => p.pdfUrl !== null && p.pdfFile !== null);
    let verifiedPdfs = 0;
    let partialCount = 0;
    const missing = [];
    for (const paper of withPdf) {
        const pdfPath = resolveSafePdfPath(replayed.paths, paper);
        const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
        const hasPdf = fs.existsSync(pdfPath);
        const hasReceipt = fs.existsSync(receiptPath);
        if (hasPdf && hasReceipt) {
            replayPdfReceipt(replayed, paper);
            verifiedPdfs += 1;
        } else if (hasPdf || hasReceipt) {
            partialCount += 1;
        } else {
            missing.push(paper.id);
        }
    }
    return {
        command: 'status',
        providerId,
        outputRoot,
        catalog: 'complete',
        papers: replayed.metadata.papers.length,
        pdfExpected: withPdf.length,
        pdfVerified: verifiedPdfs,
        partialCount,
        missingCount: missing.length,
        complete: missing.length === 0 && partialCount === 0
    };
}

function verifyAcquisition({ providerId, outputRoot }) {
    const replayed = replayCatalog(providerId, outputRoot);
    rejectInterruptedTemporaryFiles([
        replayed.paths.root,
        replayed.paths.responses,
        replayed.paths.pdfs,
        replayed.paths.receipts
    ]);
    const expectedResponses = new Set(replayed.receipt.responses.map(e => path.basename(e.file)));
    for (const entry of fs.readdirSync(replayed.paths.responses, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink() || !expectedResponses.has(entry.name)) {
            fail(`发现不允许的响应目录文件或子目录：${path.join(replayed.paths.responses, entry.name)}`);
        }
    }
    const expectedPdfs = new Set();
    const expectedReceipts = new Set();
    let verified = 0;
    const missing = [];
    for (const paper of replayed.metadata.papers.filter(p => p.pdfUrl !== null && p.pdfFile !== null)) {
        const pdfPath = resolveSafePdfPath(replayed.paths, paper);
        const receiptPath = path.join(replayed.paths.receipts, `${paper.id}.json`);
        expectedPdfs.add(path.basename(pdfPath));
        expectedReceipts.add(path.basename(receiptPath));
        const hasPdf = fs.existsSync(pdfPath);
        const hasReceipt = fs.existsSync(receiptPath);
        if (!hasPdf && !hasReceipt) {
            missing.push(paper.id);
            continue;
        }
        if (!hasPdf || !hasReceipt) {
            fail(`${paper.id} 的 PDF 与 receipt 只存在一半`);
        }
        replayPdfReceipt(replayed, paper);
        verified += 1;
    }
    for (const [dir, expected, label] of [
        [replayed.paths.pdfs, expectedPdfs, 'PDF'],
        [replayed.paths.receipts, expectedReceipts, 'receipt']
    ]) {
        if (!fs.existsSync(dir)) continue;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile() || entry.isSymbolicLink() || !expected.has(entry.name)) {
                fail(`发现不允许的 ${label} 文件或目录：${path.join(dir, entry.name)}`);
            }
        }
    }
    return {
        command: 'verify',
        providerId,
        outputRoot,
        metadataSha256: replayed.metadataSha256,
        catalogReceiptSha256: replayed.receipt.receiptSha256,
        papers: replayed.metadata.papers.length,
        pdfExpected: expectedPdfs.size,
        pdfVerified: verified,
        missing,
        missingCount: missing.length,
        complete: missing.length === 0
    };
}

module.exports = {
    OfficialConferenceAcquisitionExtendedError,
    PAPER_FIELDS,
    EXTENDED_CATALOG_RECEIPT_CONTRACT,
    EXTENDED_PDF_RECEIPT_CONTRACT,
    MAX_INDEX_BYTES,
    MAX_PDF_BYTES,
    EXTENDED_PROVIDERS,
    hasProvider,
    providerFor,
    listProviderIds,
    validateUrlForProvider,
    fetchOfficialExtended,
    shouldStopZenodoPagination,
    parseEmnlpCatalogHtml,
    parseDcaseProceedingsHtml,
    parseZenodoRecordsPages,
    parseIscaCatalogHtml,
    parsePmlrCatalogHtml,
    parseEccvVirtualJson,
    parseCvfCatalogHtml,
    parseIjcaiCatalogHtml,
    parseNeuripsProceedingsHtml,
    parseIeeeLocalManifest,
    acquireCatalog,
    downloadPapers,
    acquisitionStatus,
    verifyAcquisition,
    replayCatalog,
    replayPdfReceipt,
    sha256,
    stableHash
};
