#!/usr/bin/env python3
"""Render a source-bound conference paper without inventing an arXiv identity."""

import hashlib
import html
import ipaddress
import json
import os
import re
import sys
from urllib.parse import quote, urlsplit

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


PAPER_ID = re.compile(r'^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9._-]+$')
WEAK = {'fullText': 'weak', 'tables': 'unavailable', 'formulas': 'unavailable', 'figures': 'unavailable'}
FULL = {'fullText': 'full', 'tables': 'available', 'formulas': 'available', 'figures': 'available'}
READER_CONTRACT = 'beginner-researcher-v3'
SOURCE_BINDINGS_CONTRACT = 'api-reader-source-bindings-v4'
SCORING_CONTRACT = 'api-scoring-audit-v2'
PUBLICATION_CONTRACT = 'conference-official-publication-v1'
FLAT_TAXONOMY_CONTRACT = 'paper-taxonomy-flat-tags-compat-v1'
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
    '评分', '机器摘要', '标签', '作者与机构', '毒舌点评', '核心摘要', '方法概述和架构',
    '核心创新点', '实验结果', '细节详述', '评分理由', '局限与问题', '开源详情',
)


def stable_sha(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()


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
    if parsed.scheme != 'https' or parsed.username or parsed.password or port or parsed.fragment \
            or not hostname or literal or hostname == 'localhost' or hostname.endswith('.localhost') \
            or not valid_dns or (conference_only and (
                hostname == 'arxiv.org' or hostname.endswith('.arxiv.org'))):
        raise ValueError(f'{label} 必须是公开会议 HTTPS URL')
    return value


def hide_arxiv_links(value):
    """Keep conference pages conference-native without exposing preprint URLs."""
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


def sealed_reader_sources(paper, manifest, stage, capabilities):
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
    article_sha, plan_sha = hashlib.sha256(article.encode()).hexdigest(), stable_sha(plan)
    figures = paper.get('apiReaderFigures')
    source_bindings_sha = stable_sha({
        'tableBindings': plan.get('tableBindings'), 'formulaBindings': plan.get('formulaBindings')})
    common_seal = paper.get('apiReaderArticleSha256') == article_sha and stage.get('articleSha256') == article_sha \
        and paper.get('apiReaderPlanSha256') == plan_sha and stage.get('planSha256') == plan_sha \
        and plan.get('sourceBindingsSha256') == source_bindings_sha \
        and stage.get('sourceBindingsContractVersion') == SOURCE_BINDINGS_CONTRACT \
        and stage.get('sourceBindingsSha256') == source_bindings_sha \
        and re.fullmatch(r'[a-f0-9]{64}', str(stage.get('structuredArtifactsSha256') or '')) \
        and stage.get('structuredArtifactsSha256') == ((manifest or {}).get('sourceAcquisition') or {}).get('structuredArtifactsSha256')
    if capabilities == WEAK:
        sealed = common_seal and figures == [] and plan.get('figurePlacements') == [] \
            and plan.get('tableBindings') == [] and plan.get('formulaBindings') == [] \
            and stage.get('figureCount') == 0 and stage.get('tableBindingCount') == 0 \
            and stage.get('formulaBindingCount') == 0 and stage.get('figuresSha256') == stable_sha([])
    elif capabilities == FULL:
        sealed = common_seal and isinstance(figures, list) and isinstance(plan.get('figurePlacements'), list) \
            and isinstance(plan.get('tableBindings'), list) and isinstance(plan.get('formulaBindings'), list) \
            and stage.get('figureCount') == len(figures) \
            and stage.get('tableBindingCount') == len(plan['tableBindings']) \
            and stage.get('formulaBindingCount') == len(plan['formulaBindings']) \
            and stage.get('figuresSha256') == stable_sha(figures)
    else:
        sealed = False
    if not sealed:
        raise ValueError('conference Reader bytes/plan/structure capability is not sealed; unavailable structure cannot be inferred')
    if not isinstance(authors, dict) or contracts.get('apiReaderAuthorIdentity') != 'api-reader-author-identity-v1' \
            or stable_sha(authors) != stage.get('readerAuthorsSha256') \
            or authors.get('identitySha256') != stable_sha(authors.get('identity')) \
            or stage.get('readerAuthorIdentitySha256') != authors.get('identitySha256') \
            or not isinstance(authors.get('authors'), list) or not authors['authors']:
        raise ValueError('conference Reader author/affiliation identity is not sealed')
    for author in authors['authors']:
        if not isinstance(author, dict) or not isinstance(author.get('name'), str) or not author['name'].strip() \
                or not isinstance(author.get('affiliations'), list) or not author['affiliations'] \
                or any(not isinstance(item, str) or not item.strip() for item in author['affiliations']):
            raise ValueError('conference Reader author/affiliation projection is incomplete')
    if not isinstance(resources, dict) or contracts.get('apiReaderResourceIdentity') != 'api-reader-resource-identity-v1':
        raise ValueError('conference Reader resource identity is not sealed')
    resource_identity = dict(resources)
    resource_identity.pop('identitySha256', None)
    if resources.get('identitySha256') != stable_sha(resource_identity) \
            or stage.get('resourceIdentitySha256') != resources.get('identitySha256') \
            or not isinstance(resources.get('resources'), list) \
            or stage.get('resourceCount') != len(resources['resources']):
        raise ValueError('conference Reader resource identity SHA is not replayable')
    for resource in resources['resources']:
        if not isinstance(resource, dict) or resource.get('availability') not in {
                'available', 'unavailable', 'temporarily_unreachable'}:
            raise ValueError('conference Reader resource projection is invalid')
        if resource.get('origin') == 'paper_source':
            if not paper_source_resource_binding(resource):
                raise ValueError('conference Reader paper-source URL binding is invalid')
        elif resource.get('origin') != 'validated_demo' \
                or resource.get('originalUrl') not in ((manifest.get('stages') or {}).get('demoLinkScan') or {}).get('discoveredLinks', []):
            raise ValueError('conference Reader demo resource binding is invalid')
        public_https(resource.get('originalUrl'), 'Reader resource original URL')
        public_https(resource.get('finalUrl'), 'Reader resource final URL')
    return plan, article, authors['authors'], resources['resources']


def score_line(parsed):
    try:
        score = float(parsed.get('score'))
        dimensions = [(label, float(parsed.get(field)), maximum) for field, label, maximum in SCORE_DIMENSIONS]
    except (TypeError, ValueError):
        raise ValueError('canonical eight-dimensional score is incomplete') from None
    if not 0 <= score <= 10 or any(not 0 <= value <= float(maximum) for _, value, maximum in dimensions):
        raise ValueError('canonical eight-dimensional score is out of range')
    detail = ' | '.join(f'{label} {value:.1f}/{maximum}' for label, value, maximum in dimensions)
    return f'**{score:.1f}/10** | {detail}'


def resource_projection(resources):
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


def scoring_projection(paper, parsed, stage):
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


def render_packet(packet):
    paper, assignment = packet.get('paper'), packet.get('taxonomy')
    paper_id, conference, capabilities = packet.get('paper_id'), packet.get('conference'), packet.get('capabilities')
    if not isinstance(paper, dict) or not isinstance(assignment, dict) or not PAPER_ID.fullmatch(str(paper_id or '')):
        raise ValueError('generic conference paper projection is required')
    if paper.get('id') != paper_id or paper.get('conferencePaperId') != paper_id \
            or paper.get('arxivId') is not None or paper.get('paper_id') != paper_id:
        raise ValueError('conference paper must not carry an arXiv alias')
    if assignment.get('status') != 'assigned' or assignment.get('paperId') != paper_id \
            or capabilities not in (WEAK, FULL):
        raise ValueError('taxonomy/capability projection is not source-bound weak/full conference data')
    manifest = paper.get('analysisManifest')
    stage = ((manifest or {}).get('stages') or {}).get('apiReaderArticle') or {}
    plan, article, authors, resources = sealed_reader_sources(paper, manifest, stage, capabilities)
    assets = []
    if capabilities == FULL:
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
        # The old path was derived only from the paper ID.  That made a
        # corrected crop collide with an already published PNG, while the
        # conference publisher intentionally refuses to overwrite existing
        # binary assets.  Bind the public directory to the complete Figure
        # pixel set so a changed crop gets a new immutable path.
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
            # Conference Figures live in the dedicated GitHub Pages image
            # repository, just like the existing daily-post images.  Keep the
            # staging path as the logical source identity; publication maps it
            # into the image repository and commits the bytes there.
            public_url = f'{CONFERENCE_IMAGE_BASE_URL}/{conference["id"]}/{figure_hash}/figure-{int(figure["ordinal"])}.png'
            # Figure ordinals share a prefix (Figure 1 is a prefix of Figure
            # 11).  A plain string replacement would turn the latter into
            # ``figure-1.png1``.  Replace only a complete custom URL token.
            article = re.sub(re.escape(str(source_url)) + r'(?!\d)', public_url, article)
            assets.append({'path': path, 'base64': packet_asset['base64']})
    scoring_stage = ((manifest or {}).get('stages') or {}).get('scoringAudit') or {}
    analysis = paper.get('analysis')
    headings = re.findall(r'^##(?!#)\s*([^\n]+?)\s*$', str(analysis or ''), flags=re.MULTILINE)
    headings = [re.sub(r'[：:]\s*$', '', item).strip() for item in headings]
    acquisition = (manifest or {}).get('sourceAcquisition') or {}
    if headings != list(REQUIRED_ANALYSIS_SECTIONS) or acquisition.get('fullTextAvailable') is not True \
            or acquisition.get('analysisSource') == 'abstract' \
            or not isinstance(analysis, str) or not analysis.strip() or scoring_stage.get('status') != 'complete' \
            or scoring_stage.get('scoringContract') != SCORING_CONTRACT \
            or scoring_stage.get('outputAnalysisSha256') != hashlib.sha256(analysis.encode()).hexdigest() \
            or not scoring_stability_is_resolved(scoring_stage):
        raise ValueError('conference api-scoring-audit-v2 proof is not sealed')
    concepts = {item['id']: item for item in assignment.get('concepts', [])}
    ordered = []
    for concept_id in [assignment.get('primaryTaskId'), assignment.get('primaryMethodId'), *assignment.get('conceptIds', [])]:
        if concept_id and concept_id not in ordered:
            ordered.append(concept_id)
    taxonomy_stage = ((manifest or {}).get('stages') or {}).get('taxonomySeal') or {}
    if assignment.get('flatCompatContract') != FLAT_TAXONOMY_CONTRACT \
            or assignment.get('selectionContract') != ((manifest or {}).get('contracts') or {}).get('taxonomy') \
            or assignment.get('registryVersion') != taxonomy_stage.get('registryVersion') \
            or assignment.get('registrySha256') != taxonomy_stage.get('registrySha256') \
            or assignment.get('primaryTaskId') != taxonomy_stage.get('primaryTaskId') \
            or assignment.get('primaryMethodId') != taxonomy_stage.get('primaryMethodId') \
            or sorted(assignment.get('conceptIds') or []) != sorted(taxonomy_stage.get('conceptIds') or []) \
            or taxonomy_stage.get('status') not in {'complete', 'not_needed'}:
        raise ValueError('conference current taxonomy seal/projection is not closed')
    if any(cid not in concepts for cid in ordered):
        raise ValueError('taxonomy labels are incomplete')
    labels = [concepts[cid]['preferredLabel']['zh'] for cid in assignment.get('conceptIds', [])]
    parsed = paper.get('parsed') or {}
    title, summary = str(paper.get('title') or '').strip(), str(parsed.get('summary') or '').strip()
    reader_title = str(plan.get('readerTitle') or '').strip()
    one_sentence = str(plan.get('oneSentenceThesis') or '').strip()
    rank_bucket, document_type = str(parsed.get('rankBucket') or '').strip(), str(parsed.get('documentType') or '').strip()
    scoring = str(parsed.get('scoringReason') or '').strip()
    complete_score = score_line(parsed)
    publication = packet.get('publication')
    if not title or not summary or not reader_title or not one_sentence or not rank_bucket or not document_type or not scoring \
            or not isinstance(publication, dict) or publication.get('contract') != PUBLICATION_CONTRACT:
        raise ValueError('canonical title/summary/Reader/score/publication fields are incomplete')
    record_url = public_https(publication.get('recordUrl'), 'official record URL', conference_only=True)
    pdf_url = public_https(publication.get('pdfUrl'), 'official PDF URL', conference_only=True)
    if publication != paper.get('conferencePublication') or record_url == pdf_url:
        raise ValueError('official conference publication URLs are not canonical-bound')
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
             f'paper_digest_taxonomy_contract: "{assignment["flatCompatContract"]}"',
             f'paper_digest_taxonomy_selection_contract: "{assignment["selectionContract"]}"',
             f'paper_digest_taxonomy_registry_version: "{assignment["registryVersion"]}"',
             f'paper_digest_taxonomy_registry_sha256: "{assignment["registrySha256"]}"',
             'paper_digest_taxonomy_concepts: ' + json.dumps([
                 {'id': cid, 'facet': concepts[cid]['facet'], 'label': concepts[cid]['preferredLabel']['zh']}
                 for cid in assignment['conceptIds']], ensure_ascii=False, separators=(',', ':'), sort_keys=True),
             f'paper_digest_primary_task: {json.dumps(concepts[assignment["primaryTaskId"]]["preferredLabel"]["zh"], ensure_ascii=False)}',
             f'paper_digest_primary_method: {json.dumps(concepts[assignment["primaryMethodId"]]["preferredLabel"]["zh"], ensure_ascii=False)}',
             f'paper_digest_score: {float(parsed["score"]):.1f}',
             f'paper_digest_rank_bucket: {json.dumps(rank_bucket, ensure_ascii=False)}',
             f'paper_digest_document_type: {json.dumps(document_type, ensure_ascii=False)}',
             f'paper_digest_conference_structure: {"replayable-pdf-layout-v1" if capabilities == FULL else "weak-text-only-v1"}', '---', '',
             f'# 📄 {reader_title}', '', f'> 英文题目：*{title}*', '',
             f'> 会议身份：`{paper_id}`', '',
             ('' if capabilities == FULL else '> ⚠️ 来源为会议 PDF 弱结构纯文本；表格、公式与 Figure 均不可用，本文不会据此重建这些结构。'),
             ('> ✅ 来源为官方会议 PDF；可重放的表格、公式文本与 Figure 像素已按 PDF 抽取结果绑定，未成功恢复的结构不作推断。' if capabilities == FULL else ''), '',
             f'> 会议来源：[官方记录]({record_url}) · [官方 PDF]({pdf_url})', '',
             f'标签：{" ".join("#" + label for label in labels)}', '', f'评分：{complete_score}', '',
             f'排名：{rank_bucket} | 文档类型：{document_type}', '', '## 👥 作者与机构', '']
    for author in authors:
        lines.append(f'- {author["name"]}：{"；".join(author["affiliations"])}')
    lines.extend(['', '## 📌 核心摘要', '', summary, '', '## 🔗 开源与复现资源', '',
                  *resource_projection(resources), '', '## 🧭 深度解读', '', article.strip(), '',
                  '## ⚖️ 评分明细', '', *scoring_projection(paper, parsed, scoring_stage), ''])
    lines.extend(['---', '', f'[← 返回 {conference["id"]} 论文汇总]({packet["aggregateUrl"]})', ''])
    lines[-1:] = [hide_arxiv_links(line) for line in lines[-1:]]
    return {'markdown': publisher.sanitize_markdown_for_publish(hide_arxiv_links('\n'.join(lines))), 'assets': assets}


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
