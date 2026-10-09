#!/usr/bin/env python3
"""根据已核验的来源记录生成会议论文页面，不为会议论文添加 arXiv 身份。"""

import hashlib
import base64
import html
import ipaddress
import json
import os
import re
import sys
import math
from urllib.parse import quote, urlsplit

from analysis_sections import analysis_heading_titles, normalize_analysis_section_title, evaluation_heading_issue
from blog_entry_loader import load_publish_to_blog
from tag_stage_record import TAG_STAGE_RECORD_CONTRACT, read_tag_stage_record
from tag_catalog import (TAG_SELECTION_CONTRACT, LEGACY_TAG_SELECTION_CONTRACT,
                         TAG_FLAT_COMPAT_CONTRACT, LEGACY_TAG_FLAT_COMPAT_CONTRACT)
from runtime_guard import require_external_runtime
from publish_common import _assert_hash_key_premises, _assert_ecmascript_number_premises


PAPER_ID = re.compile(r'^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$')
WEAK = {'fullText': 'weak', 'tables': 'unavailable', 'formulas': 'unavailable', 'figures': 'unavailable'}
FULL = {'fullText': 'full', 'tables': 'available', 'formulas': 'available', 'figures': 'available'}
PDF_VISUAL = {'fullText': 'full', 'tables': 'unavailable', 'formulas': 'unavailable', 'figures': 'available'}
READER_CONTRACT = 'beginner-researcher-v3'
SOURCE_BINDINGS_CONTRACT = 'api-reader-source-bindings-v4'
SCORING_CONTRACT = 'api-scoring-audit-v2'
PUBLICATION_CONTRACT = 'conference-official-publication-v1'
FLAT_TAG_CONTRACT = TAG_FLAT_COMPAT_CONTRACT
SOURCE_URL_NORMALIZATION_CONTRACT = 'paper-source-repository-url-normalization-v1'
CONFERENCE_IMAGE_BASE_URL = os.environ.get(
    'PAPER_DIGEST_IMAGE_BASE_URL',
    'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main',
).rstrip('/')
ARXIV_URL_PATTERN = r'https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/[^\s<>)]+'
ARXIV_URL_RE = re.compile(ARXIV_URL_PATTERN, re.IGNORECASE)
REPOSITORY_HOSTS = {'github.com', 'gitlab.com', 'huggingface.co', 'modelscope.cn'}
SCORE_DIMENSIONS = (
    ('innovationScore', '创新', '2'), ('technicalRigorScore', '技术严谨', '1.5'),
    ('experimentalSufficiencyScore', '实验充分', '1.5'), ('clarityScore', '清晰度', '1'),
    ('impactScore', '影响力', '1.5'), ('openSourceScore', '开源', '1.5'),
    ('reproducibilityScore', '可复现', '0.5'), ('engineeringScore', '工程/实践', '1.5'),
)
REQUIRED_ANALYSIS_SECTIONS = (
    '评分', '机器摘要', '标签', '作者与机构', '论文评价', '核心摘要', '方法概述和架构',
    '核心创新点', '实验结果', '细节详述', '评分理由', '局限与问题', '开源详情',
)


def stable_sha(value):
    # 有效 Unicode 保持原有序列化字节；模型文本中的孤立 UTF-16 代理字符使用转义。
    # 此处与 Node 的 JSON.stringify 转义方式对应，不把全部中文转为 ASCII 转义。
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode(
        'utf-8', 'backslashreplace'
    )
    return hashlib.sha256(raw).hexdigest()


def reader_record_sha(value, label):
    """算与 Node 共用的会议记录 SHA 前，先核对跨语言前提。

    会议页里的读者记录、资源身份和公式证据都由 Node 先算一份，再由这里复算。
    Node 的 stableFingerprint 用 JSON.stringify 写这些哈希，这里用 json.dumps。
    数字写法与键排序的分歧见 publish_common 里两个 _assert 函数的说明。
    """
    _assert_hash_key_premises(value, label)
    _assert_ecmascript_number_premises(value, label)
    return stable_sha(value)


def public_https(value, label, *, conference_only=False):
    if not isinstance(value, str) or not value.strip() or value != value.strip():
        raise ValueError(f'{label} 必须是非空 HTTPS URL')
    parsed = urlsplit(value)
    hostname = (parsed.hostname or '').lower()
    try:
        ipaddress.ip_address(hostname)
        literal = True
    except ValueError:
        literal = False
    try:
        port = parsed.port
    except ValueError:
        raise ValueError(f'{label} 端口非法') from None
    labels = hostname.split('.')
    valid_dns = len(labels) > 1 and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', item)
                                          for item in labels)
    # 网址片段用于页面内定位，例如 #demo 或 #code，不会发送给网络服务器。
    # 资源网址通过下方检查后，可以保留片段并生成可点击链接。
    if parsed.scheme != 'https' or parsed.username or parsed.password or port \
            or not hostname or literal or hostname == 'localhost' or hostname.endswith('.localhost') \
            or not valid_dns or (conference_only and (
                hostname == 'arxiv.org' or hostname.endswith('.arxiv.org'))):
        raise ValueError(f'{label} 必须是公开会议 HTTPS URL')
    return value


def hide_arxiv_links(value):
    """隐藏正文中的 arXiv 预印本链接，会议版来源继续由页面的官方记录提供。"""
    text = str(value or '')
    note = '（预印本链接未在会议页展示）'
    text = re.sub(
        rf'\[([^\]\n]+)\]\(\s*<?{ARXIV_URL_PATTERN}>?\s*\)',
        rf'\1{note}', text, flags=re.IGNORECASE)
    text = re.sub(rf'<\s*{ARXIV_URL_PATTERN}\s*>', note, text, flags=re.IGNORECASE)
    return ARXIV_URL_RE.sub(note, text)


def is_arxiv_url(value):
    return bool(re.search(r'https?://(?:www\.)?arxiv\.org/', str(value or ''), re.IGNORECASE))


def fold_repository_token_line_breaks(value):
    if not isinstance(value, str):
        return None
    token = value.strip()
    if not token or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', token) \
            or re.search(r'\r?\n[ \t]*\r?\n', token):
        return None
    breaks = list(re.finditer(r'\r?\n[ \t]*', token))
    if len(breaks) > 3:
        return None
    for line_break in breaks:
        previous = token[line_break.start() - 1] if line_break.start() else ''
        next_character = token[line_break.end()] if line_break.end() < len(token) else ''
        if previous != '/' and next_character != '/' \
                and re.fullmatch(r'[._~-]', previous) is None \
                and re.fullmatch(r'[._~-]', next_character) is None:
            return None
    folded = re.sub(r'\r?\n[ \t]*', '', token)
    return None if re.search(r'\s', folded) else folded


def normalized_repository_source_token(value):
    token = fold_repository_token_line_breaks(value)
    if not token:
        return None
    try:
        parsed = urlsplit(token if token.lower().startswith('https://') else f'https://{token}')
        port = parsed.port
    except ValueError:
        return None
    segments = [item for item in parsed.path.split('/') if item]
    if parsed.scheme != 'https' or parsed.username or parsed.password or port \
            or parsed.query or parsed.fragment or (parsed.hostname or '').lower() not in REPOSITORY_HOSTS \
            or len(segments) < 2 or any(item in {'.', '..'} \
                                        or not re.fullmatch(r'[A-Za-z0-9._~-]+', item) for item in segments):
        return None
    return f'https://{parsed.hostname.lower()}/{"/".join(segments)}'


def paper_source_resource_binding(resource):
    quote_text = resource.get('sourceQuote')
    original = resource.get('originalUrl')
    if not isinstance(quote_text, str) or hashlib.sha256(quote_text.encode()).hexdigest() \
            != resource.get('sourceQuoteSha256'):
        return False
    if isinstance(original, str) and original in quote_text:
        return True
    token = resource.get('sourceUrlToken')
    return resource.get('sourceUrlBindingContract') == SOURCE_URL_NORMALIZATION_CONTRACT \
        and isinstance(token, str) and hashlib.sha256(token.encode()).hexdigest() \
        == resource.get('sourceUrlTokenSha256') and token in quote_text \
        and normalized_repository_source_token(token) == original


def validate_reader_source_records(paper, manifest, stage, capabilities):
    plan, article = paper.get('apiReaderPlan'), paper.get('apiReaderArticle')
    authors, resources = paper.get('apiReaderAuthors'), paper.get('apiReaderResources')
    contracts = (manifest or {}).get('contracts') or {}
    if not isinstance(plan, dict) or not isinstance(article, str) or not article.strip() \
            or contracts.get('apiReaderArticle') != READER_CONTRACT \
            or contracts.get('apiReaderSourceBindings') != SOURCE_BINDINGS_CONTRACT \
            or plan.get('version') != 3 or plan.get('contract') != READER_CONTRACT \
            or plan.get('sourceBindingsContract') != SOURCE_BINDINGS_CONTRACT \
            or stage.get('status') != 'complete':
        raise ValueError('conference Reader 合同不是 beginner-researcher-v3/source-bindings-v4')
    article_sha, plan_sha = hashlib.sha256(article.encode()).hexdigest(), \
        reader_record_sha(plan, 'API reader 编辑计划')
    figures = paper.get('apiReaderFigures')
    source_bindings_sha = reader_record_sha({
        'tableBindings': plan.get('tableBindings'), 'formulaBindings': plan.get('formulaBindings')},
        'API reader 来源绑定')
    common_records_match = paper.get('apiReaderArticleSha256') == article_sha and stage.get('articleSha256') == article_sha \
        and paper.get('apiReaderPlanSha256') == plan_sha and stage.get('planSha256') == plan_sha \
        and plan.get('sourceBindingsSha256') == source_bindings_sha \
        and stage.get('sourceBindingsContractVersion') == SOURCE_BINDINGS_CONTRACT \
        and stage.get('sourceBindingsSha256') == source_bindings_sha \
        and re.fullmatch(r'[a-f0-9]{64}', str(stage.get('structuredArtifactsSha256') or '')) \
        and stage.get('structuredArtifactsSha256') == ((manifest or {}).get('sourceAcquisition') or {}).get('structuredArtifactsSha256')
    if capabilities == WEAK:
        reader_records_match = common_records_match and figures == [] and plan.get('figurePlacements') == [] \
            and plan.get('tableBindings') == [] and plan.get('formulaBindings') == [] \
            and stage.get('figureCount') == 0 and stage.get('tableBindingCount') == 0 \
            and stage.get('formulaBindingCount') == 0 and stage.get('figuresSha256') == stable_sha([])
    elif capabilities in (FULL, PDF_VISUAL):
        reader_records_match = common_records_match and isinstance(figures, list) and isinstance(plan.get('figurePlacements'), list) \
            and isinstance(plan.get('tableBindings'), list) and isinstance(plan.get('formulaBindings'), list) \
            and stage.get('figureCount') == len(figures) \
            and stage.get('tableBindingCount') == len(plan['tableBindings']) \
            and stage.get('formulaBindingCount') == len(plan['formulaBindings']) \
            and stage.get('figuresSha256') == reader_record_sha(figures, 'API reader 图片记录')
        if capabilities == PDF_VISUAL:
            reader_records_match = reader_records_match and plan.get('formulaBindings') == [] and all(
                isinstance(binding, dict) and binding.get('sourceType') == 'source_quotes'
                and binding.get('sourceTableOrdinal') is None
                for binding in plan.get('tableBindings', []))
    else:
        reader_records_match = False
    if not reader_records_match:
        raise ValueError('conference Reader bytes/plan/structure capability is not sealed; unavailable structure cannot be inferred')
    if not isinstance(authors, dict) or contracts.get('apiReaderAuthorIdentity') != 'api-reader-author-identity-v1' \
            or reader_record_sha(authors, 'API reader 作者记录') != stage.get('readerAuthorsSha256') \
            or authors.get('identitySha256') \
            != reader_record_sha(authors.get('identity'), 'API reader 作者来源记录') \
            or stage.get('readerAuthorIdentitySha256') != authors.get('identitySha256') \
            or not isinstance(authors.get('authors'), list) or not authors['authors']:
        raise ValueError('会议论文解读的作者与机构记录格式无效、为空，或与格式声明及保存哈希不一致。')
    for author in authors['authors']:
        if not isinstance(author, dict) or not isinstance(author.get('name'), str) or not author['name'].strip() \
                or not isinstance(author.get('affiliations'), list) or not author['affiliations'] \
                or any(not isinstance(item, str) or not item.strip() for item in author['affiliations']):
            raise ValueError('会议论文解读的作者记录格式无效，或姓名及机构列表缺少非空文字。')
    if not isinstance(resources, dict) or contracts.get('apiReaderResourceIdentity') != 'api-reader-resource-identity-v1':
        raise ValueError('会议论文解读的资源记录格式无效，或格式声明不符合要求。')
    resource_identity = dict(resources)
    resource_identity.pop('identitySha256', None)
    if resources.get('identitySha256') != reader_record_sha(resource_identity, 'API reader 资源身份记录') \
            or stage.get('resourceIdentitySha256') != resources.get('identitySha256') \
            or not isinstance(resources.get('resources'), list) \
            or stage.get('resourceCount') != len(resources['resources']):
        raise ValueError('会议论文解读的资源列表不是数组，或条目数量或内容哈希与保存记录不一致。')
    for resource in resources['resources']:
        if not isinstance(resource, dict) or resource.get('availability') not in {
                'available', 'unavailable', 'temporarily_unreachable'}:
            raise ValueError('会议论文解读的资源条目必须是对象，且可达状态须为允许的值。')
        if resource.get('origin') == 'paper_source':
            if not paper_source_resource_binding(resource):
                raise ValueError('无法按原文引句及保存记录核实会议论文解读中的资源原始网址。')
        elif resource.get('origin') != 'validated_demo' \
                or resource.get('originalUrl') not in ((manifest.get('stages') or {}).get('demoLinkScan') or {}).get('discoveredLinks', []):
            raise ValueError('会议论文解读的资源来源未标记为已核验演示，或原始网址不在演示链接扫描记录中。')
        # 历史记录中可能存在不完整的网址。资源已标记为不可用或暂时无法访问时，
        # 允许继续处理，但不能据此声称资源已开放，也不在这里删除原资源记录。
        # 资源标记为 available 时，原始地址与最终地址都必须通过公开 HTTPS 地址检查。
        try:
            public_https(resource.get('originalUrl'), '资源的原始网址')
            public_https(resource.get('finalUrl'), '资源的最终网址')
        except ValueError:
            if resource.get('availability') in {'unavailable', 'temporarily_unreachable'}:
                print('会议论文解读中的资源链接未通过公开 HTTPS 地址检查；'
                      '该资源已标记为不可用或暂时无法访问，本次继续处理：'
                      f'{resource.get("originalUrl")}', file=sys.stderr)
                continue
            raise
    return plan, article, authors['authors'], resources['resources']


def score_line(parsed):
    try:
        score = float(parsed.get('score'))
        dimensions = [(label, float(parsed.get(field)), maximum) for field, label, maximum in SCORE_DIMENSIONS]
    except (TypeError, ValueError):
        raise ValueError('总分或八个评分维度缺失，或无法转换为数字。') from None
    if not 0 <= score <= 10 or any(not 0 <= value <= float(maximum) for _, value, maximum in dimensions):
        raise ValueError('总分或评分维度的数值不在允许范围内。')
    detail = ' | '.join(f'{label} {value:.1f}/{maximum}' for label, value, maximum in dimensions)
    return f'**{score:.1f}/10** | {detail}'


def render_resource_lines(resources):
    labels = {'code': '代码相关资源', 'model': '模型相关资源', 'dataset': '数据相关资源',
              'demo': '演示资源', 'reproduction': '复现相关资源', 'third_party': '第三方资源'}
    statuses = {'available': '链接可访问', 'unavailable': '链接不可用',
                'temporarily_unreachable': '暂时无法访问'}

    def link(url):
        return '<' + re.sub(r'[<>"\\\s]', lambda match: quote(match.group(0), safe=''), url) + '>'

    visible_resources = [resource for resource in resources
                         if not is_arxiv_url(resource.get('originalUrl'))
                         and not is_arxiv_url(resource.get('finalUrl'))]
    lines = []
    for resource in visible_resources:
        original = resource['originalUrl']
        final = resource['finalUrl']
        urls = link(original) + (f' → {link(final)}' if final != original else '')
        status = statuses[resource['availability']]
        if resource.get('status') is not None:
            status += f'（HTTP {resource["status"]}）'
        lines.append(f'- {labels[resource["type"]]}：{urls} — {status}')
    if len(visible_resources) != len(resources):
        lines.append('预印本/扩展版链接未在会议页展示；会议版来源见页首官方记录与 PDF。')
    if not lines:
        lines.append('本次未形成可展示的已核验资源记录，开放状态尚未核实。')
    lines.append('可达状态仅表示本次链接检查结果，不代表许可证、本文权重或运行复现已验证。')
    return lines


def render_scoring_notes(paper, parsed, stage):
    lines = ['评分属于系统判断，不是论文实验结果；八维数值与总分见页首，原始审计记录保留在后端。']
    for label, value in (('评分规则', paper.get('scoringRubricVersion') or parsed.get('scoringRubricVersion')),
                         ('评分模型', stage.get('model')), ('评分请求协议', stage.get('protocol'))):
        if isinstance(value, str) and value.strip():
            clean = re.sub(r'\s+', ' ', value.strip())
            lines.append(f'- {label}：{html.escape(clean)}')
    return lines


def scoring_stability_is_resolved(stage):
    if stage.get('stabilityWarning') is not True:
        return True
    resolution = stage.get('stabilityResolution') or {}
    numeric = ('firstAuditScore', 'secondAuditScore', 'scoreDifference')
    return resolution.get('contract') == 'api-scoring-stability-resolution-v1' \
        and resolution.get('status') == 'resolved' \
        and resolution.get('method') == 'second_pass_consensus' \
        and all(isinstance(resolution.get(field), (int, float)) and not isinstance(resolution.get(field), bool)
                for field in numeric) \
        and resolution['scoreDifference'] <= 0.3 \
        and re.fullmatch(r'[a-f0-9]{64}', str(resolution.get('secondAuditSha256') or '')) is not None


def render_formula_image_section(evidence, paper_id, conference_id, pdf_url):
    """把经过认证的 PDF 裁剪区域投影成可见图片，绝不直接展示 TeX。"""
    if evidence is None:
        return [], []
    body = {key: value for key, value in evidence.items() if key != 'evidenceSha256'}
    if evidence.get('contract') != 'conference-pdf-formula-images-v1' \
            or evidence.get('evidenceSha256') != reader_record_sha(body, '会议公式证据') \
            or not re.fullmatch(r'[a-f0-9]{64}', str(evidence.get('pdfSha256', ''))) \
            or not re.fullmatch(r'[a-f0-9]{64}', str(evidence.get('sourceSnapshotSha256', ''))) \
            or not isinstance(evidence.get('regions'), list) \
            or type(evidence.get('candidateCount')) is not int \
            or evidence['candidateCount'] < len(evidence['regions']) or len(evidence['regions']) > 32:
        raise ValueError('conference formula image evidence is invalid')
    regions = evidence['regions']
    if not regions and not evidence['candidateCount']:
        return [], []
    directory = stable_sha({'kind': 'pdf-formula-images-v1', 'paperId': paper_id,
                            'evidenceSha256': evidence['evidenceSha256']})[:12]
    lines = ['## 📐 原文公式与排版', '',
             '以下展示论文原页中的数学表达区域，保留原始上下标、分式和符号排版。区域序号仅用于本文导航，不是论文公式编号。', '']
    assets = []
    total_bytes = 0
    for index, region in enumerate(regions, 1):
        expression = region.get('sourceExpression') or {}
        crop = expression.get('crop') or {}
        if region.get('ordinal') != index or type(region.get('page')) is not int or region['page'] < 1 \
                or expression.get('contract') != 'pdf-formula-source-expression-v1' \
                or expression.get('kind') != 'recovered-from-pdf-layout' \
                or expression.get('originalTexAvailable') is not False \
                or crop.get('dpi') != 144 or crop.get('mediaType') != 'image/png' \
                or not isinstance(crop.get('base64'), str) or len(crop['base64']) > 4 * math.ceil(512 * 1024 / 3) \
                or not isinstance(crop.get('bbox'), list) or len(crop['bbox']) != 4 \
                or not all(type(x) in (int, float) and math.isfinite(x) for x in crop['bbox']) \
                or not 0 < crop['bbox'][2] - crop['bbox'][0] <= 420 \
                or not 0 < crop['bbox'][3] - crop['bbox'][1] <= 96:
            raise ValueError('conference formula image region is invalid')
        try:
            raw = base64.b64decode(crop['base64'], validate=True)
        except ValueError as exc:
            raise ValueError('conference formula PNG is invalid') from exc
        if not 24 <= len(raw) <= 512 * 1024 or not raw.startswith(b'\x89PNG\r\n\x1a\n') \
                or not 0 < int.from_bytes(raw[16:20], 'big') <= 842 \
                or not 0 < int.from_bytes(raw[20:24], 'big') <= 194 \
                or hashlib.sha256(raw).hexdigest() != crop.get('sha256'):
            raise ValueError('conference formula PNG SHA drifted')
        total_bytes += len(raw)
        if total_bytes > 8 * 1024 * 1024:
            raise ValueError('conference formula image budget exceeded')
        # 复用现有的不可变图片资产传输方式，不改动
        # 发布器：公式图片有自己按内容绑定的目录。
        relative = f'{conference_id}/{directory}/figure-{index}.png'
        url = f'{CONFERENCE_IMAGE_BASE_URL}/{relative}'
        assets.append({'path': f'static/images/conference/{relative}', 'base64': crop['base64']})
        lines.extend([f'![原文数学表达区域 {index}，PDF 第 {region["page"]} 页]({url})', '',
                      f'区域 {index} · [查看论文原页]({pdf_url}#page={region["page"]})', ''])
    if evidence['candidateCount'] > len(regions):
        lines.extend([f'另有 {evidence["candidateCount"] - len(regions)} 个候选区域因边界不明确或图片数量、尺寸限制未展开；'
                      f'请[查看完整论文]({pdf_url})中的原始排版。', ''])
    return lines, assets


def repair_caption_quoted_gloss_links(markdown):
    """在生成的图片图注里保留带引号的注音原样。"""
    output = []
    fence = None
    pattern = re.compile(r"(?<![\\!])\[([^\[\]\n]+)\]\((‘[^‘’\n]*’|“[^“”\n]*”|'[^'\n]*'|\"[^\"\n]*\")\)")
    for line in str(markdown).split('\n'):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if marker:
            if fence is None:
                fence = (marker.group(1)[0], len(marker.group(1)))
            elif marker.group(1)[0] == fence[0] and len(marker.group(1)) >= fence[1] and not marker.group(2).strip():
                fence = None
        elif fence is None:
            ending = '\r' if line.endswith('\r') else ''
            text = line[:-1] if ending else line
            if re.fullmatch(r'\*论文图\s+\d+。[^\n]*\*', text):
                # 只有新增的带引号注音修复会跳过复杂的图注行。
                # 未改动的既有渲染修复仍然可能处理这些行。
                caption = text[1:-1]
                complex_line = any(marker in caption for marker in ('\\', '$', '`', '<', '>', '*', '_', '~', '!['))
                depth = 0
                for char in caption:
                    if char == '[':
                        depth += 1
                        complex_line = complex_line or depth > 1
                    elif char == ']':
                        depth -= 1
                        complex_line = complex_line or depth < 0
                if not complex_line and depth == 0:
                    line = pattern.sub(lambda match: f'&#91;{match.group(1)}&#93;({match.group(2)})', text) + ending
        output.append(line)
    return '\n'.join(output)


def repair_reader_figure_caption_emphasis(markdown):
    """把生成的斜体图片图注行里字面的星号用文字表达出来。"""
    pattern = re.compile(r'^\*论文图\s+(\d+)。([^\n]*)\*$', re.MULTILINE)

    def replace(match):
        caption = re.sub(r'(?:\\\*){3}|\*{3}', '三个星号', match.group(2))
        caption = re.sub(r'(?:\\\*){2}|\*{2}', '两个星号', caption)
        caption = re.sub(r'\\?\*', '一个星号', caption)
        return f'*论文图 {match.group(1)}。{caption}*'

    return pattern.sub(replace, str(markdown))


def repair_formula_delimiters(markdown):
    """让 TeX 定界符和生成的图片图注保持对 Markdown 安全。"""
    markdown = repair_reader_figure_caption_emphasis(repair_caption_quoted_gloss_links(markdown))
    # 模型可能把行内控制词元嵌进代码段里，例如
    # `` `turn off `<EOT>``。这种双反引号结尾的形态要在这里
    # 修掉，在共用的发布器清理器里也要修：会议渲染器
    # 可能在另一条 Python 模块搜索路径下被加载，
    # 而暂存页面在被核验保存之前必须已经安全。
    markdown = re.sub(
        r'`([^`\n]*)`<([A-Za-z][A-Za-z0-9_†-]{0,40})>``',
        lambda match: f'`{match.group(1)}&lt;{match.group(2)}&gt;`',
        str(markdown),
    )
    # PDF 图片图注里可能有字面方括号，例如 ``f[k]`` 或
    # ``s = [1, 0, ...]``。右方括号同时也是 Markdown 图片语法，
    # 所以替代文本里凡是尚未转义的方括号都必须保持转义。
    # 检查 TeX 时，发布检查会忽略完整图片标签中的内容，
    # 因为这些字节属于图注文字而不是数学公式。
    # 结束定界符是紧跟 ``(`` 的那个 ``]``；
    # 图注本身可能含有普通的 ``[`` 和 ``]`` 字符。
    image = re.compile(r'!\[([^\n]*?)\]\(([^)\n]+)\)')

    def image_alt(match):
        alt = []
        slash_run = 0
        for char in match.group(1):
            if char == '\\':
                alt.append(char)
                slash_run += 1
                continue
            if char in '[]' and slash_run % 2 == 0:
                alt.append('\\')
            alt.append(char)
            slash_run = 0
        alt = ''.join(alt)
        return f'![{alt}]({match.group(2)})'

    markdown = image.sub(image_alt, str(markdown))
    pattern = re.compile(r'(?<!\\)\\+\[([\s\S]*?)(\\+)\]|(?<!\\)\\+\(([\s\S]*?)(\\+)\)', re.DOTALL)

    def replace(match):
        display, _display_slashes, inline, _inline_slashes = match.groups()
        value = display if display is not None else inline
        value = value.replace('<', r'\lt ').replace('>', r'\gt ')
        return (r'\[' if display is not None else r'\(') + value + (r'\]' if display is not None else r'\)')

    return pattern.sub(replace, str(markdown))


def render_packet(packet):
    if 'tagMetadata' in packet and 'taxonomy' in packet:
        raise ValueError('页面生成输入不能同时包含 tagMetadata 和旧字段 taxonomy。')
    paper = packet.get('paper')
    assignment = packet.get('tagMetadata') if 'tagMetadata' in packet else packet.get('taxonomy')
    paper_id, conference, capabilities = packet.get('paper_id'), packet.get('conference'), packet.get('capabilities')
    if not isinstance(paper, dict) or not isinstance(assignment, dict) or not PAPER_ID.fullmatch(str(paper_id or '')):
        raise ValueError('会议论文及其标签记录必须为对象，且论文 ID 必须符合会议论文格式。')
    if paper.get('id') != paper_id or paper.get('conferencePaperId') != paper_id \
            or paper.get('arxivId') is not None or paper.get('paper_id') != paper_id:
        raise ValueError('conference paper must not carry an arXiv alias')
    if assignment.get('status') != 'assigned' or assignment.get('paperId') != paper_id \
            or capabilities not in (WEAK, FULL, PDF_VISUAL):
        raise ValueError('会议论文的标签记录或来源能力记录无效，标签记录不属于当前论文，或来源能力不在允许范围内。')
    manifest = paper.get('analysisManifest')
    stage = ((manifest or {}).get('stages') or {}).get('apiReaderArticle') or {}
    plan, article, authors, resources = validate_reader_source_records(paper, manifest, stage, capabilities)
    assets = []
    if capabilities in (FULL, PDF_VISUAL):
        asset_by_url = {}
        for item in packet.get('figureAssets') or []:
            if not isinstance(item, dict) or not isinstance(item.get('url'), str) \
                    or not isinstance(item.get('base64'), str) or not re.fullmatch(r'[a-f0-9]{64}', str(item.get('assetSha256') or '')) \
                    or item.get('mediaType') != 'image/png' \
                    or not re.fullmatch(r'(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?', item['base64']):
                raise ValueError('conference Figure asset packet is invalid')
            raw = __import__('base64').b64decode(item['base64'], validate=True)
            if hashlib.sha256(raw).hexdigest() != item['assetSha256'] or item['url'] in asset_by_url:
                raise ValueError('conference Figure asset packet SHA or identity is invalid')
            asset_by_url[item['url']] = item
        # 旧路径只根据论文 ID 推导。这样一来，
        # 修正后的裁剪区域会与已经发布的 PNG 冲突，
        # 而会议发布器有意拒绝覆盖现有的
        # 二进制资产。把公开目录绑定到完整的图片
        # 像素集合，裁剪一变就会得到新的不可变路径。
        figure_set = [
            {'ordinal': int(figure.get('ordinal')), 'assetSha256': asset_by_url[figure.get('url')]['assetSha256']}
            for figure in paper.get('apiReaderFigures') or []
            if figure.get('url') in asset_by_url
        ]
        figure_hash = hashlib.sha256(json.dumps(
            {'paperId': paper_id, 'figures': figure_set},
            ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest()[:12]
        for figure in paper.get('apiReaderFigures') or []:
            source_url = figure.get('url')
            packet_asset = asset_by_url.get(source_url)
            if not packet_asset:
                raise ValueError(f'conference Figure {figure.get("ordinal")} lacks publishable pixel asset')
            path = f'static/images/conference/{conference["id"]}/{figure_hash}/figure-{int(figure["ordinal"])}.png'
            # 会议图片和现有的每日文章图片一样，
            # 存放在专用的 GitHub Pages 图片仓库里。把暂存路径
            # 当作逻辑上的来源身份；发布时把它映射进
            # 图片仓库，并把字节提交到那里。
            public_url = f'{CONFERENCE_IMAGE_BASE_URL}/{conference["id"]}/{figure_hash}/figure-{int(figure["ordinal"])}.png'
            # 图片序号共享前缀（图片 1 是图片 11 的前缀）。
            # 直接做字符串替换会把后者变成
            # ``figure-1.png1``。只替换完整的自定义 URL 词元。
            article = re.sub(re.escape(str(source_url)) + r'(?!\d)', public_url, article)
            # 较早的 Reader 草稿里已经是本地 Hugo 资产 URL
            # （`/images/conference/...`），而不是图片来源 URL。
            # 这个确定性路径也要改写，否则页面在暂存阶段能过，
            # 等字节提交到专用图片仓库之后，
            # 却指向一个并不存在的博客本地资产。
            local_pattern = (
                rf'(?<![A-Za-z0-9])(?:/static)?/images/conference/'
                rf'{re.escape(conference["id"])}/[a-f0-9]{{12}}/'
                rf'figure-{int(figure["ordinal"])}\.png(?!\d)'
            )
            article = re.sub(local_pattern, public_url, article)
            assets.append({'path': path, 'base64': packet_asset['base64']})
    scoring_stage = ((manifest or {}).get('stages') or {}).get('scoringAudit') or {}
    analysis = paper.get('analysis')
    heading_issue = evaluation_heading_issue(analysis)
    if heading_issue:
        raise ValueError(heading_issue)
    headings = [normalize_analysis_section_title(title) for title in analysis_heading_titles(analysis)]
    acquisition = (manifest or {}).get('sourceAcquisition') or {}
    if headings != list(REQUIRED_ANALYSIS_SECTIONS) or acquisition.get('fullTextAvailable') is not True \
            or acquisition.get('analysisSource') == 'abstract' \
            or not isinstance(analysis, str) or not analysis.strip() or scoring_stage.get('status') != 'complete' \
            or scoring_stage.get('scoringContract') != SCORING_CONTRACT \
            or scoring_stage.get('outputAnalysisSha256') != hashlib.sha256(analysis.encode()).hexdigest() \
            or not scoring_stability_is_resolved(scoring_stage):
        raise ValueError('会议论文的分析正文、全文来源或评分审计记录不符合 api-scoring-audit-v2 要求。')
    concepts = {item['id']: item for item in assignment.get('concepts', [])}
    ordered = []
    for concept_id in [assignment.get('primaryTaskId'), assignment.get('primaryMethodId'), *assignment.get('conceptIds', [])]:
        if concept_id and concept_id not in ordered:
            ordered.append(concept_id)
    tag_record = read_tag_stage_record(manifest, paper.get('analysisStageCheckpoints'))
    tag_stage = tag_record['stage'] or {}
    tag_contract = ((manifest or {}).get('contracts') or {}).get(tag_record['contractKey'])
    selection_contract = tag_stage.get('selectionContract') if tag_record['format'] == 'current' else tag_contract
    supported_selection_contracts = (LEGACY_TAG_SELECTION_CONTRACT, TAG_SELECTION_CONTRACT)
    if assignment.get('flatCompatContract') not in (LEGACY_TAG_FLAT_COMPAT_CONTRACT, FLAT_TAG_CONTRACT) \
            or (tag_record['format'] == 'current' and tag_contract != TAG_STAGE_RECORD_CONTRACT) \
            or assignment.get('selectionContract') not in supported_selection_contracts \
            or selection_contract not in supported_selection_contracts \
            or (tag_record['format'] != 'current' and 'selectionContract' in tag_stage
                and tag_stage['selectionContract'] != tag_contract) \
            or assignment.get('registryVersion') != tag_stage.get('registryVersion') \
            or assignment.get('registrySha256') != tag_stage.get('registrySha256') \
            or assignment.get('primaryTaskId') != tag_stage.get('primaryTaskId') \
            or assignment.get('primaryMethodId') != tag_stage.get('primaryMethodId') \
            or sorted(assignment.get('conceptIds') or []) != sorted(tag_stage.get('conceptIds') or []) \
            or tag_stage.get('status') not in {'complete', 'not_needed'}:
        raise ValueError('会议论文的标签选择记录与分析阶段记录的协议、词表或所选标签不一致，或标签阶段尚未完成。')
    if any(cid not in concepts for cid in ordered):
        raise ValueError('会议论文的标签记录中，部分主标签或已选概念没有对应的概念记录。')
    labels = [concepts[cid]['preferredLabel']['zh'] for cid in assignment.get('conceptIds', [])]
    parsed = paper.get('parsed') or {}
    title, summary = str(paper.get('title') or '').strip(), str(parsed.get('summary') or '').strip()
    short_proceedings = acquisition.get('analysisConfidence') == 'short_proceedings'
    reader_title = str(plan.get('readerTitle') or '').strip()
    one_sentence = str(plan.get('oneSentenceThesis') or '').strip()
    rank_bucket, document_type = str(parsed.get('rankBucket') or '').strip(), str(parsed.get('documentType') or '').strip()
    scoring = str(parsed.get('scoringReason') or '').strip()
    complete_score = score_line(parsed)
    publication = packet.get('publication')
    if not title or not summary or not reader_title or not one_sentence or not rank_bucket or not document_type or not scoring \
            or not isinstance(publication, dict) or publication.get('contract') != PUBLICATION_CONTRACT:
        raise ValueError('会议论文的标题、摘要、解读标题、核心观点、排名、文档类型或评分说明为空，或发布记录格式及规则不符合要求。')
    record_url = public_https(publication.get('recordUrl'), 'official record URL', conference_only=True)
    pdf_url = public_https(publication.get('pdfUrl'), 'official PDF URL', conference_only=True)
    if publication != paper.get('conferencePublication') or record_url == pdf_url:
        raise ValueError('会议论文的发布记录与论文中保存的记录不一致，或官方记录地址与 PDF 地址相同。')
    if capabilities == WEAK and packet.get('formulaEvidence'):
        raise ValueError('weak source cannot carry formula image evidence')
    formula_lines, formula_assets = render_formula_image_section(
        packet.get('formulaEvidence'), paper_id, conference['id'], pdf_url)
    assets.extend(formula_assets)
    publisher = load_publish_to_blog()
    category = f'{conference["id"]} 论文'
    lines = ['---', f'title: "{publisher.yaml_escape(title)}"', f'date: {packet["date"]}', 'draft: false',
             f'description: "{publisher.yaml_escape(one_sentence)}"',
             f'tags: {json.dumps(labels, ensure_ascii=False)}', f'categories: {json.dumps([category], ensure_ascii=False)}',
             'paper_digest_pipeline_owned: true', 'paper_digest_page_type: paper',
             f'paper_digest_paper_id: {json.dumps(paper_id, ensure_ascii=False)}', 'paper_digest_source_kind: conference',
             f'paper_digest_conference_id: {json.dumps(conference["id"])}',
             f'paper_digest_conference_record_url: {json.dumps(record_url)}',
             f'paper_digest_conference_pdf_url: {json.dumps(pdf_url)}',
             f'paper_digest_api_reader_contract: "{READER_CONTRACT}"',
             f'paper_digest_api_reader_article_sha256: "{paper["apiReaderArticleSha256"]}"',
             f'paper_digest_api_reader_plan_sha256: "{paper["apiReaderPlanSha256"]}"',
             f'paper_digest_api_reader_source_binding_contract: "{SOURCE_BINDINGS_CONTRACT}"',
             f'paper_digest_api_reader_source_bindings_sha256: "{plan["sourceBindingsSha256"]}"',
             f'paper_digest_api_reader_source_table_count: {stage["tableBindingCount"]}',
             f'paper_digest_api_reader_source_formula_count: {stage["formulaBindingCount"]}',
             f'paper_digest_api_reader_structured_artifacts_sha256: "{stage["structuredArtifactsSha256"]}"',
             'paper_digest_api_reader_author_identity_contract: "api-reader-author-identity-v1"',
             f'paper_digest_api_reader_author_identity_sha256: "{paper["apiReaderAuthors"]["identitySha256"]}"',
             f'paper_digest_api_reader_author_count: {len(authors)}',
             'paper_digest_api_reader_resource_identity_contract: "api-reader-resource-identity-v1"',
             f'paper_digest_api_reader_resource_identity_sha256: "{paper["apiReaderResources"]["identitySha256"]}"',
             f'paper_digest_api_reader_resource_count: {len(resources)}',
             'paper_digest_api_reader_decision_projection: "api-reader-decision-projection-v2"',
             f'paper_digest_scoring_contract: "{SCORING_CONTRACT}"',
             f'paper_digest_tags_contract: "{FLAT_TAG_CONTRACT}"',
             f'paper_digest_tags_selection_contract: "{assignment["selectionContract"]}"',
             f'paper_digest_tags_registry_version: "{assignment["registryVersion"]}"',
             f'paper_digest_tags_registry_sha256: "{assignment["registrySha256"]}"',
             'paper_digest_tags_concepts: ' + json.dumps([
                 {'id': cid, 'facet': concepts[cid]['facet'], 'label': concepts[cid]['preferredLabel']['zh']}
                 for cid in assignment['conceptIds']], ensure_ascii=False, separators=(',', ':'), sort_keys=True),
             f'paper_digest_primary_task: {json.dumps(concepts[assignment["primaryTaskId"]]["preferredLabel"]["zh"], ensure_ascii=False)}',
             f'paper_digest_primary_method: {json.dumps(concepts[assignment["primaryMethodId"]]["preferredLabel"]["zh"], ensure_ascii=False)}',
             f'paper_digest_score: {float(parsed["score"]):.1f}',
             f'paper_digest_rank_bucket: {json.dumps(rank_bucket, ensure_ascii=False)}',
             f'paper_digest_document_type: {json.dumps(document_type, ensure_ascii=False)}',
             f'paper_digest_conference_structure: {"pdf-visual-quote-evidence-v1" if capabilities == PDF_VISUAL else "replayable-pdf-layout-v1" if capabilities == FULL else "weak-text-only-v1"}', '---', '',
             f'# 📄 {reader_title}', '', f'> 英文题目：*{title}*', '',
             f'> 会议身份：`{paper_id}`', '',
             ('> ⚠️ 来源为会议 PDF 弱结构纯文本；表格、公式与 Figure 均不可用，本文不会据此重建这些结构。' if capabilities == WEAK else ''),
             ('> ℹ️ 这是短篇 proceedings PDF；正文较短，但分析使用封存的完整 PDF 文本，未降级为摘要。' if short_proceedings else ''),
             ('> 来源为官方会议 PDF；图片依据原页像素，表格数字依据原文引用。PDF 文字层不视为原始 TeX，未可靠恢复的结构不作推断。' if capabilities == PDF_VISUAL else ''),
             ('> ✅ 来源为官方会议 PDF；可重放的表格、公式与 Figure 像素已按 PDF 抽取结果绑定。PDF 公式以原页区域图片展示，未冒称作者原始 TeX；未成功恢复的结构不作推断。' if capabilities == FULL else ''), '',
             f'> 会议来源：[官方记录]({record_url}) · [官方 PDF]({pdf_url})', '',
             f'标签：{" ".join("#" + label for label in labels)}', '', f'评分：{complete_score}', '',
             f'排名：{rank_bucket} | 文档类型：{document_type}', '', '## 👥 作者与机构', '']
    for author in authors:
        lines.append(f'- {author["name"]}：{"；".join(author["affiliations"])}')
    lines.extend(['', '## 📌 核心摘要', '', summary, '', '## 🔗 开源与复现资源', '',
                  *render_resource_lines(resources), '', '## 🧭 深度解读', '', article.strip(), '',
                  *formula_lines,
                  '## ⚖️ 评分明细', '', *render_scoring_notes(paper, parsed, scoring_stage), ''])
    lines.extend(['---', '', f'[← 返回 {conference["id"]} 论文汇总]({packet["aggregateUrl"]})', ''])
    lines[-1:] = [hide_arxiv_links(line) for line in lines[-1:]]
    markdown = repair_formula_delimiters(hide_arxiv_links('\n'.join(lines)))
    return {'markdown': publisher.sanitize_markdown_for_publish(markdown), 'assets': assets}


def packet_bytes():
    arguments = sys.argv[1:]
    if not arguments:
        return sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
    if len(arguments) != 2 or arguments[0] != '--packet-file':
        raise ValueError('usage: conference-page-render.py [--packet-file ABSOLUTE_PATH]')
    packet_path = os.path.abspath(arguments[1])
    if not os.path.isabs(arguments[1]) or os.path.islink(packet_path) or not os.path.isfile(packet_path):
        raise ValueError('conference renderer packet file must be a regular non-symlink file')
    return open(packet_path, 'rb', buffering=0).read(64 * 1024 * 1024 + 1)


def main():
    require_external_runtime('conference-page-render.py')
    raw = packet_bytes()
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('conference renderer packet exceeds 64 MiB')
    packet = json.loads(raw.decode('utf-8'))
    sys.stdout.write(json.dumps(render_packet(packet), ensure_ascii=False))


if __name__ == '__main__':
    main()
