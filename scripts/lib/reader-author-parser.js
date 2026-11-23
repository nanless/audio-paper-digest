'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const cheerio = require('cheerio');
const identityFormat = require('./reader-identity-format');
// 解析或逐人关联失败不能推断论文没有披露机构；旧提示语仍按原签名只读兼容。
const READER_AFFILIATION_UNBOUND = '机构信息未能在本次解析中与作者逐人可靠绑定';
const PDF_PAGE1_AUTHOR_CONTRACT_V1 = 'pdf-page1-author-evidence-v1';
const PDF_PAGE1_AUTHOR_CONTRACT_V2 = 'pdf-page1-author-evidence-v2';
const PDF_PAGE1_AUTHOR_CONTRACT = PDF_PAGE1_AUTHOR_CONTRACT_V2;
const PDF_PAGE1_AUTHOR_CONTRACTS = new Set([PDF_PAGE1_AUTHOR_CONTRACT_V1, PDF_PAGE1_AUTHOR_CONTRACT_V2]);
const PDF_PAGE1_AUTHOR_MODES = new Set(['markers', 'thanks', 'column_blocks', 'single_institution', 'inline_author_aff']);
const MAX_PDF_AUTHOR_BYTES = 512 * 1024 * 1024;
const METADATA_AUTHOR_SEPARATORS = new Set([':', '：', ';', '；', ',', '，', '、', '·', '|', '/', '•', '—', '–', '-']);
const recoverySha256 = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const stableFingerprint = value => sha256(JSON.stringify(canonical(value)));
const MAX_AUTHOR_SOURCE_HTML_BYTES = 8 * 1024 * 1024;
const AUTHOR_VERIFICATION_CACHE_MAX_ENTRIES = 256;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const htmlAuthorSourceCache = new Map();
const conferencePdfAuthorCache = new Map();
const pdfPage1AuthorCache = new Map();
const verifiedAuthorMatchCache = new Map();
const authorCacheCounters = {
    htmlHits: 0,
    htmlMisses: 0,
    conferencePdfHits: 0,
    conferencePdfMisses: 0,
    pdfPage1Hits: 0,
    pdfPage1Misses: 0,
    verifiedMatchHits: 0,
    verifiedMatchMisses: 0
};

const READER_ROLE_FOOTNOTE_RE = /^(?:[∗*†‡⋆§¶‖∥#•◦⋄+]\s*)?(?:(?:denotes?|indicates?|signifies|represents?)\s+)?(?:(?:the|these|all)\s+)?(?:equal\s+contribution|contributed\s+equally|authors?\s+contributed\s+equally|joint\s+first\s+authors?|co-?first\s+authors?|equal\s+advising|equal\s+supervision|equal\s+senior|corresponding\s+authors?|author\s+to\s+whom\s+correspondence\s+should\s+be\s+addressed|correspondence\s+(?:to|should\s+be\s+addressed)|correspondence\s*[:：]?$|corresponding\s+to|thanks\s*[:：]|project\s+lead|team\s+lead|core\s+contributors?|work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:during|while|at|as)|intern(?:ship)?\s+at|now\s+at|preprint|under\s+review|accepted\s+(?:at|to|by)|published\s+(?:at|in)|to\s+appear\s+in|(?:this\s+)?work\s+(?:was\s+)?(?:funded|supported)\s+by|(?:funded|supported)\s+by|alphabetical\s+order|author\s+order\s+is\s+random|order\s+is\s+random|acknowledg|email|e-?mail|contact(?:\s*[:：]|\b)|project\s+page|code\s+available|demo\s+page)/i;
const READER_UNANCHORED_ROLE_SENTENCE_RE = /\b(?:contributed\s+equally|is\s+(?:the\s+)?corresponding\s+author|are\s+(?:the\s+)?corresponding\s+authors?|correspondence\s+should\s+be\s+addressed|author\s+to\s+whom\s+correspondence|work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:during|while|at|as))\b/i;
const READER_CREDIT_STRONG_RE = /\b(?:software\s+design|conceptualization|formal\s+analysis|data\s+curation|writing\s*[–—-]\s*original\s+draft|writing\s*[–—-]\s*review(?:\s+and\s+editing)?|funding\s+acquisition|project\s+administration|manuscript\s+review\s+and\s+editing)\b/i;
const READER_CREDIT_GENERIC_TERM_RE = /\b(?:conceptualization|methodology|formal\s+analysis|investigation|data\s+curation|visualization|funding\s+acquisition|project\s+administration|supervision|validation|resources|documentation|software\s+design|writing\s*[–—-]\s*original|writing\s*[–—-]\s*review)\b/gi;
const READER_CORP_DOT_SUFFIX_SRC = '(?<=\\S\\s)(?:b\\.v\\.|s\\.a\\.(?:s\\.)?|a\\.g\\.|s\\.r\\.l\\.)(?![a-z0-9-])|(?:pvt|pte|pty)\\.?\\s*ltd(?:\\.(?![a-z0-9-])|\\b)';
const READER_AUTHOR_CORP_DOT_SUFFIX_SRC = '(?<=\\S\\s)(?:b\\.v\\.|s\\.a\\.(?:s\\.)?|a\\.g\\.|s\\.r\\.l\\.)(?=\\s*(?:[,;)]|$))|(?:pvt|pte|pty)\\.?\\s*ltd(?:\\.(?![a-z0-9-])|\\b)';
const READER_UPPERCASE_CORP_SUFFIX_RE = /(?<=\S\s)(?:(?:AG|SE|NV|BV|AB|Oy)\b|K\.K\.(?![A-Za-z0-9-]))/;
const READER_AUTHOR_UPPERCASE_CORP_SUFFIX_RE = /(?<=\S\s)(?:(?:AG|SE|NV|BV|AB|Oy)\b|K\.K\.(?=\s*(?:[,;)]|$)))/;
const READER_AFFILIATION_ENTITY_HINT_RE = new RegExp(`\\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|institut(?:e|ion|o)?|research|independent\\s+researcher|school|college|department|dept\\.?|departamento|dipartimento|division|faculty|laborator(?:y|ies|io)|laboratoires?|labs?|academy|cent(?:re|er|ro)|hospital|clinic|foundation|conservatory|conservatoire|[ée]cole|escola|politecnic[oa]|polytechnique|hochschule|corp(?:oration)?\\.?|company|co\\.?,?\\s*ltd\\.?|inc(?:\\.(?![a-z0-9-])|\\b)|ltd(?:\\.(?![a-z0-9-])|\\b)|gmbh|llc|llp|plc|pbc|berhad|sdn\\.?\\s*bhd\\.?|${READER_CORP_DOT_SUFFIX_SRC}|technology|technologies|t[ée]l[ée]com(?:munications?)?|intelligence|platforms?|vision|systems?|solutions?|engineering|sciences?|computing|software|networks?|media|communications?|agi\\s+lab|ai\\s+lab|ai\\s+research|fraunhofer|max\\s+planck|ubisoft|tether\\s+evo|tencent|wechat|google|deepmind|meta\\s+ai|microsoft|amazon|apple|nvidia|adobe|alibaba|bytedance|huawei|baidu|oppo|xiaomi|samsung|sony|ibm|intel|qualcomm|bosch|siemens|openai|northwestern|kyutai|kaist|inria|cnrs|sorbonne|sinica|mit|cmu|uc\\s+berkeley|eth\\s+zurich|eth\\s+zürich|epfl|tsinghua|peking|fudan|sjtu|ustc|cuhk|nus|ntu|snu|riken|nict|nii|dfki|idiap|fbk|athena|isir|mila|vector|allen\\s+institute|ntt|team)(?=\\b|[\\s,.;)]|$)`, 'i');
const READER_NON_PERSON_AFFILIATION_HINT_RE = new RegExp(`\\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|institut(?:e|ion|o)?|research|school|college|department|dept\\.?|departamento|dipartimento|division|faculty|laborator(?:y|ies|io)|laboratoires?|labs?|academy|cent(?:re|er|ro)|hospital|clinic|foundation|conservatory|conservatoire|[ée]cole|escola|politecnic[oa]|polytechnique|hochschule|corp(?:oration)?\\.?|company|co\\.?,?\\s*ltd\\.?|inc(?:\\.(?![a-z0-9-])|\\b)|ltd(?:\\.(?![a-z0-9-])|\\b)|gmbh|llc|llp|plc|pbc|berhad|sdn\\.?\\s*bhd\\.?|${READER_AUTHOR_CORP_DOT_SUFFIX_SRC}|technology|technologies|t[ée]l[ée]com(?:munications?)?|intelligence|platforms?|vision|systems?|solutions?|engineering|sciences?|computing|software|networks?|media|communications?|agi\\s+lab|ai\\s+lab|ai\\s+research|fraunhofer|max\\s+planck|ubisoft|tether\\s+evo|tencent|wechat|google|deepmind|meta\\s+ai|microsoft|amazon|nvidia|adobe|alibaba|bytedance|huawei|baidu|xiaomi|samsung|ibm|intel|qualcomm|siemens|kyutai|kaist|inria|cnrs|sorbonne|sinica|mit|cmu|uc\\s+berkeley|eth\\s+zurich|eth\\s+zürich|epfl|tsinghua|peking|fudan|sjtu|ustc|cuhk|nus|ntu|snu|riken|nict|nii|dfki|idiap|fbk|isir|vector|allen\\s+institute|ntt|team)(?=\\b|[\\s,.;)]|$)`, 'i');
const READER_RESOURCE_LABEL_ONLY_RE = /^(?:project(?:\s+(?:page|website|webpage|url|link|site))?|(?:code|source\s+code|demo|demos|dataset|datasets|data|model|models|model\s+card|weights|checkpoint|checkpoints|evaluation|benchmark|benchmarks|paper|blog|arxiv|license|samples|audio\s+samples|hugging\s*face|github|gitlab|modelscope|home|homepage|website|webpage|repository|repo|abstract|introduction|keywords?|index\s+terms)(?:\s+(?:page|website|url|link|repo|repository))?|e-?mail|emails?|contact|correspondence|address)\s*[:：]?\s*$/i;
const READER_ACADEMIC_INST_CORE_RE = /\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|institut(?:e|ion|o)?|research|school|college|department|dept\.?|departamento|dipartimento|division|faculty|laborator(?:y|ies|io)|laboratoires?|labs?|academy|cent(?:re|er|ro)|hospital|clinic|foundation|conservatory|conservatoire|[ée]cole|escola|politecnic[oa]|polytechnique|hochschule|fraunhofer|max\s+planck|cnrs|inria|kaist|epfl|mit|cmu|riken|nict|dfki|idiap|sorbonne|sinica)\b/i;
const READER_PURE_LOCATION_COUNTRY_RE = /^(?:United\s+States(?:\s+of\s+America)?|U\.?S\.?A\.?|United\s+Kingdom|U\.?K\.?|China|P\.?\s*R\.?\s*China|France|Germany|Japan|Korea|South\s+Korea|Republic\s+of\s+Korea|Canada|Switzerland|Singapore|Australia|India|Italy|Spain|(?:The\s+)?Netherlands|Sweden|Norway|Finland|Denmark|Belgium|Austria|Poland|Israel|Taiwan|R\.?O\.?C\.?|Hong\s+Kong|Macau|Brazil|Mexico|Turkey|Türkiye|Greece|Ireland|Portugal|Czech\s+Republic|New\s+Zealand|Russia|Vietnam|Thailand|Malaysia|Nepal|Uzbekistan|Bangladesh|El\s+Salvador|United\s+Arab\s+Emirates|UAE|Saudi\s+Arabia|Egypt|Iran|Pakistan|Indonesia|Philippines|Argentina|Chile|Colombia|Peru|South\s+Africa|Nigeria|Kenya|Cameroon|Hungary|Romania)$/i;
const READER_PURE_LOCATION_STATE_OR_REGION_RE = /^(?:California|Massachusetts|Washington|Texas|Illinois|Pennsylvania|Michigan|Virginia|Maryland|Georgia|Indiana|Colorado|Oregon|Florida|Arizona|Ohio|Minnesota|Connecticut|Wisconsin|Missouri|Tennessee|Utah|New\s+York|New\s+Jersey|North\s+Carolina|South\s+Carolina|New\s+Mexico|West\s+Virginia|North\s+Dakota|South\s+Dakota|Rhode\s+Island|New\s+Hampshire|District\s+of\s+Columbia|Ontario|Quebec|British\s+Columbia|Nova\s+Scotia|Alberta|Manitoba|Gujarat|Maharashtra|Karnataka|Tamil\s+Nadu|Telangana|Uttar\s+Pradesh|West\s+Bengal|Kerala|Rajasthan|Punjab|Haryana|Andhra\s+Pradesh|England|Scotland|Bavaria|CA|NY|MA|WA|TX|PA|IL|NJ|MD|VA|GA|NC|SC|NM|WV|ND|SD|RI|NH|OH|MI|MN|CO|OR|CT|DC|FL|AZ|UT|IN|WI|MO|TN|ON|QC|BC|AB|NS|NSW|VIC)$/i;
const READER_KNOWN_NON_CITY_ORG_HEADS = new Set([
    'openai', 'anthropic', 'google', 'deepmind', 'meta', 'fair', 'apple', 'amazon', 'microsoft',
    'tencent', 'alibaba', 'bytedance', 'huawei', 'baidu', 'nvidia', 'adobe', 'sony', 'mistral',
    'cohere', 'zyphra', 'kyutai', 'suno', 'udio', 'stability', 'runway', 'databricks', 'snowflake',
    'palantir', 'stripe', 'uber', 'airbnb', 'netflix', 'spotify', 'zoom', 'cisco', 'oracle',
    'salesforce', 'qualcomm', 'intel', 'siemens', 'bosch', 'samsung', 'toyota', 'honda', 'panasonic',
    'toshiba', 'hitachi', 'fujitsu', 'nec', 'ntt', 'naver', 'kakao', 'coupang', 'grab', 'shopee',
    'tiktok', 'xiaomi', 'oppo', 'vivo', 'lenovo', 'sensetime', 'megvii', 'zhipu', 'moonshot',
    'stepfun', 'baichuan', 'deepseek', 'qwen', 'minimax', 'elevenlabs', 'xai', 'iflytek', 'kaist',
    'inria', 'cnrs', 'epfl', 'riken', 'nict', 'dfki', 'idiap', 'mila', 'cartesia', 'sesame',
    'telefonica', 'telefónica', 'innovacion', 'innovación', 'digital', 'ubisoft', 'tether', 'manifestro', 'arm'
]);
let legacyReplayPreservePureLocationDepth = 0;
function withLegacyPureLocationPreservation(fn) {
    legacyReplayPreservePureLocationDepth++;
    try {
        return fn();
    } finally {
        legacyReplayPreservePureLocationDepth--;
    }
}
function isReaderPureLocationOnly(text) {
    const s = String(text || '').trim();
    if (!s || READER_AFFILIATION_ENTITY_HINT_RE.test(s) || READER_UPPERCASE_CORP_SUFFIX_RE.test(s)) return false;
    if (READER_PURE_LOCATION_COUNTRY_RE.test(s)) return true;
    const parts = s.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length !== 2 && parts.length !== 3) return false;
    const left = parts[0];
    const right = parts[parts.length - 1].replace(/\s+\d{4,6}$/, '').trim();
    if (!READER_PURE_LOCATION_COUNTRY_RE.test(right)) return false;
    if (parts.length === 3) {
        // Mirror Python _is_location_only_line: 3-part pure location must have a state/province/region
        // or postal code in the middle (never "<Company>, <City>, <Country>" like "Arm, Cambridge, United Kingdom").
        const mid = parts[1].replace(/\s+\d{4,6}$/, '').trim();
        const midIsStateOrZip = /^\d{4,6}(?:-\d{4})?$/.test(parts[1])
            || READER_PURE_LOCATION_STATE_OR_REGION_RE.test(mid)
            || READER_PURE_LOCATION_COUNTRY_RE.test(mid);
        if (!midIsStateOrZip) return false;
    }
    const leftKey = left.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]/g, '');
    if (READER_KNOWN_NON_CITY_ORG_HEADS.has(leftKey)) return false;
    if (left.split(/\s+/).some(tok => READER_KNOWN_NON_CITY_ORG_HEADS.has(tok.toLowerCase().replace(/[^a-z0-9\u00c0-\u024f]/g, '')))) return false;
    if (/[a-z][A-Z]/.test(left) || /\.(?:ai|io|com|org|edu|air)\b/i.test(left)) return false;
    if (/^[A-Z]{2,}$/.test(left) && !['DC', 'LA', 'NY', 'SF', 'UK', 'US'].includes(left)) return false;
    // Protect non-geographic ALL-CAPS institutional acronyms (e.g. "UNSW Sydney, Australia", "KAIST Daejeon, Korea")
    const geoAcronyms = new Set(['USA', 'UAE', 'PRC', 'ROC', 'NSW', 'QLD', 'VIC', 'ACT', 'TAS', 'SAR']);
    if (left.split(/\s+/).some(tok => { const t = tok.replace(/[()]/g, ''); return /^[A-Z]{3,}$/.test(t) && !geoAcronyms.has(t); })) return false;
    // Protect famous university shortnames paired directly with a country (e.g. "Stanford, USA"), while keeping "Stanford, CA" / "Stanford, CA, USA" location-only.
    const univShortnames = new Set(['stanford', 'caltech', 'cornell', 'princeton', 'harvard', 'purdue', 'dartmouth', 'vanderbilt', 'northwestern']);
    const usStateNames = new Set(['california', 'new york', 'new jersey', 'massachusetts', 'indiana', 'illinois', 'tennessee', 'new hampshire']);
    if (parts.length === 2 && univShortnames.has(leftKey) && right.length > 2 && !usStateNames.has(right.toLowerCase())) return false;
    // Only single-word or 2-word city names (e.g. "Hangzhou", "New York", "San Francisco"); never 3+ word org names
    return /^[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+(?:\s+[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’.-]+)?$/.test(left);
}
const READER_SECTION_META_HEADING_RE = /^(?:(?:paper\s+)?author(?:\s+(?:roles?|contributions?|affiliations?|information|notes?|biograph(?:y|ies)|details?)|s\b)|highlights|overview|title|contents|table\s+of\s+contents|acknowledg(?:e)?ments?|declarations?|conflict\s+of\s+interest|ethics\s+statement|data\s+availability|code\s+availability|supplementary\s+material)\b/i;
const READER_BARE_DOMAIN_FRAGMENT_RE = /^(?:[a-z0-9-]+\.)+(?:com|org|edu|cn|net|io|ai|gov|mil|de|uk|fr|jp|kr|ca|ch|sg|au|nl|eu|ac\.[a-z]{2}|co\.[a-z]{2}|edu\.[a-z]{2})$/i;
const READER_IEEE_MEMBER_ONLY_RE = /^(?:(?:Life\s+)?(?:(?:Graduate\s+)?Student\s+|Senior\s+|Associate\s+)?(?:Member|Fellow)\s*,\s*IEEE\.?)(?:(?:[\s,;]+|,\s*and\s+|\s+and\s+)(?:(?:Life\s+)?(?:(?:Graduate\s+)?Student\s+|Senior\s+|Associate\s+)?(?:Member|Fellow)\s*,\s*IEEE\.?))*$/i;
const READER_VENUE_OR_STATUS_RE = /^(?:(?:accepted\s+(?:at|to|by)|published\s+(?:at|in)|to\s+appear\s+in|proceedings\s+of|in\s+proceedings|under\s+review|technical\s+report|working\s+paper|preprint|draft|camera[- ]ready|arXiv|figure\s+\d|table\s+\d|abstract|appendix)\b|(?:ICASSP|INTERSPEECH|NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|SIGIR|KDD|WWW|ACM\s+MM|IEEE|SLT|ASRU|WASPAA|ISMIR|DCASE|EUSIPCO|BMVC|WACV|SIGGRAPH|CHI|UIST|OSDI|SOSP|NSDI|CCS|S&P|NDSS)\b.*(?:19|20)\d{2}\b)/i;
const READER_DATE_LINE_RE = /^(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|Preprint\.?.*)$/i;
const READER_STREET_ADDRESS_RE = /\b(?:Way|Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Parkway|Drive|Dr\.|Lane|Rue|Straße|Strasse)(?=\b|[\s,.;]|$)/i;
function isReaderCreditContribution(value) {
    const s = normalizeReaderIdentityText(value);
    if (!s) return false;
    if (READER_CREDIT_STRONG_RE.test(s)) return true;
    const distinctTerms = new Set([...s.matchAll(READER_CREDIT_GENERIC_TERM_RE)].map(m => m[0].toLowerCase().replace(/\s+/g, ' ')));
    if (distinctTerms.size >= 2) return true;
    if (distinctTerms.size === 1 && s.includes(':') && !READER_AFFILIATION_ENTITY_HINT_RE.test(s)) {
        const prefix = s.slice(0, s.indexOf(':')).trim();
        if (prefix.length >= 2 && prefix.length <= 60 && !READER_AFFILIATION_ENTITY_HINT_RE.test(prefix)) return true;
    }
    return false;
}
function isBareStreetAddressLine(body) {
    const s = normalizeReaderIdentityText(body);
    const m = READER_STREET_ADDRESS_RE.exec(s);
    if (!m) return false;
    const segments = s.split(/\s*[,;]\s*/);
    let offset = 0;
    let streetSegIdx = 0;
    for (let i = 0; i < segments.length; i++) {
        const idx = s.indexOf(segments[i], offset);
        const end = idx + segments[i].length;
        if (m.index >= idx && m.index < end) {
            streetSegIdx = i;
            break;
        }
        offset = end;
    }
    if (streetSegIdx === 0) {
        return !READER_ACADEMIC_INST_CORE_RE.test(segments[0]);
    }
    const prior = segments.slice(0, streetSegIdx).join(', ');
    if (READER_AFFILIATION_ENTITY_HINT_RE.test(prior)) return false;
    const priorKey = prior.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (KNOWN_NON_CITY_ORG_HEADS.has(priorKey)) return false;
    return true;
}
const KNOWN_NON_CITY_ORG_HEADS = new Set([
    'openai', 'anthropic', 'google', 'deepmind', 'meta', 'fair', 'apple', 'amazon', 'microsoft',
    'tencent', 'alibaba', 'bytedance', 'huawei', 'baidu', 'nvidia', 'adobe', 'sony', 'mistral',
    'cohere', 'zyphra', 'kyutai', 'suno', 'udio', 'stability', 'runway', 'databricks', 'snowflake',
    'palantir', 'stripe', 'uber', 'airbnb', 'netflix', 'spotify', 'zoom', 'cisco', 'oracle',
    'salesforce', 'qualcomm', 'intel', 'siemens', 'bosch', 'samsung', 'toyota', 'honda', 'panasonic',
    'toshiba', 'hitachi', 'fujitsu', 'nec', 'ntt', 'naver', 'kakao', 'coupang', 'grab', 'shopee',
    'tiktok', 'xiaomi', 'oppo', 'vivo', 'lenovo', 'sensetime', 'megvii', 'zhipu', 'moonshot',
    'stepfun', 'baichuan', 'deepseek', 'qwen', 'minimax', 'elevenlabs', 'xai', 'iflytek', 'kaist',
    'inria', 'cnrs', 'epfl', 'riken', 'nict', 'dfki', 'idiap', 'mila', 'cartesia'
]);
const SURNAME_COLLIDING_ORG_HEADS = new Set([
    'honda', 'fair', 'bosch', 'apple', 'sony', 'oracle', 'stripe', 'grab', 'zoom',
    'runway', 'stability', 'vivo', 'oppo', 'suno', 'udio', 'mila'
]);
const ORG_HEAD_LOCATION_COLLIDING = new Set([...SURNAME_COLLIDING_ORG_HEADS, 'athena', 'mila']);
const KNOWN_LOCATION_TAIL_FULL_RE = /^(?:United\s+States(?:\s+of\s+America)?|United\s+Kingdom|China|P\.?\s*R\.?\s*China|France|Germany|Japan|Korea|South\s+Korea|Republic\s+of\s+Korea|Canada|Switzerland|Singapore|Australia|India|Italy|Spain|Netherlands|Sweden|Norway|Finland|Denmark|Belgium|Austria|Poland|Israel|Taiwan|Hong\s+Kong|Macau|Brazil|Mexico|Turkey|Türkiye|Greece|Ireland|Portugal|Czech\s+Republic|New\s+Zealand|Russia|Vietnam|Thailand|Malaysia|California|Massachusetts|Washington|Texas|Illinois|Pennsylvania|Michigan|Virginia|Maryland|Georgia|Indiana|Colorado|Oregon|Florida|Arizona|Ohio|Minnesota|Connecticut|Wisconsin|Missouri|Tennessee|Utah|New\s+York|New\s+Jersey|North\s+Carolina|South\s+Carolina|New\s+Mexico|West\s+Virginia|North\s+Dakota|South\s+Dakota|Rhode\s+Island|New\s+Hampshire|District\s+of\s+Columbia|Ontario|Quebec|British\s+Columbia|Nova\s+Scotia|Alberta|Manitoba|England|Scotland|Bavaria)$/i;
const KNOWN_LOCATION_CODE_CS_RE = /^(?:USA|U\.S\.A\.?|US|U\.S\.?|UK|U\.K\.?|CA|NY|MA|WA|TX|PA|IL|NJ|MD|VA|GA|NC|SC|NM|WV|ND|SD|RI|NH|OH|MI|MN|CO|OR|CT|DC|FL|AZ|UT|IN|WI|MO|TN|ON|QC|BC|AB|NS|NSW|VIC)$/;
function isKnownLocationTail(value) {
    const s = String(value || '').trim();
    return KNOWN_LOCATION_TAIL_FULL_RE.test(s) || KNOWN_LOCATION_CODE_CS_RE.test(s);
}
const KNOWN_NON_PERSON_ORG_TOKENS = new Set(
    [...KNOWN_NON_CITY_ORG_HEADS].filter(tok => !SURNAME_COLLIDING_ORG_HEADS.has(tok))
);
const NON_PERSON_ORG_TOKEN_CS_RE = /\b(?:ML|NLP|LLM|ASR|TTS|Group|Tech|Studio|Studios|Robotics|Dynamics|Ventures|Digital|Interactive|Telecom|Mobile|Health|Healthcare|Medical|Pharma|Therapeutics|Diagnostics|Biosciences|Genomics)\b|\b(?:Scale|Meta|Mistral|Stability|Character|Perplexity|Together|Assembly|Inflection|Cohere|Runway|Suno|Hume|Cartesia|Sesame|Google|Apple|Microsoft|Amazon|NVIDIA|Samsung|Sony|Huawei|Tencent|Alibaba|ByteDance|Baidu|Xiaomi|Oppo|SenseTime|Zhipu|Moonshot|StepFun|DeepSeek|MiniMax|ElevenLabs|Adobe|Oracle|Salesforce|IBM|Intel|Qualcomm|Bosch|Siemens|Toyota|Honda|Open|Deep|Generative|Applied|Enterprise|Global|National|Shanghai|Beijing)\s+AI\b|\b(?:Meta\s+FAIR|(?:Google|Alibaba|Tencent|Huawei|Amazon|AWS|Oracle|IBM|Microsoft|Azure|Baidu|Volcano|ByteDance|Salesforce)\s+Cloud)\b/;
const EXEMPT_UPPER_CITIES = new Set(['DC', 'LA', 'NY', 'SF', 'UK', 'US']);

const NON_PERSON_AUTHOR_FIRST_TOKENS = new Set([
    'this', 'the', 'our', 'all', 'these', 'those', 'both', 'each', 'some', 'many', 'most',
    'other', 'another', 'such', 'work', 'paper', 'code', 'dataset', 'data', 'authors', 'author',
    'model', 'models', 'method', 'methods', 'system', 'systems', 'corpus', 'benchmark',
    'experiments', 'results', 'audio', 'speech', 'music', 'video', 'figure', 'table', 'section',
    'appendix', 'funding', 'grant', 'research', 'project', 'corresponding', 'equal', 'joint',
    'manuscript'
]);
const NON_PERSON_AUTHOR_ANY_TOKENS = new Set([
    'and', 'dataset', 'datasets', 'corpus', 'corpora', 'benchmark', 'benchmarks', 'authors',
    'paper', 'work', 'model', 'models', 'code', 'system', 'systems', 'method', 'methods',
    'experiments', 'results', 'manuscript', 'funding', 'independent', 'researcher',
    'researchers', 'speech', 'audio', 'music', 'hearing', 'vision', 'division', 'artificial'
]);

const MIXED_CASE_AI_ORG_LINE_RE = /^[A-Z][a-z][\w.-]*(?:\s+[A-Z][a-z][\w.-]*){0,2}\s+AI$/;
const MULTI_WORD_LOCATION_PHRASE_RE = /^(?:United\s+States(?:\s+of\s+America)?|United\s+Kingdom|South\s+Korea|North\s+Korea|Republic\s+of\s+Korea|Hong\s+Kong|New\s+Zealand|Czech\s+Republic|New\s+York|San\s+Francisco|Los\s+Angeles|Palo\s+Alto|Menlo\s+Park|Redwood\s+City|Ann\s+Arbor|Mountain\s+View|Santa\s+Clara|Santa\s+Barbara|Santa\s+Cruz|Chapel\s+Hill|College\s+Park|San\s+Diego|San\s+Jose|Las\s+Vegas|North\s+Carolina|South\s+Carolina|New\s+Jersey|New\s+Mexico|West\s+Virginia|North\s+Dakota|South\s+Dakota|Rhode\s+Island|New\s+Hampshire|District\s+of\s+Columbia|British\s+Columbia|Nova\s+Scotia|New\s+South\s+Wales|Costa\s+Rica|Saudi\s+Arabia|South\s+Africa|United\s+Arab\s+Emirates|Sri\s+Lanka|Puerto\s+Rico)$/i;
const NOBILIARY_PARTICLES = new Set(['de', 'da', 'di', 'del', 'della', 'der', 'den', 'van', 'von', 'la', 'le', 'du', 'des', 'dos', 'das', 'al', 'el', 'ben', 'bin', 'ibn', 'ter', 'ten']);

function isOrgHeadPlusLocationName(tokens, lowered) {
    if (tokens.some(tok => /^(?:USA|U\.S\.A\.?|US|U\.S\.?|UK|U\.K\.?)$/.test(tok))) return true;
    const hasOrgHead = lowered.some(tok => ORG_HEAD_LOCATION_COLLIDING.has(tok));
    if (!hasOrgHead) return false;
    if (tokens.some((tok, idx) => !ORG_HEAD_LOCATION_COLLIDING.has(lowered[idx]) && isKnownLocationTail(tok))) {
        return true;
    }
    const nonOrgTokens = tokens.filter((_, idx) => !ORG_HEAD_LOCATION_COLLIDING.has(lowered[idx]));
    if (nonOrgTokens.length >= 2) {
        const joined = nonOrgTokens.join(' ');
        if (isKnownLocationTail(joined) || MULTI_WORD_LOCATION_PHRASE_RE.test(joined)) return true;
        for (let span = 2; span <= Math.min(4, nonOrgTokens.length); span++) {
            for (let start = 0; start + span <= nonOrgTokens.length; start++) {
                const sub = nonOrgTokens.slice(start, start + span).join(' ');
                if (isKnownLocationTail(sub) || MULTI_WORD_LOCATION_PHRASE_RE.test(sub)) return true;
            }
        }
    }
    return false;
}

function isMidNameNicknameToken(tok) {
    return /^(?:\([\p{Lu}\p{Lt}][\p{L}\p{M}'’.-]{1,20}\)|"[\p{Lu}\p{Lt}][\p{L}\p{M}'’.-]{1,20}"|“[\p{Lu}\p{Lt}][\p{L}\p{M}'’.-]{1,20}”)$/u.test(tok);
}

function isValidPersonAuthorName(value) {
    const name = normalizeReaderIdentityText(value);
    if (!name || name.length > 80) return false;
    if (/[@\d]|https?:\/\/|www\./i.test(name)) return false;
    if (READER_ROLE_FOOTNOTE_RE.test(name) || READER_UNANCHORED_ROLE_SENTENCE_RE.test(name)
        || isReaderCreditContribution(name)
        || READER_NON_PERSON_AFFILIATION_HINT_RE.test(name)
        || READER_AUTHOR_UPPERCASE_CORP_SUFFIX_RE.test(name)
        || READER_VENUE_OR_STATUS_RE.test(name)
        || READER_SECTION_META_HEADING_RE.test(name)
        || READER_DATE_LINE_RE.test(name) || MULTI_WORD_LOCATION_PHRASE_RE.test(name)
        || NON_PERSON_ORG_TOKEN_CS_RE.test(name)) return false;
    if (/^[\u3400-\u9fff]{2,6}$/.test(name)) return true;
    if (name.length < 3) return false;
    const tokens = name.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 7) return false;
    const lowered = tokens.map(tok => tok.toLowerCase().replace(/^['’.-]+|['’.-]+$/g, ''));
    if (NON_PERSON_AUTHOR_FIRST_TOKENS.has(lowered[0])) return false;
    if (lowered.some(tok => NON_PERSON_AUTHOR_ANY_TOKENS.has(tok) || KNOWN_NON_PERSON_ORG_TOKENS.has(tok))) return false;
    if (isOrgHeadPlusLocationName(tokens, lowered)) return false;
    const lowerSurnameStopwords = new Set([
        'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with'
    ]);
    const lastLower = lowered[tokens.length - 1];
    const hasCapParticleLowerSurname = tokens.length >= 3
        && NOBILIARY_PARTICLES.has(lowered[tokens.length - 2])
        && /^[\p{Lu}\p{Lt}]/u.test(tokens[tokens.length - 2])
        && /^\p{Ll}/u.test(tokens[tokens.length - 1])
        && lastLower.length >= 2
        && !NOBILIARY_PARTICLES.has(lastLower)
        && !lowerSurnameStopwords.has(lastLower);
    if (!/^[\p{Lu}\p{Lt}]/u.test(tokens[tokens.length - 1]) && !hasCapParticleLowerSurname) return false;
    if (!/^[\p{Lu}\p{Lt}]/u.test(tokens[0]) && !NOBILIARY_PARTICLES.has(lowered[0])) return false;
    return tokens.every((tok, idx) => {
        if (idx > 0 && idx < tokens.length - 1 && isMidNameNicknameToken(tok)) {
            return true;
        }
        if (!/^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(tok)) return false;
        if (tok.includes('.')) {
            if (/^(?:[A-Z]\.){2,}$/.test(tok)) {
                if (['U.S.', 'U.K.', 'U.S.A.', 'P.R.', 'E.U.', 'D.C.'].includes(tok)) return false;
                if ((tok.match(/\./g) || []).length >= 3) return false;
            } else if (!/^(?:[\p{Lu}][\p{Ll}]{0,2}\.(?:-[\p{Lu}][\p{Ll}]{0,2}\.?)*|[\p{Lu}]\.[\p{Lu}]\.)$/u.test(tok)
                || ['Co.', 'St.', 'No.', 'Dr.', 'Mr.', 'Ms.', 'Inc.', 'Ltd.'].includes(tok)) {
                return false;
            }
        }
        return true;
    });
}

function getBoundedCacheEntry(cache, key) {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
}

function setBoundedCacheEntry(cache, key, value, maxEntries = AUTHOR_VERIFICATION_CACHE_MAX_ENTRIES) {
    if (cache.has(key)) cache.delete(key);
    else if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
    cache.set(key, value);
    return value;
}

function clearReaderAuthorVerificationCaches() {
    htmlAuthorSourceCache.clear();
    conferencePdfAuthorCache.clear();
    pdfPage1AuthorCache.clear();
    verifiedAuthorMatchCache.clear();
    authorCacheCounters.htmlHits = 0;
    authorCacheCounters.htmlMisses = 0;
    authorCacheCounters.conferencePdfHits = 0;
    authorCacheCounters.conferencePdfMisses = 0;
    authorCacheCounters.pdfPage1Hits = 0;
    authorCacheCounters.pdfPage1Misses = 0;
    authorCacheCounters.verifiedMatchHits = 0;
    authorCacheCounters.verifiedMatchMisses = 0;
}

function getReaderAuthorVerificationCacheStats() {
    return Object.freeze({
        maxEntries: AUTHOR_VERIFICATION_CACHE_MAX_ENTRIES,
        htmlEntries: htmlAuthorSourceCache.size,
        conferencePdfEntries: conferencePdfAuthorCache.size,
        pdfPage1Entries: pdfPage1AuthorCache.size,
        verifiedMatchEntries: verifiedAuthorMatchCache.size,
        ...authorCacheCounters
    });
}


const READER_NON_WS_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

function normalizeReaderIdentityText(value) {
    return String(value || '')
        .replace(/\x86/g, '†')
        .replace(/\x87/g, '‡')
        .replace(READER_NON_WS_CTRL_RE, '')
        .replace(/\s+/g, ' ').trim();
}

function readerIdentityKey(value) {
    return normalizeReaderIdentityText(value).normalize('NFKC').toLocaleLowerCase();
}

function readerIdentityTokens(value) {
    return readerIdentityKey(value).split(/\s+/).filter(Boolean);
}

function isLikelyAuthorEnumeration(value) {
    const text = normalizeReaderIdentityText(value);
    if (!/(?:\band\b|&)/i.test(text)
        || /\b(?:university|institute|institution|school|college|department|laborator(?:y|ies)|centre|center|hospital|academy|research|corporation|company|inc\.?|ltd\.?|gmbh|ai)\b/i.test(text)) {
        return false;
    }
    const parts = text.split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
        .map(part => part.replace(/^and\s+/i, '').trim()).filter(Boolean);
    const nameLike = parts.filter(part => {
        const tokens = part.split(/\s+/).filter(Boolean);
        return tokens.length >= 2 && tokens.length <= 5
            && tokens.every(token => /^[\p{L}][\p{L}'’.-]*$/u.test(token));
    });
    return nameLike.length >= 2 && nameLike.length === parts.length;
}

function buildKnownAuthorIndex(authorNames = []) {
    const exactKeys = new Set();
    const initialLastKeys = new Set();
    const multiTokenKeys = new Set();
    const MAX_MULTI_TOKENS = 8;
    let maxTokens = 0;
    const indexEntry = name => {
        const nk = trimEndChars(readerIdentityKey(name), ',:;').trim();
        if (!nk) return;
        exactKeys.add(nk);
        const words = nk.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2 && words.length <= MAX_MULTI_TOKENS) {
            const wordKey = words.join(' ');
            multiTokenKeys.add(wordKey);
            if (words.length > maxTokens) maxTokens = words.length;
        }
        const foldToks = canonicalAuthorFoldKey(name).split(' ').filter(Boolean);
        if (foldToks.length >= 2 && foldToks.length <= MAX_MULTI_TOKENS) {
            initialLastKeys.add(`${foldToks[0][0]}\0${foldToks[foldToks.length - 1]}`);
        }
    };
    for (const rawName of (authorNames || [])) {
        const str = String(rawName || '');
        if (!str) continue;
        indexEntry(str);
        if (/[,;&]|\band\b/i.test(str)) {
            for (const piece of str.split(/\s*[,;]\s*|\s+and\s+|\s*&\s*/i)) {
                const p = piece.replace(/^(?:and|&)\s+/i, '').trim();
                const pWords = readerIdentityKey(p).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
                if (p && (pWords.length >= 2 || /^[\u3400-\u9fff]{2,6}$/.test(p))) {
                    indexEntry(p);
                }
            }
        }
    }
    return { __knownAuthorIndex: true, exactKeys, initialLastKeys, multiTokenKeys, maxTokens };
}

function countKnownAuthorNames(value, authorNames) {
    if (authorNames && authorNames.__knownAuthorIndex) {
        if (authorNames.multiTokenKeys.size === 0) return 0;
        const words = readerIdentityKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
        if (words.length < 2) return 0;
        const maxN = Math.min(authorNames.maxTokens, words.length);
        const matched = new Set();
        const multi = authorNames.multiTokenKeys;
        for (let i = 0; i < words.length - 1; i++) {
            let phrase = words[i];
            const limit = Math.min(words.length, i + maxN);
            for (let j = i + 1; j < limit; j++) {
                phrase = `${phrase} ${words[j]}`;
                if (multi.has(phrase)) {
                    matched.add(phrase);
                    if (matched.size >= 2) return 2;
                }
            }
        }
        return matched.size;
    }
    const haystack = ` ${readerIdentityKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    return [...new Set((authorNames || []).map(readerIdentityKey).filter(Boolean))]
        .filter(name => {
            const needle = ` ${name.replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
            return needle.trim().split(/\s+/).length >= 2 && haystack.includes(needle);
        }).length;
}

function isReaderResourceAffiliationLabel(value) {
    const text = normalizeReaderIdentityText(value)
        .replace(/^(?:affiliation|institution)\s*[:：]?\s*/i, '');
    // 项目 URL 被删掉之后，可能留下一段看着挺像样的非空标签。这些显式资源标签不是机构
    // 证据。
    return /^(?:project\s+(?:page|website|webpage)|(?:code|demo|dataset)(?:\s+(?:page|website|url|link))?)(?:\s*[:：]\s*.*|\s*)$/i.test(text);
}

const READER_TRAILING_ROLE_CLAUSE_RE = /(?:^|(?<![\s,;—–.-])[\s,;—–.-]+)(?:[*∗†‡⋆§¶‖∥+]\s*)?(?:(?:denotes?|indicates?|signifies|represents?)\s+)?(?:the\s+)?(?:(?:equal\s+contribution|contributed\s+equally|authors?\s+contributed\s+equally|co-?first\s+authors?|joint\s+first\s+authors?|equal\s+advising|equal\s+supervision|core\s+contributors?|corresponding\s+authors?)[.;,:\s—–-]*|(?:corresponding\s+authors?\s*[:：]|author\s+to\s+whom\s+correspondence\s+should\s+be\s+addressed|correspondence(?:\s+(?:to|should\s+be\s+addressed)|\s*[:：])|(?:e-?mails?|contact)\s*[:：]|work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:while|during|at|as))[^;]*)$/i;
const READER_TRAILING_GLUED_SENTENCE_RE = /(\b(?:Ltd|Inc|Corp|Co|Univ|Dept|Lab|Labs|Tech|Inst|St|U\.S\.A|U\.K|U\.S|D\.C|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K)\.)\s+(?:(?:\d{1,2}|[∗*†‡⋆§¶‖∥+]+)\s*)?(?:This\s+(?:work|paper|research|study|article|manuscript)|An\s+earlier\s+version|A\s+preliminary\s+version|Part\s+of\s+this|The\s+(?:authors?|work|paper|code|dataset|source)|Manuscript\s+received|Supported\s+by|Funded\s+by|Digital\s+Object|Copyright|Accepted|Preprint|Published|Submitted|Under\s+review|To\s+appear|Received)\b.*$/i;

function trimEndChars(value, chars) {
    const s = String(value || '');
    let end = s.length;
    while (end > 0 && chars.includes(s[end - 1])) end--;
    return end === s.length ? s : s.slice(0, end);
}

function trimBothChars(value, chars) {
    const s = String(value || '');
    let start = 0;
    let end = s.length;
    while (start < end && chars.includes(s[start])) start++;
    while (end > start && chars.includes(s[end - 1])) end--;
    return (start === 0 && end === s.length) ? s : s.slice(start, end);
}

function matchesInitialedKnownAuthorName(text, authorNames = []) {
    const tokens = trimEndChars(normalizeReaderIdentityText(text), ',:;').trim().split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 4) return false;
    if (!/^[A-Z]\.?$|^[A-Z]\.[A-Z]\.?$/.test(tokens[0])) return false;
    const init = tokens[0][0].toLowerCase();
    const lastKey = canonicalAuthorFoldKey(tokens[tokens.length - 1]);
    if (!lastKey) return false;
    if (authorNames && authorNames.__knownAuthorIndex) {
        return authorNames.initialLastKeys.has(`${init}\0${lastKey}`);
    }
    return (authorNames || []).some(name => {
        const nameTokens = canonicalAuthorFoldKey(name).split(' ').filter(Boolean);
        return nameTokens.length >= 2 && nameTokens[0][0] === init && nameTokens[nameTokens.length - 1] === lastKey;
    });
}

function stripDanglingAffiliationTailEnd(s, end) {
    // Strictly O(n) reverse-scan end cursor stripping trailing delimiters and dangling delimiter/space+dot tails
    // (e.g. "; .", " . . ."), preserving word-attached abbreviation dots like "MIT Inc." and "MIT.".
    const delims = ' \t\r\n,;—–|｜•·-';
    let i = end;
    while (i > 0) {
        while (i > 0 && delims.includes(s[i - 1])) i--;
        if (i > 0 && s[i - 1] === '.') {
            let j = i;
            while (j > 0 && s[j - 1] === '.') j--;
            if (j === 0 || delims.includes(s[j - 1])) {
                i = j;
                continue;
            }
        }
        break;
    }
    return i;
}

function stripDanglingAffiliationTail(value) {
    const s = String(value || '');
    return s.slice(0, stripDanglingAffiliationTailEnd(s, s.length)).trim();
}

const EMAIL_LOCAL_STOP_CHARS = ',;()[]:：|｜<>';

function stripTrailingAtEmailLinear(value) {
    const s = String(value || '');
    if (!s.includes('@')) return s;
    let pos = 0;
    while (pos < s.length) {
        const atIdx = s.indexOf('@', pos);
        if (atIdx < 0) break;
        if (atIdx > 0 && !/\s/.test(s[atIdx - 1]) && !EMAIL_LOCAL_STOP_CHARS.includes(s[atIdx - 1])
            && atIdx + 1 < s.length && !/\s/.test(s[atIdx + 1]) && !EMAIL_LOCAL_STOP_CHARS.includes(s[atIdx + 1])) {
            let cut = atIdx;
            while (cut > 0 && !/\s/.test(s[cut - 1]) && !EMAIL_LOCAL_STOP_CHARS.includes(s[cut - 1])) cut--;
            let pre = cut;
            while (pre > 0 && /\s/.test(s[pre - 1])) pre--;
            if (pre > 0 && (s[pre - 1] === '(' || s[pre - 1] === '[' || s[pre - 1] === '<')) cut = pre - 1;
            while (cut > 0 && (/\s/.test(s[cut - 1]) || s[cut - 1] === ',' || s[cut - 1] === ';')) cut--;
            return s.slice(0, cut);
        }
        pos = atIdx + 1;
    }
    return s;
}

function stripInlineAtEmailsLinear(value) {
    let s = String(value || '');
    if (!s.includes('@')) return s;
    // Strip parenthesized / angle-bracketed / square-bracketed email-only clauses in strictly O(n) time
    // before whitespace tokenization so "(e-mail: a@b.c)", "< a@b.c >", "({alice,bob}@mit.edu)", and
    // "(a@b.c and b@b.c)" leave no dangling brackets while disallowing `@` before the first `@` prevents O(n²).
    const isEmailOnlyClause = innerRaw => {
        const inner = innerRaw.replace(/^\s*(?:e-?mail|emails?)\s*[:：]\s*/i, '').trim();
        if (!inner) return false;
        const collapsed = inner.replace(/\{[^{}@]+\}\s*@\S+/g, 'brace@email');
        const parts = collapsed.split(/[\s,;]+/).filter(p => p && !/^(?:and|&)$/i.test(p));
        return parts.length > 0 && parts.every(p => p.includes('@'));
    };
    if (s.includes('(') && s.includes(')')) {
        s = s.replace(/\([^()@]*@[^()]*\)/g, m => (
            isEmailOnlyClause(m.slice(1, -1)) ? ' ' : m
        ));
    }
    if (s.includes('<') && s.includes('>')) {
        s = s.replace(/<[^<>@]*@[^<>]*>/g, m => (
            isEmailOnlyClause(m.slice(1, -1)) ? ' ' : m
        ));
    }
    if (s.includes('[') && s.includes(']')) {
        s = s.replace(/\[[^\[\]@]*@[^\[\]]*\]/g, m => (
            isEmailOnlyClause(m.slice(1, -1)) ? ' ' : m
        ));
    }
    if (!s.includes('@')) return s.replace(/\s+/g, ' ').trim();
    const out = [];
    for (const tok of s.split(/\s+/)) {
        if (!tok) continue;
        if (!tok.includes('@')) {
            out.push(tok);
            continue;
        }
        // Strictly O(n) single-pass removal of email sub-tokens bounded by non-local-part delimiters
        // (including balanced (...), [...], <...> wrappers around emails).
        const kept = [];
        let lastEnd = 0;
        let searchFrom = 0;
        while (searchFrom < tok.length) {
            const atIdx = tok.indexOf('@', searchFrom);
            if (atIdx < 0) break;
            if (atIdx > lastEnd && !EMAIL_LOCAL_STOP_CHARS.includes(tok[atIdx - 1])
                && atIdx + 1 < tok.length && !EMAIL_LOCAL_STOP_CHARS.includes(tok[atIdx + 1])) {
                let left = atIdx;
                while (left > lastEnd && !EMAIL_LOCAL_STOP_CHARS.includes(tok[left - 1])) left--;
                let right = atIdx + 1;
                while (right < tok.length && !EMAIL_LOCAL_STOP_CHARS.includes(tok[right])) right++;
                if (left > lastEnd && right < tok.length
                    && ((tok[left - 1] === '(' && tok[right] === ')')
                        || (tok[left - 1] === '[' && tok[right] === ']')
                        || (tok[left - 1] === '<' && tok[right] === '>'))) {
                    left--;
                    right++;
                }
                if (left > lastEnd) kept.push(tok.slice(lastEnd, left));
                lastEnd = right;
                searchFrom = right;
            } else {
                searchFrom = atIdx + 1;
            }
        }
        if (lastEnd < tok.length) kept.push(tok.slice(lastEnd));
        const cleaned = trimBothChars(kept.join(''), ',;');
        if (cleaned) out.push(cleaned);
    }
    return out.join(' ');
}

function stripTrailingDoiInTail(tail) {
    // Strictly O(len(tail)) strip of a trailing bare DOI `10.\d{4,9}/[-._;()/:A-Za-z0-9]+`
    if (!tail || !/[A-Za-z0-9._;()/:~-]/.test(tail[tail.length - 1])) return tail;
    let runStart = tail.length;
    while (runStart > 0 && /[A-Za-z0-9\-._;()/:]/.test(tail[runStart - 1])) runStart--;
    const run = tail.slice(runStart);
    let idx = run.indexOf('10.');
    while (idx >= 0) {
        if (idx === 0 || !/\d/.test(run[idx - 1])) {
            if (/^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/.test(run.slice(idx))) {
                let cut = runStart + idx;
                while (cut > 0 && /\s/.test(tail[cut - 1])) cut--;
                return tail.slice(0, cut);
            }
        }
        idx = run.indexOf('10.', idx + 3);
    }
    return tail;
}

function stripTrailingAffiliationDoiAndIdEnd(s, end) {
    while (end > 0) {
        const prevEnd = end;
        end = stripDanglingAffiliationTailEnd(s, end);
        const winStart = Math.max(0, end - 256);
        let tail = s.slice(winStart, end);
        if (tail.includes('-')) {
            const orcidStripped = removeTrailingReaderAuthorIdentifier(tail);
            if (orcidStripped.length < tail.length) {
                end = winStart + orcidStripped.length;
                tail = s.slice(winStart, end);
            }
        }
        if (tail.includes('10.')) {
            const doiStripped = stripTrailingDoiInTail(tail);
            if (doiStripped.length < tail.length) {
                end = winStart + doiStripped.length;
            }
        }
        end = stripDanglingAffiliationTailEnd(s, end);
        if (end >= prevEnd) break;
    }
    return end;
}

function stripTrailingAffiliationDoiAndId(value) {
    let s = String(value || '');
    const barDoi = /[|｜]|DOI\s*:/i.exec(s);
    if (barDoi) {
        let cut = barDoi.index;
        while (cut > 0 && /\s/.test(s[cut - 1])) cut--;
        s = s.slice(0, cut);
    }
    return s.slice(0, stripTrailingAffiliationDoiAndIdEnd(s, s.length)).trim();
}

function stripTrailingFootnoteMark(value) {
    const s = String(value || '');
    if (!/footnotemark/i.test(s)) return s;
    return s.replace(/(?<!\d)\d*\s*(?:\\?footnotemark)\s*:?[\s\d]*.*$/i, '');
}

const READER_PRESERVED_ABBR_DOT_CI_RE = /\b(?:Inc|Ltd|Corp|Co|Univ|Dept|Lab|Labs|Tech|Inst|St|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K)\.$/i;
const READER_PRESERVED_ACRONYM_DOT_RE = /(?:[A-Z]\.){2,}$/;

function hasPreservedAbbreviationDot(value) {
    const s = String(value || '');
    return READER_PRESERVED_ABBR_DOT_CI_RE.test(s) || READER_PRESERVED_ACRONYM_DOT_RE.test(s);
}

function stripNonAbbreviationTrailingDot(value) {
    let s = trimEndChars(String(value || ''), ';,').trim();
    if (s.endsWith('.') && !hasPreservedAbbreviationDot(s)) {
        s = trimEndChars(s, '.');
    }
    return trimEndChars(s, ';,').trim();
}

function sanitizeReaderAffiliationValue(value, authorNames = []) {
    let cleaned = normalizeReaderIdentityText(value)
        .replace(/^(?:affiliations?|institutions?)\s*[:：]\s*/i, '');
    // Strip leaked raw LaTeX macros / key-value metadata fragments (strictly O(n) non-nested; (?![A-Za-z]) prevents mangling \institute / \correspondence)
    if (cleaned.includes('\\')) {
        cleaned = cleaned
            .replace(/\\(?:institution|affiliation|authorblockA|authorrefmark|IEEEauthorrefmark|inst|email|thanks|sthanks|corresponding|corr|reinorcid)(?![A-Za-z])(?:\{[^}{]*\}|\d{4}-\d{4}-\d{4}-\d{3}[\dX]|\d{1,2})?\s*/gi, ' ')
            .replace(/\s+/g, ' ').trim();
    }
    if (cleaned.includes('=')) {
        cleaned = cleaned
            .replace(/\b(?:organization|addressline|city|state|country)\s*=\s*\{?([^},;]+)\}?/gi, '$1')
            .replace(/,?\s*\bpostcode\s*=\s*\{?[^},;]+\}?/gi, '')
            .replace(/\s+/g, ' ').trim();
    }
    // Strip parenthetical / inline email & URL clauses before tail-windowed role stripping (strictly O(n))
    const braceDomainPat = '(?:@|[a-z0-9.-]+\\.(?:edu|com|org|cn|net|io|ai|gov|de|uk|fr|jp|kr|ca|ch|sg|au|nl|eu|ac\\.[a-z]{2}|co\\.[a-z]{2}|edu\\.[a-z]{2})\\b)';
    if (cleaned.includes('(') && cleaned.includes(')')) {
        cleaned = cleaned.replace(/ ?\( ?(?:e-?mail|emails?|corresponding\s+author|work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:while|during|at|as)|equal\s+contribution|contributed\s+equally)[^()]*\)/gi, ' ');
        cleaned = cleaned.replace(/ ?\( ?(?:https?:\/\/|www\.)[^()]*\)/gi, ' ');
        if (cleaned.includes('{') && cleaned.includes('}')) {
            cleaned = cleaned.replace(new RegExp(` ?\\( ?\\{[^}{]+\\} ?${braceDomainPat}[^()]*\\)`, 'gi'), ' ');
        }
        cleaned = cleaned.replace(/\s+/g, ' ').trim();
    }
    if (cleaned.includes(':') || cleaned.includes('：')) {
        cleaned = cleaned.replace(/,?(?: ?[\(\[<] ?| ?)(?:e-?mail|emails?) ?[:：] ?\S+.*$/i, '');
    }
    if (cleaned.includes('{')) {
        if (cleaned.includes('}')) {
            cleaned = cleaned.replace(new RegExp(`(?: ?[\\(\\[<] ?| ?)\\{[^}{]+\\} ?${braceDomainPat}\\S*.*$`, 'i'), '');
        }
        // Strip unclosed email-brace tails like "Shanghai Jiao Tong University{chenchiyu, ma_yuezhao,"
        cleaned = cleaned.replace(/(?: ?[\(\[<] ?| ?)\{[a-z0-9_+.,\s-]*$/i, '');
    }
    cleaned = stripTrailingAtEmailLinear(cleaned);
    if (/https?:\/\/|www\./i.test(cleaned)) {
        cleaned = cleaned.replace(/,?(?: ?[\(\[<] ?| ?)(?:https?:\/\/|www\.)\S+.*$/i, '');
    }
    cleaned = cleaned
        .replace(READER_TRAILING_GLUED_SENTENCE_RE, '$1')
        .replace(/\s+/g, ' ').trim();
    if (!cleaned || READER_ROLE_FOOTNOTE_RE.test(cleaned) || READER_IEEE_MEMBER_ONLY_RE.test(cleaned)) return '';
    // Strip leftmost '|', '｜', or 'DOI:' once in strictly O(n) time before end-cursor stripping.
    const barDoi = /[|｜]|DOI\s*:/i.exec(cleaned);
    if (barDoi) {
        let cut = barDoi.index;
        while (cut > 0 && /\s/.test(cleaned[cut - 1])) cut--;
        cleaned = cleaned.slice(0, cut);
    }
    // Strictly O(n) end-cursor stripping loop for chained ORCID/DOI/role clauses (zero prefix copying).
    let end = stripTrailingAffiliationDoiAndIdEnd(cleaned, cleaned.length);
    while (end > 0) {
        const lastSemi = cleaned.lastIndexOf(';', end - 1);
        const winStart = lastSemi >= 0 && end - lastSemi <= 1024
            ? lastSemi
            : Math.max(0, end - 1024);
        const tail = cleaned.slice(winStart, end);
        const nextTail = tail.replace(READER_TRAILING_ROLE_CLAUSE_RE, '');
        if (nextTail.length >= tail.length) break;
        end = stripTrailingAffiliationDoiAndIdEnd(cleaned, winStart + nextTail.length);
    }
    let text = trimBothChars(cleaned.slice(0, stripTrailingAffiliationDoiAndIdEnd(cleaned, end)).trim(), ' ,;|｜•·—–-').trim();
    if (text.endsWith('.') && !hasPreservedAbbreviationDot(text)) {
        text = trimEndChars(text, '.').trim();
    }
    text = trimBothChars(text, ' ,;|｜•·—–-').replace(/\s+/g, ' ').trim();
    const normalizedText = trimEndChars(readerIdentityKey(text), ',:;').trim();
    const colonPrefixRaw = text.includes(':') ? text.slice(0, text.indexOf(':')).trim() : '';
    const colonPrefixKey = colonPrefixRaw ? trimEndChars(readerIdentityKey(colonPrefixRaw), ',:;').trim() : '';
    const isExactKnownAuthorName = (authorNames && authorNames.__knownAuthorIndex)
        ? (authorNames.exactKeys.has(normalizedText) || (colonPrefixKey.length > 0 && authorNames.exactKeys.has(colonPrefixKey)))
        : (authorNames || []).some(name => {
            const nk = trimEndChars(readerIdentityKey(name), ',:;').trim();
            return nk.length > 0 && (normalizedText === nk || (colonPrefixKey.length > 0 && colonPrefixKey === nk));
        });
    if (text.length < 3
        || isReaderResourceAffiliationLabel(text)
        || READER_RESOURCE_LABEL_ONLY_RE.test(text)
        || READER_DATE_LINE_RE.test(text)
        || READER_VENUE_OR_STATUS_RE.test(text)
        || /^(?:keywords?|index\s+terms)\s*[:：—–-]/i.test(text)
        || READER_ROLE_FOOTNOTE_RE.test(text)
        || READER_UNANCHORED_ROLE_SENTENCE_RE.test(text)
        || READER_SECTION_META_HEADING_RE.test(text)
        || READER_BARE_DOMAIN_FRAGMENT_RE.test(text)
        || isReaderCreditContribution(text)
        || /\bequal\s+contribution\b/i.test(text)
        || READER_IEEE_MEMBER_ONLY_RE.test(text)
        || /\b(?:is|are|was|were)\s+(?:also\s+|now\s+)?(?:with|affiliated\s+with|from)\b/i.test(text)
        || /^(?:denotes?|indicates?|authors?)$/i.test(text)
        || /https?:\/\/|www\./i.test(text)
        || /@/.test(text)
        || /,\s*,/.test(text)
        || isExactKnownAuthorName
        || matchesInitialedKnownAuthorName(text, authorNames)
        || (colonPrefixRaw && matchesInitialedKnownAuthorName(colonPrefixRaw, authorNames))
        || countKnownAuthorNames(text, authorNames) >= 2
        || (legacyReplayPreservePureLocationDepth === 0 && isReaderPureLocationOnly(text))
        || isLikelyAuthorEnumeration(text)) {
        return '';
    }
    return text;
}

// 作者标识有时作为纯文本跟在机构后面；只去掉末尾且校验位正确的 ORCID。
// 校验规则：https://support.orcid.org/hc/en-us/articles/360006897674
function removeTrailingReaderAuthorIdentifier(value) {
    const str = String(value);
    const winStart = Math.max(0, str.length - 128);
    const tail = str.slice(winStart);
    if (!tail.includes('-')) return value;
    const match = tail.match(/(?:^|(?<![\s,;])[\s,;]+)(?:ORCID(?:\s+iD)?\s*[:：]?\s*)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\.?\s*$/i);
    if (!match || match[1].endsWith('x')) return value;
    const digits = match[1].replace(/-/g, '').toUpperCase();
    let total = 0;
    for (const digit of digits.slice(0, -1)) total = (total + Number(digit)) * 2;
    const remainder = (12 - (total % 11)) % 11;
    if ((remainder === 10 ? 'X' : String(remainder)) !== digits.at(-1)) return value;
    return str.slice(0, winStart + match.index).trim();
}

const DOM_URL_CLASS_SET = new Set(['ltx_url']);
const DOM_NOTE_MARK_CLASS_SET = new Set(['ltx_note_mark']);
const DOM_NAME_SKIP_CLASSES = new Set(['ltx_note_mark', 'ltx_note', 'ltx_tag']);
const DOM_AFF_SKIP_CLASSES = new Set([
    'ltx_contact_name', 'ltx_contact_email', 'ltx_role_email',
    'ltx_note_mark', 'ltx_note', 'ltx_tag'
]);
const DOM_MARKER_SKIP_CLASSES = new Set(['ltx_contact_name', 'ltx_contact_email', 'ltx_role_email', 'ltx_tag']);
const DOM_NOTE_CLASS_SET = new Set(['ltx_note']);
const DOM_NOTE_BODY_CLASSES = new Set(['ltx_note_outer', 'ltx_note_content', 'ltx_note_type']);

function domNodeRoots(node) {
    if (!node) return [];
    if (typeof node.toArray === 'function') return node.toArray();
    return Array.isArray(node) ? node : [node];
}

function domHasAnyClass(el, classSet) {
    const raw = el && el.attribs && el.attribs.class;
    if (!raw) return false;
    for (const cls of raw.trim().split(/\s+/)) {
        if (classSet.has(cls)) return true;
    }
    return false;
}

function domCollectChildrenText(root, onElement = () => 'descend') {
    const parts = [];
    const stack = [];
    const roots = domNodeRoots(root);
    for (let ri = roots.length - 1; ri >= 0; ri--) {
        const r = roots[ri];
        if (!r) continue;
        if (r.type === 'text') {
            stack.push(r);
        } else if (Array.isArray(r.children) && r.children.length > 0) {
            for (let i = r.children.length - 1; i >= 0; i--) stack.push(r.children[i]);
        }
    }
    while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur) continue;
        if (cur.type === 'text') {
            if (cur.data) parts.push(cur.data);
            continue;
        }
        if (cur.type !== 'tag' && cur.type !== 'script' && cur.type !== 'style') continue;
        const action = onElement(cur, parts);
        if (action === 'skip') continue;
        if (Array.isArray(cur.children) && cur.children.length > 0) {
            for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]);
        }
    }
    return parts.join('');
}

function isSkippedAnchorHref(hrefRaw) {
    const href = String(hrefRaw || '').trim().toLowerCase();
    return href.startsWith('http://') || href.startsWith('https://')
        || href.startsWith('mailto:') || href.includes('orcid.org');
}

function cleanReaderAffiliationNode($, node, authorNames = []) {
    const rawText = domCollectChildrenText(node, (el, parts) => {
        const tag = String(el.name || '').toLowerCase();
        if (tag === 'sup') {
            const supText = domCollectChildrenText(el).trim();
            if (parts.length > 0 && /\d$/.test(parts[parts.length - 1]) && /^(?:st|nd|rd|th)$/i.test(supText)) {
                parts.push(supText);
            }
            return 'skip';
        }
        if (domHasAnyClass(el, DOM_AFF_SKIP_CLASSES)) return 'skip';
        if (tag === 'a') {
            if (domHasAnyClass(el, DOM_URL_CLASS_SET) || isSkippedAnchorHref(el.attribs?.href)) {
                return 'skip';
            }
        }
        if (tag === 'br' || tag === 'p' || tag === 'div') {
            if (parts.length > 0 && !/\s$/.test(parts[parts.length - 1])) parts.push(' ');
            if (tag === 'br') return 'skip';
        }
        return 'descend';
    });
    // Separate CamelCase element-boundary gluing like "SciencesCorresponding author" or "AutomationChinese Academy"
    const spacedRaw = rawText.replace(/([a-z])((?:Corresponding|Equal|Project|University|Chinese|Institute|Department|School|Faculty|College|Center|Centre|Laboratory|Academy|National|State)\b)/g, '$1 $2');
    return sanitizeReaderAffiliationValue(spacedRaw, authorNames);
}

function cleanReaderAuthorNameNode($, node) {
    const rawText = domCollectChildrenText(node, el => {
        const tag = String(el.name || '').toLowerCase();
        if (tag === 'sup' || tag === 'math' || domHasAnyClass(el, DOM_NAME_SKIP_CLASSES)) return 'skip';
        if (tag === 'a') {
            if (domHasAnyClass(el, DOM_URL_CLASS_SET) || isSkippedAnchorHref(el.attribs?.href)) {
                return 'skip';
            }
        }
        return 'descend';
    });
    let cleaned = stripTrailingFootnoteMark(normalizeReaderIdentityText(rawText));
    if (cleaned.includes('\\')) {
        cleaned = cleaned.replace(/\\(?:authorblockN|authorrefmark|IEEEauthorrefmark|inst|sthanks|corresponding|corr|reinorcid)(?![A-Za-z])(?:\{[^}{]*\}|\d{4}-\d{4}-\d{4}-\d{3}[\dX]|\d{1,2})?/gi, ' ');
    }
    cleaned = cleaned.replace(/\s+/g, ' ').replace(/^(?:and|&)\s+/i, '');
    cleaned = stripInlineAtEmailsLinear(
        cleaned.replace(/,?\s?\b(?:Life\s+)?(?:Student\s+|Graduate\s+Student\s+|Senior\s+|Associate\s+)?(?:Member|Fellow)\s*,\s*IEEE\b/gi, '')
    );
    const trailingStripped = /\+\+$/.test(cleaned)
        ? trimEndChars(cleaned, '∗*†‡⋆§¶‖∥#\uf02a')
        : trimEndChars(cleaned, '∗*†‡⋆§¶‖∥#+\uf02a');
    return trimBothChars(
        trailingStripped.replace(/\s+/g, ' '),
        ',; \t\r\n'
    );
}

function parseReaderThanksAffiliations($, knownAuthorNames = []) {
    const mappings = new Map();
    const sourceNodes = [];
    const thanksNodes = [
        ...$('.ltx_title_document .ltx_pubnote.ltx_role_thanks').toArray(),
        ...$('.ltx_authors .ltx_note.ltx_role_thanks').toArray(),
        ...$('.ltx_title_document .ltx_note.ltx_role_thanks').toArray()
    ];
    const seenNodes = new Set();
    const pendingClauses = [];
    const verbReGlobal = /\b(?:is|are|was|were)\s+(?:also\s+|now\s+)?(?:with|affiliated\s+with|from)\b/gi;
    const verbReTest = /\b(?:is|are|was|were)\s+(?:also\s+|now\s+)?(?:with|affiliated\s+with|from)\b/i;
    const nobiliaryPat = '(?:de|del|della|der|di|du|da|do|dos|das|la|le|lo|van|von|den|ten|ter|al|el|ben|ibn|bin|st\\.?)';
    const thanksTailPredPat = '(?:(?:is|are|was|were)\\s+(?:also\\s+|now\\s+)?(?:with|affiliated\\s+with|from)\\b|,|and\\b|&)';
    const surnameBeforeVerbRe = new RegExp(
        `^(?:(?:[\\p{Lu}]\\.?\\s+){1,2}[\\p{Lu}][\\p{L}'’-]*|(?:${nobiliaryPat}\\s+){1,2}[\\p{L}][\\p{L}'’-]*|[\\p{Lu}][\\p{L}'’-]*)(?=\\s+${thanksTailPredPat})`,
        'iu'
    );
    const fullNewAuthorClauseRe = new RegExp(
        `^([\\p{Lu}][\\p{Ll}'’-]+)\\s+[\\p{Lu}][\\p{L}'’-]+(?:\\s+[\\p{Lu}][\\p{L}'’-]+)?\\s+${thanksTailPredPat}`,
        'u'
    );
    const clauseSepRe = /(?<=\b(?:Inc|Ltd|Co|Corp|Univ|Dept|Lab|Labs|Tech|Inst|St|U\.S\.A|U\.K|U\.S|D\.C|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K))\.\s+(?:(?:and|while|whereas)\s+)?|,\s*(?:and|while|whereas)\s+|\s+(?:and|while|whereas)\s+|,\s+/gi;
    const knownAuthorProfiles = [];
    const knownProfilesByKey = new Map();
    const seenKnownProfileFolds = new Set();
    const addKnownKey = rawStr => {
        const profile = canonicalAuthorTier3Profile(rawStr);
        if (!profile.fold || profile.fold.split(' ').length < 2) return;
        if (!seenKnownProfileFolds.has(profile.fold)) {
            seenKnownProfileFolds.add(profile.fold);
            knownAuthorProfiles.push(profile);
            for (const k of profile.keys) {
                let bucket = knownProfilesByKey.get(k);
                if (!bucket) {
                    bucket = [];
                    knownProfilesByKey.set(k, bucket);
                }
                bucket.push(profile);
            }
        }
    };
    for (const rawName of (knownAuthorNames || [])) {
        const cleanedRaw = normalizeReaderIdentityText(rawName);
        if (!cleanedRaw) continue;
        addKnownKey(cleanedRaw);
        // Also expand multi-author combined nodes (e.g. "Alice Brown, Bob White")
        for (const piece of cleanedRaw.split(/\s*[,;]\s*|\s+and\s+|\s*&\s*/i)) {
            const p = piece.replace(/^(?:and|&)\s+/i, '').trim();
            if (p && canonicalAuthorFoldKey(p).split(' ').length >= 2) addKnownKey(p);
        }
    }
    const matchesKnownAuthorProfile = tok => {
        if (!knownAuthorProfiles.length) return false;
        const tp = canonicalAuthorTier3Profile(tok);
        if (!tp.fold) return false;
        for (const k of tp.keys) {
            const bucket = knownProfilesByKey.get(k);
            if (!bucket) continue;
            for (const kp of bucket) {
                if (kp.nick && tp.nick && kp.nick !== tp.nick) continue;
                if (kp.middleInitials.length > 0 && tp.middleInitials.length > 0
                    && kp.middleInitials.join(' ') !== tp.middleInitials.join(' ')) continue;
                return true;
            }
        }
        return false;
    };
    const splitAuthorSubjectTokens = subject => String(subject || '').trim()
        .split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
        .map(name => name.replace(/^(?:and|&)\s+/i, '').trim())
        .filter(Boolean);
    const splitThanksClauses = sentence => {
        const out = [];
        for (const semiPart of sentence.split(/\s*;\s*/)) {
            const verbs = [...semiPart.matchAll(verbReGlobal)];
            if (verbs.length <= 1) {
                out.push(semiPart);
                continue;
            }
            const cuts = [];
            for (let vIdx = 0; vIdx < verbs.length - 1; vIdx++) {
                const winStart = verbs[vIdx].index + verbs[vIdx][0].length;
                const winEnd = verbs[vIdx + 1].index;
                const window = semiPart.slice(winStart, winEnd);
                const matches = [...window.matchAll(clauseSepRe)];
                const tier3 = [];
                const tierDot = [];
                const tier2 = [];
                const tier1 = [];
                // Right-to-left suffix validation: each inter-separator segment is validated at most once -> strictly O(m).
                const firstNonWs = window.search(/\S/);
                let suffixValid = true;
                let suffixAllKnown = knownAuthorProfiles.length > 0;
                for (let mi = matches.length - 1; mi >= 0; mi--) {
                    const bm = matches[mi];
                    const isAbbrDot = bm[0].startsWith('.');
                    const cutRelStart = bm.index + (isAbbrDot ? 1 : 0);
                    const cutRelEnd = bm.index + bm[0].length;
                    const nextBoundary = mi + 1 < matches.length
                        ? matches[mi + 1].index + (matches[mi + 1][0].startsWith('.') ? 1 : 0)
                        : window.length;
                    if (mi + 1 < matches.length) {
                        const nextSep = matches[mi + 1][0];
                        const nextIsAuthorJoiner = !nextSep.startsWith('.')
                            && !/\b(?:while|whereas)\b/i.test(nextSep);
                        if (!nextIsAuthorJoiner) {
                            suffixValid = false;
                            suffixAllKnown = false;
                        }
                    }
                    if (!suffixValid) break;
                    const segText = window.slice(cutRelEnd, nextBoundary).trim();
                    const segTokens = splitAuthorSubjectTokens(segText);
                    if (segTokens.length === 0 || segTokens.some(tok => !isValidPersonAuthorName(tok))) {
                        suffixValid = false;
                        suffixAllKnown = false;
                        break;
                    }
                    if (suffixAllKnown && !segTokens.every(matchesKnownAuthorProfile)) {
                        suffixAllKnown = false;
                    }
                    if (firstNonWs < 0 || cutRelStart <= firstNonWs) continue;
                    const isConj = !isAbbrDot && /\b(?:and|while|whereas)\b/i.test(bm[0]);
                    const hasCommaConj = !isAbbrDot && /^,\s*(?:and|while|whereas)\s+$/i.test(bm[0]);
                    const absStart = winStart + cutRelStart;
                    const absEnd = winStart + cutRelEnd;
                    if (suffixAllKnown) {
                        tier3.push([absStart, absEnd]);
                    } else if (isAbbrDot) {
                        tierDot.push([absStart, absEnd]);
                    } else if (isConj) {
                        tier2.push([absStart, absEnd, hasCommaConj, cutRelStart]);
                    } else {
                        const prevComma = window.lastIndexOf(',', cutRelStart - 1);
                        const leftLastCommaSeg = window.slice(prevComma + 1, cutRelStart).trim();
                        tier1.push([absStart, absEnd, leftLastCommaSeg]);
                    }
                }
                tier3.reverse();
                tierDot.reverse();
                tier2.reverse();
                tier1.reverse();
                let chosen = null;
                if (tier3.length > 0) {
                    // Pick leftmost Tier-3 cut so "MIT, Bob White and Carol Davis" cuts before Bob White
                    chosen = tier3[0];
                } else if (tierDot.length > 0) {
                    chosen = tierDot[0];
                } else if (tier2.length > 0) {
                    const commaT2 = tier2.filter(item => item[2]);
                    const firstT2Start = tier2[0][0];
                    if (commaT2.length > 0 && commaT2[0][0] === firstT2Start) {
                        const [cStart, cEnd, , cRelStart] = commaT2[0];
                        let trailingAuthors = 0;
                        if (commaT2.length === 1) {
                            let segEnd = cRelStart;
                            while (segEnd > 0) {
                                const cIdx = window.lastIndexOf(',', segEnd - 1);
                                const segPiece = window.slice(cIdx + 1, segEnd).trim();
                                if (isValidPersonAuthorName(segPiece)) {
                                    trailingAuthors++;
                                    if (cIdx < 0) break;
                                    segEnd = cIdx;
                                } else {
                                    break;
                                }
                            }
                        }
                        const earlierT1 = trailingAuthors >= 2
                            ? tier1.filter(([, e, lastSeg]) => e <= cStart && !isValidPersonAuthorName(lastSeg))
                            : [];
                        chosen = earlierT1.length > 0
                            ? [earlierT1[0][0], earlierT1[0][1]]
                            : [cStart, cEnd];
                    } else {
                        const earlierT1 = tier1.filter(([, e, lastSeg]) => e <= firstT2Start && !isValidPersonAuthorName(lastSeg));
                        chosen = earlierT1.length > 0
                            ? [earlierT1[0][0], earlierT1[0][1]]
                            : [tier2[0][0], tier2[0][1]];
                    }
                } else if (tier1.length > 0) {
                    chosen = [tier1[tier1.length - 1][0], tier1[tier1.length - 1][1]];
                }
                if (chosen) cuts.push(chosen);
            }
            let pos = 0;
            for (const [cStart, cEnd] of cuts) {
                out.push(semiPart.slice(pos, cStart));
                pos = cEnd;
            }
            out.push(semiPart.slice(pos));
        }
        return out;
    };
    thanksNodes.forEach(node => {
        if (seenNodes.has(node)) return;
        seenNodes.add(node);
        sourceNodes.push($.html(node));
        const note = $(node).clone();
        note.find('.ltx_note_name, .ltx_note_mark, .ltx_note_type, .ltx_tag, sup').remove();
        // Replace parenthetical email / corresponding clauses with sentence breaks BEFORE splitting sentences (strictly O(n) non-nested)
        const normNoteText = normalizeReaderIdentityText(note.text());
        const rawText = (normNoteText.includes('(') && normNoteText.includes(')'))
            ? normNoteText.replace(/\((?:e-?mail|emails?|corresponding\s+author)[^()]*\)\s*\.?/gi, ' . ')
            : normNoteText;
        // Sentence split respecting abbreviations and Unicode/multi-letter initials, while breaking before new funding/venue sentences
        const abbrCiRe = /\b(?:Co|Ltd|Inc|Corp|Dept|Univ|Lab|Tech|Inst|Prof|Dr|Mr|Ms|Jr|Sr|St|No|Vol|Fig|al|vs|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K)\.$/i;
        const endsWithNameInitial = (partText, bufHasVerb, nxtPart) => {
            const trimmed = String(partText || '').trim();
            if (!trimmed) return false;
            const lastTok = trimmed.split(/\s+/).at(-1).replace(/^[([\"'“‘]+/, '');
            if (!lastTok.endsWith('.') || ['U.S.', 'U.K.', 'U.S.A.', 'D.C.', 'P.R.', 'E.U.'].includes(lastTok)) return false;
            const hp = lastTok.includes('-') ? lastTok.split('-').at(-1) : lastTok;
            const core = hp.slice(0, -1);
            if (/^\p{Lu}$/u.test(core)) {
                if (bufHasVerb && nxtPart) {
                    const mFull = fullNewAuthorClauseRe.exec(nxtPart);
                    if (mFull && !NOBILIARY_PARTICLES.has(mFull[1].toLowerCase().replace(/\.$/, ''))) {
                        return false;
                    }
                }
                return true;
            }
            if (/^\p{Lu}\p{Ll}{1,2}$/u.test(core)) {
                return !bufHasVerb || Boolean(nxtPart && /^\p{Lu}/u.test(nxtPart) && surnameBeforeVerbRe.test(nxtPart));
            }
            return false;
        };
        const newSentenceStartRe = /^(?:(?:\d{1,2}|[∗*†‡⋆§¶‖∥+]+)\s*)?(?:This\s+(?:work|paper|research|study|article|manuscript)|An\s+earlier\s+version|A\s+preliminary\s+version|Part\s+of\s+this|The\s+(?:authors?|work|paper|code|dataset|source)|Manuscript\s+received|Digital\s+Object|Corresponding\s+author|Work\s+(?:was\s+)?(?:done|supported|funded)|Supported\s+by|Funded\s+by|Copyright|Email|E-?mail|GitHub|Code|Project|Accepted|Preprint|Published|Submitted|Under\s+review|To\s+appear|Received)\b/i;
        const rawParts = rawText.split(/(?<=\.)\s+/);
        const sentences = [];
        let bufParts = [];
        let bufHasVerb = false;
        for (let pIdx = 0; pIdx < rawParts.length; pIdx++) {
            const part = rawParts[pIdx];
            bufParts.push(part);
            if (!bufHasVerb && verbReTest.test(part)) bufHasVerb = true;
            const nextPart = pIdx + 1 < rawParts.length ? rawParts[pIdx + 1] : '';
            let nextLookahead = nextPart;
            if (/^\p{Lu}\.$/u.test(nextPart)) {
                let lIdx = pIdx + 2;
                const pieces = [nextPart];
                while (lIdx < rawParts.length && pieces.length < 3) {
                    pieces.push(rawParts[lIdx]);
                    if (!/^\p{Lu}\.$/u.test(rawParts[lIdx])) break;
                    lIdx++;
                }
                nextLookahead = pieces.join(' ');
            }
            if (!(abbrCiRe.test(part) || endsWithNameInitial(part, bufHasVerb, nextLookahead)) || (nextPart && newSentenceStartRe.test(nextPart))) {
                sentences.push(bufParts.join(' '));
                bufParts = [];
                bufHasVerb = false;
            }
        }
        if (bufParts.length) sentences.push(bufParts.join(' '));
        for (const rawSentence of sentences) {
            const cleanedSentence = stripNonAbbreviationTrailingDot(rawSentence);
            for (const rawClause of splitThanksClauses(cleanedSentence)) {
                const text = stripNonAbbreviationTrailingDot(rawClause);
                const match = text.match(/^(.+?)\s+(?:is\s+also\s+with|are\s+also\s+with|is\s+now\s+with|are\s+now\s+with|is\s+with|are\s+with|was\s+with|were\s+with|is\s+affiliated\s+with|are\s+affiliated\s+with|is\s+from|are\s+from)\s+(.+)$/i);
                if (!match) continue;
                const namesPart = match[1].replace(/^\([^()]*\)\s*/, '').trim();
                const names = splitAuthorSubjectTokens(namesPart);
                if (names.length === 0 || names.some(name => !isValidPersonAuthorName(name))) continue;
                pendingClauses.push({ names, rawAff: match[2] });
            }
        }
    });
    const allKnownIndex = buildKnownAuthorIndex([...(knownAuthorNames || []), ...pendingClauses.flatMap(clause => clause.names)]);
    for (const clause of pendingClauses) {
        const affiliation = sanitizeReaderAffiliationValue(clause.rawAff.replace(/^the\s+/i, ''), allKnownIndex);
        if (!affiliation) continue;
        for (const name of clause.names) {
            const key = readerIdentityKey(name);
            const current = mappings.get(key) || { name, affiliations: [] };
            if (!current.affiliations.includes(affiliation)) current.affiliations.push(affiliation);
            mappings.set(key, current);
        }
    }
    return { mappings, sourceNodes };
}

function parseReaderAuthorTable($) {
    // 有些会议模板把作者块放进普通的导言区表格，既没有 ltx_authors 也没有引文元数据。
    // 只有明确的上标关联才算数；绝不按行序推断关联。
    const tables = [];
    let reachedSection = false;
    $('table, section, .ltx_section').each((_, node) => {
        if ($(node).is('section, .ltx_section')) reachedSection = true;
        else if (!reachedSection && !$(node).parents('table, .ltx_figure, .ltx_table').length) {
            tables.push(node);
        }
    });
    const candidates = [];
    for (const table of tables) {
        const rows = $(table).find('tr').toArray();
        if (rows.length < 2 || rows.length > 101
            || rows.some(row => $(row).children('td, th').length !== 1)) continue;
        const markedCellText = row => {
            const cell = $(row).children('td, th').first().clone();
            let valid = true;
            cell.find('sup').each((_, marker) => {
                const label = normalizeReaderIdentityText($(marker).text()).replace(/\s+/g, '');
                if (!/^[1-9]\d{0,2}(?:,[1-9]\d{0,2})*$/.test(label)) valid = false;
                $(marker).replaceWith(`[[AUTHOR_AFF:${label}]]`);
            });
            return valid ? normalizeReaderIdentityText(cell.text()) : '';
        };
        const nameText = markedCellText(rows[0]);
        if (!nameText.includes('[[AUTHOR_AFF:')) continue;
        const nameMatches = [...nameText.matchAll(/(?:^|(?<=\]\]))([^\[\]]+)\[\[AUTHOR_AFF:([\d,]+)\]\]/g)];
        if (!nameMatches.length || nameMatches.length > 100
            || nameMatches.map(match => match[0]).join('') !== nameText) continue;
        const entries = nameMatches.map(match => ({
            name: normalizeReaderIdentityText(match[1]).replace(/^(?:[,;]\s*|(?:and|&)\s+)/i, ''),
            labels: match[2].split(',')
        }));
        const names = entries.map(entry => entry.name);
        const isName = name => /^[\u3400-\u9fff]{2,8}$/.test(name)
            || /^(?:[\p{Lu}\p{Lt}][\p{L}’'.-]*\s+){1,7}[\p{Lu}\p{Lt}][\p{L}’'.-]*$/u.test(name);
        if (names.some(name => !isName(name))
            || new Set(names.map(readerIdentityKey)).size !== names.length) continue;
        const affiliations = new Map();
        let valid = true;
        for (const row of rows.slice(1)) {
            const match = markedCellText(row).match(/^\[\[AUTHOR_AFF:([1-9]\d{0,2})\]\]\s*([^\[\]]+)$/);
            const affiliation = match ? sanitizeReaderAffiliationValue(match[2], names) : '';
            if (!match || !affiliation || affiliations.has(match[1])) {
                valid = false;
                break;
            }
            affiliations.set(match[1], affiliation);
        }
        if (!valid || entries.some(entry => entry.labels.some(label => !affiliations.has(label)))) continue;
        candidates.push({
            authors: entries.map(entry => ({
                name: entry.name,
                affiliations: [...new Set(entry.labels.map(label => affiliations.get(label)))]
            })),
            sourceDomSha256: crypto.createHash('sha256').update($.html(table)).digest('hex')
        });
    }
    return candidates.length === 1 ? candidates[0] : null;
}

// A captured group label is not a per-person affiliation merely because it sits in the last creator.
// This deliberately downgrades only the complete, otherwise-unbound trailing multi-institution shape.
function rejectUnboundTrailingAffiliationGroup(authors, labeledGroups) {
    if (!Array.isArray(authors) || authors.length < 2) return authors;
    const last = authors.at(-1), unavailable = value => /^机构信息未/.test(String(value || ''));
    if (!authors.slice(0, -1).every(author => Array.isArray(author.affiliations)
        && author.affiliations.every(unavailable)) || !Array.isArray(last.affiliations)
        || last.affiliations.length !== 1 || unavailable(last.affiliations[0])) return authors;
    const target = normalizeReaderIdentityText(last.affiliations[0]);
    const ambiguous = labeledGroups.some(value => {
        const match = String(value || '').match(/^\s*(?:Affiliations?|Institutions?)\s*[:：]\s*([\s\S]+)$/i);
        if (!match) return false;
        const normalizedRaw = normalizeReaderIdentityText(match[1]);
        const normalizedSanitized = normalizeReaderIdentityText(sanitizeReaderAffiliationValue(match[1]));
        if (normalizedRaw !== target && normalizedSanitized !== target) return false;
        const parts = match[1].split(/[\u2002-\u200b\u3000]+| {2,}/u).map(item => item.trim()).filter(Boolean);
        return parts.length > 1 && parts.every(item => item.length >= 3);
    });
    return ambiguous ? authors.map((author, index) => index === authors.length - 1
        ? { ...author, affiliations: [READER_AFFILIATION_UNBOUND] } : author) : authors;
}

const HTML_MARKER_SYMBOL_RE = /[∗*†‡⋆§¶‖∥#+\uf02a]/gu;

function normalizeHtmlMarkerToken(raw) {
    const t = String(raw || '').replace(/\uf02a|\u2217|\u2731/g, '∗').replace(/\u2605/g, '⋆').replace(/‖/g, '∥').trim();
    if (t === '*') return '∗';
    return t;
}

function parseHtmlMarkerList(raw) {
    const cleaned = String(raw || '').replace(/[\u00a0()[\]]/g, ' ').trim();
    if (!cleaned || /@/.test(cleaned) || /[A-Za-z]{3,}/.test(cleaned) || /[a-z]{2,}/.test(cleaned)
        || cleaned.includes('++') || /(?:\+[A-Za-z]|[A-Za-z]\+)/.test(cleaned) || /\+\d/.test(cleaned)) return [];
    const tokens = [];
    for (const part of cleaned.split(/[\s,;]+/).filter(Boolean)) {
        for (const match of part.matchAll(/([1-9]\d?|[a-z]|[∗*†‡⋆§¶‖∥#+\uf02a])/gu)) {
            const norm = normalizeHtmlMarkerToken(match[1]);
            if (norm && !tokens.includes(norm)) tokens.push(norm);
        }
    }
    return tokens;
}

function isMarkerSkippedElement(el, skipNotes = false) {
    if (domHasAnyClass(el, DOM_MARKER_SKIP_CLASSES)) return true;
    if (skipNotes && domHasAnyClass(el, DOM_NOTE_CLASS_SET)) return true;
    const tag = String(el.name || '').toLowerCase();
    if (tag === 'a') {
        if (domHasAnyClass(el, DOM_URL_CLASS_SET) || isSkippedAnchorHref(el.attribs?.href)) {
            return true;
        }
    }
    return false;
}

function findFirstTexAnnotation(mathEl, skipNotes = false) {
    const stack = [];
    if (Array.isArray(mathEl.children)) {
        for (let i = mathEl.children.length - 1; i >= 0; i--) stack.push(mathEl.children[i]);
    }
    while (stack.length > 0) {
        const cur = stack.pop();
        if (!cur || (cur.type !== 'tag' && cur.type !== 'script' && cur.type !== 'style')) continue;
        if (isMarkerSkippedElement(cur, skipNotes)) continue;
        const tag = String(cur.name || '').toLowerCase();
        if (tag === 'annotation' && cur.attribs?.encoding === 'application/x-tex') {
            return cur;
        }
        if (Array.isArray(cur.children)) {
            for (let i = cur.children.length - 1; i >= 0; i--) stack.push(cur.children[i]);
        }
    }
    return null;
}

const DOM_AFFILIATION_NOTE_CLASSES = new Set(['ltx_role_affiliation', 'ltx_affiliation', 'ltx_role_address']);

function extractMarkedNodeText(root, insideSup, skipNotes = false) {
    return domCollectChildrenText(root, (el, parts) => {
        if (skipNotes && domHasAnyClass(el, DOM_NOTE_CLASS_SET)) {
            if (!insideSup && domHasAnyClass(el, DOM_AFFILIATION_NOTE_CLASSES)) {
                const emitNoteMarks = node => {
                    if (!node || !Array.isArray(node.children)) return;
                    for (const child of node.children) {
                        if (child.type !== 'tag') continue;
                        if (domHasAnyClass(child, DOM_NOTE_MARK_CLASS_SET)) {
                            const rawText = extractMarkedNodeText(child, true, false);
                            const markers = [];
                            for (const m of rawText.matchAll(/\[\[MARK:([^\]]+)\]\]/g)) {
                                for (const tok of m[1].split(',').filter(Boolean)) {
                                    if (!markers.includes(tok)) markers.push(tok);
                                }
                            }
                            const remainder = rawText.replace(/\[\[MARK:[^\]]+\]\]/g, ' ');
                            for (const tok of parseHtmlMarkerList(remainder)) {
                                if (!markers.includes(tok)) markers.push(tok);
                            }
                            if (markers.length) parts.push(`[[MARK:${markers.join(',')}]]`);
                        } else if (!domHasAnyClass(child, DOM_MARKER_SKIP_CLASSES)
                            && !domHasAnyClass(child, DOM_NOTE_BODY_CLASSES)) {
                            emitNoteMarks(child);
                        }
                    }
                };
                emitNoteMarks(el);
            }
            return 'skip';
        }
        if (isMarkerSkippedElement(el, skipNotes)) return 'skip';
        const tag = String(el.name || '').toLowerCase();
        if (tag === 'br') {
            parts.push('\n');
            return 'skip';
        }
        if (tag === 'math') {
            const ann = findFirstTexAnnotation(el, skipNotes);
            const readRaw = target => domCollectChildrenText(target, (sub, subParts) => {
                if (isMarkerSkippedElement(sub, skipNotes)) return 'skip';
                if (String(sub.name || '').toLowerCase() === 'br') {
                    subParts.push('\n');
                    return 'skip';
                }
                return 'descend';
            });
            const tex = (ann ? readRaw(ann) : '') || readRaw(el);
            let cleanedTex = String(tex || '');
            if (cleanedTex.includes('\\') && cleanedTex.includes('}')) {
                cleanedTex = cleanedTex.replace(/\\(?:text|mathrm|mathbf|mathit|scriptscriptstyle|scriptstyle|displaystyle)\{([^}{]*)\}/g, '$1');
            }
            cleanedTex = cleanedTex
                .replace(/\\ast\b/g, '∗').replace(/\\star\b/g, '⋆').replace(/\\dagger\b/g, '†').replace(/\\ddagger\b/g, '‡')
                .replace(/\\parallel\b|\\\|/g, '∥')
                .replace(/[\^{}\s]/g, '');
            const markers = parseHtmlMarkerList(cleanedTex);
            if (markers.length) parts.push(`[[MARK:${markers.join(',')}]]`);
            return 'skip';
        }
        if (!insideSup && (tag === 'sup' || domHasAnyClass(el, DOM_NOTE_MARK_CLASS_SET))) {
            const rawText = extractMarkedNodeText(el, true, skipNotes);
            const markers = [];
            for (const m of rawText.matchAll(/\[\[MARK:([^\]]+)\]\]/g)) {
                for (const tok of m[1].split(',').filter(Boolean)) {
                    if (!markers.includes(tok)) markers.push(tok);
                }
            }
            const remainder = rawText.replace(/\[\[MARK:[^\]]+\]\]/g, ' ');
            for (const tok of parseHtmlMarkerList(remainder)) {
                if (!markers.includes(tok)) markers.push(tok);
            }
            if (markers.length) parts.push(`[[MARK:${markers.join(',')}]]`);
            else if (tag === 'sup' && parts.length > 0 && /\d$/.test(parts[parts.length - 1])
                && /^(?:st|nd|rd|th)$/i.test(remainder.trim())) {
                parts.push(remainder.trim());
            }
            return 'skip';
        }
        return 'descend';
    });
}

function extractNodeMarkersAndText($, node, { skipNotes = true } = {}) {
    return extractMarkedNodeText(node, false, skipNotes);
}

function parseArxivHtmlMarkedAuthors($, wrapper, knownAuthorNames) {
    // Collect candidate affiliation nodes from inside .ltx_authors, plus pre-section & post-Abstract
    // .ltx_role_address (spconf) / .ltx_note.ltx_role_affiliation (bmvc2k).
    const affCandidates = [];
    const seen = new Set();
    const pushNode = node => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        affCandidates.push(node);
    };
    if (wrapper.length) {
        wrapper.find('.ltx_role_affiliation, .ltx_affiliation, .ltx_role_address').toArray().forEach(pushNode);
    }
    $('.ltx_note.ltx_role_affiliation, .ltx_role_address').toArray().forEach(node => {
        if ($(node).closest('.ltx_bibliography, .bibtex, .ltx_figure, .ltx_table').length === 0) {
            pushNode(node);
        }
    });
    if (!affCandidates.length || !wrapper.length) return null;

    const affMap = new Map();
    const roleMarkers = new Set();
    const isRoleBody = body => Boolean(
        READER_ROLE_FOOTNOTE_RE.test(body)
        || READER_UNANCHORED_ROLE_SENTENCE_RE.test(body)
        || isReaderCreditContribution(body)
    );
    const rawFallbackLines = [];

    // Pass 1: explicit [[MARK:...]] superscript markers take precedence over raw non-superscript fallback
    for (const node of affCandidates) {
        const markedText = extractNodeMarkersAndText($, node);
        const lines = markedText.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        for (const line of lines) {
            const matches = [...line.matchAll(/\[\[MARK:([^\]]+)\]\]/g)];
            if (matches.length && matches[0].index <= 3) {
                for (let idx = 0; idx < matches.length; idx++) {
                    const m = matches[idx];
                    const start = m.index + m[0].length;
                    const end = idx + 1 < matches.length ? matches[idx + 1].index : line.length;
                    const body = line.slice(start, end).replace(/^\s*[,;:]\s*/, '').trim();
                    const markers = m[1].split(',').filter(Boolean);
                    if (!body || !markers.length) continue;
                    if (markers.length === 1 && markers[0] === '+'
                        && (/^(?:\(?\d|tel\b|fax\b|phone\b)/i.test(body)
                            || (/\d{3,}[-\s]\d{3,}/.test(body) && !READER_AFFILIATION_ENTITY_HINT_RE.test(body)))) {
                        continue;
                    }
                    if (isRoleBody(body)) {
                        markers.forEach(mk => roleMarkers.add(mk));
                        continue;
                    }
                    const cleaned = sanitizeReaderAffiliationValue(body, knownAuthorNames);
                    if (cleaned) markers.forEach(mk => { if (!affMap.has(mk)) affMap.set(mk, cleaned); });
                }
            } else if (!matches.length) {
                rawFallbackLines.push(line);
            }
        }
    }
    // Pass 2: raw non-superscript fallback (never pre-empts Pass 1; case-sensitive [1-4]D guard)
    const hasExplicitNumeric = [...affMap.keys(), ...roleMarkers].some(mk => /^\d+$/.test(mk));
    for (const line of rawFallbackLines) {
        if (/^[1-4]D(?:[A-Z]{2,}|\b)/.test(line) || /^\d+(?:st|nd|rd|th)\b/i.test(line)) continue;
        const rawMatch = line.match(/^([∗*†‡⋆§¶‖∥#+]|[1-9]\d?(?:\s+(?=[A-Z])|(?=[A-Z](?:[a-z]{2,}|[A-Z]))))\s*(.+)$/u);
        if (!rawMatch) continue;
        const rawMkText = rawMatch[1];
        const isNumericRaw = /^\d/.test(rawMkText);
        const isGluedNumeric = isNumericRaw && !/\s$/.test(rawMkText);
        const markers = parseHtmlMarkerList(rawMkText);
        const body = rawMatch[2].trim();
        if (!markers.length || !body) continue;
        if (rawMkText.trim() === '+'
            && (/^(?:\(?\d|tel\b|fax\b|phone\b)/i.test(body)
                || (/\d{3,}[-\s]\d{3,}/.test(body) && !READER_AFFILIATION_ENTITY_HINT_RE.test(body)))) {
            continue;
        }
        if (isRoleBody(body)) markers.forEach(mk => roleMarkers.add(mk));
        else if (!(isNumericRaw && isBareStreetAddressLine(body))
            && !/\b(?:track|workshop|challenge|session|symposium)\b/i.test(body)
            && !(isNumericRaw && hasExplicitNumeric
                && !READER_AFFILIATION_ENTITY_HINT_RE.test(body)
                && !(isGluedNumeric && body.split(/\s+/).length >= 2))) {
            const cleaned = sanitizeReaderAffiliationValue(body, knownAuthorNames);
            if (cleaned) markers.forEach(mk => { if (!affMap.has(mk) && !roleMarkers.has(mk)) affMap.set(mk, cleaned); });
        }
    }
    if (affMap.size === 0) return null;

    // Now extract authors + markers from .ltx_personname nodes (supporting both 1 author/creator and multi-author .ltx_personname)
    const personNodes = wrapper.find('.ltx_creator.ltx_role_author .ltx_personname').toArray();
    if (!personNodes.length) return null;
    const entries = [];
    for (const pNode of personNodes) {
        const marked = extractNodeMarkersAndText($, pNode)
            .replace(/\r\n?/g, '\n')
            .replace(/[^\S\r\n]+/g, ' ')
            .replace(/ ?\n ?/g, '\n')
            .replace(/\n+/g, '\n')
            .replace(/(?:,\s?)?\b(?:Life )?(?:Student |Graduate Student |Senior |Associate )?(?:Member|Fellow) ?, ?IEEE\b/gi, '')
            .replace(/[^\S\r\n]+/g, ' ')
            .replace(/ ?\n ?/g, '\n')
            .replace(/\n+/g, '\n')
            .replace(/\[\[MARK:[^\]]+\]\](?: ?, ?\[\[MARK:[^\]]+\]\])+/g, match => (
                `[[MARK:${[...match.matchAll(/\[\[MARK:([^\]]+)\]\]/g)].map(m => m[1]).join(',')}]]`
            ));
        // Protect [[MARK:...]] tokens while splitting on newlines / commas / 'and' / '&' (strictly O(n))
        const stash = [];
        const protectedText = marked.replace(/\[\[MARK:[^\]]+\]\]/g, tok => {
            stash.push(tok);
            return `__MK${stash.length - 1}__`;
        });
        const chunks = protectedText.split(/\n| ?[,;] ?| (?:and|&) /i)
            .map(c => c.replace(/^(?:and|&)\s+/i, '').replace(/\s+(?:and|&)$/i, '').trim()).filter(Boolean)
            .map(c => c.replace(/__MK(\d+)__/g, (_, i) => stash[Number(i)]));
        for (const chunk of chunks) {
            const markers = [];
            for (const m of chunk.matchAll(/\[\[MARK:([^\]]+)\]\]/g)) {
                for (const mk of m[1].split(',').filter(Boolean)) {
                    if (!markers.includes(mk)) markers.push(mk);
                }
            }
            let rawName = chunk.replace(/\[\[MARK:[^\]]+\]\]/g, '');
            const symSet = '∗*†‡⋆§¶‖∥#+\uf02a';
            let tailEnd = rawName.length;
            while (tailEnd > 0 && /\s/.test(rawName[tailEnd - 1])) tailEnd--;
            let symStart = tailEnd;
            while (symStart > 0 && symSet.includes(rawName[symStart - 1])) symStart--;
            if (symStart < tailEnd) {
                for (const mk of parseHtmlMarkerList(rawName.slice(symStart, tailEnd))) {
                    if (!markers.includes(mk)) markers.push(mk);
                }
                rawName = rawName.slice(0, symStart);
            }
            let name = stripTrailingFootnoteMark(normalizeReaderIdentityText(rawName));
            if (name.includes('\\')) {
                name = name.replace(/\\(?:authorblockN|authorrefmark|IEEEauthorrefmark|inst)\b(?:\{[^}{]*\})?/gi, ' ');
            }
            name = stripInlineAtEmailsLinear(name).replace(/\s+/g, ' ').trim();
            if (!name || name.length < 2) continue;
            const resolvedAffs = [...new Set(markers.filter(mk => affMap.has(mk)).map(mk => affMap.get(mk)))];
            entries.push({ name, affiliations: resolvedAffs });
        }
    }
    if (!entries.length || entries.some(e => e.affiliations.length === 0)) return null;
    const extraNodes = affCandidates.filter(n => !$.contains(wrapper[0], n)).map(n => $.html(n));
    return { authors: entries, extraSourceNodes: extraNodes };
}

function parseArxivReaderAuthors($) {
    const wrapper = $('.ltx_authors').first();
    const cleanName = value => stripTrailingFootnoteMark(normalizeReaderIdentityText(value)).trim();
    const metaAuthors = $('meta[name="citation_author"]').toArray()
        .map(node => cleanName($(node).attr('content'))).filter(Boolean);
    const domAuthorNames = wrapper.length
        ? wrapper.find('.ltx_creator.ltx_role_author .ltx_personname').toArray()
            .map(node => cleanReaderAuthorNameNode($, node)).filter(Boolean)
        : [];
    const thanksAffiliations = parseReaderThanksAffiliations($, [...metaAuthors, ...domAuthorNames]);
    const knownAuthorNames = [...metaAuthors, ...domAuthorNames,
        ...[...thanksAffiliations.mappings.values()].map(item => item.name)];
    const knownAuthorIndex = buildKnownAuthorIndex(knownAuthorNames);
    const markedHtml = parseArxivHtmlMarkedAuthors($, wrapper, knownAuthorIndex);
    const metadataGroups = [];
    $('meta[name="citation_author"], meta[name="citation_author_institution"]').each((_, node) => {
        if ($(node).attr('name') === 'citation_author') {
            metadataGroups.push({ name: cleanName($(node).attr('content')), affiliations: [] });
        } else if (metadataGroups.length > 0) {
            const affiliation = sanitizeReaderAffiliationValue($(node).attr('content'), knownAuthorIndex);
            if (affiliation) metadataGroups.at(-1).affiliations.push(affiliation);
        }
    });
    // 多个姓名集中在前、机构集中在后时，元数据没有明确给出逐人对应关系。
    const unpairedMetadata = metadataGroups.length > 1
        && metadataGroups.slice(0, -1).every(group => group.affiliations.length === 0);
    const metadataAffsByKey = new Map();
    if (!unpairedMetadata) {
        for (const group of metadataGroups) {
            const gk = readerIdentityKey(group.name);
            if (!gk || !group.affiliations.length) continue;
            let list = metadataAffsByKey.get(gk);
            if (!list) {
                list = [];
                metadataAffsByKey.set(gk, list);
            }
            for (const aff of group.affiliations) {
                if (!list.includes(aff)) list.push(aff);
            }
        }
    }
    const metadataAffiliationsForName = name => unpairedMetadata
        ? []
        : [...(metadataAffsByKey.get(readerIdentityKey(name)) || [])];
    const globalAffNodes = wrapper.length
        ? wrapper.find('.ltx_role_affiliation, .ltx_affiliation').toArray()
            .filter(node => $(node).closest('.ltx_creator.ltx_role_author').length === 0)
        : [];
    const globalAffNodeCarriesMarkers = node => {
        const markedText = extractNodeMarkersAndText($, node);
        const lines = markedText.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
        let rawLowerLetterListLines = 0;
        const rawLowerLetterMarkers = new Set();
        for (const line of lines) {
            const matches = [...line.matchAll(/\[\[MARK:([^\]]+)\]\]/g)];
            if (matches.length && matches[0].index <= 3) {
                for (let idx = 0; idx < matches.length; idx++) {
                    const m = matches[idx];
                    const start = m.index + m[0].length;
                    const end = idx + 1 < matches.length ? matches[idx + 1].index : line.length;
                    const body = line.slice(start, end).replace(/^\s*[,;:]\s*/, '').trim();
                    const markers = m[1].split(',').filter(Boolean);
                    if (!body || !markers.length) continue;
                    if (markers.length === 1 && markers[0] === '+'
                        && (/^(?:\(?\d|tel\b|fax\b|phone\b)/i.test(body)
                            || (/\d{3,}[-\s]\d{3,}/.test(body) && !READER_AFFILIATION_ENTITY_HINT_RE.test(body)))) {
                        continue;
                    }
                    const isRole = Boolean(
                        READER_ROLE_FOOTNOTE_RE.test(body)
                        || READER_UNANCHORED_ROLE_SENTENCE_RE.test(body)
                        || isReaderCreditContribution(body)
                    );
                    if (!isRole) return true;
                }
                continue;
            }
            if (matches.length) continue;
            if (/^[1-4]D(?:[A-Z]{2,}|\b)/.test(line) || /^\d+(?:st|nd|rd|th)\b/i.test(line)) continue;
            const rawMatch = line.match(/^(?:([∗*†‡⋆§¶‖∥#+]|[1-9]\d?(?:\s+(?=[A-Z])|(?=[A-Z](?:[a-z]{2,}|[A-Z]))))|\(([1-9]\d?)\)\s+(?=[A-Z])|([1-9]\d?)[.)]\s+(?=[A-Z])|\(([a-z])\)\s+(?=[A-Z])|([a-z])[.)]\s+(?=[A-Z]))\s*(.+)$/u);
            if (rawMatch) {
                const rawMk = (rawMatch[1] || rawMatch[2] || rawMatch[3] || rawMatch[4] || rawMatch[5] || '').trim();
                const body = rawMatch[6].trim();
                const isNum = /^\d/.test(rawMk);
                if (rawMk === '+' && (/^(?:\(?\d|tel\b|fax\b|phone\b)/i.test(body)
                    || (/\d{3,}[-\s]\d{3,}/.test(body) && !READER_AFFILIATION_ENTITY_HINT_RE.test(body)))) continue;
                if (isNum && isBareStreetAddressLine(body)) continue;
                const isRole = Boolean(
                    READER_ROLE_FOOTNOTE_RE.test(body)
                    || READER_UNANCHORED_ROLE_SENTENCE_RE.test(body)
                    || isReaderCreditContribution(body)
                );
                if (body && !isRole) return true;
                continue;
            }
            if (lines.length >= 2) {
                const lowerMatch = line.match(/^([a-z])\s+([A-Z].+)$/u);
                if (lowerMatch) {
                    const body = lowerMatch[2].trim();
                    const isRole = Boolean(
                        READER_ROLE_FOOTNOTE_RE.test(body)
                        || READER_UNANCHORED_ROLE_SENTENCE_RE.test(body)
                        || isReaderCreditContribution(body)
                    );
                    if (body && !isRole) {
                        rawLowerLetterListLines++;
                        rawLowerLetterMarkers.add(lowerMatch[1]);
                    }
                }
            }
        }
        return rawLowerLetterListLines >= 2 && rawLowerLetterMarkers.size >= 2;
    };
    const anyGlobalAffMarked = globalAffNodes.some(globalAffNodeCarriesMarkers);
    const globalAffiliations = anyGlobalAffMarked
        ? []
        : globalAffNodes.map(node => cleanReaderAffiliationNode($, node, knownAuthorIndex)).filter(Boolean);
    const dedupedGlobalAffiliations = [...new Set(globalAffiliations)];
    const authorElements = wrapper.length
        ? wrapper.find('.ltx_creator.ltx_role_author').toArray()
        : [];
    // Secondary canonical-fold lookup (supporting diacritics, hyphens, and "Last, First" order)
    // enforcing middle-initial/nickname compatibility and bijective non-duplicate consumption.
    const profilesConflict = (p1, p2) => {
        if (p1.nick && p2.nick && p1.nick !== p2.nick) return true;
        if (p1.middleInitials.length > 0 && p2.middleInitials.length > 0
            && p1.middleInitials.join(' ') !== p2.middleInitials.join(' ')) return true;
        return false;
    };
    const thanksEntries = [...thanksAffiliations.mappings.entries()].map(([rawKey, item]) => ({
        rawKey,
        item,
        profile: canonicalAuthorTier3Profile(item.name)
    }));
    const thanksByFoldKey = new Map();
    const ambiguousThanksFoldKeys = new Set();
    for (const entry of thanksEntries) {
        for (const fk of entry.profile.keys) {
            if (ambiguousThanksFoldKeys.has(fk)) continue;
            if (thanksByFoldKey.has(fk) && thanksByFoldKey.get(fk).rawKey !== entry.rawKey) {
                thanksByFoldKey.delete(fk);
                ambiguousThanksFoldKeys.add(fk);
            } else {
                thanksByFoldKey.set(fk, entry);
            }
        }
    }
    // Pre-collect ONLY the active author list being bound (DOM authorElements when non-empty;
    // metaAuthors ONLY when DOM authorElements yield no names — never mix <meta> into DOM competition!).
    // Compute both exact rawKey ownership and non-exact claimant sets so 2-to-1 ambiguity
    // (e.g. "John A. Smith" + "John B. Smith" vs thanks "John Smith") cannot greedily steal an affiliation.
    const activeDomCandidates = [];
    for (const el of authorElements) {
        const nm = cleanReaderAuthorNameNode($, $(el).find('.ltx_personname').first());
        if (!nm) continue;
        const directK = readerIdentityKey(nm);
        const splitParts = nm.split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
            .map(p => p.replace(/^(?:and|&)\s+/i, '').trim())
            .filter(Boolean);
        if (!thanksAffiliations.mappings.has(directK)
            && splitParts.length >= 2 && splitParts.every(part => isValidPersonAuthorName(part))) {
            activeDomCandidates.push(...splitParts);
        } else {
            activeDomCandidates.push(nm);
        }
    }
    const activeCandidateNames = activeDomCandidates.length > 0 ? activeDomCandidates : metaAuthors;
    const exactCandidateRawKeys = new Set();
    for (const candidateName of activeCandidateNames) {
        const dk = readerIdentityKey(candidateName);
        if (dk) exactCandidateRawKeys.add(dk);
    }
    const findUniqueThanksEntryForNonExact = candidateName => {
        const profile = canonicalAuthorTier3Profile(candidateName);
        let matched = null;
        for (const fk of profile.keys) {
            const hit = thanksByFoldKey.get(fk);
            if (!hit) continue;
            if (profilesConflict(profile, hit.profile)) continue;
            if (matched && matched.rawKey !== hit.rawKey) return null;
            matched = hit;
        }
        return matched;
    };
    const thanksNonExactClaimants = new Map();
    for (const candidateName of activeCandidateNames) {
        const dk = readerIdentityKey(candidateName);
        if (!dk || thanksAffiliations.mappings.has(dk)) continue;
        const matched = findUniqueThanksEntryForNonExact(candidateName);
        if (!matched) continue;
        if (!thanksNonExactClaimants.has(matched.rawKey)) thanksNonExactClaimants.set(matched.rawKey, new Set());
        thanksNonExactClaimants.get(matched.rawKey).add(dk);
    }
    const consumedThanksKeys = new Set();
    const lookupThanksForName = (name, { respectConsumed = true } = {}) => {
        const directKey = readerIdentityKey(name);
        if (thanksAffiliations.mappings.has(directKey)) {
            if (respectConsumed && consumedThanksKeys.has(directKey)) return null;
            return { rawKey: directKey, item: thanksAffiliations.mappings.get(directKey) };
        }
        const matched = findUniqueThanksEntryForNonExact(name);
        if (!matched) return null;
        if (respectConsumed && consumedThanksKeys.has(matched.rawKey)) return null;
        if (exactCandidateRawKeys.has(matched.rawKey) && directKey !== matched.rawKey) return null;
        if ((thanksNonExactClaimants.get(matched.rawKey)?.size || 0) > 1) return null;
        return { rawKey: matched.rawKey, item: matched.item };
    };
    let authors = authorElements.flatMap(element => {
        const creator = $(element);
        const nameNode = creator.find('.ltx_personname').first();
        const name = cleanReaderAuthorNameNode($, nameNode);
        if (!name) return [];
        const affiliationNodes = creator.find('.ltx_contact.ltx_role_affiliation').toArray();
        const rejectedResourceLabel = affiliationNodes.some(node => isReaderResourceAffiliationLabel($(node).text()));
        const affiliations = affiliationNodes
            .map(node => cleanReaderAffiliationNode($, node, knownAuthorIndex))
            .filter(Boolean);
        const thanksHit = lookupThanksForName(name);
        if (!thanksHit && affiliations.length === 0) {
            // Single .ltx_personname combining multiple IEEE authors ("Bob White, Carol Davis, and David Lee"):
            // expand cleanly when every split token is a valid person name uniquely bound to DISTINCT thanks entries.
            const splitParts = name.split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
                .map(part => part.replace(/^(?:and|&)\s+/i, '').trim())
                .filter(Boolean);
            if (splitParts.length >= 2 && splitParts.every(part => isValidPersonAuthorName(part))) {
                const hits = splitParts.map(part => ({ part, hit: lookupThanksForName(part) }));
                const hitRawKeys = hits.map(entry => entry.hit?.rawKey).filter(Boolean);
                if (hits.every(entry => entry.hit && entry.hit.item.affiliations.length > 0)
                    && new Set(hitRawKeys).size === hits.length) {
                    return hits.map(({ part, hit }) => {
                        consumedThanksKeys.add(hit.rawKey);
                        return { name: part, affiliations: [...new Set(hit.item.affiliations)] };
                    });
                }
            }
        }
        if (thanksHit) consumedThanksKeys.add(thanksHit.rawKey);
        const thanks = thanksHit?.item || null;
        const metadataAffiliations = metadataAffiliationsForName(name);
        const fallbackAffiliations = rejectedResourceLabel ? [] : metadataAffiliations.length > 0
            ? metadataAffiliations
            : (dedupedGlobalAffiliations.length === 1 ? dedupedGlobalAffiliations : []);
        return [{
            name,
            affiliations: [...new Set(thanks?.affiliations?.length > 0
                ? thanks.affiliations
                : (affiliations.length > 0 ? affiliations : fallbackAffiliations))]
        }];
    }).filter(item => item.name);
    // Explicit thanks mappings keep their independent named evidence. Numeric per-person markers
    // are outside this narrow unmarked-block rejection and retain the existing parser behavior.
    const lastCreator = authorElements.length ? $(authorElements.at(-1)) : null;
    const affHasSupMarker = Boolean(wrapper.length)
        && wrapper.find('.ltx_contact.ltx_role_affiliation sup').toArray().some(node => {
            const note = $(node).closest('.ltx_note');
            return note.length === 0 || note.is('.ltx_role_affiliation, .ltx_affiliation, .ltx_role_address');
        });
    const personHasNonRoleMarker = Boolean(wrapper.length)
        && wrapper.find('.ltx_personname sup, .ltx_personname .ltx_note_mark').toArray().some(node => {
            const note = $(node).closest('.ltx_note');
            if (!(note.length === 0 || note.is('.ltx_role_affiliation, .ltx_affiliation, .ltx_role_address'))) return false;
            const mks = parseHtmlMarkerList($(node).text());
            return mks.some(mk => /^\d+$/.test(mk) || /^[a-z]$/.test(mk));
        });
    const hasMarkers = Boolean(markedHtml) || affHasSupMarker || personHasNonRoleMarker;
    const rawLabeledSkipClasses = new Set(['ltx_contact_email', 'ltx_role_email', 'ltx_note_mark', 'ltx_note', 'ltx_tag']);
    if (lastCreator && !lookupThanksForName(authors.at(-1)?.name, { respectConsumed: false }) && !hasMarkers) {
        const rawLabeledGroups = lastCreator.find('.ltx_contact.ltx_role_affiliation').toArray().map(node => (
            domCollectChildrenText(node, (el, parts) => {
                const tag = String(el.name || '').toLowerCase();
                if (tag === 'sup' || domHasAnyClass(el, rawLabeledSkipClasses)) return 'skip';
                if (tag === 'a' && (domHasAnyClass(el, DOM_URL_CLASS_SET) || isSkippedAnchorHref(el.attribs?.href))) return 'skip';
                if (tag === 'br') {
                    parts.push(' ');
                    return 'skip';
                }
                return 'descend';
            })
        ));
        authors = rejectUnboundTrailingAffiliationGroup(authors, rawLabeledGroups);
    }
    // If HTML superscript/symbol marker parsing cleanly bound ALL authors and plain creator parsing left any unbound
    // (or collapsed multiple authors into one .ltx_personname), prefer the marker-bound result!
    let extraSourceNodes = [];
    const plainBoundCount = authors.filter(a => a.affiliations.length > 0 && a.affiliations.every(v => !/^机构信息未/.test(v))).length;
    const plainAllSameSingle = authors.length >= 2
        && authors.every(a => a.affiliations.length === 1 && a.affiliations[0] === authors[0].affiliations[0]);
    const markedHasDistinctBindings = Boolean(
        markedHtml
        && markedHtml.authors.length === authors.length
        && markedHtml.authors.every(ma => ma.affiliations.length > 0)
        && new Set(markedHtml.authors.map(ma => ma.affiliations.join('||'))).size >= 2
    );
    const plainHasNoThanks = !authors.some(a => lookupThanksForName(a.name, { respectConsumed: false }));
    if (markedHtml && markedHtml.authors.length >= authors.length
        && (plainBoundCount < authors.length || markedHtml.authors.length > authors.length
            || (markedHtml.authors.length === authors.length
                && (markedHtml.authors.some((ma, idx) => ma.affiliations.length > (authors[idx]?.affiliations?.length || 0))
                    || (plainAllSameSingle && markedHasDistinctBindings && plainHasNoThanks))))) {
        authors = markedHtml.authors;
        extraSourceNodes = markedHtml.extraSourceNodes;
        consumedThanksKeys.clear();
        for (const a of authors) {
            const h = lookupThanksForName(a.name, { respectConsumed: true });
            if (h) consumedThanksKeys.add(h.rawKey);
        }
    }
    if (authors.length === 0 && metaAuthors.length > 0) {
        authors = metaAuthors.map(name => {
            const h = lookupThanksForName(name, { respectConsumed: true });
            if (h) consumedThanksKeys.add(h.rawKey);
            const metaAffs = metadataAffiliationsForName(name);
            return {
                name,
                affiliations: h?.item?.affiliations?.length > 0 ? [...new Set(h.item.affiliations)] : metaAffs
            };
        });
    }
    const existingNames = new Set(authors.map(item => readerIdentityKey(item.name)));
    const existingProfilesByKey = new Map();
    const indexExistingProfile = prof => {
        for (const k of prof.keys) {
            let bucket = existingProfilesByKey.get(k);
            if (!bucket) {
                bucket = [];
                existingProfilesByKey.set(k, bucket);
            }
            bucket.push(prof);
        }
    };
    for (const item of authors) indexExistingProfile(canonicalAuthorTier3Profile(item.name));
    for (const [key, item] of thanksAffiliations.mappings) {
        if (existingNames.has(key) || consumedThanksKeys.has(key)) continue;
        const itemProfile = canonicalAuthorTier3Profile(item.name);
        let alreadyPresent = false;
        for (const k of itemProfile.keys) {
            const bucket = existingProfilesByKey.get(k);
            if (!bucket) continue;
            if (bucket.some(ep => !profilesConflict(ep, itemProfile))) {
                alreadyPresent = true;
                break;
            }
        }
        if (!alreadyPresent) {
            authors.push({ name: item.name, affiliations: [...item.affiliations] });
            existingNames.add(key);
            indexExistingProfile(itemProfile);
        }
    }
    if (authors.length === 0) {
        const tableAuthors = parseReaderAuthorTable($);
        if (tableAuthors) return tableAuthors;
    }
    authors = authors.map(item => ({
        name: item.name,
        affiliations: item.affiliations.length > 0
            ? item.affiliations
            : [READER_AFFILIATION_UNBOUND]
    }));
    const sourceNodes = wrapper.length
        ? [$.html(wrapper), ...thanksAffiliations.sourceNodes, ...extraSourceNodes].filter(Boolean).join('\n')
        : $('meta[name="citation_author"], meta[name="citation_author_institution"]')
            .toArray().map(node => $.html(node)).join('\n');
    return {
        authors,
        sourceDomSha256: sourceNodes
            ? crypto.createHash('sha256').update(sourceNodes).digest('hex')
            : ''
    };
}

function normalizeReaderMetadataDisplayName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
        // 元数据里可能留着本该是 Unicode 拉丁重音字符外面的 TeX 分组（Ga{ë}l）。只去掉
        // 这种纯展示用的花括号，身份仍绑定原始元数据和 DOM SHA。
        .replace(/(?<=[A-Za-z])\{([\u00c0-\u024f])\}(?=[A-Za-z])/gu, '$1');
}


function canonicalAuthorFoldKey(value) {
    return normalizeReaderIdentityText(normalizeReaderMetadataDisplayName(value))
        .normalize('NFKD')
        .replace(/\p{Mn}+/gu, '')
        .replace(/[\u0131\u0130]/g, 'i')
        .replace(/[\u0141\u0142]/g, 'l')
        .replace(/[\u00d8\u00f8]/g, 'o')
        .replace(/\u00df/g, 'ss')
        .replace(/[\u2018\u2019'`]/g, '')
        .replace(/[\u2010-\u2015\-.,]/g, ' ')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

function canonicalAuthorUmlautDigraphKey(value) {
    const raw = normalizeReaderIdentityText(normalizeReaderMetadataDisplayName(value))
        .replace(/ä/g, 'ae').replace(/Ä/g, 'Ae')
        .replace(/ö/g, 'oe').replace(/Ö/g, 'Oe')
        .replace(/ü/g, 'ue').replace(/Ü/g, 'Ue');
    return canonicalAuthorFoldKey(raw);
}

function canonicalAuthorTier3Profile(value) {
    const raw = normalizeReaderMetadataDisplayName(value);
    const fold = canonicalAuthorFoldKey(raw);
    const keys = new Set();
    if (fold) keys.add(fold);
    const umlautKey = canonicalAuthorUmlautDigraphKey(raw);
    if (umlautKey) keys.add(umlautKey);
    const nickMatches = [...raw.matchAll(/(?:\(([^)]{1,24})\)|["“]([^"”]{1,24})["”])/g)]
        .map(m => canonicalAuthorFoldKey(m[1] || m[2] || '')).filter(Boolean);
    const nick = nickMatches.length ? nickMatches.join(' ') : null;
    const noNick = raw.replace(/\s*(?:\([^)]{1,24}\)|["“][^"”]{1,24}["”])\s*/g, ' ').replace(/\s+/g, ' ').trim();
    const noNickFold = canonicalAuthorFoldKey(noNick);
    if (noNickFold) keys.add(noNickFold);
    const noNickUmlaut = canonicalAuthorUmlautDigraphKey(noNick);
    if (noNickUmlaut) keys.add(noNickUmlaut);
    // "Last, First" -> "First Last"
    let normalizedOrder = noNickFold;
    if (noNick.includes(',')) {
        const parts = noNick.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length === 2) {
            const swapped = canonicalAuthorFoldKey(`${parts[1]} ${parts[0]}`);
            if (swapped) {
                keys.add(swapped);
                normalizedOrder = swapped;
            }
        }
    }
    const baseTokens = normalizedOrder.split(' ').filter(Boolean);
    const middleInitials = baseTokens.length >= 3
        ? baseTokens.slice(1, -1).filter(tok => tok.length === 1)
        : [];
    const coreTokens = baseTokens.length >= 3
        ? [baseTokens[0], ...baseTokens.slice(1, -1).filter(tok => tok.length > 1), baseTokens[baseTokens.length - 1]]
        : baseTokens;
    if (coreTokens.length >= 2) {
        keys.add(coreTokens.join(' '));
        if (coreTokens.length === 2) {
            keys.add(`${coreTokens[1]} ${coreTokens[0]}`);
        } else if (coreTokens.length >= 3 && coreTokens.slice(0, -1).every(tok => tok.length >= 2)) {
            // Reordered multi-given names with identical surname (e.g. "Michael Barasa Murunga" <-> "Barasa Michael Murunga")
            const sortedGiven = [...coreTokens.slice(0, -1)].sort().join(' ');
            keys.add(`${sortedGiven} ${coreTokens[coreTokens.length - 1]}`);
        }
    }
    return { fold, nick, middleInitials, keys };
}

function isMetadataAuthorSeparator(name) {
    const trimmed = String(name || '').trim();
    return Boolean(trimmed) && METADATA_AUTHOR_SEPARATORS.has(trimmed);
}

/**
 * Strictly 1-to-1 unambiguous bijection matching between metadata display names and parsed authors.
 * Preserves pollution rejection (parsed length must equal real metadata author count) and rejects
 * duplicate names or ambiguous matches without ever guessing by position.
 */
function alignAuthorNames1to1(metadataNames, parsedAuthors) {
    if (!Array.isArray(metadataNames) || !Array.isArray(parsedAuthors) || !parsedAuthors.length) {
        return null;
    }
    const realMetaIndices = [];
    for (let i = 0; i < metadataNames.length; i++) {
        if (!isMetadataAuthorSeparator(metadataNames[i])) realMetaIndices.push(i);
    }
    if (realMetaIndices.length !== parsedAuthors.length || realMetaIndices.length === 0) {
        return null;
    }
    // Duplicate metadata names (e.g., two "John Smith") cannot be disambiguated safely.
    const exactMetaKeys = realMetaIndices.map(i => readerIdentityKey(metadataNames[i]));
    const exactParsedKeys = parsedAuthors.map(a => readerIdentityKey(normalizeReaderMetadataDisplayName(a?.name)));
    if (new Set(exactMetaKeys).size !== exactMetaKeys.length
        || new Set(exactParsedKeys).size !== exactParsedKeys.length) {
        return null;
    }

    const matchedParsedByMetaIdx = new Map();
    const usedParsedIndices = new Set();
    const parsedDisplayNames = parsedAuthors.map(a => normalizeReaderMetadataDisplayName(a?.name));

    const commitUniqueTier = (metaToCandidates, parsedToCandidates) => {
        for (const [mIdx, pList] of metaToCandidates) {
            if (pList.length === 1) {
                const pIdx = pList[0];
                if ((parsedToCandidates.get(pIdx) || []).length === 1) {
                    matchedParsedByMetaIdx.set(mIdx, parsedAuthors[pIdx]);
                    usedParsedIndices.add(pIdx);
                }
            }
        }
    };

    const runKeyTier = (keyFn) => {
        const parsedByKey = new Map();
        for (let pIdx = 0; pIdx < parsedAuthors.length; pIdx++) {
            if (usedParsedIndices.has(pIdx)) continue;
            const pk = keyFn(parsedDisplayNames[pIdx]);
            if (!pk) continue;
            let list = parsedByKey.get(pk);
            if (!list) {
                list = [];
                parsedByKey.set(pk, list);
            }
            list.push(pIdx);
        }
        const metaToCandidates = new Map();
        const parsedToCandidates = new Map();
        for (const mIdx of realMetaIndices) {
            if (matchedParsedByMetaIdx.has(mIdx)) continue;
            const mk = keyFn(metadataNames[mIdx]);
            if (!mk) continue;
            const hits = parsedByKey.get(mk);
            if (!hits) continue;
            metaToCandidates.set(mIdx, [...hits]);
            for (const pIdx of hits) {
                let mList = parsedToCandidates.get(pIdx);
                if (!mList) {
                    mList = [];
                    parsedToCandidates.set(pIdx, mList);
                }
                mList.push(mIdx);
            }
        }
        commitUniqueTier(metaToCandidates, parsedToCandidates);
    };

    // Tier 1: exact NFKC case-folded identity (O(K) Map-indexed)
    runKeyTier(readerIdentityKey);
    // Tier 2: diacritic / punctuation / hyphen folded identity (O(K) Map-indexed)
    if (matchedParsedByMetaIdx.size < realMetaIndices.length) {
        runKeyTier(canonicalAuthorFoldKey);
    }
    // Tier 3: reversed "Last, First" / 2-token order / nickname / single-letter middle initial (O(K) Map-indexed)
    // Never matches conflicting explicit middle initials (John A. Smith vs John B. Smith) or conflicting nicknames.
    if (matchedParsedByMetaIdx.size < realMetaIndices.length) {
        const parsedProfiles = new Map();
        const parsedByTier3Key = new Map();
        for (let pIdx = 0; pIdx < parsedAuthors.length; pIdx++) {
            if (usedParsedIndices.has(pIdx)) continue;
            const pp = canonicalAuthorTier3Profile(parsedDisplayNames[pIdx]);
            if (!pp.fold) continue;
            parsedProfiles.set(pIdx, pp);
            for (const k of pp.keys) {
                let bucket = parsedByTier3Key.get(k);
                if (!bucket) {
                    bucket = [];
                    parsedByTier3Key.set(k, bucket);
                }
                bucket.push(pIdx);
            }
        }
        const metaToCandidates = new Map();
        const parsedToCandidates = new Map();
        for (const mIdx of realMetaIndices) {
            if (matchedParsedByMetaIdx.has(mIdx)) continue;
            const mp = canonicalAuthorTier3Profile(metadataNames[mIdx]);
            if (!mp.fold) continue;
            const candidateSet = new Set();
            for (const k of mp.keys) {
                const bucket = parsedByTier3Key.get(k);
                if (!bucket) continue;
                for (const pIdx of bucket) {
                    if (candidateSet.has(pIdx)) continue;
                    const pp = parsedProfiles.get(pIdx);
                    if (mp.nick && pp.nick && mp.nick !== pp.nick) continue;
                    if (mp.middleInitials.length > 0 && pp.middleInitials.length > 0
                        && mp.middleInitials.join(' ') !== pp.middleInitials.join(' ')) continue;
                    candidateSet.add(pIdx);
                }
            }
            if (candidateSet.size > 0) {
                const pList = [...candidateSet];
                metaToCandidates.set(mIdx, pList);
                for (const pIdx of pList) {
                    let mList = parsedToCandidates.get(pIdx);
                    if (!mList) {
                        mList = [];
                        parsedToCandidates.set(pIdx, mList);
                    }
                    mList.push(mIdx);
                }
            }
        }
        commitUniqueTier(metaToCandidates, parsedToCandidates);
    }

    // Tier 4: controlled 1-remaining-author alignment for anglicized/native given-name variants
    // (e.g. "George Fazekas" <-> "György Fazekas") ONLY when N >= 2, N - 1 authors already matched
    // strictly 1-to-1, and the sole remaining pair has identical folded surname AND identical given initial.
    if (realMetaIndices.length >= 2 && matchedParsedByMetaIdx.size === realMetaIndices.length - 1) {
        const remMeta = realMetaIndices.find(mIdx => !matchedParsedByMetaIdx.has(mIdx));
        let remParsed = -1;
        for (let pIdx = 0; pIdx < parsedAuthors.length; pIdx++) {
            if (!usedParsedIndices.has(pIdx)) {
                remParsed = pIdx;
                break;
            }
        }
        if (remMeta !== undefined && remParsed >= 0) {
            const mp = canonicalAuthorTier3Profile(metadataNames[remMeta]);
            const pp = canonicalAuthorTier3Profile(parsedDisplayNames[remParsed]);
            const conflictingMiddle = mp.middleInitials.length > 0 && pp.middleInitials.length > 0
                && mp.middleInitials.join(' ') !== pp.middleInitials.join(' ');
            const conflictingNick = Boolean(mp.nick && pp.nick && mp.nick !== pp.nick);
            const mt = canonicalAuthorFoldKey(metadataNames[remMeta]).split(' ').filter(Boolean);
            const pt = canonicalAuthorFoldKey(parsedDisplayNames[remParsed]).split(' ').filter(Boolean);
            if (!conflictingMiddle && !conflictingNick
                && mt.length >= 2 && pt.length >= 2
                && mt[mt.length - 1] === pt[pt.length - 1] && mt[0][0] === pt[0][0]) {
                matchedParsedByMetaIdx.set(remMeta, parsedAuthors[remParsed]);
                usedParsedIndices.add(remParsed);
            }
        }
    }

    if (matchedParsedByMetaIdx.size !== realMetaIndices.length) return null;
    return matchedParsedByMetaIdx;
}

function validatePdfPage1AuthorEvidence(evidence, expectedPdfSha256 = null) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
    const expectedKeys = ['authors', 'contract', 'mode', 'pdfSha256', 'sourceDomSha256', 'sourceEvidence', 'sourceEvidenceSha256'];
    if (JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(expectedKeys)) return false;
    if (!PDF_PAGE1_AUTHOR_CONTRACTS.has(evidence.contract)) return false;
    if (!PDF_PAGE1_AUTHOR_MODES.has(evidence.mode)) return false;
    if (evidence.mode === 'inline_author_aff' && evidence.contract !== PDF_PAGE1_AUTHOR_CONTRACT_V2) return false;
    if (!recoverySha256(evidence.pdfSha256)) return false;
    if (expectedPdfSha256 && evidence.pdfSha256 !== expectedPdfSha256) return false;
    if (typeof evidence.sourceEvidence !== 'string' || !evidence.sourceEvidence.trim()) return false;
    const expectedEvidenceSha = sha256(Buffer.from(evidence.sourceEvidence, 'utf8'));
    if (evidence.sourceEvidenceSha256 !== expectedEvidenceSha) return false;
    const expectedDomSha = sha256(Buffer.from(`${evidence.pdfSha256}:${expectedEvidenceSha}`, 'utf8'));
    if (evidence.sourceDomSha256 !== expectedDomSha) return false;
    if (!Array.isArray(evidence.authors) || !evidence.authors.length) return false;
    return evidence.authors.every(author => (
        Boolean(author && typeof author === 'object' && !Array.isArray(author))
        && JSON.stringify(Object.keys(author).sort()) === JSON.stringify(['affiliations', 'name'])
        && typeof author.name === 'string' && author.name.trim().length > 0
        && Array.isArray(author.affiliations) && author.affiliations.length > 0
        && author.affiliations.every(aff => typeof aff === 'string' && aff.trim().length > 0)
    ));
}

function extractPdfPage1AuthorsSync(pdfBytes, options = {}) {
    const requestedContract = options?.contract || PDF_PAGE1_AUTHOR_CONTRACT;
    if (!PDF_PAGE1_AUTHOR_CONTRACTS.has(requestedContract)) {
        throw new Error(`Unsupported PDF page-1 author contract: ${requestedContract}`);
    }
    const payload = Buffer.isBuffer(pdfBytes) ? pdfBytes : Buffer.from(pdfBytes || []);
    // Real arXiv PDFs are at least a few KiB; tiny synthetic unit-test stubs (e.g. 25 bytes) skip subprocess overhead.
    if (payload.length < 256 || payload.length > MAX_PDF_AUTHOR_BYTES
        || payload.subarray(0, 5).toString('ascii') !== '%PDF-') return null;
    const pdfSha = sha256(payload);
    const cacheKey = `${requestedContract}:${pdfSha}`;
    const cached = getBoundedCacheEntry(pdfPage1AuthorCache, cacheKey);
    if (cached !== undefined) {
        authorCacheCounters.pdfPage1Hits++;
        return cached === null ? null : structuredClone(cached);
    }
    authorCacheCounters.pdfPage1Misses++;
    const rootDir = path.resolve(__dirname, '..', '..');
    const runner = path.join(rootDir, 'scripts', 'python-runtime.sh');
    const script = path.join(rootDir, 'scripts', 'pdf_author_extract.py');
    const childEnv = { ...process.env };
    delete childEnv.PYTHONSTARTUP;
    delete childEnv.PYTHONPATH;
    delete childEnv.NODE_OPTIONS;
    let tmpDir = null;
    let result;
    try {
        tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pdf-authors-')));
        fs.chmodSync(tmpDir, 0o700);
        const tmpPdf = path.join(tmpDir, 'source.pdf');
        fs.writeFileSync(tmpPdf, payload, { mode: 0o600 });
        result = spawnSync('bash', [runner, script, '--pdf', tmpPdf, '--contract', requestedContract], {
            cwd: rootDir,
            env: childEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            encoding: 'utf8',
            timeout: 20000,
            maxBuffer: 8 * 1024 * 1024
        });
    } finally {
        if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    if (result.error || result.signal || result.status !== 0 || !result.stdout) {
        return null;
    }
    try {
        const parsed = JSON.parse(result.stdout);
        const valid = validatePdfPage1AuthorEvidence(parsed, pdfSha) && parsed.contract === requestedContract ? parsed : null;
        setBoundedCacheEntry(pdfPage1AuthorCache, cacheKey, valid ? structuredClone(valid) : null);
        return valid ? structuredClone(valid) : null;
    } catch (_) {
        return null;
    }
}

function scoreAlignedAffiliationQuality(names, alignment, knownAuthorNames) {
    if (!alignment) return -1e9;
    const knownIndex = knownAuthorNames && knownAuthorNames.__knownAuthorIndex
        ? knownAuthorNames
        : buildKnownAuthorIndex(knownAuthorNames);
    let score = 0;
    for (let i = 0; i < names.length; i++) {
        const matched = alignment.get(i);
        if (!matched || !Array.isArray(matched.affiliations)) continue;
        const clean = matched.affiliations
            .map(v => sanitizeReaderAffiliationValue(v, knownIndex))
            .filter(v => v && !/^机构信息未/.test(v));
        if (!clean.length) continue;
        score += 10;
        // Reward clean multi-affiliations (up to 3 per author)
        score += Math.min(2, clean.length - 1) * 3;
        for (const aff of clean) {
            if (READER_AFFILIATION_ENTITY_HINT_RE.test(aff) || READER_UPPERCASE_CORP_SUFFIX_RE.test(aff)) score += 2;
            if (/\b(?:univ|college|academy|institute|corp|inc\.?|ltd\.?|gmbh|lab|research|google|meta|microsoft|tencent|alibaba|bytedance|huawei|nvidia|amazon|apple|kyutai|kaist|inria|cnrs|sorbonne|sinica)\b/i.test(aff)) score += 1;
            // Penalize concatenated CamelCase artifacts, raw LaTeX/KV leakage, dangling punctuation, or very short fragments
            if (/[a-z][A-Z][a-z]{3,}/.test(aff) && !/(?:DeepMind|OpenAI|ByteDance|MetaAI|HuggingFace|ModelScope|SpeechBrain|YouTube|WeChat|MacOS|PyTorch|TensorFlow|iFLYTEK|SenseTime|MiniMax|StepFun|DeepSeek|ElevenLabs|BandLab|OmniBuds|EchoNova|VinUniversity|SoundHound|McGill|McMaster|DePaul|LaTeX)/i.test(aff)) score -= 4;
            if (/\\|=/.test(aff)) score -= 8;
            if (/,\s*(?:of|for|and|in)\s+/i.test(aff)) score -= 4;
            if (aff.length < 5) score -= 2;
        }
    }
    return score;
}

function countAlignedBoundAuthors(names, alignment, knownAuthorNames) {
    if (!alignment) return -1;
    const knownIndex = knownAuthorNames && knownAuthorNames.__knownAuthorIndex
        ? knownAuthorNames
        : buildKnownAuthorIndex(knownAuthorNames);
    let bound = 0;
    for (let i = 0; i < names.length; i++) {
        const matched = alignment.get(i);
        if (!matched || !Array.isArray(matched.affiliations)) continue;
        const clean = matched.affiliations
            .map(v => sanitizeReaderAffiliationValue(v, knownIndex))
            .filter(v => v && !/^机构信息未/.test(v));
        if (clean.length > 0) bound++;
    }
    return bound;
}

function resolveApiReaderAuthors(paper, sourceDetails) {
    let activeDetails = sourceDetails;
    let parsed = activeDetails?.readerAuthors;
    const normalizeName = normalizeReaderMetadataDisplayName;
    const rawAuthors = Array.isArray(paper?.authors) ? paper.authors : [];
    let names = rawAuthors.map(author => (
        typeof author === 'string' ? author : author?.name
    )).map(normalizeName).filter(Boolean);

    // If a verified PDF Page-1 fallback is attached alongside HTML readerAuthors, prefer it whenever
    // HTML failed to align with paper metadata OR left authors unbound while PDF Page-1 binds strictly more authors.
    const pdfFallback = parsed?.pdfPage1Authors && validatePdfPage1AuthorEvidence(parsed.pdfPage1Authors)
        ? parsed.pdfPage1Authors : null;
    if (pdfFallback) {
        const primaryNames = names.length > 0 ? names : (Array.isArray(parsed?.authors) ? parsed.authors.map(a => normalizeName(a?.name)).filter(Boolean) : []);
        const primaryAlign = Array.isArray(parsed?.authors) && parsed.authors.length > 0
            ? alignAuthorNames1to1(primaryNames, parsed.authors) : null;
        const pdfAlign = names.length > 0
            ? alignAuthorNames1to1(names, pdfFallback.authors)
            : new Map(pdfFallback.authors.map((a, idx) => [idx, a]));
        const knownIndex = buildKnownAuthorIndex([...primaryNames, ...(parsed?.authors || []).map(a => a?.name), ...pdfFallback.authors.map(a => a?.name)]);
        const primaryBound = primaryAlign ? countAlignedBoundAuthors(primaryNames, primaryAlign, knownIndex) : -1;
        const pdfTargetNames = names.length > 0 ? names : pdfFallback.authors.map(a => a.name);
        const pdfBound = pdfAlign ? countAlignedBoundAuthors(pdfTargetNames, pdfAlign, knownIndex) : -1;
        const pdfWinsTieByQuality = pdfBound > 0 && pdfBound === primaryBound
            && scoreAlignedAffiliationQuality(pdfTargetNames, pdfAlign, knownIndex)
                > scoreAlignedAffiliationQuality(primaryNames, primaryAlign, knownIndex) + 2;
        if ((pdfBound > primaryBound && pdfBound > 0) || pdfWinsTieByQuality) {
            activeDetails = { ...sourceDetails, readerAuthors: pdfFallback };
            parsed = pdfFallback;
        }
    }

    // 解析出来的姓名集合不匹配时，不能继续借用其中任何机构关联。
    // 原封存对象保留用于诊断；只在本次解析中退回正式元数据姓名和明确不可得状态。
    let alignedMap = null;
    if (names.length > 0 && Array.isArray(parsed?.authors) && parsed.authors.length > 0) {
        alignedMap = alignAuthorNames1to1(names, parsed.authors);
        if (!alignedMap) {
            console.warn(`[作者来源] ${paper?.arxivId || ''} 姓名集合与论文元数据不一致；本次机构信息标为未能可靠取得，原封存记录保留。`);
            return resolveApiReaderAuthors(paper, { ...activeDetails, readerAuthors: null });
        }
    }
    const unavailableAffiliation = activeDetails?.source === 'conference_pdf_text'
        ? '机构信息未能从会议 PDF 纯文本可靠映射'
        : activeDetails?.analysisSource === 'pdf' || activeDetails?.source === 'pdf'
            ? '机构信息未能从 arXiv PDF 文本可靠映射'
            : READER_AFFILIATION_UNBOUND;
    if (parsed && Array.isArray(parsed.authors) && parsed.authors.length > 0
        && recoverySha256(parsed.sourceDomSha256)) {
        if (names.length === 0) names = parsed.authors.map(author => normalizeName(author?.name)).filter(Boolean);
        const knownAuthorIndex = buildKnownAuthorIndex([...names, ...parsed.authors.map(author => author?.name)]);
        const normalizedByRaw = new Map();
        for (const rawAuthor of parsed.authors) {
            normalizedByRaw.set(rawAuthor, {
                name: normalizeName(rawAuthor?.name),
                affiliations: Array.isArray(rawAuthor?.affiliations)
                    ? rawAuthor.affiliations
                        .map(value => sanitizeReaderAffiliationValue(value, knownAuthorIndex))
                        .filter(Boolean)
                    : []
            });
        }
        const effectiveAlign = alignedMap || alignAuthorNames1to1(names, parsed.authors);
        const authors = names.map((name, idx) => {
            if (isMetadataAuthorSeparator(name)) {
                return { name, affiliations: [unavailableAffiliation] };
            }
            const rawMatched = effectiveAlign ? effectiveAlign.get(idx) : null;
            const matched = rawMatched ? normalizedByRaw.get(rawMatched) : null;
            return {
                name,
                affiliations: matched?.affiliations?.length > 0
                    ? matched.affiliations
                    : [unavailableAffiliation]
            };
        });
        return bindApiReaderAuthorIdentity(paper, activeDetails, {
            authors, sourceDomSha256: parsed.sourceDomSha256
        });
    }
    const sourceSha256 = crypto.createHash('sha256')
        .update(String(activeDetails?.text || '')).digest('hex');
    return bindApiReaderAuthorIdentity(paper, activeDetails, {
        authors: names.map(name => ({
            name,
            affiliations: [unavailableAffiliation]
        })),
        sourceDomSha256: sourceSha256
    });
}

function bindApiReaderAuthorIdentity(paper, sourceDetails, resolved) {
    const sourceTextSha256 = crypto.createHash('sha256')
        .update(String(sourceDetails?.text || '')).digest('hex');
    const metadataAuthors = Array.isArray(paper?.authors) ? paper.authors : [];
    const metadataSha256 = stableFingerprint(metadataAuthors);
    const parsedAuthors = Array.isArray(sourceDetails?.readerAuthors?.authors)
        ? sourceDetails.readerAuthors.authors : [];
    const sourceDomSha256 = sourceDetails?.readerAuthors?.sourceDomSha256;
    const isConferencePdf = sourceDetails?.source === 'conference_pdf_text';
    const isPdfPage1 = PDF_PAGE1_AUTHOR_CONTRACTS.has(sourceDetails?.readerAuthors?.contract);
    const isPdfSource = isConferencePdf || isPdfPage1;
    if (isConferencePdf && sourceDetails?.readerAuthors) {
        const evidence = sourceDetails.readerAuthors;
        if (evidence.sourceTextSha256 !== sourceTextSha256
            || typeof evidence.sourceEvidence !== 'string'
            || evidence.sourceEvidenceSha256 !== crypto.createHash('sha256')
                .update(evidence.sourceEvidence).digest('hex')
            || !String(sourceDetails.text || '').includes(evidence.sourceEvidence)) {
            throw new Error('会议 PDF 的作者证据与全文哈希不一致，或者引文缺失、格式无效、哈希不一致或没有完整出现在已保存全文中。');
        }
    }
    if (isPdfPage1 && !validatePdfPage1AuthorEvidence(sourceDetails.readerAuthors)) {
        throw new Error('PDF 首页作者证据的 PDF 哈希、引文哈希或 DOM 哈希无效。');
    }
    const isUnavailable = value => /^机构信息未/.test(String(value || ''));
    const resolvedAuthors = Array.isArray(resolved?.authors) ? resolved.authors : [];
    const alignedResolved = alignAuthorNames1to1(resolvedAuthors.map(a => a?.name || ''), parsedAuthors);
    const metadataCountByKey = new Map();
    for (const item of metadataAuthors) {
        const mk = readerIdentityKey(normalizeReaderMetadataDisplayName(typeof item === 'string' ? item : item?.name));
        metadataCountByKey.set(mk, (metadataCountByKey.get(mk) || 0) + 1);
    }
    const parsedByKey = new Map();
    const resolvedCountByKey = new Map();
    if (!alignedResolved) {
        for (const item of parsedAuthors) {
            const pk = readerIdentityKey(item?.name);
            let list = parsedByKey.get(pk);
            if (!list) {
                list = [];
                parsedByKey.set(pk, list);
            }
            list.push(item);
        }
        for (const item of resolvedAuthors) {
            const rk = readerIdentityKey(item?.name);
            resolvedCountByKey.set(rk, (resolvedCountByKey.get(rk) || 0) + 1);
        }
    }
    const authors = resolvedAuthors.map((author, idx) => {
        const authorKey = readerIdentityKey(author?.name);
        const metadataCount = metadataCountByKey.get(authorKey) || 0;
        let parsed = null;
        if (alignedResolved && alignedResolved.has(idx)) {
            if (metadataCount <= 1) parsed = alignedResolved.get(idx);
        } else {
            const matches = parsedByKey.get(authorKey) || [];
            const sameNamedCount = resolvedCountByKey.get(authorKey) || 0;
            parsed = matches.length === 1 && sameNamedCount === 1
                && metadataCount <= 1 ? matches[0] : null;
        }
        const nameBinding = parsed && recoverySha256(sourceDomSha256)
            ? {
                sourceKind: isPdfSource ? 'pdf_text' : 'html_dom',
                // 来源 DOM 中的作者姓名可能全部大写，而元数据和读者文章使用正常大小写。
                // 此处保存读者文章中的姓名，同时保留来源 DOM 的 SHA，以便核对同一作者。
                sourceValue: author.name,
                sourceDomSha256
            }
            : { sourceKind: 'paper_metadata', sourceValue: author.name, metadataSha256 };
        const affiliationBindings = (author.affiliations || []).map(affiliation => {
            if (isUnavailable(affiliation)) {
                return {
                    sourceKind: 'explicit_unavailable', sourceValue: affiliation,
                    sourceTextSha256
                };
            }
            const direct = parsed?.affiliations?.find(value => (
                readerIdentityKey(sanitizeReaderAffiliationValue(value)) === readerIdentityKey(affiliation)
            ));
            if (!direct || !recoverySha256(sourceDomSha256)) {
                throw new Error(`作者 ${author.name} 的机构“${affiliation}”缺少对应的来源机构记录，或来源内容 SHA 格式无效。`);
            }
            return {
                sourceKind: isPdfSource ? 'pdf_text' : 'html_dom',
                association: 'direct_author',
                sourceValue: affiliation,
                sourceDomSha256
            };
        });
        return { name: author.name, affiliations: author.affiliations, nameBinding, affiliationBindings };
    });
    const identity = {
        ...identityFormat.header('authors'),
        sourceDomSha256: recoverySha256(sourceDomSha256) ? sourceDomSha256 : '',
        sourceTextSha256,
        metadataSha256,
        authors
    };
    return {
        authors: authors.map(item => ({ name: item.name, affiliations: item.affiliations })),
        sourceDomSha256: resolved?.sourceDomSha256 || sourceTextSha256,
        identity,
        identitySha256: stableFingerprint(identity)
    };
}

const CONFERENCE_PDF_AFFILIATION_HINT = new RegExp(`\\b(?:univ(?:ersit[yéèêa-z]*)?|institut(?:e|ion)?|research|school|college|department|dept\\.?|division|faculty|laborator(?:y|ies)|laboratoires?|key laboratory|labs?|academy|cent(?:re|er)|hospital|clinic|foundation|corp(?:oration)?\\.?|company|co\\.?,?\\s*ltd\\.?|inc(?:\\.(?![a-z0-9-])|\\b)|ltd(?:\\.(?![a-z0-9-])|\\b)|gmbh|llc|llp|plc|pbc|${READER_CORP_DOT_SUFFIX_SRC}|technology|technologies|t[ée]l[ée]com(?:munications?)?|intelligence|platforms?|vision|systems?|solutions?|engineering|sciences?|computing|software|networks?|media|communications?|agi\\s+lab|ai\\s+lab|ai\\s+research|adobe|google|deepmind|meta\\s+ai|microsoft|tencent|wechat|alibaba|bytedance|huawei|baidu|oppo|xiaomi|samsung|amazon|apple|nvidia|openai|sony|ibm|intel|qualcomm|bosch|siemens|ntt|kyutai|kaist|inria|cnrs|sorbonne|sinica|northwestern|tsinghua|peking|fudan|sjtu|ustc|cuhk|nus|ntu|snu|cmu|mit|uc\\s+berkeley|eth\\s+zurich|eth\\s+zürich|epfl|idiap|dfki|riken|nict|nii|fbk|isir|vector|allen\\s+institute|athena|mila|team|xian|xi['’]an|france|china|usa|germany|japan|korea|uk|canada|switzerland|singapore|india|turkey|finland|greece|san francisco|evanston|lannion|vannes|lemans)(?=\\b|[\\s,.;)]|$)`, 'i');
const CONFERENCE_PDF_NON_PERSON_AFFILIATION_HINT = new RegExp(`\\b(?:univ(?:ersit[yéèêa-z]*)?|institut(?:e|ion)?|research|school|college|department|dept\\.?|division|faculty|laborator(?:y|ies)|laboratoires?|key laboratory|labs?|academy|cent(?:re|er)|hospital|clinic|foundation|corp(?:oration)?\\.?|company|co\\.?,?\\s*ltd\\.?|inc(?:\\.(?![a-z0-9-])|\\b)|ltd(?:\\.(?![a-z0-9-])|\\b)|gmbh|llc|llp|plc|pbc|${READER_AUTHOR_CORP_DOT_SUFFIX_SRC}|technology|technologies|t[ée]l[ée]com(?:munications?)?|intelligence|platforms?|vision|systems?|solutions?|engineering|sciences?|computing|software|networks?|media|communications?|agi\\s+lab|ai\\s+lab|ai\\s+research|adobe|google|deepmind|meta\\s+ai|microsoft|tencent|wechat|alibaba|bytedance|huawei|baidu|xiaomi|samsung|amazon|nvidia|openai|ibm|intel|qualcomm|siemens|ntt|kyutai|kaist|inria|cnrs|sorbonne|sinica|northwestern|tsinghua|peking|fudan|sjtu|ustc|cuhk|nus|ntu|snu|cmu|mit|uc\\s+berkeley|eth\\s+zurich|eth\\s+zürich|epfl|idiap|dfki|riken|nict|nii|fbk|isir|vector|allen\\s+institute|team)(?=\\b|[\\s,.;)]|$)`, 'i');

function normalizeConferencePdfAuthorName(value) {
    return String(value || '')
        .replace(/\u00a0|\uf020/g, ' ')
        .replace(/\uf02a/g, '∗')
        .replace(/\x86/g, '†')
        .replace(/\x87/g, '‡')
        .replace(READER_NON_WS_CTRL_RE, '')
        // Strip Interspeech ORCID badge 'ID' trailing a name (even after symbol markers like `Georgiou* ID`)
        .replace(/(?<=\p{L})([†‡∗⋆*§¶‖∥#]*)\s+ID(?=\s*(?:[,;]|$))/gu, '$1')
        .replace(/\s+/g, ' ').trim()
        .replace(/^(?:and|&)$/i, '')
        .replace(/^(?:and|&)\s+/i, '')
        .replace(/\s+(?:and|&)$/i, '')
        .replace(/\s+/g, ' ').trim()
        .replace(/c¸/g, 'ç').replace(/C¸/g, 'Ç')
        .replace(/c´ı/g, 'cí').replace(/C´ı/g, 'Cí');
}

function validConferencePdfAuthorName(value) {
    const name = normalizeConferencePdfAuthorName(value);
    if (!name || name.length > 120 || NON_PERSON_ORG_TOKEN_CS_RE.test(name)
        || READER_NON_PERSON_AFFILIATION_HINT_RE.test(name)
        || READER_AUTHOR_UPPERCASE_CORP_SUFFIX_RE.test(name)
        || MULTI_WORD_LOCATION_PHRASE_RE.test(name)
        || READER_SECTION_META_HEADING_RE.test(name)
        || READER_DATE_LINE_RE.test(name)
        || READER_ROLE_FOOTNOTE_RE.test(name)
        || READER_UNANCHORED_ROLE_SENTENCE_RE.test(name)
        || isReaderCreditContribution(name)
        || READER_VENUE_OR_STATUS_RE.test(name)) return false;
    const tokens = name.split(/\s+/).filter(Boolean);
    if (tokens.length < 2 || tokens.length > 8) return false;
    const lowered = tokens.map(tok => trimBothChars(tok.toLowerCase(), "'’.-"));
    if (NON_PERSON_AUTHOR_FIRST_TOKENS.has(lowered[0])) return false;
    if (lowered.some(tok => KNOWN_NON_PERSON_ORG_TOKENS.has(tok) || NON_PERSON_AUTHOR_ANY_TOKENS.has(tok))) return false;
    if (isOrgHeadPlusLocationName(tokens, lowered)) return false;
    const lowerSurnameStopwords = new Set([
        'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'of', 'on', 'or', 'the', 'to', 'with'
    ]);
    const lastLower = lowered[tokens.length - 1];
    const hasCapParticleLowerSurname = tokens.length >= 3
        && NOBILIARY_PARTICLES.has(lowered[tokens.length - 2])
        && /^[\p{Lu}\p{Lt}]/u.test(tokens[tokens.length - 2])
        && /^\p{Ll}/u.test(tokens[tokens.length - 1])
        && lastLower.length >= 2
        && !NOBILIARY_PARTICLES.has(lastLower)
        && !lowerSurnameStopwords.has(lastLower);
    if (!/^[\p{Lu}\p{Lt}]/u.test(tokens[tokens.length - 1]) && !hasCapParticleLowerSurname) return false;
    if (!/^[\p{Lu}\p{Lt}]/u.test(tokens[0]) && !NOBILIARY_PARTICLES.has(lowered[0])) return false;
    return tokens.every((token, idx) => {
        if (idx > 0 && idx < tokens.length - 1 && isMidNameNicknameToken(token)) return true;
        if (!/^[\p{L}\p{M}][\p{L}\p{M}'’.'-]*$/u.test(token)) return false;
        if (token.includes('.')) {
            if (/^(?:[A-Z]\.){2,}$/.test(token)) {
                if (['U.S.', 'U.K.', 'U.S.A.', 'P.R.', 'E.U.', 'D.C.'].includes(token)) return false;
                if ((token.match(/\./g) || []).length >= 3) return false;
            } else if (!/^(?:[\p{Lu}][\p{Ll}]{0,2}\.(?:-[\p{Lu}][\p{Ll}]{0,2}\.?)*|[\p{Lu}]\.[\p{Lu}]\.)$/u.test(token)
                || ['Co.', 'St.', 'No.', 'Dr.', 'Mr.', 'Ms.', 'Inc.', 'Ltd.'].includes(token)) {
                return false;
            }
        }
        return true;
    });
}

function normalizeConferencePdfAffiliation(value) {
    let s = String(value || '').replace(/\u00a0|\uf020/g, ' ').replace(/\s+/g, ' ').trim();
    const barDoi = /[|｜]|DOI\s*:/i.exec(s);
    if (barDoi) {
        let cut = barDoi.index;
        while (cut > 0 && /\s/.test(s[cut - 1])) cut--;
        s = s.slice(0, cut);
    }
    // PDF 那一行在分栏处没有空白时，PyMuPDF 会把 DOI 直接接在机构名最后一个 token 后面（严格 O(n) 尾窗扫描）。
    if (s.includes('10.')) {
        const winStart = Math.max(0, s.length - 256);
        const tail = s.slice(winStart);
        const stripped = stripTrailingDoiInTail(tail);
        if (stripped.length < tail.length) s = s.slice(0, winStart + stripped.length);
    }
    return stripNonAbbreviationTrailingDot(s);
}

const CONF_PDF_SYMBOL_CHARS = '†‡∗⋆*§¶‖∥#';

/**
 * 只从保留下来的会议 PDF 里恢复肉眼可见的那块作者信息。
 * 支持上标符号/数字标记（含 Interspeech ORCID ID、PUA \uf02a、空格分隔标记、紧贴机构首字的数字标记、and/& 连接）
 * 以及明确无标记的单一共享机构导言区。返回的证据在交给 Reader 之前，会连同完整来源文本 SHA 和 preamble 的精确 SHA 一起绑定。
 */
function parseConferencePdfAuthorsUncached(sourceText) {
    const abstractIndex = sourceText.search(/\n[^\S\n]*ABSTRACT\b/i);
    const preamble = abstractIndex >= 0 ? sourceText.slice(0, abstractIndex) : sourceText.slice(0, 12000);
    const rawLines = preamble.split(/\n/);
    const lineEntries = rawLines.map(raw => {
        // Normalize exotic whitespace to single space, collapse any mixed run containing wide Unicode spaces
        // to single '\u2002', and collapse tabs / >=3 ASCII spaces to '   ' (keeping exact 2-space runs distinct
        // from 3-space gaps) while eliminating quadratic regex backtracking on mixed space/wide-space runs.
        const preserved = raw
            .replace(/[\u00a0\uf020\r\f\v\u1680\u2028\u2029\u202f\u205f\ufeff]+/g, ' ')
            .replace(/\uf02a/g, '∗')
            .replace(/\x86/g, '†')
            .replace(/\x87/g, '‡')
            .replace(READER_NON_WS_CTRL_RE, '')
            .replace(/[ \t\u2002-\u200b\u3000]+/gu, m => (
                /[\u2002-\u200b\u3000]/u.test(m)
                    ? '\u2002'
                    : (m.includes('\t') || m.length >= 3 ? '   ' : m)
            ));
        return { raw: preserved.trim(), norm: preserved.replace(/\s+/g, ' ').trim() };
    }).filter(entry => Boolean(entry.norm));
    const lines = lineEntries.map(entry => entry.norm);
    const symbolAuthors = [];
    const numericAuthors = [];
    const symAuthorRe = /(?:^|(?<=,))([^,†‡∗⋆*§¶‖∥#]+)([†‡∗⋆*§¶‖∥#]+(?:\s*,\s*[†‡∗⋆*§¶‖∥#]+)*)(?=\s*(?:,|and\b|&|$))/giu;
    const numAuthorRe = /(?:^|(?<=,))([^,\d†‡∗⋆*§¶‖∥#]+)((?:[†‡∗⋆*§¶‖∥#]+\s*(?:,\s*)?)?\d{1,3}(?:\s*[†‡∗⋆*§¶‖∥#]+)?(?:\s*,\s*(?:(?:[†‡∗⋆*§¶‖∥#]+\s*(?:,\s*)?)?\d{1,3}(?:\s*[†‡∗⋆*§¶‖∥#]+)?|[†‡∗⋆*§¶‖∥#]+))*)(?=\s*(?:,|and\b|&|$))/giu;
    for (const line of lines) {
        if (CONFERENCE_PDF_NON_PERSON_AFFILIATION_HINT.test(line)
            || READER_AUTHOR_UPPERCASE_CORP_SUFFIX_RE.test(line)
            || /@|DOI\s*:/i.test(line)) continue;
        // Strip standalone Interspeech ORCID 'ID' before marker matching (including after symbol markers like `Georgiou* ID 2`)
        const cleanedLine = line.replace(/(?<=\p{L})([†‡∗⋆*§¶‖∥#]*)\s+ID(?=\s*(?:[,;\d†‡∗⋆*§¶‖∥#]|and\b|&|$))/gu, '$1');
        // Split on ' and ' / ' & ' first so "Alice1 and Bob2" parses both names cleanly
        const segments = cleanedLine.split(/\s+(?:and|&)\s+/i);
        let foundSymbol = false;
        const lineSymbols = [];
        const lineNumerics = [];
        for (const seg of segments) {
            const symbolMatches = [...seg.matchAll(symAuthorRe)]
                .map(match => ({
                    name: normalizeConferencePdfAuthorName(match[1]),
                    markers: [...match[2].matchAll(/[†‡∗⋆*§¶‖∥#]/gu)].map(marker => normalizeHtmlMarkerToken(marker[0]))
                }))
                .filter(item => validConferencePdfAuthorName(item.name));
            const numericMatches = [...seg.matchAll(numAuthorRe)]
                .map(match => ({
                    name: normalizeConferencePdfAuthorName(match[1]),
                    markers: [...match[2].matchAll(/\d{1,3}/g)].map(m => m[0])
                }))
                .filter(item => item.markers.length > 0 && validConferencePdfAuthorName(item.name));
            if (numericMatches.length) lineNumerics.push(...numericMatches);
            else if (symbolMatches.length) { foundSymbol = true; lineSymbols.push(...symbolMatches); }
        }
        if (lineNumerics.length) numericAuthors.push(...lineNumerics);
        else if (foundSymbol && lineSymbols.length) symbolAuthors.push(...lineSymbols);
    }
    const authors = symbolAuthors.length ? symbolAuthors : numericAuthors;
    const evidence = preamble.trim();
    const sourceTextSha256 = sha256(Buffer.from(sourceText, 'utf8'));
    const evidenceSha256 = sha256(Buffer.from(evidence, 'utf8'));
    if (authors.length) {
        const markerSet = new Set(authors.flatMap(item => item.markers));
        const affiliations = new Map();
        const authorNameIndex = buildKnownAuthorIndex(authors.map(a => a.name));
        for (const entry of lineEntries) {
            const line = entry.norm;
            const ungluedLine = entry.raw.replace(/(?:^|(?<![ \u2002-\u200b\u3000])(?:[\u2002-\u200b\u3000]+| {2,})|[;；]\s*)(?![1-4]D(?:[A-Z]{2,}|\b))[1-9]\d{0,2}(?=[A-Z](?:[a-z]{2,}|[A-Z]))/g, ' ');
            if (!CONFERENCE_PDF_AFFILIATION_HINT.test(ungluedLine) && !READER_UPPERCASE_CORP_SUFFIX_RE.test(ungluedLine)) continue;
            for (const match of line.matchAll(/([†‡∗⋆*§¶‖∥#])\s*([^†‡∗⋆*§¶‖∥#]+?)(?=[†‡∗⋆*§¶‖∥#]|$)/gu)) {
                const symMk = normalizeHtmlMarkerToken(match[1]);
                const value = normalizeConferencePdfAffiliation(match[2]);
                const sanitized = value ? sanitizeReaderAffiliationValue(value, authorNameIndex) : '';
                if (markerSet.has(symMk) && sanitized && !/@|DOI\s*:/i.test(value)
                    && !READER_ROLE_FOOTNOTE_RE.test(value)
                    && !READER_UNANCHORED_ROLE_SENTENCE_RE.test(value)
                    && !isReaderCreditContribution(value)
                    && !READER_IEEE_MEMBER_ONLY_RE.test(value)
                    && !affiliations.has(symMk)) {
                    affiliations.set(symMk, sanitized);
                }
            }
            for (const match of entry.raw.matchAll(/(?:^|(?<![ \u2002-\u200b\u3000])(?:[\u2002-\u200b\u3000]+| {2,})|[;；]\s*)(?![1-4]D(?:[A-Z]{2,}|\b))(?!\d+(?:st|nd|rd|th)\b)([1-9]\d{0,2})(?:\s+|(?=[A-Z](?:[a-z]{2,}|[A-Z])))(.+?)(?=(?:(?<![ \u2002-\u200b\u3000])(?:[\u2002-\u200b\u3000]+| {2,})|[;；]\s*)[1-9]\d{0,2}(?:\s+|[A-Z](?:[a-z]{2,}|[A-Z]))|$)/gu)) {
                const value = normalizeConferencePdfAffiliation(match[2]);
                const sanitized = value ? sanitizeReaderAffiliationValue(value, authorNameIndex) : '';
                if (markerSet.has(match[1]) && sanitized && !/@|DOI\s*:/i.test(value)
                    && !READER_ROLE_FOOTNOTE_RE.test(value)
                    && !READER_UNANCHORED_ROLE_SENTENCE_RE.test(value)
                    && !isReaderCreditContribution(value)
                    && !READER_IEEE_MEMBER_ONLY_RE.test(value)
                    && !isBareStreetAddressLine(value)
                    && !affiliations.has(match[1])) {
                    affiliations.set(match[1], sanitized);
                }
            }
        }
        const normalizedAuthors = authors.map(author => ({
            name: author.name,
            affiliations: [...new Set(author.markers.map(marker => affiliations.get(marker)).filter(Boolean))]
        }));
        return {
            contract: 'conference-pdf-author-evidence-v1',
            authors: normalizedAuthors,
            sourceTextSha256,
            sourceEvidence: evidence,
            sourceEvidenceSha256: evidenceSha256,
            sourceDomSha256: evidenceSha256
        };
    }
    // Unmarked single-institution fallback for conference PDFs where all authors share 1 explicit affiliation line
    const unmarkedAuthors = [];
    const unmarkedAffs = [];
    const unmarkedAffRaw = [];
    const confVenueOrMetaRe = /^(?:(?:accepted\s+(?:at|to|by)|published\s+(?:at|in)|to\s+appear\s+in|proceedings\s+of|in\s+proceedings|under\s+review|technical\s+report|working\s+paper|preprint|draft|camera[- ]ready|arXiv|abstract|index\s+terms|keywords?|figure\s+\d|table\s+\d)\b|(?:ICASSP|INTERSPEECH|NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|IEEE|SLT|ASRU|WASPAA|ISMIR|DCASE|EUSIPCO|BMVC)\b.*(?:19|20)\d{2}\b)/i;
    const confDateRe = /^(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})$/i;
    const confNonPersonEntityHintRe = READER_NON_PERSON_AFFILIATION_HINT_RE;
    const confLocSegRe = /^[\p{Lu}\p{Lt}][\p{L}\p{M}\p{N}'’.-]+(?:\s+(?:of\s+)?[\p{Lu}\p{Lt}][\p{L}\p{M}\p{N}'’.-]+){0,3}$/u;
    const isConfLocationOnly = value => {
        const parts = String(value || '').split(',').map(p => p.trim());
        if (parts.length !== 2 && parts.length !== 3) return false;
        const left = parts[0];
        const right = parts[parts.length - 1];
        if (!confLocSegRe.test(left)) return false;
        const rightNoZip = right.replace(/\s+\d{4,6}$/, '').trim();
        if (!confLocSegRe.test(rightNoZip) || !isKnownLocationTail(rightNoZip)) return false;
        if (parts.length === 3) {
            const mid = parts[1];
            const midNoZip = mid.replace(/\s+\d{4,6}$/, '').trim();
            const isPostal = /^\d{4,6}(?:-\d{4})?$/.test(mid);
            const isState = confLocSegRe.test(midNoZip) && isKnownLocationTail(midNoZip);
            if (!isPostal && !isState) return false;
        }
        if (READER_AFFILIATION_ENTITY_HINT_RE.test(left)
            || READER_UPPERCASE_CORP_SUFFIX_RE.test(left)
            || NON_PERSON_ORG_TOKEN_CS_RE.test(left)
            || MIXED_CASE_AI_ORG_LINE_RE.test(left)) return false;
        const leftKey = left.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (KNOWN_NON_CITY_ORG_HEADS.has(leftKey)) return false;
        if (left.split(/\s+/).some(tok => KNOWN_NON_PERSON_ORG_TOKENS.has(tok.toLowerCase().replace(/[^a-z0-9]/g, '')))) return false;
        if (/[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(left)) return false;
        if (left.length >= 2 && left === left.toUpperCase() && !EXEMPT_UPPER_CITIES.has(left)) return false;
        return true;
    };
    const isExtraUnmarkedOrgLine = value => {
        const s = String(value || '').trim();
        if (!s || s.length < 2 || s.length > 75 || s.split(/\s+/).length > 10) return false;
        if (READER_ROLE_FOOTNOTE_RE.test(s) || READER_UNANCHORED_ROLE_SENTENCE_RE.test(s)
            || confVenueOrMetaRe.test(s) || confDateRe.test(s) || isConfLocationOnly(s)
            || MULTI_WORD_LOCATION_PHRASE_RE.test(s) || isKnownLocationTail(s)) return false;
        if (/\b(?:19|20)\d{2}\b/.test(s)) return false;
        const firstTok = s.split(/\s+/)[0];
        const startsOrg = /^[\p{Lu}\p{Lt}\u3400-\u9fff]/u.test(firstTok) || /^[a-z]{1,10}[A-Z]/.test(firstTok);
        if (!startsOrg) return false;
        return /^[\p{L}\p{N}&'’.,;；\s()·•/-]{2,75}$/u.test(s);
    };
    const hasStrongUnmarkedOrgSignal = value => {
        const s = String(value || '').trim();
        if (!s) return false;
        const toks = s.split(/\s+/);
        return (s === s.toUpperCase() && /[A-Z]/.test(s))
            || /[a-z][A-Z]|[A-Z]{2,}[a-z]/.test(s)
            || KNOWN_NON_CITY_ORG_HEADS.has(s.toLowerCase().replace(/[^a-z0-9]/g, ''))
            || toks.some(t => KNOWN_NON_CITY_ORG_HEADS.has(t.toLowerCase().replace(/[^a-z0-9]/g, '')))
            || READER_UPPERCASE_CORP_SUFFIX_RE.test(s)
            || NON_PERSON_ORG_TOKEN_CS_RE.test(s)
            || MIXED_CASE_AI_ORG_LINE_RE.test(s);
    };
    const stripInlineEmailUrl = value => {
        let s = String(value || '').replace(/\s+/g, ' ').trim();
        const braceDomPat = '(?:@|[a-z0-9.-]+\\.(?:edu|com|org|cn|net|io|ai|gov|de|uk|fr|jp|kr|ca|ch|sg|au|nl|eu|ac\\.[a-z]{2}|co\\.[a-z]{2}|edu\\.[a-z]{2})\\b)';
        if (s.includes('(') && s.includes(')')) {
            s = s.replace(/ ?\( ?(?:e-?mail|emails?|corresponding\s+author|work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:while|during|at|as)|equal\s+contribution|contributed\s+equally)[^()]*\)/gi, ' ');
            s = s.replace(/ ?\( ?(?:https?:\/\/|www\.)[^()]*\)/gi, ' ');
            if (s.includes('{') && s.includes('}')) {
                s = s.replace(new RegExp(` ?\\( ?\\{[^}{]+\\} ?${braceDomPat}[^()]*\\)`, 'gi'), ' ');
            }
            s = s.replace(/\s+/g, ' ').trim();
        }
        if (s.includes(':') || s.includes('：')) {
            s = s.replace(/,?(?: ?[\(\[<] ?| ?)(?:e-?mail|emails?) ?[:：] ?\S+.*$/i, '');
        }
        if (s.includes('{') && s.includes('}')) {
            s = s.replace(new RegExp(`(?: ?[\\(\\[<] ?| ?)\\{[^}{]+\\} ?${braceDomPat}\\S*.*$`, 'i'), '');
        }
        s = stripTrailingAtEmailLinear(s);
        if (/https?:\/\/|www\./i.test(s)) {
            s = s.replace(/,?(?: ?[\(\[<] ?| ?)(?:https?:\/\/|www\.)\S+.*$/i, '');
        }
        return s;
    };
    let unmarkedAmbiguous = false;
    let unmarkedLocSeen = false;
    let unmarkedPreExtraOrgSeen = false;
    let sawResourceAfterInst = false;
    const hasLocationTail = value => {
        const commaIdx = String(value || '').lastIndexOf(',');
        if (commaIdx < 0) return false;
        const tail = String(value).slice(commaIdx + 1).trim().replace(/\s+\d{4,6}$/, '').trim();
        return isKnownLocationTail(tail);
    };
    const emailDomainMatchesLeft = (rawLine, locText, inst0 = '') => {
        const left = String(locText || '').split(',')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
        if (left.length < 3) return false;
        const inst0Norm = String(inst0 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (inst0Norm && inst0Norm.includes(left)) return false;
        const raw = String(rawLine || '');
        for (const em of raw.matchAll(/@([a-z0-9.-]+)/gi)) {
            const domain = em[1].toLowerCase().replace(/[^a-z0-9]/g, '');
            if (domain.includes(left)) return true;
        }
        for (const um of raw.matchAll(/(?:https?:\/\/|www\.)([a-z0-9.-]+)/gi)) {
            const host = um[1].toLowerCase().replace(/[^a-z0-9]/g, '');
            if (host.includes(left)) return true;
        }
        return false;
    };
    for (let i = 0; i < lineEntries.length; i++) {
        if (i === 0) continue; // skip title line 0 BEFORE checking affiliation keywords
        const line = lineEntries[i].norm;
        if (confVenueOrMetaRe.test(line) || confDateRe.test(line)
            || READER_ROLE_FOOTNOTE_RE.test(line) || READER_IEEE_MEMBER_ONLY_RE.test(line)) continue;
        if (unmarkedAuthors.length > 0) {
            if (/@|DOI\s*:|https?:\/\/|www\./i.test(line)) {
                // Split on wide spaces, semicolons, and commas following bracketed/bare email/URL tokens so a left-column
                // email/URL never swallows a right-column or comma-following institution.
                const splitReadyRaw = lineEntries[i].raw.includes(',')
                    ? lineEntries[i].raw
                        .replace(
                            /(\([^()]{1,120}(?:@|https?:\/\/|www\.)[^()]{0,120}\)|<[^<>]{1,120}(?:@|https?:\/\/|www\.)[^<>]{0,120}>|\[[^\[\]]{1,120}(?:@|https?:\/\/|www\.)[^\[\]]{0,120}\])\s*,\s*/gi,
                            '$1; '
                        )
                        .replace(
                            /((?<![^\s,;()<>[\]@])[^\s,;()<>[\]@]+@[^\s,;()<>[\]@]+|(?<![^\s,;()<>[\]])(?:https?:\/\/|www\.)[^\s,;()<>[\]]+)\s*,\s*/gi,
                            '$1; '
                        )
                    : lineEntries[i].raw;
                const resChunks = splitReadyRaw.split(/[\u2002-\u200b\u3000]+| {2,}|[;；]/u)
                    .map(ch => ch.trim()).filter(Boolean);
                const lineHasContact = /@|https?:\/\/|www\./i.test(line);
                for (const resChunk of (resChunks.length ? resChunks : [line])) {
                    const stripped = normalizeConferencePdfAffiliation(stripInlineEmailUrl(resChunk));
                    const cleaned = sanitizeReaderAffiliationValue(stripped, unmarkedAuthors);
                    if (cleaned && (READER_AFFILIATION_ENTITY_HINT_RE.test(cleaned) || READER_UPPERCASE_CORP_SUFFIX_RE.test(cleaned)) && !isConfLocationOnly(cleaned)) {
                        unmarkedAffs.push(cleaned);
                        unmarkedAffRaw.push(resChunk);
                        sawResourceAfterInst = true;
                    } else if (cleaned && isExtraUnmarkedOrgLine(cleaned)) {
                        if (unmarkedAffs.length >= 1) {
                            unmarkedAffs.push(cleaned);
                            unmarkedAffRaw.push(resChunk);
                            sawResourceAfterInst = true;
                        } else if (lineHasContact && (!isValidPersonAuthorName(cleaned) || MIXED_CASE_AI_ORG_LINE_RE.test(cleaned))) {
                            unmarkedPreExtraOrgSeen = true;
                        }
                    } else if (cleaned && lineHasContact && isConfLocationOnly(cleaned)) {
                        if (unmarkedAffs.length === 0) {
                            unmarkedPreExtraOrgSeen = true;
                        } else if (sawResourceAfterInst || unmarkedLocSeen
                            || hasLocationTail(unmarkedAffs[0]) || emailDomainMatchesLeft(line, cleaned, unmarkedAffs[0])) {
                            unmarkedAmbiguous = true;
                        } else {
                            unmarkedLocSeen = true;
                            sawResourceAfterInst = true;
                        }
                    } else if (unmarkedAffs.length > 0) {
                        sawResourceAfterInst = true;
                    }
                }
                continue;
            }
            if (unmarkedAffs.length === 0 && !confNonPersonEntityHintRe.test(line) && !READER_AUTHOR_UPPERCASE_CORP_SUFFIX_RE.test(line)) {
                // Before accepting an affiliation line (including surname-colliding hints like "Athena", "Mila", "Honda"),
                // check if this line is a multi-author (or single-author) continuation line (e.g. "Athena Dai, Carol Davis",
                // "Carol Davis", "John McDonald", "Mila Novak", or ALL-CAPS "CAROL DAVIS"), while rejecting all-"<Word> AI" org rows.
                const rawLine = lineEntries[i].raw;
                const rawMultiOrgChunks = rawLine.split(/[\u2002-\u200b\u3000]+| {2,}|[;；]\s*/u)
                    .map(ch => ch.trim()).filter(Boolean);
                const rawAllMixedCaseAiOrg = rawMultiOrgChunks.length > 0
                    && rawMultiOrgChunks.every(ch => MIXED_CASE_AI_ORG_LINE_RE.test(ch));
                const cleanedAuthorProbe = rawLine.replace(/(?<=\p{L})([†‡∗⋆*§¶‖∥#]*)\s+ID(?=\s*(?:[,;]|and\b|&|$))/gu, '$1');
                const authorPartsProbe = cleanedAuthorProbe
                    .split(/[\u2002-\u200b\u3000]+| {2,}| *, *| +(?:and|&) +/iu)
                    .map(normalizeConferencePdfAuthorName).filter(Boolean);
                const allMixedCaseAiOrg = rawAllMixedCaseAiOrg || (authorPartsProbe.length > 0
                    && authorPartsProbe.every(ch => MIXED_CASE_AI_ORG_LINE_RE.test(ch)));
                const hasSemicolon = /[;；]/.test(rawLine);
                if (!hasSemicolon && !allMixedCaseAiOrg && authorPartsProbe.length >= 2 && authorPartsProbe.every(validConferencePdfAuthorName)) {
                    unmarkedAuthors.push(...authorPartsProbe);
                    continue;
                }
                if (!hasSemicolon && !allMixedCaseAiOrg && !unmarkedPreExtraOrgSeen
                    && rawMultiOrgChunks.length === 1 && authorPartsProbe.length === 1
                    && !isConfLocationOnly(line) && !MIXED_CASE_AI_ORG_LINE_RE.test(line)
                    && (line !== line.toUpperCase() || unmarkedAuthors.every(a => a === a.toUpperCase()))
                    && validConferencePdfAuthorName(authorPartsProbe[0])) {
                    unmarkedAuthors.push(authorPartsProbe[0]);
                    continue;
                }
            }
            const cleanedLineAff = sanitizeReaderAffiliationValue(normalizeConferencePdfAffiliation(line), unmarkedAuthors);
            if (cleanedLineAff && isConfLocationOnly(cleanedLineAff)) {
                if (unmarkedAffs.length > 0 && (sawResourceAfterInst || unmarkedLocSeen || hasLocationTail(unmarkedAffs[0]))) {
                    // Inst 1 already carries a location tail (e.g. "Stanford University, CA 94305"),
                    // an email/URL block already followed Inst 1, or a location line was seen;
                    // another "<Name>, <State/Country>" line (e.g. "Sesame, CA") signals a second institution.
                    unmarkedAmbiguous = true;
                } else if (unmarkedAffs.length > 0) {
                    unmarkedLocSeen = true;
                } else {
                    // "<Name>, <State/Country>" appearing BEFORE Inst 1 (e.g. "Cartesia, CA\nStanford University")
                    // is a preceding non-keyword organization, not a trailing location line.
                    unmarkedPreExtraOrgSeen = true;
                }
                continue;
            }
            if (READER_AFFILIATION_ENTITY_HINT_RE.test(line) || READER_UPPERCASE_CORP_SUFFIX_RE.test(line)) {
                if (cleanedLineAff && !READER_ROLE_FOOTNOTE_RE.test(cleanedLineAff)) {
                    unmarkedAffs.push(cleanedLineAff);
                    unmarkedAffRaw.push(lineEntries[i].raw);
                }
                continue;
            }
            if (unmarkedAffs.length > 0) {
                if (cleanedLineAff && isExtraUnmarkedOrgLine(cleanedLineAff)) {
                    unmarkedAffs.push(cleanedLineAff);
                    unmarkedAffRaw.push(lineEntries[i].raw);
                }
                continue;
            }
            const rawPreChunks = lineEntries[i].raw.split(/[\u2002-\u200b\u3000]+| {2,}|[;；] *| *, */u)
                .map(ch => ch.trim()).filter(Boolean);
            if (cleanedLineAff && isExtraUnmarkedOrgLine(cleanedLineAff)
                && (!validConferencePdfAuthorName(cleanedLineAff)
                    || /[;；]|[\u2002-\u200b\u3000]| {2,}/u.test(lineEntries[i].raw)
                    || (rawPreChunks.length > 0 && rawPreChunks.every(ch => MIXED_CASE_AI_ORG_LINE_RE.test(ch))))) {
                unmarkedPreExtraOrgSeen = true;
            }
            continue;
        }
        if (/@|DOI\s*:|https?:\/\/|www\./i.test(line) || confNonPersonEntityHintRe.test(line) || READER_AUTHOR_UPPERCASE_CORP_SUFFIX_RE.test(line)) continue;
        const rawLine = lineEntries[i].raw;
        if (/[;；]/.test(rawLine)) continue;
        const cleanedLine = rawLine.replace(/(?<=\p{L})([†‡∗⋆*§¶‖∥#]*)\s+ID(?=\s*(?:[,;]|and\b|&|$))/gu, '$1');
        const parts = cleanedLine.split(/[\u2002-\u200b\u3000]+| {2,}| *, *| +(?:and|&) +/iu).map(normalizeConferencePdfAuthorName).filter(Boolean);
        if (parts.length >= 2 && parts.every(validConferencePdfAuthorName)
            && !parts.every(ch => MIXED_CASE_AI_ORG_LINE_RE.test(ch))) {
            unmarkedAuthors.push(...parts);
        }
    }
    const rawSplitParts = unmarkedAffRaw[0]
        ? unmarkedAffRaw[0].split(/[\u2002-\u200b\u3000]+| {2,}|[;；]/u).map(part => part.trim()).filter(Boolean)
        : [];
    let multiInstHintCount = 0;
    let multiInstOrgCount = 0;
    for (const part of rawSplitParts) {
        const cleanedPart = sanitizeReaderAffiliationValue(
            normalizeConferencePdfAffiliation(stripInlineEmailUrl(part)),
            unmarkedAuthors
        );
        if (!cleanedPart || /\b(?:of|for|and|in|at|the|de|la|du)$/i.test(cleanedPart)) continue;
        if (((READER_AFFILIATION_ENTITY_HINT_RE.test(cleanedPart) || READER_UPPERCASE_CORP_SUFFIX_RE.test(cleanedPart)) && !isConfLocationOnly(cleanedPart))
            || (isExtraUnmarkedOrgLine(cleanedPart) && hasStrongUnmarkedOrgSignal(cleanedPart))) {
            multiInstHintCount++;
            multiInstOrgCount++;
        } else if (isExtraUnmarkedOrgLine(cleanedPart)) {
            multiInstOrgCount++;
        }
    }
    const hasTwoSpaceMultiInst = rawSplitParts.length >= 2 && multiInstHintCount >= 1 && multiInstOrgCount >= 2;
    if (!unmarkedAmbiguous && !unmarkedPreExtraOrgSeen && unmarkedAuthors.length >= 2 && unmarkedAffs.length === 1
        && !hasTwoSpaceMultiInst
        && !/[;；]|[\u2002-\u200b\u3000]| {3,}/.test(unmarkedAffRaw[0])) {
        return {
            contract: 'conference-pdf-author-evidence-v1',
            authors: unmarkedAuthors.map(name => ({ name, affiliations: [unmarkedAffs[0]] })),
            sourceTextSha256,
            sourceEvidence: evidence,
            sourceEvidenceSha256: evidenceSha256,
            sourceDomSha256: evidenceSha256
        };
    }
    return null;
}

function parseConferencePdfAuthors(text) {
    const sourceText = String(text || '');
    const cacheKey = `v1:${sha256(Buffer.from(sourceText, 'utf8'))}`;
    const cached = getBoundedCacheEntry(conferencePdfAuthorCache, cacheKey);
    if (cached !== undefined) {
        authorCacheCounters.conferencePdfHits++;
        return cached === null ? null : structuredClone(cached);
    }
    authorCacheCounters.conferencePdfMisses++;
    const parsed = parseConferencePdfAuthorsUncached(sourceText);
    setBoundedCacheEntry(conferencePdfAuthorCache, cacheKey, parsed === null ? null : structuredClone(parsed));
    return parsed === null ? null : structuredClone(parsed);
}

// 原 HTML 仅供本地身份重放，不是模型证据或图片缓存。

const CONFERENCE_PDF_AUTHOR_LINES_V2 = 'conference-pdf-author-lines-v2';
function parseConferencePdfAuthorsV2(text) {
    const original = String(text || '');
    const textSha256 = sha256(Buffer.from(original, 'utf8'));
    const cacheKey = `v2:${textSha256}`;
    const cached = getBoundedCacheEntry(conferencePdfAuthorCache, cacheKey);
    if (cached !== undefined) {
        authorCacheCounters.conferencePdfHits++;
        return cached === null ? null : structuredClone(cached);
    }
    authorCacheCounters.conferencePdfMisses++;
    const boundary = original.search(/\n[^\S\n]*ABSTRACT\b/i);
    const preamble = boundary >= 0 ? original.slice(0, boundary) : original.slice(0, 12000);
    const raw = preamble.split('\n'), projected = [];
    for (let i = 0; i < raw.length; i++) {
        let line = raw[i];
        // Only an explicitly unfinished labelled institution can own an
        // indented continuation. Never absorb names, emails, another marker,
        // Abstract, acknowledgements or ordinary paper prose.
        if (/^\s*(?:[1-9]\d{0,2}|[†‡∗⋆*])\s+/.test(line) && CONFERENCE_PDF_AFFILIATION_HINT.test(line)) {
            for (let count = 0; count < 2 && /\b(?:of|and)\s*$/i.test(line) && i + 1 < raw.length; count++) {
                const next = raw[i + 1];
                if (!/^\s{2,}\S/u.test(next) || !/^\s*(?:Technology|Science|Engineering|School|University|Institute|Academy|Department|College|Center|Centre)\b/i.test(next)
                    || /[@]|^\s*(?:[1-9]\d{0,2}|[†‡∗⋆*])\s+|\b(?:Abstract|Acknowledg|Introduction|DOI)\b/i.test(next)) break;
                line += ' ' + next.trim(); i++;
            }
        }
        projected.push(line);
    }
    const parsed = parseConferencePdfAuthorsUncached(projected.join('\n') + (boundary >= 0 ? original.slice(boundary) : ''));
    if (!parsed) {
        setBoundedCacheEntry(conferencePdfAuthorCache, cacheKey, null);
        return null;
    }
    const evidence = preamble.trim();
    const evidenceSha256 = sha256(Buffer.from(evidence, 'utf8'));
    const result = {
        ...parsed,
        contract: 'conference-pdf-author-evidence-v2',
        sourceTextSha256: textSha256,
        sourceEvidence: evidence,
        sourceEvidenceSha256: evidenceSha256,
        sourceDomSha256: evidenceSha256
    };
    setBoundedCacheEntry(conferencePdfAuthorCache, cacheKey, structuredClone(result));
    return structuredClone(result);
}

function inspectHtmlAuthorSource(html) {
    if (typeof html !== 'string' || !html || Buffer.byteLength(html, 'utf8') > MAX_AUTHOR_SOURCE_HTML_BYTES
        || /data\s*:\s*image\/|<svg\b|<canvas\b/iu.test(html)) {
        return { htmlSha256: '', retainable: false, readerAuthors: null };
    }
    const openHtmlMatch = html.includes('>') ? /<html\b[^<>]*>/iu.exec(html) : null;
    if (!openHtmlMatch || !/<\/html\s*>/iu.test(html.slice(openHtmlMatch.index + openHtmlMatch[0].length))) {
        return { htmlSha256: '', retainable: false, readerAuthors: null };
    }
    const htmlSha256 = sha256(html);
    const cacheKey = legacyReplayPreservePureLocationDepth > 0 ? `legacy:${htmlSha256}` : htmlSha256;
    const cached = getBoundedCacheEntry(htmlAuthorSourceCache, cacheKey);
    if (cached !== undefined) {
        authorCacheCounters.htmlHits++;
        return {
            htmlSha256,
            retainable: cached.retainable,
            readerAuthors: cached.readerAuthors ? structuredClone(cached.readerAuthors) : null
        };
    }
    authorCacheCounters.htmlMisses++;
    const $ = cheerio.load(html);
    const retainable = !$('*').toArray().some(node => (
        Object.values(node.attribs || {}).some(value => /data\s*:\s*image\/|<svg\b|<canvas\b/iu.test(value))
    ));
    const parsed = retainable ? parseArxivReaderAuthors($) : null;
    setBoundedCacheEntry(htmlAuthorSourceCache, cacheKey, {
        retainable,
        readerAuthors: parsed ? structuredClone(parsed) : null
    });
    return {
        htmlSha256,
        retainable,
        readerAuthors: parsed ? structuredClone(parsed) : null
    };
}

function canRetainAuthorSourceHtml(html) {
    return inspectHtmlAuthorSource(html).retainable;
}

function retainAuthorSourceHtml(parsed, html) {
    return canRetainAuthorSourceHtml(html) ? { ...parsed, sourceHtml: html } : parsed;
}

/**
 * Extract a sanitized, header-only HTML document containing solely citation metadata, title/thanks,
 * author blocks, and pre-section affiliation notes/tables, stripped of any <svg>/<canvas>/<img>/data:image/.
 * Used so real arXiv HTML pages (whose navbar always includes <svg> icons) still retain replayable author DOM.
 */
function extractAuthorHeaderHtml(html) {
    if (typeof html !== 'string' || !html || Buffer.byteLength(html, 'utf8') > MAX_AUTHOR_SOURCE_HTML_BYTES * 4) {
        return '';
    }
    const $ = cheerio.load(html);
    const metaNodes = $('meta[name="citation_author"], meta[name="citation_author_institution"]')
        .toArray()
        .map(node => {
            const clone = $(node).clone();
            for (const [attr, val] of Object.entries(clone[0]?.attribs || {})) {
                if (/data\s*:\s*image\/|<svg\b|<canvas\b/iu.test(String(val || ''))) {
                    clone.removeAttr(attr);
                }
            }
            const htmlOut = $.html(clone);
            return /data\s*:\s*image\/|<svg\b|<canvas\b/iu.test(htmlOut) ? '' : htmlOut;
        })
        .filter(Boolean);
    const bodyParts = [];
    const seen = new Set();
    const addCleanClone = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        const clone = $(node).clone();
        clone.find('svg, canvas, img, iframe, script, style, object, embed').remove();
        clone.find('*').each((_, el) => {
            for (const [attr, val] of Object.entries(el.attribs || {})) {
                if (/data\s*:\s*image\/|<svg\b|<canvas\b/iu.test(String(val || ''))) {
                    $(el).removeAttr(attr);
                }
            }
        });
        bodyParts.push($.html(clone));
    };
    $('.ltx_title_document').first().toArray().forEach(addCleanClone);
    $('.ltx_authors').first().toArray().forEach(addCleanClone);
    $('.ltx_note.ltx_role_affiliation, .ltx_note.ltx_role_thanks, .ltx_role_address').toArray().forEach(node => {
        if ($(node).closest('.ltx_bibliography, .bibtex, .ltx_figure, .ltx_table').length === 0
            && !$(node).closest('.ltx_authors, .ltx_title_document').length) {
            addCleanClone(node);
        }
    });
    // Include pre-section author tables if present
    let reachedSection = false;
    $('table, section, .ltx_section').each((_, node) => {
        if ($(node).is('section, .ltx_section')) reachedSection = true;
        else if (!reachedSection && !$(node).parents('table, .ltx_figure, .ltx_table, .ltx_authors').length) {
            addCleanClone(node);
        }
    });
    if (!metaNodes.length && !bodyParts.length) return '';
    const slice = `<html><head>${metaNodes.join('')}</head><body>${bodyParts.join('\n')}</body></html>`;
    return canRetainAuthorSourceHtml(slice) ? slice : '';
}

function retainAuthorSourceHeaderHtml(parsed, html) {
    if (canRetainAuthorSourceHtml(html)) {
        return { ...parsed, sourceHtml: html };
    }
    const headerHtml = extractAuthorHeaderHtml(html);
    return headerHtml ? { ...parsed, sourceHeaderHtml: headerHtml } : parsed;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function replayHtmlReaderAuthors(details) {
    const artifacts = details?.structuredArtifacts;
    if (details?.source !== 'html' || typeof details.text !== 'string'
        || !artifacts || typeof artifacts !== 'object') return null;
    const { payloadSha256, ...body } = artifacts;
    if (sha256(details.text) !== artifacts.flattenedTextSha256
        || ![sha256(JSON.stringify(body)), sha256(JSON.stringify(canonical(body)))].includes(payloadSha256)) return null;
    const fullHtml = details?.readerAuthors?.sourceHtml;
    if (typeof fullHtml === 'string' && fullHtml) {
        const inspected = inspectHtmlAuthorSource(fullHtml);
        if (inspected.retainable && inspected.htmlSha256 === artifacts.sourceHtmlSha256) {
            return inspected.readerAuthors;
        }
        return null;
    }
    const headerHtml = details?.readerAuthors?.sourceHeaderHtml;
    if (typeof headerHtml === 'string' && headerHtml && recoverySha256(artifacts.authorHeaderHtmlSha256)) {
        const inspected = inspectHtmlAuthorSource(headerHtml);
        if (inspected.retainable && inspected.htmlSha256 === artifacts.authorHeaderHtmlSha256) {
            return inspected.readerAuthors;
        }
        return null;
    }
    return null;
}

function verifiedReaderAuthorDetails(details, { conferencePdfAuthorParserVersion = 1 } = {}) {
    if (![1,2].includes(conferencePdfAuthorParserVersion)) throw new Error('Unknown conference author parser version');
    let readerAuthors = details?.source === 'conference_pdf_text'
        ? (conferencePdfAuthorParserVersion===2?parseConferencePdfAuthorsV2(details.text):parseConferencePdfAuthors(details.text)) : replayHtmlReaderAuthors(details);
    if (details?.source === 'html' || details?.source === 'pdf') {
        // Authenticate the unchanged four-file bundle before inspecting its derived/PDF-page1 author proof.
        // Plain JSON and caller-supplied details never acquire this source capability.
        const bundleAuthors = require('./fresh-analysis-context.js').readVerifiedBundleReaderAuthors(details);
        if (!readerAuthors && bundleAuthors
            && (details.source !== 'pdf' || PDF_PAGE1_AUTHOR_CONTRACTS.has(bundleAuthors.contract))) {
            readerAuthors = bundleAuthors;
            if (details.source === 'html' && !details.readerAuthors?.sourceHtml && !details.readerAuthors?.sourceHeaderHtml
                && !PDF_PAGE1_AUTHOR_CONTRACTS.has(readerAuthors.contract)) {
                const preamble = String(details.text || '').split(/\nAbstract\n/i)[0];
                const lines = preamble.split(/\r?\n/);
                const names = readerAuthors.authors || [];
                if (names.every(author => lines.some(line => normalizeReaderIdentityText(line)
                    === normalizeReaderIdentityText(author.name)))) {
                    readerAuthors = { ...readerAuthors, authors: rejectUnboundTrailingAffiliationGroup(names,
                        lines.filter(line => /^\s*(?:Affiliation|Institution)\s*[:：]/i.test(line))) };
                }
            }
        } else if (readerAuthors && bundleAuthors?.pdfPage1Authors
            && validatePdfPage1AuthorEvidence(bundleAuthors.pdfPage1Authors)) {
            readerAuthors = { ...readerAuthors, pdfPage1Authors: bundleAuthors.pdfPage1Authors };
        }
    }
    return { ...details, readerAuthors: readerAuthors || null };
}

function resolveVerifiedReaderAuthors(paper, details, options = {}) {
    const savedVersion=paper?.apiReaderAuthors?.identity?.conferencePdfAuthorParser;
    if(savedVersion!==undefined&&savedVersion!==CONFERENCE_PDF_AUTHOR_LINES_V2)throw new Error('Unknown saved conference author parser');
    const version=options.conferencePdfAuthorParserVersion ?? (savedVersion===CONFERENCE_PDF_AUTHOR_LINES_V2?2:1);
    const resolved=resolveApiReaderAuthors(paper,verifiedReaderAuthorDetails(details,{conferencePdfAuthorParserVersion:version}));
    if(details?.source==='conference_pdf_text'&&version===2) {
        resolved.identity.conferencePdfAuthorParser=CONFERENCE_PDF_AUTHOR_LINES_V2;
        resolved.identitySha256=stableFingerprint(resolved.identity);
    }
    return resolved;
}

const EXPLICIT_UNAVAILABLE_AFFILIATIONS = new Set([
    READER_AFFILIATION_UNBOUND,
    '机构信息未在 arXiv HTML 中可靠披露',
    '机构信息未能从 arXiv PDF 文本可靠映射',
    '机构信息未能从会议 PDF 纯文本可靠映射',
    '机构信息未在会议 PDF 中可靠披露',
    '机构信息未可靠披露'
]);

function readerAuthorUnavailableIdentityMatches(paper, { sourceSha256, metadataAuthors } = {}) {
    const saved = paper?.apiReaderAuthors;
    const identity = saved?.identity;
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
    if (!recoverySha256(sourceSha256) || paper?.sourceSha256 !== sourceSha256
        || paper?.analysisManifest?.sourceAcquisition?.sourceSha256 !== sourceSha256
        || !Array.isArray(metadataAuthors) || !metadataAuthors.length
        || metadataAuthors.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim())
        || JSON.stringify(paper.authors) !== JSON.stringify(metadataAuthors)
        || !identityFormat.hasIdentity(identity, 'authors')
        || identity.sourceTextSha256 !== sourceSha256
        || identity.metadataSha256 !== stableFingerprint(metadataAuthors)
        || saved.identitySha256 !== stableFingerprint(identity)
        || stage?.readerAuthorIdentitySha256 !== saved.identitySha256
        || stage.readerAuthorsSha256 !== stableFingerprint(saved)
        || !Array.isArray(saved.authors) || saved.authors.length !== metadataAuthors.length
        || !Array.isArray(identity.authors) || identity.authors.length !== metadataAuthors.length) return false;
    const displayNames = metadataAuthors.map(normalizeReaderMetadataDisplayName);
    return saved.authors.every((author, index) => {
        const bound = identity.authors[index];
        return author?.name === displayNames[index] && bound?.name === displayNames[index]
            && JSON.stringify(author.affiliations) === JSON.stringify(bound.affiliations)
            && bound.nameBinding?.sourceKind === 'paper_metadata'
            && bound.nameBinding.sourceValue === displayNames[index]
            && bound.nameBinding.metadataSha256 === identity.metadataSha256
            && Array.isArray(author.affiliations) && author.affiliations.length > 0
            && Array.isArray(bound.affiliationBindings) && bound.affiliationBindings.length === author.affiliations.length
            && author.affiliations.every((value, offset) => typeof value === 'string' && EXPLICIT_UNAVAILABLE_AFFILIATIONS.has(value)
                && bound.affiliationBindings[offset]?.sourceKind === 'explicit_unavailable'
                && bound.affiliationBindings[offset].sourceValue === value
                && bound.affiliationBindings[offset].sourceTextSha256 === sourceSha256);
    });
}

function serializeMetadataAuthorsForKey(authors) {
    if (!Array.isArray(authors)) return { isArray: false, type: typeof authors, value: authors ?? null };
    return {
        isArray: true,
        items: authors.map(item => (
            item && typeof item === 'object'
                ? { type: 'object', value: item }
                : { type: typeof item, value: item ?? null }
        ))
    };
}

function readerAuthorIdentityMatchesSource(paper, details) {
    if (!paper?.apiReaderAuthors) return false;
    if (!identityFormat.hasIdentity(paper.apiReaderAuthors.identity, 'authors')) return false;
    if (typeof details?.text !== 'string') return false;
    const sourceTextSha256 = sha256(details.text);
    if (sourceTextSha256 !== paper.sourceSha256
        || paper.analysisManifest?.sourceAcquisition?.sourceSha256 !== paper.sourceSha256) return false;
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    const artifacts = details.structuredArtifacts;
    if (stage?.structuredArtifactsSha256 !== artifacts?.payloadSha256
        || (paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256
            && paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 !== artifacts?.payloadSha256)) return false;
    const savedVersion = paper?.apiReaderAuthors?.identity?.conferencePdfAuthorParser;
    if (savedVersion !== undefined && savedVersion !== CONFERENCE_PDF_AUTHOR_LINES_V2) {
        throw new Error('Unknown saved conference author parser');
    }
    const version = savedVersion === CONFERENCE_PDF_AUTHOR_LINES_V2 ? 2 : 1;
    // 每次调用仍先重读并校验原始材料（HTML/全文/结构化提取 SHA，或四份封存文件的磁盘 SHA 与权限），
    // 仅对物理校验通过后的纯确定性身份比对做有界只读记忆化，避免多轮重复解析与重复打印同一警告。
    const verifiedDetails = verifiedReaderAuthorDetails(details, { conferencePdfAuthorParserVersion: version });
    const hasDerivedLegacyPdfFallback = !details?.readerAuthors?.pdfPage1Authors
        && !PDF_PAGE1_AUTHOR_CONTRACTS.has(details?.readerAuthors?.contract)
        && Boolean(
            verifiedDetails?.readerAuthors?.pdfPage1Authors
            || PDF_PAGE1_AUTHOR_CONTRACTS.has(verifiedDetails?.readerAuthors?.contract)
        );
    const matchKey = stableFingerprint({
        version,
        arxivId: String(paper?.arxivId || ''),
        source: verifiedDetails?.source ?? null,
        analysisSource: verifiedDetails?.analysisSource ?? null,
        sourceTextSha256,
        verifiedReaderAuthors: verifiedDetails?.readerAuthors ?? null,
        hasDerivedLegacyPdfFallback,
        metadataAuthors: serializeMetadataAuthorsForKey(paper?.authors),
        paperSourceSha256: paper?.sourceSha256 ?? null,
        sourceAcquisitionSha256: paper?.analysisManifest?.sourceAcquisition?.sourceSha256 ?? null,
        savedApiReaderAuthors: paper.apiReaderAuthors,
        stageReaderAuthorIdentitySha256: stage?.readerAuthorIdentitySha256 ?? null,
        stageReaderAuthorsSha256: stage?.readerAuthorsSha256 ?? null
    });
    const cachedMatch = getBoundedCacheEntry(verifiedAuthorMatchCache, matchKey);
    if (cachedMatch !== undefined) {
        authorCacheCounters.verifiedMatchHits++;
        return cachedMatch;
    }
    authorCacheCounters.verifiedMatchMisses++;
    const saved = paper.apiReaderAuthors;
    const resolveExpectedFor = candidateDetails => {
        const expected = resolveApiReaderAuthors(paper, candidateDetails);
        if (details?.source === 'conference_pdf_text' && version === 2) {
            expected.identity.conferencePdfAuthorParser = CONFERENCE_PDF_AUTHOR_LINES_V2;
            expected.identitySha256 = stableFingerprint(expected.identity);
        }
        expected.identity = identityFormat.inSavedHeaderDomain(expected.identity, saved.identity, 'authors');
        expected.identitySha256 = stableFingerprint(expected.identity);
        return expected;
    };
    const expected = resolveExpectedFor(verifiedDetails);
    let matched = false;
    if (saved.identitySha256 === stableFingerprint(saved.identity)
        && stage?.readerAuthorIdentitySha256 === saved.identitySha256
        && stage.readerAuthorsSha256 === stableFingerprint(saved)) {
        // 旧明确不可得提示语可以不同，但姓名全集、逐项绑定及封存 SHA 必须闭合。
        matched = stableFingerprint(saved) === stableFingerprint(expected)
            || (saved.identity?.metadataSha256 === expected.identity.metadataSha256
                && readerAuthorUnavailableIdentityMatches(paper, {
                    sourceSha256: paper.sourceSha256, metadataAuthors: paper.authors
                }));
        if (!matched && (details?.source === 'html' || details?.source === 'pdf')
            && details?.readerAuthors?.contract !== PDF_PAGE1_AUTHOR_CONTRACT_V2
            && details?.readerAuthors?.pdfPage1Authors?.contract !== PDF_PAGE1_AUTHOR_CONTRACT_V2) {
            // 兼容旧封存批次（含 2026-11-20 与 2026-11-17 历史已发布记录）：
            // 允许只读重放旧 v1 PDF 首页证据以及旧版保留城市尾的 HTML/PDF 绑定；
            // 新写入的 v2 批次不进入此历史回放路径。
            const v1BundleAuthors = require('./fresh-analysis-context.js').readVerifiedBundleReaderAuthors(details, {
                pdfContract: PDF_PAGE1_AUTHOR_CONTRACT_V1
            });
            const tryCandidate = (candidateDetails, preserveLegacyLocations = false) => {
                const exec = () => {
                    const candidateExpected = resolveExpectedFor(candidateDetails);
                    return stableFingerprint(saved) === stableFingerprint(candidateExpected);
                };
                return preserveLegacyLocations ? withLegacyPureLocationPreservation(exec) : exec();
            };
            const legacyHtmlDetails = withLegacyPureLocationPreservation(() => (
                details?.source === 'html'
                    ? verifiedReaderAuthorDetails(details, { conferencePdfAuthorParserVersion: version })
                    : verifiedDetails
            ));
            if (v1BundleAuthors) {
                const buildV1Details = baseDetails => {
                    const v1ReaderAuthors = PDF_PAGE1_AUTHOR_CONTRACTS.has(v1BundleAuthors.contract)
                        ? v1BundleAuthors
                        : (v1BundleAuthors.pdfPage1Authors
                            ? (baseDetails.readerAuthors
                                ? { ...baseDetails.readerAuthors, pdfPage1Authors: v1BundleAuthors.pdfPage1Authors }
                                : v1BundleAuthors)
                            : (baseDetails.readerAuthors || v1BundleAuthors));
                    return { ...baseDetails, readerAuthors: v1ReaderAuthors };
                };
                matched = tryCandidate(buildV1Details(verifiedDetails), false)
                    || tryCandidate(buildV1Details(legacyHtmlDetails), true);
            }
            if (!matched) {
                const stripPdfPage1 = baseDetails => {
                    if (!baseDetails.readerAuthors || PDF_PAGE1_AUTHOR_CONTRACTS.has(baseDetails.readerAuthors.contract)) {
                        return { ...baseDetails, readerAuthors: null };
                    }
                    const clone = { ...baseDetails.readerAuthors };
                    delete clone.pdfPage1Authors;
                    return { ...baseDetails, readerAuthors: clone };
                };
                matched = (hasDerivedLegacyPdfFallback && tryCandidate(stripPdfPage1(verifiedDetails), false))
                    || tryCandidate(stripPdfPage1(legacyHtmlDetails), true);
            }
        }
    }
    return setBoundedCacheEntry(verifiedAuthorMatchCache, matchKey, matched);
}

module.exports = {
    normalizeReaderIdentityText, readerIdentityKey, readerIdentityTokens,
    canonicalAuthorFoldKey, alignAuthorNames1to1,
    sanitizeReaderAffiliationValue, isReaderResourceAffiliationLabel, parseArxivReaderAuthors,
    resolveApiReaderAuthors, bindApiReaderAuthorIdentity, parseConferencePdfAuthors, parseConferencePdfAuthorsV2, CONFERENCE_PDF_AUTHOR_LINES_V2,
    verifiedReaderAuthorDetails, resolveVerifiedReaderAuthors, readerAuthorIdentityMatchesSource, readerAuthorUnavailableIdentityMatches,
    MAX_AUTHOR_SOURCE_HTML_BYTES, AUTHOR_VERIFICATION_CACHE_MAX_ENTRIES,
    PDF_PAGE1_AUTHOR_CONTRACT, PDF_PAGE1_AUTHOR_CONTRACT_V1, PDF_PAGE1_AUTHOR_CONTRACT_V2, PDF_PAGE1_AUTHOR_CONTRACTS,
    METADATA_AUTHOR_SEPARATORS,
    clearReaderAuthorVerificationCaches, getReaderAuthorVerificationCacheStats,
    canRetainAuthorSourceHtml, retainAuthorSourceHtml, extractAuthorHeaderHtml, retainAuthorSourceHeaderHtml, replayHtmlReaderAuthors,
    validatePdfPage1AuthorEvidence, extractPdfPage1AuthorsSync
};
