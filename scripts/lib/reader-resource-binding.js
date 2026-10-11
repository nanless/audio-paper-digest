'use strict';

const crypto = require('node:crypto');

const SOURCE_URL_NORMALIZATION_CONTRACT = 'paper-source-repository-url-normalization-v1';
const SUPPORTED_REPOSITORY_HOSTS = new Set([
    'github.com', 'gitlab.com', 'huggingface.co', 'modelscope.cn'
]);
const sha256 = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

const RESOURCE_FACET_SPECS = Object.freeze([
    ['code', /\b(?:source\s+code|code|implementation|software|repository|repo)\b|源代码|代码|实现|仓库/i],
    ['model', /\b(?:models?(?:\s+weights?)?|weights?|checkpoints?)\b|模型(?:权重)?|权重|检查点/i],
    ['dataset', /\b(?:data|datasets?|corpus|corpora|benchmarks?)\b|数据集|数据|语料库|基准/i],
    ['demo', /\b(?:(?:audio\s+)?demos?|demonstration)\b|在线演示|项目演示/i],
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

// 只接受完整的作者试听声明；术语提及、引文和未知具名主体不授权演示身份。
function isAuthorAudioExamplesStatement(value) {
    return /^Audio examples are (?:publicly )?available at (?:https:\/\/[^\s"'<>`]+|\[RESOURCE_URL\])[.]?$/i.test(String(value || '').trim());
}

function authorAudioExamplesContext(source, token, start) {
    const paragraphStart = source.lastIndexOf('\n\n', start - 1);
    const lower = paragraphStart < 0 ? 0 : paragraphStart + 2;
    const previous = source.slice(0, lower).trimEnd().split(/\n\s*\n/).at(-1) || '';
    const context = source.slice(0, start + token.length);
    // TXT 可能没有空行。保留完整引入文字，不能由最后一句覆盖否定或未来承诺。
    if (RESOURCE_NOT_RELEASED.test(context)
        || /["“”‘’`]|^\s*['>]|^ {4}|<\/?(?:blockquote|pre|code)\b/im.test(context)
        || /\b(?:quotes?|quoted|quotation|states|stated|says?|said|writes?|wrote|reported|according\s+to|following|as\s+follows|authors?|et\s+al|documentation|announcement|this\s+sentence|excerpt|mentioned|noted|claimed|describes?|description|website|contains|definition|terminology|phrase|means|for\s+example)\b|引用|第三方|术语/i.test(context)) return false;
    // 有引入文字时必须由最近的完整句明确介绍本研究；未知项目的说明保持中性。
    const statementStart = source.lastIndexOf('Audio examples', start);
    const introduction = source.slice(lower, statementStart).trim();
    const previousIntroduction = previous.trim();
    const preceding = introduction || previousIntroduction;
    if (preceding) {
        const nearest = preceding.split(/[.!?]\s+/).at(-1).replace(/\s+/g, ' ').trim();
        if (!/^(?:(?:Furthermore|Additionally|Moreover|Specifically|Therefore),?\s+)?We\s+(?:propose|present|formulate|design|estimate|introduce|develop)\b/i.test(nearest)) return false;
        if (/\b(?:projects?|resources?)\b/i.test(nearest)
            || THIRD_PARTY_RESOURCE.test(nearest)
            || /\b(?:another|external|other|third[- ]party)\s+(?:projects?|systems?|works?|authors?|resources?)\b|\b(?:from|by)\s+[A-Z][A-Za-z0-9_-]+\b/.test(nearest)) return false;
    }
    const sentence = repositoryClassificationQuote(source, start, start + token.length);
    return isAuthorAudioExamplesStatement(sentence);
}

function classifyPaperSourceResourceFacets(sourceQuote) {
    if (isAuthorAudioExamplesStatement(sourceQuote)) return ['demo'];
    const quote = String(sourceQuote || '').replace(/\bavail-\s*able\b/gi, 'available')
        .replace(/\s+/g, ' ').trim()
        .replace(ATTACHED_FOOTNOTE_RESOURCE_LABEL, '');
    if (!quote || RESOURCE_NOT_RELEASED.test(quote) || THIRD_PARTY_RESOURCE.test(quote)
        || !RESOURCE_AFFIRMATIVE.test(quote)
        || /\b(?:quotes?|quoted)\b.*\b(?:following|statement|declaration)\b|(?:引用以下声明)/i.test(quote)) return ['third_party'];
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
    // HTML 脚注可形成“句号+引用号、换行脚注号、资源声明”。只隔开明确的
    // 独立声明，不删除来源字节，也不把前文引述的声明改认成本篇作者资源。
    const footnoteBoundary = /\.\d{1,3}[ \t]*\r?\n[ \t]*\d{1,3}[ \t]*\r?\n[ \t]*(?=(?:source\s+code|code|(?:audio\s+)?demos?)\b[^\n]*\b(?:is|are)\s+(?:publicly\s+)?available\s+at\b)/giu;
    for (const match of before.matchAll(footnoteBoundary)) {
        const absoluteBoundary = start - before.length + match.index;
        const paragraphStart = source.lastIndexOf('\n\n', absoluteBoundary);
        const abstractCandidate = source.lastIndexOf('\nAbstract\n', absoluteBoundary);
        const metadataLines = abstractCandidate < 0 ? [] : source.slice(0, abstractCandidate).trim().split(/\r?\n/);
        // 只识别文档开头的标题与逐行作者姓名；任意正文中的 Abstract 不授权截断。
        const authorLines = metadataLines.slice(1).map(line => line.split(/\\sthanks|Corresponding author/i)[0].trim());
        const hasAuthorMetadata = metadataLines.length >= 2 && metadataLines.length <= 20
            && authorLines.every(line => /^[A-Z][A-Za-z.'’–-]*(?:\s+[A-Z][A-Za-z.'’–-]*){1,5}$/.test(line));
        const preAbstract = abstractCandidate < 0 ? '' : source.slice(0, abstractCandidate);
        const abstractStart = hasAuthorMetadata && !RESOURCE_NOT_RELEASED.test(preAbstract)
            && !THIRD_PARTY_RESOURCE.test(metadataLines[0] || '')
            && !/\b(?:quotes?|quoted|states|stated|says?|said|writes?|wrote|reported|according\s+to|following|as\s+follows|authors?|et\s+al|documentation|announcement|this\s+sentence|excerpt|mentioned|noted|claimed|describes?|provides?|contains)\b|引用|以下声明|其他作者|另一篇工作/i.test(metadataLines[0] || '')
            ? abstractCandidate : -1;
        const introductionStart = Math.max(paragraphStart < 0 ? 0 : paragraphStart + 2,
            abstractStart < 0 ? 0 : abstractStart + '\nAbstract\n'.length);
        const introduction = source.slice(introductionStart, absoluteBoundary);
        const sentenceStart = Math.max(-1, ...previousBoundaries.filter(index => index < match.index)) + 1;
        const conclusionStart = Math.max(start - before.length + sentenceStart, introductionStart);
        const conclusion = source.slice(conclusionStart, absoluteBoundary).trim();
        // 额外句界只适用于紧邻的结果/分析结论。未知前文仍保持原分类窗口，
        // 而不是按一张不完整的引述动词表猜测归属。
        if (RESOURCE_NOT_RELEASED.test(introduction)
            || /\b(?:quotes?|quoted|states|stated|says?|said|writes?|wrote|reported|according\s+to|following|as\s+follows|authors?|et\s+al|documentation|announcement|this\s+sentence)\b|(?:引用|以下声明|其他作者|另一篇工作)/i.test(introduction)) {
            return source.slice(introductionStart, end).trim();
        }
        if (!/^(?:(?:these|our|the|further)\s+)?(?:experimental\s+)?(?:results?|analysis|evaluations?|experiments?)\b[^.!?]*\b(?:shows?|demonstrates?|indicates?|suggests?|confirms?|reveals?)\b/i.test(conclusion)) continue;
        previousBoundaries.push(match.index + match[0].length - 1);
    }
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

// 仅恢复同一作者软件声明内被脚注分开的仓库及明确开源句。
function presentedLibraryRepositoryQuote(source, token, start) {
    const url = normalizePaperSourceRepositoryToken(token);
    if (!url || /\r?\n/.test(token)) return '';
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com' || parsed.pathname.split('/').filter(Boolean).length !== 2) return '';
    const name = parsed.pathname.split('/').filter(Boolean)[1];
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) return '';
    const lower = source.lastIndexOf('We present ', start);
    if (lower < 0 || (lower > 0 && source[lower - 1] !== '\n')) return '';
    const prefix = source.slice(lower, start);
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^We present ${escapedName}(?:\\d{1,3})?\\s*(?:\\d{1,3}\\s*)?$`).test(prefix)
        || /\n\s*\n/.test(prefix)) return '';
    const endOfLine = source.indexOf('\n', start + token.length);
    const quote = source.slice(lower, endOfLine < 0 ? source.length : endOfLine);
    const after = quote.slice(prefix.length + token.length);
    if (!/^:\s*given\b/i.test(after) || quote.length > 1600
        || RESOURCE_NOT_RELEASED.test(quote) || THIRD_PARTY_RESOURCE.test(quote)
        || (quote.match(/https?:\/\//gi) || []).length !== 1
        || /\b(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\b/gi.test(after)
        || !/^:\s*given a score–performance alignment, it places independently generated components onto this shared axis and merges them into a single, self-contained visualization\.\s+(?:Each is handled as an independent layer that can be added, combined, or removed, making such composites straightforward to build and adapt\.\s+)?The library is open-source\b/.test(after)) return '';
    return quote;
}

function paperSourceResourceQuote(sourceText, sourceToken) {
    const source = String(sourceText || '');
    const token = String(sourceToken || '');
    const start = token ? source.indexOf(token) : -1;
    return start < 0 ? '' : presentedLibraryRepositoryQuote(source, token, start)
        || repositoryClassificationQuote(source, start, start + token.length);
}

function resourceClassificationIsCurrent(resource, sourceText) {
    if (resource?.origin !== 'paper_source' || resource.type !== 'third_party') return true;
    const token = resource.sourceUrlToken || resource.originalUrl;
    const source = String(sourceText || '');
    const start = token ? source.indexOf(token) : -1;
    return start < 0 || !authorAudioExamplesContext(source, token, start);
}

function paperSourceResourceFacets(sourceText, sourceToken) {
    const source = String(sourceText || '');
    const token = String(sourceToken || '');
    const start = token ? source.indexOf(token) : -1;
    if (start >= 0 && authorAudioExamplesContext(source, token, start)) return ['demo'];
    if (start >= 0 && presentedLibraryRepositoryQuote(source, token, start)) return ['code'];
    const quote = paperSourceResourceQuote(sourceText, sourceToken)
        .split(String(sourceToken || '')).join('[RESOURCE_URL]');
    if (isAuthorAudioExamplesStatement(quote)) return ['third_party'];
    return classifyPaperSourceResourceFacets(quote);
}

/**
 * 从已核验的论文文本里提取仓库引用。单个 URL 可能有意给出多个
 * 带类型的引用（例如代码 + 数据集）。断行恢复只限同一段落内的
 * URL 分隔符；保留原文中断行的地址文本，供后续结合原文引文重新核对
 * 恢复后的 HTTPS URL。
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
    // 原仓库提取拒绝紧邻冒号；只为已通过完整作者软件声明的原字节恢复。
    for (const match of source.matchAll(/https:\/\/github\.com\/[A-Za-z0-9._~-]+\/[A-Za-z0-9_-]+(?=:\s*given\b)/g)) {
        const line = presentedLibraryRepositoryQuote(source, match[0], match.index);
        if (line) candidates.push({ type: 'code', url: match[0], sourceToken: match[0], line });
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
    paperSourceResourceFacets, resourceClassificationIsCurrent,
    paperSourceResourceQuote,
    extractPaperSourceRepositoryCandidates,
    normalizedSourceUrlBinding,
    paperSourceQuoteBindsOriginalUrl
};
