#!/usr/bin/env python3
"""根据已核验的来源记录生成会议论文页面，不为会议论文添加 arXiv 身份。"""

import hashlib
import base64
import html
import ipaddress
import json
import os
import re
import stat
import sys
import math
from urllib.parse import quote, urlsplit

from analysis_sections import analysis_heading_titles, normalize_analysis_section_title, evaluation_heading_issue
from blog_entry_loader import load_publish_to_blog
from scoring_stability import scoring_stability_is_resolved
from paper_reader_presentation import (build_reader_presentation, SCORE_DIMENSIONS,
                                       normalize_repeated_bold_prefixes, reader_score_line,
                                       build_aggregate_reader_presentations)
from tag_presentation import FACET_DISPLAY_LABELS, render_tag_hierarchy_markdown
from tag_catalog import load_tag_catalog, load_archived_tag_catalog, resolve_compatible_proof_catalog
from tag_stage_record import TAG_STAGE_RECORD_CONTRACT, is_tag_stage_record_declaration, read_tag_stage_record
from tag_catalog import (tag_catalog_identity,is_supported_flat_tag_contract, is_supported_tag_selection_contract,TAG_SELECTION_CONTRACT, LEGACY_TAG_SELECTION_CONTRACT,
                         TAG_FLAT_COMPAT_CONTRACT, LEGACY_TAG_FLAT_COMPAT_CONTRACT)
from runtime_guard import require_external_runtime
from publish_common import _assert_hash_key_premises, _assert_ecmascript_number_premises
import protocol_codec as protocols
from scoring_record_format import has_scoring_audit_format
from reader_record_format import (is_integrated_plan, validate_bindings, stage_matches,
                                  identity_binding)
from publication_local_replay import (publication_replay_scope, render_process_guard,
    render_budget_seconds, LocalReplayFailure, RenderDeadlineExceeded, emit_replay_failure)


PAPER_ID = re.compile(r'^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$')
WEAK = {'fullText': 'weak', 'tables': 'unavailable', 'formulas': 'unavailable', 'figures': 'unavailable'}
FULL = {'fullText': 'full', 'tables': 'available', 'formulas': 'available', 'figures': 'available'}
PDF_VISUAL = {'fullText': 'full', 'tables': 'unavailable', 'formulas': 'unavailable', 'figures': 'available'}
PDF_VISUAL_TABLES = {'fullText': 'full', 'tables': 'available', 'formulas': 'unavailable', 'figures': 'available'}
FLAT_TAG_CONTRACT = TAG_FLAT_COMPAT_CONTRACT
SOURCE_URL_NORMALIZATION_CONTRACT = 'paper-source-repository-url-normalization-v1'
CONFERENCE_IMAGE_BASE_URL = os.environ.get(
    'PAPER_DIGEST_IMAGE_BASE_URL',
    'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main',
).rstrip('/')
ARXIV_URL_PATTERN = r'https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/[^\s<>)]+'
ARXIV_URL_RE = re.compile(ARXIV_URL_PATTERN, re.IGNORECASE)
REPOSITORY_HOSTS = {'github.com', 'gitlab.com', 'huggingface.co', 'modelscope.cn'}
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
            or not is_integrated_plan(plan) or not validate_bindings(contracts, stage, plan) \
            or stage.get('status') != 'complete':
        raise ValueError('会议 Reader 文章及来源绑定声明不属于已登记的完整格式')
    article_sha, plan_sha = hashlib.sha256(article.encode()).hexdigest(), \
        reader_record_sha(plan, 'API reader 编辑计划')
    figures = paper.get('apiReaderFigures')
    source_bindings_sha = reader_record_sha({
        'tableBindings': plan.get('tableBindings'), 'formulaBindings': plan.get('formulaBindings')},
        'API reader 来源绑定')
    common_records_match = paper.get('apiReaderArticleSha256') == article_sha and stage.get('articleSha256') == article_sha \
        and paper.get('apiReaderPlanSha256') == plan_sha and stage.get('planSha256') == plan_sha \
        and plan.get('sourceBindingsSha256') == source_bindings_sha \
        and stage_matches(stage, 'sourceBindings') \
        and stage.get('sourceBindingsSha256') == source_bindings_sha \
        and re.fullmatch(r'[a-f0-9]{64}', str(stage.get('structuredArtifactsSha256') or '')) \
        and stage.get('structuredArtifactsSha256') == ((manifest or {}).get('sourceAcquisition') or {}).get('structuredArtifactsSha256')
    if capabilities == WEAK:
        reader_records_match = common_records_match and figures == [] and plan.get('figurePlacements') == [] \
            and plan.get('tableBindings') == [] and plan.get('formulaBindings') == [] \
            and stage.get('figureCount') == 0 and stage.get('tableBindingCount') == 0 \
            and stage.get('formulaBindingCount') == 0 and stage.get('figuresSha256') == stable_sha([])
    elif capabilities in (FULL, PDF_VISUAL, PDF_VISUAL_TABLES):
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
        elif capabilities == PDF_VISUAL_TABLES:
            reader_records_match = reader_records_match and plan.get('formulaBindings') == []
    else:
        reader_records_match = False
    if not reader_records_match:
        raise ValueError('conference Reader bytes/plan/structure capability is not sealed; unavailable structure cannot be inferred')
    if not isinstance(authors, dict) or not identity_binding(paper, 'authors') \
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
    if not isinstance(resources, dict) or not identity_binding(paper, 'resources'):
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
    return reader_score_line(parsed)



def render_formula_image_section(evidence, paper_id, conference_id, pdf_url):
    """把已经核验的 PDF 裁剪区域展示为图片，不把文字层当作原始 TeX。"""
    if evidence is None:
        return [], []
    body = {key: value for key, value in evidence.items() if key != 'evidenceSha256'}
    if not protocols.has_valid_header(evidence, 'conference-pdf-formula-images') \
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
    directory_domain = protocols.contract('conference-formula-image-directory') \
        if protocols.is_current_header(evidence, 'conference-pdf-formula-images') \
        else protocols.historical_contract('conference-formula-image-directory', 'original-pdf-regions')
    directory = stable_sha({'kind': directory_domain, 'paperId': paper_id,
                            'evidenceSha256': evidence['evidenceSha256']})[:12]
    lines = ['## 📐 原文公式与排版', '',
             '以下展示论文原页中的数学表达区域，保留原始上下标、分式和符号排版。区域序号仅用于本文导航，不是论文公式编号。', '']
    assets = []
    total_bytes = 0
    for index, region in enumerate(regions, 1):
        expression = region.get('sourceExpression') or {}
        crop = expression.get('crop') or {}
        if region.get('ordinal') != index or type(region.get('page')) is not int or region['page'] < 1 \
                or not protocols.has_valid_header(expression, 'pdf-formula-source-expression') \
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
            if re.fullmatch(r'\*论文图\s+\d+[。：:][^\n]*\*', text):
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
    pattern = re.compile(r'^\*论文图\s+(\d+)([。：:])([^\n]*)\*$', re.MULTILINE)

    def replace(match):
        caption = re.sub(r'(?:\\\*){3}|\*{3}', '三个星号', match.group(3))
        caption = re.sub(r'(?:\\\*){2}|\*{2}', '两个星号', caption)
        caption = re.sub(r'\\?\*', '一个星号', caption)
        return f'*论文图 {match.group(1)}{match.group(2)}{caption}*'

    return pattern.sub(replace, str(markdown))


def repair_formula_delimiters(markdown):
    """让 TeX 定界符和生成的图片图注保持对 Markdown 安全。"""
    import bisect as _bisect

    raw_markdown = str(markdown)
    fm_prefix = ''
    markdown = raw_markdown
    if raw_markdown.startswith('---'):
        fm_match = re.match(r'^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)', raw_markdown, flags=re.DOTALL)
        if fm_match:
            fm_body = fm_match.group(1)
            fm_lines = fm_body.splitlines()
            first_raw_line = fm_lines[0] if fm_lines else ''
            # 真实 YAML frontmatter 紧跟在开头 `---` 之后（不能紧接空行，防止把 `---\n\nNote: ...` 主题分隔线误作 frontmatter），
            # 且必须能按 YAML 解析为非空字符串键映射（同时兼容未加引号与带引号键名及开头 `---` 后尾随空格）。
            if first_raw_line.strip():
                is_valid_yaml_fm = False
                try:
                    import yaml as _yaml
                    try:
                        parsed_fm = _yaml.safe_load(fm_body)
                        is_valid_yaml_fm = (
                            isinstance(parsed_fm, dict)
                            and bool(parsed_fm)
                            and all(isinstance(k, str) for k in parsed_fm.keys())
                        )
                    except Exception:
                        is_valid_yaml_fm = False
                except ImportError:
                    first_yaml_line = next(
                        (ln.strip() for ln in fm_lines if ln.strip() and not ln.strip().startswith('#')),
                        '',
                    )
                    is_valid_yaml_fm = bool(
                        re.match(r'^(?:[A-Za-z0-9_.-]+|"[^"\n]+"|\'[^\'\n]+\')[ \t]*:', first_yaml_line)
                    )
                if is_valid_yaml_fm:
                    fm_prefix = raw_markdown[:fm_match.end()]
                    markdown = raw_markdown[fm_match.end():]
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
    def escape_markdown_image_alts(text):
        bare_url_like_dest = re.compile(
            r'^(?:https?://\S+|(?:\.\.?/|/)\S+|\S+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|tiff?|ico|pdf|html?)(?:[?#]\S*)?)$',
            re.IGNORECASE,
        )
        angle_url_like_dest = re.compile(
            r'^(?:https?://[^\r\n<>]+|(?:\.\.?/|/)[^\r\n<>]+|[^\r\n<>]+\.(?:png|jpe?g|gif|webp|svg|avif|bmp|tiff?|ico|pdf|html?)(?:[?#][^\r\n<>]*)?)$',
            re.IGNORECASE,
        )

        def is_url_like(url, is_angle):
            return bool((angle_url_like_dest if is_angle else bare_url_like_dest).match(url))

        likely_image_ext_re = re.compile(r'\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$')

        def is_likely_image_url(url):
            base = str(url or '').split('?', 1)[0].split('#', 1)[0].lower()
            return bool(
                likely_image_ext_re.search(base)
                or '/images/' in base
                or '/figures/' in base
            )

        from conference_publication_gate import _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE

        def match_code_span(source, tick, limit):
            tick_end = tick + 1
            while tick_end < limit and source[tick_end] == '`':
                tick_end += 1
            closing = re.search(
                r'(?<!`)`{' + str(tick_end - tick) + r'}(?!`)',
                source[tick_end:limit],
            )
            return tick_end + closing.end() if closing else None

        ascii_punctuation = set(r'''!"#$%&'()*+,-./:;<=>?@[\]^_`{|}~''')

        def skip_ws_with_one_nl(source, pos, limit):
            while pos < limit and source[pos] in ' \t':
                pos += 1
            if pos < limit and source[pos] in '\r\n':
                if source[pos] == '\r' and pos + 1 < limit and source[pos + 1] == '\n':
                    pos += 2
                else:
                    pos += 1
                while pos < limit and source[pos] in ' \t':
                    pos += 1
            return pos

        def parse_link_title(source, start_pos, limit):
            delim = source[start_pos]
            end_delim = ')' if delim == '(' else delim
            pos = start_pos + 1
            escaped = False
            while pos < limit:
                ch = source[pos]
                if escaped:
                    escaped = False
                elif ch == '\\' and pos + 1 < limit and source[pos + 1] in ascii_punctuation:
                    escaped = True
                elif delim == '(' and ch == '(':
                    return None
                elif ch == end_delim:
                    return pos + 1
                pos += 1
            return None

        def parse_link_dest(source, open_paren, limit, *, allow_empty_angle=False):
            """Strict CommonMark §6.3 inline destination + optional title parser."""
            if open_paren >= limit or source[open_paren] != '(':
                return None
            pos = skip_ws_with_one_nl(source, open_paren + 1, limit)
            if pos >= limit:
                return None
            is_angle = False
            if source[pos] == '<':
                is_angle = True
                dest_start = pos + 1
                pos += 1
                escaped = False
                closed_angle = False
                while pos < limit:
                    ch = source[pos]
                    if ch in ('\r', '\n'):
                        return None
                    if escaped:
                        escaped = False
                    elif ch == '\\' and pos + 1 < limit and source[pos + 1] in ascii_punctuation:
                        escaped = True
                    elif ch == '>':
                        closed_angle = True
                        break
                    elif ch == '<':
                        return None
                    pos += 1
                if not closed_angle:
                    return None
                url = source[dest_start:pos].strip()
                pos += 1
            else:
                dest_start = pos
                paren_depth = 0
                escaped = False
                while pos < limit:
                    ch = source[pos]
                    if ch in ' \t\r\n':
                        break
                    if ord(ch) < 0x20 or ord(ch) == 0x7f:
                        return None
                    if escaped:
                        escaped = False
                    elif ch == '\\' and pos + 1 < limit and source[pos + 1] in ascii_punctuation:
                        escaped = True
                    elif ch == '(':
                        paren_depth += 1
                    elif ch == ')':
                        if paren_depth == 0:
                            break
                        paren_depth -= 1
                    pos += 1
                if paren_depth != 0 or escaped:
                    return None
                url = source[dest_start:pos]
                if not url:
                    return None
            if not url and not (allow_empty_angle and is_angle):
                return None
            ws_start = pos
            pos = skip_ws_with_one_nl(source, pos, limit)
            if pos >= limit:
                return None
            if source[pos] == ')':
                return pos, url, is_angle
            if pos > ws_start and source[pos] in ('"', "'", '('):
                title_end = parse_link_title(source, pos, limit)
                if title_end is None:
                    return None
                pos = skip_ws_with_one_nl(source, title_end, limit)
                if pos < limit and source[pos] == ')':
                    return pos, url, is_angle
            return None

        def has_unpaired_close_paren(segment):
            if ')' not in segment:
                return False
            depth = 0
            k = 0
            seg_len = len(segment)
            has_link_delim = '](' in segment
            while k < seg_len:
                ch = segment[k]
                if ch == '\\' and k + 1 < seg_len:
                    k += 2
                    continue
                if ch == '`':
                    span_end = match_code_span(segment, k, seg_len)
                    if span_end is not None:
                        k = span_end
                        continue
                    while k < seg_len and segment[k] == '`':
                        k += 1
                    continue
                if ch == '<':
                    raw_match = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE.match(segment, k)
                    if raw_match:
                        k = raw_match.end()
                        continue
                if has_link_delim and ch == ']' and k + 1 < seg_len and segment[k + 1] == '(':
                    parsed_d = parse_link_dest(segment, k + 1, seg_len, allow_empty_angle=True)
                    if parsed_d is not None:
                        k = parsed_d[0] + 1
                        continue
                if ch == '(':
                    depth += 1
                elif ch == ')':
                    if depth == 0:
                        return True
                    depth -= 1
                k += 1
            return False

        def has_unpaired_open_paren(segment):
            if '(' not in segment:
                return False
            depth = 0
            k = 0
            seg_len = len(segment)
            has_link_delim = '](' in segment
            while k < seg_len:
                ch = segment[k]
                if ch == '\\' and k + 1 < seg_len:
                    k += 2
                    continue
                if ch == '`':
                    span_end = match_code_span(segment, k, seg_len)
                    if span_end is not None:
                        k = span_end
                        continue
                    while k < seg_len and segment[k] == '`':
                        k += 1
                    continue
                if ch == '<':
                    raw_match = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE.match(segment, k)
                    if raw_match:
                        k = raw_match.end()
                        continue
                if has_link_delim and ch == ']' and k + 1 < seg_len and segment[k + 1] == '(':
                    parsed_d = parse_link_dest(segment, k + 1, seg_len, allow_empty_angle=True)
                    if parsed_d is not None:
                        k = parsed_d[0] + 1
                        continue
                if ch == '(':
                    depth += 1
                elif ch == ')':
                    if depth > 0:
                        depth -= 1
                k += 1
            return depth > 0

        def is_half_open_interval_text(text_span):
            prefix = text_span.lstrip()
            p_depth = 0
            saw_comma = False
            k = 0
            n_p = len(prefix)
            while k < n_p:
                ch = prefix[k]
                if ch == '\\' and k + 1 < n_p:
                    k += 2
                    continue
                if ch == '`':
                    span_end = match_code_span(prefix, k, n_p)
                    if span_end is not None:
                        k = span_end
                        continue
                    while k < n_p and prefix[k] == '`':
                        k += 1
                    continue
                if ch == '<':
                    raw_match = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE.match(prefix, k)
                    if raw_match:
                        k = raw_match.end()
                        continue
                if ch in '[]':
                    return False
                if ch == '(':
                    p_depth += 1
                elif ch == ')':
                    if p_depth == 0:
                        return saw_comma
                    p_depth -= 1
                elif ch == ',' and p_depth == 0:
                    saw_comma = True
                k += 1
            return False

        def collect_alt_escape_offsets(raw_alt, base_offset):
            offsets = []
            k = 0
            alt_len = len(raw_alt)
            slash_run = 0
            while k < alt_len:
                ch = raw_alt[k]
                if ch == '\\':
                    slash_run += 1
                    k += 1
                    continue
                if ch == '`' and slash_run % 2 == 0:
                    span_end = match_code_span(raw_alt, k, alt_len)
                    if span_end is not None:
                        k = span_end
                        slash_run = 0
                        continue
                    while k < alt_len and raw_alt[k] == '`':
                        k += 1
                    slash_run = 0
                    continue
                if ch == '<' and slash_run % 2 == 0:
                    raw_match = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE.match(raw_alt, k)
                    if raw_match:
                        k = raw_match.end()
                        slash_run = 0
                        continue
                if ch in '[]' and slash_run % 2 == 0:
                    offsets.append(base_offset + k)
                slash_run = 0
                k += 1
            return offsets

        caption_prefix_re = re.compile(
            r'\s*(?:原论文\s*)?(?:Figure|Fig\.?|Table|Tab\.?|图)\s*[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*\s*(?:[:：—–;-]|\.(?=\s))',
            re.IGNORECASE,
        )
        prose_break_re = re.compile(r'(?:[—–;]|--|\.\s|\bsee\s+$)', re.IGNORECASE)
        prose_break_non_see_re = re.compile(r'(?:[—–;]|--|\.\s)')
        trailing_see_re = re.compile(r'see\s+$', re.IGNORECASE)
        tail_conj_prefix_re = re.compile(r'^(?:and\b|or\b|[,.;:])', re.IGNORECASE)

        def img_lead_has_prose_break(lead_text):
            if caption_prefix_re.match(lead_text):
                return False
            return bool(prose_break_re.search(lead_text))

        def escape_segment_image_alts(seg, tokens):
            if not tokens:
                return [], []
            n_tok = len(tokens)
            active = [True] * n_tok
            # 标记被 Step 1 剥离的“包含引用图片”或“干净平衡方括号”跨度，避免被后续误当作普通文本
            has_ref_img = [False] * n_tok
            has_real_ref_img = [False] * n_tok
            clean_peeled_brk_end = {}
            peeled_spans = []
            peeled_ref_img_spans = []
            peeled_empty_img_spans = []
            closed_img_link_spans = []

            def mask_seg_spans(start_pos, end_pos, spans, *, already_sorted=False):
                if start_pos >= end_pos:
                    return ''
                if not spans:
                    return seg[start_pos:end_pos]
                ordered = spans if (already_sorted or len(spans) <= 1 or spans is peeled_spans) else sorted(spans)
                parts = []
                cur = start_pos
                # Jump straight to the earliest span that could end after start_pos when sorted.
                idx_sp = 0
                if len(ordered) > 8:
                    lo, hi = 0, len(ordered)
                    while lo < hi:
                        mid = (lo + hi) // 2
                        if ordered[mid][0] < start_pos:
                            lo = mid + 1
                        else:
                            hi = mid
                    idx_sp = max(0, lo - 1)
                    while idx_sp > 0 and ordered[idx_sp - 1][1] > start_pos:
                        idx_sp -= 1
                n_sp = len(ordered)
                while idx_sp < n_sp:
                    cs, ce = ordered[idx_sp]
                    idx_sp += 1
                    if ce <= cur:
                        continue
                    if cs >= end_pos:
                        break
                    if cs > cur:
                        parts.append(seg[cur:cs])
                    cur = max(cur, ce)
                if cur < end_pos:
                    parts.append(seg[cur:end_pos])
                return ''.join(parts)

            def add_peeled_span(span):
                nonlocal sim_last
                if not peeled_spans or peeled_spans[-1][0] <= span[0]:
                    peeled_spans.append(span)
                else:
                    _bisect.insort(peeled_spans, span)
                sim_cache.clear()
                sim_last = None
                surplus_clean_memo.clear()

            sim_cache = {}
            sim_last = None
            surplus_clean_memo = {}

            def is_math_interval_close(open_end, tok, open_type=None):
                if open_type == 'OPEN_BRK':
                    return False
                return (
                    (tok['type'] == 'CLOSE_OTHER' or (tok['type'] == 'CLOSE_LINK' and not tok['is_url']))
                    and has_unpaired_open_paren(mask_seg_spans(open_end, tok['pos'], peeled_spans))
                )

            def is_half_open_interval_open(open_end, end_pos, spans=None):
                return is_half_open_interval_text(mask_seg_spans(open_end, end_pos, peeled_spans if spans is None else spans))

            def all_extra_opens_are_intervals(opens, close_pos):
                if not opens:
                    return False
                for ei, o_idx in enumerate(opens):
                    ot = tokens[o_idx]
                    if ot['type'] != 'OPEN_BRK':
                        return False
                    end_p = tokens[opens[ei + 1]]['pos'] if ei + 1 < len(opens) else close_pos
                    slice_txt = mask_seg_spans(ot['open_end'], end_p, peeled_spans)
                    if not (is_half_open_interval_text(slice_txt)
                            or has_unpaired_close_paren(slice_txt)):
                        return False
                return True

            def find_clean_ref_span(close_idx):
                if tokens[close_idx].get('resolved_ref') and tokens[close_idx]['subkind'] == 'ref_close':
                    return close_idx
                if close_idx + 1 >= n_tok:
                    return None
                next_tok = tokens[close_idx + 1]
                if next_tok['type'] != 'OPEN_BRK' or next_tok['pos'] != tokens[close_idx]['pos'] + 1:
                    return None
                if close_idx + 1 in clean_peeled_brk_end:
                    return clean_peeled_brk_end[close_idx + 1]
                if not active[close_idx + 1]:
                    return None
                ref_end = None
                ref_depth = 0
                for r in range(close_idx + 1, n_tok):
                    if not active[r]:
                        continue
                    rt = tokens[r]
                    if rt['type'] in ('OPEN_IMG', 'OPEN_BRK'):
                        ref_depth += 1
                    else:
                        ref_depth -= 1
                        if ref_depth == 0:
                            if rt['type'] == 'CLOSE_OTHER' and rt['subkind'] == 'plain_close':
                                ref_end = r
                            break
                if ref_end is None:
                    return None
                if any(tokens[k]['type'] in ('OPEN_IMG', 'CLOSE_LINK') for k in range(close_idx + 2, ref_end)):
                    return None
                ref_text = seg[next_tok['open_end']:tokens[ref_end]['pos']]
                if has_unpaired_open_paren(ref_text) or has_unpaired_close_paren(ref_text):
                    return None
                return ref_end

            def count_surplus_closers(
                start_idx,
                include_ref=False,
                include_plain=False,
                max_plain=None,
                require_immediate_plain=False,
                open_img_depth=0,
                open_eff_len=None,
                always_consume_broken_later_imgs=False,
            ):
                eff_target = open_img_depth if open_eff_len is None else open_eff_len
                memo_key_base = (
                    include_ref,
                    include_plain,
                    max_plain,
                    require_immediate_plain,
                    open_img_depth,
                    eff_target,
                    always_consume_broken_later_imgs,
                )
                can_use_suffix_memo = not include_plain
                init_plain_done = (0 >= open_img_depth)
                if can_use_suffix_memo:
                    cached_s = surplus_clean_memo.get((start_idx, memo_key_base, False, init_plain_done))
                    if cached_s is not None:
                        return cached_s
                surplus = 0
                plain_used = 0
                plain_closed_outer_imgs = 0
                extra_opens = []
                broken_later_imgs = []
                saw_closed_non_img_url = False
                boundary_pos = tokens[start_idx - 1]['dest_end'] + 1 if start_idx > 0 else 0
                clean_points = [(start_idx, init_plain_done)] if can_use_suffix_memo else None
                clean_points_saw = [] if can_use_suffix_memo else None
                memo_pref_clean = True
                memo_pref_pos = boundary_pos
                r = start_idx
                while r < n_tok:
                    if not active[r]:
                        r += 1
                        continue
                    plain_closed_done = (plain_closed_outer_imgs >= open_img_depth)
                    if can_use_suffix_memo and not extra_opens and not broken_later_imgs \
                            and (saw_closed_non_img_url or (surplus == 0 and (plain_closed_outer_imgs == 0 or plain_closed_done))):
                        is_clean_boundary = r == start_idx
                        if not is_clean_boundary and r > 0 and 'dest_end' in tokens[r - 1]:
                            prev_end = tokens[r - 1]['dest_end'] + 1
                            if memo_pref_pos < boundary_pos:
                                memo_pref_pos = boundary_pos
                                memo_pref_clean = True
                            if memo_pref_clean and prev_end > memo_pref_pos:
                                delta_masked = mask_seg_spans(memo_pref_pos, prev_end, peeled_spans)
                                if '(' in delta_masked or '`' in delta_masked or '<' in delta_masked \
                                        or delta_masked.endswith('\\'):
                                    memo_pref_clean = False
                                memo_pref_pos = prev_end
                            if memo_pref_clean and prev_end >= boundary_pos \
                                    and not (prev_end < seg_len and seg[prev_end] == '('):
                                is_clean_boundary = True
                        if is_clean_boundary:
                            hit = surplus_clean_memo.get(
                                (r, memo_key_base, saw_closed_non_img_url, plain_closed_done if not saw_closed_non_img_url else False)
                            )
                            if hit is not None:
                                final_val = surplus + hit if saw_closed_non_img_url else hit
                                for cp_r, cp_pc in clean_points:
                                    surplus_clean_memo[(cp_r, memo_key_base, False, cp_pc)] = final_val
                                for cp_r, cp_s in clean_points_saw:
                                    surplus_clean_memo[(cp_r, memo_key_base, True, False)] = final_val - cp_s
                                return final_val
                            if saw_closed_non_img_url:
                                clean_points_saw.append((r, surplus))
                            elif r != start_idx:
                                clean_points.append((r, plain_closed_done))
                    rt = tokens[r]
                    if rt['type'] in ('OPEN_BRK', 'OPEN_IMG'):
                        extra_opens.append(r)
                        r += 1
                        continue
                    if extra_opens and is_math_interval_close(
                        tokens[extra_opens[-1]]['open_end'],
                        rt,
                        tokens[extra_opens[-1]]['type'],
                    ):
                        r += 1
                        continue
                    if extra_opens:
                        # 全部剩余挂起 `[` 均为半开区间 `[0, 1)` / `[f(0), 1)` 时，不吞掉真正的外层闭合符；
                        # 已闭合一个外层非图链接或引用后，后续独立 `[0, 1) range](doc)` 不再计作前文多余闭合。
                        if all_extra_opens_are_intervals(extra_opens, rt['pos']):
                            if rt['type'] == 'CLOSE_LINK' and rt['is_url'] and not saw_closed_non_img_url:
                                can_consume_broken = (
                                    saw_closed_non_img_url
                                    or surplus >= eff_target
                                    or (
                                        always_consume_broken_later_imgs == 2
                                        and eff_target <= open_img_depth
                                    )
                                    or (
                                        always_consume_broken_later_imgs == 1
                                        and eff_target <= open_img_depth
                                        and (surplus + plain_closed_outer_imgs) >= open_img_depth
                                    )
                                )
                                if broken_later_imgs and can_consume_broken:
                                    b_kind, b_pos = broken_later_imgs[-1]
                                    if (
                                        b_kind == 'empty_paren' and rt['pos'] == b_pos + 1
                                    ) or (
                                        b_kind != 'empty_paren' and (
                                            b_kind == 'ref_close' or seg[b_pos + 1:rt['pos']].strip()
                                            or (rt['pos'] == b_pos + 1 and eff_target <= open_img_depth)
                                        )
                                    ):
                                        broken_later_imgs.pop()
                                        extra_opens.clear()
                                        boundary_pos = rt['dest_end'] + 1
                                        r += 1
                                        continue
                                last_extra_slice = mask_seg_spans(
                                    tokens[extra_opens[-1]]['open_end'],
                                    rt['pos'],
                                    peeled_spans,
                                )
                                if surplus >= open_img_depth and not is_likely_image_url(rt.get('url', '')) \
                                        and not last_extra_slice.rstrip().endswith(')'):
                                    extra_opens.pop()
                                    r += 1
                                    continue
                                extra_opens.clear()
                                surplus += 1
                                if not is_likely_image_url(rt.get('url', '')) or surplus > open_img_depth:
                                    saw_closed_non_img_url = True
                                boundary_pos = rt['dest_end'] + 1
                                r += 1
                                continue
                            if rt['type'] == 'CLOSE_OTHER' and rt['subkind'] == 'ref_close' and not saw_closed_non_img_url:
                                ref_end = find_clean_ref_span(r)
                                if ref_end is not None:
                                    extra_opens.clear()
                                    saw_closed_non_img_url = True
                                    if include_ref:
                                        surplus += 1
                                    boundary_pos = tokens[ref_end]['dest_end'] + 1
                                    r = ref_end + 1
                                    continue
                            if include_plain and rt['type'] == 'CLOSE_OTHER' and (
                                rt['subkind'] == 'plain_close'
                                or (rt['subkind'] == 'ref_close' and find_clean_ref_span(r) is None)
                            ) \
                                    and not (require_immediate_plain and saw_closed_non_img_url) \
                                    and (max_plain is None or plain_used < max_plain) \
                                    and (
                                        not require_immediate_plain
                                        or not re.match(
                                            r'^(?:and\b|or\b|[,.;:])',
                                            seg[boundary_pos:tokens[extra_opens[0]]['pos']].strip(),
                                            re.IGNORECASE,
                                        )
                                    ):
                                extra_opens.clear()
                                plain_used += 1
                                surplus += 1
                                boundary_pos = rt['dest_end'] + 1
                                r += 1
                                continue
                        # 若栈顶是若干半开区间/未配对右括号 OPEN_BRK 且下方紧邻未闭合 OPEN_IMG，
                        # 遇到有效 URL 闭合符时同步展开并闭合该 OPEN_IMG，保证修复前/后 surplus 计数幂等。
                        if rt['type'] == 'CLOSE_LINK' and rt['is_url'] and tokens[extra_opens[-1]]['type'] == 'OPEN_BRK':
                            probe_e = len(extra_opens) - 1
                            next_e_pos = rt['pos']
                            while probe_e >= 0 and tokens[extra_opens[probe_e]]['type'] == 'OPEN_BRK':
                                slice_e = mask_seg_spans(tokens[extra_opens[probe_e]]['open_end'], next_e_pos, peeled_spans)
                                if is_half_open_interval_text(slice_e) or has_unpaired_close_paren(slice_e):
                                    next_e_pos = tokens[extra_opens[probe_e]]['pos']
                                    probe_e -= 1
                                else:
                                    break
                            if probe_e >= 0 and tokens[extra_opens[probe_e]]['type'] == 'OPEN_IMG':
                                top_e_slice = mask_seg_spans(tokens[extra_opens[-1]]['open_end'], rt['pos'], peeled_spans)
                                if is_likely_image_url(rt.get('url', '')) or (
                                    top_e_slice.rstrip().endswith(')') and is_half_open_interval_text(top_e_slice)
                                ):
                                    del extra_opens[probe_e:]
                                    r += 1
                                    continue
                        popped_idx = extra_opens.pop()
                        is_empty_img_close_rt = (
                            open_img_depth > 0
                            and rt['dest_end'] + 1 < seg_len
                            and seg[rt['dest_end'] + 1] == ']'
                            and (
                                (rt['type'] == 'CLOSE_OTHER' and rt['subkind'] == 'empty_paren')
                                or (rt['type'] == 'CLOSE_LINK' and not rt['is_url'] and rt.get('url', '') == '')
                            )
                        )
                        if not extra_opens and tokens[popped_idx]['type'] == 'OPEN_IMG' and (
                            (rt['type'] == 'CLOSE_OTHER' and rt['subkind'] in ('plain_close', 'ref_close'))
                            or is_empty_img_close_rt
                        ) and (
                            saw_closed_non_img_url
                            or surplus >= eff_target
                            or (
                                always_consume_broken_later_imgs == 2
                                and eff_target <= open_img_depth
                            )
                            or (
                                always_consume_broken_later_imgs == 1
                                and eff_target <= open_img_depth
                                and (surplus + plain_closed_outer_imgs) >= open_img_depth
                            )
                        ):
                            b_subkind = (
                                'empty_paren'
                                if is_empty_img_close_rt
                                else (
                                    rt['subkind']
                                    if not (rt['subkind'] == 'ref_close' and find_clean_ref_span(r) is None)
                                    else 'plain_close'
                                )
                            )
                            broken_later_imgs.append((b_subkind, rt['dest_end']))
                        r += 1
                        continue
                    if rt['type'] == 'CLOSE_LINK' and rt['is_url']:
                        if broken_later_imgs and (
                            saw_closed_non_img_url
                            or surplus >= eff_target
                            or (
                                always_consume_broken_later_imgs == 2
                                and eff_target <= open_img_depth
                            )
                            or (
                                always_consume_broken_later_imgs == 1
                                and eff_target <= open_img_depth
                                and (surplus + plain_closed_outer_imgs) >= open_img_depth
                            )
                        ):
                            b_kind, b_pos = broken_later_imgs[-1]
                            if (
                                b_kind == 'empty_paren' and rt['pos'] == b_pos + 1
                            ) or (
                                b_kind != 'empty_paren' and (
                                    b_kind == 'ref_close' or seg[b_pos + 1:rt['pos']].strip()
                                    or (rt['pos'] == b_pos + 1 and eff_target <= open_img_depth)
                                )
                            ):
                                broken_later_imgs.pop()
                                boundary_pos = rt['dest_end'] + 1
                                r += 1
                                continue
                        surplus += 1
                        if not is_likely_image_url(rt.get('url', '')) or surplus > open_img_depth:
                            saw_closed_non_img_url = True
                        boundary_pos = rt['dest_end'] + 1
                        r += 1
                        continue
                    if rt['type'] == 'CLOSE_OTHER' and rt['subkind'] == 'ref_close':
                        ref_end = find_clean_ref_span(r)
                        if ref_end is not None:
                            if not has_unpaired_open_paren(mask_seg_spans(boundary_pos, rt['pos'], peeled_spans)):
                                saw_closed_non_img_url = True
                                if include_ref:
                                    surplus += 1
                                boundary_pos = tokens[ref_end]['dest_end'] + 1
                                r = ref_end + 1
                                continue
                        else:
                            can_count_plain_r = (
                                include_plain
                                and (max_plain is None or plain_used < max_plain)
                                and (not require_immediate_plain or not seg[boundary_pos:rt['pos']].strip())
                            )
                            if (can_count_plain_r or always_consume_broken_later_imgs == 1) \
                                    and not has_unpaired_open_paren(mask_seg_spans(boundary_pos, rt['pos'], peeled_spans)):
                                plain_closed_outer_imgs += 1
                                if can_count_plain_r:
                                    plain_used += 1
                                    surplus += 1
                                    boundary_pos = rt['dest_end'] + 1
                            r += 1
                            continue
                    if rt['type'] == 'CLOSE_OTHER' and rt['subkind'] == 'plain_close':
                        can_count_plain_p = (
                            include_plain
                            and (max_plain is None or plain_used < max_plain)
                            and (not require_immediate_plain or not seg[boundary_pos:rt['pos']].strip())
                        )
                        if (can_count_plain_p or always_consume_broken_later_imgs == 1) \
                                and not has_unpaired_open_paren(mask_seg_spans(boundary_pos, rt['pos'], peeled_spans)):
                            plain_closed_outer_imgs += 1
                            if can_count_plain_p:
                                plain_used += 1
                                surplus += 1
                                boundary_pos = rt['dest_end'] + 1
                    r += 1
                if can_use_suffix_memo:
                    for cp_r, cp_pc in clean_points:
                        surplus_clean_memo[(cp_r, memo_key_base, False, cp_pc)] = surplus
                    for cp_r, cp_s in clean_points_saw:
                        surplus_clean_memo[(cp_r, memo_key_base, True, False)] = surplus - cp_s
                return surplus

            def note_wrapper_count_on_stack(cur_stack, inner_pos, spans=None):
                mask_spans = peeled_spans if spans is None else spans
                count = 0
                for i_s, s in enumerate(cur_stack):
                    st = tokens[s]
                    if st['type'] == 'OPEN_BRK' and st['pos'] < inner_pos:
                        next_tok_pos = tokens[cur_stack[i_s + 1]]['pos'] if i_s + 1 < len(cur_stack) else inner_pos
                        masked = mask_seg_spans(st['open_end'], next_tok_pos, mask_spans)
                        if not is_half_open_interval_text(masked) \
                                and not has_unpaired_close_paren(masked) \
                                and seg[st['open_end']:next_tok_pos].strip():
                            count += 1
                return count

            def is_closed_earlier_img(s_idx, before_pos):
                return (
                    before_pos is not None
                    and tokens[s_idx]['type'] == 'OPEN_IMG'
                    and any(
                        active[m] and tokens[m]['type'] == 'CLOSE_LINK' and tokens[m]['is_url']
                        and tokens[m]['pos'] < before_pos
                        for m in range(s_idx + 1, n_tok)
                    )
                )

            def simulate_open_stack_before(limit_idx):
                """Simulate open BRK/IMG entries before `limit_idx`, unwinding half-open intervals,
                unpaired-`)` brackets (e.g. `[Panel a)`), and nested `![FALL]` chains so already-closed
                outer links/images are excluded."""
                nonlocal sim_last
                cached = sim_cache.get(limit_idx)
                if cached is not None:
                    return cached
                if sim_last is not None and sim_last[0] < limit_idx:
                    k = sim_last[0]
                    li_stack = [[e[0], e[1], e[2]] for e in sim_last[1]]
                    li_closed_spans = list(sim_last[2])
                    li_brk_count = sim_last[3]
                    li_clean_brk_stack = list(sim_last[4])
                else:
                    k = 0
                    li_stack = []
                    li_closed_spans = list(peeled_spans)
                    li_brk_count = 0
                    li_clean_brk_stack = []
                saw_clipped_ref = False

                def li_pop_from(probe_idx):
                    nonlocal li_brk_count
                    for idx_p in range(probe_idx, len(li_stack)):
                        if li_stack[idx_p][0] == 'BRK':
                            li_brk_count -= 1
                    del li_stack[probe_idx:]
                    # Any clean-BRK index >= probe_idx is gone, and probe_idx - 1 (now top) will be lazily checked against future items.
                    while li_clean_brk_stack and li_clean_brk_stack[-1] >= max(0, probe_idx - 1):
                        li_clean_brk_stack.pop()

                def li_push_entry(entry_list, tok_pos):
                    if li_stack and li_stack[-1][0] == 'BRK' and li_stack[-1][1] is None:
                        if not is_unclosed_paren_brk(tokens[li_stack[-1][2]]['open_end'], tok_pos):
                            li_clean_brk_stack.append(len(li_stack) - 1)
                    li_stack.append(entry_list)

                def add_li_closed_span(span):
                    if not li_closed_spans or li_closed_spans[-1][0] <= span[0]:
                        li_closed_spans.append(span)
                    else:
                        _bisect.insort(li_closed_spans, span)

                def li_seg_outside_closed(start_pos, end_pos):
                    return mask_seg_spans(start_pos, end_pos, li_closed_spans, already_sorted=True)

                def is_unclosed_paren_brk(open_end, end_pos):
                    slice_txt = li_seg_outside_closed(open_end, end_pos)
                    return is_half_open_interval_text(slice_txt) \
                        or has_unpaired_close_paren(slice_txt)

                def li_unwind_intervals(close_pos):
                    probe = len(li_stack) - 1
                    next_pos = close_pos
                    while probe >= 0 and li_stack[probe][0] == 'BRK' and li_stack[probe][1] is None \
                            and is_unclosed_paren_brk(tokens[li_stack[probe][2]]['open_end'], next_pos):
                        next_pos = tokens[li_stack[probe][2]]['pos']
                        probe -= 1
                    return probe, next_pos

                def mark_enclosing_brk_has_img(img_pos):
                    if li_brk_count <= 0:
                        return
                    if li_stack and li_stack[-1][0] == 'BRK':
                        if li_stack[-1][1] is not None:
                            return
                        if not is_unclosed_paren_brk(tokens[li_stack[-1][2]]['open_end'], img_pos):
                            li_stack[-1][1] = img_pos
                            return
                    while li_clean_brk_stack:
                        idx_b = li_clean_brk_stack.pop()
                        if idx_b < len(li_stack) and li_stack[idx_b][0] == 'BRK':
                            if li_stack[idx_b][1] is None:
                                li_stack[idx_b][1] = img_pos
                            return

                def li_unwind_img_chain(probe, close_pos):
                    while probe >= 1 and li_stack[probe][0] == 'IMG_CLOSED':
                        prev_kind = li_stack[probe - 1][0]
                        if prev_kind in ('IMG', 'IMG_CLOSED'):
                            probe -= 1
                            continue
                        if prev_kind == 'BRK' and li_stack[probe - 1][1] is None \
                                and is_unclosed_paren_brk(
                                    tokens[li_stack[probe - 1][2]]['open_end'],
                                    tokens[li_stack[probe][2]]['pos'],
                                ):
                            look = probe - 1
                            next_pos = tokens[li_stack[probe][2]]['pos']
                            while look >= 0 and li_stack[look][0] == 'BRK' and li_stack[look][1] is None \
                                    and is_unclosed_paren_brk(tokens[li_stack[look][2]]['open_end'], next_pos):
                                next_pos = tokens[li_stack[look][2]]['pos']
                                look -= 1
                            if look >= 0 and li_stack[look][0] in ('IMG', 'IMG_CLOSED'):
                                probe = look
                                continue
                        break
                    return probe

                while k < limit_idx:
                    if not active[k]:
                        if has_ref_img[k]:
                            mark_enclosing_brk_has_img(tokens[k]['pos'])
                        k += 1
                        continue
                    kt = tokens[k]
                    if kt['type'] == 'OPEN_BRK':
                        li_push_entry(['BRK', None, k], kt['pos'])
                        li_brk_count += 1
                        k += 1
                        continue
                    if kt['type'] == 'OPEN_IMG':
                        li_push_entry(['IMG', None, k], kt['pos'])
                        k += 1
                        continue
                    if kt['type'] == 'CLOSE_LINK':
                        if kt['is_url']:
                            probe, _ = li_unwind_intervals(kt['pos'])
                            if kt.get('is_img_close') and probe >= 0 and li_stack[probe][0] == 'BRK':
                                p2 = probe
                                while p2 >= 0 and li_stack[p2][0] in ('BRK', 'IMG_CLOSED'):
                                    p2 -= 1
                                if p2 >= 0 and li_stack[p2][0] == 'IMG':
                                    probe = p2
                            if probe >= 0 and li_stack[probe][0] in ('IMG', 'IMG_CLOSED'):
                                probe = li_unwind_img_chain(probe, kt['pos'])
                                img_start_pos = tokens[li_stack[probe][2]]['pos']
                                add_li_closed_span((img_start_pos, kt['dest_end'] + 1))
                                li_pop_from(probe)
                                mark_enclosing_brk_has_img(img_start_pos)
                            elif probe >= 0 and li_stack[probe][0] == 'BRK':
                                add_li_closed_span((tokens[li_stack[probe][2]]['pos'], kt['dest_end'] + 1))
                                li_pop_from(probe)
                        elif li_stack:
                            probe, _ = li_unwind_intervals(kt['pos'])
                            if probe >= 0 and li_stack[probe][0] == 'BRK':
                                add_li_closed_span((tokens[li_stack[probe][2]]['pos'], kt['dest_end'] + 1))
                                li_pop_from(probe)
                        k += 1
                        continue
                    if kt['type'] == 'CLOSE_OTHER':
                        if kt['subkind'] == 'ref_close':
                            ref_end = find_clean_ref_span(k)
                            if ref_end is not None and ref_end >= limit_idx:
                                saw_clipped_ref = True
                            if ref_end is not None and ref_end < limit_idx and li_stack:
                                probe, _ = li_unwind_intervals(kt['pos'])
                                if probe >= 0 and li_stack[probe][0] in ('IMG', 'IMG_CLOSED'):
                                    probe = li_unwind_img_chain(probe, kt['pos'])
                                    img_start_pos = tokens[li_stack[probe][2]]['pos']
                                    add_li_closed_span((img_start_pos, tokens[ref_end]['dest_end'] + 1))
                                    li_pop_from(probe)
                                    mark_enclosing_brk_has_img(img_start_pos)
                                elif probe >= 0 and li_stack[probe][0] == 'BRK':
                                    add_li_closed_span((tokens[li_stack[probe][2]]['pos'], tokens[ref_end]['dest_end'] + 1))
                                    li_pop_from(probe)
                                k = ref_end + 1
                                continue
                            if ref_end is None and li_stack:
                                if not is_math_interval_close(
                                    tokens[li_stack[-1][2]]['open_end'],
                                    kt,
                                    'OPEN_BRK' if li_stack[-1][0] == 'BRK' else 'OPEN_IMG',
                                ):
                                    probe, next_pos = li_unwind_intervals(kt['pos'])
                                    if probe == len(li_stack) - 1 and li_stack[probe][0] == 'IMG':
                                        li_stack[probe][0] = 'IMG_CLOSED'
                                    elif probe >= 0 and li_stack[probe][0] == 'BRK' \
                                            and not is_unclosed_paren_brk(tokens[li_stack[probe][2]]['open_end'], next_pos):
                                        add_li_closed_span((tokens[li_stack[probe][2]]['pos'], kt['dest_end'] + 1))
                                        li_pop_from(probe)
                        elif kt['subkind'] == 'empty_paren' and li_stack:
                            probe, _ = li_unwind_intervals(kt['pos'])
                            if probe >= 0 and li_stack[probe][0] == 'BRK':
                                add_li_closed_span((tokens[li_stack[probe][2]]['pos'], kt['dest_end'] + 1))
                                li_pop_from(probe)
                        elif kt['subkind'] == 'plain_close' and li_stack:
                            if is_math_interval_close(
                                tokens[li_stack[-1][2]]['open_end'],
                                kt,
                                'OPEN_BRK' if li_stack[-1][0] == 'BRK' else 'OPEN_IMG',
                            ):
                                k += 1
                                continue
                            probe, next_pos = li_unwind_intervals(kt['pos'])
                            if probe == len(li_stack) - 1 and li_stack[probe][0] == 'IMG':
                                li_stack[probe][0] = 'IMG_CLOSED'
                            elif probe >= 0 and li_stack[probe][0] == 'BRK' \
                                    and not is_unclosed_paren_brk(tokens[li_stack[probe][2]]['open_end'], next_pos):
                                add_li_closed_span((tokens[li_stack[probe][2]]['pos'], kt['dest_end'] + 1))
                                li_pop_from(probe)
                    k += 1
                result = (li_stack, li_closed_spans)
                sim_cache[limit_idx] = result
                if not saw_clipped_ref:
                    sim_last = (limit_idx, li_stack, li_closed_spans, li_brk_count, li_clean_brk_stack)
                return result

            def effective_stack_metrics(cur_stack, ref_pos=None, ref_idx=None, return_live=False):
                if ref_idx is not None:
                    li_stack_sim, li_closed_spans = simulate_open_stack_before(ref_idx)
                    live_set = {entry[2] for entry in li_stack_sim}
                else:
                    live_set = None
                    li_closed_spans = list(peeled_spans)
                live_entries = [
                    s for s in cur_stack
                    if (s in live_set if live_set is not None else not is_closed_earlier_img(s, ref_pos))
                ]
                live_img_indices = [
                    i_s for i_s, s in enumerate(live_entries)
                    if tokens[s]['type'] == 'OPEN_IMG'
                ]
                limit_pos = ref_pos if ref_pos is not None else (
                    tokens[live_entries[live_img_indices[-1]]]['pos'] if live_img_indices else -1
                )
                effective_len = 0
                for i_s, s in enumerate(live_entries):
                    st = tokens[s]
                    if st['type'] == 'OPEN_BRK' and limit_pos >= 0 and st['pos'] < limit_pos:
                        next_tok_pos = tokens[live_entries[i_s + 1]]['pos'] if i_s + 1 < len(live_entries) else limit_pos
                        masked_slice = mask_seg_spans(st['open_end'], next_tok_pos, li_closed_spans, already_sorted=True)
                        if is_half_open_interval_text(masked_slice) or has_unpaired_close_paren(masked_slice):
                            continue
                    effective_len += 1
                if return_live:
                    return len(live_img_indices), effective_len, live_entries
                return len(live_img_indices), effective_len

            def can_peel_paren_link(cur_stack, op_idx, close_idx, inner_span=''):
                op_tok = tokens[op_idx]
                close_url = tokens[close_idx].get('url', '')
                is_interval = is_half_open_interval_text(inner_span) if inner_span else is_half_open_interval_open(op_tok['open_end'], tokens[close_idx]['pos'])
                if is_likely_image_url(close_url) and (is_interval or (inner_span and inner_span.rstrip().endswith(')'))):
                    # 即使前文 `![FALL]` 已因字面 `]` 从 Step 1 栈弹出，只要区间 `[0, 1)` 紧跟在同一未闭合图片短语之后，
                    # 仍不得把图片自身的 `](img.png)` 当普通链接剥掉。
                    has_prior_unmatched_img = False
                    for k in range(op_idx - 1, -1, -1):
                        if not active[k]:
                            continue
                        kt = tokens[k]
                        if kt['type'] == 'OPEN_IMG':
                            has_prior_unmatched_img = True
                            break
                        if kt['type'] == 'CLOSE_LINK' and kt['is_url']:
                            break
                    if has_prior_unmatched_img:
                        return False
                img_count, eff_len, live_entries = effective_stack_metrics(
                    cur_stack,
                    ref_pos=op_tok['pos'],
                    ref_idx=op_idx,
                    return_live=True,
                )
                if img_count == 0:
                    return True
                if is_likely_image_url(close_url) and (is_interval or (inner_span and inner_span.rstrip().endswith(')'))):
                    return False
                open_depth = img_count
                broken_later_mode = (
                    2
                    if (
                        is_interval
                        or (bool(inner_span) and inner_span.rstrip().endswith(')') and not inner_span.rstrip()[:-1].strip())
                    )
                    else (1 if (bool(inner_span) and inner_span.rstrip().endswith(')')) else 0)
                )
                surplus_url = count_surplus_closers(
                    close_idx + 1,
                    include_ref=False,
                    include_plain=False,
                    open_img_depth=open_depth,
                    open_eff_len=eff_len,
                    always_consume_broken_later_imgs=broken_later_mode,
                )
                live_imgs_for_lead = [
                    s for s in live_entries
                    if tokens[s]['type'] == 'OPEN_IMG'
                ]
                img_lead = seg[tokens[live_imgs_for_lead[-1]]['open_end']:op_tok['pos']] if live_imgs_for_lead else ''
                has_prose_break_before_link = img_lead_has_prose_break(img_lead)
                has_closed_brk_above_img = bool(
                    live_imgs_for_lead
                    and any(
                        tokens[s]['type'] == 'OPEN_BRK' and tokens[s]['pos'] > tokens[live_imgs_for_lead[-1]]['pos']
                        for s in live_entries
                    )
                    and count_surplus_closers(
                        close_idx + 1,
                        include_ref=False,
                        include_plain=True,
                        max_plain=1,
                        require_immediate_plain=False,
                    ) >= 1
                )
                if surplus_url == 0 \
                        and (eff_len == img_count or has_prose_break_before_link or has_closed_brk_above_img) \
                        and (not is_interval or has_prose_break_before_link) \
                        and inner_span and (not inner_span.rstrip().endswith(')') or (has_prose_break_before_link and not is_interval)) \
                        and not is_likely_image_url(close_url):
                    return True
                if surplus_url < img_count:
                    return False
                surplus_link_or_ref = count_surplus_closers(
                    close_idx + 1,
                    include_ref=True,
                    include_plain=False,
                    open_img_depth=open_depth,
                    open_eff_len=eff_len,
                    always_consume_broken_later_imgs=2 if is_interval else 0,
                )
                if surplus_link_or_ref >= eff_len:
                    return True
                if not live_imgs_for_lead:
                    return False
                innermost_img_pos = tokens[live_imgs_for_lead[-1]]['pos']
                next_url_tok = next(
                    (
                        tokens[r] for r in range(close_idx + 1, n_tok)
                        if active[r] and tokens[r]['type'] == 'CLOSE_LINK' and tokens[r]['is_url']
                    ),
                    None,
                )
                if next_url_tok is None:
                    return False
                # 未闭合外层 `[outer` 包裹有效图片且图片自身拥有显式图片 URL 闭合与后续图注文本时，
                # 允许剥离内部非图片、非区间链接（如 `[outer ![Fig 1: [1) a](a) cap](f3.png)`）。
                if not is_interval and inner_span and not inner_span.rstrip().endswith(')') \
                        and not is_likely_image_url(close_url) \
                        and is_likely_image_url(next_url_tok.get('url', '')) \
                        and seg[tokens[close_idx]['dest_end'] + 1:next_url_tok['pos']].strip():
                    return True
                note_count = note_wrapper_count_on_stack(live_entries, innermost_img_pos)
                inner_brks_above_img = 0
                if not is_interval and inner_span and not inner_span.rstrip().endswith(')') \
                        and not is_likely_image_url(close_url):
                    for i_s, s in enumerate(live_entries):
                        st = tokens[s]
                        if st['type'] == 'OPEN_BRK' and st['pos'] > innermost_img_pos:
                            nxt_p = tokens[live_entries[i_s + 1]]['pos'] if i_s + 1 < len(live_entries) else op_tok['pos']
                            m_sl = mask_seg_spans(st['open_end'], nxt_p, peeled_spans)
                            if not is_half_open_interval_text(m_sl) and not has_unpaired_close_paren(m_sl):
                                inner_brks_above_img += 1
                max_plain_total = note_count + inner_brks_above_img
                if max_plain_total == 0:
                    return False
                if note_count > 0 and inner_brks_above_img == 0 \
                        and not seg[tokens[close_idx]['dest_end'] + 1:next_url_tok['pos']].strip():
                    if is_interval or (inner_span and inner_span.rstrip().endswith(')')) \
                            or not is_likely_image_url(next_url_tok.get('url', '')):
                        return False
                surplus_all = count_surplus_closers(
                    close_idx + 1,
                    include_ref=True,
                    include_plain=True,
                    max_plain=max_plain_total,
                    require_immediate_plain=is_interval,
                    open_img_depth=open_depth,
                    open_eff_len=eff_len,
                )
                return surplus_all >= eff_len

            def only_clean_literal_imgs_inside(top, idx):
                inner_stack = []
                for k in range(top + 1, idx):
                    if not active[k]:
                        continue
                    kt = tokens[k]
                    if kt['type'] == 'OPEN_IMG':
                        inner_stack.append(k)
                    elif kt['type'] == 'CLOSE_OTHER' and kt['subkind'] == 'plain_close' and inner_stack:
                        open_k = inner_stack.pop()
                        if any(tokens[m]['type'] == 'CLOSE_LINK' for m in range(open_k + 1, k)):
                            return False
                        inner_text = seg[tokens[open_k]['open_end']:kt['pos']]
                        if has_unpaired_open_paren(inner_text) or has_unpaired_close_paren(inner_text):
                            return False
                    else:
                        return False
                return not inner_stack

            # Step 1：自内向外剥离干净的普通链接 [label](dest)、平衡方括号 [...]、
            # 平衡引用链接 [a][b]、平衡引用图 ![alt][ref] 与平衡空目标图 ![alt]() / ![alt](<>)。
            peeled = True
            while peeled:
                peeled = False
                pass_stack_metrics_cache = {}
                skipped_paren_links = []
                stack = []
                idx = 0
                while idx < n_tok:
                    if not active[idx]:
                        idx += 1
                        continue
                    tok = tokens[idx]
                    if tok['type'] in ('OPEN_IMG', 'OPEN_BRK'):
                        stack.append(idx)
                        idx += 1
                        continue
                    if not stack:
                        idx += 1
                        continue
                    # CommonMark 已解析的引用图片直接按其精确开括号剥离，不受未配对括号或外层闭合符上限影响；
                    # 但若其内部仍含活跃的内层图片（如 `[![Fig 1: FALL: ![e me](f1.png)][ref]`），
                    # 仅在外层 `[` 仍有专属闭合符（如 `[![Fig 1: ![sub](sub.png)][img]](paper)`）时剥离，
                    # 避免抢走外层链接的 `[ref]`。
                    if tok['type'] == 'CLOSE_OTHER' and tok.get('resolved_ref'):
                        ref_open = tok.get('ref_open_idx')
                        if ref_open is not None and active[ref_open] and tokens[ref_open]['type'] == 'OPEN_IMG':
                            has_inner_url_img = (
                                any(active[k] and tokens[k]['type'] == 'OPEN_IMG' for k in range(ref_open + 1, idx))
                                and any(
                                    active[k] and tokens[k]['type'] == 'CLOSE_LINK' and tokens[k]['is_url']
                                    for k in range(ref_open + 1, idx)
                                )
                            )
                            can_peel_resolved_img = True
                            if has_inner_url_img:
                                outer_stack = [s for s in stack if s < ref_open]
                                _img_c, eff_len = effective_stack_metrics(
                                    outer_stack,
                                    ref_pos=tokens[ref_open]['pos'],
                                    ref_idx=ref_open,
                                )
                                note_count = note_wrapper_count_on_stack(outer_stack, tokens[ref_open]['pos'])
                                use_plain_res = eff_len > 0 and note_count > 0
                                if eff_len > 0 and count_surplus_closers(
                                    idx + 1,
                                    include_ref=True,
                                    include_plain=use_plain_res,
                                    max_plain=note_count,
                                    open_img_depth=_img_c,
                                ) < eff_len:
                                    can_peel_resolved_img = False
                            if can_peel_resolved_img:
                                for k in range(ref_open, idx + 1):
                                    active[k] = False
                                has_ref_img[ref_open] = True
                                has_real_ref_img[ref_open] = True
                                add_peeled_span((tokens[ref_open]['pos'], tok['dest_end'] + 1))
                                peeled_ref_img_spans.append((tokens[ref_open]['pos'], tok['dest_end']))
                                while stack and stack[-1] >= ref_open:
                                    stack.pop()
                                peeled = True
                                idx += 1
                                continue
                        elif ref_open is not None and active[ref_open] and tokens[ref_open]['type'] == 'OPEN_BRK':
                            has_active_inner_url_img = (
                                any(
                                    active[k] and tokens[k]['type'] == 'OPEN_IMG'
                                    for k in range(ref_open + 1, idx)
                                )
                                and any(
                                    active[k] and tokens[k]['type'] == 'CLOSE_LINK' and tokens[k]['is_url']
                                    for k in range(ref_open + 1, idx)
                                )
                            )
                            if not has_active_inner_url_img:
                                ref_inner = mask_seg_spans(tokens[ref_open]['open_end'], tok['pos'], peeled_spans)
                                can_peel_ref_brk = True
                                if is_half_open_interval_text(ref_inner) or has_unpaired_close_paren(ref_inner):
                                    li_stack, li_closed = simulate_open_stack_before(ref_open)
                                    probe = len(li_stack) - 1
                                    next_p = tokens[ref_open]['pos']
                                    while probe >= 0 and li_stack[probe][0] == 'BRK' and li_stack[probe][1] is None:
                                        slice_txt = mask_seg_spans(tokens[li_stack[probe][2]]['open_end'], next_p, li_closed, already_sorted=True)
                                        if is_half_open_interval_text(slice_txt) or has_unpaired_close_paren(slice_txt):
                                            next_p = tokens[li_stack[probe][2]]['pos']
                                            probe -= 1
                                        else:
                                            break
                                    if probe >= 0 and li_stack[probe][0] == 'BRK' and li_stack[probe][1] is not None:
                                        brk_prefix = mask_seg_spans(
                                            tokens[li_stack[probe][2]]['open_end'],
                                            li_stack[probe][1],
                                            li_closed,
                                            already_sorted=True,
                                        ).strip()
                                        if not brk_prefix:
                                            can_peel_ref_brk = False
                                        elif ref_inner.rstrip().endswith(')') and (
                                            is_half_open_interval_text(ref_inner)
                                            or not any(
                                                active[m] and tokens[m]['type'] == 'CLOSE_OTHER'
                                                and tokens[m]['subkind'] == 'plain_close'
                                                for m in range(idx + 1, n_tok)
                                            )
                                        ):
                                            can_peel_ref_brk = False
                                    elif any(entry[0] in ('IMG', 'IMG_CLOSED') for entry in li_stack):
                                        outer_stack = [s for s in stack if s < ref_open]
                                        _img_c, eff_len = effective_stack_metrics(
                                            outer_stack,
                                            ref_pos=tokens[ref_open]['pos'],
                                            ref_idx=ref_open,
                                        )
                                        if eff_len > 0 and count_surplus_closers(
                                            idx + 1,
                                            include_ref=True,
                                            include_plain=False,
                                        ) < eff_len:
                                            can_peel_ref_brk = False
                                if can_peel_ref_brk:
                                    if any(has_real_ref_img[k] for k in range(ref_open + 1, idx)):
                                        closed_img_link_spans.append((tokens[ref_open]['pos'], tok['dest_end']))
                                    for k in range(ref_open, idx + 1):
                                        active[k] = False
                                    add_peeled_span((tokens[ref_open]['pos'], tok['dest_end'] + 1))
                                    while stack and stack[-1] >= ref_open:
                                        stack.pop()
                                    peeled = True
                                    idx += 1
                                    continue
                    if is_math_interval_close(
                        tokens[stack[-1]]['open_end'],
                        tok,
                        tokens[stack[-1]]['type'],
                    ):
                        idx += 1
                        continue
                    top = stack.pop()
                    op = tokens[top]
                    has_active_inner = any(active[k] for k in range(top + 1, idx))
                    # 若是普通链接 [label](dest) 内仅包含干净闭合的字面 `![FALL]` 且无多余外层闭合符，
                    # 允许剥离该链接，防止前文未闭合散文 `![e me` 或内层 `![FALL]` 劫持它。
                    if has_active_inner:
                        first_inner = next(k for k in range(top + 1, idx) if active[k])
                        first_inner_pos = tokens[first_inner]['pos']
                        _img_c, eff_len = effective_stack_metrics(stack, ref_pos=op['pos'], ref_idx=top)
                        note_count = note_wrapper_count_on_stack(stack, op['pos'])
                        prefix_before_inner = mask_seg_spans(op['open_end'], first_inner_pos, peeled_spans)
                        is_wrapped_img_note = (
                            op['type'] == 'OPEN_BRK' and tok['type'] == 'CLOSE_LINK'
                            and bool(tok.get('is_url'))
                            and bool(seg[op['open_end']:first_inner_pos].strip())
                        )
                        if eff_len > 0 and note_count > 0:
                            use_plain_inner = True
                            max_plain_inner = note_count + (1 if is_wrapped_img_note else 0)
                            req_imm_inner = False
                        elif is_wrapped_img_note:
                            has_inner_link_before = any(
                                not active[k] and tokens[k]['type'] == 'CLOSE_LINK'
                                for k in range(top + 1, first_inner)
                            )
                            use_plain_inner, max_plain_inner, req_imm_inner = True, 1, not has_inner_link_before
                        else:
                            use_plain_inner, max_plain_inner, req_imm_inner = False, 0, False
                        if op['type'] == 'OPEN_BRK' and tok['type'] == 'CLOSE_LINK' \
                                and only_clean_literal_imgs_inside(top, idx) \
                                and not is_half_open_interval_text(prefix_before_inner) \
                                and not (
                                    has_unpaired_close_paren(prefix_before_inner)
                                    and is_likely_image_url(tok.get('url', ''))
                                ) \
                                and count_surplus_closers(
                                    idx + 1,
                                    include_ref=True,
                                    include_plain=use_plain_inner,
                                    max_plain=max_plain_inner,
                                    require_immediate_plain=req_imm_inner,
                                ) <= eff_len:
                            inner_span = mask_seg_spans(op['open_end'], tok['pos'], peeled_spans)
                            if not has_unpaired_close_paren(inner_span) or can_peel_paren_link(stack, top, idx, inner_span):
                                if any(has_real_ref_img[k] for k in range(top + 1, idx)):
                                    closed_img_link_spans.append((op['pos'], tok['dest_end']))
                                for k in range(top, idx + 1):
                                    active[k] = False
                                add_peeled_span((op['pos'], tok['dest_end'] + 1))
                                peeled = True
                                idx += 1
                                continue
                        idx += 1
                        continue
                    if any(
                        tokens[k]['type'] == 'OPEN_IMG' and not has_ref_img[k]
                        for k in range(top + 1, idx)
                    ):
                        idx += 1
                        continue
                    # 平衡空目标行内图：![balanced_alt]() / ![balanced_alt](<>)
                    if op['type'] == 'OPEN_IMG' and (
                        (tok['type'] == 'CLOSE_OTHER' and tok['subkind'] == 'empty_paren')
                        or (tok['type'] == 'CLOSE_LINK' and not tok['is_url'] and tok.get('url', '') == '')
                    ):
                        alt_span = mask_seg_spans(op['open_end'], tok['pos'], peeled_spans)
                        has_later_open_img_before_cl = False
                        m_scan = idx + 1
                        while m_scan < n_tok:
                            if not active[m_scan]:
                                m_scan += 1
                                continue
                            mt_scan = tokens[m_scan]
                            if mt_scan['type'] == 'CLOSE_LINK':
                                if mt_scan['is_url'] or mt_scan.get('url', '') != '':
                                    break
                                m_scan += 1
                                continue
                            if mt_scan['type'] == 'OPEN_IMG':
                                # 紧随其后的独立平衡空目标图 `![e]()` / `![e](<>)` 不会阻止当前空目标图同趟剥离，避免 O(N³)。
                                next_act = m_scan + 1
                                while next_act < n_tok and not active[next_act]:
                                    next_act += 1
                                if next_act < n_tok:
                                    nt_act = tokens[next_act]
                                    is_adj_empty = (
                                        (nt_act['type'] == 'CLOSE_OTHER' and nt_act['subkind'] == 'empty_paren')
                                        or (nt_act['type'] == 'CLOSE_LINK' and not nt_act['is_url'] and nt_act.get('url', '') == '')
                                    )
                                    if is_adj_empty:
                                        adj_alt = mask_seg_spans(mt_scan['open_end'], nt_act['pos'], peeled_spans)
                                        if not has_unpaired_open_paren(adj_alt) and not has_unpaired_close_paren(adj_alt):
                                            m_scan = next_act + 1
                                            continue
                                has_later_open_img_before_cl = True
                                break
                            m_scan += 1
                        if not has_later_open_img_before_cl \
                                and not any(active[k] and tokens[k]['type'] == 'CLOSE_LINK' for k in range(top + 1, idx)) \
                                and not has_unpaired_open_paren(alt_span) \
                                and not has_unpaired_close_paren(alt_span):
                            stack_key = tuple(stack)
                            cached_metrics = pass_stack_metrics_cache.get(stack_key)
                            cache_hit = False
                            if cached_metrics is not None:
                                c_top, c_pos, c_eff, c_note, c_last_empty, c_last_paren = cached_metrics
                                if c_top < top and c_pos <= op['pos'] \
                                        and not any(active[k] for k in range(c_top, top)) \
                                        and not mask_seg_spans(c_pos, op['pos'], peeled_spans).strip():
                                    eff_len = c_eff
                                    note_count = c_note
                                    if c_last_empty and stack and tokens[stack[-1]]['type'] == 'OPEN_BRK' \
                                            and seg[tokens[stack[-1]]['open_end']:op['pos']].strip():
                                        if not c_last_paren:
                                            note_count += 1
                                        c_last_empty = False
                                    pass_stack_metrics_cache[stack_key] = (
                                        top, op['pos'], eff_len, note_count, c_last_empty, c_last_paren,
                                    )
                                    cache_hit = True
                            if not cache_hit:
                                _img_c, eff_len = effective_stack_metrics(stack, ref_pos=op['pos'], ref_idx=top)
                                note_count = note_wrapper_count_on_stack(stack, op['pos'])
                                if stack and tokens[stack[-1]]['type'] == 'OPEN_BRK':
                                    last_st = tokens[stack[-1]]
                                    last_masked = mask_seg_spans(last_st['open_end'], op['pos'], peeled_spans)
                                    last_is_paren = is_half_open_interval_text(last_masked) or has_unpaired_close_paren(last_masked)
                                    last_is_empty = not seg[last_st['open_end']:op['pos']].strip()
                                else:
                                    last_is_paren = False
                                    last_is_empty = False
                                pass_stack_metrics_cache[stack_key] = (
                                    top, op['pos'], eff_len, note_count, last_is_empty, last_is_paren,
                                )
                            use_plain_empty = eff_len > 0 and note_count > 0
                            if count_surplus_closers(
                                idx + 1,
                                include_ref=True,
                                include_plain=use_plain_empty,
                                max_plain=note_count,
                            ) <= eff_len:
                                for k in range(top, idx + 1):
                                    active[k] = False
                                has_ref_img[top] = True
                                add_peeled_span((op['pos'], tok['dest_end'] + 1))
                                peeled_empty_img_spans.append((op['pos'], tok['dest_end']))
                                peeled = True
                                idx += 1
                                continue
                        idx += 1
                        continue
                    # 平衡引用图：![balanced_alt][ref]
                    if op['type'] == 'OPEN_IMG' and tok['type'] == 'CLOSE_OTHER' and tok['subkind'] == 'ref_close':
                        alt_span = mask_seg_spans(op['open_end'], tok['pos'], peeled_spans)
                        if not any(active[k] and tokens[k]['type'] == 'CLOSE_LINK' for k in range(top + 1, idx)) \
                                and not has_unpaired_open_paren(alt_span) \
                                and not has_unpaired_close_paren(alt_span):
                            ref_end = find_clean_ref_span(idx)
                            _img_c, eff_len = effective_stack_metrics(stack, ref_pos=op['pos'], ref_idx=top)
                            note_count = note_wrapper_count_on_stack(stack, op['pos'])
                            use_plain_ref = eff_len > 0 and note_count > 0
                            if ref_end is not None \
                                    and count_surplus_closers(
                                        ref_end + 1,
                                        include_ref=True,
                                        include_plain=use_plain_ref,
                                        max_plain=note_count,
                                    ) <= eff_len:
                                for k in range(top, ref_end + 1):
                                    active[k] = False
                                has_ref_img[top] = True
                                has_real_ref_img[top] = True
                                add_peeled_span((op['pos'], tokens[ref_end]['dest_end'] + 1))
                                peeled_ref_img_spans.append((op['pos'], tokens[ref_end]['dest_end']))
                                peeled = True
                                idx = ref_end + 1
                                continue
                        idx += 1
                        continue
                    if op['type'] != 'OPEN_BRK':
                        idx += 1
                        continue
                    if tok['type'] == 'CLOSE_LINK':
                        inner_span = mask_seg_spans(op['open_end'], tok['pos'], peeled_spans)
                        has_prior_linked_img = False
                        if is_half_open_interval_text(inner_span) or has_unpaired_close_paren(inner_span):
                            # 追踪 top 之前尚未闭合的外层 `[` 是否已包含闭合图片（例如 `[![FALL] caption](f1) over [0, 1)](p1)`
                            # 或 `[Panel a)](p1)`）；仅当跳过未闭合区间/未配对右括号后栈顶本身就是已含图片的 `BRK` 时阻断，
                            # 且当该外层 `[` 是带前置说明文本的注释包裹（如 `[Note: ![Fig 1](f1) and [1) a](a) ...]`）
                            # 并且当前子链接不以 `)` 结尾时放行内部子链接，避免拦截同一注释内的普通子链接。
                            li_stack, li_closed = simulate_open_stack_before(top)
                            probe = len(li_stack) - 1
                            next_p = op['pos']
                            while probe >= 0 and li_stack[probe][0] == 'BRK' and li_stack[probe][1] is None:
                                slice_txt = mask_seg_spans(tokens[li_stack[probe][2]]['open_end'], next_p, li_closed, already_sorted=True)
                                if is_half_open_interval_text(slice_txt) or has_unpaired_close_paren(slice_txt):
                                    next_p = tokens[li_stack[probe][2]]['pos']
                                    probe -= 1
                                else:
                                    break
                            if probe >= 0 and li_stack[probe][0] == 'BRK' and li_stack[probe][1] is not None:
                                brk_prefix = mask_seg_spans(
                                    tokens[li_stack[probe][2]]['open_end'],
                                    li_stack[probe][1],
                                    li_closed,
                                    already_sorted=True,
                                ).strip()
                                if not brk_prefix:
                                    has_prior_linked_img = True
                                elif inner_span.rstrip().endswith(')') and (
                                    is_half_open_interval_text(inner_span)
                                    or not any(
                                        active[m] and tokens[m]['type'] == 'CLOSE_OTHER'
                                        and tokens[m]['subkind'] == 'plain_close'
                                        for m in range(idx + 1, n_tok)
                                    )
                                ):
                                    has_prior_linked_img = True
                        if not has_prior_linked_img \
                                and (not has_unpaired_close_paren(inner_span) or can_peel_paren_link(stack, top, idx, inner_span)):
                            if any(has_real_ref_img[k] for k in range(top + 1, idx)):
                                closed_img_link_spans.append((op['pos'], tok['dest_end']))
                            for k in range(top, idx + 1):
                                active[k] = False
                            add_peeled_span((op['pos'], tok['dest_end'] + 1))
                            peeled = True
                            idx += 1
                            continue
                        if not has_prior_linked_img and has_unpaired_close_paren(inner_span):
                            skipped_paren_links.append((top, idx, list(stack)))
                    elif tok['type'] == 'CLOSE_OTHER' and tok['subkind'] == 'ref_close':
                        inner_span = mask_seg_spans(op['open_end'], tok['pos'], peeled_spans)
                        if not any(tokens[k]['type'] == 'CLOSE_LINK' for k in range(top + 1, idx)) \
                                and not has_unpaired_close_paren(inner_span) \
                                and not has_unpaired_open_paren(inner_span):
                            ref_end = find_clean_ref_span(idx)
                            if ref_end is not None:
                                if any(has_real_ref_img[k] for k in range(top + 1, idx)):
                                    closed_img_link_spans.append((op['pos'], tokens[ref_end]['dest_end']))
                                for k in range(top, ref_end + 1):
                                    active[k] = False
                                clean_peeled_brk_end[top] = ref_end
                                add_peeled_span((op['pos'], tokens[ref_end]['dest_end'] + 1))
                                peeled = True
                                idx = ref_end + 1
                                continue
                            # `ref_close` 后跟已剥离行内链接（如 `[1][link](url)`）导致无干净引用标签时，退化为普通平衡 `]` 剥离。
                            for k in range(top, idx + 1):
                                active[k] = False
                            clean_peeled_brk_end[top] = idx
                            add_peeled_span((op['pos'], tok['dest_end'] + 1))
                            peeled = True
                            idx += 1
                            continue
                    elif tok['type'] == 'CLOSE_OTHER' and tok['subkind'] in ('plain_close', 'empty_paren'):
                        inner_span = mask_seg_spans(op['open_end'], tok['pos'], peeled_spans)
                        if not any(tokens[k]['type'] == 'CLOSE_LINK' for k in range(top + 1, idx)) \
                                and not has_unpaired_close_paren(inner_span) \
                                and (tok['subkind'] == 'empty_paren' or not has_unpaired_open_paren(inner_span)):
                            for k in range(top, idx + 1):
                                active[k] = False
                            if tok['subkind'] == 'plain_close':
                                clean_peeled_brk_end[top] = idx
                            add_peeled_span((op['pos'], tok['dest_end'] + 1))
                            peeled = True
                            idx += 1
                            continue
                    idx += 1
                # 本趟若在右侧发生剥离，仅在纯 OPEN_IMG 栈且无外层/中间 OPEN_BRK 干扰时逆向级联收尾
                # `surplus_url == 0` 链接（与左到右剥离严格等价，且消除 `![a *N + [1) x](a) *N` 的 O(N³) 轮次膨胀）。
                if peeled and skipped_paren_links:
                    prev_cascade_end = n_tok
                    for s_top, s_idx, s_stack in reversed(skipped_paren_links):
                        if not active[s_top] or not active[s_idx]:
                            continue
                        if any(active[k] for k in range(s_top + 1, s_idx)):
                            continue
                        cur_s_stack = [s for s in s_stack if active[s]]
                        if not cur_s_stack or any(tokens[s]['type'] != 'OPEN_IMG' for s in cur_s_stack):
                            break
                        if any(active[k] and tokens[k]['type'] == 'OPEN_BRK' for k in range(s_idx + 1, prev_cascade_end)):
                            break
                        s_op = tokens[s_top]
                        s_tok = tokens[s_idx]
                        s_inner = mask_seg_spans(s_op['open_end'], s_tok['pos'], peeled_spans)
                        if not has_unpaired_close_paren(s_inner):
                            break
                        li_st_s, _ = simulate_open_stack_before(s_top)
                        if any(e[0] == 'BRK' for e in li_st_s):
                            break
                        if can_peel_paren_link(cur_s_stack, s_top, s_idx, s_inner):
                            if any(has_real_ref_img[k] for k in range(s_top + 1, s_idx)):
                                closed_img_link_spans.append((s_op['pos'], s_tok['dest_end']))
                            for k in range(s_top, s_idx + 1):
                                active[k] = False
                            add_peeled_span((s_op['pos'], s_tok['dest_end'] + 1))
                            prev_cascade_end = s_top
                        else:
                            break
            # 防止它在后文存在新链接/图片时跨句劫持无关的 `](url)`。
            # 严禁跨越中间的 CLOSE_LINK 配对（如 `[Note: ![Fig 1: [0, 1)](url)]` 中的末 `]`）。
            clean_plain_close = {}
            clean_plain_close_idx = {}
            clean_other_close = {}
            clean_other_close_idx = {}
            clean_other_close_kind = {}
            tmp_stack = []
            for idx in range(n_tok):
                if not active[idx]:
                    continue
                tok = tokens[idx]
                if tok['type'] in ('OPEN_IMG', 'OPEN_BRK'):
                    tmp_stack.append(idx)
                elif tmp_stack:
                    if is_math_interval_close(
                        tokens[tmp_stack[-1]]['open_end'],
                        tok,
                        tokens[tmp_stack[-1]]['type'],
                    ):
                        continue
                    top = tmp_stack.pop()
                    is_empty_angle_img = (
                        tok['type'] == 'CLOSE_LINK' and not tok['is_url'] and tok.get('url', '') == ''
                    )
                    if tokens[top]['type'] == 'OPEN_IMG' and (tok['type'] == 'CLOSE_OTHER' or is_empty_angle_img) \
                            and not any(active[m] and tokens[m]['type'] == 'CLOSE_LINK' for m in range(top + 1, idx)) \
                            and not has_unpaired_open_paren(mask_seg_spans(tokens[top]['open_end'], tok['pos'], peeled_spans)):
                        is_unresolved_ref_with_span = (
                            tok['type'] == 'CLOSE_OTHER'
                            and tok['subkind'] == 'ref_close'
                            and find_clean_ref_span(idx) is not None
                        )
                        if tok['type'] == 'CLOSE_OTHER' and (
                            tok['subkind'] == 'plain_close'
                            or (tok['subkind'] == 'ref_close' and not is_unresolved_ref_with_span)
                        ):
                            clean_plain_close[top] = tok['pos']
                            clean_plain_close_idx[top] = idx
                        elif is_empty_angle_img or tok['subkind'] == 'empty_paren' or is_unresolved_ref_with_span:
                            clean_other_close[top] = tok['pos']
                            clean_other_close_idx[top] = idx
                            clean_other_close_kind[top] = (
                                'ref_close'
                                if is_unresolved_ref_with_span
                                else 'empty_paren'
                            )

            # Step 2：从左到右配对所有剩余的有效 URL 闭合 `](url)`。
            matched_imgs = []
            matched_img_spans = []
            step2_masked_spans = list(peeled_spans)
            step2_unpaired_paren_cache = {}  # OPEN_BRK idx -> first unpaired ')' char pos (invalidated if covered by new matched img)
            # Precompute prefix max of CLOSE_OTHER (tok_idx, dest_end + 1) for O(1) last_other_end lookups in Step 2.
            prefix_close_other_idx = [-1] * (n_tok + 1)
            prefix_close_other_end = [0] * (n_tok + 1)
            for _mi in range(n_tok):
                if tokens[_mi]['type'] == 'CLOSE_OTHER':
                    prefix_close_other_idx[_mi + 1] = _mi
                    prefix_close_other_end[_mi + 1] = max(prefix_close_other_end[_mi], tokens[_mi]['dest_end'] + 1)
                else:
                    prefix_close_other_idx[_mi + 1] = prefix_close_other_idx[_mi]
                    prefix_close_other_end[_mi + 1] = prefix_close_other_end[_mi]
            for cl_idx in range(n_tok):
                if not active[cl_idx]:
                    continue
                cl = tokens[cl_idx]
                if cl['type'] != 'CLOSE_LINK' or not cl['is_url']:
                    continue
                left_active = [k for k in range(cl_idx) if active[k]]
                cl_pos = cl['pos']
                cl_surplus_cache = {}

                def seg_outside_matched_imgs(start_pos, end_pos):
                    return mask_seg_spans(start_pos, end_pos, step2_masked_spans, already_sorted=True)

                def cached_cl_surplus(include_ref, include_plain, max_plain=None, require_immediate_plain=False):
                    key = (include_ref, include_plain, max_plain, require_immediate_plain)
                    val = cl_surplus_cache.get(key)
                    if val is None:
                        val = count_surplus_closers(
                            cl_idx + 1,
                            include_ref=include_ref,
                            include_plain=include_plain,
                            max_plain=max_plain,
                            require_immediate_plain=require_immediate_plain,
                        )
                        cl_surplus_cache[key] = val
                    return val

                def is_clean_brk_between(start_pos, end_pos):
                    for bi, b_idx in enumerate(left_active):
                        bt = tokens[b_idx]
                        if bt['type'] != 'OPEN_BRK' or bt['pos'] <= start_pos or bt['pos'] >= end_pos:
                            continue
                        next_pos = tokens[left_active[bi + 1]]['pos'] if bi + 1 < len(left_active) else end_pos
                        if not has_unpaired_close_paren(seg_outside_matched_imgs(bt['open_end'], next_pos)):
                            return True
                    return False

                # 单次前向扫描构建本 `cl_idx` 下所有左侧 OPEN_IMG 位置处的未闭合外层 OPEN_BRK 列表，
                # 消除 `for earlier in candidate_earliers:` 对 `unclosed_enclosing_brks_before` 的 O(N³) 重复扫描。
                unclosed_brks_map = None

                def _ensure_unclosed_brks_map():
                    nonlocal unclosed_brks_map
                    if unclosed_brks_map is not None:
                        return unclosed_brks_map
                    unclosed_brks_map = {}
                    next_open_pos_after = {}
                    last_open_pos = cl_pos
                    for m_rev in reversed(left_active):
                        mt_rev = tokens[m_rev]
                        if mt_rev['type'] in ('OPEN_BRK', 'OPEN_IMG'):
                            if mt_rev['type'] == 'OPEN_BRK':
                                next_open_pos_after[m_rev] = last_open_pos
                            last_open_pos = mt_rev['pos']
                    brk_prefix_bad_cache = {}

                    def brk_prefix_bad(idx_b):
                        cached = brk_prefix_bad_cache.get(idx_b)
                        if cached is None:
                            cached = has_unpaired_close_paren(
                                seg_outside_matched_imgs(tokens[idx_b]['open_end'], next_open_pos_after.get(idx_b, cl_pos))
                            )
                            brk_prefix_bad_cache[idx_b] = cached
                        return cached

                    b_stack = []
                    good_brks = []
                    last_close_pos = -1

                    def b_pop():
                        kind_b, idx_b = b_stack.pop()
                        if kind_b == 'BRK' and good_brks and good_brks[-1] == idx_b:
                            good_brks.pop()

                    def b_unwind_intervals(close_pos):
                        next_pos = close_pos
                        while b_stack and b_stack[-1][0] == 'BRK':
                            o_end = tokens[b_stack[-1][1]]['open_end']
                            slice_txt = seg_outside_matched_imgs(o_end, next_pos)
                            if is_half_open_interval_text(slice_txt) or has_unpaired_close_paren(slice_txt):
                                next_pos = tokens[b_stack[-1][1]]['pos']
                                b_pop()
                            else:
                                break

                    m_pos_i = 0
                    n_left = len(left_active)
                    while m_pos_i < n_left:
                        m = left_active[m_pos_i]
                        mt = tokens[m]
                        if mt['type'] == 'OPEN_IMG':
                            unclosed_brks_map[m] = list(good_brks)
                            b_stack.append(('IMG', m))
                        elif mt['type'] == 'OPEN_BRK':
                            b_stack.append(('BRK', m))
                            if not brk_prefix_bad(m):
                                good_brks.append(m)
                        elif mt['type'] == 'CLOSE_OTHER' and b_stack:
                            if mt['subkind'] == 'ref_close':
                                ref_end = find_clean_ref_span(m)
                                if ref_end is not None and ref_end < cl_idx:
                                    b_unwind_intervals(mt['pos'])
                                    if b_stack:
                                        b_pop()
                                    last_close_pos = tokens[ref_end]['dest_end']
                                    while m_pos_i < n_left and left_active[m_pos_i] <= ref_end:
                                        m_pos_i += 1
                                    continue
                                if ref_end is None:
                                    b_unwind_intervals(mt['pos'])
                                    if b_stack:
                                        scan_start = max(tokens[b_stack[-1][1]]['open_end'], last_close_pos + 1)
                                        if b_stack[-1][0] == 'BRK' \
                                                or not has_unpaired_open_paren(seg_outside_matched_imgs(scan_start, mt['pos'])):
                                            b_pop()
                                    last_close_pos = mt['dest_end']
                            elif mt['subkind'] in ('empty_paren', 'plain_close'):
                                b_unwind_intervals(mt['pos'])
                                if b_stack:
                                    scan_start = max(tokens[b_stack[-1][1]]['open_end'], last_close_pos + 1)
                                    if b_stack[-1][0] == 'BRK' \
                                            or not has_unpaired_open_paren(seg_outside_matched_imgs(scan_start, mt['pos'])):
                                        b_pop()
                                last_close_pos = mt['dest_end']
                        elif mt['type'] == 'CLOSE_LINK' and b_stack:
                            b_unwind_intervals(mt['pos'])
                            if b_stack:
                                scan_start = max(tokens[b_stack[-1][1]]['open_end'], last_close_pos + 1)
                                if b_stack[-1][0] == 'BRK' or mt['is_url'] \
                                        or not has_unpaired_open_paren(seg_outside_matched_imgs(scan_start, mt['pos'])):
                                    b_pop()
                            last_close_pos = mt['dest_end']
                        m_pos_i += 1
                    return unclosed_brks_map

                def unclosed_enclosing_brks_before(target_idx):
                    return _ensure_unclosed_brks_map().get(target_idx, [])

                # 惰性构建当前 `cl_idx` 的掩码前文缓冲区，将 `img_lead_has_prose_break` 降至 O(1)/候选。
                cl_prose_state = None

                def lead_has_prose_break_from(open_end_pos):
                    nonlocal cl_prose_state
                    if cl_prose_state is None:
                        buf_parts = []
                        seg_ranges = []
                        cur_p = 0
                        buf_len = 0
                        for cs, ce in step2_masked_spans:
                            if ce <= cur_p:
                                continue
                            if cs >= cl_pos:
                                break
                            if cs > cur_p:
                                piece = seg[cur_p:cs]
                                seg_ranges.append((cur_p, cs, buf_len))
                                buf_parts.append(piece)
                                buf_len += len(piece)
                            cur_p = max(cur_p, ce)
                        if cur_p < cl_pos:
                            piece = seg[cur_p:cl_pos]
                            seg_ranges.append((cur_p, cl_pos, buf_len))
                            buf_parts.append(piece)
                            buf_len += len(piece)
                        cl_buf = ''.join(buf_parts)
                        range_starts = [rs for rs, _re, _bo in seg_ranges]
                        last_non_see = -1
                        for m_pb in prose_break_non_see_re.finditer(cl_buf):
                            last_non_see = m_pb.start()
                        t_see_m = trailing_see_re.search(cl_buf)
                        t_see_start = t_see_m.start() if t_see_m else -1
                        cl_prose_state = (cl_buf, seg_ranges, range_starts, last_non_see, t_see_start)
                    cl_buf, seg_ranges, range_starts, last_non_see, t_see_start = cl_prose_state
                    if not seg_ranges:
                        return False
                    ri = _bisect.bisect_right(range_starts, open_end_pos) - 1
                    if ri >= 0 and open_end_pos < seg_ranges[ri][1]:
                        b_off = seg_ranges[ri][2] + (open_end_pos - seg_ranges[ri][0])
                    elif ri + 1 < len(seg_ranges):
                        b_off = seg_ranges[ri + 1][2]
                    else:
                        return False
                    if caption_prefix_re.match(cl_buf, b_off):
                        return False
                    if last_non_see >= b_off:
                        return True
                    if t_see_start >= b_off and (
                        t_see_start == b_off or not (cl_buf[t_see_start - 1].isalnum() or cl_buf[t_see_start - 1] == '_')
                    ):
                        return True
                    return False

                cand_imgs = []
                cl_is_img_url = is_likely_image_url(cl.get('url', ''))
                tail_wrap_cache = {}
                all_nested_sources = (*matched_img_spans, *peeled_ref_img_spans)
                nested_before_cl = sorted(
                    (ms, me) for ms, me in all_nested_sources if me < cl_pos
                ) if all_nested_sources else []
                nested_ms = [ms for ms, _me in nested_before_cl]
                nested_suf_max_end = []
                if nested_before_cl:
                    nested_suf_max_end = [-1] * len(nested_before_cl)
                    cur_max_e = -1
                    for ni in range(len(nested_before_cl) - 1, -1, -1):
                        if nested_before_cl[ni][1] > cur_max_e:
                            cur_max_e = nested_before_cl[ni][1]
                        nested_suf_max_end[ni] = cur_max_e
                # 惰性计算位于任意嵌套真实图之前、且自身干净拥有嵌套图的最右侧活跃未闭合 `OPEN_BRK`
                # 或已闭合外链图片 `[...](url)` 起点位置，防止左侧孤立 `![e me,` 跨过合法外链劫持 `](url)`，
                # 同时避免 O(N³) 并排除已被 `]` 闭合的普通 `[Panel ![sub](s.png)]`。
                max_clean_owning_brk_pos = None

                def get_max_clean_owning_brk_pos():
                    nonlocal max_clean_owning_brk_pos
                    if max_clean_owning_brk_pos is not None:
                        return max_clean_owning_brk_pos
                    best_pos = -1
                    for ls, le in closed_img_link_spans:
                        if le < cl_pos and ls > best_pos:
                            best_pos = ls
                    if not nested_before_cl:
                        max_clean_owning_brk_pos = best_pos
                        return best_pos
                    max_ms_under_cl = nested_ms[-1]
                    # 单趟计算在 `cl_idx` 之前仍未闭合的活跃 `OPEN_BRK` 集合
                    brk_open_stack = []
                    for m_la in left_active:
                        mt_la = tokens[m_la]
                        if mt_la['type'] in ('OPEN_IMG', 'OPEN_BRK'):
                            brk_open_stack.append(m_la)
                        elif brk_open_stack:
                            if is_math_interval_close(
                                tokens[brk_open_stack[-1]]['open_end'],
                                mt_la,
                                tokens[brk_open_stack[-1]]['type'],
                            ):
                                continue
                            brk_open_stack.pop()
                    # 从右向左扫描仍未闭合且位于嵌套图之前的 `OPEN_BRK`，命中首个干净拥有嵌套图的 `[` 即停止
                    # 用所有活跃 OPEN_BRK 位置界定右端，避免已被 `(0, 1]` 弹出的内层 `[0, 1)` 漏入外层 `b_slice`。
                    all_active_brk_pos = [tokens[m_la]['pos'] for m_la in left_active if tokens[m_la]['type'] == 'OPEN_BRK']
                    for b_i in reversed(brk_open_stack):
                        bt_i = tokens[b_i]
                        if bt_i['type'] != 'OPEN_BRK':
                            continue
                        b_pos = bt_i['pos']
                        if b_pos <= best_pos:
                            break
                        if b_pos < max_ms_under_cl:
                            ni_b = _bisect.bisect_right(nested_ms, b_pos)
                            if ni_b < len(nested_ms):
                                first_ms_after_b = nested_ms[ni_b]
                                bi_nxt = _bisect.bisect_right(all_active_brk_pos, b_pos)
                                next_inner_brk_pos = all_active_brk_pos[bi_nxt] if bi_nxt < len(all_active_brk_pos) else cl_pos
                                slice_end = min(first_ms_after_b, next_inner_brk_pos)
                                b_slice = seg_outside_matched_imgs(bt_i['open_end'], slice_end)
                                if not has_unpaired_close_paren(b_slice) and not is_half_open_interval_text(b_slice):
                                    best_pos = b_pos
                                    break
                    max_clean_owning_brk_pos = best_pos
                    return best_pos

                # Single O(L) incremental scan over left_active for O(1) enclosing-open-img & unclosed-brk checks.
                _inf_pos = seg_len + 1
                max_prev_img_close_pos = -1
                running_unclosed_stack = []
                running_unclosed_brk_count = 0
                later_open_img_suffix_max_pos = {}
                _max_img_pos_seen = -1
                for _m_rev in reversed(left_active):
                    later_open_img_suffix_max_pos[_m_rev] = _max_img_pos_seen
                    if tokens[_m_rev]['type'] == 'OPEN_IMG':
                        if tokens[_m_rev]['pos'] > _max_img_pos_seen:
                            _max_img_pos_seen = tokens[_m_rev]['pos']
                _inactive_cl_scan = 0
                _max_inactive_cl_idx = -1

                for k in left_active:
                    while _inactive_cl_scan < k:
                        if not active[_inactive_cl_scan] and tokens[_inactive_cl_scan]['type'] == 'CLOSE_LINK':
                            _max_inactive_cl_idx = _inactive_cl_scan
                        _inactive_cl_scan += 1
                    kt_cur = tokens[k]
                    has_enclosing_open_img_before_k = max_prev_img_close_pos >= kt_cur['pos']
                    has_any_unclosed_brk_before_k_cur = running_unclosed_brk_count > 0
                    # Maintain running_unclosed_stack & max_prev_img_close_pos incrementally
                    if kt_cur['type'] in ('OPEN_IMG', 'OPEN_BRK'):
                        running_unclosed_stack.append(k)
                        if kt_cur['type'] == 'OPEN_BRK':
                            running_unclosed_brk_count += 1
                    elif running_unclosed_stack:
                        if not is_math_interval_close(
                            tokens[running_unclosed_stack[-1]]['open_end'],
                            kt_cur,
                            tokens[running_unclosed_stack[-1]]['type'],
                        ):
                            _popped_r = running_unclosed_stack.pop()
                            if tokens[_popped_r]['type'] == 'OPEN_BRK':
                                running_unclosed_brk_count -= 1
                    if kt_cur['type'] != 'OPEN_IMG':
                        continue
                    _k_close_pos = _inf_pos
                    if k in clean_plain_close:
                        _k_close_pos = min(_k_close_pos, clean_plain_close[k])
                    if k in clean_other_close:
                        _k_close_pos = min(_k_close_pos, clean_other_close[k])
                    if _k_close_pos > max_prev_img_close_pos:
                        max_prev_img_close_pos = _k_close_pos
                    # 严禁跨越已经匹配完成的独立图片或已剥离的引用图片；
                    # 仅当外层图片自身指向图片 URL、未提前闭合、不跨越干净外链 `[`、无散文断句，
                    # 且在嵌套图之后确实存在未闭合方括号/半开区间待修复时才允许包裹嵌套图。
                    max_nested_end = -1
                    k_pos = kt_cur['pos']
                    if nested_ms:
                        ni_k = _bisect.bisect_right(nested_ms, k_pos)
                        if ni_k < len(nested_suf_max_end):
                            max_nested_end = nested_suf_max_end[ni_k]
                    if max_nested_end >= 0:
                        if not cl_is_img_url \
                                or (k in clean_plain_close and clean_plain_close[k] < cl_pos) \
                                or (k in clean_other_close and clean_other_close[k] < cl_pos):
                            continue
                        tail_ok = tail_wrap_cache.get(max_nested_end)
                        if tail_ok is None:
                            tail_after_nested = mask_seg_spans(max_nested_end + 1, cl_pos, peeled_spans)
                            if ('(' in tail_after_nested or ')' in tail_after_nested) \
                                    and not tail_conj_prefix_re.match(tail_after_nested.strip()):
                                has_tail_close_p = has_unpaired_close_paren(tail_after_nested)
                                has_tail_open_p = has_unpaired_open_paren(tail_after_nested)
                                has_tail_brk = any(
                                    tokens[m]['pos'] > max_nested_end and tokens[m]['type'] == 'OPEN_BRK'
                                    for m in left_active
                                ) if has_tail_close_p else False
                                has_tail_other = any(
                                    tokens[m]['pos'] > max_nested_end and tokens[m]['type'] == 'CLOSE_OTHER'
                                    for m in left_active
                                ) if has_tail_open_p else False
                                tail_ok = (has_tail_close_p and has_tail_brk) or (has_tail_open_p and has_tail_other)
                            else:
                                tail_ok = False
                            tail_wrap_cache[max_nested_end] = tail_ok
                        if not tail_ok or lead_has_prose_break_from(tokens[k]['open_end']):
                            continue
                        if k_pos < get_max_clean_owning_brk_pos():
                            continue
                    if k in clean_other_close and clean_other_close[k] < cl_pos:
                        oc_idx = clean_other_close_idx[k]
                        oc_kind = clean_other_close_kind[k]
                        oc_end = tokens[oc_idx]['dest_end']
                        if oc_kind == 'ref_close':
                            oc_ref_end = find_clean_ref_span(oc_idx)
                            if oc_ref_end is not None and oc_ref_end < cl_idx:
                                oc_end = tokens[oc_ref_end]['dest_end']
                        last_other_end_oc = (
                            max(oc_end + 1, prefix_close_other_end[cl_idx])
                            if prefix_close_other_idx[cl_idx] > oc_idx
                            else oc_end + 1
                        )
                        if has_unpaired_open_paren(mask_seg_spans(last_other_end_oc, cl['pos'], peeled_spans)):
                            continue
                        if is_clean_brk_between(oc_end, cl['pos']):
                            continue
                        if has_enclosing_open_img_before_k:
                            continue
                        allow_captionless_ref_img = (oc_kind == 'ref_close' and cl_is_img_url)
                        if has_any_unclosed_brk_before_k_cur:
                            after_oc_txt = mask_seg_spans(oc_end + 1, cl['pos'], peeled_spans)
                            if (not after_oc_txt.strip() and not allow_captionless_ref_img) \
                                    or has_unpaired_close_paren(after_oc_txt) \
                                    or has_unpaired_open_paren(after_oc_txt):
                                continue
                        enclosing_brks_before_k_oc = unclosed_enclosing_brks_before(k)
                        if enclosing_brks_before_k_oc:
                            use_plain_outer_oc = bool(cl.get('is_url')) and bool(
                                seg[tokens[enclosing_brks_before_k_oc[0]]['open_end']:tokens[k]['pos']].strip()
                            )
                            has_deactivated_note_oc = _max_inactive_cl_idx > enclosing_brks_before_k_oc[0]
                            surplus_outer_oc = cached_cl_surplus(
                                include_ref=True,
                                include_plain=use_plain_outer_oc,
                                max_plain=len(enclosing_brks_before_k_oc),
                                require_immediate_plain=not (use_plain_outer_oc and has_deactivated_note_oc),
                            )
                            if surplus_outer_oc < len(enclosing_brks_before_k_oc) \
                                    or (not seg[oc_end + 1:cl['pos']].strip() and not allow_captionless_ref_img):
                                continue
                    if k in clean_plain_close and clean_plain_close[k] < cl['pos']:
                        pc_pos = clean_plain_close[k]
                        pc_idx = clean_plain_close_idx[k]
                        last_other_end = (
                            max(pc_pos + 1, prefix_close_other_end[cl_idx])
                            if prefix_close_other_idx[cl_idx] > pc_idx
                            else pc_pos + 1
                        )
                        if has_unpaired_open_paren(mask_seg_spans(last_other_end, cl['pos'], peeled_spans)):
                            continue
                        has_later_img = later_open_img_suffix_max_pos[k] > pc_pos
                        if has_later_img or is_clean_brk_between(pc_pos, cl['pos']):
                            continue
                        # 若左侧已有未闭合的更外层 OPEN_IMG（如 `![Fig 1: see ![FALL] here](f1)`），
                        # 则内部干净闭合的 `![FALL]` 是图注字面量，不与外层图片竞争闭合符。
                        if has_enclosing_open_img_before_k:
                            continue
                        # 若左侧存在任意未闭合的外层 `[`（含带未配对 `)` 的 `[Panel a)`），
                        # 则 `![FALL]` 之后必须存在不含未配对 `)` 的实质图注正文，否则 `](url)` 属于外层链接而非 `![FALL]`。
                        if has_any_unclosed_brk_before_k_cur:
                            after_pc_txt = mask_seg_spans(pc_pos + 1, cl['pos'], peeled_spans)
                            if not after_pc_txt.strip() or has_unpaired_close_paren(after_pc_txt):
                                continue
                        enclosing_brks_before_k = unclosed_enclosing_brks_before(k)
                        if enclosing_brks_before_k:
                            use_plain_outer = bool(cl.get('is_url')) and bool(
                                seg[tokens[enclosing_brks_before_k[0]]['open_end']:tokens[k]['pos']].strip()
                            )
                            has_deactivated_note = _max_inactive_cl_idx > enclosing_brks_before_k[0]
                            surplus_outer = cached_cl_surplus(
                                include_ref=True,
                                include_plain=use_plain_outer,
                                max_plain=len(enclosing_brks_before_k),
                                require_immediate_plain=not (use_plain_outer and has_deactivated_note),
                            )
                            if surplus_outer < len(enclosing_brks_before_k) or not seg[pc_pos + 1:cl['pos']].strip():
                                continue
                    cand_imgs.append(k)

                if cand_imgs:
                    chosen_img = cand_imgs[-1]
                    if len(cand_imgs) >= 2:
                        # 先从 chosen_img 左侧逆向确定最早未阻断的候选位置，
                        # 彻底消除深层嵌套 `[![a ...](url)` 上的 O(N³) 重复扫描。
                        chosen_pos = tokens[chosen_img]['pos']
                        unblocked_earlier = []
                        min_allowed_pos = -1
                        for ms, _me in matched_img_spans:
                            if ms < chosen_pos and ms > min_allowed_pos:
                                min_allowed_pos = ms
                        for ms, _me in peeled_ref_img_spans:
                            if ms < chosen_pos and ms > min_allowed_pos:
                                min_allowed_pos = ms
                        # 逆向扫描 (chosen_img - 1 .. cand_imgs[0])：首个阻断 OPEN_BRK 直接截断更左侧全部候选。
                        cand_set = set(cand_imgs[:-1])
                        skip_open_for_clean_close = set()
                        blocker_idx = -1
                        for m in range(chosen_img - 1, cand_imgs[0] - 1, -1):
                            if not active[m]:
                                continue
                            mt = tokens[m]
                            if mt['pos'] <= min_allowed_pos:
                                blocker_idx = m
                                break
                            if mt['type'] == 'OPEN_BRK':
                                if not has_unpaired_close_paren(seg_outside_matched_imgs(mt['open_end'], chosen_pos)):
                                    blocker_idx = m
                                    break
                        candidate_earliers = [
                            e for e in cand_imgs[:-1]
                            if e > blocker_idx and tokens[e]['pos'] > min_allowed_pos
                        ]
                        if candidate_earliers:
                            first_surplus_cl = None
                            fs_depth = 0
                            for r in range(cl_idx + 1, n_tok):
                                if not active[r]:
                                    continue
                                rt = tokens[r]
                                if rt['type'] in ('OPEN_BRK', 'OPEN_IMG'):
                                    fs_depth += 1
                                elif rt['type'] in ('CLOSE_LINK', 'CLOSE_OTHER'):
                                    if fs_depth > 0:
                                        fs_depth -= 1
                                    elif rt['type'] == 'CLOSE_LINK' and rt['is_url']:
                                        first_surplus_cl = rt
                                        break
                            next_active_cl = first_surplus_cl
                            surplus_no_plain_base = cached_cl_surplus(include_ref=True, include_plain=False)
                            next_cl_is_diff_img = (
                                next_active_cl is not None
                                and is_likely_image_url(next_active_cl.get('url', ''))
                                and next_active_cl.get('url', '') != cl.get('url', '')
                            )
                            for earlier in candidate_earliers:
                                unclosed_brks = unclosed_enclosing_brks_before(earlier)
                                if not unclosed_brks:
                                    continue
                                if surplus_no_plain_base > len(unclosed_brks):
                                    continue
                                note_brks = [
                                    b for b in unclosed_brks
                                    if seg[tokens[b]['open_end']:tokens[earlier]['pos']].strip()
                                ]
                                if not note_brks:
                                    surplus_total = surplus_no_plain_base
                                else:
                                    surplus_total = cached_cl_surplus(
                                        include_ref=True,
                                        include_plain=True,
                                        max_plain=len(note_brks),
                                        require_immediate_plain=False,
                                    )
                                has_outer_closer = 0 < surplus_total <= len(unclosed_brks)
                                if not has_outer_closer:
                                    continue
                                # 不得跨过散文断句、非图注前缀中的未配对左括号或紧邻空图 `![![s](s.png)]` 从合法内层图 `chosen_img` 抢夺 URL。
                                lead_between = seg_outside_matched_imgs(tokens[earlier]['open_end'], chosen_pos)
                                if not lead_between.strip() \
                                        or img_lead_has_prose_break(lead_between) \
                                        or (has_unpaired_open_paren(lead_between) and not caption_prefix_re.match(lead_between)):
                                    continue
                                # 若首个多余闭合符是指向不同图片资源的显式图片 URL（归属 `earlier` 自身，如
                                # `[![Fig 1: ![sub](s.png)](f5.png) ...]` 或 `[![Fig 1: ![sub](s.png) [0, 1) range](doc)](f1.png)`），
                                # 不得抢夺合法内层图 `chosen_img` 的闭合符（同 URL 点击放大链图 `[![...FALL: ![e me](f1.png)](f1.png)` 仍正常修复）。
                                if next_cl_is_diff_img:
                                    continue
                                if len(note_brks) == len(unclosed_brks) and next_active_cl is not None:
                                    surplus_plain_only = cached_cl_surplus(
                                        include_ref=False,
                                        include_plain=True,
                                        max_plain=len(note_brks),
                                        require_immediate_plain=False,
                                    )
                                    if surplus_plain_only <= cached_cl_surplus(include_ref=False, include_plain=False):
                                        continue
                                blocked_between = False
                                skip_plain_close = set()
                                for m in range(earlier + 1, chosen_img):
                                    if not active[m] or m in skip_plain_close:
                                        continue
                                    mt = tokens[m]
                                    if mt['type'] == 'OPEN_IMG' and m in clean_plain_close_idx \
                                            and clean_plain_close_idx[m] < chosen_img:
                                        skip_plain_close.add(clean_plain_close_idx[m])
                                        continue
                                    if mt['type'] == 'OPEN_BRK':
                                        if not has_unpaired_close_paren(seg_outside_matched_imgs(mt['open_end'], chosen_pos)):
                                            blocked_between = True
                                            break
                                    elif mt['type'] == 'CLOSE_OTHER' or (mt['type'] == 'CLOSE_LINK' and not mt['is_url']):
                                        if (mt['type'] == 'CLOSE_OTHER' and mt['subkind'] == 'empty_paren') \
                                                or (mt['type'] == 'CLOSE_LINK' and not mt['is_url'] and mt.get('url', '') == ''):
                                            continue
                                        if not is_math_interval_close(tokens[earlier]['open_end'], mt, 'OPEN_IMG'):
                                            blocked_between = True
                                            break
                                if not blocked_between:
                                    chosen_img = earlier
                                    break
                    matched_imgs.append((tokens[chosen_img], cl))
                    matched_img_spans.append((tokens[chosen_img]['pos'], cl['dest_end']))
                    _bisect.insort(step2_masked_spans, (tokens[chosen_img]['pos'], cl['dest_end'] + 1))
                    if step2_unpaired_paren_cache:
                        _ms_new, _me_new = tokens[chosen_img]['pos'], cl['dest_end'] + 1
                        step2_unpaired_paren_cache = {
                            bk: pp for bk, pp in step2_unpaired_paren_cache.items()
                            if not (_ms_new <= pp < _me_new)
                        }
                    for k in range(chosen_img, cl_idx + 1):
                        active[k] = False
                else:
                    # 无待配对图片：配对最右侧包裹已匹配图片（或无未配对 `)`）的外层链接 `[`（O(L) 逆向早停 + 缓存未配对 `)` 位置）
                    max_img_start_before_cl = -1
                    for _ms, _me in matched_img_spans:
                        if _me < cl_pos and _ms > max_img_start_before_cl:
                            max_img_start_before_cl = _ms
                    for _ms, _me in peeled_ref_img_spans:
                        if _me < cl_pos and _ms > max_img_start_before_cl:
                            max_img_start_before_cl = _ms
                    for _ms, _me in peeled_empty_img_spans:
                        if _me < cl_pos and _ms > max_img_start_before_cl:
                            max_img_start_before_cl = _ms
                    chosen_enclosing_brk = None
                    if max_img_start_before_cl >= 0:
                        for b in reversed(left_active):
                            if tokens[b]['type'] == 'OPEN_BRK' and tokens[b]['pos'] < max_img_start_before_cl:
                                chosen_enclosing_brk = b
                                break
                    if chosen_enclosing_brk is not None:
                        closed_img_link_spans.append((tokens[chosen_enclosing_brk]['pos'], cl['dest_end']))
                        for k in range(chosen_enclosing_brk, cl_idx + 1):
                            active[k] = False
                    else:
                        chosen_plain_brk = None
                        for b in reversed(left_active):
                            if tokens[b]['type'] != 'OPEN_BRK':
                                continue
                            cached_pp = step2_unpaired_paren_cache.get(b)
                            if cached_pp is not None and cached_pp < cl_pos:
                                continue
                            # Locate first unpaired ')' outside step2_masked_spans in [open_end, cl_pos)
                            b_start = tokens[b]['open_end']
                            p_depth = 0
                            first_unpaired_pos = None
                            cur_p = b_start
                            n_sp2 = len(step2_masked_spans)
                            idx_sp2 = 0
                            if n_sp2 > 8:
                                lo2, hi2 = 0, n_sp2
                                while lo2 < hi2:
                                    mid2 = (lo2 + hi2) // 2
                                    if step2_masked_spans[mid2][0] < b_start:
                                        lo2 = mid2 + 1
                                    else:
                                        hi2 = mid2
                                idx_sp2 = max(0, lo2 - 1)
                                while idx_sp2 > 0 and step2_masked_spans[idx_sp2 - 1][1] > b_start:
                                    idx_sp2 -= 1
                            while cur_p < cl_pos:
                                seg_end_p = cl_pos
                                while idx_sp2 < n_sp2 and step2_masked_spans[idx_sp2][1] <= cur_p:
                                    idx_sp2 += 1
                                if idx_sp2 < n_sp2 and step2_masked_spans[idx_sp2][0] < cl_pos:
                                    if step2_masked_spans[idx_sp2][0] <= cur_p:
                                        cur_p = max(cur_p, step2_masked_spans[idx_sp2][1])
                                        idx_sp2 += 1
                                        continue
                                    seg_end_p = step2_masked_spans[idx_sp2][0]
                                for ch_i in range(cur_p, seg_end_p):
                                    ch_c = seg[ch_i]
                                    if ch_c == '(':
                                        p_depth += 1
                                    elif ch_c == ')':
                                        if p_depth > 0:
                                            p_depth -= 1
                                        else:
                                            first_unpaired_pos = ch_i
                                            break
                                if first_unpaired_pos is not None:
                                    break
                                cur_p = seg_end_p
                            if first_unpaired_pos is not None:
                                step2_unpaired_paren_cache[b] = first_unpaired_pos
                                continue
                            chosen_plain_brk = b
                            break
                        if chosen_plain_brk is not None:
                            for k in range(chosen_plain_brk, cl_idx + 1):
                                active[k] = False

            if not matched_imgs:
                return [], []
            matched_imgs.sort(key=lambda pair: pair[0]['pos'])
            non_overlapping_imgs = []
            repair_groups = []
            pos = 0
            for op, cl in matched_imgs:
                if op['pos'] < pos:
                    continue
                non_overlapping_imgs.append((op, cl))
                raw_alt = seg[op['open_end']:cl['pos']]
                group_offs = collect_alt_escape_offsets(raw_alt, op['open_end'])
                if group_offs:
                    repair_groups.append((op['pos'], cl['dest_end'] + 1, cl.get('url', ''), group_offs))
                pos = cl['dest_end'] + 1
            return non_overlapping_imgs, repair_groups

        # 文档级扫描：使用与 conference_publication_gate 完全统一的 CommonMark 0.31.2 块与容器扫描器，
        # 按剥离引用块/列表容器前缀后的 inline_regions 逐段落扫描行内元素（支持引用块内多行原始 HTML、
        # 多行链接/图片标题与跨行代码 span），并将图注方括号转义与保护区间精确映射回原始偏移。
        from conference_publication_gate import (
            _is_valid_cm_label_text,
            _normalize_cm_link_label,
            _parse_cm_ref_label,
            _scan_commonmark_structure,
        )
        _ignored_blocks, inline_regions, ref_defs = _scan_commonmark_structure(text, include_ref_defs=True)
        raw_repair_groups = []

        for reg_id, region in enumerate(inline_regions):
            if not region:
                continue
            seg_parts = []
            orig_offsets = []
            for r_idx, (s_start, s_end) in enumerate(region):
                if r_idx > 0:
                    seg_parts.append('\n')
                    orig_offsets.append(region[r_idx - 1][1])
                seg_parts.append(text[s_start:s_end])
                orig_offsets.extend(range(s_start, s_end))
            orig_offsets.append(region[-1][1])
            seg = ''.join(seg_parts)
            seg_len = len(seg)

            tokens = []
            # Each stack entry:
            #   [tok_idx, kind, closed_pos, closed_kind, active, cond_gids, triggered_gids, hard_deactivated, had_skipped_close]
            # `cond_gids` / `triggered_gids` store deduplicated shared group IDs pointing into `cond_groups`
            # (`gid -> [rem_img_ids_set, orig_img_ids_frozenset, brk_entries_list, active_key]`),
            # eliminating O(N^3) set cloning across repeated inner links under nested `OPEN_BRK`/`OPEN_IMG`.
            open_stack = []
            tok_closed_spans = []
            tok_closed_with_imgs = []
            tok_all_nested_imgs = []
            tok_nested_close_tok_idxs = []
            tok_nested_prefix_max_open_tok = []
            tok_nested_open_pos_sorted = []
            tok_strict_real_img_max_open = -1
            tok_max_closed_img_link_open_tok = -1
            all_open_brk_pos = []
            cond_groups = {}
            cond_group_by_key = {}
            cond_trie = {}
            next_trie_node = 1
            img_propagated_below = set()
            img_triggered_set = set()
            img_to_cond_gids = {}
            next_cond_gid = 0

            def _insert_sorted_span(spans_list, span):
                if not spans_list or spans_list[-1][0] <= span[0]:
                    spans_list.append(span)
                else:
                    _bisect.insort(spans_list, span)

            def add_tok_closed_span(span):
                _insert_sorted_span(tok_closed_spans, span)
                _insert_sorted_span(tok_closed_with_imgs, span)

            def add_tok_closed_img_span(span):
                _insert_sorted_span(tok_closed_with_imgs, span)

            def record_nested_img(open_tok_idx, close_tok_idx, close_end, open_pos, *, is_strict_real=True, already_in_closed=False):
                nonlocal tok_strict_real_img_max_open
                if is_strict_real:
                    if open_pos > tok_strict_real_img_max_open:
                        tok_strict_real_img_max_open = open_pos
                    if not already_in_closed:
                        add_tok_closed_img_span((open_pos, close_end + 1))
                tok_all_nested_imgs.append((close_tok_idx, close_end, open_tok_idx, open_pos, is_strict_real))
                tok_nested_close_tok_idxs.append(close_tok_idx)
                prev_max_open = tok_nested_prefix_max_open_tok[-1] if tok_nested_prefix_max_open_tok else -1
                tok_nested_prefix_max_open_tok.append(open_tok_idx if open_tok_idx > prev_max_open else prev_max_open)
                pair = (open_pos, close_end)
                if not tok_nested_open_pos_sorted or tok_nested_open_pos_sorted[-1] <= pair:
                    tok_nested_open_pos_sorted.append(pair)
                else:
                    _bisect.insort(tok_nested_open_pos_sorted, pair)

            def has_nested_img_inside(open_tok_idx, limit_pos):
                idx_n = len(tok_all_nested_imgs) - 1
                while idx_n >= 0 and tok_all_nested_imgs[idx_n][0] > open_tok_idx:
                    if tok_all_nested_imgs[idx_n][1] < limit_pos:
                        return tok_all_nested_imgs[idx_n][1]
                    idx_n -= 1
                return -1

            def note_closed_brk_link(brk_open_tok_idx, link_close_pos):
                nonlocal tok_max_closed_img_link_open_tok
                if has_nested_img_inside(brk_open_tok_idx, link_close_pos) >= 0:
                    if brk_open_tok_idx > tok_max_closed_img_link_open_tok:
                        tok_max_closed_img_link_open_tok = brk_open_tok_idx

            def _tok_mask_from_spans(spans_list, start_p, end_p):
                if start_p >= end_p:
                    return ''
                if not spans_list:
                    return seg[start_p:end_p]
                parts = []
                cur = start_p
                idx_sp = 0
                if len(spans_list) > 8:
                    lo, hi = 0, len(spans_list)
                    while lo < hi:
                        mid = (lo + hi) // 2
                        if spans_list[mid][0] < start_p:
                            lo = mid + 1
                        else:
                            hi = mid
                    idx_sp = max(0, lo - 1)
                    while idx_sp > 0 and spans_list[idx_sp - 1][1] > start_p:
                        idx_sp -= 1
                n_sp = len(spans_list)
                while idx_sp < n_sp:
                    cs, ce = spans_list[idx_sp]
                    idx_sp += 1
                    if ce <= cur:
                        continue
                    if cs >= end_p:
                        break
                    if cs > cur:
                        parts.append(seg[cur:cs])
                    cur = max(cur, ce)
                if cur < end_p:
                    parts.append(seg[cur:end_p])
                return ''.join(parts)

            def tok_mask_closed(start_p, end_p):
                return _tok_mask_from_spans(tok_closed_spans, start_p, end_p)

            def tok_mask_with_imgs(start_p, end_p):
                return _tok_mask_from_spans(tok_closed_with_imgs, start_p, end_p)

            def _pos_in_tok_closed(p_val):
                if not tok_closed_spans:
                    return False
                lo, hi = 0, len(tok_closed_spans)
                while lo < hi:
                    mid = (lo + hi) // 2
                    if tok_closed_spans[mid][0] <= p_val:
                        lo = mid + 1
                    else:
                        hi = mid
                idx_c = lo - 1
                while idx_c >= 0 and tok_closed_spans[idx_c][1] > p_val:
                    if tok_closed_spans[idx_c][0] <= p_val < tok_closed_spans[idx_c][1]:
                        return True
                    idx_c -= 1
                return False

            def check_img_will_step2_wrap(img_s_idx, img_tok_idx, close_pos, close_url):
                nested_real_img_end = has_nested_img_inside(img_tok_idx, close_pos)
                if nested_real_img_end < 0:
                    return False, True
                if not is_likely_image_url(close_url):
                    return True, False
                if tok_max_closed_img_link_open_tok > img_tok_idx:
                    return True, False
                # Check unclosed OPEN_BRKs above img_s_idx on open_stack for clean ownership of a nested img
                # (bounded by next OPEN_BRK position matching Step 2 get_max_clean_owning_brk_pos).
                n_open_sorted = len(tok_nested_open_pos_sorted)
                n_all_brks = len(all_open_brk_pos)
                for j_ob in range(img_s_idx + 1, len(open_stack)):
                    ob_e = open_stack[j_ob]
                    if ob_e[1] == 'OPEN_BRK' and ob_e[2] is None:
                        bt_ob = tokens[ob_e[0]]
                        bp_ob = bt_ob['pos']
                        ni_b = _bisect.bisect_right(tok_nested_open_pos_sorted, (bp_ob, seg_len + 1))
                        while ni_b < n_open_sorted and tok_nested_open_pos_sorted[ni_b][1] >= close_pos:
                            ni_b += 1
                        if ni_b < n_open_sorted:
                            first_ms_ob = tok_nested_open_pos_sorted[ni_b][0]
                            bi_nxt = _bisect.bisect_right(all_open_brk_pos, bp_ob)
                            nxt_brk_pos = all_open_brk_pos[bi_nxt] if bi_nxt < n_all_brks else close_pos
                            slice_end_ob = first_ms_ob if first_ms_ob < nxt_brk_pos else nxt_brk_pos
                            bsl_ob = tok_mask_closed(bt_ob['open_end'], slice_end_ob)
                            if not has_unpaired_close_paren(bsl_ob) and not is_half_open_interval_text(bsl_ob):
                                return True, False
                tail_after_n = tok_mask_closed(nested_real_img_end + 1, close_pos)
                if ('(' not in tail_after_n and ')' not in tail_after_n) \
                        or tail_conj_prefix_re.match(tail_after_n.strip()):
                    return True, False
                has_tail_open = has_unpaired_open_paren(tail_after_n)
                has_tail_close = has_unpaired_close_paren(tail_after_n)
                if not has_tail_open and not has_tail_close:
                    return True, False
                lo_t, hi_t = img_tok_idx + 1, len(tokens)
                while lo_t < hi_t:
                    mid_t = (lo_t + hi_t) // 2
                    if tokens[mid_t]['pos'] <= nested_real_img_end:
                        lo_t = mid_t + 1
                    else:
                        hi_t = mid_t
                has_active_tail_brk = False
                has_active_tail_other = False
                for ti_t in range(lo_t, len(tokens)):
                    pt_t = tokens[ti_t]
                    pt_type_t = pt_t['type']
                    if has_tail_close and not has_active_tail_brk and pt_type_t == 'OPEN_BRK':
                        if not _pos_in_tok_closed(pt_t['pos']):
                            has_active_tail_brk = True
                            if not has_tail_open or has_active_tail_other:
                                break
                    elif has_tail_open and not has_active_tail_other and pt_type_t == 'CLOSE_OTHER':
                        if not _pos_in_tok_closed(pt_t['pos']):
                            has_active_tail_other = True
                            if not has_tail_close or has_active_tail_brk:
                                break
                if not ((has_tail_close and has_active_tail_brk) or (has_tail_open and has_active_tail_other)):
                    return True, False
                lead_outer_txt = tok_mask_with_imgs(tokens[img_tok_idx]['open_end'], close_pos)
                if img_lead_has_prose_break(lead_outer_txt):
                    return True, False
                return True, True

            def deactivate_lower_brks(below_idx, *, conditional_below_open_img=True):
                nonlocal next_cond_gid, next_trie_node
                shielding_imgs = []
                trie_node = 0
                cur_gid = None
                for j in range(below_idx - 1, -1, -1):
                    entry = open_stack[j]
                    if entry[1] == 'OPEN_IMG' and entry[2] is None:
                        if conditional_below_open_img:
                            im_tok_id = entry[0]
                            if im_tok_id in img_triggered_set:
                                continue
                            if im_tok_id in img_propagated_below:
                                break
                            if not shielding_imgs:
                                img_propagated_below.add(im_tok_id)
                            shielding_imgs.append(im_tok_id)
                            t_key = (trie_node, im_tok_id)
                            nxt_node = cond_trie.get(t_key)
                            if nxt_node is None:
                                nxt_node = next_trie_node
                                next_trie_node += 1
                                cond_trie[t_key] = nxt_node
                            trie_node = nxt_node
                            cur_gid = None
                        continue
                    if entry[1] == 'OPEN_BRK' and entry[2] is None:
                        if shielding_imgs:
                            if cur_gid is None:
                                cur_gid = cond_group_by_key.get(trie_node)
                                if cur_gid is None:
                                    cur_gid = next_cond_gid
                                    next_cond_gid += 1
                                    orig_fs = frozenset(shielding_imgs)
                                    cond_groups[cur_gid] = [set(shielding_imgs), orig_fs, [], trie_node]
                                    cond_group_by_key[trie_node] = cur_gid
                                    for im_id in orig_fs:
                                        img_to_cond_gids.setdefault(im_id, set()).add(cur_gid)
                            if cur_gid not in entry[5] and cur_gid not in entry[6]:
                                entry[5].add(cur_gid)
                                cond_groups[cur_gid][2].append(entry)
                        else:
                            entry[4] = False
                            entry[7] = True

            def trigger_cond_deactivation_for_img(img_tok_idx):
                img_triggered_set.add(img_tok_idx)
                img_propagated_below.discard(img_tok_idx)
                gids = img_to_cond_gids.get(img_tok_idx)
                if not gids:
                    return
                for gid in list(gids):
                    grp = cond_groups.get(gid)
                    if grp is None:
                        continue
                    rem, _orig, brks, key = grp
                    if key is not None:
                        cond_group_by_key.pop(key, None)
                        grp[3] = None
                    rem.discard(img_tok_idx)
                    if not rem:
                        for entry in brks:
                            if gid in entry[5]:
                                entry[5].discard(gid)
                                entry[6].add(gid)
                                entry[4] = False

            def cancel_cond_deactivation_for_img(img_tok_idx):
                img_propagated_below.discard(img_tok_idx)
                gids = img_to_cond_gids.pop(img_tok_idx, None)
                if not gids:
                    return
                for gid in list(gids):
                    grp = cond_groups.pop(gid, None)
                    if grp is None:
                        continue
                    _rem, orig, brks, key = grp
                    if key is not None:
                        cond_group_by_key.pop(key, None)
                    for other_im in orig:
                        if other_im != img_tok_idx:
                            s_other = img_to_cond_gids.get(other_im)
                            if s_other is not None:
                                s_other.discard(gid)
                    for entry in brks:
                        entry[5].discard(gid)
                        entry[6].discard(gid)
                        if not entry[7] and not entry[6]:
                            entry[4] = True

            def has_outer_closer_after(dest_end, s_idx, target_img_tok_idx):
                if dest_end is None:
                    return False
                top_tok_local = tokens[open_stack[s_idx][0]]
                is_note_wrapper = bool(seg[top_tok_local['open_end']:tokens[target_img_tok_idx]['pos']].strip())
                outer_can_be_link = (
                    not open_stack[s_idx][7]
                    and not any(target_img_tok_idx not in cond_groups[gid][1] for gid in open_stack[s_idx][6])
                )
                k = dest_end + 1
                mini_opens = []
                while k < seg_len:
                    c = seg[k]
                    if c == '\\' and k + 1 < seg_len and seg[k + 1] != '\n':
                        k += 2
                        continue
                    if c == '`':
                        span_e = match_code_span(seg, k, seg_len)
                        if span_e is not None:
                            k = span_e
                            continue
                        while k < seg_len and seg[k] == '`':
                            k += 1
                        continue
                    if c == '<':
                        raw_m = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE.match(seg, k, seg_len)
                        if raw_m:
                            k = raw_m.end()
                            continue
                    if c == '!' and k + 1 < seg_len and seg[k + 1] == '[':
                        mini_opens.append(('IMG', k, k + 2))
                        k += 2
                        continue
                    if c == '[':
                        mini_opens.append(('BRK', k, k + 1))
                        k += 1
                        continue
                    if c == ']':
                        next_is_inline_link = False
                        if k + 1 < seg_len and seg[k + 1] == '(':
                            ws_chk = skip_ws_with_one_nl(seg, k + 2, seg_len)
                            if (ws_chk < seg_len and seg[ws_chk] == ')') \
                                    or parse_link_dest(seg, k + 1, seg_len, allow_empty_angle=True) is not None:
                                next_is_inline_link = True
                        next_is_ref_link = False
                        if not next_is_inline_link and k + 1 < seg_len and seg[k + 1] == '[':
                            pr_chk = _parse_cm_ref_label(seg, k + 1, seg_len)
                            if pr_chk is not None and (pr_chk[1] == '' or bool(_normalize_cm_link_label(pr_chk[1]))):
                                next_is_ref_link = True
                        has_img_in_mini = any(m[0] == 'IMG' for m in mini_opens)
                        next_p = k
                        while mini_opens and mini_opens[-1][0] == 'BRK':
                            slice_t = seg[mini_opens[-1][2]:next_p]
                            if next_is_inline_link or next_is_ref_link:
                                # 无内层 IMG 时，独立的 `[0, 1)](a)` / `[0, 1) range][ref]` 是外层 `[` 内的独立链接，
                                # 不得将其展开回外层 `[`。
                                if has_img_in_mini and slice_t.rstrip().endswith(')') and is_half_open_interval_text(slice_t):
                                    next_p = mini_opens[-1][1]
                                    mini_opens.pop()
                                else:
                                    break
                            elif (is_half_open_interval_text(slice_t) or has_unpaired_close_paren(slice_t)) \
                                    and (slice_t.rstrip().endswith(')') or not is_note_wrapper):
                                next_p = mini_opens[-1][1]
                                mini_opens.pop()
                            else:
                                break
                        if mini_opens:
                            if k + 1 < seg_len and seg[k + 1] == '(':
                                ws_e = skip_ws_with_one_nl(seg, k + 2, seg_len)
                                if ws_e < seg_len and seg[ws_e] == ')':
                                    if mini_opens[-1][0] == 'BRK':
                                        if not any(m[0] == 'IMG' for m in mini_opens[:-1]):
                                            outer_can_be_link = False
                                        mini_opens.pop()
                                    elif not has_unpaired_open_paren(seg[mini_opens[-1][2]:k]):
                                        mini_opens.pop()
                                    k = ws_e + 1
                                    continue
                                pd = parse_link_dest(seg, k + 1, seg_len, allow_empty_angle=True)
                                if pd is not None:
                                    if mini_opens[-1][0] == 'BRK':
                                        if not any(m[0] == 'IMG' for m in mini_opens[:-1]):
                                            outer_can_be_link = False
                                        mini_opens.pop()
                                    elif (bool(pd[1]) and is_url_like(pd[1], pd[2])) \
                                            or not has_unpaired_open_paren(seg[mini_opens[-1][2]:k]):
                                        mini_opens.pop()
                                    k = pd[0] + 1
                                    continue
                            if ref_defs and mini_opens[-1][0] in ('BRK', 'IMG'):
                                ref_resolved_end = None
                                shortcut_blocked = False
                                if k + 1 < seg_len and seg[k + 1] == '[':
                                    pr = _parse_cm_ref_label(seg, k + 1, seg_len)
                                    if pr is not None:
                                        rc, rr = pr
                                        shortcut_blocked = (rr == '' or bool(_normalize_cm_link_label(rr)))
                                        if rr == '':
                                            inner_r = seg[mini_opens[-1][2]:k]
                                            if _is_valid_cm_label_text(inner_r) and _normalize_cm_link_label(inner_r) in ref_defs:
                                                ref_resolved_end = rc
                                        elif _normalize_cm_link_label(rr) in ref_defs:
                                            ref_resolved_end = rc
                                if ref_resolved_end is None and not shortcut_blocked:
                                    inner_r = seg[mini_opens[-1][2]:k]
                                    if _is_valid_cm_label_text(inner_r) and _normalize_cm_link_label(inner_r) in ref_defs:
                                        ref_resolved_end = k
                                if ref_resolved_end is not None:
                                    if mini_opens[-1][0] == 'BRK' and not any(m[0] == 'IMG' for m in mini_opens[:-1]):
                                        outer_can_be_link = False
                                    mini_opens.pop()
                                    k = ref_resolved_end + 1
                                    continue
                            if mini_opens[-1][0] == 'BRK' or not has_unpaired_open_paren(seg[mini_opens[-1][2]:k]):
                                mini_opens.pop()
                            k += 1
                            continue
                        if k + 1 < seg_len and seg[k + 1] == '(':
                            if not outer_can_be_link:
                                return bool(is_note_wrapper and not seg[dest_end + 1:k].strip())
                            pd = parse_link_dest(seg, k + 1, seg_len, allow_empty_angle=True)
                            if pd is not None and bool(pd[1]) and is_url_like(pd[1], pd[2]):
                                return True
                            return False
                        if k + 1 < seg_len and seg[k + 1] == '[':
                            pr_outer = _parse_cm_ref_label(seg, k + 1, seg_len)
                            if pr_outer is not None and (pr_outer[1] == '' or bool(_normalize_cm_link_label(pr_outer[1]))):
                                if not outer_can_be_link:
                                    return bool(is_note_wrapper and not seg[dest_end + 1:k].strip())
                                return True
                        if is_note_wrapper:
                            return True
                        return False
                    k += 1
                return False

            def find_reparable_closed_img_above(s_idx, close_pos, dest_url, dest_end):
                has_closed_img_above = any(
                    open_stack[j][1] == 'OPEN_IMG' and open_stack[j][2] is not None
                    for j in range(s_idx + 1, len(open_stack))
                )
                if not has_closed_img_above:
                    return None
                top_tok_local = tokens[open_stack[s_idx][0]]
                closed_img_top = (
                    open_stack[-1]
                    if (
                        s_idx + 1 < len(open_stack)
                        and open_stack[-1][1] == 'OPEN_IMG'
                        and open_stack[-1][2] is not None
                    )
                    else None
                )
                target_img_tok_idx = None
                if closed_img_top is not None:
                    after_closed_txt = tok_mask_closed(closed_img_top[2] + 1, close_pos)
                    after_closed_balanced = (
                        not has_unpaired_close_paren(after_closed_txt)
                        and not has_unpaired_open_paren(after_closed_txt)
                    )
                    has_caption_after_closed_img = bool(after_closed_txt.strip()) and after_closed_balanced
                    is_unresolved_ref_closed_img = closed_img_top[3] == 'ref_close'
                    is_url_closed_img = closed_img_top[3] == 'url_close'
                    if is_url_closed_img and (is_likely_image_url(dest_url) or has_caption_after_closed_img):
                        target_img_tok_idx = closed_img_top[0]
                    elif (
                        tok_strict_real_img_max_open <= tokens[closed_img_top[0]]['pos']
                        and (
                            has_caption_after_closed_img
                            or (
                                is_likely_image_url(dest_url)
                                and is_unresolved_ref_closed_img
                                and after_closed_balanced
                            )
                        )
                    ):
                        target_img_tok_idx = closed_img_top[0]
                if target_img_tok_idx is None:
                    imm_after_txt = (
                        tok_mask_closed(open_stack[s_idx + 1][2] + 1, close_pos)
                        if (s_idx + 1 < len(open_stack) and open_stack[s_idx + 1][2] is not None)
                        else ''
                    )
                    is_immediate_closed_img = (
                        s_idx + 1 < len(open_stack)
                        and open_stack[s_idx + 1][1] == 'OPEN_IMG'
                        and open_stack[s_idx + 1][2] is not None
                        and tokens[open_stack[s_idx + 1][0]]['pos'] == top_tok_local['open_end']
                        and bool(imm_after_txt.strip())
                        and not has_unpaired_close_paren(imm_after_txt)
                        and not has_unpaired_open_paren(imm_after_txt)
                        and (
                            open_stack[s_idx + 1][3] in ('url_close', 'url_close_prose')
                            or tok_strict_real_img_max_open <= tokens[open_stack[s_idx + 1][0]]['pos']
                        )
                    )
                    if is_immediate_closed_img:
                        target_img_tok_idx = open_stack[s_idx + 1][0]
                if target_img_tok_idx is None:
                    return None
                if not has_outer_closer_after(dest_end, s_idx, target_img_tok_idx):
                    return None
                return target_img_tok_idx

            i = 0
            while i < seg_len:
                ch = seg[i]
                if ch == '\\' and i + 1 < seg_len and seg[i + 1] != '\n':
                    i += 2
                    continue
                if ch == '`':
                    tick_end = i + 1
                    while tick_end < seg_len and seg[tick_end] == '`':
                        tick_end += 1
                    span_end = match_code_span(seg, i, seg_len)
                    if span_end is not None:
                        i = span_end
                        continue
                    i = tick_end
                    continue
                if ch == '<':
                    raw_match = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE.match(seg, i, seg_len)
                    if raw_match:
                        i = raw_match.end()
                        continue
                if ch == '!' and i + 1 < seg_len and seg[i + 1] == '[':
                    open_stack.append([len(tokens), 'OPEN_IMG', None, None, True, set(), set(), False, 0])
                    tokens.append({'type': 'OPEN_IMG', 'pos': i, 'open_end': i + 2})
                    i += 2
                    continue
                if ch == '[':
                    open_stack.append([len(tokens), 'OPEN_BRK', None, None, True, set(), set(), False, 0])
                    tokens.append({'type': 'OPEN_BRK', 'pos': i, 'open_end': i + 1})
                    all_open_brk_pos.append(i)
                    i += 1
                    continue
                if ch == ']':
                    top_unclosed_idx = next(
                        (s_idx for s_idx in range(len(open_stack) - 1, -1, -1) if open_stack[s_idx][2] is None),
                        None,
                    )
                    if top_unclosed_idx is not None and open_stack[top_unclosed_idx][1] == 'OPEN_BRK' \
                            and not open_stack[top_unclosed_idx][4]:
                        allow_deactivated_img_bypass = False
                        if i + 1 < seg_len and seg[i + 1] == '(':
                            peek_dest = parse_link_dest(seg, i + 1, seg_len, allow_empty_angle=True)
                            if peek_dest is not None and bool(peek_dest[1]) and is_url_like(peek_dest[1], peek_dest[2]):
                                if find_reparable_closed_img_above(top_unclosed_idx, i, peek_dest[1], peek_dest[0]) is not None:
                                    allow_deactivated_img_bypass = True
                                else:
                                    top_inner = tok_mask_closed(tokens[open_stack[top_unclosed_idx][0]]['open_end'], i)
                                    if is_half_open_interval_text(top_inner) or has_unpaired_close_paren(top_inner):
                                        probe = top_unclosed_idx - 1
                                        next_pos = tokens[open_stack[top_unclosed_idx][0]]['pos']
                                        while probe >= 0:
                                            if open_stack[probe][2] is not None:
                                                if open_stack[probe][1] == 'OPEN_IMG':
                                                    probe -= 1
                                                    continue
                                                break
                                            if open_stack[probe][1] == 'OPEN_BRK':
                                                sl_p = tok_mask_closed(tokens[open_stack[probe][0]]['open_end'], next_pos)
                                                if is_half_open_interval_text(sl_p) or has_unpaired_close_paren(sl_p):
                                                    next_pos = tokens[open_stack[probe][0]]['pos']
                                                    probe -= 1
                                                    continue
                                            break
                                        if (is_likely_image_url(peek_dest[1]) or top_inner.rstrip().endswith(')')) and not (
                                            probe >= 0 and open_stack[probe][2] is None
                                            and open_stack[probe][1] == 'OPEN_IMG'
                                        ):
                                            p2 = probe
                                            while p2 >= 0 and (
                                                (open_stack[p2][2] is not None and open_stack[p2][1] == 'OPEN_IMG')
                                                or (open_stack[p2][2] is None and open_stack[p2][1] == 'OPEN_BRK')
                                            ):
                                                p2 -= 1
                                            if p2 >= 0 and open_stack[p2][2] is None and open_stack[p2][1] == 'OPEN_IMG':
                                                img_lead_p2 = tok_mask_closed(
                                                    tokens[open_stack[p2][0]]['open_end'],
                                                    tokens[open_stack[top_unclosed_idx][0]]['pos'],
                                                )
                                                if not img_lead_has_prose_break(img_lead_p2):
                                                    probe = p2
                                        if probe >= 0 and open_stack[probe][2] is None \
                                                and open_stack[probe][1] == 'OPEN_IMG':
                                            if is_likely_image_url(peek_dest[1]):
                                                allow_deactivated_img_bypass = True
                                            else:
                                                img_lead_raw = tok_mask_closed(
                                                    tokens[open_stack[probe][0]]['open_end'],
                                                    tokens[open_stack[top_unclosed_idx][0]]['pos'],
                                                )
                                                if not img_lead_has_prose_break(img_lead_raw):
                                                    allow_deactivated_img_bypass = True
                        if not allow_deactivated_img_bypass:
                            subkind = 'ref_close' if (i + 1 < seg_len and seg[i + 1] == '[') else 'plain_close'
                            popped_entries = open_stack[top_unclosed_idx:]
                            del open_stack[top_unclosed_idx:]
                            for e in popped_entries:
                                if e[1] == 'OPEN_IMG' and e[2] is None:
                                    trigger_cond_deactivation_for_img(e[0])
                            tokens.append({
                                'type': 'CLOSE_OTHER',
                                'subkind': subkind,
                                'pos': i,
                                'dest_end': i,
                            })
                            i += 1
                            continue
                    if open_stack and i + 1 < seg_len and seg[i + 1] == '(':
                        has_unclosed_open = top_unclosed_idx is not None
                        ws_end = skip_ws_with_one_nl(seg, i + 2, seg_len)
                        if ws_end < seg_len and seg[ws_end] == ')':
                            if has_unclosed_open:
                                s_idx = top_unclosed_idx
                                top_tok = tokens[open_stack[s_idx][0]]
                                if open_stack[s_idx][1] == 'OPEN_BRK' \
                                        or not has_unpaired_open_paren(tok_mask_closed(top_tok['open_end'], i)):
                                    if open_stack[s_idx][1] == 'OPEN_BRK':
                                        add_tok_closed_span((top_tok['pos'], ws_end + 1))
                                        deactivate_lower_brks(s_idx)
                                        del open_stack[s_idx:]
                                    else:
                                        open_stack[s_idx][2] = ws_end
                                        open_stack[s_idx][3] = 'empty_paren'
                                        trigger_cond_deactivation_for_img(open_stack[s_idx][0])
                                else:
                                    l_skip_ep = open_stack[s_idx][8]
                                    if l_skip_ep > 0:
                                        l_rem = l_skip_ep
                                        l_probe = s_idx
                                        l_skipped_img_ids = {open_stack[s_idx][0]}
                                        while l_probe is not None and l_rem > 0:
                                            l_rem -= 1
                                            l_probe = next(
                                                (k_s for k_s in range(l_probe - 1, -1, -1) if open_stack[k_s][2] is None),
                                                None,
                                            )
                                            if l_probe is not None and open_stack[l_probe][1] == 'OPEN_IMG' and open_stack[l_probe][8] > 0:
                                                l_rem += open_stack[l_probe][8]
                                                l_skipped_img_ids.add(open_stack[l_probe][0])
                                        if l_probe is not None and open_stack[l_probe][1] == 'OPEN_BRK':
                                            l_probe_active = (
                                                open_stack[l_probe][4]
                                                and not any(
                                                    not (cond_groups[gid][0] - l_skipped_img_ids)
                                                    for gid in open_stack[l_probe][5]
                                                )
                                            )
                                            if l_probe_active:
                                                add_tok_closed_span((tokens[open_stack[l_probe][0]]['pos'], ws_end + 1))
                                                deactivate_lower_brks(l_probe)
                                                del open_stack[l_probe:]
                                            else:
                                                popped_deact = open_stack[l_probe:]
                                                del open_stack[l_probe:]
                                                for e in popped_deact:
                                                    if e[1] == 'OPEN_IMG' and e[2] is None:
                                                        trigger_cond_deactivation_for_img(e[0])
                                                tokens.append({
                                                    'type': 'CLOSE_OTHER',
                                                    'subkind': 'plain_close',
                                                    'pos': i,
                                                    'dest_end': i,
                                                })
                                                i += 1
                                                continue
                                        else:
                                            open_stack[s_idx][8] += 1
                                    else:
                                        open_stack[s_idx][8] += 1
                            tokens.append({
                                'type': 'CLOSE_OTHER',
                                'subkind': 'empty_paren',
                                'pos': i,
                                'dest_end': ws_end,
                            })
                            i = ws_end + 1
                            continue
                        allow_dest_scan = has_unclosed_open
                        last_closed_pos = None
                        last_closed_kind = None
                        had_intervening_close = False
                        had_intervening_img_close_link = False
                        had_intervening_unmatched_close = False
                        if not allow_dest_scan:
                            last_closed_pos = open_stack[-1][2]
                            last_closed_kind = open_stack[-1][3]
                            scan_from = last_closed_pos + 1
                            for prev_tok in reversed(tokens):
                                if prev_tok['pos'] <= last_closed_pos:
                                    break
                                if prev_tok['type'] in ('CLOSE_OTHER', 'CLOSE_LINK'):
                                    had_intervening_close = True
                                    if prev_tok['type'] == 'CLOSE_LINK' and prev_tok.get('is_img_close'):
                                        had_intervening_img_close_link = True
                                    scan_from = max(scan_from, prev_tok['dest_end'] + 1)
                                    break
                            bal_after = 0
                            for aft_tok in tokens:
                                if aft_tok['pos'] <= last_closed_pos:
                                    continue
                                if aft_tok['type'] in ('OPEN_BRK', 'OPEN_IMG'):
                                    bal_after += 1
                                elif aft_tok['type'] in ('CLOSE_OTHER', 'CLOSE_LINK'):
                                    if bal_after > 0:
                                        bal_after -= 1
                                    elif aft_tok['type'] == 'CLOSE_OTHER':
                                        had_intervening_unmatched_close = True
                            allow_dest_scan = not has_unpaired_open_paren(tok_mask_closed(scan_from, i))
                        if allow_dest_scan:
                            parsed = parse_link_dest(seg, i + 1, seg_len, allow_empty_angle=True)
                            if parsed is not None:
                                dest_end, url, is_angle = parsed
                                url_flag = bool(url) and is_url_like(url, is_angle)
                                adj_to_prev_close = (
                                    bool(tokens)
                                    and tokens[-1]['type'] == 'CLOSE_OTHER'
                                    and not tokens[-1].get('resolved_ref')
                                    and i == tokens[-1]['dest_end'] + 1
                                )
                                adj_to_prev_nested_img = (
                                    bool(tokens)
                                    and tokens[-1]['type'] == 'CLOSE_LINK'
                                    and tokens[-1].get('is_url')
                                    and tokens[-1].get('is_img_close')
                                    and last_closed_pos is not None
                                    and tokens[-1]['pos'] > last_closed_pos
                                    and i == tokens[-1]['dest_end'] + 1
                                )
                                closed_img_dest_ok = (
                                    not has_unclosed_open
                                    and url_flag
                                    and (
                                        (
                                            last_closed_kind == 'url_close'
                                            and (
                                                (is_likely_image_url(url) and not had_intervening_unmatched_close)
                                                or adj_to_prev_close
                                                or adj_to_prev_nested_img
                                            )
                                        )
                                        or (
                                            last_closed_kind == 'url_close_prose'
                                            and not had_intervening_unmatched_close
                                        )
                                        or (
                                            last_closed_kind not in ('url_close', 'url_close_prose')
                                            and not had_intervening_img_close_link
                                            and (
                                                (last_closed_pos is not None and i == last_closed_pos + 1)
                                                or (
                                                    last_closed_kind not in ('ref_close', 'empty_paren')
                                                    and (not had_intervening_close or is_likely_image_url(url))
                                                )
                                                or (
                                                    last_closed_kind == 'empty_paren'
                                                    and adj_to_prev_close
                                                    and is_likely_image_url(url)
                                                )
                                            )
                                        )
                                    )
                                )
                                if has_unclosed_open or closed_img_dest_ok:
                                    closed_img_flag = False
                                    if has_unclosed_open:
                                        # 若栈顶存在被内层非图链接暂标为 `url_close` 的内层 `OPEN_IMG`
                                        #（如 `![Fig 9: ![Fig 1: [1) a](a) cap](f3.png)](outer.png)`），
                                        # 紧随其后的显式图片 URL 闭合符仅闭合该内层图，保留外层 `![Fig 9:`。
                                        if url_flag and open_stack[-1][1] == 'OPEN_IMG' \
                                                and open_stack[-1][2] is not None \
                                                and open_stack[-1][3] in ('url_close', 'url_close_prose') \
                                                and (is_likely_image_url(url) or seg[open_stack[-1][2] + 1:i].strip()):
                                            cancel_cond_deactivation_for_img(open_stack[-1][0])
                                            record_nested_img(
                                                open_stack[-1][0],
                                                len(tokens),
                                                dest_end,
                                                tokens[open_stack[-1][0]]['pos'],
                                                is_strict_real=True,
                                            )
                                            open_stack.pop()
                                            if open_stack and all(e[2] is not None and e[3] == 'empty_paren' for e in open_stack):
                                                open_stack.clear()
                                            closed_img_flag = True
                                        else:
                                            s_idx = top_unclosed_idx
                                            top_tok = tokens[open_stack[s_idx][0]]
                                            inner_txt = tok_mask_closed(top_tok['open_end'], i)
                                            if open_stack[s_idx][1] == 'OPEN_BRK' or url_flag or not has_unpaired_open_paren(inner_txt):
                                                pop_to = s_idx
                                                keep_empty_img_on_stack = False
                                                if open_stack[s_idx][1] == 'OPEN_IMG':
                                                    closed_img_flag = True
                                                    if url_flag:
                                                        # 若该外层图内包含已闭合的嵌套图（真实 URL 图或平衡引用图），
                                                        # 仅当满足 Step 2 完整包裹条件（图片 URL、无散文断句、无拥有嵌套图的内层外链 `[`、
                                                        # 非连词开头且尾部含活跃未闭合方括号/右括号）时取消条件失活，
                                                        # 否则按 CommonMark 触发外层 `[` 的条件失活。
                                                        has_nested_img_dir, will_step2_wrap_dir = check_img_will_step2_wrap(
                                                            s_idx, open_stack[s_idx][0], i, url
                                                        )
                                                        if has_nested_img_dir and not will_step2_wrap_dir:
                                                            trigger_cond_deactivation_for_img(open_stack[s_idx][0])
                                                        else:
                                                            cancel_cond_deactivation_for_img(open_stack[s_idx][0])
                                                            record_nested_img(
                                                                open_stack[s_idx][0],
                                                                len(tokens),
                                                                dest_end,
                                                                top_tok['pos'],
                                                                is_strict_real=True,
                                                            )
                                                    elif url == '':
                                                        open_stack[s_idx][2] = dest_end
                                                        open_stack[s_idx][3] = 'empty_paren'
                                                        trigger_cond_deactivation_for_img(open_stack[s_idx][0])
                                                        keep_empty_img_on_stack = True
                                                    else:
                                                        trigger_cond_deactivation_for_img(open_stack[s_idx][0])
                                                elif open_stack[s_idx][1] == 'OPEN_BRK':
                                                    reparable_img_tok_idx = (
                                                        find_reparable_closed_img_above(s_idx, i, url, dest_end)
                                                        if url_flag
                                                        else None
                                                    )
                                                    if reparable_img_tok_idx is not None:
                                                        cancel_cond_deactivation_for_img(reparable_img_tok_idx)
                                                        rep_limit_pos = tokens[reparable_img_tok_idx]['pos']
                                                        ni_rep = _bisect.bisect_left(tok_nested_close_tok_idxs, reparable_img_tok_idx) - 1
                                                        while ni_rep >= 0 and tok_all_nested_imgs[ni_rep][1] >= rep_limit_pos:
                                                            ni_rep -= 1
                                                        max_open_before_rep = (
                                                            tok_nested_prefix_max_open_tok[ni_rep] if ni_rep >= 0 else -1
                                                        )
                                                        for e_rem in open_stack[s_idx + 1:]:
                                                            if e_rem[1] == 'OPEN_IMG' and e_rem[0] != reparable_img_tok_idx \
                                                                    and e_rem[3] in ('url_close', 'url_close_prose'):
                                                                has_nested_img_before_rep = (
                                                                    e_rem[0] < reparable_img_tok_idx
                                                                    and max_open_before_rep > e_rem[0]
                                                                )
                                                                if has_nested_img_before_rep:
                                                                    trigger_cond_deactivation_for_img(e_rem[0])
                                                                else:
                                                                    cancel_cond_deactivation_for_img(e_rem[0])
                                                        pop_to = s_idx + 1
                                                    elif url_flag and (
                                                        is_half_open_interval_text(inner_txt)
                                                        or has_unpaired_close_paren(inner_txt)
                                                    ):
                                                        probe = s_idx - 1
                                                        next_pos = top_tok['pos']
                                                        while probe >= 0:
                                                            if open_stack[probe][2] is not None:
                                                                if open_stack[probe][1] == 'OPEN_IMG':
                                                                    probe -= 1
                                                                    continue
                                                                break
                                                            if open_stack[probe][1] == 'OPEN_BRK':
                                                                sl_p = tok_mask_closed(tokens[open_stack[probe][0]]['open_end'], next_pos)
                                                                if is_half_open_interval_text(sl_p) or has_unpaired_close_paren(sl_p):
                                                                    next_pos = tokens[open_stack[probe][0]]['pos']
                                                                    probe -= 1
                                                                    continue
                                                            break
                                                        # 若目标是图片 URL 或半开区间/右括号闭合且中间存在未闭合普通 `[x `（无散文断句）
                                                        # 或已闭合 `![FALL]`，Step 2 会将其连同区间一并转义并闭合外层 `OPEN_IMG`。
                                                        p2_unwound = False
                                                        if (is_likely_image_url(url) or inner_txt.rstrip().endswith(')')) and not (
                                                            probe >= 0 and open_stack[probe][2] is None
                                                            and open_stack[probe][1] == 'OPEN_IMG'
                                                        ):
                                                            p2 = probe
                                                            while p2 >= 0 and (
                                                                (open_stack[p2][2] is not None and open_stack[p2][1] == 'OPEN_IMG')
                                                                or (open_stack[p2][2] is None and open_stack[p2][1] == 'OPEN_BRK')
                                                            ):
                                                                p2 -= 1
                                                            if p2 >= 0 and open_stack[p2][2] is None and open_stack[p2][1] == 'OPEN_IMG':
                                                                img_lead_p2 = tok_mask_closed(tokens[open_stack[p2][0]]['open_end'], top_tok['pos'])
                                                                if not img_lead_has_prose_break(img_lead_p2) or (
                                                                    inner_txt.rstrip().endswith(')')
                                                                    and is_half_open_interval_text(inner_txt)
                                                                ):
                                                                    probe = p2
                                                                    p2_unwound = True
                                                        if probe >= 0 and open_stack[probe][2] is None \
                                                                and open_stack[probe][1] == 'OPEN_IMG':
                                                            if not is_likely_image_url(url) \
                                                                    and not (inner_txt.rstrip().endswith(')') and (is_half_open_interval_text(inner_txt) or p2_unwound)):
                                                                img_lead_raw = tok_mask_closed(tokens[open_stack[probe][0]]['open_end'], top_tok['pos'])
                                                                has_prose_brk = img_lead_has_prose_break(img_lead_raw)
                                                                add_tok_closed_span((top_tok['pos'], dest_end + 1))
                                                                note_closed_brk_link(open_stack[s_idx][0], i)
                                                                deactivate_lower_brks(
                                                                    s_idx,
                                                                    conditional_below_open_img=not has_prose_brk,
                                                                )
                                                                open_stack[probe][2] = dest_end
                                                                open_stack[probe][3] = 'url_close_prose' if has_prose_brk else 'url_close'
                                                                pop_to = probe + 1
                                                            else:
                                                                has_nested_img_uw, will_step2_wrap_uw = check_img_will_step2_wrap(
                                                                    probe, open_stack[probe][0], i, url
                                                                )
                                                                if has_nested_img_uw and not will_step2_wrap_uw:
                                                                    add_tok_closed_span((top_tok['pos'], dest_end + 1))
                                                                    note_closed_brk_link(open_stack[s_idx][0], i)
                                                                    deactivate_lower_brks(s_idx)
                                                                    trigger_cond_deactivation_for_img(open_stack[probe][0])
                                                                    pop_to = s_idx
                                                                else:
                                                                    closed_img_flag = True
                                                                    for e in open_stack[probe:]:
                                                                        if e[1] == 'OPEN_IMG':
                                                                            cancel_cond_deactivation_for_img(e[0])
                                                                    record_nested_img(
                                                                        open_stack[probe][0],
                                                                        len(tokens),
                                                                        dest_end,
                                                                        tokens[open_stack[probe][0]]['pos'],
                                                                        is_strict_real=True,
                                                                    )
                                                                    pop_to = probe
                                                        else:
                                                            add_tok_closed_span((top_tok['pos'], dest_end + 1))
                                                            note_closed_brk_link(open_stack[s_idx][0], i)
                                                            deactivate_lower_brks(s_idx)
                                                    else:
                                                        add_tok_closed_span((top_tok['pos'], dest_end + 1))
                                                        if url_flag:
                                                            note_closed_brk_link(open_stack[s_idx][0], i)
                                                        deactivate_lower_brks(s_idx)
                                                if not keep_empty_img_on_stack:
                                                    del open_stack[pop_to:]
                                                    if closed_img_flag and url_flag and open_stack and all(e[2] is not None and e[3] == 'empty_paren' for e in open_stack):
                                                        open_stack.clear()
                                            else:
                                                # 非 URL 闭合 `](not-url "...")` 若内层 OPEN_IMG 此前已跳过 `]`，
                                                # 按 CommonMark 消耗 skip_budget 闭合外层 `[outer` 链接，防止破坏合法链接标题；
                                                # 若外层 `[outer` 已被内层链接条件失活，则按 CommonMark 退化为普通 `]` 不吞噬标题。
                                                link_s_idx = s_idx
                                                l_skip = open_stack[link_s_idx][8]
                                                if l_skip > 0:
                                                    l_rem = l_skip
                                                    l_probe = link_s_idx
                                                    l_skipped_img_ids = {open_stack[link_s_idx][0]}
                                                    while l_probe is not None and l_rem > 0:
                                                        l_rem -= 1
                                                        l_probe = next(
                                                            (k_s for k_s in range(l_probe - 1, -1, -1) if open_stack[k_s][2] is None),
                                                            None,
                                                        )
                                                        if l_probe is not None and open_stack[l_probe][1] == 'OPEN_IMG' and open_stack[l_probe][8] > 0:
                                                            l_rem += open_stack[l_probe][8]
                                                            l_skipped_img_ids.add(open_stack[l_probe][0])
                                                    if l_probe is not None and open_stack[l_probe][1] == 'OPEN_BRK':
                                                        l_probe_active = (
                                                            open_stack[l_probe][4]
                                                            and not any(
                                                                not (cond_groups[gid][0] - l_skipped_img_ids)
                                                                for gid in open_stack[l_probe][5]
                                                            )
                                                        )
                                                        if l_probe_active:
                                                            add_tok_closed_span((tokens[open_stack[l_probe][0]]['pos'], dest_end + 1))
                                                            deactivate_lower_brks(l_probe)
                                                            del open_stack[l_probe:]
                                                        else:
                                                            popped_deact = open_stack[l_probe:]
                                                            del open_stack[l_probe:]
                                                            for e in popped_deact:
                                                                if e[1] == 'OPEN_IMG' and e[2] is None:
                                                                    trigger_cond_deactivation_for_img(e[0])
                                                            tokens.append({
                                                                'type': 'CLOSE_OTHER',
                                                                'subkind': 'plain_close',
                                                                'pos': i,
                                                                'dest_end': i,
                                                            })
                                                            i += 1
                                                            continue
                                                    else:
                                                        open_stack[s_idx][8] += 1
                                                else:
                                                    open_stack[s_idx][8] += 1
                                    else:
                                        closed_img_flag = True
                                        open_stack.clear()
                                    tokens.append({
                                        'type': 'CLOSE_LINK',
                                        'pos': i,
                                        'dest_end': dest_end,
                                        'url': url,
                                        'is_url': url_flag,
                                        'is_img_close': closed_img_flag,
                                    })
                                    i = dest_end + 1
                                    continue
                    if open_stack and open_stack[-1][1] == 'OPEN_IMG' \
                            and open_stack[-1][2] is not None \
                            and open_stack[-1][3] in ('url_close', 'url_close_prose'):
                        ref_s_idx = len(open_stack) - 1
                        skip_budget = 0
                        skipped_img_ids = set()
                    else:
                        ref_s_idx = top_unclosed_idx
                        skip_budget = 0
                        skipped_img_ids = set()
                        while ref_s_idx is not None:
                            if open_stack[ref_s_idx][1] == 'OPEN_IMG' and open_stack[ref_s_idx][8] > 0:
                                skip_budget += open_stack[ref_s_idx][8]
                                skipped_img_ids.add(open_stack[ref_s_idx][0])
                            if skip_budget > 0:
                                skip_budget -= 1
                                ref_s_idx = next(
                                    (k_s for k_s in range(ref_s_idx - 1, -1, -1) if open_stack[k_s][2] is None),
                                    None,
                                )
                                continue
                            break
                    ref_entry_active = (
                        ref_s_idx is not None
                        and open_stack[ref_s_idx][4]
                        and not (
                            open_stack[ref_s_idx][1] == 'OPEN_BRK'
                            and any(not (cond_groups[gid][0] - skipped_img_ids) for gid in open_stack[ref_s_idx][5])
                        )
                    )
                    if ref_defs and ref_entry_active:
                        s_idx = ref_s_idx
                        top_tok = tokens[open_stack[s_idx][0]]
                        ref_url = None
                        ref_end_idx = i
                        shortcut_blocked = False
                        if i + 1 < seg_len and seg[i + 1] == '[':
                            parsed_ref = _parse_cm_ref_label(seg, i + 1, seg_len)
                            if parsed_ref is not None:
                                ref_close, ref_raw = parsed_ref
                                shortcut_blocked = (ref_raw == '' or bool(_normalize_cm_link_label(ref_raw)))
                                if ref_raw == '':
                                    inner_raw = seg[top_tok['open_end']:i]
                                    if _is_valid_cm_label_text(inner_raw):
                                        norm_key = _normalize_cm_link_label(inner_raw)
                                        if norm_key in ref_defs:
                                            ref_url = ref_defs[norm_key]
                                            ref_end_idx = ref_close
                                else:
                                    norm_key = _normalize_cm_link_label(ref_raw)
                                    if norm_key and norm_key in ref_defs:
                                        ref_url = ref_defs[norm_key]
                                        ref_end_idx = ref_close
                        if ref_url is None and not shortcut_blocked:
                            inner_raw = seg[top_tok['open_end']:i]
                            if _is_valid_cm_label_text(inner_raw):
                                norm_key = _normalize_cm_link_label(inner_raw)
                                if norm_key in ref_defs:
                                    ref_url = ref_defs[norm_key]
                                    ref_end_idx = i
                        if ref_url is not None:
                            sub_k = 'ref_close' if ref_end_idx > i else 'plain_close'
                            ref_open_tok_idx = open_stack[s_idx][0]
                            popped_entries = open_stack[s_idx:]
                            add_tok_closed_span((top_tok['pos'], ref_end_idx + 1))
                            if open_stack[s_idx][1] == 'OPEN_BRK':
                                note_closed_brk_link(ref_open_tok_idx, i)
                                deactivate_lower_brks(s_idx)
                                del open_stack[s_idx:]
                            else:
                                record_nested_img(
                                    ref_open_tok_idx,
                                    len(tokens),
                                    ref_end_idx,
                                    top_tok['pos'],
                                    is_strict_real=True,
                                    already_in_closed=True,
                                )
                                trigger_cond_deactivation_for_img(ref_open_tok_idx)
                                del open_stack[s_idx:]
                            for e in popped_entries[1:]:
                                if e[1] == 'OPEN_IMG' and e[2] is None:
                                    trigger_cond_deactivation_for_img(e[0])
                            tokens.append({
                                'type': 'CLOSE_OTHER',
                                'subkind': sub_k,
                                'pos': i,
                                'dest_end': ref_end_idx,
                                'resolved_ref': True,
                                'ref_open_idx': ref_open_tok_idx,
                            })
                            i = ref_end_idx + 1
                            continue
                    subkind = 'ref_close' if (i + 1 < seg_len and seg[i + 1] == '[') else 'plain_close'
                    if top_unclosed_idx is not None:
                        s_idx = top_unclosed_idx
                        top_tok = tokens[open_stack[s_idx][0]]
                        img_other_txt = (
                            None
                            if open_stack[s_idx][1] == 'OPEN_BRK'
                            else tok_mask_closed(top_tok['open_end'], i)
                        )
                        if open_stack[s_idx][1] == 'OPEN_BRK' \
                                or not has_unpaired_open_paren(img_other_txt):
                            if open_stack[s_idx][1] == 'OPEN_BRK':
                                popped_pos = top_tok['pos']
                                popped_open_end = top_tok['open_end']
                                popped_entries = open_stack[s_idx:]
                                del open_stack[s_idx:]
                                # 若普通方括号 `[x]` 自身不含未配对括号且无嵌套链接，记入 `tok_closed_spans` 以与 Step 1 剥离对齐。
                                if subkind == 'plain_close' and len(popped_entries) == 1:
                                    plain_inner = tok_mask_closed(popped_open_end, i)
                                    if not has_unpaired_open_paren(plain_inner) and not has_unpaired_close_paren(plain_inner):
                                        add_tok_closed_span((popped_pos, i + 1))
                                for e in popped_entries:
                                    if e[1] == 'OPEN_IMG' and e[2] is None:
                                        trigger_cond_deactivation_for_img(e[0])
                                if subkind == 'plain_close' and open_stack \
                                        and open_stack[-1][1] == 'OPEN_IMG' \
                                        and open_stack[-1][3] == 'ref_close' \
                                        and open_stack[-1][2] + 1 == popped_pos:
                                    open_stack[-1][2] = i
                            elif subkind in ('plain_close', 'ref_close'):
                                open_stack[s_idx][2] = i
                                open_stack[s_idx][3] = subkind
                                if subkind == 'ref_close' and not has_unpaired_close_paren(img_other_txt):
                                    pr_im = _parse_cm_ref_label(seg, i + 1, seg_len)
                                    if pr_im is not None:
                                        record_nested_img(
                                            open_stack[s_idx][0],
                                            len(tokens),
                                            pr_im[0],
                                            top_tok['pos'],
                                            is_strict_real=False,
                                            already_in_closed=True,
                                        )
                                trigger_cond_deactivation_for_img(open_stack[s_idx][0])
                        else:
                            open_stack[s_idx][8] += 1
                    tokens.append({
                        'type': 'CLOSE_OTHER',
                        'subkind': subkind,
                        'pos': i,
                        'dest_end': i,
                    })
                    i += 1
                    continue
                i += 1

            matched_imgs, seg_repair_groups = escape_segment_image_alts(seg, tokens)
            for op_pos, cl_end, g_url, g_offs in seg_repair_groups:
                raw_repair_groups.append((
                    orig_offsets[op_pos],
                    orig_offsets[cl_end - 1] + 1,
                    g_url,
                    [orig_offsets[off] for off in g_offs],
                    reg_id,
                ))

        def is_hard_raw_html_or_autolink(raw_span_text):
            if raw_span_text.startswith(('<!--', '<?', '<!')):
                return True
            if '://' in raw_span_text or '@' in raw_span_text:
                return True
            if any(ch.isspace() for ch in raw_span_text):
                return True
            if re.search(r'\\[()\[\]]', raw_span_text):
                return True
            return False

        def analyze_commonmark_document(final_text):
            """Single-pass CommonMark 0.31.2 analyzer on `final_text`.
            Returns `(region_math_entries, non_alt_protected, hard_protected, top_level_images)`:
            - `region_math_entries`: list of `(buf, f_offsets, buf_hard_spans)` per inline region for exact
              blockquote/paragraph-safe TeX math rewriting;
            - `non_alt_protected`: document-offset spans that image alt escaping must never mutate
              (code/HTML blocks, link ref defs, code spans, raw HTML/autolinks, link/image dest+titles,
              and resolved ref-link labels);
            - `hard_protected`: original-document spans (`f_blocks`, code spans, raw HTML/autolinks, and
              inline `(dest "title")` bodies starting at `(`) that a repair group spanning across them must
              never mutate;
            - `top_level_images`: list of `(open_orig, end_orig, dest_url)` for parsed CommonMark images."""
            f_blocks, f_regions, f_ref_defs = _scan_commonmark_structure(final_text, include_ref_defs=True)
            non_alt_protected = [(bs, be) for bs, be, _bk in f_blocks]
            hard_protected = [(bs, be) for bs, be, _bk in f_blocks]
            code_spans = []
            region_math_entries = []
            raw_images = []
            for f_region in f_regions:
                if not f_region:
                    continue
                f_parts = []
                f_offsets = []
                for r_idx, (rs, re_off) in enumerate(f_region):
                    if r_idx > 0:
                        f_parts.append('\n')
                        f_offsets.append(f_region[r_idx - 1][1])
                    f_parts.append(final_text[rs:re_off])
                    f_offsets.extend(range(rs, re_off))
                buf = ''.join(f_parts)
                p_end = len(buf)
                buf_hard_spans = []
                delim_stack = []
                pos = 0
                while pos < p_end:
                    char = buf[pos]
                    if char == '\\' and pos + 1 < p_end and buf[pos + 1] in ascii_punctuation:
                        pos += 2
                        continue
                    if char == '`':
                        tick_end = pos + 1
                        while tick_end < p_end and buf[tick_end] == '`':
                            tick_end += 1
                        span_end = match_code_span(buf, pos, p_end)
                        if span_end is not None:
                            buf_hard_spans.append((pos, span_end))
                            span_orig = (f_offsets[pos], f_offsets[span_end - 1] + 1)
                            non_alt_protected.append(span_orig)
                            hard_protected.append(span_orig)
                            code_spans.append(span_orig)
                            pos = span_end
                            continue
                        pos = tick_end
                        continue
                    if char == '<':
                        raw_m = _COMMONMARK_AUTOLINK_OR_RAW_HTML_RE.match(buf, pos, p_end)
                        if raw_m:
                            raw_span_txt = buf[pos:raw_m.end()]
                            span_orig = (f_offsets[pos], f_offsets[raw_m.end() - 1] + 1)
                            non_alt_protected.append(span_orig)
                            hard_protected.append(span_orig)
                            if is_hard_raw_html_or_autolink(raw_span_txt):
                                buf_hard_spans.append((pos, raw_m.end()))
                            pos = raw_m.end()
                            continue
                    if char == '!' and pos + 1 < p_end and buf[pos + 1] == '[':
                        delim_stack.append(['img', pos, True])
                        pos += 2
                        continue
                    if char == '[':
                        delim_stack.append(['link', pos, True])
                        pos += 1
                        continue
                    if char == ']':
                        if not delim_stack:
                            pos += 1
                            continue
                        kind, open_pos, is_active = delim_stack.pop()
                        if not is_active:
                            pos += 1
                            continue
                        if pos + 1 < p_end and buf[pos + 1] == '(':
                            end_paren = None
                            dest_url = ''
                            ws_e = skip_ws_with_one_nl(buf, pos + 2, p_end)
                            if ws_e < p_end and buf[ws_e] == ')':
                                end_paren = ws_e
                            else:
                                parsed_d = parse_link_dest(buf, pos + 1, p_end, allow_empty_angle=True)
                                if parsed_d is not None:
                                    end_paren, dest_url, _is_ang = parsed_d
                            if end_paren is not None:
                                non_alt_protected.append((f_offsets[pos], f_offsets[end_paren] + 1))
                                hard_protected.append((f_offsets[pos + 1], f_offsets[end_paren] + 1))
                                if kind == 'img':
                                    buf_hard_spans.append((open_pos, end_paren + 1))
                                    raw_images.append((f_offsets[open_pos], f_offsets[end_paren] + 1, dest_url))
                                else:
                                    buf_hard_spans.append((pos, end_paren + 1))
                                    for entry in delim_stack:
                                        if entry[0] == 'link':
                                            entry[2] = False
                                pos = end_paren + 1
                                continue
                        if f_ref_defs:
                            open_end = open_pos + (2 if kind == 'img' else 1)
                            ref_url = None
                            ref_end_idx = pos
                            ref_style = None
                            shortcut_blocked = False
                            if pos + 1 < p_end and buf[pos + 1] == '[':
                                parsed_ref = _parse_cm_ref_label(buf, pos + 1, p_end)
                                if parsed_ref is not None:
                                    ref_close, ref_raw = parsed_ref
                                    shortcut_blocked = (ref_raw == '' or bool(_normalize_cm_link_label(ref_raw)))
                                    if ref_raw == '':
                                        inner_raw = buf[open_end:pos]
                                        if _is_valid_cm_label_text(inner_raw):
                                            norm_key = _normalize_cm_link_label(inner_raw)
                                            if norm_key in f_ref_defs:
                                                ref_url = f_ref_defs[norm_key]
                                                ref_end_idx = ref_close
                                                ref_style = 'collapsed'
                                    else:
                                        norm_key = _normalize_cm_link_label(ref_raw)
                                        if norm_key and norm_key in f_ref_defs:
                                            ref_url = f_ref_defs[norm_key]
                                            ref_end_idx = ref_close
                                            ref_style = 'full'
                            if ref_url is None and not shortcut_blocked:
                                inner_raw = buf[open_end:pos]
                                if _is_valid_cm_label_text(inner_raw):
                                    norm_key = _normalize_cm_link_label(inner_raw)
                                    if norm_key in f_ref_defs:
                                        ref_url = f_ref_defs[norm_key]
                                        ref_end_idx = pos
                                        ref_style = 'shortcut'
                            if ref_url is not None:
                                if kind == 'img':
                                    buf_hard_spans.append((open_pos, ref_end_idx + 1))
                                    non_alt_protected.append((f_offsets[pos], f_offsets[ref_end_idx] + 1))
                                    raw_images.append((f_offsets[open_pos], f_offsets[ref_end_idx] + 1, ref_url))
                                else:
                                    if ref_style == 'full':
                                        buf_hard_spans.append((pos, ref_end_idx + 1))
                                        non_alt_protected.append((f_offsets[pos], f_offsets[ref_end_idx] + 1))
                                    else:
                                        buf_hard_spans.append((open_pos, ref_end_idx + 1))
                                        non_alt_protected.append((f_offsets[open_pos], f_offsets[ref_end_idx] + 1))
                                    for entry in delim_stack:
                                        if entry[0] == 'link':
                                            entry[2] = False
                                pos = ref_end_idx + 1
                                continue
                        pos += 1
                        continue
                    pos += 1
                region_math_entries.append((buf, f_offsets, buf_hard_spans))
            # Keep top-level images (excluding nested images strictly contained in an outer image's alt text).
            raw_images.sort(key=lambda item: (item[0], -item[1]))
            top_level_images = []
            max_end = -1
            for im_s, im_e, im_url in raw_images:
                if im_e <= max_end:
                    continue
                top_level_images.append((im_s, im_e, im_url))
                max_end = max(max_end, im_e)
            return region_math_entries, non_alt_protected, hard_protected, top_level_images, code_spans

        def merge_spans_local(span_list):
            if not span_list:
                return []
            merged_out = []
            for s, e in sorted(span_list):
                if merged_out and s <= merged_out[-1][1]:
                    merged_out[-1] = (merged_out[-1][0], max(merged_out[-1][1], e))
                else:
                    merged_out.append((s, e))
            return merged_out

        def apply_inserts(src, positions):
            out = []
            last = 0
            for ins_pos in positions:
                out.append(src[last:ins_pos])
                out.append('\\')
                last = ins_pos
            out.append(src[last:])
            return ''.join(out)

        if not raw_repair_groups:
            math_entries, _prot, _hprot, _imgs, _cs = analyze_commonmark_document(text)
            return text, math_entries

        orig_math_entries, _orig_prot, orig_hard_prot, orig_images, orig_code_spans = analyze_commonmark_document(text)
        orig_hard_merged = merge_spans_local(orig_hard_prot)
        orig_hard_starts = [s for s, _e in orig_hard_merged]
        orig_nonempty_images = [(os, oe, ou) for os, oe, ou in orig_images if ou]
        active_groups = list(raw_repair_groups)
        for _verify_pass in range(len(active_groups) + 3):
            if not active_groups:
                return text, orig_math_entries
            insert_positions = sorted({p for _gs, _ge, _gu, g_offs, _gr in active_groups for p in g_offs})
            if not insert_positions:
                return text, orig_math_entries
            escaped_text = apply_inserts(text, insert_positions)
            math_entries, non_alt_prot, _final_hprot, final_images, final_code_spans = analyze_commonmark_document(escaped_text)
            prot_merged = merge_spans_local(non_alt_prot)
            prot_starts = [s for s, _e in prot_merged]
            final_code_span_set = set(final_code_spans)

            def in_protected(pos_val):
                pi = _bisect.bisect_right(prot_starts, pos_val) - 1
                return pi >= 0 and prot_merged[pi][0] <= pos_val < prot_merged[pi][1]

            def mutates_enclosed_orig_hard_prot(gs, ge, g_offs):
                for off in g_offs:
                    pi = _bisect.bisect_right(orig_hard_starts, off) - 1
                    if pi >= 0:
                        ps, pe = orig_hard_merged[pi]
                        if ps <= off < pe and gs <= ps and pe <= ge:
                            return True
                return False

            bad_group_indices = set()
            for gi, (gs, ge, _gu, g_offs, _gr) in enumerate(active_groups):
                if mutates_enclosed_orig_hard_prot(gs, ge, g_offs):
                    bad_group_indices.add(gi)
                    continue
                if any(in_protected(off + _bisect.bisect_left(insert_positions, off)) for off in g_offs):
                    bad_group_indices.add(gi)
                    continue
                new_gs = gs + _bisect.bisect_left(insert_positions, gs)
                new_ge = ge + _bisect.bisect_left(insert_positions, ge)
                if not any(fs <= new_gs and new_ge <= fe and bool(_fu) for fs, fe, _fu in final_images):
                    bad_group_indices.add(gi)
                    continue
            # 严禁某组修复破坏原文档中已合法存在的顶层非空图片（包含被其破坏的外层合法图片，
            # 以及与修复组无包含关系的左侧/右侧独立合法图片）。
            if not bad_group_indices and orig_nonempty_images:
                # 预计算所有活跃修复组在新文本中的映射范围与段落归属，避免跨段误伤早先段落的合法修复。
                group_mapped = [
                    (
                        gs + _bisect.bisect_left(insert_positions, gs),
                        ge + _bisect.bisect_left(insert_positions, ge),
                    )
                    for gs, ge, _gu, _g_offs, _gr in active_groups
                ]
                region_bounds = [
                    (reg[0][0], reg[-1][1]) if reg else (-1, -1)
                    for reg in inline_regions
                ]

                def orig_span_region_id(o_pos):
                    for r_id, (r_s, r_e) in enumerate(region_bounds):
                        if r_s <= o_pos < r_e:
                            return r_id
                    return -1

                for os, oe, _ou in orig_nonempty_images:
                    new_os = os + _bisect.bisect_left(insert_positions, os)
                    new_oe = oe + _bisect.bisect_left(insert_positions, oe)
                    if any(fs == new_os and fe == new_oe and bool(_fu) for fs, fe, _fu in final_images):
                        continue
                    # 合法外层断图修复（`gs <= os < ge`，涵盖外层图包裹嵌套图、修正外层图提前闭合、
                    # 或外层断图修复收束此前由内部字面 `![` 泄漏到外链 URL 的伪图）允许更新该原图。
                    if any(gs <= os < ge for gs, ge, _gu, _g_offs, _gr in active_groups):
                        continue
                    # 优先找出直接重叠或被吞噬它的 `final_images` 跨度所包含的修复组（如右侧修复解锁了外层吞噬），
                    # 绝不跨段把责任归咎到前文无关段落的合法修复上。
                    culprits = [
                        gi for gi, (gs, ge, _gu, _g_offs, _gr) in enumerate(active_groups)
                        if (os <= gs and ge <= oe) or (gs < oe and ge > os)
                    ]
                    if not culprits:
                        swallowing = [
                            (fs, fe) for fs, fe, fu in final_images
                            if bool(fu) and fs <= new_os and new_oe <= fe
                        ]
                        if swallowing:
                            sw_s, sw_e = swallowing[0]
                            in_swallow = [
                                gi for gi, (ngs, nge) in enumerate(group_mapped)
                                if ngs < sw_e and nge > sw_s
                            ]
                            sw_following = [gi for gi in in_swallow if active_groups[gi][0] >= oe]
                            if sw_following:
                                culprits = [sw_following[0]]
                            else:
                                sw_preceding = [gi for gi in in_swallow if active_groups[gi][1] <= os]
                                if sw_preceding:
                                    culprits = [sw_preceding[-1]]
                    if not culprits:
                        orig_rid = orig_span_region_id(os)
                        same_reg_indices = [
                            gi for gi, (_gs, _ge, _gu, _g_offs, gr) in enumerate(active_groups)
                            if orig_rid < 0 or gr == orig_rid
                        ]
                        preceding = [
                            gi for gi in same_reg_indices
                            if active_groups[gi][1] <= os
                        ]
                        if preceding:
                            culprits = [preceding[-1]]
                        else:
                            following = [
                                gi for gi in same_reg_indices
                                if active_groups[gi][0] >= oe
                            ]
                            if following:
                                culprits = [following[0]]
                    for gi in culprits:
                        bad_group_indices.add(gi)
            if not bad_group_indices:
                return escaped_text, math_entries
            active_groups = [g for gi, g in enumerate(active_groups) if gi not in bad_group_indices]
        return text, orig_math_entries

    markdown, region_math_entries = escape_markdown_image_alts(str(markdown))
    pattern = re.compile(r'(?<!\\)\\+\[([\s\S]*?)(\\+)\]|(?<!\\)\\+\(([\s\S]*?)(\\+)\)', re.DOTALL)

    def merge_spans(span_list):
        if not span_list:
            return []
        merged_out = []
        for s, e in sorted(span_list):
            if merged_out and s <= merged_out[-1][1]:
                merged_out[-1] = (merged_out[-1][0], max(merged_out[-1][1], e))
            else:
                merged_out.append((s, e))
        return merged_out

    edits = []
    for buf, f_offsets, buf_hard_spans in region_math_entries:
        merged_buf_hard = merge_spans(buf_hard_spans)
        slices = []
        cur = 0
        for hs, he in merged_buf_hard:
            if cur < hs:
                slices.append((cur, hs))
            cur = max(cur, he)
        if cur < len(buf):
            slices.append((cur, len(buf)))
        for sl_s, sl_e in slices:
            for m in pattern.finditer(buf, sl_s, sl_e):
                display, display_slashes, inline, inline_slashes = m.groups()
                if display is not None:
                    body_start, body_end = m.start(1), m.end(1)
                    close_slash_start = m.start(2)
                else:
                    body_start, body_end = m.start(3), m.end(3)
                    close_slash_start = m.start(4)
                open_delim_idx = body_start - 1
                close_delim_idx = m.end() - 1
                if open_delim_idx - m.start() > 1:
                    edits.append((f_offsets[m.start()], f_offsets[open_delim_idx], '\\'))
                for j in range(body_start, body_end):
                    ch = buf[j]
                    if ch == '<':
                        edits.append((f_offsets[j], f_offsets[j] + 1, r'\lt '))
                    elif ch == '>':
                        edits.append((f_offsets[j], f_offsets[j] + 1, r'\gt '))
                if close_delim_idx - close_slash_start > 1:
                    edits.append((f_offsets[close_slash_start], f_offsets[close_delim_idx], '\\'))

    if not edits:
        return fm_prefix + markdown
    edits.sort(key=lambda item: item[0])
    rebuilt = []
    pos = 0
    for es, ee, rep in edits:
        if es < pos:
            continue
        if pos < es:
            rebuilt.append(markdown[pos:es])
        rebuilt.append(rep)
        pos = ee
    if pos < len(markdown):
        rebuilt.append(markdown[pos:])
    return fm_prefix + ''.join(rebuilt)


def render_packet(packet):
    if 'aggregatePresentationBatch' in packet:
        if set(packet) != {'aggregatePresentationBatch'}:
            raise ValueError('汇总展示输入不能与论文页面或标签输入混用。')
        records = packet['aggregatePresentationBatch']
        if not isinstance(records, list) or not 1 <= len(records) <= 8:
            raise ValueError('汇总展示每批必须包含 1–8 篇已核验记录。')
        for record in records:
            if not isinstance(record, dict) or not isinstance(record.get('resources'), list):
                raise ValueError('汇总展示缺少已核验资源列表。')
            for resource in record['resources']:
                for field in ('originalUrl', 'finalUrl'):
                    public_https(resource.get(field), f'汇总资源 {field}')
        return {'readerPresentations': build_aggregate_reader_presentations(records)}
    if 'tagPresentationBatch' in packet:
        # A pure, batched display operation shares this existing Python bridge.
        # It emits no page/assets or publication eligibility and cannot bypass
        # the full source-bound paper rendering path below.
        if set(packet) != {'tagPresentationBatch'}:
            raise ValueError('标签批量展示输入不能与论文页面输入混用。')
        batch = packet['tagPresentationBatch']
        if not isinstance(batch, dict) or set(batch) != {'catalog', 'records'} \
                or not isinstance(batch['records'], list) \
                or not 1 <= len(batch['records']) <= 10000:
            raise ValueError('标签批量展示需要同一完整词表及非空有界的所选记录集合。')
        return {'tagPresentations': [
            render_tag_hierarchy_markdown(record, batch['catalog'])
            for record in batch['records']
        ], 'facetDisplayLabels': dict(FACET_DISPLAY_LABELS)}
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
            or capabilities not in (WEAK, FULL, PDF_VISUAL, PDF_VISUAL_TABLES):
        raise ValueError('会议论文的标签记录或来源能力记录无效，标签记录不属于当前论文，或来源能力不在允许范围内。')
    manifest = paper.get('analysisManifest')
    stage = ((manifest or {}).get('stages') or {}).get('apiReaderArticle') or {}
    plan, article, authors, resources = validate_reader_source_records(paper, manifest, stage, capabilities)
    publisher = load_publish_to_blog()
    article = publisher._apply_reader_display_fixes(
        publisher._add_reader_term_heading_spaces(article, plan)
    )
    article = publisher._normalize_api_reader_display_artifacts(article)
    article = publisher._project_bound_source_cell_math_display(article, plan)
    article = publisher._project_artifact_table_cell_tex_display(article, plan)
    if r'G.711 μ\mu-law' in article:
        article = publisher._project_source_quoted_codec_display(article, paper)
    article = normalize_repeated_bold_prefixes(article)
    assets = []
    if capabilities in (FULL, PDF_VISUAL, PDF_VISUAL_TABLES):
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
    article = publisher._collapse_mathjax_double_write(article)
    publisher._assert_rendered_tables_have_no_bare_tex(article)
    article = publisher._nest_reader_headings(article.strip(), minimum_level=3)
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
            or not has_scoring_audit_format(scoring_stage) \
            or scoring_stage.get('outputAnalysisSha256') != hashlib.sha256(analysis.encode()).hexdigest() \
            or not (load_publish_to_blog()._validate_local_source_scoring_replay(paper)
                    if scoring_stage.get('executionKind') in {'deterministic_source_resource_audit', 'deterministic_source_core_audit'}
                    else scoring_stability_is_resolved(scoring_stage)):
        raise ValueError('会议论文的分析正文、全文来源或评分审计记录不符合已登记的评分要求。')
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
    tag_catalog = packet.get('tagCatalog') if 'tagCatalog' in packet else load_tag_catalog()
    same_catalog = assignment.get('registryVersion') == tag_stage.get('registryVersion') \
        and assignment.get('registrySha256') == tag_stage.get('registrySha256')
    if not same_catalog:
        original = resolve_compatible_proof_catalog(tag_stage.get('registrySha256'), tag_catalog)
        if original is None:
            # Completed official conference records retain their original stage,
            # catalog and upgrade chain. Current page assignment is independent;
            # this does not relax global append-only compatibility or re-sign it.
            original = load_archived_tag_catalog(tag_stage.get('registrySha256'))
            if original is not None and tag_catalog == load_tag_catalog():
                from publish_common import _validate_tag_stage_record
                _validate_tag_stage_record(paper, manifest, paper_id,
                    original_registry_sha256=tag_stage.get('registrySha256'))
            else:
                original = None
        if original is not None and tag_stage.get('registryVersion') == tag_catalog_identity(original):
            # Only genuine archived bytes with an unchanged full prefix qualify.
            # Recompute the old prompt and both selections; never rewrite the
            # original stage/checkpoint or infer an approval from a new SHA.
            from tag_catalog import tag_prompt_text_sha256
            from utils import _validate_tag_selection
            parsed_tags = load_publish_to_blog().parse_analysis(analysis)
            old_selection = _validate_tag_selection(original, parsed_tags.get('tags'),
                parsed_tags.get('primaryTaskTag'), parsed_tags.get('primaryMethodTag'))
            new_selection = _validate_tag_selection(tag_catalog, parsed_tags.get('tags'),
                parsed_tags.get('primaryTaskTag'), parsed_tags.get('primaryMethodTag'))
            same_catalog = tag_stage.get('projectionSha256') == tag_prompt_text_sha256(
                original, tag_stage.get('projectionContract')) \
                and old_selection.get('valid') is True and new_selection.get('valid') is True \
                and all(old_selection.get(key) == new_selection.get(key)
                        for key in ('primaryTaskId', 'primaryMethodId', 'conceptIds'))
    if not is_supported_flat_tag_contract(assignment.get('flatCompatContract')) \
            or (tag_record['format'] == 'current' and not is_tag_stage_record_declaration(tag_contract)) \
            or not is_supported_tag_selection_contract(assignment.get('selectionContract')) \
            or not is_supported_tag_selection_contract(selection_contract) \
            or (tag_record['format'] != 'current' and 'selectionContract' in tag_stage
                and tag_stage['selectionContract'] != tag_contract) \
            or not same_catalog \
            or assignment.get('primaryTaskId') != tag_stage.get('primaryTaskId') \
            or assignment.get('primaryMethodId') != tag_stage.get('primaryMethodId') \
            or sorted(assignment.get('conceptIds') or []) != sorted(tag_stage.get('conceptIds') or []) \
            or tag_stage.get('status') not in {'complete', 'not_needed'}:
        raise ValueError('会议论文的标签选择记录与分析阶段记录的协议、词表或所选标签不一致，或标签阶段尚未完成。')
    if any(cid not in concepts for cid in ordered):
        raise ValueError('会议论文的标签记录中，部分主标签或已选概念没有对应的概念记录。')
    labels = [concepts[cid]['preferredLabel']['zh'] for cid in assignment.get('conceptIds', [])]
    tag_presentation = render_tag_hierarchy_markdown({
        'registryVersion': assignment['registryVersion'],
        'registrySha256': assignment['registrySha256'],
        'concepts': [{'id': cid, 'facet': concepts[cid]['facet'],
                      'label': concepts[cid]['preferredLabel']['zh']}
                     for cid in assignment['conceptIds']],
    }, tag_catalog)
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
            or not isinstance(publication, dict) \
            or not protocols.has_valid_header(publication, 'conference-official-publication'):
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
    presentation = build_reader_presentation(paper, plan=plan, resources=resources,
                                             publisher=publisher,
                                             authors=authors, exclude_resource_url=is_arxiv_url,
                                             source_text=packet.get('sourceText'),
                                             publication_evidence=packet.get('publicationEvidence'))
    workbench_parsed = dict(parsed)
    workbench_parsed['primaryTaskTag'] = '#' + concepts[assignment['primaryTaskId']]['preferredLabel']['zh']
    workbench_parsed['primaryMethodTag'] = '#' + concepts[assignment['primaryMethodId']]['preferredLabel']['zh']
    workbench = publisher.build_verified_conference_workbench_bundle(
        paper, packet['date'], paper_id=paper_id, publication=publication,
        reader_plan=plan, parsed=workbench_parsed, authors=authors)
    assets.extend({'path': relative.as_posix(), 'base64': base64.b64encode(raw).decode('ascii')}
                  for relative, raw in workbench['sidecars'].items())
    category = f'{conference["id"]} 论文'
    conference_name = str(conference.get('name') or conference.get('displayName') or conference['id']).strip()
    raw_doi = str(publication.get('doi') or paper.get('doi') or '').strip()
    valid_doi = raw_doi if raw_doi and re.fullmatch(r'10\.\d{4,9}/[A-Za-z0-9._;()/:+-]{2,160}', raw_doi) else ''
    raw_track = str(publication.get('track') or paper.get('conferenceTrack') or paper.get('track') or '').strip()
    valid_track = raw_track if raw_track and len(raw_track) <= 500 and not re.search(r'[\x00-\x1f\x7f]', raw_track) else ''
    plain_title = publisher.plain_title_for_publish(title)
    plain_one_sentence = publisher.plain_title_for_publish(one_sentence)
    lines = ['---', f'title: {json.dumps(plain_title, ensure_ascii=False)}', f'date: {packet["date"]}', 'draft: false',
             f'description: {json.dumps(plain_one_sentence, ensure_ascii=False)}',
             f'tags: {json.dumps(labels, ensure_ascii=False)}', f'categories: {json.dumps([category], ensure_ascii=False)}',
             'hiddenInHomeList: true',
             'paper_digest_pipeline_owned: true', 'paper_digest_page_type: paper',
             publisher._researcher_workbench_frontmatter(workbench).rstrip(),
             f'paper_digest_paper_id: {json.dumps(paper_id, ensure_ascii=False)}', 'paper_digest_source_kind: conference',
             f'paper_digest_conference_id: {json.dumps(conference["id"])}',
             f'paper_digest_conference_name: {json.dumps(conference_name, ensure_ascii=False)}',
             *([f'paper_digest_doi: {json.dumps(valid_doi, ensure_ascii=False)}',
                f'paper_digest_conference_doi: {json.dumps(valid_doi, ensure_ascii=False)}'] if valid_doi else []),
             f'paper_digest_conference_record_url: {json.dumps(record_url)}',
             f'paper_digest_conference_pdf_url: {json.dumps(pdf_url)}',
             f'paper_digest_api_reader_contract: "{plan["contract"]}"',
             *([f'paper_digest_api_reader_schema_fingerprint: "{plan["schemaFingerprint"]}"']
               if 'schemaFingerprint' in plan else []),
             f'paper_digest_api_reader_article_sha256: "{paper["apiReaderArticleSha256"]}"',
             f'paper_digest_api_reader_plan_sha256: "{paper["apiReaderPlanSha256"]}"',
             f'paper_digest_api_reader_source_binding_contract: "{plan["sourceBindingsContract"]}"',
             *([f'paper_digest_api_reader_source_binding_schema_fingerprint: "{plan["sourceBindingsSchemaFingerprint"]}"']
               if 'sourceBindingsSchemaFingerprint' in plan else []),
             f'paper_digest_api_reader_source_bindings_sha256: "{plan["sourceBindingsSha256"]}"',
             f'paper_digest_api_reader_source_table_count: {stage["tableBindingCount"]}',
             f'paper_digest_api_reader_source_formula_count: {stage["formulaBindingCount"]}',
             f'paper_digest_api_reader_structured_artifacts_sha256: "{stage["structuredArtifactsSha256"]}"',
             f'paper_digest_api_reader_author_identity_contract: "{paper["apiReaderAuthors"]["identity"]["contract"]}"',
             *([f'paper_digest_api_reader_author_identity_schema_fingerprint: "{paper["apiReaderAuthors"]["identity"]["schemaFingerprint"]}"']
               if 'schemaFingerprint' in paper['apiReaderAuthors']['identity'] else []),
             f'paper_digest_api_reader_author_identity_sha256: "{paper["apiReaderAuthors"]["identitySha256"]}"',
             f'paper_digest_api_reader_author_count: {len(authors)}',
             f'paper_digest_api_reader_resource_identity_contract: "{paper["apiReaderResources"]["contract"]}"',
             *([f'paper_digest_api_reader_resource_identity_schema_fingerprint: "{paper["apiReaderResources"]["schemaFingerprint"]}"']
               if 'schemaFingerprint' in paper['apiReaderResources'] else []),
             f'paper_digest_api_reader_resource_identity_sha256: "{paper["apiReaderResources"]["identitySha256"]}"',
             f'paper_digest_api_reader_resource_count: {len(resources)}',
             f'paper_digest_api_reader_decision_projection: "{publisher.API_READER_DECISION_PROJECTION_CONTRACT}"',
             f'paper_digest_api_reader_decision_projection_schema_fingerprint: "{publisher.API_READER_DECISION_PROJECTION_SCHEMA_FINGERPRINT}"',
             f'paper_digest_scoring_contract: "{paper["analysisManifest"]["stages"]["scoringAudit"]["scoringContract"]}"',
             *([f'paper_digest_scoring_schema_fingerprint: "{paper["analysisManifest"]["stages"]["scoringAudit"]["scoringSchemaFingerprint"]}"']
               if 'scoringSchemaFingerprint' in paper['analysisManifest']['stages']['scoringAudit'] else []),
             f'paper_digest_tags_contract: "{FLAT_TAG_CONTRACT}"',
             f'paper_digest_tags_schema_fingerprint: "{protocols.schema_fingerprint(FLAT_TAG_CONTRACT)}"',
             f'paper_digest_tags_selection_contract: "{assignment["selectionContract"]}"',
             f'paper_digest_tags_registry_version: "{assignment["registryVersion"]}"',
             f'paper_digest_tags_registry_sha256: "{assignment["registrySha256"]}"',
             'paper_digest_tags_concepts: ' + json.dumps([
                 {'id': cid, 'facet': concepts[cid]['facet'], 'label': concepts[cid]['preferredLabel']['zh']}
                 for cid in assignment['conceptIds']], ensure_ascii=False, separators=(',', ':'), sort_keys=True),
             f'paper_digest_primary_method: {json.dumps(concepts[assignment["primaryMethodId"]]["preferredLabel"]["zh"], ensure_ascii=False)}',
             f'paper_digest_conference_structure: {"pdf-visual-tables-v2" if capabilities == PDF_VISUAL_TABLES else "pdf-visual-quote-evidence-v1" if capabilities == PDF_VISUAL else "replayable-pdf-layout-v1" if capabilities == FULL else "weak-text-only-v1"}', '---', '',
             f'# 📄 {publisher.markdown_title_for_publish(reader_title)}', '', f'> 英文题目：*{publisher.markdown_title_for_publish(plain_title)}*', '',
             f'> 会议身份：`{paper_id}`',
             *([f'> DOI：`{valid_doi}`'] if valid_doi else []),
             *([f'> Track：{publisher.markdown_title_for_publish(valid_track)}'] if valid_track else []), '',
             ('> ⚠️ 来源为会议 PDF 提取的正文；表格、公式和论文图片均不可用，本文不会据此重建这些结构。' if capabilities == WEAK else ''),
             ('> ℹ️ 这是会议论文集中的短篇 PDF；正文较短，但分析使用封存的完整 PDF 文本，未降级为摘要。' if short_proceedings else ''),
             ('> 来源为官方会议 PDF；图片依据原页像素，表格数字依据原文引用。PDF 文字层不视为原始 TeX，未可靠恢复的结构不作推断。' if capabilities == PDF_VISUAL else ''),
             ('> 来源为官方会议 PDF（v2 增强抽取）；表格结构与图片依据原页抽取与像素核验，PDF 文字层不视为原始 TeX，未可靠恢复的结构不作推断。' if capabilities == PDF_VISUAL_TABLES else ''),
             ('> ✅ 来源为官方会议 PDF；表格和公式来自 PDF 抽取结果，论文图片依据原页像素。PDF 公式以原页区域图片展示，未冒称作者原始 TeX；未成功恢复的结构不作推断。' if capabilities == FULL else ''), '',
             f'> 会议来源：[官方记录]({record_url}) · [官方 PDF]({pdf_url})', '',
             tag_presentation.rstrip(), '', f'评分：{complete_score}', '',
             f'排名：{rank_bucket} | 文档类型：{document_type}', '', '## 👥 作者与机构', '']
    lines.extend([presentation['authorBlock']])
    implementation_specs_block = publisher._render_api_reader_implementation_specs(paper.get('apiReaderPlan'))
    specs_lines = (['## ⚙️ 关键实现与复现规格', '', implementation_specs_block, '']
                   if implementation_specs_block else [])
    metadata_lines = [
        f'- 评分：{complete_score}',
        f'- 排名：{rank_bucket} | 文档类型：{document_type}',
        f'- 会议身份：`{paper_id}`',
        f'- 会议来源：[官方记录]({record_url}) · [官方 PDF]({pdf_url})',
        *([f'- DOI：`{valid_doi}`'] if valid_doi else []),
        *([f'- Track：{publisher.markdown_title_for_publish(valid_track)}'] if valid_track else []),
    ]
    metadata_details = [
        '<details>',
        '<summary>📎 论文与评分元数据</summary>',
        '',
        *metadata_lines,
        '',
        '</details>',
        '',
    ]
    lines.extend(['', '## 📌 核心摘要', '', presentation['summary'], '', '## 🔗 开源与复现资源', '',
                  presentation['resourceBlock'], '', '## 🧭 深度解读', '', article.strip(), '',
                  *formula_lines,
                  *specs_lines,
                  *metadata_details,
                  '## ⚖️ 评分明细', '', presentation['scoringBlock'], ''])
    lines.extend(['---', '', f'[← 返回 {conference["id"]} 论文汇总]({packet["aggregateUrl"]})', ''])
    lines[-1:] = [hide_arxiv_links(line) for line in lines[-1:]]
    markdown = repair_formula_delimiters(hide_arxiv_links('\n'.join(lines)))
    return {'markdown': publisher.sanitize_markdown_for_publish(markdown), 'assets': assets}


def packet_bytes():
    arguments = sys.argv[1:]
    limit = 64 * 1024 * 1024 + 1
    if not arguments:
        return sys.stdin.buffer.read(limit)
    if len(arguments) != 2 or arguments[0] != '--packet-file':
        raise ValueError('usage: conference-page-render.py [--packet-file ABSOLUTE_PATH]')
    if not os.path.isabs(arguments[1]):
        raise ValueError('conference renderer packet file must be a regular non-symlink file')
    packet_path = os.path.abspath(arguments[1])
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    try:
        fd = os.open(packet_path, flags)
    except OSError as exc:
        raise ValueError('conference renderer packet file must be a regular non-symlink file') from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('conference renderer packet file must be a regular non-symlink file')
        if info.st_size > 64 * 1024 * 1024:
            raise ValueError('conference renderer packet exceeds 64 MiB')
        chunks = []
        total = 0
        while total < limit:
            chunk = os.read(fd, min(1024 * 1024, limit - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        return b''.join(chunks)
    finally:
        os.close(fd)


def main():
    require_external_runtime('conference-page-render.py')
    raw = packet_bytes()
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('conference renderer packet exceeds 64 MiB')
    packet = json.loads(raw.decode('utf-8'))
    try:
        with render_process_guard(render_budget_seconds(packet, 'conference'), renderer=__file__):
            with publication_replay_scope(packet.get('paper'), packet.get('sourceText'),
                    packet.get('publicationEvidence'), publisher=load_publish_to_blog()):
                sys.stdout.write(json.dumps(render_packet(packet), ensure_ascii=False))
    except (LocalReplayFailure, RenderDeadlineExceeded) as error:
        emit_replay_failure(error, __file__)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
