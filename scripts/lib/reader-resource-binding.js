'use strict';

const crypto = require('node:crypto');

const SOURCE_URL_NORMALIZATION_CONTRACT = 'paper-source-repository-url-normalization-v1';
const SUPPORTED_REPOSITORY_HOSTS = new Set([
    'github.com', 'gitlab.com', 'huggingface.co', 'modelscope.cn'
]);
const sha256 = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

const RESOURCE_FACET_SPECS = Object.freeze([
    ['code', /\b(?:source[- ]code|codes?|codebase|implementation|software|repository|repo)\b|源代码|代码|实现|仓库/i],
    ['model', /\b(?:models?(?:\s+weights?)?(?![\s-]+(?:results?|predictions?|implementation|training|outputs?|evaluation|details?|architecture|design|performance|comparisons?|analys(?:is|es)|descriptions?|statistics?|ablations?|inference|behaviors?|behaviours?|metrics?|scores?|logs?|curves?|cards?|summar(?:y|ies)|overviews?|diagrams?|figures?|tables?|settings?|setups?|configurations?|hyperparameters?)\b)|weights?|checkpoints?)\b|模型(?:权重)?|权重|检查点/i],
    ['dataset', /\b(?:data(?![\s-]+(?:pre-?processing|processing|augmentation|loading|loaders?|preparation|cleaning|curation|formatting|extraction|splitting|sampling|collection|filtering|normalization|pipeline|scripts?|analysis|analyses|efficiency|efficient|generation|synthesis|privacy|driven|ablations?|protocols?)\b)|datasets?(?![\s-]+(?:details?|statistics?|descriptions?|overviews?|construction|collection|cards?|documentation|analys(?:is|es)|summar(?:y|ies)|pre-?processing|processing|scripts?|preparation|curation|formatting|filtering|results?|predictions?|outputs?|evaluation|metrics?|scores?|tables?|figures?)\b)|(?:corpus|corpora|benchmarks?)(?![\s-]+(?:preparation|scripts?|construction|pipeline|results?|evaluation|details?|statistics?|descriptions?|overviews?|analysis|analyses|metrics?|scores?|tables?|figures?|settings?|setups?|configs?|configurations?)\b))\b|数据集|数据|语料库|基准/i],
    ['demo', /\b(?:(?:audio\s+)?demos?|demonstration)\b|在线演示|项目演示/i],
    ['reproduction', /\b(?:artifacts?|reproducibility|reproduction(?:\s+materials?)?)\b|复现材料|工件/i]
]);
// 可达地址不等于作者已开放资源；明确否定、未来计划和第三方归属不得成为肯定依据。
const RESOURCE_NOT_RELEASED = /\b(?:not(?!\s+(?:only|just)\b)|never|no\s+longer|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|hasn[’']t|haven[’']t|didn[’']t|don[’']t|doesn[’']t|unable\s+to|closed[- ]source|unreleased|unavailable|to\s+be\s+released|coming\s+soon|under\s+(?:anonymous\s+)?review|pending\s+(?:approval|review|release)|tbd)\b|\b(?:will|would|plan(?:s|ned)?|intend(?:s)?|soon|forthcoming|upon\s+(?:acceptance|publication))\b|(?:尚未|还未|未曾|不会|不再|不公开|不开放|未公开|未开放|未开源|未发布|不可用|尚不|没有(?:公开|开放|开源|发布)|计划|将会|拟于|将在|将(?:公开|开放|开源|发布)|即将|待发表|待录用)/i;
const COMPARATIVE_CLOSED_SOURCE_CONTRAST_RE = /\b(?:unlike|than|against|versus|vs\.?|over|compared\s+(?:to|with)|contrast(?:ing)?\s+with)\s+(?:(?:existing|prior|commercial|proprietary|previous|other)\s+){0,2}(?:closed[- ]source|proprietary|private)\s+(?:models?|systems?|baselines?|methods?|tools?|apis?)\b/gi;
function stripComparativeClosedSourceContrast(value) {
    return String(value || '').replace(COMPARATIVE_CLOSED_SOURCE_CONTRAST_RE, ' ');
}
function hasNotReleasedContext(value) {
    return RESOURCE_NOT_RELEASED.test(stripComparativeClosedSourceContrast(value));
}
const THIRD_PARTY_RESOURCE = /\b(?:baselines?|third[- ]party|prior\s+work|previous\s+work|other\s+(?:authors?|researchers?|projects?)|from\s+an?\s+(?:publicly\s+|openly\s+)?(?:available|released|open[- ]source|pretrained|pre-trained)\b|we\s+(?:(?:also|directly|further|additionally|only|simply|mainly|primarily|first|instead)\s+){0,2}(?:use|used|utiliz(?:e|ed)|adopt(?:ed)?|reuse[d]?|build\s+on|base\s+our\s+[a-z-]+\s+on|download(?:ed|ing)?|load(?:ed|ing)?|compar(?:e[ds]?|ing)\s+(?:with|against)|(?:follow(?:ed|ing)?|employ(?:ed|ing)?|leverag(?:e[ds]?|ing)|obtain(?:ed|ing)?)\s+(?:the\s+(?:official|public(?:ly)?|open[- ]source(?:d)?|released|available|pre-?trained|existing|original|prior|baseline|third[- ]party)|an?\s+(?:official|public(?:ly)?|open[- ]source(?:d)?|released|available|pre-?trained|existing|original|prior|baseline|third[- ]party)|their\b|its\b|from\b)|implement(?:ed)?\s+[^.,;]{0,40}\s+(?:following|based\s+on)|initializ(?:e|ed)\s+[^.,;]{0,40}\s+from|(?:fine-?tun(?:e[ds]?|ing)|adapt(?:ed|ing)?)\s+(?!our\b|this\b)(?:(?:the|an?)\s+(?:(?:official|public(?:ly)?|open[- ]source(?:d)?|released|available|pre-?trained|existing|original|prior)\s+){1,3}|(?!the\b|an?\b|its\b|their\b)[a-z][a-z0-9._-]*(?:[’']s\s+|\s+(?:using|with|from|via)\s+))|evaluat(?:e[ds]?|ing)\s+(?:(?:(?:both|several|multiple|two|three|four|five|\d+)\s+)?(?:commercial\s+and\s+)?open[- ]source|(?!our\b|this\b|these\b|the\s+proposed\b)[^.,;]{1,50}\s+(?:using|with|via|from)\b)|run\s+its\s+public|partition(?:ed)?\s+[^.;]{0,120}\s+according\s+to)|our\s+(?:pipeline|system|method|framework|approach|architecture|model|implementation|baseline|setup|workflow|experiments?)\s+(?:uses?|utiliz(?:e[ds]?)|adopts?|reuses?|builds?\s+on|follows?|employs?|leverages?|loads?|relies\s+on|depends\s+on|incorporates?|integrates?)\s+(?:the|an?)\s+(?:official|public(?:ly)?|open[- ]source(?:d)?|released|available|pre-?trained|existing|original|prior)\b|(?:is|was|are|were)\s+implemented\s+(?:using|based\s+on)\s+(?:the\s+(?:official|public|open[- ]source|released)|an?\s+(?:public|open[- ]source|official|existing|prior))\b|(?:made\s+available|released)\s+by\s+the\s+authors\s+(?:is|are)\s+used)\b|(?:第三方|基线|已有工作|先前工作|其他作者|他人)/i;
const RESOURCE_AFFIRMATIVE = /\b(?:(?:available|released|published|open[- ]source(?:d)?)(?:\b|(?=(?:(\d{1,2})\1|\d{1,2})\b))|public\b)|\b(?:is|are)\s+(?:publicly\s+|openly\s+)?hosted\s+(?:at|on)\b|\b(?:can\s+be|is|are)\s+(?:publicly\s+|openly\s+)?(?:found|accessed|downloaded)\s+(?:at|on|via)\b|\b(?:we|authors?)\s+(?:(?:have|has)\s+)?(?:(?:publicly|openly|also|freely|hereby|jointly)\s+){0,2}(?:release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]source[ds]?)\b|\band\s+(?:(?:publicly|openly|also|freely|hereby|jointly)\s+){0,2}(?:release|provide|publish|share|open[- ]source)\s+our\b|(?:已|现已|公开|开源|发布|提供|可获取|可用)/i;
const GENERIC_FIRST_PARTY_RESOURCE = /\b(?:resources?|materials?)\s+(?:for|from)\s+(?:this|our|the)\s+(?:study|work|paper|project)\s+(?:are|is)\s+(?:publicly\s+)?available\b|\b(?:we|the\s+authors?)\s+(?:(?:have|has)\s+)?(?:release[ds]?|provide[ds]?)\s+(?:the\s+)?(?:resources?|materials?)\b/i;
const ATTACHED_FOOTNOTE_RESOURCE_LABEL = /\b\d{1,3}(?=(?:source[- ]code|codes?|codebase|implementation|software|repositor(?:y|ies)|repo|models?(?:\s+weights?)?|weights?|checkpoints?|data|datasets?|corpus|corpora|benchmarks?|demos?|demonstration|artifacts?|reproducibility|reproduction)\b)/gi;
const TRAILING_FOOTNOTE_RESOURCE_LABEL = /(?<=\b(?:source[- ]code|codes?|codebase|implementation|software|repositor(?:y|ies)|repo|models?|weights?|checkpoints?|data|datasets?|corpus|corpora|benchmarks?|demos?|demonstration|artifacts?|reproducibility|reproduction|materials?))(?:(\d{1,2})\1|\d{1,3})\b/g;
const TRAILING_FOOTNOTE_CAP_RESOURCE_LABEL = /(?<=\b(?:Source[- ]code|Codes?|Codebase|Implementation|Software|Repositor(?:y|ies)|Repo|Models?|Weights?|Checkpoints?|Data|Datasets?|Corpus|Corpora|Benchmarks?|Demos?|Demonstration|Artifacts?|Reproducibility|Reproduction|Materials?))(\d{1,2})\1\b(?=\s+\1\b)/g;

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

function localContextWindow(source, start, maxBackChars = 1500) {
    const before = source.slice(Math.max(0, start - maxBackChars), start);
    const paragraphs = before.split(/\n\s*\n/);
    return paragraphs.slice(-3).join('\n\n');
}

function hasUnclosedFenceBefore(source, start) {
    let fence = null;
    for (const line of source.slice(0, start).split('\n')) {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
        if (!marker) continue;
        if (!fence) fence = marker[0];
        else if (marker[0] === fence) fence = null;
    }
    return Boolean(fence);
}

function hasBlockingAttributionOrQuoteContext(source, start, end) {
    const local = localContextWindow(source, start);
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const currentLinePrefix = source.slice(Math.max(lineStart, start - 400), start);
    const immediatePrefix = source.slice(Math.max(0, start - 260), start);
    if (hasUnclosedFenceBefore(source, start)) return true;
    if (/^\s*['>]|^ {4}|<\/?(?:blockquote|pre|code)\b|<!--/im.test(local)) return true;
    if ((currentLinePrefix.match(/"/g) || []).length % 2 === 1) return true;
    if ((currentLinePrefix.match(/`/g) || []).length % 2 === 1) return true;
    const openCurly = (currentLinePrefix.match(/“/g) || []).length;
    const closeCurly = (currentLinePrefix.match(/”/g) || []).length;
    if (openCurly > closeCurly) return true;
    if (/^\s*['"“‘`]/.test(currentLinePrefix.trim()) && /['"”’`]\s*$/.test(source.slice(end, end + 4))) return true;
    if (/\b(?:quotes?|quoted|quotation|according\s+to|documentation|(?:external|third[- ]party|other|cited|their|official\s+baseline)\s+website|website\s+(?:description|statement|announcement|excerpt|states?|says?)|announcement|following\s+statement|following\s+two\s+paragraphs|cited\s+(?:article|abstract|paper|work))\b|\b(?:states?|stated|says?|said|writes?|wrote|reported|mentioned|noted|claimed)\b[^.\n]{0,120}(?:following|statement|declaration|excerpt|:)|引用|第三方|术语|以下声明|其他作者|另一篇工作/i.test(local)) {
        return true;
    }
    if (/\bet\s+al\b|\b(?:the|other)\s+authors?\b/i.test(immediatePrefix)) {
        return true;
    }
    return false;
}

const RETRACTION_OPTIONAL_ADJ = '(?:(?:full|complete|trained|pre-?trained|training|evaluation|eval|inference|reproduction|official|public|raw|annotated)\\s+){0,2}';
const RETRACTION_RESOURCE_NOUN = '(?:source[- ])?(?:codes?|codebase|implementation|models?\\s+weights?|models?|weights?|checkpoints?|benchmark\\s+datasets?|datasets?|benchmarks?|corpus|corpora|annotations?|audio\\s+samples?|scripts?|repository|repo|demos?|project\\s+page|homepage|spaces?|github|gitlab|hugging\\s*face(?:\\s+(?:spaces?|datasets?))?|modelscope(?:\\s+(?:datasets?|studios?))?|resources?|materials?|artifacts?)';
const EXTERNAL_OWNERSHIP_RE = /\b(?:belongs?\s+to|(?:owned|maintained|provided|developed|released|published|created)\s+by|hosted\s+by(?!\s+(?:GitHub|GitLab|Hugging\s*Face|ModelScope|Zenodo)\b))\s+(?!(?:us|our(?:\s+(?:team|group|lab|laboratory|authors?|organization|institution|university))?|the\s+authors?(?!\s+of\b)|ourselves)\b)/i;
const RETRACTION_MAKE_AVAILABLE_CLAUSE = `(?:made|make)\\s+(?:(?:(?:our|this|the|these|it|them)\\b|${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b)[^.!?\\n]{0,60}\\s+)?(?:publicly\\s+|openly\\s+)?available`;
const RETRACTION_RESTRICTED_PREDICATE = 'restricted(?!\\s+to\\s+(?:non[- ]?commercial|research|academic|educational|personal|evaluation|scientific|\\d|monophonic|single|clean|short|english|speech|audio|fixed|causal|offline|synthetic|in-domain)\\b)';
const INLINE_UNAVAILABLE_TAG_RE = /\b(?:(?:currently|still|strictly|presently)\s+)?(?:private|withheld|internal\s+only|unreleased|unavailable|closed[- ]source|proprietary|confidential|pending(?:\s+(?:approval|review|release))?|tbd|to\s+be\s+released|under\s+(?:anonymous\s+)?review|placeholder|coming\s+soon)\b/i;
function hasInlineUnavailableTag(value) {
    return INLINE_UNAVAILABLE_TAG_RE.test(stripComparativeClosedSourceContrast(value));
}
const INLINE_VERBLESS_NEG_RE = new RegExp(`^(?:(?:and|but|yet|however|though|although|while|whereas|currently|still|strictly|presently|unfortunately|also)[,:]?\\s+)*(?:(?:not|no\\s+longer)\\s+(?:(?:yet|currently|still)\\s+)*(?:public(?:ly)?|openly|available|released|open[- ]sourced|shared|accessible|made\\s+(?:publicly\\s+|openly\\s+)?available)|unreleased|unavailable|closed[- ]source|proprietary|confidential|internal\\s+only|placeholder|${RETRACTION_RESTRICTED_PREDICATE})\\b`, 'i');
const SHARED_BADGE_LEAD_RE = /^(?:[•·*$-]\s*)?(?:source[- ]code|codebase|code|models?|weights?|checkpoints?|datasets?|benchmarks?|demos?|project\s+page|homepage|github|gitlab|hugging\s*face(?:\s+(?:spaces?|datasets?))?|modelscope(?:\s+(?:datasets?|studios?))?|repository|repo|resources?|artifacts?)\s*[:(]/i;
function hasBadgeUnavailableOrVerblessNeg(badgeClause) {
    const raw = String(badgeClause || '').trim();
    if (!raw) return false;
    if (hasInlineUnavailableTag(raw)) return true;
    const strippedLead = raw.replace(SHARED_BADGE_LEAD_RE, '').trim();
    const leadEndedWithParen = /\(\s*$/.test(raw.slice(0, raw.length - strippedLead.length));
    let body = strippedLead.replace(/[.!?。]+$/, '').trim();
    if (leadEndedWithParen && body.endsWith(')')) {
        body = body.slice(0, -1).trim();
    } else if (body.startsWith('(') && body.endsWith(')')) {
        body = body.slice(1, -1).trim();
    }
    return Boolean(body) && (hasInlineUnavailableTag(body) || INLINE_VERBLESS_NEG_RE.test(body));
}
const INLINE_BADGE_HEADER_SPLIT_RE = /(?=\s+(?:source[- ]code|codebase|code|models?|weights?|checkpoints?|datasets?|benchmarks?|demos?|project\s+page|homepage|github|gitlab|hugging\s*face(?:\s+(?:spaces?|datasets?))?|modelscope(?:\s+(?:datasets?|studios?))?|repository|repo|resources?|artifacts?)\s*[:(])/i;
function splitBadgeBarSegments(line) {
    return String(line || '')
        .split(/(?:\$?[|·•]+\$?|(?:^|\s+)\/(?=\s+))/)
        .flatMap(seg => seg.split(INLINE_BADGE_HEADER_SPLIT_RE))
        .map(seg => seg.replace(/^\$+/, '').replace(/\$+$/, '').trim())
        .filter(Boolean);
}
const RETRACTION_FACET_PATTERNS = {
    code: /\b(?:source[- ]code|codes?|codebase|implementation|scripts?|repository|repo|github|gitlab)\b/i,
    model: /\b(?:models?|weights?|checkpoints?|repository|repo|hugging\s*face(?!\s+(?:datasets?|spaces?)\b)|modelscope(?!\s+(?:datasets?|studios?)\b))\b/i,
    dataset: /\b(?:datasets?|benchmarks?|corpus|corpora|annotations?|repository|repo|hugging\s*face\s+datasets?|modelscope\s+datasets?)\b/i,
    demo: /\b(?:demos?|project\s+page|homepage|audio\s+samples?|spaces?|hugging\s*face\s+spaces?|modelscope\s+studios?)\b/i,
    reproduction: /\b(?:reproduction|reproducibility|source[- ]code|codes?|codebase|scripts?|artifacts?|materials?|resources?|repository|repo|github|gitlab)\b/i
};
function demoPlatformForToken(token) {
    const normalized = normalizePaperSourceRepositoryToken(token) || String(token || '');
    if (/huggingface\.co\/spaces\//i.test(normalized)) return 'huggingface';
    if (/modelscope\.cn\/studios\//i.test(normalized)) return 'modelscope';
    return '';
}
function advanceEndPastUrlSuffix(source, end) {
    const str = String(source || '');
    let pos = end;
    if (pos < str.length && (str[pos] === '?' || str[pos] === '#'
        || (str[pos] === '/' && (str[pos + 1] === '?' || str[pos + 1] === '#')))) {
        const m = /^\/?[?#][^\s<>"'\]})>,;]*/.exec(str.slice(pos));
        if (m) {
            const cleaned = m[0].replace(/[),.;:!?，。；：！？、）》】」』]+$/u, '');
            pos += cleaned.length;
        }
    }
    return pos;
}

function isHostedDemoPlatformMismatch(text, expectedFacets, demoPlatform, { repoHostDemo = false } = {}) {
    if (!Array.isArray(expectedFacets) || !expectedFacets.includes('demo')) return false;
    if (/\b(?:project\s+page|homepage|audio\s+samples?|demos?)\b/i.test(text)) return false;
    if (repoHostDemo && /\b(?:repository|repo|github|gitlab)\b/i.test(text)) return false;
    const isHfSpace = /\bhugging\s*face\s+spaces?\b/i.test(text);
    const isMsStudio = /\bmodelscope\s+studios?\b/i.test(text);
    if (!isHfSpace && !isMsStudio) return false;
    const withoutPlatformClause = String(text || '')
        .replace(
            /(?:^|\b(?:and|&)\s+|[,;|·•]\s*)(?:(?:our|the|this)\s+)?(?:hugging\s*face\s+spaces?|modelscope\s+studios?)\b(?:(?!\s+(?:and|but|yet|though|although|while|whereas|&)\s+(?:also\s+)?(?:it|they|this|that|our|the|we|is|are|remains?|stays?|will|would|may|might|plan(?:s|ned)?|intend(?:s|ed)?|unable|unfortunately|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|has(?:n[’']t)?|have(?:n[’']t)?|did(?:n[’']t)?|do(?:n[’']t|es(?:n[’']t)?)?|not|no\s+longer|currently|still|strictly|presently|private|withheld|unreleased|unavailable|closed[- ]source|proprietary|confidential|placeholder|restricted|internal|coming\s+soon|pending|tbd|to\s+be\s+released|under\s+(?:anonymous\s+)?review)\b)[^.,;/|·•])*/gi,
            ''
        )
        .replace(/^[/,;:|·•\s]+/, '')
        .trim();
    if (withoutPlatformClause && (hasInlineUnavailableTag(withoutPlatformClause)
        || INLINE_VERBLESS_NEG_RE.test(withoutPlatformClause)
        || hasExplicitResourceRetractionPredicate(withoutPlatformClause))) {
        return false;
    }
    return !((isHfSpace && demoPlatform === 'huggingface') || (isMsStudio && demoPlatform === 'modelscope'));
}
function retractionMatchesFacet(facet, text, { repoHostDemo = false } = {}) {
    if (RETRACTION_FACET_PATTERNS[facet]?.test(text)) return true;
    if (facet === 'demo' && repoHostDemo && /\b(?:repository|repo|github|gitlab)\b/i.test(text)) return true;
    return false;
}

function hasExplicitResourceRetractionPredicate(rawSentence) {
    const sentence = stripComparativeClosedSourceContrast(rawSentence);
    return new RegExp(`\\b(?:is|are|remains?|stay[s]?)\\s+(?:(?:currently|still|yet|strictly|presently)\\s+)*(?:(?:not|no\\s+longer)\\s+(?:(?:yet|currently|still)\\s+)*(?:public(?:ly)?|available|released|open[- ]sourced|shared|accessible|maintained|made\\s+(?:publicly\\s+|openly\\s+)?available)|private|closed[- ]source|proprietary|unreleased|unavailable|confidential|${RETRACTION_RESTRICTED_PREDICATE}|withheld|internal\\s+only|(?:a\\s+)?placeholder|under\\s+(?:anonymous\\s+)?review|pending(?:\\s+(?:approval|review|release))?|to\\s+be\\s+released)\\b`, 'i').test(sentence)
        || /\b(?:isn[’']t|aren[’']t)\s+(?:(?:currently|still|yet)\s+)*(?:public(?:ly)?|available|released|open[- ]sourced|shared|accessible|made\s+(?:publicly\s+|openly\s+)?available)\b/i.test(sentence)
        || new RegExp(`\\b(?:(?:has|have)\\s+not|hasn[’']t|haven[’']t|did\\s+not|didn[’']t)\\s+(?:(?:yet|currently|still)\\s+)*(?:been\\s+)?(?:publicly\\s+|openly\\s+)?(?:release[d]?|publish(?:ed)?|provide[d]?|share[d]?|open[- ]source[d]?|${RETRACTION_MAKE_AVAILABLE_CLAUSE})\\b`, 'i').test(sentence)
        || new RegExp(`\\b(?:cannot|can[’']t|won[’']t|will\\s+not|do\\s+not|don[’']t|does\\s+not|doesn[’']t|are\\s+unable\\s+to|is\\s+unable\\s+to|unable\\s+to)\\s+(?:(?:yet|currently|still)\\s+)*(?:be\\s+(?:(?:yet|currently|still)\\s+)*(?:public(?:ly)?\\s+|openly\\s+)?(?:available|accessible|accessed|release[d]?|publish(?:ed)?|provide[d]?|share[d]?|open[- ]source[d]?|made\\s+(?:publicly\\s+|openly\\s+)?available)|(?:publicly\\s+|openly\\s+)?(?:release[d]?|publish(?:ed)?|provide[d]?|share[d]?|open[- ]source[d]?|${RETRACTION_MAKE_AVAILABLE_CLAUSE}))\\b`, 'i').test(sentence)
        || new RegExp(`\\b(?:will|would|may|might|plan(?:s|ned)?\\s+to|intend(?:s|ed)?\\s+to)\\s+(?:(?:soon|later|eventually)\\s+)*(?:be\\s+(?:(?:soon|later|eventually)\\s+)*(?:public(?:ly)?\\s+|openly\\s+)?(?:available|accessible|release[d]?|publish(?:ed)?|open[- ]source[d]?|made\\s+(?:publicly\\s+|openly\\s+)?available)|(?:publicly\\s+|openly\\s+)?(?:release[d]?|publish(?:ed)?|open[- ]source[d]?|${RETRACTION_MAKE_AVAILABLE_CLAUSE}))\\b`, 'i').test(sentence)
        || /\b(?:coming\s+soon|to\s+be\s+released|tbd|under\s+(?:anonymous\s+)?review|upon\s+(?:acceptance|publication))\b/i.test(sentence);
}

function isResourceBadgeOrTagLine(line) {
    return /^(?:[•·*|$-]\s*)?[A-Za-z0-9\s|·•$-]{0,40}(?::|\()[^\n]*https?:\/\//i.test(line)
        || (/https?:\/\//i.test(line) && !/[.!?。]$/.test(line))
        || /^(?:\[[^\]\n]{1,40}\](?:\s*[|·•/]?\s*)?)+$/.test(line)
        || (!/[.!?。]$/.test(line) && /^(?:[•·*-]\s*)?(?:arXiv|Paper|PDF|Source[- ]code|Codebase|Code|Demo|Project(?:\s+page)?|Homepage|GitHub|GitLab|Hugging\s*Face(?:\s+Space)?|ModelScope|Weights?|Checkpoints?|Models?|Datasets?|License|DOI|Repository|Repo)\s*[:(]/i.test(line));
}

function isUnpunctuatedResourceHeadingLine(line) {
    return !/[.!?。]$/.test(line) && (
        /^(?:(?:\d+(?:\.\d+)*|[IVX]+)\.?\s+)?(?:Abstract|Introduction|Related\s+Work|Background|Method(?:ology|s)?|Approach|Experiments?|Evaluation|Results?|Discussion|Conclusion(?:s)?|Limitations?|Ethics(?:\s+Statement)?|Broader\s+Impact|Reproducibility(?:\s+Statement)?|Appendix|References)\s*$/i.test(line)
        || /^(?:\d+(?:\.\d+)*\.?|[IVX]+\.?|[IVX]+-[A-Z]\.?|[A-Z](?:\.\d+)+)\s+[A-Z][A-Za-z0-9\s,&:/-]{1,70}$/.test(line)
        || /^Appendix\s+[A-Z0-9]+(?:\s*[:.-]\s*[A-Za-z0-9\s,&:/-]{1,60})?$/i.test(line)
        || /^(?:(?:Code|Data|Model|Artifact|Resource|Open[- ]Source)(?:\s+(?:and|&|\/)\s+(?:Code|Data|Model|Artifact|Resource|Open[- ]Source))*\s+(?:Availability|Release|Statement)|Availability\s+of\s+(?:Code|Data|Model|Artifact|Resource)[A-Za-z0-9\s,&/-]{0,40})$/i.test(line)
    );
}

const PRIOR_WORK_CONTEXT_SOURCE = '(?:\\b(?:most|many|existing|prior|previous|current|traditional|conventional|commercial|other|real[- ]world)\\s+(?:[a-z-]+\\s+){0,2}(?:models?|systems?|methods?|baselines?|datasets?|corpora|annotations?|benchmarks?|tools?|implementations?|codes?|weights?|apis?|services?)\\b|\\b(?:baselines?|prior\\s+work|previous\\s+work|existing\\s+work)\\b)';
const PRIOR_WORK_CONTEXT_RE = new RegExp(PRIOR_WORK_CONTEXT_SOURCE, 'i');
const PRIOR_WORK_BROAD_MAIN_RE = PRIOR_WORK_CONTEXT_RE;
const MAIN_CLAUSE_RETRACTION_VERB_LA = '(?!(?<!\\b(?:and|or)(?:\\s+(?:still|currently|often|also|yet|frequently|typically|generally|mostly|usually))?)\\s+(?:is|are|remains?|stays?|will|would|may|might|plan(?:s|ned)?|intend(?:s|ed)?|cannot|can[’\']t|won[’\']t|isn[’\']t|aren[’\']t|has(?:\\s+not|n[’\']t)?|have(?:\\s+not|n[’\']t)?|did(?:\\s+not|n[’\']t)?|do(?:\\s+not|n[’\']t|es(?:\\s+not|n[’\']t)?)?)\\s+(?:(?:currently|still|yet|strictly|presently|soon|later|eventually|not|no\\s+longer|be|been|public(?:ly)?|openly|unable|to)\\b|private|closed[- ]source|proprietary|unreleased|unavailable|confidential|withheld|internal\\s+only|(?:a\\s+)?placeholder|under\\s+(?:anonymous\\s+)?review|coming\\s+soon|pending|restricted|tbd|to\\s+be\\s+released|release[d]?|publish(?:ed)?|open[- ]source[d]?|make))';
const PRIOR_WORK_PREP_MOD_CORE = `\\b(?:(?:distilled|derived)\\s+from|(?:trained|built)\\s+(?:on|upon)|(?:of|for|on|using|from|against|with))\\s+(?:(?:evaluating|comparing(?:\\s+against)?|benchmarking|testing|training|running)\\s+)?${PRIOR_WORK_CONTEXT_SOURCE}`;
const PRIOR_WORK_PREP_MOD_RE = new RegExp(`${PRIOR_WORK_PREP_MOD_CORE}(?!,?\\s*(?:that|which)\\b)`, 'gi');
const PRIOR_WORK_PREP_MOD_WITH_REL_RE = new RegExp(
    `${PRIOR_WORK_PREP_MOD_CORE}(?:,\\s*(?:that|which)\\b[^,.;]{1,120},?|\\s+(?:that|which)\\b(?:\\s+(?:is|are|was|were|remains?|stays?|has|have|did|do(?:es)?|can|cannot|will|fail(?:s|ed)?|lack(?:s|ed)?))?(?:${MAIN_CLAUSE_RETRACTION_VERB_LA}[^,.;]){1,120})?`,
    'gi'
);
const SUBORDINATE_BECAUSE_RE = /(?<=\S\s+)(?:because|since|to\s+address\s+(?:the\s+)?(?:limitation|gap|issue|problem)\s+that)\b.*$/i;
const SUBORDINATE_REL_PRIOR_WORK_RE = new RegExp(
    `(?<=\\S\\s+)(?:where|that|which)\\s+(?:${PRIOR_WORK_CONTEXT_SOURCE}|\\bthey\\b)(?:\\s+(?:is|are|was|were|remains?|stays?|has|have|did|do(?:es)?|can|cannot|will|fail(?:s|ed)?|lack(?:s|ed)?))?(?:${MAIN_CLAUSE_RETRACTION_VERB_LA}[^,.;]){0,120}`,
    'gi'
);

function extractActiveRetractionClauses(clause) {
    const str = String(clause || '');
    const becauseMatch = SUBORDINATE_BECAUSE_RE.exec(str);
    if (becauseMatch) {
        const cleanedMain = str.slice(0, becauseMatch.index).replace(SUBORDINATE_REL_PRIOR_WORK_RE, ' ').replace(/\s+/g, ' ').trim();
        const subClause = becauseMatch[0];
        const results = cleanedMain ? [cleanedMain] : [];
        if (/^(?:because|since)\b/i.test(subClause)) {
            const body = subClause.replace(/^(?:because|since)\s+/i, '');
            const ownSubStartRe = new RegExp(
                `^(?:(?:(?:our|this\\s+(?:paper|work)(?:['’]s)?|the)\\s+)?${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b`
                    + `|we\\b[^.;]{0,80}\\b(?:(?:our|this\\s+(?:paper|work)(?:['’]s)?|the)\\s+)?${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b)`,
                'i'
            );
            const hasPredicateWordRe = /\b(?:is|are|was|were|remains?|stays?|has|have|had|will|would|may|might|can|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|did|do(?:es)?|released|available|unavailable|private|withheld|pending|restricted|proprietary|closed[- ]source|unreleased|under\s+(?:anonymous\s+)?review|coming\s+soon|tbd)\b/i;
            // Only split on bare `and|but` when the left side already carries a verb/predicate, keeping compound subjects like "our code and weights" intact.
            const subParts = [];
            let prev = 0;
            for (const m of body.matchAll(/\s*,\s*(?:and|but)\s+|\s+(?:and|but)\s+/gi)) {
                const left = body.slice(prev, m.index).trim();
                if (m[0].trimStart().startsWith(',') || hasPredicateWordRe.test(left)) {
                    if (left) subParts.push(left);
                    prev = m.index + m[0].length;
                }
            }
            const lastPart = body.slice(prev).trim();
            if (lastPart) subParts.push(lastPart);
            for (const part of subParts) {
                if (PRIOR_WORK_CONTEXT_RE.test(part.replace(PRIOR_WORK_PREP_MOD_WITH_REL_RE, ' '))) continue;
                if (!hasExplicitResourceRetractionPredicate(part)) continue;
                if (ownSubStartRe.test(part)) {
                    results.push(part);
                } else if (/^(?:it|they|we\b[^.;]{0,50}\b(?:it|them))\b/i.test(part) && cleanedMain
                    && !PRIOR_WORK_BROAD_MAIN_RE.test(cleanedMain)
                    && !/^We\s+(?:build|propose|present|introduce|develop|design|train|create|construct|formulate)\b/i.test(cleanedMain)
                    && !(/\b(?:outperforms?|surpass(?:es)?|beats?|exceeds?|address(?:es)?|overcomes?|mitigates?|solves?|improves?\s+on)\b/i.test(cleanedMain) && /^they\b/i.test(part))
                    && (new RegExp(`\\b(?:our|this\\s+(?:paper|work)(?:['’]s)?)\\s+${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b|\\bplaceholder\\b`, 'i').test(cleanedMain))
                    && (!/^they\b/i.test(part) || /\b(?:weights|checkpoints|models|datasets|benchmarks|codes|scripts|artifacts|resources|materials|demos|samples|and)\b/i.test(cleanedMain))) {
                    results.push(`${cleanedMain} (${part})`);
                }
            }
        }
        return results;
    }
    const cleaned = str.replace(SUBORDINATE_REL_PRIOR_WORK_RE, ' ').replace(/\s+/g, ' ').trim();
    return cleaned ? [cleaned] : [];
}

function isPriorWorkOnlyRetractionClause(mainClause, leadTransition, { allowAnaphoricFirstParty = false } = {}) {
    if (!PRIOR_WORK_CONTEXT_RE.test(mainClause)) return false;
    const anaphoricAlt = allowAnaphoricFirstParty ? '|(?:which|it|they)\\b' : '';
    const ownExplicitFirstPersonSubjectRe = new RegExp(
        `^${leadTransition}(?:(?:our|this\\s+(?:paper|work)(?:['’]s)?)\\s+${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b|We\\b[^.]{0,120}\\b(?:our|this\\s+(?:paper|work)(?:['’]s)?)\\s+${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b${anaphoricAlt})`,
        'i'
    );
    if (!ownExplicitFirstPersonSubjectRe.test(mainClause)) return true;
    const strippedPrepMod = mainClause.replace(PRIOR_WORK_PREP_MOD_RE, ' ');
    if (!PRIOR_WORK_CONTEXT_RE.test(strippedPrepMod)) return false;
    const strippedWithRel = mainClause.replace(PRIOR_WORK_PREP_MOD_WITH_REL_RE, ' ');
    if (!PRIOR_WORK_CONTEXT_RE.test(strippedWithRel) && hasExplicitResourceRetractionPredicate(strippedWithRel)) {
        return false;
    }
    return true;
}

function splitLeadingSubordinateClauseTagged(rawSentence) {
    const s = String(rawSentence || '').trim();
    const leadSub = /^(?:(?:(?:However|Unfortunately|Currently|At\s+present|In\s+practice|Also|Furthermore|Moreover|Additionally|Notably),?\s+|Note(?:\s+that\s+|\s*:\s*)))?(?:Since|Because|Although|Though|While|Whereas)\b/i.exec(s);
    if (!leadSub) return [{ text: s, isSubordinateLead: false }];
    const subPredRe = /\b(?:is|are|was|were|remains?|stays?|has|have|had|can|could|may|might|will|would|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|hasn[’']t|haven[’']t|did|do|does|don[’']t|doesn[’']t|didn[’']t|contains?|includes?|uses?|provides?|releases?|released|publishes?|published|shares?|shared|undergo(?:es|ing)?|awaits?|awaiting|under\s+(?:anonymous\s+)?review|private|public|available|unavailable|unreleased|withheld|pending|restricted)\b/i;
    const mainLeadRe = new RegExp(
        `^(?:(?:only|here|currently|presently|still|unfortunately|at\\s+present|for\\s+now|in\\s+practice),?\\s+)*(?:our|the|this|these|we|it|they|${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN})\\b`,
        'i'
    );
    const bodyStart = leadSub.index + leadSub[0].length;
    const commaRe = /,\s+/g;
    commaRe.lastIndex = bodyStart;
    let m;
    while ((m = commaRe.exec(s)) !== null) {
        const subBody = s.slice(bodyStart, m.index);
        const mainPart = s.slice(m.index + m[0].length).trim();
        if (subPredRe.test(subBody) && mainLeadRe.test(mainPart)) {
            const left = s.slice(0, m.index).trim();
            const out = [];
            if (left) out.push({ text: left, isSubordinateLead: true });
            if (mainPart) out.push({ text: mainPart, isSubordinateLead: false });
            return out.length ? out : [{ text: s, isSubordinateLead: false }];
        }
    }
    return [{ text: s, isSubordinateLead: false }];
}

function splitLeadingSubordinateClause(rawSentence) {
    return splitLeadingSubordinateClauseTagged(rawSentence).map(item => item.text);
}

function splitCoordinatedRetractionClauses(rawSentence) {
    const s = String(rawSentence || '').trim();
    if (!s) return [];
    const coordSplitRe = new RegExp(
        `[;；]\\s*|,\\s*(and|but)\\s+(?=(?:(?:only|here|currently|presently|still|unfortunately|for\\s+now)\\s+)?(?:our|the|this|these|we|${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN})\\b)|,\\s*(?=(?:while|whereas|though|although)\\s+(?:(?:only|here|currently|presently|still|unfortunately|for\\s+now)\\s+)?(?:our|the|this|these|we|${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN})\\b)`,
        'gi'
    );
    const leftPredRe = /\b(?:is|are|was|were|remains?|stays?|has|have|had|can|could|may|might|will|would|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|hasn[’']t|haven[’']t|did|do|does|don[’']t|doesn[’']t|didn[’']t|release[ds]?|available|unavailable|private|withheld|pending|restricted|open[- ]source[ds]?|publish(?:es|ed)?|provide[ds]?|share[ds]?|host(?:s|ed)?|contains?|includes?|under\s+(?:anonymous\s+)?review)\b/i;
    const parts = [];
    let prev = 0;
    for (const m of s.matchAll(coordSplitRe)) {
        const conj = String(m[1] || '').toLowerCase();
        const left = s.slice(prev, m.index).trim();
        // Do not split Oxford-comma subject lists ("dataset, models, and benchmarks are ...") before any verb.
        if (conj === 'and' && !leftPredRe.test(left)) continue;
        if (left) parts.push(left);
        prev = m.index + m[0].length;
    }
    const tail = s.slice(prev).trim();
    if (tail) parts.push(tail);
    return parts.length ? parts : [s];
}

function hasFollowingResourceRetraction(source, rawEnd, expectedFacets = null, options = {}) {
    const end = advanceEndPastUrlSuffix(source, rawEnd);
    const repoHostDemo = Boolean(options?.repoHostDemo);
    const demoPlatform = String(options?.demoPlatform || '');
    const startOffset = source[end] === '.' ? end + 1 : end;
    const paragraphEnd = source.indexOf('\n\n', startOffset);
    const nextParagraphStart = paragraphEnd < 0 ? -1
        : paragraphEnd + source.slice(paragraphEnd).match(/^\s*/)[0].length;
    const nextParagraphEnd = nextParagraphStart < 0 ? -1 : source.indexOf('\n\n', nextParagraphStart);
    const followingEnd = nextParagraphStart >= 0
        ? (nextParagraphEnd < 0 ? source.length : nextParagraphEnd)
        : (paragraphEnd < 0 ? source.length : paragraphEnd);
    const following = source.slice(end, Math.min(followingEnd, end + 600)).replace(/\r\n/g, '\n');
    const rawLines = following.split('\n');
    if (rawLines.length > 0) {
        // Strip a single trailing '/' that belongs to the normalized URL itself before stripping closing punctuation,
        // preserving separator slashes like ") / GitHub (placeholder)" for firstLineBarrier.
        rawLines[0] = rawLines[0].replace(/^\/(?=$|[)\]}.,;: \t])/, '').replace(/^[)\]}.,;: \t]+/, '');
        // If line 0 starts with benign parenthetical(s) followed by a badge separator (e.g. "(v1.0) | Code: private"),
        // strip the benign parenthetical so firstLineBarrier/splitBadgeBarSegments still see the badge bar.
        const strippedLeadingParen = rawLines[0].replace(/^(?:\([^)\n]{1,80}\)\s*)+/, '');
        if (strippedLeadingParen !== rawLines[0] && (/^[/|·•$]/.test(strippedLeadingParen) || SHARED_BADGE_LEAD_RE.test(strippedLeadingParen))) {
            rawLines[0] = strippedLeadingParen;
        }
    }
    const isStandaloneUrlLine = line => /^https?:\/\/\S+\.?$/i.test(line);
    const blocks = [];
    let currentLines = [];
    const flushCurrent = () => {
        if (currentLines.length > 0) {
            blocks.push(currentLines.join(' '));
            currentLines = [];
        }
    };
    for (let idx = 0; idx < rawLines.length; idx += 1) {
        const trimmed = rawLines[idx].trim();
        if (!trimmed) {
            flushCurrent();
            continue;
        }
        const firstLineBarrier = idx === 0 && (
            /^[/|·•$]/.test(trimmed)
            || /^\([^)\n]{1,80}\)$/.test(trimmed)
            || /^(?:\[[^\]\n]{1,40}\](?:\s*[|·•/]?\s*)?)+$/.test(trimmed)
            || /^[-–—,]?\s*[A-Za-z0-9\s]{1,24}:/.test(trimmed)
            || /https?:\/\//i.test(trimmed)
        );
        if (firstLineBarrier || isStandaloneUrlLine(trimmed) || isResourceBadgeOrTagLine(trimmed) || isUnpunctuatedResourceHeadingLine(trimmed)) {
            flushCurrent();
            if (firstLineBarrier || isResourceBadgeOrTagLine(trimmed)) {
                for (const seg of splitBadgeBarSegments(trimmed)) {
                    if (!/https?:\/\//i.test(seg)) blocks.push(seg);
                }
            } else {
                blocks.push(trimmed);
            }
            continue;
        }
        currentLines.push(trimmed);
    }
    flushCurrent();
    const sentences = blocks.flatMap(block => block.split(/(?<=[.!?])\s+/))
        .flatMap(splitLeadingSubordinateClause)
        .flatMap(splitCoordinatedRetractionClauses)
        .flatMap(splitLeadingSubordinateClause);
    return sentences.some(rawSentence => {
        const sentence = rawSentence.replace(/\s+/g, ' ').trim();
        if (!sentence) return false;
        const isBadge = SHARED_BADGE_LEAD_RE.test(sentence);
        const leadTransition = '(?:(?:(?:However|Note(?:\\s+that)?|Unfortunately|Currently|At\\s+present|For\\s+now|In\\s+practice|Only|Here|Although|Though|While|Whereas|Since|Because)[:,]?|Due\\s+to\\s+[^,.\\n]{1,60},)\\s+)*';
        const ownResource = isBadge
            || new RegExp(`^${leadTransition}(?:(?:our|this|the)\\s+)?${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b`, 'i').test(sentence)
            || new RegExp(`^${leadTransition}We\\b[^.]{0,120}\\b(?:(?:our|this|the)\\s+)?${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b`, 'i').test(sentence);
        if (!ownResource) return false;
        const activeClauses = isBadge ? [sentence] : extractActiveRetractionClauses(sentence);
        return activeClauses.some(mainClause => {
            if (!mainClause || (!isBadge && isPriorWorkOnlyRetractionClause(mainClause, leadTransition))) return false;
            if (Array.isArray(expectedFacets) && expectedFacets.length > 0) {
                if (isHostedDemoPlatformMismatch(mainClause, expectedFacets, demoPlatform, { repoHostDemo })) return false;
                const matchesExpected = expectedFacets.some(facet => retractionMatchesFacet(facet, mainClause, { repoHostDemo }));
                const matchesOther = Object.keys(RETRACTION_FACET_PATTERNS)
                    .some(facet => !expectedFacets.includes(facet) && retractionMatchesFacet(facet, mainClause, { repoHostDemo }));
                if (!matchesExpected && matchesOther) return false;
            }
            const externalOwnership = EXTERNAL_OWNERSHIP_RE.test(mainClause);
            if (externalOwnership) return true;
            return hasExplicitResourceRetractionPredicate(mainClause)
                || (isBadge && hasBadgeUnavailableOrVerblessNeg(mainClause));
        });
    });
}

function hasPrecedingResourceRetractionOrDeferral(source, limitPos, expectedFacets = null, options = {}) {
    if (limitPos <= 0) return false;
    const repoHostDemo = Boolean(options?.repoHostDemo);
    const demoPlatform = String(options?.demoPlatform || '');
    const precedingBlock = source.slice(Math.max(0, limitPos - 320), limitPos).replace(/\r\n/g, '\n').split('\n\n').at(-1) || '';
    if (!precedingBlock.trim()) return false;
    const isStandaloneUrlLine = line => /^https?:\/\/\S+\.?$/i.test(line);
    // Join wrapped prose lines into blocks; split badge bars on | · • / and inline headers and keep every non-URL badge segment.
    const blocks = [];
    let current = [];
    const flush = () => {
        if (current.length) {
            blocks.push(current.join(' '));
            current = [];
        }
    };
    for (const rawLine of precedingBlock.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed || isStandaloneUrlLine(trimmed) || isUnpunctuatedResourceHeadingLine(trimmed)) {
            flush();
            continue;
        }
        if (isResourceBadgeOrTagLine(trimmed)) {
            flush();
            for (const seg of splitBadgeBarSegments(trimmed)) {
                if (!/https?:\/\//i.test(seg)) blocks.push(seg);
            }
            continue;
        }
        current.push(trimmed);
    }
    flush();
    const clauses = blocks.flatMap(block => block.split(/(?<=[.!?。])\s+/))
        .flatMap(splitLeadingSubordinateClause)
        .flatMap(splitCoordinatedRetractionClauses)
        .flatMap(splitLeadingSubordinateClause);
    const leadTransition = '(?:(?:(?:However|Note(?:\\s+that)?|Unfortunately|Currently|At\\s+present|For\\s+now|In\\s+practice|Only|Here|Although|Though|While|Whereas|Since|Because)[:,]?|Due\\s+to\\s+[^,.\\n]{1,60},)\\s+)*';
    const ownResourceLeadRe = new RegExp(`^${leadTransition}(?:(?:our|this|the)\\s+)?${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b`, 'i');
    const weResourceLeadRe = new RegExp(`^${leadTransition}We\\b[^.]{0,120}\\b(?:(?:our|this|the)\\s+)?${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN}\\b`, 'i');
    return clauses.some(raw => {
        const clause = raw.replace(/\s+/g, ' ').trim();
        if (!clause) return false;
        const isBadge = SHARED_BADGE_LEAD_RE.test(clause);
        const isOwnOrBadge = isBadge || ownResourceLeadRe.test(clause) || weResourceLeadRe.test(clause);
        if (!isOwnOrBadge) return false;
        const activeClauses = isBadge ? [clause] : extractActiveRetractionClauses(clause);
        return activeClauses.some(mainClause => {
            if (!mainClause || (!isBadge && isPriorWorkOnlyRetractionClause(mainClause, leadTransition))) return false;
            if (Array.isArray(expectedFacets) && expectedFacets.length > 0) {
                if (isHostedDemoPlatformMismatch(mainClause, expectedFacets, demoPlatform, { repoHostDemo })) return false;
                const matchesExpected = expectedFacets.some(facet => retractionMatchesFacet(facet, mainClause, { repoHostDemo }));
                const matchesOther = Object.keys(RETRACTION_FACET_PATTERNS)
                    .some(facet => !expectedFacets.includes(facet) && retractionMatchesFacet(facet, mainClause, { repoHostDemo }));
                if (!matchesExpected && matchesOther) return false;
            }
            return hasExplicitResourceRetractionPredicate(mainClause)
                || (isBadge && hasBadgeUnavailableOrVerblessNeg(mainClause));
        });
    });
}

const RESERVED_HF_PREFIXES = new Set([
    'spaces', 'datasets', 'collections', 'papers', 'docs', 'blog', 'tasks', 'models',
    'organizations', 'join', 'login', 'signup', 'pricing', 'enterprise', 'settings',
    'inference-endpoints', 'chat', 'learn', 'course', 'posts', 'evaluate', 'api',
    'new', 'hub', 'support', 'terms-of-service', 'privacy'
]);

function classifyRepositoryHostFacets(url) {
    if (typeof url !== 'string' || /[\s\u0000-\u001f\u007f?#\\%]/.test(url)) return null;
    const schemeMatch = /^https:\/\/([^/]+)(\/.*)?$/i.exec(url);
    if (!schemeMatch) return null;
    const rawPath = schemeMatch[2] || '';
    if (/(?:^|\/)\.\.?(?:\/|$)/.test(rawPath) || /\/\//.test(rawPath)) return null;
    let parsed;
    try { parsed = new URL(url); } catch (_) { return null; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
        || parsed.search || parsed.hash) return null;
    if (schemeMatch[1].toLowerCase() !== parsed.hostname.toLowerCase()) return null;
    if (parsed.pathname.replace(/\/$/, '') !== rawPath.replace(/\/$/, '')) return null;
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.some(seg => !/^[A-Za-z0-9._~-]+$/.test(seg) || seg === '.' || seg === '..' || seg.endsWith('.'))) return null;
    const first = (segments[0] || '').toLowerCase();
    if (host === 'github.com' || host === 'gitlab.com') return segments.length >= 2 ? ['code'] : null;
    if (host === 'huggingface.co') {
        if (first === 'spaces') return segments.length >= 3 ? ['demo'] : null;
        if (first === 'datasets') return segments.length >= 3 ? ['dataset'] : null;
        if (first === 'collections') return segments.length >= 3 ? ['model'] : null;
        if (RESERVED_HF_PREFIXES.has(first)) return null;
        return segments.length >= 2 ? ['model'] : null;
    }
    if (host === 'modelscope.cn') {
        if (first === 'studios') return segments.length >= 3 ? ['demo'] : null;
        if (first === 'datasets') return segments.length >= 3 ? ['dataset'] : null;
        if (first === 'models') return segments.length >= 3 ? ['model'] : null;
        return null;
    }
    return null;
}

// 紧随作者第一人称公开发布句之后的独立 URL 块（例如 WeMM-Video：
// "We publicly release the WeMM-Video family along with our evaluation and reproduction pipeline...\nhttps://...\nhttps://..."）
function standaloneReleaseBlockMatch(source, token, start) {
    const url = normalizePaperSourceRepositoryToken(token);
    if (!url || /\r?\n/.test(token)) return null;
    const hostFacets = classifyRepositoryHostFacets(url);
    if (!hostFacets) return null;
    const end = start + token.length;
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const lineEndRaw = source.indexOf('\n', end);
    const lineEnd = lineEndRaw < 0 ? source.length : lineEndRaw;
    if (source.slice(lineStart, start).trim() !== '' || !/^\/?\.?\s*$/.test(source.slice(end, lineEnd))) {
        return null;
    }
    // 向上跳过至多 3 条连续独立 HTTPS URL 行，不得跨越空行
    let cursor = lineStart;
    let skippedUrls = 0;
    while (cursor > 0 && skippedUrls < 3) {
        const prevEnd = cursor - 1;
        const prevStart = source.lastIndexOf('\n', prevEnd - 1) + 1;
        const prevLine = source.slice(prevStart, prevEnd).trim();
        if (!prevLine) return null;
        if (/^https:\/\/[^\s<>"]+\.?$/i.test(prevLine)) {
            skippedUrls += 1;
            cursor = prevStart;
            continue;
        }
        break;
    }
    if (cursor <= 0) return null;
    const prevLineEnd = cursor - 1;
    const immediatePrevStart = source.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const immediatePrevLine = source.slice(immediatePrevStart, prevLineEnd).trim();
    // 紧邻独立 URL 块上方不得是孤立脚注编号行（如 "1"），且须以句末标点收尾
    if (!immediatePrevLine || /^\d{1,3}$/.test(immediatePrevLine) || !/[.!?。:：]$/.test(immediatePrevLine)) {
        return null;
    }
    const prevBlockStart = Math.max(0, prevLineEnd - 800);
    const prevChunk = source.slice(prevBlockStart, prevLineEnd);
    const blankSep = prevChunk.lastIndexOf('\n\n');
    const scanChunk = blankSep >= 0 ? prevChunk.slice(blankSep + 2) : prevChunk;
    const scanOffset = blankSep >= 0 ? prevBlockStart + blankSep + 2 : prevBlockStart;
    // 取紧贴 URL 块之前的最后一个完整句
    const trimmedScan = scanChunk.replace(/\s+$/, '');
    if (!trimmedScan) return null;
    const bodyWithoutFinalDot = trimmedScan.replace(/[.!?。]\s*$/, '');
    const lastBoundary = Math.max(
        bodyWithoutFinalDot.lastIndexOf('. '),
        bodyWithoutFinalDot.lastIndexOf('.\n'),
        bodyWithoutFinalDot.lastIndexOf('! '),
        bodyWithoutFinalDot.lastIndexOf('? '),
        bodyWithoutFinalDot.lastIndexOf('。')
    );
    const relSentenceStart = lastBoundary < 0 ? 0 : lastBoundary + (bodyWithoutFinalDot[lastBoundary] === '。' ? 1 : 2);
    const sentenceStart = scanOffset + relSentenceStart;
    const sentence = source.slice(sentenceStart, prevLineEnd).trim();
    if (!sentence || sentence.length > 600) return null;
    if (hasNotReleasedContext(sentence) || THIRD_PARTY_RESOURCE.test(sentence)
        || /\b(?:their|external|another)\b/i.test(sentence)
        || /\b(?:from|by)\s+[A-Z][A-Za-z0-9_-]+\b/.test(sentence)) return null;
    if (hasBlockingAttributionOrQuoteContext(source, sentenceStart, end)) return null;
    const firstPersonRelease = /^(?:(?:Furthermore|Additionally|Moreover|Specifically|Finally|In\s+addition),?\s+)?(?:To\s+[^,.]{1,80},\s+)?(?:Unlike\s+[^,.]{1,80},\s+)?(?:We|This\s+(?:paper|work))\s+(?:publicly\s+|openly\s+)?(?:release[ds]?|open[- ]source[ds]?|provide[ds]?|share[ds]?|publish(?:ed)?|make[s]?\s+(?:publicly\s+)?available)\b/i.test(sentence)
        || /^Our\s+(?:source[- ]code|codes?|codebase|models?|weights?|checkpoints?|datasets?|benchmarks?|evaluation|reproduction|pipeline|family)\b[^.\n]{0,160}\b(?:is|are)\s+(?:publicly\s+|openly\s+)?(?:available|released|open[- ]sourced)\b/i.test(sentence);
    if (!firstPersonRelease) return null;
    // 确认发布句实际覆盖该主机对应的资源形态，避免无关链接借用或错配类型
    const mentionsCode = /\b(?:codes?|codebase|source[- ]code|implementation|repo(?:sitory)?|pipeline|reproduction|evaluation|scripts?|toolkit|framework)\b/i.test(sentence);
    const mentionsModel = /\b(?:models?|weights?|checkpoints?|family|pretrained|backbone)\b/i.test(sentence);
    const mentionsDataset = /\b(?:datasets?|corpus|corpora|benchmarks?|annotations?|data\s+release)\b/i.test(sentence);
    const mentionsDemo = /\b(?:demos?|demo\s+page|audio\s+samples?|space|interactive\s+demo|showcase)\b/i.test(sentence);
    const parsedHost = new URL(url).hostname.toLowerCase();
    let matchedFacets = [];
    if (parsedHost === 'github.com' || parsedHost === 'gitlab.com') {
        if (mentionsCode) matchedFacets.push('code');
        if (mentionsDataset && !mentionsCode) matchedFacets.push('dataset');
    } else if (hostFacets.includes('demo')) {
        if (mentionsDemo || mentionsModel) matchedFacets.push('demo');
    } else if (hostFacets.includes('dataset')) {
        if (mentionsDataset) matchedFacets.push('dataset');
    } else if (hostFacets.includes('model')) {
        if (mentionsModel) matchedFacets.push('model');
    }
    if (!matchedFacets.length) return null;
    const blockRetractionOpts = {
        demoPlatform: demoPlatformForToken(url),
        repoHostDemo: Boolean(classifyRepositoryHostFacets(url)?.includes('code'))
    };
    if (hasFollowingResourceRetraction(source, end, matchedFacets, blockRetractionOpts)
        || matchedFacets.some(facet => hasInlineTailRetraction(source, end, facet, blockRetractionOpts))) return null;
    const quote = source.slice(sentenceStart, end);
    return { quote, facets: matchedFacets };
}

function isInHeaderOrAbstractRegion(source, start) {
    const introMatch = /(?:^|\n)[ \t]*(?:(?:1|I)\.?\s+Introduction\b|Introduction[ \t]*(?:\r?\n|$)|(?:2|II)\.?\s+Related\s+Work\b)/i.exec(source);
    if (introMatch) return start <= introMatch.index;
    if (source.length > 4000) return start <= 3500;
    return true;
}

function isBlockedByPrecedingColonHeading(source, lineStart, prefixBeforeLabel, explicitFirstPartyPrefix = false) {
    if (lineStart <= 1 || explicitFirstPartyPrefix) return false;
    const startsWithBadgeLabel = /^(?:[•·*-]\s*)?(?:Project\s+page|Homepage|Demo\s+page|Online\s+Demo|GitHub|GitLab|Hugging\s*Face(?:\s+Space)?|ModelScope|Source[- ]code|Codebase|Code|Models?|Datasets?|Demo|Paper|arXiv|Weights?|Checkpoints?|Repository|Repo|Space)\s*(?::|\()/i.test(prefixBeforeLabel)
        || /https?:\/\//i.test(prefixBeforeLabel);
    const looksLikeProseSentence = prefixBeforeLabel.split(/\s+/).length >= 4 && /\b[a-z]{3,}\b/.test(prefixBeforeLabel);
    if (prefixBeforeLabel && !startsWithBadgeLabel && /[.!?。]\s*$/.test(prefixBeforeLabel) && looksLikeProseSentence) {
        return false;
    }
    const isStackedBadgeOrUrlLine = trimmed => (
        /^(?:[•·*-]\s*)?(?:Project\s+page|Homepage|Demo\s+page|Online\s+Demo|GitHub|GitLab|Hugging\s*Face(?:\s+Space)?|ModelScope|Source[- ]code|Codebase|Code|Models?|Datasets?|Demo|Paper|arXiv|Weights?|Checkpoints?|Repository|Repo|Space)\s*(?::|\()/i.test(trimmed)
        || /^https?:\/\/\S+\.?$/i.test(trimmed)
        || (/https?:\/\//i.test(trimmed) && !/[.!?。]$/.test(trimmed))
    );
    const prevLines = source.slice(0, lineStart - 1).split('\n');
    let idx = prevLines.length - 1;
    let skipped = 0;
    let consecutiveBlanks = 0;
    while (idx >= 0 && skipped < 6) {
        const trimmed = prevLines[idx].trim();
        if (!trimmed) {
            consecutiveBlanks += 1;
            if (consecutiveBlanks > 1) return false;
            idx -= 1;
            continue;
        }
        if (isStackedBadgeOrUrlLine(trimmed) && !/:\s*$/.test(trimmed)) {
            consecutiveBlanks = 0;
            skipped += 1;
            idx -= 1;
            continue;
        }
        return /:\s*$/.test(trimmed)
            && !/^(?:abstract|we|our|this\s+(?:paper|work))\b/i.test(trimmed);
    }
    return false;
}

// 作者页眉/摘要末尾的简洁官方资源标签（如 "Project page: https://..."、"Project Page (https://...)"、
// "GitHub (https://github.com/...)"、"Hugging Face (https://huggingface.co/...)"）
function conciseAuthorResourceBadgeMatch(source, token, start) {
    if (!token || /\r?\n/.test(token)) return null;
    const end = advanceEndPastUrlSuffix(source, start + token.length);
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const beforeOnLine = source.slice(lineStart, start);
    if (hasBlockingAttributionOrQuoteContext(source, start, end)) return null;
    const lineEndRaw = source.indexOf('\n', end);
    const lineEnd = lineEndRaw < 0 ? source.length : lineEndRaw;
    const hasScopedBadgeBlocker = exactLabelStart => {
        const prefixOnLine = source.slice(lineStart, exactLabelStart);
        let lastSlashSep = -1;
        for (const sm of prefixOnLine.matchAll(/(?:^|\s)\/(?=\s|$)/g)) {
            lastSlashSep = sm.index + sm[0].length - 1;
        }
        const lastSentenceStop = Math.max(
            prefixOnLine.lastIndexOf('.'),
            prefixOnLine.lastIndexOf('!'),
            prefixOnLine.lastIndexOf('?'),
            prefixOnLine.lastIndexOf('。'),
            prefixOnLine.lastIndexOf(';'),
            prefixOnLine.lastIndexOf('；'),
            prefixOnLine.lastIndexOf('|'),
            prefixOnLine.lastIndexOf('·'),
            prefixOnLine.lastIndexOf('•'),
            lastSlashSep
        );
        const badgeClauseStart = lastSentenceStop >= 0 ? lineStart + lastSentenceStop + 1 : lineStart;
        const rawTail = source.slice(end, Math.min(lineEnd, end + 80));
        const tailStopMatch = /[|·•]|(?:\s+)\/(?=\s+)|https?:\/\/|(?:\s+)(?:GitHub|GitLab|Hugging\s*Face(?:\s+(?:Spaces?|Datasets?))?|ModelScope(?:\s+(?:Datasets?|Studios?|Models?))?|Source[- ]code|Codebase|Code|(?:Online\s+)?Demos?(?:\s+Page)?|Project\s+Page|Homepage|Paper|arXiv|PDF|Datasets?|Models?|Weights?|Checkpoints?|Repositor(?:y|ies)|Repo|Spaces?)\s*[:(]/i.exec(rawTail);
        const badgeTail = tailStopMatch ? rawTail.slice(0, tailStopMatch.index) : rawTail;
        const badgeClause = source.slice(badgeClauseStart, end) + badgeTail;
        return hasNotReleasedContext(badgeClause) || THIRD_PARTY_RESOURCE.test(badgeClause)
            || hasInlineUnavailableTag(badgeTail)
            || INLINE_CITATION_RE.test(badgeClause)
            || /\bet\s+al\b/i.test(badgeClause);
    };
    const inHeaderRegion = isInHeaderOrAbstractRegion(source, start);
    const normalizedRepoUrl = normalizePaperSourceRepositoryToken(token);
    const repoHostDemo = Boolean(normalizedRepoUrl && classifyRepositoryHostFacets(normalizedRepoUrl)?.includes('code'));
    const demoPlatform = demoPlatformForToken(token);
    // 1. Project page / Homepage / Demo page 标签
    const demoBadge = /(?:^|[.!?|$\s])(Project\s+[Pp]age|Homepage|Demo\s+[Pp]age|Online\s+Demo)\s*(?::\s*|\(\s*)$/i.exec(beforeOnLine);
    if (demoBadge) {
        if (hasFollowingResourceRetraction(source, end, ['demo'], { repoHostDemo, demoPlatform })
            || hasInlineTailRetraction(source, end, 'demo', { repoHostDemo, demoPlatform })) return null;
        const exactLabelStart = lineStart + beforeOnLine.lastIndexOf(demoBadge[1]);
        if (hasScopedBadgeBlocker(exactLabelStart)) return null;
        const prefixBeforeLabel = source.slice(lineStart, exactLabelStart).trim();
        const explicitFirstPartyPrefix = /(?:^|\s)(?:our|this\s+(?:paper|work)(?:'s|’s)?)$/i.test(prefixBeforeLabel);
        if (!inHeaderRegion && !explicitFirstPartyPrefix) return null;
        // 排除第三方命名主体引导（如 "ExternalLib Project Page:"、"Baseline project page:"）
        if (prefixBeforeLabel && !/(?:[.!?|$·•]\s*$|(?:^|\s)\/\s*$)/.test(prefixBeforeLabel)
            && !explicitFirstPartyPrefix
            && !(inHeaderRegion && /(?:^|\s)the$/i.test(prefixBeforeLabel))) {
            return null;
        }
        // 若上一非空行以冒号结尾且不像摘要/第一人称句（如 "AudioLDM2:\nProject page: https://..."），整条徽章栏均拒绝
        if (isBlockedByPrecedingColonHeading(source, lineStart, prefixBeforeLabel, explicitFirstPartyPrefix)) {
            return null;
        }
        const endWithSlash = (beforeOnLine.trimEnd().endsWith('(') && source[end] === '/' && source[end + 1] === ')') ? end + 1 : end;
        const closeParen = beforeOnLine.trimEnd().endsWith('(') && source[endWithSlash] === ')' ? 1 : 0;
        const quote = source.slice(exactLabelStart, endWithSlash + closeParen);
        if (hasPrecedingResourceRetractionOrDeferral(source, exactLabelStart, ['demo'], { repoHostDemo, demoPlatform })) return null;
        return { quote, facets: ['demo'] };
    }
    // 2. 文档页眉/摘要区的 GitHub / GitLab / Hugging Face / ModelScope 徽章
    const repoBadge = /(?:^|[|$\s·•])(GitHub|GitLab|Hugging\s*Face|ModelScope)\s*(?::\s*|\(\s*)$/i.exec(beforeOnLine);
    if (repoBadge) {
        const url = normalizePaperSourceRepositoryToken(token);
        if (!url) return null;
        const hostFacets = classifyRepositoryHostFacets(url);
        if (!hostFacets) return null;
        if (hasFollowingResourceRetraction(source, end, hostFacets, { demoPlatform })
            || hostFacets.some(facet => hasInlineTailRetraction(source, end, facet, { demoPlatform }))) return null;
        const parsed = new URL(url);
        const labelLower = repoBadge[1].toLowerCase().replace(/\s+/g, '');
        if ((labelLower === 'github' && parsed.hostname !== 'github.com')
            || (labelLower === 'gitlab' && parsed.hostname !== 'gitlab.com')
            || (labelLower === 'huggingface' && parsed.hostname !== 'huggingface.co')
            || (labelLower === 'modelscope' && parsed.hostname !== 'modelscope.cn')) {
            return null;
        }
        // 仅允许在文档开头/页眉/摘要区（1 Introduction 之前），禁止正文实验/相关工作误认第三方链接
        if (!inHeaderRegion) return null;
        const exactLabelStart = lineStart + beforeOnLine.lastIndexOf(repoBadge[1]);
        if (hasScopedBadgeBlocker(exactLabelStart)) return null;
        const prefixBeforeLabel = source.slice(lineStart, exactLabelStart).trim();
        if (prefixBeforeLabel && !/(?:[.!?|$·•]\s*$|(?:^|\s)\/\s*$)/.test(prefixBeforeLabel)
            && !/https?:\/\/[^)\s]+\)\s*(?:\$?\|\$?|[·•,/])?\s*$/.test(prefixBeforeLabel)) {
            return null;
        }
        // 若上一非空行以冒号结尾且不像摘要/第一人称句（如 "AudioLDM2:\nGitHub: https://..."），整条徽章栏均拒绝
        if (isBlockedByPrecedingColonHeading(source, lineStart, prefixBeforeLabel, false)) {
            return null;
        }
        if (hasPrecedingResourceRetractionOrDeferral(source, exactLabelStart, hostFacets, { demoPlatform })) return null;
        const endWithSlash = (beforeOnLine.trimEnd().endsWith('(') && source[end] === '/' && source[end + 1] === ')') ? end + 1 : end;
        const closeParen = beforeOnLine.trimEnd().endsWith('(') && source[endWithSlash] === ')' ? 1 : 0;
        const quote = source.slice(exactLabelStart, endWithSlash + closeParen);
        return { quote, facets: hostFacets };
    }
    return null;
}

function hasInlineTailRetraction(source, rawEnd, facet, { repoHostDemo = false, demoPlatform = '' } = {}) {
    const end = advanceEndPastUrlSuffix(source, rawEnd);
    const rawChunk = source.slice(end, Math.min(source.length, end + 260)).replace(/\r\n/g, '\n');
    const paraStop = rawChunk.indexOf('\n\n');
    const rawLines = (paraStop >= 0 ? rawChunk.slice(0, paraStop) : rawChunk).split('\n');
    const keptLines = [];
    for (let li = 0; li < rawLines.length; li++) {
        const line = rawLines[li];
        const trimmed = line.trim();
        if (li > 0) {
            if (!trimmed || /^https?:\/\/\S+\.?$/i.test(trimmed)
                || isResourceBadgeOrTagLine(trimmed) || isUnpunctuatedResourceHeadingLine(trimmed)) {
                break;
            }
        }
        keptLines.push(li === 0 ? line : trimmed);
    }
    const rawImmediateTail = keptLines.join(' ')
        .replace(/^\/(?=$|[)\]}.,;: \t>])/, '')
        .replace(/^[)\]>}]+/, '');
    let restTail = rawImmediateTail.trim();
    const inlineCandidates = [];
    const stripInlineParens = str => {
        let cur = str.trimStart();
        while (cur.startsWith('(')) {
            const pm = /^\(([^)\n]{1,120})\)/.exec(cur);
            if (!pm) break;
            if (pm[1].trim()) inlineCandidates.push(pm[1].trim());
            cur = cur.slice(pm[0].length).trimStart();
        }
        return cur;
    };
    restTail = stripInlineParens(restTail);
    const singleModPat = '(?:under\\s+(?:(?:the\\s+|an?\\s+)?(?:MIT|Apache|BSD|GPL|LGPL|AGPL|MPL|ISC|EPL|Unlicense|CC(?:[- ]?BY(?:[- ]?(?:NC|ND|SA))*|0)?)(?:\\s+licen[cs]e)?(?:[- ]?(?:[23]-clause|v?\\d+(?:\\.\\d+)*|zero))?(?:\\s+licen[cs]e)?|(?:the\\s+|an?\\s+)(?:(?!\\b(?:and|but|while|whereas|yet|though|although|review|embargo|construction|preparation|development)\\b)[A-Za-z0-9._\\s-]){1,36}\\s+licen[cs]e)|for\\s+(?:(?:non[- ]?commercial|research|academic|educational|personal)\\s+){1,3}(?:use|purposes?)(?:\\s+only)?)\\b\\s*';
    const afterModRaw = stripInlineParens(restTail.replace(new RegExp(`^(?:${singleModPat})+`, 'i'), ''));
    const tailStop = /(?<!\b(?:e\.g|i\.e|vs|secs?|figs?|tabs?|apps?|eqs?|nos?))\.(?!\d|[a-z])|[!?。]|https?:\/\/|[|·•]/i.exec(afterModRaw);
    const immediateTail = (tailStop ? afterModRaw.slice(0, tailStop.index) : afterModRaw).trim();
    const inlineConjunctionClauseRe = new RegExp(
        `^(?:and|but|yet|while|whereas|though|although)\\s+(`
            + `(?:(?:(?:it|they|this|that|we|(?:(?:our|this|the)\\s+)?${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN})\\s+)?`
            + `(?:(?:currently|still|yet|strictly|presently|unfortunately|also)\\s+)*`
            + `(?:is|are|remains?|stays?|will|would|may|might|has|have|did|do|don[’']t|does|doesn[’']t|plan(?:s|ned)?|intend(?:s|ed)?|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|hasn[’']t|haven[’']t|didn[’']t)\\b.+)`
            + `|(?:(?:currently|still|yet|strictly|presently|unfortunately|also)\\s+)*(?:private|withheld|internal\\s+only|unreleased|unavailable|placeholder|${RETRACTION_RESTRICTED_PREDICATE}|coming\\s+soon|pending(?:\\s+(?:approval|review|release))?|tbd|under\\s+(?:anonymous\\s+)?review|to\\s+be\\s+released|closed[- ]source|proprietary|confidential|(?:not|no\\s+longer)\\s+(?:(?:yet|currently|still)\\s+)*(?:public(?:ly)?|openly|available|released|open[- ]sourced|shared|accessible|made\\s+(?:publicly\\s+|openly\\s+)?available))\\b.*`
        + `)$`,
        'i'
    );
    if (immediateTail) {
        const clauseMatch = /^[,;；]\s*(.+)$/.exec(immediateTail) || inlineConjunctionClauseRe.exec(immediateTail);
        if (clauseMatch && clauseMatch[1].trim()) inlineCandidates.push(clauseMatch[1].trim());
    }
    const inlineLeadTransition = '(?:(?:and|however|note(?:\\s+that)?|unfortunately|currently|at\\s+present|for\\s+now|in\\s+practice|only|here|although|though|while|whereas|since|because|but|yet|also)[,:]?\\s+)*';
    const strongSubClauseSplitRe = /\s*,\s*(?:and|but|yet)\s+|\s*,\s*(?=(?:while|whereas|though|although)\b)|\s+(?=(?:while|whereas|though|although)\b)/i;
    const explicitSubjectCoordSplitRe = new RegExp(
        `\\s+(?:and|but|yet)\\s+(?=(?:our|the|this|these|we|which|most|many|existing|prior|previous|current|traditional|conventional|commercial|other|baselines?|${RETRACTION_OPTIONAL_ADJ}${RETRACTION_RESOURCE_NOUN})\\b)`,
        'i'
    );
    const sameSubjectCoordPredSplitRe = /\s+(?:and|but|yet)\s+(?=(?:is|are|was|were|remains?|stays?|hosts?|provides?|will|would|may|might|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|has(?:n[’']t)?|have(?:n[’']t)?|also|currently|still|strictly|presently|unfortunately|not|no\s+longer|private|withheld|internal\s+only|unreleased|unavailable|placeholder|restricted|closed[- ]source|proprietary|confidential|(?:owned|maintained|provided|developed|released|published|created|hosted)\s+by|belongs?\s+to)\b)/i;
    const anaphoricOrVerblessTargetRe = new RegExp(
        `^${inlineLeadTransition}(?:(?:which|it|they)\\b|(?:(?:currently|still|yet|strictly|presently|unfortunately|also)\\s+)*(?:is|are|remains?|stays?|will|would|may|might|cannot|can[’']t|won[’']t|isn[’']t|aren[’']t|has(?:n[’']t)?|have(?:n[’']t)?|did(?:n[’']t)?|do(?:n[’']t|es(?:n[’']t)?)?|not|no\\s+longer|private|withheld|internal\\s+only|unreleased|unavailable|placeholder|${RETRACTION_RESTRICTED_PREDICATE}|coming\\s+soon|pending|tbd|under\\s+(?:anonymous\\s+)?review|to\\s+be\\s+released|closed[- ]source|proprietary|confidential|belongs?\\s+to|(?:owned|maintained|provided|developed|released|published|created|hosted)\\s+by)\\b)`,
        'i'
    );
    const nonResourcePaperSubjRe = /^(?:(?:while|whereas|though|although|since|because|but|yet|and)\s+)?(?:our|this|the)\s+(?:paper|manuscript|work|submission|preprint|article|draft)\b/i;
    const hasNonMatchingExplicitSubject = segText => {
        if (nonResourcePaperSubjRe.test(segText)) return true;
        if (isPriorWorkOnlyRetractionClause(segText, inlineLeadTransition, { allowAnaphoricFirstParty: true })) return true;
        if (isHostedDemoPlatformMismatch(segText, [facet], demoPlatform, { repoHostDemo })) return true;
        const cleaned = segText.replace(PRIOR_WORK_PREP_MOD_WITH_REL_RE, ' ');
        const matchesExp = retractionMatchesFacet(facet, cleaned, { repoHostDemo });
        const matchesOth = Object.keys(RETRACTION_FACET_PATTERNS)
            .some(otherFacet => otherFacet !== facet && retractionMatchesFacet(otherFacet, cleaned, { repoHostDemo }));
        return !matchesExp && matchesOth;
    };
    return inlineCandidates.some(rawGroup => (
        rawGroup.split(/\s*[;；]\s*/).filter(Boolean).some(semiGroup => {
            const subClauses = semiGroup
                .split(strongSubClauseSplitRe)
                .flatMap(seg => seg.split(explicitSubjectCoordSplitRe))
                .flatMap(seg => (hasNonMatchingExplicitSubject(seg) ? [seg] : seg.split(sameSubjectCoordPredSplitRe)))
                .flatMap(seg => splitLeadingSubordinateClauseTagged(seg))
                .filter(item => item.text);
            let prevClauseOtherSubject = false;
            return subClauses.some(({ text: rawCandidate, isSubordinateLead }) => {
                const activeClauses = extractActiveRetractionClauses(rawCandidate);
                let clauseHadOtherSubject = false;
                let clauseHadNonResourcePaperSubj = false;
                let clauseHadOtherResourceSubject = false;
                let clauseHadExpectedSubject = false;
                const hit = activeClauses.some(candidateTail => {
                    if (!candidateTail) return false;
                    if (nonResourcePaperSubjRe.test(candidateTail)) {
                        clauseHadOtherSubject = true;
                        clauseHadNonResourcePaperSubj = true;
                        return false;
                    }
                    if (isPriorWorkOnlyRetractionClause(candidateTail, inlineLeadTransition, { allowAnaphoricFirstParty: true })) {
                        clauseHadOtherSubject = true;
                        clauseHadOtherResourceSubject = true;
                        return false;
                    }
                    if (isHostedDemoPlatformMismatch(candidateTail, [facet], demoPlatform, { repoHostDemo })) {
                        clauseHadOtherSubject = true;
                        clauseHadOtherResourceSubject = true;
                        return false;
                    }
                    const facetText = candidateTail.replace(PRIOR_WORK_PREP_MOD_WITH_REL_RE, ' ');
                    const matchesExpected = retractionMatchesFacet(facet, facetText, { repoHostDemo });
                    const matchesOther = Object.keys(RETRACTION_FACET_PATTERNS)
                        .some(otherFacet => otherFacet !== facet && retractionMatchesFacet(otherFacet, facetText, { repoHostDemo }));
                    if (!matchesExpected && matchesOther) {
                        clauseHadOtherSubject = true;
                        clauseHadOtherResourceSubject = true;
                    } else if (matchesExpected) {
                        clauseHadExpectedSubject = true;
                    }
                    if (!(EXTERNAL_OWNERSHIP_RE.test(candidateTail)
                        || hasInlineUnavailableTag(candidateTail)
                        || INLINE_VERBLESS_NEG_RE.test(candidateTail)
                        || hasExplicitResourceRetractionPredicate(candidateTail))) {
                        return false;
                    }
                    if (anaphoricOrVerblessTargetRe.test(candidateTail)) {
                        if (prevClauseOtherSubject) {
                            return false;
                        }
                        return true;
                    }
                    return !(!matchesExpected && matchesOther);
                });
                if (!(isSubordinateLead && clauseHadNonResourcePaperSubj && !clauseHadOtherResourceSubject)) {
                    if (clauseHadOtherSubject && !clauseHadExpectedSubject) prevClauseOtherSubject = true;
                    else if (clauseHadExpectedSubject) prevClauseOtherSubject = false;
                }
                return hit;
            });
        })
    ));
}

// 明确的第一方试听/视频/演示声明（含 LaTeXML 脚注 "For <Model>11\n 1\n Audio samples can be found at <url>"、
// "Full videos ... on the project page at <url>"、"illustrated in the accompanying demo video11\n 1\n <url>"）
function authorFirstPartyDemoQuote(source, token, start) {
    if (!token || /\r?\n/.test(token)) return '';
    const end = advanceEndPastUrlSuffix(source, start + token.length);
    if (hasBlockingAttributionOrQuoteContext(source, start, end)) return '';
    const normalizedRepoUrl = normalizePaperSourceRepositoryToken(token);
    const repoHostDemo = Boolean(normalizedRepoUrl && classifyRepositoryHostFacets(normalizedRepoUrl)?.includes('code'));
    const demoPlatform = demoPlatformForToken(token);
    if (hasFollowingResourceRetraction(source, end, ['demo'], { repoHostDemo, demoPlatform })
        || hasInlineTailRetraction(source, end, 'demo', { repoHostDemo, demoPlatform })) return '';
    const trailingDot = source[end] === '.' ? 1 : 0;
    const before = source.slice(Math.max(0, start - 320), start);
    const hasCitationOrThirdParty = text => /\bet\s+al\b|\bother\s+authors?\b/i.test(text) || INLINE_CITATION_RE.test(text);
    const rawAfter = source.slice(end, Math.min(source.length, end + 80));
    const afterLineStop = rawAfter.search(/\r?\n|https?:\/\/|[|·•]/);
    const afterClause = afterLineStop >= 0 ? rawAfter.slice(0, afterLineStop) : rawAfter;
    const afterSentStop = afterClause.search(/(?<!\b(?:e\.g|i\.e|vs|al|figs?|tabs?|secs?|apps?))\.(?!\d|[a-z])|[!?。]/i);
    const postUrlTail = afterSentStop >= 0 ? afterClause.slice(0, afterSentStop + 1) : afterClause;
    if (hasCitationOrThirdParty(postUrlTail)) return '';
    // 1. LaTeXML 脚注内明确试听声明（例如 "For UMelCodec11\n 1\n Audio samples can be found at <url>."）
    const footnoteAudio = /(?:^|\n)([^\n.!?]{0,80}\d{1,3}[ \t]*\r?\n[ \t]*\d{1,3}[ \t]*\r?\n[ \t]*(?:(?:Our|The)\s+)?(?:audio|speech|music|sound|video|demo)\s+(?:samples?|examples?|demos?)\s+(?:are|can\s+be)\s+(?:publicly\s+)?(?:available|found|accessed|heard|listened\s+to|viewed)\s+(?:at|on)\s+)$/i.exec(before);
    if (footnoteAudio) {
        const quoteStart = start - footnoteAudio[1].length;
        const quote = source.slice(quoteStart, end + trailingDot);
        if (!RESOURCE_NOT_RELEASED.test(quote) && !THIRD_PARTY_RESOURCE.test(quote) && !hasCitationOrThirdParty(quote)) return quote;
    }
    // 1b. LaTeXML 脚注内 "illustrated in the accompanying demo video11\n 1\n <url>"
    const footnoteAccompanying = /(?:^|\n|[.!?]\s+)([^\n.!?]{0,160}\b(?:illustrated|shown|demonstrated|presented|available)\s+(?:in|on|at)\s+(?:the|our)\s+accompanying\s+(?:demo\s+(?:video|page|website)|project\s+page|supplementary\s+(?:demo|video))\d{1,3}[ \t]*\r?\n[ \t]*\d{1,3}[ \t]*\r?\n[ \t]*)$/i.exec(before);
    if (footnoteAccompanying) {
        const quoteStart = start - footnoteAccompanying[1].length;
        const quote = source.slice(quoteStart, end + trailingDot);
        if (!RESOURCE_NOT_RELEASED.test(quote) && !THIRD_PARTY_RESOURCE.test(quote) && !hasCitationOrThirdParty(quote)) return quote;
    }
    // 2. 句内明确 "Full videos ... are on the/our project page at <url>." 或 "samples ... on the/our project page at <url>."
    const sentenceStartOffset = Math.max(
        before.lastIndexOf('. '), before.lastIndexOf('.\n'), before.lastIndexOf('.\r\n'), before.lastIndexOf('\n')
    );
    const relStart = sentenceStartOffset < 0 ? 0
        : before[sentenceStartOffset] === '\n' ? sentenceStartOffset + 1
            : before.startsWith('.\r\n', sentenceStartOffset) ? sentenceStartOffset + 3
                : sentenceStartOffset + 2;
    const sentencePrefix = before.slice(relStart);
    const fullSentence = source.slice(start - before.length + relStart, end + trailingDot);
    if (!RESOURCE_NOT_RELEASED.test(fullSentence) && !THIRD_PARTY_RESOURCE.test(fullSentence)
        && !hasCitationOrThirdParty(fullSentence)) {
        if (/(?:full\s+videos?|(?:audio|speech|music|video|listening|demo)\s+(?:samples?|examples?|clips?|demos?))\b(?:[^.\n]|\.\d){0,140}\b(?:are|can\s+be)\s+(?:(?:publicly\s+)?(?:available|found|viewed|heard)\s+)?on\s+(?:our|the)\s+project\s+page\s+at\s+$/i.test(sentencePrefix)) {
            return fullSentence;
        }
        if (/\b(?:illustrated|shown|demonstrated|presented|available)\s+(?:in|on|at)\s+(?:the|our)\s+accompanying\s+(?:demo\s+(?:video|page|website)|project\s+page|supplementary\s+(?:demo|video))\s+(?:at\s+)?$/i.test(sentencePrefix)) {
            return fullSentence;
        }
    }
    return '';
}

function authorAudioExamplesContext(source, token, start) {
    const paragraphStart = source.lastIndexOf('\n\n', start - 1);
    const lower = paragraphStart < 0 ? 0 : paragraphStart + 2;
    const previous = source.slice(0, lower).trimEnd().split(/\n\s*\n/).at(-1) || '';
    const context = localContextWindow(source, start) + source.slice(start, start + token.length);
    // TXT 可能没有空行。保留局部 3 段完整引入文字，不能由最后一句覆盖否定或未来承诺，也不被远处的 Related Work 误伤。
    if (hasUnclosedFenceBefore(source, start)
        || RESOURCE_NOT_RELEASED.test(context)
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

const THIRD_PARTY_POST_FACET_WHITELIST = '(?:Git[Hh]ub\\.com|Git[Ll]ab\\.com|Hugging[Ff]ace\\.co|Model[Ss]cope\\.cn|Git[Hh]ub(?:\\.?\\d{1,3})?|Git[Ll]ab(?:\\.?\\d{1,3})?|Hugging\\s*[Ff]ace(?:\\.?\\d{1,3})?|Model[Ss]cope(?:\\.?\\d{1,3})?|CC-BY(?:-(?:NC|ND|SA|4\\.0|3\\.0|2\\.0|\\d+(?:\\.\\d+)?))*|CC0|Apache-2\\.0|BSD-[23]-Clause|GPL-v?[23](?:\\.0)?|LGPL-v?[23](?:\\.0)?|AGPL-v?[23](?:\\.0)?|MPL-2(?:\\.0)?|Text-to-Speech|Speech-to-Text|Speech-to-Speech|Text-to-Audio|Audio-to-Text|Audio-Visual|Speech-Language|Audio-Language|Audio-Text|MIT|Apache|BSD|GPL|LGPL|AGPL|MPL|CC|Python|PyTorch|TensorFlow|JAX|ONNX|CUDA|CPU|GPU|API|CLI|SDK|FP16|BF16|INT8|ASR|TTS|LLM|VLM|MLLM|Section|Appendix|Table|Figure|Fig|Tab|Sec|Availability|Release|Statement|Overview|Details|Summary|English|Chinese|Japanese|Korean|French|German|Spanish|Arabic|Mandarin|Multilingual|(?:Audio|Speech|Music|Video|Text|Image|Voice|Sound)(?!\\s+(?!Models?|Data|Datasets?|Corpus|Corpora|Benchmarks?|Demos?|Samples?|Code|Codes|Recognition|Synthesis|Processing|Enhancement|Separation|Generation|Understanding|Language|Token)[A-Z])|Docker|Linux|Ubuntu|Windows|macOS|Conda|Pip|Google\\s*Colab|Colab|Zenodo|Kaggle|OpenReview|ArXiv|arXiv|BibTeX|JSON|YAML|CSV|WAV|MP3|FLAC)';
const THIRD_PARTY_COORD_NOUN_WHITELIST = `(?:${THIRD_PARTY_POST_FACET_WHITELIST.slice(3, -1)}|Code|Codes|Model|Models|Weight|Weights|Checkpoint|Checkpoints|Data|Dataset|Datasets|Corpus|Corpora|Benchmark|Benchmarks|Demo|Demos|Script|Scripts|Implementation|Software|Repo|Repository|Repositories|Artifact|Artifacts|Material|Materials|Toolkit|Toolkits|Evaluation|Training|Inference|Pretrained|Pre-trained|Official|Source|Project|Website|Page|Samples|Examples|Clips|Annotations|Labels|Prompts|Recipes|Configs|Configurations|Instructions|Documentation|Appendices|Supplementary)`;
const WHITELIST_END_BOUNDARY = '(?:\\d{1,3})?(?![A-Za-z0-9_-]|\\.[A-Za-z])';
const VENUE_YEAR_EXCLUSION_LA = '(?!(?:Interspeech|INTERSPEECH|ICASSP|NeurIPS|NEURIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|DCASE|ISMIR|WASPAA|ASRU|SLT|EUSIPCO|SIGGRAPH|CHI|ACM|IEEE|arXiv|ArXiv|ARXIV|Preprint|PREPRINT|Camera[- ]Ready|CAMERA[- ]READY|Released|Updated|Published|Accessed|Retrieved|Version|Copyright)\\b)';
const NUMERIC_CITATION_LIST_PAT = '\\d+(?:\\s*[-–]\\s*\\d+)?(?:\\s*,\\s*\\d+(?:\\s*[-–]\\s*\\d+)?)*';
const INLINE_CITATION_RE = new RegExp(`\\[${NUMERIC_CITATION_LIST_PAT}\\]|\\[${VENUE_YEAR_EXCLUSION_LA}[A-Z][A-Za-z-]+\\s*(?:[Ee]t\\s+[Aa]l\\.?|&|[Aa]nd)?[^\\]\\n]{0,28}\\b(?:19|20)\\d{2}[a-z]?\\]|\\(${VENUE_YEAR_EXCLUSION_LA}[A-Z][A-Za-z-]+\\s*(?:[Ee]t\\s+[Aa]l\\.?|&|[Aa]nd)?[^)\\n]{0,20}\\b(?:19|20)\\d{2}[a-z]?\\)`);
const TRAILING_URL_CITATION_RE = new RegExp(`\\[RESOURCE_URL\\]\\s*\\)?,?(?:\\s+[Uu]nder\\s+(?:(?:[Tt]he\\s+|[Aa]n?\\s+)?(?:MIT|Apache|BSD|GPL|LGPL|AGPL|MPL|ISC|EPL|Unlicense|CC(?:[- ]?BY(?:[- ]?(?:NC|ND|SA))*|0)?)(?:\\s+[Ll]icen[cs]e)?(?:[- ]?(?:[23]-clause|[Vv]?\\d+(?:\\.\\d+)*|zero))?(?:\\s+[Ll]icen[cs]e)?|(?:[Tt]he\\s+|[Aa]n?\\s+)[A-Za-z0-9._\\s-]{1,36}\\s+[Ll]icen[cs]e))?\\s*,?\\s*(?:\\[${NUMERIC_CITATION_LIST_PAT}\\]|\\[${VENUE_YEAR_EXCLUSION_LA}[A-Z][A-Za-z-]+\\s*(?:[Ee]t\\s+[Aa]l\\.?|&|[Aa]nd)?[^\\]\\n]{0,28}\\b(?:19|20)\\d{2}[a-z]?\\]|\\(${VENUE_YEAR_EXCLUSION_LA}[A-Z][A-Za-z-]+\\s*(?:[Ee]t\\s+[Aa]l\\.?|&|[Aa]nd)?[^)\\n]{0,20}\\b(?:19|20)\\d{2}[a-z]?\\))`);
const POST_FACET_PREP_PROPER_RE = new RegExp(`\\b(?:of|from|by|for|in|on|with|through|via)\\s+(?:(?:the|an?)\\s+)?(?:(?!and\\b|or\\b)[a-z-]+\\s+){0,3}(?!${THIRD_PARTY_POST_FACET_WHITELIST}${WHITELIST_END_BOUNDARY})[A-Z][A-Za-z0-9._-]*\\b`);
const POST_FACET_APPOSITIVE_PROPER_RE = new RegExp(`^(?:\\s+|\\s*\\()(?!${THIRD_PARTY_POST_FACET_WHITELIST}${WHITELIST_END_BOUNDARY})[A-Z][A-Za-z0-9._-]{1,}\\b`);
const COORD_THIRD_PARTY_PROPER_RE = new RegExp(`\\band\\s+(?:(?:the|an?)\\s+)?(?:[a-z-]+\\s+){0,2}(?!${THIRD_PARTY_COORD_NOUN_WHITELIST}${WHITELIST_END_BOUNDARY})(?![A-Z]{2,5}\\s+(?:analys(?:is|es)|experiments?|decoding|preprocessing|processing|classification|detection|recognition|estimation|modeling|prediction|tasks?|studies?)\\b)[A-Z][A-Za-z0-9._-]{1,}\\b(?!\\s+(?:source[- ]code|codes?|codebase|implementation|software|repositor(?:y|ies)|repo|models?|weights?|checkpoints?|data|datasets?|corpus|corpora|benchmarks?|demos?|demonstration|artifacts?|reproducibility|reproduction|scripts?|toolkits?)\\b)`);
const POST_URL_BY_FROM_PROPER_RE = new RegExp(`\\b(?:by|from|through|via)\\s+(?:(?:the|an?)\\s+)?(?:(?!and\\b|or\\b)[a-z-]+\\s+){0,3}(?!${THIRD_PARTY_POST_FACET_WHITELIST}${WHITELIST_END_BOUNDARY})[A-Z][A-Za-z0-9._-]*\\b`);

function hasThirdPartyPostFacetOrCitation(subject, firstFacetEnd, explicitAuthor, subjectBeforeVerb = null) {
    if (INLINE_CITATION_RE.test(subject)) {
        return true;
    }
    if (!explicitAuthor && Number.isFinite(firstFacetEnd)) {
        const afterFacet = subject.slice(firstFacetEnd);
        if (POST_FACET_PREP_PROPER_RE.test(afterFacet)) {
            return true;
        }
        if (POST_FACET_APPOSITIVE_PROPER_RE.test(afterFacet)) {
            return true;
        }
        const preVerbAfterFacet = subjectBeforeVerb !== null
            ? subjectBeforeVerb.slice(firstFacetEnd)
            : afterFacet;
        if (COORD_THIRD_PARTY_PROPER_RE.test(preVerbAfterFacet)) {
            return true;
        }
    }
    return false;
}

function isCleanElidedLocativeClause(clauseText) {
    const text = String(clauseText || '').replace(/\s+/g, ' ').trim();
    if (!text || hasNotReleasedContext(text) || THIRD_PARTY_RESOURCE.test(text)
        || hasInlineUnavailableTag(text) || hasExplicitResourceRetractionPredicate(text)
        || /\bet\s+al\b/i.test(text)) {
        return false;
    }
    const locMatch = /^(.*?)\s+(?:(?:is|are)\s+)?(?:at|on|in|via)\s+[(\[]?(?:https?:\/\/\S+|\[RESOURCE_URL\](?:\/?[?#][^\s<>"'\]})>,;]*)?)[\/)\].,;:!?]*(?:\s+(?:under\s+(?:(?:the\s+|an?\s+)?(?:MIT|Apache|BSD|GPL|LGPL|AGPL|MPL|ISC|EPL|Unlicense|CC(?:[- ]?BY(?:[- ]?(?:NC|ND|SA))*|0)?)(?:\s+licen[cs]e)?(?:[- ]?(?:[23]-clause|v?\d+(?:\.\d+)*|zero))?(?:\s+licen[cs]e)?|(?:the\s+|an?\s+)[A-Za-z0-9.\s-]{1,40}\s+licen[cs]e)|\((?:MIT|Apache|BSD|GPL|LGPL|CC[- ]?BY|MPL)[^)\n]{0,30}\)))?[.,;:!?]*$/i.exec(text)
        || /^(.*?(?:source[- ]code|codes?|codebase|implementation|software|repositor(?:y|ies)|repo|models?|weights?|checkpoints?|data|datasets?|corpus|corpora|benchmarks?|demos?|demonstration|artifacts?|reproducibility|reproduction|materials?))(\d{1,2})\2\s+\2\s+[(\[]?(?:https?:\/\/\S+|\[RESOURCE_URL\](?:\/?[?#][^\s<>"'\]})>,;]*)?)[\/)\].,;:!?]*$/i.exec(text);
    if (!locMatch) return false;
    const subject = locMatch[1]
        .replace(ATTACHED_FOOTNOTE_RESOURCE_LABEL, '')
        .replace(TRAILING_FOOTNOTE_RESOURCE_LABEL, '')
        .replace(TRAILING_FOOTNOTE_CAP_RESOURCE_LABEL, '')
        .trim();
    if (!subject) return false;
    const facetHits = RESOURCE_FACET_SPECS.map(([, pattern]) => pattern.exec(subject)).filter(Boolean);
    if (!facetHits.length) return false;
    const firstFacetHit = facetHits.reduce((best, cur) => (cur.index < best.index ? cur : best));
    const firstFacetIdx = firstFacetHit.index;
    const firstFacetEnd = firstFacetHit.index + firstFacetHit[0].length;
    const prefix = subject.slice(0, firstFacetIdx);
    const unknownSubject = prefix.replace(/\b(?:our|the|this|these|all|both|we|authors?|work|paper|project|pre-?trained|trained|pruned|distilled|quantized|fine-?tuned|compressed|full|complete|official|accompanying|associated|corresponding|source|audio|speech|music|video|evaluation|training|inference|online)\b/gi, '')
        .replace(/(?:本文|本研究|我们|作者|的)|[\s:：,，]/gu, '');
    const explicitAuthor = /^(?:our\b|we\b|the\s+authors?\b|本文|本研究|我们|作者)/i.test(prefix.trim());
    if (hasThirdPartyPostFacetOrCitation(subject, firstFacetEnd, explicitAuthor)) return false;
    return !unknownSubject || explicitAuthor;
}

function classifySingleClauseFirstPartyFacets(rawClause) {
    const quote = String(rawClause || '')
        // 先还原 PDF 行末连字符断词（如 Ex-\ntraction -> Extraction、avail-\nable -> available），避免拆词触发未知主体误判。
        .replace(/([A-Za-z]{2,})-\r?\n[ \t]*([a-z]{2,})/g, '$1$2')
        .replace(/\bavail-\s*able\b/gi, 'available')
        .replace(/\s+/g, ' ').trim()
        // 剥离行首编号小节标题（如 "6 Open Access Statement Our ..."）与行首脚注编号（如 "1All accompanying code..." / "1 1All ..."）。
        .replace(/^\d+(?:\.\d+)*\s+(?:Open\s+Access|Data\s+Availability|Code\s+Availability|Reproducibility|Availability|Artifact)(?:\s+Statement)?\s+(?=(?:Our|We|The\s+authors?|All|Code|Data|Dataset|This)\b)/i, '')
        .replace(/^(?:\d{1,2}\s+){1,2}(?=[A-Z])/, '')
        .replace(/^\d{1,2}(?=(?:All|Our|The|We|Code|Data|Dataset|Benchmark|Model|Source|Accompanying|Full|Project)\b)/, '')
        .replace(ATTACHED_FOOTNOTE_RESOURCE_LABEL, '')
        .replace(TRAILING_FOOTNOTE_RESOURCE_LABEL, '')
        .replace(TRAILING_FOOTNOTE_CAP_RESOURCE_LABEL, '');
    if (!quote || hasNotReleasedContext(quote) || THIRD_PARTY_RESOURCE.test(quote)
        || hasInlineUnavailableTag(quote) || hasExplicitResourceRetractionPredicate(quote)
        || /\bet\s+al\b/i.test(quote)
        || !RESOURCE_AFFIRMATIVE.test(quote)
        || /\b(?:quotes?|quoted)\b.*\b(?:following|statement|declaration)\b|(?:引用以下声明)/i.test(quote)) return ['third_party'];
    // Strip URL query/fragment tails (e.g. "#code-and-data") before facet matching so URL slugs never mint extra facets.
    const facetSource = quote.replace(/(?:https?:\/\/[^\s<>"'\]})>,;]+|\[RESOURCE_URL\](?:\/?[?#][^\s<>"'\]})>,;]*)?)/gi, '[RESOURCE_URL]');
    const facetMatches = RESOURCE_FACET_SPECS.map(([type, pattern]) => ({ type, match: pattern.exec(facetSource) }))
        .filter(item => item.match);
    const firstFacetHit = facetMatches.length
        ? facetMatches.reduce((best, cur) => (cur.match.index < best.match.index ? cur : best)).match
        : null;
    const firstFacet = firstFacetHit ? firstFacetHit.index : Infinity;
    const firstFacetEnd = firstFacetHit ? (firstFacetHit.index + firstFacetHit[0].length) : Infinity;
    const prefix = Number.isFinite(firstFacet) ? facetSource.slice(0, firstFacet) : '';
    // 明确命名的外部项目不能只因“code available”被归为作者资源。
    // 无归属前缀的“Code is available”保留；无法确认的命名主体按其他链接处理。
    const unknownSubject = prefix.replace(/\b(?:our|the|this|these|all|both|an?|and|we|authors?|have|has|work|paper|project|release|released|releases|provide|provided|provides|publish|published|publishes|share|shared|shares|open[- ]source(?:d)?|publicly|openly|also|freely|hereby|jointly|make|made|pre-?trained|trained|pruned|distilled|quantized|fine-?tun(?:e[ds]?|ing)|compressed|full|complete|official|accompanying|associated|corresponding|source|audio|speech|music|video|evaluation|training|inference|online|extraction|analysis|prompting|benchmark(?:ing)?|preprocessing|postprocessing|reproduction|reproducibility|experiment(?:al)?|implementation|scripts?|anonymized|clinician[- ]labell?ed|relevant)\b/gi, '')
        .replace(/(?:本文|本研究|我们|作者|现已|已|公开|提供|的)|[\s:：,，]/gu, '');
    const prefixTrimmed = prefix.trim();
    const hasThirdPartyPossessive = /\b(?:their|his|her|its)\b/i.test(prefixTrimmed)
        || /\b(?:on|at|in|from|via)\s+their\b|\b(?:another|other)\s+(?:projects?|authors?|works?|repositor(?:y|ies))\b/i.test(facetSource);
    const hasPrefixConsumptionVerb = /\b(?:uses?|used|using|utiliz(?:e[ds]?|ing)|adopt(?:s|ed|ing)?|reus(?:e[ds]?|ing)|builds?\s+on|download(?:s|ed|ing)?|obtain(?:s|ed|ing)?|load(?:s|ed|ing)?|evaluat(?:e[ds]?|ing)|compar(?:e[ds]?|ing)|follow(?:s|ed|ing)?|employ(?:s|ed|ing)?|leverag(?:e[ds]?|ing))\b/i.test(prefixTrimmed);
    const explicitAuthor = !hasThirdPartyPossessive && !hasPrefixConsumptionVerb && (
        /^(?:our\b|the\s+authors?[’']?\b|本文|本研究|我们|作者)/i.test(prefixTrimmed)
        || /^(?:we|the\s+authors?)\s+(?:(?:have|has)\s+)?(?:(?:also|hereby|publicly|openly|freely|jointly)\s+){0,2}(?:release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]source[ds]?|make|made)\b/i.test(prefixTrimmed)
        || /^(?:we|the\s+authors?)\b[^,.;]{0,80}\bour$/i.test(prefixTrimmed)
    );
    if (hasThirdPartyPossessive) return ['third_party'];
    if (unknownSubject && !explicitAuthor) return ['third_party'];
    if (Number.isFinite(firstFacetEnd)) {
        const urlIdx = facetSource.indexOf('[RESOURCE_URL]');
        const clauseThroughUrl = urlIdx >= 0
            ? facetSource.slice(0, urlIdx + '[RESOURCE_URL]'.length)
            : facetSource;
        const postUrlTail = urlIdx >= 0
            ? facetSource.slice(urlIdx + '[RESOURCE_URL]'.length)
            : '';
        if (INLINE_CITATION_RE.test(facetSource) || TRAILING_URL_CITATION_RE.test(facetSource)) {
            return ['third_party'];
        }
        if (!explicitAuthor && postUrlTail && POST_URL_BY_FROM_PROPER_RE.test(postUrlTail)) {
            return ['third_party'];
        }
        const predOrUrlMatch = /\b(?:is|are|was|were|will|can|has|have|provide[sd]?|release[sd]?|publish(?:ed)?|share[sd]?|open[- ]source[sd]?|make[sd]?|made|hosted|available|accessible|found)\b|\[RESOURCE_URL\]/i.exec(facetSource.slice(firstFacetEnd));
        const subjectBeforeVerb = predOrUrlMatch
            ? facetSource.slice(0, firstFacetEnd + predOrUrlMatch.index)
            : facetSource;
        if (hasThirdPartyPostFacetOrCitation(clauseThroughUrl, firstFacetEnd, explicitAuthor, subjectBeforeVerb)) return ['third_party'];
    }
    const facets = facetMatches.map(item => item.type);
    if (facets.length) return facets;
    return GENERIC_FIRST_PARTY_RESOURCE.test(quote) ? ['reproduction'] : ['third_party'];
}

function isValidFirstPartyLeadClause(leadClause) {
    const text = String(leadClause || '').replace(/\s+/g, ' ').trim();
    if (!text || /\b(?:but|while|whereas|however|although|though|yet)\b|[;；]|但是|然而|但|而/i.test(text)
        || hasNotReleasedContext(text) || THIRD_PARTY_RESOURCE.test(text)
        || hasInlineUnavailableTag(text) || hasExplicitResourceRetractionPredicate(text)
        || /\bet\s+al\b/i.test(text)) {
        return false;
    }
    const urlTokenRe = /(?:https?:\/\/\S+|(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/\S+)/gi;
    const urlMatches = [...text.matchAll(urlTokenRe)];
    if (urlMatches.length === 0) {
        const facets = classifySingleClauseFirstPartyFacets(text);
        return facets.some(facet => facet !== 'third_party');
    }
    const purePrepOnlyRe = /^(?:(?:at|on|in|via|from)(?:\s+(?:GitHub|GitLab|Hugging\s*Face|ModelScope))?(?:\s+at)?(?:\s+(?:(\d{1,2})\1\s+\1|\d{1,2}))?|(?:(\d{1,2})\2\s+\2))?$/i;
    const cleanPostUrlTailRe = /^[.,;:!?)\s]*(?:under\s+(?:(?:the\s+|an?\s+)?(?:MIT|Apache|BSD|GPL|LGPL|AGPL|MPL|ISC|EPL|Unlicense|CC(?:[- ]?BY(?:[- ]?(?:NC|ND|SA))*|0)?)(?:\s+licen[cs]e)?(?:[- ]?(?:[23]-clause|v?\d+(?:\.\d+)*|zero))?(?:\s+licen[cs]e)?|(?:the\s+|an?\s+)[A-Za-z0-9._\s-]{1,40}\s+licen[cs]e)|\((?:MIT|Apache|BSD|GPL|LGPL|CC[- ]?BY|MPL)[^)\n]{0,30}\)|for\s+(?:non[- ]?commercial|research|academic)\s+use)?[.,;:!?]*$/i;
    const hasPredicateIn = chunk => RESOURCE_AFFIRMATIVE.test(chunk) || /\b(?:is|are|was|were)\s+(?:at|on|in|hosted|available|released)\b/i.test(chunk);
    const hasValidCompoundMultiUrlSubjects = chunk => {
        const chunkUrlRe = /(?:https?:\/\/\S+|(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/\S+)/gi;
        const chunkUrlMatches = [...String(chunk || '').matchAll(chunkUrlRe)];
        if (chunkUrlMatches.length < 2) return true;
        // Compound subject with >=2 URLs before a single end-predicate (e.g. "Our code at URL1 and AudioLDM2 at URL2 are publicly available"):
        // verify every subsequent URL's local subject before the URL is either empty/prepositional or a clean first-party resource facet.
        for (let uIdx = 1; uIdx < chunkUrlMatches.length; uIdx += 1) {
            const prevUrlEnd = chunkUrlMatches[uIdx - 1].index + chunkUrlMatches[uIdx - 1][0].length;
            const between = chunk.slice(prevUrlEnd, chunkUrlMatches[uIdx].index).trim();
            const subjectRaw = between
                .replace(/^(?:,\s*(?:and\s+)?|and\s+)/i, '')
                .replace(/\s+(?:at|on|in|via|from)(?:\s+(?:GitHub|GitLab|Hugging\s*Face|ModelScope))?$/i, '')
                .replace(ATTACHED_FOOTNOTE_RESOURCE_LABEL, '')
                .replace(TRAILING_FOOTNOTE_RESOURCE_LABEL, '')
                .replace(TRAILING_FOOTNOTE_CAP_RESOURCE_LABEL, '')
                .replace(/\b\d{1,3}\b/g, '')
                .replace(/\s+/g, ' ').trim();
            if (!subjectRaw || purePrepOnlyRe.test(subjectRaw)) continue;
            const facetHits = RESOURCE_FACET_SPECS.map(([, pattern]) => pattern.exec(subjectRaw)).filter(Boolean);
            if (!facetHits.length) return false;
            const firstFacetHit = facetHits.reduce((best, cur) => (cur.index < best.index ? cur : best));
            const firstFacetIdx = firstFacetHit.index;
            const firstFacetEnd = firstFacetHit.index + firstFacetHit[0].length;
            const prefix = subjectRaw.slice(0, firstFacetIdx);
            const unknownSubj = prefix.replace(/\b(?:our|the|this|these|all|both|we|authors?|work|paper|project|pre-?trained|trained|full|complete|official|accompanying|associated|corresponding|source|audio|speech|music|video|evaluation|training|inference|online)\b/gi, '')
                .replace(/(?:本文|本研究|我们|作者|的)|[\s:：,，\d]/gu, '');
            const explicitAuthor = /^(?:our\b|we\b|the\s+authors?\b|本文|本研究|我们|作者)/i.test(prefix.trim());
            if ((unknownSubj && !explicitAuthor) || hasThirdPartyPostFacetOrCitation(subjectRaw, firstFacetEnd, explicitAuthor)) {
                return false;
            }
        }
        return true;
    };
    const parts = [];
    let prevEnd = 0;
    for (const sm of text.matchAll(/(?:\s*,\s*(?:and\s+)?|\s+and\s+)/gi)) {
        const chunk = text.slice(prevEnd, sm.index).trim();
        urlTokenRe.lastIndex = 0;
        const hasUrlInChunk = urlTokenRe.test(chunk);
        const afterSplit = text.slice(sm.index + sm[0].length);
        urlTokenRe.lastIndex = 0;
        const hasUrlLater = urlTokenRe.test(afterSplit);
        const hasPredicate = hasPredicateIn(chunk);
        const hasPredicateLater = hasPredicateIn(afterSplit);
        if ((hasUrlInChunk && (parts.length > 0 || hasPredicate))
            || (!hasUrlInChunk && hasPredicate && (hasUrlLater || hasPredicateLater))) {
            parts.push(chunk);
            prevEnd = sm.index + sm[0].length;
        }
    }
    const tail = text.slice(prevEnd).trim();
    if (tail) parts.push(tail);
    if (parts.length <= 1) {
        if (!hasValidCompoundMultiUrlSubjects(text)) return false;
        const facets = classifySingleClauseFirstPartyFacets(text);
        return facets.some(facet => facet !== 'third_party');
    }
    if (!hasValidCompoundMultiUrlSubjects(parts[0])
        || !classifySingleClauseFirstPartyFacets(parts[0]).some(facet => facet !== 'third_party')) {
        return false;
    }
    const singleUrlRe = /(?:https?:\/\/\S+|(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/\S+)/i;
    for (let i = 1; i < parts.length; i += 1) {
        const part = parts[i];
        if (!hasValidCompoundMultiUrlSubjects(part)) return false;
        const firstUrl = singleUrlRe.exec(part);
        if (!firstUrl) {
            if (hasNotReleasedContext(part) || THIRD_PARTY_RESOURCE.test(part)
                || hasInlineUnavailableTag(part) || hasExplicitResourceRetractionPredicate(part)) {
                return false;
            }
            if (cleanPostUrlTailRe.test(part)) continue;
            if (!classifySingleClauseFirstPartyFacets(part).some(facet => facet !== 'third_party')) {
                return false;
            }
            continue;
        }
        const beforeUrl = part.slice(0, firstUrl.index).trim();
        const afterUrl = part.slice(firstUrl.index + firstUrl[0].length).trim();
        if (purePrepOnlyRe.test(beforeUrl)) {
            if (afterUrl && !cleanPostUrlTailRe.test(afterUrl)) return false;
            continue;
        }
        const normalizedPart = `${part.slice(0, firstUrl.index)}[RESOURCE_URL]${part.slice(firstUrl.index + firstUrl[0].length)}`;
        const isCleanElided = !RESOURCE_AFFIRMATIVE.test(part) && isCleanElidedLocativeClause(normalizedPart);
        const isFirstParty = classifySingleClauseFirstPartyFacets(part).some(facet => facet !== 'third_party');
        if (!isCleanElided && !isFirstParty) return false;
    }
    return true;
}

function classifyPaperSourceResourceFacets(sourceQuote) {
    if (isAuthorAudioExamplesStatement(sourceQuote)) return ['demo'];
    const quote = String(sourceQuote || '').replace(/\bavail-\s*able\b/gi, 'available')
        .replace(/\s+/g, ' ').trim()
        .replace(ATTACHED_FOOTNOTE_RESOURCE_LABEL, '');
    // Elided-verb or multi-URL coordinated clause carried alongside an earlier URL clause:
    // find the LAST `, and` / `,` / `and` split whose left contains an earlier URL and whose right
    // contains `[RESOURCE_URL]` (with no other URL) and a non-prepositional subject before `[RESOURCE_URL]`.
    // Never fall through to full-sentence classification when an independent URL2 clause is detected,
    // so URL1 facets and retracted/third-party lead clauses can never leak onto URL2.
    const urlTokenRe = /(?:https?:|github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)/i;
    const fullUrlTokenRe = /(?:https?:\/\/[^\s<>"'\]})>,;]+|(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/[^\s<>"'\]})>,;]+)/gi;
    const purePrepBeforePlaceholderRe = /^(?:(?:at|on|in|via|from)(?:\s+(?:GitHub|GitLab|Hugging\s*Face|ModelScope))?(?:\s+at)?(?:\s+(?:(\d{1,2})\1\s+\1|\d{1,2}))?|(?:(\d{1,2})\2\s+\2))$/i;
    if (quote.includes('[RESOURCE_URL]') && urlTokenRe.test(quote)) {
        const placeholderIdx = quote.indexOf('[RESOURCE_URL]');
        let lastPriorUrlEnd = -1;
        for (const um of quote.matchAll(fullUrlTokenRe)) {
            if (um.index < placeholderIdx) {
                lastPriorUrlEnd = um.index + um[0].length;
            }
        }
        const splitRe = /(?:\s*,\s*(?:and\s+)?|\s+and\s+)/gi;
        const candidateSplits = [];
        for (const sm of quote.matchAll(splitRe)) {
            if (sm.index >= placeholderIdx) break;
            if (lastPriorUrlEnd >= 0 && sm.index < lastPriorUrlEnd) continue;
            const left = quote.slice(0, sm.index).trim();
            const right = quote.slice(sm.index + sm[0].length).trim();
            if (!left || !right) continue;
            if (!urlTokenRe.test(left)) continue;
            if (!right.includes('[RESOURCE_URL]') || urlTokenRe.test(right)) continue;
            const beforePlaceholder = right.slice(0, right.indexOf('[RESOURCE_URL]')).trim();
            if (!beforePlaceholder || purePrepBeforePlaceholderRe.test(beforePlaceholder)) continue;
            candidateSplits.push({ left, right, afterUrlGap: lastPriorUrlEnd >= 0 ? quote.slice(lastPriorUrlEnd, sm.index).trim() : '' });
        }
        if (candidateSplits.length) {
            // Take the FIRST split after the last prior URL (preserving compound URL2 subjects like
            // "the model files and audio samples at [RESOURCE_URL]"). Only advance past an internal "and"
            // inside URL1's own trailing modifier (e.g. "at URL1 for training and evaluation, and ...").
            const chosen = candidateSplits.find((sp, idx) => {
                if (idx === candidateSplits.length - 1) return true;
                if (!sp.afterUrlGap || /^[.,;:!?)\]]*$/.test(sp.afterUrlGap)) return true;
                if (RESOURCE_AFFIRMATIVE.test(sp.right)) return true;
                return isValidFirstPartyLeadClause(sp.left) && isCleanElidedLocativeClause(sp.right);
            }) || candidateSplits[0];
            const { left: leadClause, right: url2Clause } = chosen;
            const url2HasFiniteVerb = /\b(?:is|are|was|were|has|have|can|we\s+(?:(?:also|publicly|openly|freely|hereby|jointly)\s+){0,2}(?:release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]source[ds]?))\b/i.test(url2Clause);
            if (RESOURCE_AFFIRMATIVE.test(url2Clause) && url2HasFiniteVerb) {
                return classifySingleClauseFirstPartyFacets(url2Clause);
            }
            if (isValidFirstPartyLeadClause(leadClause) && isCleanElidedLocativeClause(url2Clause)) {
                const url2FacetSource = url2Clause
                    .replace(/\[RESOURCE_URL\](?:\/?[?#][^\s<>"'\]})>,;]*)?/g, '[RESOURCE_URL]')
                    .replace(TRAILING_FOOTNOTE_RESOURCE_LABEL, '')
                    .replace(TRAILING_FOOTNOTE_CAP_RESOURCE_LABEL, '');
                const url2Facets = RESOURCE_FACET_SPECS.filter(([, pattern]) => pattern.test(url2FacetSource)).map(([type]) => type);
                if (url2Facets.length) return url2Facets;
            }
            return ['third_party'];
        }
    }
    return classifySingleClauseFirstPartyFacets(quote);
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
    // Unpunctuated standalone section/appendix headings (e.g. "Data Availability\n", "Appendix A Implementation Details\n")
    // separate preceding headings from the actual release sentence so heading words never leak into subject/facet matching.
    // Deliberately excludes bare "Abstract" because footnoteBoundary handles document-top Abstract with verified author lines.
    const beforeSectionHeadingRe = /(?:^|\n)[ \t]*(?:(?!(?:19|20)\d{2}\b)\d{1,2}(?:\.\d+)*\.?[ \t]+[A-Z][^\n.:;!?]{1,90}|(?:Appendix|APPENDIX)[ \t]+[A-Z0-9]+(?:\.\d+)*\.?(?:[ \t]+[^\n.:;!?]{1,90})?|[A-Z]\.\d+(?:\.\d+)*\.?[ \t]+[A-Z][^\n.:;!?]{1,90}|(?:Introduction|INTRODUCTION|Related\s+Work|RELATED\s+WORK|Background|BACKGROUND|Method(?:ology|s)?|METHOD(?:OLOGY|S)?|Experiments?|EXPERIMENTS?|Evaluation|EVALUATION|Results?|RESULTS?|Discussion|DISCUSSION|Conclusion(?:s)?|CONCLUSION(?:S)?|Acknowledgment(?:s)?|ACKNOWLEDGMENT(?:S)?|Acknowledgements?|ACKNOWLEDGEMENTS?|Limitations?|LIMITATIONS?|Ethics(?:\s+Statement)?|ETHICS(?:\s+STATEMENT)?|Broader\s+Impact|BROADER\s+IMPACT|Impact\s+Statement|IMPACT\s+STATEMENT|Reproducibility(?:\s+Statement)?|REPRODUCIBILITY(?:\s+STATEMENT)?|(?:Code|Data|Dataset|Model|Artifact|Resource|Software)(?:\s+(?:and|&|\/)\s+(?:Code|Data|Dataset|Model|Artifact|Resource|Software))*\s+Availability(?:\s+Statement)?|Availability(?:\s+Statement)?|Implementation\s+Details|Experimental\s+Setup|References|REFERENCES|Appendix|APPENDIX))[ \t]*\r?\n(?=[ \t]*(?![a-z])\S)/g;
    for (const hm of before.matchAll(beforeSectionHeadingRe)) {
        previousBoundaries.push(hm.index + hm[0].length - 1);
    }
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
    // Mid-sentence LaTeXML footnote splice: `<word>NN\n N\n The source code is available at ...`
    // (e.g. `au11\n 1\n The source code is available at ...`, `interpretable11\n 1\n Code is available at ...`).
    const midSentenceLatexMlFootnoteBoundary = /[A-Za-z.)](\d{1,2})\1[ \t]*\r?\n[ \t]*\1[ \t]*\r?\n[ \t]*(?=(?:(?:The|Our)\s+(?:[Ss]ource[- ]code|[Cc]odes?|[Cc]odebase|[Ii]mplementation|[Mm]odels?(?:\s+weights?)?|[Ww]eights?|[Cc]heckpoints?|[Dd]atasets?|[Bb]enchmarks?|(?:[Aa]udio\s+)?[Dd]emos?|[Pp]roject\s+page|[Aa]rtifacts?|[Rr]eproduction)|(?:Source[- ]code|Codes?|Codebase|Implementation|Models?(?:\s+weights?)?|Weights?|Checkpoints?|Datasets?|Benchmarks?|(?:Audio\s+)?Demos?|Project\s+page|Artifacts?|Reproduction))\b[^\n]*\b(?:is|are)\s+(?:publicly\s+|openly\s+)?(?:available|released|hosted|provided)\s+(?:at|on)\b|We\s+(?:have\s+)?(?:(?:also|publicly|openly|freely)\s+)?(?:release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]source[ds]?)\b)/gu;
    for (const match of before.matchAll(midSentenceLatexMlFootnoteBoundary)) {
        const absoluteBoundary = start - before.length + match.index;
        const paragraphStart = source.lastIndexOf('\n\n', absoluteBoundary);
        const introStart = paragraphStart < 0 ? 0 : paragraphStart + 2;
        const introText = source.slice(introStart, absoluteBoundary);
        if (RESOURCE_NOT_RELEASED.test(introText)
            || /\b(?:quotes?|quoted|states|stated|says?|said|writes?|wrote|reported|according\s+to|following|as\s+follows|authors?|et\s+al|documentation|announcement|this\s+sentence|excerpt|mentioned|noted|claimed|describes?|provides?|contains)\b|(?:引用|以下声明|其他作者|另一篇工作)/i.test(introText)) {
            continue;
        }
        previousBoundaries.push(match.index + match[0].length - 1);
    }
    const afterSectionOrCaptionBreak = /(?:\n(?:(?!(?:19|20)\d{2}\b)\d{1,2}(?:\.\d+)*\.?\s+[A-Z]|[A-Z]\.\d+\s+[A-Z]|(?:Abstract|ABSTRACT|Introduction|INTRODUCTION|Related\s+Work|RELATED\s+WORK|Background|BACKGROUND|Method(?:ology|s)?|METHOD(?:OLOGY|S)?|Experiments?|EXPERIMENTS?|Evaluation|EVALUATION|Results?|RESULTS?|Conclusion(?:s)?|CONCLUSION(?:S)?|References|REFERENCES|Appendix|APPENDIX|Index\s+Terms|INDEX\s+TERMS|Keywords|KEYWORDS)\b|(?:Figure|Fig\.?|Table|Tab\.?|FIGURE|TABLE)\s+\d+\s*[:.]|\d{1,3}\n(?:Figure|Fig\.?|Table|Tab\.?|\d{1,2}\s+[A-Z]|Introduction|Abstract))|\s+(?:Index\s+Terms|INDEX\s+TERMS|Keywords|KEYWORDS)\s*[—–:-])/.exec(after);
    const nextBoundaries = [after.indexOf('. '), after.indexOf('.\n'), after.indexOf('。'), after.indexOf('！'),
        after.indexOf('？'), after.indexOf(';'), after.indexOf('；'), after.indexOf('\n\n'),
        afterSectionOrCaptionBreak ? afterSectionOrCaptionBreak.index : -1]
        .filter(index => index >= 0);
    const lower = start - before.length + Math.max(-1, ...previousBoundaries) + 1;
    const upper = end + (nextBoundaries.length ? Math.min(...nextBoundaries) : after.length);
    const sentence = source.slice(lower, upper);
    const relativeStart = start - lower;
    const relativeEnd = end - lower;
    // and 只有带新主语或连接两个不同链接子句时才切分；Data and code 这类同一声明仍作为一组。
    const urlLikeRe = /(?:https?:|github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)/i;
    const purePrepBeforeUrl2Re = /^(?:(?:at|on|in|via|from)(?:\s+(?:GitHub|GitLab|Hugging\s*Face|ModelScope))?(?:\s+at)?(?:\s+(?:(\d{1,2})\1\s+\1|\d{1,2}))?|(?:(\d{1,2})\2\s+\2))$/i;
    const boundary = /[,;；]|\b(?:but|while|whereas|however|although|though|yet|and)\b|(?:但是|然而|但|而)/giu;
    let clauseStart = 0;
    let leadStart = 0;
    let clauseEnd = sentence.length;
    let lastAndSplitBeforeTarget = null;
    const namedClauseRe = /^\s*(?:(?:and|but)\s+)?(?!(?:GitHub|GitLab|Hugging\s*Face|ModelScope)\b)[A-Z][A-Za-z0-9._-]*(?:['’]s)?(?:\s+[A-Za-z0-9._-]+(?:['’]s)?){0,2}(?:\s*\([^()\n]{1,24}\))?\s+(?:is|are|was|were|can|has|have|provides?|releases?|hosts?|offers?|open[- ]sources?)\b/;
    const hasLeftPredicate = seg => RESOURCE_AFFIRMATIVE.test(seg) || /\b(?:is|are|was|were)\b/i.test(seg);
    const hasClauseVerbRe = /\b(?:is|are|was|were|has|have|had|can|could|will|would|may|might|should|release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]source[ds]?|make[sd]?|made|hosts?|offers?|train(?:s|ed)?|evaluat(?:e[ds]?)|us(?:e[ds]?)|propos(?:e[ds]?)|present(?:s|ed)?|introduc(?:e[ds]?)|show[ns]?|achiev(?:e[ds]?)|outperform(?:s|ed)?|build[s]?|built|develop(?:s|ed)?|collect(?:s|ed)?|curat(?:e[ds]?)|design(?:s|ed)?|conduct(?:s|ed)?|perform(?:s|ed)?|adopt(?:s|ed)?|employ(?:s|ed)?|leverag(?:e[ds]?)|compar(?:e[ds]?)|obtain(?:s|ed)?|download(?:s|ed)?|follow(?:s|ed)?|fine-?tun(?:e[ds]?)|adapt(?:s|ed)?)\b/i;
    const hasRightFinitePredRe = /\b(?:is|are|was|were|has|have|can|will|release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]sources|make[sd]?|made|hosts?|offers?)\b|\b(?:we|authors?)\s+(?:(?:also|publicly|openly|freely|hereby)\s+){0,2}open[- ]source(?:d)?\b/i;
    const introLeadPhraseRe = /^\s*(?:in|to|for|with|upon|after|before|following|using|through|by|as|since|because|although|while|whereas|given|motivated|inspired|building|unlike|compared\s+(?:to|with)|contrast(?:ing)?\s+with|despite|instead\s+of|beyond|besides|furthermore|moreover|additionally|specifically|finally|notably|importantly)\b/i;
    const postUrlCitation = new RegExp(`^\\/?\\s*\\)?,?(?:\\s+[Uu]nder\\s+[A-Za-z0-9._\\s-]{1,36})?\\s*,?\\s*(?:\\(${VENUE_YEAR_EXCLUSION_LA}[A-Z][A-Za-z-]+\\s*(?:[Ee]t\\s+[Aa]l\\.?|&|[Aa]nd)?[^()\\n]{0,20}\\b(?:19|20)\\d{2}[a-z]?\\)|\\[${NUMERIC_CITATION_LIST_PAT}\\]|\\[${VENUE_YEAR_EXCLUSION_LA}[A-Z][A-Za-z-]+\\s*(?:[Ee]t\\s+[Aa]l\\.?|&|[Aa]nd)?[^\\]\\n]{0,28}\\b(?:19|20)\\d{2}[a-z]?\\])`).exec(sentence.slice(relativeEnd));
    const postUrlCitationEnd = postUrlCitation ? relativeEnd + postUrlCitation[0].length : relativeEnd;
    for (const match of sentence.matchAll(boundary)) {
        if (/^and$/i.test(match[0])) {
            const afterAnd = sentence.slice(match.index + match[0].length);
            const leftBeforeAnd = sentence.slice(clauseStart, match.index);
            const leftFromLead = sentence.slice(leadStart, match.index);
            const isPostCommaConj = lastAndSplitBeforeTarget !== null && !leftBeforeAnd.trim();
            const urlCheckLeft = isPostCommaConj ? leftFromLead : leftBeforeAnd;
            const hasPriorUrl = urlLikeRe.test(urlCheckLeft);
            const nextUrlMatch = urlLikeRe.exec(afterAnd);
            const rightBeforeUrl = nextUrlMatch ? afterAnd.slice(0, nextUrlMatch.index).trim() : '';
            const startsWithPronounSubject = /^\s+(?:our|we|the|their|its)\b/i.test(afterAnd);
            const hasNewSubject = startsWithPronounSubject && (
                hasPriorUrl
                || (hasClauseVerbRe.test(leftFromLead) && hasRightFinitePredRe.test(rightBeforeUrl || afterAnd))
            );
            const separatesIndependentUrlClause = hasPriorUrl
                && Boolean(nextUrlMatch)
                && Boolean(rightBeforeUrl)
                && !purePrepBeforeUrl2Re.test(rightBeforeUrl);
            const startsNamedClause = hasLeftPredicate(leftFromLead) && namedClauseRe.test(afterAnd);
            if (!hasNewSubject && !separatesIndependentUrlClause && !startsNamedClause) continue;
            if (match.index + match[0].length <= relativeStart && hasPriorUrl) {
                lastAndSplitBeforeTarget = match.index;
            }
        }
        // URL 前的逗号可能只是“code, dataset, and weights”或“at URL1, URL2, and URL3”枚举，不能丢掉前面的资源。
        // 前面已有另一链接且逗号后带有独立新主语（而非空/纯 and/纯介词），或后面明确开始独立主语时，才把它当作声明边界。
        if (match[0] === ',' && match.index < relativeStart) {
            const afterComma = sentence.slice(match.index + 1);
            const leftBeforeComma = sentence.slice(leadStart, match.index);
            const hasPriorUrl = urlLikeRe.test(leftBeforeComma);
            if (hasPriorUrl) {
                const nextUrlMatch = urlLikeRe.exec(afterComma);
                const rightBeforeUrl = nextUrlMatch ? afterComma.slice(0, nextUrlMatch.index).trim() : '';
                const rightWithoutAnd = rightBeforeUrl.replace(/^and\b\s*/i, '').trim();
                const isBareUrlListItem = Boolean(nextUrlMatch)
                    && (!rightWithoutAnd || purePrepBeforeUrl2Re.test(rightWithoutAnd));
                if (isBareUrlListItem) continue;
            } else {
                const nextUrlMatch = urlLikeRe.exec(afterComma);
                const rightBeforeUrl = nextUrlMatch ? afterComma.slice(0, nextUrlMatch.index).trim() : '';
                const startsWeClause = /^\s*(?:(?:and|but)\s+)?we\b/i.test(afterComma)
                    && hasRightFinitePredRe.test(rightBeforeUrl || afterComma);
                const startsIndependentNewSubj = /^\s*(?:(?:and|but)\s+)?(?:our|the|their|its)\b/i.test(afterComma)
                    && (hasClauseVerbRe.test(leftBeforeComma) || (clauseStart === leadStart && introLeadPhraseRe.test(leftBeforeComma)))
                    && hasRightFinitePredRe.test(rightBeforeUrl || afterComma);
                if (!startsWeClause && !startsIndependentNewSubj
                    && !(hasLeftPredicate(leftBeforeComma) && namedClauseRe.test(afterComma))) {
                    continue;
                }
            }
        }
        if (match.index + match[0].length <= relativeStart) {
            if (match[0] === ',' && urlLikeRe.test(sentence.slice(leadStart, match.index))) {
                lastAndSplitBeforeTarget = match.index;
            } else if (match[0] === ',' && clauseStart === leadStart && introLeadPhraseRe.test(sentence.slice(leadStart, match.index))) {
                leadStart = match.index + match[0].length;
                lastAndSplitBeforeTarget = null;
            } else if (!/^and$/i.test(match[0]) && match[0] !== ',') {
                leadStart = match.index + match[0].length;
                lastAndSplitBeforeTarget = null;
            }
            clauseStart = match.index + match[0].length;
        } else if (match.index >= relativeEnd) {
            if (match.index < postUrlCitationEnd) continue;
            clauseEnd = match.index;
            break;
        }
    }
    const splitClause = sentence.slice(clauseStart, clauseEnd).trim();
    const splitClauseHasFiniteVerb = /\b(?:is|are|was|were|has|have|can|we\s+(?:(?:also|publicly|openly|freely|hereby)\s+){0,2}(?:release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]source[ds]?))\b/i.test(splitClause);
    if (lastAndSplitBeforeTarget !== null && (!RESOURCE_AFFIRMATIVE.test(splitClause) || !splitClauseHasFiniteVerb)) {
        const targetUrl = sentence.slice(relativeStart, relativeEnd);
        const leadPart = sentence.slice(leadStart, lastAndSplitBeforeTarget).replace(/,\s*$/, '').trim();
        const relInSplit = relativeStart - clauseStart;
        const url2Normalized = relInSplit >= 0 && relInSplit + targetUrl.length <= sentence.length - clauseStart
            ? (sentence.slice(clauseStart, relativeStart) + '[RESOURCE_URL]' + sentence.slice(relativeEnd, clauseEnd)).trim()
            : splitClause.split(targetUrl).join('[RESOURCE_URL]');
        if (isValidFirstPartyLeadClause(leadPart) && isCleanElidedLocativeClause(url2Normalized)) {
            return sentence.slice(leadStart, clauseEnd).trim();
        }
        // Elided URL2 clause without its own finite verb that falsely trips RESOURCE_AFFIRMATIVE via adjectival
        // "released"/"public" (e.g. "They release ... and the publicly released model at URL2") must keep the
        // non-first-party lead context so third-party attribution is preserved.
        if (!isValidFirstPartyLeadClause(leadPart) && !splitClauseHasFiniteVerb && RESOURCE_AFFIRMATIVE.test(splitClause)) {
            return sentence.slice(leadStart, clauseEnd).trim();
        }
    }
    return splitClause;
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

// 作者直接说明提供代码、给出自己的仓库时，保留跨脚注的完整声明。
// 用途里的 dataset collection 不等于作者同时开放数据集。
function authorProvidedCodeRepositoryQuote(source, token, start) {
    const url = normalizePaperSourceRepositoryToken(token);
    if (!url || /\r?\n/.test(token)) return '';
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com' || parsed.pathname.split('/').filter(Boolean).length !== 2) return '';
    const prefix = source.slice(0, start);
    const introductions = [
        ...prefix.matchAll(/(?:^|\n)(We provide (?:the|our) (?:source )?codes? for )/g),
        ...prefix.matchAll(/(?:^|[.!?]\s+|\n)(Public release of our evaluation code\.\d{1,3}[ \t\u00a0]*\r?\n[ \t]*\d{1,3}[ \t]*\r?\n[ \t]*Code and results:[ \t]*)/g),
        ...prefix.matchAll(/(?:^|[.!?]\s+|\n)(We share our (?:source )?code(?: and invite others to [A-Za-z][A-Za-z -]{0,80})?\.\d{1,3}[ \t\u00a0]*\r?\n[ \t]*\d{1,3}[ \t]*\r?\n[ \t]*)/g)
    ].sort((left, right) => left.index - right.index);
    const last = introductions.at(-1);
    if (!last) return '';
    const lower = last.index + last[0].length - last[1].length;
    const standaloneAuthorCodeRelease = /^(?:Public release of our evaluation code\.|We share our (?:source )?code\b)/.test(last[1]);
    const beforeUrl = source.slice(lower, start);
    const end = start + token.length;
    const after = source.slice(end);
    if (beforeUrl.length > 1600 || /\n\s*\n/.test(beforeUrl)
        || (standaloneAuthorCodeRelease ? beforeUrl !== last[1]
            : !/on our GitHub[ \t\u00a0]*(?:\d{1,3}[ \t\u00a0]*\r?\n[ \t]*\d{1,3}[ \t]*\r?\n[ \t]*)?$/.test(beforeUrl))
        || !/^(?:\.)?(?:[ \t]*\r?\n|[ \t]*$)/.test(after)) return '';
    const context = source.slice(0, end);
    // 一篇论文早先定义技术术语，并不是在引用当前代码声明；显式引述仍核整段来源。
    const terminologyContext = standaloneAuthorCodeRelease
        ? source.slice(Math.max(0, lower - 240), end) : context;
    const paragraphEnd = source.indexOf('\n\n', end);
    const nextParagraphStart = paragraphEnd < 0 ? -1
        : paragraphEnd + source.slice(paragraphEnd).match(/^\s*/)[0].length;
    const nextParagraphEnd = nextParagraphStart < 0 ? -1 : source.indexOf('\n\n', nextParagraphStart);
    const followingEnd = standaloneAuthorCodeRelease && nextParagraphStart >= 0
        ? (nextParagraphEnd < 0 ? source.length : nextParagraphEnd)
        : (paragraphEnd < 0 ? source.length : paragraphEnd);
    const following = source.slice(end + (after.startsWith('.') ? 1 : 0), followingEnd);
    // 代码发布声明同时核对紧邻后段的撤销，方法效果的否定不属于资源状态。
    const retractsCode = following.split(/[.!?]\s+/).some(rawSentence => {
        const sentence = rawSentence.replace(/\s+/g, ' ').trim();
        const ownCode = /^(?:our|this|the)\s+(?:source\s+)?(?:codes?|repository|repo)\b/i.test(sentence.trim())
            || /^We\b[^.]{0,120}\b(?:our|this|the)\s+(?:source\s+)?(?:codes?|repository|repo)\b/i.test(sentence.trim());
        const releaseStatus = /\b(?:release[ds]?|publish(?:ed)?|provide[ds]?|share[ds]?|available|public(?:ly)?|private|unreleased)\b|open[- ]source/i.test(sentence);
        const unclearOwnState = /^(?:our|this|the)\s+(?:source\s+)?(?:codes?|repository|repo)\s+(?:is|are|remains?|has|have|will|would|cannot|can't)\b/i.test(sentence.trim())
            && !RESOURCE_AFFIRMATIVE.test(sentence);
        const externalOwnership = standaloneAuthorCodeRelease
            && EXTERNAL_OWNERSHIP_RE.test(sentence);
        return ownCode && (externalOwnership || unclearOwnState || (releaseStatus && (RESOURCE_NOT_RELEASED.test(sentence)
            || /\b(?:cannot|can't|unable\s+to|private|unreleased)\b/i.test(sentence))));
    });
    if (retractsCode || (standaloneAuthorCodeRelease
        && /\b(?:cited|quoted)\s+(?:article|abstract|paper|work)\b/i.test(context))
        || /:\s*$/.test(source.slice(0, lower))
        || RESOURCE_NOT_RELEASED.test(beforeUrl)
        || /\b(?:our|the authors[’']?)\s+(?:codes?|resources?|repository|repo)\b[^.\n]{0,120}\b(?:not|never|will|would|plan|intend)\b/i.test(context)
        || /\b(?:quotes?|quoted|quotation|according\s+to|documentation|website|announcement)\b|\b(?:states?|stated|says?|said|writes?|wrote|reported|mentioned|noted|claimed)\b[^.\n]{0,120}(?:following|statement|declaration|excerpt|:)|引用|第三方|术语/i.test(context)
        || /\b(?:definition|terminology)\b/i.test(terminologyContext)
        || /^\s*['>]|^ {4}|<\/?(?:blockquote|pre|code)\b|<!--|-->/im.test(context)
        || (prefix.match(/\"|“|”/g) || []).length % 2 === 1
        || (prefix.match(/```|~~~/g) || []).length % 2 === 1
        || /\b(?:provides?|provided|offers?|contains?|describes?)\b[^.\n]{0,120}\b(?:examples?|statements?|declarations?|excerpts?|resources?|codes?|repositories|another\s+author|other\s+authors?)\b/i.test(prefix.slice(0, lower))
        || THIRD_PARTY_RESOURCE.test(beforeUrl)
        || /\b(?:external|another|other)\b|\b(?:from|by)\s+\S+/i.test(beforeUrl)
        || /https?:\/\//i.test(beforeUrl)) return '';
    const purpose = beforeUrl.slice(last[1].length).replace(/on our GitHub[\s\S]*$/, '');
    if (!standaloneAuthorCodeRelease && !/^[a-z0-9 ,\u2013\u2014\-]+$/.test(purpose.trim())) return '';
    return source.slice(lower, end + (after.startsWith('.') ? 1 : 0));
}

function isUrlContinuationAt(source, idx) {
    const ch = source[idx];
    if (!ch) return false;
    if (/[A-Za-z0-9_~%+-]/.test(ch)) return true;
    if (ch === '.') return Boolean(source[idx + 1] && /[A-Za-z0-9_~%+-]/.test(source[idx + 1]));
    if (ch === '/') {
        const next = source[idx + 1];
        return Boolean(next && (/[A-Za-z0-9_~%+-]/.test(next)
            || (next === '.' && source[idx + 2] && /[A-Za-z0-9._~%+-]/.test(source[idx + 2]))));
    }
    return false;
}

function findTokenWithUrlBoundary(source, token, searchFrom = 0) {
    if (!source || !token) return -1;
    const isUrlLeadContChar = ch => Boolean(ch && /[A-Za-z0-9._~%+-/]/.test(ch));
    let pos = searchFrom;
    while (pos < source.length) {
        const idx = source.indexOf(token, pos);
        if (idx < 0) break;
        const beforeCh = idx > 0 ? source[idx - 1] : '';
        const afterBlocked = isUrlContinuationAt(source, idx + token.length);
        const beforeBlocked = !/^https?:\/\//i.test(token) && isUrlLeadContChar(beforeCh);
        if (!afterBlocked && !beforeBlocked) return idx;
        pos = idx + 1;
    }
    return -1;
}

function replaceBoundedTokenInQuote(quote, token, replacement) {
    if (!quote || !token) return String(quote || '');
    const idx = findTokenWithUrlBoundary(quote, token);
    if (idx < 0) return quote;
    return quote.slice(0, idx) + replacement + quote.slice(idx + token.length);
}

function paperSourceResourceQuote(sourceText, sourceToken) {
    const source = String(sourceText || '');
    const token = String(sourceToken || '');
    const start = token ? findTokenWithUrlBoundary(source, token) : -1;
    if (start < 0) return '';
    return authorProvidedCodeRepositoryQuote(source, token, start)
        || presentedLibraryRepositoryQuote(source, token, start)
        || standaloneReleaseBlockMatch(source, token, start)?.quote
        || conciseAuthorResourceBadgeMatch(source, token, start)?.quote
        || authorFirstPartyDemoQuote(source, token, start)
        || repositoryClassificationQuote(source, start, advanceEndPastUrlSuffix(source, start + token.length));
}

function resourceClassificationIsCurrent(resource, sourceText) {
    if (resource && Object.hasOwn(resource, 'authenticatedPdfFootnoteEvidence')) {
        return require('./reader-authenticated-pdf-footnote-evidence').assertEvidence(resource, sourceText);
    }
    if (resource?.origin === 'validated_demo') {
        const expectedFacets = classifyRepositoryHostFacets(resource.originalUrl);
        return Boolean(expectedFacets && expectedFacets.includes(resource.type));
    }
    if (resource?.origin !== 'paper_source') return true;
    const token = resource.sourceUrlToken || resource.originalUrl;
    const source = String(sourceText || '');
    const start = token ? findTokenWithUrlBoundary(source, token) : -1;
    if (start < 0) return true;
    if (resource.type === 'third_party') {
        return !authorAudioExamplesContext(source, token, start)
            && !authorProvidedCodeRepositoryQuote(source, token, start)
            && !presentedLibraryRepositoryQuote(source, token, start)
            && !standaloneReleaseBlockMatch(source, token, start)
            && !conciseAuthorResourceBadgeMatch(source, token, start)
            && !authorFirstPartyDemoQuote(source, token, start);
    }
    return paperSourceResourceFacets(source, token).includes(resource.type);
}

function paperSourceResourceFacets(sourceText, sourceToken) {
    const source = String(sourceText || '');
    const token = String(sourceToken || '');
    const start = token ? findTokenWithUrlBoundary(source, token) : -1;
    if (start >= 0 && authorAudioExamplesContext(source, token, start)) return ['demo'];
    if (start >= 0 && (authorProvidedCodeRepositoryQuote(source, token, start)
        || presentedLibraryRepositoryQuote(source, token, start))) return ['code'];
    if (start >= 0) {
        const releaseBlock = standaloneReleaseBlockMatch(source, token, start);
        if (releaseBlock) return releaseBlock.facets;
        const badge = conciseAuthorResourceBadgeMatch(source, token, start);
        if (badge) return badge.facets;
        if (authorFirstPartyDemoQuote(source, token, start)) return ['demo'];
    }
    const normalizedRepoUrlForQuote = normalizePaperSourceRepositoryToken(token);
    const repoHostDemoForQuote = Boolean(normalizedRepoUrlForQuote && classifyRepositoryHostFacets(normalizedRepoUrlForQuote)?.includes('code'));
    const demoPlatformForQuote = demoPlatformForToken(token);
    const rawQuote = replaceBoundedTokenInQuote(paperSourceResourceQuote(sourceText, sourceToken), token, '[RESOURCE_URL]');
    const quote = rawQuote.replace(/(\[RESOURCE_URL\]\/?(?:[?#][^\s<>"'\]})>,;]*)?)\s*\(([^()\n]{1,120})\)/g, (full, urlRef, inner) => (
        /^\s*(?:(?:our|the|this)\s+)?(?:hugging\s*face\s+spaces?|modelscope\s+studios?)\b/i.test(inner)
        && isHostedDemoPlatformMismatch(inner, ['demo'], demoPlatformForQuote, { repoHostDemo: repoHostDemoForQuote })
            ? urlRef
            : full
    ));
    if (isAuthorAudioExamplesStatement(quote)) return ['third_party'];
    const facets = classifyPaperSourceResourceFacets(quote);
    if (start >= 0 && facets.some(facet => facet !== 'third_party')) {
        const end = advanceEndPastUrlSuffix(source, start + token.length);
        // Reject explicit quotation/third-party attribution intros, blockquotes, HTML comments, and code fences.
        if (hasUnclosedFenceBefore(source, start)) return ['third_party'];
        const localBefore = source.slice(Math.max(0, start - 600), start);
        const lastCommentOpen = localBefore.lastIndexOf('<!--');
        const lastCommentClose = localBefore.lastIndexOf('-->');
        if (lastCommentOpen > lastCommentClose) return ['third_party'];
        const curLineStart = source.lastIndexOf('\n', start - 1) + 1;
        const curParaBreak = source.lastIndexOf('\n\n', start - 1);
        const curParaStart = curParaBreak >= 0 ? curParaBreak + 2 : 0;
        if (/^\s*>/m.test(source.slice(curParaStart, start))) return ['third_party'];
        const prevLineEnd = curLineStart > 0 ? curLineStart - 1 : -1;
        const prevLineStart = prevLineEnd >= 0 ? source.lastIndexOf('\n', prevLineEnd - 1) + 1 : -1;
        const prevLine = prevLineEnd >= 0 ? source.slice(prevLineStart, prevLineEnd).trim() : '';
        const prevPara = curParaBreak >= 0
            ? (source.slice(Math.max(0, curParaBreak - 600), curParaBreak).trim().split(/\n\s*\n/).at(-1)?.trim() || '')
            : '';
        const quoteIntroRe = /\b(?:quotes?|quoted|quotation|following(?:\s+(?:statement|declaration|excerpt|two\s+paragraphs|text))?|(?:other|cited|another)\s+authors?|(?:documentation|website)\s+contains\s+this\s+sentence|definition\s+contains\s+the\s+statement|(?:provides?|provided|offers?|contains?|describes?)\s+(?:this\s+example|resources|another\s+author|other\s+authors?)|(?:states?|stated|says?|said|writes?|wrote|claims?|claimed|reported|noted)\b[^.\n]{0,120}(?:following|statement|declaration|excerpt|:))\b|引用|以下声明|其他作者/i;
        if (prevPara && /:\s*$/.test(prevPara) && quoteIntroRe.test(prevPara)) {
            return ['third_party'];
        }
        if (prevLine && (/:$/.test(prevLine) || /\b(?:documentation|website)\s+contains\s+this\s+sentence\b|\b(?:offers?|provides?)\s+resources\.?$/i.test(prevLine))
            && quoteIntroRe.test(prevLine)) {
            return ['third_party'];
        }
        // If this occurrence matched the exact authorProvidedCodeRepositoryQuote shape (which was already rejected above),
        // never let the generic fallback resurrect a rejected quote/retraction/dual-URL case.
        const beforeInPara = source.slice(curParaStart, start);
        if (/(?:^|\n)We provide (?:the|our) (?:source )?codes? for [^\n]{0,240}\bon our GitHub\b(?:[ \t\u00a0]*\d{1,3}[ \t\u00a0]*\r?\n[ \t\u00a0]*\d{1,3}[ \t\u00a0]*\r?\n[ \t\u00a0]*)?[^\n]{0,160}$/i.test(beforeInPara)
            || /(?:^|\n)We share our (?:source )?code(?: and invite others to [A-Za-z][A-Za-z -]{0,80})?\.\d{1,3}[ \t\u00a0]*\r?\n[ \t\u00a0]*\d{0,3}[ \t\u00a0]*\r?\n?[ \t\u00a0]*[^\n]{0,160}$/i.test(beforeInPara)) {
            return ['third_party'];
        }
        const repoHostDemo = repoHostDemoForQuote;
        const demoPlatform = demoPlatformForQuote;
        const remaining = facets.filter(facet => facet === 'third_party'
            || (!hasFollowingResourceRetraction(source, end, [facet], { repoHostDemo, demoPlatform })
                && !hasInlineTailRetraction(source, end, facet, { repoHostDemo, demoPlatform })));
        return remaining.length ? remaining : ['third_party'];
    }
    return facets;
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

function paperSourceQuoteBindsOriginalUrlBinding(resource) {
    if (resource && Object.hasOwn(resource, 'authenticatedPdfFootnoteEvidence')) {
        return require('./reader-authenticated-pdf-footnote-evidence').assertEvidence(resource);
    }
    const quote = String(resource?.sourceQuote || '');
    const originalUrl = String(resource?.originalUrl || '');
    if (!originalUrl) return false;
    if (findTokenWithUrlBoundary(quote, originalUrl) >= 0) return true;
    if (resource?.type === 'third_party' && originalUrl.endsWith('/') && quote.includes(originalUrl)) {
        return true;
    }
    const token = String(resource?.sourceUrlToken || '');
    return resource?.sourceUrlBindingContract === SOURCE_URL_NORMALIZATION_CONTRACT
        && resource?.sourceUrlTokenSha256 === sha256(token)
        && findTokenWithUrlBoundary(quote, token) >= 0
        && normalizePaperSourceRepositoryToken(token) === originalUrl;
}

function paperSourceQuoteBindsOriginalUrl(resource) {
    if (resource && Object.hasOwn(resource, 'authenticatedPdfFootnoteEvidence')) {
        return require('./reader-authenticated-pdf-footnote-evidence').assertEvidence(resource);
    }
    return paperSourceQuoteBindsOriginalUrlBinding(resource)
        && (!resource?.type || resource.type === 'third_party'
            || paperSourceResourceFacets(resource.sourceQuote,
                resource.sourceUrlToken || resource.originalUrl).includes(resource.type));
}

function legacyConferenceResourceIdentity(paper) {
    const contracts = paper?.analysisManifest?.contracts;
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
    return paper?.source === 'conference' && paper.conferencePaperId === paper.id
        && /^conference:[a-z0-9-]+:\d{4}:[^\s]+$/u.test(String(paper.id || ''))
        && !Object.hasOwn(paper?.apiReaderResources || {}, 'schemaFingerprint')
        && require('./reader-identity-format').payloadBinding(paper, 'resources')
        && contracts.readerResourceClaims === undefined
        && stage?.readerResourceClaimsContractVersion === undefined
        && stage?.readerResourceClaimsProtocol === undefined;
}

const GENERIC_RESOURCE_COLON_HEADING_RE = /^(?:abstract|we|our|this\s+(?:paper|work)|links?|urls?|websites?|pages?|official|release|paper|preprint|arxiv|resources?|artifacts?|materials?|availability|open[- ]source(?:\s+(?:links?|resources?|code|models?|datasets?))?|project\s+links?|supplementary(?:\s+materials?)?|(?:code|data|dataset|model|artifact|resource)(?:\s+(?:and|&|\/)\s+(?:code|data|dataset|model|artifact|resource))*\s+(?:availability|release|statement|links?)|source[- ]code|codebase|code|models?|weights?|checkpoints?|datasets?|benchmarks?|demos?|project\s+page|homepage|github|gitlab|hugging\s*face(?:\s+(?:spaces?|datasets?))?|modelscope(?:\s+(?:datasets?|studios?|models?))?|repositor(?:y|ies)|repo|note|see|here|below|available\s+at|hosted\s+at|found\s+at)\b/i;

function isGenericResourceColonHeading(rawSegment) {
    const trimmed = String(rawSegment || '').trim();
    if (!trimmed) return false;
    const strippedOfficial = trimmed.replace(/^Official\s+(?=[A-Z])/i, '').trim();
    if (strippedOfficial && strippedOfficial !== trimmed) {
        return GENERIC_RESOURCE_COLON_HEADING_RE.test(strippedOfficial);
    }
    return GENERIC_RESOURCE_COLON_HEADING_RE.test(trimmed);
}

const GENERIC_LOWERCASE_BADGE_WORDS = new Set([
    'our', 'the', 'this', 'these', 'that', 'see', 'here', 'below', 'above', 'link', 'links',
    'code', 'codebase', 'model', 'models', 'weight', 'weights', 'checkpoint', 'checkpoints',
    'dataset', 'datasets', 'benchmark', 'benchmarks', 'demo', 'demos', 'paper', 'project',
    'page', 'homepage', 'website', 'official', 'public', 'open', 'source', 'available',
    'hosted', 'found', 'at', 'on', 'in', 'via', 'and', 'or', 'for', 'with', 'from', 'by',
    'to', 'is', 'are', 'be', 'find', 'check', 'visit', 'view', 'get', 'download', 'try',
    'run', 'use', 'also', 'more', 'full', 'all', 'both', 'new', 'its', 'their', 'my', 'your',
    'we', 'authors', 'work', 'study', 'repository', 'repo', 'artifacts', 'resources', 'materials'
]);

function isNamedThirdPartyLabel(rawSegment, { beforeBadge = false } = {}) {
    let seg = String(rawSegment || '')
        .replace(/^[-*•·$]\s*/, '')
        .replace(/[:(\s]+$/, '')
        .replace(/\s*\([^()\n]{1,32}\)\s*$/g, '')
        .trim();
    if (!seg || /,/.test(seg) || isGenericResourceColonHeading(seg)) return false;
    if (beforeBadge) {
        seg = seg
            .replace(/\s+(?:on|at|via|for|in|of|from)$/i, '')
            .replace(/\s+(?:official|public|open[- ]source)$/i, '')
            .trim();
    }
    const strippedOfficial = seg.replace(/^(?:(?:the|official|public|open[- ]source)\s+)+(?=[A-Za-z])/i, '').trim();
    if (strippedOfficial && strippedOfficial !== seg) seg = strippedOfficial;
    if (!seg || isGenericResourceColonHeading(seg)) return false;
    const words = seg.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 3) return false;
    if (beforeBadge && words.length === 1 && /^[a-z][a-z0-9._-]{2,}$/.test(words[0])) {
        return !GENERIC_LOWERCASE_BADGE_WORDS.has(words[0]);
    }
    if (!/^[A-Z]/.test(words[0])) return false;
    return words.every(w => /^[A-Z][A-Za-z0-9._-]*(?:['’]s)?$|^v?\d+(?:\.\d+)*$/.test(w));
}

function hasThirdPartyPrecedingColonHeading(source, start) {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1;
    const beforeOnLine = source.slice(lineStart, start);
    const badgeLabelMatch = /(?:^|[|$\s·•.:;!?])(GitHub|GitLab|Hugging\s*Face(?:\s+(?:Spaces?|Datasets?))?|ModelScope(?:\s+(?:Datasets?|Studios?|Models?))?|Project\s+page|Homepage|(?:Online\s+)?Demo(?:\s+page)?|Source[- ]code|Codebase|Code|Models?|Weights?|Checkpoints?|Datasets?|Benchmarks?|Repositor(?:y|ies)|Repo)\s*(?::\s*|\(\s*)$/i.exec(beforeOnLine);
    let prefixBeforeLabel = '';
    let explicitFirstPartyPrefix = false;
    if (badgeLabelMatch) {
        const exactLabelStart = lineStart + beforeOnLine.lastIndexOf(badgeLabelMatch[1]);
        prefixBeforeLabel = source.slice(lineStart, exactLabelStart).trim();
        explicitFirstPartyPrefix = /(?:^|\s)(?:our|this\s+(?:paper|work)(?:'s|’s)?)$/i.test(prefixBeforeLabel);
        if (explicitFirstPartyPrefix) return false;
        if (/:\s*$/.test(prefixBeforeLabel)) {
            const labelSeg = prefixBeforeLabel.split(/(?:[.!?|·•;]\s*)/).at(-1).trim().replace(/^[-*•·$]\s*/, '');
            if (labelSeg && !isGenericResourceColonHeading(labelSeg)) return true;
        } else if (prefixBeforeLabel
            && !/(?:[.!?|$·•;]\s*$|(?:^|\s)\/\s*$)/.test(prefixBeforeLabel)
            && !/https?:\/\/[^)\s]+\)\s*(?:\$?\|\$?|[·•,/])?\s*$/.test(prefixBeforeLabel)) {
            const labelSeg = prefixBeforeLabel.split(/(?:[.!?|·•;]\s*)/).at(-1).trim();
            if (isNamedThirdPartyLabel(labelSeg, { beforeBadge: true })) return true;
        }
    } else if (/:\s*$/.test(beforeOnLine.trim())) {
        const labelSeg = beforeOnLine.trim().split(/(?:[.!?|·•;]\s*)/).at(-1).trim();
        if (isNamedThirdPartyLabel(labelSeg)) return true;
        if (!isGenericResourceColonHeading(labelSeg.replace(/^[-*•·$]\s*/, ''))) return false;
    } else if (/\(\s*$/.test(beforeOnLine.trim())) {
        const labelSeg = beforeOnLine.trim().replace(/\(\s*$/, '').split(/(?:[.!?|·•;]\s*)/).at(-1).trim();
        if (isNamedThirdPartyLabel(labelSeg)) return true;
        return false;
    } else if (beforeOnLine.trim() !== '' && !/^[-*•·$]\s*$/.test(beforeOnLine.trim())) {
        return false;
    }
    if (lineStart <= 1) return false;
    const startsWithBadgeLabel = /^(?:[•·*-]\s*)?(?:Project\s+page|Homepage|Demo\s+page|Online\s+Demo|GitHub|GitLab|Hugging\s*Face(?:\s+Space)?|ModelScope|Source[- ]code|Codebase|Code|Models?|Datasets?|Demo|Paper|arXiv|Weights?|Checkpoints?|Repository|Repo|Space|URL|Link)\s*(?::|\()/i.test(prefixBeforeLabel)
        || /https?:\/\//i.test(prefixBeforeLabel);
    const looksLikeProseSentence = prefixBeforeLabel.split(/\s+/).length >= 4 && /\b[a-z]{3,}\b/.test(prefixBeforeLabel);
    if (prefixBeforeLabel && !startsWithBadgeLabel && /[.!?。]\s*$/.test(prefixBeforeLabel) && looksLikeProseSentence) {
        return false;
    }
    const isStackedBadgeOrUrlLine = trimmed => (
        /^(?:[•·*-]\s*)?(?:Project\s+page|Homepage|Demo\s+page|Online\s+Demo|GitHub|GitLab|Hugging\s*Face(?:\s+Space)?|ModelScope|Source[- ]code|Codebase|Code|Models?|Datasets?|Demo|Paper|arXiv|Weights?|Checkpoints?|Repository|Repo|Space|URL|Link)\s*(?::|\()/i.test(trimmed)
        || /^(?:[-*•·$]\s*)?https?:\/\/\S+\.?$/i.test(trimmed)
        || (/https?:\/\//i.test(trimmed) && !/[.!?。]$/.test(trimmed))
    );
    const prevLines = source.slice(0, lineStart - 1).split('\n');
    let idx = prevLines.length - 1;
    let skipped = 0;
    let consecutiveBlanks = 0;
    while (idx >= 0 && skipped < 6) {
        const trimmed = prevLines[idx].trim();
        if (!trimmed) {
            consecutiveBlanks += 1;
            if (consecutiveBlanks > 1) return false;
            idx -= 1;
            continue;
        }
        if (isStackedBadgeOrUrlLine(trimmed) && !/:\s*$/.test(trimmed)) {
            consecutiveBlanks = 0;
            skipped += 1;
            idx -= 1;
            continue;
        }
        const strippedTrimmed = trimmed.replace(/^[-*•·$]\s*/, '');
        if (!/:\s*$/.test(strippedTrimmed) || isGenericResourceColonHeading(strippedTrimmed)) return false;
        // Skip first-person prose sentences ending in ":" (e.g. "To facilitate reproducibility, we provide:")
        if (/\b(?:we|our|this\s+(?:paper|work))\b/i.test(strippedTrimmed)) return false;
        return true;
    }
    return false;
}

function hasExplicitThirdPartySourceAttribution(source, start, end) {
    const effectiveEnd = advanceEndPastUrlSuffix(source, end);
    if (hasBlockingAttributionOrQuoteContext(source, start, effectiveEnd)) return true;
    if (hasThirdPartyPrecedingColonHeading(source, start)) return true;
    const rawQuote = repositoryClassificationQuote(source, start, effectiveEnd);
    if (!rawQuote) return false;
    const checkClauseForThirdParty = clauseText => {
        const cleaned = String(clauseText || '').replace(/\bavail-\s*able\b/gi, 'available')
            .replace(/\s+/g, ' ').trim()
            .replace(ATTACHED_FOOTNOTE_RESOURCE_LABEL, '')
            .replace(TRAILING_FOOTNOTE_RESOURCE_LABEL, '')
            .replace(TRAILING_FOOTNOTE_CAP_RESOURCE_LABEL, '');
        if (!cleaned) return false;
        if (THIRD_PARTY_RESOURCE.test(cleaned) || /\bet\s+al\b/i.test(cleaned)) return true;
        const facetSource = cleaned.replace(/(?:https?:\/\/[^\s<>"'\]})>,;]+|(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/[^\s<>"'\]})>,;]+|\[RESOURCE_URL\](?:\/?[?#][^\s<>"'\]})>,;]*)?)/gi, '[RESOURCE_URL]');
        if (INLINE_CITATION_RE.test(facetSource) || TRAILING_URL_CITATION_RE.test(facetSource)) return true;
        const urlIdx = facetSource.indexOf('[RESOURCE_URL]');
        const clauseThroughUrl = urlIdx >= 0 ? facetSource.slice(0, urlIdx + '[RESOURCE_URL]'.length) : facetSource;
        const postUrlTail = urlIdx >= 0 ? facetSource.slice(urlIdx + '[RESOURCE_URL]'.length) : '';
        const explicitAuthorOverall = /^(?:our\b|we\b|the\s+authors?\b|本文|本研究|我们|作者)/i.test(facetSource.trim());
        if (!explicitAuthorOverall && postUrlTail && POST_URL_BY_FROM_PROPER_RE.test(postUrlTail)) {
            return true;
        }
        const facetMatches = RESOURCE_FACET_SPECS.map(([type, pattern]) => ({ type, match: pattern.exec(facetSource) }))
            .filter(item => item.match);
        if (facetMatches.length) {
            const firstHit = facetMatches.reduce((best, cur) => (cur.match.index < best.match.index ? cur : best)).match;
            const prefix = facetSource.slice(0, firstHit.index);
            const explicitAuthor = /^(?:our\b|we\b|the\s+authors?\b|本文|本研究|我们|作者)/i.test(prefix.trim());
            if (!explicitAuthor) {
                const unknownPrefix = prefix
                    .replace(/\b(?:our|the|this|these|all|both|an?|we|authors?|work|paper|project|release|released|provide|provided|provides|publicly|openly|public|open[- ]source(?:d)?|available|hosted|published|shared|make|made|pre-?trained|trained|pruned|distilled|quantized|fine-?tuned|compressed|full|complete|official|accompanying|associated|corresponding|source|audio|speech|music|video|evaluation|training|inference|online|real-?time)\b/gi, '')
                    .replace(/(?:本文|本研究|我们|作者|现已|已|公开|提供|的)|[\s:：,，\d]/gu, '');
                if (unknownPrefix) return true;
            }
            const predOrUrlMatch = /\b(?:is|are|was|were|will|can|has|have|provide[sd]?|release[sd]?|publish(?:ed)?|share[sd]?|open[- ]source[sd]?|make[sd]?|made|hosted|available|accessible|found)\b|\[RESOURCE_URL\]/i.exec(facetSource.slice(firstHit.index + firstHit[0].length));
            const subjectBeforeVerb = predOrUrlMatch
                ? facetSource.slice(0, firstHit.index + firstHit[0].length + predOrUrlMatch.index)
                : facetSource;
            if (hasThirdPartyPostFacetOrCitation(clauseThroughUrl, firstHit.index + firstHit[0].length, explicitAuthor, subjectBeforeVerb)) {
                return true;
            }
        } else {
            const predMatch = /\b(?:(?:is|are|was|were|has\s+been|have\s+been|can\s+be|may\s+be)\s+(?:(?:publicly|openly|freely)\s+)?(?:available|accessible|found|released|published|hosted|provided|open[- ]sourced)|(?:releases?|released|provides?|provided|publishes?|published|hosts?|hosted|open[- ]sources?|open[- ]sourced|shares?|shared))\b/i.exec(clauseThroughUrl);
            if (predMatch) {
                const subj = clauseThroughUrl.slice(0, predMatch.index).trim();
                const explicitAuthorSubj = /^(?:our\b|we\b|the\s+authors?\b|this\s+(?:paper|work|project|study|system|framework|method|tool|library)\b|the\s+(?:paper|work|project|study|system|framework|method|tool|library)\b|本文|本研究|我们|作者)/i.test(subj);
                if (subj && !explicitAuthorSubj) {
                    if (/\b(?:they|their|them)\b/i.test(subj)) return true;
                    const strippedSubj = subj.replace(/^(?:(?:the|this|these|an?|all|both|official|public(?:ly)?|open[- ]source(?:d)?|original|pre-?trained)\s+)+/i, '').trim();
                    if (/^[A-Z][A-Za-z0-9._-]*/.test(strippedSubj)
                        && !/^(?:Paper|Work|Project|Study|System|Framework|Method|Tool|Library|Resources?|Materials?|Links?|Page|Website|Homepage|Availability|Abstract|Introduction|Note|See|Here)\b/i.test(strippedSubj)) {
                        return true;
                    }
                }
            }
        }
        return false;
    };
    if (checkClauseForThirdParty(rawQuote)) return true;
    // If rawQuote is an elided continuation clause (no finite release verb or no affirmative,
    // e.g. "public model at URL2" or "the model at URL2" after "They release URL1 and ..."),
    // inspect the sentence lead preceding this clause for third-party attribution.
    const rawHasFiniteVerb = /\b(?:is|are|was|were|has|have|can|we\s+(?:(?:also|publicly|openly|freely|hereby)\s+){0,2}(?:release[ds]?|provide[ds]?|publish(?:ed|es)?|share[ds]?|open[- ]source[ds]?))\b/i.test(rawQuote);
    if (!RESOURCE_AFFIRMATIVE.test(rawQuote) || !rawHasFiniteVerb) {
        const sentStart = Math.max(
            0,
            source.lastIndexOf('\n\n', start - 1) + 2,
            source.lastIndexOf('. ', start - 1) + 2,
            source.lastIndexOf('.\n', start - 1) + 2
        );
        const leadWindow = source.slice(sentStart, start).trim();
        if (leadWindow
            && /(?:https?:\/\/|(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/)/i.test(leadWindow)
            && checkClauseForThirdParty(leadWindow)) {
            return true;
        }
    }
    return false;
}

function inferContextFacetsForRetraction(source, start, fallbackFacet, end = start) {
    const str = String(source || '');
    const beforeLines = str.slice(Math.max(0, start - 360), start).replace(/\r\n/g, '\n').split('\n');
    while (beforeLines.length && (!beforeLines.at(-1).trim() || /^https?:\/\/\S+\.?$/i.test(beforeLines.at(-1).trim()))) {
        beforeLines.pop();
    }
    const before = beforeLines.join('\n').replace(/[.!?:：\s]+$/, '');
    const sentBreakRe = /(?:(?<!\b(?:e\.g|i\.e|vs|etc|al|figs?|tabs?|secs?|eqs?|nos?))\.\s+|\n\n)/i;
    const localLead = before.split(sentBreakRe).at(-1) || '';
    const afterSameSentence = str.slice(end, Math.min(str.length, end + 160))
        .split(/(?:(?<!\b(?:e\.g|i\.e|vs|etc|al|figs?|tabs?|secs?|eqs?|nos?))\.\s+|\n\n|\n(?=[A-Z]))/i)[0] || '';
    const combinedContext = `${localLead} ${afterSameSentence}`;
    const inferred = [];
    for (const facet of ['code', 'model', 'dataset', 'demo']) {
        if (RETRACTION_FACET_PATTERNS[facet].test(combinedContext)) {
            inferred.push(facet);
        }
    }
    if (fallbackFacet && !inferred.includes(fallbackFacet)) {
        inferred.push(fallbackFacet);
    }
    return inferred.length ? inferred : (fallbackFacet ? [fallbackFacet] : []);
}

module.exports = {
    SOURCE_URL_NORMALIZATION_CONTRACT,
    RESOURCE_NOT_RELEASED,
    THIRD_PARTY_RESOURCE,
    RESERVED_HF_PREFIXES,
    stripComparativeClosedSourceContrast,
    demoPlatformForToken,
    hasNotReleasedContext,
    hasFollowingResourceRetraction,
    hasInlineTailRetraction,
    hasPrecedingResourceRetractionOrDeferral,
    hasExplicitThirdPartySourceAttribution,
    inferContextFacetsForRetraction,
    classifyRepositoryHostFacets,
    normalizePaperSourceRepositoryToken,
    classifySingleClauseFirstPartyFacets,
    classifyPaperSourceResourceFacets,
    paperSourceResourceFacets, resourceClassificationIsCurrent,
    paperSourceResourceQuote,
    extractPaperSourceRepositoryCandidates,
    normalizedSourceUrlBinding,
    paperSourceQuoteBindsOriginalUrl, paperSourceQuoteBindsOriginalUrlBinding,
    legacyConferenceResourceIdentity
};
