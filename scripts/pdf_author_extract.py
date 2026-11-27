#!/usr/bin/env python3
"""从已封存论文 PDF 第 1 页的字体与上标几何结构中确定性提取作者与机构绑定。

仅使用 PyMuPDF 文本 span 坐标、字号与上标标记，不调用外部网络或模型：
- Mode A (markers): 作者名上的上标数字/符号与机构行前导上标标记逐项匹配（支持单栏、多栏及同行多机构）。
- Mode B (thanks): IEEEtran 首页底部脚注中的 "A, B, and C are with ..." 归属句解析。
- Mode C (single_institution): 无机构区分标记且正文之前仅披露单一明确机构时，统一绑定全部作者；
  若检测到多个未标记机构并列，拒绝猜测并返回 None。
- Mode D (column_blocks): IEEEtran 多列作者卡片（每列内作者紧接其所属机构）。

所有输出均绑定源 PDF 的 SHA-256 与第 1 页原文引文 SHA-256，供后续来源重放核验。
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import heapq
import json
import math
import os
import re
import stat
import sys
import threading
import unicodedata
from pathlib import Path

import fitz

from runtime_guard import require_external_runtime

CONTRACT_V1 = "pdf-page1-author-evidence-v1"
CONTRACT_V2 = "pdf-page1-author-evidence-v2"
CONTRACT_V3 = "pdf-page1-author-evidence-v3"
CONTRACT = CONTRACT_V2
_GEOMETRIC_GUARDS_ENABLED = False
# PyMuPDF (fitz) 全局上下文非线程安全，且 v3 使用模块级守卫开关，多线程并发重放必须串行化。
_PDF_AUTHOR_EXTRACT_LOCK = threading.RLock()
PYMUPDF_LOCK = _PDF_AUTHOR_EXTRACT_LOCK
MAX_PDF_BYTES = 512 * 1024 * 1024

ICON_FONT_RE = re.compile(
    r"(?:marvosym|fontawesome|zapfdingbats|dingbats|webdings|wingdings|bbding|academicons|ifsym|wasysym|txsy|msam|msbm)",
    re.IGNORECASE,
)

SYMBOL_MARKER_CHARS = "∗*†‡⋆§¶‖∥#◊♠♣♥♦♭♮♯✉•◦⋄+"
PUA_TO_STAR = {
    "\uf02a": "∗",
    "\uf020": " ",
    "\u2217": "∗",
    "\u2731": "∗",
    "\u2605": "⋆",
    "\ufe0f": "",
    "\x86": "†",
    "\x87": "‡",
}
_NON_WS_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_LATEX_SPACING_ACCENT_MAP = {
    "\u00b4": "\u0301",  # ´ acute (e.g. Ram´ırez -> Ramírez)
    "\u00a8": "\u0308",  # ¨ diaeresis (e.g. R¨as¨anen -> Räsänen)
    "\u02c6": "\u0302",  # ˆ circumflex
    "\u02dc": "\u0303",  # ˜ tilde
    "\u02c7": "\u030c",  # ˇ caron
    "\u02d8": "\u0306",  # ˘ breve
    "\u00af": "\u0304",  # ¯ macron
    "\u02da": "\u030a",  # ˚ ring
    "\u02dd": "\u030b",  # ˝ double acute
}
_LATEX_SPACING_ACCENT_RE = re.compile(
    r"(?:([\u00b4\u00a8\u02c6\u02dc\u02c7\u02d8\u00af\u02da\u02dd])([A-Za-z\u0131\u0237])|(\u02da)\s+([Aa]))"
)
_LATEX_SUFFIX_CEDILLA_SPLIT_RE = re.compile(r"\b([Cc])\u00b8 (?=[a-z])")
_LATEX_SUFFIX_CEDILLA_RE = re.compile(r"([CcSsTt])\u00b8")
_LATEX_PREFIX_CEDILLA_RE = re.compile(r"\u00b8([CcSsTt])")
_LATEX_GRAVE_ACCENT_RE = re.compile(r"(?:(?<=[A-Za-z])\u0060([AEIOUaeiou])|(?<!\u0060)\u0060([aeiou]))")

AFFILIATION_HINT_RE = re.compile(
    r"\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|institut(?:e|ion|o)?|research|school|college|department|dept\.?|departamento|dipartimento|division|"
    r"faculty|laborator(?:y|ies|io)|laboratoires?|labs?|academy|cent(?:re|er|ro)|hospital|clinic|foundation|"
    r"conservatory|conservatoire|[ée]cole|escola|politecnic[oa]|polytechnique|hochschule|"
    r"corp(?:oration)?\.?|company|co\.?,?\s*ltd\.?|inc(?:\.(?![a-z0-9-])|\b)|ltd(?:\.(?![a-z0-9-])|\b)|gmbh|llc|llp|plc|pbc|berhad|sdn\.?\s*bhd\.?|"
    r"(?<=\S\s)(?:b\.v\.|s\.a\.(?:s\.)?|a\.g\.|s\.r\.l\.)(?![a-z0-9-])|"
    r"(?:pvt|pte|pty)\.?\s*ltd(?:\.(?![a-z0-9-])|\b)|technology|technologies|"
    r"t[ée]l[ée]com(?:munications?)?|intelligence|platforms?|vision|systems?|solutions?|engineering|"
    r"sciences?|computing|software|networks?|media|communications?|agi\s+lab|ai\s+lab|ai\s+research|"
    r"fraunhofer|max\s+planck|ubisoft|tether\s+evo|"
    r"tencent|wechat|google|deepmind|meta\s+ai|microsoft|amazon|apple|nvidia|adobe|alibaba|bytedance|"
    r"huawei|baidu|oppo|xiaomi|samsung|sony|ibm|intel|qualcomm|bosch|siemens|kyutai|kaist|inria|"
    r"cnrs|sorbonne|sinica|mit|cmu|uc\s+berkeley|eth\s+zurich|eth\s+zürich|epfl|tsinghua|peking|fudan|sjtu|ustc|cuhk|nus|ntu|snu|"
    r"riken|nict|nii|dfki|idiap|fbk|athena|isir|mila|vector|allen\s+institute|ntt|team)(?=\b|[\s,.;)]|$)",
    re.IGNORECASE,
)

NON_PERSON_AFFILIATION_RE = re.compile(
    r"\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|institut(?:e|ion|o)?|research|school|college|department|dept\.?|departamento|dipartimento|division|"
    r"faculty|laborator(?:y|ies|io)|laboratoires?|labs?|academy|cent(?:re|er|ro)|hospital|clinic|foundation|"
    r"conservatory|conservatoire|[ée]cole|escola|politecnic[oa]|polytechnique|hochschule|"
    r"corp(?:oration)?\.?|company|co\.?,?\s*ltd\.?|inc(?:\.(?![a-z0-9-])|\b)|ltd(?:\.(?![a-z0-9-])|\b)|gmbh|llc|llp|plc|pbc|berhad|sdn\.?\s*bhd\.?|"
    r"(?<=\S\s)(?:b\.v\.|s\.a\.(?:s\.)?|a\.g\.|s\.r\.l\.)(?=\s*(?:[,;)]|$))|"
    r"(?:pvt|pte|pty)\.?\s*ltd(?:\.(?![a-z0-9-])|\b)|technology|technologies|"
    r"t[ée]l[ée]com(?:munications?)?|intelligence|platforms?|vision|systems?|solutions?|engineering|"
    r"sciences?|computing|software|networks?|media|communications?|agi\s+lab|ai\s+lab|ai\s+research|"
    r"fraunhofer|max\s+planck|ubisoft|tether\s+evo|"
    r"tencent|wechat|google|deepmind|meta\s+ai|microsoft|amazon|nvidia|adobe|alibaba|bytedance|"
    r"huawei|baidu|xiaomi|samsung|ibm|intel|qualcomm|siemens|kyutai|kaist|inria|"
    r"cnrs|sorbonne|sinica|mit|cmu|uc\s+berkeley|eth\s+zurich|eth\s+zürich|epfl|tsinghua|peking|fudan|sjtu|ustc|cuhk|nus|ntu|snu|"
    r"riken|nict|nii|dfki|idiap|fbk|isir|vector|allen\s+institute|ntt|team)(?=\b|[\s,.;)]|$)",
    re.IGNORECASE,
)

ACADEMIC_INST_CORE_RE = re.compile(
    r"\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|institut(?:e|ion|o)?|research|school|college|department|dept\.?|departamento|dipartimento|division|"
    r"faculty|laborator(?:y|ies|io)|laboratoires?|labs?|academy|cent(?:re|er|ro)|hospital|clinic|foundation|"
    r"conservatory|conservatoire|[ée]cole|escola|politecnic[oa]|polytechnique|hochschule|fraunhofer|max\s+planck|"
    r"cnrs|inria|kaist|epfl|mit|cmu|riken|nict|dfki|idiap|sorbonne|sinica)\b",
    re.IGNORECASE,
)

SECTION_META_HEADING_RE = re.compile(
    r"^(?:(?:paper\s+)?author(?:\s+(?:roles?|contributions?|affiliations?|information|notes?|biograph(?:y|ies)|details?)|s\b)|"
    r"highlights|overview|title|contents|table\s+of\s+contents|acknowledg(?:e)?ments?|"
    r"declarations?|conflict\s+of\s+interest|ethics\s+statement|data\s+availability|code\s+availability|supplementary\s+material)\b",
    re.IGNORECASE,
)

BARE_DOMAIN_FRAGMENT_RE = re.compile(
    r"^(?:[a-z0-9-]+\.)+(?:com|org|edu|cn|net|io|ai|gov|mil|de|uk|fr|jp|kr|ca|ch|sg|au|nl|eu|ac\.[a-z]{2}|co\.[a-z]{2}|edu\.[a-z]{2})$",
    re.IGNORECASE,
)

UPPERCASE_CORP_SUFFIX_RE = re.compile(r"(?<=\S\s)(?:(?:AG|SE|NV|BV|AB|Oy)\b|K\.K\.(?![A-Za-z0-9-]))")
AUTHOR_UPPERCASE_CORP_SUFFIX_RE = re.compile(r"(?<=\S\s)(?:(?:AG|SE|NV|BV|AB|Oy)\b|K\.K\.(?=\s*(?:[,;)]|$)))")


def _has_affiliation_hint(text: str) -> bool:
    return bool(AFFILIATION_HINT_RE.search(text) or UPPERCASE_CORP_SUFFIX_RE.search(text))


NON_AUTHOR_RESOURCE_RE = re.compile(
    r"(?:@|https?://|www\.|github\.com|huggingface\.co|gitlab\.com|^\s*\{[^}]+\}\s*@|^\s*e-?mail\s*:|"
    r"\b(?:project\s+page|hugging\s*face|github|modelscope|demo\s+page|code\s+link)\b|"
    r"^(?:code|dataset|datasets|demo|demos|models?|paper|project|weights?|blog|audio\s+samples?)"
    r"(?:(?:\s*[·•|/]\s*|\s+)(?:code|dataset|datasets|demo|demos|models?|paper|project|weights?|blog|audio|samples?))+\b)",
    re.IGNORECASE,
)

RESOURCE_LABEL_ONLY_RE = re.compile(
    r"^(?:project(?:\s+(?:page|website|webpage|url|link|site))?|"
    r"(?:code|source\s+code|demo|demos|dataset|datasets|data|model|models|model\s+card|weights|"
    r"checkpoint|checkpoints|evaluation|benchmark|benchmarks|paper|blog|arxiv|license|samples|"
    r"audio\s+samples|hugging\s*face|github|gitlab|modelscope|home|homepage|website|webpage|"
    r"repository|repo|abstract|introduction|keywords?|index\s+terms)"
    r"(?:\s+(?:page|website|url|link|repo|repository))?|"
    r"e-?mail|emails?|contact|correspondence|address)\s*[:：]?\s*$",
    re.IGNORECASE,
)

UNANCHORED_ROLE_SENTENCE_RE = re.compile(
    r"\b(?:contributed\s+equally|"
    r"is\s+(?:the\s+)?corresponding\s+author|are\s+(?:the\s+)?corresponding\s+authors?|"
    r"correspondence\s+should\s+be\s+addressed|author\s+to\s+whom\s+correspondence|"
    r"work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:during|while|at|as))\b",
    re.IGNORECASE,
)

CREDIT_STRONG_RE = re.compile(
    r"\b(?:software\s+design|conceptualization|formal\s+analysis|data\s+curation|"
    r"writing\s*[-–—]\s*original(?:\s+draft)?|writing\s*[-–—]\s*review(?:\s+and\s+editing)?|"
    r"project\s+administration|funding\s+acquisition|manuscript\s+review\s+and\s+editing)\b",
    re.IGNORECASE,
)
CREDIT_GENERIC_TERM_RE = re.compile(
    r"\b(?:conceptualization|methodology|formal\s+analysis|investigation|data\s+curation|"
    r"visualization|funding\s+acquisition|project\s+administration|supervision|validation|"
    r"resources|documentation|software\s+design|writing\s*[-–—]\s*original|writing\s*[-–—]\s*review)\b",
    re.IGNORECASE,
)


def _is_credit_contribution(text: str) -> bool:
    s = _clean_ws(text)
    if not s:
        return False
    if CREDIT_STRONG_RE.search(s):
        return True
    terms = {re.sub(r"\s+", " ", m.group(0).lower()) for m in CREDIT_GENERIC_TERM_RE.finditer(s)}
    if len(terms) >= 2:
        return True
    if len(terms) == 1 and ":" in s and not _has_affiliation_hint(s):
        prefix = s.split(":", 1)[0].strip()
        if 2 <= len(prefix) <= 60 and not _has_affiliation_hint(prefix):
            return True
    return False


NON_PERSON_ORG_TOKEN_CS_RE = re.compile(
    r"\b(?:ML|NLP|LLM|ASR|TTS|Group|Tech|Studio|Studios|Robotics|Dynamics|Ventures|Digital|Interactive|Telecom|Mobile|Health|Healthcare|Medical|Pharma|Therapeutics|Diagnostics|Biosciences|Genomics)\b|"
    r"\b(?:Scale|Meta|Mistral|Stability|Character|Perplexity|Together|Assembly|Inflection|Cohere|Runway|Suno|Hume|"
    r"Cartesia|Sesame|Google|Apple|Microsoft|Amazon|NVIDIA|Samsung|Sony|Huawei|Tencent|Alibaba|ByteDance|Baidu|"
    r"Xiaomi|Oppo|SenseTime|Zhipu|Moonshot|StepFun|DeepSeek|MiniMax|ElevenLabs|Adobe|Oracle|Salesforce|IBM|Intel|"
    r"Qualcomm|Bosch|Siemens|Toyota|Honda|Open|Deep|Generative|Applied|Enterprise|Global|National|Shanghai|Beijing)\s+AI\b|"
    r"\b(?:Meta\s+FAIR|(?:Google|Alibaba|Tencent|Huawei|Amazon|AWS|Oracle|IBM|Microsoft|Azure|Baidu|Volcano|ByteDance|Salesforce)\s+Cloud)\b"
)

STREET_ADDRESS_RE = re.compile(
    r"\b(?:Way|Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|Parkway|Drive|Dr\.|Lane|Rue|Straße|Strasse)(?=\b|[\s,.;]|$)",
    re.IGNORECASE,
)


def _is_bare_street_address(body: str) -> bool:
    s = _clean_ws(body)
    m = STREET_ADDRESS_RE.search(s)
    if not m:
        return False
    segments = [seg.strip() for seg in re.split(r"\s*[,;]\s*", s)]
    offset = 0
    street_seg_idx = 0
    for i, seg in enumerate(segments):
        idx = s.find(seg, offset)
        end = idx + len(seg)
        if idx <= m.start() < end:
            street_seg_idx = i
            break
        offset = end
    if street_seg_idx == 0:
        return not bool(ACADEMIC_INST_CORE_RE.search(segments[0]))
    prior = ", ".join(segments[:street_seg_idx])
    if _has_affiliation_hint(prior):
        return False
    prior_key = re.sub(r"[^a-z0-9]", "", prior.lower())
    if prior_key in KNOWN_NON_CITY_ORG_HEADS:
        return False
    return True


PROSE_VERB_RE = re.compile(
    r"\b(?:focuses|focused|rely|relies|relied|achieves?|proposes?|proposed|presents?|presented|"
    r"evaluates?|evaluated|introduces?|introduced|demonstrates?|demonstrated|investigates?|"
    r"explores?|addresses?|considers?|improves?|outperforms?|enables?|allows?|shows?|showed|"
    r"we\s+(?:present|propose|introduce|evaluate|study|investigate|show|find|observe|develop))\b",
    re.IGNORECASE,
)

KNOWN_NON_CITY_ORG_HEADS = frozenset({
    "openai", "anthropic", "google", "deepmind", "meta", "fair", "apple", "amazon", "microsoft",
    "tencent", "alibaba", "bytedance", "huawei", "baidu", "nvidia", "adobe", "sony", "mistral",
    "cohere", "zyphra", "kyutai", "suno", "udio", "stability", "runway", "databricks", "snowflake",
    "palantir", "stripe", "uber", "airbnb", "netflix", "spotify", "zoom", "cisco", "oracle",
    "salesforce", "qualcomm", "intel", "siemens", "bosch", "samsung", "toyota", "honda", "panasonic",
    "toshiba", "hitachi", "fujitsu", "nec", "ntt", "naver", "kakao", "coupang", "grab", "shopee",
    "tiktok", "xiaomi", "oppo", "vivo", "lenovo", "sensetime", "megvii", "zhipu", "moonshot",
    "stepfun", "baichuan", "deepseek", "qwen", "minimax", "elevenlabs", "xai", "iflytek", "kaist",
    "inria", "cnrs", "epfl", "riken", "nict", "dfki", "idiap", "mila", "cartesia",
})

SURNAME_COLLIDING_ORG_HEADS = frozenset({
    "honda", "fair", "bosch", "apple", "sony", "oracle", "stripe", "grab", "zoom",
    "runway", "stability", "vivo", "oppo", "suno", "udio", "mila",
})
ORG_HEAD_LOCATION_COLLIDING = SURNAME_COLLIDING_ORG_HEADS | frozenset({"athena", "mila"})
KNOWN_NON_PERSON_ORG_TOKENS = KNOWN_NON_CITY_ORG_HEADS - SURNAME_COLLIDING_ORG_HEADS

EXEMPT_UPPER_CITIES = frozenset({"DC", "LA", "NY", "SF", "UK", "US"})

MULTI_WORD_LOCATION_PHRASE_RE = re.compile(
    r"^(?:United\s+States(?:\s+of\s+America)?|United\s+Kingdom|South\s+Korea|North\s+Korea|"
    r"Republic\s+of\s+Korea|Hong\s+Kong|New\s+Zealand|Czech\s+Republic|New\s+York|San\s+Francisco|"
    r"Los\s+Angeles|Palo\s+Alto|Menlo\s+Park|Redwood\s+City|Ann\s+Arbor|Mountain\s+View|"
    r"Santa\s+Clara|Santa\s+Barbara|Santa\s+Cruz|Chapel\s+Hill|College\s+Park|"
    r"San\s+Diego|San\s+Jose|Las\s+Vegas|North\s+Carolina|South\s+Carolina|New\s+Jersey|"
    r"New\s+Mexico|West\s+Virginia|North\s+Dakota|South\s+Dakota|Rhode\s+Island|New\s+Hampshire|"
    r"District\s+of\s+Columbia|British\s+Columbia|Nova\s+Scotia|New\s+South\s+Wales|"
    r"Costa\s+Rica|Saudi\s+Arabia|South\s+Africa|United\s+Arab\s+Emirates|Sri\s+Lanka|Puerto\s+Rico)$",
    re.IGNORECASE,
)

FOOTNOTE_ROLE_RE = re.compile(
    r"^(?:(?:denotes?|indicates?|signifies|represents?)\s+)?(?:the\s+)?"
    r"(?:equal\s+contribution|contributed\s+equally|authors?\s+contributed\s+equally|"
    r"joint\s+first\s+authors?|co-?first\s+authors?|equal\s+advising|equal\s+supervision|equal\s+senior|"
    r"corresponding\s+authors?|author\s+to\s+whom\s+correspondence\s+should\s+be\s+addressed|"
    r"correspondence\s+(?:to|should\s+be\s+addressed)|correspondence\s*[:：]?$|corresponding\s+to|thanks\s*[:：]|"
    r"project\s+lead|team\s+lead|core\s+contributors?|"
    r"work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:during|while|at|as)|intern(?:ship)?\s+at|now\s+at|"
    r"preprint|under\s+review|accepted\s+(?:at|to|by)|published\s+(?:at|in)|to\s+appear\s+in|"
    r"(?:this\s+)?work\s+(?:was\s+)?(?:funded|supported)\s+by|(?:funded|supported)\s+by|"
    r"alphabetical\s+order|author\s+order\s+is\s+random|order\s+is\s+random|"
    r"acknowledg|email|e-?mail|contact(?:\s*[:：]|\b)|project\s+page|code\s+available|demo\s+page)",
    re.IGNORECASE,
)

VENUE_OR_STATUS_RE = re.compile(
    r"^(?:(?:accepted\s+(?:at|to|by)|published\s+(?:at|in)|to\s+appear\s+in|proceedings\s+of|in\s+proceedings|"
    r"under\s+review|technical\s+report|working\s+paper|preprint|draft|camera[- ]ready|arXiv|"
    r"figure\s+\d|table\s+\d|abstract|appendix)\b|"
    r"(?:ICASSP|INTERSPEECH|NeurIPS|NIPS|ICML|ICLR|CVPR|ICCV|ECCV|ACL|EMNLP|NAACL|AAAI|IJCAI|SIGIR|"
    r"KDD|WWW|ACM\s+MM|IEEE|SLT|ASRU|WASPAA|ISMIR|DCASE|EUSIPCO|BMVC|WACV|SIGGRAPH|CHI|UIST|"
    r"OSDI|SOSP|NSDI|CCS|S&P|NDSS)\b.*(?:19|20)\d{2}\b)",
    re.IGNORECASE,
)

IEEE_MEMBER_RE = re.compile(
    r",?\s*\b(?:Life\s+)?(?:Student\s+|Graduate\s+Student\s+|Senior\s+|Associate\s+)?(?:Member|Fellow)\s*,\s*IEEE\b",
    re.IGNORECASE,
)

IEEE_MEMBER_ONLY_RE = re.compile(
    r"^(?:(?:Life\s+)?(?:(?:Graduate\s+)?Student\s+|Senior\s+|Associate\s+)?(?:Member|Fellow)\s*,\s*IEEE\.?)"
    r"(?:(?:[\s,;]+|,\s*and\s+|\s+and\s+)(?:(?:Life\s+)?(?:(?:Graduate\s+)?Student\s+|Senior\s+|Associate\s+)?(?:Member|Fellow)\s*,\s*IEEE\.?))*$",
    re.IGNORECASE,
)

ABSTRACT_START_RE = re.compile(
    r"^(?:a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|summary|i\.\s*introduction|1\.?\s+introduction)\b",
    re.IGNORECASE,
)

DATE_LINE_RE = re.compile(
    r"^(?:(?:January|February|March|April|May|June|July|August|September|October|November|December|"
    r"Jan\.?|Feb\.?|Mar\.?|Apr\.?|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?)\s+\d{1,2},?\s+\d{4}|"
    r"\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}|"
    r"Preprint\.?.*)$",
    re.IGNORECASE,
)

EMAIL_OR_URL_LINE_RE = re.compile(
    r"(?:@|https?://|www\.|github\.com|huggingface\.co|gitlab\.com|^\s*\{[^}]+\}\s*@|^\s*e-?mail\s*:)",
    re.IGNORECASE,
)

_LOC_SEG_PAT = r"[A-ZÀ-ÖØ-ÞĀ-ŽḀ-ỿ][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ0-9'’.-]+(?:\s+(?:of\s+)?[A-ZÀ-ÖØ-ÞĀ-ŽḀ-ỿ][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ0-9'’.-]+){0,3}"
LOCATION_ONLY_RE = re.compile(
    rf"^{_LOC_SEG_PAT}\s*,\s*(?:(?:\d{{4,6}}(?:-\d{{4}})?|{_LOC_SEG_PAT}(?:\s+\d{{4,6}})?)\s*,\s*)?{_LOC_SEG_PAT}(?:\s+\d{{4,6}})?$"
)

KNOWN_LOCATION_TAIL_FULL_RE = re.compile(
    r"^(?:United\s+States(?:\s+of\s+America)?|United\s+Kingdom|United\s+Arab\s+Emirates|UAE|"
    r"China|P\.?\s*R\.?\s*China|France|Germany|Japan|Korea|South\s+Korea|Republic\s+of\s+Korea|"
    r"Canada|Switzerland|Singapore|Australia|India|Italy|Spain|(?:The\s+)?Netherlands|Sweden|Norway|Finland|"
    r"Denmark|Belgium|Austria|Poland|Israel|Taiwan|R\.?\s*O\.?\s*C\.?|Hong\s+Kong|Macau|Brazil|Mexico|Turkey|Türkiye|"
    r"Greece|Ireland|Portugal|Czech\s+Republic|New\s+Zealand|Russia|Vietnam|Thailand|Malaysia|"
    r"El\s+Salvador|Nepal|Bangladesh|Uzbekistan|Saudi\s+Arabia|Egypt|Iran|Pakistan|Indonesia|"
    r"Philippines|Argentina|Chile|Colombia|Peru|South\s+Africa|Nigeria|Kenya|Cameroon|Hungary|Romania|"
    r"Bulgaria|Croatia|Serbia|Slovakia|Slovenia|Ukraine|Lithuania|Latvia|Estonia|Iceland|"
    r"Luxembourg|Malta|Cyprus|Qatar|Kuwait|Oman|Jordan|Lebanon|Morocco|Tunisia|Kazakhstan|"
    r"Belarus|Armenia|Azerbaijan|Mongolia|Cambodia|Myanmar|Sri\s+Lanka|"
    r"California|Massachusetts|Washington|Texas|Illinois|Pennsylvania|Michigan|Virginia|Maryland|"
    r"Georgia|Indiana|Colorado|Oregon|Florida|Arizona|Ohio|Minnesota|Connecticut|Wisconsin|"
    r"Missouri|Tennessee|Utah|New\s+York|New\s+Jersey|North\s+Carolina|South\s+Carolina|"
    r"New\s+Mexico|West\s+Virginia|North\s+Dakota|South\s+Dakota|Rhode\s+Island|New\s+Hampshire|"
    r"District\s+of\s+Columbia|Ontario|Quebec|British\s+Columbia|Nova\s+Scotia|Alberta|Manitoba|"
    r"Gujarat|Maharashtra|Karnataka|Tamil\s+Nadu|Telangana|Uttar\s+Pradesh|West\s+Bengal|Kerala|Rajasthan|Punjab|Haryana|Andhra\s+Pradesh|"
    r"England|Scotland|Bavaria)$",
    re.IGNORECASE,
)
KNOWN_LOCATION_CODE_CS_RE = re.compile(
    r"^(?:USA|U\.S\.A\.?|US|U\.S\.?|UK|U\.K\.?|"
    r"CA|NY|MA|WA|TX|PA|IL|NJ|MD|VA|GA|NC|SC|NM|WV|ND|SD|RI|NH|OH|MI|MN|CO|OR|CT|DC|FL|AZ|UT|IN|WI|MO|TN|ON|QC|BC|AB|NS|NSW|VIC)$"
)


def _is_known_location_tail(text: str) -> bool:
    s = text.strip()
    return bool(KNOWN_LOCATION_TAIL_FULL_RE.fullmatch(s) or KNOWN_LOCATION_CODE_CS_RE.fullmatch(s))


_NOBILIARY_PARTICLES = frozenset({
    "de", "da", "di", "del", "della", "der", "den", "van", "von", "la", "le", "du",
    "des", "dos", "das", "al", "el", "ben", "bin", "ibn", "ter", "ten",
})

MIXED_CASE_AI_ORG_LINE_RE = re.compile(r"^[A-Z][a-z][\w.-]*(?:\s+[A-Z][a-z][\w.-]*){0,2}\s+AI$")

NON_PERSON_FIRST_TOKENS = frozenset({
    "this", "the", "our", "all", "these", "those", "both", "each", "some", "many", "most",
    "other", "another", "such", "work", "paper", "code", "dataset", "data", "authors", "author",
    "model", "models", "method", "methods", "system", "systems", "corpus", "benchmark",
    "experiments", "results", "audio", "speech", "music", "video", "figure", "table", "section",
    "appendix", "funding", "grant", "research", "project", "corresponding", "equal", "joint",
    "manuscript",
})
NON_PERSON_ANY_TOKENS = frozenset({
    "and", "dataset", "datasets", "corpus", "corpora", "benchmark", "benchmarks", "authors",
    "paper", "work", "model", "models", "code", "system", "systems", "method", "methods",
    "experiments", "results", "manuscript", "funding", "independent", "researcher",
    "researchers", "speech", "audio", "music", "hearing", "vision", "division", "artificial",
})


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def _normalize_pua(text: str) -> str:
    out = text.encode("utf-8", "replace").decode("utf-8").replace("\u00a0", " ")
    for k, v in PUA_TO_STAR.items():
        out = out.replace(k, v)
    out = _NON_WS_CTRL_RE.sub("", out)
    # Recombine pdflatex suffix cedilla (e.g. "Franc¸ois", "C¸ a˘gdas¸") BEFORE prefix accents
    if "\u00b8" in out:
        out = _LATEX_SUFFIX_CEDILLA_SPLIT_RE.sub(lambda m: unicodedata.normalize("NFC", m.group(1) + "\u0327"), out)
        out = _LATEX_SUFFIX_CEDILLA_RE.sub(lambda m: unicodedata.normalize("NFC", m.group(1) + "\u0327"), out)
        out = _LATEX_PREFIX_CEDILLA_RE.sub(lambda m: unicodedata.normalize("NFC", m.group(1) + "\u0327"), out)
    if "\u0060" in out:
        out = _LATEX_GRAVE_ACCENT_RE.sub(
            lambda m: unicodedata.normalize("NFC", (m.group(1) or m.group(2)) + "\u0300"),
            out,
        )
    if _LATEX_SPACING_ACCENT_RE.search(out):
        def _combine_accent(m: re.Match) -> str:
            acc_ch = m.group(1) or m.group(3)
            base = m.group(2) or m.group(4)
            acc = _LATEX_SPACING_ACCENT_MAP[acc_ch]
            if base == "\u0131":
                base = "i"
            elif base == "\u0237":
                base = "j"
            return unicodedata.normalize("NFC", base + acc)
        out = _LATEX_SPACING_ACCENT_RE.sub(_combine_accent, out)
    return out


def _clean_ws(text: str) -> str:
    return re.sub(r"\s+", " ", _normalize_pua(text)).strip()


def _fold_name_key(name: str) -> str:
    s = unicodedata.normalize("NFKD", _clean_ws(name))
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = s.lower()
    s = re.sub(r"['’`.-]+", " ", s)
    s = re.sub(r"[^\w\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _is_org_head_plus_location(tokens: list[str], lowered: list[str]) -> bool:
    if any(re.fullmatch(r"(?:USA|U\.S\.A\.?|US|U\.S\.?|UK|U\.K\.?)", tok) for tok in tokens):
        return True
    if not any(tok in ORG_HEAD_LOCATION_COLLIDING for tok in lowered):
        return False
    if any(
        lowered[i] not in ORG_HEAD_LOCATION_COLLIDING and _is_known_location_tail(tok)
        for i, tok in enumerate(tokens)
    ):
        return True
    non_org = [tok for i, tok in enumerate(tokens) if lowered[i] not in ORG_HEAD_LOCATION_COLLIDING]
    if len(non_org) >= 2:
        joined = " ".join(non_org)
        if _is_known_location_tail(joined) or MULTI_WORD_LOCATION_PHRASE_RE.fullmatch(joined):
            return True
        for span in range(2, min(4, len(non_org)) + 1):
            for start in range(0, len(non_org) - span + 1):
                sub = " ".join(non_org[start : start + span])
                if _is_known_location_tail(sub) or MULTI_WORD_LOCATION_PHRASE_RE.fullmatch(sub):
                    return True
    return False


def _is_mid_name_nickname(tok: str) -> bool:
    return bool(
        re.fullmatch(
            r'(?:\([A-ZÀ-ÖØ-ÞĀ-Ž][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ\'’.-]{1,20}\)|'
            r'"[A-ZÀ-ÖØ-ÞĀ-Ž][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ\'’.-]{1,20}"|'
            r'“[A-ZÀ-ÖØ-ÞĀ-Ž][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ\'’.-]{1,20}”)',
            tok,
        )
    )


def _is_valid_author_name(text: str) -> bool:
    name = _clean_ws(text)
    if not name or len(name) > 80:
        return False
    if "@" in name or "http" in name.lower() or "www." in name.lower():
        return False
    if (
        NON_PERSON_AFFILIATION_RE.search(name)
        or AUTHOR_UPPERCASE_CORP_SUFFIX_RE.search(name)
        or FOOTNOTE_ROLE_RE.search(name)
        or UNANCHORED_ROLE_SENTENCE_RE.search(name)
        or _is_credit_contribution(name)
        or VENUE_OR_STATUS_RE.match(name)
        or SECTION_META_HEADING_RE.match(name)
    ):
        return False
    if DATE_LINE_RE.match(name) or MULTI_WORD_LOCATION_PHRASE_RE.fullmatch(name):
        return False
    if re.search(r"\d", name):
        return False
    # CJK full name (2-6 chars) before Latin len < 3 check
    if re.fullmatch(r"[\u3400-\u9fff]{2,6}", name):
        return True
    if len(name) < 3:
        return False
    tokens = name.split()
    if len(tokens) < 2 or len(tokens) > 7:
        return False
    lowered = [tok.lower().strip("'’.-") for tok in tokens]
    if NON_PERSON_ORG_TOKEN_CS_RE.search(name):
        return False
    if lowered[0] in NON_PERSON_FIRST_TOKENS:
        return False
    if any(tok in NON_PERSON_ANY_TOKENS or tok in KNOWN_NON_PERSON_ORG_TOKENS for tok in lowered):
        return False
    if _is_org_head_plus_location(tokens, lowered):
        return False
    _lower_surname_stopwords = {
        "a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "of", "on", "or", "the", "to", "with",
    }
    has_cap_particle_lower_surname = (
        len(tokens) >= 3
        and lowered[-2] in _NOBILIARY_PARTICLES
        and tokens[-2][0].isupper()
        and tokens[-1][0].islower()
        and len(lowered[-1]) >= 2
        and lowered[-1] not in _NOBILIARY_PARTICLES
        and lowered[-1] not in _lower_surname_stopwords
    )
    if not tokens[-1][0].isupper() and not has_cap_particle_lower_surname:
        return False
    if not tokens[0][0].isupper() and lowered[0] not in _NOBILIARY_PARTICLES:
        return False
    for idx, tok in enumerate(tokens):
        if 0 < idx < len(tokens) - 1 and _is_mid_name_nickname(tok):
            continue
        if not re.fullmatch(r"[A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ'’.-]*", tok):
            return False
        if "." in tok:
            # Allow personal initials (J., J.R., Ch., Š., Ł., J.-P.) and suffix Jr./Sr.,
            # never country/org abbreviations (U.S.A., U.K., D.C., Inc., Ltd.)
            if tok in {"U.S.", "U.K.", "U.S.A.", "P.R.", "E.U.", "D.C.", "Co.", "St.", "No.", "Dr.", "Mr.", "Ms.", "Inc.", "Ltd."}:
                return False
            dotted_segs = tok.split(".")
            if len(dotted_segs) >= 3 and dotted_segs[-1] == "" and all(len(sg) == 1 and sg.isupper() for sg in dotted_segs[:-1]):
                if len(dotted_segs) - 1 >= 3:
                    return False
            else:
                hyph_parts = tok.split("-")
                if not hyph_parts or not hyph_parts[0].endswith("."):
                    return False
                for hp in hyph_parts:
                    core = hp[:-1] if hp.endswith(".") else hp
                    if not (1 <= len(core) <= 3 and core[0].isupper() and all(ch.islower() for ch in core[1:])):
                        return False
    return True


def _looks_like_prose_sentence(text: str) -> bool:
    s = _clean_ws(text)
    if not s:
        return True
    if ABSTRACT_START_RE.match(s) or SECTION_META_HEADING_RE.match(s):
        return True
    if re.match(r"^[•◦▪▫●○■□▸▹]\s+", s):
        return True
    if re.match(r"^(?:A|An|The)\s+[a-z]", s):
        return True
    if re.search(r"\[\d+(?:\s*[,–-]\s*\d+)*\]", s):
        return True
    if re.search(r"[a-z]-$", s):
        return True
    # Lowercase-leading multi-word body fragment (allow lowercase-start brand CamelCase like xAI/iFLYTEK/pyannoteAI)
    first_tok = s.split()[0]
    if first_tok and first_tok[0].islower() and not re.match(r"^[a-z]{1,10}[A-Z]", first_tok):
        return True
    # Internal sentence boundary (e.g. "[1]. Modern speaker recognition...")
    for m_dot in re.finditer(r"(\b[A-Za-z]+|\])\.\s+[A-Z]", s):
        tok = m_dot.group(1)
        if tok == "]" or (
            len(tok) > 1
            and tok not in {"Co", "Ltd", "Inc", "Corp", "Dept", "Univ", "Lab", "Labs", "Tech", "Inst", "Prof", "Dr", "St", "No", "Mt", "Ft", "al", "vs", "Pvt", "Pte", "Pty", "Sdn", "Bhd", "Eng", "Sci", "Res", "Nat", "Int", "Adv", "Acad", "Med", "Assoc"}
        ):
            return True
    if PROSE_VERB_RE.search(s) or _is_credit_contribution(s):
        return True
    if re.search(r",\s*(?:and|or)\s*$", s, re.IGNORECASE):
        return True
    if re.search(r"\b(?:is|are|was|were)\s+(?:also\s+|now\s+)?(?:with|affiliated\s+with|from)\b", s, re.IGNORECASE):
        return True
    return False


def _is_plausible_unmarked_org_text(text: str) -> bool:
    s = _clean_ws(text)
    if not s or len(s) < 2 or len(s) > 75 or len(s.split()) > 10:
        return False
    if (
        FOOTNOTE_ROLE_RE.match(s)
        or RESOURCE_LABEL_ONLY_RE.match(s)
        or DATE_LINE_RE.match(s)
        or VENUE_OR_STATUS_RE.match(s)
        or SECTION_META_HEADING_RE.match(s)
        or BARE_DOMAIN_FRAGMENT_RE.fullmatch(s)
        or _is_location_only_line(s)
        or MULTI_WORD_LOCATION_PHRASE_RE.fullmatch(s)
        or _is_known_location_tail(s)
        or _looks_like_prose_sentence(s)
    ):
        return False
    if re.search(r"\b(?:19|20)\d{2}\b", s):
        return False
    if re.search(r"^(?:abstract|preprint|draft|appendix)\b", s, re.IGNORECASE):
        return False
    first_tok = s.split()[0]
    starts_org = bool(
        first_tok[0].isupper()
        or re.match(r"^[a-z]{1,10}[A-Z]", first_tok)
        or ("\u3400" <= first_tok[0] <= "\u9fff")
    )
    if not starts_org:
        return False
    return bool(re.fullmatch(r"[\w\u00c0-\u024f\u1e00-\u1eff\u3400-\u9fff&'’.,\s()·•/-]{2,75}", s))


def _is_location_only_line(text: str) -> bool:
    cleaned = _clean_ws(text)
    if not LOCATION_ONLY_RE.match(cleaned):
        return False
    parts = [p.strip() for p in cleaned.split(",")]
    if len(parts) not in (2, 3):
        return False
    left = parts[0]
    right = parts[-1]
    # Rightmost segment MUST be a recognized country/state/region tail (strip optional trailing postal/ZIP code first; rejects "FAIR, Meta")
    right_no_zip = re.sub(r"\s+\d{4,6}$", "", right).strip()
    if not _is_known_location_tail(right_no_zip):
        return False
    if len(parts) == 3:
        mid = parts[1]
        mid_no_zip = re.sub(r"\s+\d{4,6}$", "", mid).strip()
        if not (re.fullmatch(r"\d{4,6}(?:-\d{4})?", mid) or _is_known_location_tail(mid_no_zip)):
            return False
    # Never classify "Anthropic, USA" / "OpenAI, CA" / "Observe.AI, India" / "Armsoftech.air, India" / "Fraunhofer IIS, Germany" as city-only
    if (
        _has_affiliation_hint(left)
        or NON_PERSON_ORG_TOKEN_CS_RE.search(left)
        or MIXED_CASE_AI_ORG_LINE_RE.fullmatch(left)
        or re.search(r"\.(?:ai|io|com|org|net|edu|co|air)\b", left, re.IGNORECASE)
    ):
        return False
    left_key = re.sub(r"[^a-z0-9]", "", left.lower())
    if left_key in KNOWN_NON_CITY_ORG_HEADS:
        return False
    if any(re.sub(r"[^a-z0-9]", "", tok.lower()) in KNOWN_NON_PERSON_ORG_TOKENS for tok in left.split()):
        return False
    if re.search(r"[a-z][A-Z]|[A-Z]{2,}[a-z]", left):
        return False
    if len(left) >= 2 and left.isupper() and left not in EXEMPT_UPPER_CITIES:
        return False
    # Protect non-geographic ALL-CAPS institutional acronyms (e.g. "UNSW Sydney, Australia", "KAIST Daejeon, Korea")
    _geo_acronyms = {"USA", "UAE", "PRC", "ROC", "NSW", "QLD", "VIC", "ACT", "TAS", "SAR"}
    if any(re.fullmatch(r"[A-Z]{3,}", tok.strip("()")) and tok.strip("()") not in _geo_acronyms for tok in left.split()):
        return False
    # Protect famous university shortnames when paired directly with a country (e.g. "Stanford, USA"),
    # while still treating state-qualified city lines (e.g. "Stanford, CA" or "Stanford, CA, USA") as pure locations.
    _univ_shortnames = {"stanford", "caltech", "cornell", "princeton", "harvard", "purdue", "dartmouth", "vanderbilt", "northwestern"}
    if len(parts) == 2 and left_key in _univ_shortnames and len(right_no_zip) > 2 and right_no_zip.lower() not in {"california", "new york", "new jersey", "massachusetts", "indiana", "illinois", "tennessee", "new hampshire"}:
        return False
    # Real city names are 1-2 words (or explicit multi-word locations like "District of Columbia"),
    # never 3+ word organization names like "Earth Species Project, France".
    if len(left.split()) >= 3 and not MULTI_WORD_LOCATION_PHRASE_RE.fullmatch(left):
        return False
    if re.search(r"\b(?:project|initiative|consortium|association|society|alliance|collective|collaborative)\b", left, re.IGNORECASE):
        return False
    return True


def _normalize_marker_token(tok: str) -> str:
    t = _normalize_pua(tok).strip()
    if t in {"*", "∗", "⁎", "✱"}:
        return "∗"
    if t in {"⋆", "★"}:
        return "⋆"
    if t in {"‖", "∥"}:
        return "∥"
    return t


def _parse_marker_string(raw: str) -> list[str]:
    s = _normalize_pua(raw).strip()
    if not s:
        return []
    # Strip surrounding parens/brackets and RevTeX/AIP trailing ')' on markers like "a)" or "a),b)"
    s = re.sub(r"\b([a-z])\)", r"\1", s)
    s = s.strip("()[]")
    # Reject things that look like ordinary words, years, emails, C++, +x/+y/+z diagram axes, or +1/+86 phones
    if (
        "@" in s
        or len(s) > 24
        or re.search(r"[A-Za-z]{3,}", s)
        or "++" in s
        or re.search(r"(?:\+[A-Za-z]|[A-Za-z]\+)", s)
        or re.search(r"\+\d", s)
    ):
        return []
    markers: list[str] = []
    # Split on commas / whitespace / semicolons first
    parts = [p.strip() for p in re.split(r"[\s,;]+", s) if p.strip()]
    for part in parts:
        # Handle glued digits + symbols like "1∗" or "⋆†" or "1,2*"
        for m in re.finditer(r"([1-9]\d?|[a-z]|[" + re.escape(SYMBOL_MARKER_CHARS) + r"])", part):
            tok = _normalize_marker_token(m.group(1))
            if tok and tok not in markers:
                markers.append(tok)
    return markers


def _is_pure_marker_text(raw: str) -> bool:
    s = _normalize_pua(raw).strip()
    if not s or len(s) > 20:
        return False
    # Reject C++ / ++, +x/+y/+z / a+b diagram labels, and +1/+86/1+2 phone or math prefixes
    if "++" in s or re.search(r"(?:\+[a-z]|[a-z]\+)", s) or re.search(r"\+\d", s):
        return False
    # Allow combinations of digits (1-20), single lowercase letters (optionally RevTeX 'a)'), symbol markers, commas, spaces
    if re.fullmatch(r"[\s,;]*(?:(?:[1-9]\d?|[a-z]\)?|[" + re.escape(SYMBOL_MARKER_CHARS) + r"])[\s,;]*)+", s):
        # Single lowercase 'a' or 'i' only if no surrounding words; reject multi-letter words
        if re.search(r"[a-z]{2,}", s):
            return False
        # Reject single digit > 20
        for num in re.findall(r"\d+", s):
            if int(num) > 20:
                return False
        return True
    return False


def _is_likely_author_enumeration(text: str) -> bool:
    cleaned = _clean_ws(text)
    if not cleaned or not re.search(r"(?:,|\band\b|&)", cleaned, re.IGNORECASE):
        return False
    if _has_affiliation_hint(cleaned):
        return False
    parts = [
        re.sub(r"^(?:and|&)\s+", "", p.strip(), flags=re.IGNORECASE).strip()
        for p in re.split(r"\s*,\s*|\s+and\s+|\s*&\s*", cleaned, flags=re.IGNORECASE)
        if p.strip()
    ]
    if len(parts) < 2 or all(MIXED_CASE_AI_ORG_LINE_RE.fullmatch(p) for p in parts):
        return False
    return all(_is_valid_author_name(p) for p in parts)


class _KnownAuthorIndex:
    """Pre-folded O(1) lookup structure eliminating O(K^2) author-name scanning across thanks clauses."""

    __slots__ = ("exact_keys", "initial_last_keys", "multi_token_keys", "max_tokens")
    MAX_MULTI_TOKENS = 8

    def __init__(self, author_names: list[str] | None) -> None:
        self.exact_keys: set[str] = set()
        self.initial_last_keys: set[tuple[str, str]] = set()
        self.multi_token_keys: set[str] = set()
        self.max_tokens: int = 0
        if not author_names:
            return
        for raw_name in author_names:
            pieces = [raw_name]
            if isinstance(raw_name, str) and re.search(r"[,;&]|\band\b", raw_name, re.IGNORECASE):
                for p in re.split(r"\s*[,;]\s*|\s+and\s+|\s*&\s*", raw_name, flags=re.IGNORECASE):
                    cleaned_p = re.sub(r"^(?:and|&)\s+", "", p.strip(), flags=re.IGNORECASE).strip()
                    if not cleaned_p:
                        continue
                    pk = _fold_name_key(cleaned_p)
                    if pk and (len(pk.split()) >= 2 or re.fullmatch(r"[\u3400-\u9fff]{2,6}", cleaned_p)):
                        pieces.append(cleaned_p)
            for name in pieces:
                nk = _fold_name_key(name)
                if not nk:
                    continue
                self.exact_keys.add(nk)
                ntoks = nk.split()
                if 2 <= len(ntoks) <= self.MAX_MULTI_TOKENS:
                    self.multi_token_keys.add(nk)
                    if len(ntoks) > self.max_tokens:
                        self.max_tokens = len(ntoks)
                    self.initial_last_keys.add((ntoks[0][0], ntoks[-1]))


def _count_known_author_names(text: str, author_names: list[str] | _KnownAuthorIndex | None) -> int:
    if not author_names:
        return 0
    if isinstance(author_names, _KnownAuthorIndex):
        if not author_names.multi_token_keys:
            return 0
        words = _fold_name_key(text).split()
        wlen = len(words)
        if wlen < 2:
            return 0
        max_n = min(author_names.max_tokens, wlen)
        matched: set[str] = set()
        multi = author_names.multi_token_keys
        for i in range(wlen - 1):
            phrase = words[i]
            for j in range(i + 1, min(wlen, i + max_n)):
                phrase = phrase + " " + words[j]
                if phrase in multi:
                    matched.add(phrase)
                    if len(matched) >= 2:
                        return 2
        return len(matched)
    haystack = f" {_fold_name_key(text)} "
    seen: set[str] = set()
    hits = 0
    for name in author_names:
        nk = _fold_name_key(name)
        if not nk or nk in seen or len(nk.split()) < 2:
            continue
        seen.add(nk)
        if f" {nk} " in haystack:
            hits += 1
    return hits


_TRAILING_ROLE_CLAUSE_RE = re.compile(
    r"(?:^|(?<![\s,;—–.-])[\s,;—–.-]+)(?:[∗*†‡⋆§¶‖∥+]\s*)?(?:(?:denotes?|indicates?|signifies|represents?)\s+)?(?:the\s+)?(?:"
    r"(?:equal\s+contribution|contributed\s+equally|authors?\s+contributed\s+equally|"
    r"joint\s+first\s+authors?|co-?first\s+authors?|equal\s+advising|equal\s+supervision|"
    r"core\s+contributors?|corresponding\s+authors?)[.;,:\s—–-]*|"
    r"(?:corresponding\s+authors?\s*[:：]|author\s+to\s+whom\s+correspondence\s+should\s+be\s+addressed|"
    r"correspondence(?:\s+(?:to|should\s+be\s+addressed)|\s*[:：])|"
    r"(?:e-?mails?|contact)\s*[:：]|"
    r"work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:while|during|at|as))[^;]*)$",
    re.IGNORECASE,
)

_TRAILING_GLUED_SENTENCE_RE = re.compile(
    r"(\b(?:Ltd|Inc|Corp|Co|Univ|Dept|Lab|Labs|Tech|Inst|St|U\.S\.A|U\.K|U\.S|D\.C|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K)\.)\s+(?:(?:\d{1,2}|[∗*†‡⋆§¶‖∥+]+)\s*)?"
    r"(?:This\s+(?:work|paper|research|study|article|manuscript)|An\s+earlier\s+version|"
    r"A\s+preliminary\s+version|Part\s+of\s+this|The\s+(?:authors?|work|paper|code|dataset|source)|"
    r"Manuscript\s+received|Supported\s+by|Funded\s+by|Digital\s+Object|Copyright|"
    r"Accepted|Preprint|Published|Submitted|Under\s+review|To\s+appear|Received)\b.*$",
    re.IGNORECASE,
)

_PRESERVED_ABBR_DOT_CI_RE = re.compile(
    r"\b(?:Inc|Ltd|Corp|Co|Univ|Dept|Lab|Labs|Tech|Inst|St|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K)\.$",
    re.IGNORECASE,
)
_PRESERVED_ACRONYM_DOT_RE = re.compile(r"(?:[A-Z]\.){2,}$")


def _has_preserved_abbr_dot(text: str) -> bool:
    return bool(_PRESERVED_ABBR_DOT_CI_RE.search(text) or _PRESERVED_ACRONYM_DOT_RE.search(text))


def _matches_initialed_known_author(text: str, author_names: list[str] | _KnownAuthorIndex | None) -> bool:
    if not author_names:
        return False
    tokens = _clean_ws(text).rstrip(",:;").split()
    if len(tokens) < 2 or len(tokens) > 4:
        return False
    if not re.fullmatch(r"[A-Z]\.?|[A-Z]\.[A-Z]\.?", tokens[0]):
        return False
    init = tokens[0][0].lower()
    last_key = _fold_name_key(tokens[-1])
    if not last_key:
        return False
    if isinstance(author_names, _KnownAuthorIndex):
        return (init, last_key) in author_names.initial_last_keys
    for name in author_names:
        ntoks = _fold_name_key(name).split()
        if len(ntoks) >= 2 and ntoks[0][0] == init and ntoks[-1] == last_key:
            return True
    return False


def _strip_dangling_tail_end(s: str, end: int) -> int:
    """Strictly O(n) reverse-scan end cursor stripping trailing delimiters and dangling delimiter/space+dot tails
    (e.g. '; .', ' . . .'). Preserves word-attached abbreviation dots like 'MIT Inc.' and 'MIT.'.
    """
    delims = " \t\r\n,;—–|｜•·-"
    i = end
    while i > 0:
        while i > 0 and s[i - 1] in delims:
            i -= 1
        if i > 0 and s[i - 1] == ".":
            j = i
            while j > 0 and s[j - 1] == ".":
                j -= 1
            if j == 0 or s[j - 1] in delims:
                i = j
                continue
        break
    return i


def _strip_dangling_tail(s: str) -> str:
    return s[:_strip_dangling_tail_end(s, len(s))].strip()


_DOI_TAIL_CHAR_SET = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._;()/:")


def _strip_trailing_doi_in_tail(tail: str) -> str:
    """Strictly O(len(tail)) strip of a trailing bare DOI `10.\\d{4,9}/[-._;()/:A-Za-z0-9]+`."""
    if not tail or tail[-1] not in _DOI_TAIL_CHAR_SET:
        return tail
    run_start = len(tail)
    while run_start > 0 and tail[run_start - 1] in _DOI_TAIL_CHAR_SET:
        run_start -= 1
    run = tail[run_start:]
    idx = run.find("10.")
    while idx >= 0:
        if idx == 0 or not run[idx - 1].isdigit():
            if re.match(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+$", run[idx:]):
                cut = run_start + idx
                while cut > 0 and tail[cut - 1].isspace():
                    cut -= 1
                return tail[:cut]
        idx = run.find("10.", idx + 3)
    return tail


def _strip_trailing_orcid_and_doi_end(s: str, end: int) -> int:
    """Strictly O(n) end-cursor loop stripping trailing ORCIDs, bare DOIs, and dangling delimiters."""
    while end > 0:
        prev_end = end
        end = _strip_dangling_tail_end(s, end)
        win_start = max(0, end - 256)
        tail = s[win_start:end]
        if "-" in tail:
            m_orcid = re.search(
                r"(?:^|(?<![\s,;])[\s,;]+)(?:ORCID(?:\s+iD)?\s*[:：]?\s*)?\d{4}-\d{4}-\d{4}-\d{3}[\dX]\.?\s*$",
                tail,
                flags=re.IGNORECASE,
            )
            if m_orcid:
                end = win_start + m_orcid.start()
                tail = s[win_start:end]
        if "10." in tail:
            stripped_tail = _strip_trailing_doi_in_tail(tail)
            if len(stripped_tail) < len(tail):
                end = win_start + len(stripped_tail)
        end = _strip_dangling_tail_end(s, end)
        if end >= prev_end:
            break
    return end


def _strip_trailing_orcid_and_doi(text: str) -> str:
    m_bar_doi = re.search(r"[|｜]|DOI\s*:", text, flags=re.IGNORECASE)
    if m_bar_doi:
        cut = m_bar_doi.start()
        while cut > 0 and text[cut - 1].isspace():
            cut -= 1
        text = text[:cut]
    return text[:_strip_trailing_orcid_and_doi_end(text, len(text))].strip()


def _has_strong_unmarked_org_signal(text: str) -> bool:
    s = _clean_ws(text)
    if not s:
        return False
    toks = s.split()
    return bool(
        s.isupper()
        or re.search(r"[a-z][A-Z]|[A-Z]{2,}[a-z]", s)
        or re.sub(r"[^a-z0-9]", "", s.lower()) in KNOWN_NON_CITY_ORG_HEADS
        or any(re.sub(r"[^a-z0-9]", "", t.lower()) in KNOWN_NON_CITY_ORG_HEADS for t in toks)
        or NON_PERSON_ORG_TOKEN_CS_RE.search(s)
        or bool(re.match(r"^(?:UC|CSU|SUNY|CUNY|UNC|USC|ETH|EPFL|MIT|CMU|NYU|KAIST|UNSW|RWTH|TUM|LMU|KTH|DTU|NTNU|IIT|IIIT|IISc)\b", s))
        or MIXED_CASE_AI_ORG_LINE_RE.fullmatch(s)
    )


def _sanitize_affiliation(raw: str, author_names: list[str] | _KnownAuthorIndex | None = None) -> str:
    text = _clean_ws(raw)
    # Strip leading affiliation labels & academic title prefixes (e.g. "Associate Professor, Middlebury Institute...")
    text = re.sub(r"^(?:affiliations?|institutions?)\s*[:：]\s*", "", text, flags=re.IGNORECASE)
    m_title_prefix = re.match(
        r"^(?:(?:Assistant|Associate|Full|Adjunct|Visiting|Emeritus|Distinguished|Research)\s+)?Professor\s*,\s*(.+)$",
        text,
        re.IGNORECASE,
    )
    if m_title_prefix and _has_affiliation_hint(m_title_prefix.group(1)):
        text = m_title_prefix.group(1).strip()
    if FOOTNOTE_ROLE_RE.match(text) or DATE_LINE_RE.match(text) or VENUE_OR_STATUS_RE.match(text) or IEEE_MEMBER_ONLY_RE.match(text):
        return ""
    # Strip trailing email/URL/parenthetical email clauses (strictly O(n) guarded & non-nested)
    brace_dom = r"(?:@|[a-z0-9.-]+\.(?:edu|com|org|cn|net|io|ai|gov|de|uk|fr|jp|kr|ca|ch|sg|au|nl|eu|ac\.[a-z]{2}|co\.[a-z]{2}|edu\.[a-z]{2})\b)"
    if "(" in text and ")" in text:
        text = re.sub(
            r" ?\( ?(?:e-?mail|emails?|corresponding\s+author|work\s+(?:was\s+)?(?:done|performed|conducted|carried\s+out|completed)\s+(?:while|during|at|as)|equal\s+contribution|contributed\s+equally)[^()]*\)",
            " ",
            text,
            flags=re.IGNORECASE,
        )
        text = re.sub(r" ?\( ?(?:https?://|www\.)[^()]*\)", " ", text, flags=re.IGNORECASE)
        if "{" in text and "}" in text:
            text = re.sub(r" ?\( ?\{[^}{]+\} ?" + brace_dom + r"[^()]*\)", " ", text, flags=re.IGNORECASE)
        text = re.sub(r"\s+", " ", text).strip()
    if ":" in text or "：" in text:
        text = re.sub(r",?(?: ?[\(\[<] ?| ?)(?:e-?mail|emails?) ?[:：] ?\S+.*$", "", text, flags=re.IGNORECASE)
    if "{" in text:
        if "}" in text:
            text = re.sub(r"(?: ?[\(\[<] ?| ?)\{[^}{]+\} ?" + brace_dom + r"\S*.*$", "", text, flags=re.IGNORECASE)
        text = re.sub(r"(?: ?[\(\[<] ?| ?)\{[^}{]*$", "", text)  # unclosed email brace fragment
    if "@" in text:
        email_stop = ",;()[]:：|｜<>"
        pos = 0
        while True:
            at_idx = text.find("@", pos)
            if at_idx < 0:
                break
            if (
                at_idx > 0
                and not text[at_idx - 1].isspace()
                and text[at_idx - 1] not in email_stop
                and at_idx + 1 < len(text)
                and not text[at_idx + 1].isspace()
                and text[at_idx + 1] not in email_stop
            ):
                cut = at_idx
                while cut > 0 and not text[cut - 1].isspace() and text[cut - 1] not in email_stop:
                    cut -= 1
                pre = cut
                while pre > 0 and text[pre - 1].isspace():
                    pre -= 1
                if pre > 0 and text[pre - 1] in "([<":
                    cut = pre - 1
                while cut > 0 and (text[cut - 1].isspace() or text[cut - 1] in ",;"):
                    cut -= 1
                text = text[:cut]
                break
            pos = at_idx + 1
    if "http" in text.lower() or "www." in text.lower():
        text = re.sub(r",?(?: ?[\(\[<] ?| ?)(?:https?://|www\.)\S+.*$", "", text, flags=re.IGNORECASE)
    # Strip trailing glued funding/venue sentence after Inc./Ltd./B.V./U.S.A. (after stripping parenthetical email/URLs)
    text = _TRAILING_GLUED_SENTENCE_RE.sub(r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    # Strip leftmost '|', '｜', or 'DOI:' once in strictly O(n) time before tail-cursor stripping.
    m_bar_doi = re.search(r"[|｜]|DOI\s*:", text, flags=re.IGNORECASE)
    if m_bar_doi:
        cut = m_bar_doi.start()
        while cut > 0 and text[cut - 1].isspace():
            cut -= 1
        text = text[:cut]
    # Strictly O(n) end-cursor stripping loop for chained ORCID/DOI/role clauses (zero prefix copying).
    end = _strip_trailing_orcid_and_doi_end(text, len(text))
    while end > 0:
        last_semi = text.rfind(";", 0, end)
        win_start = last_semi if (last_semi >= 0 and end - last_semi <= 1024) else max(0, end - 1024)
        tail = text[win_start:end]
        next_tail = _TRAILING_ROLE_CLAUSE_RE.sub("", tail)
        if len(next_tail) >= len(tail):
            break
        end = _strip_trailing_orcid_and_doi_end(text, win_start + len(next_tail))
    # Final trailing cleanup
    text = text[:_strip_trailing_orcid_and_doi_end(text, end)].strip(" ,;|｜•·—–-")
    if text.endswith(".") and not _has_preserved_abbr_dot(text):
        text = text.rstrip(".")
    text = re.sub(r"\s+", " ", text.strip(" ,;|｜•·—–-")).strip()
    if len(text) < 3:
        return ""
    if (
        FOOTNOTE_ROLE_RE.match(text)
        or UNANCHORED_ROLE_SENTENCE_RE.search(text)
        or _is_credit_contribution(text)
        or SECTION_META_HEADING_RE.match(text)
        or BARE_DOMAIN_FRAGMENT_RE.fullmatch(text)
        or re.search(r"\bequal\s+contribution\b", text, re.IGNORECASE)
        or RESOURCE_LABEL_ONLY_RE.match(text)
        or re.match(r"^(?:keywords?|index\s+terms)\s*[:：—–-]", text, re.IGNORECASE)
        or DATE_LINE_RE.match(text)
        or VENUE_OR_STATUS_RE.match(text)
        or IEEE_MEMBER_ONLY_RE.match(text)
        or re.search(r"\b(?:is|are|was|were)\s+(?:also\s+|now\s+)?(?:with|affiliated\s+with|from)\b", text, re.IGNORECASE)
        or re.fullmatch(r"(?:denotes?|indicates?|authors?)", text, re.IGNORECASE)
    ):
        return ""
    if "@" in text or "http://" in text.lower() or "https://" in text.lower() or "www." in text.lower():
        return ""
    if _looks_like_author_fragment := re.sub(r"^(?:and|&)\s+", "", text, flags=re.IGNORECASE):
        if _looks_like_author_fragment != text and _is_valid_author_name(_looks_like_author_fragment):
            return ""
    if _count_known_author_names(text, author_names) >= 2 or _is_likely_author_enumeration(text):
        return ""
    if _matches_initialed_known_author(text, author_names):
        return ""
    if author_names:
        folded = _fold_name_key(text)
        folded_no_conj = _fold_name_key(re.sub(r"^(?:and|&)\s+", "", text, flags=re.IGNORECASE))
        colon_prefix_raw = text.split(":", 1)[0].strip() if ":" in text else ""
        if colon_prefix_raw and _matches_initialed_known_author(colon_prefix_raw, author_names):
            return ""
        colon_prefix = _fold_name_key(colon_prefix_raw) if colon_prefix_raw else ""
        if isinstance(author_names, _KnownAuthorIndex):
            exact = author_names.exact_keys
            if folded in exact or folded_no_conj in exact or (colon_prefix and colon_prefix in exact):
                return ""
        else:
            for name in author_names:
                nk = _fold_name_key(name)
                if folded == nk or folded_no_conj == nk or (colon_prefix and colon_prefix == nk):
                    return ""
    return text


def _is_multi_institution_unmarked_line(text: str, raw_spans: list[dict] | None = None, author_names: list[str] | _KnownAuthorIndex | None = None) -> bool:
    """Detect whether an unmarked affiliation text actually packs >=2 distinct institutions side-by-side."""
    def _chunks_are_multi_inst(chunks: list[str], require_no_trailing_prep: bool = False, allow_side_by_side_loc: bool = False) -> bool:
        cleaned_chunks = []
        hint_count = 0
        for raw_c in chunks:
            sc = _sanitize_affiliation(raw_c, author_names)
            if not sc:
                continue
            if require_no_trailing_prep and re.search(r"\b(?:of|for|and|in|at|the|de|la|du)$", sc, re.IGNORECASE):
                continue
            if _has_affiliation_hint(sc) or (_is_plausible_unmarked_org_text(sc) and _has_strong_unmarked_org_signal(sc)):
                hint_count += 1
                cleaned_chunks.append(sc)
            elif _is_plausible_unmarked_org_text(sc) or (allow_side_by_side_loc and _is_location_only_line(sc)):
                cleaned_chunks.append(sc)
        return hint_count >= 1 and len(cleaned_chunks) >= 2

    # Check wide horizontal gaps between spans on the same line (> 22pt gap between non-empty text chunks)
    if raw_spans and len(raw_spans) >= 2:
        non_empty = [s for s in raw_spans if s["text"].strip()]
        gap_chunks: list[str] = []
        if non_empty:
            cur = [non_empty[0]["text"].strip()]
            prev_x1 = non_empty[0]["bbox"][2]
            for s in non_empty[1:]:
                if s["bbox"][0] - prev_x1 > 22.0:
                    gap_chunks.append(" ".join(cur).strip())
                    cur = [s["text"].strip()]
                else:
                    cur.append(s["text"].strip())
                prev_x1 = max(prev_x1, s["bbox"][2])
            gap_chunks.append(" ".join(cur).strip())
        if len(gap_chunks) >= 2 and _chunks_are_multi_inst(gap_chunks, allow_side_by_side_loc=True):
            return True
    # Also check multiple institutions separated by wide unicode spaces, tabs, double+ spaces,
    # semicolons, or commas after bracketed/bare inline emails/URLs; reconstruct raw span text first so
    # internal double spaces/tabs/wide spaces are not lost to prior _clean_ws normalization.
    if raw_spans:
        raw_buf: list[str] = []
        for si, sp in enumerate(raw_spans):
            if sp.get("is_gap"):
                raw_buf.append("   ")
                continue
            cur_t = sp.get("text", "")
            if si > 0 and not raw_spans[si - 1].get("is_gap"):
                prev_t = raw_spans[si - 1].get("text", "")
                gap = sp["bbox"][0] - raw_spans[si - 1]["bbox"][2]
                if gap > 22.0:
                    raw_buf.append("   ")
                elif gap > 1.8 and not prev_t.endswith((" ", "\t")) and not cur_t.startswith((" ", "\t", ",", ".", ";", ":")):
                    raw_buf.append(" ")
            raw_buf.append(cur_t)
        raw_text = "".join(raw_buf)
    else:
        raw_text = text
    if "," in raw_text:
        raw_text = re.sub(
            r"(\([^()]{1,120}(?:@|https?://|www\.)[^()]{0,120}\)|<[^<>]{1,120}(?:@|https?://|www\.)[^<>]{0,120}>|\[[^\[\]]{1,120}(?:@|https?://|www\.)[^\[\]]{0,120}\])\s*,\s*",
            r"\1; ",
            raw_text,
            flags=re.IGNORECASE,
        )
        raw_text = re.sub(
            r"((?<![^\s,;()<>[\]@])[^\s,;()<>[\]@]+@[^\s,;()<>[\]@]+|(?<![^\s,;()<>[\]])(?:https?://|www\.)[^\s,;()<>[\]]+)\s*,\s*",
            r"\1; ",
            raw_text,
            flags=re.IGNORECASE,
        )
    wide_parts = [p.strip() for p in re.split(r"[\u2002-\u200b\u3000]+|\t+| {3,}|[;；]", raw_text) if p.strip()]
    if len(wide_parts) >= 2 and _chunks_are_multi_inst(wide_parts, require_no_trailing_prep=True, allow_side_by_side_loc=True):
        return True
    parts = [p.strip() for p in re.split(r"[\u2002-\u200b\u3000]+|\t+| {2,}|[;；]", raw_text) if p.strip()]
    return len(parts) >= 2 and _chunks_are_multi_inst(parts, require_no_trailing_prep=True)


def _extract_page1_lines(page: fitz.Page) -> tuple[list[dict], list[dict], float, float]:
    """Return (header_lines, footnote_lines, page_width, page_height)."""
    page_w = float(page.rect.width)
    page_h = float(page.rect.height)
    raw_dict = page.get_text("dict")
    all_lines: list[dict] = []

    for b_idx, block in enumerate(raw_dict.get("blocks", [])):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            # Skip vertical/rotated text (e.g. arXiv left-margin stamp)
            ldir = line.get("dir", (1.0, 0.0))
            if abs(ldir[0]) < 0.8 or abs(ldir[1]) > 0.3:
                continue
            spans = []
            for s in line.get("spans", []):
                t = _normalize_pua(s.get("text", ""))
                if not t:
                    continue
                font_name = str(s.get("font", ""))
                is_icon = bool(ICON_FONT_RE.search(font_name) and len(t.strip()) <= 3)
                spans.append({
                    "text": "✉" if is_icon else t,
                    "font": font_name,
                    "is_icon": is_icon,
                    "size": float(s.get("size", 10.0)),
                    "flags": int(s.get("flags", 0)),
                    "origin_y": float(s.get("origin", (0.0, 0.0))[1]),
                    "bbox": tuple(float(v) for v in s.get("bbox", (0, 0, 0, 0))),
                })
            if not spans:
                continue
            joined = _clean_ws("".join("" if s.get("is_icon") else s["text"] for s in spans))
            if not joined:
                continue
            # Skip left-margin arXiv stamp even if horizontal
            if re.match(r"^arXiv:\d{4}\.\d{4,5}", joined, re.IGNORECASE):
                continue
            bbox = tuple(float(v) for v in line.get("bbox", (0, 0, 0, 0)))
            non_icon_spans = [s for s in spans if not s.get("is_icon")] or spans
            max_sz = max(s["size"] for s in non_icon_spans)
            # Dominant (non-marker) font size & baseline
            word_spans = [s for s in non_icon_spans if re.search(r"[A-Za-z\u3400-\u9fff]{2,}", s["text"])]
            base_sz = max((s["size"] for s in word_spans), default=max_sz)
            base_y = (
                sorted(s["origin_y"] for s in word_spans)[len(word_spans) // 2]
                if word_spans
                else non_icon_spans[0]["origin_y"]
            )
            all_lines.append({
                "block": b_idx,
                "bbox": bbox,
                "y0": bbox[1],
                "y1": bbox[3],
                "x0": bbox[0],
                "x1": bbox[2],
                "spans": spans,
                "text": joined,
                "max_size": max_sz,
                "base_size": base_sz,
                "base_y": base_y,
            })

    # Find abstract start y (upper bound of header), allowing long affiliation blocks up to 0.78*page_h
    # when Abstract/Introduction sits below 0.50*page_h (e.g. 12-institution headers).
    abstract_y: float | None = None
    top_title_sz = max(
        (ln["max_size"] for ln in all_lines if 35 <= ln["y0"] < page_h * 0.35),
        default=12.0,
    )
    sorted_all = sorted(all_lines, key=lambda r: (r["y0"], r["x0"]))
    y_rows: list[list[dict]] = []
    for ln in sorted_all:
        if y_rows and abs(ln["y0"] - y_rows[-1][0]["y0"]) <= 4.5:
            y_rows[-1].append(ln)
        else:
            y_rows.append([ln])
    for row in y_rows:
        row_sorted = sorted(row, key=lambda r: r["x0"])
        row_y = min(r["y0"] for r in row_sorted)
        if row_y <= 60 or row_y > page_h * 0.78:
            continue
        row_text = _clean_ws(" ".join(r["text"] for r in row_sorted))
        row_max_sz = max(r["max_size"] for r in row_sorted)
        is_title_sized = top_title_sz >= 13.0 and row_max_sz >= top_title_sz - 1.0
        is_standalone_abstract_heading = bool(
            re.fullmatch(r"(?:a\s*b\s*s\s*t\s*r\s*a\s*c\s*t|summary)\s*[:.—-]?", row_text, re.IGNORECASE)
        )
        if is_title_sized and not is_standalone_abstract_heading and not re.match(r"^(?:i\.|1\.?)\s+introduction\b", row_text, re.IGNORECASE):
            continue
        if ABSTRACT_START_RE.match(row_text) or any(ABSTRACT_START_RE.match(r["text"]) for r in row_sorted):
            abstract_y = row_y
            break
        # v3: 首页 Teaser Figure 1 图注位于作者/机构区之后、摘要之前，截断以防图内文字与编号框混入机构
        if _GEOMETRIC_GUARDS_ENABLED and row_y >= page_h * 0.16 and re.match(r"^(?:Figure|Fig\.?)\s*1\s*[:.]", row_text, re.IGNORECASE):
            abstract_y = row_y
            break
    if abstract_y is None:
        abstract_y = page_h * 0.50
        # If explicit superscript affiliation lines continue past 0.50*page_h, extend up to 0.72*page_h
        for row in y_rows:
            row_y = min(r["y0"] for r in row)
            if row_y < page_h * 0.50:
                continue
            if row_y > page_h * 0.72:
                break
            row_text = _clean_ws(" ".join(r["text"] for r in sorted(row, key=lambda r: r["x0"])))
            if any(_has_affiliation_hint(r["text"]) for r in row) and not _looks_like_prose_sentence(row_text):
                abstract_y = max(abstract_y, max(r["y1"] for r in row) + 4.0)
            else:
                break

    # Skip running page headers near the top edge (y < 42 and small font)
    top_candidates = [ln for ln in all_lines if ln["y0"] < abstract_y]
    # Find largest font size in top region (the paper title)
    title_max_sz = max((ln["max_size"] for ln in top_candidates if ln["y0"] >= 35), default=12.0)

    header_lines: list[dict] = []
    for ln in top_candidates:
        if ln["y0"] < 38 and ln["max_size"] <= 10.2 and (
            ln["max_size"] < title_max_sz - 2.0
            or re.fullmatch(r"\d+", ln["text"])
            or re.search(r"preprint|journal|proceedings|conference|et al\.|asia pacific|ieee|acm|icassp|interspeech", ln["text"], re.IGNORECASE)
        ):
            continue
        header_lines.append(ln)

    # Bottom footnotes (for IEEEtran \thanks)
    footnote_lines = [
        ln for ln in all_lines
        if ln["y0"] >= page_h * 0.68 and ln["y0"] <= page_h * 0.97 and ln["base_size"] <= 9.6
    ]
    return header_lines, footnote_lines, page_w, page_h


def _strip_title_lines(header_lines: list[dict]) -> list[dict]:
    """Remove top title lines (largest font block at top of Page 1)."""
    if not header_lines:
        return []
    ordered = sorted(header_lines, key=lambda r: (r["y0"], r["x0"]))
    # Compute title max_sz only from lines with real alphabetic words (ignoring big KPI stat banners like "7.62M 15.3 MB 48 kHz")
    alpha_lines = [
        ln for ln in ordered
        if len(re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ]{3,}", ln["text"])) >= 2
        or (len(re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ]{3,}", ln["text"])) >= 1 and ln["y0"] < ordered[0]["y0"] + 120.0)
    ]
    max_sz = max((ln["max_size"] for ln in (alpha_lines or ordered)), default=12.0)
    first_title_y = None
    last_title_y = None
    title_block = None
    title_is_allcaps = False
    title_is_bold = False
    title_indices: set[int] = set()

    def _line_has_superscript(ln: dict) -> bool:
        return any(_span_is_superscript(s, ln["base_size"], ln["base_y"]) for s in ln["spans"])

    def _line_is_bold(ln: dict) -> bool:
        return any((s["flags"] & 16) != 0 for s in ln["spans"] if re.search(r"[A-Za-z]", s["text"]))

    def _line_is_allcaps(ln: dict) -> bool:
        letters = [ch for ch in ln["text"] if ch.isalpha()]
        return len(letters) >= 4 and all(ch.isupper() for ch in letters)

    _title_func_words = {"a", "an", "the", "for", "with", "of", "in", "on", "to", "via", "using", "from", "what", "how", "why", "when", "can", "towards", "toward"}
    for idx, ln in enumerate(ordered):
        has_sup = _line_has_superscript(ln)
        is_allcaps = _line_is_allcaps(ln)
        is_bold = _line_is_bold(ln)
        is_big = ln["max_size"] >= max_sz - 1.2 and max_sz >= 11.5
        # Large display titles (>= 15pt) may contain mathematical superscripts or title footnote stars (e.g. "A³: ..." or "Title*")
        is_large_title_with_sup = bool(
            has_sup
            and ln["max_size"] >= max_sz - 1.2
            and max_sz >= 15.0
            and not _is_likely_author_enumeration(re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"\d]", "", ln["text"]).strip())
            and (":" in ln["text"] or len(ln["text"].split()) >= 4 or any(w.lower() in _title_func_words for w in ln["text"].split()))
        )
        # Never let a tiny running masthead (e.g. 10.4pt "REIN PROTOCOL") hijack first_title_y when a much larger title exists below
        is_allcaps_title = is_allcaps and is_bold and ln["max_size"] >= max_sz - 2.0
        # Handle plain 12pt single-font papers where the top line is a multi-word title (with function words, not an author name)
        is_plain_top_title = (
            first_title_y is None
            and max_sz <= 12.6
            and not has_sup
            and len(ln["text"].split()) >= 5
            and not _is_likely_author_enumeration(ln["text"])
            and not _is_valid_author_name(ln["text"])
            and any(w.lower() in _title_func_words for w in ln["text"].split())
        )
        if first_title_y is None:
            if (is_big or is_allcaps_title or is_plain_top_title) and (not has_sup or is_large_title_with_sup):
                first_title_y = ln["y0"]
                last_title_y = ln["y1"]
                title_block = ln["block"]
                title_is_allcaps = is_allcaps
                title_is_bold = is_bold
                title_indices.add(idx)
            elif ln["y0"] < 95 and (ln["max_size"] < max_sz - 2.0 or DATE_LINE_RE.match(ln["text"])):
                title_indices.add(idx)
        else:
            # Never absorb author lines (with superscripts, emails, or italic-after-bold-allcaps title)
            if has_sup or "@" in ln["text"]:
                break
            if title_is_allcaps and not is_allcaps:
                break
            if title_is_bold and not is_bold and ln["max_size"] < max_sz - 1.2:
                break
            if max_sz <= 12.6 and title_is_bold and not is_bold:
                break
            has_same_row_peer_block = any(
                o["block"] != ln["block"] and abs(o["y0"] - ln["y0"]) <= 3.0
                for o in ordered
            )
            ln_no_sym = re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"]", "", ln["text"]).strip(" ,")
            smaller_non_title_fallback = (
                ln["y0"] - last_title_y < 14
                and ln["max_size"] >= max_sz * 0.78
                and not re.search(r"[@,]", ln["text"])
                and not has_same_row_peer_block
                and not _is_valid_author_name(ln_no_sym)
                and not _is_likely_author_enumeration(ln_no_sym)
                and not _has_affiliation_hint(ln["text"])
                and not _is_location_only_line(ln["text"])
            )
            next_ln = ordered[idx + 1] if idx + 1 < len(ordered) else None
            next_no_sym = (
                re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"]", "", next_ln["text"]).strip(" ,")
                if next_ln is not None
                else ""
            )
            next_is_known_org = (
                next_ln is not None
                and (
                    re.sub(r"[^a-z0-9]", "", next_ln["text"].lower()) in KNOWN_NON_CITY_ORG_HEADS
                    or _has_strong_unmarked_org_signal(next_ln["text"])
                )
            )
            same_block_subtitle = (
                title_block is not None
                and ln["block"] == title_block
                and (ln["y0"] - last_title_y) <= 8.0
                and max_sz >= ln["max_size"] + 3.0
                and not has_same_row_peer_block
                and not _is_valid_author_name(ln_no_sym)
                and not (
                    _is_likely_author_enumeration(ln_no_sym)
                    and not (_is_valid_author_name(next_no_sym) or _is_likely_author_enumeration(next_no_sym))
                )
                and not _has_affiliation_hint(ln["text"])
                and not _is_location_only_line(ln["text"])
                and next_ln is not None
                and next_ln["block"] != title_block
                and (next_ln["y0"] - ln["y1"]) >= 10.0
                and not _has_affiliation_hint(next_ln["text"])
                and not next_is_known_org
                and not EMAIL_OR_URL_LINE_RE.search(next_ln["text"])
            )
            # Immediate bold subtitle directly below a larger bold main title, above a non-bold author line
            # (e.g. "Why Do Low-Activity Speakers Disappear?" + bold 12pt subtitle + regular 12pt "Fumiaki Yamaguchi").
            ln_bold_spans = [s for s in (ln.get("spans") or []) if s["text"].strip()]
            ln_all_bold = bool(ln_bold_spans) and all((s.get("flags", 0) & 16) != 0 for s in ln_bold_spans)
            next_bold_spans = [s for s in (next_ln.get("spans") or []) if s["text"].strip()] if next_ln is not None else []
            next_is_bold = bool(next_bold_spans) and all((s.get("flags", 0) & 16) != 0 for s in next_bold_spans)
            bold_subtitle_below_title = (
                ln_all_bold
                and max_sz >= ln["max_size"] + 1.5
                and len(ln["text"].split()) >= 5
                and not has_same_row_peer_block
                and not _is_valid_author_name(ln_no_sym)
                and not _is_likely_author_enumeration(ln_no_sym)
                and not _has_affiliation_hint(ln["text"])
                and not EMAIL_OR_URL_LINE_RE.search(ln["text"])
                and next_ln is not None
                and not next_is_bold
                and not _has_affiliation_hint(next_ln["text"])
                and not EMAIL_OR_URL_LINE_RE.search(next_ln["text"])
            )
            if is_big or (title_is_allcaps and is_allcaps) or smaller_non_title_fallback or same_block_subtitle or bold_subtitle_below_title:
                if ln["y0"] - last_title_y < 24:
                    last_title_y = max(last_title_y, ln["y1"])
                    title_indices.add(idx)
                    continue
            break

    remaining = [ln for idx, ln in enumerate(ordered) if idx not in title_indices]
    if not remaining and len(ordered) > 1:
        return ordered[1:]
    return remaining


def _merge_same_row_lines(lines: list[dict], page_w: float) -> tuple[list[dict], bool]:
    """Merge horizontally separated lines on the same y-row when they belong to a full-width author/affiliation row,
    UNLESS the header is clearly a two-column split (left column authors, right column affiliations like BMVC).
    Returns (lines, is_two_col_split)."""
    if not lines:
        return [], False
    # Filter out tiny figure-diagram labels (font size <= 6.5pt) that appear above Abstract in teaser figures,
    # while preserving standalone LaTeX \scriptsize (~7pt) pure-marker superscript lines AND small resource URL/domain lines
    # (so paired rows like "Evaluation github.com/..." stay merged and are filtered as resource lines).
    small_resource_re = re.compile(
        r"(?:@|https?://|www\.|\b[a-z0-9-]+\.(?:com|org|ai|io|edu|net|dev|co|ch|de|fr|uk|cn|jp|kr)\b)",
        re.IGNORECASE,
    )
    usable = [
        ln for ln in lines
        if ln["base_size"] >= 7.2
        or (ln["base_size"] >= 4.5 and _is_pure_marker_text(ln["text"]))
        or (ln["base_size"] >= 5.5 and (NON_AUTHOR_RESOURCE_RE.search(ln["text"]) or small_resource_re.search(ln["text"])))
    ]
    if not usable:
        usable = lines
    # Detect 2-column BMVC layout: left column (x0 < page_w*0.35, x1 < page_w*0.60) has emails/names,
    # right column (x0 > page_w*0.40) has affiliations
    left_lines = [ln for ln in usable if ln["x0"] < page_w * 0.35 and ln["x1"] < page_w * 0.62]
    right_lines = [ln for ln in usable if ln["x0"] > page_w * 0.40]
    if left_lines and right_lines:
        left_has_emails = any("@" in ln["text"] for ln in left_lines)
        right_has_emails = any("@" in ln["text"] for ln in right_lines)
        right_has_aff = any("@" not in ln["text"] and _has_affiliation_hint(ln["text"]) for ln in right_lines)
        left_has_aff = any("@" not in ln["text"] and _has_affiliation_hint(ln["text"]) for ln in left_lines)
        if left_has_emails and not right_has_emails and right_has_aff and not left_has_aff:
            # Keep only header lines above any bottom teaser figure (stop after max y of left emails / right affs + 25pt)
            max_header_y = max(
                max(ln["y1"] for ln in left_lines if "@" in ln["text"] or _is_valid_author_name(re.sub(r"\d+", "", ln["text"]))),
                max(ln["y1"] for ln in right_lines if _has_affiliation_hint(ln["text"])),
            ) + 22.0
            left_kept = sorted([ln for ln in left_lines if ln["y0"] <= max_header_y], key=lambda r: r["y0"])
            right_kept = sorted([ln for ln in right_lines if ln["y0"] <= max_header_y], key=lambda r: r["y0"])
            return left_kept + right_kept, True

    # Otherwise group lines within 4.5pt vertical proximity into visual rows
    ordered = sorted(usable, key=lambda r: (r["y0"], r["x0"]))
    rows: list[list[dict]] = []
    for ln in ordered:
        row_tol = 6.0 if (rows and (_is_pure_marker_text(ln["text"]) or _is_pure_marker_text(rows[-1][0]["text"]))) else 4.5
        if rows and abs(ln["y0"] - rows[-1][0]["y0"]) <= row_tol:
            rows[-1].append(ln)
        else:
            rows.append([ln])

    merged: list[dict] = []
    for row in rows:
        row.sort(key=lambda r: r["x0"])
        if len(row) == 1:
            merged.append(row[0])
            continue
        # Combine spans with synthetic separator info (preserve exact x bboxes!)
        all_spans: list[dict] = []
        for idx, part in enumerate(row):
            if idx > 0:
                gap = part["x0"] - row[idx - 1]["x1"]
                prev_is_pure_marker = _is_pure_marker_text(row[idx - 1]["text"])
                gap_thresh = max(7.5, min(10.0, part["base_size"] * 0.92)) if part["base_size"] <= 9.8 else 10.0
                if not prev_is_pure_marker and gap > gap_thresh:
                    all_spans.append({
                        "text": "   ",
                        "size": part["base_size"],
                        "flags": 0,
                        "origin_y": part["base_y"],
                        "bbox": (row[idx - 1]["x1"], part["y0"], part["x0"], part["y1"]),
                        "is_gap": True,
                        "gap_pt": gap,
                    })
                else:
                    all_spans.append({
                        "text": " ",
                        "size": part["base_size"],
                        "flags": 0,
                        "origin_y": part["base_y"],
                        "bbox": (row[idx - 1]["x1"], part["y0"], part["x0"], part["y1"]),
                    })
            all_spans.extend(part["spans"])
        non_gap = [s for s in all_spans if not s.get("is_gap") and s["text"].strip()]
        word_spans = [s for s in non_gap if re.search(r"[A-Za-z\u3400-\u9fff]{2,}", s["text"])]
        base_sz = max((s["size"] for s in word_spans), default=max(s["size"] for s in non_gap))
        base_y = (
            sorted(s["origin_y"] for s in word_spans)[len(word_spans) // 2]
            if word_spans
            else non_gap[0]["origin_y"]
        )
        merged.append({
            "block": row[0]["block"],
            "bbox": (min(r["x0"] for r in row), min(r["y0"] for r in row), max(r["x1"] for r in row), max(r["y1"] for r in row)),
            "y0": min(r["y0"] for r in row),
            "y1": max(r["y1"] for r in row),
            "x0": min(r["x0"] for r in row),
            "x1": max(r["x1"] for r in row),
            "spans": all_spans,
            "text": _clean_ws(" ".join(r["text"] for r in row)),
            "max_size": max(r["max_size"] for r in row),
            "base_size": base_sz,
            "base_y": base_y,
        })
    return merged, False


def _span_is_superscript(span: dict, base_sz: float, base_y: float) -> bool:
    if span.get("is_gap"):
        return False
    if span.get("is_icon"):
        return True
    txt = span["text"].strip()
    if not txt:
        return False
    if not _is_pure_marker_text(txt):
        return False
    flag_sup = (span["flags"] & 1) != 0
    smaller = span["size"] <= base_sz * 0.86
    raised = span["origin_y"] <= base_y - 1.2
    # In PyMuPDF, some LaTeX PDFs set flag=1 on superscripts, some only shrink size & raise origin_y,
    # and leading affiliation superscripts like "1 Fudan University" have smaller size (8pt vs 12pt)
    # even when origin_y matches the line baseline.
    if flag_sup:
        return True
    if smaller and raised:
        return True
    if smaller and span["size"] <= base_sz * 0.78:
        return True
    return False


def _annotate_line_with_markers(line: dict) -> str:
    """Convert a line's spans into text with explicit [[SUP:...]] and [[GAP]] tokens."""
    base_sz = line["base_size"]
    base_y = line["base_y"]
    out: list[str] = []
    i = 0
    spans = line["spans"]
    while i < len(spans):
        s = spans[i]
        if s.get("is_gap"):
            out.append(" [[GAP]] ")
            i += 1
            continue
        if _span_is_superscript(s, base_sz, base_y):
            # Merge adjacent superscript spans
            sup_parts = [s["text"].strip()]
            j = i + 1
            while j < len(spans) and _span_is_superscript(spans[j], base_sz, base_y):
                sup_parts.append(spans[j]["text"].strip())
                j += 1
            combined = ",".join(p for p in sup_parts if p)
            out.append(f"[[SUP:{combined}]]")
            i = j
            continue
        # Handle inline space gap between spans in same block (e.g. "1 Fudan University   2 USC")
        if i > 0 and not spans[i - 1].get("is_gap"):
            gap = s["bbox"][0] - spans[i - 1]["bbox"][2]
            if gap > 14.0:
                out.append(" [[GAP]] ")
            elif gap > 1.8 and out and not out[-1].endswith((" ", "[[GAP]] ")):
                # Only insert space if not glued inside a word
                prev_t = spans[i - 1]["text"]
                cur_t = s["text"]
                if not prev_t.endswith(" ") and not cur_t.startswith((" ", ",", ".", ";", ":")):
                    out.append(" ")
        out.append(s["text"])
        i += 1
    return re.sub(r"\s+", " ", "".join(out))


def _extract_marked_affiliations_from_lines(lines: list[dict], author_names: list[str] | None = None) -> tuple[dict[str, str], set[str]]:
    """Extract {marker: affiliation_text} and set of non-institution footnote markers (e.g. '*' -> Equal contribution).
    Two-pass: explicit [[SUP:...]] markers are always extracted before raw non-superscript fallback so street addresses
    (e.g. '1 Microsoft Way') or '3DGS' headings can never pre-empt explicit superscript markers."""
    aff_map: dict[str, str] = {}
    role_markers: set[str] = set()
    raw_fallback_segments: list[str] = []

    def _is_role_body(body: str) -> bool:
        return bool(FOOTNOTE_ROLE_RE.match(body) or UNANCHORED_ROLE_SENTENCE_RE.search(body) or _is_credit_contribution(body))

    STREET_ADDRESS_RE = re.compile(
        r"^\s*\d{1,5}\s+[A-Za-z0-9.\s'-]{1,40}\b(?:Blvd\.?|Ave\.?|Avenue|St\.?|Street|Rd\.?|Road|Way|Dr\.?|Drive|Pkwy\.?|Parkway|Ln\.?|Lane|Ct\.?|Court|Pl\.?|Place|Cir\.?|Circle|Suite|Ste\.?)\b",
        re.IGNORECASE,
    )

    # Pass 1: explicit [[SUP:...]] markers
    confirmed_aff_cont_lines: set[int] = set()
    for idx, ln in enumerate(lines):
        if _GEOMETRIC_GUARDS_ENABLED and STREET_ADDRESS_RE.match(ln["text"].strip()):
            continue
        annotated = _annotate_line_with_markers(ln)
        stripped_ann = annotated.lstrip()
        starts_with_marker = bool(
            stripped_ann.startswith("[[SUP:")
            or (stripped_ann and stripped_ann[0] in SYMBOL_MARKER_CHARS)
            or re.match(r"^[1-9]\d?(?:\s+(?=[A-Z])|(?=[A-Z](?:[a-z]{2,}|[A-Z])))", stripped_ann)
        )
        if EMAIL_OR_URL_LINE_RE.search(ln["text"]) and not _has_affiliation_hint(ln["text"]) and not starts_with_marker and idx not in confirmed_aff_cont_lines:
            continue
        segments = [seg.strip() for seg in annotated.split("[[GAP]]") if seg.strip()]
        # Guard against author lines split by [[GAP]] where a superscript falls at the start of seg_idx > 0
        # (e.g. "Yi Zhao [[GAP]] [[SUP:∗]], Zhi Gong"): only accept seg_idx > 0 leading [[SUP:...]] if
        # the line itself started with a marker or was a confirmed affiliation continuation.
        first_seg_starts_marker = bool(segments and (
            segments[0].startswith("[[SUP:")
            or (segments[0][0] in SYMBOL_MARKER_CHARS)
            or re.match(r"^[1-9]\d?(?:\s+(?=[A-Z])|(?=[A-Z](?:[a-z]{2,}|[A-Z])))", segments[0])
        ))
        for seg_idx, seg in enumerate(segments):
            matches = list(re.finditer(r"\[\[SUP:([^\]]+)\]\]", seg))
            if not matches:
                if idx not in confirmed_aff_cont_lines or seg_idx > 0:
                    raw_fallback_segments.append(seg)
                continue
            if matches[0].start() > 2 and not (seg_idx == 0 and idx in confirmed_aff_cont_lines):
                continue
            if seg_idx > 0 and not first_seg_starts_marker and idx not in confirmed_aff_cont_lines:
                first_seg_plain = _clean_ws(re.sub(r"\[\[SUP:[^\]]+\]\]", " ", segments[0])).strip(" ,;")
                after_first_sup = seg[matches[0].end():].lstrip()
                if _is_valid_author_name(first_seg_plain) or after_first_sup.startswith(","):
                    continue
            for m_i, m in enumerate(matches):
                markers = _parse_marker_string(m.group(1))
                start_pos = m.end()
                end_pos = matches[m_i + 1].start() if m_i + 1 < len(matches) else len(seg)
                body = _clean_ws(seg[start_pos:end_pos])
                if not markers or not body:
                    continue
                if markers == ["+"] and (
                    re.match(r"^(?:\(?\d|tel\b|fax\b|phone\b)", body, re.IGNORECASE)
                    or (re.search(r"\d{3,}[-\s]\d{3,}", body) and not _has_affiliation_hint(body))
                ):
                    continue
                if _is_role_body(body):
                    role_markers.update(markers)
                    continue
                if (
                    seg_idx == len(segments) - 1
                    and m_i == len(matches) - 1
                ):
                    cur_ln = ln
                    next_idx = idx + 1
                    for _cont_step in range(3):
                        if next_idx >= len(lines):
                            break
                        nxt = lines[next_idx]
                        nxt_ann = _annotate_line_with_markers(nxt)
                        nxt_stripped = nxt_ann.lstrip()
                        nxt_has_trailing_markers = ("[[SUP:" in nxt_ann or "[[GAP]]" in nxt_ann)
                        if nxt_stripped.startswith("[[SUP:") or nxt_stripped.startswith("[[GAP]]"):
                            break
                        first_tag = re.search(r"\[\[GAP\]\]|\[\[SUP:", nxt_stripped)
                        nxt_lead = _clean_ws(nxt_stripped[:first_tag.start()] if first_tag else nxt_stripped)
                        m_prep = re.match(r"^(?:of|for|in|and|&)\s+(.+)$", nxt_lead, re.IGNORECASE)
                        nxt_prep_rest = m_prep.group(1).strip() if m_prep else ""
                        nxt_starts_prep = bool(
                            m_prep
                            and re.match(r"^(?:the\s+)?[A-Z\u00c0-\u00de\u0100-\u017e]", nxt_prep_rest)
                        )
                        nxt_lead_is_prose = (
                            (_looks_like_prose_sentence(f"{body} {nxt_lead}") or _looks_like_prose_sentence(nxt_prep_rest))
                            if nxt_starts_prep
                            else _looks_like_prose_sentence(nxt_lead)
                        )
                        nxt_lead_stripped_author = re.sub(
                            r"^(?:and|&)\s+",
                            "",
                            re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"]", "", nxt_lead).strip(" ,;"),
                            flags=re.IGNORECASE,
                        ).strip()
                        if not (
                            nxt_lead
                            and not NON_AUTHOR_RESOURCE_RE.search(nxt_lead)
                            and not EMAIL_OR_URL_LINE_RE.search(nxt_lead)
                            and not _is_role_body(nxt_lead)
                            and not nxt_lead_is_prose
                            and not DATE_LINE_RE.match(nxt_lead)
                            and not VENUE_OR_STATUS_RE.match(nxt_lead)
                            and not SECTION_META_HEADING_RE.match(nxt_lead)
                            and not IEEE_MEMBER_RE.search(nxt_lead)
                            and not re.match(r"^(?:keywords?|index\s+terms|ccs\s+concepts|categories|acm\s+reference)\b", nxt_lead, re.IGNORECASE)
                            and not re.match(r"^(?:\(\d{1,2}\)|\d{1,2}[.)])\s+", nxt_lead)
                            and not re.match(
                                r"^(?:[" + re.escape(SYMBOL_MARKER_CHARS) + r"]|[1-9]\d?(?:\s+(?=[A-Z])|(?=[A-Z](?:[a-z]{2,}|[A-Z]))))",
                                nxt_lead,
                            )
                            and not _is_likely_author_enumeration(nxt_lead_stripped_author)
                            and nxt["y0"] - cur_ln["y1"] < 18
                        ):
                            break
                        nxt_same_font = abs(nxt["base_size"] - cur_ln["base_size"]) <= 1.2
                        nxt_lead_not_author = not _is_valid_author_name(nxt_lead_stripped_author)
                        dangling_prep = bool(re.search(r"\b(?:of|and|&|for|in|de|la|du|da|do|dos|das|del|des|di|the)\s*$", body, re.IGNORECASE))
                        dangling_comma = body.rstrip().endswith(",")
                        nxt_ends_before_sup = bool(
                            first_tag
                            and first_tag.group(0).startswith("[[SUP:")
                            and nxt_lead.rstrip().endswith((",", ";"))
                        )
                        nxt_after_sup_has_aff = bool(
                            nxt_ends_before_sup
                            and first_tag
                            and _has_affiliation_hint(nxt_stripped[first_tag.end():])
                        )
                        body_tail_no_zip = (
                            re.sub(r"\s+\d{4,6}(?:-\d{4})?$", "", body.rsplit(",", 1)[-1].strip()).strip()
                            if "," in body
                            else ""
                        )
                        body_has_loc_tail = bool(body_tail_no_zip and _is_known_location_tail(body_tail_no_zip))
                        body_ends_incomplete_org_head = bool(
                            (
                                re.search(
                                    r"(?:^|,\s*|-\s*|\b(?:the|national|technical|chinese|state|city|federal|free|open|catholic|autonomous|polytechnic|imperial|royal|pontifical)\s+)university\s*$",
                                    body.strip(),
                                    re.IGNORECASE,
                                )
                                and re.match(r"^of\s+", nxt_lead, re.IGNORECASE)
                            )
                            or re.fullmatch(r"(?:the\s+)?university", body.strip(), re.IGNORECASE)
                            or re.search(
                                r"\b(?:department|school|institute|institution|faculty|center|centre|"
                                r"laboratory|laboratories|division|college|academy|group|lab|labs|"
                                r"program|chair|unit|research|engineering|science|sciences|studies|"
                                r"technology|technologies|computing|intelligence|information|systems|"
                                r"communication|communications)\s*$",
                                body,
                                re.IGNORECASE,
                            )
                        )
                        nxt_prep_is_venue_journal = bool(
                            re.search(
                                r"\b(?:transactions?|journal|proceedings|conference|workshop|symposium|letters|magazine)\b",
                                nxt_lead,
                                re.IGNORECASE,
                            )
                        )
                        merged = False
                        nxt_is_postal_or_loc_tail = bool(
                            _is_location_only_line(nxt_lead)
                            or _is_known_location_tail(nxt_lead)
                            or (
                                "," in nxt_lead
                                and _is_known_location_tail(
                                    re.sub(r"\s+\d{4,6}(?:-\d{4})?$", "", nxt_lead.rsplit(",", 1)[-1].strip()).strip()
                                )
                            )
                            or (
                                len(nxt_lead.split()) <= 5
                                and re.search(r"\b(?:[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}|\d{4,6})\b", nxt_lead)
                            )
                        )
                        if (dangling_prep or dangling_comma) and (nxt_lead_not_author or nxt_after_sup_has_aff) and (
                            _has_affiliation_hint(nxt_lead)
                            or nxt_is_postal_or_loc_tail
                            or (dangling_prep and nxt_same_font and _has_affiliation_hint(f"{body} {nxt_lead}"))
                            or (dangling_comma and nxt_same_font and nxt_ends_before_sup)
                        ):
                            body = f"{body} {nxt_lead}"
                            merged = True
                        elif (
                            nxt_starts_prep
                            and not nxt_prep_is_venue_journal
                            and (nxt_lead_not_author or nxt_after_sup_has_aff)
                            and not body_has_loc_tail
                            and not body.rstrip().endswith((".", ";"))
                            and (
                                _has_affiliation_hint(nxt_lead)
                                or (nxt_same_font and body_ends_incomplete_org_head)
                            )
                        ):
                            body = f"{body} {nxt_lead}"
                            merged = True
                        elif (
                            nxt_same_font
                            and nxt_ends_before_sup
                            and (nxt_lead_not_author or nxt_after_sup_has_aff)
                            and not body.rstrip().endswith(";")
                            and not body_has_loc_tail
                        ):
                            body = f"{body} {nxt_lead}"
                            merged = True
                        elif (
                            nxt_same_font
                            and (len(segments) >= 2 or nxt_has_trailing_markers)
                            and not _has_affiliation_hint(body)
                            and not _is_location_only_line(body)
                            and re.sub(r"[^a-z0-9]", "", body.lower()) not in KNOWN_NON_CITY_ORG_HEADS
                            and nxt_lead_not_author
                            and (
                                _has_affiliation_hint(nxt_lead)
                                or _has_affiliation_hint(f"{body} {nxt_lead}")
                                or _is_location_only_line(nxt_lead)
                                or ("," in nxt_lead and _is_known_location_tail(nxt_lead.rsplit(",", 1)[-1].strip()))
                            )
                        ):
                            body = f"{body} {nxt_lead}"
                            merged = True
                        elif (
                            nxt_same_font
                            and not nxt_has_trailing_markers
                            and nxt_lead_not_author
                            and not body.rstrip().endswith((".", ";", ","))
                            and not body_has_loc_tail
                            and (
                                (
                                    nxt["block"] == cur_ln["block"]
                                    and (cur_ln["x1"] - cur_ln["x0"]) >= 260.0
                                )
                                or (
                                    _has_affiliation_hint(nxt_lead)
                                    and not _is_location_only_line(nxt_lead)
                                    and bool(re.match(
                                        r"^(?:Science|Sciences|Engineering|Technology|Technologies|Studies|Research|"
                                        r"Intelligence|Systems|Laboratory|Laboratories|Institute|University|Center|"
                                        r"Centre|School|College|Department|Faculty|Division)\b",
                                        nxt_lead,
                                    ))
                                )
                            )
                            and (
                                not re.search(
                                    r"\b(?:university|college|school|institute|institution|corporation|company|inc\.?|ltd\.?|"
                                    r"laboratory|laboratories|lab|labs|center|centre|academy|mit|cmu|kaist|epfl|cnrs|inria|riken|nict|dfki|idiap)\s*$",
                                    body,
                                    re.IGNORECASE,
                                )
                                or (
                                    re.search(r"\bcollege\s*$", body, re.IGNORECASE)
                                    and bool(re.match(r"^(?:London|Dublin|Oxford|Cambridge|Edinburgh|Imperial|Cork)\b", nxt_lead))
                                )
                            )
                            and (_has_affiliation_hint(nxt_lead) or nxt_is_postal_or_loc_tail)
                        ):
                            body = f"{body} {nxt_lead}"
                            merged = True
                        elif (
                            _cont_step == 0
                            and len(segments) == 1
                            and not nxt_has_trailing_markers
                            and abs(nxt["x0"] - cur_ln["x0"]) < 35
                            and not _has_affiliation_hint(nxt_lead)
                            and (
                                _is_location_only_line(nxt_lead)
                                or (
                                    len(nxt_lead.split()) <= 4
                                    and "," in nxt_lead
                                    and ":" not in nxt_lead
                                    and "：" not in nxt_lead
                                    and bool(re.match(r"^[A-ZÀ-ÖØ-Þ]", nxt_lead))
                                    and not re.search(r"\b(?:19|20)\d{2}\b|all\s+rights\s+reserved|copyright", nxt_lead, re.IGNORECASE)
                                    and nxt_lead_not_author
                                    and not re.search(r",\s*(?:we|our|this|they|it|he|she|in|on|at|for|to|from|with|by)\b", nxt_lead, re.IGNORECASE)
                                )
                            )
                            and "," not in body
                        ):
                            body = f"{body}, {nxt_lead}"
                            merged = True
                        if not merged:
                            break
                        if nxt_has_trailing_markers:
                            confirmed_aff_cont_lines.add(next_idx)
                            break
                        cur_ln = nxt
                        next_idx += 1
                cleaned = _sanitize_affiliation(body, author_names)
                if cleaned and not _is_location_only_line(cleaned) and not _is_known_location_tail(cleaned) and (
                    _has_affiliation_hint(cleaned)
                    or re.search(r"[A-Z][a-z]+", cleaned)
                    or re.fullmatch(r"[A-Z]{2,12}(?:\([A-Z0-9]{1,8}\)|-[A-Z0-9]{1,6})?(?:,\s*[A-Z]{2,12}(?:\([A-Z0-9]{1,8}\)|-[A-Z0-9]{1,6})?)*", cleaned)
                ):
                    for mk in markers:
                        aff_map.setdefault(mk, cleaned)

    # Pass 2: raw non-superscript marker fallback (never pre-empts Pass 1; case-sensitive [1-4]D guard)
    has_explicit_numeric = any(mk.isdigit() for mk in aff_map) or any(mk.isdigit() for mk in role_markers)
    for seg in raw_fallback_segments:
        if DATE_LINE_RE.match(seg) or re.match(r"^[1-4]D(?:[A-Z]{2,}|\b)", seg) or re.match(r"^\d+(?:st|nd|rd|th)\b", seg, re.IGNORECASE):
            continue
        m_raw = re.match(
            r"^([" + re.escape(SYMBOL_MARKER_CHARS) + r"]|[1-9]\d?(?:\s+(?=[A-Z])|(?=[A-Z](?:[a-z]{2,}|[A-Z]))))\s*(.+)$",
            seg,
        )
        if not m_raw:
            continue
        raw_mk_text = m_raw.group(1)
        is_numeric_raw = raw_mk_text.strip()[0].isdigit()
        is_glued_numeric = is_numeric_raw and not raw_mk_text[-1].isspace()
        markers = _parse_marker_string(raw_mk_text.strip())
        body = _clean_ws(m_raw.group(2))
        if not markers or not body:
            continue
        if raw_mk_text.strip() == "+" and (
            re.match(r"^(?:\(?\d|tel\b|fax\b|phone\b)", body, re.IGNORECASE)
            or (re.search(r"\d{3,}[-\s]\d{3,}", body) and not _has_affiliation_hint(body))
        ):
            continue
        if _is_role_body(body):
            role_markers.update(markers)
            continue
        if _looks_like_prose_sentence(body):
            continue
        if is_numeric_raw and _is_bare_street_address(body):
            continue
        if re.search(r"\b(?:track|workshop|challenge|session|symposium)\b", body, re.IGNORECASE):
            continue
        if is_numeric_raw and has_explicit_numeric and not (
            _has_affiliation_hint(body) or (is_glued_numeric and len(body.split()) >= 2)
        ):
            continue
        if _has_affiliation_hint(body) or len(body.split()) >= 2:
            cleaned = _sanitize_affiliation(body, author_names)
            if cleaned and (_has_affiliation_hint(cleaned) or is_glued_numeric or not _is_valid_author_name(cleaned)):
                for mk in markers:
                    if mk not in aff_map and mk not in role_markers:
                        aff_map[mk] = cleaned
    return aff_map, role_markers


def _parse_authors_from_lines(lines: list[dict], defined_markers: set[str], role_markers: set[str], is_two_col: bool = False) -> tuple[list[dict], set[int]]:
    """Parse ordered list of {name, markers} from author lines, plus indices of lines consumed as author lines."""
    authors: list[dict] = []
    author_annotated_parts: list[str] = []
    consumed_indices: set[int] = set()
    last_author_meta: dict | None = None

    def _is_location_row(text: str, annotated: str) -> bool:
        if _is_location_only_line(text):
            return True
        if "[[GAP]]" in annotated:
            gap_segs = [seg.strip() for seg in annotated.split("[[GAP]]") if seg.strip()]
            if gap_segs and all(_is_location_only_line(seg) for seg in gap_segs):
                return True
        return False

    def _has_following_marked_author_line(start_idx: int) -> bool:
        if not defined_markers:
            return False
        for look_idx in range(start_idx + 1, len(lines)):
            look_ln = lines[look_idx]
            look_txt = look_ln["text"]
            if ABSTRACT_START_RE.match(look_txt) or SECTION_META_HEADING_RE.match(look_txt) or VENUE_OR_STATUS_RE.match(look_txt):
                return False
            look_ann = _annotate_line_with_markers(look_ln)
            if re.match(r"^\s*\[\[SUP:[^\]]+\]\]", look_ann):
                return False
            if NON_AUTHOR_RESOURCE_RE.search(look_txt) or _is_location_row(look_txt, look_ann):
                continue
            if DATE_LINE_RE.match(look_txt) or FOOTNOTE_ROLE_RE.match(look_txt) or IEEE_MEMBER_ONLY_RE.match(look_txt):
                continue
            if (NON_PERSON_AFFILIATION_RE.search(look_txt) or AUTHOR_UPPERCASE_CORP_SUFFIX_RE.search(look_txt)) and not re.search(r"\[\[SUP:[^\]]+\]\]", look_ann):
                return False
            if last_author_meta is not None and abs(look_ln["base_size"] - last_author_meta["size"]) > 1.0:
                continue
            sup_hits = re.findall(r"\[\[SUP:([^\]]+)\]\]", look_ann)
            if sup_hits and any(
                any(mk in defined_markers for mk in _parse_marker_string(sh))
                for sh in sup_hits
            ):
                cand_ann = IEEE_MEMBER_RE.sub(" ", look_ann)
                cand_ann = re.sub(
                    r"(\[\[SUP:[^\]]+\]\])\s+(?=[A-ZÀ-ÖØ-ÞĀ-Ž\u1e00-\u1eff\u3400-\u9fff])",
                    r"\1 [[GAP]] ",
                    cand_ann,
                )
                cand_plain = re.sub(r"\[\[SUP:[^\]]+\]\]", " ", cand_ann)
                cand_chunks = [
                    re.sub(
                        r"^(?:and|&)\s+",
                        "",
                        re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"]", "", ch).strip(" ,;"),
                        flags=re.IGNORECASE,
                    ).strip()
                    for ch in re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", cand_plain, flags=re.IGNORECASE)
                ]
                cand_chunks = [ch for ch in cand_chunks if ch]
                if cand_chunks and all(_is_valid_author_name(ch) for ch in cand_chunks):
                    return True
        return False

    for idx, ln in enumerate(lines):
        txt = ln["text"]
        if DATE_LINE_RE.match(txt) or FOOTNOTE_ROLE_RE.match(txt) or IEEE_MEMBER_ONLY_RE.match(txt):
            if author_annotated_parts and not is_two_col:
                break
            continue
        if NON_AUTHOR_RESOURCE_RE.search(txt):
            # In single-column headers, once we hit emails/URLs/Project Page AFTER collecting authors, stop
            # UNLESS Mode A still has a subsequent row of superscript-marked authors before the affiliation block!
            if author_annotated_parts and not is_two_col:
                if _has_following_marked_author_line(idx):
                    continue
                break
            continue
        ann = _annotate_line_with_markers(ln)
        # Skip affiliation lines (leading marker + affiliation text, or pure affiliation text)
        if re.match(r"^\s*\[\[SUP:[^\]]+\]\]", ann):
            if author_annotated_parts and not is_two_col:
                break
            continue
        if (NON_PERSON_AFFILIATION_RE.search(txt) or AUTHOR_UPPERCASE_CORP_SUFFIX_RE.search(txt)) and not re.search(r"\[\[SUP:[^\]]+\]\]", ann):
            if author_annotated_parts and not is_two_col:
                break
            continue
        if _has_affiliation_hint(txt) and not re.search(r"\[\[SUP:[^\]]+\]\]", ann):
            ann_no_sup = re.sub(r"\s+", " ", re.sub(r"\[\[SUP:[^\]]+\]\]", " ", ann)).strip()
            chk_parts = [
                re.sub(r"^(?:and|&)\s+", "", ch.strip(), flags=re.IGNORECASE).strip()
                for ch in re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", ann_no_sup, flags=re.IGNORECASE)
                if ch.strip()
            ]
            if not (chk_parts and all(_is_valid_author_name(ch) for ch in chk_parts)):
                if author_annotated_parts and not is_two_col:
                    break
                continue
        if author_annotated_parts and _is_location_row(txt, ann):
            if not is_two_col:
                if _has_following_marked_author_line(idx):
                    continue
                break
            continue
        # Skip leading glued-digit affiliation lines like "1Adobe Research, San Jose, USA"
        if re.match(r"^[1-9]\d?\s*[A-Z]", txt) and _has_affiliation_hint(txt):
            if author_annotated_parts and not is_two_col:
                break
            continue
        # Skip lingering ALL-CAPS wrapped title lines (no markers, no commas, no column gaps) before authors start,
        # or ALL-CAPS single-chunk lines after Title-Case authors (never dropping ALL-CAPS author continuations like "CAROL DAVIS").
        letters = [ch for ch in txt if ch.isalpha()]
        if len(letters) >= 6 and all(ch.isupper() for ch in letters) and not re.search(r"[,;]|\[\[SUP:|\[\[GAP\]\]", ann):
            prev_all_caps = bool(
                last_author_meta
                and any(c.isalpha() for c in last_author_meta["plain"])
                and all(c.isupper() for c in last_author_meta["plain"] if c.isalpha())
            )
            if not author_annotated_parts or not prev_all_caps:
                continue
        # Strip IEEE member grades, LNCS bracketed ORCIDs, & Interspeech ORCID 'ID' icon badges
        cleaned_ann = IEEE_MEMBER_RE.sub(" ", ann)
        cleaned_ann = re.sub(r"\s*\[\d{4}-\d{4}-\d{4}-\d{3}[\dX]\]", "", cleaned_ann)
        # Reattach superscripts separated from the preceding author by a [[GAP]] (e.g. "Young-Joo Suh [[GAP]] [[SUP:5]],[[SUP:6]]")
        cleaned_ann = re.sub(r"\s*\[\[GAP\]\]\s*(?=\[\[SUP:)", " ", cleaned_ann)
        _sym_esc = re.escape(SYMBOL_MARKER_CHARS)
        cleaned_ann = re.sub(
            r"(?<=[A-Za-z.\u00c0-\u024f\u1e00-\u1eff])((?:[" + _sym_esc + r"]+(?: ?\[\[SUP:[" + _sym_esc + r",\s]+\]\][" + _sym_esc + r"]*)?| ?\[\[SUP:[" + _sym_esc + r",\s]+\]\][" + _sym_esc + r"]*)?)\s+ID(?=\s*(?:[,;]|(?i:\band\b)|&|[" + _sym_esc + r"]|\[\[SUP:|\[\[GAP\]\]|$))",
            r"\1",
            cleaned_ann,
        )
        cleaned_ann = re.sub(r"\s+", " ", cleaned_ann).strip()
        plain_no_sup = _clean_ws(re.sub(r"\[\[SUP:[^\]]+\]\]|\[\[GAP\]\]", " ", cleaned_ann))
        if not plain_no_sup or NON_PERSON_AFFILIATION_RE.search(plain_no_sup) or AUTHOR_UPPERCASE_CORP_SUFFIX_RE.search(plain_no_sup):
            if author_annotated_parts and not is_two_col:
                break
            continue
        # Never start author collection on a standalone 1-word non-CJK line without markers (e.g. wrapped title word "IN")
        if (
            not author_annotated_parts
            and len(plain_no_sup.split()) == 1
            and not re.fullmatch(r"[\u3400-\u9fff]{2,6}", plain_no_sup)
            and not re.search(r"\[\[SUP:", cleaned_ann)
        ):
            continue
        # Do not swallow a standalone single-word org/brand line (e.g. Anthropic, OpenAI, xAI, Cartesia, Mistral)
        # as a "wrapped surname" below an already-complete author line; still allow wrapped surnames like
        # "... and John" + "McDonald" / "DUPONT" or right-margin wrapped "... and Nur Yağmur" + "Tuncer".
        if author_annotated_parts and len(plain_no_sup.split()) == 1 and not re.search(r"\[\[SUP:", cleaned_ann):
            tok = plain_no_sup
            tok_key = re.sub(r"[^a-z0-9]", "", tok.lower())
            prev_last_chunk = (
                re.split(r"\[\[GAP\]\]|[,;]|\band\b|&", last_author_meta["gap_plain"])[-1].strip()
                if last_author_meta is not None
                else ""
            )
            prev_last_toks = prev_last_chunk.split()
            prev_ends_hanging_single = len(prev_last_toks) == 1
            prev_ends_nobiliary = (
                2 <= len(prev_last_toks) <= 4
                and prev_last_toks[-1].lower().strip("'’.-") in _NOBILIARY_PARTICLES
            )
            is_known_brand = tok_key in KNOWN_NON_CITY_ORG_HEADS
            is_org_brand_tok = is_known_brand or (
                not prev_ends_hanging_single
                and not prev_ends_nobiliary
                and (
                    bool(re.search(r"[a-z][A-Z]|[A-Z]{2,}[a-z]", tok))
                    or (len(tok) >= 2 and tok.isupper())
                )
            )
            smaller_font = last_author_meta is not None and ln["base_size"] < last_author_meta["size"] - 0.5
            prev_complete_non_wrap = (
                last_author_meta is not None
                and len(prev_last_toks) >= 2
                and not prev_ends_nobiliary
                and last_author_meta["width"] < 340.0
            )
            if is_org_brand_tok or smaller_font or prev_complete_non_wrap:
                if not is_two_col:
                    break
                continue
        # Validate unmarked multi-word candidate author lines (both the first line and continuation lines)
        # so subtitle / wrapped title lines (e.g. "Measuring Timing, Task Accuracy, Whisper and Volume," or
        # "and Conversation-Grounded Expansion") and non-author org/location lines never leak as phantom authors.
        if len(plain_no_sup.split()) >= 2 and not re.search(r"\[\[SUP:", cleaned_ann):
            if not author_annotated_parts and re.match(r"^(?:and|&)\s+", plain_no_sup):
                continue
            prev_ends_open = bool(last_author_meta and re.search(r"(?:,|\band|&)\s*$", last_author_meta["plain"], re.IGNORECASE))
            probe_src = re.sub(r"\s+", " ", re.sub(r"\[\[SUP:[^\]]+\]\]", " ", cleaned_ann)).strip()
            probe_chunks = [
                re.sub(
                    r"^(?:and|&)$",
                    "",
                    re.sub(r"\s+(?:and|&)$", "", re.sub(r"^(?:and|&)\s+", "", ch.strip(), flags=re.IGNORECASE), flags=re.IGNORECASE),
                    flags=re.IGNORECASE,
                ).rstrip(SYMBOL_MARKER_CHARS + " ,;")
                for ch in re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", probe_src, flags=re.IGNORECASE)
                if ch.strip()
            ]
            probe_chunks = [ch for ch in probe_chunks if ch]
            if not prev_ends_open and (
                MIXED_CASE_AI_ORG_LINE_RE.fullmatch(plain_no_sup)
                or (probe_chunks and all(MIXED_CASE_AI_ORG_LINE_RE.fullmatch(ch) for ch in probe_chunks))
            ):
                if author_annotated_parts and not is_two_col:
                    break
                continue
            def _valid_hanging_given(tok: str) -> bool:
                parts = tok.split()
                if not parts or len(parts) > 4:
                    return False
                if len(parts) == 1:
                    t0 = parts[0]
                    if not t0[0].isupper():
                        return False
                    if _is_known_location_tail(t0) or (len(t0) >= 2 and t0.isupper()):
                        return False
                    if re.sub(r"[^a-z0-9]", "", t0.lower()) in KNOWN_NON_CITY_ORG_HEADS:
                        return False
                    return bool(re.fullmatch(r"[A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ'’.-]*", t0))
                return (
                    parts[-1].lower().strip("'’.-") in _NOBILIARY_PARTICLES
                    and _is_valid_author_name(f"{tok} Smith")
                )
            next_is_wrapped_surname = False
            if idx + 1 < len(lines):
                next_ln = lines[idx + 1]
                next_ann = _annotate_line_with_markers(next_ln)
                next_no_sup = _clean_ws(re.sub(r"\[\[SUP:[^\]]+\]\]", " ", next_ann))
                next_first_chunk = (
                    re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", next_no_sup, maxsplit=1, flags=re.IGNORECASE)[0]
                    .strip()
                    .rstrip(SYMBOL_MARKER_CHARS + " ,;")
                )
                next_fc_toks = next_first_chunk.split()
                next_is_nobiliary_surname = (
                    len(next_fc_toks) in (2, 3)
                    and next_fc_toks[0].lower() in _NOBILIARY_PARTICLES
                    and next_fc_toks[-1][0].isupper()
                )
                next_cand = next_first_chunk if (next_first_chunk and (len(next_fc_toks) == 1 or next_is_nobiliary_surname)) else _clean_ws(next_ln["text"])
                next_cand_ok_shape = (
                    len(next_cand.split()) == 1
                    and bool(re.fullmatch(r"[A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ][A-Za-zÀ-ÖØ-öø-ÿĀ-žḀ-ỿ'’.-]*", next_cand))
                ) or next_is_nobiliary_surname
                if (
                    next_cand_ok_shape
                    and abs(next_ln["base_size"] - ln["base_size"]) <= 0.5
                    and not EMAIL_OR_URL_LINE_RE.search(next_cand)
                    and not _has_affiliation_hint(next_cand)
                    and not _is_known_location_tail(next_cand)
                    and not DATE_LINE_RE.match(next_cand)
                    and not FOOTNOTE_ROLE_RE.match(next_cand)
                    and not VENUE_OR_STATUS_RE.match(next_cand)
                    and not SECTION_META_HEADING_RE.match(next_cand)
                    and not RESOURCE_LABEL_ONLY_RE.match(next_cand)
                    and not ABSTRACT_START_RE.match(next_cand)
                    and re.sub(r"[^a-z0-9]", "", next_cand.lower()) not in KNOWN_NON_CITY_ORG_HEADS
                ):
                    next_is_wrapped_surname = True
            # Also check if chunk 0 completes a hanging 1-token given name from the previous line
            # (e.g. "Alice Brown, Bob White, Xinchen" + "Yuan, Carol Davis").
            prev_hanging_tok = ""
            if author_annotated_parts and last_author_meta is not None and not prev_ends_open:
                prev_tail_raw = (
                    re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", last_author_meta["gap_plain"], flags=re.IGNORECASE)[-1]
                    .strip()
                    .rstrip(SYMBOL_MARKER_CHARS + " ,;")
                )
                if _valid_hanging_given(prev_tail_raw):
                    prev_hanging_tok = prev_tail_raw
            eff_chunks = list(probe_chunks)
            if prev_hanging_tok and eff_chunks and _is_valid_author_name(f"{prev_hanging_tok} {eff_chunks[0]}"):
                eff_chunks[0] = f"{prev_hanging_tok} {eff_chunks[0]}"
            all_chunks_author_ok = bool(eff_chunks) and (
                all(_is_valid_author_name(ch) for ch in eff_chunks)
                or (
                    len(eff_chunks) >= 2
                    and next_is_wrapped_surname
                    and all(_is_valid_author_name(ch) for ch in eff_chunks[:-1])
                    and _valid_hanging_given(eff_chunks[-1])
                )
            )
            if not all_chunks_author_ok:
                if author_annotated_parts and not is_two_col:
                    break
                continue
        # Stop if we hit a sentence-like body paragraph (lowercase words > 5 and no commas/markers/gaps)
        if len(plain_no_sup.split()) >= 7 and not re.search(r"\[\[SUP:|\[\[GAP\]\]|,|and\b", cleaned_ann):
            if author_annotated_parts:
                break
            continue
        # If all previously collected author lines were unmarked and significantly larger font (> +1.5pt)
        # than this multi-author line, they were wrapped subtitle/title fragments — drop them and start here.
        if (
            author_annotated_parts
            and last_author_meta is not None
            and not any("[[SUP:" in p for p in author_annotated_parts)
            and last_author_meta["size"] > ln["base_size"] + 1.5
            and (
                re.search(r"\[\[SUP:", cleaned_ann)
                or len([ch for ch in re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", plain_no_sup, flags=re.IGNORECASE) if ch.strip()]) >= 2
            )
        ):
            author_annotated_parts.clear()
            consumed_indices.clear()
        author_annotated_parts.append(cleaned_ann)
        consumed_indices.add(idx)
        last_author_meta = {
            "plain": plain_no_sup,
            "gap_plain": _clean_ws(re.sub(r"\[\[SUP:[^\]]+\]\]", " ", cleaned_ann)),
            "size": ln["base_size"],
            "width": float(ln["x1"] - ln["x0"]),
        }

    if not author_annotated_parts:
        return [], consumed_indices

    # Join lines: handle wrapped surname across line break — standalone next-line surname
    # ("... and Nur Yağmur" + "Tuncer"), mid-author wrap followed by more authors
    # ("..., Xinrong Lin[[SUP:2]], Xinchen" + "Yuan[[SUP:3]], ..."), and nobiliary surname wraps
    # ("... Gonzalo" + "de Polavieja[[SUP:7]]").
    joined_lines: list[str] = []
    for part in author_annotated_parts:
        plain = _clean_ws(re.sub(r"\[\[SUP:[^\]]+\]\]|\[\[GAP\]\]", " ", part))
        tokens = plain.split()
        can_join_prev = (
            bool(joined_lines)
            and not re.search(r"[,;]", joined_lines[-1].rstrip()[-1:])
            and not joined_lines[-1].rstrip().endswith("]]")
        )
        should_join = False
        if can_join_prev:
            if len(tokens) == 1:
                should_join = True
            else:
                prev_plain = _clean_ws(re.sub(r"\[\[SUP:[^\]]+\]\]", " ", joined_lines[-1]))
                prev_last_raw = (
                    re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", prev_plain, flags=re.IGNORECASE)[-1]
                    .strip()
                    .rstrip(SYMBOL_MARKER_CHARS + " ,;")
                )
                prev_last_toks = prev_last_raw.split()
                cur_first_raw = (
                    re.split(
                        r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ",
                        _clean_ws(re.sub(r"\[\[SUP:[^\]]+\]\]", " ", part)),
                        maxsplit=1,
                        flags=re.IGNORECASE,
                    )[0]
                    .strip()
                    .rstrip(SYMBOL_MARKER_CHARS + " ,;")
                )
                cur_first_toks = cur_first_raw.split()
                prev_ends_cap_nobiliary = (
                    2 <= len(prev_last_toks) <= 4
                    and prev_last_toks[-1][0].isupper()
                    and prev_last_toks[-1].lower().strip("'’.-") in _NOBILIARY_PARTICLES
                )
                cur_is_single_or_nobiliary = (
                    (len(cur_first_toks) == 1 and (cur_first_toks[0][0].isupper() or (prev_ends_cap_nobiliary and cur_first_toks[0][0].islower())))
                    or (
                        len(cur_first_toks) in (2, 3)
                        and cur_first_toks[0].lower() in _NOBILIARY_PARTICLES
                        and (cur_first_toks[-1][0].isupper() or (cur_first_toks[-2][0].isupper() and cur_first_toks[-1][0].islower()))
                    )
                )
                prev_is_hanging = (
                    (len(prev_last_toks) == 1 and prev_last_toks[0][0].isupper())
                    or (
                        2 <= len(prev_last_toks) <= 4
                        and prev_last_toks[-1].lower().strip("'’.-") in _NOBILIARY_PARTICLES
                    )
                )
                if (
                    prev_is_hanging
                    and cur_is_single_or_nobiliary
                    and _is_valid_author_name(f"{prev_last_raw} {cur_first_raw}")
                ):
                    should_join = True
        if should_join:
            joined_lines[-1] = joined_lines[-1].rstrip() + " " + part.lstrip()
        else:
            joined_lines.append(part)

    # Split each line into author chunks on [[GAP]], commas (outside [[SUP:...]]), ' and ', ' & '
    all_chunks: list[str] = []
    for part in joined_lines:
        # Merge arbitrarily long adjacent superscript marker chains in one O(n) pass
        merged_sup = re.sub(
            r"\[\[SUP:[^\]]+\]\](?:\s*,\s*\[\[SUP:[^\]]+\]\])+",
            lambda m: "[[SUP:" + ",".join(re.findall(r"\[\[SUP:([^\]]+)\]\]", m.group(0))) + "]]",
            part,
        )
        # Protect [[SUP:...]] tokens while splitting on commas
        sup_store: list[str] = []

        def _stash(m: re.Match) -> str:
            sup_store.append(m.group(0))
            return f"__SUPTOKEN{len(sup_store) - 1}__"

        protected = re.sub(r"\s+", " ", re.sub(r"\[\[SUP:[^\]]+\]\]", _stash, merged_sup)).strip()
        # Split between an author's trailing superscript marker and a space-separated next author name
        # (e.g. "Chenyang Le[[SUP:1,∗]] Pei Zhang[[SUP:2,3]]" with 8.3pt gap < 10pt [[GAP]] threshold).
        protected = re.sub(r"(__SUPTOKEN\d+__) (?=[A-ZÀ-ÖØ-ÞĀ-Ž\u1e00-\u1eff\u3400-\u9fff])", r"\1 [[GAP]] ", protected)
        # Split on [[GAP]], commas, semicolons, " and ", " & " (strictly O(n) after ws collapse)
        raw_chunks = re.split(r"\[\[GAP\]\]| ?[,;] ?| (?:and|&) ", protected, flags=re.IGNORECASE)
        for ch in raw_chunks:
            ch = re.sub(r"^(?:and|&)$", "", ch.strip(), flags=re.IGNORECASE)
            ch = re.sub(r"^(?:and|&)\s+", "", ch, flags=re.IGNORECASE)
            ch = re.sub(r"\s+(?:and|&)$", "", ch, flags=re.IGNORECASE).strip()
            if not ch:
                continue
            restored = re.sub(r"__SUPTOKEN(\d+)__", lambda m: sup_store[int(m.group(1))], ch)
            all_chunks.append(restored)

    for chunk in all_chunks:
        markers: list[str] = []
        for m in re.finditer(r"\[\[SUP:([^\]]+)\]\]", chunk):
            for mk in _parse_marker_string(m.group(1)):
                if mk not in markers:
                    markers.append(mk)
        name_raw = re.sub(r"\[\[SUP:[^\]]+\]\]", "", chunk)
        # Also catch trailing non-superscript symbol markers glued to names (strictly O(n) reverse scan)
        tail_rstripped = name_raw.rstrip()
        sym_start = len(tail_rstripped)
        while sym_start > 0 and tail_rstripped[sym_start - 1] in SYMBOL_MARKER_CHARS:
            sym_start -= 1
        if sym_start < len(tail_rstripped):
            for mk in _parse_marker_string(tail_rstripped[sym_start:]):
                if mk not in markers:
                    markers.append(mk)
            name_raw = tail_rstripped[:sym_start]
        name = _clean_ws(name_raw).strip(" ,;:")
        name = re.sub(r"^(?:(?:Assoc|Asst)\.?\s+)?(?:Prof|Dr)\.?\s+", "", name, flags=re.IGNORECASE).strip()
        if not _is_valid_author_name(name):
            continue
        # Filter out pure role markers (like '*' when '*' is NOT an affiliation marker)
        aff_markers = [mk for mk in markers if mk in defined_markers]
        if not aff_markers and defined_markers:
            # Keep non-role markers for diagnostic completeness
            aff_markers = [mk for mk in markers if mk not in role_markers]
        authors.append({"name": name, "markers": aff_markers, "rawMarkers": markers})

    return authors, consumed_indices


def _try_mode_thanks(header_lines: list[dict], footnote_lines: list[dict], page_w: float) -> tuple[list[dict], str] | None:
    """Mode B: Parse IEEEtran Page-1 bottom footnotes ('A, B, and C are with ...')."""
    if not footnote_lines:
        return None
    # Strip stray section headings (e.g. "I. INTRODUCTION") that occasionally fall near the bottom of Page 1
    footnote_lines = [
        ln for ln in footnote_lines
        if not re.fullmatch(r"(?:[IVX]+\.|[1-9]\.?)\s+(?:INTRODUCTION|ABSTRACT|BACKGROUND|OVERVIEW)", ln["text"].strip(), re.IGNORECASE)
    ]
    if not footnote_lines:
        return None
    # Partition footnote lines into left/right columns BEFORE proximity row-clustering so an unrelated
    # right-column line's y0 can never shift a left-column row's cluster anchor and drop fragments.
    mid_x = page_w * 0.50 if page_w > 0 else 306.0

    def _cluster_column(col_lines: list[dict], single_column: bool = False) -> list[dict]:
        by_y = sorted(col_lines, key=lambda r: (r["y0"], r["x0"]))
        y_rows: list[list[dict]] = []
        for ln in by_y:
            if y_rows and abs(ln["y0"] - y_rows[-1][0]["y0"]) <= 2.5:
                y_rows[-1].append(ln)
            else:
                y_rows.append([ln])
        col_merged: list[dict] = []
        for row in y_rows:
            row.sort(key=lambda r: r["x0"])
            row_merged: list[dict] = []
            for ln in row:
                # Inside an already-isolated half-column, justified narrow lines can have wide inter-word gaps (up to 60pt)
                max_word_gap = 60.0 if single_column else min(26.0, max(12.0, ln.get("base_size", 8.0) * 3.0))
                if row_merged and -2.0 <= (ln["x0"] - row_merged[-1]["x1"]) < max_word_gap:
                    prev = row_merged[-1]
                    prev["text"] = _clean_ws(f"{prev['text']} {ln['text']}")
                    prev["x1"] = max(prev["x1"], ln["x1"])
                    prev["y0"] = min(prev["y0"], ln["y0"])
                else:
                    row_merged.append({
                        "text": ln["text"],
                        "x0": ln["x0"],
                        "x1": ln["x1"],
                        "y0": ln["y0"],
                    })
            col_merged.extend(row_merged)
        return sorted(col_merged, key=lambda r: (r["y0"], r["x0"]))

    def _bridges_center_same_row(band_lines: list[dict]) -> bool:
        """Strictly O(L log L) exact check for any pair (a, b) with |a.y0 - b.y0| <= 2.5,
        a.x0 < mid_x <= b.x0, and -2.0 <= b.x0 - a.x1 < 12.0 using 1pt-bucketed lazy min/max heaps."""
        y_sorted = sorted(band_lines, key=lambda r: (r["y0"], r["x0"]))
        # Each side maintains per-1pt-bucket: active count, lazy min-heap (val, id), lazy max-heap (-val, id)
        left_count: dict[int, int] = {}
        left_min: dict[int, list[tuple[float, int]]] = {}
        left_max: dict[int, list[tuple[float, int]]] = {}
        right_count: dict[int, int] = {}
        right_min: dict[int, list[tuple[float, int]]] = {}
        right_max: dict[int, list[tuple[float, int]]] = {}
        removed: set[int] = set()

        def _add(side_count, side_min, side_max, val: float, item_id: int) -> None:
            bk = math.floor(val)
            side_count[bk] = side_count.get(bk, 0) + 1
            heapq.heappush(side_min.setdefault(bk, []), (val, item_id))
            heapq.heappush(side_max.setdefault(bk, []), (-val, item_id))

        def _remove(side_count, val: float, item_id: int) -> None:
            removed.add(item_id)
            bk = math.floor(val)
            cnt = side_count.get(bk, 0) - 1
            if cnt <= 0:
                side_count.pop(bk, None)
            else:
                side_count[bk] = cnt

        def _bucket_min(side_min, bk: int) -> float | None:
            h = side_min.get(bk)
            if not h:
                return None
            while h and h[0][1] in removed:
                heapq.heappop(h)
            return h[0][0] if h else None

        def _bucket_max(side_max, bk: int) -> float | None:
            h = side_max.get(bk)
            if not h:
                return None
            while h and h[0][1] in removed:
                heapq.heappop(h)
            return -h[0][0] if h else None

        def _has_value_in_range(side_count, side_min, side_max, lo: float, hi: float, lo_inc: bool, hi_inc: bool) -> bool:
            bk_lo = math.floor(lo)
            bk_hi = math.floor(hi)
            for bk in range(bk_lo, bk_hi + 1):
                if side_count.get(bk, 0) <= 0:
                    continue
                if bk > bk_lo and bk < bk_hi:
                    return True
                if bk == bk_lo and bk == bk_hi:
                    mn = _bucket_min(side_min, bk)
                    mx = _bucket_max(side_max, bk)
                    if mn is None or mx is None:
                        continue
                    # Since hi - lo == 14.0, bk_lo < bk_hi always holds, so this branch is defensive only.
                    if (mx >= lo if lo_inc else mx > lo) and (mn <= hi if hi_inc else mn < hi):
                        return True
                elif bk == bk_lo:
                    mx = _bucket_max(side_max, bk)
                    if mx is not None and (mx >= lo if lo_inc else mx > lo):
                        return True
                else:
                    mn = _bucket_min(side_min, bk)
                    if mn is not None and (mn <= hi if hi_inc else mn < hi):
                        return True
            return False

        row_start = 0
        for idx_y, cur in enumerate(y_sorted):
            cur_y = cur["y0"]
            while row_start < idx_y and (cur_y - y_sorted[row_start]["y0"]) > 2.5:
                old = y_sorted[row_start]
                if old["x0"] < mid_x:
                    _remove(left_count, old["x1"], row_start)
                else:
                    _remove(right_count, old["x0"], row_start)
                row_start += 1
            if cur["x0"] < mid_x:
                # Standard IEEEtran/TPAMI 2-column gutter is ~11.5-12pt; only genuine continuous full-width text (< 6.5pt gap) bridges center.
                if _has_value_in_range(right_count, right_min, right_max, cur["x1"] - 2.0, cur["x1"] + 6.5, True, False):
                    return True
                _add(left_count, left_min, left_max, cur["x1"], idx_y)
            else:
                if _has_value_in_range(left_count, left_min, left_max, cur["x0"] - 6.5, cur["x0"] + 2.0, False, True):
                    return True
                _add(right_count, right_min, right_max, cur["x0"], idx_y)
        return False

    if page_w > 0 and len(footnote_lines) >= 2:
        full_width_lines = sorted(
            [ln for ln in footnote_lines if ln["x0"] < mid_x - 20.0 and ln["x1"] > mid_x + 20.0],
            key=lambda r: (r["y0"], r["x0"]),
        )
        col_local_lines = [ln for ln in footnote_lines if not (ln["x0"] < mid_x - 20.0 and ln["x1"] > mid_x + 20.0)]
        # Partition col_local_lines into vertical bands separated by full_width_lines in O(L log L) time via bisect.
        bands: list[list[dict]] = [[] for _ in range(len(full_width_lines) + 1)]
        fw_rows: list[list[dict]] = [[fw] for fw in full_width_lines]
        fw_y0s = [fw["y0"] for fw in full_width_lines]
        for ln in col_local_lines:
            fi = bisect.bisect_left(fw_y0s, ln["y0"] - 2.5)
            if fi < len(fw_y0s):
                if abs(ln["y0"] - fw_y0s[fi]) <= 2.5:
                    fw_rows[fi].append(ln)
                else:
                    bands[fi].append(ln)
            else:
                bands[len(fw_y0s)].append(ln)
        ordered = []
        for bi, band in enumerate(bands):
            if band:
                left_col = [ln for ln in band if ln["x0"] < mid_x]
                right_col = [ln for ln in band if ln["x0"] >= mid_x]
                has_left = any(ln["x0"] < mid_x - 20.0 for ln in left_col)
                has_right = bool(right_col)
                if has_left and has_right and not _bridges_center_same_row(band):
                    ordered.extend(_cluster_column(left_col, single_column=True))
                    ordered.extend(_cluster_column(right_col, single_column=True))
                else:
                    ordered.extend(_cluster_column(band))
            if bi < len(fw_rows):
                ordered.extend(_cluster_column(fw_rows[bi]))
    else:
        ordered = _cluster_column(footnote_lines)
    # Rejoin hyphenated PDF line breaks within footnote text
    raw_lines = [ln["text"] for ln in ordered]
    combined_parts: list[str] = []
    for line_text in raw_lines:
        if combined_parts and combined_parts[-1].endswith("-") and re.match(r"^[a-z]", line_text):
            combined_parts[-1] = combined_parts[-1][:-1] + line_text
        else:
            combined_parts.append(line_text)
    footnote_text = _clean_ws(" ".join(combined_parts))
    if not footnote_text:
        return None

    # Split into sentences cleanly (respecting abbreviations like Co., Ltd., Dr., Dept., Univ., Inc., Prof., St., No.)
    # Rejoin hyphenated "e- mail:" artifacts and swallow any trailing "." after "(e-mail: ...)."
    footnote_text = re.sub(r"\be-\s+mail\b", "e-mail", footnote_text, flags=re.IGNORECASE)
    cleaned_for_split = (
        re.sub(r"\((?:e-?mail|emails?|corresponding\s+author)[^()]*\)\s*\.?", " . ", footnote_text, flags=re.IGNORECASE)
        if ("(" in footnote_text and ")" in footnote_text)
        else footnote_text
    )
    # Break after bare emails (no trailing period) when immediately followed by a new uppercase author clause
    cleaned_for_split = re.sub(
        r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\s+(?=[A-ZÀ-ÖØ-Þ])",
        r"\1 . ",
        cleaned_for_split,
    )
    abbr_ci_re = re.compile(
        r"\b(?:Co|Ltd|Inc|Corp|Dept|Univ|Lab|Tech|Inst|Prof|Dr|Mr|Ms|Jr|Sr|St|No|Vol|Fig|al|vs|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K)\.$",
        re.IGNORECASE,
    )
    verb_re = re.compile(
        r"\b(?:is|are|was|were)\s+(?:also\s+|now\s+)?(?:with|affiliated\s+with|from)\b",
        re.IGNORECASE,
    )
    _nobiliary_pat = r"(?:de|del|della|der|di|du|da|do|dos|das|la|le|lo|van|von|den|ten|ter|al|el|ben|ibn|bin|st\.?)"
    _thanks_tail_pred_pat = r"(?:(?:is|are|was|were)\s+(?:also\s+|now\s+)?(?:with|affiliated\s+with|from)\b|,|and\b|&)"
    surname_before_verb_re = re.compile(
        rf"^(?:(?:[^\W\d_]\.?\s+){{1,2}}[^\W\d_][\w'’-]*|(?:{_nobiliary_pat}\s+){{1,2}}[^\W\d_][\w'’-]*|[^\W\d_][\w'’-]*)(?=\s+{_thanks_tail_pred_pat})",
        re.IGNORECASE,
    )
    full_new_author_clause_re = re.compile(
        rf"^([^\W\d_][\w'’-]+)\s+([^\W\d_][\w'’-]+)(?:\s+[^\W\d_][\w'’-]+)?\s+{_thanks_tail_pred_pat}",
        re.IGNORECASE,
    )

    def _ends_with_name_initial(part_text: str, buf_has_verb: bool, nxt_part: str) -> bool:
        tok = part_text.rsplit(None, 1)[-1].lstrip("([\"'“‘") if part_text.strip() else ""
        if not tok.endswith(".") or tok in {"U.S.", "U.K.", "U.S.A.", "D.C.", "P.R.", "E.U."}:
            return False
        hp = tok.rsplit("-", 1)[-1]
        core = hp[:-1]
        if len(core) == 1 and core.isupper():
            if buf_has_verb and nxt_part:
                m_full = full_new_author_clause_re.match(nxt_part)
                if (
                    m_full
                    and m_full.group(1)[0].isupper()
                    and any(c.islower() for c in m_full.group(1)[1:])
                    and m_full.group(2)[0].isupper()
                    and m_full.group(1).lower().rstrip(".") not in _NOBILIARY_PARTICLES
                ):
                    return False
            return True
        if 2 <= len(core) <= 3 and core[0].isupper() and all(c.islower() for c in core[1:]):
            # Never confuse a 2-3 letter surname ending a complete sentence (e.g. "Corresponding author: Seokjin Lee.")
            # with a multi-letter given-name abbreviation like "Ch." or "Ph."
            part_toks = part_text.split()
            prev_tok = part_toks[-2].strip("([\"'“‘:,;") if len(part_toks) >= 2 else ""
            if prev_tok and len(prev_tok) >= 3 and prev_tok[0].isupper() and not prev_tok.endswith(".") and re.search(r"[a-z]", prev_tok):
                if re.search(r"corresponding\s+author|grant|foundation|dissertation|university|work\s+(?:was\s+)?(?:supported|funded)", part_text, re.IGNORECASE):
                    return False
                if nxt_part and full_new_author_clause_re.match(nxt_part):
                    return False
            return (not buf_has_verb) or bool(
                nxt_part and nxt_part[0].isupper() and surname_before_verb_re.match(nxt_part)
            )
        return False

    new_sentence_start_re = re.compile(
        r"^(?:(?:\d{1,2}|[∗*†‡⋆§¶‖∥+]+)\s*)?(?:This\s+(?:work|paper|research|study|article|manuscript)|An\s+earlier\s+version|"
        r"A\s+preliminary\s+version|Part\s+of\s+this|The\s+(?:authors?|work|paper|code|dataset|source)|"
        r"Manuscript\s+received|Digital\s+Object|Corresponding\s+author|"
        r"Work\s+(?:was\s+)?(?:done|supported|funded)|Supported\s+by|Funded\s+by|"
        r"Copyright|Email|E-?mail|GitHub|Code|Project|"
        r"Accepted|Preprint|Published|Submitted|Under\s+review|To\s+appear|Received)\b",
        re.IGNORECASE,
    )
    raw_parts = re.split(r"(?<=\.)\s+", cleaned_for_split)
    sentences: list[str] = []
    buf_parts: list[str] = []
    buf_has_verb = False
    for p_idx, part in enumerate(raw_parts):
        buf_parts.append(part)
        if not buf_has_verb and verb_re.search(part):
            buf_has_verb = True
        next_part = raw_parts[p_idx + 1] if p_idx + 1 < len(raw_parts) else ""
        next_lookahead = next_part
        if len(next_part) == 2 and next_part[0].isupper() and next_part[1] == ".":
            l_idx = p_idx + 2
            pieces = [next_part]
            while l_idx < len(raw_parts) and len(pieces) < 3:
                pieces.append(raw_parts[l_idx])
                if not (len(raw_parts[l_idx]) == 2 and raw_parts[l_idx][0].isupper() and raw_parts[l_idx][1] == "."):
                    break
                l_idx += 1
            next_lookahead = " ".join(pieces)
        if not (abbr_ci_re.search(part) or _ends_with_name_initial(part, buf_has_verb, next_lookahead)) or (next_part and new_sentence_start_re.match(next_part)):
            sentences.append(" ".join(buf_parts))
            buf_parts = []
            buf_has_verb = False
    if buf_parts:
        sentences.append(" ".join(buf_parts))

    header_authors, _ = _parse_authors_from_lines(header_lines, set(), set())
    def _name_fold_and_core_initials(raw_name: str) -> tuple[str, str, tuple[str, ...]]:
        fk = _fold_name_key(raw_name)
        ftoks = fk.split()
        if len(ftoks) >= 3:
            mids = tuple(t for t in ftoks[1:-1] if len(t) == 1)
            core_toks = [ftoks[0]] + [t for t in ftoks[1:-1] if len(t) > 1] + [ftoks[-1]]
            core = " ".join(core_toks) if len(core_toks) >= 2 else fk
            return fk, core, mids
        return fk, fk, ()

    known_header_profiles = [
        _name_fold_and_core_initials(ha["name"]) for ha in header_authors if _fold_name_key(ha["name"])
    ]
    known_exact_folds: set[str] = set()
    known_by_core: dict[str, list[tuple[str, ...]]] = {}
    for hfk, hcore, hmids in known_header_profiles:
        known_exact_folds.add(hfk)
        known_by_core.setdefault(hcore, []).append(hmids)

    def _matches_known_header_author(tok: str) -> bool:
        if not known_header_profiles:
            return False
        tfk, tcore, tmids = _name_fold_and_core_initials(tok)
        if not tfk:
            return False
        if tfk in known_exact_folds:
            return True
        bucket = known_by_core.get(tcore)
        if not bucket:
            return False
        for hmids in bucket:
            if not tmids or not hmids or tmids == hmids:
                return True
        return False

    author_aff_map: dict[str, tuple[str, list[str]]] = {}
    matched_sentences: list[str] = []
    clause_sep_re = re.compile(
        r"(\b(?:Inc|Ltd|Co|Corp|Univ|Dept|Lab|Labs|Tech|Inst|St|U\.S\.A|U\.K|U\.S|D\.C|S\.r\.l|B\.V|S\.A\.S|S\.A|A\.G|K\.K)\.)\s+(?:(?:and|while|whereas)\s+)?|,\s*(?:and|while|whereas)\s+|\s+(?:and|while|whereas)\s+|,\s+",
        re.IGNORECASE,
    )

    def _split_author_subject_tokens(subject: str) -> list[str]:
        return [
            re.sub(r"^(?:and|&)\s+", "", n.strip(), flags=re.IGNORECASE).strip()
            for n in re.split(r"\s*,\s*|\s+and\s+|\s*&\s*", subject.strip(), flags=re.IGNORECASE)
            if n.strip()
        ]

    def _split_thanks_clauses(sentence: str) -> list[str]:
        out: list[str] = []
        for semi_part in re.split(r"\s*;\s*", sentence):
            verbs = list(verb_re.finditer(semi_part))
            if len(verbs) <= 1:
                out.append(semi_part)
                continue
            cuts: list[tuple[int, int]] = []
            for v_idx in range(len(verbs) - 1):
                win_start = verbs[v_idx].end()
                win_end = verbs[v_idx + 1].start()
                window = semi_part[win_start:win_end]
                matches = list(clause_sep_re.finditer(window))
                tier3: list[tuple[int, int]] = []
                tier_dot: list[tuple[int, int]] = []
                tier2: list[tuple[int, int, bool, int]] = []
                tier1: list[tuple[int, int, str]] = []
                # Right-to-left suffix validation: each inter-separator segment is validated at most once -> strictly O(m).
                first_non_ws = len(window) - len(window.lstrip())
                suffix_valid = True
                suffix_all_known = bool(known_header_profiles)
                for mi in range(len(matches) - 1, -1, -1):
                    bm = matches[mi]
                    abbr_prefix = bm.group(1) or ""
                    is_abbr_dot = bool(abbr_prefix)
                    cut_rel_s = bm.start() + len(abbr_prefix)
                    cut_rel_e = bm.end()
                    if mi + 1 < len(matches):
                        nxt_m = matches[mi + 1]
                        nxt_abbr = nxt_m.group(1) or ""
                        nxt_boundary = nxt_m.start() + len(nxt_abbr)
                        nxt_is_author_joiner = (not nxt_abbr) and (
                            not re.search(r"\b(?:while|whereas)\b", nxt_m.group(0), re.IGNORECASE)
                        )
                        if not nxt_is_author_joiner:
                            suffix_valid = False
                            suffix_all_known = False
                    else:
                        nxt_boundary = len(window)
                    if not suffix_valid:
                        break
                    seg_text = window[cut_rel_e:nxt_boundary].strip()
                    seg_tokens = _split_author_subject_tokens(seg_text)
                    if not seg_tokens or not all(_is_valid_author_name(tok) for tok in seg_tokens):
                        suffix_valid = False
                        suffix_all_known = False
                        break
                    if suffix_all_known and not all(_matches_known_header_author(tok) for tok in seg_tokens):
                        suffix_all_known = False
                    if cut_rel_s <= first_non_ws:
                        continue
                    is_conj = bool(not is_abbr_dot and re.search(r"\b(?:and|while|whereas)\b", bm.group(0), re.IGNORECASE))
                    has_comma_conj = bool(not is_abbr_dot and re.match(r"^,\s*(?:and|while|whereas)\s+$", bm.group(0), re.IGNORECASE))
                    abs_s = win_start + cut_rel_s
                    abs_e = win_start + cut_rel_e
                    if suffix_all_known:
                        tier3.append((abs_s, abs_e))
                    elif is_abbr_dot:
                        tier_dot.append((abs_s, abs_e))
                    elif is_conj:
                        tier2.append((abs_s, abs_e, has_comma_conj, cut_rel_s))
                    else:
                        prev_comma = window.rfind(",", 0, cut_rel_s)
                        left_last_comma_seg = window[prev_comma + 1:cut_rel_s].strip()
                        tier1.append((abs_s, abs_e, left_last_comma_seg))
                tier3.reverse()
                tier_dot.reverse()
                tier2.reverse()
                tier1.reverse()
                chosen = None
                if tier3:
                    # Pick the leftmost Tier-3 cut so "MIT, Bob White and Carol Davis" cuts before Bob White
                    # rather than splitting inside the known-author list.
                    chosen = tier3[0]
                elif tier_dot:
                    chosen = tier_dot[0]
                elif tier2:
                    comma_t2 = [(s, e, rel_s) for s, e, is_cc, rel_s in tier2 if is_cc]
                    first_t2_start = tier2[0][0]
                    if comma_t2 and comma_t2[0][0] == first_t2_start:
                        # If there is only a single Oxford comma (", and <lastAuthor>") whose left side ends
                        # with >= 2 consecutive valid person names ("Stanford University, Bob White, Carol Davis"),
                        # cut at the earlier comma before those authors rather than inside the author list.
                        c_s, c_e, c_rel_s = comma_t2[0]
                        trailing_authors = 0
                        if len(comma_t2) == 1:
                            seg_end = c_rel_s
                            while seg_end > 0:
                                c_idx = window.rfind(",", 0, seg_end)
                                seg_piece = window[c_idx + 1:seg_end].strip()
                                if _is_valid_author_name(seg_piece):
                                    trailing_authors += 1
                                    if c_idx < 0:
                                        break
                                    seg_end = c_idx
                                else:
                                    break
                        earlier_t1 = [
                            (s, e) for s, e, last_seg in tier1
                            if e <= c_s and not _is_valid_author_name(last_seg)
                        ] if trailing_authors >= 2 else []
                        chosen = earlier_t1[0] if earlier_t1 else (c_s, c_e)
                    else:
                        earlier_t1 = [
                            (s, e) for s, e, last_seg in tier1
                            if e <= first_t2_start and not _is_valid_author_name(last_seg)
                        ]
                        chosen = earlier_t1[0] if earlier_t1 else (tier2[0][0], tier2[0][1])
                elif tier1:
                    chosen = (tier1[-1][0], tier1[-1][1])
                if chosen is not None:
                    cuts.append(chosen)
            pos = 0
            for c_start, c_end in cuts:
                out.append(semi_part[pos:c_start])
                pos = c_end
            out.append(semi_part[pos:])
        return out

    stmt_re = re.compile(
        r"^(.+?)\s+(?:is\s+also\s+with|are\s+also\s+with|is\s+now\s+with|are\s+now\s+with|"
        r"is\s+with|are\s+with|was\s+with|were\s+with|is\s+affiliated\s+with|are\s+affiliated\s+with|"
        r"is\s+from|are\s+from)\s+(.+)$",
        re.IGNORECASE,
    )
    elided_with_re = re.compile(
        r"^(.+?)\s+with\s+(?:the\s+)?(.+)$",
        re.IGNORECASE,
    )
    dual_inst_split_re = re.compile(
        r",?\s+and\s+(?:(?:is|are|was|were)\s+)?(?:also\s+|now\s+)?(?:with|affiliated\s+with)\s+",
        re.IGNORECASE,
    )
    collective_subject_re = re.compile(r"^(?:the|all)\s+authors$", re.IGNORECASE)

    pending_clauses: list[tuple[str, list[str], list[str]]] = []
    for sent in sentences:
        for clause in _split_thanks_clauses(sent):
            s = clause.lstrip(" .").strip(" ;")
            if s.endswith(".") and not _has_preserved_abbr_dot(s):
                s = s.rstrip(".")
            s = s.lstrip(" .").strip(" ;")
            if not s:
                continue
            m = stmt_re.match(s)
            if not m:
                m_elided = elided_with_re.match(s)
                if m_elided and _has_affiliation_hint(m_elided.group(2)):
                    m = m_elided
            if not m:
                continue
            names_part = m.group(1).strip()
            aff_raw = m.group(2).strip()
            # Handle elided second-author clause inside aff_raw, e.g. "... University, and R. Taupitz with Other Univ"
            aff_segments: list[str] = []
            sub_clauses: list[tuple[str, str]] = [(names_part, aff_raw)]
            m_tail_elided = re.search(
                r"(?:,\s*|\s+)and\s+([A-ZÀ-ÖØ-Þ][^,;]{1,50}?)\s+with\s+(.+)$",
                aff_raw,
            )
            if m_tail_elided:
                cand_name = m_tail_elided.group(1).strip()
                cand_aff = m_tail_elided.group(2).strip()
                if _is_valid_author_name(cand_name) and _has_affiliation_hint(cand_aff):
                    first_aff = aff_raw[:m_tail_elided.start()].strip(" ,;")
                    # Inherit shared parent university suffix ONLY on tight "<Subunit1> and <Name> with <Subunit2>, <SharedUniv>"
                    # (no ", and " clause break, no comma inside first_aff, explicit academic subunit in both halves,
                    # and first_aff contains NO standalone org/brand/acronym like "Google Research" or "MIT").
                    _elided_parent_re = re.compile(
                        r"\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|college|academy|polytechnique|politecnic[oa]|corp(?:oration)?|company|inc\.?|ltd\.?|gmbh)\b",
                        re.IGNORECASE,
                    )
                    _elided_subunit_re = re.compile(
                        r"\b(?:professorship|chair|dept\.?|department|departamento|dipartimento|school|faculty|division|lab|laboratory|center|centre|group|unit)\b",
                        re.IGNORECASE,
                    )
                    _elided_cand_subunit_re = re.compile(
                        r"\b(?:institute|professorship|chair|dept\.?|department|departamento|dipartimento|school|faculty|division|lab|laboratory|center|centre|group|unit)\b",
                        re.IGNORECASE,
                    )
                    _tight_and = not m_tail_elided.group(0).lstrip().startswith(",")
                    _first_has_brand_or_acronym = (
                        any(re.sub(r"[^a-z0-9]", "", tok.lower()) in KNOWN_NON_CITY_ORG_HEADS for tok in first_aff.split())
                        or any(re.fullmatch(r"[A-Z]{2,8}", tok.strip("()")) for tok in first_aff.split())
                    )
                    if (
                        _tight_and
                        and first_aff
                        and "," not in first_aff
                        and not _elided_parent_re.search(first_aff)
                        and _elided_subunit_re.search(first_aff)
                        and not _first_has_brand_or_acronym
                        and "," in cand_aff
                    ):
                        _comma_idx = cand_aff.find(",")
                        _cand_head = cand_aff[:_comma_idx].strip()
                        _shared_tail = cand_aff[_comma_idx + 1:].strip()
                        if _elided_cand_subunit_re.search(_cand_head) and _shared_tail and _elided_parent_re.search(_shared_tail):
                            first_aff = f"{first_aff}, {_shared_tail}"
                    sub_clauses = [
                        (names_part, first_aff),
                        (cand_name, cand_aff),
                    ]
            for sub_names_part, sub_aff_raw in sub_clauses:
                # Strip only leading parenthetical notes or stray wrapped "mail:" tokens
                sub_names_part = re.sub(r"^\([^()]*\)\s*", "", sub_names_part).strip()
                sub_names_part = re.sub(r"^(?:e-?mail|mail)\s*[:：]\s*", "", sub_names_part, flags=re.IGNORECASE).strip()
                if collective_subject_re.fullmatch(sub_names_part) and header_authors:
                    valid_names = [ha["name"] for ha in header_authors]
                else:
                    raw_names = _split_author_subject_tokens(sub_names_part)
                    valid_names = [n for n in raw_names if _is_valid_author_name(n)]
                    if not valid_names or len(valid_names) != len(raw_names):
                        continue
                # Split same-subject dual/multi affiliations: "X is with A, and is also with B"
                aff_parts = [p.strip(" ,;") for p in dual_inst_split_re.split(sub_aff_raw) if p.strip(" ,;")]
                if aff_parts:
                    pending_clauses.append((s, valid_names, aff_parts))

    all_known_thanks_index = _KnownAuthorIndex(
        [ha["name"] for ha in header_authors] + [nm for _, nms, _ in pending_clauses for nm in nms]
    )
    for s, valid_names, aff_parts in pending_clauses:
        cleaned_affs: list[str] = []
        for ap in aff_parts:
            aff = _sanitize_affiliation(re.sub(r"^the\s+", "", ap, flags=re.IGNORECASE), all_known_thanks_index)
            if aff and aff not in cleaned_affs:
                cleaned_affs.append(aff)
        if not cleaned_affs:
            continue
        matched_sentences.append(s)
        for nm in valid_names:
            key = _fold_name_key(nm)
            if key not in author_aff_map:
                author_aff_map[key] = (nm, [])
            for aff in cleaned_affs:
                if aff not in author_aff_map[key][1]:
                    author_aff_map[key][1].append(aff)

    if not author_aff_map:
        return None

    # Order authors by header appearance and require Mode B to cover all header authors
    # so a single-author "is now with ..." footnote never hijacks a full-header paper from Mode D/C.
    def _strip_middle_initials(folded: str) -> str:
        toks = folded.split()
        if len(toks) < 3:
            return folded
        return " ".join([toks[0]] + [t for t in toks[1:-1] if len(t) > 1] + [toks[-1]])

    def _middle_initials(folded: str) -> list[str]:
        toks = folded.split()
        if len(toks) < 3:
            return []
        return [t for t in toks[1:-1] if len(t) == 1]

    def _initial_surname_key(folded: str) -> tuple[str, str] | None:
        toks = folded.split()
        if len(toks) < 2:
            return None
        return (toks[0][0], toks[-1])

    def _initial_compatible(header_fold: str, thanks_fold: str) -> bool:
        ht = header_fold.split()
        tt = thanks_fold.split()
        if len(ht) < 2 or len(tt) < 2:
            return False
        if ht[-1] != tt[-1]:
            return False
        # At least one side uses an initial for given name (e.g. "c wei" vs "chang wei", "n f chen" vs "nancy f chen")
        if not (len(tt[0]) == 1 or len(ht[0]) == 1):
            return False
        if ht[0][0] != tt[0][0]:
            return False
        h_mids = [t[0] for t in ht[1:-1] if t]
        t_mids = [t[0] for t in tt[1:-1] if t]
        if h_mids and t_mids and h_mids != t_mids:
            return False
        return True

    result_authors: list[dict] = []
    used_keys: set[str] = set()
    if header_authors:
        exact_header_keys = {_fold_name_key(ha["name"]) for ha in header_authors}
        matched_by_idx: dict[int, list[str]] = {}
        # Pass 1: exact folded key match (reserves keys so non-exact aliases cannot steal them)
        for idx, ha in enumerate(header_authors):
            key = _fold_name_key(ha["name"])
            if key in author_aff_map and key not in used_keys:
                matched_by_idx[idx] = list(author_aff_map[key][1])
                used_keys.add(key)
        # Pass 2: unique middle-initial-compatible fallback (bijective, O(K) indexed by stripped fold)
        aff_by_stripped: dict[str, list[tuple[str, list[str]]]] = {}
        for k in author_aff_map:
            if k not in used_keys and k not in exact_header_keys:
                aff_by_stripped.setdefault(_strip_middle_initials(k), []).append((k, _middle_initials(k)))
        for idx, ha in enumerate(header_authors):
            if idx in matched_by_idx:
                continue
            ha_key = _fold_name_key(ha["name"])
            ha_stripped = _strip_middle_initials(ha_key)
            ha_mids = _middle_initials(ha_key)
            candidates = [
                k for k, k_mids in aff_by_stripped.get(ha_stripped, ())
                if k not in used_keys
                and not (ha_mids and k_mids and ha_mids != k_mids)
            ]
            if len(candidates) == 1:
                matched_by_idx[idx] = list(author_aff_map[candidates[0]][1])
                used_keys.add(candidates[0])
        # Pass 3: strict 1-to-1 bijective given-initial + surname match (IEEE standard "C. Wei" <-> "Chang Wei")
        unmatched_header = [
            (idx, _fold_name_key(ha["name"]))
            for idx, ha in enumerate(header_authors)
            if idx not in matched_by_idx
        ]
        unmatched_thanks = [k for k in author_aff_map if k not in used_keys and k not in exact_header_keys]
        if unmatched_header and unmatched_thanks:
            h_to_t: dict[int, list[str]] = {}
            t_to_h: dict[str, list[int]] = {}
            for idx, hkey in unmatched_header:
                for tk in unmatched_thanks:
                    if _initial_compatible(hkey, tk):
                        h_to_t.setdefault(idx, []).append(tk)
                        t_to_h.setdefault(tk, []).append(idx)
            for idx, cands in h_to_t.items():
                if len(cands) == 1 and len(t_to_h.get(cands[0], ())) == 1:
                    matched_by_idx[idx] = list(author_aff_map[cands[0]][1])
                    used_keys.add(cands[0])
        if len(matched_by_idx) < len(header_authors):
            return None
        for idx, ha in enumerate(header_authors):
            result_authors.append({"name": ha["name"], "affiliations": matched_by_idx[idx]})
    for key, (nm, affs) in author_aff_map.items():
        if key not in used_keys:
            result_authors.append({"name": nm, "affiliations": list(affs)})
    if not result_authors:
        return None
    evidence = "\n".join(raw_lines)
    return result_authors, evidence


def _try_mode_column_blocks(body_lines: list[dict], page_w: float) -> tuple[list[dict], str] | None:
    """Mode D: Multi-column or vertically stacked author cards (e.g. IEEEtran authorblockN + authorblockA)."""
    # Pre-filter tiny teaser-figure diagram labels (< 7.2pt) and cut off teaser/caption blocks below large vertical gaps
    # (prevents teaser figure labels from triggering >20pt span-gap aborts across valid author cards).
    filtered_body = [
        ln for ln in body_lines
        if ln["base_size"] >= 7.2
        or (len(ln["text"]) <= 3 and any(ord(c) >= 0x00A0 for c in ln["text"]))
    ]
    if not filtered_body:
        return None
    filtered_body.sort(key=lambda r: (r["y0"], r["x0"]))
    trimmed_body: list[dict] = []
    for ln in filtered_body:
        if re.match(r"^(?:figure|fig\.|table)\s+\d", ln["text"], re.IGNORECASE):
            break
        if trimmed_body and (ln["y0"] - max(r["y1"] for r in trimmed_body)) > 42.0:
            if not _has_affiliation_hint(ln["text"]) and "@" not in ln["text"] and not _is_valid_author_name(ln["text"]):
                break
        trimmed_body.append(ln)
    body_lines = trimmed_body
    # Group lines by PyMuPDF block; split any PyMuPDF block that merged two horizontally separated columns (> 25pt gutter)
    raw_blocks: dict[int, list[dict]] = {}
    for ln in body_lines:
        raw_blocks.setdefault(ln["block"], []).append(ln)

    blocks: dict[int, list[dict]] = {}
    next_bid = (max(raw_blocks.keys()) + 1) if raw_blocks else 0
    for bid, blines in raw_blocks.items():
        # Check if lines inside this block cleanly split across a vertical gutter (> 25pt)
        sub_lines: list[dict] = []
        split_needed = False
        for ln in blines:
            non_empty = [s for s in ln.get("spans", []) if s.get("text", "").strip()]
            # Split single line into span-chunks if spans have > 25pt horizontal gap
            if len(non_empty) >= 2 and any(
                non_empty[si + 1]["bbox"][0] - non_empty[si]["bbox"][2] > 25.0
                for si in range(len(non_empty) - 1)
            ):
                split_needed = True
                cur_spans = [non_empty[0]]
                for sp in non_empty[1:]:
                    if sp["bbox"][0] - cur_spans[-1]["bbox"][2] > 25.0:
                        txt_c = _clean_ws("".join("" if s.get("is_icon") else s["text"] for s in cur_spans))
                        if txt_c:
                            sub_lines.append({
                                **ln,
                                "spans": cur_spans,
                                "text": txt_c,
                                "x0": min(s["bbox"][0] for s in cur_spans),
                                "x1": max(s["bbox"][2] for s in cur_spans),
                                "y0": min(s["bbox"][1] for s in cur_spans),
                                "y1": max(s["bbox"][3] for s in cur_spans),
                            })
                        cur_spans = [sp]
                    else:
                        cur_spans.append(sp)
                txt_c = _clean_ws("".join("" if s.get("is_icon") else s["text"] for s in cur_spans))
                if txt_c:
                    sub_lines.append({
                        **ln,
                        "spans": cur_spans,
                        "text": txt_c,
                        "x0": min(s["bbox"][0] for s in cur_spans),
                        "x1": max(s["bbox"][2] for s in cur_spans),
                        "y0": min(s["bbox"][1] for s in cur_spans),
                        "y1": max(s["bbox"][3] for s in cur_spans),
                    })
            else:
                sub_lines.append(ln)
        if not split_needed:
            # Also check if two different lines on same y-row inside same block have > 25pt horizontal gap
            for ia in range(len(sub_lines)):
                for ib in range(ia + 1, len(sub_lines)):
                    if abs(sub_lines[ia]["y0"] - sub_lines[ib]["y0"]) <= 3.5:
                        lx, rx = (sub_lines[ia], sub_lines[ib]) if sub_lines[ia]["x0"] <= sub_lines[ib]["x0"] else (sub_lines[ib], sub_lines[ia])
                        if rx["x0"] - lx["x1"] > 25.0:
                            split_needed = True
                            break
                if split_needed:
                    break
        if split_needed and len(sub_lines) >= 2:
            # Find a clean vertical gutter x separating left and right clusters (greedy x-interval union)
            intervals = sorted((ln["x0"], ln["x1"]) for ln in sub_lines)
            merged_iv = [list(intervals[0])]
            for x0, x1 in intervals[1:]:
                if x0 <= merged_iv[-1][1] + 18.0:
                    merged_iv[-1][1] = max(merged_iv[-1][1], x1)
                else:
                    merged_iv.append([x0, x1])
            if len(merged_iv) >= 2:
                col_parts = [
                    [ln for ln in sub_lines if ln["x0"] >= gx0 - 2.0 and ln["x1"] <= gx1 + 2.0]
                    for gx0, gx1 in merged_iv
                ]
                # Only split a merged block into column cards when every split column looks like a rich multi-line card
                # (>= 3 lines or contains an email), preventing side-by-side "Author1 Author2 / Org1 Org2" rows from being split.
                if all(len(cp) >= 3 or any("@" in l["text"] for l in cp) for cp in col_parts):
                    for iv_idx, col_part in enumerate(col_parts):
                        if col_part:
                            blocks[bid if iv_idx == 0 else next_bid] = col_part
                            if iv_idx > 0:
                                next_bid += 1
                    continue
        blocks[bid] = blines
    if len(blocks) < 2:
        return None

    def _strip_block_author_markers(text: str) -> str:
        s = IEEE_MEMBER_RE.sub("", text)
        return re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"]", "", s).strip(" ,")

    def _is_author_only_block(blines: list[dict]) -> bool:
        usable = [
            ln for ln in blines
            if not (FOOTNOTE_ROLE_RE.match(ln["text"]) or DATE_LINE_RE.match(ln["text"]) or SECTION_META_HEADING_RE.match(ln["text"]))
        ]
        if not usable or len(usable) > 3:
            return False
        non_ai_org_lines = 0
        for ln in usable:
            t = ln["text"]
            if EMAIL_OR_URL_LINE_RE.search(t) or BARE_DOMAIN_FRAGMENT_RE.fullmatch(t.strip()):
                return False
            t_clean = _strip_block_author_markers(t)
            if _is_likely_author_enumeration(t_clean) or not _is_valid_author_name(t_clean):
                return False
            if NON_PERSON_AFFILIATION_RE.search(t) or AUTHOR_UPPERCASE_CORP_SUFFIX_RE.search(t) or _is_location_only_line(t):
                return False
            if not MIXED_CASE_AI_ORG_LINE_RE.fullmatch(t_clean):
                non_ai_org_lines += 1
        return non_ai_org_lines > 0

    def _is_aff_only_block(blines: list[dict], author_sz: float) -> bool:
        usable = [
            ln for ln in blines
            if not (FOOTNOTE_ROLE_RE.match(ln["text"]) or DATE_LINE_RE.match(ln["text"]) or SECTION_META_HEADING_RE.match(ln["text"]))
        ]
        if not usable:
            return False
        first_t = usable[0]["text"]
        first_clean = _strip_block_author_markers(first_t)
        if not EMAIL_OR_URL_LINE_RE.search(first_t) and usable[0]["base_size"] >= author_sz - 0.5 and _is_valid_author_name(first_clean):
            return False
        return any(
            _has_affiliation_hint(ln["text"])
            or _has_strong_unmarked_org_signal(_sanitize_affiliation(ln["text"]))
            or _is_location_only_line(ln["text"])
            or EMAIL_OR_URL_LINE_RE.search(ln["text"])
            for ln in usable
        )

    merged_blocks: dict[int, list[dict]] = {bid: sorted(bl, key=lambda r: (r["y0"], r["x0"])) for bid, bl in blocks.items()}
    consumed_aff_bids: set[int] = set()
    merged_author_bids: set[int] = set()
    for a_bid in sorted(merged_blocks, key=lambda b: (min(r["y0"] for r in merged_blocks[b]), min(r["x0"] for r in merged_blocks[b]))):
        if a_bid in consumed_aff_bids:
            continue
        a_lines = merged_blocks[a_bid]
        if not _is_author_only_block(a_lines):
            continue
        a_y1 = max(r["y1"] for r in a_lines)
        a_x0 = min(r["x0"] for r in a_lines)
        a_x1 = max(r["x1"] for r in a_lines)
        a_cx = (a_x0 + a_x1) / 2.0
        a_sz = max(r["base_size"] for r in a_lines)
        candidates = []
        for b_bid, b_lines in merged_blocks.items():
            if b_bid == a_bid or b_bid in consumed_aff_bids:
                continue
            b_y0 = min(r["y0"] for r in b_lines)
            dy = b_y0 - a_y1
            if dy < -2.0 or dy > 22.0:
                continue
            b_x0 = min(r["x0"] for r in b_lines)
            b_x1 = max(r["x1"] for r in b_lines)
            b_cx = (b_x0 + b_x1) / 2.0
            if abs(a_cx - b_cx) > 45.0 or min(a_x1, b_x1) < max(a_x0, b_x0) - 8.0:
                continue
            if _is_aff_only_block(b_lines, a_sz):
                candidates.append((dy, abs(a_cx - b_cx), b_bid))
        if candidates:
            candidates.sort()
            best_bid = candidates[0][2]
            merged_blocks[a_bid] = sorted(a_lines + merged_blocks[best_bid], key=lambda r: (r["y0"], r["x0"]))
            consumed_aff_bids.add(best_bid)
            merged_author_bids.add(a_bid)
    for bid in consumed_aff_bids:
        merged_blocks.pop(bid, None)
    blocks = merged_blocks
    if len(blocks) < 2:
        return None
    # Must have multiple horizontally separated blocks (distinct x-centers)
    # Match genuine wrapped org-suffix continuations (e.g. "Shanghai Jiao Tong" -> "University, Shanghai, China"
    # or "Shanghai Artificial" -> "Intelligence Laboratory"), never standalone "School of ..." / "Department of ..."
    # / "University of ..." / "Technology Center, ..." openings.
    org_continuation_start_re = re.compile(
        r"^(?:University|Institute|Institution|Laboratory|Laboratories|Intelligence|"
        r"Technologies|Technology|Group|Corp\.?|Corporation|Company|Inc\.?|Ltd\.?)"
        r"(?:\s*[,;.]|\s*$|\s+(?:Laboratory|Laboratories|Institute|Co\.?|Inc\.?|Ltd\.?)\b)",
        re.IGNORECASE,
    )
    def _line_font_style(ln_obj: dict) -> tuple[bool, bool]:
        spans = ln_obj.get("spans") or []
        word_spans = [s for s in spans if re.search(r"[A-Za-z\u3400-\u9fff]{2,}", s.get("text", ""))]
        sample = word_spans or spans
        is_bold = any((int(s.get("flags", 0)) & 16) != 0 for s in sample)
        is_italic = any((int(s.get("flags", 0)) & 2) != 0 for s in sample)
        return is_bold, is_italic

    card_authors: list[dict] = []
    card_x_centers: list[float] = []
    card_y_spans: list[tuple[float, float]] = []
    card_saw_emails: list[bool] = []
    card_used_merged = False
    card_blocks_used = 0
    for b_id, blines in sorted(blocks.items(), key=lambda kv: (min(r["y0"] for r in kv[1]), min(r["x0"] for r in kv[1]))):
        blines.sort(key=lambda r: (r["y0"], r["x0"]))
        # Reject Mode D if PyMuPDF merged two side-by-side column cards into a single block or single line
        # (two lines on the same visual row or two spans on one line separated horizontally by > 20pt).
        # Otherwise, merge tightly adjacent/overlapping same-row lines within the same block
        # (e.g. "Kalle ˚" + "Aström" -> "Kalle Åström").
        for i_a in range(len(blines)):
            non_empty_spans = [s for s in blines[i_a].get("spans", []) if s.get("text", "").strip()]
            for si in range(len(non_empty_spans) - 1):
                if non_empty_spans[si + 1]["bbox"][0] - non_empty_spans[si]["bbox"][2] > 20.0:
                    return None
            for i_b in range(i_a + 1, len(blines)):
                if abs(blines[i_a]["y0"] - blines[i_b]["y0"]) <= 3.0:
                    left_l, right_l = (blines[i_a], blines[i_b]) if blines[i_a]["x0"] <= blines[i_b]["x0"] else (blines[i_b], blines[i_a])
                    if right_l["x0"] - left_l["x1"] > 20.0:
                        return None
        rows: list[list[dict]] = []
        for ln_item in blines:
            if rows and abs(ln_item["y0"] - rows[-1][0]["y0"]) <= 3.0:
                rows[-1].append(ln_item)
            else:
                rows.append([ln_item])
        merged_blines: list[dict] = []
        for row in rows:
            if len(row) == 1:
                merged_blines.append(row[0])
                continue
            row.sort(key=lambda r: (r["x0"], r["y0"]))
            primary = max(row, key=lambda r: (len(r["text"].strip()), r["base_size"]))
            acc_text = row[0]["text"]
            acc_spans = list(row[0].get("spans") or [])
            for item in row[1:]:
                cur_text = item["text"]
                join_sep = (
                    ""
                    if (
                        acc_text.endswith(("\u02da", "\u00a8", "\u00b4", "\u02c6", "\u02dc", "\u02c7", "\u02d8", "\u00af", "\u02dd", "\u00b8", " "))
                        or cur_text.startswith(" ")
                    )
                    else " "
                )
                acc_text = acc_text + join_sep + cur_text
                acc_spans.extend(item.get("spans") or [])
            merged_blines.append({
                **primary,
                "text": _clean_ws(acc_text),
                "x0": min(r["x0"] for r in row),
                "x1": max(r["x1"] for r in row),
                "y0": min(r["y0"] for r in row),
                "y1": max(r["y1"] for r in row),
                "base_size": max(r["base_size"] for r in row),
                "max_size": max(r.get("max_size", r["base_size"]) for r in row),
                "spans": acc_spans,
            })
        blines = merged_blines
        # Look for author name line(s) followed by affiliation line(s) inside this block
        b_names: list[str] = []
        b_affs: list[tuple[str, str]] = []  # (cleaned, raw_line_text)
        card_email_domains: set[str] = set()
        for _ln_em in blines:
            for _dom in re.findall(r"@([a-z0-9.-]+\.[a-z]{2,})", _ln_em["text"], flags=re.IGNORECASE):
                _root = _dom.lower().split(".")[0]
                if len(_root) >= 4 and _root not in {"gmail", "yahoo", "hotmail", "outlook", "icloud", "proton", "protonmail", "foxmail", "163", "126", "qq", "live", "mail"}:
                    card_email_domains.add(_root)
        name_font_size: float | None = None
        name_is_bold: bool | None = None
        name_is_italic: bool | None = None
        saw_email_in_block = False
        prev_wrapped_email = False
        for li, ln in enumerate(blines):
            t = ln["text"]
            t_strip = t.strip()
            if prev_wrapped_email and " " not in t_strip and "." in t_strip:
                prev_wrapped_email = t_strip.endswith("-")
                saw_email_in_block = True
                continue
            prev_wrapped_email = False
            if EMAIL_OR_URL_LINE_RE.search(t) or BARE_DOMAIN_FRAGMENT_RE.fullmatch(t_strip):
                saw_email_in_block = True
                if "@" in t and t_strip.endswith("-"):
                    prev_wrapped_email = True
                continue
            if FOOTNOTE_ROLE_RE.match(t) or DATE_LINE_RE.match(t) or SECTION_META_HEADING_RE.match(t):
                continue
            t_no_ieee = IEEE_MEMBER_RE.sub("", t).rstrip(SYMBOL_MARKER_CHARS + "\uf02a").strip(" ,")
            t_no_markers = re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"\uf02a]", "", IEEE_MEMBER_RE.sub("", t)).strip(" ,")
            ln_bold, ln_italic = _line_font_style(ln)
            next_non_email_ln = next(
                (
                    blines[j]
                    for j in range(li + 1, len(blines))
                    if not EMAIL_OR_URL_LINE_RE.search(blines[j]["text"])
                    and not BARE_DOMAIN_FRAGMENT_RE.fullmatch(blines[j]["text"].strip())
                ),
                None,
            )
            next_style_match = (
                next_non_email_ln is not None
                and _line_font_style(next_non_email_ln) == (ln_bold, ln_italic)
            )
            looks_like_wrapped_org_prefix = bool(
                next_non_email_ln is not None
                and abs(next_non_email_ln["base_size"] - ln["base_size"]) <= 0.5
                and next_style_match
                and org_continuation_start_re.match(next_non_email_ln["text"].strip())
            )
            is_smaller_than_author = name_font_size is not None and ln["base_size"] < name_font_size - 0.5
            is_different_style_from_author = (
                name_is_bold is not None
                and ((name_is_bold and not ln_bold) or (not name_is_italic and ln_italic))
            )
            if (
                not is_smaller_than_author
                and not is_different_style_from_author
                and not (b_names and "," in t and _is_known_location_tail(t.rsplit(",", 1)[-1].strip()))
                and _is_likely_author_enumeration(t_no_markers)
            ):
                # Multi-author comma/and line inside a column card cannot be safely skipped while other columns match.
                return None
            has_later_explicit_aff = any(
                _has_affiliation_hint(blines[j]["text"])
                for j in range(li + 1, len(blines))
                if not EMAIL_OR_URL_LINE_RE.search(blines[j]["text"])
            )
            is_mixed_ai_org = bool(
                MIXED_CASE_AI_ORG_LINE_RE.fullmatch(t_no_ieee)
                and not (
                    b_names
                    and not is_smaller_than_author
                    and not is_different_style_from_author
                    and has_later_explicit_aff
                )
            )
            if (
                not b_affs
                and not saw_email_in_block
                and not is_smaller_than_author
                and not is_different_style_from_author
                and not is_mixed_ai_org
                and not looks_like_wrapped_org_prefix
                and _is_valid_author_name(t_no_ieee)
            ):
                b_names.append(t_no_ieee)
                if name_font_size is None:
                    name_font_size = ln["base_size"]
                    name_is_bold = ln_bold
                    name_is_italic = ln_italic
            elif b_names:
                if (
                    (b_affs or saw_email_in_block)
                    and not is_smaller_than_author
                    and not is_different_style_from_author
                    and not is_mixed_ai_org
                    and not looks_like_wrapped_org_prefix
                    and _is_valid_author_name(t_no_ieee)
                    and not NON_PERSON_AFFILIATION_RE.search(t)
                    and not _is_location_only_line(t)
                ):
                    return None
                cleaned = _sanitize_affiliation(t, b_names)
                cleaned_slug = re.sub(r"[^a-z0-9]", "", cleaned.lower()) if cleaned else ""
                is_card_email_brand = bool(cleaned and len(cleaned.split()) <= 2 and len(cleaned_slug) >= 4 and cleaned_slug in card_email_domains)
                if cleaned and (
                    _has_affiliation_hint(cleaned)
                    or _has_strong_unmarked_org_signal(cleaned)
                    or is_card_email_brand
                    or _is_location_only_line(cleaned)
                    or _is_known_location_tail(cleaned)
                    or is_smaller_than_author
                    or is_different_style_from_author
                    or is_mixed_ai_org
                    or saw_email_in_block
                    or looks_like_wrapped_org_prefix
                    or (not _is_valid_author_name(t_no_ieee) and _is_plausible_unmarked_org_text(cleaned))
                ):
                    b_affs.append((cleaned, t_strip))
        if b_names and b_affs:
            aff_texts = [c for c, _ in b_affs]
            has_org_signal = (
                any(
                    _has_affiliation_hint(a)
                    or _has_strong_unmarked_org_signal(a)
                    or (len(a.split()) <= 2 and len(re.sub(r"[^a-z0-9]", "", a.lower())) >= 4 and re.sub(r"[^a-z0-9]", "", a.lower()) in card_email_domains)
                    for a in aff_texts
                )
                or (
                    len(aff_texts) >= 2
                    and any(_is_location_only_line(a) or _is_known_location_tail(a) for a in aff_texts)
                    and any(
                        not _is_location_only_line(a) and not _is_known_location_tail(a)
                        and _is_plausible_unmarked_org_text(a)
                        for a in aff_texts
                    )
                )
            )
            if not has_org_signal:
                return None
            combined_parts: list[str] = []
            for pi, (cleaned_part, raw_part) in enumerate(b_affs):
                if pi == 0:
                    combined_parts.append(cleaned_part)
                else:
                    prev_clean, prev_raw = b_affs[pi - 1]
                    if prev_raw.endswith(","):
                        combined_parts.append(f", {cleaned_part}")
                    elif re.search(r"(?:\b(?:of|for|and|in|de|la|du)|&)$", prev_clean, re.IGNORECASE):
                        combined_parts.append(f" {cleaned_part}")
                    elif re.match(r"^(?:of|for|and|in|at|de|la|du)\s+", cleaned_part, re.IGNORECASE):
                        combined_parts.append(f" {cleaned_part}")
                    elif (
                        not _has_affiliation_hint(prev_clean)
                        and "," not in prev_clean
                        and org_continuation_start_re.match(cleaned_part)
                    ):
                        combined_parts.append(f" {cleaned_part}")
                    else:
                        combined_parts.append(f", {cleaned_part}")
            combined_aff = re.sub(r",\s*,+", ", ", "".join(combined_parts)).strip(" ,")
            for nm in b_names:
                card_authors.append({"name": nm, "affiliations": [combined_aff]})
            block_x_center = (min(r["x0"] for r in blines) + max(r["x1"] for r in blines)) / 2.0
            card_x_centers.append(block_x_center)
            card_y_spans.append((min(r["y0"] for r in blines), max(r["y1"] for r in blines)))
            card_saw_emails.append(saw_email_in_block)
            if b_id in merged_author_bids:
                card_used_merged = True
            card_blocks_used += 1
        elif b_names:
            return None
    min_x_sep = max(40.0, page_w * 0.15) if page_w > 0 else 40.0
    is_multi_col_cards = card_blocks_used >= 2 and len(card_authors) >= 2 and (max(card_x_centers) - min(card_x_centers)) >= min_x_sep
    # Allow single-column vertically stacked author cards ONLY when each block natively contains
    # its author + explicit org affiliation + its own email address (strictly disambiguating card boundaries
    # from stacked unmarked multi-org headers).
    sorted_ys = sorted(card_y_spans)
    is_vertical_stack_cards = (
        card_blocks_used >= 2
        and not card_used_merged
        and all(card_saw_emails)
        and len(card_authors) == card_blocks_used
        and all(sorted_ys[i][1] <= sorted_ys[i + 1][0] + 2.0 for i in range(len(sorted_ys) - 1))
        and all(
            any(_has_affiliation_hint(a) for a in au["affiliations"])
            for au in card_authors
        )
    )
    if is_multi_col_cards or is_vertical_stack_cards:
        evidence = "\n".join(ln["text"] for ln in body_lines)
        return card_authors, evidence
    return None


def _try_mode_inline_author_aff(merged_lines: list[dict]) -> tuple[list[dict], str] | None:
    """Mode E: ACM acmart / single-column inline 'AUTHOR NAME[*], Institution, Country' format."""
    if not merged_lines:
        return None
    inline_authors: list[dict] = []
    used_indices: list[int] = []
    idx = 0
    while idx < len(merged_lines):
        ln = merged_lines[idx]
        txt = ln["text"].strip()
        if not txt or ABSTRACT_START_RE.match(txt) or SECTION_META_HEADING_RE.match(txt):
            if inline_authors:
                break
            idx += 1
            continue
        if DATE_LINE_RE.match(txt) or VENUE_OR_STATUS_RE.match(txt) or FOOTNOTE_ROLE_RE.match(txt):
            idx += 1
            continue
        if "," in txt and not NON_AUTHOR_RESOURCE_RE.search(txt):
            left, right = txt.split(",", 1)
            left_clean = re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"\uf02a]", "", left).strip()
            right_clean = right.strip()
            # Require ALL-CAPS or Bold author name before comma AND explicit affiliation hint after comma
            letters = [c for c in left_clean if c.isalpha()]
            is_allcaps = len(letters) >= 4 and all(c.isupper() for c in letters)
            left_bold = any(
                (int(s.get("flags", 0)) & 16) != 0
                for s in ln.get("spans", [])
                if s["bbox"][0] <= ln["x0"] + 60.0 and re.search(r"[A-Za-z]", s.get("text", ""))
            )
            right_clean_no_sym = re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"\uf02a]", "", right_clean).strip(" ,;")
            right_has_org_start = bool(
                right_clean
                and not _is_valid_author_name(right_clean_no_sym)
                and not _is_likely_author_enumeration(right_clean_no_sym)
                and (_has_affiliation_hint(right_clean) or _has_strong_unmarked_org_signal(right_clean))
            )
            if (is_allcaps or left_bold) and _is_valid_author_name(left_clean) and right_has_org_start:
                aff_body = right_clean
                # Absorb 1-2 immediate wrapped continuation lines (smaller or same size, no author before comma)
                j = idx + 1
                while j < len(merged_lines) and j <= idx + 2:
                    nxt = merged_lines[j]
                    nt = nxt["text"].strip()
                    if not nt or ABSTRACT_START_RE.match(nt) or FOOTNOTE_ROLE_RE.match(nt) or NON_AUTHOR_RESOURCE_RE.search(nt):
                        break
                    if "," in nt:
                        nl, nr = nt.split(",", 1)
                        nl_c = re.sub(r"[" + re.escape(SYMBOL_MARKER_CHARS) + r"\uf02a]", "", nl).strip()
                        if _is_valid_author_name(nl_c) and (_has_affiliation_hint(nr) or _has_strong_unmarked_org_signal(nr)):
                            break
                    if (nxt["y0"] - merged_lines[j - 1]["y1"]) > 14.0:
                        break
                    if _looks_like_prose_sentence(nt) or DATE_LINE_RE.match(nt) or VENUE_OR_STATUS_RE.match(nt):
                        break
                    if _has_affiliation_hint(nt) or _is_location_only_line(nt) or _is_known_location_tail(nt) or aff_body.endswith(","):
                        aff_body = f"{aff_body} {nt}"
                        used_indices.append(j)
                        j += 1
                    else:
                        break
                inline_authors.append({"name": left_clean, "raw_aff": aff_body})
                used_indices.append(idx)
                idx = j
                continue
        if inline_authors:
            break
        idx += 1
    if len(inline_authors) >= 2:
        all_names = [a["name"] for a in inline_authors]
        sanitized_inline: list[dict] = []
        for a in inline_authors:
            cleaned_aff = _sanitize_affiliation(a["raw_aff"], all_names)
            if not (cleaned_aff and (_has_affiliation_hint(cleaned_aff) or _has_strong_unmarked_org_signal(cleaned_aff))):
                return None
            sanitized_inline.append({"name": a["name"], "affiliations": [cleaned_aff]})
        evidence = "\n".join(merged_lines[i]["text"] for i in sorted(set(used_indices)))
        return sanitized_inline, evidence
    return None


def extract_pdf_page1_authors_legacy(pdf_bytes: bytes) -> dict | None:
    with _PDF_AUTHOR_EXTRACT_LOCK:
        import pdf_author_extract_legacy as _legacy
        return _legacy.extract_pdf_page1_authors(pdf_bytes)


def extract_pdf_page1_authors_structured(pdf_bytes: bytes) -> dict | None:
    with _PDF_AUTHOR_EXTRACT_LOCK:
        return _extract_pdf_page1_authors_structured_locked(pdf_bytes)


def _extract_pdf_page1_authors_structured_locked(pdf_bytes: bytes) -> dict | None:
    if not isinstance(pdf_bytes, (bytes, bytearray)) or len(pdf_bytes) < 5 or len(pdf_bytes) > MAX_PDF_BYTES or not pdf_bytes.startswith(b"%PDF-"):
        return None
    pdf_sha = _sha256_bytes(bytes(pdf_bytes))
    try:
        with fitz.open(stream=bytes(pdf_bytes), filetype="pdf") as doc:
            if doc.needs_pass or len(doc) == 0:
                return None
            page = doc[0]
            if page.rect.width <= 0 or page.rect.height <= 0:
                return None
            header_lines, footnote_lines, page_w, _page_h = _extract_page1_lines(page)
    except Exception:
        return None

    if not header_lines:
        return None

    body_lines = _strip_title_lines(header_lines)
    if not body_lines:
        return None
    merged_lines, is_two_col = _merge_same_row_lines(body_lines, page_w)
    header_evidence = "\n".join(ln["text"] for ln in merged_lines)

    # --- Mode A: Marker-matched authors <-> marker-labeled affiliations ---
    aff_map, role_markers = _extract_marked_affiliations_from_lines(merged_lines)
    if footnote_lines:
        _, footnote_role_markers = _extract_marked_affiliations_from_lines(footnote_lines)
        role_markers = role_markers | footnote_role_markers
    if aff_map:
        defined_markers = set(aff_map.keys())
        parsed_authors, _ = _parse_authors_from_lines(merged_lines, defined_markers, role_markers, is_two_col=is_two_col)
        # Drop any aff_map entry whose value is an author name or multi-author enumeration (e.g. "* Alice Brown, Bob White, {a,b}@mit.edu")
        if parsed_authors:
            parsed_author_names = [au["name"] for au in parsed_authors]
            parsed_author_index = _KnownAuthorIndex(parsed_author_names)
            parsed_name_keys = parsed_author_index.exact_keys
            clean_aff_map = {
                mk: val for mk, val in aff_map.items()
                if _fold_name_key(val) not in parsed_name_keys
                and _count_known_author_names(val, parsed_author_index) < 2
                and not _is_likely_author_enumeration(val)
            }
            # Shared parent-university recovery: if EVERY marked affiliation is strictly a subunit
            # (Department/School/Lab/Division/Faculty/Center/Group) lacking a parent University/College/Corp,
            # and a single unmarked parent-institution line appears right below the marked lines, attach it.
            _subunit_re = re.compile(r"\b(?:dept\.?|department|school|faculty|division|center|centre|lab|labs|laborator(?:y|ies)|group|chair|program|unit)\b", re.IGNORECASE)
            _parent_org_re = re.compile(r"\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|college|academy|institute|institution|polytechnique|politecnic[oa]|corp(?:oration)?|company|inc\.?|ltd\.?|gmbh)\b", re.IGNORECASE)
            if clean_aff_map and all(_subunit_re.search(v) and not _parent_org_re.search(v) for v in clean_aff_map.values()):
                last_marked_idx = -1
                for li, ln in enumerate(merged_lines):
                    ann_l = _annotate_line_with_markers(ln).lstrip()
                    if ann_l.startswith("[[SUP:") and any(v[:20] in ln["text"] for v in clean_aff_map.values()):
                        last_marked_idx = li
                if last_marked_idx >= 0:
                    parent_cands: list[str] = []
                    for li in range(last_marked_idx + 1, min(len(merged_lines), last_marked_idx + 4)):
                        ptxt = merged_lines[li]["text"].strip()
                        if not ptxt or ABSTRACT_START_RE.match(ptxt) or NON_AUTHOR_RESOURCE_RE.search(ptxt) or FOOTNOTE_ROLE_RE.match(ptxt):
                            break
                        if _annotate_line_with_markers(merged_lines[li]).lstrip().startswith("[[SUP:"):
                            break
                        pclean = _sanitize_affiliation(ptxt, parsed_author_index)
                        if pclean and _parent_org_re.search(pclean) and not _looks_like_prose_sentence(pclean):
                            parent_cands.append(pclean)
                    if len(parent_cands) == 1:
                        parent_org = parent_cands[0]
                        clean_aff_map = {
                            mk: (val if parent_org.lower() in val.lower() else f"{val}, {parent_org}")
                            for mk, val in clean_aff_map.items()
                        }
            bound_authors = []
            resolved_count = 0
            for au in parsed_authors:
                affs = []
                for mk in au["markers"]:
                    val = clean_aff_map.get(mk)
                    if val and val not in affs:
                        affs.append(val)
                if affs:
                    resolved_count += 1
                bound_authors.append({"name": au["name"], "affiliations": affs})
            if resolved_count == len(parsed_authors) and resolved_count > 0:
                ev_sha = _sha256_text(header_evidence)
                return {
                    "contract": CONTRACT_V2,
                    "mode": "markers",
                    "pdfSha256": pdf_sha,
                    "sourceEvidence": header_evidence,
                    "sourceEvidenceSha256": ev_sha,
                    "sourceDomSha256": _sha256_text(f"{pdf_sha}:{ev_sha}"),
                    "authors": bound_authors,
                }

    # --- Mode B: IEEEtran Page-1 bottom footnotes ---
    thanks_res = _try_mode_thanks(merged_lines, footnote_lines, page_w)
    if thanks_res is not None:
        thanks_authors, thanks_evidence = thanks_res
        full_evidence = f"{header_evidence}\n---\n{thanks_evidence}"
        ev_sha = _sha256_text(full_evidence)
        return {
            "contract": CONTRACT_V2,
            "mode": "thanks",
            "pdfSha256": pdf_sha,
            "sourceEvidence": full_evidence,
            "sourceEvidenceSha256": ev_sha,
            "sourceDomSha256": _sha256_text(f"{pdf_sha}:{ev_sha}"),
            "authors": thanks_authors,
        }

    # --- Mode D: Multi-column or vertical author cards ---
    col_res = _try_mode_column_blocks(body_lines, page_w)
    if col_res is not None:
        col_authors, col_evidence = col_res
        ev_sha = _sha256_text(col_evidence)
        return {
            "contract": CONTRACT_V2,
            "mode": "column_blocks",
            "pdfSha256": pdf_sha,
            "sourceEvidence": col_evidence,
            "sourceEvidenceSha256": ev_sha,
            "sourceDomSha256": _sha256_text(f"{pdf_sha}:{ev_sha}"),
            "authors": col_authors,
        }

    # --- Mode E: Inline ACM acmart 'AUTHOR NAME, Institution, Country' ---
    inline_res = _try_mode_inline_author_aff(merged_lines)
    if inline_res is not None:
        inline_authors, inline_evidence = inline_res
        ev_sha = _sha256_text(inline_evidence)
        return {
            "contract": CONTRACT_V2,
            "mode": "inline_author_aff",
            "pdfSha256": pdf_sha,
            "sourceEvidence": inline_evidence,
            "sourceEvidenceSha256": ev_sha,
            "sourceDomSha256": _sha256_text(f"{pdf_sha}:{ev_sha}"),
            "authors": inline_authors,
        }

    # --- Mode C: Unmarked single shared institution ---
    # Supports standard single-column shared institution AND BMVC 2-column left-authors/right-single-institution.
    if not aff_map:
        parsed_authors, consumed_indices = _parse_authors_from_lines(merged_lines, set(), role_markers, is_two_col=is_two_col)
        if parsed_authors:
            author_names = [a["name"] for a in parsed_authors]
            author_index = _KnownAuthorIndex(author_names)
            # On multi-author papers, reject ANY unmatched alphanumeric or non-standard symbol marker (#, §, ¶, ◊, +, ⋆, ∥),
            # AND reject ANY symbol marker (even if classified in role_markers, e.g. "#Work performed at MIT.")
            # whose bottom footnote mentions an affiliation!
            _std_role_syms = {"∗", "*", "†", "‡", "✉"}
            _footnote_aff_syms: set[str] = set()
            _header_lower = header_evidence.lower()
            for _fln in (footnote_lines or []):
                _ftxt = _fln["text"].strip()
                if not _ftxt:
                    continue
                _f0 = _normalize_marker_token(_ftxt[0])
                _ftxt_no_contact = re.sub(r"\S+@\S+|https?://\S+|www\.\S+", " ", _ftxt[1:])
                if (_f0 in _std_role_syms or _ftxt[0] in SYMBOL_MARKER_CHARS) and _has_affiliation_hint(_ftxt_no_contact):
                    # Standard role symbols (*, †, ‡, ✉) saying "Work done during an internship at <same header org>"
                    # refer to the single shared institution itself; any other org or non-standard symbol (#, §, ...) fails closed.
                    _m_at = re.search(r"\b(?:at|with)\s+([^.;,]{3,80})", _ftxt_no_contact, re.IGNORECASE)
                    _same_header_org = bool(
                        _f0 in _std_role_syms
                        and _m_at
                        and _m_at.group(1).strip().lower() in _header_lower
                    )
                    if not _same_header_org:
                        _footnote_aff_syms.add(_f0)
            has_unmatched_marker = len(author_names) > 1 and any(
                any(
                    mk in _footnote_aff_syms
                    or (mk not in role_markers and mk not in _std_role_syms)
                    for mk in a.get("rawMarkers", [])
                )
                for a in parsed_authors
            )
            if not has_unmatched_marker:
                # Each entry: (text, first_ln, last_ln, first_idx, last_idx)
                inst_lines: list[tuple[str, dict, dict, int, int]] = []
                loc_lines: list[str] = []
                header_email_domains: set[str] = set()
                for _ml in merged_lines:
                    for _dom in re.findall(r"@([a-z0-9.-]+\.[a-z]{2,})", _ml["text"], flags=re.IGNORECASE):
                        _root = _dom.lower().split(".")[0]
                        if len(_root) >= 4 and _root not in {"gmail", "yahoo", "hotmail", "outlook", "icloud", "proton", "protonmail", "foxmail", "163", "126", "qq", "live", "mail"}:
                            header_email_domains.add(_root)
                ambiguous = False
                pre_unmarked_org_seen = False
                saw_resource_after_inst = False
                prev_header_y1: float | None = None
                start_idx = (max(consumed_indices) + 1) if consumed_indices else 0
                if consumed_indices and not is_two_col:
                    min_c, max_c = min(consumed_indices), max(consumed_indices)
                    for mid_idx in range(min_c + 1, max_c):
                        if mid_idx in consumed_indices:
                            continue
                        mid_txt = merged_lines[mid_idx]["text"]
                        if (
                            DATE_LINE_RE.match(mid_txt)
                            or FOOTNOTE_ROLE_RE.match(mid_txt)
                            or VENUE_OR_STATUS_RE.match(mid_txt)
                            or IEEE_MEMBER_ONLY_RE.match(mid_txt)
                        ):
                            continue
                        cleaned_mid = _sanitize_affiliation(mid_txt, author_index)
                        if cleaned_mid and (_has_affiliation_hint(cleaned_mid) or _is_plausible_unmarked_org_text(cleaned_mid)):
                            ambiguous = True
                            break
                # Single-author 2-column side-by-side affiliation recovery (e.g. left university column | right lab column):
                # split lines on wide horizontal gaps (>=20pt) instead of row-concatenating unrelated columns!
                if len(author_names) == 1 and not ambiguous:
                    post_author_lines = [
                        merged_lines[j]
                        for j in range(start_idx, len(merged_lines))
                        if not (
                            ABSTRACT_START_RE.match(merged_lines[j]["text"])
                            or re.match(r"^(?:figure|table)\s+\d", merged_lines[j]["text"], re.IGNORECASE)
                        )
                    ]
                    gap_rows = [
                        ln for ln in post_author_lines
                        if not (
                            EMAIL_OR_URL_LINE_RE.search(ln["text"])
                            or NON_AUTHOR_RESOURCE_RE.search(ln["text"])
                            or DATE_LINE_RE.match(ln["text"])
                            or VENUE_OR_STATUS_RE.match(ln["text"])
                            or FOOTNOTE_ROLE_RE.match(ln["text"])
                            or IEEE_MEMBER_ONLY_RE.match(ln["text"])
                        )
                        and any(sp.get("is_gap") and float(sp.get("gap_pt", 0.0)) >= 20.0 for sp in (ln.get("spans") or []))
                    ]
                    if gap_rows:
                        gap_midpoints = [
                            (sp["bbox"][0] + sp["bbox"][2]) / 2.0
                            for ln in gap_rows
                            for sp in (ln.get("spans") or [])
                            if sp.get("is_gap") and float(sp.get("gap_pt", 0.0)) >= 20.0
                        ]
                        col_mid_x = sorted(gap_midpoints)[len(gap_midpoints) // 2] if gap_midpoints else page_w * 0.5
                        col_buckets: dict[int, list[str]] = {}
                        col_locs: dict[int, list[str]] = {}
                        col_valid = True
                        for ln in post_author_lines:
                            txt_l = ln["text"]
                            if ABSTRACT_START_RE.match(txt_l) or re.match(r"^(?:figure|table)\s+\d", txt_l, re.IGNORECASE):
                                break
                            if DATE_LINE_RE.match(txt_l) or FOOTNOTE_ROLE_RE.match(txt_l) or VENUE_OR_STATUS_RE.match(txt_l) or IEEE_MEMBER_ONLY_RE.match(txt_l):
                                continue
                            # Split spans on wide column gaps (>=20pt), tracking each segment's x-span
                            seg_items: list[tuple[str, float]] = []
                            cur_seg: list[str] = []
                            cur_x0: float | None = None
                            for sp in (ln.get("spans") or []):
                                if sp.get("is_gap") and float(sp.get("gap_pt", 0.0)) >= 20.0:
                                    s_txt = _clean_ws("".join(cur_seg))
                                    if s_txt:
                                        seg_items.append((s_txt, cur_x0 if cur_x0 is not None else ln["x0"]))
                                    cur_seg = []
                                    cur_x0 = None
                                else:
                                    if cur_x0 is None and sp.get("text", "").strip():
                                        cur_x0 = float(sp["bbox"][0])
                                    cur_seg.append(sp.get("text", ""))
                            if cur_seg:
                                s_txt = _clean_ws("".join(cur_seg))
                                if s_txt:
                                    seg_items.append((s_txt, cur_x0 if cur_x0 is not None else ln["x0"]))
                            if len(seg_items) > 2:
                                col_valid = False
                                break
                            for seg_idx, (seg, seg_x0) in enumerate(seg_items):
                                if EMAIL_OR_URL_LINE_RE.search(seg) or NON_AUTHOR_RESOURCE_RE.search(seg) or BARE_DOMAIN_FRAGMENT_RE.fullmatch(seg):
                                    continue
                                ci = seg_idx if len(seg_items) == 2 else (0 if seg_x0 < col_mid_x else 1)
                                c_seg = _sanitize_affiliation(seg, author_index)
                                if not c_seg or BARE_DOMAIN_FRAGMENT_RE.fullmatch(c_seg):
                                    continue
                                if _is_location_only_line(c_seg) or _is_known_location_tail(c_seg):
                                    col_locs.setdefault(ci, []).append(c_seg)
                                else:
                                    col_buckets.setdefault(ci, []).append(c_seg)
                        if col_valid and len(col_buckets) == 2 and all(col_buckets.get(ci) for ci in (0, 1)):
                            col_affs: list[str] = []
                            for ci in (0, 1):
                                parts_c = list(col_buckets[ci])
                                if col_locs.get(ci) and col_locs[ci][0].lower() not in ", ".join(parts_c).lower():
                                    parts_c.append(col_locs[ci][0])
                                joined_c = ", ".join(parts_c)
                                if joined_c and (_has_affiliation_hint(joined_c) or _has_strong_unmarked_org_signal(joined_c)):
                                    col_affs.append(joined_c)
                            if len(col_affs) == 2:
                                ev_sha = _sha256_text(header_evidence)
                                return {
                                    "contract": CONTRACT_V2,
                                    "mode": "single_institution",
                                    "pdfSha256": pdf_sha,
                                    "sourceEvidence": header_evidence,
                                    "sourceEvidenceSha256": ev_sha,
                                    "sourceDomSha256": _sha256_text(f"{pdf_sha}:{ev_sha}"),
                                    "authors": [{"name": author_names[0], "affiliations": col_affs}],
                                }
                        # If a single-author paper has wide column gaps that didn't parse into 2 clean columns, fail closed rather than gluing columns!
                        ambiguous = True
                for idx in range(start_idx, len(merged_lines)):
                    if ambiguous:
                        break
                    ln = merged_lines[idx]
                    txt = ln["text"]
                    if ABSTRACT_START_RE.match(txt) or re.match(r"^(?:figure|table)\s+\d", txt, re.IGNORECASE):
                        break
                    if (
                        DATE_LINE_RE.match(txt)
                        or FOOTNOTE_ROLE_RE.match(txt)
                        or VENUE_OR_STATUS_RE.match(txt)
                        or IEEE_MEMBER_ONLY_RE.match(txt)
                    ):
                        prev_header_y1 = ln["y1"]
                        continue
                    # For multi-author papers, reject multi-institution side-by-side rows; single-author papers have no attribution ambiguity!
                    if len(author_names) > 1 and _is_multi_institution_unmarked_line(txt, ln["spans"], author_index):
                        ambiguous = True
                        break
                    if NON_AUTHOR_RESOURCE_RE.search(txt):
                        raw_res_parts: list[str] = []
                        ln_spans = ln.get("spans") or []
                        for si, sp in enumerate(ln_spans):
                            if sp.get("is_gap"):
                                raw_res_parts.append(" [[GAP]] ")
                                continue
                            if _span_is_superscript(sp, ln["base_size"], ln["base_y"]):
                                continue
                            if si > 0 and not ln_spans[si - 1].get("is_gap"):
                                gap = sp["bbox"][0] - ln_spans[si - 1]["bbox"][2]
                                if gap > 14.0:
                                    raw_res_parts.append(" [[GAP]] ")
                                elif gap > 1.8 and raw_res_parts and not raw_res_parts[-1].endswith((" ", "[[GAP]] ")):
                                    raw_res_parts.append(" ")
                            raw_res_parts.append(sp.get("text", ""))
                        raw_res_joined = "".join(raw_res_parts) if raw_res_parts else txt
                        if "," in raw_res_joined:
                            raw_res_joined = re.sub(
                                r"(\([^()]{1,120}(?:@|https?://|www\.)[^()]{0,120}\)|<[^<>]{1,120}(?:@|https?://|www\.)[^<>]{0,120}>|\[[^\[\]]{1,120}(?:@|https?://|www\.)[^\[\]]{0,120}\])\s*,\s*",
                                r"\1; ",
                                raw_res_joined,
                                flags=re.IGNORECASE,
                            )
                            raw_res_joined = re.sub(
                                r"((?<![^\s,;()<>[\]@])[^\s,;()<>[\]@]+@[^\s,;()<>[\]@]+|(?<![^\s,;()<>[\]])(?:https?://|www\.)[^\s,;()<>[\]]+)\s*,\s*",
                                r"\1; ",
                                raw_res_joined,
                                flags=re.IGNORECASE,
                            )
                        res_chunks = [
                            c.strip()
                            for c in re.split(r"\[\[GAP\]\]|[\u2002-\u200b\u3000]+|\t+| {2,}|[;；]", raw_res_joined)
                            if c.strip()
                        ] or [txt]
                        line_has_contact = "@" in txt or bool(re.search(r"https?://|www\.", txt, re.IGNORECASE))
                        line_email_domains = {
                            dm.lower().split(".")[0]
                            for dm in re.findall(r"@([a-z0-9.-]+\.[a-z]{2,})", txt, flags=re.IGNORECASE)
                            if len(dm.lower().split(".")[0]) >= 4
                        }
                        for res_chunk in res_chunks:
                            cleaned_res = _sanitize_affiliation(res_chunk, author_index)
                            is_indep_res = bool(cleaned_res and re.fullmatch(r"Independent\s+Researchers?(?:,\s*.+)?", cleaned_res, re.IGNORECASE))
                            res_slug = re.sub(r"[^a-z0-9]", "", re.sub(r"\s+ai$", "", cleaned_res.lower())) if cleaned_res else ""
                            matches_line_domain = bool(len(res_slug) >= 4 and res_slug in line_email_domains)
                            if cleaned_res and not _looks_like_prose_sentence(cleaned_res) and (
                                _has_affiliation_hint(cleaned_res)
                                or is_indep_res
                                or matches_line_domain
                                or (
                                    _is_plausible_unmarked_org_text(cleaned_res)
                                    and (
                                        len(inst_lines) >= 1
                                        or (
                                            line_has_contact
                                            and (not _is_valid_author_name(cleaned_res) or MIXED_CASE_AI_ORG_LINE_RE.fullmatch(cleaned_res))
                                        )
                                    )
                                )
                            ):
                                if len(inst_lines) == 0 and not _has_affiliation_hint(cleaned_res) and not is_indep_res and not matches_line_domain and not (
                                    _has_strong_unmarked_org_signal(cleaned_res) and len(cleaned_res.split()) <= 8
                                    and not MIXED_CASE_AI_ORG_LINE_RE.fullmatch(cleaned_res)
                                ):
                                    pre_unmarked_org_seen = True
                                else:
                                    inst_lines.append((cleaned_res, ln, ln, idx, idx))
                                if line_has_contact:
                                    saw_resource_after_inst = True
                            elif cleaned_res and line_has_contact and _is_location_only_line(cleaned_res):
                                left_key = re.sub(r"[^a-z0-9]", "", cleaned_res.split(",", 1)[0].lower())
                                inst0_norm = re.sub(r"[^a-z0-9]", "", inst_lines[0][0].lower()) if inst_lines else ""
                                domain_matches = (
                                    len(left_key) >= 3
                                    and not (inst0_norm and left_key in inst0_norm)
                                    and (
                                        any(
                                            left_key in re.sub(r"[^a-z0-9]", "", dm.lower())
                                            for dm in re.findall(r"@([a-z0-9.-]+)", txt, flags=re.IGNORECASE)
                                        )
                                        or any(
                                            left_key in re.sub(r"[^a-z0-9]", "", host.lower())
                                            for host in re.findall(r"(?:https?://|www\.)([a-z0-9.-]+)", txt, flags=re.IGNORECASE)
                                        )
                                    )
                                )
                                inst0_tail = (
                                    re.sub(r"\s+\d{4,6}$", "", inst_lines[0][0].rsplit(",", 1)[1].strip()).strip()
                                    if (inst_lines and "," in inst_lines[0][0])
                                    else ""
                                )
                                if not inst_lines:
                                    pre_unmarked_org_seen = True
                                elif (
                                    saw_resource_after_inst
                                    or loc_lines
                                    or (inst0_tail and _is_known_location_tail(inst0_tail))
                                    or domain_matches
                                ):
                                    ambiguous = True
                                    break
                                else:
                                    loc_lines.append(cleaned_res)
                                    saw_resource_after_inst = True
                            elif inst_lines and line_has_contact:
                                saw_resource_after_inst = True
                        if ambiguous:
                            break
                        prev_header_y1 = ln["y1"]
                        continue
                    has_email_ahead = any("@" in merged_lines[j]["text"] for j in range(idx + 1, len(merged_lines)))
                    if (
                        saw_resource_after_inst
                        and not has_email_ahead
                        and prev_header_y1 is not None
                        and (ln["y0"] - prev_header_y1) > 24.0
                        and not _has_affiliation_hint(txt)
                    ):
                        break
                    # Pre-join explicit hyphenated line wrap (e.g. "University of Tech-" + "nology, Eindhoven ...") BEFORE prose check
                    if (
                        txt.rstrip().endswith("-")
                        and _has_affiliation_hint(txt)
                        and idx + 1 < len(merged_lines)
                        and re.match(r"^[a-z]{2,}", merged_lines[idx + 1]["text"].strip())
                        and (merged_lines[idx + 1]["y0"] - ln["y1"]) < 24.0
                    ):
                        combined_hyph = txt.rstrip()[:-1] + merged_lines[idx + 1]["text"].strip()
                        cleaned_hyph = _sanitize_affiliation(combined_hyph, author_index)
                        if cleaned_hyph and not _looks_like_prose_sentence(cleaned_hyph):
                            inst_lines.append((cleaned_hyph, ln, merged_lines[idx + 1], idx, idx + 1))
                            prev_header_y1 = merged_lines[idx + 1]["y1"]
                            continue
                    # Skip the already-consumed second half of a hyphenated institution wrap
                    if inst_lines and idx == inst_lines[-1][4]:
                        prev_header_y1 = ln["y1"]
                        continue
                    if _looks_like_prose_sentence(txt):
                        prev_header_y1 = ln["y1"]
                        continue
                    cleaned = _sanitize_affiliation(txt, author_index)
                    prev_header_y1 = ln["y1"]
                    if not cleaned:
                        continue
                    if _looks_like_prose_sentence(cleaned) or len(cleaned) > 160 or len(cleaned.split()) > 18:
                        continue
                    # Coalesce explicit trailing-comma continuation line into the immediately preceding institution line
                    if (
                        inst_lines
                        and idx == inst_lines[-1][4] + 1
                        and not saw_resource_after_inst
                        and inst_lines[-1][2]["text"].rstrip().endswith(",")
                        and (ln["y0"] - inst_lines[-1][2]["y1"]) < 14.0
                        and abs(ln["base_size"] - inst_lines[-1][2]["base_size"]) <= 1.2
                        and (_has_affiliation_hint(cleaned) or _is_location_only_line(cleaned))
                    ):
                        prev_str, prev_first_ln, _prev_last_ln, prev_first_idx, _ = inst_lines[-1]
                        inst_lines[-1] = (f"{prev_str.rstrip(' ,')}, {cleaned}", prev_first_ln, ln, prev_first_idx, idx)
                        continue
                    if _has_affiliation_hint(cleaned) or re.fullmatch(r"Independent\s+Researchers?(?:,\s*.+)?", cleaned, re.IGNORECASE):
                        inst_lines.append((cleaned, ln, ln, idx, idx))
                    elif (
                        inst_lines
                        and _is_valid_author_name(cleaned)
                        and not MIXED_CASE_AI_ORG_LINE_RE.fullmatch(cleaned)
                        and not _is_location_only_line(cleaned)
                    ):
                        # Another person author appearing after an affiliation line means vertically stacked multi-author blocks
                        ambiguous = True
                        break
                    elif _is_location_only_line(cleaned):
                        inst0_tail = (
                            re.sub(r"\s+\d{4,6}$", "", inst_lines[0][0].rsplit(",", 1)[1].strip()).strip()
                            if (inst_lines and "," in inst_lines[0][0])
                            else ""
                        )
                        if (
                            inst_lines
                            and not saw_resource_after_inst
                            and not loc_lines
                            and not (inst0_tail and _is_known_location_tail(inst0_tail))
                        ):
                            loc_lines.append(cleaned)
                        elif inst_lines:
                            ambiguous = True
                            break
                        else:
                            pre_unmarked_org_seen = True
                    elif _is_plausible_unmarked_org_text(cleaned):
                        if len(inst_lines) >= 1:
                            inst_lines.append((cleaned, ln, ln, idx, idx))
                        elif not saw_resource_after_inst and (
                            not _is_valid_author_name(cleaned) or MIXED_CASE_AI_ORG_LINE_RE.fullmatch(cleaned)
                        ):
                            toks = cleaned.split()
                            cleaned_slug = re.sub(r"[^a-z0-9]", "", cleaned.lower())
                            is_email_domain_brand = bool(len(toks) <= 2 and len(cleaned_slug) >= 4 and cleaned_slug in header_email_domains)
                            is_known_brand_or_acronym = (
                                cleaned.isupper()
                                or bool(re.search(r"[a-z][A-Z]|[A-Z]{2,}[a-z]", cleaned))
                                or cleaned_slug in KNOWN_NON_CITY_ORG_HEADS
                                or any(re.sub(r"[^a-z0-9]", "", t.lower()) in KNOWN_NON_CITY_ORG_HEADS for t in toks)
                                or bool(NON_PERSON_ORG_TOKEN_CS_RE.search(cleaned))
                                or bool(re.search(r"\.(?:ai|io)\b", cleaned, re.IGNORECASE))
                                or is_email_domain_brand
                            )
                            if is_known_brand_or_acronym and len(toks) <= 8:
                                inst_lines.append((cleaned, ln, ln, idx, idx))
                            else:
                                pre_unmarked_org_seen = True

                # Hierarchical 2-line single-institution merge: ONLY when entries are strictly consecutive (no email/resource
                # separating them: idx2_start == idx1_end + 1), tight vertical gap, similar font size, and clear subunit <-> parent relation
                # (never merges two peer institutions like "Stanford University" + "Massachusetts Institute of Technology").
                if not ambiguous and not pre_unmarked_org_seen and len(inst_lines) == 2:
                    t1, ln1_first, ln1_last, idx1_first, idx1_last = inst_lines[0]
                    t2, ln2_first, ln2_last, idx2_first, idx2_last = inst_lines[1]
                    _sub_re = re.compile(r"\b(?:dept\.?|department|departamento|dipartimento|school|faculty|division|center|centre|lab|labs|laborator(?:y|ies)|group|chair|program|unit|research\s+group|institute\s+for)\b", re.IGNORECASE)
                    _top_re = re.compile(
                        r"\b(?:univ(?:ersit[yéèêiäöüa-z]*|ersidad|ersidade|ersit[àá]|ersit[äa]t)?|college|academy|polytechnique|politecnic[oa]|institute\s+of\s+technology|"
                        r"corp(?:oration)?|company|inc\.?|ltd\.?|gmbh|"
                        r"mit|cmu|epfl|kaist|cnrs|inria|riken|nict|nii|dfki|idiap|nus|ntu|snu|ustc|sjtu|cuhk|hkust|thu|pku|zju|ucla|ucsd|ucsb|uiuc|nyu|eth|ibm|aws|amd|arm|nec|ntt|unsw|kth|dtu|tum|lmu|rwth|cas|"
                        r"tencent|bytedance|google|deepmind|meta|microsoft|nvidia|amazon|apple|alibaba|huawei|baidu|openai|anthropic|adobe|sony|samsung|bosch|siemens|intel|qualcomm)\b",
                        re.IGNORECASE,
                    )
                    _known_subunit_acronyms = {
                        "LIACS", "CSAIL", "CLSP", "LTI", "DEIB", "IRIT", "LIG", "LIMSI",
                        "ISIR", "CVSSP", "CCRMA", "IDMT", "MIRMI", "DISI", "DIBRIS", "DIETI",
                    }
                    _independent_city_lab_re = re.compile(
                        r"^(?:shanghai|beijing|shenzhen|guangzhou|hangzhou|hong\s+kong|allen|vector|mila|peng\s*cheng|baai)\s+(?:ai\s+|artificial\s+intelligence\s+)?(?:lab|laboratory|institute|academy)\b",
                        re.IGNORECASE,
                    )
                    strictly_consecutive = (
                        idx2_first == idx1_last + 1
                        and not NON_AUTHOR_RESOURCE_RE.search(ln1_last["text"])
                        and not NON_AUTHOR_RESOURCE_RE.search(ln2_first["text"])
                    )
                    close_vert = strictly_consecutive and (ln2_first["y0"] - ln1_last["y1"]) < 16.0 and abs(ln2_first["base_size"] - ln1_last["base_size"]) <= 1.6
                    t1_has_loc = "," in t1 and _is_known_location_tail(re.sub(r"\s+\d{4,6}$", "", t1.rsplit(",", 1)[-1].strip()).strip())
                    t1_has_brand = any(re.sub(r"[^a-z0-9]", "", tok.lower()) in KNOWN_NON_CITY_ORG_HEADS for tok in t1.split())
                    t2_has_brand = any(re.sub(r"[^a-z0-9]", "", tok.lower()) in KNOWN_NON_CITY_ORG_HEADS for tok in t2.split())
                    t1_is_top = bool(_top_re.search(t1) or t1_has_brand or _independent_city_lab_re.match(t1))
                    t2_is_top = bool(_top_re.search(t2) or t2_has_brand or _independent_city_lab_re.match(t2))
                    both_are_top_orgs = bool(t1_is_top and t2_is_top)
                    is_hier_pair = close_vert and not t1_has_loc and not both_are_top_orgs and (
                        (_sub_re.search(t1) and not t1_is_top and (t2_is_top or _has_affiliation_hint(t2)))
                        or (t1_is_top and not _sub_re.search(t1) and ((_sub_re.search(t2) and not t2_is_top) or (t2.strip() in _known_subunit_acronyms)))
                        or (_sub_re.search(t1) and t1_is_top and _sub_re.search(t2) and not t2_is_top)
                        or (re.search(r"\b(?:of|for|and|in|at|the)\s*$", t1, re.IGNORECASE) is not None)
                        or (re.match(r"^(?:of|for|and|in|at)\s+", t2, re.IGNORECASE) is not None)
                    )
                    if is_hier_pair:
                        sep = " " if (re.search(r"\b(?:of|for|and|in|at|the)\s*$", t1, re.IGNORECASE) or re.match(r"^(?:of|for|and|in|at)\s+", t2, re.IGNORECASE)) else ", "
                        inst_lines = [(f"{t1.rstrip(' ,')}{sep}{t2}", ln1_first, ln2_last, idx1_first, idx2_last)]

                # Single-author papers may legitimately list multiple affiliations cleanly without ambiguity
                if len(author_names) == 1 and not ambiguous and not pre_unmarked_org_seen and len(inst_lines) >= 2:
                    dedup_affs: list[str] = []
                    for a_txt, _, _, _, _ in inst_lines:
                        if a_txt not in dedup_affs:
                            dedup_affs.append(a_txt)
                    if len(loc_lines) == 1 and loc_lines[0] not in dedup_affs[-1]:
                        dedup_affs[-1] = f"{dedup_affs[-1]}, {loc_lines[0]}"
                    ev_sha = _sha256_text(header_evidence)
                    return {
                        "contract": CONTRACT_V2,
                        "mode": "single_institution",
                        "pdfSha256": pdf_sha,
                        "sourceEvidence": header_evidence,
                        "sourceEvidenceSha256": ev_sha,
                        "sourceDomSha256": _sha256_text(f"{pdf_sha}:{ev_sha}"),
                        "authors": [{"name": author_names[0], "affiliations": dedup_affs}],
                    }

                # Accept ONLY a single unambiguous institution (joining any trailing city/country onto that affiliation)
                if not ambiguous and not pre_unmarked_org_seen and len(inst_lines) == 1:
                    aff0 = inst_lines[0][0]
                    if len(loc_lines) == 1 and loc_lines[0].lower() not in aff0.lower():
                        aff0 = f"{aff0}, {loc_lines[0]}"
                    affs = [aff0]
                    ev_sha = _sha256_text(header_evidence)
                    return {
                        "contract": CONTRACT_V2,
                        "mode": "single_institution",
                        "pdfSha256": pdf_sha,
                        "sourceEvidence": header_evidence,
                        "sourceEvidenceSha256": ev_sha,
                        "sourceDomSha256": _sha256_text(f"{pdf_sha}:{ev_sha}"),
                        "authors": [{"name": nm, "affiliations": list(affs)} for nm in author_names],
                    }

    return None


def extract_pdf_page1_authors_geometric(pdf_bytes: bytes) -> dict | None:
    with _PDF_AUTHOR_EXTRACT_LOCK:
        global _GEOMETRIC_GUARDS_ENABLED
        prev = _GEOMETRIC_GUARDS_ENABLED
        _GEOMETRIC_GUARDS_ENABLED = True
        try:
            result = extract_pdf_page1_authors_structured(pdf_bytes)
        finally:
            _GEOMETRIC_GUARDS_ENABLED = prev
    if isinstance(result, dict):
        return {**result, "contract": CONTRACT_V3}
    return result


def extract_pdf_page1_authors(pdf_bytes: bytes, contract: str = CONTRACT_V2) -> dict | None:
    with _PDF_AUTHOR_EXTRACT_LOCK:
        if contract in (CONTRACT_V1, "v1"):
            return extract_pdf_page1_authors_legacy(pdf_bytes)
        if contract in (CONTRACT_V2, "v2", None, ""):
            return extract_pdf_page1_authors_structured(pdf_bytes)
        if contract in (CONTRACT_V3, "v3"):
            return extract_pdf_page1_authors_geometric(pdf_bytes)
    raise ValueError(f"Unsupported PDF page-1 author contract: {contract}")


def read_pdf_file(path: Path) -> bytes:
    if not path.is_absolute():
        raise ValueError("PDF 路径必须是绝对路径")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(str(path), flags)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("PDF 必须是普通文件、不是符号链接且硬链接数为 1")
        if info.st_size > MAX_PDF_BYTES:
            raise ValueError(f"PDF 超过体积上限 {MAX_PDF_BYTES} 字节")
        with os.fdopen(fd, "rb") as handle:
            fd = -1
            data = handle.read(MAX_PDF_BYTES + 1)
    finally:
        if fd >= 0:
            os.close(fd)
    if len(data) != info.st_size or not data.startswith(b"%PDF-"):
        raise ValueError("PDF 文件在读取时发生变化或缺少 %PDF- 文件头")
    return data


def main() -> None:
    require_external_runtime("pdf_author_extract.py")
    if len(sys.argv) == 2 and sys.argv[1] == "3":
        import base64

        info = os.fstat(3)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise SystemExit("pdf_author_extract: fd 3 必须是普通单链接文件")
        max_json_bytes = int(MAX_PDF_BYTES * 4 // 3) + 1024 * 1024
        if info.st_size > max_json_bytes:
            raise SystemExit("pdf_author_extract: fd 3 输入超过体积上限")
        with os.fdopen(3, "rb") as handle:
            raw_json = handle.read(max_json_bytes + 1)
        if len(raw_json) != info.st_size:
            raise SystemExit("pdf_author_extract: fd 3 输入读取时发生变化")
        payload = json.loads(raw_json.decode("utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("pdfBase64"), str):
            raise SystemExit("pdf_author_extract: fd 3 缺少 pdfBase64 字段")
        contract = payload.get("contract", CONTRACT_V2)
        if contract not in (CONTRACT_V1, CONTRACT_V2, CONTRACT_V3, "v1", "v2", "v3"):
            raise SystemExit(f"pdf_author_extract: 不支持的提取合同 {contract}")
        pdf_bytes = base64.b64decode(payload["pdfBase64"], validate=True)
        if len(pdf_bytes) > MAX_PDF_BYTES or not pdf_bytes.startswith(b"%PDF-"):
            raise SystemExit("pdf_author_extract: fd 3 PDF 字节无效或超限")
        result = extract_pdf_page1_authors(pdf_bytes, contract=contract)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return
    parser = argparse.ArgumentParser(description="从 PDF 首页确定性提取作者与机构绑定")
    parser.add_argument("--pdf", type=Path, help="已封存 PDF 的绝对路径（不传则从 stdin 读取原始 PDF 字节）")
    parser.add_argument("--contract", default=CONTRACT_V2, choices=[CONTRACT_V1, CONTRACT_V2, CONTRACT_V3, "v1", "v2", "v3"], help="提取合同版本")
    args = parser.parse_args()
    if args.pdf is not None:
        pdf_bytes = read_pdf_file(args.pdf)
    else:
        pdf_bytes = sys.stdin.buffer.read(MAX_PDF_BYTES + 1)
        if len(pdf_bytes) > MAX_PDF_BYTES:
            raise SystemExit("pdf_author_extract: stdin PDF 超过体积上限")
    result = extract_pdf_page1_authors(pdf_bytes, contract=args.contract)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
