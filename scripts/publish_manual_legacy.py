#!/usr/bin/env python3
"""已退役 Manual v4/v5/v6 历史记录只读核验与兼容校验（从 publish_common.py 拆出）。

本模块不参与当前默认 API 日更生产，仅供旧记录冷核、历史兼容读取与回归测试调用；
所有符号均通过 scripts/publish_common.py 原名转导并保持 monkeypatch 钩子兼容。
"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure legacy helper is imported via publish_common, not a direct CLI.')

import contextvars
import hashlib
import json
import math
import os
import re
import struct
import sys
import unicodedata
from collections.abc import Mapping
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

_SHARED_SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)

from analysis_sections import (  # noqa: E402
    EVALUATION_TITLE,
    LEGACY_EVALUATION_TITLE,
    evaluation_heading_issue,
    normalize_analysis_section_title,
)
from manual_agent_policy import (  # noqa: E402
    CURRENT_MODEL_POLICY,
    LEGACY_MODEL_POLICY,
    analysis_identity_error,
    bound_analysis_model_policy,
)
from protocol_codec import historical_contract as historical_manual_contract  # noqa: E402

_ACTIVE_HOOKS: contextvars.ContextVar[Mapping | None] = contextvars.ContextVar(
    'publish_manual_legacy_hooks', default=None,
)


@contextmanager
def _hooks_scope(hooks: Mapping | None):
    if hooks is None:
        yield
        return
    token = _ACTIVE_HOOKS.set(hooks)
    try:
        yield
    finally:
        _ACTIVE_HOOKS.reset(token)


class _HookAccessor:
    def __getattr__(self, name: str):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        if name in globals():
            return globals()[name]
        pc = sys.modules.get('publish_common')
        if pc is None:
            pc = __import__('publish_common')
        if hasattr(pc, name):
            return getattr(pc, name)
        raise RuntimeError(f'publish_manual_legacy 缺少必需运行钩子: {name}')

    def get(self, name: str, default=None):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        if name in globals():
            return globals()[name]
        pc = sys.modules.get('publish_common')
        if pc is not None and hasattr(pc, name):
            return getattr(pc, name)
        return default


_H = _HookAccessor()


MANUAL_RESEARCH_CONTRACT = historical_manual_contract('manual-research-brief', 'audio-evidence')
MANUAL_DEPTH_SOURCE_CONTRACT = historical_manual_contract('manual-analysis-depth', 'baseline-source')
MANUAL_DEPTH_COVERAGE_CONTRACT = historical_manual_contract('manual-analysis-depth', 'source-coverage')
MANUAL_DEPTH_EXPLANATION_CONTRACT = historical_manual_contract('manual-analysis-depth', 'beginner-explanation')
MANUAL_DEPTH_READER_QUALITY_CONTRACT = historical_manual_contract('manual-analysis-depth', 'reader-quality')
MANUAL_DEPTH_FACT_COVERAGE_CONTRACT = historical_manual_contract('manual-analysis-depth', 'fact-coverage')
MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT = historical_manual_contract('manual-analysis-depth', 'signed-longform')
SIGNED_MANUAL_COMPATIBILITY_MODE = 'signed-v6-task-evidence-override-v1'
MANUAL_SIGNED_LONGFORM_CONTRACT = historical_manual_contract('manual-reader-longform', 'signed-blocks')
MANUAL_STRUCTURED_ARTIFACT_PARSER_CONTRACT = historical_manual_contract('manual-artifact-parser', 'structured-source')
MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT = historical_manual_contract('manual-paper-source-identity', 'per-paper-inputs')
MANUAL_DEPTH_CONTRACTS = frozenset({
    MANUAL_DEPTH_SOURCE_CONTRACT,
    MANUAL_DEPTH_COVERAGE_CONTRACT,
    MANUAL_DEPTH_EXPLANATION_CONTRACT,
    MANUAL_DEPTH_READER_QUALITY_CONTRACT,
    MANUAL_DEPTH_FACT_COVERAGE_CONTRACT,
    MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT,
})
MANUAL_READER_QUALITY_CONTRACTS = frozenset({
    MANUAL_DEPTH_READER_QUALITY_CONTRACT,
    MANUAL_DEPTH_FACT_COVERAGE_CONTRACT,
    MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT,
})
MANUAL_COMPLETE_STATUS = 'manual_complete'
MANUAL_COMPLETE_PROVENANCE_VERSION = 2
MANUAL_PROVENANCE_PROTOCOL = historical_manual_contract('manual-stage-attestation', 'source-bound-review')
MANUAL_STAGE_EXECUTION_KIND = 'manual_attestation'
MANUAL_BOUND_STAGE_CUTOFF_DATE = '2026-08-22'
MANUAL_AUDIT_CHECKS = frozenset({
    'sourceCoverage', 'promptConformance', 'factualClaimsLedger', 'scoreRecomputed',
    'methodContract', 'tableContract', 'boilerplateScan', 'finalContract',
})
MANUAL_STAGE_EVIDENCE_STAGES = (
    'imageDownload', 'primaryAnalysis', 'openSourceScan', 'demoLinkScan', 'revision',
    'tableRepair', 'methodRepair', 'structureRepair', 'scoringAudit', 'imageSupplement',
)
MANUAL_BOILERPLATE_PATTERNS = (
    re.compile(r'从复现角度(?:看)?[，,:：]'),
    re.compile(r'这样的边界很重要'),
    re.compile(r'本文的实验和图示应'),
    re.compile(r'对于未报告的参数、?硬件、?随机种子或服务版本'),
    re.compile(r'应按数据流逐项复核'),
    re.compile(r'不能把整条流水线的收益都归因'),
    re.compile(r'对于多模态系统，还要区分'),
)


def _validate_manual_rejected_image_coverage(paper, decisions, paper_label):
    """只有在完整、具体的全拒审查之后，Manual v5 才允许零张图片。

    这里刻意与 manual-research-contract.js 里的
    ``validateManualAllRejectedImageException`` 保持同构。记录/规格闸
    已经确认研究者审过图；发布阶段不应再提一套不同（而且更窄）的要求，
    比如移动端分辨率缺陷或图注里必须出现某个词。只要有一个针对该论文的
    视觉或技术锚点，并写明由此得出的编辑结论，就足够了。
    """
    image_manifest = paper.get('imageManifest') or {}
    candidates = image_manifest.get('candidates') or []
    if not candidates:
        return
    selected_top_level = paper.get('selectedImageUrls')
    selected_manifest = image_manifest.get('selected') or []
    insertion_plan = image_manifest.get('insertionPlan') or []
    if (not isinstance(selected_top_level, list) or selected_top_level
            or selected_manifest or insertion_plan):
        raise _H.PublishDataValidationError(
            f'{paper_label} manual v5 空选图例外必须同时绑定显式空 selectedImageUrls、空 selected 与空 insertionPlan'
        )
    candidate_urls = [item.get('url') for item in candidates if isinstance(item, dict)]
    decision_urls = [item.get('url') for item in decisions if isinstance(item, dict)]
    if (not candidate_urls or len(candidate_urls) != len(set(candidate_urls))
            or len(decision_urls) != len(candidate_urls)
            or len(decision_urls) != len(set(decision_urls))
            or set(decision_urls) != set(candidate_urls)):
        raise _H.PublishDataValidationError(
            f'{paper_label} manual v5 空选图例外的 figureReview 未逐项覆盖全文候选图'
        )
    normalized_reasons = set()
    specific_anchor = re.compile(
        r'\b\d{2,}\s*[×x]\s*\d{2,}\b'
        r'|[A-Za-z][A-Za-z0-9_-]{1,}'
        r'|(?:流程图|热图|散点|谱图|曲线|坐标|标签|面板|图注|模型|分类器|特征|数据集|设备|录音机|基线图|示意图|系统总览|矩阵|分布|公式|箭头|分桶|点位|声码器)',
        re.I,
    )
    generic_short_conclusion = re.compile(
        r'^(?:该图)?(?:不适合|不需要|无价值|移动端不可读|与正文重复)[，。；;\s]*(?:故)?(?:不选|拒绝)?[。.]?$',
    )
    for index, decision in enumerate(decisions):
        if not isinstance(decision, dict) or decision.get('decision') != 'reject':
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外必须全部为 reject，不能夹带 select'
            )
        reason = str(decision.get('reason') or '').strip()
        if len(reason) < 40:
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外的 reject 理由不足 40 字'
            )
        normalized_reason = _normalize_manual_evidence(reason).lower()
        if normalized_reason in normalized_reasons:
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外的第 {index + 1} 条理由不得跨图复用同一拒绝模板'
            )
        normalized_reasons.add(normalized_reason)
        if not specific_anchor.search(reason) or generic_short_conclusion.fullmatch(reason):
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v5 空选图例外的第 {index + 1} 条理由不是论文特有的像素/缓存/图注事实与论证影响'
            )

def _manual_js_number_text(value):
    """按 ECMAScript 的 Number::toString 写数字文本，与 Node 的 JSON.stringify 一致。

    json.dumps 用 repr：0.00002 写成 2e-05、1e17 写成 1e+17、整数浮点写成 1.0，
    而 Node 写 0.00002、100000000000000000、1。这些差异会让 manualSha256 与
    _manual_hash 对同一对象算出不同哈希。
    """
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return str(value)
    if value != value or value in (math.inf, -math.inf):
        return 'null'
    if value == 0:
        return '0'
    text = repr(float(value))
    negative = text.startswith('-')
    if negative:
        text = text[1:]
    mantissa, marker, exponent_text = text.partition('e')
    exponent = int(exponent_text) if marker else 0
    integer_part, _, fraction_part = mantissa.partition('.')
    combined = integer_part + fraction_part
    stripped = combined.lstrip('0')
    leading_zeros = len(combined) - len(stripped)
    digits = stripped.rstrip('0') or '0'
    # point 是十进制小数点相对 digits 首位的位置，对应 ECMAScript 算法里的 n。
    point = len(integer_part) - leading_zeros + exponent
    length = len(digits)
    if length <= point <= 21:
        body = digits + '0' * (point - length)
    elif 0 < point <= 21:
        body = f'{digits[:point]}.{digits[point:]}'
    elif -6 < point <= 0:
        body = '0.' + '0' * (-point) + digits
    else:
        exponent_out = point - 1
        head = digits if length == 1 else f'{digits[0]}.{digits[1:]}'
        body = f'{head}e{"+" if exponent_out >= 0 else "-"}{abs(exponent_out)}'
    return f'-{body}' if negative else body


def _assert_hash_key_premises(value, label):
    """核对 Node 与 Python 对同一个对象算哈希时，键必须满足的两条前提。

    键得是字符串：json.dumps 不给非字符串键加引号，{1: 'a'} 会写成 {1:"a"} 这种
    非法 JSON，而 Node 的 Object.keys 只给出字符串键，写的是 {"1":"a"}。
    键还得都在 BMP 内：Node 按 UTF-16 码元排序，Python 按码点排序，键里出现 emoji
    这类增补平面字符时两端顺序不同。两条前提失效时两端都不报错，只是算出不同的哈希。
    """
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_hash_key_premises(item, f'{label}[{index}]')
        return
    if not isinstance(value, dict):
        return
    for key, item in value.items():
        if not isinstance(key, str):
            raise _H.PublishDataValidationError(
                f'{label} 的对象键必须是字符串，实际是 {type(key).__name__} {key!r}；'
                'Python 会把它写成不带引号的 JSON 键，与 Node 的写法不同'
            )
        if any(ord(character) > 0xFFFF for character in key):
            raise _H.PublishDataValidationError(
                f'{label}.{key} 的对象键含 BMP 以外的字符；'
                'Python 按码点排序、Node 按 UTF-16 码元排序，两端顺序会不同'
            )
        _assert_hash_key_premises(item, f'{label}.{key}')


def _assert_ecmascript_number_premises(value, label):
    """核对 json.dumps 的 repr 数字写法与 Node 的 ECMAScript 写法一致。

    _stable_json_sha256 用 json.dumps 写数字，Node 的 stableFingerprint 用
    ECMAScript 的 Number::toString。四类取值会写出不同字节：整数取值的浮点
    （1.0 对 1）、绝对值小于 1e-4 的非整浮点（2e-05 对 0.00002）、负零
    （-0.0 对 0），以及 1e16 到 1e21 之间的浮点（1e+17 对 100000000000000000）。
    超出安全整数范围的整数也会在 Node 里丢精度。两端都会写、都会核验这些字段，
    出现这类取值时不会报错，只会让一端算出另一个哈希。
    """
    if isinstance(value, bool):
        return
    if isinstance(value, int):
        if abs(value) > (2 ** 53 - 1):
            raise _H.PublishDataValidationError(
                f'{label} 含超出 JSON 安全整数范围的整数 {value}；'
                'Node 读回时会丢精度，两端哈希会不同'
            )
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise _H.PublishDataValidationError(
                f'{label} 含非有限数值 {value!r}；Python 写 NaN/Infinity，Node 写 null'
            )
        ecmascript = _manual_js_number_text(value)
        if repr(value) != ecmascript:
            raise _H.PublishDataValidationError(
                f'{label} 的浮点数 {value!r} 在两端写法不同：'
                f'Python 写 {repr(value)}，Node 写 {ecmascript}，两端哈希会不同'
            )
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _assert_ecmascript_number_premises(item, f'{label}[{index}]')
        return
    if isinstance(value, dict):
        for key, item in value.items():
            _assert_ecmascript_number_premises(item, f'{label}.{key}')
        return


def _manual_canonical_json(value):
    if value is None:
        return 'null'
    if isinstance(value, (bool, int, float)):
        return _manual_js_number_text(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return '[' + ','.join(_manual_canonical_json(item) for item in value) + ']'
    if isinstance(value, dict):
        return '{' + ','.join(
            f'{json.dumps(key, ensure_ascii=False)}:{_manual_canonical_json(value[key])}'
            for key in sorted(value)
        ) + '}'
    # 其他类型交给 json.dumps，保持改动前的行为（含它抛出的 TypeError）。
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _manual_hash(value):
    _assert_hash_key_premises(value, 'manual 哈希输入')
    return hashlib.sha256(_manual_canonical_json(value).encode('utf-8')).hexdigest()

def _manual_paper_identity_mode(contracts, paper_label='paper'):
    contracts = contracts if isinstance(contracts, dict) else {}
    identity_marker = contracts.get('paperSourceIdentity')
    if identity_marker is None:
        if contracts.get('freshAuthoring') is not None \
                or contracts.get('tutorialPayload') is not None:
            raise _H.PublishDataValidationError(
                f'{paper_label} 声明了新写作或教程材料记录，但缺少逐篇来源身份记录。'
            )
        return 'historical_per_entry'
    if identity_marker != MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT:
        raise _H.PublishDataValidationError(
            f'{paper_label} 逐论文来源身份契约标记非法'
        )
    return 'per_paper_v1'


MANUAL_SIGNATURE_CONTRACT = historical_manual_contract('manual-signature', 'exact-decimal-nfkc')


def _prepare_manual_signature_input(value, label='manual-v6-signature'):
    """与 manual-signature-contract.js 共用的 v6 规范签名输入。

    对象 key 刻意限制为可见 ASCII。安全整数保持普通 JSON 整数；有限浮
    点数稍后按 IEEE-754 位模式写成精确的十进制 JSON 数字。字符串值仍
    然完整支持 Unicode；NFKC 文本归一化在 ``_normalize_signed_manual_text`` 里显式
    进行，而不是对签名 JSON 做看不见的改写。
    """
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, str):
        if any(0xD800 <= ord(character) <= 0xDFFF for character in value):
            raise _H.PublishDataValidationError(f'{label} 含非法 Unicode 代理项')
        return value
    if isinstance(value, int):
        if abs(value) > (2 ** 53 - 1):
            raise _H.PublishDataValidationError(f'{label} 含非安全整数')
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or (value == 0.0 and math.copysign(1.0, value) < 0):
            raise _H.PublishDataValidationError(f'{label} 签名对象禁止 NaN/Infinity 或负零')
        if value.is_integer() and abs(value) > (2 ** 53 - 1):
            raise _H.PublishDataValidationError(f'{label} 含非安全整数')
        return value
    if isinstance(value, list):
        return [
            _prepare_manual_signature_input(item, f'{label}[{index}]')
            for index, item in enumerate(value)
        ]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise _H.PublishDataValidationError(f'{label} 签名对象 key 必须是字符串')
        result = {}
        for key in sorted(value):
            if not key or any(ord(character) < 0x20 or ord(character) > 0x7E for character in key):
                raise _H.PublishDataValidationError(f'{label} 签名对象 key 必须是可见 ASCII')
            result[key] = _prepare_manual_signature_input(value[key], f'{label}.{key}')
        return result
    raise _H.PublishDataValidationError(f'{label} 含不可签名类型: {type(value).__name__}')


def _manual_signature_number_text(value):
    if isinstance(value, int):
        return str(value)
    bits = struct.unpack('>Q', struct.pack('>d', value))[0]
    negative = bits >> 63 == 1
    exponent_bits = (bits >> 52) & 0x7FF
    fraction = bits & ((1 << 52) - 1)
    significand = fraction if exponent_bits == 0 else (1 << 52) | fraction
    exponent2 = -1074 if exponent_bits == 0 else exponent_bits - 1023 - 52
    scale = 0
    if exponent2 >= 0:
        digits = significand << exponent2
    else:
        scale = -exponent2
        digits = significand * (5 ** scale)
        while scale > 0 and digits % 10 == 0:
            digits //= 10
            scale -= 1
    text = str(digits)
    if scale > 0:
        text = text.rjust(scale + 1, '0')
        text = f'{text[:-scale]}.{text[-scale:]}'
    return f'-{text}' if negative else text


def _manual_signature_canonical_json(value):
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if isinstance(value, (int, float)):
        return _manual_signature_number_text(value)
    if isinstance(value, list):
        return '[' + ','.join(_manual_signature_canonical_json(item) for item in value) + ']'
    return '{' + ','.join(
        f'{json.dumps(key, ensure_ascii=False)}:{_manual_signature_canonical_json(value[key])}'
        for key in sorted(value)
    ) + '}'


def _manual_signature_hash(value):
    canonical = _prepare_manual_signature_input(value)
    encoded = _manual_signature_canonical_json(canonical).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


_SIGNED_MANUAL_SHA_FIELDS = (
    'specRootSha256', 'paperSpecSha256', 'sealedRecordSha256',
    'recordFileSha256', 'artifactIndexSha256', 'artifactIndexFileSha256',
    'recordsEnvelopeFileSha256', 'taskEvidenceSha256', 'readerLongformSha256',
    'readerLongformArticleSha256',
)
_SIGNED_MANUAL_BLOCK_KINDS = frozenset({
    'prerequisites', 'problem', 'related_work', 'signal_path', 'architecture',
    'component', 'training', 'formula', 'experiment_setup', 'result',
    'ablation', 'negative_result', 'reproduction', 'limitation', 'synthesis',
})


def _manual_signed_reader_compatibility(paper, manifest=None):
    if not isinstance(paper, dict):
        return False
    manifest = manifest if isinstance(manifest, dict) else paper.get('analysisManifest')
    if not isinstance(manifest, dict):
        return False
    contracts = manifest.get('contracts')
    takeover = manifest.get('manualTakeover')
    acquisition = manifest.get('sourceAcquisition')
    provenance_record = paper.get('manualV6Provenance')
    return (
        paper.get('manualV6CompatibilityMode') == SIGNED_MANUAL_COMPATIBILITY_MODE
        and isinstance(contracts, dict)
        and contracts.get('manualDepth') == MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT
        and paper.get('manualDepth') == MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT
        and isinstance(provenance_record, dict)
        and provenance_record.get('runtimeMode') == 'production'
        and provenance_record.get('v5BridgeMode') == SIGNED_MANUAL_COMPATIBILITY_MODE
        and isinstance(takeover, dict)
        and takeover.get('v6Provenance') == provenance_record
        and isinstance(acquisition, dict)
        and acquisition.get('v5BridgeMode') == SIGNED_MANUAL_COMPATIBILITY_MODE
    )


def _normalize_signed_manual_text(value):
    return unicodedata.normalize(
        'NFKC', '' if value is None else str(value),
    ).replace('\r\n', '\n').replace('\r', '\n').strip()


def _signed_manual_article_uses_term(article, value):
    term = _normalize_signed_manual_text(value)
    if len(term) < 2:
        return False
    return re.search(
        rf'(^|[^A-Za-z0-9]){re.escape(term)}(?=$|[^A-Za-z0-9])', article,
    ) is not None


def _signed_manual_text_sha(value):
    # manual-longform-contract.js 直接对 String(value) 的字节取哈希。对象身份
    # （ArtifactIndex/workflow）改用 ``_manual_hash`` 的稳定 JSON。
    return hashlib.sha256(str(value or '').encode('utf-8')).hexdigest()


def _require_signed_manual_text(value, label, minimum=1):
    text = _normalize_signed_manual_text(value)
    if len(text) < minimum:
        raise _H.PublishDataValidationError(f'{label} 至少需要 {minimum} 个字符')
    return text


def _is_signed_manual_table_paragraph(value):
    lines = [line.strip() for line in _normalize_signed_manual_text(value).splitlines() if line.strip()]
    return len(lines) >= 2 and all(line.startswith('|') and line.endswith('|') for line in lines)


def _sanitize_signed_manual_table_cell(value):
    text = _normalize_signed_manual_text(value)
    text = re.sub(r'(binary \{0,1\})\\\{0,1\\\}', r'\1', text)
    text = re.sub(r'U\u200b?\{3,\.\.\.,7\}\\mathcal\{U\}\\\{3,\\ldots,7\\\}', 'U{3,...,7}', text)
    text = text.replace('F1F_{1}', 'F1').replace('α\\alpha', 'α').replace('ρ\\rho', 'ρ')
    text = text.replace('r1r_{1}', 'r1')
    text = text.replace('κmax=α\\kappa_{\\max}=\\sqrt{\\alpha}', 'κ_max = √α')
    text = re.sub(r'r1\u200b?α\\sqrt\{r_\{1\}\\alpha\}', '√(r1 α)', text)
    text = re.sub(r'(\d+)×(\d+)\1\\times\s*\2', r'\1×\2', text)
    text = re.sub(r'[∼~](\d+(?:\.\d+)?)\{\\sim\}\1', r'~\1', text)
    text = re.sub(r'≈(\d+(?:\.\d+)?)\\approx\s*\1', r'≈\1', text)
    text = re.sub(r'(p=0\.5)\1', r'\1', text)
    text = re.sub(r'\b([123]\.0)\1(?=\s*s\b)', r'\1', text)
    text = re.sub(r'\b(n=\d+)\1\b', r'\1', text)
    text = re.sub(r'\+([0-9]+(?:\.[0-9]+)?)\+\1', r'+\1', text)
    text = re.sub(r'−([0-9]+(?:\.[0-9]+)?)-\1', r'−\1', text)
    text = re.sub(r'(?<![\d.])(\d+\.\d+)\1(?![\d.])', r'\1', text)
    text = re.sub(r'\[−(\d+(?:\.\d+)?)(,[^\]]+)\]\[-\1\2\]', r'[−\1\2]', text)
    text = re.sub(r'(\d+)%\1\\%', r'\1%', text)
    text = re.sub(r'(\[[^\]]+\])\1', r'\1', text)
    text = text.replace('++', '+').replace('−-', '−')

    def collapse_numeric(match):
        token = match.group(0)
        if '.' not in token and len(token) < 4:
            return token
        for split in range(1, len(token)):
            if token[:split] == token[split:]:
                return token[:split]
        return token

    return re.sub(r'(?<![\d.])\d+(?:\.\d+)?(?![\d.])', collapse_numeric, text)


def _render_signed_manual_table(table):
    matrix = table.get('matrix') if isinstance(table, dict) else None
    if not isinstance(matrix, list) or not matrix or any(not isinstance(row, list) or not row for row in matrix):
        raise _H.PublishDataValidationError(f'{(table or {}).get("id", "unknown table")} 缺少可确定性渲染矩阵')
    width = max(len(row) for row in matrix)
    rows = []
    for row in matrix:
        rows.append([
            row[index] if index < len(row) else ''
            for index in range(width)
        ])
    header_text = [_normalize_signed_manual_text(cell) for cell in rows[0]]
    active_contrast_column = None
    routed = []
    for row_index, row in enumerate(rows):
        if row_index == 0:
            routed.append(row)
            continue
        populated = [_normalize_signed_manual_text(cell) for cell in row if _normalize_signed_manual_text(cell)]
        if len(populated) == width and len(set(populated)) == 1:
            sample = re.search(r'\bn=(\d+)', populated[0], re.I)
            active_contrast_column = next(
                (index for index, cell in enumerate(header_text)
                 if sample and f'n={sample.group(1)}' in cell), None,
            )
            routed.append([row[0], *([''] * (width - 1))])
            continue
        first = _sanitize_signed_manual_table_cell(row[0])
        if (isinstance(active_contrast_column, int) and active_contrast_column > 0
                and re.fullmatch(r'[A-Z]\s*[−-]\s*[A-Z]', first)):
            value = next((cell for cell in row[1:] if _normalize_signed_manual_text(cell)), '')
            output = [''] * width
            output[0] = row[0]
            output[active_contrast_column] = value
            routed.append(output)
            continue
        routed.append(row)
    normalized = []
    for row in routed:
        escaped = [
            _sanitize_signed_manual_table_cell(cell).replace('|', r'\|').replace('\n', '<br>')
            for cell in row
        ]
        populated = [cell for cell in escaped if cell]
        normalized.append(
            [populated[0], *([''] * (width - 1))]
            if len(populated) > 1 and len(set(populated)) == 1 else escaped
        )
    caption = _sanitize_signed_manual_table_cell(table.get('caption') or table.get('id') or '实验表格')
    return '\n'.join([
        f'**{caption}**', '', f'| {" | ".join(normalized[0])} |',
        f'| {" | ".join(["---"] * width)} |',
        *(f'| {" | ".join(row)} |' for row in normalized[1:]),
    ])


def _signed_manual_numeric_cell_ids(table):
    table_id = str(table.get('id') or table.get('sourceTableId') or '').strip()
    result = []
    for row_index, row in enumerate(table.get('matrix') or []):
        for column_index, raw_cell in enumerate(row if isinstance(row, list) else []):
            cell = _normalize_signed_manual_text(raw_cell)
            if not re.search(r'(?:^|[^A-Za-z])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\b)', cell):
                continue
            result.append(
                f'{table_id}:r{row_index}:c{column_index}:{_signed_manual_text_sha(cell)[:12]}'
            )
    return result


def _signed_manual_inventory_ids(index, field):
    result = {}
    for position, item in enumerate(index.get(field) or []):
        if not isinstance(item, dict):
            raise _H.PublishDataValidationError(f'ArtifactIndex.{field}[{position}] 必须是对象')
        item_id = str(item.get('id') or item.get('sourceTableId') or item.get('url') or '').strip()
        if not item_id or item_id in result:
            raise _H.PublishDataValidationError(f'ArtifactIndex.{field} ID 缺失或重复')
        result[item_id] = item
    return result


def _manual_analysis_model_context(manifest, takeover, paper_label):
    """先确定外层身份，防止旧分支提前返回时接受新标识。"""
    try:
        policy = bound_analysis_model_policy(manifest)
        bound_analysis_model_policy(takeover, policy)
        contracts = manifest.get('contracts')
        if contracts and not isinstance(contracts, dict):
            raise ValueError('人工分析的格式约定必须为 JSON 对象。')
        contracts = contracts if isinstance(contracts, dict) else {}
        if policy == CURRENT_MODEL_POLICY:
            if (contracts.get('manualDepth') != MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT
                    or contracts.get('perPaperSubagent') != 'isolated-single-paper-v2'
                    or type(takeover.get('version')) is not int or takeover['version'] != 2):
                raise ValueError('当前模型规则只适用于带版本 2 接管证明的新 Manual v6。')
        elif contracts.get('perPaperSubagent') == 'isolated-single-paper-v2':
            raise ValueError('旧模型上下文不能冒用新的单篇任务格式。')
        for key in ('researchBrief', 'scoringCalibration', 'readabilityRubric'):
            value = takeover.get(key)
            if policy == CURRENT_MODEL_POLICY or isinstance(value, dict):
                bound_analysis_model_policy(value, policy)
        if policy == LEGACY_MODEL_POLICY:
            brief = takeover.get('researchBrief')
            brief = brief if isinstance(brief, dict) else {}
            subagent = brief.get('paperSubagent') if isinstance(brief, dict) else None
            for value in (subagent, takeover.get('scoringCalibration'), takeover.get('readabilityRubric')):
                if isinstance(value, dict):
                    error = analysis_identity_error(value, policy, legacy_optional=True)
                    if error:
                        raise ValueError(error)
            if isinstance(subagent, dict) and 'version' in subagent and (type(subagent['version']) is not int or subagent['version'] != 1):
                raise ValueError('旧研究说明不能冒用新单篇任务版本。')
        return policy
    except ValueError as exc:
        raise _H.PublishDataValidationError(f'{paper_label} {exc}') from exc


def _require_manual_analysis_identity(value, policy, label, **options):
    error = analysis_identity_error(value, policy, **options)
    if error:
        raise _H.PublishDataValidationError(f'{label} {error}')


def _validate_current_manual_research_identity(takeover, policy, paper_id, task_names):
    brief = takeover['researchBrief']
    if brief.get('contract') != MANUAL_RESEARCH_CONTRACT or brief.get('audience') != 'audio_researcher':
        raise _H.PublishDataValidationError('新研究说明必须保留原研究者正文格式和读者身份。')
    subagent = brief.get('paperSubagent')
    _require_manual_analysis_identity(subagent, policy, 'researchBrief.paperSubagent', receipt=True)
    if (subagent.get('singlePaperOnly') is not True or subagent.get('isolatedContext') is not True
            or _H.normalize_publish_arxiv_id(subagent.get('paperId')) != paper_id
            or subagent.get('taskName') != task_names['author']
            or not _H.BEIJING_TIMESTAMP_RE.fullmatch(str(subagent.get('completedAt') or ''))):
        raise _H.PublishDataValidationError('研究说明必须对应真实初稿作者的独立单篇任务。')
    for field, task in (('scoringCalibration', 'technicalScoring'),
                        ('readabilityRubric', 'pedagogyReadability')):
        value = takeover[field]
        _require_manual_analysis_identity(value, policy, field)
        if (value.get('independentReview') is not True
                or value.get('reviewerTaskName') != task_names[task]):
            raise _H.PublishDataValidationError(f'{field} 必须对应四角色记录中的独立审查任务。')
        if field == 'scoringCalibration' and (type(value.get('version')) is not int or value['version'] != 1):
            raise _H.PublishDataValidationError('评分校准仍须采用原版本 1。')
        if field == 'readabilityRubric' and _H.normalize_publish_arxiv_id(value.get('paperId')) != paper_id:
            raise _H.PublishDataValidationError('可读性审查必须属于当前论文。')
    for field in ('researchBrief', 'scoringCalibration', 'readabilityRubric'):
        if takeover.get(field + 'Sha256') != _manual_hash(takeover[field]):
            raise _H.PublishDataValidationError(f'{field} 的模型身份及内容未绑定原对应 SHA。')


def validate_signed_manual_payload(paper):
    """校验 Manual v6 记录，并按固定规则从正文分块生成文章。

    返回的文章只由受控的 longform 块组成。旧的
    ``manualTakeover.readerArticle`` 只用于比对内容是否一致，绝不参与渲染。
    """
    if not isinstance(paper, dict):
        raise _H.PublishDataValidationError('Manual v6 的正式论文记录必须是 JSON 对象。')
    paper_label = str(paper.get('arxivId') or paper.get('id') or '<unknown paper>')
    paper_id = _H.normalize_publish_arxiv_id(paper_label)
    manifest = paper.get('analysisManifest')
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    if not isinstance(contracts, dict) or contracts.get('manualDepth') != MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT:
        raise _H.PublishDataValidationError(f'{paper_label} 未声明 Manual v6')
    takeover = manifest.get('manualTakeover')
    policy = _manual_analysis_model_context(manifest, takeover, paper_label)
    required_contracts = {
        'readerLongform': MANUAL_SIGNED_LONGFORM_CONTRACT,
        'artifactIndex': MANUAL_STRUCTURED_ARTIFACT_PARSER_CONTRACT,
        'experimentTables': _H.EXPERIMENT_TABLE_CONTRACT_VERSION,
        'researcherFocus': MANUAL_RESEARCH_CONTRACT,
        'perPaperSubagent': ('isolated-single-paper-v2' if policy == CURRENT_MODEL_POLICY
                             else 'isolated-single-paper-v1'),
        'authorLineage': 'original-author-final-revision-v1',
    }
    for key, expected in required_contracts.items():
        if contracts.get(key) != expected:
            raise _H.PublishDataValidationError(f'{paper_label} Manual v6 contracts.{key} 必须为 {expected}')
    if paper.get('manualDepth') != MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT:
        raise _H.PublishDataValidationError(f'{paper_label} canonical manualDepth 与 contracts 不一致')

    artifact = paper.get('manualArtifactIndex')
    bundle = paper.get('manualReaderLongform')
    provenance_record = paper.get('manualV6Provenance')
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    takeover_v6_record = takeover.get('v6Provenance') if isinstance(takeover, dict) else None
    acquisition = manifest.get('sourceAcquisition') if isinstance(manifest, dict) else None
    if not all(isinstance(value, dict) for value in (artifact, bundle, provenance_record, takeover_v6_record, acquisition)):
        raise _H.PublishDataValidationError(f'{paper_label} Manual v6 artifact/longform/provenance 不完整')
    if provenance_record.get('specVersion') != 6 or takeover_v6_record != provenance_record:
        raise _H.PublishDataValidationError(f'{paper_label} Manual v6 provenance 副本不一致')
    if provenance_record.get('runtimeMode') != 'production':
        raise _H.PublishDataValidationError(
            f'{paper_label} Manual v6 论文记录的运行模式必须为 production；shadow 模式的运行结果不能用于发布。'
        )
    if provenance_record.get('readerLongformContract') != MANUAL_SIGNED_LONGFORM_CONTRACT:
        raise _H.PublishDataValidationError(f'{paper_label} Manual v6 readerLongformContract 非法')
    for field in _SIGNED_MANUAL_SHA_FIELDS:
        value = str(provenance_record.get(field) or '')
        if not re.fullmatch(r'[a-f0-9]{64}', value):
            raise _H.PublishDataValidationError(f'{paper_label} manualV6Provenance.{field} 非法')
        if field in acquisition and acquisition.get(field) != value:
            raise _H.PublishDataValidationError(f'{paper_label} sourceAcquisition.{field} 与 v6 provenance 不一致')
    for field in ('specRootSha256', 'paperSpecSha256', 'sealedRecordSha256',
                  'recordFileSha256', 'artifactIndexSha256', 'artifactIndexFileSha256'):
        if acquisition.get(field) != provenance_record[field]:
            raise _H.PublishDataValidationError(f'{paper_label} sourceAcquisition 缺少 {field} 的强绑定')

    if (artifact.get('version') != 1
            or artifact.get('parserVersion') != MANUAL_STRUCTURED_ARTIFACT_PARSER_CONTRACT
            or _H.normalize_publish_arxiv_id(artifact.get('paperId')) != paper_id):
        raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex 版本/parser/paperId 非法')
    input_identity = artifact.get('inputIdentity')
    if not isinstance(input_identity, dict):
        raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex.inputIdentity 缺失')
    for field in ('sourceSha256', 'sourceIdentitySha256', 'paperInputSha256'):
        value = str(input_identity.get(field) or '')
        if not re.fullmatch(r'[a-f0-9]{64}', value) or acquisition.get(field) != value:
            raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex.inputIdentity.{field} 未绑定 sourceAcquisition')
    if not isinstance(artifact.get('inventoryHealth'), dict) \
            or artifact['inventoryHealth'].get('status') != 'complete':
        raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex inventory 未完整恢复，禁止发布 v6')
    for field in ('sections', 'tables', 'figures', 'formulas', 'references', 'acronyms',
                  'citations', 'baselines', 'datasets', 'metrics', 'sourceSpans'):
        if not isinstance(artifact.get(field), list):
            raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex.{field} 缺失')
    if artifact.get('images') != artifact.get('figures'):
        raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex 中兼容字段 images 与 figures 的内容不一致。')
    payload = {key: value for key, value in artifact.items()
               if key not in {'artifactIndexSha256', 'outputSha256'}}
    artifact_sha = _manual_signature_hash(payload)
    if (artifact.get('artifactIndexSha256') != artifact_sha
            or artifact.get('outputSha256') != artifact_sha
            or provenance_record.get('artifactIndexSha256') != artifact_sha):
        raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex semantic SHA 漂移')
    counts = artifact.get('counts')
    if not isinstance(counts, dict):
        raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex.counts 缺失')
    for field in ('sections', 'tables', 'figures', 'formulas', 'references', 'acronyms',
                  'citations', 'baselines', 'datasets', 'metrics'):
        if counts.get(field) != len(artifact[field]):
            raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex 中 {field} 的数量缺失，或与对应清单的条数不一致。')
    if counts.get('images') != len(artifact['figures']):
        raise _H.PublishDataValidationError(f'{paper_label} ArtifactIndex 中的图片数量缺失，或与 figures 清单的条数不一致。')

    if (bundle.get('version') != 2
            or bundle.get('contract') != MANUAL_SIGNED_LONGFORM_CONTRACT
            or _H.normalize_publish_arxiv_id(bundle.get('paperId')) != paper_id
            or bundle.get('artifactIndexSha256') != artifact_sha):
        raise _H.PublishDataValidationError(f'{paper_label} reader-longform-v2 身份绑定非法')
    try:
        bound_analysis_model_policy(bundle, policy)
    except ValueError as exc:
        raise _H.PublishDataValidationError(str(exc)) from exc
    bundle_sha = _manual_signature_hash(bundle)
    if (provenance_record.get('readerLongformSha256') != bundle_sha
            or acquisition.get('readerLongformSha256') != bundle_sha):
        raise _H.PublishDataValidationError(f'{paper_label} reader-longform-v2 semantic SHA 漂移')
    blocks = bundle.get('blocks')
    if not isinstance(blocks, list) or not 6 <= len(blocks) <= 32:
        raise _H.PublishDataValidationError(f'{paper_label} reader-longform-v2 blocks 必须为 6-32 个')
    block_by_id = {}
    source_ids = {item['id'] for item in artifact['sourceSpans'] if isinstance(item, dict) and item.get('id')}
    uses_signed_legacy_format = _manual_signed_reader_compatibility(paper, manifest)
    inventory = {field: _signed_manual_inventory_ids(artifact, field)
                 for field in ('tables', 'figures', 'formulas', 'acronyms', 'citations')}
    positions = {}
    for position, block in enumerate(blocks):
        if not isinstance(block, dict):
            raise _H.PublishDataValidationError(f'{paper_label} blocks[{position}] 必须是对象')
        block_id = _require_signed_manual_text(block.get('id'), f'{paper_label}.blocks[{position}].id', 2)
        if block_id in block_by_id or block.get('kind') not in _SIGNED_MANUAL_BLOCK_KINDS:
            raise _H.PublishDataValidationError(f'{paper_label} block ID 重复或 kind 非法')
        _require_signed_manual_text(block.get('heading'), f'{paper_label}.{block_id}.heading', 6)
        _require_signed_manual_text(block.get('learningObjective'), f'{paper_label}.{block_id}.learningObjective', 12)
        markdown = _require_signed_manual_text(block.get('markdown'), f'{paper_label}.{block_id}.markdown', 100)
        if len(markdown) > 4000 or any(
                len(_normalize_signed_manual_text(item)) > 1200
                and not _is_signed_manual_table_paragraph(item)
                for item in re.split(r'\n\s*\n', markdown)):
            raise _H.PublishDataValidationError(f'{paper_label}.{block_id} 过长，未形成递进 block')
        if re.search(r'(?:sourceBindings|readerBindings|evidenceLedger|resultClaims|schema|字段串)', markdown, re.I):
            raise _H.PublishDataValidationError(f'{paper_label}.{block_id} 泄露内部 schema 语言')
        reference_fields = (('evidenceSpanIds', source_ids), ('tableIds', set(inventory['tables'])),
                            ('figureIds', set(inventory['figures'])), ('formulaIds', set(inventory['formulas'])))
        for field, allowed in reference_fields:
            values = block.get(field, [])
            if not isinstance(values, list) or len(values) != len(set(values)) or any(value not in allowed for value in values):
                raise _H.PublishDataValidationError(f'{paper_label}.{block_id}.{field} 引用非法')
        block_by_id[block_id] = block
        positions.setdefault(block['kind'], position)
    method_positions = [positions[kind] for kind in ('signal_path', 'architecture', 'component') if kind in positions]
    result_positions = [positions[kind] for kind in ('result', 'ablation', 'negative_result') if kind in positions]
    required_kinds = {'prerequisites', 'problem', 'related_work', 'reproduction', 'limitation'}
    if str((paper.get('parsed') or {}).get('documentType') or '') != '理论研究':
        required_kinds.update({'training', 'experiment_setup'})
    if (not required_kinds.issubset(positions) or not method_positions or not result_positions
            or not (positions['problem'] < min(method_positions) < min(result_positions) < positions['limitation'])):
        raise _H.PublishDataValidationError(f'{paper_label} v6 正文未按问题→方法→结果→边界递进')
    article = '\n\n'.join(
        f'### {_normalize_signed_manual_text(block["heading"])}\n\n{_normalize_signed_manual_text(block["markdown"])}'
        for block in blocks
    )
    article_sha = _signed_manual_text_sha(article)
    if bundle.get('articleSha256') != article_sha:
        raise _H.PublishDataValidationError(f'{paper_label} longform article SHA 与 blocks 重放不一致')
    if provenance_record.get('readerLongformArticleSha256') != article_sha:
        raise _H.PublishDataValidationError(f'{paper_label} provenance 未绑定 longform article SHA')
    if isinstance(takeover.get('readerArticle'), str) \
            and _normalize_signed_manual_text(takeover['readerArticle']) != article:
        raise _H.PublishDataValidationError(f'{paper_label} 兼容 readerArticle 与受控 blocks 不一致')
    if takeover.get('readerArticleSha256') not in (None, article_sha):
        raise _H.PublishDataValidationError(f'{paper_label} 兼容 readerArticleSha256 与 blocks 不一致')

    receipt = bundle.get('authorReceipt')
    if (not isinstance(receipt, dict) or _H.normalize_publish_arxiv_id(receipt.get('paperId')) != paper_id
            or receipt.get('singlePaperOnly') is not True or receipt.get('isolatedContext') is not True
            or analysis_identity_error(receipt, policy, receipt=True) is not None
            or not re.fullmatch(r'[a-f0-9]{64}', str(receipt.get('articleSha256') or ''))
            or not re.fullmatch(r'[a-f0-9]{64}', str(receipt.get('inputPacketSha256') or ''))
            or not isinstance(receipt.get('revision'), int) or receipt['revision'] < 1):
        raise _H.PublishDataValidationError(f'{paper_label} v6 authorReceipt 未绑定对应模型规则的单篇初稿')
    if policy == CURRENT_MODEL_POLICY and (receipt.get('role') != 'author'
            or not re.fullmatch(r'[a-f0-9]{64}', str(receipt.get('outputSha256') or ''))):
        raise _H.PublishDataValidationError('新初稿凭证必须明确 author 角色和交付结果 SHA。')
    _require_signed_manual_text(receipt.get('taskName'), f'{paper_label}.authorReceipt.taskName', 4)
    final_receipt = bundle.get('finalRevisionAuthorReceipt')
    if (not isinstance(final_receipt, dict)
            or final_receipt.get('role') != 'author_revision'
            or _H.normalize_publish_arxiv_id(final_receipt.get('paperId')) != paper_id
            or final_receipt.get('singlePaperOnly') is not True
            or final_receipt.get('isolatedContext') is not True
            or analysis_identity_error(final_receipt, policy, receipt=True) is not None
            or final_receipt.get('articleSha256') != article_sha
            or not re.fullmatch(r'[a-f0-9]{64}', str(final_receipt.get('consumedPacketSha256') or ''))
            or not re.fullmatch(r'[a-f0-9]{64}', str(final_receipt.get('outputSha256') or ''))
            or not isinstance(final_receipt.get('revision'), int)
            or final_receipt['revision'] < 1):
        raise _H.PublishDataValidationError(
            f'{paper_label} finalRevisionAuthorReceipt 未绑定最终 readerArticle'
        )
    _require_signed_manual_text(
        final_receipt.get('taskName'), f'{paper_label}.finalRevisionAuthorReceipt.taskName', 4
    )
    if final_receipt['taskName'] == receipt['taskName']:
        raise _H.PublishDataValidationError(f'{paper_label} 初稿 author 与最终 author_revision taskName 重复')
    for receipt_name, current_receipt in (
            ('authorReceipt', receipt), ('finalRevisionAuthorReceipt', final_receipt)):
        times = []
        for field in ('queuedAt', 'startedAt', 'completedAt'):
            value = str(current_receipt.get(field) or '')
            if not _H.BEIJING_TIMESTAMP_RE.fullmatch(value):
                raise _H.PublishDataValidationError(f'{paper_label} {receipt_name}.{field} 非北京时间')
            times.append(datetime.fromisoformat(value))
        if not times[0] <= times[1] <= times[2]:
            raise _H.PublishDataValidationError(f'{paper_label} {receipt_name} 时间顺序非法')
    task_names = provenance_record.get('taskNames')
    expected_task_name_keys = {
        'author', 'technicalScoring', 'pedagogyReadability', 'authorRevision'
    }
    if (not isinstance(task_names, dict) or set(task_names) != expected_task_name_keys
            or len(set(task_names.values())) != 4
            or task_names.get('author') != receipt.get('taskName')
            or task_names.get('authorRevision') != final_receipt.get('taskName')):
        raise _H.PublishDataValidationError(f'{paper_label} Manual v6 的四项任务名称记录格式不符合要求、名称不唯一，或作者名称与初稿及修订稿凭证不一致。')

    if policy == CURRENT_MODEL_POLICY:
        for role, task_name in task_names.items():
            _require_signed_manual_text(task_name, f'{paper_label}.taskNames.{role}', 4)
        _validate_current_manual_research_identity(takeover, policy, paper_id, task_names)
    else:
        # 旧完整样本不要求补齐后来增加的研究/审查字段，但拒绝内层自选新身份。
        brief = takeover.get('researchBrief')
        brief = brief if isinstance(brief, dict) else {}
        for value in (brief.get('paperSubagent'), takeover.get('scoringCalibration'),
                      takeover.get('readabilityRubric')):
            if isinstance(value, dict):
                _require_manual_analysis_identity(value, policy, '旧研究或审查身份', legacy_optional=True)
        subagent = brief.get('paperSubagent')
        if isinstance(subagent, dict) and 'version' in subagent and (type(subagent['version']) is not int or subagent['version'] != 1):
            raise _H.PublishDataValidationError('旧研究说明不能冒用新单篇任务版本。')

    table_dispositions = bundle.get('tables')
    if not isinstance(table_dispositions, list):
        raise _H.PublishDataValidationError(f'{paper_label} v6 tables 处置表缺失')
    seen = set()
    deterministic_tables = []
    for item in table_dispositions:
        if not isinstance(item, dict) or item.get('sourceTableId') in seen:
            raise _H.PublishDataValidationError(f'{paper_label} v6 table disposition 非法或重复')
        table_id = str(item.get('sourceTableId') or '')
        source = inventory['tables'].get(table_id)
        seen.add(table_id)
        if not source or item.get('disposition') not in {'inline', 'appendix', 'omit'}:
            raise _H.PublishDataValidationError(f'{paper_label} v6 table 不属于 ArtifactIndex')
        matrix_sha = _manual_signature_hash(source.get('matrix'))
        if (source.get('matrixSha256') != matrix_sha
                or item.get('sourceMatrixSha256') != matrix_sha):
            raise _H.PublishDataValidationError(f'{paper_label} {table_id} matrix SHA 漂移')
        expected_cells = _signed_manual_numeric_cell_ids(source)
        covered = item.get('coveredNumericCellIds')
        if not isinstance(covered, list) or len(covered) != len(set(covered)):
            raise _H.PublishDataValidationError(f'{paper_label} {table_id} 数值单元格绑定非法')
        if source.get('kind') == 'result' and (item.get('disposition') == 'omit' or set(covered) != set(expected_cells)):
            raise _H.PublishDataValidationError(f'{paper_label} {table_id} 结果表未逐数值完整覆盖')
        if item.get('disposition') != 'omit':
            block = block_by_id.get(item.get('blockId'))
            rendered = (
                _normalize_signed_manual_text(item.get('renderedMarkdown'))
                if uses_signed_legacy_format else _render_signed_manual_table(source)
            )
            if (not block or item.get('renderedMarkdown') != rendered
                    or item.get('renderedFragmentSha256') != _signed_manual_text_sha(rendered)
                    or rendered not in _normalize_signed_manual_text(block.get('markdown'))):
                raise _H.PublishDataValidationError(f'{paper_label} {table_id} 未由矩阵确定性渲染进入绑定 block')
            deterministic_tables.append(rendered)
        elif len(_normalize_signed_manual_text(item.get('omissionReason'))) < 24:
            raise _H.PublishDataValidationError(f'{paper_label} {table_id} 省略原因过短')
    if seen != set(inventory['tables']):
        raise _H.PublishDataValidationError(f'{paper_label} v6 未逐项处置全部表格')

    def validate_dispositions(field, inventory_field, *, figures=False, formulas=False):
        items = bundle.get(field)
        if not isinstance(items, list):
            raise _H.PublishDataValidationError(f'{paper_label} v6 {field} 处置表缺失')
        handled = set()
        for item in items:
            if not isinstance(item, dict):
                raise _H.PublishDataValidationError(f'{paper_label} v6 {field} 项非法')
            item_id = str(item.get('id') or item.get('url') or '')
            source = inventory[inventory_field].get(item_id)
            if not source or item_id in handled or item.get('disposition') not in {'inline', 'appendix', 'omit'}:
                raise _H.PublishDataValidationError(f'{paper_label} v6 {field} 身份/处置非法')
            handled.add(item_id)
            if item['disposition'] == 'omit':
                if len(_normalize_signed_manual_text(item.get('omissionReason'))) < 24:
                    raise _H.PublishDataValidationError(f'{paper_label} {field}.{item_id} 省略原因过短')
                continue
            block = block_by_id.get(item.get('blockId'))
            markdown = _normalize_signed_manual_text(block.get('markdown')) if block else ''
            if figures:
                url = str(source.get('url') or '')
                facts = item.get('visibleFacts')
                if not url or url not in markdown or not isinstance(facts, list) or not facts \
                        or any(len(_normalize_signed_manual_text(fact)) < 12 or _normalize_signed_manual_text(fact) not in markdown for fact in facts):
                    raise _H.PublishDataValidationError(f'{paper_label} 图片 {item_id} 缺 URL/像素事实正文绑定')
            if formulas:
                formula = _normalize_signed_manual_text(source.get('raw') or source.get('latex') or source.get('text'))
                explanation = _require_signed_manual_text(item.get('explanation'), f'{paper_label}.formula.{item_id}', 40)
                if explanation not in markdown or (formula and formula not in markdown):
                    raise _H.PublishDataValidationError(f'{paper_label} 公式 {item_id} 缺原式/解释正文绑定')
        if handled != set(inventory[inventory_field]):
            raise _H.PublishDataValidationError(f'{paper_label} v6 未逐项处置全部 {field}')
    validate_dispositions('figures', 'figures', figures=True)
    validate_dispositions('formulas', 'formulas', formulas=True)

    terms = bundle.get('terms')
    if not isinstance(terms, list):
        raise _H.PublishDataValidationError(f'{paper_label} v6 terms 缺失')
    handled_terms = set()
    for item in terms:
        if not isinstance(item, dict) or item.get('id') in handled_terms or item.get('id') not in inventory['acronyms']:
            raise _H.PublishDataValidationError(f'{paper_label} v6 term 身份非法')
        handled_terms.add(item['id'])
        term = _require_signed_manual_text(item.get('term'), f'{paper_label}.term', 2)
        definition = _require_signed_manual_text(item.get('definition'), f'{paper_label}.definition', 16)
        block = block_by_id.get(item.get('firstUseBlockId'))
        if not block or term not in _normalize_signed_manual_text(block.get('markdown')) or definition not in _normalize_signed_manual_text(block.get('markdown')):
            raise _H.PublishDataValidationError(f'{paper_label} 术语 {term} 未在首次出现处定义')
    required_terms = {
        item_id for item_id, source in inventory['acronyms'].items()
        if _signed_manual_article_uses_term(article, source.get('value') or source.get('term'))
    }
    missing_terms = required_terms - handled_terms
    if missing_terms:
        raise _H.PublishDataValidationError(
            f'{paper_label} v6 未定义正文实际使用的术语: {", ".join(sorted(missing_terms))}'
        )

    related = bundle.get('relatedWorks')
    if not isinstance(related, list):
        raise _H.PublishDataValidationError(f'{paper_label} v6 relatedWorks 缺失')
    # relatedWorks 绑定参考文献身份。结构化 arXiv 来源可能把它们放进
    # references，而正文引用投影为空，所以校验时取两份按内容寻址清单的
    # 并集。
    related_inventory = _signed_manual_inventory_ids(artifact, 'references')
    related_inventory.update(inventory['citations'])
    handled_related = set()
    for item in related:
        declared_id = item.get('citationId') if isinstance(item, dict) else None
        if not isinstance(item, dict) or declared_id in handled_related \
                or declared_id not in related_inventory:
            raise _H.PublishDataValidationError(f'{paper_label} v6 related-work 身份非法')
        handled_related.add(declared_id)
        relationship = _require_signed_manual_text(item.get('relationship'), f'{paper_label}.relationship', 16)
        difference = _require_signed_manual_text(item.get('difference'), f'{paper_label}.difference', 16)
        block = block_by_id.get(item.get('blockId'))
        if not block or relationship not in _normalize_signed_manual_text(block.get('markdown')) or difference not in _normalize_signed_manual_text(block.get('markdown')):
            raise _H.PublishDataValidationError(f'{paper_label} related-work 缺关系/差异正文绑定')
    minimum_related = min(2, len(inventory['citations']))
    if len(handled_related) < minimum_related:
        raise _H.PublishDataValidationError(
            f'{paper_label} v6 relatedWorks 必须绑定至少 {minimum_related} 个真实引用'
        )

    return {
        'paperId': paper_id, 'article': article, 'articleSha256': article_sha,
        'artifactIndexSha256': artifact_sha, 'provenance': dict(provenance_record),
        'bundle': bundle, 'artifactIndex': artifact, 'deterministicTables': deterministic_tables,
    }


def _normalize_manual_evidence(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(value or '')))


def _manual_claim_field_text(value):
    if isinstance(value, dict):
        if value.get('notReported') is True:
            return 'notReported'
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if isinstance(value, list):
        return ' / '.join(_manual_claim_field_text(item) for item in value)
    return str(value or '').strip()


def _manual_claim_not_reported(value):
    if isinstance(value, dict):
        return value.get('notReported') is True
    return bool(re.fullmatch(r'(?:not[_ -]?reported|正文未报告|未报告)', str(value or '').strip(), re.I))


MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS = (
    'datasetOrSetting', 'splitOrCondition', 'method', 'baseline',
    'metric', 'value', 'unit', 'direction',
)
MANUAL_ENGLISH_NUMBER_WORDS = {
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
    'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9',
    'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
    'fourteen': '14', 'fifteen': '15', 'sixteen': '16',
    'seventeen': '17', 'eighteen': '18', 'nineteen': '19', 'twenty': '20',
}
MANUAL_RESULT_DIRECTION_PATTERNS = (
    re.compile(
        r'^(?:↑|(?:越)?高(?:越)?好|越大越好|'
        r'higher(?:[\s_-]+\w+){0,3}[\s_-]+is[\s_-]+better|'
        r'increase(?:[\s_-]+is)?[\s_-]+better)$', re.I,
    ),
    re.compile(
        r'^(?:↓|(?:越)?低(?:越)?好|越小越好|'
        r'lower(?:[\s_-]+\w+){0,3}[\s_-]+is[\s_-]+better|'
        r'decrease(?:[\s_-]+is)?[\s_-]+better)$', re.I,
    ),
    re.compile(r'^(?:descriptive|描述性)$', re.I),
    re.compile(
        r'^(?:绝对值反映关联强度|'
        r'larger\s+(?:absolute\s+)?magnitude\s+means\s+stronger\s+association)$',
        re.I,
    ),
)


def _normalize_manual_numeric_lexeme(value):
    normalized = unicodedata.normalize('NFKC', str(value or '')).lower()
    normalized = re.sub(r'[\u2212\u2012\u2013\u2014]', '-', normalized).replace(',', '')
    if normalized in MANUAL_ENGLISH_NUMBER_WORDS:
        return MANUAL_ENGLISH_NUMBER_WORDS[normalized]
    try:
        number = float(normalized)
    except (TypeError, ValueError):
        return normalized
    if not math.isfinite(number):
        return normalized
    if number == 0:
        return '0'
    if number.is_integer():
        return str(int(number))
    return format(number, '.15g')


def _manual_numeric_lexemes(value):
    normalized = unicodedata.normalize('NFKC', _manual_claim_field_text(value))
    normalized = re.sub(r'[\u2212\u2012\u2013\u2014]', '-', normalized)
    # 与 Node 一致：保留裸重复小数的完整表面供声明校验拒绝，不猜测其中半值。
    decimal = r'(?:\d*\.\d+)'
    repeated = rf'(?:\+({decimal})\+\1|-({decimal})-\2|[-+]?({decimal})\3)'
    number = (
        r'[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)(?:[eE][-+]?\d+)?'
        r'|[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:[eE][-+]?\d+)?'
    )
    number_words = '|'.join(MANUAL_ENGLISH_NUMBER_WORDS)
    matches = re.finditer(
        rf'(?<![\d.])(?:{repeated}|[-+]?\d*\.\d+(?:\.\d+)+|{number})(?!\d|\.\d)|\b(?:{number_words})\b',
        normalized,
        flags=re.I,
    )
    return [_normalize_manual_numeric_lexeme(item.group(0)) for item in matches]


def _manual_normalized_semantic_text(value):
    normalized = unicodedata.normalize('NFKC', _manual_claim_field_text(value)).lower()
    normalized = re.sub(r'[\u2212\u2012\u2013\u2014]', '-', normalized)
    return re.sub(r'[\s\W_]+', '', normalized, flags=re.UNICODE)


def _manual_binding_reuse_key(value):
    normalized = unicodedata.normalize('NFKC', str(value or '')).lower()
    normalized = re.sub(r'https?://\S+', '', normalized)
    return re.sub(r'[\s\W_]+', '', normalized, flags=re.UNICODE)


def _manual_result_direction_supported(value):
    if _manual_claim_not_reported(value):
        return True
    text = str(value or '').strip()
    return any(pattern.fullmatch(text) for pattern in MANUAL_RESULT_DIRECTION_PATTERNS)


def _manual_result_claim_dedup_key(claim):
    normalized_field_values = []
    for field in MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS:
        value = claim.get(field)
        if _manual_claim_not_reported(value):
            reason = value.get('reason') if isinstance(value, dict) else ''
            normalized_field_values.append(f'notReported:{_normalize_manual_evidence(reason)}')
        else:
            normalized_field_values.append(
                f'{_manual_normalized_semantic_text(value)}:'
                f'{",".join(_manual_numeric_lexemes(value))}'
            )
    return json.dumps(normalized_field_values, ensure_ascii=False, separators=(',', ':'))


def _manual_reader_result_evidence_blocks(value):
    blocks = []
    table = []
    prose = []

    def flush_table():
        if table:
            blocks.append('\n'.join(table))
            table.clear()

    def flush_prose():
        if not prose:
            return
        paragraph = ' '.join(prose).strip()
        if paragraph:
            blocks.append(paragraph)
            blocks.extend(
                item.strip() for item in re.split(r'(?<=[。！？!?;；])', paragraph)
                if item.strip()
            )
        prose.clear()

    for line in str(value or '').split('\n'):
        if re.fullmatch(r'\s*\|.*\|\s*', line):
            flush_prose()
            table.append(line)
        elif not line.strip():
            flush_table()
            flush_prose()
        else:
            flush_table()
            prose.append(line.strip())
    flush_table()
    flush_prose()
    return list(dict.fromkeys(blocks))


def _validate_manual_result_claim_bindings(
        claim, binding_field, evidence_text, prefix, *, require_membership=True):
    bindings = claim.get(binding_field)
    if not isinstance(bindings, dict):
        return f'{prefix}.{binding_field} 必须是逐字段证据对象'
    if set(bindings) != set(MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS) \
            or len(bindings) != len(MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS):
        return (
            f'{prefix}.{binding_field} 必须且只能包含 '
            f'{", ".join(MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS)}'
        )
    normalized_evidence = _normalize_manual_evidence(evidence_text)
    repeated = {}
    for field in MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS:
        fragment = bindings.get(field)
        normalized_fragment = _normalize_manual_evidence(fragment) \
            if isinstance(fragment, str) else ''
        # 与 Node 检查使用同一组允许的单字符单位和方向；其余任意单字符仍拒绝。
        legitimate_single_character = (
            field == 'unit'
            and re.fullmatch(r'(?:%|s|h|W|分|帧|人)', normalized_fragment, re.I)
        ) or (
            field == 'direction'
            and re.fullmatch(r'(?:↑|↓)', normalized_fragment)
        )
        if len(normalized_fragment) < 2 and not legitimate_single_character:
            return (
                f'{prefix}.{binding_field}.{field} '
                '必须是至少 2 个非空白字符的连续证据片段'
            )
        if require_membership and normalized_fragment not in normalized_evidence:
            return f'{prefix}.{binding_field}.{field} 不存在于本条 sourceQuote'
        reuse_key = _manual_binding_reuse_key(fragment) or normalized_fragment
        repeated[reuse_key] = repeated.get(reuse_key, 0) + 1
        if field == 'value' and not _manual_claim_not_reported(claim.get('value')):
            binding_numbers = _manual_numeric_lexemes(fragment)
            missing = [
                number for number in _manual_numeric_lexemes(claim.get('value'))
                if number not in binding_numbers
            ]
            if missing:
                return (
                    f'{prefix}.{binding_field}.value '
                    f'未覆盖 claim.value 数值 {missing[0]}'
                )
        if _manual_claim_not_reported(claim.get(field)) and not re.search(
                r'not\s+report|not\s+provide|without|unavailable|qualitative|'
                r'degrad\w*|fail\w*|未报告|未给出|未提供|不可得|定性|退化|失败',
                fragment, re.I):
            return f'{prefix}.{binding_field}.{field} 未给出缺失、定性或负面证据片段'
    if any(count > 3 for count in repeated.values()):
        return f'{prefix}.{binding_field} 同一证据片段最多绑定 3 个字段'
    return None


def _manual_result_claim_bound_to_reader_block(claim, reader_blocks):
    expected_numbers = [] if _manual_claim_not_reported(claim.get('value')) \
        else _manual_numeric_lexemes(claim.get('value'))
    bindings = claim.get('readerBindings') or {}
    for block in reader_blocks:
        block_numbers = _manual_numeric_lexemes(block)
        if expected_numbers and any(number not in block_numbers for number in expected_numbers):
            continue
        normalized_block = _normalize_manual_evidence(block)
        if all(
                _normalize_manual_evidence(bindings.get(field)) in normalized_block
                for field in MANUAL_RESULT_CLAIM_SEMANTIC_FIELDS):
            return True
    return False


def _manual_result_claim_source_text(paper):
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    claims = takeover.get('resultClaims') if isinstance(takeover, dict) else None
    if not isinstance(claims, list):
        return ''
    return '\n'.join(
        str(claim.get('sourceQuote') or '')
        for claim in claims
        if isinstance(claim, dict)
    )

def _validate_manual_attributed_result_claims(
        takeover, analysis, paper_label, *, reader_section='实验结果'):
    """在发布阶段复刻来源绑定的 Manual v4 结果主张结构。

    受控全文刻意不写入发布数据，所以它原本的成员校验仍由摄入阶段负责。
    这个复刻版本依然拒绝被削弱或自洽的载荷：普通论文需要三条互不相同
    的主张，例外按文档类型设闸，每个语义字段都绑定一个确切的本地来源
    和读者片段，实证论文还要在一个读者可见的实验证据块里保留一条来源
    绑定的数值主张。
    """
    claims = takeover.get('resultClaims')
    exception = takeover.get('resultClaimsException')
    document_type = str(takeover.get('documentType') or '')
    minimum_claims = 3
    if exception is not None:
        if not isinstance(exception, dict):
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v4 resultClaimsException 必须是对象'
            )
        exception_type = str(exception.get('type') or '')
        if not re.fullmatch(r'(?:theoretical|qualitative)', exception_type, re.I) \
                or not re.search(r'(?:理论|定性|theor|qualitative)', document_type, re.I):
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims 例外仅允许理论/定性文档'
            )
        if len(_normalize_manual_evidence(exception.get('reason'))) < 20 \
                or not isinstance(exception.get('sourceQuote'), str) \
                or len(_normalize_manual_evidence(exception.get('sourceQuote'))) < 8:
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims 例外缺少充分理由或全文原句'
            )
        minimum_claims = 1
    if not isinstance(claims, list) or len(claims) < minimum_claims:
        raise _H.PublishDataValidationError(
            f'{paper_label} manual v4 resultClaims 至少需要 {minimum_claims} 条'
        )
    required_fields = (
        'datasetOrSetting', 'splitOrCondition', 'method', 'baseline',
        'metric', 'value', 'unit', 'direction', 'sourceQuote',
    )
    reader_results = _H._extract_analysis_section(analysis, reader_section)
    reader_blocks = _manual_reader_result_evidence_blocks(reader_results)
    claim_index_by_key = {}
    numeric_claim_count = 0
    for index, claim in enumerate(claims):
        if not isinstance(claim, dict):
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims[{index}] 必须是对象'
            )
        for field in required_fields:
            if field not in claim or not _normalize_manual_evidence(
                    _manual_claim_field_text(claim.get(field))):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}].{field} 缺失'
                )
            value = claim.get(field)
            if field != 'sourceQuote' and re.search(
                    r'not[_ -]?reported.*\d|\d.*not[_ -]?reported',
                    _manual_claim_field_text(value), re.I):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}].{field} '
                    '不得把 notReported 与数值混写'
                )
            if field != 'sourceQuote' and _manual_claim_not_reported(value) \
                    and (not isinstance(value, dict)
                         or value.get('notReported') is not True
                         or len(_normalize_manual_evidence(value.get('reason'))) < 8):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}].{field} '
                    'notReported 必须使用 {notReported:true, reason} 且附理由'
                )
        source_quote = claim.get('sourceQuote')
        if not isinstance(source_quote, str) \
                or len(_normalize_manual_evidence(source_quote)) < 8:
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v4 resultClaims[{index}].sourceQuote 过短'
            )
        prefix = f'{paper_label} manual v4 resultClaims[{index}]'
        if not _manual_result_direction_supported(claim.get('direction')):
            raise _H.PublishDataValidationError(
                f'{prefix}.direction 不是受支持的方向语义'
            )
        binding_issue = _validate_manual_result_claim_bindings(
            claim, 'sourceBindings', source_quote, prefix,
        )
        if binding_issue:
            raise _H.PublishDataValidationError(binding_issue)
        binding_issue = _validate_manual_result_claim_bindings(
            claim, 'readerBindings', reader_results, prefix,
            require_membership=False,
        )
        if binding_issue:
            raise _H.PublishDataValidationError(binding_issue)
        if not _manual_claim_not_reported(claim.get('value')):
            value_numbers = _manual_numeric_lexemes(claim.get('value'))
            try:
                valid_numbers = bool(value_numbers) and all(
                    math.isfinite(float(number)) for number in value_numbers)
            except ValueError:
                valid_numbers = False
            if not valid_numbers:
                raise _H.PublishDataValidationError(
                    f'{prefix}.value 必须包含可核对的完整数字，不得包含无法解析的拼接数值；'
                    '缺失值应使用带理由的 notReported 对象'
                )
            numeric_claim_count += 1
            quote_numbers = _manual_numeric_lexemes(source_quote)
            missing_quote = [number for number in value_numbers if number not in quote_numbers]
            if missing_quote:
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims[{index}] 数值 '
                    f'{missing_quote[0]} 未出现在 sourceQuote'
                )
        if not _manual_result_claim_bound_to_reader_block(claim, reader_blocks):
            raise _H.PublishDataValidationError(
                f'{prefix}.readerBindings '
                f'未共同落在读者正文{reader_section}的同一局部证据块'
            )
        claim_key = _manual_result_claim_dedup_key(claim)
        if claim_key in claim_index_by_key:
            raise _H.PublishDataValidationError(
                f'{prefix} 与 resultClaims[{claim_index_by_key[claim_key]}] 重复，'
                '不能重复计入最低条数'
            )
        claim_index_by_key[claim_key] = index
    empirical = exception is None and not re.search(
        r'(?:理论|定性|theor|qualitative)', document_type, re.I,
    )
    if empirical and claims and numeric_claim_count == 0:
        raise _H.PublishDataValidationError(
            f'{paper_label} 实证论文的 resultClaims '
            '至少需要 1 条包含可核对数字的声明'
        )
    return claims


def _manual_boilerplate(analysis):
    text = str(analysis or '')
    return [line.strip() for line in text.splitlines() if any(pattern.search(line) for pattern in MANUAL_BOILERPLATE_PATTERNS)]


def _validate_manual_takeover_manifest(paper, manifest, paper_label):
    stages = manifest.get('stages') if isinstance(manifest, dict) else {}
    uses_manual = any(
        isinstance(stage, dict) and stage.get('status') == MANUAL_COMPLETE_STATUS
        for stage in (stages or {}).values()
    )
    if not uses_manual and manifest.get('manualTakeover') is None:
        if 'modelPolicy' in manifest:
            _manual_analysis_model_context(manifest, None, paper_label)
        return
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    if contracts.get('manualDepth') in MANUAL_READER_QUALITY_CONTRACTS \
            and contracts.get('experimentTables') != _H.EXPERIMENT_TABLE_CONTRACT_VERSION:
        raise _H.PublishDataValidationError(
            f'{paper_label} manual v4 必须声明 '
            f'experimentTables={_H.EXPERIMENT_TABLE_CONTRACT_VERSION}'
        )
    if contracts.get('manualDepth') in MANUAL_READER_QUALITY_CONTRACTS \
            and contracts.get('editorialQuality') != _H.EDITORIAL_QUALITY_CONTRACT_VERSION:
        raise _H.PublishDataValidationError(
            f'{paper_label} manual v4 必须声明 '
            f'editorialQuality={_H.EDITORIAL_QUALITY_CONTRACT_VERSION}'
        )
    takeover = manifest.get('manualTakeover')
    if not isinstance(takeover, dict):
        raise _H.PublishDataValidationError(f'{paper_label} manual_complete 缺少 manualTakeover provenance')
    manual_depth = contracts.get('manualDepth')
    model_policy = _manual_analysis_model_context(manifest, takeover, paper_label)
    signed_manual_compatibility = _manual_signed_reader_compatibility(paper, manifest)
    if paper.get('manualV6CompatibilityMode') is not None and not signed_manual_compatibility:
        raise _H.PublishDataValidationError(
            f'{paper_label} Manual v6 的兼容标记、版本、运行模式或来源记录不符合要求，或相关记录缺失。'
        )
    if signed_manual_compatibility:
        # 生产 V6 用按内容寻址的 ArtifactIndex、reader-longform-v2 和四份独立的
        # 任务核验记录，取代旧的 V4/V5 resultClaims、stageReviews、evidenceLedger
        # 和 figureReview 投影。接受这个覆盖前必须完整重跑 V6 校验器。
        validate_signed_manual_payload(paper)
        return
    if takeover.get('version') == MANUAL_COMPLETE_PROVENANCE_VERSION:
        if takeover.get('mode') != MANUAL_COMPLETE_STATUS:
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.version/mode 必须为 manual_complete v2')
        if not isinstance(takeover.get('agent'), str) or not takeover['agent'].strip():
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.agent 缺失')
        if takeover.get('basis') != 'full_text':
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.basis 必须为 full_text')
        source_sha = str(paper.get('sourceSha256') or manifest.get('sourceAcquisition', {}).get('sourceSha256') or '')
        if not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('sourceSha256') or '')):
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 非法')
        if not source_sha or takeover['sourceSha256'] != source_sha:
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 与全文来源不一致')
        if not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('promptSha256') or '')):
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.promptSha256 非法')
        manual_depth = (manifest.get('contracts') or {}).get('manualDepth')
        if manual_depth in {MANUAL_DEPTH_EXPLANATION_CONTRACT, *MANUAL_READER_QUALITY_CONTRACTS} \
                and not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('manualAuthoringPromptSha256') or '')):
            raise _H.PublishDataValidationError(f'{paper_label} manual v3/v4 缺少 manualAuthoringPromptSha256')
        analysis_sha = hashlib.sha256(str(paper.get('analysis') or '').encode('utf-8')).hexdigest()
        if takeover.get('analysisSha256') != analysis_sha:
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.analysisSha256 与正文不一致')
        completed_at = takeover.get('completedAt')
        if not isinstance(completed_at, str) or not _H.BEIJING_TIMESTAMP_RE.fullmatch(completed_at):
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.completedAt 必须为北京时间 ISO 时间')
        if not isinstance(takeover.get('reason'), str) or len(takeover['reason'].strip()) < 20:
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.reason 过短')
        review = takeover.get('review')
        required_review = ('sourceVerified', 'analysisContractVerified', 'scoringVerified', 'stageEvidenceVerified')
        if not isinstance(review, dict) or any(review.get(key) is not True for key in required_review):
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.review 未确认来源、正文、评分和阶段证据')
        if manual_depth in MANUAL_READER_QUALITY_CONTRACTS \
                and review.get('readerQualityVerified') is not True:
            raise _H.PublishDataValidationError(
                f'{paper_label} manual v4 review 未确认 readerQualityVerified'
            )
        audit = takeover.get('audit')
        if not isinstance(audit, dict) or audit.get('version') != 1:
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.audit 必须为 v1')
        if not isinstance(audit.get('attempts'), int) or audit['attempts'] < 2:
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.audit 至少需要两轮尝试')
        passes = audit.get('passes')
        if not isinstance(passes, list) or len(passes) < 2 or not isinstance(passes[-1], dict) \
                or passes[-1].get('status') != 'pass' or passes[-1].get('issues') != []:
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.audit 最后一轮必须干净通过')
        checks = audit.get('checks')
        if not isinstance(checks, dict) or set(checks) != MANUAL_AUDIT_CHECKS \
                or any(value is not True for value in checks.values()):
            raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.audit.checks 不完整')
        if _manual_boilerplate(paper.get('analysis')):
            raise _H.PublishDataValidationError(f'{paper_label} 正文包含通用 manual 提示词残留')
        ledger = takeover.get('evidenceLedger')
        if not isinstance(ledger, list) or len(ledger) < 6:
            raise _H.PublishDataValidationError(f'{paper_label} manual evidenceLedger 不完整')
        if takeover.get('evidenceLedgerSha256') != _manual_hash(ledger):
            raise _H.PublishDataValidationError(f'{paper_label} manual evidenceLedger SHA 不一致')
        if manual_depth in MANUAL_READER_QUALITY_CONTRACTS:
            result_claims = _validate_manual_attributed_result_claims(
                takeover, paper.get('analysis'), paper_label,
            )
            expected_claims_sha = _manual_hash({
                'claims': result_claims,
                'exception': takeover.get('resultClaimsException'),
            })
            if takeover.get('resultClaimsSha256') != expected_claims_sha:
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 resultClaims SHA 不一致'
                )
            rubric = takeover.get('readabilityRubric')
            dimensions = rubric.get('dimensions') if isinstance(rubric, dict) else None
            required_dimensions = {
                'paragraphLogic', 'interParagraphContinuity', 'sectionResponsibility',
                'factLocality', 'terminologyAndPerspective', 'sentenceRhythm',
                'antiTemplateOriginality',
            }
            if not isinstance(dimensions, dict) or set(dimensions) != required_dimensions:
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 readabilityRubric 维度不完整'
                )
            scores = []
            for dimension, entry in dimensions.items():
                if not isinstance(entry, dict) or not isinstance(entry.get('score'), int) \
                        or entry['score'] < 0 or entry['score'] > 2 \
                        or len(str(entry.get('reason') or '').strip()) < 12 \
                        or not isinstance(entry.get('evidence'), list) or not entry['evidence']:
                    raise _H.PublishDataValidationError(
                        f'{paper_label} manual v4 readabilityRubric.{dimension} 非法'
                    )
                scores.append(entry['score'])
            if sum(scores) < 12 or 0 in scores:
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 readabilityRubric 未达到 12/14 且无 0 分'
                )
            if takeover.get('readabilityRubricSha256') != _manual_hash(rubric):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v4 readabilityRubric SHA 不一致'
                )
        if manual_depth in {
                MANUAL_DEPTH_FACT_COVERAGE_CONTRACT,
                MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT,
        }:
            if contracts.get('researcherFocus') != MANUAL_RESEARCH_CONTRACT \
                    or contracts.get('perPaperSubagent') != ('isolated-single-paper-v2'
                        if model_policy == CURRENT_MODEL_POLICY else 'isolated-single-paper-v1'):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 缺少 researcherFocus/perPaperSubagent 契约'
                )
            bound_fields = {
                'researchBriefSha256': 'researchBrief',
                'stageReviewsSha256': 'stageReviews',
                'scoringCalibrationSha256': 'scoringCalibration',
                'openSourceEvidenceSha256': 'openSourceEvidence',
                'figureReviewSha256': 'figureReview',
                'externalResourceVerificationSha256': 'externalResourceVerification',
            }
            for sha_field, value_field in bound_fields.items():
                if takeover.get(sha_field) != _manual_hash(takeover.get(value_field)):
                    raise _H.PublishDataValidationError(
                        f'{paper_label} manual v5 {sha_field} 不匹配'
                    )
            brief = takeover.get('researchBrief')
            subagent = brief.get('paperSubagent') if isinstance(brief, dict) else None
            if (not isinstance(brief, dict)
                    or brief.get('contract') != MANUAL_RESEARCH_CONTRACT
                    or brief.get('audience') != 'audio_researcher'
                    or not isinstance(subagent, dict)
                    or subagent.get('singlePaperOnly') is not True
                    or subagent.get('isolatedContext') is not True):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 researchBrief/subagent provenance 非法'
                )
            stage_reviews = takeover.get('stageReviews')
            review_stages = stage_reviews.get('stages') if isinstance(stage_reviews, dict) else None
            if (not isinstance(stage_reviews, dict) or stage_reviews.get('version') != 2
                    or not isinstance(review_stages, dict)
                    or set(review_stages) != set(MANUAL_STAGE_EVIDENCE_STAGES)):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 stageReviews 未精确覆盖全部阶段'
                )
            figure_review = takeover.get('figureReview')
            decisions = figure_review.get('decisions') if isinstance(figure_review, dict) else None
            if not isinstance(decisions, list):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 figureReview 缺失'
                )
            selected_urls = [
                item.get('url') for item in (paper.get('imageManifest') or {}).get('selected', [])
                if isinstance(item, dict)
            ]
            reviewed_selected = [
                item.get('url') for item in decisions
                if isinstance(item, dict) and item.get('decision') == 'select'
            ]
            # canonical selected 按最终正文插入位置排序；figureReview 保留研究者
            # 审图时的声明顺序。两者应校验同一组唯一 URL，而不是误把顺序当事实。
            if (len(reviewed_selected) != len(set(reviewed_selected))
                    or len(selected_urls) != len(set(selected_urls))
                    or sorted(reviewed_selected) != sorted(selected_urls)):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 figureReview 与 selected 图片不一致'
                )
            if not selected_urls:
                _validate_manual_rejected_image_coverage(paper, decisions, paper_label)
            verification = takeover.get('externalResourceVerification')
            declared_urls = (takeover.get('openSourceEvidence') or {}).get('urls') or []
            outcomes = verification.get('outcomes', []) if isinstance(verification, dict) else []
            outcomes_valid = isinstance(outcomes, list) and all(
                isinstance(item, dict)
                and item.get('status') == 'reachable_public_https'
                and item.get('httpStatus') == 200
                and str(item.get('finalUrl') or '').startswith('https://')
                and isinstance(item.get('verifiedAt'), str)
                and re.fullmatch(
                    r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})',
                    item['verifiedAt'],
                )
                and isinstance(item.get('discoveredLinks'), list)
                and all(str(url).startswith('https://') for url in item['discoveredLinks'])
                for item in outcomes
            )
            if (not isinstance(verification, dict) or verification.get('version') != 1
                    or verification.get('state') != (takeover.get('openSourceEvidence') or {}).get('state')
                    or not outcomes_valid
                    or [item.get('url') for item in outcomes
                        if isinstance(item, dict)] != declared_urls):
                raise _H.PublishDataValidationError(
                    f'{paper_label} Manual v5 外部资源核验记录的格式、版本、状态或访问结果不符合要求，或 URL 内容及顺序与声明不一致。'
                )
            acquisition = manifest.get('sourceAcquisition')
            if not isinstance(acquisition, dict):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 缺少 sourceAcquisition'
                )
            try:
                full_text_path = Path(acquisition.get('fullTextPath', '')).resolve(strict=True)
                controlled_root = (Path(_H.CURRENT_DIR) / 'manual-full-text').resolve(strict=True)
                full_text_path.relative_to(controlled_root)
                source_bytes = full_text_path.read_bytes()
            except (OSError, RuntimeError, ValueError) as exc:
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 全文路径未落在当前受控目录: {exc}'
                ) from exc
            if hashlib.sha256(source_bytes).hexdigest() != acquisition.get('sourceSha256'):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 发布前全文 SHA 漂移'
                )
            source_manifest_path = full_text_path.parent / 'manifest.json'
            try:
                source_manifest_bytes = source_manifest_path.read_bytes()
                source_manifest = json.loads(source_manifest_bytes.decode('utf-8'))
            except (OSError, UnicodeError, json.JSONDecodeError) as exc:
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 发布前无法读取全文 manifest: {exc}'
                ) from exc
            source_id = _H.normalize_publish_arxiv_id(acquisition.get('sourceId'))
            source_entry = (source_manifest.get('papers') or {}).get(source_id)
            if (not isinstance(source_entry, dict)
                    or Path(source_entry.get('path', '')).resolve() != full_text_path
                    or source_entry.get('sourceSha256') != acquisition.get('sourceSha256')
                    or source_entry.get('paperInputSha256') != acquisition.get('paperInputSha256')
                    or source_entry.get('sourceIdentitySha256') != acquisition.get('sourceIdentitySha256')):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual v5 发布前全文 manifest membership 不一致'
                )
            identity_mode = _manual_paper_identity_mode(contracts, paper_label)
            if identity_mode == 'per_paper_v1':
                artifact_manifest_path = source_manifest_path.parent / 'artifacts' / 'manifest.json'
                try:
                    artifact_manifest = json.loads(artifact_manifest_path.read_text(encoding='utf-8'))
                    artifact_entry = (artifact_manifest.get('papers') or {}).get(source_id)
                    artifact_path = Path((artifact_entry or {}).get('path', '')).resolve(strict=True)
                    artifact_path.relative_to(artifact_manifest_path.parent.resolve(strict=True))
                    artifact_bytes = artifact_path.read_bytes()
                    artifact_index = json.loads(artifact_bytes.decode('utf-8'))
                except (OSError, RuntimeError, ValueError, UnicodeError, json.JSONDecodeError) as exc:
                    raise _H.PublishDataValidationError(
                        f'{paper_label} 发布前无法重放逐论文 ArtifactIndex: {exc}'
                    ) from exc
                snapshot = source_entry.get('structuredArtifactsSnapshot')
                if (not isinstance(artifact_entry, dict)
                        or artifact_entry.get('status') != 'complete'
                        or artifact_entry.get('inventoryStatus') != 'complete'
                        or artifact_entry.get('paperId') != source_id
                        or artifact_entry.get('parserVersion') != MANUAL_STRUCTURED_ARTIFACT_PARSER_CONTRACT
                        or artifact_entry.get('sourceSha256') != source_entry.get('sourceSha256')
                        or artifact_entry.get('sourceIdentitySha256') != source_entry.get('sourceIdentitySha256')
                        or artifact_entry.get('paperInputSha256') != source_entry.get('paperInputSha256')
                        or not isinstance(snapshot, dict)
                        or snapshot.get('healthStatus') != 'complete'
                        or snapshot.get('payloadSha256') != artifact_entry.get('structuredArtifactsSha256')
                        or artifact_entry.get('bytes') != len(artifact_bytes)
                        or artifact_entry.get('outputSha256') != hashlib.sha256(artifact_bytes).hexdigest()
                        or artifact_index.get('paperId') != source_id
                        or (artifact_index.get('inventoryHealth') or {}).get('status') != 'complete'
                        or artifact_index.get('artifactIndexSha256') != artifact_entry.get('artifactIndexSha256')):
                    raise _H.PublishDataValidationError(
                        f'{paper_label} 单篇 ArtifactIndex 的完成状态、论文或来源信息不符合要求，或快照、清单与实际文件的字节数或 SHA 不一致。'
                    )
                expected_identity = {
                    'contract': MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT,
                    'date': source_manifest.get('date'),
                    'paperId': source_id,
                    'fullText': {
                        'requestedArxivId': _H.normalize_publish_arxiv_id(source_entry.get('requestedArxivId')),
                        'sourceSha256': source_entry.get('sourceSha256'),
                        'sourceIdentitySha256': source_entry.get('sourceIdentitySha256'),
                        'paperMetadataSha256': source_entry.get('paperMetadataSha256'),
                        'paperInputSha256': source_entry.get('paperInputSha256'),
                        'bytes': source_entry.get('bytes'),
                        'imageInfosSha256': _manual_hash(source_entry.get('imageInfos') or []),
                        'fileName': Path(source_entry.get('path', '')).name,
                    },
                    'artifactIndex': {
                        'parserVersion': artifact_entry.get('parserVersion'),
                        'structuredArtifactsSha256': artifact_entry.get('structuredArtifactsSha256'),
                        'artifactIndexSha256': artifact_entry.get('artifactIndexSha256'),
                        'fileSha256': artifact_entry.get('outputSha256'),
                        'bytes': artifact_entry.get('bytes'),
                        'fileName': artifact_path.name,
                    },
                }
                declared_identity = acquisition.get('paperSourceIdentity')
                if (not isinstance(declared_identity, dict)
                        or declared_identity.get('contract') != MANUAL_PAPER_SOURCE_IDENTITY_CONTRACT
                        or declared_identity.get('value') != expected_identity
                        or declared_identity.get('sha256') != _manual_hash(expected_identity)
                        or _manual_hash(declared_identity.get('value')) != declared_identity.get('sha256')):
                    raise _H.PublishDataValidationError(
                        f'{paper_label} 逐论文来源身份与当前全文/ArtifactIndex 不一致'
                    )
        evidence = takeover.get('stageEvidence')
        stages = manifest.get('stages') or {}
        if not isinstance(evidence, dict):
            raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence 缺失')
        audit_sha = _manual_hash(audit)
        hardened_fields = ('protocol', 'promptSource', 'promptSha256', 'contextSha256')
        hardened = any(
            any(key in (evidence.get(stage) or {}) or key in (stages.get(stage) or {}) for key in hardened_fields)
            for stage in MANUAL_STAGE_EVIDENCE_STAGES
        )
        if not hardened and completed_at[:10] >= MANUAL_BOUND_STAGE_CUTOFF_DATE:
            raise _H.PublishDataValidationError(
                f'{paper_label} manual stageEvidence 缺少 {MANUAL_BOUND_STAGE_CUTOFF_DATE} 起必需的逐阶段 prompt/context 绑定'
            )
        image_manifest = paper.get('imageManifest')
        image_context_fields = {
            'imageDownload': 'downloadEvidenceSha256',
            'imageSupplement': 'selectionEvidenceSha256',
        }
        if hardened:
            if not isinstance(image_manifest, dict) \
                    or not isinstance(image_manifest.get('candidates'), list) \
                    or not isinstance(image_manifest.get('downloadOutcomes'), list) \
                    or not isinstance(image_manifest.get('selected'), list):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual imageManifest 缺少可重算的 candidates/downloadOutcomes/selected'
                )

            def normalize_image_evidence(info):
                normalized = {
                    'url': info.get('url'),
                    'caption': info.get('caption') or '',
                    'source': info.get('source') or None,
                    'sourceOrder': info.get('sourceOrder'),
                    'candidateScore': info.get('candidateScore'),
                }
                # JS 生成 downloadEvidenceSha256 时，未下载/人工拒绝候选的
                # undefined 二进制字段会被 JSON.stringify 省略，而不是写成 null。
                # Python 重算必须保持同一 JSON 语义。
                for optional_key in ('mime', 'sha256', 'bytes'):
                    if optional_key in info:
                        normalized[optional_key] = info.get(optional_key)
                if manual_depth in {
                        MANUAL_DEPTH_FACT_COVERAGE_CONTRACT,
                        MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT,
                }:
                    normalized.update({
                        'reviewDecision': info.get('reviewDecision'),
                        'reviewReason': info.get('reviewReason'),
                        'figureNumber': info.get('figureNumber'),
                        'visibleFacts': info.get('visibleFacts') or [],
                        'renderPlan': info.get('renderPlan'),
                    })
                return normalized

            expected_download_context = _manual_hash({
                'candidates': [normalize_image_evidence(item) for item in image_manifest['candidates']],
                'outcomes': image_manifest['downloadOutcomes'],
            })
            if image_manifest.get('downloadEvidenceSha256') != expected_download_context:
                raise _H.PublishDataValidationError(
                    f'{paper_label} 图片下载记录的 downloadEvidenceSha256 与候选图片及下载结果重新计算的 SHA 不一致。'
                )
            normalized_selected = [
                normalize_image_evidence(item) for item in image_manifest['selected']
            ]
            if image_manifest.get('version', 1) >= 2:
                expected_selection_context = _manual_hash({
                    'selected': normalized_selected,
                    'insertionPlan': image_manifest.get('insertionPlan') or [],
                    'insertionDiagnostics': image_manifest.get('insertionDiagnostics') or [],
                })
            else:
                expected_selection_context = _manual_hash(normalized_selected)
            if image_manifest.get('selectionEvidenceSha256') != expected_selection_context:
                raise _H.PublishDataValidationError(
                    f'{paper_label} 选图记录的 selectionEvidenceSha256 与按当前清单版本从选中图片及相关字段重新计算的 SHA 不一致。'
                )
        for stage in MANUAL_STAGE_EVIDENCE_STAGES:
            item = evidence.get(stage)
            state = stages.get(stage)
            if not isinstance(item, dict) or not isinstance(state, dict) or item.get('status') != state.get('status'):
                raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage} 与阶段状态不一致')
            if manual_depth in {MANUAL_DEPTH_EXPLANATION_CONTRACT, *MANUAL_READER_QUALITY_CONTRACTS} \
                    and (item.get('executionKind') != MANUAL_STAGE_EXECUTION_KIND
                         or state.get('executionKind') != MANUAL_STAGE_EXECUTION_KIND):
                raise _H.PublishDataValidationError(
                    f'{paper_label} manual stageEvidence.{stage}.executionKind 必须为 '
                    f'{MANUAL_STAGE_EXECUTION_KIND}'
                )
            if not isinstance(item.get('attempts'), int) or item['attempts'] < 2:
                raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage} 未记录两轮审计')
            for key in ('inputSha256', 'outputSha256', 'auditSha256'):
                if not re.fullmatch(r'[a-f0-9]{64}', str(item.get(key) or '')):
                    raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.{key} 非法')
            if item['outputSha256'] != takeover['analysisSha256']:
                raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.outputSha256 与最终正文 SHA 不一致')
            if not isinstance(item.get('reviewedClaims'), list) or not item['reviewedClaims']:
                raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.reviewedClaims 不能为空')
            claims = item['reviewedClaims']
            if hardened:
                if item.get('protocol') != MANUAL_PROVENANCE_PROTOCOL \
                        or state.get('protocol') != MANUAL_PROVENANCE_PROTOCOL:
                    raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.protocol 与阶段协议不一致')
                if not isinstance(item.get('promptSource'), str) or not item['promptSource'].strip() \
                        or item['promptSource'] != state.get('promptSource'):
                    raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.promptSource 与阶段 manifest 不一致')
                if not re.fullmatch(r'[a-f0-9]{64}', str(item.get('promptSha256') or '')) \
                        or item['promptSha256'] != state.get('promptSha256'):
                    raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.promptSha256 与阶段 manifest 不一致')
                if stage == 'primaryAnalysis' and item['promptSha256'] != takeover['promptSha256']:
                    raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.promptSha256 与 primaryAnalysis 阶段不一致')
                context_field = image_context_fields.get(stage)
                if context_field:
                    if not re.fullmatch(r'[a-f0-9]{64}', str(item.get('contextSha256') or '')):
                        raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.contextSha256 缺失或非法')
                    if not isinstance(image_manifest, dict) \
                            or item['contextSha256'] != image_manifest.get(context_field):
                        raise _H.PublishDataValidationError(
                            f'{paper_label} manual stageEvidence.{stage}.contextSha256 与 imageManifest.{context_field} 不一致'
                        )
                elif 'contextSha256' in item:
                    raise _H.PublishDataValidationError(f'{paper_label} manual stageEvidence.{stage}.contextSha256 不应存在')
                expected_input_payload = {
                    'stage': stage,
                    'sourceSha256': takeover['sourceSha256'],
                    'analysisSha256': takeover['analysisSha256'],
                    'claims': claims,
                    'stagePromptSha256': item['promptSha256'],
                    'stageContextSha256': item.get('contextSha256'),
                }
                if manual_depth in {MANUAL_DEPTH_EXPLANATION_CONTRACT, *MANUAL_READER_QUALITY_CONTRACTS}:
                    expected_input_payload['executionKind'] = item.get('executionKind')
                expected_input_sha = _manual_hash(expected_input_payload)
            else:
                expected_input_sha = _manual_hash({
                    'stage': stage,
                    'sourceSha256': takeover['sourceSha256'],
                    'analysisSha256': takeover['analysisSha256'],
                    'claims': claims,
                })
            if item['inputSha256'] != expected_input_sha:
                raise _H.PublishDataValidationError(f'{paper_label} 阶段 {stage} 的 inputSha256 与该阶段输入记录重新计算的 SHA 不一致。')
            expected_audit_sha = _manual_hash({
                'stage': stage,
                'claims': claims,
                'auditSha256': audit_sha,
                'stageInputSha256': item['inputSha256'],
            })
            if item['auditSha256'] != expected_audit_sha:
                raise _H.PublishDataValidationError(f'{paper_label} 阶段 {stage} 的 auditSha256 与阶段输入及审核记录重新计算的 SHA 不一致。')
        if manual_depth == MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT:
            validate_signed_manual_payload(paper)
        return
    if takeover.get('version') != 1 or takeover.get('mode') != MANUAL_COMPLETE_STATUS:
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.version/mode 非法')
    if not isinstance(takeover.get('agent'), str) or not takeover['agent'].strip():
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.agent 缺失')
    if takeover.get('basis') != 'full_text':
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.basis 必须为 full_text')
    source_sha = str(paper.get('sourceSha256') or manifest.get('sourceAcquisition', {}).get('sourceSha256') or '')
    if not re.fullmatch(r'[a-f0-9]{64}', str(takeover.get('sourceSha256') or '')):
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 非法')
    if source_sha and takeover['sourceSha256'] != source_sha:
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.sourceSha256 与全文来源不一致')
    completed_at = takeover.get('completedAt')
    if not isinstance(completed_at, str) or not _H.BEIJING_TIMESTAMP_RE.fullmatch(completed_at):
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.completedAt 必须是北京时间 ISO 时间')
    if not isinstance(takeover.get('reason'), str) or len(takeover['reason'].strip()) < 20:
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.reason 过短')
    review = takeover.get('review')
    required_review = ('sourceVerified', 'analysisContractVerified', 'scoringVerified', 'stageEvidenceVerified')
    if not isinstance(review, dict) or any(review.get(key) is not True for key in required_review):
        raise _H.PublishDataValidationError(f'{paper_label} manualTakeover.review 未确认来源、正文、评分和阶段证据')

def validate_manual_depth_contract(analysis):
    """新摄入的人工流程文本如果只是摘要，直接按失败处理。

    这与 Node 摄入闸一致，并且只在清单显式声明 ``full-text-evidence-v1``
    时生效，好让历史 API 记录和更早的人工核验记录继续可读。
    """
    heading_issue = evaluation_heading_issue(analysis)
    if heading_issue:
        return heading_issue
    method = _H._extract_analysis_section(analysis, '方法概述和架构')
    results = _H._extract_analysis_section(analysis, '实验结果')
    details = _H._extract_analysis_section(analysis, '细节详述')
    chinese_count = lambda value: len(re.findall(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]', str(value or '')))
    if chinese_count(method) < 650:
        return f'manual 全文方法证据不足: {chinese_count(method)}/650'
    if chinese_count(results) < 100:
        return f'manual 全文实验证据不足: {chinese_count(results)}/100'
    if chinese_count(details) < 40:
        return f'manual 全文细节证据不足: {chinese_count(details)}/40'
    if re.search(r'从复现角度|本分析|人工(?:审计|接管)|manual_complete|不能由本分析|不补造|实验数字只采用|按来源逐项核对', str(analysis or ''), re.I):
        return 'manual 正文包含流程/审计元话语，必须改写为论文事实'
    return None


MANUAL_DUP_CHECK_SECTIONS = (
    '核心摘要', '方法概述和架构', '核心创新点', '实验结果',
    '细节详述', '评分理由', '局限与问题', '开源详情',
)
MANUAL_DUP_MIN_SENTENCE_CHARS = 15
MANUAL_DUP_MAX_SENTENCES = 2
MANUAL_DUP_MAX_SECTION_SPREAD = 2
MANUAL_EDITORIAL_TEMPLATE_RE = re.compile(
    r'亮点[：:]?\s*一是|优点[：:]?\s*一是|短板是|不足[：:]?\s*一是[^。]{0,120}二是[^。]{0,120}三是'
)
MANUAL_SCORING_ANCHOR_TAG_MIN = 4
MANUAL_SCORING_ANCHOR_TAG_RE = re.compile(r'\[A_[A-Z_]{2,}\]')


def _normalize_manual_dup_sentence(value):
    normalized = unicodedata.normalize('NFKC', str(value or '')).lower()
    return re.sub(r'[\s\W_]+', '', normalized, flags=re.UNICODE)


def find_cross_section_duplicate_sentences(analysis, limit=3):
    sentence_sections = {}
    for section in MANUAL_DUP_CHECK_SECTIONS:
        body = _H._extract_analysis_section(analysis, section)
        if not body:
            continue
        seen_in_section = set()
        for raw_sentence in re.split(r'[。！？!?\n]', body):
            normalized = _normalize_manual_dup_sentence(raw_sentence)
            if len(normalized) < MANUAL_DUP_MIN_SENTENCE_CHARS:
                continue
            if normalized in seen_in_section:
                continue
            seen_in_section.add(normalized)
            sentence_sections.setdefault(normalized, set()).add(section)
    duplicates = [
        {'sentence': sentence, 'sections': sorted(sections)}
        for sentence, sections in sentence_sections.items()
        if len(sections) >= 2
    ]
    duplicates.sort(key=lambda item: item['sentence'])
    return duplicates[:limit]


def validate_manual_source_coverage(analysis):
    """按 Node 的 full-text-evidence-v2 规则检查分析正文。

    检查开源 URL 需要来源全文，而全文不在规范发布记录里；这项检查只在 Node
    导入分析时执行。其余检查在发布前再次执行。
    """
    heading_issue = evaluation_heading_issue(analysis)
    if heading_issue:
        return heading_issue
    base_issue = validate_manual_depth_contract(analysis)
    if base_issue:
        return base_issue
    duplicates = find_cross_section_duplicate_sentences(analysis)
    worst_section_spread = max((len(item['sections']) for item in duplicates), default=0)
    if len(duplicates) > MANUAL_DUP_MAX_SENTENCES or worst_section_spread > MANUAL_DUP_MAX_SECTION_SPREAD:
        example = duplicates[0]
        preview = example['sentence'][:24]
        joined = '、'.join(example['sections'])
        return (
            f'manual 正文存在跨章节自我复制: {len(duplicates)} 个句子重复出现在多个章节'
            f'（如「{preview}…」同时出现在{joined}），每个章节必须独立撰写'
        )
    evaluation = _H._extract_analysis_section(analysis, EVALUATION_TITLE)
    if MANUAL_EDITORIAL_TEMPLATE_RE.search(evaluation or ''):
        return '论文评价使用了固定模板句式（亮点一是二是/短板是），请根据本文证据分别评价贡献和不足。'
    scoring_reason = _H._extract_analysis_section(analysis, '评分理由') or ''
    anchor_tags = set(MANUAL_SCORING_ANCHOR_TAG_RE.findall(scoring_reason))
    if len(anchor_tags) < MANUAL_SCORING_ANCHOR_TAG_MIN:
        return (
            f'manual 评分理由缺少证据锚点标签 [A_*]: 仅 {len(anchor_tags)}'
            f'/{MANUAL_SCORING_ANCHOR_TAG_MIN} 个不同标签，每个维度必须引用可定位的证据组并说明锚点档位'
        )
    return None


def _manual_chinese_count(value):
    return len(re.findall(r'[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]', str(value or '')))


def _manual_prose_paragraphs(value):
    return [
        item.strip() for item in re.split(r'\n\s*\n', str(value or ''))
        if len(item.strip()) > 20 and not item.lstrip().startswith(('|', '!['))
    ]


def _manual_editorial_prose_paragraphs(value):
    """复刻 editorial-quality.js/proseParagraphs，用于 v4 读者闸。

    上面那个旧辅助函数有意服务于若干历史深度检查，会把 Markdown 标题算
    进它所在的空行块。Node 编辑闸则把标题、表格、图片和返回链接都当作
    段落边界，去掉列表标记，只评估读者正文。把这个窄用途的辅助函数单独
    留出来，发布阶段的 v4 复刻才不会仅因为分段方式与摄入阶段不同就否掉
    一篇规范文章。
    """
    paragraphs = []
    pending = []
    fenced_end = None

    def flush():
        if not pending:
            return
        paragraph = re.sub(r'\s+', ' ', ' '.join(pending)).strip()
        if paragraph:
            paragraphs.append(paragraph)
        pending.clear()

    for raw_line in str(value or '').splitlines():
        line = raw_line.strip()
        if fenced_end is not None:
            if fenced_end.search(line):
                fenced_end = None
            continue
        if not line:
            flush()
            continue
        code_fence = re.match(r'^(```|~~~)', line)
        if code_fence:
            flush()
            marker = code_fence.group(1)
            if line.find(marker, len(marker)) < 0:
                fenced_end = re.compile(rf'^{re.escape(marker)}')
            continue
        if line.startswith('$$'):
            flush()
            if line.find('$$', 2) < 0:
                fenced_end = re.compile(r'\$\$\s*$')
            continue
        if line.startswith('\\['):
            flush()
            if not re.search(r'\\\]\s*$', line):
                fenced_end = re.compile(r'\\\]\s*$')
            continue
        if re.match(r'^(?:#{1,6}\s|\||!\[|---+$|\[←)', line):
            flush()
            continue
        if re.match(r'^(?:[-*+]\s+|\d+[.)、]\s+)', line):
            flush()
        line = re.sub(r'^[-*+]\s+', '', line)
        line = re.sub(r'^\d+[.)、]\s+', '', line)
        pending.append(line)
    flush()
    return paragraphs


def _manual_han_character_count(value):
    """按 editorial-quality.js 的做法统计汉字字符。

    `_manual_chinese_count` 是旧的长度启发式，会把 CJK 标点也算进去。
    段落超载是读者正文的对等闸，标点另有自己的句子长度阈值；把它算进来
    会在 260 字符边界附近误报硬失败。
    """
    return len(re.findall(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]', str(value or '')))


def validate_manual_beginner_explanation(analysis):
    """发布阶段复刻读者可见的 Manual v3 质量下限。

    来源绑定的核对清单和数字密度检查已在 Node 摄入阶段跑过。发布阶段
    重跑所有能从规范文章重算的检查，这样过期或手工改过的记录也无法
    绕过 v3。
    """
    v2_issue = validate_manual_source_coverage(analysis)
    if v2_issue:
        return v2_issue

    summary = _H._extract_analysis_section(analysis, '核心摘要')
    method = _H._extract_analysis_section(analysis, '方法概述和架构')
    innovations = _H._extract_analysis_section(analysis, '核心创新点')
    results = _H._extract_analysis_section(analysis, '实验结果')
    details = _H._extract_analysis_section(analysis, '细节详述')
    scoring = _H._extract_analysis_section(analysis, '评分理由')
    limits = _H._extract_analysis_section(analysis, '局限与问题')

    length_gates = (
        ('核心摘要', summary, 360),
        ('方法证据', method, 650),
        ('核心创新点', innovations, 380),
        ('实验证据', results, 300),
        ('细节证据', details, 450),
        ('评分理由', scoring, 250),
        ('局限分析', limits, 300),
    )
    for label, body, minimum in length_gates:
        count = _manual_chinese_count(body)
        if count < minimum:
            return f'manual v3 {label}过短: {count}/{minimum} 个中文字符'

    summary_sentences = [
        item.strip() for item in re.split(r'[。！？!?]', summary)
        if _manual_chinese_count(item) >= 8
    ]
    if len(summary_sentences) < 5:
        return f'manual v3 核心摘要缺少论证推进: {len(summary_sentences)}/5 个有效句子'

    method_paragraphs = _manual_prose_paragraphs(method)
    if len(method_paragraphs) < 5:
        return f'manual v3 方法段落不足: {len(method_paragraphs)}/5'
    method_signals = (
        r'输入|波形|特征|样本|数据',
        r'模块|编码器|解码器|网络|组件|算子|阶段|结构',
        r'训练|优化|损失|目标|监督|更新|拟合|求解|实验|控制|构造|标注|证明',
        r'输出|推理|解码|预测|生成|检索|评估|结果|结论|决策',
    )
    missing_method_signals = sum(not re.search(pattern, method) for pattern in method_signals)
    if missing_method_signals > 1:
        return f'manual v3 方法缺少输入、组件、训练目标或输出边界中的 {missing_method_signals} 类'

    innovation_items = [
        item for item in _manual_prose_paragraphs(innovations)
        if not re.match(r'引导|总的来说', item)
    ]
    if len(innovation_items) < 3:
        return f'manual v3 创新论证不足: {len(innovation_items)}/3 个独立段落'
    innovation_signals = (
        r'相比|相较|比|既有|传统|标准|过去|不同于|不再|无需|而不|而非|避免|问题|限制|瓶颈|缺口|代价',
        r'机制|通过|采用|引入|设计|改为|拆分|把|将|使用|以|定义|提出',
        r'实验|评测|结果|消融|证据|数据|数值|观察|报告|达到|下降|提升|改善|验证',
    )
    if any(not re.search(pattern, innovations) for pattern in innovation_signals):
        return 'manual v3 创新点必须同时说明既有缺口、新机制和实验证据，不能只列贡献名词'

    if not re.search(
        r'相比|相较|比较|配对|对照|基线|baseline|vs\.?|消融|移除|加入|主方法|提出方法|最强|高于|低于|超过|落后|优于|改善|差距|从[^。]{0,40}(?:升至|降至|到)',
        results,
        re.I,
    ):
        return 'manual v3 实验结果缺少明确比较对象或消融关系'
    if not re.search(
        r'但是|但|不过|仅|尚未|不能|限制|边界|未报告|未说明|'
        r'而非|并非|不存在|退化|失败|更差|不显著|跨零',
        results,
    ):
        return 'manual v3 实验结果缺少结论边界或负面结果'

    reproducibility_signals = (
        r'数据|语料|样本|划分|训练集|测试集',
        r'损失|目标|优化器|学习率|训练|求解',
        r'超参数|批量|轮|epoch|步数|阈值|维度|窗口',
        r'硬件|GPU|CPU|显卡|内存|显存|未说明',
        r'推理|解码|延迟|吞吐|部署|测试时|未说明',
    )
    reproducibility_text = f'{method}\n{details}'
    details_coverage = sum(bool(re.search(pattern, reproducibility_text, re.I)) for pattern in reproducibility_signals)
    if details_coverage < 3:
        return f'manual v3 复现信息覆盖不足: {details_coverage}/5 类'

    score_lines = [item.strip() for item in scoring.splitlines() if item.strip().startswith('*')]
    if len(score_lines) != 8:
        return f'manual v3 评分理由必须恰好 8 条: {len(score_lines)}/8'
    for item in score_lines:
        reason = re.sub(r'^\*[^：:]*[：:]\s*', '', item)
        if _manual_chinese_count(reason) < 25:
            return f'manual v3 评分理由过于概括: {item[:80]}'
    if any(re.search(r'(?:创新|方法|实验|清晰度|实用|开源|可复现性|综合)维度(?:认可|体现|有|中)', item) for item in score_lines):
        return 'manual v3 评分理由仍是“某维度认可/体现”模板，必须直接写论文证据与扣分边界'

    if '论文证据直接支持的边界' not in limits or '进一步审视' not in limits:
        return 'manual v3 局限必须分开标注论文证据支持的边界与进一步审视'
    if _manual_chinese_count(limits) < 300:
        return f'manual v3 局限分析过短: {_manual_chinese_count(limits)}/300'
    return None


def _is_discourse_task_condition_numeral(text, index, surface):
    if (index < 1 or not re.fullmatch(r'一个(?:任务|条件|随机种子)', surface)
            or text[index:index + len(surface)] != surface or text[index - 1] not in '上下这另哪'):
        return False
    prefix = re.split(r'[，,。！？；;\n]', text[:index - 1])[-1]
    return not re.search(r'(?:仅|只|至少|至多|恰好|共有|共计|总共|总计|一共|剩余)', prefix)


def _is_person_introduction_numeral(text, match):
    """“这是一位说话人”是在介绍人物，不是在报告实验人数。

    与 editorial-quality.js 的候选豁免同规则：只放过“这是/那是 + 一位 +
    人物名词”，且同一句不能同时出现实验、样本、统计等技术语境。
    """
    if match.group(0) != '一位':
        return False
    if not re.search(r'(?:这|那)是\s*$', text[:match.start()]):
        return False
    clause = re.split(r'[。！？!?；;\n]', text[match.end():])[0]
    if not re.match(r'^.{0,64}?(?:说话人|听者|读者|用户|研究者|作者)', clause):
        return False
    return not re.search(
        r'(?:量化|比特|位宽|编码|精度|实验|样本|人数|统计|均值|平均|错误率|数量)', clause)


def validate_manual_reader_quality(analysis):
    """发布阶段对 Manual v4 读者闸做高置信度复刻。

    完整的近似重复和结果来源检查在 Node 侧、受控全文可用时执行。Python
    重跑那些能从规范 Markdown 精确重算的读者可见检查。
    """
    heading_issue = evaluation_heading_issue(analysis)
    if heading_issue:
        return heading_issue
    sections = {
        name: _H._extract_analysis_section(analysis, heading)
        for name, heading in (
            ('authors', '作者与机构'), ('review', EVALUATION_TITLE),
            ('summary', '核心摘要'), ('method', '方法概述和架构'),
            ('innovations', '核心创新点'), ('results', '实验结果'),
            ('details', '细节详述'), ('limits', '局限与问题'),
            ('scoring', '评分理由'), ('open_source', '开源详情'),
        )
    }
    numeral_chars = '零〇一二两三四五六七八九十百千万亿'
    simple_count_unit_items = (
        'GPU 小时', 'GPU小时', 'GPU 秒', 'GPU秒',
        '毫秒', '秒', '分钟', '小时', '天', '兆赫', '千赫', '赫兹', '分贝',
        '百分点', '毫焦', '皮焦', '兆字节', '千字节', '字节',
        'GB', 'MB', 'KB', 'mJ', 'dB', 'Hz', 'kHz', 'MHz', 'MAC', 'MACs',
        'token', 'tokens', '像素', '采样', '自由度', '帧', '个随机种子', '随机种子',
        '个', '对', '种', '条', '篇', '张', '段', '轮', '步', '次', '倍', '人', '名',
        '例', '维', '层', '位', '核', '类', '组', '路', '级', '阶', '流',
        '通道', '阶段', '分支', '模型', '基准', '数据集', '物种', '会话',
        '目录', '艺人', '轨道', '模态', '套', '卡', '分制', '男', '女',
        '个组件', '个任务', '个条件', '个类别', '个模型', '个数据集',
        '个时间点', '个方向', '个卷积块', '个流', 'worker', 'workers',
        'episode', 'episodes', 'epoch', 'epochs',
    )
    large_count_unit_items = simple_count_unit_items + (
        '个动作', '个样本', '个片段', '个关键词', '个文件', '个条件',
        '个刺激', '名参与者', '样本', '参数', '词', '批', '折', '参与者',
        '题', '轨迹', '主干',
    )
    unit_pattern = lambda items: '|'.join(
        re.escape(item) for item in sorted(set(items), key=len, reverse=True)
    )
    large_count_units = unit_pattern(large_count_unit_items)
    simple_count_units = unit_pattern(simple_count_unit_items)
    exact_quantity_patterns = (
        re.compile(rf'百分之[{numeral_chars}]+(?:点[{numeral_chars}]+)?', re.I),
        re.compile(rf'[负正]?[{numeral_chars}]+点[{numeral_chars}]+', re.I),
        re.compile(
            rf'(?<![第{numeral_chars}])[负正]?[{numeral_chars}]*[十百千万亿][{numeral_chars}]*\s*'
            rf'(?:{large_count_units})', re.I,
        ),
        re.compile(rf'(?<![第{numeral_chars}])[一二两三四五六七八九]\s*(?:{simple_count_units})', re.I),
        re.compile(rf'[负正]?[{numeral_chars}]+(?:到|至|–|—|-)[负正]?[{numeral_chars}]+(?=\s*(?:的)?(?:分数|评分|范围|区间|等级))', re.I),
        re.compile(rf'[{numeral_chars}]+\s*(?:比|:|：)\s*[{numeral_chars}]+', re.I),
        re.compile(rf'[{numeral_chars}]+\s*乘\s*[{numeral_chars}]+', re.I),
        re.compile(rf'[{numeral_chars}]+点[{numeral_chars}]*\d+', re.I),
        re.compile(rf'[{numeral_chars}]+\d+(?=\s*(?:{large_count_units}))', re.I),
        re.compile(rf'[{numeral_chars}]+\s*(?:到|至|–|—|-)\s*\d+(?=\s*(?:{large_count_units}))', re.I),
        re.compile(r'\d+(?:\.\d+)?\s*[万亿](?=\s*(?:更新|参数|样本|条|次|帧|token|tokens|MAC|MACs))', re.I),
        re.compile(r'(?:至少)?一半|四分之一(?:宽)?|[一二两三四五六七八九]成(?=(?:左右|上下|或|以内|以上|比例|占比|水平|样本|数据|案例|[，,。；;、]|$))'),
        re.compile(r'(?:最高|满分|得分|评分|至少|超过|低于|高于|达到)\s*[一二两三四五六七八九]\s*分|[一二两三四五六七八九]\s*分(?:制|量表|以上|以下|满分)|[一二两三四五六七八九]\s*分(?=\s*(?:[，,。；;、]|$))'),
        re.compile(r'[几数]\s*\d+(?=\s*(?:毫秒|秒|分钟|小时|天|Hz|kHz|MHz|MB|GB|KB|mJ|dB|帧|步|倍))', re.I),
        re.compile(
            rf'(?:LoRA\s*)?(?:秩|rank|alpha|缩放系数|阈值|beam|batch(?:\s*size)?|hop|'
            rf'窗口|采样率|分辨率|上下文长度|时间步|通道数|层数|维度)'
            rf'\s*(?:=|为|:)?\s*[{numeral_chars}]+', re.I,
        ),
    )
    reader_template_patterns = (
        re.compile(r'关键比较问题是[：:]'),
        re.compile(r'下图用于核对'),
        re.compile(r'证据边界在于'),
        re.compile(r'下一段将(?:解释|说明|展示|讨论)'),
        re.compile(r'^\s*\d+[.)、]\s*是(?=\S)', re.M),
    )
    reader_spaced_quantifiers = (
        '个百分点', '个随机种子', '名参与者', '个文件', '个会话', '个模型', '个候选', '个组合',
        '个病例', '段录音', '个场景', '个样本', '个片段', '个数据集', '个组件', '个任务',
        '个条件', '个类别', '个时间点', '个方向', '个卷积块',
        '个', '次', '名', '组', '套', '层', '种', '段', '轮', '步', '倍', '人', '例', '类',
        '张', '篇', '条', '对', '位', '路', '维', '帧', '卡', '分制', '会话', '模型', '候选',
        '组合', '病例', '录音', '文件', '场景', '样本', '片段', '数据集', '组件', '任务',
        '条件', '类别', '时间点', '方向', '卷积块',
        '毫秒', '秒', '分钟', '小时', '天', '兆赫', '千赫', '赫兹', '分贝', '毫焦', '皮焦',
        '兆字节', '千字节', '字节', 'mW', 'mJ', 'ms', 'dB', 'Hz', 'kHz', 'MHz',
        'MAC', 'MACs', 'token', 'tokens', '像素', '采样', '自由度',
        # 容量单位（KB/MB/GB/KiB/B）在中文技术写作与模型名里通常紧贴数字（4GB），
        # 不算排版损坏；上下文的数字粘连仍由前后两条规则拦截。
    )
    numeric_connector_prefixes = (
        '分别为', '提高到', '提升至', '增加到', '下降到', '降低至', '降至', '升至',
        '最多保留', '批量分别', '实际选', '每提示', '样本只', '单台',
        '从', '由', '到', '至', '为', '达', '含', '有', '共', '约', '近', '超过', '低于', '高于',
        '提高', '提升', '增加', '下降', '减少', '加入', '读取', '使用', '采用', '包含', '覆盖',
        '处理', '训练', '测试', '运行', '观看', '留出', '选择', '固定', '生成', '组成', '形成',
        '比较', '估算', '执行', '标注', '包括', '总计', '平均', '达到', '放入', '请求',
        '上限', '阈值', '权重', '学习率', '综合分', '版本', '版',
        '第', '在', '以', '把', '与', '和', '及', '或', '是', '只', '各', '选', '转', '加',
        '对', '前', '后', '比', '按', '做', '属于',
    )
    numeric_connector_suffixes = (
        '分别', '以及', '和', '与', '到', '至', '已', '仍', '又', '为', '是', '的', '后', '前',
        '时', '中', '下', '上', '可', '能', '并', '而', '只是', '同时', '属于', '门控',
        '首波', '状态', '地图', '审计', '完整', '主干', '因果', '协议', '声学', '权重',
        '上限', '变化', '设置', '版本', '轨迹', '结果', '记忆',
    )
    reader_number = r'(?<![A-Za-z0-9_.-])[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?'
    numeric_typography_patterns = (
        re.compile(r'[\u4e00-\u9fff][-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?'),
        re.compile(rf'{reader_number}(?=[\u4e00-\u9fff])'),
        re.compile(
            rf'{reader_number}(?:{unit_pattern(reader_spaced_quantifiers)})', re.I,
        ),
        re.compile(
            rf'(?:{unit_pattern(numeric_connector_prefixes)}){reader_number}',
        ),
        re.compile(
            rf'{reader_number}(?:{unit_pattern(numeric_connector_suffixes)})',
        ),
        re.compile(
            r'(?:(?<!加)[下上这另哪])\s*1\s*(?:步|层|类|种|段|项|组|张|个)|'
            r'(?:同|唯|统|单)\s*1\s*(?=[\u4e00-\u9fff])|归\s*1\s*(?=(?:化|后|组合|处理|权重))',
        ),
        re.compile(
            r'[\u4e00-\u9fff][\t \u3000]+一次性|一次性[\t \u3000]+[\u4e00-\u9fff]',
        ),
        re.compile(
            r'[\u4e00-\u9fff](?:T|F|K|N|SNR|IoU|batch|beta|top-k)\s*=\s*\d|'
            r'\b(?:T|F|K|N|SNR|IoU|batch|beta|top-k)\s*=\s*\d+(?:\.\d+)?(?=[\u4e00-\u9fff])',
            re.I,
        ),
        re.compile(r'(?:\d+(?:\.\d+)?(?:D|B|K|M|G|bit|DoF|FPS|Vpp|MHz|GB|TB))(?=[\u4e00-\u9fff])', re.I),
    )
    def _mask_non_newlines(match):
        return re.sub(r'[^\r\n]', ' ', match.group(0))

    for section, body in sections.items():
        body = unicodedata.normalize('NFKC', body)
        # 等长空格屏蔽围栏代码、行内代码、LaTeX 公式、URL 与百分号，避免
        # 代码/公式/链接触发中文数值排版规则，同时保持其余字符偏移不变。
        typography_body = re.sub(
            r'(?m)^[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]{0,3}\1[ \t]*$|\Z)',
            _mask_non_newlines,
            body,
        )
        inline_spans = _H.markdown_inline_code_ranges(typography_body)
        if inline_spans:
            chars = list(typography_body)
            for span_start, span_end in inline_spans:
                for idx in range(span_start, span_end):
                    if chars[idx] not in ('\r', '\n'):
                        chars[idx] = ' '
            typography_body = ''.join(chars)
        typography_body = re.sub(
            r'(?<!\\)\\\([\s\S]*?\\\)|(?<!\\)\\\[[\s\S]*?\\\]|'
            r'(?<!\\)\$\$[\s\S]*?(?<!\\)\$\$|'
            r'(?<![\\$])\$(?!\$)[^\s$\n](?:[^$\n]*?[^\s$\n])?(?<!\\)\$(?![\d$])|'
            r'https?://[^\s<>()\[\]]+',
            _mask_non_newlines,
            typography_body,
        )
        # 百分号属于数值本身；“前10% / 提升19.5%”保留中文常用写法，
        # 不交给连接词粘连规则。等长屏蔽避免改变其余诊断位置。
        typography_body = re.sub(
            r'(?:[\u4e00-\u9fff])?[-+]?\d+(?:\.\d+)?\s*%',
            lambda match: ' ' * len(match.group(0)),
            typography_body,
        )
        # 这段归一化要与 editorial-quality.js/findQuantitativeChineseNumerals 保持
        # 一致。Markdown 标题是给读者看的标签，不是实证结论（例如“从 306 通道
        # 到一个词标签”），“一个 + 形容词”这类固定说法也不是可测量的计数。
        # 替换成等长空白，后续匹配就不会漂到相邻文本上。
        quantity_body = re.sub(
            r'^#{1,6}\s+[^\n]*$',
            lambda match: ' ' * len(match.group(0)),
            body,
            flags=re.M,
        )
        # “三点一致：”中的“一致”是完整名词；保留真正的小数与其他诊断位置。
        quantity_body = re.sub(
            rf'(?<![\d{numeral_chars}])[{numeral_chars}]+点一致(?:性)?(?=\s*(?:[:：，,。；;！？!?]|$))',
            lambda match: ' ' * len(match.group(0)),
            quantity_body,
        )
        quantity_body = re.sub(
            r'[上下这另哪]一个(?:任务|条件|随机种子)',
            lambda match: ' ' * len(match.group(0)) if _is_discourse_task_condition_numeral(
                quantity_body, match.start() + 1, match.group(0)[1:]) else match.group(0),
            quantity_body,
        )
        # 与 Node 对等：仅屏蔽完整操作名，不屏蔽邻近的真实阈值数。
        quantity_body = re.sub(
            r'(?<![\d零〇一二两三四五六七八九十百千万亿])二值化',
            lambda match: ' ' * len(match.group(0)),
            quantity_body,
        )
        # 与 Node 闸一致：一对一是一种结构关系，不是可测量的配对数量。
        # 用等长空白保留诊断偏移。
        quantity_body = re.sub(
            r'(?<![\d零〇一二两三四五六七八九十百千万亿])(?:一|1)\s*对\s*(?:一|1)(?=\s*(?:分配|匹配|映射|对应|关联|对齐|约束|配对))',
            lambda match: ' ' * len(match.group(0)),
            quantity_body,
        )
        quantity_body = re.sub(
            r'(?:进一步|这一步|下一步|上一步|每一步|一次性|这一类|有趣二分)|'
            r'另一个流|'
            r'(?:同一|统一|唯一|单一)(?=[\u4e00-\u9fff])|'
            r'一个(?=(?:好看|漂亮|笼统|粗糙|清晰|完整|简单|直接|孤立|统一))|'
            r'二分(?=(?:解释|结构|视角|框架|法))',
            lambda match: ' ' * len(match.group(0)),
            quantity_body,
        )
        for pattern in exact_quantity_patterns:
            for match in pattern.finditer(quantity_body):
                if _is_person_introduction_numeral(quantity_body, match):
                    continue
                return f'manual v4 {section} 精确定量必须使用阿拉伯数字: {match.group(0)}'
        for pattern in reader_template_patterns:
            match = pattern.search(body)
            if match:
                return f'manual v4 {section} 仍使用批量模板句式: {match.group(0)}'
        for paragraph in re.split(r'\n\s*\n', body):
            if paragraph.strip().endswith(('；', ';')):
                return f'manual v4 {section} 段落以分号中断，必须补成完整论述'
            if re.search(
                r'[，,]\s*(?:但是|不过|然而|但)\s*(?:[。！？!?])?\s*$',
                paragraph,
            ):
                return f'manual v4 {section} 段落以悬空连接词中断，必须补成完整论述'
        broken = re.search(
            r'尚尚|只只|分别分别|只有仅有|单单个|能能(?!否|够)|具有有(?:吸引力|优势|价值|能力|作用|意义|效果|潜力|特点|必要性)|'
            r'更接近区别于|存在也区别于其|无明显退化区别于|却区别于|提高现实性却区别于|2\s*次计算成本|'
            r'[“"]?(?:听懂|理解)[^。！？!?]{0,12}[”"]?区别于(?:能|能够|可以|具备)|'
            r'(?:参数|计算|内存)高效区别于(?:推理|训练|部署)(?:廉价|便宜|成本低)|'
            r'(?:客服|模板|提示)文本区别于(?:自发|真实)(?:客服)?(?:通话|对话|语音)|'
            r'(?:素材池|样本池|数据池)规模[^。！？!?]{0,24}区别于(?:最终)?(?:题量|样本量)|'
            r'源(?:音频|语音|数据)[^。！？!?]{0,16}区别于真实(?:通话|设备|场景|分布)',
            body,
        )
        if broken:
            return f'manual v4 {section} 存在重复或断裂连接表达: {broken.group(0)}'
        for pattern in numeric_typography_patterns:
            match = pattern.search(typography_body)
            if match:
                return f'manual v4 {section} 数值排版或固定词损坏: {match.group(0)}'
        if re.search(
            r'^\s*\d+[.)、]\s*第\s*(?:\d+|[一二两三四五六七八九十百]+)\s*'
            r'(?:项|个|点)(?=[\u4e00-\u9fff\s，,：:])',
            body,
            re.M,
        ):
            return f'manual v4 {section} 存在双重编号'
        if section == 'innovations' and re.search(
            r'(?:^|\n\s*\n)\s*第\s*(?:\d+|[一二两三四五六七八九十百]+)\s*'
            r'(?:项|个)(?=[\u4e00-\u9fff\s，,：:])',
            body,
        ):
            return 'manual v4 innovations 将自动渲染为列表，正文不得重复使用第 N 个/项序数'
        for line in body.splitlines():
            if line.strip() in {'论文证据直接支持的边界', '进一步审视'}:
                return f'manual v4 {section} 暴露裸编辑字段标签'
        visible = re.sub(r'`[^`]*`', '', body)
        visible = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', visible)
        visible = re.sub(r'https?://[^\s)]+|[*_~]+', '', visible)
        adhesion = re.search(r'(?:[\u4e00-\u9fff][A-Za-z][A-Za-z0-9.+-]{1,}|[A-Za-z][A-Za-z0-9.+-]{1,}[\u4e00-\u9fff])', visible)
        if adhesion:
            return f'manual v4 {section} 中英文技术词边界缺少空格: {adhesion.group(0)}'
        for paragraph in _manual_editorial_prose_paragraphs(body):
            if _manual_han_character_count(paragraph) > 260 or len(re.findall(r'[。！？；!?;]', paragraph)) > 7:
                return (f'manual v4 {section} 段落过长：汉字超过 260 个，或中文句号、'
                        '中英文问号、感叹号和分号合计超过 7 个。'
                        '请按主要意思拆成多个段落，并写清前后联系')
    seen = {}
    for section, body in sections.items():
        for sentence in re.split(r'(?<=[。！？!?；;])', body):
            normalized = re.sub(r'[\s\W_]+', '', sentence.lower())
            if len(normalized) < 20:
                continue
            prior = seen.get(normalized)
            if prior and prior != section:
                return f'manual v4 {prior}/{section} 存在重复长句'
            seen[normalized] = section
    return None


FINAL_MANUAL_SECTION_HEADINGS = (
    '作者与机构', EVALUATION_TITLE, LEGACY_EVALUATION_TITLE, '核心摘要', '方法概述和架构',
    '核心创新点', '实验结果', '细节详述', '评分理由',
    '局限与问题', '开源详情', '补充信息',
    # Manual v5 的读者优先页面用一个针对具体论文的解读文章，取代 v4 固定的
    # 方法/创新/结果/细节/局限这套栏目结构。把生成的这个 H3 归一化成读者视图的 H2，
    # 最终页面的证据检查才能稳定地定位到它。
    '深度解读', '开源与复现资源', '评分依据与证据（展开查看）',
)


def _manual_structured_reader_view(markdown):
    """在用于校验的文本副本中，把已知页面栏目转换为分析章节标题。"""
    text = str(markdown or '')
    frontmatter = re.match(r'^---\n.*?\n---\n', text, flags=re.DOTALL)
    if frontmatter:
        text = text[frontmatter.end():]
    headings = '|'.join(re.escape(item) for item in FINAL_MANUAL_SECTION_HEADINGS)
    return re.sub(
        rf'^[^\S\r\n]*#{{1,6}}[^\S\r\n]+'
        rf'(?:[^\w\s#]\ufe0f?[^\S\r\n]*)*({headings})[^\S\r\n]*$',
        lambda match: f'## {normalize_analysis_section_title(match.group(1))}',
        text,
        flags=re.MULTILINE,
    )


def _final_manual_depth_contract(markdown, paper=None):
    if isinstance(paper, dict):
        manifest = paper.get('analysisManifest')
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if isinstance(contracts, dict):
            value = contracts.get('manualDepth')
            if value in MANUAL_READER_QUALITY_CONTRACTS:
                return value
    match = re.search(
        rf'^paper_digest_manual_depth:\s*["\']?'
        rf'({re.escape(MANUAL_DEPTH_READER_QUALITY_CONTRACT)}|{re.escape(MANUAL_DEPTH_FACT_COVERAGE_CONTRACT)}|{re.escape(MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT)})["\']?\s*$',
        str(markdown or ''), flags=re.MULTILINE,
    )
    return match.group(1) if match else None


def _is_final_structured_manual(markdown, paper=None):
    """向后兼容的判断函数：是否为 Manual 读者质量页面（v4/v5）。"""
    return _final_manual_depth_contract(markdown, paper) is not None

def _final_markdown_image_occurrences(markdown):
    blocks = [block.strip() for block in re.split(r'\n\s*\n', str(markdown or '')) if block.strip()]
    occurrences = []
    for index, block in enumerate(blocks):
        bare = re.fullmatch(
            r'!\[(?:\\.|[^\]\\])*\]\((https://[^)\s]+)(?:\s+["\'][^"\']*["\'])?\)',
            block,
        )
        linked = re.fullmatch(
            r'\[!\[(?:\\.|[^\]\\])*\]\((https://[^)\s]+)\)\]\((https://[^)\s]+)\)',
            block,
        )
        # 发布清理会把远程图片包成自链接。先检查外层形式：它内部的 `![](...)`
        # 同样匹配裸图片模式，否则同一张图会被数两次，破坏 selectedImageUrls
        # 的顺序。
        if linked and linked.group(1) == linked.group(2):
            occurrences.append((index, linked.group(1), blocks))
        elif bare:
            occurrences.append((index, bare.group(1), blocks))
    return occurrences


def validate_final_structured_manual_markdown(markdown, paper=None):
    """页面完成发布处理后，重新核验人工流程要求的章节、正文和图片说明。

    根据记录或页面标记选择 v4、v5 或 v6 规则；未使用这些格式时返回 None。
    分析记录通过检查，并不表示组装后的页面也符合要求。
    """
    manual_depth = _final_manual_depth_contract(markdown, paper)
    if manual_depth is None:
        return None
    if isinstance(paper, dict):
        manifest = paper.get('analysisManifest')
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if isinstance(contracts, dict) \
                and contracts.get('manualDepth') in MANUAL_READER_QUALITY_CONTRACTS \
                and not re.search(
                    rf'^paper_digest_manual_depth:\s*["\']?(?:{re.escape(MANUAL_DEPTH_READER_QUALITY_CONTRACT)}|{re.escape(MANUAL_DEPTH_FACT_COVERAGE_CONTRACT)}|{re.escape(MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT)})["\']?\s*$',
                    str(markdown or ''), flags=re.MULTILINE,
                ):
            return '最终 Markdown 缺少 Manual v4 深度标记'

    heading_issue = evaluation_heading_issue(markdown, rendered=True)
    if heading_issue:
        return heading_issue
    reader_view = _manual_structured_reader_view(markdown)
    is_v5_reader_article = manual_depth in {
        MANUAL_DEPTH_FACT_COVERAGE_CONTRACT,
        MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT,
    }
    required = (
        ('核心摘要', '深度解读', '评分依据与证据（展开查看）')
        if manual_depth == MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT else
        ('核心摘要', '深度解读') if is_v5_reader_article else
        ('核心摘要', '方法概述和架构', '核心创新点', '实验结果',
         '细节详述', '局限与问题')
    )
    missing = [heading for heading in required if not _H._extract_analysis_section(reader_view, heading)]
    if missing:
        version = 'v6' if manual_depth == MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT \
            else ('v5' if is_v5_reader_article else 'v4')
        return f'最终 Markdown 缺少 Manual {version} 读者章节: {"、".join(missing)}'

    signed_manual_payload = None
    if manual_depth == MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT:
        if not isinstance(paper, dict):
            return '核验最终 Manual v6 页面时，必须提供对应的正式论文记录。'
        try:
            signed_manual_payload = validate_signed_manual_payload(paper)
        except _H.PublishDataValidationError as exc:
            return f'最终 Manual v6 页面的正式论文记录未通过验证：{exc}'
        provenance_record = signed_manual_payload['provenance']
        marker_values = {
            'paper_digest_v6_runtime_mode': 'production',
            'paper_digest_reader_longform': MANUAL_SIGNED_LONGFORM_CONTRACT,
            'paper_digest_reader_longform_sha256': provenance_record['readerLongformSha256'],
            'paper_digest_reader_article_sha256': signed_manual_payload['articleSha256'],
            'paper_digest_artifact_index_sha256': signed_manual_payload['artifactIndexSha256'],
            'paper_digest_v6_spec_root_sha256': provenance_record['specRootSha256'],
            'paper_digest_v6_paper_spec_sha256': provenance_record['paperSpecSha256'],
            'paper_digest_v6_sealed_record_sha256': provenance_record['sealedRecordSha256'],
            'paper_digest_v6_record_file_sha256': provenance_record['recordFileSha256'],
            'paper_digest_v6_artifact_index_file_sha256': provenance_record['artifactIndexFileSha256'],
            'paper_digest_v6_records_envelope_file_sha256': provenance_record['recordsEnvelopeFileSha256'],
            'paper_digest_v6_task_evidence_sha256': provenance_record['taskEvidenceSha256'],
        }
        for field, expected in marker_values.items():
            match = re.search(
                rf'^{re.escape(field)}:\s*["\']?([^"\'\s]+)["\']?\s*$',
                str(markdown or ''), flags=re.MULTILINE,
            )
            if not match or match.group(1) != expected:
                return f'最终 Manual v6 页面 {field} 与 canonical 绑定不一致'
        nested_article = re.sub(
            r'^(#{1,6})(\s+)',
            lambda match: '#' * max(len(match.group(1)), 4) + match.group(2),
            signed_manual_payload['article'], flags=re.MULTILINE,
        )
        expected_article = _H.sanitize_markdown_for_publish(nested_article).strip()
        actual_article = _H._extract_analysis_section(reader_view, '深度解读').strip()
        actual_article = actual_article.split(
            '\n<details>\n<summary>📎 论文与评分元数据</summary>', 1,
        )[0].strip()
        if actual_article != expected_article:
            return '最终 Manual v6 页面的深度解读与正式正文块的渲染结果不一致。'
        scoring_reason = str((paper.get('parsed') or {}).get('scoringReason') or '').strip()
        scoring_section = _H._extract_analysis_section(
            reader_view, '评分依据与证据（展开查看）',
        )
        expected_scoring = _H.sanitize_markdown_for_publish(re.sub(
            r'^(#{1,6})(\s+)',
            lambda match: '#' * max(len(match.group(1)), 4) + match.group(2),
            scoring_reason, flags=re.MULTILINE,
        )).strip()
        if not expected_scoring or expected_scoring not in scoring_section:
            return '正式评分记录的展示内容为空，或最终 Manual v6 页面的评分依据没有完整包含这份内容。'
        for table in signed_manual_payload['deterministicTables']:
            if table not in actual_article:
                return '最终 Manual v6 页面遗漏或改写了 ArtifactIndex 确定性表格'
        bundle = signed_manual_payload['bundle']
        artifact = signed_manual_payload['artifactIndex']
        formulas = {
            str(item.get('id') or item.get('url') or ''): item
            for item in artifact.get('formulas') or [] if isinstance(item, dict)
        }
        for item in bundle.get('formulas') or []:
            if item.get('disposition') == 'omit':
                continue
            source = formulas.get(str(item.get('id') or item.get('url') or ''), {})
            raw = _normalize_signed_manual_text(source.get('raw') or source.get('latex') or source.get('text'))
            if (raw and raw not in actual_article) or _normalize_signed_manual_text(item.get('explanation')) not in actual_article:
                return '最终 Manual v6 页面公式原式或教学解释缺失'
        for item in bundle.get('terms') or []:
            if (_normalize_signed_manual_text(item.get('term')) not in actual_article
                    or _normalize_signed_manual_text(item.get('definition')) not in actual_article):
                return '最终 Manual v6 页面术语首次定义缺失'
        for item in bundle.get('relatedWorks') or []:
            if (_normalize_signed_manual_text(item.get('relationship')) not in actual_article
                    or _normalize_signed_manual_text(item.get('difference')) not in actual_article):
                return '最终 Manual v6 页面 related-work 关系或差异缺失'

    if (isinstance(paper, dict)
            and not _manual_signed_reader_compatibility(
                paper, paper.get('analysisManifest'),
            )):
        manifest = paper.get('analysisManifest')
        takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
        if not isinstance(takeover, dict):
            return '最终 Markdown 缺少 authoritative Manual v4 resultClaims'
        try:
            _validate_manual_attributed_result_claims(
                takeover,
                reader_view,
                str(paper.get('arxivId') or paper.get('id') or 'authoritative paper'),
                reader_section='深度解读' if is_v5_reader_article else '实验结果',
            )
        except _H.PublishDataValidationError as exc:
            return f'最终页面的结果声明与读者正文的对应检查未通过：{exc}'

    selected = None
    if isinstance(paper, dict) and isinstance(paper.get('selectedImageUrls'), list):
        excluded = {
            item.get('url') for item in paper.get('publishImageExclusions', [])
            if isinstance(item, dict) and isinstance(item.get('url'), str)
        }
        selected = [
            str(url) for url in paper['selectedImageUrls']
            if isinstance(url, str) and url.startswith('https://') and url not in excluded
        ]
    occurrences = _final_markdown_image_occurrences(reader_view)
    occurrence_urls = [url for _index, url, _blocks in occurrences]
    if signed_manual_payload is not None:
        figure_sources = {
            str(item.get('id') or item.get('url') or ''): str(item.get('url') or '')
            for item in signed_manual_payload['artifactIndex'].get('figures') or []
            if isinstance(item, dict)
        }
        expected_figure_urls = [
            figure_sources.get(str(item.get('id') or item.get('url') or ''), '')
            for item in signed_manual_payload['bundle'].get('figures') or []
            if isinstance(item, dict) and item.get('disposition') != 'omit'
        ]
        if (not all(expected_figure_urls)
                or sorted(occurrence_urls) != sorted(expected_figure_urls)):
            return '最终 Manual v6 图片没有逐项以独立 Markdown 图块进入正文'
    if selected is not None and occurrence_urls != selected:
        return '最终 Markdown 图片 URL/顺序与 selectedImageUrls 不一致'
    for index, url, blocks in occurrences:
        if index == 0 or index + 1 >= len(blocks):
            return f'{url} 在最终 Markdown 中缺少图前或图后相邻正文'
        issue = _H._validate_image_narrative_pair(blocks[index - 1], blocks[index + 1])
        if issue:
            return f'{url} 最终 Markdown 图片叙事无效: {issue}'

    document_type = ''
    if isinstance(paper, dict):
        document_type = str((paper.get('parsed') or {}).get('documentType') or '')
    if not document_type:
        match = re.search(r'(?:^|[|\n])\s*文档类型[：:]\s*([^|\n]+)', reader_view)
        document_type = match.group(1).strip() if match else ''
    saved_results_section = ''
    if isinstance(paper, dict):
        saved_results_section = _H._extract_analysis_section(
            str(paper.get('analysis') or ''), '实验结果',
        )
    if not is_v5_reader_article:
        table_issue = _H.validate_experiment_table_contract(
            reader_view,
            contract_version=_H.EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type=document_type,
            # Node 已经把证据充分的来源闸绑定到受控全文的实验切片上。到最终页面
            # 阶段，只有规范实验章节是权威依据：这里用整篇分析，会让方法/局限里
            # 出现的“消融”“退化”等词产生实验证据里根本不存在的来源义务。
            source_text=saved_results_section,
        )
        if table_issue:
            return f'最终 Markdown evidence-rich 表格无效: {table_issue}'

    seen_paragraphs = set()
    for block in re.split(r'\n\s*\n', reader_view):
        stripped = block.strip()
        if not stripped or stripped.startswith(('#', '|', '![', '-', '*', '>', '```', '~~~')):
            continue
        if _manual_chinese_count(stripped) < 30:
            continue
        normalized = re.sub(
            r'[\s\W_]+', '', unicodedata.normalize('NFKC', stripped).casefold(),
        )
        if normalized in seen_paragraphs:
            return '最终 Markdown 存在完全重复的长正文段落'
        seen_paragraphs.add(normalized)

    editorial_issue = validate_manual_reader_quality(reader_view)
    if editorial_issue:
        return f'最终 Markdown 读者文本质量无效: {editorial_issue}'
    return None
