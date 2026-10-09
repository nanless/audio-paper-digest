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
// 可达地址不等于作者已开放资源；明确否定、未来计划和第三方归属不得成为肯定依据。
const RESOURCE_NOT_RELEASED = /\b(?:not(?!\s+(?:only|just)\b)|never|no\s+longer)\b|\b(?:will|would|plan(?:s|ned)?|intend(?:s)?|soon|forthcoming|upon\s+(?:acceptance|publication))\b|(?:尚未|还未|未曾|不会|不再|不公开|不开放|未公开|未开放|未开源|未发布|不可用|尚不|没有(?:公开|开放|开源|发布)|计划|将会|拟于|将在|将(?:公开|开放|开源|发布)|即将|待发表|待录用)/i;
const THIRD_PARTY_RESOURCE = /\b(?:baseline|third[- ]party|prior\s+work|previous\s+work|other\s+(?:authors?|researchers?|projects?)|we\s+(?:use|used|adopt|adopted|reuse|reused|build\s+on))\b|(?:第三方|基线|已有工作|先前工作|其他作者|他人)/i;
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
        // PDF 提取可能紧挨着 URL 分隔符换行。字母数字与字母数字直接相连，
        // 和把无关正文连起来无法区分，所以有意不支持这种恢复。
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
    if (!quote || RESOURCE_NOT_RELEASED.test(quote) || THIRD_PARTY_RESOURCE.test(quote)
        || !RESOURCE_AFFIRMATIVE.test(quote)) return ['third_party'];
    const facetMatches = RESOURCE_FACET_SPECS.map(([type, pattern]) => ({ type, match: pattern.exec(quote) }))
        .filter(item => item.match);
    const firstFacet = Math.min(...facetMatches.map(item => item.match.index));
    const prefix = Number.isFinite(firstFacet) ? quote.slice(0, firstFacet) : '';
    // 明确命名的外部项目不能只因“code available”被归为作者资源。
    // 无归属前缀的“Code is available”保留；无法确认的命名主体按其他链接处理。
    const unknownSubject = prefix.replace(/\b(?:our|the|this|these|all|both|we|authors?|work|paper|project|release|released|provide|provided|provides|publicly|openly|make|made)\b/gi, '')
        .replace(/(?:本文|本研究|我们|作者|现已|已|公开|提供|的)|[\s:：,，]/gu, '');
    const explicitAuthor = /^(?:our\b|we\b|the\s+authors?\b|本文|本研究|我们|作者)/i.test(prefix.trim());
    if (unknownSubject && !explicitAuthor) return ['third_party'];
    const facets = facetMatches.map(item => item.type);
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
    const sentence = source.slice(lower, upper);
    const relativeStart = start - lower;
    const relativeEnd = end - lower;
    // and 只有带新主语时才切分；Data and code 这类同一声明仍作为一组。
    const boundary = /[,;；]|\b(?:but|while|whereas|however)\b|\band\b(?=\s+(?:our|we|the|their|its)\b)|(?:但是|然而|但|而)/giu;
    let clauseStart = 0;
    let clauseEnd = sentence.length;
    for (const match of sentence.matchAll(boundary)) {
        // URL 前的逗号可能只是“code, dataset, and weights”枚举，不能丢掉前面的资源。
        // 前面已有另一链接，或后面明确开始独立主语时，才把它当作声明边界。
        if (match[0] === ',' && match.index < relativeStart
            && !/(?:https?:|github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)/i.test(sentence.slice(0, match.index))
            && !/^\s*(?:(?:and|but)\s+)?(?:our|we|the|their|its)\b/i.test(sentence.slice(match.index + 1))) continue;
        if (match.index + match[0].length <= relativeStart) clauseStart = match.index + match[0].length;
        else if (match.index >= relativeEnd) { clauseEnd = match.index; break; }
    }
    return sentence.slice(clauseStart, clauseEnd).trim();
}

function paperSourceResourceQuote(sourceText, sourceToken) {
    const source = String(sourceText || '');
    const token = String(sourceToken || '');
    const start = token ? source.indexOf(token) : -1;
    return start < 0 ? '' : repositoryClassificationQuote(source, start, start + token.length);
}

function paperSourceResourceFacets(sourceText, sourceToken) {
    const quote = paperSourceResourceQuote(sourceText, sourceToken)
        .split(String(sourceToken || '')).join('[RESOURCE_URL]');
    return classifyPaperSourceResourceFacets(quote);
}

/**
 * 从已核验的论文文本里提取仓库引用。单个 URL 可能有意给出多个
 * 带类型的引用（例如代码 + 数据集）。断行恢复只限同一段落内的
 * URL 分隔符；保留精确的断开的 token，方便之后用来源引文重放
 * 来证明规范化后的 HTTPS URL。
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
        const facets = paperSourceResourceFacets(source, sourceToken);
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
    if (!originalUrl || (resource?.type && resource.type !== 'third_party'
        && !paperSourceResourceFacets(quote, resource.sourceUrlToken || originalUrl).includes(resource.type))) return false;
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
    paperSourceResourceFacets,
    paperSourceResourceQuote,
    extractPaperSourceRepositoryCandidates,
    normalizedSourceUrlBinding,
    paperSourceQuoteBindsOriginalUrl
};
