'use strict';

const crypto = require('node:crypto');

const SOURCE_URL_NORMALIZATION_CONTRACT = 'paper-source-repository-url-normalization-v1';
const SUPPORTED_REPOSITORY_HOSTS = new Set([
    'github.com', 'gitlab.com', 'huggingface.co', 'modelscope.cn'
]);
const sha256 = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

const RESOURCE_FACET_SPECS = Object.freeze([
    ['code', /\b(?:source\s+code|code|implementation|software|repository|repo)\b|源代码|代码|实现|仓库/i],
    ['model', /\b(?:model(?:\s+weights?)?|weights?|checkpoints?)\b|模型(?:权重)?|权重|检查点/i],
    ['dataset', /\b(?:data|datasets?|corpus|corpora|benchmarks?)\b|数据集|数据|语料库|基准/i],
    ['demo', /\b(?:demo|demonstration)\b|在线演示|项目演示/i],
    ['reproduction', /\b(?:artifacts?|reproducibility|reproduction(?:\s+materials?)?)\b|复现材料|工件/i]
]);
const RESOURCE_AFFIRMATIVE = /\b(?:available|released|published|public|open[- ]source(?:d)?)\b|\b(?:we|authors?)\s+(?:release|provide)|(?:已|现已|公开|开源|发布|提供|可获取|可用)/i;
const GENERIC_FIRST_PARTY_RESOURCE = /\b(?:resources?|materials?)\s+(?:for|from)\s+(?:this|our|the)\s+(?:study|work|paper|project)\s+(?:are|is)\s+(?:publicly\s+)?available\b|\b(?:we|the\s+authors?)\s+(?:release|provide)\s+(?:the\s+)?(?:resources?|materials?)\b/i;
const ATTACHED_FOOTNOTE_RESOURCE_LABEL = /\b\d{1,3}(?=(?:source\s+code|code|implementation|software|repository|repo|model(?:\s+weights?)?|weights?|checkpoints?|data|datasets?|corpus|corpora|demo|demonstration|artifacts?|reproducibility|reproduction)\b)/gi;

function foldRepositoryTokenLineBreaks(value) {
    const token = String(value || '').trim();
    if (!token || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(token)
        || /\r?\n[ \t]*\r?\n/u.test(token)) return null;
    const breaks = [...token.matchAll(/\r?\n[ \t]*/g)];
    if (breaks.length > 3) return null;
    for (const match of breaks) {
        const previous = token[match.index - 1] || '';
        const next = token[match.index + match[0].length] || '';
        // PDF extraction may wrap immediately beside a URL delimiter.  An
        // alphanumeric-to-alphanumeric join is indistinguishable from joining
        // unrelated prose, so it deliberately remains unsupported.
        if (!(previous === '/' || next === '/' || /[._~-]/.test(previous) || /[._~-]/.test(next))) {
            return null;
        }
    }
    const folded = token.replace(/\r?\n[ \t]*/g, '');
    return /\s/u.test(folded) ? null : folded;
}

function normalizePaperSourceRepositoryToken(value) {
    const token = foldRepositoryTokenLineBreaks(value);
    if (!token) return null;
    let parsed;
    try {
        parsed = new URL(/^https:\/\//i.test(token) ? token : `https://${token}`);
    } catch (_) {
        return null;
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || parsed.hash || parsed.search || !SUPPORTED_REPOSITORY_HOSTS.has(parsed.hostname.toLowerCase())) {
        return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 2 || segments.some(segment => !/^[A-Za-z0-9._~-]+$/.test(segment)
        || segment === '.' || segment === '..')) return null;
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = `/${segments.join('/')}`;
    return parsed.toString().replace(/\/$/, '');
}

function classifyPaperSourceResourceFacets(sourceQuote) {
    const quote = String(sourceQuote || '').replace(/\bavail-\s*able\b/gi, 'available')
        .replace(/\s+/g, ' ').trim()
        .replace(ATTACHED_FOOTNOTE_RESOURCE_LABEL, '');
    if (!quote || !RESOURCE_AFFIRMATIVE.test(quote)) return ['third_party'];
    const facets = RESOURCE_FACET_SPECS
        .filter(([, pattern]) => pattern.test(quote))
        .map(([type]) => type);
    if (facets.length) return facets;
    return GENERIC_FIRST_PARTY_RESOURCE.test(quote) ? ['reproduction'] : ['third_party'];
}

function repositorySourceQuote(sourceText, start, end, maxChars = 1200) {
    const source = String(sourceText || '');
    const paragraphStart = source.lastIndexOf('\n\n', start - 1);
    const paragraphEnd = source.indexOf('\n\n', end);
    let lower = paragraphStart < 0 ? 0 : paragraphStart + 2;
    let upper = paragraphEnd < 0 ? source.length : paragraphEnd;
    lower = Math.max(lower, start - Math.floor(maxChars / 2));
    upper = Math.min(upper, end + Math.floor(maxChars / 2));
    return source.slice(lower, upper).trim();
}

function repositoryClassificationQuote(sourceText, start, end) {
    const source = String(sourceText || '');
    const before = source.slice(Math.max(0, start - 600), start);
    const after = source.slice(end, Math.min(source.length, end + 600));
    const previousBoundaries = [before.lastIndexOf('. '), before.lastIndexOf('.\n'), before.lastIndexOf('。'),
        before.lastIndexOf('！'), before.lastIndexOf('？'), before.lastIndexOf(';'),
        before.lastIndexOf('；'), before.lastIndexOf('\n\n')];
    const nextBoundaries = [after.indexOf('. '), after.indexOf('.\n'), after.indexOf('。'), after.indexOf('！'),
        after.indexOf('？'), after.indexOf(';'), after.indexOf('；'), after.indexOf('\n\n')]
        .filter(index => index >= 0);
    const lower = start - before.length + Math.max(-1, ...previousBoundaries) + 1;
    const upper = end + (nextBoundaries.length ? Math.min(...nextBoundaries) : after.length);
    return source.slice(lower, upper).trim();
}

/**
 * Extract repository references from authenticated paper text. A single URL
 * may intentionally yield several typed facets (for example code + dataset).
 * Line-break recovery is limited to URL delimiters inside one paragraph; the
 * exact broken token is retained so a later source-quote replay can prove the
 * normalized HTTPS URL.
 */
function extractPaperSourceRepositoryCandidates(sourceText) {
    const source = String(sourceText || '');
    const host = '(?:github\\.com|gitlab\\.com|huggingface\\.co|modelscope\\.cn)';
    const softBreak = '(?:\\r?\\n[ \\t]*)?';
    const segment = '[A-Za-z0-9._~-]+';
    const separator = `${softBreak}\\/${softBreak}`;
    const pattern = new RegExp(
        `(?<![A-Za-z0-9._~@/-])(?:https:${softBreak}\\/${softBreak}\\/${softBreak})?(?:www\\.)?${host}`
            + `${separator}${segment}${separator}${segment}(?:${separator}${segment})*`
            + '(?![A-Za-z0-9._~/%?:#@-])',
        'giu'
    );
    const candidates = [];
    for (const match of source.matchAll(pattern)) {
        const prefix = source.slice(Math.max(0, match.index - 96), match.index);
        if (/@[ \t]*\r?\n[ \t]*$/u.test(prefix)) continue;
        const sourceToken = match[0].replace(/[),.;:!?，。；：！？、）》】》」』]+$/u, '');
        const url = normalizePaperSourceRepositoryToken(sourceToken);
        if (!url) continue;
        const sourceQuote = repositorySourceQuote(
            source, match.index, match.index + sourceToken.length
        );
        const classificationQuote = repositoryClassificationQuote(
            source, match.index, match.index + sourceToken.length
        ).split(sourceToken).join('[RESOURCE_URL]');
        const facets = classifyPaperSourceResourceFacets(classificationQuote);
        if (/\r?\n/u.test(sourceToken) && facets.length === 1 && facets[0] === 'third_party') {
            continue;
        }
        for (const type of facets) {
            candidates.push({ type, url, sourceToken, line: sourceQuote });
        }
    }
    return [...new Map(candidates.map(candidate => [
        `${candidate.type}:${candidate.url}:${candidate.sourceToken}`, candidate
    ])).values()];
}

function normalizedSourceUrlBinding(sourceToken, originalUrl) {
    const normalized = normalizePaperSourceRepositoryToken(sourceToken);
    if (!normalized || normalized !== originalUrl || sourceToken === originalUrl) return {};
    return {
        sourceUrlBindingContract: SOURCE_URL_NORMALIZATION_CONTRACT,
        sourceUrlToken: sourceToken,
        sourceUrlTokenSha256: sha256(sourceToken)
    };
}

function paperSourceQuoteBindsOriginalUrl(resource) {
    const quote = String(resource?.sourceQuote || '');
    const originalUrl = String(resource?.originalUrl || '');
    if (quote.includes(originalUrl)) return true;
    const token = String(resource?.sourceUrlToken || '');
    return resource?.sourceUrlBindingContract === SOURCE_URL_NORMALIZATION_CONTRACT
        && resource?.sourceUrlTokenSha256 === sha256(token)
        && quote.includes(token)
        && normalizePaperSourceRepositoryToken(token) === originalUrl;
}

module.exports = {
    SOURCE_URL_NORMALIZATION_CONTRACT,
    normalizePaperSourceRepositoryToken,
    classifyPaperSourceResourceFacets,
    extractPaperSourceRepositoryCandidates,
    normalizedSourceUrlBinding,
    paperSourceQuoteBindsOriginalUrl
};
