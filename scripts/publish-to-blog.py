#!/usr/bin/env python3
from project_env import load_project_env
load_project_env()

"""
论文速递 → GitHub Pages 博客

产物结构（平铺）：
  content/posts/
    ├── YYYY-MM-DD.md              # 每日汇总页面
    ├── YYYY-MM-DD-<slug-1>.md     # 论文1独立页面
    ├── YYYY-MM-DD-<slug-2>.md     # 论文2独立页面
    └── ...

用法：
    python3 publish-to-blog.py [data_file]
    python3 generate-blog.py                   # 只生成并写 generation manifest
    python3 review-blog.py                     # 只 review 并写 SHA-256 审查凭证
    python3 push-blog.py                       # 只验证凭证后 commit/push
    python3 publish-to-blog.py                 # 兼容生成入口
    python3 publish-to-blog.py --date YYYY-MM-DD
"""
import argparse
import copy
import contextvars
import difflib
import html
import json, re, sys, os, subprocess, datetime, base64, concurrent.futures, hashlib, math, io
import ipaddress, shutil, socket, tempfile, stat, struct, zlib, unicodedata, time, signal
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote, unquote, urlparse, urlsplit

SHARED_SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SHARED_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SHARED_SCRIPTS_DIR))
MANUAL_SCRIPTS_DIR = Path(__file__).resolve().parent.parent / 'manual' / 'scripts'
if str(MANUAL_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(MANUAL_SCRIPTS_DIR))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    extract_all_tags, score_emoji, format_medal, build_paper_meta,
    fix_latex_delimiters, escape_html_like_tags, fix_image_markdown,
    truncate_base64_datauri, fix_yaml_double_commas, strip_raw_inline_html,
    fix_empty_markdown_links, dedupe_image_alts, fix_yaml_unbalanced_quotes,
    sanitize_markdown_for_publish, strip_internal_scoring_anchors,
    call_publish_llm_api, PublishLLMUnavailable,
    PublishDataValidationError, count_blocking_review_issues, is_blocking_review_issue,
    normalize_publish_arxiv_id, parse_publish_arxiv_identity, review_protocol_failure,
    validate_papers_for_publish, validate_review_payload,
    validate_final_manual_v4_markdown, MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5, MANUAL_DEPTH_CONTRACT_VERSION_V6,
    MANUAL_LONGFORM_CONTRACT_VERSION_V2, validate_manual_v6_payload,
    validate_digest_index_reader_quality, DIGEST_INDEX_READER_QUALITY_VERSION,
    split_markdown_table_row,
)
from path_config import (
    PROJECT_ROOT,
    ARCHIVE_DIR,
    CURRENT_DIR,
    DEEP_ANALYSIS_RESULT_FILE,
    DAILY_FRESH_SOURCE_RUNS_DIR,
    resolve_deep_analysis_result_path,
    DIGEST_COVER_ASSET_DIR,
    DIGEST_COVER_MANIFEST_DIR,
    VISUAL_SUMMARY_ASSET_DIR,
    VISUAL_SUMMARY_MANIFEST_DIR,
    RESEARCHER_SIDECAR_RELATIVE_ROOT,
    atomic_write_json,
    atomic_write_text,
    file_lock,
)
from blog_repository_lock import shared_blog_repository_lock
from project_env import VCS_CHILD_ENV_KEYS, build_child_process_env, get_required_fetch_proxy
from runtime_guard import require_external_runtime
from llm_usage import with_llm_usage_context
from utils import strip_md, parse_analysis, read_tag_validation
from tag_stage_record import TAG_STAGE_RECORD_CONTRACT, read_tag_stage_record
from analysis_sections import (
    evaluation_heading_issue, extract_evaluation_section, find_evaluation_headings,
)
from tag_catalog import (
    TAG_FLAT_COMPAT_CONTRACT,
    TAG_SELECTION_CONTRACT,
    LEGACY_TAG_SELECTION_CONTRACT,
    load_tag_catalog,
)
from tutorial_payload_verifier import (
    TUTORIAL_FORMAT_CONTRACT,
    FRESH_AUTHORING_CONTRACT,
    MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
    MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
    MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
    normalize_fresh_article as _normalize_fresh_article_impl,
    validate_manual_v5_fresh_authoring as _verify_manual_v5_fresh_authoring,
    validate_manual_v5_tutorial_payload as _verify_manual_v5_tutorial_payload,
)
from markdown_hugo_gate import (
    parse_frontmatter_content as _parse_frontmatter_content_impl,
    load_frontmatter as _load_frontmatter_impl,
    validate_markdown_format_gate as _validate_markdown_format_gate_impl,
    validate_hugo_rendered_html_gate as _validate_hugo_rendered_html_gate_impl,
    rendered_page_candidates as _rendered_page_candidates,
    rendered_article_fragment as _rendered_article_fragment,
)
from sealed_tutorial_preview import load_verified_tutorial_preview

BLOG_REPO = os.path.expanduser(
    os.environ.get("PAPER_DIGEST_BLOG_REPO", "~/code/github_repos/audio-paper-digest-blog")
)
CONTENT_DIR = os.path.join(BLOG_REPO, "content", "posts")
BASE_PATH = os.environ.get("PAPER_DIGEST_BLOG_BASE_PATH", "/audio-paper-digest-blog")
GITHUB_REMOTE = os.environ.get("PAPER_DIGEST_GITHUB_REMOTE", "origin")
BEIJING_TIMESTAMP_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$'
)
VISUAL_SUMMARY_KINDS = ('infographic',)
VISUAL_SUMMARY_LABELS = {
    'infographic': '论文长图摘要',
}
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
VISUAL_SUMMARY_MAX_BYTES = 8 * 1024 * 1024
DIGEST_COVER_RANKING_LIMIT = 10
DIGEST_COVER_RENDERING_CONTRACT = {
    'mode': 'full_image_generation_v2',
    'renderer': 'built-in image_gen',
    'resolutionPolicy': 'highest_available_portrait',
    'orientation': 'portrait',
    'preferredAspectRatio': '1:2',
    'minimumWidth': 768,
    'minimumHeight': 1024,
    'maxPngBytes': VISUAL_SUMMARY_MAX_BYTES,
}
_REVIEW_PROTOCOL_CACHE = {}
_REVIEW_UNIT_CONTEXT = contextvars.ContextVar('blog_review_unit_context', default=None)
PUBLISH_IMAGE_EXCLUSIONS_SCHEMA_VERSION = 1
PUBLISH_IMAGE_EXCLUSIONS_PATH = PROJECT_ROOT / 'config' / 'publish-image-exclusions.json'
PUBLISH_IMAGE_EXCLUSIONS_FIELD = 'publishImageExclusions'
PUBLISH_IMAGE_VIEW_FIELD = 'publishImageExclusionView'
PUBLISHED_PAPERS_FINGERPRINT_CONTRACT = 'typed-json-f64-utf16-v1'
MANUAL_V6_PRODUCTION_MODE = 'manual_v6_production'
MANUAL_V6_PRODUCTION_CONTRACT = 'manual-v6-production-publication-v1'
LLM_API_PRODUCTION_MODE = 'llm_api_production'
LLM_API_PRODUCTION_CONTRACT = 'llm-api-production-publication-v1'
LLM_API_READER_CONTRACT = 'beginner-researcher-v3'
LLM_API_READER_LEGACY_CONTRACTS = {
    'beginner-researcher-v1',
    'beginner-researcher-v2',
}
LLM_API_READER_STRUCTURED_CONTRACTS = {
    'beginner-researcher-v2',
    LLM_API_READER_CONTRACT,
}
LLM_API_READER_SOURCE_BINDING_CONTRACT = 'api-reader-source-bindings-v4'
LLM_API_READER_AUTHOR_IDENTITY_CONTRACT = 'api-reader-author-identity-v1'
LLM_API_READER_RESOURCE_IDENTITY_CONTRACT = 'api-reader-resource-identity-v1'
# Its presence makes the lack of a stored Figure asset intentional and
# reviewable.  Older Reader records remain cache-backed when this is absent.
EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT = 'ephemeral-no-persisted-figure-assets-v1'
LLM_API_SCORING_CONTRACT = 'api-scoring-audit-v2'
CORE_SUMMARY_DETAILED_CONTRACT = 'core-summary-detailed-v3'
LEGACY_V5_MAINTENANCE_MODE = 'legacy_v5_maintenance'
SEALED_TUTORIAL_PREVIEW_MODE = 'sealed_tutorial_preview'
MANUAL_REVIEW_MODE = 'manual_complete'
FINAL_PAGE_ARTIFACT_VERSION = 1
RESEARCHER_WORKBENCH_CONTRACT = 'researcher-workbench-v1'
RESEARCHER_SIDECAR_CONTRACT = 'researcher-sidecars-v1'
FLAT_TAG_COMPAT_CONTRACT = TAG_FLAT_COMPAT_CONTRACT
_PAGE_TAG_CATALOG = load_tag_catalog()
_PAGE_ACTIVE_TAGS_BY_ID = {
    item['id']: item for item in _PAGE_TAG_CATALOG['concepts']
    if item['status'] == 'active'
}
# 只读 registry 快照：博客端（Hugo 模板 + 浏览器搜索）需要 id/facet/zh/en/
# aliases/ancestorIds，而页面 frontmatter 只带 {id, facet, label}。快照字节
# 只由 registry 决定，因此与 ``paper_digest_taxonomy_registry_sha256`` 同源。
TAG_CATALOG_SNAPSHOT_CONTRACT = 'paper-taxonomy-registry-snapshot-v1'
# Hugo 只把 ``data/`` 当模板输入，不会发布到 ``public/``；浏览器端搜索因此
# 还需要一份字节完全相同的静态副本。
TAG_CATALOG_SNAPSHOT_RELATIVE = Path('data') / 'taxonomy-registry.json'
TAG_CATALOG_STATIC_RELATIVE = Path('static') / 'data' / 'taxonomy-registry.json'
RESEARCHER_SIDECAR_FILENAMES = (
    'citation.json', 'citation.bib', 'citation.ris', 'rethink-context.json',
)
RESEARCHER_SIDECAR_MAX_BYTES = 256 * 1024
MANUAL_REVIEW_SUBAGENT_MODEL = 'gpt-5.6-terra'
MANUAL_REVIEW_SUBAGENT_REASONING = 'high'

# Single-paper gray releases keep generation/review/push evidence beside, not
# on top of, the already remote-verified batch evidence for the same date.
# Entry points set this only inside ``publication_scope``; ordinary batch calls
# and existing direct function callers retain the historical date-only paths.
_ACTIVE_PUBLICATION_INCLUDE_ID = None


@contextmanager
def publication_scope(include_id=None):
    global _ACTIVE_PUBLICATION_INCLUDE_ID
    previous = _ACTIVE_PUBLICATION_INCLUDE_ID
    normalized = (
        normalize_publish_arxiv_id(include_id) if include_id is not None else None
    )
    _ACTIVE_PUBLICATION_INCLUDE_ID = normalized
    try:
        yield normalized
    finally:
        _ACTIVE_PUBLICATION_INCLUDE_ID = previous


def _publication_state_stem(date_str):
    stem = validate_publish_date(date_str)
    if _ACTIVE_PUBLICATION_INCLUDE_ID is None:
        return stem
    safe_id = re.sub(r'[^a-z0-9]+', '-', _ACTIVE_PUBLICATION_INCLUDE_ID).strip('-')
    if not safe_id:
        raise PublishDataValidationError('单篇发布 ID 无法形成安全状态路径')
    identity_suffix = hashlib.sha256(
        _ACTIVE_PUBLICATION_INCLUDE_ID.encode('utf-8')
    ).hexdigest()[:10]
    return f'{stem}-single-{safe_id}-{identity_suffix}'


def _reviewed_path_set_sha256(files):
    """对已审文件的路径、删除标记和 SHA 集合计算哈希，用于核对审查记录。"""
    entries = []
    for record in files:
        entries.append({
            'path': record.get('path'),
            'deleted': record.get('deleted') is True,
            'sha256': None if record.get('deleted') is True else record.get('sha256'),
        })
    entries.sort(key=lambda item: (str(item.get('path')), bool(item.get('deleted'))))
    return _stable_json_sha256(entries)


def _manual_review_record_error(receipt, *, date_str=None,
                                    generation_manifest_sha256=None,
                                    expected_base_head=None):
    """核对人工审查记录是否满足要求，并与发布凭证相符。

    ``manual_complete`` 是单独记录的人工审查方式，不会因模型服务故障自动启用。
    审查记录必须对应本次生成清单及审查时使用的 Git 基线。
    """
    mode = receipt.get('reviewMode')
    if mode is None:
        return None
    if mode != MANUAL_REVIEW_MODE:
        return f'审查凭证中的审查方式不符合要求：{mode}'
    manual_review_record = receipt.get('reviewProvenance')
    if not isinstance(manual_review_record, dict):
        return '发布凭证缺少有效的人工审查记录。'
    if manual_review_record.get('version') not in (1, 2, 3) or manual_review_record.get('mode') != MANUAL_REVIEW_MODE:
        return '人工审查记录的版本或审查方式不符合要求。'
    legacy_v1 = manual_review_record.get('version') == 1
    current_v3 = manual_review_record.get('version') == 3
    if not isinstance(manual_review_record.get('agent'), str) or not manual_review_record['agent'].strip():
        return '人工审查记录必须填写非空的审查者名称。'
    if manual_review_record.get('basis') != 'deterministic_and_manual_semantic_review':
        return '人工审查记录必须注明已完成代码检查和人工语义审查。'
    if not isinstance(manual_review_record.get('reason'), str) or len(manual_review_record['reason'].strip()) < 20:
        return '人工审查记录中的审查理由必须是至少 20 个字符的非空文字。'
    completed_at = manual_review_record.get('completedAt')
    if not isinstance(completed_at, str) or not BEIJING_TIMESTAMP_RE.fullmatch(completed_at):
        return '人工审查记录中的完成时间必须符合北京时间格式。'
    checks = manual_review_record.get('checks')
    required_checks = {
        'generationManifestVerified', 'baseHeadVerified', 'fileHashesVerified',
        'frontmatterVerified', 'markdownVerified', 'contentSemanticsVerified',
        'imageReferencesVerified', 'hugoGateVerified',
    }
    if (
        not isinstance(checks, dict)
        or set(checks) != required_checks
        or any(checks.get(key) is not True for key in required_checks)
    ):
        return '人工审查记录必须完整列出规定的检查项，并将每项结果标为 true。'
    manifest_sha = manual_review_record.get('generationManifestSha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(manifest_sha or '')):
        return '人工审查记录中的生成清单 SHA 缺失或格式无效。'
    if generation_manifest_sha256 is not None and manifest_sha != generation_manifest_sha256:
        return '人工审查记录中的生成清单 SHA 与本次清单不一致。'
    base_head = manual_review_record.get('baseHead')
    if not re.fullmatch(r'[0-9a-f]{40}', str(base_head or '').lower()):
        return '人工审查记录中的 Git 基线缺失或格式无效。'
    if expected_base_head is not None and str(base_head).lower() != str(expected_base_head).lower():
        return '人工审查记录中的 Git 基线与审查基线不一致。'
    file_count = manual_review_record.get('fileCount')
    if not isinstance(file_count, int) or file_count <= 0:
        return '人工审查记录中的文件数量必须是正整数。'
    review_file_details = manual_review_record.get('files')
    receipt_files = receipt.get('files')
    if legacy_v1:
        # v1 never carried per-page attestations. It is accepted only as
        # immutable historical publication evidence, never as a new/pending
        # receipt that could authorize another push under today's protocol.
        if not all(receipt.get(field) for field in (
            'publicationCommit', 'remoteVerifiedOid', 'remoteVerifiedAt',
            'remoteIdentitySha256',
        )):
            return 'v1 人工审查记录只能用于读取已发布的历史凭证，不能授权新的推送。'
        if not isinstance(receipt_files, list) or len(receipt_files) != file_count:
            return 'v1 人工审查记录中的文件数量与发布凭证的文件清单不一致。'
        path_set_sha = manual_review_record.get('reviewedPathSetSha256')
        if path_set_sha != _reviewed_path_set_sha256(receipt_files):
            return 'v1 人工审查记录中的已审文件集合哈希与发布凭证不一致。'
        return None
    required_file_checks = {
        'titleAndMetadata', 'technicalNarrative', 'factualClaims',
        'experimentComparisons', 'reproducibility', 'limitations',
        'scoring', 'images',
    }
    if not isinstance(review_file_details, list) or len(review_file_details) != file_count:
        return '人工审查记录必须保留逐文件审查明细，且条目数量须与记录的文件数量一致。'
    if not isinstance(receipt_files, list) or len(receipt_files) != file_count:
        return '人工审查记录中的文件数量与发布凭证的文件清单不一致。'
    receipt_by_path = {
        item.get('path'): item for item in receipt_files
        if isinstance(item, dict) and isinstance(item.get('path'), str)
    }

    def notes_bind_reader_fact(notes, content, ignored=()):
        ignored_text = ' '.join(str(item) for item in ignored).casefold()
        tokens = re.findall(
            r'[A-Za-z][A-Za-z0-9.+-]{2,}|(?<!\d)\d+(?:\.\d+)?%?', notes,
        )
        return any(
            token.casefold() not in ignored_text and token.casefold() in content.casefold()
            for token in tokens
        )

    seen_review_file_paths = set()
    seen_notes = set()
    seen_semantic_notes = set()
    seen_review_tasks = set()

    def require_unique_note_semantics(notes, identifiers, path):
        basis = notes
        for identifier in identifiers:
            if identifier:
                basis = basis.replace(str(identifier), '<page>')
        key = re.sub(r'[\W_]+', '', basis, flags=re.UNICODE).casefold()
        if key in seen_semantic_notes:
            return f'人工审查说明在去除页面 ID 后仍重复，未体现各页面的独立审查结果：{path}'
        seen_semantic_notes.add(key)
        return None

    for item in review_file_details:
        if not isinstance(item, dict):
            return '人工审查记录中的每条文件明细必须是对象。'
        allowed_fields = {'path', 'sha256', 'checks', 'notes', 'deleted'}
        required_fields = {'path', 'sha256', 'checks', 'notes'}
        if current_v3:
            allowed_fields.update({'reviewSubagent', 'imageFindings'})
            required_fields.update({'reviewSubagent', 'imageFindings'})
        if not required_fields.issubset(item) \
                or not set(item).issubset(allowed_fields):
            return '人工审查记录的文件明细缺少必要字段，或含有不允许的字段。'
        path = item.get('path')
        if not isinstance(path, str) or path in seen_review_file_paths or path not in receipt_by_path:
            return '人工审查记录中的文件路径格式无效、重复，或不在发布凭证的文件清单中。'
        relative_path = Path(path)
        if relative_path.is_absolute() or '..' in relative_path.parts:
            return f'人工审查记录必须使用不含 .. 的博客仓库相对路径：{path}'
        seen_review_file_paths.add(path)
        receipt_item = receipt_by_path[path]
        deleted = receipt_item.get('deleted') is True
        if deleted != (item.get('deleted') is True) \
                or item.get('sha256') != receipt_item.get('sha256'):
            return f'人工审查记录中的文件 SHA 或删除标记与发布凭证不一致：{path}'
        item_checks = item.get('checks')
        if deleted:
            if item_checks != {'deletionVerified': True}:
                return f'已删除文件的审查记录必须只包含结果为 true 的删除确认项：{path}'
        elif (
                not isinstance(item_checks, dict)
                or set(item_checks) != required_file_checks
                or any(item_checks.get(key) is not True for key in required_file_checks)):
            return f'文件审查记录必须完整列出规定的检查项，并将每项结果标为 true：{path}'
        if not isinstance(item.get('notes'), str) or len(item['notes'].strip()) < 20:
            return f'文件审查说明必须是至少 20 个字符的非空文字：{path}'
        subagent = item.get('reviewSubagent')
        if current_v3 and (not isinstance(subagent, dict) or subagent.get('version') != 1
                or not isinstance(subagent.get('taskName'), str)
                or len(subagent['taskName'].strip()) < 4
                or subagent.get('singleFileOnly') is not True
                or subagent.get('isolatedContext') is not True
                or subagent.get('model') != MANUAL_REVIEW_SUBAGENT_MODEL
                or subagent.get('reasoningEffort') != MANUAL_REVIEW_SUBAGENT_REASONING):
            return f'文件审查记录未按规定记录独立单页审查任务、模型及推理等级：{path}'
        if current_v3 and not isinstance(item.get('imageFindings'), list):
            return f'文件审查记录中的逐图检查结果必须是数组：{path}'
        if current_v3:
            task_name = subagent['taskName'].strip()
            if task_name in seen_review_tasks:
                return '各页面的独立审查任务名称必须全局唯一，不能跨页面复用。'
            seen_review_tasks.add(task_name)
        normalized_notes = re.sub(r'[\W_]+', '', item['notes'], flags=re.UNICODE).casefold()
        if normalized_notes in seen_notes:
            return '文件审查说明重复，未体现各页面的独立审查结果。'
        seen_notes.add(normalized_notes)
        if deleted:
            if '删除' not in item['notes'] or Path(path).stem not in item['notes']:
                return f'删除项的审查说明必须包含“删除”和对应页面不含扩展名的文件名：{path}'
            semantic_error = require_unique_note_semantics(
                item['notes'], (Path(path).stem, date_str), path,
            )
            if semantic_error:
                return semantic_error
        else:
            repo_root = Path(BLOG_REPO).expanduser().resolve()
            target = (repo_root / relative_path).resolve()
            try:
                target.relative_to(repo_root)
            except ValueError:
                return f'人工审查记录中的文件路径越界，不能指向博客仓库之外：{path}'
            try:
                content = target.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                return f'无法读取人工审查记录对应的页面：{path}'
            arxiv_match = re.search(
                r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', content, re.MULTILINE,
            )
            if arxiv_match and arxiv_match.group(1) not in item['notes']:
                return f'论文页的审查说明缺少本页的 arXiv ID：{path}'
            if current_v3 and arxiv_match:
                paper_id = subagent.get('paperId')
                if not re.fullmatch(r'\d{4}\.\d{5}', str(paper_id or '')):
                    return f'论文页审查任务中的 paperId 缺失或不是规范的 arXiv ID：{path}'
                if normalize_publish_arxiv_id(paper_id) != \
                        normalize_publish_arxiv_id(arxiv_match.group(1)):
                    return f'审查任务中的 paperId 与页面的论文 ID 不一致：{path}'
            image_urls = [image.get('url') for image in parse_markdown_images(content)]
            findings = item.get('imageFindings')
            if current_v3 and [finding.get('url') for finding in findings if isinstance(finding, dict)] != image_urls:
                return f'逐图审查记录未按正文顺序完整覆盖页面中的图片：{path}'
            for finding in findings if current_v3 else []:
                if (not isinstance(finding, dict)
                        or set(finding) != {
                            'url', 'captionVerified', 'adjacentNarrativeVerified',
                            'mobileReadable', 'visibleFacts', 'notes',
                        }
                        or any(finding.get(key) is not True for key in (
                            'captionVerified', 'adjacentNarrativeVerified', 'mobileReadable',
                        ))
                        or not isinstance(finding.get('visibleFacts'), list)
                        or len(finding['visibleFacts']) < 2
                        or any(not isinstance(fact, str) or len(fact.strip()) < 10
                               for fact in finding['visibleFacts'])
                        or not isinstance(finding.get('notes'), str)
                        or len(finding['notes'].strip()) < 20):
                    return f'逐图审查记录的格式、检查结果或可见事实说明不符合要求：{path}'
            if arxiv_match and not notes_bind_reader_fact(
                    item['notes'], content, (arxiv_match.group(1), date_str)):
                return f'论文页的审查说明缺少可在正文中核对的技术词或实验数字：{path}'
            if not arxiv_match and (
                    not date_str or date_str not in item['notes'] or '汇总' not in item['notes']):
                return f'汇总页的审查说明必须包含批次日期和“汇总”字样：{path}'
            if not arxiv_match and not notes_bind_reader_fact(
                    item['notes'], content, (date_str,)):
                return f'汇总页的审查说明缺少可在正文中核对的排名、数量或论文术语：{path}'
            semantic_error = require_unique_note_semantics(
                item['notes'],
                ((arxiv_match.group(1) if arxiv_match else None), date_str),
                path,
            )
            if semantic_error:
                return semantic_error
    if seen_review_file_paths != set(receipt_by_path):
        return '人工审查记录中的文件集合与发布凭证不一致。'
    path_set_sha = manual_review_record.get('reviewedPathSetSha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(path_set_sha or '')):
        return '人工审查记录中的已审文件集合哈希缺失或格式无效。'
    protocol = manual_review_record.get('reviewProtocolFingerprint')
    if not re.fullmatch(r'[0-9a-f]{64}', str(protocol or '')):
        return '人工审查记录中的审查规则指纹缺失或格式无效。'
    return None


def blog_transaction_lock(date_str, *, timeout_seconds=30):
    """Serialize generation, review, and push for the same publication date."""
    date_str = validate_publish_date(date_str)
    return file_lock(
        CURRENT_DIR / f'blog-publication-{date_str}.transaction',
        timeout_seconds=timeout_seconds,
    )


def blog_repository_lock(*, timeout_seconds=30):
    """Serialize writers through the blog repository's shared Git common-dir."""
    return shared_blog_repository_lock(
        BLOG_REPO,
        owner=f'paper-digest-blog-stage:{os.getpid()}',
        timeout_seconds=timeout_seconds,
    )


@contextmanager
def blog_publication_lock(date_str, *, timeout_seconds=30):
    """Acquire locks in one global order: repository first, publication date second."""
    date_str = validate_publish_date(date_str)
    with blog_repository_lock(timeout_seconds=timeout_seconds):
        with blog_transaction_lock(date_str, timeout_seconds=timeout_seconds):
            from publication_activation import assert_no_pending
            try:
                assert_no_pending(CURRENT_DIR, date_str)
            except ValueError as exc:
                raise PublishDataValidationError(str(exc)) from exc
            yield


def get_blog_review_concurrency():
    """Return the project-scoped concurrency for independent post reviews."""
    raw = os.environ.get("PD_BLOG_REVIEW_CONCURRENCY", "5").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 5
    return min(5, max(1, value))


def current_image_review_mode():
    return (
        'multimodal'
        if os.environ.get('PAPER_ANALYZER_MODEL', '').strip()
        else 'deterministic_only'
    )


def get_blog_review_chunk_chars():
    """Bound text-review chunks to reduce repeated prompt overhead safely."""
    raw = os.environ.get("PD_BLOG_REVIEW_CHUNK_CHARS", "8000").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 8000
    return min(16000, max(4000, value))


def get_blog_review_max_tokens():
    """Return the output budget for one strict blog review call."""
    raw = os.environ.get("PD_BLOG_REVIEW_MAX_TOKENS", "4000").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 4000
    return min(16000, max(1000, value))


def call_llm_api(
    prompt,
    max_tokens=800,
    temperature=0.1,
    required=False,
    context="LLM review",
    timeout=120,
    images=None,
    use_secondary=False,
    max_retries=5,
    structured_output=False,
):
    """调用发布阶段公共 LLM API client。"""
    return call_publish_llm_api(
        prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        required=required,
        context=context,
        timeout=timeout,
        max_retries=max_retries,
        images=images,
        use_secondary=use_secondary,
        structured_output=structured_output,
    )


@contextmanager
def review_unit_cache(date_str, page_path, *, required, paper_id=None, run_id=None):
    """Enable request-level recovery only within a strict publication review."""
    context = None
    if required:
        context = {
            'directory': review_page_checkpoint_dir(validate_publish_date(date_str)) / 'units'
                / hashlib.sha256(str(Path(page_path).resolve()).encode('utf-8')).hexdigest(),
            'protocol': review_protocol_fingerprint(),
            'paperId': paper_id,
            'runId': run_id,
        }
    token = _REVIEW_UNIT_CONTEXT.set(context)
    try:
        yield
    finally:
        _REVIEW_UNIT_CONTEXT.reset(token)


def review_cached_unit(kind, inputs, run):
    """Reuse only exact successful request evidence; retain failed issues for diagnosis."""
    context = _REVIEW_UNIT_CONTEXT.get()
    if context is None:
        return run()
    identity = {
        'schemaVersion': 1, 'kind': kind,
        'reviewProtocolFingerprint': context['protocol'],
        'inputSha256': _stable_json_sha256(inputs),
    }
    key = _stable_json_sha256(identity)
    directory = context['directory']
    checkpoint = directory / f'{key}.json'
    # Never follow a cache symlink; malformed checkpoints simply cannot attest
    # a successful request. No prompt, page body or image bytes are persisted.
    current_root = Path(CURRENT_DIR)
    for component in (checkpoint, directory, *directory.parents):
        if component.is_symlink():
            raise PublishDataValidationError('review unit checkpoint 禁止符号链接')
        if component == current_root:
            break
    try:
        if checkpoint.stat().st_size > 1024 * 1024:
            raise ValueError('review unit checkpoint exceeds bounded result size')
        record = json.loads(checkpoint.read_text(encoding='utf-8'))
        if (
            isinstance(record, dict)
            and all(record.get(name) == value for name, value in identity.items())
            and record.get('passed') is True
            and record.get('resultSha256') == _stable_json_sha256({
                'passed': record.get('passed'), 'issues': record.get('issues'),
            })
        ):
            passed, issues = validate_review_payload(record, required=True, context='cached review unit')
            if passed is True and count_blocking_review_issues(issues) == 0:
                return passed, issues
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
        pass
    try:
        with with_llm_usage_context({
            'runId': context.get('runId'),
            'paperId': context.get('paperId'),
            'stage': 'publish.figure' if kind == 'image' else 'publish.text',
            'unitId': key,
        }):
            passed, issues = run()
    except Exception as exc:
        # The caller keeps the original exception/retry semantics.
        result = {'passed': False, 'issues': [{
            'severity': 'error', 'type': 'infrastructure',
            'description': f'review request failed ({type(exc).__name__})',
        }]}
        atomic_write_json(checkpoint, {**identity, **result,
            'resultSha256': _stable_json_sha256(result)}, ensure_ascii=False, indent=2, mode=0o600)
        raise
    result = {'passed': passed is True, 'issues': issues}
    atomic_write_json(checkpoint, {**identity, **result,
        'resultSha256': _stable_json_sha256(result)}, ensure_ascii=False, indent=2, mode=0o600)
    return passed, issues


def validate_publish_date(value):
    """Return a canonical real Gregorian date in strict YYYY-MM-DD form."""
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise PublishDataValidationError('博客日期必须严格使用 YYYY-MM-DD 格式')
    try:
        parsed = datetime.datetime.strptime(value, '%Y-%m-%d')
    except ValueError as exc:
        raise PublishDataValidationError(f'博客日期不是有效日期: {value}') from exc
    if parsed.strftime('%Y-%m-%d') != value:
        raise PublishDataValidationError(f'博客日期不是规范日期: {value}')
    return value


def paper_batch_date(paper):
    explicit = paper.get('fetchBatchDate') or paper.get('batchDate')
    if explicit:
        return validate_publish_date(explicit)
    fetched_at = paper.get('fetchedAt')
    match = BEIJING_TIMESTAMP_RE.fullmatch(fetched_at) if isinstance(fetched_at, str) else None
    if not match:
        label = paper.get('arxivId') or paper.get('title') or '<unknown>'
        raise PublishDataValidationError(f'{label} fetchedAt 不是严格北京时间戳')
    return validate_publish_date(match.group(1))


def validate_publish_target(blog_repo=None, content_dir=None):
    """Constrain publication writes to <blog repo>/content/posts."""
    blog_repo = BLOG_REPO if blog_repo is None else blog_repo
    content_dir = CONTENT_DIR if content_dir is None else content_dir
    repo = Path(blog_repo).expanduser().resolve()
    target = Path(content_dir).expanduser().resolve()
    expected = (repo / 'content' / 'posts').resolve()
    try:
        expected.relative_to(repo)
    except ValueError as exc:
        raise PublishDataValidationError('博客 content/posts 不能通过符号链接逃逸仓库') from exc
    if target != expected:
        raise PublishDataValidationError(
            f'CONTENT_DIR 必须严格为博客仓库的 content/posts: {expected}'
        )
    if not repo.is_dir():
        raise PublishDataValidationError(f'博客仓库不存在或不是目录: {repo}')
    return repo, target


def split_review_content(content, limit=4000):
    """Split at Markdown block boundaries without cutting fences/tables/links."""
    if not content:
        return ['']
    lines = content.splitlines(keepends=True)
    blocks = []
    block = []
    fence = None
    in_table = False
    for line in lines:
        fence_match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence:
            block.append(line)
            if fence_match and fence_match.group(1)[0] == fence[0] and len(fence_match.group(1)) >= len(fence):
                blocks.append(('protected', ''.join(block)))
                block, fence = [], None
            continue
        if fence_match:
            if block:
                blocks.append(('plain', ''.join(block)))
            block = [line]
            fence = fence_match.group(1)
            in_table = False
            continue
        is_table = line.lstrip().startswith('|')
        if is_table:
            if block and not in_table:
                blocks.append(('plain', ''.join(block)))
                block = []
            block.append(line)
            in_table = True
            continue
        if in_table:
            blocks.append(('protected', ''.join(block)))
            block, in_table = [], False
        block.append(line)
        if not line.strip():
            blocks.append(('plain', ''.join(block)))
            block = []
    if block:
        blocks.append(('protected' if fence or in_table else 'plain', ''.join(block)))

    chunks = []
    current = ''
    for block_kind, block in blocks:
        if current and len(current) + len(block) > limit:
            chunks.append(current)
            current = ''
        # A single semantic block may exceed the soft limit. Keeping it intact
        # is safer than manufacturing an unclosed fence/table/link context.
        if not current and len(block) > limit and block_kind == 'protected':
            chunks.append(block)
        elif not current and len(block) > limit:
            # Long plain paragraphs have no Markdown block state to preserve.
            # Prefer a line boundary so short semantic tokens are not split.
            remaining = block
            while len(remaining) > limit:
                boundary = remaining.rfind('\n', 0, limit + 1)
                if boundary >= 0:
                    boundary += 1
                if boundary <= 0:
                    boundary = limit
                chunks.append(remaining[:boundary])
                remaining = remaining[boundary:]
            current = remaining
        else:
            current += block
    if current or not chunks:
        chunks.append(current)
    return chunks


def has_unconverted_dollar_math(content):
    """是否仍存在未转换的 $...$ / $$...$$ 公式。"""
    if not content:
        return False
    if re.search(r'(?<!\\)\$\$[\s\S]+?(?<!\\)\$\$', content):
        return True
    return bool(re.search(r'(?<!\\)\$([^\s$][^$]*?[^\s$])(?<!\\)\$', content))


def markdown_table_shapes_are_valid(content):
    """Replay explicit Markdown table column counts for LLM false-positive filtering."""
    lines = str(content or '').splitlines()
    for index, line in enumerate(lines):
        if not re.match(r'^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$', line):
            continue
        expected_columns = len(split_markdown_table_row(line))
        start = index - 1
        end = index + 1
        while start >= 0 and lines[start].lstrip().startswith('|'):
            start -= 1
        while end < len(lines) and lines[end].lstrip().startswith('|'):
            end += 1
        if any(
            len(split_markdown_table_row(lines[row_index])) != expected_columns
            for row_index in range(start + 1, end)
        ):
            return False
    return True


def filter_false_positive_review_issues(content, issues):
    """过滤可由代码确定为误报的 LLM review 问题。"""
    if not issues:
        return issues
    raw_dollar_math = has_unconverted_dollar_math(content)
    unescaped_angle_tags = set(
        m.group(0)
        for m in re.finditer(r'(?<![a-zA-Z0-9`])<(/?)([A-Za-z][A-Za-z0-9_†-]{0,40})(?![A-Za-z0-9_†-])>', content)
    )
    fence_count = len(re.findall(r'^\s*`{3,}[^`]*$', content, re.MULTILINE))
    fences_are_balanced = fence_count % 2 == 0
    frontmatter_is_closed = bool(re.match(
        r'\A---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\Z)',
        str(content or ''),
    ))
    filtered = []
    for issue in issues:
        desc = str(issue.get('description', ''))
        issue_type = str(issue.get('type', '')).lower()
        if ('反引号' in desc or 'backtick' in desc.lower()) and re.search(r'模型名|模型名称|技术术语|model name|technical term', desc, re.IGNORECASE):
            continue
        if not raw_dollar_math and (issue_type == 'latex' or '$' in desc) and ('LaTeX' in desc or '公式' in desc or '$' in desc):
            continue
        mentioned_angle_tags = set(re.findall(r'</?[A-Za-z][A-Za-z0-9_†-]{0,40}>', desc))
        if mentioned_angle_tags and not (mentioned_angle_tags & unescaped_angle_tags):
            continue
        if not unescaped_angle_tags and (issue_type == 'html_tag' or 'HTML-like' in desc or 'HTML标签' in desc):
            continue
        fence_claim = re.search(
            r'代码块|code\s*fence|fenced\s+code|backtick',
            desc,
            re.IGNORECASE,
        ) and re.search(
            r'未闭合|没有.*结束|孤立|unclosed|unterminated|unmatched|isolated',
            desc,
            re.IGNORECASE,
        )
        if fences_are_balanced and fence_claim:
            continue
        frontmatter_closure_claim = re.search(
            r'frontmatter|YAML', desc, re.IGNORECASE,
        ) and re.search(
            r'未闭合|缺少.*闭合|没有.*闭合|没有.*结束|unclosed|unterminated|missing.*(?:closing|delimiter)',
            desc,
            re.IGNORECASE,
        )
        if frontmatter_is_closed and frontmatter_closure_claim:
            continue
        table_shape_claim = re.search(r'表格|表头|table', desc, re.IGNORECASE) \
            and re.search(r'列数|分隔行|separator|column', desc, re.IGNORECASE)
        if table_shape_claim and markdown_table_shapes_are_valid(content):
            continue
        sha_fields = set(re.findall(r'\b(paper_digest_[a-z0-9_]*sha256)\b', desc))
        sha_shape_claim = sha_fields and re.search(
            r'SHA|哈希|十六进制|空格|长度|hex', desc, re.IGNORECASE,
        )
        if sha_shape_claim and all(re.search(
                rf'^{re.escape(field)}:\s*"[0-9a-f]{{64}}"\s*$',
                content, flags=re.MULTILINE,
        ) for field in sha_fields):
            continue
        sidecar_sha_claim = re.search(
            r'paper_digest_sidecars|sidecar', desc, re.IGNORECASE,
        ) and re.search(r'SHA|哈希|十六进制|空格|长度|hex', desc, re.IGNORECASE)
        if sidecar_sha_claim:
            sidecar_hashes = re.findall(r'"sha256"\s*:\s*"([^"]*)"', content)
            if sidecar_hashes and all(re.fullmatch(r'[0-9a-f]{64}', value)
                                      for value in sidecar_hashes):
                continue
        filtered.append(issue)
    return filtered


def parse_review_json(text):
    """Parse a JSON response even when the model adds a short prose wrapper."""
    cleaned = (text or '').strip()
    cleaned = re.sub(r'^```(?:json)?\s*|\s*```$', '', cleaned, flags=re.IGNORECASE).strip()
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find('{'), cleaned.rfind('}')
        if start < 0 or end <= start:
            raise
        return json.loads(cleaned[start:end + 1])


def repair_review_payload(
    raw_response,
    context,
    *,
    use_secondary=False,
    issue_fields=(),
    retry_prompt=None,
    retry_images=None,
):
    """Convert a malformed review response to the strict review JSON contract once."""
    raw_response = raw_response or ''
    original_retry_attempted = False
    if retry_prompt and len(raw_response.strip()) < 32:
        original_retry_attempted = True
        try:
            retried = call_llm_api(
                retry_prompt + '\n\n上一次响应不完整。请重新完成审查，并且只输出符合上述契约的完整 JSON 对象。',
                max_tokens=get_blog_review_max_tokens(),
                temperature=0.1,
                required=True,
                context=f'{context} 协议重试',
                images=retry_images,
                use_secondary=use_secondary,
                max_retries=2,
                structured_output=True,
            )
            review = parse_review_json(retried)
            return validate_review_payload(
                review,
                required=True,
                context=context,
                issue_fields=issue_fields,
            )
        except (PublishLLMUnavailable, json.JSONDecodeError, TypeError, ValueError):
            raw_response = retried if 'retried' in locals() else raw_response

    prompt = f"""你只负责修复审查响应的输出格式，不得新增、删除或改变审查结论。

原始审查响应：
```text
{(raw_response or '')[:12000]}
```

只输出一个 JSON 对象，不要输出代码围栏或解释：
{{
  "passed": true/false,
  "issues": [
    {{
      "severity": "error/warning/info",
      "type": "html_tag/latex/markdown/content/image/yaml/unknown",
      "description": "原响应中的具体问题",
      "auto_fixable": false,
      "fix_instruction": ""
    }}
  ]
}}

约束：只有 issues 中存在 severity=error 时 passed 才能为 false；没有问题时 issues 必须为空数组。"""
    try:
        repaired = call_llm_api(
            prompt,
            max_tokens=min(get_blog_review_max_tokens(), 4000),
            temperature=0.1,
            required=True,
            context=f'{context} 格式修复',
            use_secondary=use_secondary,
            max_retries=1,
            structured_output=True,
        )
        review = parse_review_json(repaired)
        return validate_review_payload(
            review,
            required=True,
            context=context,
            issue_fields=issue_fields,
        )
    except (PublishLLMUnavailable, json.JSONDecodeError, TypeError, ValueError) as exc:
        repair_error = exc

    # A format-repair response can itself be truncated or malformed. In that
    # case, retry the actual review once so text and image evidence remain in
    # scope instead of repeatedly asking a model to repair broken JSON.
    if retry_prompt and not original_retry_attempted:
        try:
            retried = call_llm_api(
                retry_prompt + '\n\n上一次响应及其格式修复均无效。请重新完成审查，并且只输出符合上述契约的完整 JSON 对象。',
                max_tokens=get_blog_review_max_tokens(),
                temperature=0.1,
                required=True,
                context=f'{context} 协议重试',
                images=retry_images,
                use_secondary=use_secondary,
                max_retries=2,
                structured_output=True,
            )
            review = parse_review_json(retried)
            return validate_review_payload(
                review,
                required=True,
                context=context,
                issue_fields=issue_fields,
            )
        except (PublishLLMUnavailable, json.JSONDecodeError, TypeError, ValueError) as retry_exc:
            return review_protocol_failure(
                context,
                f'响应不是可解析的 JSON，格式修复失败：{repair_error}；协议重试失败：{retry_exc}',
            )

    return review_protocol_failure(context, f'响应不是可解析的 JSON，格式修复失败：{repair_error}')


def _llm_review_post_chunk(content, title="", required=False, chunk_label='1/1'):
    """Review one bounded chunk of a post."""
    title = plain_title_for_publish(title) if title else title
    prompt = f"""你是一个 Hugo 静态站点博客内容质量审查专家。

请严格审查下面这篇博客的 Markdown 内容，重点检查以下问题：

1. **HTML 标签解析问题**：只检查尖括号包裹的文本标记，例如 `<S>`、`<E>`、`<Sigmoid>`、`<B†>`、`<s>`、`<e>` 等是否**未被反引号包裹**而被 Hugo 错误解析为 HTML 标签（会导致删除线、粗体等意外样式）。普通英文名词或数据集名（如 Lakh MIDI、TheoryTab、MELD、CMU-MOSEI）不是 HTML-like 标签，不要报告。注意：已经被反引号包裹的如 `` `<S>` `` 是正确格式，不要报告。
2. **LaTeX 公式渲染问题**：检查是否存在使用了 `$...$` 或 `$$...$$` 格式的公式。注意：纯文本形式的数学描述（如 "RMS = sqrt(1/N)"）不是 LaTeX 公式，不需要报告；只有明确使用了 `$` 或 `$$` 包裹但未转换为 `\\(...\\)` / `\\[...\\]` 的才需要报告。
3. **Markdown 格式问题**：链接、图片引用、表格、列表等格式是否有语法错误
4. **内容完整性**：是否有乱码、重复、段落错位。当前内容是完整正文的分块 {chunk_label}，不要因为分块边界报告内容不完整。
5. **图片问题**：图片链接是否为空、格式是否正确（支持 base64 data URI 和普通 URL）
6. **YAML frontmatter 问题**：标题、描述等字段是否有引号不匹配、特殊字符未转义
7. **中文栏目语言**：`论文评价`（兼容旧标题 `毒舌点评`）必须以简体中文为主；如果整段主要是英文，必须报告为 error，并要求依据原点评含义改写为中文，不能只删除内容

【重要区分】以下情况**不要**作为错误报告：
- 已经用反引号包裹的 HTML-like 标记（如 `` `<S>` ``）→ 这是正确格式
- 纯文本中的数学符号或公式描述（未使用 `$` 包裹）→ 这不是 LaTeX 格式问题
- 仅属于风格建议的问题（如 alt 文本可以更详细、列表格式可以更统一）→ 这些应评为 info 级别或干脆不报告
- 技术术语未用反引号包裹 → 这不是格式错误，除非它会被 Hugo 解析为 HTML
- Markdown 表格的列数按竖线分隔后的单元格数计算；例如 `| --- | --- | --- | --- | --- |` 是 5 列，不是 4 列
- 不要在复制或视觉分行时给 frontmatter 的 64 位十六进制 SHA 插入空格；必须按代码块中的原始连续字节判断

博客标题：{title}

博客正文分块 {chunk_label}：
```markdown
{content}
```

请以 **纯 JSON** 格式返回审查结果，不要添加任何解释文字：
{{
  "passed": true/false,
  "issues": [
    {{
      "severity": "error/warning/info",
      "type": "html_tag/latex/markdown/content/image/yaml",
      "description": "具体问题描述",
      "auto_fixable": true/false,
      "fix_instruction": "修复指令（如: 将 $<S>$ 改为 `\\`<S>\\``）"
    }}
  ]
}}"""

    prompt += """

协议一致性要求：
- 只有 `issues` 中至少存在一条 `severity=error` 时，`passed` 才能为 `false`。
- 若只有 `warning` / `info` 或没有问题，`passed` 必须为 `true`。
- `passed=false` 时必须给出至少一条具体、可执行的 `error` 级原因。
"""

    review_context = f"LLM 文本 review: {title}"
    try:
        result = call_llm_api(
            prompt,
            max_tokens=get_blog_review_max_tokens(),
            temperature=0.1,
            required=required,
            context=review_context,
            structured_output=True,
        )
    except PublishLLMUnavailable as primary_error:
        # 主模型请求不可用时，只有本次必须完成模型审查且已配置副模型，
        # 才用副模型重新审查文本；返回结果仍须满足相同的 JSON 要求。
        secondary_model = os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', '').strip()
        if not required or not secondary_model:
            raise
        print(
            f"  ⚠️ {review_context} 主模型不可用，使用副模型 {secondary_model} 重试："
            f"{str(primary_error)[:240]}"
        )
        result = call_llm_api(
            prompt,
            max_tokens=get_blog_review_max_tokens(),
            temperature=0.1,
            required=True,
            context=f"{review_context} 副模型 fallback",
            use_secondary=True,
            max_retries=3,
            structured_output=True,
        )
    if not result:
        if required:
            passed, issues = review_protocol_failure(f"LLM 文本 review: {title}", '响应为空')
            return passed, issues, content
        return True, [], content

    # 尝试解析 JSON
    try:
        # 清理可能的 markdown 代码块
        cleaned = result
        if cleaned.startswith("```json"):
            cleaned = cleaned[7:]
        if cleaned.startswith("```"):
            cleaned = cleaned[3:]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()
        review = parse_review_json(cleaned)
        passed, issues = validate_review_payload(
            review,
            required=required,
            context=f"LLM 文本 review: {title}",
            issue_fields=('type', 'auto_fixable', 'fix_instruction'),
        )
        issues = filter_false_positive_review_issues(content, issues)
        if passed is False and not issues:
            # All model-reported blockers were deterministically disproved
            # against these exact page bytes. A raw false-without-reason still
            # blocks because validate_review_payload injects a protocol issue.
            passed = True
        # 自动应用可修复的问题
        fixed_content = apply_llm_fixes(content, issues)
        return passed, issues, fixed_content
    except (json.JSONDecodeError, TypeError, ValueError):
        # 如果 JSON 解析失败，尝试从文本中提取问题
        print(f"  ⚠️  LLM review 返回非 JSON 格式，尝试文本解析")
        if required:
            passed, issues = repair_review_payload(
                result,
                f"LLM 文本 review: {title}",
                issue_fields=('type', 'auto_fixable', 'fix_instruction'),
                retry_prompt=prompt,
            )
            issues = filter_false_positive_review_issues(content, issues)
            if passed is False and not issues:
                passed = True
            fixed_content = apply_llm_fixes(content, issues)
            return passed, issues, fixed_content
        issues = []
        if "问题" in result or "错误" in result or "建议" in result:
            issues.append({
                "severity": "warning",
                "type": "unknown",
                "description": "LLM 发现潜在问题（非结构化输出）",
                "auto_fixable": False,
                "fix_instruction": "请手动检查"
            })
            return False, issues, content
        return True, [], content


def llm_review_post(content, title="", required=False):
    """Review every chunk of a post and return merged issues and fixes."""
    chunks = split_review_content(content, get_blog_review_chunk_chars())
    all_issues = []
    passed = True
    chunk_results = [None] * len(chunks)

    def review_chunk(index):
        label = f'{index + 1}/{len(chunks)}'
        passed, issues = review_cached_unit(
            'text', {'content': chunks[index], 'title': title, 'chunkLabel': label, 'required': required},
            lambda: _llm_review_post_chunk(
                chunks[index], title, required=required, chunk_label=label,
            )[:2],
        )
        return passed, issues, chunks[index]

    # The large daily index is otherwise the serial bottleneck. Paper pages are
    # already parallelized by review_all_posts, so keep their chunks sequential
    # to avoid multiplying page concurrency by chunk concurrency.
    if title == "汇总页" and len(chunks) > 1:
        workers = min(get_blog_review_concurrency(), len(chunks))
        print(f"    🔀 汇总页文本分块 review 并发度: {workers}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(contextvars.copy_context().run, review_chunk, index): index
                for index in range(len(chunks))
            }
            for future in concurrent.futures.as_completed(futures):
                chunk_results[futures[future]] = future.result()
    else:
        for index in range(len(chunks)):
            chunk_results[index] = review_chunk(index)

    for chunk_passed, issues, _unused in chunk_results:
        passed = passed and chunk_passed
        all_issues.extend(issues)
    # A chunk reviewer can only see its bounded slice and may claim that a
    # document-level construct (most commonly YAML frontmatter) is unclosed.
    # Replay deterministic false-positive checks once more against the exact
    # full page bytes before the merged verdict is signed.
    all_issues = filter_false_positive_review_issues(content, all_issues)
    fixed_content = apply_llm_fixes(content, all_issues)
    passed = count_blocking_review_issues(all_issues) == 0
    return passed, all_issues, fixed_content


REVIEW_IMAGE_MIME_TYPES = {
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
}
REVIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024
REVIEW_IMAGE_MAX_EDGE = 4096
REVIEW_IMAGE_MAX_PIXELS = 16 * 1024 * 1024
REVIEW_IMAGE_DEADLINE_SECONDS = 120
HUGO_GATE_TIMEOUT_SECONDS = 300
HUGO_GATE_OUTPUT_TAIL_BYTES = 128 * 1024
SUBPROCESS_SEMANTIC_OUTPUT_MAX_BYTES = 32 * 1024 * 1024
GIT_LOCAL_TIMEOUT_SECONDS = 30
GIT_COMMIT_TIMEOUT_SECONDS = 180
GIT_NETWORK_TIMEOUT_SECONDS = 180
VISUAL_PLANNER_TIMEOUT_SECONDS = 120


def _validate_public_image_url(url):
    parsed = urlparse(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise PublishDataValidationError('图片 review 只允许无认证信息的 HTTPS URL')
    hostname = parsed.hostname.lower().rstrip('.')
    if hostname == 'localhost' or hostname.endswith('.local'):
        raise PublishDataValidationError('图片 review 拒绝本地主机 URL')
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(hostname, None)}
    except socket.gaierror as exc:
        raise PublishDataValidationError(f'图片域名无法解析: {hostname}') from exc
    for address in addresses:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            raise PublishDataValidationError(f'图片 URL 解析到非公网地址: {address}')
    return {str(ipaddress.ip_address(address)) for address in addresses}


def _response_peer_ip(response):
    """Extract the connected peer from requests/urllib3 without trusting DNS twice."""
    raw = getattr(response, 'raw', None)
    candidates = [
        getattr(getattr(response, '_connection', None), 'sock', None),
        getattr(getattr(response, 'connection', None), 'sock', None),
        getattr(getattr(raw, '_connection', None), 'sock', None),
        getattr(getattr(raw, 'connection', None), 'sock', None),
    ]
    original = getattr(raw, '_original_response', None)
    try:
        candidates.append(original.fp.raw._sock)
    except AttributeError:
        pass
    for sock in candidates:
        if sock is None:
            continue
        try:
            return str(ipaddress.ip_address(sock.getpeername()[0].split('%', 1)[0]))
        except (AttributeError, OSError, TypeError, ValueError):
            continue
    raise PublishDataValidationError('无法验证图片 HTTPS 连接的实际 peer IP')


def _validate_response_peer(response, resolved_addresses):
    return _validate_response_peer_with_transport(response, resolved_addresses)


def _resolve_proxy_addresses(proxy):
    """Resolve the explicitly configured CONNECT proxy, which is a trusted transport hop."""
    parsed = urlparse(proxy)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
        raise PublishDataValidationError('图片 review 代理必须是 HTTP CONNECT 地址')
    try:
        return {
            str(ipaddress.ip_address(item[4][0].split('%', 1)[0]))
            for item in socket.getaddrinfo(parsed.hostname, parsed.port or 443)
        }
    except socket.gaierror as exc:
        raise PublishDataValidationError(f'图片 review 代理无法解析: {parsed.hostname}') from exc


def _bounded_positive_seconds(env_name, default, minimum, maximum):
    raw = str(os.environ.get(env_name, default)).strip()
    try:
        value = int(raw)
    except ValueError:
        value = default
    return min(maximum, max(minimum, value))


def _remaining_deadline_seconds(deadline, label):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise PublishDataValidationError(f'{label}超过绝对截止时间')
    return remaining


def _pinned_https_url(parsed, address):
    """Replace only the transport authority; Host and TLS SNI stay original."""
    normalized = str(ipaddress.ip_address(address))
    host = f'[{normalized}]' if ':' in normalized else normalized
    if parsed.port and parsed.port != 443:
        host = f'{host}:{parsed.port}'
    return parsed._replace(netloc=host).geturl()


def _read_pinned_review_image(
    current, resolved_addresses, proxy, proxy_addresses, deadline, target_address=None,
):
    """Fetch one HTTPS hop through CONNECT pinned to a prevalidated public IP."""
    import urllib3

    parsed = urlparse(current)
    target_address = target_address or sorted(
        resolved_addresses,
        key=lambda value: (ipaddress.ip_address(value).version, value),
    )[0]
    pinned_url = _pinned_https_url(parsed, target_address)
    hostname = parsed.hostname.lower().rstrip('.')
    manager = urllib3.ProxyManager(
        proxy,
        cert_reqs='CERT_REQUIRED',
        assert_hostname=hostname,
        server_hostname=hostname,
        retries=False,
    )
    response = None
    try:
        remaining = _remaining_deadline_seconds(deadline, '图片下载')
        response = manager.request(
            'GET',
            pinned_url,
            headers={
                'Host': parsed.netloc,
                'User-Agent': 'audio-paper-digest/1.0',
            },
            redirect=False,
            preload_content=False,
            retries=False,
            timeout=urllib3.Timeout(connect=min(30.0, remaining), read=min(30.0, remaining)),
        )
        _validate_response_peer_with_transport(
            response, resolved_addresses, proxy_addresses,
        )
        status = int(response.status or 0)
        headers = response.headers
        if status in {301, 302, 303, 307, 308}:
            return {
                'status': status,
                'location': headers.get('Location'),
                'media_type': '',
                'raw': b'',
                'pinned_address': target_address,
            }
        if status < 200 or status >= 300:
            raise PublishDataValidationError(f'图片下载 HTTP {status}')
        media_type = str(headers.get('Content-Type') or '').split(';', 1)[0].lower()
        if media_type not in REVIEW_IMAGE_MIME_TYPES:
            raise PublishDataValidationError(f'图片 MIME 不受支持: {media_type or "unknown"}')
        declared_size = headers.get('Content-Length')
        if declared_size:
            try:
                if int(declared_size) > REVIEW_IMAGE_MAX_BYTES:
                    raise PublishDataValidationError('图片超过 8 MiB review 上限')
            except ValueError as exc:
                raise PublishDataValidationError('图片 Content-Length 非法') from exc
        chunks = []
        size = 0
        while True:
            remaining = _remaining_deadline_seconds(deadline, '图片下载')
            connection = getattr(response, 'connection', None) \
                or getattr(response, '_connection', None)
            sock = getattr(connection, 'sock', None)
            if sock is not None:
                sock.settimeout(min(30.0, remaining))
            chunk = response.read(65536)
            if not chunk:
                break
            size += len(chunk)
            if size > REVIEW_IMAGE_MAX_BYTES:
                raise PublishDataValidationError('图片超过 8 MiB review 上限')
            chunks.append(chunk)
        return {
            'status': status,
            'location': None,
            'media_type': media_type,
            'raw': b''.join(chunks),
            'pinned_address': target_address,
        }
    finally:
        if response is not None:
            response.close()
            response.release_conn()
        manager.clear()


def _validate_response_peer_with_transport(response, resolved_addresses, proxy_addresses=None):
    peer = _response_peer_ip(response)
    # With an explicit HTTP CONNECT proxy the socket peer is the configured proxy
    # (often 127.0.0.1), not the remote image host. The URL is still DNS-checked
    # before every hop; validate the transport peer against the configured proxy.
    if proxy_addresses is not None:
        if peer not in proxy_addresses:
            raise PublishDataValidationError(
                f'图片 HTTPS 连接未命中已配置代理 peer: {peer}'
            )
        return peer
    if not ipaddress.ip_address(peer).is_global:
        raise PublishDataValidationError(f'图片 HTTPS 连接命中非公网 peer: {peer}')
    if peer not in resolved_addresses:
        raise PublishDataValidationError(
            f'图片 HTTPS peer {peer} 不在预先验证的 DNS 解析结果中，疑似 DNS rebinding'
        )
    return peer


def _download_review_image(url):
    """Download through CONNECT pinned to the locally prevalidated public IP."""
    proxy = get_required_fetch_proxy()
    proxy_addresses = _resolve_proxy_addresses(proxy)
    deadline_seconds = _bounded_positive_seconds(
        'PD_BLOG_IMAGE_REVIEW_DEADLINE_SECONDS',
        REVIEW_IMAGE_DEADLINE_SECONDS, 10, 300,
    )
    deadline = time.monotonic() + deadline_seconds
    try:
        current = url
        for _redirect in range(4):
            resolved_addresses = _validate_public_image_url(current)
            result = None
            transient_error = None
            candidate_addresses = sorted(
                resolved_addresses,
                key=lambda value: (ipaddress.ip_address(value).version, value),
            )
            for target_address in candidate_addresses:
                for transport_attempt in range(4):
                    try:
                        result = _read_pinned_review_image(
                            current, resolved_addresses, proxy, proxy_addresses, deadline,
                            target_address=target_address,
                        )
                        break
                    except Exception as exc:
                        # Only transport-layer failures may retry the same
                        # already DNS-validated address or move to another
                        # validated address. Content/security failures remain
                        # fail-closed and are never silently bypassed.
                        import urllib3
                        if isinstance(exc, (OSError, urllib3.exceptions.HTTPError)):
                            transient_error = exc
                            if transport_attempt < 3 and time.monotonic() < deadline:
                                time.sleep(0.5 * (transport_attempt + 1))
                                continue
                            break
                        raise
                if result is not None:
                    break
            if result is None:
                if transient_error is not None:
                    raise transient_error
                raise PublishDataValidationError('图片下载没有可用的已校验地址')
            if result['status'] in {301, 302, 303, 307, 308}:
                location = result['location']
                if not location:
                    raise PublishDataValidationError('图片重定向缺少 Location')
                from urllib.parse import urljoin
                current = urljoin(current, location)
                continue
            raw = result['raw']
            media_type = result['media_type']
            _validate_image_signature(media_type, raw)
            if media_type == 'image/svg+xml':
                raw = _rasterize_svg_for_review(raw)
                media_type = 'image/png'
            media_type, raw = _prepare_raster_for_review(media_type, raw)
            return {
                'media_type': media_type,
                'data': base64.b64encode(raw).decode('ascii'),
            }
        raise PublishDataValidationError('图片重定向次数过多')
    except PublishDataValidationError:
        raise
    except (OSError, ValueError) as exc:
        raise PublishDataValidationError(f'图片下载失败: {exc}') from exc


def _validate_image_signature(media_type, raw):
    svg_signature = False
    if media_type == 'image/svg+xml' and raw:
        try:
            import xml.etree.ElementTree as element_tree
            root = element_tree.fromstring(_sanitize_svg_xml_for_review(raw))
            svg_signature = root.tag.rsplit('}', 1)[-1].lower() == 'svg'
        except (UnicodeDecodeError, element_tree.ParseError):
            svg_signature = False
    signatures = {
        'image/jpeg': raw.startswith(b'\xff\xd8\xff'),
        'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'),
        'image/gif': raw.startswith((b'GIF87a', b'GIF89a')),
        'image/webp': len(raw) >= 12 and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP',
        'image/svg+xml': svg_signature,
    }
    if not raw:
        raise PublishDataValidationError('图片内容为空')
    if not signatures.get(media_type, False):
        raise PublishDataValidationError(f'图片内容与 MIME 签名不一致: {media_type}')


def _sanitize_svg_xml_for_review(raw):
    """Drop only XML-invalid character references from trusted arXiv SVG.

    arXiv occasionally emits numeric references to control characters.  They
    are not renderable XML, but rejecting the entire figure would diverge from
    the Node sanitizer and needlessly block an otherwise safe paper figure.
    Active content is still rejected by ``_rasterize_svg_for_review`` below.
    """
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError:
        raise

    def replace_reference(match):
        token = match.group(1)
        try:
            codepoint = int(token[1:], 16) if token[:1].lower() == 'x' else int(token)
        except ValueError:
            return ''
        valid = (
            codepoint in (0x9, 0xA, 0xD)
            or 0x20 <= codepoint <= 0xD7FF
            or 0xE000 <= codepoint <= 0xFFFD
            or 0x10000 <= codepoint <= 0x10FFFF
        )
        return match.group(0) if valid else ''

    text = re.sub(r'&#(x[0-9A-Fa-f]+|[0-9]+);', replace_reference, text)
    return text.encode('utf-8')


def _prepare_raster_for_review(media_type, raw):
    """Bound decoded raster dimensions before sending bytes to the reviewer."""
    if media_type == 'image/svg+xml':
        return media_type, raw
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(raw)) as source:
            width, height = source.size
            if width <= 0 or height <= 0:
                raise PublishDataValidationError('图片像素尺寸非法')
            if (max(width, height) <= REVIEW_IMAGE_MAX_EDGE
                    and width * height <= REVIEW_IMAGE_MAX_PIXELS):
                rgba = source.convert('RGBA')
                if rgba.getchannel('A').getextrema()[0] == 255:
                    return media_type, raw
                # Review on the same white surface as the reader page. A
                # transparent PNG with black text otherwise appears blank
                # when the model decodes transparency against black.
                background = Image.new('RGB', rgba.size, 'white')
                background.paste(rgba, mask=rgba.getchannel('A'))
                output = io.BytesIO()
                background.save(output, format='PNG')
                prepared = output.getvalue()
                if len(prepared) <= REVIEW_IMAGE_MAX_BYTES:
                    _validate_image_signature('image/png', prepared)
                    return 'image/png', prepared
            scale = min(
                REVIEW_IMAGE_MAX_EDGE / width,
                REVIEW_IMAGE_MAX_EDGE / height,
                math.sqrt(REVIEW_IMAGE_MAX_PIXELS / (width * height)),
            )
            target = (
                max(1, int(width * scale)),
                max(1, int(height * scale)),
            )
            image = ImageOps.exif_transpose(source).convert('RGBA')
            image.thumbnail(target, Image.Resampling.LANCZOS)
            background = Image.new('RGB', image.size, 'white')
            background.paste(image, mask=image.getchannel('A'))
            for quality in (90, 82, 74):
                output = io.BytesIO()
                background.save(
                    output, format='JPEG', quality=quality,
                    optimize=True, progressive=True,
                )
                prepared = output.getvalue()
                if len(prepared) <= REVIEW_IMAGE_MAX_BYTES:
                    _validate_image_signature('image/jpeg', prepared)
                    return 'image/jpeg', prepared
    except PublishDataValidationError:
        raise
    except Exception as exc:
        raise PublishDataValidationError(f'图片审查降采样失败: {exc}') from exc
    raise PublishDataValidationError('图片审查降采样结果超过 8 MiB')


def _rasterize_svg_for_review(raw):
    """Rasterize an untrusted SVG in an isolated, network-blocked browser page."""
    if not raw or len(raw) > REVIEW_IMAGE_MAX_BYTES:
        raise PublishDataValidationError('SVG 为空或超过 8 MiB review 上限')
    raw = _sanitize_svg_xml_for_review(raw)
    _validate_image_signature('image/svg+xml', raw)
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeDecodeError as exc:
        raise PublishDataValidationError('SVG 不是 UTF-8') from exc
    if re.search(r'<!DOCTYPE|<!ENTITY|<\s*(?:script|foreignObject|iframe|object|embed)\b',
                 text, flags=re.IGNORECASE) \
            or re.search(r'\bon[a-z]+\s*=', text, flags=re.IGNORECASE) \
            or re.search(r'(?:href|src)\s*=\s*["\']\s*(?:https?:|file:|//)',
                         text, flags=re.IGNORECASE) \
            or re.search(r'url\(\s*["\']?\s*(?:https?:|file:|//)',
                         text, flags=re.IGNORECASE):
        raise PublishDataValidationError('SVG 含脚本、实体、嵌入对象或外部资源')
    encoded_svg = base64.b64encode(raw).decode('ascii')
    html = (
        '<!doctype html><meta charset="utf-8">'
        '<style>html,body{margin:0;background:#fff}body{display:flex;align-items:flex-start;'
        'justify-content:flex-start}#figure{display:block;max-width:1600px;max-height:1200px}</style>'
        f'<img id="figure" alt="review figure" src="data:image/svg+xml;base64,{encoded_svg}">'
    )
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            launch_options = {'headless': True}
            expected_executable = Path(playwright.chromium.executable_path)
            if not expected_executable.is_file():
                cache_roots = [
                    Path.home() / 'Library' / 'Caches' / 'ms-playwright',
                    Path.home() / '.cache' / 'ms-playwright',
                ]
                candidates = []
                for cache_root in cache_roots:
                    if cache_root.is_symlink() or not cache_root.is_dir():
                        continue
                    for pattern in (
                            'chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell',
                            'chromium_headless_shell-*/chrome-headless-shell-*/headless_shell'):
                        for candidate in cache_root.glob(pattern):
                            resolved = candidate.resolve()
                            try:
                                resolved.relative_to(cache_root.resolve())
                            except ValueError:
                                continue
                            if candidate.is_symlink() or not resolved.is_file() \
                                    or not os.access(resolved, os.X_OK):
                                continue
                            candidates.append(resolved)
                if candidates:
                    launch_options['executable_path'] = str(sorted(candidates)[-1])
            browser = playwright.chromium.launch(**launch_options)
            try:
                context = browser.new_context(
                    viewport={'width': 1600, 'height': 1200},
                    java_script_enabled=False,
                )
                page = context.new_page()
                page.route('**/*', lambda route: route.abort())
                page.set_content(html, wait_until='load', timeout=30_000)
                png = page.locator('#figure').screenshot(
                    type='png', animations='disabled', timeout=30_000,
                )
            finally:
                browser.close()
    except Exception as exc:
        raise PublishDataValidationError(f'SVG 安全栅格化失败: {exc}') from exc
    if not png or len(png) > REVIEW_IMAGE_MAX_BYTES:
        raise PublishDataValidationError('SVG 栅格化结果为空或超过 8 MiB')
    _validate_image_signature('image/png', png)
    return png


_IMAGE_REPO_SUFFIX_MIME = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
}


def _load_review_image_from_local_repo(url):
    """Read our own pre-push image-repository URL from the local worktree.

    Conference review runs before push: generate stages figure bytes into the
    image repository working tree without committing them, while the rendered
    Markdown already cites the canonical raw.githubusercontent main URL.
    Resolving that exact path locally keeps review read-only for both
    repositories and lets the later push commit the very bytes that passed
    review.  Paths outside the image repository (or not staged locally) return
    None so the caller falls back to the pinned remote download.
    """
    match = re.fullmatch(r'https://raw\.githubusercontent\.com/[^/]+/([^/]+)/main/([^?#]+)', url)
    if not match:
        return None
    repo_name, relative = match.groups()
    image_repo = Path(
        os.environ.get('PAPER_DIGEST_IMAGE_REPO',
                       str(Path.home() / 'code' / 'github_repos' / 'audio-paper-digest-images'))
    ).expanduser().resolve()
    if repo_name != image_repo.name or not relative:
        return None
    target = (image_repo / relative).resolve()
    if not target.is_relative_to(image_repo) or target.is_symlink() or not target.is_file():
        return None
    media_type = _IMAGE_REPO_SUFFIX_MIME.get(target.suffix.lower())
    if media_type not in REVIEW_IMAGE_MIME_TYPES:
        return None
    raw = target.read_bytes()
    if not raw or len(raw) > REVIEW_IMAGE_MAX_BYTES:
        raise PublishDataValidationError('本地图片仓图片为空或超过 8 MiB review 上限')
    _validate_image_signature(media_type, raw)
    if media_type == 'image/svg+xml':
        raw = _rasterize_svg_for_review(raw)
        media_type = 'image/png'
    media_type, raw = _prepare_raster_for_review(media_type, raw)
    return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}


def _load_review_image(url):
    if url.startswith('data:'):
        match = re.fullmatch(r'data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)', url)
        if not match:
            raise PublishDataValidationError('图片 data URI 必须是合法 base64')
        media_type = match.group(1).lower()
        if media_type not in REVIEW_IMAGE_MIME_TYPES:
            raise PublishDataValidationError(f'图片 MIME 不受支持: {media_type}')
        try:
            encoded = re.sub(r'\s+', '', match.group(2))
            raw = base64.b64decode(encoded, validate=True)
        except ValueError as exc:
            raise PublishDataValidationError('图片 data URI base64 非法') from exc
        if not raw or len(raw) > REVIEW_IMAGE_MAX_BYTES:
            raise PublishDataValidationError('图片 data URI 为空或超过 8 MiB')
        _validate_image_signature(media_type, raw)
        if media_type == 'image/svg+xml':
            raw = _rasterize_svg_for_review(raw)
            media_type = 'image/png'
        media_type, raw = _prepare_raster_for_review(media_type, raw)
        return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}
    if url.startswith('https://'):
        local_payload = _load_review_image_from_local_repo(url)
        if local_payload is not None:
            return local_payload
        return _download_review_image(url)
    base = BASE_PATH.rstrip('/')
    allowed_prefixes = (
        f'{base}/images/visual-summaries/',
        f'{base}/images/digest-covers/',
        f'{base}/images/papers/',
    )
    if url.startswith(allowed_prefixes):
        parsed = urlparse(url)
        if parsed.query or parsed.fragment or parsed.netloc or parsed.scheme:
            raise PublishDataValidationError('本地视觉摘要 URL 不允许参数、片段或 authority')
        relative_public = parsed.path[len(base) + 1:]
        repo = Path(BLOG_REPO).expanduser().resolve()
        target = (repo / 'static' / relative_public).resolve()
        _path, relative = _manifest_record(target, repo)
        if not relative.startswith((
                'static/images/visual-summaries/', 'static/images/digest-covers/',
                'static/images/papers/')):
            raise PublishDataValidationError('本地图片不属于受控视觉资产目录')
        try:
            raw = target.read_bytes()
        except OSError as exc:
            raise PublishDataValidationError('本地受控图片不可读') from exc
        if len(raw) > REVIEW_IMAGE_MAX_BYTES:
            raise PublishDataValidationError('本地受控图片超过 8 MiB review 上限')
        media_type = 'image/svg+xml' if target.suffix.lower() == '.svg' else 'image/png'
        _validate_image_signature(media_type, raw)
        if media_type == 'image/svg+xml':
            raw = _rasterize_svg_for_review(raw)
            media_type = 'image/png'
        media_type, raw = _prepare_raster_for_review(media_type, raw)
        return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}
    raise PublishDataValidationError('图片 review 只允许 data URI、HTTPS 或受控本地图片 URL')


def _digest_cover_review_expectation(url):
    base = re.escape(BASE_PATH.rstrip('/'))
    match = re.fullmatch(rf'{base}/images/digest-covers/(\d{{4}}-\d{{2}}-\d{{2}})/cover\.png', url)
    if not match:
        return ''
    date_str = validate_publish_date(match.group(1))
    manifest = _load_json_object(
        DIGEST_COVER_MANIFEST_DIR / f'{date_str}.json', '汇总页封面 manifest'
    )
    context = manifest.get('generationContext')
    if not isinstance(context, dict):
        raise PublishDataValidationError('汇总页封面缺少可审查的确定性上下文')
    return (
        '\n  汇总封面必须逐字段匹配以下确定性上下文；标题、热门方向标签/计数、'
        'TOP 10 的顺序/完整英文标题/分数/中文任务标签任一错误或缺失都必须报 error：\n'
        f'```json\n{json.dumps(context, ensure_ascii=False, sort_keys=True)}\n```'
    )


def parse_markdown_images(content):
    """Scan inline images with balanced labels and destinations.

    Only paragraph code spans and top-level fences are excluded; indented
    code and container fences are not generalized here. Quoted titles may contain
    unmatched parentheses; only destination parentheses affect URL balance.
    Broken inline images fail closed; reference labels remain out of scope.
    """
    def is_escaped(position):
        previous = position
        while previous > 0 and content[previous - 1] == '\\':
            previous -= 1
        return (position - previous) % 2 != 0

    def invalid(detail, position):
        raise PublishDataValidationError(
            f'图片 Markdown {detail}（字符位置 {position}）'
        )

    # CommonMark top-level fences: <=3 leading spaces, >=3 matching marks;
    # backticks cannot occur in a backtick fence's info string. An unclosed
    # fence consumes the rest of the document as code, including literal ![.
    fenced_ranges = []
    fence = None
    offset = 0
    for line in content.splitlines(keepends=True):
        if fence:
            close = r' {0,3}' + re.escape(fence[1]) + '{' + str(fence[2]) + r',}[ \t]*\r?\n?$'
            if re.fullmatch(close, line):
                fenced_ranges.append((fence[0], offset + len(line)))
                fence = None
        else:
            opened = re.match(r' {0,3}(`{3,}|~{3,})([^\r\n]*)', line)
            if opened and not (opened.group(1)[0] == '`' and '`' in opened.group(2)):
                fence = (offset, opened.group(1)[0], len(opened.group(1)))
        offset += len(line)
    if fence:
        fenced_ranges.append((fence[0], len(content)))

    images = []
    cursor = 0
    while True:
        start = content.find('![', cursor)
        if start < 0:
            break
        fenced = next((span for span in fenced_ranges if span[0] <= start < span[1]), None)
        if fenced:
            cursor = fenced[1]
            continue
        # Locate code spans only before the next image marker. Once an image
        # is parsed, its complete label/URL/title is consumed, so backticks in
        # those fields cannot accidentally open a code span over later images.
        tick = content.find('`', cursor, start)
        if tick >= 0:
            fenced = next((span for span in fenced_ranges if span[0] <= tick < span[1]), None)
            if fenced:
                cursor = fenced[1]
                continue
            tick_end = tick + 1
            while tick_end < len(content) and content[tick_end] == '`':
                tick_end += 1
            if not is_escaped(tick):
                limit = len(content)
                paragraph_end = re.search(
                    r'(?:\r\n|\r(?!\n)|(?<!\r)\n)(?:[ \t]*(?:\r\n|\r(?!\n)|(?<!\r)\n)| {0,3}(?:#{1,6}(?:[ \t]|(?=\r|\n|$))|'
                    r'>|[-+*][ \t]+(?=\S)|0{0,8}1[.)][ \t]+(?=\S)|'
                    r'(?:-+|\*{3,}|_{3,}|=+)[ \t]*(?=\r|\n|$)))',
                    content[tick_end:],
                )
                if paragraph_end:
                    limit = tick_end + paragraph_end.start()
                for fence_start, _fence_end in fenced_ranges:
                    if tick_end <= fence_start < limit:
                        limit = fence_start
                closing = re.search(
                    r'(?<!`)`{' + str(tick_end - tick) + r'}(?!`)',
                    content[tick_end:limit],
                )
                if closing:
                    cursor = tick_end + closing.end()
                    continue
            cursor = tick_end
            continue
        if is_escaped(start):
            cursor = start + 2
            continue
        depth = 1
        alt_end = start + 2
        escaped = False
        while alt_end < len(content):
            char = content[alt_end]
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '`':
                # Matching code spans are literal label content: brackets
                # inside them do not alter the enclosing image label depth.
                tick_end = alt_end + 1
                while tick_end < len(content) and content[tick_end] == '`':
                    tick_end += 1
                boundary = re.search(r'(?:\r\n|\r(?!\n)|(?<!\r)\n)[ \t]*(?:\r\n|\r(?!\n)|(?<!\r)\n)', content[tick_end:])
                limit = tick_end + boundary.start() if boundary else len(content)
                closing = re.search(
                    r'(?<!`)`{' + str(tick_end - alt_end) + r'}(?!`)',
                    content[tick_end:limit],
                )
                if closing:
                    alt_end = tick_end + closing.end()
                    continue
                # An unmatched delimiter remains literal; its brackets are
                # still parsed normally rather than silently hiding an image.
                alt_end = tick_end
                continue
            elif char == '[':
                depth += 1
            elif char == ']':
                depth -= 1
                if depth == 0:
                    break
            alt_end += 1
        if depth != 0:
            invalid('alt 未闭合', start)
        if content[alt_end + 1:alt_end + 2] != '(':
            cursor = alt_end + 1
            continue
        end = alt_end + 2
        depth = 1
        escaped = False
        angle = False
        title_quote = None
        title_start = None
        title_end = None
        while end < len(content):
            char = content[end]
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif title_quote:
                if char == title_quote:
                    title_quote = None
                    title_end = end
            elif angle:
                if char == '>':
                    angle = False
            elif char == '<' and not content[alt_end + 2:end].strip():
                angle = True
            elif char in ('"', "'") and depth == 1 and content[end - 1:end].isspace():
                if title_start is not None:
                    invalid('存在多个 title', start)
                title_quote = char
                title_start = end
            elif char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
                if depth == 0:
                    break
            end += 1
        if title_quote:
            invalid('title 未闭合', start)
        if angle:
            invalid('尖括号 URL 未闭合', start)
        if depth != 0:
            invalid('URL 括号未闭合', start)
        if title_start is not None:
            if title_end is None or content[title_end + 1:end].strip():
                invalid('title 后存在非法内容', start)
            url = content[alt_end + 2:title_start].strip()
        else:
            # Preserve the previous raw-destination behavior for non-title
            # content, including legacy truncated data URIs. The unchanged
            # loader must still reject invalid bytes/schemes/addresses.
            url = content[alt_end + 2:end].strip()
        if url.startswith('<') and url.endswith('>'):
            url = url[1:-1].strip()
        if not url:
            invalid('URL 为空', start)
        raw = content[start:end + 1]
        images.append({
            'alt': content[start + 2:alt_end], 'url': url,
            'start': start, 'end': end + 1, 'raw': raw,
        })
        cursor = end + 1
    return images


def _linked_image_source_url(content, image_end):
    """Return the outer link target for ``[![alt](local)](official-url)``."""
    suffix = str(content or '')[image_end:]
    match = re.match(r'^\]\((https://[^)]+)\)', suffix)
    return match.group(1).strip() if match else ''


def multimodal_review_images(content, title="", required=False):
    """Send actual image bytes to the routed multimodal publish API."""
    title = plain_title_for_publish(title) if title else title
    image_matches = parse_markdown_images(content)

    if not image_matches:
        return True, []
    # Blog image review follows the same primary model as text review.  This
    # prevents a stale optional analysis-secondary route from silently moving
    # publication review to a different provider or quota.
    if not os.environ.get('PAPER_ANALYZER_MODEL', '').strip():
        return True, []

    img_summary = []
    image_payloads = []
    load_issues = []
    for match_index, match in enumerate(image_matches):
        alt, url = match['alt'], match['url']
        previous_end = image_matches[match_index - 1]['end'] if match_index else 0
        next_start = (
            image_matches[match_index + 1]['start']
            if match_index + 1 < len(image_matches) else len(content)
        )
        before = content[max(previous_end, match['start'] - 600):match['start']]
        after = content[match['end']:min(next_start, match['end'] + 600)]
        nearby = (before + match['raw'] + after).strip()
        try:
            image_payload = _load_review_image(url)
        except PublishDataValidationError as exc:
            # Fresh-source production pages may intentionally omit persisted
            # Figure assets while retaining the exact official HTTPS target
            # in the surrounding Markdown link.  Review that bound source
            # instead of treating the absent local projection as a content
            # failure; all HTTPS source gates still apply in _load_review_image.
            image_payload = None
            fallback_url = _linked_image_source_url(content, match['end'])
            if fallback_url:
                try:
                    image_payload = _load_review_image(fallback_url)
                except PublishDataValidationError:
                    image_payload = None
                if image_payload is not None:
                    url = fallback_url
            if image_payload is not None:
                pass
            else:
                load_issues.append({
                    'severity': 'error' if required else 'warning',
                    'description': f'无法加载图片内容用于多模态 review: {exc}',
                })
                continue
        # Keep prompt metadata and attached bytes in the same append path.
        # A failed download must not shift later images onto earlier contexts.
        image_payloads.append(image_payload)
        cover_expectation = _digest_cover_review_expectation(url)
        img_summary.append(
            f"- 图片 {len(img_summary) + 1} | alt: `{alt}` | 来源: {url[:500]}\n"
            f"  正文附近上下文：\n```markdown\n{nearby}\n```{cover_expectation}"
        )

    if load_issues and required:
        return False, load_issues
    if not image_payloads:
        return (not required), load_issues

    prompt = f"""你是一个博客图片质量审查专家。

请审查下面这篇博客中的图片引用是否合理。

【重要】本请求已按列表顺序附上实际图片字节，以下是正文中提取的对应元数据：
- 博客正文中的实际图片格式为标准 Markdown：`![alt](url)`
- 摘要中的格式（如"外部图片: url | alt: ..."）只是元数据展示，**不要**因为摘要格式而误判
- 摘要中的 URL 可能为了简洁而截断，但博客正文中的 URL 是完整的
- 如果博客正文中所有图片都使用 `![alt](url)` 格式，则格式检查项应视为通过
- 发布清洗器可能把远程图包成自链接 `[![alt](url)](url)`；内层仍是标准图片语法，这种等 URL 外层链接是合法的，不要报“普通链接格式错误”

博客标题：{title}
图片元数据摘要：
{chr(10).join(img_summary)}

请检查：
1. 图片内容是否可解码、清晰且与 alt 和论文正文语义一致
2. 图片是否包含明显错误、空白、损坏、无关内容或隐私信息
3. 图片 alt 文本是否为空、重复或与实际内容冲突
4. 若图片是汇总封面，必须逐字段核对所附确定性上下文；标题、热门方向、计数、TOP 10 顺序、完整英文标题、分数和任务标签不一致均为 error

【禁止事项】不要报告以下伪问题：
- 摘要格式（如"外部图片: url | alt: ..."）不是 Markdown 格式 → 这是正常的元数据摘要
- 摘要中 URL 被截断 → 博客正文中的 URL 是完整的
- 图片 alt 文本仅为"图1""图2"等编号 → 这在学术博客中是可以接受的

请以 JSON 格式返回：
{{
  "passed": true/false,
  "issues": [
    {{
      "severity": "error/warning/info",
      "description": "问题描述"
    }}
  ]
}}"""

    prompt += """

协议一致性要求：只有存在 `severity=error` 的问题时 `passed` 才能为 `false`；仅有 warning/info 或无问题时必须为 `true`。`passed=false` 时必须提供至少一条具体的 error 级原因。
"""

    summary_blob = chr(10).join(img_summary)

    def review_image_batch(batch_prompt, batch_images, context):
        result = call_llm_api(
            batch_prompt,
            max_tokens=get_blog_review_max_tokens(),
            temperature=0.1,
            required=required,
            context=context,
            images=batch_images,
            use_secondary=False,
            structured_output=True,
        )
        if not result:
            if required:
                return review_protocol_failure(context, '响应为空')
            return True, []
        cleaned = result
        try:
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            if cleaned.startswith("```"):
                cleaned = cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            review = parse_review_json(cleaned)
            return validate_review_payload(
                review,
                required=required,
                context=context,
            )
        except (json.JSONDecodeError, TypeError, ValueError):
            fallback = cleaned.strip()
            if required:
                return repair_review_payload(
                    result,
                    context,
                    use_secondary=False,
                    retry_prompt=batch_prompt,
                    retry_images=batch_images,
                )
            lower = fallback.lower()
            error_markers = ['error', '错误', '阻断', '不合理', '无法渲染', '过长', '空 alt', '重复 alt']
            pass_markers = ['passed', '"passed": true', '通过', '无问题', '没有问题', '未发现问题']
            if any(marker in lower for marker in error_markers):
                return False, [{
                    "severity": "error",
                    "description": f"{context} 返回非 JSON，但文本中包含错误信号：{fallback[:240]}"
                }]
            if any(marker in lower for marker in pass_markers):
                return True, []
            return True, []

    passed_all = True
    all_issues = list(load_issues)
    # One image per request keeps the configured proxy upload bounded while
    # preserving exact image/context alignment and full per-page coverage.
    for index, (summary, image_payload) in enumerate(zip(img_summary, image_payloads), 1):
        batch_prompt = prompt.replace(summary_blob, summary, 1)
        passed, issues = review_cached_unit(
            'image', {'prompt': batch_prompt, 'images': [image_payload], 'required': required},
            lambda: review_image_batch(
                batch_prompt, [image_payload],
                f"多模态图片 review: {title} [图 {index}/{len(image_payloads)}]",
            ),
        )
        passed_all = passed_all and passed
        all_issues.extend(issues)
    return passed_all, all_issues


def apply_llm_fixes(content, issues):
    """只应用唯一、有边界的精确替换，拒绝 LLM 自由全文改写。"""
    if not issues:
        return content

    fixed = content
    fix_count = 0
    for issue in issues:
        if not issue.get("auto_fixable", False):
            continue
        instruction = issue.get("fix_instruction", "")
        if not instruction:
            continue

        # 解析简单替换指令："将 A 改为 B" 或 "replace A with B"
        replace_patterns = [
            r'将\s*[\"\']?(.+?)[\"\']?\s*改为\s*[\"\']?(.+?)[\"\']?\s*$',
            r'replace\s*[\"\']?(.+?)[\"\']?\s*with\s*[\"\']?(.+?)[\"\']?\s*$',
            r'把\s*[\"\']?(.+?)[\"\']?\s*替换成\s*[\"\']?(.+?)[\"\']?\s*$',
        ]
        for pattern in replace_patterns:
            match = re.match(pattern, instruction, re.IGNORECASE)
            if match:
                old, new = match.group(1), match.group(2)
                # 自动修复必须是唯一 span；常见词、标点或大段改写一律留给下轮 review。
                if (
                    old != new
                    and len(old) >= 4
                    and len(old) <= 500
                    and len(new) <= 1000
                    and '\n---\n' not in old
                    and fixed.count(old) == 1
                ):
                    fixed = fixed.replace(old, new, 1)
                    fix_count += 1
                    break

    return fixed


def slugify(text, max_length=50):
    """将标题转换为 URL 友好的 slug（保留中文、英文、数字）"""
    text = text.lower()
    # 保留中文(\u4e00-\u9fff)、日文假名、韩文、英文、数字、空格和连字符
    text = re.sub(r"[^\u4e00-\u9fff\u3005\u3007\u3021-\u3029\u3038-\u303b\uff10-\uff19\uff21-\uff3a\uff41-\uff5aa-z0-9\s-]", '', text)
    # 将空白和连续连字符替换为单个连字符
    text = re.sub(r'[\s-]+', '-', text)
    text = text.strip('-')
    if len(text) > max_length:
        text = text[:max_length].rsplit('-', 1)[0]
    # 如果过滤后为空（极少数情况），返回 "paper" 作为兜底
    return text if text else 'paper'


def normalize_arxiv_id(arxiv_id):
    """Normalize an arXiv identifier for stable, traversal-safe filenames."""
    return normalize_publish_arxiv_id(arxiv_id)


def _validate_publish_image_exclusion(entry, label='发布图片排除项'):
    """Validate and canonicalize one publication-only image exclusion."""
    if not isinstance(entry, dict) or set(entry) != {
        'normalizedArxivId', 'url', 'reason',
    }:
        raise PublishDataValidationError(
            f'{label}必须且只能包含 normalizedArxivId/url/reason'
        )
    raw_id = entry.get('normalizedArxivId')
    normalized_id = normalize_publish_arxiv_id(raw_id)
    if raw_id != normalized_id:
        raise PublishDataValidationError(
            f'{label}.normalizedArxivId 必须已规范化且不含版本号: {raw_id!r}'
        )
    url = entry.get('url')
    if not isinstance(url, str) or not url or url != url.strip() or re.search(r'[\x00-\x20]', url):
        raise PublishDataValidationError(f'{label}.url 必须是无空白的精确 HTTPS URL')
    try:
        parsed_url = urlparse(url)
        _ = parsed_url.port
    except (AttributeError, TypeError, ValueError) as exc:
        raise PublishDataValidationError(f'{label}.url 非法: {url!r}') from exc
    if (
        parsed_url.scheme != 'https'
        or not parsed_url.hostname
        or parsed_url.username is not None
        or parsed_url.password is not None
    ):
        raise PublishDataValidationError(
            f'{label}.url 必须是无 userinfo 的精确 HTTPS URL: {url!r}'
        )
    reason = entry.get('reason')
    if not isinstance(reason, str) or not reason.strip():
        raise PublishDataValidationError(f'{label}.reason 必须是非空字符串')
    return {
        'normalizedArxivId': normalized_id,
        'url': url,
        'reason': reason.strip(),
    }


def load_publish_image_exclusions(config_path=None):
    """Load the narrow, checked-in publication image override contract."""
    path = Path(config_path or PUBLISH_IMAGE_EXCLUSIONS_PATH)
    payload = _load_json_object(path, '发布图片排除配置')
    if set(payload) != {'schemaVersion', 'exclusions'}:
        raise PublishDataValidationError(
            '发布图片排除配置必须且只能包含 schemaVersion/exclusions'
        )
    if payload.get('schemaVersion') != PUBLISH_IMAGE_EXCLUSIONS_SCHEMA_VERSION:
        raise PublishDataValidationError('发布图片排除配置 schemaVersion 非法')
    raw_entries = payload.get('exclusions')
    if not isinstance(raw_entries, list):
        raise PublishDataValidationError('发布图片排除配置 exclusions 必须是数组')
    entries = [
        _validate_publish_image_exclusion(item, f'发布图片排除项[{index}]')
        for index, item in enumerate(raw_entries)
    ]
    keys = [(item['normalizedArxivId'], item['url']) for item in entries]
    if len(keys) != len(set(keys)):
        raise PublishDataValidationError('发布图片排除配置包含重复 normalizedArxivId + URL')
    return sorted(entries, key=lambda item: (item['normalizedArxivId'], item['url']))


def _is_plain_publish_image_paragraph(paragraph, max_length):
    """Return a short prose paragraph only; never admit Markdown structure."""
    value = str(paragraph or '').strip()
    return bool(
        value
        and len(value) <= max_length
        and not re.match(r'^(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|!\[)', value)
    )


def _is_publish_image_lead_paragraph(paragraph):
    """Recognize only an explicit, sentence-final pointer to the following figure."""
    value = str(paragraph or '').strip()
    if not _is_plain_publish_image_paragraph(value, 500):
        return False
    return bool(re.search(
        r'(?:如下图所示|(?:请)?参见下图|见下图|如下图|'
        r'如图\s*(?:\d+(?:[.-]\d+)*|[一二三四五六七八九十]+)?\s*所示)'
        r'[。！？.!?）)]*$',
        value,
    ))


def _is_publish_image_explanation_paragraph(paragraph):
    """Recognize only a deictic explanation that explicitly describes that figure."""
    value = str(paragraph or '').strip()
    if not _is_plain_publish_image_paragraph(value, 1000):
        return False
    return bool(re.match(
        r'^(?:下图|上图|该图|此图|图中|图\s*(?:\d+(?:[.-]\d+)*|'
        r'[一二三四五六七八九十]+))\s*(?:则|中|所)?\s*'
        r'(?:展示|显示|说明|对比|呈现|描绘|概述|给出|总结|揭示|可视化)',
        value,
    ))


def _strip_publish_image_lead_context(paragraph):
    """Remove a bridge lead while preserving an immediately preceding heading."""
    value = str(paragraph or '').strip()
    if _is_publish_image_lead_paragraph(value):
        return ''
    heading_and_body = re.fullmatch(r'(#{1,6}\s+[^\n]+)\n+([\s\S]+)', value)
    if (
        heading_and_body
        and _is_publish_image_lead_paragraph(heading_and_body.group(2))
    ):
        return heading_and_body.group(1).strip()
    return None


def _remove_publish_image_block(content, exact_url, insertion_plan=None):
    """Remove one exact image and only high-confidence adjacent bridge prose."""
    if not isinstance(content, str) or exact_url not in content:
        return content
    paragraphs = re.split(r'\n(?:[ \t]*\n)+', content.strip())
    image_pattern = re.compile(
        rf'^[ \t]*!\[[^\n]*\]\({re.escape(exact_url)}\)[ \t]*$'
    )
    inline_pattern = re.compile(
        rf'!\[[^\]\n]*\]\({re.escape(exact_url)}\)'
    )
    remove = set()
    exact_lead = re.sub(r'\s+', ' ', str((insertion_plan or {}).get('lead') or '')).strip()
    exact_explanation = re.sub(
        r'\s+', ' ', str((insertion_plan or {}).get('explanation') or ''),
    ).strip()
    for index, paragraph in enumerate(paragraphs):
        if image_pattern.fullmatch(paragraph):
            remove.add(index)
            if index > 0:
                normalized_previous = re.sub(r'\s+', ' ', paragraphs[index - 1]).strip()
                stripped_lead = _strip_publish_image_lead_context(paragraphs[index - 1])
                if exact_lead and normalized_previous == exact_lead:
                    remove.add(index - 1)
                elif exact_lead:
                    heading_and_body = re.fullmatch(
                        r'(#{1,6}\s+[^\n]+)\n+([\s\S]+)', paragraphs[index - 1].strip(),
                    )
                    if heading_and_body and re.sub(
                            r'\s+', ' ', heading_and_body.group(2),
                    ).strip() == exact_lead:
                        paragraphs[index - 1] = heading_and_body.group(1).strip()
                    elif stripped_lead == '':
                        remove.add(index - 1)
                    elif stripped_lead is not None:
                        paragraphs[index - 1] = stripped_lead
                elif stripped_lead == '':
                    remove.add(index - 1)
                elif stripped_lead is not None:
                    paragraphs[index - 1] = stripped_lead
            if index + 1 < len(paragraphs):
                normalized_next = re.sub(r'\s+', ' ', paragraphs[index + 1]).strip()
                if (exact_explanation and normalized_next == exact_explanation) \
                        or _is_publish_image_explanation_paragraph(paragraphs[index + 1]):
                    remove.add(index + 1)
        elif inline_pattern.search(paragraph):
            paragraphs[index] = inline_pattern.sub('', paragraph).strip()
    return '\n\n'.join(
        paragraph for index, paragraph in enumerate(paragraphs)
        if index not in remove and paragraph
    ).strip()


def _remove_api_reader_figure_block(content, exact_url):
    """Remove one reader image, its v3 focus path, and generated caption."""
    paragraphs = re.split(r'\n(?:[ \t]*\n)+', str(content or '').strip())
    image_pattern = re.compile(
        rf'^[ \t]*!\[(?:\\.|[^\]\\\n])*\]\({re.escape(exact_url)}\)[ \t]*$'
    )
    remove = set()
    for index, paragraph in enumerate(paragraphs):
        if not image_pattern.fullmatch(paragraph):
            continue
        remove.add(index)
        if index > 0 and re.fullmatch(
                r'>\s*\*\*看图路径：\*\*[\s\S]+', paragraphs[index - 1].strip()):
            remove.add(index - 1)
        if index + 1 < len(paragraphs) and re.fullmatch(
                r'[ *_]*论文图\s*\d+[\s\S]*?[ *_]*', paragraphs[index + 1].strip()):
            remove.add(index + 1)
    cleaned = '\n\n'.join(
        paragraph for index, paragraph in enumerate(paragraphs)
        if index not in remove and paragraph
    ).strip()
    if exact_url in cleaned or not remove:
        raise PublishDataValidationError(
            f'API reader 发布图片排除未能精确移除正文图片: {exact_url}'
        )
    return cleaned


def apply_publish_image_exclusions(papers, exclusions=None):
    """Attach overrides and sanitize one derived analysis/parsed publication view.

    ``score_and_sort()`` deliberately reparses ``analysis`` instead of trusting a
    cached ``parsed`` object.  The publication-only analysis copy therefore has
    to be cleaned together with its parsed projection; otherwise the summary
    page reparses the original image back into the rendered output while the
    single-paper page uses the cleaned cache.
    """
    exclusions = load_publish_image_exclusions() if exclusions is None else [
        _validate_publish_image_exclusion(item)
        for item in exclusions
    ]
    by_id = {}
    seen = set()
    for entry in exclusions:
        key = (entry['normalizedArxivId'], entry['url'])
        if key in seen:
            raise PublishDataValidationError('发布图片排除项包含重复 normalizedArxivId + URL')
        seen.add(key)
        by_id.setdefault(key[0], []).append(entry)

    prepared = []
    for paper in papers:
        normalized_id = normalize_publish_arxiv_id(paper.get('arxivId'))
        next_paper = copy.deepcopy(paper)
        active = [dict(item) for item in by_id.get(normalized_id, [])]
        contracts = next_paper.get('analysisManifest', {}).get('contracts', {})
        api_reader_structured = contracts.get(
            'apiReaderArticle'
        ) in LLM_API_READER_STRUCTURED_CONTRACTS
        if active and api_reader_structured:
            analysis = next_paper.get('analysis')
            article = next_paper.get('apiReaderArticle')
            plan = next_paper.get('apiReaderPlan')
            figures = next_paper.get('apiReaderFigures')
            manifest = next_paper.get('analysisManifest')
            stage = manifest.get('stages', {}).get('apiReaderArticle') \
                if isinstance(manifest, dict) else None
            if not isinstance(analysis, str) or not analysis.strip() \
                    or not isinstance(article, str) or not article.strip() \
                    or not isinstance(plan, dict) \
                    or not isinstance(plan.get('figurePlacements'), list) \
                    or not isinstance(figures, list) or not isinstance(stage, dict):
                raise PublishDataValidationError(
                    f'{normalized_id} API reader v2 缺少可派生的正文/figure/stage'
                )
            source_analysis_sha256 = _javascript_string_sha256(analysis)
            source_article_sha256 = _javascript_string_sha256(article)
            source_figures_sha256 = _stable_json_sha256(figures)
            figure_urls = [
                item.get('url') for item in figures if isinstance(item, dict)
            ]
            excluded_urls = [item['url'] for item in active]
            missing_urls = [url for url in excluded_urls if url not in figure_urls]
            source_candidate_urls = {
                item.get('url')
                for source_manifest in (
                    next_paper.get('imageManifest'),
                    next_paper.get('analysisRecoveryImageManifest'),
                )
                if isinstance(source_manifest, dict)
                for item in source_manifest.get('candidates', [])
                if isinstance(item, dict) and isinstance(item.get('url'), str)
            }
            unresolved_missing = [
                url for url in missing_urls
                if url in article or url not in source_candidate_urls
            ]
            if unresolved_missing:
                raise PublishDataValidationError(
                    f'{normalized_id} API reader 发布图片排除未命中 canonical figure: '
                    + ', '.join(unresolved_missing)
                )
            bound_exclusions = [
                exclusion for exclusion in active
                if exclusion['url'] in figure_urls
            ]
            excluded_ordinals = {
                item.get('ordinal') for item in figures
                if item.get('url') in excluded_urls
            }
            for exclusion in bound_exclusions:
                article = _remove_api_reader_figure_block(article, exclusion['url'])
            figures = [item for item in figures if item.get('url') not in excluded_urls]
            plan = copy.deepcopy(plan)
            plan['figurePlacements'] = [
                item for item in plan['figurePlacements']
                if item.get('figureOrdinal') not in excluded_ordinals
            ]
            article_sha256 = _javascript_string_sha256(article)
            plan_sha256 = _stable_json_sha256(plan)
            figures_sha256 = _stable_json_sha256(figures)
            next_paper['apiReaderArticle'] = article
            next_paper['apiReaderArticleSha256'] = article_sha256
            next_paper['apiReaderPlan'] = plan
            next_paper['apiReaderPlanSha256'] = plan_sha256
            next_paper['apiReaderFigures'] = figures
            stage['articleSha256'] = article_sha256
            stage['planSha256'] = plan_sha256
            stage['figureCount'] = len(figures)
            stage['figuresSha256'] = figures_sha256
            image_stage = manifest.get('stages', {}).get('imageSupplement')
            if isinstance(image_stage, dict) \
                    and image_stage.get('reason') in {
                        'api_reader_v2_official_figures_bound',
                        'api_reader_v3_official_figures_bound',
                    }:
                image_stage['officialFigureCount'] = len(figures)
                image_stage['officialFiguresSha256'] = figures_sha256
            selected = next_paper.get('selectedImageUrls')
            if not isinstance(selected, list):
                selected = []
                next_paper['selectedImageUrls'] = selected
            next_paper[PUBLISH_IMAGE_EXCLUSIONS_FIELD] = active
            next_paper[PUBLISH_IMAGE_VIEW_FIELD] = {
                'version': 2,
                'sourceAnalysisSha256': source_analysis_sha256,
                'analysisSha256': source_analysis_sha256,
                'sourceApiReaderArticleSha256': source_article_sha256,
                'apiReaderArticleSha256': article_sha256,
                'sourceApiReaderFiguresSha256': source_figures_sha256,
                'apiReaderFiguresSha256': figures_sha256,
                'excludedUrls': excluded_urls,
                'effectiveSelectedImageUrls': list(selected),
                'effectiveApiReaderFigureUrls': [item['url'] for item in figures],
                'imageNarrativeContract': 'context-bound-v1',
            }
        elif active:
            analysis = next_paper.get('analysis')
            if not isinstance(analysis, str) or not analysis.strip():
                raise PublishDataValidationError(
                    f'{normalized_id} 缺少可派生发布快照的 analysis'
                )
            source_analysis_sha256 = _javascript_string_sha256(analysis)
            image_manifest = next_paper.get('imageManifest') or {}
            plans = image_manifest.get('insertionPlan') or []
            selected_manifest = image_manifest.get('selected') or []
            plan_by_url = {}
            for position, selected in enumerate(selected_manifest):
                if not isinstance(selected, dict) or not isinstance(selected.get('url'), str):
                    continue
                image_number = selected.get('index', position + 1)
                plan_by_url[selected['url']] = next((
                    plan for plan in plans
                    if isinstance(plan, dict) and plan.get('imageNumber') == image_number
                ), None)
            for exclusion in active:
                analysis = _remove_publish_image_block(
                    analysis, exclusion['url'], plan_by_url.get(exclusion['url']),
                )
            next_paper['analysis'] = analysis

            parsed = dict(next_paper.get('parsed') or {})
            for key, value in list(parsed.items()):
                if not isinstance(value, str):
                    continue
                for exclusion in active:
                    value = _remove_publish_image_block(
                        value, exclusion['url'], plan_by_url.get(exclusion['url']),
                    )
                parsed[key] = value
            next_paper['parsed'] = parsed
            selected_urls = next_paper.get('selectedImageUrls')
            if not isinstance(selected_urls, list):
                selected_urls = [
                    item.get('url') for item in selected_manifest
                    if isinstance(item, dict) and isinstance(item.get('url'), str)
                ]
            excluded_urls = {item['url'] for item in active}
            next_paper['selectedImageUrls'] = [
                url for url in selected_urls if url not in excluded_urls
            ]
            next_paper[PUBLISH_IMAGE_EXCLUSIONS_FIELD] = active
            next_paper[PUBLISH_IMAGE_VIEW_FIELD] = {
                'version': 1,
                'sourceAnalysisSha256': source_analysis_sha256,
                'analysisSha256': _javascript_string_sha256(analysis),
                'excludedUrls': [item['url'] for item in active],
                'effectiveSelectedImageUrls': list(
                    next_paper.get('selectedImageUrls') or []
                ),
                'imageNarrativeContract': 'context-bound-v1',
            }
        else:
            next_paper.pop(PUBLISH_IMAGE_EXCLUSIONS_FIELD, None)
            next_paper.pop(PUBLISH_IMAGE_VIEW_FIELD, None)
        prepared.append(next_paper)
    return prepared


def paper_slug(title, arxiv_id):
    id_suffix = normalize_arxiv_id(arxiv_id).replace('/', '-').replace('.', '-')
    return f'{slugify(title, max_length=50)}-{id_suffix}'


def yaml_escape(s):
    """安全转义 YAML 双引号字符串中的特殊字符，同时避免 f-string 解析问题"""
    if not s:
        return ''
    # 标题/描述里的短 LaTeX 片段保留内部文本，避免 Best-of-$N$ 变成 Best-of-。
    s = re.sub(r'\\\(([^)]+)\\\)', r'\1', s)
    s = re.sub(r'\\\[([^\]]+)\\\]', r'\1', s)
    s = re.sub(r'\$\$([^$]*?)\$\$', r'\1', s)
    s = re.sub(r'\$([^\s\$][^$]*?)\$', r'\1', s)
    return (s.replace('\\', '\\\\')
             .replace('"', '\\"')
             .replace('\n', ' ')
             .replace('{', '{{')
             .replace('}', '}}'))


def _validated_workbench_text(
        value, label, *, maximum, allow_empty=False, preserve_newlines=False):
    if not isinstance(value, str):
        raise PublishDataValidationError(f'{label} 必须是字符串')
    if '\r' in value:
        raise PublishDataValidationError(f'{label} 禁止 CR/CRLF；只允许规范 LF')
    # The abstract sidecar is evidence: keep its exact Unicode code points and
    # LF layout. Short presentation fields are normalized to stable NFC.
    value = value if preserve_newlines else unicodedata.normalize('NFC', value)
    for character in value:
        category = unicodedata.category(character)
        if category == 'Cs' or (
                category == 'Cc'
                and not (preserve_newlines and character == '\n')):
            raise PublishDataValidationError(f'{label} 包含控制字符或非法代理项')
    normalized = value if preserve_newlines else re.sub(r'\s+', ' ', value).strip()
    if not allow_empty and not normalized.strip():
        raise PublishDataValidationError(f'{label} 不能为空')
    if len(normalized) > maximum:
        raise PublishDataValidationError(f'{label} 超过 {maximum} 字符上限')
    return normalized


def _workbench_authors(paper, api_reader_payload=None):
    reader_authors = (
        api_reader_payload.get('readerAuthors')
        if isinstance(api_reader_payload, dict) else None
    )
    source = reader_authors.get('authors') \
        if isinstance(reader_authors, dict) else paper.get('authors')
    if not isinstance(source, list) or not source:
        raise PublishDataValidationError('researcher workbench 缺少结构化作者来源')
    authors = []
    for index, item in enumerate(source):
        if isinstance(item, str):
            name = item
            affiliations = []
        elif isinstance(item, dict):
            if not isinstance(item.get('name'), str):
                raise PublishDataValidationError(
                    f'researcher workbench 第 {index + 1} 位作者缺少姓名'
                )
            name = item['name']
            affiliations = item.get('affiliations', [])
            if not isinstance(affiliations, list):
                raise PublishDataValidationError(
                    f'researcher workbench 第 {index + 1} 位作者机构必须是数组'
                )
        else:
            raise PublishDataValidationError(
                f'researcher workbench 第 {index + 1} 位作者格式非法'
            )
        name = _validated_workbench_text(
            name, f'researcher workbench 作者 {index + 1} 姓名', maximum=500,
        )
        clean_affiliations = [
            _validated_workbench_text(
                affiliation,
                f'researcher workbench 作者 {index + 1} 机构 {affiliation_index + 1}',
                maximum=1000,
            )
            for affiliation_index, affiliation in enumerate(affiliations)
        ]
        if len(clean_affiliations) != len(set(clean_affiliations)):
            raise PublishDataValidationError(
                f'researcher workbench 第 {index + 1} 位作者机构重复'
            )
        authors.append({'name': name, 'affiliations': clean_affiliations})
    if len(authors) > 1000:
        raise PublishDataValidationError('researcher workbench 作者超过 1000 人上限')
    return authors


def _researcher_workbench_eligible(v6_payload, api_reader_payload):
    return bool(
        isinstance(v6_payload, dict)
        or (
            isinstance(api_reader_payload, dict)
            and api_reader_payload.get('contract') == LLM_API_READER_CONTRACT
        )
    )


_BIBTEX_ESCAPE = {
    '\\': r'{\textbackslash{}}', '{': r'\{', '}': r'\}', '&': r'\&',
    '%': r'\%', '$': r'\$', '#': r'\#', '_': r'\_', '~': r'\textasciitilde{}',
    '^': r'\textasciicircum{}',
}


def _bibtex_escape(value, label):
    value = _validated_workbench_text(value, label, maximum=10000)
    return ''.join(_BIBTEX_ESCAPE.get(character, character) for character in value)


def _json_sidecar_bytes(value):
    raw = (json.dumps(
        value, ensure_ascii=False, sort_keys=True, indent=2,
    ) + '\n').encode('utf-8')
    if b'\r' in raw or len(raw) > RESEARCHER_SIDECAR_MAX_BYTES:
        raise PublishDataValidationError('researcher JSON sidecar 非规范或超过 256 KiB')
    return raw


def _researcher_sidecar_relative_root(date_str, base_id):
    validated_date = validate_publish_date(date_str)
    safe_id = base_id.replace('/', '-').replace('.', '-')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]*[a-z0-9]', safe_id):
        raise PublishDataValidationError(f'arXiv ID 无法形成安全 sidecar 路径: {base_id}')
    return RESEARCHER_SIDECAR_RELATIVE_ROOT / validated_date / safe_id


def _researcher_public_url(relative):
    relative = Path(relative)
    if relative.is_absolute() or relative.parts[:1] != ('static',) or '..' in relative.parts:
        raise PublishDataValidationError(f'researcher sidecar URL 路径非法: {relative}')
    base_path = str(BASE_PATH or '').rstrip('/')
    if not re.fullmatch(r'/[A-Za-z0-9._~!$&\'()*+,;=:@%/-]*', base_path) \
            or '//' in base_path or '/./' in f'{base_path}/' or '/../' in f'{base_path}/':
        raise PublishDataValidationError('PAPER_DIGEST_BLOG_BASE_PATH 不是安全站内路径')
    return f'{base_path}/{relative.relative_to("static").as_posix()}'


def build_tag_catalog_snapshot(tag_catalog=None):
    """根据只读词表生成博客搜索使用的精简快照。

    每个概念保留 id、facet、中英文名称和别名，ancestorIds 按从最高层到直接上级的顺序记录。
    博客可据此按上级概念查询论文，或用别名匹配标签，无需在浏览器中重新推导标签含义和层级。
    """
    registry = _PAGE_TAG_CATALOG if tag_catalog is None else tag_catalog
    if not isinstance(registry, dict):
        raise PublishDataValidationError('生成标签词表快照的输入必须是对象。')
    registry_sha256 = registry.get('registrySha256')
    if not isinstance(registry_sha256, str) or not re.fullmatch(r'[0-9a-f]{64}', registry_sha256):
        raise PublishDataValidationError('标签词表快照缺少有效的 registrySha256。')
    registry_version = registry.get('version')
    if not isinstance(registry_version, str) or not registry_version:
        raise PublishDataValidationError('标签词表快照缺少有效的版本名称。')
    concepts = registry.get('concepts')
    if not isinstance(concepts, list) or not concepts:
        raise PublishDataValidationError('标签词表快照缺少非空的概念列表。')
    records = {}
    ordered = []
    for concept in concepts:
        if not isinstance(concept, dict):
            raise PublishDataValidationError('标签词表快照中的每个概念都必须是对象。')
        concept_id = concept.get('id')
        preferred = concept.get('preferredLabel')
        aliases = concept.get('aliases')
        if (not isinstance(concept_id, str) or not concept_id or concept_id in records
                or not isinstance(concept.get('facet'), str) or not concept.get('facet')
                or not isinstance(preferred, dict)
                or not isinstance(preferred.get('zh'), str) or not preferred.get('zh')
                or not isinstance(preferred.get('en'), str) or not preferred.get('en')
                or not isinstance(aliases, list)
                or any(not isinstance(alias, str) or not alias for alias in aliases)):
            raise PublishDataValidationError(
                f'标签词表快照中的概念无效：{concept_id!r}'
            )
        record = {
            'id': concept_id,
            'facet': concept['facet'],
            'zh': preferred['zh'],
            'en': preferred['en'],
            'aliases': list(aliases),
            'ancestorIds': [],
        }
        for field in ('definition', 'scopeNote', 'status'):
            value = concept.get(field)
            if value is not None:
                if not isinstance(value, str) or not value:
                    raise PublishDataValidationError(f'标签概念 {concept_id} 的 {field} 必须是非空字符串。')
                record[field] = value
        records[concept_id] = (record, concept)
        ordered.append(record)
    for record, concept in records.values():
        chain = []
        seen = {concept['id']}
        parent_id = concept.get('broaderId')
        while parent_id is not None:
            parent = records.get(parent_id)
            if parent is None or parent_id in seen:
                raise PublishDataValidationError(
                    f'标签概念 {concept["id"]} 的上级概念缺失，或上级关系存在循环。'
                )
            seen.add(parent_id)
            chain.append(parent_id)
            parent_id = parent[1].get('broaderId')
        record['ancestorIds'] = list(reversed(chain))
    return {
        'contract': TAG_CATALOG_SNAPSHOT_CONTRACT,
        'registryVersion': registry_version,
        'registrySha256': registry_sha256,
        'concepts': ordered,
    }


def tag_catalog_snapshot_bytes(snapshot):
    """按固定 JSON 格式生成不含时间戳的字节；相同快照会生成相同文件。"""
    if not isinstance(snapshot, dict):
        raise PublishDataValidationError('标签词表快照必须是对象。')
    return (
        json.dumps(snapshot, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        + '\n'
    ).encode('utf-8')


def _validate_tag_catalog_snapshot(snapshot):
    """核验已保存词表快照的格式和上级关系，不补造缺失的上级概念。"""
    if (not isinstance(snapshot, dict)
            or snapshot.get('contract') != TAG_CATALOG_SNAPSHOT_CONTRACT
            or not re.fullmatch(r'[0-9a-f]{64}', str(snapshot.get('registrySha256') or ''))
            or not isinstance(snapshot.get('registryVersion'), str)
            or not snapshot['registryVersion']
            or not isinstance(snapshot.get('concepts'), list) or not snapshot['concepts']):
        raise PublishDataValidationError('保存的标签词表快照格式无效，或缺少协议、版本、SHA 或概念列表。')
    by_id = {}
    facets = {'task', 'method', 'setting', 'signal', 'application', 'research_focus',
              'artifact', 'scientific_topic', 'model_family'}
    for node in snapshot['concepts']:
        if not isinstance(node, dict):
            raise PublishDataValidationError('保存的标签词表快照中的每个概念都必须是对象。')
        concept_id = node.get('id')
        facet = node.get('facet')
        if (not isinstance(concept_id, str)
                or not re.fullmatch(r'[a-z][a-z0-9_]*\.[a-z0-9][a-z0-9.-]*', concept_id)
                or concept_id in by_id or facet not in facets
                or not concept_id.startswith(f'{facet}.')
                or not isinstance(node.get('zh'), str) or not node['zh']
                or not isinstance(node.get('en'), str) or not node['en']
                or not isinstance(node.get('aliases'), list)
                or any(not isinstance(value, str) or not value for value in node['aliases'])
                or not isinstance(node.get('ancestorIds'), list)
                or any(not isinstance(value, str) or not value for value in node['ancestorIds'])
                or node.get('status', 'active') not in {'active', 'deprecated'}):
            raise PublishDataValidationError(f'保存的标签词表快照中存在无效概念：{concept_id!r}')
        for field in ('definition', 'scopeNote'):
            if field in node and (not isinstance(node[field], str) or not node[field]):
                raise PublishDataValidationError(f'保存的标签概念中，{field} 必须是非空字符串。')
        by_id[concept_id] = node
    for node in by_id.values():
        chain = node['ancestorIds']
        if len(set(chain)) != len(chain) or node['id'] in chain:
            raise PublishDataValidationError('保存的标签概念的上级列表存在重复，或包含概念自身。')
        for position, ancestor in enumerate(chain):
            parent = by_id.get(ancestor)
            if (parent is None or parent['facet'] != node['facet']
                    or parent['ancestorIds'] != chain[:position]
                    or parent.get('status', 'active') != 'active'):
                raise PublishDataValidationError('保存的标签概念的上级列表包含缺失、跨分类或停用的概念，或与上级概念记录的顺序不一致。')
    return snapshot


def _validate_tag_version_catalog(catalog):
    if (not isinstance(catalog, dict)
            or catalog.get('contract') != 'paper-taxonomy-version-catalog-v1'
            or not isinstance(catalog.get('snapshots'), list) or not catalog['snapshots']
            or not re.fullmatch(r'[a-f0-9]{64}', str(catalog.get('currentSha256') or ''))):
        raise PublishDataValidationError('标签词表版本目录格式无效，或缺少协议、快照列表或当前版本 SHA。')
    versions = {}
    for snapshot in catalog['snapshots']:
        _validate_tag_catalog_snapshot(snapshot)
        sha = snapshot['registrySha256']
        if sha in versions:
            raise PublishDataValidationError('标签词表版本目录中存在重复的 SHA。')
        versions[sha] = snapshot
    if catalog['currentSha256'] not in versions:
        raise PublishDataValidationError('标签词表版本目录中未保存当前版本的快照。')
    return versions


def _validate_tag_display_policy(policy):
    fields = {'contract', 'baseRegistrySha256', 'baseSnapshotSha256',
              'preferredRegistrySha256', 'preferredSnapshotSha256',
              'preferredProjectionSha256'}
    if (not isinstance(policy, dict) or set(policy) != fields
            or policy.get('contract') != 'paper-taxonomy-presentation-selection-v1'
            or any(not isinstance(policy[key], str)
                   or not re.fullmatch(r'[a-f0-9]{64}', policy[key])
                   for key in fields - {'contract'})
            or policy['baseRegistrySha256'] == policy['preferredRegistrySha256']):
        raise PublishDataValidationError('标签展示策略的字段、协议或 SHA 格式无效，或选用版本与基础版本相同。')
    return policy


def _historical_tag_prompt_text_sha256(snapshot):
    # The public historical projection has a fixed nine-facet order.  Concept
    # IDs are ASCII.  Rebuilt bytes must match the explicitly approved digest;
    # an unrecognized ordering/projection can never silently select a version.
    facets = ['task', 'method', 'setting', 'signal', 'application', 'research_focus',
              'artifact', 'scientific_topic', 'model_family']
    def compact(value):
        return re.sub(r'\s+', ' ', re.sub(r'[\r\n|]+', ' ', value or '')).strip()
    lines = ['contract=paper-taxonomy-prompt-projection-v1',
             f'registry_version={snapshot["registryVersion"]}',
             f'registry_sha256={snapshot["registrySha256"]}',
             '只允许输出下列 active 概念的中文首选标签；ID 用于消歧，不得自造标签或输出同义词。']
    current_facet = None
    nodes = [node for node in snapshot['concepts'] if node.get('status') == 'active']
    for node in sorted(nodes, key=lambda item: (facets.index(item['facet']),
                                               item['id'])):
        if node['facet'] != current_facet:
            current_facet = node['facet']
            lines.append(f'[{current_facet}]')
        lines.append('|'.join([node['id'], '#' + node['zh'],
                               compact(node.get('definition')), compact(node.get('scopeNote'))]))
    raw = ('historical-taxonomy-prompt-projection-v2\n' + '\n'.join(lines) + '\n').encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def _select_tag_display_version(repo, current, versions):
    """按明确的展示策略选择词表版本，不改变单篇论文的签发记录。"""
    relatives = ['data/taxonomy-presentation-policy.json',
                 'static/data/taxonomy-presentation-policy.json']
    def read_regular(relative):
        target = repo / relative
        # Reject even a dangling link and links to another in-repo location.
        for item in [target, *target.parents]:
            if item == repo:
                break
            if item.is_symlink():
                raise PublishDataValidationError('标签展示策略或快照的路径及其父目录不得是符号链接。')
        if not target.exists():
            return None
        if not target.is_file() or target.stat().st_nlink != 1:
            raise PublishDataValidationError('标签展示策略和快照必须是普通文件，且只能有一个硬链接。')
        return target.read_bytes()
    raw_mirrors = [read_regular(relative) for relative in relatives]
    if raw_mirrors == [None, None]:
        return current, {}
    if raw_mirrors[0] is None or raw_mirrors[0] != raw_mirrors[1]:
        raise PublishDataValidationError('标签展示策略只缺少一份副本，或 data 与 static/data 中的文件内容不完全一致。')
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise PublishDataValidationError('标签展示策略的 JSON 中存在重复键。')
            result[key] = value
        return result
    try:
        policy = _validate_tag_display_policy(
            json.loads(raw_mirrors[0].decode('utf-8'), object_pairs_hook=unique_object))
    except (ValueError, UnicodeError) as exc:
        raise PublishDataValidationError('标签展示策略文件无法按 UTF-8 JSON 读取，或其中的策略内容未通过校验。') from exc
    base_sha = policy['baseRegistrySha256']
    preferred_sha = policy['preferredRegistrySha256']
    if (current['registrySha256'] != base_sha
            or hashlib.sha256(tag_catalog_snapshot_bytes(current)).hexdigest()
            != policy['baseSnapshotSha256']):
        raise PublishDataValidationError('标签展示策略记录的基础词表 SHA 或快照 SHA 与实际签发来源不一致。')
    preferred = versions.get(preferred_sha)
    if preferred is None:
        raise PublishDataValidationError('标签展示策略选用的版本没有保存对应的词表快照。')
    raw = tag_catalog_snapshot_bytes(preferred)
    if (hashlib.sha256(raw).hexdigest() != policy['preferredSnapshotSha256']
            or _historical_tag_prompt_text_sha256(preferred)
            != policy['preferredProjectionSha256']):
        raise PublishDataValidationError('标签展示策略记录的快照 SHA 或提示文本 SHA 与重新计算的结果不一致。')
    if preferred['concepts'][:len(current['concepts'])] != current['concepts']:
        raise PublishDataValidationError('标签展示策略选用的词表修改了已有概念，或改变了它们的顺序；只允许在原列表末尾追加概念。')
    # Both archived copies and both catalog entries must already carry exactly
    # this approved snapshot; a policy may not manufacture a missing version.
    for prefix in ('data', 'static/data'):
        if read_regular(f'{prefix}/taxonomy-snapshots/{preferred_sha}.json') != raw:
            raise PublishDataValidationError('标签展示策略选用版本的归档副本缺失，或文件内容与对应快照不完全一致。')
        catalog = _read_tag_catalog_file(repo, f'{prefix}/taxonomy-catalog.json')
        if catalog is None or _validate_tag_version_catalog(catalog).get(preferred_sha) != preferred:
            raise PublishDataValidationError('标签展示策略选用的版本未在对应版本目录中保存，或目录中的快照内容不一致。')
    return preferred, dict(zip(relatives, raw_mirrors))


def _is_tag_catalog_file_path(relative):
    parts = Path(relative).parts
    if Path(relative).is_absolute() or '..' in parts or '\\' in str(relative):
        return False
    if Path(relative).as_posix() in {
            'data/taxonomy-registry.json', 'static/data/taxonomy-registry.json',
            'data/taxonomy-catalog.json', 'static/data/taxonomy-catalog.json',
            'data/taxonomy-presentation-policy.json',
            'static/data/taxonomy-presentation-policy.json'}:
        return True
    return bool((parts[:2] == ('data', 'taxonomy-snapshots') and len(parts) == 3
                 or parts[:3] == ('static', 'data', 'taxonomy-snapshots') and len(parts) == 4)
                and re.fullmatch(r'[a-f0-9]{64}\.json', parts[-1]))


def _read_tag_catalog_file(repo, relative):
    target = repo / relative
    try:
        target.resolve().relative_to(repo)
    except ValueError as exc:
        raise PublishDataValidationError('标签词表文件的路径超出了博客仓库。') from exc
    if target.is_symlink():
        raise PublishDataValidationError('标签词表文件不得是符号链接。')
    if not target.exists():
        return None
    if not target.is_file():
        raise PublishDataValidationError('标签词表文件必须是普通文件。')
    try:
        return json.loads(target.read_text(encoding='utf-8'))
    except (ValueError, UnicodeError) as exc:
        raise PublishDataValidationError('标签词表文件不是有效的 UTF-8 JSON。') from exc


def tag_catalog_file_contents(blog_repo=None):
    """写入前准备完整的词表历史快照，以及当前版本在两处目录中的副本。"""
    repo = Path(BLOG_REPO if blog_repo is None else blog_repo).expanduser().resolve()
    current = _validate_tag_catalog_snapshot(build_tag_catalog_snapshot())
    versions = {}
    def retain(snapshot):
        _validate_tag_catalog_snapshot(snapshot)
        sha = snapshot['registrySha256']
        if sha in versions and versions[sha] != snapshot:
            raise PublishDataValidationError(f'标签词表的同一个 SHA 对应了不同的快照内容：{sha}')
        versions[sha] = snapshot
    catalogs = []
    for prefix in ('data', 'static/data'):
        catalog = _read_tag_catalog_file(repo, f'{prefix}/taxonomy-catalog.json')
        if catalog is not None:
            _validate_tag_version_catalog(catalog)
            catalogs.append(catalog)
            for snapshot in catalog['snapshots']:
                retain(snapshot)
        snapshot = _read_tag_catalog_file(repo, f'{prefix}/taxonomy-registry.json')
        if snapshot is not None:
            retain(snapshot)
        archive = repo / prefix / 'taxonomy-snapshots'
        if archive.exists():
            if archive.is_symlink() or not archive.is_dir():
                raise PublishDataValidationError('标签词表归档路径必须是目录，且不得是符号链接。')
            for target in sorted(archive.iterdir()):
                if not re.fullmatch(r'[a-f0-9]{64}\.json', target.name):
                    raise PublishDataValidationError('标签词表归档目录中存在不符合 SHA 文件命名要求的文件。')
                snapshot = _read_tag_catalog_file(repo, target.relative_to(repo))
                _validate_tag_catalog_snapshot(snapshot)
                if target.stem != snapshot['registrySha256']:
                    raise PublishDataValidationError('标签词表归档文件名中的 SHA 与快照记录不一致。')
                retain(snapshot)
    if len(catalogs) == 2 and catalogs[0] != catalogs[1]:
        raise PublishDataValidationError('data 与 static/data 中的标签词表版本目录内容不一致。')
    retain(current)
    display, policy_assets = _select_tag_display_version(repo, current, versions)
    catalog = {'contract': 'paper-taxonomy-version-catalog-v1',
               'currentSha256': display['registrySha256'],
               'snapshots': [versions[sha] for sha in sorted(versions)]}
    assets = dict(policy_assets)
    for prefix in ('data', 'static/data'):
        assets[f'{prefix}/taxonomy-registry.json'] = tag_catalog_snapshot_bytes(display)
        assets[f'{prefix}/taxonomy-catalog.json'] = tag_catalog_snapshot_bytes(catalog)
        for sha, snapshot in sorted(versions.items()):
            assets[f'{prefix}/taxonomy-snapshots/{sha}.json'] = tag_catalog_snapshot_bytes(snapshot)
    return assets


def prepare_tag_catalog_staged_files(stage_root, blog_repo=None, *, single_page=False,
                                          installation=None):
    """将词表文件写入与页面共用的暂存区，并绑定安装记录、审查凭证和本次精确文件差异。"""
    repo = Path(BLOG_REPO if blog_repo is None else blog_repo).expanduser().resolve()
    stage = Path(stage_root).resolve()
    if installation is not None:
        # The target repo may be between data/static replacements after a crash.
        # Reuse only the journal-bound complete staging set, never derive a new
        # version catalogue from that partially installed worktree.
        records = installation.get('files') if isinstance(installation, dict) else None
        if not isinstance(records, list):
            raise PublishDataValidationError('标签词表安装记录缺少有效的文件列表。')
        selected = [record for record in records if isinstance(record, dict)
                    and _is_tag_catalog_file_path(record.get('path', ''))]
        if single_page:
            if selected:
                raise PublishDataValidationError('单篇发布的安装记录不得包含全站标签词表文件。')
            return []
        expected = tag_catalog_file_contents(stage)
        if {record['path'] for record in selected} != set(expected):
            raise PublishDataValidationError('安装记录中的标签词表文件集合与暂存区应有的文件集合不一致。')
        paths = []
        for record in selected:
            relative = record['path']
            target = stage / relative
            if (record.get('delete') is not False
                    or record.get('stagedRelativePath') != relative
                    or target.is_symlink() or not target.is_file()
                    or _sha256_file(target) != record.get('expectedSha256')
                    or target.read_bytes() != expected[relative]):
                raise PublishDataValidationError('标签词表暂存文件无效，或其安装路径、删除标记、SHA 或文件内容与安装记录不一致。')
            paths.append(target)
        return paths
    assets = tag_catalog_file_contents(repo)
    if single_page:
        if any(not (repo / relative).is_file() or (repo / relative).read_bytes() != raw
               for relative, raw in assets.items()):
            raise PublishDataValidationError('单篇发布不得更新全站标签词表；请先通过完整批次发布词表版本文件。')
        return []
    paths = []
    for relative, raw in assets.items():
        target = stage / relative
        try:
            target.resolve().relative_to(stage)
        except ValueError as exc:
            raise PublishDataValidationError('标签词表文件的暂存路径超出了暂存目录。') from exc
        if target.is_symlink():
            raise PublishDataValidationError('标签词表暂存文件不得是符号链接。')
        _atomic_write_bytes(target, raw)
        paths.append(target)
    return paths


def export_tag_catalog_files(blog_repo=None):
    """将词表版本文件写入博客仓库，不修改原词表。

    返回实际写入的文件路径。已有文件内容相同时跳过写入；博客根目录不存在时不写入任何文件。
    """
    repo = Path(BLOG_REPO if blog_repo is None else blog_repo).expanduser().resolve()
    if not repo.is_dir():
        return []
    assets = tag_catalog_file_contents(repo)
    written = []
    for relative, raw in assets.items():
        target = repo / relative
        if target.is_file() and target.read_bytes() == raw:
            continue
        _atomic_write_bytes(target, raw)
        written.append(target)
    return written


def build_flat_tag_compat_metadata(parsed, *, required=False):
    """保留 Hugo 的 tags 字段，并记录当前词表中标签的含义和层级。

    旧记录维护时可以缺少当前标签选择记录；required 为 True 时必须提供有效记录。
    输入声明标签选择有效后，本函数仍按当前词表逐项核对 ID、中文名称、分类维度和主标签角色。
    """
    try:
        validation = read_tag_validation(parsed)
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error
    if not isinstance(validation, dict) or validation.get('valid') is not True:
        if required:
            raise PublishDataValidationError('新页面缺少通过当前词表检查的标签选择记录。')
        return None
    if validation.get('registryVersion') != _PAGE_TAG_CATALOG['version'] \
            or validation.get('registrySha256') != _PAGE_TAG_CATALOG['registrySha256']:
        raise PublishDataValidationError('页面的标签选择记录与当前词表版本或 SHA 不一致。')
    tags = parsed.get('tags')
    concept_ids = validation.get('conceptIds')
    if not isinstance(tags, list) or not isinstance(concept_ids, list) \
            or len(tags) != len(concept_ids) or len(tags) not in range(3, 6):
        raise PublishDataValidationError('页面标签或概念 ID 列表无效，或两者数量不一致；标签数量必须为 3–5 个。')
    concepts = []
    for tag, concept_id in zip(tags, concept_ids):
        concept = _PAGE_ACTIVE_TAGS_BY_ID.get(concept_id)
        label = str(tag or '').removeprefix('#')
        if not concept or concept['preferredLabel']['zh'] != label:
            raise PublishDataValidationError('页面标签与对应概念的中文首选名称不一致，或该概念未在当前词表中启用。')
        concepts.append({
            'id': concept_id,
            'facet': concept['facet'],
            'label': label,
        })
    primary_task_id = validation.get('primaryTaskId')
    primary_method_id = validation.get('primaryMethodId')
    primary_task = str(parsed.get('primaryTaskTag') or '').removeprefix('#')
    primary_method = str(parsed.get('primaryMethodTag') or '').removeprefix('#')
    task = _PAGE_ACTIVE_TAGS_BY_ID.get(primary_task_id)
    method = _PAGE_ACTIVE_TAGS_BY_ID.get(primary_method_id)
    if not task or task['facet'] != 'task' or task['preferredLabel']['zh'] != primary_task \
            or not method or method['facet'] != 'method' \
            or method['preferredLabel']['zh'] != primary_method \
            or primary_task_id not in concept_ids or primary_method_id not in concept_ids:
        raise PublishDataValidationError('页面的主任务或主方法不符合对应的分类、中文首选名称或已选概念。')
    return {
        'contract': FLAT_TAG_COMPAT_CONTRACT,
        'selectionContract': TAG_SELECTION_CONTRACT,
        'registryVersion': _PAGE_TAG_CATALOG['version'],
        'registrySha256': _PAGE_TAG_CATALOG['registrySha256'],
        'primaryTaskId': primary_task_id,
        'primaryMethodId': primary_method_id,
        'primaryTask': primary_task,
        'primaryMethod': primary_method,
        'concepts': concepts,
    }


def build_researcher_workbench_bundle(
        paper, date_str, *, parsed=None, reader_plan=None,
        api_reader_payload=None, require_reader=False):
    """Build deterministic page metadata and four same-origin sidecars.

    Legacy maintenance pages without a reader plan remain readable and do not
    get relabelled. Modern production pages must set ``require_reader`` and
    fail closed instead of publishing an incomplete workbench record.
    """
    try:
        read_tag_validation(parsed or paper.get('parsed'))
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error
    if reader_plan is None:
        api_reader_payload = api_reader_payload or _api_reader_payload(paper)
        v6_payload = _manual_v6_reader_payload(paper)
        reader_plan = (
            v6_payload.get('plan') if isinstance(v6_payload, dict)
            else api_reader_payload.get('plan') if isinstance(api_reader_payload, dict)
            else _manual_reader_editorial_plan(paper)
        )
    if not isinstance(reader_plan, dict):
        if require_reader:
            raise PublishDataValidationError('production 论文缺少 researcher workbench reader plan')
        return None
    reader_title = _validated_workbench_text(
        reader_plan.get('readerTitle'), 'researcher workbench readerTitle', maximum=500,
    )
    if not re.search(r'[\u3400-\u9fff]', reader_title):
        raise PublishDataValidationError('researcher workbench readerTitle 必须包含中文')
    one_sentence = _validated_workbench_text(
        reader_plan.get('oneSentenceThesis'),
        'researcher workbench oneSentenceThesis', maximum=2000,
    )
    original_title = _validated_workbench_text(
        paper.get('title'), 'researcher workbench originalTitle', maximum=2000,
    )
    abstract = _validated_workbench_text(
        paper.get('abstract'), 'researcher workbench abstract', maximum=200000,
        preserve_newlines=True,
    )
    identity = _workbench_source_identity(paper)
    parsed_analysis = dict(parsed or paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {})
    try:
        score = float(parsed_analysis.get('score'))
    except (TypeError, ValueError) as exc:
        raise PublishDataValidationError('researcher workbench score 必须是数值') from exc
    if not math.isfinite(score) or score < 0 or score > 10:
        raise PublishDataValidationError('researcher workbench score 必须在 0-10')
    raw_primary_task = parsed_analysis.get('primaryTaskTag')
    if not isinstance(raw_primary_task, str):
        raise PublishDataValidationError('researcher workbench primaryTask 必须是字符串')
    primary_task = _validated_workbench_text(
        raw_primary_task.lstrip('#'),
        'researcher workbench primaryTask', maximum=200,
    )
    tag_metadata = build_flat_tag_compat_metadata(parsed_analysis)
    primary_method = tag_metadata['primaryMethod'] if tag_metadata else None
    rank_bucket = _validated_workbench_text(
        parsed_analysis.get('rankBucket'), 'researcher workbench rankBucket', maximum=100,
    )
    document_type = _validated_workbench_text(
        parsed_analysis.get('documentType'), 'researcher workbench documentType', maximum=100,
    )
    authors = _workbench_authors(paper, api_reader_payload)
    abstract_sha = hashlib.sha256(abstract.encode('utf-8')).hexdigest()
    citation_id = identity['versionedId'] or identity['baseId']
    common = {
        'contract': RESEARCHER_SIDECAR_CONTRACT,
        'arxivId': identity['baseId'],
        'arxivVersion': identity['version'],
        'arxivVersionedId': identity['versionedId'],
        'absUrl': identity['absUrl'],
        'pdfUrl': identity['pdfUrl'],
        'originalTitle': original_title,
        'authors': authors,
    }
    citation = dict(common)
    citation.update({'schemaVersion': 1, 'id': citation_id, 'type': 'preprint'})
    context = dict(common)
    context.update({
        'schemaVersion': 1,
        'readerTitle': reader_title,
        'oneSentenceThesis': one_sentence,
        'abstract': abstract,
        'abstractSha256': abstract_sha,
        'assessment': {
            'primaryTask': primary_task,
            **({'primaryMethod': primary_method, 'taxonomy': tag_metadata} if tag_metadata else {}),
            'score': score,
            'rankBucket': rank_bucket,
            'documentType': document_type,
        },
    })
    author_bibtex = ' and '.join(
        '{' + _bibtex_escape(author['name'], 'BibTeX author') + '}'
        for author in authors
    )
    citation_key = 'arxiv_' + re.sub(r'[^a-z0-9]+', '_', citation_id.lower()).strip('_')
    bibtex = (
        f'@misc{{{citation_key},\n'
        f'  title = {{{_bibtex_escape(original_title, "BibTeX title")}}},\n'
        f'  author = {{{author_bibtex}}},\n'
        f'  eprint = {{{_bibtex_escape(citation_id, "BibTeX eprint")}}},\n'
        '  archivePrefix = {arXiv},\n'
        f'  url = {{{_bibtex_escape(identity["absUrl"], "BibTeX URL")}}}\n'
        '}\n'
    ).encode('utf-8')
    ris_lines = ['TY  - UNPB', f'TI  - {original_title}']
    ris_lines.extend(f'AU  - {author["name"]}' for author in authors)
    ris_lines.extend([
        f'ID  - {citation_id}', f'UR  - {identity["absUrl"]}',
        f'L1  - {identity["pdfUrl"]}', 'ER  - ', '',
    ])
    ris = '\n'.join(ris_lines).encode('utf-8')
    root = _researcher_sidecar_relative_root(date_str, identity['baseId'])
    sidecars = {
        root / 'citation.json': _json_sidecar_bytes(citation),
        root / 'citation.bib': bibtex,
        root / 'citation.ris': ris,
        root / 'rethink-context.json': _json_sidecar_bytes(context),
    }
    for relative, raw in sidecars.items():
        if b'\r' in raw or not raw.endswith(b'\n') \
                or not raw or len(raw) > RESEARCHER_SIDECAR_MAX_BYTES:
            raise PublishDataValidationError(f'researcher sidecar 非规范: {relative}')
    sidecar_records = {
        relative.name: {
            'url': _researcher_public_url(relative),
            'sha256': hashlib.sha256(raw).hexdigest(),
        }
        for relative, raw in sidecars.items()
    }
    return {
        'contract': RESEARCHER_WORKBENCH_CONTRACT,
        'readerTitle': reader_title,
        'originalTitle': original_title,
        'oneSentenceThesis': one_sentence,
        'abstractSha256': abstract_sha,
        'identity': identity,
        'authors': authors,
        'primaryTask': primary_task,
        'primaryMethod': primary_method,
        'taxonomy': tag_metadata,
        'score': score,
        'rankBucket': rank_bucket,
        'documentType': document_type,
        'sidecars': sidecars,
        'sidecarRecords': sidecar_records,
    }


def _workbench_display_original_title(title):
    """Convert inline-math dollar delimiters in the YAML display title."""
    if not isinstance(title, str):
        return title
    title = re.sub(r'AS\$\^2\$D', 'AS²D', title, flags=re.IGNORECASE)
    return re.sub(
        r'(?<!\\)\$(.+?)(?<!\\)\$',
        lambda match: r'\(' + match.group(1) + r'\)',
        title,
    )


def _researcher_workbench_frontmatter(bundle):
    if not bundle:
        return ''
    authors_json = json.dumps(
        bundle['authors'], ensure_ascii=False, separators=(',', ':'), sort_keys=True,
    )
    sidecars_json = json.dumps(
        bundle['sidecarRecords'], ensure_ascii=False, separators=(',', ':'), sort_keys=True,
    )
    if len(authors_json.encode('utf-8')) > 32 * 1024:
        raise PublishDataValidationError('researcher workbench frontmatter 作者超过 32 KiB')
    identity = bundle['identity']
    version = 'null' if identity['version'] is None else str(identity['version'])
    versioned_id = (
        'null' if identity['versionedId'] is None
        else json.dumps(identity['versionedId'], ensure_ascii=False)
    )
    tag_metadata = bundle.get('taxonomy')
    tag_frontmatter = ''
    if tag_metadata:
        tag_frontmatter = (
            f'paper_digest_taxonomy_contract: "{tag_metadata["contract"]}"\n'
            f'paper_digest_taxonomy_selection_contract: "{tag_metadata["selectionContract"]}"\n'
            f'paper_digest_taxonomy_registry_version: "{tag_metadata["registryVersion"]}"\n'
            f'paper_digest_taxonomy_registry_sha256: "{tag_metadata["registrySha256"]}"\n'
            f'paper_digest_taxonomy_concepts: '
            f'{json.dumps(tag_metadata["concepts"], ensure_ascii=False, separators=(",", ":"), sort_keys=True)}\n'
            f'paper_digest_primary_method: {json.dumps(tag_metadata["primaryMethod"], ensure_ascii=False)}\n'
        )
    return (
        f'paper_digest_workbench_contract: "{RESEARCHER_WORKBENCH_CONTRACT}"\n'
        f'paper_digest_reader_title: {json.dumps(bundle["readerTitle"], ensure_ascii=False)}\n'
        f'paper_digest_original_title: {json.dumps(_workbench_display_original_title(bundle["originalTitle"]), ensure_ascii=False)}\n'
        f'paper_digest_arxiv_version: {version}\n'
        f'paper_digest_arxiv_versioned_id: {versioned_id}\n'
        f'paper_digest_arxiv_abs_url: {json.dumps(identity["absUrl"], ensure_ascii=False)}\n'
        f'paper_digest_arxiv_pdf_url: {json.dumps(identity["pdfUrl"], ensure_ascii=False)}\n'
        f'paper_digest_primary_task: {json.dumps(bundle["primaryTask"], ensure_ascii=False)}\n'
        f'{tag_frontmatter}'
        f'paper_digest_score: {json.dumps(bundle["score"], allow_nan=False)}\n'
        f'paper_digest_rank_bucket: {json.dumps(bundle["rankBucket"], ensure_ascii=False)}\n'
        f'paper_digest_document_type: {json.dumps(bundle["documentType"], ensure_ascii=False)}\n'
        f'paper_digest_one_sentence: {json.dumps(bundle["oneSentenceThesis"], ensure_ascii=False)}\n'
        f'paper_digest_authors: {authors_json}\n'
        f'paper_digest_abstract_sha256: "{bundle["abstractSha256"]}"\n'
        f'paper_digest_sidecars: {sidecars_json}\n'
    )


def _validate_researcher_workbench_frontmatter(frontmatter, paper, date_str):
    if frontmatter.get('paper_digest_workbench_contract') is None:
        return True
    if frontmatter.get('paper_digest_workbench_contract') != RESEARCHER_WORKBENCH_CONTRACT:
        raise PublishDataValidationError('researcher workbench frontmatter 合同版本非法')
    if not isinstance(paper, dict):
        raise PublishDataValidationError('researcher workbench 页面缺少权威论文快照')
    api_reader_payload = _api_reader_payload(paper)
    v6_payload = _manual_v6_reader_payload(paper)
    reader_plan = (
        v6_payload.get('plan') if isinstance(v6_payload, dict)
        else api_reader_payload.get('plan') if isinstance(api_reader_payload, dict)
        else _manual_reader_editorial_plan(paper)
    )
    bundle = build_researcher_workbench_bundle(
        paper, date_str, reader_plan=reader_plan,
        api_reader_payload=api_reader_payload, require_reader=True,
    )
    identity = bundle['identity']
    expected = {
        'paper_digest_reader_title': bundle['readerTitle'],
        'paper_digest_original_title': _workbench_display_original_title(bundle['originalTitle']),
        'paper_digest_arxiv_id': identity['baseId'],
        'paper_digest_arxiv_version': identity['version'],
        'paper_digest_arxiv_versioned_id': identity['versionedId'],
        'paper_digest_arxiv_abs_url': identity['absUrl'],
        'paper_digest_arxiv_pdf_url': identity['pdfUrl'],
        'paper_digest_primary_task': bundle['primaryTask'],
        'paper_digest_score': bundle['score'],
        'paper_digest_rank_bucket': bundle['rankBucket'],
        'paper_digest_document_type': bundle['documentType'],
        'paper_digest_one_sentence': bundle['oneSentenceThesis'],
        'paper_digest_authors': bundle['authors'],
        'paper_digest_abstract_sha256': bundle['abstractSha256'],
        'paper_digest_sidecars': bundle['sidecarRecords'],
        'description': bundle['oneSentenceThesis'],
    }
    tag_metadata = bundle.get('taxonomy')
    if tag_metadata:
        expected.update({
            'paper_digest_taxonomy_contract': tag_metadata['contract'],
            'paper_digest_taxonomy_selection_contract': tag_metadata['selectionContract'],
            'paper_digest_taxonomy_registry_version': tag_metadata['registryVersion'],
            'paper_digest_taxonomy_registry_sha256': tag_metadata['registrySha256'],
            'paper_digest_taxonomy_concepts': tag_metadata['concepts'],
            'paper_digest_primary_method': tag_metadata['primaryMethod'],
        })
    for field, value in expected.items():
        if frontmatter.get(field) != value:
            raise PublishDataValidationError(
                f'researcher workbench frontmatter.{field} 与权威论文快照不一致'
            )
    return True


def plain_title_for_publish(title):
    """标题中的短数学标记转成普通文本，避免 Hugo/frontmatter 误解析。"""
    title = str(title or '')
    title = re.sub(r'\$?\s*\^\s*2\s*\$?', '²', title)
    title = re.sub(r'\\underline\s*\{([^{}]+)\}', r'\1', title)
    title = re.sub(
        r'\$?\s*(\d+(?:\.\d+)?)\s*\^\s*\\circ\s*\$?',
        lambda match: f'{match.group(1)}°',
        title,
    )
    title = title.replace('$', '')
    return yaml_escape(title).replace('\\\\', '\\')


def compact_title_for_ranking(title, max_length=55):
    """按完整词截断排行榜标题，避免固定字符切片留下半个英文词。"""
    title = re.sub(r'\s+', ' ', str(title or '')).strip()
    if len(title) <= max_length:
        return title
    if max_length < 2:
        return '…'[:max_length]
    prefix = title[:max_length - 1]
    # 只有切口两侧都是英文/数字时才回退到词边界；中文无需按空格截断。
    if re.match(r'[A-Za-z0-9]', title[max_length - 1]) and re.search(r'[A-Za-z0-9]$', prefix):
        boundary = max(prefix.rfind(' '), prefix.rfind('-'), prefix.rfind('/'))
        if boundary >= max_length // 2:
            prefix = prefix[:boundary]
    return prefix.rstrip(' -/:;,.') + '…'


def format_complete_score_line(parsed):
    """Render total plus all eight dimensions; zero is a real score, not missing."""
    if not isinstance(parsed, dict) or parsed.get('score') is None:
        return ''
    dimensions = (
        ('innovationScore', '创新', '2'),
        ('technicalRigorScore', '技术严谨', '1.5'),
        ('experimentalSufficiencyScore', '实验充分', '1.5'),
        ('clarityScore', '清晰度', '1'),
        ('impactScore', '影响力', '1.5'),
        ('openSourceScore', '开源', '1.5'),
        ('reproducibilityScore', '可复现', '0.5'),
        ('engineeringScore', '工程/实践', '1.5'),
    )
    sub_scores = ' | '.join(
        f'{label} {parsed[key]}/{maximum}'
        for key, label, maximum in dimensions
        if parsed.get(key) is not None
    )
    return f"**{parsed['score']}/10**" + (f' | {sub_scores}' if sub_scores else '')


def normalize_digest_index_reader_surface(text):
    """Normalize quantitative prose copied from canonical into the daily index."""
    value = str(text or '')
    frontmatter = ''
    frontmatter_match = re.match(
        r'\A---\r?\n[\s\S]*?\r?\n---(?:\r?\n|\Z)', value,
    )
    if frontmatter_match:
        # Quantitative typography owns reader prose only.  In particular,
        # case-insensitive unit suffixes such as B/D must never split a signed
        # hexadecimal digest stored in YAML frontmatter.
        frontmatter = frontmatter_match.group(0)
        value = value[len(frontmatter):]
    protected_markdown_links = []
    protected_percentages = []
    protected_urls = []

    def stash_markdown_link(match):
        protected_markdown_links.append(match.group(0))
        return f'__PD_MARKDOWN_LINK_{len(protected_markdown_links) - 1}__'

    # Quantitative typography is only for prose.  Preserve both the label and
    # destination of inline links/images byte-for-byte: a unit-like paper token
    # such as ``3D`` must not become ``3 D``, and the same rewrite inside a
    # relative post URL would silently create a broken digest-index link.
    value = re.sub(
        r'!?\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)',
        stash_markdown_link,
        value,
    )

    def stash_url(match):
        protected_urls.append(match.group(0))
        return f'__PD_URL_{len(protected_urls) - 1}__'

    value = re.sub(
        r'https://[^\s<>()\[\]{}"\'，。；：！？、一-鿿]+',
        stash_url,
        value,
    )

    def stash_percentage(match):
        protected_percentages.append(match.group(0))
        return f'__PD_PERCENT_{len(protected_percentages) - 1}__'

    value = re.sub(
        r'[-+]?\d+(?:\.\d+)?\s*%',
        stash_percentage,
        value,
    )
    digits = {
        '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4,
        '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
    }

    def chinese_integer(raw):
        section = digit = total = 0
        for char in raw:
            if char in digits:
                digit = digits[char]
                continue
            unit = {'十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000}.get(char)
            if not unit:
                return raw
            if unit < 10000:
                section += (digit or 1) * unit
            else:
                total += (section + digit or 1) * unit
                section = digit = 0
            digit = 0
        return str(total + section + digit)

    chars = '零〇一二两三四五六七八九十百千万亿'
    value = re.sub(
        rf'([{chars}]+)分之([{chars}]+)',
        lambda match: f'{chinese_integer(match.group(2))}/{chinese_integer(match.group(1))}',
        value,
    )
    value = re.sub(r'一半', '1/2', value)
    value = re.sub(r'半宽', '1/2 宽', value)
    value = re.sub(
        r'([一二两三四五六七八九])成',
        lambda match: f'{digits[match.group(1)] * 10}%',
        value,
    )
    count_units = (
        '个|对|种|条|篇|张|段|轮|步|次|倍|人|名|例|维|层|位|核|类|'
        '组|路|级|阶|流|通道|阶段|分支|模型|基准|数据集|会话|样本|参数|'
        '题|轨迹|主干|帧|毫秒|秒|分钟|小时|天|兆赫|千赫|赫兹|分贝|毫焦|皮焦|兆字节|千字节|字节|像素|采样|自由度|'
        '目录|艺人|轨道|模态|套|卡|分制|男|女|组件|任务|条件|类别|'
        '时间点|方向|卷积块|动作|片段|关键词|文件|刺激|参与者|病例|录音|场景|组合|候选|折'
    )
    value = re.sub(
        rf'(?<!第)([{chars}]+)\s*({count_units})',
        lambda match: f'{chinese_integer(match.group(1))} {match.group(2)}',
        value,
    )
    value = re.sub(
        rf'[几数]\s*(\d+(?:\.\d+)?)\s*(?=({count_units}))',
        r'约 \1 ',
        value,
    )
    value = re.sub(r'(\d+/\d+)(?=[一-鿿])', r'\1 ', value)
    value = re.sub(r'([一-鿿])([-+]?\d)', r'\1 \2', value)
    value = re.sub(r'(\d)([一-鿿])', r'\1 \2', value)
    value = re.sub(r'([一-鿿])([A-Za-z][A-Za-z0-9+.-]*)', r'\1 \2', value)
    value = re.sub(r'([A-Za-z0-9%+)\]])([一-鿿])', r'\1 \2', value)
    value = re.sub(r'([A-Za-z0-9])([*_~`]{1,3})([一-鿿])', r'\1\2 \3', value)
    value = re.sub(r'([一-鿿])([*_~`]{1,3})([A-Za-z])', r'\1 \2\3', value)
    value = re.sub(r'([同唯统单])\s*1\s*(?=[一-鿿])', r'\1一', value)
    value = re.sub(r'归\s*1\s*(?=(?:化|后|组合|处理|权重))', '归一', value)
    value = re.sub(
        r'([下上这另哪])\s*1\s*(?=(?:步|层|类|种|段|项|组|张|个))',
        r'\1一',
        value,
    )
    value = re.sub(
        r'([-+]?\d+(?:\.\d+)?)(?=(?:mW|mJ|ms|dB|kHz|MHz|Hz|KiB|KB|MB|GB|MACs?|tokens?|FPS|bit|DoF|Vpp|D|B|K|M|G)(?![A-Za-z]))',
        r'\1 ',
        value,
        flags=re.I,
    )
    for index, original in enumerate(protected_percentages):
        value = value.replace(f'__PD_PERCENT_{index}__', original)
    value = re.sub(r'([前约近])\s+(\d+(?:\.\d+)?%)', r'\1\2', value)
    value = re.sub(r'(\d+(?:\.\d+)?%)\s+([一-鿿])', r'\1\2', value)
    for index, original in enumerate(protected_urls):
        value = value.replace(f'__PD_URL_{index}__', original)
    for index, original in enumerate(protected_markdown_links):
        value = value.replace(f'__PD_MARKDOWN_LINK_{index}__', original)
    return frontmatter + value


def compact_index_opensource(parsed_analysis, paper, limit=4):
    """Keep the digest index navigable; full provenance remains on each paper page."""
    oss_text = enrich_opensource(parsed_analysis, paper)
    urls = []
    for raw in re.findall(
            r'https://[^\s<>()\[\]{}"\'，。；：！？、一-鿿]+',
            oss_text):
        url = raw.rstrip('.,;:)，。；：！？、')
        if url and url not in urls:
            urls.append(url)
        if len(urls) >= limit:
            break
    if not urls:
        return '资源状态、许可边界与复现证据详见单篇分析页。'
    lines = [f'- [资源 {index}]({url})' for index, url in enumerate(urls, 1)]
    lines.append('- 完整资源身份、许可边界与缺失项详见单篇分析页。')
    return '\n'.join(lines)


API_READER_DECISION_PROJECTION_CONTRACT = 'api-reader-decision-projection-v2'


def _analysis_sha256_ignoring_core_summary_body(analysis):
    matches = list(re.finditer(r'^##\s*核心摘要\s*\r?\n', str(analysis or ''), re.MULTILINE))
    if len(matches) != 1:
        return None
    start = matches[0].end()
    following = re.search(r'^##\s+', analysis[start:], re.MULTILINE)
    end = start + following.start() if following else len(analysis)
    projected = analysis[:start] + '<CORE_SUMMARY_BODY>' + analysis[end:]
    return _javascript_string_sha256(projected)


def _nearest_core_summary_metric_label(segment, from_right):
    # A bare token such as PESQ can name either a metric or a baseline method.
    # Only an explicit "X分数/X得分/X指标" label is safe to compare here.
    candidates = []
    custom = re.compile(
        r'(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]{1,39})(?=\s*(?:分数|得分|指标))'
    )
    candidates.extend(
        (match.start(), re.sub(r'[\s_-]+', '', match.group(1).lower()))
        for match in custom.finditer(str(segment or ''))
    )
    if not candidates:
        return ''
    candidates.sort(key=lambda item: item[0])
    return candidates[-1 if from_right else 0][1]


def _has_cross_metric_directional_comparison(sentence):
    sentence = str(sentence or '')
    for match in re.finditer(r'(?:高于|低于|超过|优于|领先)', sentence):
        left = _nearest_core_summary_metric_label(
            sentence[max(0, match.start() - 80):match.start()], True
        )
        right = _nearest_core_summary_metric_label(
            sentence[match.end():match.end() + 80], False
        )
        if left and right and left != right:
            return True
    return False


def _strip_core_summary_non_result_numerals(text):
    value = str(text or '')
    value = re.sub(r'https?://\S+', ' ', value)
    value = re.sub(r'\[[0-9,;\s-]+\]', ' ', value)
    value = re.sub(r'§\s*\d+(?:\.\d+)*', ' ', value)
    value = re.sub(
        r'\b(?:theorem|lemma|proposition|corollary|definition|assumption|equation|fig(?:ure)?\.?|table|section|appendix)\s*\d+(?:\.\d+)*',
        ' ', value, flags=re.IGNORECASE,
    )
    value = re.sub(
        r'(?:定理|引理|命题|推论|公理|定义|假设|公式|方程|等式|式|图|表|章节|附录)\s*(?:编号)?\s*\d+(?:\.\d+)*',
        ' ', value,
    )
    value = re.sub(
        r'(?<![A-Za-z0-9_])\d+(?:,\d{3})*(?:\.\d+)?\s*(?:种\s*)?(?:languages?|语言)(?![A-Za-z0-9_])',
        ' ', value, flags=re.IGNORECASE,
    )
    return re.sub(r'\b(?:19|20)\d{2}\b', ' ', value)


def _detailed_core_summary_semantic_issue(summary):
    summary = str(summary or '')
    count = len(re.findall(r'[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]', summary))
    sentences = len(re.findall(r'[。！？!?]', summary))
    issues = []
    if count < 320 or count > 600:
        issues.append(f'中文字符必须为 320–600，当前 {count}')
    if sentences < 6 or sentences > 9:
        issues.append(f'句数必须为 6–9，当前 {sentences}')
    if not re.search(r'(?:问题|难点|任务|目标|输入|输出|旨在|针对|解决)', summary):
        issues.append('缺少任务问题、输入输出或实际难点')
    chain = re.findall(r'(?:第一|第二|第三|第四|首先|其次|然后|随后|接着|最后|先|再|阶段|步骤|模块|组件)', summary)
    roles = re.findall(r'(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入)', summary)
    tier_role_stages = {
        match.group(1).upper()
        for match in re.finditer(
            r'(?<![A-Za-z0-9_])Tier[-‐‑‒–—]([LMH])(?![A-Za-z0-9_])'
            r'[^；。！？!?\n]{0,120}'
            r'(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|打分|匹配|投票|检索|推理|判决|路由)',
            summary, flags=re.IGNORECASE,
        )
    }
    has_numbered_method_chain = (
        (len(chain) >= 2 or re.search(r'分(?:\d+|[一二三四五六七八九十]+)步', summary))
        and len(roles) >= 2
    )
    if not has_numbered_method_chain and len(tier_role_stages) < 2:
        issues.append('缺少 2–4 步方法链的分工与衔接')
    # Keep this allow-list in lockstep with scripts/analysis-contract.js.
    # The publisher replays the same v3 contract after the Node analysis
    # stages, so a metric accepted upstream must not be rejected here merely
    # because it uses a newer alias (for example PPL or compression rate).
    metric = re.compile(
        r'(?:(?<![A-Za-z0-9_])(?:(?:cp|tcp)?WER|SWER|AER|CER|PER|DER|JER|F1|F[- ]?Scores?|BLEU|COMET|ROUGE|MOS(?:[- ]?[PT])?|PCC|FAD(?:CLAP|Vggish)|CQT1-PCC|LPAPS|CDPAM|PESQ|STOI|SI-SDR|SDR|SNR|EER|PPL|ASR|mAP|AUROC|AUC|mIoU|IoU|J&F|MJ|MF|Jaccard|LangRank|Exact Match|Pearson|Spearman|Kendall|PSNR|SSIM|MSE|MAE|RMSE|FGD|BeatAlign|Diversity|R@\d+(?:\.\d+)?|SAR|DAR|PISR|RtA|NBS|OIC|PAR|Fair[ -]?Rate|BMSR|JSR|RSF|OH|n?TVD|SpkSim|LPS|SBS|UTMOS|PLCMOS|precision|recall|MSR|FVD|FID|Acc(?:[_ -]?(?:macro|num))?|CLAP(?:[_ -](?:MS|LAION))?|VISQOL|MCD|SPK[_ -]?SIM|Mel(?:[ -]Dist(?:ance)?)?|STFT(?:[ -]Dist(?:ance)?)?|DeSync|IB|accuracy|error rate|success rate|win rate|compression[ -](?:ratio|rate)|real[ -]time factor|scores?|latency|throughput|RTF|FPS|performance|metrics?)(?![A-Za-z0-9_])|词(?:字)?错率|困惑度|攻击成功率|准确率|正确率|错误率|误差率|召回率|精确率|总体分|得分|分数|胜率|成功率|延迟|吞吐|实时率|主观评分|客观评分|相似度|相似分数|性能|指标)',
        re.IGNORECASE,
    )
    conference_metric = re.compile(
        r'包络相关(?:性)?|抖动|计数偏差|总误差|频率误差|衰减误差|增益误差|相对误差|平均误差|压缩率|谐波失真|频谱对比度损失|起音时间(?:对数)?偏差'
    )
    comparison = re.compile(
        r'(?:from\b[^。！？!?]{0,50}\bto\b|improv(?:e|es|ed|ement)|outperform(?:s|ed)?|reduc(?:e|es|ed|tion)|increase[sd]?|decrease[sd]?|degrad(?:e|es|ed|ation)|on par|comparable|(?:由|从)[^。！？!?]{0,40}(?:升至|升到|降至|降到|提升至|提高到)|相比|相较|优于|超过|反超|低于|高于|提升|提高|改善|改进|降低|下降|减少|达到|增至|减至|领先|持平|相当|接近)',
        re.IGNORECASE,
    )
    baseline_transition = re.compile(
        r'(?:基线|对照|原方法|已有方法|先前方法)'
        r'[^。！？!?\n]{0,40}(?:为|达到)\s*[-+]?\d+(?:\.\d+)?'
        r'[^。！？!?\n]{0,50}(?:升至|降至)\s*[-+]?\d',
    )
    number = re.compile(r'(?<![A-Za-z0-9])[-+]?\d+(?:\.\d+)?(?:\s*(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分))?(?![A-Za-z0-9])')
    # Match English setting labels beside Chinese text the same way JavaScript
    # does: Python treats Han characters as `\w`, while JS `\b` does not.
    setting = re.compile(r'(?:数据集|测试集|验证集|基准|评测|评价|协议|设置|条件|场景|任务|语料|套件|主干|对照|数据点|样本点|观测(?:点|值)|同一|相同|公开|内部|外部|语言|口音|性别|选项顺序|码切换|单语|多语|语言对|组合|(?<![A-Za-z0-9_])(?:on|test|benchmark|evaluation)(?![A-Za-z0-9_]))', re.IGNORECASE)
    named_setting = re.compile(
        r'(?:[A-Z][A-Za-z0-9._-]{2,}\s*[\u3400-\u9fff]{0,8}(?:集|数据集|语料|任务|基准)'
        r'|(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}(?:\s*[上中下]))',
        re.IGNORECASE,
    )
    has_complete_result = False
    for sentence in re.split(r'[。！？!?\n]', summary):
        result_sentence = _strip_core_summary_non_result_numerals(sentence)
        # A numeric metric qualifier such as R@0.9 or F1 identifies the
        # metric; it is not one endpoint of an experimental transition.
        # CLAP may be the comparison model rather than the measured metric;
        # mirror the Node contract's explicit baseline/model exclusion.
        metric_sentence = re.sub(
            r'\bCLAP\s*(?:基线|模型|baseline\b|model\b)',
            '', result_sentence, flags=re.IGNORECASE,
        )
        numeric_result_sentence = metric.sub(
            lambda match: re.sub(r'\d+(?:\.\d+)?', '', match.group(0)),
            metric_sentence,
        )
        numbers = number.findall(numeric_result_sentence)
        has_direction = comparison.search(result_sentence) or (
            len(numbers) >= 2 and baseline_transition.search(result_sentence)
        )
        has_metric = metric.search(metric_sentence) or conference_metric.search(metric_sentence)
        if has_metric and has_direction and numbers \
                and (setting.search(result_sentence) or named_setting.search(result_sentence)) \
                and (len(numbers) >= 2 or re.search(
                    r'(?:基线|对照|相比|相较|原方法|已有方法|先前方法|本文方法|本方法|所提方法|移除|完整模型|竞品)', result_sentence
                )) and not _has_cross_metric_directional_comparison(result_sentence):
            has_complete_result = True
            break
    if not has_complete_result and '原文未提供可核对的关键定量结果' not in summary:
        issues.append('缺少完整关键定量结果或明确不可得声明')
    explicit_boundary = re.search(
        r'(?:边界|局限|适用|失败|尚未|未覆盖|未验证|外推|仅限|受限)',
        summary,
    )
    separated_unverified_boundary = re.search(
        r'(?:尚未|未曾|未能|未|没有)[^。！？!?\n]{0,60}(?:验证|覆盖|评估|测试)',
        summary,
    )
    conditional_failure = re.search(
        r'(?:但|不过|然而)[^。！？!?\n]{0,80}(?:在|对)[^。！？!?\n]{1,60}'
        r'(?:时|下|中|上)[^。！？!?\n]{0,60}(?:可能|易|会|明显)?'
        r'(?:失真|退化|恶化|不稳定|不可靠|失效|下降|受损|偏差)',
        summary,
    )
    if not any((explicit_boundary, separated_unverified_boundary, conditional_failure)):
        issues.append('缺少结论适用边界、失败条件或未验证范围')
    scoped_resource_disclosure = any(
        re.search(r'(?:训练|推理|部署)', sentence)
        and re.search(r'\d', sentence)
        and re.search(
            r'(?:计算量|计算复杂度|MACs?|FLOPs?|GPU|CPU|TPU|NPU|RTX|显卡|'
            r'(?:训练|推理|采样|优化|迭代)步数|'
            r'\d\s*(?:[kKmMgG]\s*)?\s*(?:步|轮|次))',
            sentence,
            re.IGNORECASE,
        )
        for sentence in re.split(r'[。！？!?\n]', summary)
    )
    cost = '原文未披露训练、推理或部署成本' in summary \
        or re.search(r'(?:成本|代价|开销|硬件|算力|显存|内存|延迟|吞吐|实时率|能耗)', summary) \
        or re.search(r'(?:训练|推理|部署)[^。！？!?]{0,24}(?:需要|增加|额外|占用|耗时|更高|更低|受限|负担)', summary) \
        or scoped_resource_disclosure
    if not cost:
        issues.append('缺少训练、推理或部署成本或未披露声明')
    return '；'.join(issues) if issues else None


def _validated_detailed_core_summary(paper, parsed):
    """核验详细摘要的正文和阶段记录，并返回摘要文本。

    记录未声明当前详细摘要协议时，本函数返回 None。声明了该协议后，
    页面必须使用分析正文中经过本函数核验的详细摘要，不能改用编辑计划的一句话摘要。
    一句话摘要仍供页面元数据和简介使用；本函数不代表整篇分析或页面已通过所有检查。
    """
    manifest = paper.get('analysisManifest')
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    if not isinstance(contracts, dict) \
            or contracts.get('coreSummary') != CORE_SUMMARY_DETAILED_CONTRACT:
        return None
    stages = manifest.get('stages')
    stage = stages.get('coreSummaryRepair') if isinstance(stages, dict) else None
    scoring = stages.get('scoringAudit') if isinstance(stages, dict) else None
    if not isinstance(stage, dict) \
            or stage.get('status') not in {'complete', 'not_needed'} \
            or stage.get('contractVersion') != CORE_SUMMARY_DETAILED_CONTRACT:
        raise PublishDataValidationError('读者文章的详细核心摘要阶段记录缺失、尚未完成，或不符合 v3 规则。')
    analysis = paper.get('analysis')
    heading_issue = evaluation_heading_issue(analysis)
    if heading_issue:
        raise PublishDataValidationError(heading_issue)
    stored_analysis_fields = parse_analysis(analysis) if isinstance(analysis, str) else None
    summary = stored_analysis_fields.get('summary') if isinstance(stored_analysis_fields, dict) else None
    if not isinstance(summary, str) or not summary.strip():
        raise PublishDataValidationError('读者文章缺少有效的详细核心摘要正文。')
    summary = summary.strip()
    semantic_issue = _detailed_core_summary_semantic_issue(summary)
    if semantic_issue:
        raise PublishDataValidationError(
            f'读者文章的详细核心摘要未达到 {CORE_SUMMARY_DETAILED_CONTRACT}: '
            f'{semantic_issue}'
        )
    if isinstance(parsed, dict) and parsed.get('summary') != summary:
        raise PublishDataValidationError('读者文章的已解析核心摘要与分析正文中的摘要不一致。')
    summary_sha = _javascript_string_sha256(summary)
    if stage.get('summarySha256') != summary_sha:
        raise PublishDataValidationError('读者文章的详细核心摘要 SHA 与阶段记录不一致。')
    required_stage_shas = (
        'fingerprint', 'inputAnalysisSha256', 'outputAnalysisSha256',
        'inputSummarySha256', 'inputStructureProjectionSha256',
        'outputStructureProjectionSha256', 'bindingSha256',
    )
    if any(not re.fullmatch(r'[0-9a-f]{64}', str(stage.get(field) or ''))
           for field in required_stage_shas):
        raise PublishDataValidationError('读者文章的详细核心摘要阶段记录中，输入指纹或相关 SHA 缺失，或格式无效。')
    if stage.get('inputStructureProjectionSha256') \
            != stage.get('outputStructureProjectionSha256'):
        raise PublishDataValidationError('读者文章的详细核心摘要阶段记录中，输入与输出的其他章节 SHA 不一致。')
    binding_body = {
        'contractVersion': stage['contractVersion'],
        'inputAnalysisSha256': stage['inputAnalysisSha256'],
        'outputAnalysisSha256': stage['outputAnalysisSha256'],
        'inputSummarySha256': stage['inputSummarySha256'],
        'summarySha256': stage['summarySha256'],
        'inputStructureProjectionSha256': stage['inputStructureProjectionSha256'],
        'outputStructureProjectionSha256': stage['outputStructureProjectionSha256'],
    }
    if stage.get('bindingSha256') != _stable_json_sha256(binding_body):
        raise PublishDataValidationError('读者文章的详细核心摘要绑定 SHA 与按原字段重新计算的结果不一致。')
    structure = stages.get('structureRepair') if isinstance(stages, dict) else None
    try:
        tag_record = read_tag_stage_record(manifest, paper.get('analysisStageCheckpoints'))
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error
    tag_stage = tag_record['stage']
    tag_contract = contracts.get(tag_record['contractKey'])
    has_tag_stage = isinstance(stages, dict) and tag_record['stageKey'] in stages
    if tag_record['format'] == 'current' or tag_contract is not None or has_tag_stage:
        expected_contract = (TAG_STAGE_RECORD_CONTRACT if tag_record['format'] == 'current'
                             else tag_stage.get('selectionContract') if isinstance(tag_stage, dict) else None)
        if tag_contract != expected_contract \
                or not isinstance(tag_stage, dict) \
                or tag_stage.get('selectionContract') not in (
                    LEGACY_TAG_SELECTION_CONTRACT, TAG_SELECTION_CONTRACT) \
                or tag_stage.get('status') not in {'complete', 'not_needed'} \
                or not re.fullmatch(
                    r'[0-9a-f]{64}', str(tag_stage.get('outputAnalysisSha256') or '')
                ):
            raise PublishDataValidationError(
                '读者文章的详细核心摘要所依赖的标签阶段记录缺失或无效。'
            )
        upstream = tag_stage
        upstream_label = tag_record['stageKey']
        upstream_checkpoint = tag_record['checkpoint']
        checkpoint_parsed = parse_analysis(upstream_checkpoint) \
            if isinstance(upstream_checkpoint, str) else None
        checkpoint_summary = checkpoint_parsed.get('summary') \
            if isinstance(checkpoint_parsed, dict) else None
        if not isinstance(upstream_checkpoint, str) \
                or not isinstance(checkpoint_summary, str) \
                or _javascript_string_sha256(upstream_checkpoint) \
                != upstream.get('outputAnalysisSha256') \
                or _javascript_string_sha256(
                    checkpoint_summary.strip()
                ) != stage.get('inputSummarySha256') \
                or _analysis_sha256_ignoring_core_summary_body(upstream_checkpoint) \
                != stage.get('inputStructureProjectionSha256'):
            raise PublishDataValidationError(
                '读者文章的详细核心摘要所依赖的标签阶段正文或摘要缺失、格式无效，或正文、摘要或其他章节的 SHA 与阶段记录不一致。'
            )
    else:
        # 旧记录的标签协议值为 None，且未保存旧标签阶段键时，
        # 摘要阶段可以直接连接 structureRepair。协议值不是 None 或阶段键已出现时，
        # 本函数必须检查标签阶段，不能回退到结构阶段；新格式也不使用此例外。
        upstream = structure
        upstream_label = 'structureRepair'
    if not isinstance(upstream, dict) \
            or upstream.get('outputAnalysisSha256') != stage.get('inputAnalysisSha256'):
       raise PublishDataValidationError(
           f'读者文章的详细核心摘要输入与 {upstream_label} 阶段输出的 SHA 不一致，或上游阶段记录缺失。'
       )
    if not isinstance(scoring, dict):
        raise PublishDataValidationError('读者文章的评分阶段记录缺失，或评分使用的正文或详细核心摘要 SHA 与阶段记录不一致。')
    if scoring.get('status') != MANUAL_REVIEW_MODE:
        analysis_sha = _javascript_string_sha256(analysis)
        # 读者文章页面按来源记录展示官方图片。历史 imageSupplement=complete
        # 的成功记录没有保留添图前正文，本函数无法只凭三个 SHA 字段
        # 确认变化仅限图片。因此，非人工复核的评分输出仍须与最终分析正文绑定。
        scoring_binds_final = scoring.get('outputAnalysisSha256') == analysis_sha
        if not scoring_binds_final \
                or scoring.get('coreSummaryInputAnalysisSha256') != stage.get('outputAnalysisSha256') \
                or scoring.get('inputCoreSummarySha256') != summary_sha \
                or scoring.get('outputCoreSummarySha256') != summary_sha:
            raise PublishDataValidationError('读者文章的评分阶段记录缺失，或评分使用的正文或详细核心摘要 SHA 与阶段记录不一致。')
    return summary


def _build_api_reader_display_fields(paper, payload=None):
    """返回读者文章页面使用的摘要、资源情况和评分说明；未使用对应格式时返回 None。"""
    payload = _api_reader_payload(paper) if payload is None else payload
    if not payload or payload.get('contract') != LLM_API_READER_CONTRACT:
        return None
    labels = {
        'code': '代码相关资源', 'model': '模型相关资源', 'dataset': '数据相关资源',
        'demo': '演示资源', 'reproduction': '复现相关资源', 'third_party': '第三方资源',
    }
    statuses = {
        'available': '链接可访问', 'unavailable': '链接不可用',
        'temporarily_unreachable': '暂时无法访问',
    }
    resources = payload['resourceIdentityProof']['resources']
    lines = []
    for resource in resources:
        # Keep source URLs clickable without permitting Markdown/HTML escapes.
        def link(url):
            return '<' + re.sub(r'[<>"\\\s]', lambda m: quote(m.group(0), safe=''), url) + '>'
        url_text = link(resource['originalUrl'])
        if resource['finalUrl'] != resource['originalUrl']:
            url_text += ' → ' + link(resource['finalUrl'])
        status = statuses[resource['availability']]
        if resource['status'] is not None:
            status += f'（HTTP {resource["status"]}）'
        documentation = resource.get('documentationEvidence')
        if isinstance(documentation, dict) \
                and documentation.get('completeness') == 'complete':
            status += '；README 已验证包含安装、推理与微调文档'
        lines.append(f'- {labels[resource["type"]]}：{url_text} — {status}')
    if not lines:
        lines.append('本次未形成可展示的已核验资源记录，开放状态尚未核实。')
    lines.append('可达状态仅表示本次链接检查结果，不代表许可证、本文权重或运行复现已验证。')
    parsed = paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {}
    scoring_note_lines = ['评分属于系统判断，不是论文实验结果；八维数值与总分见页首，原始审计记录保留在后端。']
    stages = (paper.get('analysisManifest') or {}).get('stages') or {}
    scoring = stages.get('scoringAudit') or {}
    for label, value in (
            ('评分规则', paper.get('scoringRubricVersion') or parsed.get('scoringRubricVersion')),
            ('评分模型', scoring.get('model')), ('评分请求协议', scoring.get('protocol'))):
        if isinstance(value, str) and value.strip():
            safe_value = html.escape(re.sub(r'\s+', ' ', value.strip()))
            scoring_note_lines.append(f'- {label}：{safe_value}')
    detailed_summary = _validated_detailed_core_summary(paper, parsed)
    visible_summary = detailed_summary or payload['plan']['oneSentenceThesis'].strip()
    # 这里只在发布视图中修正这处重复的中英文术语，不改写论文记录中的摘要。
    visible_summary = visible_summary.replace(
        '音频推测推测解码 Audio Speculative Speculative Decoding',
        '音频推测解码 Audio Speculative Decoding',
    )
    return {
        'summary': visible_summary,
        'opensource': '\n\n'.join(lines),
        'scoringReason': '\n\n'.join(scoring_note_lines),
    }


def _api_reader_index_display_fields_issue(content, papers):
    """逐篇核对汇总页中的展示内容是否与对应读者文章记录一致，不修改页面。"""
    blocks = re.split(r'^### ', content.split('## 📋 论文列表', 1)[-1], flags=re.MULTILINE)[1:]
    for paper in papers:
        reader_display_fields = _build_api_reader_display_fields(paper)
        if reader_display_fields is None:
            continue
        aid = paper.get('arxivId', '')
        source_url = _visible_arxiv_source_url(paper)
        matches = [block for block in blocks if f'{source_url})' in block]
        if len(matches) != 1:
            return f'{aid}：汇总页中对应论文的内容缺失，或出现多个匹配块。'
        block = matches[0]
        if find_evaluation_headings(block, rendered=True):
            return f'{aid}：汇总页中对应论文的内容含有不允许展示的论文评价栏目。'
        for key, label, end in (
                ('summary', '📌 **核心摘要**', r'\n\n🔗 \*\*开源资源\*\*'),
                ('opensource', '🔗 **开源资源**', r'\n\n---')):
            match = re.search(re.escape(label) + r'\n\n([\s\S]*?)' + end, block)
            expected = sanitize_markdown_for_publish(reader_display_fields[key]).strip()
            if not match or match.group(1).strip() != expected:
                return f'{aid}：汇总页中 {key} 对应的摘要或资源内容缺失，或与对应读者文章记录的展示内容不一致。'
    return None


def full_index_decision_block(parsed_analysis, paper, key, *, reader_article='', api_reader_v2=False,
                              reader_display_fields=None):
    """根据对应的摘要或资源内容构造汇总展示块，并按汇总页需要整理标题和图片。"""
    content = reader_display_fields[key] if reader_display_fields is not None \
        else parsed_analysis.get(key, '') if isinstance(parsed_analysis, dict) else ''
    if not isinstance(content, str) or not content.strip():
        return ''
    content = content.strip()
    if key == 'summary':
        cutoff = re.search(r'\n##\s*详细分', content)
        if cutoff:
            content = content[:cutoff.start()].strip()
    elif key == 'opensource':
        supplement = re.search(r'##\s*补充信息\s*\n[\s\S]*', content)
        if supplement:
            content = content[:supplement.start()].strip()
    if reader_article:
        content = _strip_non_reader_article_images(
            content, _reader_first_image_plans_by_url(paper),
        )
        content = _nest_reader_headings(
            content, minimum_level=3 if api_reader_v2 else 4,
        )
    else:
        content = re.sub(r'^(?:#{1,6}\s*[^\n]+\n+)+', '', content, count=1)
    content = re.sub(r'^###\s*\d+\.\s*[^\n]+\n', '', content, flags=re.MULTILINE)
    content = re.sub(
        r'^\d+\.\s*\*\*([^*]+)\*\*\s*$', r'\1', content,
        flags=re.MULTILINE,
    )
    return content.strip()


def index_author_institution_block(paper, parsed_analysis, api_reader=None):
    """优先展示读者文章记录中的作者和机构；没有可用列表时，使用已解析的作者文本。"""
    reader_authors = api_reader.get('readerAuthors') if isinstance(api_reader, dict) else None
    authors = reader_authors.get('authors') if isinstance(reader_authors, dict) else None
    if isinstance(authors, list) and authors:
        return '\n'.join(
            f'- {author["name"]}：{"；".join(author["affiliations"])}'
            for author in authors
        )
    fallback = parsed_analysis.get('authors', '') if isinstance(parsed_analysis, dict) else ''
    return fallback.strip() if isinstance(fallback, str) else ''


def normalize_digest_index_preserving_decision_blocks(markdown):
    """整理汇总页自身的文字，保留匹配到的作者机构、摘要及其后续内容块。"""
    pattern = re.compile(
        r'^👥 \*\*作者与机构\*\*\n\n[\s\S]*?'
        r'(?=\n\n(?:💡 \*\*(?:论文评价|毒舌点评)\*\*|📌 \*\*核心摘要\*\*))|'
        r'^📌 \*\*核心摘要\*\*\n\n[\s\S]*?(?=^---$)',
        flags=re.MULTILINE,
    )
    output = []
    cursor = 0
    for match in pattern.finditer(markdown):
        output.append(normalize_digest_index_reader_surface(markdown[cursor:match.start()]))
        output.append(match.group(0))
        cursor = match.end()
    output.append(normalize_digest_index_reader_surface(markdown[cursor:]))
    return ''.join(output)


def format_display_tags(tags):
    """Flatten compound hashtag strings into one stable, deduplicated tag row."""
    values = [tags] if isinstance(tags, str) else list(tags or [])
    flattened = []
    for value in values:
        text = str(value or '').strip()
        if not text:
            continue
        hashtags = re.findall(r'#[^\s#|]+', text)
        flattened.extend(hashtags or [text])
    return ' | '.join(dict.fromkeys(flattened))


def build_index_context_line(parsed_analysis, aurl=''):
    """Render non-duplicated ranking/source metadata below the score row."""
    bits = []
    if isinstance(parsed_analysis, dict) and parsed_analysis.get('rankBucket'):
        bits.append(f'排名：{parsed_analysis["rankBucket"]}')
    if isinstance(parsed_analysis, dict) and parsed_analysis.get('documentType'):
        bits.append(f'文档类型：{parsed_analysis["documentType"]}')
    if aurl:
        bits.append(f'[arXiv 原文]({aurl})')
    return ' | '.join(bits)


def _current_batch_tag_metadata(papers):
    if not papers:
        return None
    papers = list(papers)
    try:
        for paper in papers:
            read_tag_validation(paper.get('parsed'))
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error
    selections = []
    for paper in papers:
        parsed = paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {}
        metadata = build_flat_tag_compat_metadata(parsed)
        if metadata is None:
            return None
        selections.append(metadata)
    first = selections[0]
    if any(item['registryVersion'] != first['registryVersion']
           or item['registrySha256'] != first['registrySha256']
           or item['selectionContract'] != first['selectionContract']
           for item in selections[1:]):
        raise PublishDataValidationError('汇总页中的标签选择记录使用了不同的词表版本、词表 SHA 或标签选择协议。')
    counts = {}
    for item in selections:
        tag = f'#{item["primaryTask"]}'
        counts[tag] = counts.get(tag, 0) + 1
    primary_tasks = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return {
        'contract': FLAT_TAG_COMPAT_CONTRACT,
        'selectionContract': first['selectionContract'],
        'registryVersion': first['registryVersion'],
        'registrySha256': first['registrySha256'],
        'primaryTasks': primary_tasks,
    }


def generate_index_page(scored, unscored, date_str, paper_slugs, category='论文速递'):
    """生成每日汇总页面（index.md），包含概览和每篇论文的链接"""
    total = len(scored) + len(unscored)
    papers = [p for _, p, _ in scored] + unscored
    tag_set = extract_all_tags(papers, limit=10)
    tag_metadata = _current_batch_tag_metadata(papers)
    top_tags = tag_metadata['primaryTasks'][:8] if tag_metadata \
        else extract_top_tags(papers, limit=8)
    tag_frontmatter = ''
    if tag_metadata:
        tag_frontmatter = (
            f'paper_digest_taxonomy_contract: "{tag_metadata["contract"]}"\n'
            f'paper_digest_taxonomy_selection_contract: "{tag_metadata["selectionContract"]}"\n'
            f'paper_digest_taxonomy_registry_version: "{tag_metadata["registryVersion"]}"\n'
            f'paper_digest_taxonomy_registry_sha256: "{tag_metadata["registrySha256"]}"\n'
            'paper_digest_taxonomy_scope: "aggregate-primary-task-counts"\n'
        )

    conference_title = f'ICML 2026 论文速递' if category == 'icml-2026' else f'语音/音乐/音频论文速递 {date_str}'
    md = f"""---
title: "{conference_title}"
date: {date_str}
draft: false
tags: [{', '.join(tag_set)}]
categories: [{category}]
description: "共分析 {total} 篇语音/AI 论文"
layout: "posts"
paper_digest_pipeline_owned: true
paper_digest_page_type: index
paper_digest_reader_quality: "{DIGEST_INDEX_READER_QUALITY_VERSION}"
{tag_frontmatter}---

# {conference_title}

共分析 **{total}** 篇论文

---

## ⚡ 今日概览

✅ 筛选入选 {total} 篇 → 🔬 深度分析完成

{'🏷️ 标签说明：本期标签来自新版词表；站点标签页暂时兼容展示历史标签与新标签。' if tag_metadata else ''}

### 🏷️ 热门方向

"""
    md += "| 方向 | 数量 | 分布 |\n|------|------|------|\n"
    for tag, cnt in top_tags:
        bar = '█' * min(cnt, 15)
        md += f"| {tag} | {cnt} 篇 | {bar} |\n"

    md += f"""
### 📊 论文评分排行榜（{len(scored)} 篇，按分数降序）

"""
    md += "| 排名 | 论文 | 总分 | 分档 | 文档类型 | 主任务 |\n|------|------|------|------|----------|--------|\n"
    for i, (score, p, parsed_analysis) in enumerate(scored):
        m = format_medal(i)
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        rank_bucket = parsed_analysis.get('rankBucket', '') or '-'
        document_type = parsed_analysis.get('documentType', '') or '-'
        primary_task = parsed_analysis.get('primaryTaskTag', '') or '-'
        compact_title = compact_title_for_ranking(title)
        if slug:
            md += f"| {m} | [{compact_title}]({BASE_PATH}/posts/{date_str}-{slug}) | {score} | {rank_bucket} | {document_type} | {primary_task} |\n"
        else:
            md += f"| {m} | {compact_title} | {score} | {rank_bucket} | {document_type} | {primary_task} |\n"
    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        compact_title = compact_title_for_ranking(title)
        if slug:
            md += f"| {len(scored)+i+1} | [{compact_title}]({BASE_PATH}/posts/{date_str}-{slug}) | N/A | - | - | - |\n"
        else:
            md += f"| {len(scored)+i+1} | {compact_title} | N/A | - | - | - |\n"

    md += "\n---\n\n"
    md += (
        "## 📋 论文列表\n\n"
        "> 🖼️ 有图的论文会在这里展示首张原论文图；原图链接见对应独立页面。\n\n"
    )

    def index_figure_preview(paper, reader_article):
        """Project the first source-bound paper figure as an index thumbnail.

        The signed Reader article remains the source of truth.  Reusing its
        complete Markdown image line keeps the alt text and arXiv URL bound to
        the same evidence while Hugo's image hook serves the local mirror.
        """
        if not isinstance(reader_article, str):
            return ''
        for line in reader_article.splitlines():
            stripped = line.strip()
            match = re.fullmatch(
                r'!\[(?:\\.|[^\]\\\n])*\]\((https://[^)\s]+)\)',
                stripped,
            )
            if not match:
                continue
            source_url = match.group(1)
            figure = next(
                (
                    item for item in (paper.get('apiReaderFigures') or [])
                    if isinstance(item, dict) and item.get('url') == source_url
                ),
                None,
            )
            ordinal = figure.get('ordinal') if isinstance(figure, dict) else 1
            if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal < 1:
                return ''
            extension = '.svg' if urlparse(source_url).path.lower().endswith('.svg') else '.png'
            digest = hashlib.sha256(source_url.encode('utf-8')).hexdigest()[:16]
            # API Reader v3 figures are ephemeral: their pixels may be
            # materialized only for the current call and must not be written
            # into the blog repository.  Keep the official HTTPS source in
            # the digest index for that contract; only persistent Reader
            # assets may be projected to a local mirror URL.
            if figure is not None and figure.get('cachePath'):
                local_url = (
                    f'{BASE_PATH}/images/papers/{normalize_arxiv_id(paper.get("arxivId"))}/'
                    f'figure-{ordinal}-{digest}{extension}'
                )
                local_image = stripped.replace(f'({source_url})', f'({local_url})', 1)
            else:
                local_image = stripped
            return local_image
        return ''

    for i, (score, p, parsed_analysis) in enumerate(scored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        m = format_medal(i)

        heading_issue = evaluation_heading_issue(p.get('analysis'))
        if heading_issue:
            raise PublishDataValidationError(heading_issue)
        parsed_analysis = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
        aid = p.get('arxivId', '')
        aurl = _visible_arxiv_source_url(p)
        api_reader = _api_reader_payload(p)
        reader_display_fields = _build_api_reader_display_fields(p, api_reader)
        if api_reader:
            reader_plan = api_reader['plan']
            reader_article = api_reader['article']
        else:
            reader_plan = _manual_reader_editorial_plan(p)
            reader_article = _manual_reader_article(p, reader_plan, date_str)
        reader_title = reader_plan['readerTitle'].strip() if reader_article else title
        blog_url = f'{BASE_PATH}/posts/{date_str}-{slug}' if slug else ''
        if slug:
            md += f"### {m} [{reader_title}]({blog_url})\n\n"
        else:
            md += f"### {m} {reader_title}\n\n"
        preview = index_figure_preview(p, reader_article)
        if preview:
            md += f"{preview}\n\n"
        if reader_article:
            english_title = f'[{title}]({blog_url})' if blog_url else title
            md += f"> 英文题目：*{english_title}*\n\n"
        tags = parsed_analysis.get('tags') or []
        display_tags = format_display_tags(tags)
        if display_tags:
            md += f"标签：{display_tags}\n\n"
        
        score_line = format_complete_score_line(parsed_analysis)
        if score_line:
            md += f"评分：{score_line}\n\n"

        context_line = build_index_context_line(parsed_analysis, aurl)
        if context_line:
            md += f"{context_line}\n\n"
        md += _historical_source_notice(p)

        author_institutions = index_author_institution_block(p, parsed_analysis, api_reader)
        if author_institutions:
            md += f"👥 **作者与机构**\n\n{author_institutions}\n\n"
        
        if reader_display_fields is None and parsed_analysis.get('roast'):
            md += f"💡 **论文评价**\n\n{parsed_analysis['roast']}\n\n"

        summary = full_index_decision_block(
            parsed_analysis, p, 'summary', reader_article=reader_article,
            api_reader_v2=bool(api_reader),
            reader_display_fields=reader_display_fields,
        )
        if summary:
            md += f"📌 **核心摘要**\n\n{summary}\n\n"

        opensource = full_index_decision_block(
            parsed_analysis, p, 'opensource', reader_article=reader_article,
            api_reader_v2=bool(api_reader),
            reader_display_fields=reader_display_fields,
        )
        if opensource:
            md += f"🔗 **开源资源**\n\n{opensource}\n\n"

        md += "---\n\n"

    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')

        # unscored 论文也使用与评分论文相同的读者顺序。
        heading_issue = evaluation_heading_issue(p.get('analysis'))
        if heading_issue:
            raise PublishDataValidationError(heading_issue)
        parsed_analysis = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
        aid = p.get('arxivId', '')
        aurl = _visible_arxiv_source_url(p)
        api_reader = _api_reader_payload(p)
        reader_display_fields = _build_api_reader_display_fields(p, api_reader)
        if api_reader:
            reader_plan = api_reader['plan']
            reader_article = api_reader['article']
        else:
            reader_plan = _manual_reader_editorial_plan(p)
            reader_article = _manual_reader_article(p, reader_plan)
        reader_title = reader_plan['readerTitle'].strip() if reader_article else title
        blog_url = f'{BASE_PATH}/posts/{date_str}-{slug}' if slug else ''
        if slug:
            md += f"### {len(scored)+i+1}. [{reader_title}]({blog_url})\n\n"
        else:
            md += f"### {len(scored)+i+1}. {reader_title}\n\n"
        preview = index_figure_preview(p, reader_article)
        if preview:
            md += f"{preview}\n\n"
        if reader_article:
            english_title = f'[{title}]({blog_url})' if blog_url else title
            md += f"> 英文题目：*{english_title}*\n\n"
        tags = parsed_analysis.get('tags') or []
        display_tags = format_display_tags(tags)
        if display_tags:
            md += f"标签：{display_tags}\n\n"
        md += '评分：N/A（分析未提供可验证的八维评分）\n\n'
        context_line = build_index_context_line(parsed_analysis, aurl)
        if context_line:
            md += f"{context_line}\n\n"
        md += _historical_source_notice(p)
        author_institutions = index_author_institution_block(p, parsed_analysis, api_reader)
        if author_institutions:
            md += f"👥 **作者与机构**\n\n{author_institutions}\n\n"
        if reader_display_fields is None and parsed_analysis.get('roast'):
            md += f"💡 **论文评价**\n\n{parsed_analysis['roast']}\n\n"

        summary = full_index_decision_block(
            parsed_analysis, p, 'summary', reader_article=reader_article,
            api_reader_v2=bool(api_reader),
            reader_display_fields=reader_display_fields,
        )
        if summary:
            md += f"📌 **核心摘要**\n\n{summary}\n\n"

        opensource = full_index_decision_block(
            parsed_analysis, p, 'opensource', reader_article=reader_article,
            api_reader_v2=bool(api_reader),
            reader_display_fields=reader_display_fields,
        )
        if opensource:
            md += f"🔗 **开源资源**\n\n{opensource}\n\n"

        md += "---\n\n"

    return sanitize_markdown_for_publish(
        normalize_digest_index_preserving_decision_blocks(md)
    )


import urllib.request

_REPO_URL_PATTERNS = [
    r'https?://github\.com/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:/[^\s<>"{}|\\^`\[\]，。；：！？、（）【】《》“”‘’]+)?',
    r'https?://huggingface\.co/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:/[^\s<>"{}|\\^`\[\]，。；：！？、（）【】《》“”‘’]+)?',
    r'https?://modelscope\.cn/[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+(?:/[^\s<>"{}|\\^`\[\]，。；：！？、（）【】《》“”‘’]+)?',
]

_IGNORED_GH = {'github.com/arXiv', 'github.com/brucemiller', 'github.com/ggml-org'}


def extract_repo_urls(text):
    """从文本中提取 GitHub / HuggingFace / ModelScope 链接"""
    if not text:
        return []
    urls = set()
    for pat in _REPO_URL_PATTERNS:
        for m in re.finditer(pat, text):
            url = m.group(0).rstrip('.,;:)')
            if any(ig in url for ig in _IGNORED_GH):
                continue
            urls.add(url)
    return sorted(urls)


def enrich_opensource(parsed_analysis, paper):
    """仅从已审计的本地输入提取开源链接，生成阶段不联网。"""
    oss = parsed_analysis.get('opensource', '')
    if not oss:
        return ''

    sources = []
    for key in ('abstract', 'analysis', 'comments'):
        val = paper.get(key, '')
        if val:
            sources.append(val)

    urls = extract_repo_urls('\n'.join(sources))
    if not urls:
        return oss

    missing = [u for u in urls if u not in oss]
    if not missing:
        return oss

    oss += '\n\n- 补充链接（自动提取）：'
    for url in missing:
        if 'github.com' in url:
            oss += f'\n  - 代码仓库：{url}'
        elif 'huggingface.co' in url:
            oss += f'\n  - HuggingFace：{url}'
        elif 'modelscope.cn' in url:
            oss += f'\n  - ModelScope：{url}'
        else:
            oss += f'\n  - 相关链接：{url}'
    return oss


def _visual_summary_analysis_sha256(paper):
    """Mirror visual-summary-state.js analysisSha256 exactly."""
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    stages = manifest.get('stages') if isinstance(manifest.get('stages'), dict) else {}
    payload = {
        'arxivId': normalize_publish_arxiv_id(paper.get('arxivId')),
        'analysis': paper.get('analysis'),
        'parsed': paper.get('parsed') or None,
        'analysisSource': paper.get('analysisSource') or None,
        'analysisSourceSha256': paper.get('analysisSourceSha256') or paper.get('sourceSha256') or None,
        'scoringAudit': stages.get('scoringAudit') or None,
    }
    return _stable_json_sha256(payload)


def _validate_png_bytes(raw, label):
    if not raw or len(raw) > VISUAL_SUMMARY_MAX_BYTES:
        raise PublishDataValidationError(f'{label} PNG 为空或超过 8 MiB')
    if not raw.startswith(PNG_SIGNATURE):
        raise PublishDataValidationError(f'{label} 不是有效 PNG 文件头')
    offset = len(PNG_SIGNATURE)
    chunks = []
    width = height = None
    saw_idat = False
    saw_iend = False
    while offset < len(raw):
        if offset + 12 > len(raw):
            raise PublishDataValidationError(f'{label} PNG chunk 被截断')
        length = struct.unpack('>I', raw[offset:offset + 4])[0]
        chunk_type = raw[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(raw):
            raise PublishDataValidationError(f'{label} PNG chunk 长度越界')
        payload = raw[offset + 8:offset + 8 + length]
        expected_crc = struct.unpack('>I', raw[offset + 8 + length:end])[0]
        actual_crc = zlib.crc32(chunk_type + payload) & 0xffffffff
        if expected_crc != actual_crc:
            raise PublishDataValidationError(f'{label} PNG chunk CRC 错误')
        chunks.append(chunk_type)
        if chunk_type == b'IHDR':
            if len(chunks) != 1 or length != 13:
                raise PublishDataValidationError(f'{label} PNG IHDR 非法')
            width, height = struct.unpack('>II', payload[:8])
            if not (1 <= width <= 8192 and 1 <= height <= 8192):
                raise PublishDataValidationError(f'{label} PNG 尺寸非法: {width}x{height}')
            if width < 768 or height < 1024 or height / width < 1.25:
                raise PublishDataValidationError(
                    f'{label} 必须是至少 768x1024 且高宽比不低于 1.25 '
                    f'的纵向长图: {width}x{height}'
                )
        elif chunk_type == b'IDAT':
            saw_idat = True
        elif chunk_type == b'IEND':
            if length != 0 or end != len(raw):
                raise PublishDataValidationError(f'{label} PNG IEND 非法或尾部有多余数据')
            saw_iend = True
            offset = end
            break
        offset = end
    if not chunks or chunks[0] != b'IHDR' or not saw_idat or not saw_iend:
        raise PublishDataValidationError(f'{label} PNG 缺少 IHDR/IDAT/IEND 必需 chunk')
    return hashlib.sha256(raw).hexdigest()


def load_visual_summary_cards(papers, date_str, manifest_path=None):
    """Legacy verifier retained for data forensics; the blog pipeline never calls it."""
    manifest_path = Path(manifest_path or (VISUAL_SUMMARY_MANIFEST_DIR / f'{date_str}.json'))
    if not manifest_path.is_file():
        raise PublishDataValidationError(
            f'缺少强制视觉摘要 manifest: {manifest_path}；'
            '每篇论文必须先完成一张 infographic 纵向长图'
        )
    manifest = _load_json_object(manifest_path, '视觉摘要 manifest')
    if manifest.get('version') != 2 or manifest.get('batchDate') != date_str:
        raise PublishDataValidationError('视觉摘要 manifest 版本或批次日期不匹配')
    prompt_path = Path(__file__).resolve().parent.parent / 'prompts' / 'visual-summary.md'
    prompt_sha = _sha256_file(prompt_path)
    if manifest.get('promptSha256') != prompt_sha:
        raise PublishDataValidationError('视觉摘要 manifest 的 prompt SHA 已失效，请重新 plan')
    records = manifest.get('papers')
    if not isinstance(records, dict):
        raise PublishDataValidationError('视觉摘要 manifest.papers 必须是对象')

    expected_ids = {normalize_publish_arxiv_id(paper.get('arxivId')) for paper in papers}
    if set(records) != expected_ids:
        raise PublishDataValidationError('视觉摘要 manifest 论文集合与博客发布集合不一致')

    project_root = Path(__file__).resolve().parent.parent
    allowed_root = (VISUAL_SUMMARY_ASSET_DIR / date_str / 'visual-summaries').resolve()
    enriched = []
    assets = []
    for paper in papers:
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
        record = records.get(paper_id)
        expected_analysis_sha = _visual_summary_analysis_sha256(paper)
        if (
            not isinstance(record, dict)
            or record.get('normalizedArxivId') != paper_id
            or record.get('batchDate') != date_str
            or not isinstance(record.get('rank'), int)
            or not 1 <= record.get('rank') <= 10
            or record.get('analysisSha256') != expected_analysis_sha
            or record.get('promptSha256') != prompt_sha
        ):
            raise PublishDataValidationError(f'{paper_id} 视觉摘要论文指纹已失效')
        cards = record.get('cards')
        if not isinstance(cards, dict) or set(cards) != set(VISUAL_SUMMARY_KINDS):
            raise PublishDataValidationError(f'{paper_id} 必须恰好包含一张视觉摘要长图')
        publish_cards = []
        for kind in VISUAL_SUMMARY_KINDS:
            card = cards[kind]
            if (
                not isinstance(card, dict)
                or card.get('status') != 'complete'
                or card.get('analysisSha256') != expected_analysis_sha
                or card.get('promptSha256') != prompt_sha
                or not re.fullmatch(r'[0-9a-f]{64}', str(card.get('assetSha256') or ''))
            ):
                raise PublishDataValidationError(f'{paper_id}/{kind} 视觉摘要未完成或指纹非法')
            asset_path = card.get('assetPath')
            if not isinstance(asset_path, str) or not asset_path:
                raise PublishDataValidationError(f'{paper_id}/{kind} 缺少资产路径')
            source = (project_root / asset_path).resolve()
            normalized_title = unicodedata.normalize('NFKD', str(paper.get('title') or ''))
            ascii_title = ''.join(char for char in normalized_title if not unicodedata.combining(char))
            title_slug = re.sub(r'[^a-z0-9]+', '-', ascii_title.lower()).strip('-')[:64].rstrip('-') or 'paper'
            expected_source = (
                allowed_root / f'{record["rank"]:02d}-{paper_id}-{title_slug}.png'
            ).resolve()
            if source != expected_source:
                raise PublishDataValidationError(f'{paper_id}/{kind} 视觉摘要资产路径不受控')
            try:
                raw = source.read_bytes()
            except OSError as exc:
                raise PublishDataValidationError(f'{paper_id}/{kind} 视觉摘要资产不可读') from exc
            actual_sha = _validate_png_bytes(raw, f'{paper_id}/{kind}')
            if actual_sha != card['assetSha256']:
                raise PublishDataValidationError(f'{paper_id}/{kind} 视觉摘要资产 SHA 不匹配')
            public_relative = f'images/visual-summaries/{date_str}/{paper_id}/{kind}.png'
            repo_relative = f'static/{public_relative}'
            url = f'{BASE_PATH.rstrip("/")}/{public_relative}'
            item = {
                'kind': kind,
                'label': VISUAL_SUMMARY_LABELS[kind],
                'assetSha256': actual_sha,
                'sourcePath': str(source),
                'repoRelativePath': repo_relative,
                'url': url,
            }
            publish_cards.append({
                key: value for key, value in item.items() if key != 'sourcePath'
            })
            assets.append(item)
        next_paper = dict(paper)
        next_paper['visualSummaryCards'] = publish_cards
        enriched.append(next_paper)
    return enriched, assets


def _digest_title(date_str, category='论文速递'):
    return 'ICML 2026 论文速递' if category == 'icml-2026' else f'语音/音乐/音频论文速递 {date_str}'


def _digest_cover_context(papers, date_str, category='论文速递'):
    tag_counts = {}
    scored = []
    for paper in papers:
        parsed = paper.get('parsed') or {}
        tags = parsed.get('tags') or []
        tag = str(parsed.get('primaryTaskTag') or (tags[0] if tags else '')).strip()
        if tag:
            tag_counts[tag] = tag_counts.get(tag, 0) + 1
        try:
            score = float(parsed.get('score'))
        except (TypeError, ValueError):
            continue
        scored.append({
            'arxivId': normalize_publish_arxiv_id(paper.get('arxivId')),
            'title': str(paper.get('title') or ''),
            'score': str(parsed.get('score')),
            'primaryTask': tag or '-',
            '_numericScore': score,
        })
    hot_directions = [
        {'tag': tag, 'count': count}
        for tag, count in sorted(tag_counts.items(), key=lambda item: (-item[1], item[0]))[:8]
    ]
    ranking = []
    for index, item in enumerate(sorted(
        scored, key=lambda value: (-value['_numericScore'], value['arxivId'])
    )[:DIGEST_COVER_RANKING_LIMIT]):
        clean = {key: value for key, value in item.items() if key != '_numericScore'}
        ranking.append({'rank': index + 1, **clean})
    return {
        'title': _digest_title(date_str, category),
        'batchDate': date_str,
        'paperCount': len(papers),
        'hotDirections': hot_directions,
        'rankingCount': len(ranking),
        'rankingLimit': DIGEST_COVER_RANKING_LIMIT,
        'ranking': ranking,
        'rendering': DIGEST_COVER_RENDERING_CONTRACT,
    }


def load_digest_cover(papers, date_str, manifest_path=None, category='论文速递'):
    """Legacy verifier retained for data forensics; the blog pipeline never calls it."""
    manifest_path = Path(manifest_path or (DIGEST_COVER_MANIFEST_DIR / f'{date_str}.json'))
    if not manifest_path.is_file():
        raise PublishDataValidationError(f'缺少强制汇总页封面 manifest: {manifest_path}')
    manifest = _load_json_object(manifest_path, '汇总页封面 manifest')
    prompt_path = Path(__file__).resolve().parent.parent / 'prompts' / 'digest-cover.md'
    prompt_sha = _sha256_file(prompt_path)
    context = _digest_cover_context(papers, date_str, category)
    data_sha = _stable_json_sha256(context)
    cover = manifest.get('cover')
    if (
        manifest.get('version') != 1
        or manifest.get('batchDate') != date_str
        or manifest.get('dataSha256') != data_sha
        or manifest.get('promptSha256') != prompt_sha
        or manifest.get('generationContext') != context
        or not isinstance(cover, dict)
        or cover.get('status') != 'complete'
        or cover.get('dataSha256') != data_sha
        or cover.get('promptSha256') != prompt_sha
        or not re.fullmatch(r'[0-9a-f]{64}', str(cover.get('assetSha256') or ''))
    ):
        raise PublishDataValidationError('汇总页封面未完成或数据/prompt 指纹已失效')
    source = (Path(__file__).resolve().parent.parent / str(cover.get('assetPath') or '')).resolve()
    expected = (
        DIGEST_COVER_ASSET_DIR / date_str / 'visual-summaries'
        / f'00-digest-cover-{date_str}.png'
    ).resolve()
    if source != expected:
        raise PublishDataValidationError('汇总页封面资产路径不受控')
    try:
        raw = source.read_bytes()
    except OSError as exc:
        raise PublishDataValidationError('汇总页封面资产不可读') from exc
    actual_sha = _validate_png_bytes(raw, '汇总页封面')
    if actual_sha != cover['assetSha256']:
        raise PublishDataValidationError('汇总页封面资产 SHA 不匹配')
    public_relative = f'images/digest-covers/{date_str}/cover.png'
    return {
        'kind': 'digest-cover',
        'label': '汇总页封面',
        'assetSha256': actual_sha,
        'dataSha256': data_sha,
        'promptSha256': prompt_sha,
        'generationContext': context,
        'sourcePath': str(source),
        'repoRelativePath': f'static/{public_relative}',
        'url': f'{BASE_PATH.rstrip("/")}/{public_relative}',
    }


def _atomic_write_bytes(path, content, mode=None):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    existing_mode = stat.S_IMODE(target.stat().st_mode) if target.exists() else None
    final_mode = mode if mode is not None else existing_mode
    temp_path = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=f'.{target.name}.', suffix='.tmp', delete=False) as handle:
            temp_path = Path(handle.name)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if final_mode is not None:
            os.chmod(temp_path, final_mode)
        os.replace(temp_path, target)
        temp_path = None
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def stage_visual_summary_assets(assets, staged_posts):
    """Legacy staging helper; production generation always passes an empty asset list."""
    stage_root = Path(staged_posts).parent
    staged = []
    for asset in assets:
        source = Path(asset['sourcePath'])
        raw = source.read_bytes()
        if _validate_png_bytes(raw, asset['repoRelativePath']) != asset['assetSha256']:
            raise PublishDataValidationError(f'视觉摘要资产在 staging 前发生变化: {source}')
        destination = (stage_root / asset['repoRelativePath']).resolve()
        try:
            destination.relative_to(stage_root.resolve())
        except ValueError as exc:
            raise PublishDataValidationError('视觉摘要 staging 路径逃逸') from exc
        _atomic_write_bytes(destination, raw, mode=0o600)
        staged.append(destination)
    return staged


def _manual_reader_editorial_plan(paper):
    """Return the opt-in v2 reader facade without changing canonical analysis."""
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    takeover = manifest.get('manualTakeover') if isinstance(manifest.get('manualTakeover'), dict) else {}
    brief = takeover.get('researchBrief') if isinstance(takeover.get('researchBrief'), dict) else {}
    plan = brief.get('editorialPlan') if isinstance(brief.get('editorialPlan'), dict) else {}
    manual_depth = contracts.get('manualDepth')
    if manual_depth not in {
            MANUAL_DEPTH_CONTRACT_VERSION_V5,
            MANUAL_DEPTH_CONTRACT_VERSION_V6,
    } or plan.get('version') != 2:
        return None
    if manual_depth == MANUAL_DEPTH_CONTRACT_VERSION_V5 \
            and plan.get('readerFormatContract') != TUTORIAL_FORMAT_CONTRACT:
        return None
    if not all(isinstance(plan.get(key), str) and plan[key].strip() for key in ('readerTitle', 'oneSentenceThesis')):
        return None
    return plan


def _manual_v6_reader_payload(paper):
    """Return the strict canonical v6 rendering payload, never a fallback."""
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    contracts = contracts if isinstance(contracts, dict) else {}
    if not isinstance(contracts, dict) \
            or contracts.get('manualDepth') != MANUAL_DEPTH_CONTRACT_VERSION_V6:
        return None
    payload = validate_manual_v6_payload(paper)
    plan = _manual_reader_editorial_plan(paper)
    if plan is None:
        raise PublishDataValidationError(
            f'{paper.get("arxivId") or paper.get("title")} Manual v6 缺少 reader editorialPlan v2'
        )
    return {**payload, 'plan': plan}


def _api_reader_article_image_urls(article):
    """Return HTTPS Markdown image URLs while honoring escaped alt-text chars."""
    return re.findall(
        r'!\[(?:\\.|[^\]\\])*\]\((https://[^\s)]+)\)',
        article,
    )


def _api_reader_display_formula_blocks(article):
    """Count display math in prose, never escaped citations inside image alt text."""
    visible = re.sub(
        r'!\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)',
        '',
        str(article or ''),
    )
    return re.findall(r'\\\[[\s\S]*?\\\]', visible)


def _api_reader_markdown_tables(article):
    """Replay Node's table extractor while preserving the exact hashed bytes."""
    lines = str(article or '').split('\n')
    fence = None
    visible_lines = []
    for line in lines:
        match = re.match(r'^\s*(`{3,}|~{3,})', line)
        if fence is None:
            if match:
                fence = (match.group(1)[0], len(match.group(1)))
                visible_lines.append('')
            else:
                # Publication escapes literal acoustic/biological sequence
                # symbols (for example ``*******___``) so Markdown does not
                # parse them as emphasis.  Reconstruct the canonical source
                # bytes before replaying the signed table hash and cell map.
                visible_lines.append(re.sub(
                    r'(?<=\|)([ \t]*)((?:\\[*_]|[*_])+)([ \t]*)(?=\|)',
                    lambda cell: cell.group(1)
                    + cell.group(2).replace(r'\*', '*').replace(r'\_', '_')
                    + cell.group(3),
                    line,
                ))
            continue
        if match and match.group(1)[0] == fence[0] and len(match.group(1)) >= fence[1]:
            fence = None
        visible_lines.append('')

    def separator(row):
        cells = split_markdown_table_row(row)
        return len(cells) >= 2 and all(
            re.fullmatch(r':?-{3,}:?', re.sub(r'\s+', '', cell))
            for cell in cells
        )

    tables = []
    index = 0
    while index + 1 < len(visible_lines):
        header = split_markdown_table_row(visible_lines[index])
        if len(header) < 2 or not separator(visible_lines[index + 1]):
            index += 1
            continue
        end = index + 2
        rows = []
        while end < len(visible_lines):
            line = visible_lines[end]
            cells = split_markdown_table_row(line)
            if not line.strip():
                break
            if len(cells) < 2 and not re.fullmatch(r'\s*\|.*\|\s*', line):
                break
            rows.append(cells)
            end += 1
        tables.append({
            'header': header,
            'rows': rows,
            'markdown': '\n'.join(visible_lines[index:end]),
        })
        index = max(end, index + 2)
    return tables


def _normalize_api_reader_display_artifacts(value):
    """清理显示文本中重复的置信区间注释，以及连续重复的加粗说明标题。"""
    value = str(value or '')
    value = re.sub(
        r'(\[\s*([+−-]?\d+(?:\.\d+)?)\s*,\s*([+−-]?\d+(?:\.\d+)?)\s*\])'
        r'\[\s*([+−-]?\d+(?:\.\d+)?)\{\}\{,\}\s*([+−-]?\d+(?:\.\d+)?)\{\}\s*\]',
        lambda match: match[1] if (
            match[2].replace('-', '−') == match[4].replace('-', '−')
            and match[3].replace('-', '−') == match[5].replace('-', '−')
        ) else match[0],
        value,
    )
    # 连续重复的加粗说明标题可能使 Hugo 错误解析第二处加粗标记。
    # 这里只合并标题文字和冒号完全相同的重复部分，后面的解释正文保持不变。
    return re.sub(
        r'\*\*([^*\n]+?)([：:])\*\*\s*\*\*\s*\1\2\*\*\s*',
        r'**\1\2** ',
        value,
    )


def _normalize_api_reader_source_cell(value):
    value = unicodedata.normalize('NFKC', str(value or ''))
    value = _normalize_api_reader_display_artifacts(value)
    value = re.sub(r'^−-(\d+(?:\.\d+)?%)$', r'−\1', value)
    value = re.sub(r'^\+\+(\d+(?:\.\d+)?%)$', r'+\1', value)
    value = re.sub(
        r'(?<![\d,])(\d{1,3}(?:,\d{3})+)(\d{1,3}(?:\{,\}\d{3})+)(?![\d,])',
        lambda match: match[1] if match[2].replace('{,}', ',') == match[1]
        else match[0], value,
    )
    value = re.sub(r'<br\s*/?>', ' ', value, flags=re.IGNORECASE)
    # arXiv's LaTeXML text flattening can paste a TeX superscript rendering
    # beside its plain-text counterpart (for example
    # ``lr=2e−4lr=2e^{-4}``) or repeat a signed decimal as ``−22.9-22.9``.
    # The Reader post-processor applies the same narrow display cleanup; keep
    # the publication-side equivalence check in lockstep with that cleanup.
    value = value.replace('\u200b', '')
    scalar = r'[+−-]?\d+(?:\.\d+)?'
    value = re.sub(
        rf'(?<![A-Za-z0-9])({scalar})\s*\[\s*({scalar})\s*,\s*({scalar})\s*\]'
        rf'\s*({scalar})\\;\s*\[\s*({scalar})\s*,\s*({scalar})\s*\]',
        lambda match: (f'{match[1]} [{match[2]}, {match[3]}]')
        if all(match[i].replace('−', '-') == match[i + 3].replace('−', '-')
               for i in (1, 2, 3)) else match[0], value,
    )
    # Exact visible power + identical TeX annotation; preserve the raw DOM
    # cell binding while mirroring Node's unambiguous display cleanup.
    value = re.sub(
        r'(?<![A-Za-z0-9])([1-9]\d*)([−+-])(\d+)\1\^\{([−+-])\3\}(?![A-Za-z0-9])',
        lambda match: ('\\(' + match[1] + '^{' + match[2].replace('−', '-')
                       + match[3] + '}\\)')
        if match[2].replace('−', '-') == match[4].replace('−', '-')
        else match[0], value,
    )
    value = re.sub(r'\blr\s*=\s*2e[−-]4\s*lr\s*=\s*2e\^\{-4\}', 'lr=2e-4', value)
    duplicate_signed = re.compile(r'([+−-])(\d+(?:\.\d+)?)\s*-\s*\2')
    previous = None
    while value != previous:
        previous = value
        value = duplicate_signed.sub(r'\1\2', value)
    value = re.sub(r'[*_`]', '', value).replace('％', '%')
    return re.sub(r'\s+', ' ', value).strip()


def _normalize_api_reader_numeric_token(raw):
    """规范化读者文章和来源引文中的数字，便于比较。

    这里处理千分位、空白、大小写和多余尾零，并对年份及秒数采用与
    Node 端对应的约定。数字输出沿用 Python 现有的浮点格式，
    不保证任意输入都与 JavaScript 得到逐字相同的结果。
    """
    # NFKC 不映射数学减号 U+2212 与全角连字符 U+FF0D，显式归一（与 Node 一致）。
    normalized_text = unicodedata.normalize('NFKC', str(raw or '')).replace('−', '-').replace('－', '-')
    token = normalized_text
    previous = None

    while token != previous:
        previous = token
        token = re.sub(r'(\d),(\d{3})(?!\d)', r'\1\2', token)
    token = re.sub(r'\s+', '', token).lower()
    match = re.match(r'^([-+]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$', token, flags=re.DOTALL)
    if not match:
        return token
    try:
        number = float(match.group(1))
    except ValueError:
        return token
    if not (number == number and abs(number) != float('inf')):
        return token
    suffix = match.group(2) or ''
    if re.fullmatch(r'\d{4}s', normalized_text.strip(), flags=re.IGNORECASE) \
            and re.fullmatch(r'\d{4}', match.group(1)) \
            and 1000 <= int(match.group(1)) <= 2999 and suffix == 's':
        suffix = ''
    if suffix in {'second', 'seconds'}:
        suffix = 's'
    number_text = str(int(number)) if float(number).is_integer() else str(number)
    return f'{number_text}{suffix}'


def _reader_doubled_half_token(surface):
    """双写粘连半部提取，与 Node 端 readerDoubledHalfToken 同一规则。"""
    def pick_half(compact):
        match = re.fullmatch(r'([0-9.]+)\1', compact)
        if not match:
            return None
        half = match.group(1)
        if len(half.replace('.', '')) < 2:
            return None
        if re.fullmatch(r'[0-9]+', compact) \
                and 1000 <= int(compact) <= 2999:
            return None
        return half

    compact = re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(surface or '')))
    direct = pick_half(compact)
    if direct:
        return direct
    suffix_match = re.search(r'[%a-zA-Z]+$', compact)
    if suffix_match:
        half = pick_half(compact[:suffix_match.start()])
        if half:
            return f'{half} {suffix_match.group(0)}'
    return None


def _api_reader_numeric_tokens(value):
    # Require a thousands-grouped branch to consume the complete post-comma
    # digit run. Otherwise ``10^-4,2000`` is truncated to the fabricated token
    # ``-4,200`` / ``-4200`` instead of replaying ``-4`` and ``2000``.
    grouped_integer = r'(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)'
    pattern = re.compile(
        # Consume an exact repeated decimal as one surface before half-token
        # replay; otherwise 3.093.09 is incorrectly split into 3.093 and 09.
        rf'(?<![A-Za-z0-9])(?:(\d+\.\d+)\1(?!\d|\.\d)|[-+−－]?(?:{grouped_integer}(?:\.\d+)?|\.\d+))'
        r'(?:\s*%|\s*(?:seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp)(?![A-Za-z0-9_]))?',
        flags=re.IGNORECASE,
    )
    # Match Node's narrow LaTeXML named-color replay without changing quotes,
    # numeric signs, units, or the ordinary identifier boundary.
    original_surface = str(value or '')

    def mask_color(match):
        # A sign outside the command must not become a detached positive value
        # (or expose a decimal tail). Leave this ambiguous form unindexed.
        if re.search(r'[-+－−]\s*$', original_surface[:match.start()]):
            return ' ' * len(match.group(0))
        return ' ' * len(match.group(1)) + match.group(2)

    numeric_surface = re.sub(
        r'(\\textcolor(?:black|blue|brown|cyan|darkgray|gray|green|lightgray|lime|magenta|olive|orange|pink|purple|red|teal|violet|white|yellow))([-+－−]?[0-9０-９][0-9.０-９．]*)',
        mask_color, original_surface,
    )
    tokens = []
    for match in pattern.finditer(unicodedata.normalize('NFKC', numeric_surface)):
        normalized_numeric_token = _normalize_api_reader_numeric_token(match.group(0))
        tokens.append(normalized_numeric_token)
        # 与 Node 端 readerNumericTokens 同一条双写粘连规则（4096+4096、
        # 8.218.21、40964096s 同时索引半部；短半部不拆，避免误读 2020/1212）。
        half = _reader_doubled_half_token(match.group(0))
        if half:
            half_token = _normalize_api_reader_numeric_token(half)
            if half_token != normalized_numeric_token:
                tokens.append(half_token)

    # LaTeXML can concatenate a visible thousands-grouped integer with its
    # identical annotation (``500,000500,000``). The normal grouped-number
    # branch must keep its strict trailing boundary for ``10^-4,2000``; add
    # only the exact repeated grouped surface as an auditable half-value alias.
    duplicated_grouped_integer = re.compile(
        r'(?<![A-Za-z0-9])'
        r'([+\-−－]?[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+)\1'
        r'(?![A-Za-z0-9０-９,，])'
    )
    for match in duplicated_grouped_integer.finditer(original_surface):
        tokens.append(_normalize_api_reader_numeric_token(match.group(1)))

    # Match Node's exact LaTeXML statistic alias. The HTML text extractor may
    # flatten one displayed thousands-grouped value and its TeX annotation as
    # `4,852\mu=4{,}852 ms`. Only identical numeric spellings across that exact
    # bridge inherit the trailing unit; a different value, sign, precision,
    # bridge, or unit produces no alias. This operates solely inside the
    # already SHA-bound sourceQuote bytes, never via a fuzzy full-text search.
    tex_statistic = re.compile(
        r'(?<![A-Za-z0-9])'
        r'([+\-−－]?(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)(?:[.．][0-9０-９]+)?)'
        r'\\mu\s*=\s*'
        r'([+\-−－]?[0-9０-９{}.,，．]+)\s*'
        r'(seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp|[%％])'
        r'(?![A-Za-z0-9_])',
        flags=re.IGNORECASE,
    )

    def exact_number(raw):
        surface = unicodedata.normalize('NFKC', str(raw or '')) \
            .replace('−', '-').replace('－', '-')
        if not re.fullmatch(
                r'[+\-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?', surface):
            return None
        return surface

    # Keep parity with Node's exact LaTeXML duplicate-run alias. Visible math
    # and its TeX annotation can be flattened as ``−20-20 dB``. Accept only a
    # bounded run with exactly one split whose normalized signed numbers are
    # byte-equivalent; unequal values and unsigned adjacent integers remain
    # unsupported.
    duplicate_run = re.compile(
        r'(?<![A-Za-z0-9])'
        r'([+\-−－]?[0-9０-９.,，．]+(?:[+\-−－][0-9０-９.,，．]+)?)\s*'
        r'(seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp|[%％])'
        r'(?![A-Za-z0-9_])',
        flags=re.IGNORECASE,
    )
    for match in duplicate_run.finditer(original_surface):
        run = match.group(1)
        if not re.search(r'[.．+\-−－]', run):
            continue
        splits = []
        for index in range(1, len(run)):
            left = exact_number(run[:index])
            right = exact_number(run[index:])
            if left and right and left == right:
                splits.append((run[:index], run[index:]))
        if len(splits) == 1:
            tokens.append(_normalize_api_reader_numeric_token(
                f'{splits[0][0]} {match.group(2)}'
            ))

    for match in tex_statistic.finditer(original_surface):
        left = exact_number(match.group(1))
        right = exact_number(match.group(2).replace('{', '').replace('}', ''))
        if not left or left != right:
            continue
        alias = _normalize_api_reader_numeric_token(
            f'{match.group(1)} {match.group(3)}'
        )
        tokens.append(alias)
    # Mirror Node's exact visible-measurement + TeX annotation alias.
    # Both numbers and decoded units must agree inside the SHA-bound quote.
    number_surface = r'[+\-−－]?(?:[0-9０-９]{1,3}(?:[,，][0-9０-９]{3})+|[0-9０-９]+)(?:[.．][0-9０-９]+)?'
    tex_measurement = re.compile(
        rf'(?<![A-Za-z0-9])({number_surface})\s*'
        rf'(seconds?|dB|ms|s|Hz|kHz|MHz|GB|M|B|k|pp)({number_surface})'
        r'(?:\s|\\text\{\\[,;!]\}|\\[,;!])*'
        r'((?:\\(?:mathrm|textrm|text)\{[A-Za-z]+\}){1,8})'
        r'(?![A-Za-z0-9_]|\\(?:mathrm|textrm|text)\{[A-Za-z])',
        flags=re.IGNORECASE,
    )
    for match in tex_measurement.finditer(original_surface):
        left = exact_number(match.group(1))
        right = exact_number(match.group(3))
        tex_unit = ''.join(re.findall(
            r'\\(?:mathrm|textrm|text)\{([A-Za-z]+)\}', match.group(4)))
        if left and left == right and tex_unit.lower() == match.group(2).lower():
            tokens.append(_normalize_api_reader_numeric_token(
                f'{match.group(1)} {match.group(2)}'))
    return tokens


def _validate_api_reader_source_bindings(paper, article=None):
    """按 v4 来源记录核对读者文章中的表格和公式，并返回核验结果。"""
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    contracts = contracts if isinstance(contracts, dict) else {}
    stage = (manifest.get('stages') or {}).get('apiReaderArticle') \
        if isinstance(manifest, dict) else None
    stage = stage if isinstance(stage, dict) else {}
    source = manifest.get('sourceAcquisition') if isinstance(manifest, dict) else None
    plan = paper.get('apiReaderPlan') if isinstance(paper, dict) else None
    article = paper.get('apiReaderArticle') if article is None and isinstance(paper, dict) else article
    if isinstance(article, str) and '原文中没有可逐字绑定的数值证据' in article:
        raise PublishDataValidationError(
            '读者文章中仍有内部绑定失败占位说明，请修复正文后重新生成页面。'
        )
    if not isinstance(plan, dict) or not isinstance(stage, dict) \
            or not isinstance(source, dict) or not isinstance(article, str):
        raise PublishDataValidationError('读者文章的编辑计划、阶段记录、来源记录或正文缺失，或格式无效。')
    if re.search(r'\[\[FORMULA_\d+\]\]', article):
        raise PublishDataValidationError('读者文章中仍有未对应原文公式的占位符。')
    if contracts.get('apiReaderSourceBindings') != LLM_API_READER_SOURCE_BINDING_CONTRACT \
            or plan.get('sourceBindingsContract') != LLM_API_READER_SOURCE_BINDING_CONTRACT \
            or stage.get('sourceBindingsContractVersion') != LLM_API_READER_SOURCE_BINDING_CONTRACT:
        raise PublishDataValidationError('读者文章的表格与公式来源记录未采用 v4 规则。')

    table_bindings = plan.get('tableBindings')
    formula_bindings = plan.get('formulaBindings')
    if not isinstance(table_bindings, list) or not isinstance(formula_bindings, list):
        raise PublishDataValidationError('读者文章的表格或公式来源记录必须是列表。')
    bindings_sha = _stable_json_sha256({
        'tableBindings': table_bindings,
        'formulaBindings': formula_bindings,
    })
    source_sha = source.get('sourceSha256')
    structured_sha = source.get('structuredArtifactsSha256')
    if plan.get('sourceBindingsSha256') != bindings_sha \
            or stage.get('sourceBindingsSha256') != bindings_sha:
        raise PublishDataValidationError('读者文章的表格或公式来源记录 SHA 与编辑计划或阶段记录不一致。')
    if not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or '')) \
            or paper.get('sourceSha256') != source_sha \
            or stage.get('sourceBindingsSourceTextSha256') != source_sha:
        raise PublishDataValidationError('Reader 所用论文全文的 SHA 缺失、格式无效，或与论文记录、当前阶段的来源记录不一致。')
    if not re.fullmatch(r'[0-9a-f]{64}', str(structured_sha or '')) \
            or stage.get('structuredArtifactsSha256') != structured_sha:
        raise PublishDataValidationError('论文结构化证据的 SHA 缺失、格式无效，或与读者文章阶段记录不一致。')
    if stage.get('tableBindingCount') != len(table_bindings) \
            or stage.get('formulaBindingCount') != len(formula_bindings):
        raise PublishDataValidationError('读者文章的表格或公式来源记录条数与阶段记录不一致。')

    rendered_tables = _api_reader_markdown_tables(article)
    saved_reader_article = paper.get('apiReaderArticle')
    saved_reader_tables = _api_reader_markdown_tables(saved_reader_article) \
        if isinstance(saved_reader_article, str) else rendered_tables
    if len(rendered_tables) != len(table_bindings):
        raise PublishDataValidationError('Reader 正文中的表格数与 plan.tableBindings 条目数不一致。')
    for index, (binding, rendered) in enumerate(zip(table_bindings, rendered_tables), 1):
        required = {
            'tableIndex', 'sourceType', 'sourceTableOrdinal',
            'renderedTableSha256', 'cellBindings', 'sourceQuotes',
        }
        if not isinstance(binding, dict) or set(binding) not in (required, required | {'sourceTableDomSha256'}):
            raise PublishDataValidationError(f'表格来源记录 tableBindings[{index - 1}] 格式无效、缺少必要字段，或含有不允许的字段。')
        saved_rendered_table = saved_reader_tables[index - 1] \
            if index <= len(saved_reader_tables) else None
        if binding.get('tableIndex') != index or saved_rendered_table is None \
                or binding.get('renderedTableSha256') != _javascript_string_sha256(
                    saved_rendered_table['markdown']
                ):
            raise PublishDataValidationError(f'第 {index} 个表格的序号、保存正文中的表格或渲染 SHA 与来源记录不一致。')
        rendered_rows = [rendered['header'], *rendered['rows']]
        if binding.get('sourceType') == 'artifact_table':
            if set(binding) != required | {'sourceTableDomSha256'} \
                    or not isinstance(binding.get('sourceTableOrdinal'), int) \
                    or isinstance(binding.get('sourceTableOrdinal'), bool) \
                    or binding['sourceTableOrdinal'] < 1 \
                    or not re.fullmatch(r'[0-9a-f]{64}', str(binding.get('sourceTableDomSha256') or '')) \
                    or binding.get('sourceQuotes') != [] \
                    or not isinstance(binding.get('cellBindings'), list):
                raise PublishDataValidationError(f'第 {index} 个表格的原表来源记录缺失或不符合要求。')
            expected_cells = sum(len(row) for row in rendered_rows)
            if len(binding['cellBindings']) != expected_cells:
                raise PublishDataValidationError(f'第 {index} 个表格的单元格来源记录条数与显示的单元格数不一致。')
            seen = set()
            for cell_index, cell in enumerate(binding['cellBindings']):
                cell_keys = {
                    'renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn',
                    'renderedText', 'sourceText', 'sourceDomSha256',
                }
                if not isinstance(cell, dict) or set(cell) != cell_keys:
                    raise PublishDataValidationError(
                        f'第 {index} 个表格的单元格记录 cellBindings[{cell_index}] 格式无效、缺少必要字段，或含有不允许的字段。'
                    )
                coordinates = [cell.get(key) for key in (
                    'renderedRow', 'renderedColumn', 'sourceRow', 'sourceColumn',
                )]
                if any(not isinstance(value, int) or isinstance(value, bool) or value < 0
                       for value in coordinates):
                    raise PublishDataValidationError(f'第 {index} 个表格的单元格坐标必须是非负整数。')
                rendered_row, rendered_column = coordinates[:2]
                key = (rendered_row, rendered_column)
                if key in seen or rendered_row >= len(rendered_rows) \
                        or rendered_column >= len(rendered_rows[rendered_row]):
                    raise PublishDataValidationError(f'第 {index} 个表格的单元格来源记录重复，或显示坐标超出表格范围。')
                actual_text = rendered_rows[rendered_row][rendered_column]
                if _normalize_api_reader_source_cell(cell.get('renderedText')) \
                        != _normalize_api_reader_source_cell(actual_text) \
                        or _normalize_api_reader_source_cell(actual_text) \
                        != _normalize_api_reader_source_cell(cell.get('sourceText')) \
                        or not re.fullmatch(r'[0-9a-f]{64}', str(cell.get('sourceDomSha256') or '')):
                    raise PublishDataValidationError(f'第 {index} 个表格的单元格文本与显示内容或来源文本不一致，或来源 DOM 的 SHA 无效。')
                seen.add(key)
            if len(seen) != expected_cells:
                raise PublishDataValidationError(f'第 {index} 个表格仍有单元格缺少来源记录。')
        elif binding.get('sourceType') == 'source_quotes':
            if set(binding) != required or binding.get('sourceTableOrdinal') is not None \
                    or binding.get('cellBindings') != [] \
                    or not isinstance(binding.get('sourceQuotes'), list) \
                    or not binding['sourceQuotes']:
                raise PublishDataValidationError(f'第 {index} 个表格的逐字引文来源记录缺失或不符合要求。')
            quote_corpus = []
            for quote_index, quote_binding in enumerate(binding['sourceQuotes']):
                if not isinstance(quote_binding, dict) \
                        or set(quote_binding) != {'quote', 'sourceQuoteSha256'} \
                        or not isinstance(quote_binding.get('quote'), str) \
                        or not 12 <= len(quote_binding['quote']) <= 4000 \
                        or quote_binding.get('sourceQuoteSha256') \
                        != _javascript_string_sha256(quote_binding['quote']):
                    raise PublishDataValidationError(
                        f'第 {index} 个表格的引文记录 sourceQuotes[{quote_index}] 字段、长度或 SHA 不符合要求。'
                    )
                quote_corpus.append(quote_binding['quote'])
            quote_tokens = set(_api_reader_numeric_tokens('\n'.join(quote_corpus)))
            missing = set(_api_reader_numeric_tokens(rendered['markdown'])) - quote_tokens
            if missing:
                raise PublishDataValidationError(
                    f'第 {index} 个表格中的数字或单位未被来源引文完整覆盖：{sorted(missing)}'
                )
        else:
            raise PublishDataValidationError(f'第 {index} 个表格的来源类型不符合要求。')

    display_blocks = _api_reader_display_formula_blocks(article)
    if len(display_blocks) != len(formula_bindings):
        raise PublishDataValidationError('读者文章中的展示公式数量与公式来源记录条数不一致。')
    seen_ordinals = set()
    for index, binding in enumerate(formula_bindings):
        expected_keys = {
            'formulaOrdinal', 'targetKind', 'marker', 'latex',
            'sourceDomSha256', 'renderedBlockSha256',
        }
        if not isinstance(binding, dict) or set(binding) != expected_keys:
            raise PublishDataValidationError(f'公式来源记录 formulaBindings[{index}] 格式无效、缺少必要字段，或含有不允许的字段。')
        ordinal = binding.get('formulaOrdinal')
        latex = binding.get('latex')
        rendered_block = f'\\[{str(latex or "").strip()}\\]'
        # 发布清理会将 _{<k} 改为 _{\lt k}，并处理 \texttt{<answer>} 等标记，
        # 避免 Hugo 将其当作 HTML。保存正文中是原始公式块，最终页面可能是清理后的块。
        # 两种形式合计必须恰好出现一次；缺失、重复或清理后发生碰撞时均拒绝。
        # renderedBlockSha256 仍核对原始公式块，不能用清理后的字节重新签署来源记录。
        published_block = sanitize_markdown_for_publish(rendered_block)
        if published_block == rendered_block:
            formula_occurrences = display_blocks.count(rendered_block)
        else:
            formula_occurrences = display_blocks.count(rendered_block) \
                + display_blocks.count(published_block)
        if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal < 1 \
                or ordinal in seen_ordinals \
                or binding.get('marker') != f'[[FORMULA_{ordinal}]]' \
                or binding.get('targetKind') not in (
                    'background', 'related_work', 'problem', 'method_overview',
                    'component', 'training', 'experiment_setup', 'result',
                    'ablation', 'limitation', 'reproduction', 'synthesis',
                ) \
                or not isinstance(latex, str) or not latex.strip() \
                or not re.fullmatch(r'[0-9a-f]{64}', str(binding.get('sourceDomSha256') or '')) \
                or binding.get('renderedBlockSha256') \
                != _javascript_string_sha256(rendered_block) \
                or formula_occurrences != 1 \
                or binding['marker'] in article:
            raise PublishDataValidationError(f'第 {index + 1} 个公式的来源记录或正文显示内容不符合要求。')
        seen_ordinals.add(ordinal)
    return {
        'contract': LLM_API_READER_SOURCE_BINDING_CONTRACT,
        'sha256': bindings_sha,
        'tableCount': len(table_bindings),
        'formulaCount': len(formula_bindings),
        'structuredArtifactsSha256': structured_sha,
    }


def _validate_api_reader_author_identity(paper):
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    contracts = contracts if isinstance(contracts, dict) else {}
    stage = (manifest.get('stages') or {}).get('apiReaderArticle') \
        if isinstance(manifest, dict) else None
    payload = paper.get('apiReaderAuthors') if isinstance(paper, dict) else None
    if not isinstance(payload, dict) or set(payload) != {
            'authors', 'sourceDomSha256', 'identity', 'identitySha256'}:
        raise PublishDataValidationError('读者文章的作者记录格式无效、缺少必要字段，或含有不允许的字段。')
    identity = payload.get('identity')
    if not isinstance(identity, dict) or set(identity) != {
            'contract', 'sourceDomSha256', 'sourceTextSha256',
            'metadataSha256', 'authors'}:
        raise PublishDataValidationError('读者文章的作者来源记录格式无效、缺少必要字段，或含有不允许的字段。')
    identity_sha = _stable_json_sha256(identity)
    source_sha = paper.get('sourceSha256')
    metadata_sha = _stable_json_sha256(
        paper.get('authors') if isinstance(paper.get('authors'), list) else []
    )
    if identity.get('contract') != LLM_API_READER_AUTHOR_IDENTITY_CONTRACT \
            or contracts.get('apiReaderAuthorIdentity') \
            != LLM_API_READER_AUTHOR_IDENTITY_CONTRACT \
            or stage.get('readerAuthorIdentityContractVersion') \
            != LLM_API_READER_AUTHOR_IDENTITY_CONTRACT \
            or payload.get('identitySha256') != identity_sha \
            or stage.get('readerAuthorIdentitySha256') != identity_sha \
            or identity.get('sourceTextSha256') != source_sha \
            or identity.get('metadataSha256') != metadata_sha:
        raise PublishDataValidationError('读者文章的作者来源规则不匹配，或作者记录、论文全文及论文元数据的 SHA 与对应记录不一致。')
    source_dom_sha = identity.get('sourceDomSha256')
    if source_dom_sha != '' and not re.fullmatch(r'[0-9a-f]{64}', str(source_dom_sha or '')):
        raise PublishDataValidationError('作者来源记录中的 DOM SHA 必须为空字符串或有效的 SHA-256。')
    if not re.fullmatch(r'[0-9a-f]{64}', str(payload.get('sourceDomSha256') or '')):
        raise PublishDataValidationError('读者文章作者记录中的来源 DOM SHA 缺失或格式无效。')
    public_authors = payload.get('authors')
    bound_authors = identity.get('authors')
    if not isinstance(public_authors, list) or not isinstance(bound_authors, list) \
            or not public_authors or len(public_authors) != len(bound_authors):
        raise PublishDataValidationError('展示作者列表或来源作者列表无效、为空，或两者数量不一致。')
    for index, (author, bound) in enumerate(zip(public_authors, bound_authors)):
        if not isinstance(author, dict) or set(author) != {'name', 'affiliations'} \
                or not isinstance(bound, dict) or set(bound) != {
                    'name', 'affiliations', 'nameBinding', 'affiliationBindings'} \
                or bound.get('name') != author.get('name') \
                or bound.get('affiliations') != author.get('affiliations') \
                or not isinstance(author.get('name'), str) or not author['name'].strip() \
                or not isinstance(author.get('affiliations'), list) \
                or not author['affiliations']:
            raise PublishDataValidationError(f'第 {index + 1} 位作者的字段、姓名或机构列表无效，或与来源记录不一致。')
        if not all(isinstance(value, str) and value.strip()
                   for value in author['affiliations']):
            raise PublishDataValidationError(f'第 {index + 1} 位作者的每个机构名称都必须是非空字符串。')
        name_binding = bound.get('nameBinding')
        if not isinstance(name_binding, dict) \
                or name_binding.get('sourceValue') != author['name']:
            raise PublishDataValidationError(f'第 {index + 1} 位作者缺少姓名来源记录，或记录中的姓名不一致。')
        if name_binding.get('sourceKind') == 'html_dom':
            if set(name_binding) != {'sourceKind', 'sourceValue', 'sourceDomSha256'} \
                    or not source_dom_sha \
                    or name_binding.get('sourceDomSha256') != source_dom_sha:
                raise PublishDataValidationError(f'第 {index + 1} 位作者的 HTML 姓名来源字段或 DOM SHA 不符合要求。')
        elif name_binding.get('sourceKind') == 'paper_metadata':
            if set(name_binding) != {'sourceKind', 'sourceValue', 'metadataSha256'} \
                    or name_binding.get('metadataSha256') != metadata_sha:
                raise PublishDataValidationError(f'第 {index + 1} 位作者的论文元数据姓名来源字段或 SHA 不符合要求。')
        else:
            raise PublishDataValidationError(f'第 {index + 1} 位作者的姓名来源类型不符合要求。')
        affiliation_bindings = bound.get('affiliationBindings')
        if not isinstance(affiliation_bindings, list) \
                or len(affiliation_bindings) != len(author['affiliations']):
            raise PublishDataValidationError(f'第 {index + 1} 位作者的机构来源记录必须是列表，且条数须与机构列表一致。')
        for affiliation_index, (affiliation, binding) in enumerate(zip(
                author['affiliations'], affiliation_bindings)):
            if not isinstance(binding, dict) or binding.get('sourceValue') != affiliation:
                raise PublishDataValidationError(
                    f'第 {index + 1} 位作者的第 {affiliation_index + 1} 个机构缺少来源记录，或机构名称不一致。'
                )
            if binding.get('sourceKind') == 'html_dom':
                if set(binding) != {
                        'sourceKind', 'association', 'sourceValue', 'sourceDomSha256'} \
                        or binding.get('association') not in {
                            'direct_author', 'single_global_affiliation'} \
                        or not source_dom_sha \
                        or binding.get('sourceDomSha256') != source_dom_sha:
                    raise PublishDataValidationError('作者机构的 HTML 来源字段、对应关系或 DOM SHA 不符合要求。')
            elif binding.get('sourceKind') == 'explicit_unavailable':
                if set(binding) != {
                        'sourceKind', 'sourceValue', 'sourceTextSha256'} \
                        or not affiliation.startswith('机构信息未') \
                        or binding.get('sourceTextSha256') != source_sha:
                    raise PublishDataValidationError('API reader 作者机构 unavailable binding 非法')
            else:
                raise PublishDataValidationError('作者机构的来源类型不符合要求。')
    if stage.get('readerAuthorsSha256') != _stable_json_sha256(payload):
        raise PublishDataValidationError('读者文章作者记录的 SHA 与阶段记录不一致。')
    return {
        'contract': LLM_API_READER_AUTHOR_IDENTITY_CONTRACT,
        'sha256': identity_sha,
        'payloadSha256': _stable_json_sha256(payload),
        'count': len(public_authors),
        'authors': public_authors,
    }


def _validated_https_identity_url(value, label):
    try:
        parsed = urlparse(value)
    except (TypeError, ValueError) as exc:
        raise PublishDataValidationError(f'{label} 的 URL 无法解析。') from exc
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise PublishDataValidationError(f'{label} 必须是包含主机名且不带用户名或密码的 HTTPS URL。')
    return value


def _validate_api_reader_resource_identity(paper):
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    contracts = contracts if isinstance(contracts, dict) else {}
    stages = manifest.get('stages') if isinstance(manifest, dict) else None
    reader_stage = stages.get('apiReaderArticle') if isinstance(stages, dict) else None
    reader_stage = reader_stage if isinstance(reader_stage, dict) else {}
    open_stage = stages.get('openSourceScan') if isinstance(stages, dict) else None
    open_stage = open_stage if isinstance(open_stage, dict) else {}
    demo_stage = stages.get('demoLinkScan') if isinstance(stages, dict) else None
    payload = paper.get('apiReaderResources') if isinstance(paper, dict) else None
    if not isinstance(payload, dict) or set(payload) != {
            'contract', 'sourceTextSha256', 'resources', 'identitySha256'}:
        raise PublishDataValidationError('读者文章的资源记录格式无效、缺少必要字段，或含有不允许的字段。')
    identity = {key: value for key, value in payload.items() if key != 'identitySha256'}
    identity_sha = _stable_json_sha256(identity)
    if payload.get('contract') != LLM_API_READER_RESOURCE_IDENTITY_CONTRACT \
            or contracts.get('apiReaderResourceIdentity') \
            != LLM_API_READER_RESOURCE_IDENTITY_CONTRACT \
            or reader_stage.get('resourceIdentityContractVersion') \
            != LLM_API_READER_RESOURCE_IDENTITY_CONTRACT \
            or open_stage.get('resourceEvidenceContract') \
            != LLM_API_READER_RESOURCE_IDENTITY_CONTRACT \
            or payload.get('identitySha256') != identity_sha \
            or reader_stage.get('resourceIdentitySha256') != identity_sha \
            or open_stage.get('resourceEvidenceSha256') != identity_sha \
            or payload.get('sourceTextSha256') != paper.get('sourceSha256'):
        raise PublishDataValidationError('读者文章的资源来源规则不匹配，或资源记录、论文全文及分析阶段保存的 SHA 不一致。')
    resources = payload.get('resources')
    if not isinstance(resources, list) or len(resources) > 12 \
            or reader_stage.get('resourceCount') != len(resources):
        raise PublishDataValidationError('读者文章的资源记录必须是最多 12 条的列表，且条数须与阶段记录一致。')
    discovered_links = demo_stage.get('discoveredLinks') if isinstance(demo_stage, dict) else []
    allowed_types = {'code', 'model', 'dataset', 'demo', 'reproduction', 'third_party'}
    available_types = set()
    for index, resource in enumerate(resources):
        required = {
            'type', 'origin', 'sourceQuote', 'sourceQuoteSha256',
            'originalUrl', 'finalUrl', 'redirects', 'status', 'availability',
        }
        allowed = required | {'retryable', 'failureCode', 'documentationEvidence'}
        if not isinstance(resource, dict) or not required.issubset(resource) \
                or not set(resource).issubset(allowed):
            raise PublishDataValidationError(f'资源记录 resources[{index}] 格式无效、缺少必要字段，或含有不允许的字段。')
        if resource.get('type') not in allowed_types \
                or resource.get('origin') not in {'paper_source', 'validated_demo'}:
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的类型或来源不符合要求。')
        original_url = _validated_https_identity_url(
            resource.get('originalUrl'), f'资源记录 resources[{index}] 的原始地址 originalUrl',
        )
        final_url = _validated_https_identity_url(
            resource.get('finalUrl'), f'资源记录 resources[{index}] 的最终地址 finalUrl',
        )
        source_quote = resource.get('sourceQuote')
        if not isinstance(source_quote, str) or not source_quote.strip() \
                or original_url not in source_quote \
                or resource.get('sourceQuoteSha256') \
                != _javascript_string_sha256(source_quote):
            raise PublishDataValidationError(f'资源记录 resources[{index}] 缺少有效的来源引文、引文未包含原始地址，或引文 SHA 不一致。')
        if resource['origin'] == 'validated_demo' \
                and original_url not in (discovered_links or []):
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的演示页原始地址未包含在已发现链接的记录中。')
        redirects = resource.get('redirects')
        if not isinstance(redirects, list) or len(redirects) > 3:
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的重定向记录必须是最多 3 条的列表。')
        expected_from = original_url
        for redirect_index, redirect in enumerate(redirects):
            if not isinstance(redirect, dict) or set(redirect) != {'from', 'to', 'status'} \
                    or redirect.get('from') != expected_from \
                    or redirect.get('status') not in {301, 302, 303, 307, 308}:
                raise PublishDataValidationError(
                    f'资源记录 resources[{index}] 的重定向条目 redirects[{redirect_index}] 字段、起点或 HTTP 状态码不符合要求。'
                )
            _validated_https_identity_url(redirect.get('from'), '资源重定向的起始地址')
            expected_from = _validated_https_identity_url(
                redirect.get('to'), '资源重定向的目标地址',
            )
        if expected_from != final_url:
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的重定向终点与最终地址不一致。')
        availability = resource.get('availability')
        status = resource.get('status')
        if isinstance(status, bool) or (status is not None and not isinstance(status, int)):
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的 HTTP 状态码必须是整数或空值。')
        retryable = resource.get('retryable')
        if retryable is not None and not isinstance(retryable, bool):
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的重试标记必须是布尔值或空值。')
        if availability == 'available':
            valid_terminal = status is not None and 200 <= status < 400 and retryable in {None, False}
            available_types.add(resource['type'])
        elif availability == 'unavailable':
            valid_terminal = status is not None and 400 <= status < 500 \
                and status not in {408, 425, 429} and retryable in {None, False}
        elif availability == 'temporarily_unreachable':
            valid_terminal = retryable is True and (
                status is None or status in {408, 425, 429} or status >= 500
            )
        else:
            valid_terminal = False
        if not valid_terminal:
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的可达状态与 HTTP 状态码或重试标记不一致。')
        failure_code = resource.get('failureCode')
        if failure_code is not None and (
                availability != 'temporarily_unreachable' or status is not None
                or not isinstance(failure_code, str) or not failure_code.strip()
                or len(failure_code) > 100):
            raise PublishDataValidationError(f'资源记录 resources[{index}] 的失败原因代码格式无效，或不适用于当前可达状态和 HTTP 状态码。')
        documentation = resource.get('documentationEvidence')
        if documentation is not None:
            # README 证据来自独立的 raw.githubusercontent.com 地址。
            # 仓库页面暂时不可达时，仍可能已取得有效的 README 响应。
            documentation_keys = {
                'contract', 'repositoryUrl', 'sourceUrl', 'status',
                'sourceSha256', 'capabilities', 'completeness',
            }
            capabilities = documentation.get('capabilities') \
                if isinstance(documentation, dict) else None
            capability_keys = {'installation', 'inference', 'fineTuning'}
            complete_documentation = isinstance(capabilities, dict) \
                and set(capabilities) == capability_keys \
                and all(value is True for value in capabilities.values())
            partial_documentation = isinstance(capabilities, dict) \
                and set(capabilities) == capability_keys \
                and all(isinstance(value, bool) for value in capabilities.values()) \
                and not complete_documentation
            if not isinstance(documentation, dict) \
                    or set(documentation) != documentation_keys \
                    or resource.get('type') != 'code' \
                    or documentation.get('contract') \
                    != 'repository-documentation-evidence-v1' \
                    or documentation.get('repositoryUrl') != original_url \
                    or documentation.get('status') != 200 \
                    or not re.fullmatch(r'[0-9a-f]{64}', str(
                        documentation.get('sourceSha256') or '',
                    )) \
                    or not (complete_documentation or partial_documentation) \
                    or documentation.get('completeness') != (
                        'complete' if complete_documentation else 'partial'
                    ):
                raise PublishDataValidationError(
                    f'资源记录 resources[{index}] 的 README 文档证据不符合要求。请核对记录格式、代码仓库地址、访问结果和文档完整性。'
                )
            source_url = _validated_https_identity_url(
                documentation.get('sourceUrl'),
                f'资源记录 resources[{index}] 的 README 文档证据来源地址',
            )
            parsed_repository = urlparse(original_url)
            repository_parts = [part for part in parsed_repository.path.split('/') if part]
            expected_source = (
                f'https://raw.githubusercontent.com/{repository_parts[0]}/'
                f'{repository_parts[1]}/main/README.md'
                if parsed_repository.hostname == 'github.com'
                and len(repository_parts) == 2 else None
            )
            if source_url != expected_source:
                raise PublishDataValidationError(
                    f'资源记录 resources[{index}] 的 README 文档证据地址不是该仓库 main 分支的指定地址。'
                )

    parsed_analysis = parse_analysis(paper.get('analysis', '')) or {}
    for field, resource_type in (
            ('hasCode', 'code'), ('hasModel', 'model'), ('hasDataset', 'dataset')):
        expected_yes = resource_type in available_types
        actual_yes = str(parsed_analysis.get(field) or '').strip().lower() in {'是', 'yes'}
        if actual_yes != expected_yes:
            raise PublishDataValidationError(
                f'读者文章资源记录的可达状态与机器摘要中的 {field} 标记不一致。'
            )
    availability_summary = (
        '未发现可验证的官方 HTTPS 资源 URL。' if not resources else
        '；'.join(
            f'{resource["type"]}={resource["availability"]}'
            + ('' if resource['status'] is None else f'(HTTP {resource["status"]})')
            for resource in resources
        )
    )
    if availability_summary not in str(parsed_analysis.get('opensource') or ''):
        raise PublishDataValidationError('开源说明中缺少与资源记录一致的可达性摘要。')
    return {
        'contract': LLM_API_READER_RESOURCE_IDENTITY_CONTRACT,
        'sha256': identity_sha,
        'count': len(resources),
        'availableTypes': sorted(available_types),
        'resources': resources,
    }


def _add_reader_term_heading_spaces(article, plan):
    """按编辑计划为术语说明段的加粗标题后补空格，避免 CommonMark 误解析相邻文字。

    处理只作用于发布视图，不改写论文记录中的正文或编辑计划，表格与公式字节也保留。
    """
    fences = []
    opened = None
    offset = 0
    for line in article.splitlines(keepends=True):
        token = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if token:
            mark = token.group(1)
            if opened is None:
                opened = (mark[0], len(mark), offset)
            elif mark[0] == opened[0] and len(mark) >= opened[1]:
                fences.append((opened[2], offset + len(line)))
                opened = None
        offset += len(line)
    if opened:
        fences.append((opened[2], len(article)))
    insertions = []
    for bridge in plan.get('conceptBridges', []):
        explanation = bridge['explanation']
        prefix = re.match(r'^\*\*[^*\n]+\*\*', explanation)
        if not prefix or not explanation[prefix.end():prefix.end() + 1].isalnum():
            continue
        matches = list(re.finditer(
            r'(?:\A|(?<=\n\n))' + re.escape(explanation) + r'(?=\n\n|\Z)', article,
        ))
        if len(matches) != 1:
            raise PublishDataValidationError('编辑计划中的术语说明没有在正文中恰好对应一个完整段落。')
        start = matches[0].start()
        if not any(begin <= start < end for begin, end in fences):
            insertions.append(start + prefix.end())
    for position in sorted(set(insertions), reverse=True):
        article = article[:position] + ' ' + article[position:]
    return article


def _apply_reader_display_fixes(article):
    """对显示文本应用指定的错字和集合符号修正，返回处理后的文本，不改写保存的读者正文。"""
    replacements = {
        '指标抽取代吗': '指标抽取代码',
        # Goldmark 可能把裸下划线解析为强调标记。显示时将这组集合名称改为行内代码，
        # 保留符号的可见写法；保存的正文不改写。
        'S_yes/S_no': '`S_yes`/`S_no`',
    }
    for old, new in replacements.items():
        article = article.replace(old, new)
    article = re.sub(r'(?<![\w`])Syes(?![\w`])', '`S_yes`', article)
    return article


def _ephemeral_figure_note(figure):
    ordinal = figure.get('ordinal') if isinstance(figure, dict) else None
    caption = figure.get('caption') if isinstance(figure, dict) else None
    if not isinstance(ordinal, int) or isinstance(ordinal, bool) or ordinal < 1 \
            or not isinstance(caption, str) or not caption.strip() \
            or '\n' in caption or '\r' in caption:
        raise PublishDataValidationError('临时图片的序号必须是正整数，图注必须是非空且不含换行的字符串。')
    return f'> **论文图 {ordinal}（像素未随页面持久化）**：{caption.strip()}'


def render_ephemeral_api_reader_figures(article, figures):
    """核对保存正文中的论文图位置和 URL 顺序，不写入本地图片文件。

    图片记录保存官方 arXiv HTTPS 地址及分析时所用图片的信息。
    本函数保留远程图片的 Markdown，校验后返回原正文，不创建图片缓存或复制资产。
    """
    if not isinstance(article, str) or not isinstance(figures, list):
        raise PublishDataValidationError('临时图片显示所需的正文必须是字符串，图片记录必须是列表。')
    rendered = article
    for figure in figures:
        if not isinstance(figure, dict) or not isinstance(figure.get('url'), str):
            raise PublishDataValidationError('临时图片记录缺失或格式无效，或 URL 不是字符串。')
        pattern = re.compile(
            rf'^!\[(?:\\.|[^\]\\\n])*\]\({re.escape(figure["url"])}\)$',
            flags=re.MULTILINE,
        )
        _ephemeral_figure_note(figure)
        if len(pattern.findall(rendered)) != 1:
            raise PublishDataValidationError(
                f'临时使用的论文图 {figure.get("ordinal")} 未在保存的读者正文中恰好出现一次。'
            )
    expected_urls = [figure['url'] for figure in figures]
    if _api_reader_article_image_urls(rendered) != expected_urls:
        raise PublishDataValidationError('发布正文中的图片 URL 与保存的图片记录在内容或顺序上不一致。')
    return rendered


def _api_reader_payload(paper):
    """核验保存的读者正文、编辑计划和阶段记录，并构造发布所需的数据。"""
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    reader_contract = contracts.get('apiReaderArticle')
    if reader_contract not in LLM_API_READER_LEGACY_CONTRACTS | {
            LLM_API_READER_CONTRACT}:
        return None
    declared_figure_persistence = contracts.get('apiReaderFigurePersistence')
    if declared_figure_persistence not in (None, EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT):
        raise PublishDataValidationError('读者文章中的图片保存方式不符合要求。')
    if declared_figure_persistence == EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT \
            and reader_contract not in LLM_API_READER_STRUCTURED_CONTRACTS:
        raise PublishDataValidationError('临时使用图片的方式仅适用于采用结构化记录的读者文章。')
    article = paper.get('apiReaderArticle')
    plan = paper.get('apiReaderPlan')
    stage = (manifest.get('stages') or {}).get('apiReaderArticle') or {}
    if not isinstance(article, str) or not article.strip() or not isinstance(plan, dict):
        raise PublishDataValidationError('读者正文缺失或不是非空字符串，或编辑计划不是对象。')
    article = article.strip()
    article_sha = _javascript_string_sha256(article)
    plan_sha = _stable_json_sha256(plan)
    if (paper.get('apiReaderArticleSha256') != article_sha
            or paper.get('apiReaderPlanSha256') != plan_sha
            or stage.get('status') != 'complete'
            or stage.get('articleSha256') != article_sha
            or stage.get('planSha256') != plan_sha):
        raise PublishDataValidationError('保存的读者正文或编辑计划 SHA 与论文记录、阶段记录不一致，或读者文章阶段尚未完成。')
    plan_version = plan.get('version')
    expected_plan_versions = {
        'beginner-researcher-v1': {1},
        'beginner-researcher-v2': {1, 2},
        LLM_API_READER_CONTRACT: {3},
    }
    if plan_version not in expected_plan_versions.get(reader_contract, set()) \
            or plan.get('contract') != reader_contract:
        raise PublishDataValidationError('读者文章的编辑计划版本或规则与当前文章格式不匹配。')
    source_binding_proof = (
        _validate_api_reader_source_bindings(paper)
        if reader_contract == LLM_API_READER_CONTRACT else None
    )
    author_identity_proof = (
        _validate_api_reader_author_identity(paper)
        if reader_contract == LLM_API_READER_CONTRACT else None
    )
    resource_identity_proof = (
        _validate_api_reader_resource_identity(paper)
        if reader_contract == LLM_API_READER_CONTRACT else None
    )
    if not isinstance(plan.get('readerTitle'), str) \
            or not isinstance(plan.get('oneSentenceThesis'), str):
        raise PublishDataValidationError('编辑计划中的读者标题或一句话主线必须是字符串。')
    plan_sections = plan.get('sections')
    allowed_kinds = (
        'background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation',
        'reproduction', 'synthesis',
    )
    required_kinds = ({
        'background', 'related_work', 'method_overview', 'training',
        'experiment_setup', 'result', 'limitation', 'reproduction', 'synthesis',
    } if reader_contract in LLM_API_READER_STRUCTURED_CONTRACTS else {
        'background', 'related_work', 'method_overview', 'experiment_setup',
        'result', 'limitation', 'synthesis',
    })
    minimum_sections = 12 if plan_version == 3 else 10 if plan_version == 2 else (
        8 if reader_contract in LLM_API_READER_STRUCTURED_CONTRACTS else 6
    )
    maximum_sections = 18 if plan_version == 3 else 14 if plan_version == 2 else 12
    if not isinstance(plan_sections, list) \
            or not minimum_sections <= len(plan_sections) <= maximum_sections:
        raise PublishDataValidationError(
            f'编辑计划的小节必须是列表，且包含 {minimum_sections}-{maximum_sections} 个小节。'
        )
    kinds = []
    planned_headings = []
    previous_rank = -1
    for section in plan_sections:
        if not isinstance(section, dict) or set(section) != {'kind', 'heading'}:
            raise PublishDataValidationError('编辑计划的小节记录格式无效、缺少必要字段，或含有不允许的字段。')
        kind = section.get('kind')
        heading = section.get('heading')
        if kind not in allowed_kinds or not isinstance(heading, str) or not heading.strip():
            raise PublishDataValidationError('编辑计划的小节类型不符合要求，或小节标题不是非空字符串。')
        rank = allowed_kinds.index(kind)
        if rank < previous_rank:
            raise PublishDataValidationError('编辑计划中的小节未按规定的学习顺序排列。')
        previous_rank = rank
        kinds.append(kind)
        planned_headings.append(heading.strip())
    if not required_kinds.issubset(kinds):
        raise PublishDataValidationError('编辑计划缺少读者文章必需的小节类型。')
    article_headings = re.findall(r'^###\s+(.+?)\s*$', article, flags=re.MULTILINE)
    if article_headings != planned_headings or len(set(article_headings)) != len(article_headings):
        raise PublishDataValidationError('编辑计划与正文的小节标题或排列顺序不一致，或正文存在重复标题。')
    if plan_version in {2, 3}:
        concept_bridges = plan.get('conceptBridges')
        figure_placements = plan.get('figurePlacements')
        minimum_bridges = 4 if plan_version == 3 else 3
        maximum_bridges = 10 if plan_version == 3 else 8
        if not isinstance(concept_bridges, list) \
                or not minimum_bridges <= len(concept_bridges) <= maximum_bridges \
                or not isinstance(figure_placements, list) \
                or len(figure_placements) > 4:
            raise PublishDataValidationError(
                f'v{plan_version} 编辑计划中的术语说明或图片位置记录缺失、格式无效，或数量不符合要求。'
            )
        for index, bridge in enumerate(concept_bridges, 1):
            if not isinstance(bridge, dict) or set(bridge) != {
                    'terms', 'sectionKind', 'marker', 'explanation'} \
                    or not isinstance(bridge.get('terms'), list) \
                    or len(bridge['terms']) != 2 \
                    or bridge.get('sectionKind') not in allowed_kinds \
                    or bridge.get('marker') != f'[[CONCEPT_BRIDGE_{index}]]' \
                    or not isinstance(bridge.get('explanation'), str) \
                    or bridge['explanation'] not in article \
                    or bridge['marker'] in article:
                raise PublishDataValidationError(
                    f'v{plan_version} 术语说明的字段、适用小节或占位标记不符合要求，或说明内容未完整出现在正文中。'
                )
        seen_placement_ordinals = set()
        for placement in figure_placements:
            expected_placement_fields = {
                    'figureOrdinal', 'targetKind', 'marker',
                    'leadQuote', 'explanationQuote'}
            if plan_version == 3:
                expected_placement_fields.add('focusPoints')
            if not isinstance(placement, dict) \
                    or set(placement) != expected_placement_fields \
                    or not isinstance(placement.get('figureOrdinal'), int) \
                    or placement['figureOrdinal'] in seen_placement_ordinals \
                    or placement.get('targetKind') not in allowed_kinds \
                    or placement.get('marker') != f'[[FIGURE_{placement["figureOrdinal"]}]]' \
                    or placement['marker'] in article \
                    or not isinstance(placement.get('leadQuote'), str) \
                    or not isinstance(placement.get('explanationQuote'), str) \
                    or len(placement['leadQuote'].strip()) < 30 \
                    or len(placement['explanationQuote'].strip()) < 45 \
                    or (plan_version == 3 and (
                        not isinstance(placement.get('focusPoints'), list)
                        or not 2 <= len(placement['focusPoints']) <= 4
                        # 原始观察点最多 120 个字符；排版规范化可能在中文与英文之间补空格。
                        # 这里允许带空格的文本扩展至 160 个字符，去除空白后仍不得超过 120。
                        or not all(isinstance(item, str)
                                   and 12 <= len(item.strip()) <= 160
                                   and len(re.sub(r'\s+', '', item.strip())) <= 120
                                   for item in placement['focusPoints'])
                    )):
                raise PublishDataValidationError(
                    f'v{plan_version} 图片位置计划的字段、序号、适用小节、占位标记、导读、解释或观察点不符合要求。'
                )
            seen_placement_ordinals.add(placement['figureOrdinal'])
    figures = paper.get('apiReaderFigures')
    if reader_contract in LLM_API_READER_STRUCTURED_CONTRACTS:
        if not isinstance(figures, list):
            raise PublishDataValidationError('读者文章缺少结构化的图片记录列表。')
        figures_sha = _stable_json_sha256(figures)
        if stage.get('figureCount') != len(figures) \
                or stage.get('figuresSha256') != figures_sha:
            raise PublishDataValidationError('读者文章的图片记录条数或 SHA 与阶段记录不一致。')
        article_image_urls = _api_reader_article_image_urls(article)
        figure_urls = [item.get('url') for item in figures if isinstance(item, dict)]
        if article_image_urls != figure_urls or len(set(figure_urls)) != len(figure_urls):
            raise PublishDataValidationError('正文中的图片 URL 与图片记录的内容或顺序不一致，或图片记录存在重复 URL。')
        figure_persistence = declared_figure_persistence
        ephemeral_figures = figure_persistence == EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        article_paragraphs = re.split(r'\n(?:[ \t]*\n)+', article)
        figure_assets = []
        for item in figures:
            expected_figure_fields = {
                    'ordinal', 'label', 'caption', 'url', 'mediaType',
                    'sourceDomSha256', 'targetKind', 'targetHeading'}
            if not ephemeral_figures:
                expected_figure_fields.update({
                    'cachePath', 'assetFilename', 'assetMediaType',
                    'assetSha256', 'assetBytes', 'assetWidth', 'assetHeight'})
            elif 'assetSha256' in item:
                # 历史直接分析可保留临时像素的内容 SHA，作为图片证据；
                # 此字段不提供可复制的图片文件路径。
                expected_figure_fields.add('assetSha256')
            if plan_version in {2, 3}:
                expected_figure_fields.update({
                    'marker', 'leadQuote', 'explanationQuote',
                })
            if plan_version == 3:
                expected_figure_fields.add('focusPoints')
            if not isinstance(item, dict) or set(item) != expected_figure_fields:
                raise PublishDataValidationError('读者文章的图片记录格式无效、缺少必要字段，或含有不允许的字段。')
            if plan_version in {2, 3}:
                placement = next((entry for entry in plan['figurePlacements']
                                  if entry['figureOrdinal'] == item['ordinal']), None)
                binding_keys = (
                    'marker', 'leadQuote', 'explanationQuote', 'targetKind',
                    *(() if plan_version == 2 else ('focusPoints',)),
                )
                if placement is None or any(
                        item.get(key) != placement.get(key)
                        for key in binding_keys):
                    raise PublishDataValidationError(
                        f'v{plan_version} 图片记录缺少对应的位置计划，或图片内容字段与计划不一致。'
                    )
                matching_headings = {
                    section['heading'] for section in plan_sections
                    if section['kind'] == item.get('targetKind')
                }
                if item.get('targetHeading') not in matching_headings:
                    raise PublishDataValidationError(
                        f'v{plan_version} 图片的目标标题未对应章节计划中同类型的小节。'
                    )
            if plan_version == 3:
                expected_focus = '> **看图路径：** ' + '；'.join(
                    f'{index}. {value}'
                    for index, value in enumerate(item['focusPoints'], 1)
                )
                image_index = next((
                    index for index, paragraph in enumerate(article_paragraphs)
                    if re.fullmatch(
                        rf'!\[(?:\\.|[^\]\\\n])*\]\({re.escape(item["url"])}\)',
                        paragraph.strip(),
                    )
                ), None)
                if image_index is None or image_index < 2 \
                        or image_index + 2 >= len(article_paragraphs) \
                        or article_paragraphs[image_index - 1].strip() != expected_focus \
                        or item['leadQuote'] not in article_paragraphs[image_index - 2] \
                        or not re.fullmatch(
                            rf'[ *_]*论文图\s*{item["ordinal"]}。[\s\S]+[ *_]*',
                            article_paragraphs[image_index + 1].strip(),
                        ) \
                        or item['explanationQuote'] not in article_paragraphs[image_index + 2]:
                    raise PublishDataValidationError(
                        'API Reader v3 的论文图未按导读、看图路径、原图、图注和解释的顺序相邻排列，或对应内容与图片计划不一致。'
                    )
            parsed_url = urlparse(item['url'])
            if parsed_url.scheme != 'https' \
                    or parsed_url.hostname not in {'arxiv.org', 'www.arxiv.org'} \
                    or not re.fullmatch(r'[0-9a-f]{64}', str(item['sourceDomSha256'])):
                raise PublishDataValidationError('读者文章的图片 URL 未使用官方 arXiv HTTPS 地址，或来源 DOM SHA 格式无效。')
            if ephemeral_figures:
                # 此类记录不保存缓存和像素字段；最终页面保留已核验的图片元数据，
                # 记录中可有临时像素的内容 SHA，但不能有路径、字节数或像素内容。
                if item.get('assetSha256') is not None \
                        and not re.fullmatch(r'[0-9a-f]{64}', str(item['assetSha256'])):
                    raise PublishDataValidationError(
                        '临时图片的像素证据 SHA 格式无效。'
                    )
                _ephemeral_figure_note(item)
                continue
            declared_cache_path = Path(str(item['cachePath'] or '')).expanduser()
            if declared_cache_path.is_symlink() or declared_cache_path.parent.is_symlink():
                raise PublishDataValidationError('读者文章的图片缓存路径及其直接父目录不得是符号链接。')
            cache_path = declared_cache_path.resolve()
            cache_root = (Path(CURRENT_DIR) / 'api-reader-assets' / paper_id).resolve()
            try:
                cache_path.relative_to(cache_root)
            except ValueError as exc:
                raise PublishDataValidationError('读者文章的图片缓存路径不在该论文指定的缓存目录内。') from exc
            raw_asset = cache_path.read_bytes() if cache_path.is_file() else b''
            png_dimensions = (
                struct.unpack('>II', raw_asset[16:24])
                if raw_asset.startswith(PNG_SIGNATURE) and len(raw_asset) >= 24
                else (0, 0)
            )
            if not cache_path.is_file() \
                    or cache_path.name != item['assetFilename'] \
                    or not re.fullmatch(r'figure-\d+-[0-9a-f]{16}\.png', cache_path.name) \
                    or item['assetMediaType'] != 'image/png' \
                    or not re.fullmatch(r'[0-9a-f]{64}', str(item['assetSha256'])) \
                    or _sha256_file(cache_path) != item['assetSha256'] \
                    or cache_path.stat().st_size != item['assetBytes'] \
                    or png_dimensions != (item['assetWidth'], item['assetHeight']) \
                    or not (600 <= item['assetWidth'] <= 4096) \
                    or not (200 <= item['assetHeight'] <= 4096):
                raise PublishDataValidationError('读者文章的图片缓存文件缺失，或文件名、格式、SHA、字节数及尺寸不符合记录要求。')
            destination = Path('static') / 'images' / 'papers' / paper_id / cache_path.name
            public_url = f'{BASE_PATH.rstrip("/")}/images/papers/{paper_id}/{cache_path.name}'
            figure_assets.append({
                'sourcePath': str(cache_path),
                'destination': destination.as_posix(),
                'publicUrl': public_url,
                'sourceUrl': item['url'],
                'sha256': item['assetSha256'],
            })
        if ephemeral_figures and paper_id == '2609.18673':
            # 官方论文图 1 的标题与坐标轴含义不一致，发布时使用指定的裁切图片。
            # 图片证据中的官方 URL 和图注保持原样。
            override_source = (
                PROJECT_ROOT / 'assets' / 'publish-figure-overrides'
                / '2609-18673-figure-1-cropped.png'
            ).resolve()
            if not override_source.is_file():
                raise PublishDataValidationError('发布所需的论文图 1 裁切文件缺失。')
            override_destination = (
                Path('static') / 'images' / 'papers' / paper_id
                / 'figure-1-6e2b2741029d9194.png'
            )
            figure_assets.append({
                'sourcePath': str(override_source),
                'destination': override_destination.as_posix(),
                'publicUrl': f'{BASE_PATH.rstrip("/")}/images/papers/{paper_id}/figure-1-6e2b2741029d9194.png',
                'sourceUrl': 'https://arxiv.org/html/2609.18673v1/fig/fig_distinctness_scatter.png',
                'sha256': _sha256_file(override_source),
            })
        reader_authors = paper.get('apiReaderAuthors')
        expected_author_fields = (
            {'authors', 'sourceDomSha256', 'identity', 'identitySha256'}
            if reader_contract == LLM_API_READER_CONTRACT else
            {'authors', 'sourceDomSha256'}
        )
        if not isinstance(reader_authors, dict) \
                or set(reader_authors) != expected_author_fields \
                or not isinstance(reader_authors.get('authors'), list) \
                or not re.fullmatch(
                    r'[0-9a-f]{64}', str(reader_authors.get('sourceDomSha256') or '')
                ) \
                or stage.get('readerAuthorsSha256') != _stable_json_sha256(reader_authors):
            raise PublishDataValidationError('读者文章的作者与机构记录缺失、字段或来源 DOM SHA 无效，或记录 SHA 与阶段记录不一致。')
        for author in reader_authors['authors']:
            if not isinstance(author, dict) or set(author) != {'name', 'affiliations'} \
                    or not isinstance(author.get('name'), str) \
                    or not isinstance(author.get('affiliations'), list) \
                    or not author['name'].strip() \
                    or not author['affiliations'] \
                    or not all(isinstance(value, str) and value.strip()
                               for value in author['affiliations']):
                raise PublishDataValidationError('读者文章的作者或机构字段不符合要求，姓名和机构名称必须是非空字符串。')
    else:
        figures = []
        figure_assets = []
        reader_authors = None
        figure_persistence = None
    rendered_article = _apply_reader_display_fixes(
        _add_reader_term_heading_spaces(article, plan)
    ) if reader_contract == LLM_API_READER_CONTRACT else article
    if reader_contract == LLM_API_READER_CONTRACT:
        rendered_article = _normalize_api_reader_display_artifacts(rendered_article)
    if figure_persistence == EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT:
        rendered_article = render_ephemeral_api_reader_figures(rendered_article, figures)
    for asset in figure_assets:
        rendered_article = rendered_article.replace(
            f']({asset["sourceUrl"]})', f']({asset["publicUrl"]})'
        )
    return {
        'contract': reader_contract,
        'plan': plan,
        'article': article,
        'renderedArticle': rendered_article,
        'articleSha256': article_sha,
        'planSha256': plan_sha,
        'figures': figures,
        'assets': figure_assets,
        'figurePersistence': figure_persistence,
        'readerAuthors': reader_authors,
        'sourceBindingProof': source_binding_proof,
        'authorIdentityProof': author_identity_proof,
        'resourceIdentityProof': resource_identity_proof,
    }


def _api_reader_page_binding_issue(content, paper):
    """核对最终页面的来源标记及显示内容，并重新检查表格和公式的来源记录。"""
    if not isinstance(paper, dict):
        return None
    manifest = paper.get('analysisManifest')
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    if not isinstance(contracts, dict) \
            or contracts.get('apiReaderArticle') != LLM_API_READER_CONTRACT:
        return None
    try:
        payload = _api_reader_payload(paper)
        proof = payload.get('sourceBindingProof') if isinstance(payload, dict) else None
        author_proof = payload.get('authorIdentityProof') if isinstance(payload, dict) else None
        resource_proof = payload.get('resourceIdentityProof') if isinstance(payload, dict) else None
        if not isinstance(proof, dict):
            raise PublishDataValidationError('读者文章页面缺少表格与公式的 v4 来源核验结果。')
        if not isinstance(author_proof, dict) or not isinstance(resource_proof, dict):
            raise PublishDataValidationError('读者文章页面缺少作者来源或资源核验结果。')
        def frontmatter_value(field, pattern):
            match = re.search(
                rf'^{re.escape(field)}:\s*{pattern}\s*$', content, flags=re.MULTILINE,
            )
            return match.group(1) if match else None

        marker_contract = re.search(
            r'^paper_digest_api_reader_source_binding_contract:\s*"([^"]+)"\s*$',
            content, flags=re.MULTILINE,
        )
        marker_sha = re.search(
            r'^paper_digest_api_reader_source_bindings_sha256:\s*"([0-9a-f]+)"\s*$',
            content, flags=re.MULTILINE,
        )
        marker_table_count = re.search(
            r'^paper_digest_api_reader_source_table_count:\s*(\d+)\s*$',
            content, flags=re.MULTILINE,
        )
        marker_formula_count = re.search(
            r'^paper_digest_api_reader_source_formula_count:\s*(\d+)\s*$',
            content, flags=re.MULTILINE,
        )
        marker_structured_sha = re.search(
            r'^paper_digest_api_reader_structured_artifacts_sha256:\s*"([0-9a-f]+)"\s*$',
            content, flags=re.MULTILINE,
        )
        if marker_contract is None or marker_contract.group(1) != proof['contract'] \
                or marker_sha is None or marker_sha.group(1) != proof['sha256']:
            raise PublishDataValidationError('页面头部的表格与公式来源标记或 SHA 缺失，或与正式 Reader 记录不一致。')
        if marker_table_count is None \
                or int(marker_table_count.group(1)) != proof['tableCount'] \
                or marker_formula_count is None \
                or int(marker_formula_count.group(1)) != proof['formulaCount'] \
                or marker_structured_sha is None \
                or marker_structured_sha.group(1) != proof['structuredArtifactsSha256']:
            raise PublishDataValidationError('最终页面的表格或公式来源条数、结构化证据 SHA 缺失，或与保存的核验结果不一致。')
        identity_markers = {
            'authorContract': frontmatter_value(
                'paper_digest_api_reader_author_identity_contract', r'"([^"]+)"',
            ),
            'authorSha': frontmatter_value(
                'paper_digest_api_reader_author_identity_sha256', r'"([0-9a-f]+)"',
            ),
            'authorCount': frontmatter_value(
                'paper_digest_api_reader_author_count', r'(\d+)',
            ),
            'resourceContract': frontmatter_value(
                'paper_digest_api_reader_resource_identity_contract', r'"([^"]+)"',
            ),
            'resourceSha': frontmatter_value(
                'paper_digest_api_reader_resource_identity_sha256', r'"([0-9a-f]+)"',
            ),
            'resourceCount': frontmatter_value(
                'paper_digest_api_reader_resource_count', r'(\d+)',
            ),
        }
        if identity_markers != {
                'authorContract': author_proof['contract'],
                'authorSha': author_proof['sha256'],
                'authorCount': str(author_proof['count']),
                'resourceContract': resource_proof['contract'],
                'resourceSha': resource_proof['sha256'],
                'resourceCount': str(resource_proof['count']),
        }:
            raise PublishDataValidationError('最终页面的作者或资源核验标记缺失，或其中的规则、SHA、条数与保存的核验结果不一致。')
        figure_persistence_marker = frontmatter_value(
            'paper_digest_api_reader_figure_persistence', r'"([^"]+)"',
        )
        if payload.get('figurePersistence') == EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT:
            if figure_persistence_marker != EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT:
                raise PublishDataValidationError('最终页面的图片保存方式标记缺失，或与读者文章记录不一致。')
        elif figure_persistence_marker is not None:
            raise PublishDataValidationError('未采用临时图片保存方式的读者文章页面不得声明该方式。')

        def h2_section(label):
            heading_match = re.search(
                rf'^##\s+{re.escape(label)}\s*$', content, flags=re.MULTILINE,
            )
            if heading_match is None:
                return None
            start = heading_match.end()
            start += len(content[start:]) - len(content[start:].lstrip('\n'))
            next_heading = re.search(r'^##\s+', content[start:], flags=re.MULTILINE)
            end = start + next_heading.start() if next_heading else len(content)
            return content[start:end].strip()

        actual_authors = h2_section('👥 作者与机构')
        expected_authors = sanitize_markdown_for_publish('\n'.join(
            f'- {author["name"]}：{"；".join(author["affiliations"])}'
            for author in author_proof['authors']
        )).strip()
        if actual_authors != expected_authors:
            raise PublishDataValidationError('页面中的作者和机构与已绑定来源的作者记录不一致。')
        reader_display_fields = _build_api_reader_display_fields(paper, payload)
        if frontmatter_value('paper_digest_api_reader_decision_projection', r'"([^"]+)"') \
                != API_READER_DECISION_PROJECTION_CONTRACT:
            raise PublishDataValidationError('页面缺少有效的 Reader 展示字段标记 paper_digest_api_reader_decision_projection。')
        if h2_section('📌 核心摘要') != sanitize_markdown_for_publish(reader_display_fields['summary']).strip():
            raise PublishDataValidationError('页面核心摘要与当前 Reader 记录中应展示的摘要不一致。')
        if find_evaluation_headings(content, rendered=True) or re.search(r'^##\s+(?:💡\s*研究者判断|📎\s*补充信息|⚖️\s*评分依据与证据)',
                     content, flags=re.MULTILINE):
            raise PublishDataValidationError('读者文章页面混入了未经独立事实审查的分析解释栏目。')
        expected_resources = reader_display_fields['opensource']
        expected_resources = sanitize_markdown_for_publish(
            _nest_reader_headings(expected_resources.strip(), minimum_level=3)
        ).strip()
        actual_resources = h2_section('🔗 开源与复现资源')
        if not expected_resources or actual_resources != expected_resources:
            raise PublishDataValidationError('最终页面缺少有效的开源与复现资源说明，或说明与资源核验记录的展示结果不一致。')
        actual_scores = h2_section('⚖️ 评分明细')
        if actual_scores is not None:
            actual_scores = re.split(r'^---\s*$', actual_scores, maxsplit=1, flags=re.MULTILINE)[0].strip()
        if actual_scores != sanitize_markdown_for_publish(reader_display_fields['scoringReason']).strip():
            raise PublishDataValidationError('页面评分明细与按当前评分记录生成的说明不一致。')
        positive_claims = {
            'code': r'代码[^\n]{0,18}(?:已开源|已经开源|可以访问|可直接下载|仓库可用)',
            'model': r'(?:模型|权重)[^\n]{0,18}(?:已公开|已经公开|可以访问|可直接下载|权重可用)',
            'dataset': r'数据集[^\n]{0,18}(?:已公开|已经公开|可以访问|可直接下载|数据可用)',
        }
        available_types = set(resource_proof['availableTypes'])
        for resource_type, pattern in positive_claims.items():
            if resource_type not in available_types \
                    and re.search(pattern, actual_resources, flags=re.IGNORECASE):
                raise PublishDataValidationError(
                    f'最终页面把 {resource_type} 的 temporary/unavailable 资源写成可用'
                )
        heading = re.search(r'^##\s+🧭\s*深度解读\s*$', content, flags=re.MULTILINE)
        if heading is None:
            raise PublishDataValidationError('最终页面缺少读者文章的深度解读部分。')
        article_start = heading.end()
        if content[article_start:article_start + 2] == '\n\n':
            article_start += 2
        else:
            article_start += len(content[article_start:]) - len(content[article_start:].lstrip('\n'))
        expected_article = sanitize_markdown_for_publish(_nest_reader_headings(
            payload['renderedArticle'].strip(), minimum_level=3,
        )).strip()
        page_article = content[article_start:article_start + len(expected_article)]
        if page_article != expected_article:
            raise PublishDataValidationError('页面深度解读与正式 Reader 正文的渲染结果不一致。')
        page_proof = _validate_api_reader_source_bindings(paper, article=page_article)
        if page_proof != proof:
            raise PublishDataValidationError('最终页面表格或公式的来源核验结果与保存记录不一致。')
    except PublishDataValidationError as exc:
        return str(exc)
    return None


def _normalize_fresh_article(value):
    """沿用 Manual 文件核验模块的正文规范化规则。"""
    return _normalize_fresh_article_impl(value)


def _validate_manual_v5_fresh_authoring(paper, article, date_str):
    """将项目路径传给 Manual 核验模块，检查新写作正文及其输入文件。"""
    return _verify_manual_v5_fresh_authoring(
        paper, article, date_str,
        current_dir=CURRENT_DIR, project_root=PROJECT_ROOT,
    )


def _validate_manual_v5_tutorial_payload(paper, article, date_str):
    """将项目路径传给 Manual 核验模块，检查教程质量记录和图表计划。"""
    return _verify_manual_v5_tutorial_payload(
        paper, article, date_str, current_dir=CURRENT_DIR,
    )


def _manual_reader_article(paper, plan, date_str=None):
    """核对保存的读者正文及其 SHA，并按 Manual 版本执行对应的材料检查。"""
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    if isinstance(contracts, dict) \
            and contracts.get('manualDepth') == MANUAL_DEPTH_CONTRACT_VERSION_V6:
        # v6 必须通过完整材料检查，缺失或不一致时直接拒绝。
        # 本分支不能像历史 v5 一样返回 None 后改用旧版页面布局。
        return validate_manual_v6_payload(paper)['article']
    if not plan or plan.get('version') != 2:
        return None
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    takeover = manifest.get('manualTakeover') if isinstance(manifest.get('manualTakeover'), dict) else {}
    article = takeover.get('readerArticle')
    expected_sha = takeover.get('readerArticleSha256')
    if not isinstance(article, str) or not article.strip() or not isinstance(expected_sha, str):
        return None
    actual_sha = _javascript_string_sha256(article)
    if actual_sha != expected_sha:
        return None
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    if contracts.get('manualDepth') == MANUAL_DEPTH_CONTRACT_VERSION_V5:
        if not date_str:
            raise PublishDataValidationError('Manual v5 fresh publisher 缺少目标发布日期')
        _validate_manual_v5_fresh_authoring(paper, article, date_str)
        _validate_manual_v5_tutorial_payload(paper, article, date_str)
    return article.strip()


def _nest_reader_headings(content, minimum_level=4):
    """Keep author-written reader subheads below the generated page section."""
    def replace(match):
        return '#' * max(len(match.group(1)), minimum_level) + match.group(2)
    return re.sub(r'^(#{1,6})(\s+)', replace, content, flags=re.MULTILINE)


def _reader_first_image_plans_by_url(paper):
    """Resolve Manual insertion plans to their selected URL without guessing."""
    manifest = paper.get('imageManifest') if isinstance(paper.get('imageManifest'), dict) else {}
    selected = manifest.get('selected') if isinstance(manifest.get('selected'), list) else []
    selected_by_number = {
        item.get('index', position + 1): item.get('url')
        for position, item in enumerate(selected)
        if isinstance(item, dict) and isinstance(item.get('url'), str)
    }
    plans = {}
    for plan in manifest.get('insertionPlan') or []:
        if not isinstance(plan, dict):
            continue
        url = plan.get('url')
        if not isinstance(url, str):
            url = selected_by_number.get(plan.get('imageNumber'))
        if isinstance(url, str) and url.startswith('https://'):
            plans[url] = plan
    return plans


def _strip_non_reader_article_images(content, image_plans_by_url):
    """Remove only a complete, exact legacy duplicate of a Manual v5 image group.

    A reader-first page renders compact compatibility fields *and* the
    separately attested reader article.  A selected figure may therefore still
    be present in a legacy field.  Deleting only its image leaves orphaned
    “如下图” / “图中” prose; guessing from those phrases is equally unsafe.
    Remove the three-block group only when the canonical insertion plan proves
    that the immediately adjacent blocks are the exact lead and explanation.
    Any partial or unbound occurrence is deliberately retained so the final
    image-order gate fails closed instead of damaging reader prose.
    """
    if not isinstance(content, str) or not image_plans_by_url:
        return content
    paragraphs = re.split(r'\n(?:[ \t]*\n)+', content.strip())
    remove = set()
    for index, paragraph in enumerate(paragraphs):
        match = re.fullmatch(r'[ \t]*!\[[^\n]*\]\((https://[^)\s]+)\)[ \t]*', paragraph)
        if not match:
            continue
        url = match.group(1)
        plan = image_plans_by_url.get(url)
        if not isinstance(plan, dict) or index == 0 or index + 1 >= len(paragraphs):
            continue
        lead = re.sub(r'\s+', ' ', str(plan.get('lead') or '')).strip()
        explanation = re.sub(r'\s+', ' ', str(plan.get('explanation') or '')).strip()
        previous = re.sub(r'\s+', ' ', paragraphs[index - 1]).strip()
        following = re.sub(r'\s+', ' ', paragraphs[index + 1]).strip()
        if lead and explanation and previous == lead and following == explanation:
            remove.update((index - 1, index, index + 1))
    return '\n\n'.join(
        paragraph for index, paragraph in enumerate(paragraphs)
        if index not in remove and paragraph.strip()
    ).strip()


def generate_paper_page(paper, date_str, category='论文速递'):
    """生成单篇论文的独立页面"""
    heading_issue = evaluation_heading_issue(paper.get('analysis'))
    if heading_issue:
        raise PublishDataValidationError(heading_issue)
    # main() replaces parsed with the validated analysis baseline before generation.
    parsed_analysis = dict(paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {})
    try:
        read_tag_validation(parsed_analysis)
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error
    # 补充 opensource 中缺失的具体链接
    if parsed_analysis and parsed_analysis.get('opensource'):
        parsed_analysis['opensource'] = enrich_opensource(parsed_analysis, paper)
    title = paper.get('title', 'Unknown')
    display_title = plain_title_for_publish(title)
    aid = paper.get('arxivId', '')
    aurl = _visible_arxiv_source_url(paper)
    slug = paper_slug(title, aid)

    score_str = parsed_analysis['score'] if parsed_analysis and parsed_analysis.get('score') else ''
    task_str = parsed_analysis['primaryTaskTag'].replace('#', '') if parsed_analysis and parsed_analysis.get('primaryTaskTag') else ''
    desc = f"{task_str} | {score_str}/10" if score_str and task_str else display_title
    tags = parsed_analysis.get('tags', []) if parsed_analysis else []
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    manual_depth = contracts.get('manualDepth')
    v6_payload = _manual_v6_reader_payload(paper)
    api_reader_payload = _api_reader_payload(paper)
    manual_depth_marker = (
        f'paper_digest_manual_depth: "{manual_depth}"\n'
        if manual_depth in {
            MANUAL_DEPTH_CONTRACT_VERSION_V4,
            MANUAL_DEPTH_CONTRACT_VERSION_V5,
            MANUAL_DEPTH_CONTRACT_VERSION_V6,
        } else ''
    )
    v6_marker = ''
    if v6_payload:
        manual_v6_bindings = v6_payload['provenance']
        v6_marker = (
            'paper_digest_v6_runtime_mode: "production"\n'
            f'paper_digest_reader_longform: "{MANUAL_LONGFORM_CONTRACT_VERSION_V2}"\n'
            f'paper_digest_reader_longform_sha256: "{manual_v6_bindings["readerLongformSha256"]}"\n'
            f'paper_digest_reader_article_sha256: "{v6_payload["articleSha256"]}"\n'
            f'paper_digest_artifact_index_sha256: "{v6_payload["artifactIndexSha256"]}"\n'
            + ''.join(
                f'paper_digest_v6_{marker}: "{manual_v6_bindings[field]}"\n'
                for marker, field in (
                    ('spec_root_sha256', 'specRootSha256'),
                    ('paper_spec_sha256', 'paperSpecSha256'),
                    ('sealed_record_sha256', 'sealedRecordSha256'),
                    ('record_file_sha256', 'recordFileSha256'),
                    ('artifact_index_file_sha256', 'artifactIndexFileSha256'),
                    ('records_envelope_file_sha256', 'recordsEnvelopeFileSha256'),
                    ('task_evidence_sha256', 'taskEvidenceSha256'),
                )
            )
        )
    api_reader_marker = ''
    if api_reader_payload:
        source_binding_proof = api_reader_payload.get('sourceBindingProof')
        author_identity_proof = api_reader_payload.get('authorIdentityProof')
        resource_identity_proof = api_reader_payload.get('resourceIdentityProof')
        source_binding_marker = (
            f'paper_digest_api_reader_source_binding_contract: "{source_binding_proof["contract"]}"\n'
            f'paper_digest_api_reader_source_bindings_sha256: "{source_binding_proof["sha256"]}"\n'
            f'paper_digest_api_reader_source_table_count: {source_binding_proof["tableCount"]}\n'
            f'paper_digest_api_reader_source_formula_count: {source_binding_proof["formulaCount"]}\n'
            f'paper_digest_api_reader_structured_artifacts_sha256: "{source_binding_proof["structuredArtifactsSha256"]}"\n'
            if isinstance(source_binding_proof, dict) else ''
        )
        identity_marker = (
            f'paper_digest_api_reader_author_identity_contract: "{author_identity_proof["contract"]}"\n'
            f'paper_digest_api_reader_author_identity_sha256: "{author_identity_proof["sha256"]}"\n'
            f'paper_digest_api_reader_author_count: {author_identity_proof["count"]}\n'
            f'paper_digest_api_reader_resource_identity_contract: "{resource_identity_proof["contract"]}"\n'
            f'paper_digest_api_reader_resource_identity_sha256: "{resource_identity_proof["sha256"]}"\n'
            f'paper_digest_api_reader_resource_count: {resource_identity_proof["count"]}\n'
            if isinstance(author_identity_proof, dict)
            and isinstance(resource_identity_proof, dict) else ''
        )
        api_reader_marker = (
            f'paper_digest_api_reader_contract: "{api_reader_payload["contract"]}"\n'
            f'paper_digest_api_reader_article_sha256: "{api_reader_payload["articleSha256"]}"\n'
            f'paper_digest_api_reader_plan_sha256: "{api_reader_payload["planSha256"]}"\n'
            f'{source_binding_marker}'
            f'{identity_marker}'
        )
        if api_reader_payload.get('figurePersistence') == EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT:
            api_reader_marker += (
                'paper_digest_api_reader_figure_persistence: '
                f'"{EPHEMERAL_FIGURE_PERSISTENCE_CONTRACT}"\n'
            )
        if api_reader_payload['contract'] == LLM_API_READER_CONTRACT:
            api_reader_marker += (
                f'paper_digest_api_reader_decision_projection: "{API_READER_DECISION_PROJECTION_CONTRACT}"\n'
            )
    reader_plan = (
        v6_payload['plan'] if v6_payload
        else api_reader_payload['plan'] if api_reader_payload
        else _manual_reader_editorial_plan(paper)
    )
    reader_article = (
        v6_payload['article'] if v6_payload
        else api_reader_payload['renderedArticle'] if api_reader_payload
        else _manual_reader_article(paper, reader_plan, date_str)
    )
    if api_reader_payload and api_reader_payload.get('contract') == LLM_API_READER_CONTRACT:
        reader_article = _normalize_api_reader_display_artifacts(reader_article)
    reader_first = reader_plan is not None and reader_article is not None
    api_reader_v2 = bool(
        api_reader_payload
        and api_reader_payload.get('contract') in LLM_API_READER_STRUCTURED_CONTRACTS
    )
    reader_display_fields = _build_api_reader_display_fields(paper, api_reader_payload)
    # Modern Manual pages must never be reconstructed from the legacy fixed
    # canonical sections.  A missing, partial or tampered reader payload is a
    # hard failure: silently falling back would turn an old analysis into a
    # newly generated blog page and bypass fresh authoring.
    if manual_depth in {
            MANUAL_DEPTH_CONTRACT_VERSION_V5,
            MANUAL_DEPTH_CONTRACT_VERSION_V6,
    } and not reader_first:
        raise PublishDataValidationError(
            f'{aid or title} 当前 Manual 页面缺少完整且哈希一致的 Reader 正文；'
            '不能从旧正式分析记录的固定章节拼接正文，须依据论文来源重新写作。'
        )
    workbench_bundle = (
        build_researcher_workbench_bundle(
            paper, date_str, parsed=parsed_analysis, reader_plan=reader_plan,
            api_reader_payload=api_reader_payload,
            require_reader=True,
        )
        if reader_first and _researcher_workbench_eligible(
            v6_payload, api_reader_payload,
        ) else None
    )
    if workbench_bundle:
        desc = workbench_bundle['oneSentenceThesis']
    description_yaml = (
        json.dumps(desc, ensure_ascii=False)
        if workbench_bundle else f'"{yaml_escape(desc)}"'
    )
    reader_first_image_plans = _reader_first_image_plans_by_url(paper) if reader_first else {}
    fresh_marker = ''
    if manual_depth == MANUAL_DEPTH_CONTRACT_VERSION_V5 and reader_first:
        fresh = manifest['manualTakeover']['freshAuthoring']
        tutorial_payload = manifest['manualTakeover']['tutorialPayload']
        fresh_marker = (
            f'paper_digest_tutorial_contract: "{TUTORIAL_FORMAT_CONTRACT}"\n'
            f'paper_digest_fresh_authoring_contract: "{FRESH_AUTHORING_CONTRACT}"\n'
            f'paper_digest_fresh_authoring_sha256: "{fresh["receiptSha256"]}"\n'
            f'paper_digest_reader_article_sha256: "{fresh["articleSha256"]}"\n'
            f'paper_digest_tutorial_payload_contract: "{MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT}"\n'
            f'paper_digest_tutorial_payload_sha256: "{tutorial_payload["receiptSha256"]}"\n'
            f'paper_digest_tutorial_orchestrator_contract: "{MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT}"\n'
            f'paper_digest_tutorial_orchestrator_sha256: "{MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT}"\n'
            f'paper_digest_tutorial_quality_sha256: "{tutorial_payload["qualityPacketSha256"]}"\n'
            f'paper_digest_tutorial_artifact_plan_sha256: "{tutorial_payload["artifactPlanSha256"]}"\n'
        )
    reader_title = reader_plan['readerTitle'].strip() if reader_first else display_title
    workbench_marker = _researcher_workbench_frontmatter(workbench_bundle)
    md = f"""---
title: "{yaml_escape(display_title)}"
date: {date_str}
draft: false
tags: [{', '.join([t.replace('#', '') for t in tags])}]
categories: [{category}]
description: {description_yaml}
hiddenInHomeList: true
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
paper_digest_arxiv_id: "{normalize_arxiv_id(aid)}"
{workbench_marker}{manual_depth_marker}{fresh_marker}{v6_marker}{api_reader_marker}---

# 📄 {reader_title}

"""
    if reader_first:
        paper_link = f'[{display_title}]({aurl})' if aurl else display_title
        # Keep the Chinese reader title in the H1, then expose the paper's
        # original English title and canonical link explicitly.  Calling this
        # merely “论文” made the reader-first identity block ambiguous and
        # broke the same title/link contract used by the daily index.
        md += f'> 英文题目：*{paper_link}*\n\n' if reader_display_fields is not None else (
            f'> 英文题目：*{paper_link}*\n>\n> 一句话：**{reader_plan["oneSentenceThesis"].strip()}**\n\n'
        )
    md += _historical_source_notice(paper)
    reader_authors_content = ''
    if api_reader_v2 and api_reader_payload.get('readerAuthors'):
        reader_authors_content = '\n'.join(
            f'- {author["name"]}：{"；".join(author["affiliations"])}'
            for author in api_reader_payload['readerAuthors']['authors']
        )
    if paper.get('analysisSource') == 'abstract':
        md += '> ⚠️ 本文仅基于论文摘要生成，未能取得可验证的全文，技术细节与评分置信度有限。\n\n'
    elif paper.get('analysisConfidence') == 'full_text' and paper.get('sourceTextChars', 0) > paper.get('usedTextChars', paper.get('sourceTextChars', 0)):
        md += '> ℹ️ 本文基于论文全文节选生成，超出分析上下文上限的内容未纳入。\n\n'
    metadata_block = ''
    if parsed_analysis:
        reader_identity_lines = []
        display_tags = format_display_tags(tags)
        if display_tags:
            metadata_block += f"标签：{display_tags}\n\n"
            reader_identity_lines.append(f"标签：{display_tags}")

        score_line = format_complete_score_line(parsed_analysis)
        if score_line:
            metadata_block += f"{score_line}\n\n"
            reader_identity_lines.append(f"评分：{score_line}")

        meta = build_paper_meta(parsed_analysis, aurl)
        if meta:
            metadata_block += f"{meta}\n\n"
        if reader_display_fields is not None:
            metadata_block = (build_index_context_line(parsed_analysis, aurl) or '') + '\n\n'

        if parsed_analysis.get('authors') and not api_reader_v2:
            metadata_block += f"\n### 👥 作者与机构\n\n{parsed_analysis['authors']}\n"

        if reader_first and reader_identity_lines:
            md += '> ' + '\n>\n> '.join(reader_identity_lines) + '\n\n'
        elif not reader_first:
            md += metadata_block
        if api_reader_v2 and reader_authors_content:
            md += f"\n## 👥 作者与机构\n\n{reader_authors_content}\n"

        # 分离补充信息（从 opensource 中提取）
        opensource_content = reader_display_fields['opensource'] if reader_display_fields is not None \
            else parsed_analysis.get('opensource', '')
        supplementary = ''
        if opensource_content:
            supp_match = re.search(r'##\s*补充信息\s*\n([\s\S]*)', opensource_content)
            if supp_match:
                supplementary = supp_match.group(1).strip()
                opensource_content = opensource_content[:supp_match.start()].strip()

        sections = ([
            ('📌 核心摘要', 'summary', reader_display_fields['summary']),
            ('🔗 开源与复现资源', 'opensource', reader_display_fields['opensource']),
            ('🧭 深度解读', 'readerArticle', reader_article),
        ] if reader_display_fields is not None else (
            [
                ('💬 论文评价', 'roast'),
                ('📌 核心摘要', 'summary'),
                ('🔗 开源与复现资源', 'opensource', opensource_content),
                # The decision-facing blocks come first.  The long reader
                # article follows the resource status, then the score ledger
                # closes the page as auditable evidence.
                ('🧭 深度解读', 'readerArticle', reader_article),
                ('⚖️ 评分理由', 'scoringReason'),
            ] if reader_article else [
                ('📌 核心摘要', 'summary'),
                ('🏗️ 方法概述和架构', 'architecture'),
                ('💡 核心创新点', 'innovation'),
                ('📊 实验结果', 'results'),
                ('🔬 细节详述', 'details'),
                ('🚨 局限与问题', 'limitations'),
                ('🔗 开源与复现资源', 'opensource', opensource_content),
                ('💡 研究者判断', 'roast'),
                ('⚖️ 评分理由', 'scoringReason'),
            ]
        ))
        scoring_evidence = ''
        for item in sections:
            if len(item) == 3:
                label, key, content = item
            else:
                label, key = item
                content = parsed_analysis.get(key, '')
            if content:
                # 如果 summary 中混入了详细分析内容（因标题损坏导致解析边界失效），截断到详细分析之前
                if key == 'summary':
                    cutoff = re.search(r'\n##\s*详细分', content)
                    if cutoff:
                        content = content[:cutoff.start()].strip()
                # 清理内容开头可能残留的 Markdown 标题（如 LLM 输出自带了 ## 开源详情）。
                # Manual v5 reader-plan v2 deliberately owns its paper-specific
                # headings, so preserve and nest them instead of flattening them.
                if reader_first:
                    if key != 'readerArticle':
                        content = _strip_non_reader_article_images(
                            content, reader_first_image_plans,
                        )
                    content = _nest_reader_headings(
                        # API v2 exposes its teaching path at H3. Historical
                        # Manual/API contracts retain their sealed H4 nesting.
                        content.strip(), minimum_level=3 if api_reader_v2 else 4
                    )
                else:
                    content = re.sub(r'^(?:#{1,6}\s*[^\n]+\n+)+', '', content.strip(), count=1)
                # Numbered source sections in legacy prose are formatting noise,
                # but numbered headings in the canonical API Reader article are
                # source-bound bytes and must survive final-page replay intact.
                if key != 'readerArticle':
                    content = re.sub(r'^###\s*\d+\.\s*[^\n]+\n', '', content, flags=re.MULTILINE)
                content = re.sub(r'^\d+\.\s*\*\*([^*]+)\*\*\s*$', r'\1', content, flags=re.MULTILINE)
                if key == 'scoringReason':
                    if reader_first:
                        # Reader-first pages show the score at the top, but leave
                        # its evidence trail at the end, after the argument and limits.
                        scoring_evidence = content
                    else:
                        md += (
                            f'\n<details>\n<summary>{label}（展开查看）</summary>\n\n'
                            f'{content}\n\n</details>\n'
                        )
                else:
                    heading_level = '##' if api_reader_v2 else '###'
                    md += f'\n{heading_level} {label}\n\n{content}\n'

        # 补充信息放到最后面
        if supplementary:
            md += f'\n{"##" if api_reader_v2 else "###"} 📎 补充信息\n\n{supplementary}\n'
        if reader_first and metadata_block:
            md += f'\n<details>\n<summary>📎 论文与评分元数据</summary>\n\n{metadata_block.strip()}\n\n</details>\n'
        if reader_display_fields is not None:
            md += f'\n## ⚖️ 评分明细\n\n{reader_display_fields["scoringReason"]}\n'
        if reader_first and scoring_evidence:
            md += (
                f'\n{"##" if api_reader_v2 else "###"} ⚖️ 评分依据与证据（展开查看）\n\n'
                f'<details>\n<summary>逐维得分、全文证据与扣分边界</summary>\n\n'
                f'{scoring_evidence}\n\n</details>\n'
            )
    else:
        md += '> ⚠️ 该论文分析失败\n'

    md += f'\n---\n\n[← 返回 {date_str} 语音/音乐/音频论文速递]({BASE_PATH}/posts/{date_str}/)\n'

    return sanitize_markdown_for_publish(md), slug


def review_and_fix_post(file_path, paper=None, *, dry_run=False, source_content=None):
    """Review 生成的博客文件，自动修复常见问题，返回 (是否修复, 问题列表)"""
    if source_content is None:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
    else:
        content = str(source_content)

    original = content
    issues = []

    cleaned_anchors = strip_internal_scoring_anchors(content)
    if cleaned_anchors != content:
        removed_count = len(re.findall(
            r'\[(?:A|SCORING_SOURCE)_[A-Z0-9_/-]+\]', content,
        ))
        content = cleaned_anchors
        issues.append(f"发现并清理 {removed_count} 个内部评分证据锚点")

    # Exact long-prose duplication is deterministic and safe to remove before
    # spending LLM review calls. Tables, lists, headings, code and images are
    # excluded so grouped table continuation rows remain untouched.
    frontmatter_match = re.match(r'^---\n.*?\n---\n', content, flags=re.DOTALL)
    prose_prefix = frontmatter_match.group(0) if frontmatter_match else ''
    prose_body = content[len(prose_prefix):]
    blocks = re.split(r'(\n{2,})', prose_body)
    seen_prose = set()
    duplicate_count = 0
    for index in range(0, len(blocks), 2):
        block = blocks[index]
        normalized = re.sub(r'\s+', ' ', block).strip()
        protected = (
            len(normalized) < 80
            or normalized.startswith((
                '---', '#', '|', '-', '*', '>', '```', '~~~', '![', '评分：',
            ))
            or '\n|' in block
            or re.search(r'!\[[^\]]*\]\([^)]+\)', block)
        )
        if protected:
            continue
        fingerprint = unicodedata.normalize('NFKC', normalized).casefold()
        if fingerprint in seen_prose:
            blocks[index] = ''
            if index + 1 < len(blocks):
                blocks[index + 1] = ''
            duplicate_count += 1
        else:
            seen_prose.add(fingerprint)
    if duplicate_count:
        content = prose_prefix + ''.join(blocks)
        issues.append(f"发现并删除 {duplicate_count} 个完全重复的长正文段落")

    # 捕获只有少量措辞差异的批量近重复段落。阈值刻意保持很高，且继续
    # 排除标题、列表、表格、代码、引用与图片，避免删除合法表格续行或
    # 不同实验条件下结构相似但事实不同的数据行。
    prose_prefix = frontmatter_match.group(0) if frontmatter_match else ''
    prose_body = content[len(prose_prefix):]
    blocks = re.split(r'(\n{2,})', prose_body)
    seen_near = []
    near_duplicate_count = 0

    def extract_number_url_negation_tokens(text):
        """Keep tiny but material factual differences out of fuzzy deletion."""
        numbers = tuple(re.findall(r'(?<![A-Za-z])[-+]?\d+(?:\.\d+)?%?', text))
        urls = tuple(re.findall(r'https?://\S+', text, flags=re.IGNORECASE))
        negations = tuple(re.findall(
            r'未|不|无|没有|并非|不能|not|no|without|never',
            text,
            flags=re.IGNORECASE,
        ))
        return numbers, urls, negations

    for index in range(0, len(blocks), 2):
        block = blocks[index]
        normalized = re.sub(r'\s+', ' ', block).strip()
        protected = (
            len(normalized) < 100
            or normalized.startswith((
                '---', '#', '|', '-', '*', '>', '```', '~~~', '![', '评分：',
            ))
            or '\n|' in block
            or re.search(r'!\[[^\]]*\]\([^)]+\)', block)
        )
        if protected:
            continue
        fingerprint = unicodedata.normalize('NFKC', normalized).casefold()
        duplicate = any(
            extract_number_url_negation_tokens(fingerprint) == previous_fact_tokens
            and min(len(fingerprint), len(previous)) / max(len(fingerprint), len(previous)) >= 0.9
            and difflib.SequenceMatcher(
                None, fingerprint, previous, autojunk=False,
            ).ratio() >= 0.97
            for previous, previous_fact_tokens in seen_near
        )
        if duplicate:
            blocks[index] = ''
            if index + 1 < len(blocks):
                blocks[index + 1] = ''
            near_duplicate_count += 1
        else:
            seen_near.append((fingerprint, extract_number_url_negation_tokens(fingerprint)))
    if near_duplicate_count:
        content = prose_prefix + ''.join(blocks)
        issues.append(f"发现并删除 {near_duplicate_count} 个近重复长正文段落")

    # 0. 修复 UTF-8 乱码字符（U+FFFD），从上下文推断正确汉字
    # 先统一检测，再统一修复，避免逐词替换时的顺序问题
    garbled_count = content.count('\ufffd')
    if garbled_count > 0:
        # 直接删除孤立的替换字符（1-3 字节的 � 没有上下文可推断）
        # 连续的 � 通常是 1 个中文字符损坏，替换为合理占位
        content = content.replace('\ufffd\ufffd\ufffd', '。')
        content = content.replace('\ufffd\ufffd', '。')
        # 单字符乱码：如果是中文语境，替换为空；英文语境保留原意
        content = re.sub(r'\ufffd', '', content)
        issues.append(f"发现并修复 {garbled_count} 个 UTF-8 乱码字符")

    # 1. 检查未转义的 HTML-like 标签（可能导致删除线等样式问题）
    # 匹配不在反引号、不在 code block 中的 <S>、<E>、<task>、<perception> 等标签
    html_tag_pattern = re.compile(
        r'(?<![a-zA-Z0-9`])<(/?)([SE]|task|perception|comprehension|reasoning|agent|action|state|observation|reward|goal|intent|belief|plan|policy|environment|module|component|feature|input|output|label|class|category|type|mode|phase|stage|step|layer|block|unit|node|edge|graph|tree|path|loop|branch|condition|constraint|rule|fact|evidence|proof|hypothesis|assumption|premise|conclusion|result|finding|insight|implication|contribution|limitation|direction|extension|variant|version|update|fix|issue|error|warning|notice|info|trace|log|record|entry|item|element|object|subject|target|source|reference|cite|quote|note|comment|remark|annotation|caption|title|heading|paragraph|sentence|phrase|word|token|char|symbol|sign|mark|tag|badge|identifier|id|key|code|pin|secret|ticket|voucher|license|permit|certificate|credential|award|medal|prize|gift|bonus|benefit|advantage|edge|lead|margin|gap|difference|distance|range|scope|span|scale|size|length|width|height|depth|volume|area|surface|space|place|spot|location|site|position|point|dot|pixel|fragment|shard|piece|part|portion|section|segment|slice|chunk|block|lump|mass|body|entity|thing|article|product|goods|material|substance|matter|fabric|cloth|garment|clothing|wear|dress|costume|uniform|outfit|suit|wardrobe|closet|cabinet|cupboard|pantry|cellar|basement|attic|loft|tower|spire|dome|vault|arch|beam|column|pillar|post|pole|rod|bar|rail|track|path|way|road|route|course|direction|heading|bearing|azimuth|elevation|altitude|latitude|longitude|coordinate)(?![a-zA-Z0-9`])>',
        re.IGNORECASE
    )
    matches = html_tag_pattern.findall(content)
    if matches:
        issues.append(f"发现 {len(matches)} 个未转义的 HTML-like 标签: {set(matches)}")
        content = escape_html_like_tags(content)

    # 2. 检查未正确转换的 LaTeX 行内公式（$...$ 形式，可能被 Hugo 解析为 markdown）
    # 排除已在 \( ... \) 中的，以及 code block 中的
    frontmatter_match = re.match(r'^---\n.*?\n---\n', content, flags=re.DOTALL)
    latex_prefix = frontmatter_match.group(0) if frontmatter_match else ''
    latex_body = content[len(latex_prefix):]
    latex_pattern = re.compile(r'(?<!\\)\$([^\s$][^$]*?)\$(?!\d)')
    latex_matches = latex_pattern.findall(latex_body)
    if latex_matches:
        issues.append(f"发现 {len(latex_matches)} 个未转换的 LaTeX 行内公式")
        content = latex_prefix + fix_latex_delimiters(latex_body)

    # Hugo 数学分隔符本身已经负责渲染；外围反引号会把公式重新变成代码。
    backticked_math = re.compile(
        r'(?<!`)`\s*(\\\([^`\n]+\\\)|\\\[[^`\n]+\\\])\s*`(?!`)'
    )
    backticked_math_count = len(backticked_math.findall(content))
    if backticked_math_count:
        content = backticked_math.sub(r'\1', content)
        issues.append(f"发现并修复 {backticked_math_count} 个被反引号包裹的 LaTeX 公式")

    # 3. 检查是否有裸的 HTML 标签（如 <s>、<e> 等小写形式）
    raw_html_pattern = re.compile(r'<(s|e|b|i|u)(\s+[^>]*)?>([^<]*)</\1>', re.IGNORECASE)
    raw_matches = raw_html_pattern.findall(content)
    if raw_matches:
        issues.append(f"发现 {len(raw_matches)} 个裸 HTML 标签，已转为纯文本")
        content = strip_raw_inline_html(content)

    # 4. 检查并修复非标准图片引用格式
    if re.search(r'外部\s*URL:', content):
        issues.append("发现非标准图片引用格式，尝试自动修复")
        content = fix_image_markdown(content)

    # 5. 过长 data URI 不能截成伪造图片；必须显式阻断并转存合法资产。
    base64_matches = re.findall(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', content)
    long_base64 = [m for m in base64_matches if len(m) > 50000]
    if long_base64:
        issues.append(f"发现 {len(long_base64)} 个过长的 base64 data URI，已阻断；请转存为受控图片资产")

    # 6. 修复 YAML frontmatter 双逗号
    if ',,' in content.split('---\n')[1] if len(content.split('---\n')) >= 3 else False:
        issues.append("发现 YAML frontmatter 双逗号，已修复")
        content = fix_yaml_double_commas(content)

    # 7. 检查并修复未闭合的 LaTeX $ 公式（$ \mathcal{L}_D \( 形式）
    broken_latex_pattern = re.compile(r'\$ \\mathcal\{([^}]+)\}[^\\]*\\\(')
    if broken_latex_pattern.search(content):
        issues.append("发现未闭合的 LaTeX $ 公式，已修复")
        content = broken_latex_pattern.sub(lambda m: f'\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 8. 检查并修复表格中错乱的 LaTeX 括号（如 \)\\mathcal{L}_D$）
    broken_latex_table = re.compile(r'\\\)\\\\mathcal\{([^}]+)\}\$')
    if broken_latex_table.search(content):
        issues.append("发现表格中错乱的 LaTeX，已修复")
        content = broken_latex_table.sub(lambda m: f'\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 9. 检查并修复 "仅\)\mathcal{L}_A\(" 这类错乱模式
    broken_paren_latex = re.compile(r'仅\\\)\\mathcal\{([^}]+)\}\\\(')
    if broken_paren_latex.search(content):
        issues.append("发现错乱的 LaTeX 括号，已修复")
        content = broken_paren_latex.sub(lambda m: f'仅\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 10. 检查并修复 \(\\mathcal{L}_X\) 双反斜杠问题
    double_backslash_latex = re.compile(r'\\\(\\\\mathcal\{([^}]+)\}\\\)')
    if double_backslash_latex.search(content):
        issues.append("发现双反斜杠 LaTeX，已修复")
        content = double_backslash_latex.sub(lambda m: f'\\(\\mathcal{{{m.group(1)}}}\\)', content)

    # 11. 检查是否有未闭合的 markdown 链接或图片引用
    broken_link_pattern = re.compile(r'!?\[([^\]]*)\]\s*\(\s*\)')
    broken_links = broken_link_pattern.findall(content)
    if broken_links:
        issues.append(f"发现 {len(broken_links)} 个空链接，已修复")
        content = fix_empty_markdown_links(content)

    # Deterministic Markdown table shape validation. This only checks tables
    # with an explicit separator row and never treats an empty leading group
    # cell as a heading or removes legal continuation rows.
    table_lines = content.splitlines()
    for index, line in enumerate(table_lines):
        if not re.match(r'^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$', line):
            continue
        expected_columns = len(split_markdown_table_row(line))
        start = index - 1
        end = index + 1
        while start >= 0 and table_lines[start].lstrip().startswith('|'):
            start -= 1
        while end < len(table_lines) and table_lines[end].lstrip().startswith('|'):
            end += 1
        malformed = []
        for row_index in range(start + 1, end):
            row = table_lines[row_index]
            columns = len(split_markdown_table_row(row))
            if columns != expected_columns:
                malformed.append((row_index + 1, columns))
        if malformed:
            detail = ', '.join(f'第{row}行={columns}列' for row, columns in malformed)
            issues.append(f"Markdown 表格列数不一致：期望 {expected_columns} 列，{detail}")

    # Long captions can be cut by the upstream model at a word boundary. Keep
    # a concise, sentence-aligned alt so the page remains accessible and the
    # vision reviewer does not receive a misleading half-sentence.  A complete
    # caption already bound to the authoritative image manifest must remain
    # byte-stable: an English source caption may legitimately omit the final
    # period and still end in a complete word such as ``respectively``.
    authoritative_captions_by_url = {}
    image_manifest = paper.get('imageManifest') if isinstance(paper, dict) else None
    if isinstance(image_manifest, dict):
        for collection_name in ('selected', 'downloaded', 'candidates'):
            collection = image_manifest.get(collection_name)
            if not isinstance(collection, list):
                continue
            for image in collection:
                if not isinstance(image, dict):
                    continue
                image_url = str(image.get('url') or '').strip()
                caption = str(image.get('caption') or image.get('alt') or '').strip()
                if image_url and caption:
                    authoritative_captions_by_url.setdefault(image_url, set()).add(caption)

    def normalize_caption_binding(value):
        text = unicodedata.normalize('NFKC', str(value or ''))
        text = re.sub(r'[\u200b-\u200d\ufeff]', '', text)
        text = re.sub(
            r'^(?:fig(?:ure)?\.?\s*)\d+[a-z]?(?:\s*[:.\-–—]\s*|\s+)',
            '', text, flags=re.IGNORECASE,
        )
        # The Node image assembler escapes backslashes and square brackets for
        # Markdown alt text.  Undo only those deterministic escapes before the
        # provenance comparison; do not otherwise rewrite the reader text.
        while '\\\\' in text:
            text = text.replace('\\\\', '\\')
        text = text.replace('\\[', '[').replace('\\]', ']')
        text = re.sub(r'\s+', ' ', text).strip()
        text = re.sub(
            r'([A-Za-z]{1,12}\s*[=<>]\s*-?\d+(?:\.\d+)?%?)\s*\1',
            r'\1', text, flags=re.IGNORECASE,
        )
        return text

    normalized_authoritative_captions_by_url = {
        url: {normalize_caption_binding(caption) for caption in captions}
        for url, captions in authoritative_captions_by_url.items()
    }

    def shorten_truncated_alt(match):
        alt, url = match.group(1), match.group(2)
        stripped = alt.strip()
        normalized_alt = normalize_caption_binding(stripped)
        if normalized_alt and normalized_alt in normalized_authoritative_captions_by_url.get(url, set()):
            return match.group(0)
        # 上游常在 160/180 字符附近硬截 caption；120 字已经足以保留
        # 一条可访问性描述，继续等待到 180 会漏掉 Spec/C/T 等半词结尾。
        if len(stripped) < 120 or not re.search(r'[A-Za-z]+$', stripped):
            return match.group(0)
        prefix = stripped[:160]
        boundaries = [
            prefix.rfind('。'), prefix.rfind('；'), prefix.rfind('; '),
            prefix.rfind('. '), prefix.rfind(', '), prefix.rfind('，'),
        ]
        boundary = max(boundaries)
        if boundary >= 80:
            concise = prefix[:boundary + 1].strip()
        else:
            concise = prefix.rsplit(' ', 1)[0].strip() + '…'
        return f'![{concise}]({url})'

    shortened = re.sub(
        r'!\[([^\]]*)\]\(([^)\n]+)\)',
        shorten_truncated_alt,
        content,
    )
    if shortened != content:
        issues.append('发现并缩短了被截断的长图片 alt/caption')
        content = shortened

    # 11.5 检查并修复空/重复图片 alt
    deduped_content = dedupe_image_alts(content)
    if deduped_content != content:
        issues.append("发现空或重复图片 alt，已补齐/去重")
        content = deduped_content

    # 面向中文读者的固定栏目不得整段退化为英文。确定性层只负责阻断，
    # 不凭空翻译或生成观点；普通 LLM review 或 manual reviewer 必须据原文
    # 给出真正的中文点评后才能签发凭证。
    evaluation_blocks = [content]
    if re.search(r'^paper_digest_page_type:[ \t]*index[ \t]*$',
                 prose_prefix, flags=re.MULTILINE):
        list_body = content.split('## 📋 论文列表', 1)[-1]
        paper_starts = [match.start() for match in re.finditer(
            r'^### (?:🥇|🥈|🥉|\d+\.) [^\n]+$', list_body, flags=re.MULTILINE)]
        if paper_starts:
            boundaries = [0, *paper_starts, len(list_body)]
            evaluation_blocks = [list_body[start:end] for start, end in
                                 zip(boundaries, boundaries[1:]) if start < end]
    for evaluation_block in evaluation_blocks:
        heading_issue = evaluation_heading_issue(evaluation_block, rendered=True)
        if heading_issue:
            issues.append(heading_issue)
            continue
        evaluation_text = extract_evaluation_section(evaluation_block, rendered=True)
        han_count = len(re.findall(r'[\u3400-\u9fff]', evaluation_text))
        latin_count = len(re.findall(r'[A-Za-z]', evaluation_text))
        if latin_count >= 120 and (han_count < 20 or latin_count > han_count * 3):
            issues.append('论文评价以英文为主，必须改为简体中文后才能发布')

    # 12. 检查 YAML frontmatter 中是否有未闭合的双引号
    content_before_yaml_quote_fix = content
    content = fix_yaml_unbalanced_quotes(content)
    if content != content_before_yaml_quote_fix:
        issues.append("发现 YAML frontmatter 未闭合引号，已修复")
    yaml_lines = content.split('---\n')
    if len(yaml_lines) >= 3:
        yaml_block = yaml_lines[1]
        for line in yaml_block.split('\n'):
            if ':' in line and '"' in line:
                quote_count = line.count('"')
                if quote_count % 2 != 0:
                    issues.append(f"YAML 行可能存在未闭合引号: {line[:60]}")
                    break

    fixed = content != original
    if fixed and not dry_run:
        atomic_write_text(file_path, content)

    manual_v4_issue = validate_final_manual_v4_markdown(content, paper)
    if manual_v4_issue:
        issues.append(f'Manual v4 的最终 Markdown 内容未通过检查：{manual_v4_issue}')
    api_reader_issue = _api_reader_page_binding_issue(content, paper)
    if api_reader_issue:
        issues.append(f'读者文章的最终 Markdown 内容未通过来源核验：{api_reader_issue}')
    index_quality_issue = validate_digest_index_reader_quality(content)
    if index_quality_issue:
        issues.append(f'汇总页的内容不符合读者阅读要求：{index_quality_issue}')

    return fixed, issues


def classify_review_failure(issues):
    """Separate retryable review infrastructure/protocol failures from content defects."""
    blocking = [issue for issue in (issues or []) if is_blocking_review_issue(issue)]
    if not blocking:
        return None
    if all(isinstance(issue, dict) and issue.get('type') == 'infrastructure' for issue in blocking):
        return 'transient'
    transient_markers = (
        '连续失败', '调用失败', '返回非 json', '响应不完整', '协议',
        '下载失败', '超时', '绝对截止时间', 'timeout', 'unavailable',
    )
    if all(
        isinstance(issue, dict)
        and any(marker in str(issue.get('description', '')).lower() for marker in transient_markers)
        for issue in blocking
    ):
        return 'transient'
    return 'content'


def _paper_fresh_run_id(paper):
    fresh_source_details = paper.get('freshRewriteProvenance') if isinstance(paper, dict) else None
    run_id = fresh_source_details.get('runId') if isinstance(fresh_source_details, dict) else None
    return run_id if isinstance(run_id, str) and re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', run_id,
    ) else None


GENERATION_INPUT_SOURCE_REFERENCE_CONTRACT = 'generation-input-source-reference-v1'


def build_generation_input_source_reference(data_file):
    """Describe the exact canonical/archived JSON selected for generation.

    This is deliberately a file reference, rather than an inferred `current`
    location: review runs later and must replay the same input that generation
    selected after `--date` / `--data-file` resolution. A missing file returns
    ``None`` only for injected legacy/unit-test callers; the normal loader then
    remains responsible for rejecting the absent input before generation.
    """
    if data_file is None:
        return None
    candidate = Path(data_file).expanduser()
    if not candidate.is_absolute():
        candidate = (Path.cwd() / candidate).resolve()
    try:
        entry = candidate.lstat()
    except OSError:
        return None
    if stat.S_ISLNK(entry.st_mode):
        raise PublishDataValidationError('generation 输入文件不能是符号链接')
    if not stat.S_ISREG(entry.st_mode):
        raise PublishDataValidationError('generation 输入必须是普通 JSON 文件')
    resolved_input_path = candidate.resolve()
    input_file_bytes = resolved_input_path.read_bytes()
    return {
        'contract': GENERATION_INPUT_SOURCE_REFERENCE_CONTRACT,
        'version': 1,
        'path': str(resolved_input_path),
        'sha256': hashlib.sha256(input_file_bytes).hexdigest(),
        'bytes': len(input_file_bytes),
    }


def validate_generation_input_source_reference(manifest, target_date):
    """Replay a generation manifest's exact input file before review/push.

    Older manifests legitimately have no file reference. A newly generated
    manifest carries the reference and cannot silently fall back to
    ``DEEP_ANALYSIS_RESULT_FILE`` when the selected archive or `--data-file`
    differs from current.
    """
    if not isinstance(manifest, dict):
        raise PublishDataValidationError('生成清单必须是对象，才能读取其中的输入来源记录。')
    reference = manifest.get('inputSourceReference')
    if reference is None:
        return None
    expected_keys = {'contract', 'version', 'path', 'sha256', 'bytes'}
    if (
            not isinstance(reference, dict) or set(reference) != expected_keys
            or reference.get('contract') != GENERATION_INPUT_SOURCE_REFERENCE_CONTRACT
            or reference.get('version') != 1
            or not isinstance(reference.get('path'), str)
            or not Path(reference['path']).is_absolute()
            or not re.fullmatch(r'[0-9a-f]{64}', str(reference.get('sha256') or ''))
            or not isinstance(reference.get('bytes'), int)
            or reference['bytes'] < 0
    ):
        raise PublishDataValidationError('generation 输入来源引用缺失或格式非法')
    source = Path(reference['path'])
    try:
        entry = source.lstat()
    except OSError as exc:
        raise PublishDataValidationError('generation 输入来源文件无法重放') from exc
    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISREG(entry.st_mode):
        raise PublishDataValidationError('generation 输入来源必须保持为普通非符号链接文件')
    try:
        payload = source.read_bytes()
    except OSError as exc:
        raise PublishDataValidationError('generation 输入来源文件无法读取') from exc
    if len(payload) != reference['bytes'] or hashlib.sha256(payload).hexdigest() != reference['sha256']:
        raise PublishDataValidationError('generation 输入来源文件字节或 SHA-256 已漂移')
    validate_daily_fresh_sources_for_publish(str(source), target_date)
    return str(source)


_DAILY_FRESH_SOURCE_REFERENCE_KEYS = frozenset({
    'contract', 'version', 'runId', 'batchDate', 'batchId', 'sourceGeneration',
    'sourceSetSha256', 'runManifestSha256',
})
_DAILY_FRESH_SOURCE_RUN_KEYS = frozenset({
    'contract', 'version', 'runId', 'batchDate', 'batchId', 'paperIds',
    'sourceSetSha256', 'sourceExpectations',
})
_DAILY_FRESH_SOURCE_MANIFEST_KEYS = frozenset({
    'contract', 'version', 'arxivId', 'paperId', 'generation', 'capturedAt',
    'text', 'pdf', 'runtimeMetadata',
})
_DAILY_FRESH_SOURCE_RUNTIME_KEYS = frozenset({
    'contract', 'version', 'paperId', 'title', 'textSha256',
    'structuredArtifacts', 'imageInfos', 'readerAuthors', 'htmlAvailability',
    'htmlAttempts', 'warnings',
})
_ARXIV_HISTORICAL_VERSION_KEYS = frozenset({
    'contract', 'version', 'canonicalArxivId', 'selectedSourceId', 'textSourceId',
    'selectedPdfUrl', 'currentPdfAvailable', 'attemptedCurrentPdfStatus',
    'attemptedCurrentPdfUrl', 'warning', 'identitySha256',
})
_DAILY_FRESH_SOURCE_FORBIDDEN_RUNTIME_FIELDS = frozenset({
    'cachePath', 'tempPath', 'rawBytes', 'assetBytes', 'base64', 'buffer',
    'assetFilename', 'assetMediaType', 'assetWidth', 'assetHeight', 'dataUri',
})


def _daily_fresh_sha256(value):
    return hashlib.sha256(value).hexdigest()


def _daily_fresh_is_sha256(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _daily_fresh_canonical(value):
    if isinstance(value, dict):
        return {key: _daily_fresh_canonical(value[key]) for key in sorted(value)}
    if isinstance(value, list):
        return [_daily_fresh_canonical(item) for item in value]
    return value


def _daily_fresh_canonical_json_bytes(value):
    try:
        return (json.dumps(
            _daily_fresh_canonical(value), ensure_ascii=False, indent=2,
            allow_nan=False,
        ) + '\n').encode('utf-8')
    except (TypeError, ValueError) as exc:
        raise PublishDataValidationError('daily sealed source JSON 不可规范化') from exc


def _daily_fresh_compact_json_bytes(value):
    """Mirror JSON.stringify for sealed objects already canonicalized by Node."""
    try:
        return json.dumps(
            value, ensure_ascii=False, separators=(',', ':'), allow_nan=False,
        ).encode('utf-8')
    except (TypeError, ValueError) as exc:
        raise PublishDataValidationError('daily sealed source JSON 不可重放') from exc


def _daily_fresh_safe_directory(directory, label):
    try:
        entry = Path(directory).lstat()
    except OSError as exc:
        raise PublishDataValidationError(f'{label} 无法读取') from exc
    if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode):
        raise PublishDataValidationError(f'{label} 必须是非符号链接目录')
    return Path(directory)


def _daily_fresh_read_private_file(filename, label, maximum_bytes):
    """Use the source store's private-file semantics for publish-time replay."""
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = None
    try:
        descriptor = os.open(filename, flags)
        info = os.fstat(descriptor)
        if (
                not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_size < 0 or info.st_size > maximum_bytes
                or (os.name != 'nt' and stat.S_IMODE(info.st_mode) != 0o600)
        ):
            raise PublishDataValidationError(f'{label} 不是安全的私有普通文件')
        chunks = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        payload = b''.join(chunks)
        if len(payload) != info.st_size:
            raise PublishDataValidationError(f'{label} 在重放时发生字节漂移')
        return payload
    except PublishDataValidationError:
        raise
    except OSError as exc:
        raise PublishDataValidationError(f'{label} 无法安全读取') from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _daily_fresh_read_canonical_json(filename, label, maximum_bytes):
    raw = _daily_fresh_read_private_file(filename, label, maximum_bytes)
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'{label} 不是有效 JSON') from exc
    if raw != _daily_fresh_canonical_json_bytes(value):
        raise PublishDataValidationError(f'{label} 不是规范化 JSON')
    return raw, value


def _daily_fresh_contains_persistent_image_fields(value):
    if isinstance(value, list):
        return any(_daily_fresh_contains_persistent_image_fields(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(
        key in _DAILY_FRESH_SOURCE_FORBIDDEN_RUNTIME_FIELDS
        or _daily_fresh_contains_persistent_image_fields(item)
        for key, item in value.items()
    )


def _daily_fresh_normalized_paper_id(paper):
    if not isinstance(paper, dict):
        raise PublishDataValidationError('daily sealed source 发布输入包含非对象论文')
    value = normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
    if not re.fullmatch(r'\d{4}\.\d{4,5}', str(value or '')):
        raise PublishDataValidationError('daily sealed source 发布输入缺少规范化 arXiv ID')
    return value


def _daily_fresh_official_url(value, kind, paper_id, source_id=None):
    """Check the same official source URLs accepted by the Node source store."""
    if not isinstance(value, str) or not value.strip():
        raise PublishDataValidationError(f'{paper_id} 来源网址为空或不是字符串')
    try:
        parsed = urlsplit(value.strip())
        if (parsed.scheme != 'https' or parsed.hostname != 'arxiv.org'
                or parsed.port not in (None, 443) or parsed.username is not None
                or parsed.password is not None or parsed.query or parsed.fragment):
            raise ValueError('not an official source URL')
        pattern = (r'/pdf/(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)(?:\.pdf)?'
                   if kind == 'pdf' else r'/html/(\d{4}\.\d{4,5})(?:v\d+)?/?')
        match = re.fullmatch(pattern, unquote(parsed.path))
        if not match or normalize_publish_arxiv_id(match.group(1)) != paper_id:
            raise ValueError('URL belongs to another paper')
        if kind == 'pdf' and source_id is not None and match.group(1) != source_id:
            raise ValueError('PDF URL belongs to another version')
    except (ValueError, UnicodeError) as exc:
        raise PublishDataValidationError(f'{paper_id} 来源网址不是本篇论文的官方 HTTPS 地址') from exc
    return parsed._replace(scheme='https', netloc='arxiv.org').geturl(), match.group(1)


def _daily_fresh_historical_version(value, paper_id):
    if not isinstance(value, dict) or set(value) != _ARXIV_HISTORICAL_VERSION_KEYS:
        raise PublishDataValidationError(f'{paper_id} 历史版本记录的字段不完整或包含未知字段')
    selected_id = value.get('selectedSourceId')
    if (not isinstance(selected_id, str)
            or re.fullmatch(re.escape(paper_id) + r'v[1-9]\d*', selected_id) is None):
        raise PublishDataValidationError(f'{paper_id} 历史版本记录没有指定本篇论文的有效版本')
    selected_url, _ = _daily_fresh_official_url(
        value.get('selectedPdfUrl'), 'pdf', paper_id, selected_id,
    )
    current_url, _ = _daily_fresh_official_url(
        value.get('attemptedCurrentPdfUrl'), 'pdf', paper_id, paper_id,
    )
    body = {
        'contract': 'arxiv-historical-version-source-v1', 'version': 1,
        'canonicalArxivId': paper_id, 'selectedSourceId': selected_id,
        'textSourceId': selected_id, 'selectedPdfUrl': selected_url,
        'currentPdfAvailable': False, 'attemptedCurrentPdfStatus': 404,
        'attemptedCurrentPdfUrl': current_url,
    }
    body['warning'] = (
        f'arXiv 当前无版本 PDF {current_url} 返回 HTTP 404，当前稿不可用；'
        f'本次只封存并分析官方历史版本 {selected_id}（{selected_url}），'
        '不得暗示当前稿仍有效。'
    )
    identity_sha = _daily_fresh_sha256(_daily_fresh_compact_json_bytes(
        _daily_fresh_canonical(body)
    ))
    if (type(value.get('version')) is not int
            or type(value.get('attemptedCurrentPdfStatus')) is not int
            or value.get('currentPdfAvailable') is not False
            or any(value.get(key) != expected for key, expected in body.items())
            or value.get('identitySha256') != identity_sha):
        raise PublishDataValidationError(f'{paper_id} 历史版本的身份、404 记录、警告或哈希不一致')
    return {**body, 'identitySha256': identity_sha}


def _workbench_source_identity(paper):
    identity = parse_publish_arxiv_identity(paper.get('arxivId'))
    if 'sourceVersion' not in paper:
        return identity
    source_version = _daily_fresh_historical_version(paper['sourceVersion'], identity['baseId'])
    proof = paper.get('freshRewriteProvenance')
    manifest = paper.get('analysisManifest')
    if (not isinstance(proof, dict) or not isinstance(manifest, dict)
            or manifest.get('freshRewriteProvenance') != proof
            or proof.get('sourceVersionIdentitySha256') != source_version['identitySha256']
            or (identity['versionedId'] is not None
                and identity['versionedId'] != source_version['selectedSourceId'])):
        raise PublishDataValidationError('引用资料中的历史版本未与论文分析的来源证明绑定')
    return parse_publish_arxiv_identity(source_version['selectedSourceId'])


def _visible_arxiv_source_url(paper):
    if 'sourceVersion' in paper:
        return _workbench_source_identity(paper)['absUrl']
    arxiv_id = paper.get('arxivId', '')
    return f'https://arxiv.org/abs/{arxiv_id}' if arxiv_id else ''


def _historical_source_notice(paper):
    if 'sourceVersion' not in paper:
        return ''
    _workbench_source_identity(paper)
    source_version = paper['sourceVersion']
    current_url = source_version['attemptedCurrentPdfUrl']
    selected_url = source_version['selectedPdfUrl']
    selected_id = source_version['selectedSourceId']
    return (
        f'> **来源版本说明**：arXiv 的[当前 PDF]({current_url})返回 HTTP 404。'
        f'本文依据官方历史版本 [{selected_id}]({selected_url})撰写，'
        '不代表当前稿仍然可用。\n\n'
    )


def _daily_fresh_validate_runtime(runtime, manifest, text, paper_id):
    runtime_keys = _DAILY_FRESH_SOURCE_RUNTIME_KEYS | (
        {'sourceVersion'} if isinstance(runtime, dict) and 'sourceVersion' in runtime else set()
    )
    if (
            not isinstance(runtime, dict) or set(runtime) != runtime_keys
            or runtime.get('contract') != 'fresh-arxiv-rewrite-runtime-metadata-v1'
            or runtime.get('version') != 1
            or runtime.get('paperId') != f'arxiv:{paper_id}'
            or runtime.get('textSha256') != _daily_fresh_sha256(text)
            or not isinstance(runtime.get('title'), str)
            or not isinstance(runtime.get('structuredArtifacts'), dict)
            or not isinstance(runtime.get('imageInfos'), list)
            or not isinstance(runtime.get('warnings'), list)
            or type(runtime.get('htmlAttempts')) is not int
            or runtime.get('htmlAttempts') < 0
            or not isinstance(runtime.get('htmlAvailability'), str)
            or (runtime.get('readerAuthors') is not None
                and (not isinstance(runtime.get('readerAuthors'), dict)
                     or isinstance(runtime.get('readerAuthors'), list)))
            or _daily_fresh_contains_persistent_image_fields(runtime)
    ):
        raise PublishDataValidationError(f'{paper_id} source-runtime.json 与 sealed TXT 不一致')
    if 'sourceVersion' in runtime:
        source_version = _daily_fresh_historical_version(runtime['sourceVersion'], paper_id)
        if source_version['warning'] not in runtime['warnings']:
            raise PublishDataValidationError(f'{paper_id} 来源警告没有包含已验证的历史版本说明')
    artifacts = runtime['structuredArtifacts']
    artifact_payload = dict(artifacts)
    payload_sha = artifact_payload.pop('payloadSha256', None)
    replayed_payload_sha = _daily_fresh_sha256(
        _daily_fresh_compact_json_bytes(_daily_fresh_canonical(artifact_payload))
    )
    has_text_only_source_record = (
        artifacts.get('version') == 1
        and artifacts.get('source') == 'fresh_arxiv_text_without_layout'
        and all(isinstance(artifacts.get(key), list) and not artifacts[key]
                for key in ('tables', 'formulas', 'figures'))
    )
    if (
            not _daily_fresh_is_sha256(payload_sha)
            or artifacts.get('flattenedTextSha256') != _daily_fresh_sha256(text)
            # Early sealed v4 runtimes signed the artifact before canonical
            # object-key ordering. The source manifest still authenticates the
            # exact runtime bytes, and the canonical paper proof binds that
            # declared SHA. Mirror Reader's compatibility rule: accept this
            # historical signature only when a parser identity (or the
            # explicit layoutless-text shape) is present and the sealed TXT
            # hash itself matches exactly.
            or (replayed_payload_sha != payload_sha
                and not str(artifacts.get('parserVersion') or '').strip()
                and not has_text_only_source_record)
    ):
        raise PublishDataValidationError(f'{paper_id} source-runtime.json structuredArtifacts 未绑定 sealed TXT')
    text_manifest = manifest.get('text')
    if runtime['textSha256'] != text_manifest.get('responseSha256'):
        raise PublishDataValidationError(f'{paper_id} source-runtime.json text SHA 与 source manifest 不一致')
    return artifacts


def _daily_fresh_validate_bundle(run_dir, paper_id, proof, paper):
    source_dir = run_dir / 'sources' / paper_id / 'generation-000001'
    _daily_fresh_safe_directory(run_dir / 'sources', 'daily sealed source 根目录')
    _daily_fresh_safe_directory(run_dir / 'sources' / paper_id, f'{paper_id} source 目录')
    _daily_fresh_safe_directory(source_dir, f'{paper_id} source generation 目录')
    try:
        entries = set(os.listdir(source_dir))
    except OSError as exc:
        raise PublishDataValidationError(f'{paper_id} source generation 目录无法读取') from exc
    if entries != {
            'source-manifest.json', 'source-runtime.json', 'source.pdf', 'source.txt',
    }:
        raise PublishDataValidationError(f'{paper_id} source generation 文件集合不完整或包含额外文件')
    manifest_bytes, manifest = _daily_fresh_read_canonical_json(
        source_dir / 'source-manifest.json', f'{paper_id} source-manifest.json', 1024 * 1024,
    )
    runtime_bytes, runtime = _daily_fresh_read_canonical_json(
        source_dir / 'source-runtime.json', f'{paper_id} source-runtime.json', 64 * 1024 * 1024,
    )
    text = _daily_fresh_read_private_file(
        source_dir / 'source.txt', f'{paper_id} source.txt', 64 * 1024 * 1024,
    )
    pdf = _daily_fresh_read_private_file(
        source_dir / 'source.pdf', f'{paper_id} source.pdf', 512 * 1024 * 1024,
    )
    if (
            not isinstance(manifest, dict) or set(manifest) != _DAILY_FRESH_SOURCE_MANIFEST_KEYS
            or manifest.get('contract') != 'fresh-arxiv-rewrite-source-v1'
            or manifest.get('version') != 2 or manifest.get('arxivId') != paper_id
            or manifest.get('paperId') != f'arxiv:{paper_id}' or manifest.get('generation') != 1
            or _daily_fresh_sha256(manifest_bytes) != proof.get('sourceManifestSha256')
            or _daily_fresh_sha256(text) != proof.get('sourceSha256')
            or not pdf.startswith(b'%PDF-')
    ):
        raise PublishDataValidationError(f'{paper_id} sealed TXT/PDF 或 provenance SHA 漂移')
    text_manifest = manifest.get('text')
    pdf_manifest = manifest.get('pdf')
    runtime_manifest = manifest.get('runtimeMetadata')
    if (
            not isinstance(text_manifest, dict) or not isinstance(pdf_manifest, dict)
            or not isinstance(runtime_manifest, dict)
            or text_manifest.get('filename') != 'source.txt'
            or text_manifest.get('source') not in {'html', 'pdf'}
            or normalize_publish_arxiv_id(text_manifest.get('sourceId')) != paper_id
            or text_manifest.get('responseBytes') != len(text)
            or text_manifest.get('responseSha256') != _daily_fresh_sha256(text)
            or text_manifest.get('responseSha256') != proof.get('sourceSha256')
            or pdf_manifest.get('filename') != 'source.pdf'
            or pdf_manifest.get('responseBytes') != len(pdf)
            or pdf_manifest.get('responseSha256') != _daily_fresh_sha256(pdf)
            or runtime_manifest.get('filename') != 'source-runtime.json'
            or runtime_manifest.get('responseBytes') != len(runtime_bytes)
            or runtime_manifest.get('responseSha256') != _daily_fresh_sha256(runtime_bytes)
    ):
        raise PublishDataValidationError(f'{paper_id} source manifest 未闭合 TXT/PDF/runtime SHA')
    artifacts = _daily_fresh_validate_runtime(runtime, manifest, text, paper_id)
    _daily_fresh_official_url(
        text_manifest.get('url'), 'pdf' if text_manifest['source'] == 'pdf' else 'html',
        paper_id, text_manifest['sourceId'],
    )
    _, pdf_source_id = _daily_fresh_official_url(pdf_manifest.get('url'), 'pdf', paper_id)
    if pdf_source_id != paper_id:
        source_version = _daily_fresh_historical_version(runtime.get('sourceVersion'), paper_id)
        if (source_version['selectedSourceId'] != pdf_source_id
                or text_manifest['source'] != 'pdf' or text_manifest['sourceId'] != pdf_source_id
                or paper.get('sourceVersion') != source_version
                or proof.get('sourceVersionIdentitySha256') != source_version['identitySha256']):
            raise PublishDataValidationError(f'{paper_id} TXT、PDF、论文或来源证明指向不同历史版本')
    elif ('sourceVersion' in runtime or 'sourceVersion' in paper
          or 'sourceVersionIdentitySha256' in proof):
        raise PublishDataValidationError(f'{paper_id} 当前 PDF 不得携带历史版本回退记录')
    details = {
        'text': text.decode('utf-8'),
        'source': text_manifest['source'],
        'sourceId': text_manifest['sourceId'],
        'imageInfos': runtime['imageInfos'],
        'structuredArtifacts': artifacts,
        'readerAuthors': {'authors': []} if runtime['readerAuthors'] is None else runtime['readerAuthors'],
        'htmlAvailability': runtime['htmlAvailability'],
        'htmlAttempts': runtime['htmlAttempts'],
        'warnings': runtime['warnings'],
    }
    source_snapshot_sha = _daily_fresh_sha256(_daily_fresh_compact_json_bytes({
        'sourceManifestSha256': _daily_fresh_sha256(manifest_bytes),
        'sourceGeneration': 1,
        'details': details,
    }))
    if proof.get('sourceSnapshotSha256') != source_snapshot_sha:
        raise PublishDataValidationError(f'{paper_id} fresh provenance 未绑定 source-runtime.json')
    manifest_proof = paper.get('analysisManifest', {}).get('freshRewriteProvenance') \
        if isinstance(paper.get('analysisManifest'), dict) else None
    if (
            manifest_proof != proof or paper.get('sourceSha256') != proof.get('sourceSha256')
            or not isinstance(paper.get('analysisManifest'), dict)
            or paper['analysisManifest'].get('sourceAcquisition', {}).get('sourceSha256')
            != proof.get('sourceSha256')
    ):
        raise PublishDataValidationError(f'{paper_id} daily fresh provenance 未闭合到 canonical/analysis manifest')


def validate_daily_fresh_sources_for_publish(data_file, target_date):
    """Replay every claimed daily source generation before generate/review/push.

    A daily run is all-or-nothing: its run reference and every paper's exact
    provenance must replay.  A legacy paper cannot be mixed into a batch that
    advertises a sealed daily run, even if a later publish filter would omit it.
    """
    # Generation's existing loader remains authoritative for an absent explicit
    # input.  The normal publication path always supplies a real source file.
    source_path = Path(data_file)
    if not source_path.is_file():
        return
    try:
        payload = json.loads(source_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError('无法读取 daily sealed source 输入') from exc
    if not isinstance(payload, dict):
        return
    papers = payload.get('papers')
    run_claimed = 'dailyFreshSourceRun' in payload
    claims_fresh_source_record = isinstance(papers, list) and any(
        isinstance(paper, dict) and 'freshRewriteProvenance' in paper
        for paper in papers
    )
    if not run_claimed and not claims_fresh_source_record:
        return
    if not isinstance(papers, list) or not papers:
        raise PublishDataValidationError('dailyFreshSourceRun 要求非空 papers 数组')
    reference = payload.get('dailyFreshSourceRun')
    if (
            not isinstance(reference, dict) or set(reference) != _DAILY_FRESH_SOURCE_REFERENCE_KEYS
            or reference.get('contract') != 'daily-fresh-source-reference-v1'
            or reference.get('version') != 1
            or not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', str(reference.get('runId') or ''))
            or reference.get('sourceGeneration') != 1
            or reference.get('batchDate') != target_date
            or not isinstance(reference.get('batchId'), str) or not reference['batchId'].strip()
            or not all(_daily_fresh_is_sha256(reference.get(key))
                       for key in ('sourceSetSha256', 'runManifestSha256'))
    ):
        raise PublishDataValidationError('dailyFreshSourceRun 缺失或格式非法')
    run_dir = DAILY_FRESH_SOURCE_RUNS_DIR / reference['runId']
    _daily_fresh_safe_directory(DAILY_FRESH_SOURCE_RUNS_DIR, 'daily sealed source 根目录')
    _daily_fresh_safe_directory(run_dir, 'daily sealed source run 目录')
    run_bytes, run = _daily_fresh_read_canonical_json(
        run_dir / 'run.json', 'daily sealed source run.json', 4 * 1024 * 1024,
    )
    if _daily_fresh_sha256(run_bytes) != reference['runManifestSha256']:
        raise PublishDataValidationError('daily sealed source run.json SHA 漂移')
    expected_ids = sorted(_daily_fresh_normalized_paper_id(paper) for paper in papers)
    if len(expected_ids) != len(set(expected_ids)):
        raise PublishDataValidationError('daily sealed source 发布输入包含重复 arXiv ID')
    source_expectations = {
        paper_id: {'sourceMode': 'sealed-arxiv-bundle-v1', 'sourceGeneration': 1}
        for paper_id in expected_ids
    }
    expected_set_sha = _daily_fresh_sha256(_daily_fresh_compact_json_bytes(
        _daily_fresh_canonical({
            'batchDate': reference['batchDate'], 'batchId': reference['batchId'],
            'paperIds': expected_ids, 'sourceGeneration': 1,
        })
    ))
    if (
            not isinstance(run, dict) or set(run) != _DAILY_FRESH_SOURCE_RUN_KEYS
            or run.get('contract') != 'daily-fresh-source-run-v1' or run.get('version') != 1
            or run.get('runId') != reference['runId']
            or run.get('batchDate') != reference['batchDate'] or run.get('batchId') != reference['batchId']
            or run.get('paperIds') != expected_ids or run.get('sourceExpectations') != source_expectations
            or run.get('sourceSetSha256') != reference['sourceSetSha256']
            or run.get('sourceSetSha256') != expected_set_sha
    ):
        raise PublishDataValidationError('daily sealed source run 未精确覆盖发布输入论文集合')
    for paper, paper_id in zip(papers, [_daily_fresh_normalized_paper_id(p) for p in papers]):
        proof = paper.get('freshRewriteProvenance') if isinstance(paper, dict) else None
        if (
                not isinstance(proof, dict) or proof.get('contract') != 'fresh-source-analysis-v1'
                or proof.get('runId') != reference['runId'] or proof.get('sourceGeneration') != 1
                or proof.get('sourceOnly') is not True or proof.get('oldGeneratedTextIncluded') is not False
                or not all(_daily_fresh_is_sha256(proof.get(key)) for key in (
                    'sourceManifestSha256', 'sourceSha256', 'sourceSnapshotSha256',
                ))
        ):
            raise PublishDataValidationError(f'{paper_id} 缺少精确 daily sealed fresh provenance')
        _daily_fresh_validate_bundle(run_dir, paper_id, proof, paper)


def _review_single_paper(args):
    """只读审查单篇论文，返回路径、标题、问题计数和输出。"""
    if len(args) == 7:
        arxiv_id, slug, date_str, title, require_llm, content_dir, paper = args
        page_artifact = None
    else:
        arxiv_id, slug, date_str, title, require_llm, content_dir, paper, page_artifact = args
    paper_file = os.path.join(content_dir, f"{date_str}-{slug}.md")
    if not os.path.exists(paper_file):
        return None

    expected_path = os.path.realpath(paper_file)
    if page_artifact is None:
        raw = Path(paper_file).read_bytes()
        page_artifact = {
            'path': expected_path,
            'sha256': hashlib.sha256(raw).hexdigest(),
            'content': raw.decode('utf-8'),
        }
    if (
        not isinstance(page_artifact, dict)
        or page_artifact.get('path') != expected_path
        or page_artifact.get('sha256') != _sha256_file(paper_file)
    ):
        raise PublishDataValidationError(f'{os.path.basename(paper_file)} page artifact 已失效')
    content = page_artifact['content']

    fixed_count = 0
    blocking_count = 0
    advisory_count = 0
    lines = []
    blocking_details = []

    # 1. 代码检查。最终 review 只读；任何本可自动修复的内容都必须回到
    # generation 修复并生成新 SHA，不能在审查阶段悄悄改变被审查字节。
    fixed, issues = review_and_fix_post(
        paper_file, paper, dry_run=True, source_content=content,
    )
    if fixed:
        lines.append("    ⛔ 页面仍需修复；最终审查只读取页面，请回到生成阶段修复后再审查。")
    remaining_code_issues = issues
    blocking_count += len(remaining_code_issues)
    blocking_details.extend({'severity': 'error', 'description': str(issue)} for issue in remaining_code_issues)
    for issue in issues:
        lines.append(f"    ⚠️  代码层: {issue}")
    if fixed and not issues:
        blocking_count += 1
        blocking_details.append({'severity': 'error', 'type': 'deterministic',
            'description': '最终字节需要确定性修复'})
    if blocking_count:
        return (expected_path, title, 0, blocking_count, 0, lines, 'content',
                page_artifact['sha256'], blocking_details)

    # 2. LLM 文本审查
    with review_unit_cache(date_str, paper_file, required=require_llm, paper_id=arxiv_id, run_id=_paper_fresh_run_id(paper)):
        llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, title, required=require_llm)
    if llm_passed is False and count_blocking_review_issues(llm_issues) == 0:
        llm_issues = list(llm_issues or []) + [{
            'severity': 'error',
            'description': '文本审查明确返回未通过，但没有给出阻断原因；本次审查按失败处理。',
        }]
    if llm_issues:
        for issue in llm_issues:
            sev = issue.get('severity', 'warning')
            desc = issue.get('description', '')
            lines.append(f"    🤖 LLM ({sev}): {desc}")
    if llm_fixed_content != content:
        readonly_issue = {
            'severity': 'error',
            'description': '模型建议修改最终页面；审查阶段不能写回文件，请回到生成阶段修复后重新审查。',
        }
        llm_issues = list(llm_issues or []) + [readonly_issue]
        lines.append(f"    🤖 LLM (error): {readonly_issue['description']}")
    if llm_issues:
        llm_blocking = count_blocking_review_issues(llm_issues)
        blocking_count += llm_blocking
        blocking_details.extend(issue for issue in llm_issues if is_blocking_review_issue(issue))
        advisory_count += len(llm_issues) - llm_blocking

    # 3. 多模态图片审查
    with review_unit_cache(date_str, paper_file, required=require_llm, paper_id=arxiv_id, run_id=_paper_fresh_run_id(paper)):
        img_passed, img_issues = multimodal_review_images(content, title, required=require_llm)
    if img_passed is False and count_blocking_review_issues(img_issues) == 0:
        img_issues = list(img_issues or []) + [{
            'severity': 'error',
            'description': '图片审查明确返回未通过，但没有给出阻断原因；本次审查按失败处理。',
        }]
    if img_issues:
        img_blocking = count_blocking_review_issues(img_issues)
        blocking_count += img_blocking
        blocking_details.extend(issue for issue in img_issues if is_blocking_review_issue(issue))
        advisory_count += len(img_issues) - img_blocking
        for issue in img_issues:
            sev = issue.get('severity', 'warning')
            desc = issue.get('description', '')
            lines.append(f"    🖼️  多模态 ({sev}): {desc}")

    if blocking_count == 0:
        if advisory_count == 0:
            lines.append("    ✅ 通过 review")
        else:
            lines.append(f"    ✅ 无阻断问题（保留 {advisory_count} 个 warning/info）")

    failure_kind = classify_review_failure(blocking_details) if blocking_count else None
    reviewed_sha256 = _sha256_file(paper_file)
    if reviewed_sha256 != page_artifact['sha256']:
        raise PublishDataValidationError(f'{os.path.basename(paper_file)} 在只读审查期间发生变化。')
    return (
        os.path.realpath(paper_file), title, fixed_count, blocking_count,
        advisory_count, lines, failure_kind, reviewed_sha256,
        blocking_details,
    )


def review_all_posts(
    date_str,
    paper_slugs,
    scored_papers,
    require_llm=False,
    content_dir=None,
    review_paths=None,
    return_details=False,
    result_callback=None,
    page_artifacts=None,
):
    """三层 review：代码检查 → LLM 文本审查 → 多模态图片审查（论文独立页面并发执行）"""
    print("\n🔍 开始三层 review（代码检查 → LLM 审查 → 多模态图片审查）...")
    if require_llm:
        print("  🔒 正式发布模式：LLM review 必须可用，失败将阻断推送")
    total_fixed = 0
    total_blocking_issues = 0
    total_advisory_issues = 0
    file_results = {}

    content_dir = content_dir or CONTENT_DIR
    page_artifacts = page_artifacts or {}
    def artifact_for(page_path):
        key = os.path.realpath(str(page_path))
        artifact = page_artifacts.get(key)
        if artifact is None:
            raw = Path(key).read_bytes()
            artifact = {
                'path': key,
                'sha256': hashlib.sha256(raw).hexdigest(),
                'content': raw.decode('utf-8'),
            }
            page_artifacts[key] = artifact
        return artifact
    selected_paths = None
    if review_paths is not None:
        selected_paths = {os.path.realpath(str(path)) for path in review_paths}
    # 构建 arxivId -> title 映射
    title_map = {}
    paper_map = {}
    for score, p, parsed_analysis in scored_papers:
        paper_id = normalize_publish_arxiv_id(p.get('arxivId', ''))
        title_map[paper_id] = p.get('title', '')
        paper_map[paper_id] = p
    fresh_run_ids = {_paper_fresh_run_id(paper) for paper in paper_map.values()}
    index_run_id = next(iter(fresh_run_ids)) if len(fresh_run_ids) == 1 else None

    # Review 汇总页面（串行，只有1个）
    index_file = os.path.join(content_dir, f"{date_str}.md")
    if os.path.exists(index_file) and (
        selected_paths is None or os.path.realpath(index_file) in selected_paths
    ):
        print("\n  📋 汇总页面:")
        index_key = os.path.realpath(index_file)
        index_artifact = artifact_for(index_key)
        if (
            not isinstance(index_artifact, dict)
            or index_artifact.get('path') != index_key
            or index_artifact.get('sha256') != _sha256_file(index_file)
        ):
            raise PublishDataValidationError('汇总页 page artifact 缺失或已失效')
        content = index_artifact['content']
        # 1. 代码检查。与论文页相同，最终 review 不得修改已生成字节。
        fixed, issues = review_and_fix_post(
            index_file, dry_run=True, source_content=content,
        )
        if fixed:
            print("    ⛔ 页面仍需修复；最终审查只读取页面，请回到生成阶段修复后再审查。")
        remaining_code_issues = issues
        total_blocking_issues += len(remaining_code_issues)
        for issue in issues:
            print(f"    ⚠️  代码层: {issue}")

        # 2. LLM 文本审查
        if fixed and not remaining_code_issues:
            remaining_code_issues = ['最终字节需要确定性修复']
            total_blocking_issues += 1
        if remaining_code_issues:
            result = {
                'passed': False, 'completed': True, 'failureKind': 'content',
                'blockingCount': len(remaining_code_issues),
                'reviewedSha256': index_artifact['sha256'],
                'issues': [{'severity': 'error', 'type': 'deterministic', 'description': str(issue)}
                           for issue in remaining_code_issues],
            }
            file_results[index_key] = result
            if result_callback:
                result_callback(index_key, result)
            if return_details:
                return total_fixed, total_blocking_issues, file_results
            return total_fixed, total_blocking_issues
        with review_unit_cache(date_str, index_file, required=require_llm, run_id=index_run_id):
            llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, "汇总页", required=require_llm)
        if llm_passed is False and count_blocking_review_issues(llm_issues) == 0:
            llm_issues = list(llm_issues or []) + [{
                'severity': 'error',
                'description': '汇总页文本审查明确返回未通过，但没有给出阻断原因；本次审查按失败处理。',
            }]
        if llm_issues:
            for issue in llm_issues:
                sev = issue.get('severity', 'warning')
                desc = issue.get('description', '')
                print(f"    🤖 LLM ({sev}): {desc}")
        if llm_fixed_content != content:
            readonly_issue = {
                'severity': 'error',
                'description': '模型建议修改最终页面；审查阶段不能写回文件，请回到生成阶段修复后重新审查。',
            }
            llm_issues = list(llm_issues or []) + [readonly_issue]
            print(f"    🤖 LLM (error): {readonly_issue['description']}")
        llm_blocking = count_blocking_review_issues(llm_issues)
        total_blocking_issues += llm_blocking
        total_advisory_issues += len(llm_issues) - llm_blocking

        # 汇总页同样可能包含论文图片，必须经过与独立论文页一致的多模态审查。
        with review_unit_cache(date_str, index_file, required=require_llm, run_id=index_run_id):
            _img_passed, img_issues = multimodal_review_images(content, '汇总页面', required=require_llm)
        if _img_passed is False and count_blocking_review_issues(img_issues) == 0:
            img_issues = list(img_issues or []) + [{
                'severity': 'error',
                'description': '汇总页图片审查明确返回未通过，但没有给出阻断原因；本次审查按失败处理。',
            }]
        if img_issues:
            img_blocking = count_blocking_review_issues(img_issues)
            total_blocking_issues += img_blocking
            total_advisory_issues += len(img_issues) - img_blocking
            for issue in img_issues:
                sev = issue.get('severity', 'warning')
                desc = issue.get('description', '')
                print(f"    🖼️ 多模态 ({sev}): {desc}")

        if not remaining_code_issues and count_blocking_review_issues(llm_issues) == 0 and count_blocking_review_issues(img_issues) == 0:
            advisory = len(llm_issues) + len(img_issues)
            if advisory:
                print(f"    ✅ 无阻断问题（保留 {advisory} 个 warning/info）")
            else:
                print(f"    ✅ 通过 review")
        index_reviewed_sha256 = _sha256_file(index_file)
        if index_reviewed_sha256 != index_artifact['sha256']:
            raise PublishDataValidationError('汇总页在只读审查期间发生变化。')
        file_results[os.path.realpath(index_file)] = {
            'passed': (
                not remaining_code_issues
                and count_blocking_review_issues(llm_issues) == 0
                and count_blocking_review_issues(img_issues) == 0
            ),
            'blockingCount': (
                len(remaining_code_issues)
                + count_blocking_review_issues(llm_issues)
                + count_blocking_review_issues(img_issues)
            ),
            'completed': True,
            'failureKind': classify_review_failure(
                list(remaining_code_issues) + list(llm_issues) + list(img_issues)
            ),
            'reviewedSha256': index_reviewed_sha256,
            'imageReviewMode': current_image_review_mode(),
            'issues': list(llm_issues) + list(img_issues),
        }
        if result_callback:
            result_callback(os.path.realpath(index_file), file_results[os.path.realpath(index_file)])

    # Review 每篇论文独立页面（并发）
    paper_args = [
        (arxiv_id, slug, date_str,
         title_map.get(normalize_publish_arxiv_id(arxiv_id), slug), require_llm,
         content_dir, paper_map.get(normalize_publish_arxiv_id(arxiv_id)),
         artifact_for(os.path.join(content_dir, f"{date_str}-{slug}.md")))
        for arxiv_id, slug in paper_slugs.items()
        if selected_paths is None or os.path.realpath(
            os.path.join(content_dir, f"{date_str}-{slug}.md")
        ) in selected_paths
    ]

    if paper_args:
        review_concurrency = min(get_blog_review_concurrency(), len(paper_args))
        print(f"\n  🔀 论文页 review 并发度: {review_concurrency}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=review_concurrency) as executor:
            futures = {
                executor.submit(_review_single_paper, args): args
                for args in paper_args
            }
            for future in concurrent.futures.as_completed(futures):
                args = futures[future]
                try:
                    result = future.result()
                except Exception as exc:
                    (_arxiv_id, slug, _date, title, _required,
                     worker_content_dir, _paper, _page_artifact) = args
                    path = os.path.realpath(os.path.join(
                        worker_content_dir, f'{date_str}-{slug}.md',
                    ))
                    print(f"\n  📄 {title[:50]}...")
                    print(f'    ⚠️ review worker 基础设施异常（{type(exc).__name__}），保留为可重试失败')
                    total_blocking_issues += 1
                    file_results[path] = {
                        'passed': False,
                        'blockingCount': 1,
                        'completed': True,
                        'failureKind': 'transient',
                        'issues': [{'severity': 'error', 'type': 'infrastructure',
                                    'description': f'review worker failed ({type(exc).__name__})'}],
                    }
                    if result_callback:
                        result_callback(path, file_results[path])
                    continue
                if result is None:
                    continue
                (
                    path, title, fixed_count, blocking_count, advisory_count,
                    lines, failure_kind, reviewed_sha256,
                ) = result[:8]
                print(f"\n  📄 {title[:50]}...")
                for line in lines:
                    print(line)
                total_fixed += fixed_count
                total_blocking_issues += blocking_count
                total_advisory_issues += advisory_count
                file_results[path] = {
                    'passed': blocking_count == 0,
                    'blockingCount': blocking_count,
                    'completed': True,
                    'failureKind': failure_kind,
                    'reviewedSha256': reviewed_sha256,
                    'imageReviewMode': current_image_review_mode(),
                    'issues': result[8] if len(result) > 8 else [],
                }
                if result_callback:
                    result_callback(path, file_results[path])
    elif selected_paths is not None:
        print("\n  ℹ️ 本轮没有需要复审的论文页")

    if total_fixed == 0 and total_blocking_issues == 0 and total_advisory_issues == 0:
        print("\n  ✅ 所有文件通过三层 review，无问题")
    else:
        print(f"\n  📊 review 结果: {total_fixed} 个文件已修复, {total_blocking_issues} 个阻断问题, {total_advisory_issues} 个 warning/info")

    if return_details:
        return total_fixed, total_blocking_issues, file_results
    return total_fixed, total_blocking_issues


def _parse_frontmatter_content(path, content):
    """Parse frontmatter from already-read UTF-8 text without touching disk."""
    return _parse_frontmatter_content_impl(path, content)


def _load_frontmatter(path):
    return _load_frontmatter_impl(path)


def validate_markdown_format_gate(path, frontmatter, body):
    """Validate reader-visible Markdown before Hugo gets a chance to hide defects.

    The strict tutorial presentation has a deliberately stronger contract: its
    figures/tables are complete source artifacts and its top score must expose
    all eight auditable dimensions. Other historical pages retain the generic
    syntax checks without being retroactively relabelled as tutorials.
    """
    return _validate_markdown_format_gate_impl(path, frontmatter, body)


def validate_hugo_rendered_html_gate(output_dir, source_artifacts):
    """Check the actual Hugo HTML for each strict tutorial source page.

    Markdown validation alone cannot catch a theme/renderer regression that
    discards images/tables or leaks literal Markdown markers into the page.
    We bind a rendered page by its source title, then check only article-level
    lower bounds so theme icons never create false positives.
    """
    issues = list(_validate_hugo_rendered_html_gate_impl(output_dir, source_artifacts))
    for artifact in source_artifacts:
        frontmatter = artifact.get('frontmatter') if isinstance(artifact, dict) else None
        if not isinstance(frontmatter, dict) \
                or frontmatter.get('paper_digest_api_reader_source_binding_contract') \
                != LLM_API_READER_SOURCE_BINDING_CONTRACT:
            continue
        label = Path(artifact.get('path') or 'unknown.md').name
        expected_count = frontmatter.get('paper_digest_api_reader_source_formula_count')
        if not isinstance(expected_count, int) or isinstance(expected_count, bool) \
                or expected_count < 0:
            issues.append(f'{label} API reader v4 公式数量 marker 非法')
            continue
        source_blocks = _api_reader_display_formula_blocks(artifact.get('body'))
        if len(source_blocks) != expected_count:
            issues.append(
                f'{label} API reader v4 页面公式数量与 frontmatter 不一致: '
                f'Markdown={len(source_blocks)}, marker={expected_count}'
            )
            continue
        candidates = _rendered_page_candidates(
            output_dir, frontmatter.get('title'), artifact.get('path'),
        )
        if len(candidates) != 1:
            continue  # The shared Hugo gate already reports this binding failure.
        rendered_fragment = html.unescape(_rendered_article_fragment(candidates[0][1]))
        for formula_index, block in enumerate(source_blocks, 1):
            # Hugo restores its explicit literal-shortcode escapes before
            # rendering. Compare that exact surface while retaining the
            # original source formula SHA and the unique-occurrence gate.
            rendered_block = re.sub(
                r'\{\{(<|%)/\*(.*?)\*/(>|%)\}\}',
                lambda match: ('{{' + match[1] + match[2] + match[3] + '}}')
                if (match[1], match[3]) in {('<', '>'), ('%', '%')}
                else match[0],
                block, flags=re.DOTALL,
            )
            # Published TeX can contain HTML character references so Markdown
            # does not interpret angle-bracket operators as raw HTML. Hugo
            # emits their decoded text in the article; compare that exact TeX
            # surface after decoding the source block once as well.
            rendered_block = html.unescape(rendered_block)
            if rendered_fragment.count(rendered_block) != 1:
                issues.append(
                    f'{label} API reader v4 第 {formula_index} 个展示公式未在 Hugo HTML '
                    '中原样且唯一保留'
                )
    return issues


def build_final_page_artifact(path, paper=None):
    """Read and parse one immutable final page exactly once.

    The returned artifact binds every derived validation result to the exact
    byte SHA. Callers may reuse it only while that SHA remains authoritative.
    """
    path = Path(path).resolve()
    raw = path.read_bytes()
    try:
        content = raw.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise PublishDataValidationError(f'{path.name} 不是合法 UTF-8') from exc
    frontmatter, body = _parse_frontmatter_content(path, content)
    return {
        'version': FINAL_PAGE_ARTIFACT_VERSION,
        'path': str(path),
        'sha256': hashlib.sha256(raw).hexdigest(),
        'content': content,
        'frontmatter': frontmatter,
        'body': body,
        'markdownFormatIssues': validate_markdown_format_gate(path, frontmatter, body),
        'manualIssue': validate_final_manual_v4_markdown(content, paper),
        'apiReaderIssue': _api_reader_page_binding_issue(content, paper),
        'indexQualityIssue': validate_digest_index_reader_quality(content),
    }


def validate_staged_posts(
    staged_posts_dir, date_str, date_only=False, artifact_cache=None,
    publish_paths=None, authoritative_papers=None,
):
    """Deterministically validate YAML and generated Markdown structure."""
    date_str = validate_publish_date(date_str)
    staged = Path(staged_posts_dir)
    files = (
        sorted(
            Path(path).resolve() for path in publish_paths
            if Path(path).is_file() and Path(path).suffix == '.md'
        )
        if publish_paths is not None else
        sorted(staged.glob(f'{date_str}*.md' if date_only else '*.md'))
    )
    if not files:
        raise PublishDataValidationError('staging 目录没有待发布 Markdown 文件')
    for path in files:
        if path.name != f'{date_str}.md' and not path.name.startswith(f'{date_str}-'):
            raise PublishDataValidationError(f'发布文件名不属于本次日期: {path.name}')
        paper = (authoritative_papers or {}).get(path.name)
        artifact = build_final_page_artifact(path, paper)
        frontmatter = artifact['frontmatter']
        body = artifact['body']
        for field in ('title', 'date', 'draft', 'tags', 'categories', 'description'):
            if field not in frontmatter:
                raise PublishDataValidationError(f'{path.name} 缺少 frontmatter.{field}')
        yaml_date = frontmatter['date']
        if hasattr(yaml_date, 'isoformat'):
            yaml_date = yaml_date.isoformat()
        if yaml_date != date_str:
            raise PublishDataValidationError(f'{path.name} frontmatter.date 与发布日期不一致')
        if frontmatter['draft'] is not False:
            raise PublishDataValidationError(f'{path.name} frontmatter.draft 必须为 false')
        if not isinstance(frontmatter['tags'], list) or not isinstance(frontmatter['categories'], list):
            raise PublishDataValidationError(f'{path.name} tags/categories 必须为 YAML 数组')
        if '\ufffd' in body:
            raise PublishDataValidationError(f'{path.name} 正文包含 UTF-8 替换字符')
        if re.search(r'!?\[[^\]]*\]\(\s*\)', body):
            raise PublishDataValidationError(f'{path.name} 正文包含空 Markdown 链接')
        _validate_researcher_workbench_frontmatter(
            frontmatter, paper, date_str,
        )
        markdown_format_issues = artifact['markdownFormatIssues']
        if markdown_format_issues:
            raise PublishDataValidationError(
                f'{path.name} 的 Markdown 或 Hugo 格式不符合要求：' + '; '.join(markdown_format_issues)
            )
        manual_v4_issue = artifact['manualIssue']
        if manual_v4_issue:
            raise PublishDataValidationError(
                f'{path.name} 的 Manual v4 最终 Markdown 内容未通过检查：{manual_v4_issue}'
            )
        api_reader_issue = artifact['apiReaderIssue']
        if path.name == f'{date_str}.md' and authoritative_papers:
            api_reader_issue = _api_reader_index_display_fields_issue(
                artifact['content'], list(authoritative_papers.values()),
            )
            artifact['apiReaderIssue'] = api_reader_issue
        if api_reader_issue:
            raise PublishDataValidationError(
                f'{path.name} 读者文章的最终 Markdown 内容未通过来源核验：'
                f'{api_reader_issue}'
            )
        index_quality_issue = artifact['indexQualityIssue']
        if index_quality_issue:
            raise PublishDataValidationError(
                f'{path.name} 的汇总页内容不符合读者阅读要求：{index_quality_issue}'
            )
        if artifact_cache is not None:
            artifact_cache[str(path.resolve())] = artifact
    return files


def _mirror_hugo_assets(blog_repo, asset_dir):
    """Copy only regular in-repo assets through no-follow directory handles."""
    if not hasattr(os, 'O_NOFOLLOW') or not hasattr(os, 'O_DIRECTORY'):
        raise PublishDataValidationError('Hugo assets 隔离镜像需要 no-follow 文件系统支持')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

    def copy_directory(source_fd, destination):
        with os.scandir(source_fd) as entries:
            for entry in sorted(entries, key=lambda item: item.name):
                mode = entry.stat(follow_symlinks=False).st_mode
                target = destination / entry.name
                if stat.S_ISLNK(mode):
                    raise PublishDataValidationError(f'Hugo assets 禁止符号链接: {entry.name}')
                if stat.S_ISDIR(mode):
                    child_fd = os.open(entry.name, flags, dir_fd=source_fd)
                    try:
                        target.mkdir()
                        copy_directory(child_fd, target)
                    finally:
                        os.close(child_fd)
                elif stat.S_ISREG(mode):
                    file_fd = os.open(entry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
                    with os.fdopen(file_fd, 'rb') as source:
                        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                            raise PublishDataValidationError(f'Hugo assets 不是普通文件: {entry.name}')
                        with target.open('xb') as output:
                            shutil.copyfileobj(source, output)
                    target.chmod(0o444)
                else:
                    raise PublishDataValidationError(f'Hugo assets 包含非普通文件: {entry.name}')

    root_fd = os.open(Path(blog_repo).resolve(), flags)
    try:
        try:
            mode = os.stat('assets', dir_fd=root_fd, follow_symlinks=False).st_mode
        except FileNotFoundError:
            return
        if not stat.S_ISDIR(mode):
            raise PublishDataValidationError('Hugo assets 必须是仓库内真实目录，禁止符号链接')
        source_fd = os.open('assets', flags, dir_fd=root_fd)
        try:
            copy_directory(source_fd, Path(asset_dir))
        finally:
            os.close(source_fd)
    except OSError as exc:
        raise PublishDataValidationError('Hugo assets 无法安全镜像，已拒绝链接或路径漂移') from exc
    finally:
        os.close(root_fd)


def run_hugo_gate(blog_repo, staged_posts_dir, required=False, source_paths=None):
    """Build staged content with Hugo, then gate source Markdown and rendered HTML."""
    hugo = shutil.which('hugo')
    if not hugo:
        if required:
            raise PublishDataValidationError('正式 --push 要求 Hugo 可用，当前未找到 hugo 命令')
        print('  ℹ️ 未找到 Hugo，本次跳过构建检查。')
        return 'fallback'
    source_files = (
        sorted(
            Path(path).resolve() for path in source_paths
            if Path(path).is_file() and Path(path).suffix == '.md'
        )
        if source_paths is not None else
        sorted(Path(staged_posts_dir).glob('*.md'))
    )
    if not source_files:
        raise PublishDataValidationError('Hugo gate 没有可构建的当批次 Markdown 页面')
    timeout_seconds = _bounded_positive_seconds(
        'PD_HUGO_GATE_TIMEOUT_SECONDS', HUGO_GATE_TIMEOUT_SECONDS, 30, 1800,
    )
    with tempfile.TemporaryDirectory(prefix='paper-digest-hugo-') as workspace:
        workspace = Path(workspace)
        isolated_posts = workspace / 'content' / 'posts'
        output_dir = workspace / 'public'
        cache_dir = workspace / 'cache'
        static_dir = workspace / 'static'
        resource_dir = workspace / 'resources'
        asset_dir = workspace / 'assets'
        isolated_posts.mkdir(parents=True)
        for directory in (cache_dir, static_dir, resource_dir, asset_dir):
            directory.mkdir()
        _mirror_hugo_assets(blog_repo, asset_dir)
        seen_names = set()
        for source in source_files:
            if source.name in seen_names:
                raise PublishDataValidationError(f'Hugo gate 当批次页面文件名重复: {source.name}')
            seen_names.add(source.name)
            shutil.copy2(source, isolated_posts / source.name)
        overlay_config = workspace / 'hugo-isolated-gate.json'
        overlay_config.write_text(json.dumps({
            'staticDir': str(static_dir),
            'resourceDir': str(resource_dir),
            'assetDir': str(asset_dir),
        }), encoding='utf-8')
        config_candidates = [
            Path(blog_repo) / name for name in (
                'hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json',
                'config.yaml', 'config.yml', 'config.toml', 'config.json',
            )
            if (Path(blog_repo) / name).is_file()
        ]
        config_files = [*config_candidates[:1], overlay_config]
        result = _run_bounded_subprocess(
            [
                hugo,
                '--config', ','.join(str(item) for item in config_files),
                '--contentDir', str(workspace / 'content'),
                '--destination', str(output_dir),
                '--cacheDir', str(cache_dir),
                '--cleanDestinationDir',
                '--noBuildLock',
            ],
            cwd=blog_repo,
            env=build_child_process_env(),
            timeout_seconds=timeout_seconds,
            max_output_bytes=HUGO_GATE_OUTPUT_TAIL_BYTES,
            combine_output=True,
            tail_output=True,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or '').strip()
            if result.timed_out:
                raise PublishDataValidationError(
                    f'Hugo 构建超时（上限为 {timeout_seconds} 秒），已终止整个进程组：'
                    f'{detail[-2000:]}'
                )
            raise PublishDataValidationError(f'Hugo 构建失败：{detail[-2000:]}')
        source_artifacts = []
        for path in source_files:
            try:
                source_artifacts.append(build_final_page_artifact(path))
            except PublishDataValidationError:
                raise
            except (OSError, UnicodeError) as exc:
                raise PublishDataValidationError(f'Hugo 源页面无法读取: {path.name}: {exc}') from exc
        rendered_issues = validate_hugo_rendered_html_gate(output_dir, source_artifacts)
        if rendered_issues:
            raise PublishDataValidationError(
                'Hugo 生成的 HTML 格式不符合要求：' + '; '.join(rendered_issues)
            )
    print('  ✅ Hugo staging 构建通过')
    return 'hugo'


def _terminate_process_group(process, grace_seconds=5):
    if os.name != 'nt':
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    else:
        process.terminate()
    try:
        return process.wait(timeout=grace_seconds)
    except subprocess.TimeoutExpired:
        if os.name != 'nt':
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            process.kill()
        return process.wait(timeout=grace_seconds)


def _read_bounded_process_output(handle, maximum, *, tail=False):
    handle.flush()
    size = handle.seek(0, os.SEEK_END)
    truncated = size > maximum
    handle.seek(max(0, size - maximum) if tail else 0)
    return handle.read(maximum), truncated


def _run_bounded_subprocess(
    command, *, cwd, env, timeout_seconds, text=True, check=False,
    max_output_bytes=SUBPROCESS_SEMANTIC_OUTPUT_MAX_BYTES,
    combine_output=False, tail_output=False,
):
    """Run one child with a hard deadline, bounded output and process-group cleanup."""
    with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
        process = subprocess.Popen(
            command,
            cwd=cwd,
            stdin=subprocess.DEVNULL,
            stdout=stdout_file,
            stderr=subprocess.STDOUT if combine_output else stderr_file,
            env=env,
            start_new_session=(os.name != 'nt'),
        )
        timed_out = False
        try:
            try:
                return_code = process.wait(timeout=timeout_seconds)
            except subprocess.TimeoutExpired:
                timed_out = True
                return_code = _terminate_process_group(process)
        except BaseException:
            _terminate_process_group(process)
            raise
        stdout_raw, stdout_truncated = _read_bounded_process_output(
            stdout_file, max_output_bytes, tail=tail_output,
        )
        if combine_output:
            stderr_raw = b''
            stderr_truncated = False
        else:
            stderr_raw, stderr_truncated = _read_bounded_process_output(
                stderr_file, max_output_bytes, tail=tail_output,
            )
        output_truncated = stdout_truncated or stderr_truncated
        if text:
            stdout = stdout_raw.decode('utf-8', errors='replace')
            stderr = stderr_raw.decode('utf-8', errors='replace')
        else:
            stdout, stderr = stdout_raw, stderr_raw
        result = SimpleNamespace(
            args=command,
            returncode=return_code,
            stdout=stdout,
            stderr=stderr,
            timed_out=timed_out,
            output_truncated=output_truncated,
        )
        if timed_out and check:
            raise subprocess.TimeoutExpired(
                command, timeout_seconds, output=stdout, stderr=stderr,
            )
        if output_truncated and check:
            raise PublishDataValidationError(
                f'子进程输出超过 {max_output_bytes} 字节上限: {command[0]}'
            )
        if return_code != 0 and check:
            raise subprocess.CalledProcessError(
                return_code, command, output=stdout, stderr=stderr,
            )
        return result


def _is_pipeline_owned_paper(path, date_str):
    """Only explicit pipeline-owned paper pages are eligible for stale deletion."""
    try:
        frontmatter, _body = _load_frontmatter(path)
    except (OSError, UnicodeError, PublishDataValidationError):
        return False
    yaml_date = frontmatter.get('date')
    if hasattr(yaml_date, 'isoformat'):
        yaml_date = yaml_date.isoformat()
    return (
        frontmatter.get('paper_digest_pipeline_owned') is True
        and frontmatter.get('paper_digest_page_type') == 'paper'
        and yaml_date == date_str
    )


def planned_publish_paths(staged_posts_dir, content_dir, date_str):
    staged = Path(staged_posts_dir)
    target = Path(content_dir)
    generated_names = {path.name for path in staged.glob('*.md')}
    expected_index = f'{date_str}.md'
    if expected_index not in generated_names:
        raise PublishDataValidationError(f'staging 缺少汇总页 {expected_index}')
    changed = []
    for name in sorted(generated_names):
        source = staged / name
        destination = target / name
        if not destination.exists() or source.read_bytes() != destination.read_bytes():
            changed.append(destination)
    for old_page in sorted(target.glob(f'{date_str}-*.md')) if target.exists() else []:
        if old_page.name not in generated_names and _is_pipeline_owned_paper(old_page, date_str):
            changed.append(old_page)
    return changed


def prepare_api_reader_staged_assets(papers, stage_root):
    stage_root = Path(stage_root).resolve()
    staged = []
    seen = set()
    for paper in papers:
        payload = _api_reader_payload(paper)
        if not payload:
            continue
        for asset in payload.get('assets') or []:
            relative = Path(asset['destination'])
            if relative.as_posix() in seen:
                raise PublishDataValidationError(f'API reader figure 目标路径重复: {relative}')
            seen.add(relative.as_posix())
            source = Path(asset['sourcePath']).resolve()
            target = (stage_root / relative).resolve()
            try:
                target.relative_to(stage_root)
            except ValueError as exc:
                raise PublishDataValidationError(f'API reader figure staging 路径逃逸: {relative}') from exc
            if _sha256_file(source) != asset['sha256']:
                raise PublishDataValidationError(f'API reader figure 缓存写入前发生变化: {source.name}')
            _atomic_write_bytes(target, source.read_bytes(), mode=0o600)
            staged.append(target)
    return staged


def prepare_researcher_workbench_staged_assets(papers, date_str, stage_root):
    """Materialize deterministic citation/context sidecars inside staging."""
    stage_root = Path(stage_root).resolve()
    staged = []
    seen = set()
    for paper in papers:
        api_reader_payload = _api_reader_payload(paper)
        v6_payload = _manual_v6_reader_payload(paper)
        reader_plan = (
            v6_payload.get('plan') if isinstance(v6_payload, dict)
            else api_reader_payload.get('plan') if isinstance(api_reader_payload, dict)
            else _manual_reader_editorial_plan(paper)
        )
        reader_article = (
            v6_payload.get('article') if isinstance(v6_payload, dict)
            else api_reader_payload.get('renderedArticle')
            if isinstance(api_reader_payload, dict)
            else _manual_reader_article(paper, reader_plan, date_str)
        )
        if not isinstance(reader_plan, dict) or not isinstance(reader_article, str) \
                or not reader_article.strip():
            continue
        if not _researcher_workbench_eligible(v6_payload, api_reader_payload):
            continue
        bundle = build_researcher_workbench_bundle(
            paper, date_str, reader_plan=reader_plan,
            api_reader_payload=api_reader_payload, require_reader=True,
        )
        for relative, raw in sorted(
                bundle['sidecars'].items(), key=lambda item: item[0].as_posix()):
            relative_text = relative.as_posix()
            if relative_text in seen:
                raise PublishDataValidationError(
                    f'researcher sidecar 目标路径重复: {relative_text}'
                )
            seen.add(relative_text)
            target = (stage_root / relative).resolve()
            try:
                target.relative_to(stage_root)
            except ValueError as exc:
                raise PublishDataValidationError(
                    f'researcher sidecar staging 路径逃逸: {relative_text}'
                ) from exc
            _atomic_write_bytes(target, raw, mode=0o600)
            if _sha256_file(target) != bundle['sidecarRecords'][relative.name]['sha256']:
                raise PublishDataValidationError(
                    f'researcher sidecar staging SHA 不一致: {relative_text}'
                )
            staged.append(target)
    return staged


def _git_tracked_reader_asset_paths():
    result = _run_git(
        ['ls-files', '-z', '--', 'static/images/papers', 'static/data/papers'],
    )
    if result.returncode != 0:
        return set()
    return {
        item.decode('utf-8', errors='strict')
        for item in result.stdout.split(b'\0') if item
    }


def prior_api_reader_manifest_assets(date_str):
    """Return reader assets explicitly owned by prior same-date manifests."""
    validated_date = validate_publish_date(date_str)
    current_dir = Path(CURRENT_DIR)
    candidates = [current_dir / f'blog-generation-manifest-{validated_date}.json']
    candidates.extend(sorted(current_dir.glob(
        f'blog-generation-manifest-{validated_date}-single-*.json'
    )))
    repo = Path(BLOG_REPO).expanduser().resolve()
    tracked_reader_assets = _git_tracked_reader_asset_paths()
    owned = set()
    for manifest_path in candidates:
        if not manifest_path.is_file():
            continue
        manifest = _load_json_object(manifest_path, '既有同日 generation manifest')
        files = manifest.get('files')
        if not isinstance(files, list):
            if manifest.get('schemaVersion') == 3:
                raise PublishDataValidationError(
                    f'既有同日 generation manifest.files 非数组: {manifest_path.name}'
                )
            continue
        reader_records = [
            record for record in files
            if isinstance(record, dict)
            and isinstance(record.get('path'), str)
            and record['path'].startswith((
                'static/images/papers/', 'static/data/papers/',
            ))
        ]
        if not reader_records:
            continue
        if manifest.get('schemaVersion') != 3 or manifest.get('date') != validated_date:
            raise PublishDataValidationError(
                f'拥有 reader asset 的既有 manifest 版本或日期非法: {manifest_path.name}'
            )
        for record in reader_records:
            relative = record['path']
            target = (repo / relative).resolve()
            _manifest_record(target, repo)
            if not is_api_reader_asset_path(target):
                raise PublishDataValidationError(
                    f'既有 generation manifest 含非法 reader/sidecar asset: {relative}'
                )
            if not target.exists() and relative not in tracked_reader_assets:
                continue
            owned.add(target)
    return owned


def publish_manifest_paths(
    staged_posts_dir, content_dir, date_str, staged_assets=None, single_page=False,
):
    """Return every generated path plus explicitly owned stale deletion candidate."""
    staged = Path(staged_posts_dir)
    target = Path(content_dir)
    generated_names = {path.name for path in staged.glob('*.md')}
    if single_page:
        if len(generated_names) != 1 or f'{date_str}.md' in generated_names:
            raise PublishDataValidationError('单篇 generation staging 必须只含一个论文页且不得含汇总页')
        only_name = next(iter(generated_names))
        if not only_name.startswith(f'{date_str}-'):
            raise PublishDataValidationError('单篇 generation 页面不属于目标日期')
        manifest = {(target / only_name).resolve()}
        repo = Path(BLOG_REPO).expanduser().resolve()
        stage_root = staged.resolve().parent
        for source in staged_assets or []:
            source = Path(source).resolve()
            try:
                relative = source.relative_to(stage_root)
            except ValueError as exc:
                raise PublishDataValidationError(f'单篇 asset staging 路径逃逸: {source}') from exc
            destination = (repo / relative).resolve()
            if not is_api_reader_asset_path(destination):
                raise PublishDataValidationError('单篇 generation 只允许绑定正文论文图/sidecar 资产')
            manifest.add(destination)
        return sorted(manifest)
    manifest = {target / name for name in generated_names}
    repo = Path(BLOG_REPO).expanduser().resolve()
    stage_root = staged.resolve().parent
    for source in staged_assets or []:
        source = Path(source).resolve()
        try:
            relative = source.relative_to(stage_root)
        except ValueError as exc:
            raise PublishDataValidationError(f'视觉摘要 staging 路径逃逸: {source}') from exc
        destination = (repo / relative).resolve()
        _manifest_record(destination, repo)
        manifest.add(destination)
    generated_assets = {
        (repo / Path(source).resolve().relative_to(stage_root)).resolve()
        for source in (staged_assets or [])
    }
    for old_asset in prior_api_reader_manifest_assets(date_str):
        if old_asset not in generated_assets:
            manifest.add(old_asset)
    existing_asset_root = repo / 'static' / 'images' / 'visual-summaries' / date_str
    if existing_asset_root.is_dir():
        for old_asset in existing_asset_root.rglob('*.png'):
            old_asset = old_asset.resolve()
            if old_asset not in generated_assets and is_visual_summary_asset_path(old_asset, date_str):
                manifest.add(old_asset)
    for old_page in sorted(target.glob(f'{date_str}-*.md')) if target.exists() else []:
        if old_page.name not in generated_names and _is_pipeline_owned_paper(old_page, date_str):
            manifest.add(old_page)
    return sorted(manifest)


def install_staged_posts(staged_posts_dir, content_dir, date_str):
    """Install the reviewed manifest atomically, rolling back on local failure."""
    staged = Path(staged_posts_dir)
    target = Path(content_dir)
    changes = planned_publish_paths(staged, target, date_str)
    snapshots = {path: path.read_bytes() if path.exists() else None for path in changes}
    generated = {path.name: path for path in staged.glob('*.md')}
    try:
        target.mkdir(parents=True, exist_ok=True)
        for name, source in sorted(generated.items()):
            destination = target / name
            if destination in snapshots:
                atomic_write_text(destination, source.read_text(encoding='utf-8'))
        for path, previous in snapshots.items():
            if path.name not in generated and previous is not None:
                path.unlink()
    except Exception:
        for path, previous in snapshots.items():
            if previous is None:
                path.unlink(missing_ok=True)
            else:
                atomic_write_text(path, previous.decode('utf-8'))
        raise
    return changes


def _git_relative_manifest(paths):
    repo = Path(BLOG_REPO).expanduser().resolve()
    relative = []
    for path in paths:
        _resolved, item = _manifest_record(path, repo)
        relative.append(item)
    return sorted(set(relative))


def _git_env():
    return build_child_process_env(
        extra={
            'GIT_TERMINAL_PROMPT': '0',
            'GCM_INTERACTIVE': 'never',
        },
        allowed_keys=VCS_CHILD_ENV_KEYS,
    )


def _run_git(args, *, text=False, check=False, timeout_kind='local'):
    timeout_config = {
        'local': (
            'PD_GIT_LOCAL_TIMEOUT_SECONDS', GIT_LOCAL_TIMEOUT_SECONDS, 5, 300,
        ),
        'commit': (
            'PD_GIT_COMMIT_TIMEOUT_SECONDS', GIT_COMMIT_TIMEOUT_SECONDS, 10, 900,
        ),
        'network': (
            'PD_GIT_NETWORK_TIMEOUT_SECONDS', GIT_NETWORK_TIMEOUT_SECONDS, 10, 900,
        ),
    }
    if timeout_kind not in timeout_config:
        raise ValueError(f'未知 Git timeout_kind: {timeout_kind}')
    env_name, default, minimum, maximum = timeout_config[timeout_kind]
    timeout_seconds = _bounded_positive_seconds(
        env_name, default, minimum, maximum,
    )
    result = _run_bounded_subprocess(
        ['git', *args],
        cwd=BLOG_REPO,
        env=_git_env(),
        timeout_seconds=timeout_seconds,
        text=text,
        check=check,
    )
    if result.output_truncated:
        raise PublishDataValidationError('Git 输出超过安全上限，拒绝使用截断结果')
    if result.timed_out and timeout_kind != 'network':
        raise subprocess.TimeoutExpired(['git', *args], timeout_seconds)
    return result


def validate_git_publish_branch():
    """Formal publication is only allowed from the blog repository's main branch."""
    branch = _run_git(
        ['symbolic-ref', '--quiet', '--short', 'HEAD'], text=True,
    )
    current = branch.stdout.strip() if branch.returncode == 0 else '<detached HEAD>'
    if current != 'main':
        raise PublishDataValidationError(
            f'正式发布要求博客仓库当前分支为 main，当前为 {current}'
        )
    head = _run_git(
        ['rev-parse', '--verify', 'HEAD'], text=True, check=True,
    ).stdout.strip()
    if not re.fullmatch(r'[0-9a-fA-F]{40,64}', head):
        raise PublishDataValidationError(f'无法验证博客仓库 HEAD: {head!r}')
    return head.lower()


def validate_manifest_clean_against_head(paths, allow_exact_pipeline_untracked=None):
    """Reject edits except exact bytes from the prior pipeline manifest.

    A completed generation can legitimately leave tracked files modified but
    not yet committed while a later content repair requires regeneration.  The
    prior manifest is a byte-level ownership receipt for that state, so an
    unstaged `` M`` entry is safe only when its current SHA and ownership marker
    still match that receipt.  Staged entries remain forbidden because staging
    is external state that generation must never adopt implicitly.
    """
    manifest = _git_relative_manifest(paths)
    if not manifest:
        return
    result = _run_git(
        [
            'status', '--porcelain=v1', '-z', '--untracked-files=all',
            '--', *manifest,
        ],
        check=True,
    )
    entries = []
    if result.stdout:
        entries = [item.decode('utf-8', errors='replace') for item in result.stdout.split(b'\0') if item]
        allowed = allow_exact_pipeline_untracked or {}
        unsafe = []
        repo = Path(BLOG_REPO).expanduser().resolve()
        for entry in entries:
            status = entry[:3]
            if status not in {'?? ', ' M '}:
                unsafe.append(entry)
                continue
            relative = entry[3:]
            target = repo / relative
            allowance = allowed.get(relative)
            expected_sha = (
                allowance.get('sha256') if isinstance(allowance, dict) else allowance
            )
            controlled_binary = bool(
                isinstance(allowance, dict) and allowance.get('controlledBinary')
            )
            controlled_tag_files = bool(
                isinstance(allowance, dict) and allowance.get('controlledTaxonomy')
            )
            if (not expected_sha or target.is_symlink()
                    or not target.is_file() or _sha256_file(target) != expected_sha):
                unsafe.append(entry)
                continue
            if controlled_tag_files:
                try:
                    if not _is_tag_catalog_file_path(relative):
                        raise PublishDataValidationError('文件路径不属于允许发布的标签词表文件。')
                    payload = json.loads(target.read_text(encoding='utf-8'))
                    if target.name == 'taxonomy-presentation-policy.json':
                        _validate_tag_display_policy(payload)
                        _select_tag_display_version(repo,
                            _validate_tag_catalog_snapshot(build_tag_catalog_snapshot()),
                            _validate_tag_version_catalog(_read_tag_catalog_file(repo, 'data/taxonomy-catalog.json')))
                    elif target.name == 'taxonomy-catalog.json':
                        _validate_tag_version_catalog(payload)
                    else:
                        _validate_tag_catalog_snapshot(payload)
                        if target.parent.name == 'taxonomy-snapshots' and target.stem != payload['registrySha256']:
                            raise PublishDataValidationError('标签词表归档文件名中的 SHA 与快照记录不一致。')
                except (OSError, ValueError, UnicodeError, PublishDataValidationError):
                    unsafe.append(entry)
                continue
            if controlled_binary:
                try:
                    is_valid_binary = (
                        is_api_reader_asset_path(target)
                        and (
                            is_researcher_sidecar_path(target)
                            or target.read_bytes().startswith(PNG_SIGNATURE)
                        )
                    )
                except OSError:
                    is_valid_binary = False
                if not is_valid_binary:
                    unsafe.append(entry)
                continue
            try:
                text = target.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                unsafe.append(entry)
                continue
            if 'paper_digest_pipeline_owned: true' not in text:
                unsafe.append(entry)
        entries = unsafe
    if entries:
        raise PublishDataValidationError(
            '发布清单路径已有相对 HEAD 的人工 staged/unstaged/untracked 修改，拒绝覆盖或删除: '
            + ', '.join(entries)
        )


def capture_git_publish_state(paths):
    """Capture the pre-install Git/index/worktree state for add/commit rollback."""
    manifest = _git_relative_manifest(paths)
    head = validate_git_publish_branch()
    index_tree = _run_git(
        ['write-tree'], text=True, check=True,
    ).stdout.strip()
    snapshots = {}
    repo = Path(BLOG_REPO).expanduser().resolve()
    for item in manifest:
        path = repo / item
        snapshots[path] = (
            {'content': path.read_bytes(), 'mode': path.stat().st_mode & 0o777}
            if path.exists() else None
        )
    return {
        'head': head,
        'index_tree': index_tree,
        'snapshots': snapshots,
    }


def restore_git_publish_state(state):
    """Restore HEAD (if needed), the complete index, and manifest worktree files."""
    if not state:
        return
    current = _run_git(
        ['rev-parse', '--verify', 'HEAD'], text=True, check=True,
    ).stdout.strip().lower()
    original = state['head'].lower()
    if current != original:
        _run_git(
            ['update-ref', 'refs/heads/main', original, current], check=True,
        )
    _run_git(
        ['read-tree', state['index_tree']], check=True,
    )
    for path, snapshot in state['snapshots'].items():
        if snapshot is None:
            path.unlink(missing_ok=True)
        else:
            _atomic_write_bytes(path, snapshot['content'], mode=snapshot['mode'])


def validate_git_index(paths):
    allowed = set(_git_relative_manifest(paths))
    result = _run_git(
        ['diff', '--cached', '--name-only', '-z'], check=True,
    )
    staged = {item.decode('utf-8') for item in result.stdout.split(b'\0') if item}
    unrelated = sorted(staged - allowed)
    if unrelated:
        raise PublishDataValidationError(
            f'博客仓库已有无关 staged 文件，拒绝提交: {", ".join(unrelated)}'
        )


def validate_single_publication_worktree(paths):
    """Require one paper page plus only its bound figures/sidecars to be dirty."""
    allowed = set(_git_relative_manifest(paths))
    pages = {item for item in allowed if item.startswith('content/posts/') and item.endswith('.md')}
    assets = {
        item for item in allowed
        if item.startswith(('static/images/papers/', 'static/data/papers/'))
    }
    if len(pages) != 1 or len(pages) + len(assets) != len(allowed):
        raise PublishDataValidationError('单篇灰度发布必须绑定一个论文页及其受控正文图/sidecar')
    result = _run_git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'], check=True,
    )
    unrelated = []
    for raw in (item for item in result.stdout.split(b'\0') if item):
        entry = raw.decode('utf-8', errors='replace')
        # Rename/copy records carry a second NUL-delimited path and are never a
        # valid shape for replacing one already reviewed page.
        if len(entry) < 4 or entry[2] != ' ':
            unrelated.append(entry)
            continue
        relative = entry[3:]
        if entry[:2] in {'R ', ' R', 'C ', ' C'} or relative not in allowed:
            unrelated.append(entry)
    if unrelated:
        raise PublishDataValidationError(
            '单篇灰度发布检测到清单外 Git 修改，拒绝夹带提交: '
            + ', '.join(unrelated)
        )


def validate_git_index_against_review_receipt(receipt, paths):
    """Verify staged blobs/deletions exactly match the signed review receipt."""
    manifest = set(_git_relative_manifest(paths))
    records = receipt.get('files') if isinstance(receipt, dict) else None
    if not isinstance(records, list):
        raise PublishDataValidationError('审查凭证缺少可校验的文件记录')
    by_path = {
        record.get('path'): record
        for record in records
        if isinstance(record, dict) and isinstance(record.get('path'), str)
    }
    if set(by_path) != manifest or len(by_path) != len(records):
        raise PublishDataValidationError('审查凭证与待提交路径集合不一致')

    for relative in sorted(manifest):
        record = by_path[relative]
        staged = _run_git(
            ['show', f':{relative}'],
        )
        if record.get('deleted') is True:
            if staged.returncode == 0:
                raise PublishDataValidationError(
                    f'审查凭证要求删除，但 index 仍包含文件: {relative}'
                )
            continue
        expected = str(record.get('sha256') or '')
        if not re.fullmatch(r'[0-9a-f]{64}', expected):
            raise PublishDataValidationError(f'审查凭证文件哈希非法: {relative}')
        if staged.returncode != 0:
            raise PublishDataValidationError(f'index 缺少已审查文件: {relative}')
        actual = hashlib.sha256(staged.stdout).hexdigest()
        if actual != expected:
            raise PublishDataValidationError(
                f'index 中的文件字节与 review 凭证不一致: {relative}'
            )


def _expected_commit_delta_paths(receipt, base_head):
    """Derive the exact reviewed delta against the immutable review baseline."""
    expected = set()
    for record in receipt.get('files') or []:
        relative = record['path']
        baseline = _run_git(
            ['show', f'{base_head}:{relative}'],
        )
        if record.get('deleted') is True:
            if baseline.returncode == 0:
                expected.add(relative)
            continue
        reviewed_sha = str(record.get('sha256') or '')
        baseline_sha = hashlib.sha256(baseline.stdout).hexdigest() if baseline.returncode == 0 else None
        if baseline_sha != reviewed_sha:
            expected.add(relative)
    return expected


def validate_git_commit_against_review_receipt(receipt, paths, commit='HEAD'):
    """Verify parent, exact delta and immutable blobs, closing all hook/race windows."""
    manifest = set(_git_relative_manifest(paths))
    records = receipt.get('files') if isinstance(receipt, dict) else None
    if not isinstance(records, list):
        raise PublishDataValidationError('审查凭证缺少可校验的文件记录')
    by_path = {
        record.get('path'): record
        for record in records
        if isinstance(record, dict) and isinstance(record.get('path'), str)
    }
    if set(by_path) != manifest or len(by_path) != len(records):
        raise PublishDataValidationError('审查凭证与待提交路径集合不一致')
    base_head = str(receipt.get('baseHead') or '').lower()
    parents = _run_git(
        ['rev-list', '--parents', '-n', '1', commit], text=True, check=True,
    ).stdout.strip().lower().split()
    if len(parents) != 2 or parents[1] != base_head:
        raise PublishDataValidationError('发布提交必须是 review 基线的唯一单父提交')
    actual_delta = set(filter(None, _run_git(
        ['diff-tree', '--no-commit-id', '--name-only', '-r', commit],
        text=True, check=True,
    ).stdout.splitlines()))
    expected_delta = _expected_commit_delta_paths(receipt, base_head)
    if actual_delta != expected_delta:
        unexpected = sorted(actual_delta - expected_delta)
        missing = sorted(expected_delta - actual_delta)
        raise PublishDataValidationError(
            f'发布提交完整变更集与审查凭证不一致；额外={unexpected}，缺失={missing}'
        )
    for relative in sorted(manifest):
        record = by_path[relative]
        committed = _run_git(
            ['show', f'{commit}:{relative}'],
        )
        if record.get('deleted') is True:
            if committed.returncode == 0:
                raise PublishDataValidationError(
                    f'审查凭证要求删除，但提交仍包含文件: {relative}'
                )
            continue
        expected = str(record.get('sha256') or '')
        if committed.returncode != 0 or hashlib.sha256(committed.stdout).hexdigest() != expected:
            raise PublishDataValidationError(
                f'提交中的文件字节与 review 凭证不一致: {relative}'
            )


def _remote_main_oid():
    result = _run_git(
        ['ls-remote', '--exit-code', GITHUB_REMOTE, 'refs/heads/main'],
        text=True, timeout_kind='network',
    )
    if result.returncode != 0:
        if result.timed_out:
            return None, '查询远端 main OID 超时，子进程组已终止'
        return None, (result.stderr or result.stdout or '').strip()
    first_line = (result.stdout or '').splitlines()[0] if result.stdout else ''
    oid = first_line.split(None, 1)[0].lower() if first_line else ''
    if not re.fullmatch(r'[0-9a-f]{40,64}', oid):
        return None, f'远端返回不可验证的 OID: {oid!r}'
    return oid, ''


def _remote_identity_sha256():
    """Bind a verified publication to the configured remote's exact push URL.

    The URL itself is not persisted because it may contain credentials.  Hashing
    the remote name and exact Git-resolved push URL still makes changing
    ``origin`` to an unrelated repository invalidate old publication evidence.
    """
    result = _run_git(
        ['remote', 'get-url', '--push', GITHUB_REMOTE], text=True,
    )
    if result.returncode != 0:
        return None, f'无法解析当前 Git remote {GITHUB_REMOTE!r} 的 push URL'
    push_url = (result.stdout or '').strip()
    if not push_url or '\n' in push_url or '\x00' in push_url:
        return None, f'当前 Git remote {GITHUB_REMOTE!r} 的 push URL 非法'
    return _stable_json_sha256({
        'remote': GITHUB_REMOTE,
        'pushUrl': push_url,
    }), ''


def _report_push_retry(local_head, detail):
    print(f'  ❌ Push/远端验证失败，本地提交 {local_head} 已保留，远端发布尚未确认')
    if detail:
        print(f'  原因: {detail}')
    print(f'  可重试: git -C {BLOG_REPO} push {GITHUB_REMOTE} HEAD:main')
    print(f'  可验证: git -C {BLOG_REPO} ls-remote {GITHUB_REMOTE} refs/heads/main')
    print(f'  预期远端 OID: {local_head}')


def _load_push_receipt(date_str):
    path = review_receipt_path(date_str)
    try:
        receipt = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'无法读取推送审查凭证: {path}') from exc
    base_head = str(receipt.get('baseHead') or '').lower()
    if receipt.get('schemaVersion') != 3 or not re.fullmatch(r'[0-9a-f]{40,64}', base_head):
        raise PublishDataValidationError('审查凭证缺少受保护的博客基线提交；请重新 review')
    return receipt, path, base_head


def _validate_push_generation_input_integrity(date_str):
    """Replay schema-v3 generation input proof before a push mutates Git.

    ``load_verified_review_receipt`` performs the complete receipt check, but
    ``git_push`` is also called directly by recovery and maintenance entry
    points.  Keep this narrow replay here so those callers cannot bypass the
    source-input contract by substituting or stubbing receipt loading.  Older
    manifests intentionally keep their legacy behavior; their receipt checks
    remain unchanged.
    """
    manifest_path = generation_manifest_path(date_str)
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(
            f'无法读取推送前 generation manifest: {manifest_path}'
        ) from exc
    if not isinstance(manifest, dict):
        raise PublishDataValidationError('推送前 generation manifest 必须是对象')
    if manifest.get('schemaVersion') == 3:
        _validate_generation_input_integrity(manifest, date_str)


def git_push(date_str, publish_paths, rollback_state=None):
    """Commit, push HEAD explicitly to main, and verify the remote object ID."""
    manifest = _git_relative_manifest(publish_paths)
    state = rollback_state
    try:
        verified_paths, _verified_receipt_path = load_verified_review_receipt(date_str)
        # This must remain before validate_git_publish_branch, index capture,
        # add, commit, receipt adoption, or any remote operation.  Receipt
        # validation is intentionally repeated below as part of its own
        # immutable-evidence contract.
        _validate_push_generation_input_integrity(date_str)
        if _git_relative_manifest(verified_paths) != manifest:
            raise PublishDataValidationError('git push 路径与已验证审查凭证不一致')
        receipt, receipt_path, base_head = _load_push_receipt(date_str)
        current_head = validate_git_publish_branch()
        if _ACTIVE_PUBLICATION_INCLUDE_ID is not None:
            validate_single_publication_worktree(publish_paths)
        validate_git_index(publish_paths)
        publication_commit = str(receipt.get('publicationCommit') or '').lower()
        verified_remote_oid = str(receipt.get('remoteVerifiedOid') or '').lower()
        if verified_remote_oid:
            if verified_remote_oid != publication_commit:
                raise PublishDataValidationError(
                    '已发布凭证的 remoteVerifiedOid 与 publicationCommit 不一致'
                )
            stored_remote_identity = str(
                receipt.get('remoteIdentitySha256') or ''
            ).lower()
            if (
                current_head != publication_commit
                or receipt.get('remoteName') != GITHUB_REMOTE
                or not re.fullmatch(r'[0-9a-f]{64}', stored_remote_identity)
            ):
                raise PublishDataValidationError(
                    '已发布凭证与当前 HEAD 或 Git remote 身份不一致，拒绝向其他远端重放'
                )
            current_remote_identity, identity_error = _remote_identity_sha256()
            current_remote_oid, _remote_error = _remote_main_oid()
            if (
                current_remote_identity != stored_remote_identity
                or current_remote_oid != publication_commit
            ):
                detail = identity_error or (
                    '无法实时查询当前远端 main OID'
                    if current_remote_oid is None
                    else f'当前远端 main={current_remote_oid}'
                )
                raise PublishDataValidationError(
                    '已发布凭证实时远端复核失败，拒绝覆盖或重放：' + detail
                )
            validate_git_commit_against_review_receipt(
                receipt, publish_paths, publication_commit,
            )
            validate_manifest_clean_against_head(publish_paths)
            print(
                f'  ✅ 已发布提交 {publication_commit} 的 remote 身份和远端 main OID '
                '实时复核通过，无需再次 push'
            )
            return True
        retrying_existing_commit = publication_commit and current_head == publication_commit
        if retrying_existing_commit:
            parent = _run_git(
                ['rev-parse', 'HEAD^'], text=True, check=True,
            ).stdout.strip().lower()
            if parent != base_head:
                raise PublishDataValidationError('待重试发布提交的父提交与 review 基线不一致，拒绝推送')
            validate_git_commit_against_review_receipt(receipt, publish_paths, current_head)
        # 恢复 commit 成功、receipt 原子写入前崩溃的窗口。只有单父、
        # exact delta 和所有 blob 都严格匹配旧 receipt 时才收养该提交。
        if not retrying_existing_commit and not publication_commit and current_head != base_head:
            validate_git_commit_against_review_receipt(receipt, publish_paths, current_head)
            receipt['publicationCommit'] = current_head
            atomic_write_json(receipt_path, receipt, ensure_ascii=False, indent=2)
            publication_commit = current_head
            retrying_existing_commit = True
        if not retrying_existing_commit and current_head != base_head:
            raise PublishDataValidationError('博客 HEAD 已偏离 review 时基线，拒绝推送未审查的本地提交；请重新生成并 review')
        if state is None:
            state = capture_git_publish_state(publish_paths)
        if manifest and not retrying_existing_commit:
            _run_git(
                ['add', '--', *manifest], check=True,
            )
            validate_git_index(publish_paths)
            validate_git_index_against_review_receipt(receipt, publish_paths)
        staged = _run_git(
            ['diff', '--cached', '--quiet', '--', *manifest],
        ) if manifest else None
        if retrying_existing_commit:
            local_head = current_head
        elif staged is not None and staged.returncode == 1:
            # Keep this immediately adjacent to commit so a worktree/index race
            # cannot turn an already-reviewed path set into unreviewed bytes.
            validate_git_index(publish_paths)
            validate_git_index_against_review_receipt(receipt, publish_paths)
            review_description = (
                '提交已通过逐论文独立人工语义、逐图像素事实与 Hugo gate 审查；'
                if receipt.get('reviewMode') == MANUAL_REVIEW_MODE
                else '提交已通过严格 LLM、多模态图片与 Hugo gate 审查；'
            )
            _run_git(
                [
                    'commit',
                    '-m', f'content: 发布 {date_str} 论文速递并同步评分与审查结果',
                    '-m', review_description
                          + '推送前已逐文件校验审查凭证 SHA-256，本步不重新生成或 review。',
                ],
                check=True, timeout_kind='commit',
            )
            local_head = validate_git_publish_branch()
            validate_git_commit_against_review_receipt(receipt, publish_paths, local_head)
            receipt['publicationCommit'] = local_head
            atomic_write_json(receipt_path, receipt, ensure_ascii=False, indent=2)
        elif staged is not None and staged.returncode > 1:
            raise subprocess.CalledProcessError(staged.returncode, staged.args)
        else:
            raise PublishDataValidationError('审查文件相对基线没有可提交差异，拒绝推送任意已有本地提交')
    except (
        subprocess.CalledProcessError, subprocess.TimeoutExpired,
        PublishDataValidationError, OSError, UnicodeError,
    ) as exc:
        try:
            restore_git_publish_state(state)
            print(f"  ❌ Git add/commit 失败，已恢复发布前 index 与工作树: {exc}")
        except Exception as restore_exc:
            print(f"  ❌ Git add/commit 失败，且自动恢复失败: {exc}; 恢复错误: {restore_exc}")
        return False

    remote_identity_before, identity_error = _remote_identity_sha256()
    if remote_identity_before is None:
        _report_push_retry(local_head, identity_error)
        return False
    result = _run_git(
        ['push', GITHUB_REMOTE, 'HEAD:main'],
        text=True, timeout_kind='network',
    )
    remote_oid, verify_error = _remote_main_oid()
    remote_identity_after, identity_error = _remote_identity_sha256()
    if (
        remote_oid == local_head
        and remote_identity_after is not None
        and remote_identity_after == remote_identity_before
    ):
        if result.returncode != 0:
            print('  ℹ️ git push 返回非零，但远端 main 已与本地 HEAD 一致，以 OID 验证结果为准')
        print(f"  ✅ 已推送并验证远端 main={remote_oid}，自动部署中...")
        receipt['remoteVerifiedOid'] = remote_oid
        receipt['remoteVerifiedAt'] = datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat()
        receipt['remoteName'] = GITHUB_REMOTE
        receipt['remoteIdentitySha256'] = remote_identity_after
        atomic_write_json(receipt_path, receipt, ensure_ascii=False, indent=2)
        blog_url = os.environ.get('PAPER_DIGEST_BLOG_URL', 'https://nanless.github.io/audio-paper-digest-blog/posts')
        if blog_url:
            print(f"  🌐 {blog_url}/{date_str}/")
        return True

    detail = verify_error or identity_error
    if remote_identity_after is not None and remote_identity_after != remote_identity_before:
        detail = 'Git remote 在 push 与远端 OID 校验之间发生变化'
    push_detail = (
        'git push 超时，已终止完整进程组'
        if result.timed_out else (result.stderr or result.stdout or '').strip()
    )
    if push_detail:
        detail = f'{push_detail}; {detail}' if detail else push_detail
    elif remote_oid:
        detail = f'远端 main={remote_oid}，与本地 HEAD 不一致'
    _report_push_retry(local_head, detail)
    return False


def review_receipt_path(date_str):
    return CURRENT_DIR / f'blog-review-receipt-{_publication_state_stem(date_str)}.json'


def review_failure_path(date_str):
    return CURRENT_DIR / f'blog-review-failure-{_publication_state_stem(date_str)}.json'


def review_pass_cache_path(date_str):
    return CURRENT_DIR / f'blog-review-passes-{_publication_state_stem(date_str)}.json'


def review_page_checkpoint_dir(date_str):
    return CURRENT_DIR / 'blog-review-checkpoints' / _publication_state_stem(date_str)


def _review_page_checkpoint_path(date_str, relative_path):
    relative = str(relative_path)
    digest = hashlib.sha256(relative.encode('utf-8')).hexdigest()
    return review_page_checkpoint_dir(date_str) / f'{digest}.json'


def generation_manifest_path(date_str):
    return CURRENT_DIR / f'blog-generation-manifest-{_publication_state_stem(date_str)}.json'


def generation_journal_path(date_str):
    return CURRENT_DIR / f'blog-generation-journal-{_publication_state_stem(date_str)}.json'


def generation_stage_path(date_str):
    return CURRENT_DIR / f'blog-generation-stage-{_publication_state_stem(date_str)}' / 'posts'


def manual_review_page_dir(date_str):
    return CURRENT_DIR / 'manual-blog-review-pages' / _publication_state_stem(date_str)


def manual_review_statement_path(date_str):
    return CURRENT_DIR / f'manual-review-attestation-{_publication_state_stem(date_str)}.json'


def _sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _file_fingerprint(path):
    path = Path(path)
    return {
        'deleted': not path.is_file(),
        'sha256': _sha256_file(path) if path.is_file() else None,
    }


def _javascript_json_utf8(value):
    """Encode canonical JSON like well-formed JavaScript JSON.stringify()."""
    serialized = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    )
    normalized = []
    index = 0
    while index < len(serialized):
        code_unit = ord(serialized[index])
        if 0xD800 <= code_unit <= 0xDBFF:
            if index + 1 < len(serialized):
                low = ord(serialized[index + 1])
                if 0xDC00 <= low <= 0xDFFF:
                    normalized.append(chr(
                        0x10000 + ((code_unit - 0xD800) << 10) + (low - 0xDC00)
                    ))
                    index += 2
                    continue
            normalized.append(f'\\u{code_unit:04x}')
        elif 0xDC00 <= code_unit <= 0xDFFF:
            normalized.append(f'\\u{code_unit:04x}')
        else:
            normalized.append(serialized[index])
        index += 1
    return ''.join(normalized).encode('utf-8')


def _javascript_string_utf8(value):
    """Encode a Python string like Node Buffer.from(value, 'utf8')."""
    normalized = []
    index = 0
    while index < len(value):
        code_unit = ord(value[index])
        if 0xD800 <= code_unit <= 0xDBFF:
            if index + 1 < len(value):
                low = ord(value[index + 1])
                if 0xDC00 <= low <= 0xDFFF:
                    normalized.append(chr(
                        0x10000 + ((code_unit - 0xD800) << 10) + (low - 0xDC00)
                    ))
                    index += 2
                    continue
            normalized.append('\ufffd')
        elif 0xDC00 <= code_unit <= 0xDFFF:
            normalized.append('\ufffd')
        else:
            normalized.append(value[index])
        index += 1
    return ''.join(normalized).encode('utf-8')


def _javascript_string_sha256(value):
    return hashlib.sha256(_javascript_string_utf8(value)).hexdigest()


def _stable_json_sha256(value):
    encoded = _javascript_json_utf8(value)
    return hashlib.sha256(encoded).hexdigest()


def _javascript_utf16_sort_key(value, label):
    """Match JavaScript Array#sort string ordering by UTF-16 code units."""
    try:
        encoded = value.encode('utf-16-be')
    except UnicodeEncodeError as exc:
        raise PublishDataValidationError(f'{label} 对象键包含非法 Unicode 代理项') from exc
    return struct.unpack(f'>{len(encoded) // 2}H', encoded)


def _portable_fingerprint_value(value, label='publishedPapers'):
    """Encode JSON data identically in Python and Node, including numeric values."""
    if value is None:
        return ['null']
    if isinstance(value, bool):
        return ['boolean', value]
    if isinstance(value, str):
        return ['string', value]
    if isinstance(value, (int, float)):
        if isinstance(value, int) and abs(value) > (2 ** 53 - 1):
            raise PublishDataValidationError(f'{label} 包含超出 JSON 安全范围的整数')
        numeric = float(value)
        if not math.isfinite(numeric):
            raise PublishDataValidationError(f'{label} 包含非有限数值')
        return ['number-f64', struct.pack('>d', numeric).hex()]
    if isinstance(value, list):
        return [
            'array',
            [
                _portable_fingerprint_value(item, f'{label}[{index}]')
                for index, item in enumerate(value)
            ],
        ]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise PublishDataValidationError(f'{label} 对象键必须是字符串')
        return [
            'object',
            [
                [key, _portable_fingerprint_value(value[key], f'{label}.{key}')]
                for key in sorted(
                    value,
                    key=lambda item: _javascript_utf16_sort_key(item, label),
                )
            ],
        ]
    raise PublishDataValidationError(f'{label} 包含不可序列化类型: {type(value).__name__}')


def published_papers_fingerprint(published_papers):
    """Return the cross-runtime integrity fingerprint for the publication snapshot."""
    if not isinstance(published_papers, list) or not published_papers:
        raise PublishDataValidationError('正式 generation manifest 缺少已发布论文权威快照')
    return _stable_json_sha256(_portable_fingerprint_value(published_papers))


def manual_v6_publication_bindings(published_papers):
    """Build explicit v6 proof bindings instead of relying on an outer snapshot hash."""
    bindings = []
    for paper in published_papers:
        manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if not isinstance(contracts, dict) \
                or contracts.get('manualDepth') != MANUAL_DEPTH_CONTRACT_VERSION_V6:
            continue
        payload = validate_manual_v6_payload(paper)
        manual_v6_bindings = payload['provenance']
        bindings.append({
            'paperId': payload['paperId'],
            'manualDepth': MANUAL_DEPTH_CONTRACT_VERSION_V6,
            'runtimeMode': manual_v6_bindings['runtimeMode'],
            'specVersion': manual_v6_bindings['specVersion'],
            'specRootSha256': manual_v6_bindings['specRootSha256'],
            'paperSpecSha256': manual_v6_bindings['paperSpecSha256'],
            'recordSemanticSha256': manual_v6_bindings['sealedRecordSha256'],
            'recordFileSha256': manual_v6_bindings['recordFileSha256'],
            'artifactIndexSha256': payload['artifactIndexSha256'],
            'artifactIndexFileSha256': manual_v6_bindings['artifactIndexFileSha256'],
            'recordsEnvelopeFileSha256': manual_v6_bindings['recordsEnvelopeFileSha256'],
            'taskEvidenceSha256': manual_v6_bindings['taskEvidenceSha256'],
            'readerLongformContract': MANUAL_LONGFORM_CONTRACT_VERSION_V2,
            'readerLongformSha256': manual_v6_bindings['readerLongformSha256'],
            'readerArticleSha256': payload['articleSha256'],
        })
    return sorted(bindings, key=lambda item: item['paperId'])


def manual_v6_production_proof(published_papers):
    """生成 Manual v6 批次所需的发布核验信息。

    specRootSha256 是 v6 配置的 Merkle 根哈希，用于标识整组配置文件。
    逐篇记录保留论文配置分片、v4 材料记录、文件索引、任务证据及长文记录的对应信息。
    """
    if not isinstance(published_papers, list) or not published_papers:
        raise PublishDataValidationError('Manual v6 发布批次必须是非空的论文数组。')
    bindings = manual_v6_publication_bindings(published_papers)
    if len(bindings) != len(published_papers):
        raise PublishDataValidationError(
            'Manual v6 发布批次中的所有论文记录都必须通过 v6 核验；维护旧 v5 记录时，请明确使用 --legacy-v5-maintenance。'
        )
    roots = {item['specRootSha256'] for item in bindings}
    if len(roots) != 1:
        raise PublishDataValidationError('Manual v6 论文记录使用的配置根哈希不一致。')
    paper_ids = [item['paperId'] for item in bindings]
    if len(set(paper_ids)) != len(paper_ids):
        raise PublishDataValidationError('Manual v6 发布批次中存在重复的论文 ID。')
    return {
        'contract': MANUAL_V6_PRODUCTION_CONTRACT,
        'manualDepth': MANUAL_DEPTH_CONTRACT_VERSION_V6,
        'runtimeMode': 'production',
        'specVersion': 6,
        'recordsVersion': 4,
        'readerLongformContract': MANUAL_LONGFORM_CONTRACT_VERSION_V2,
        'specMerkleRootSha256': next(iter(roots)),
        'paperCount': len(bindings),
        'paperIds': paper_ids,
        'bindingsFingerprint': _stable_json_sha256(bindings),
    }


def llm_api_publication_bindings(published_papers):
    """逐篇核对 API 分析记录，返回文章、评分和来源的哈希及对应信息。"""
    bindings = []
    for paper in published_papers:
        if not isinstance(paper, dict):
            continue
        manifest = paper.get('analysisManifest')
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if not isinstance(contracts, dict) \
                or contracts.get('apiReaderArticle') != LLM_API_READER_CONTRACT:
            continue
        if contracts.get('coreSummary') != CORE_SUMMARY_DETAILED_CONTRACT:
            raise PublishDataValidationError(
                'API 正式发布必须使用 core-summary-detailed-v3 详细核心摘要规则。'
            )
        reader = _api_reader_payload(paper)
        analysis = paper.get('analysis')
        stages = manifest.get('stages') if isinstance(manifest.get('stages'), dict) else {}
        scoring = stages.get('scoringAudit') if isinstance(stages.get('scoringAudit'), dict) else {}
        reader_stage = stages.get('apiReaderArticle') \
            if isinstance(stages.get('apiReaderArticle'), dict) else {}
        source = manifest.get('sourceAcquisition') \
            if isinstance(manifest.get('sourceAcquisition'), dict) else {}
        if not isinstance(analysis, str) or not analysis.strip():
            raise PublishDataValidationError('API 正式发布缺少有效的最终分析正文。')
        analysis_sha = _javascript_string_sha256(analysis)
        source_sha = source.get('sourceSha256')
        paper_source_sha = paper.get('sourceSha256')
        if not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or '')) \
                or paper_source_sha != source_sha:
            raise PublishDataValidationError('API 正式发布的来源 SHA 格式无效，或与论文记录不一致。')
        scoring_binds_final = scoring.get('outputAnalysisSha256') == analysis_sha
        if (
            scoring.get('status') != 'complete'
            or scoring.get('scoringContract') != LLM_API_SCORING_CONTRACT
            or not scoring_binds_final
            or not re.fullmatch(r'[0-9a-f]{64}', str(scoring.get('auditSha256') or ''))
            or not re.fullmatch(r'[0-9a-f]{64}', str(scoring.get('evidenceSha256') or ''))
        ):
            raise PublishDataValidationError('API 正式发布的评分审计状态、规则、正文对应关系或哈希不符合要求。')
        model = reader_stage.get('model')
        protocol = reader_stage.get('protocol')
        if not isinstance(model, str) or not model.strip() \
                or not isinstance(protocol, str) or not protocol.strip():
            raise PublishDataValidationError('API 正式发布的读者文章缺少有效的模型或协议记录。')
        final_score = scoring.get('finalScore')
        parsed = paper.get('parsed') if isinstance(paper.get('parsed'), dict) else {}
        try:
            parsed_score = float(parsed.get('score'))
            final_score_number = float(final_score)
        except (TypeError, ValueError) as exc:
            raise PublishDataValidationError('API 正式发布的最终评分无法转换为数字。') from exc
        if not math.isfinite(parsed_score) or not math.isfinite(final_score_number) \
                or abs(parsed_score - final_score_number) > 1e-9:
            raise PublishDataValidationError('API 正式发布的解析总分或评分审计总分不是有限数值，或两者不一致。')
        core_summary = _validated_detailed_core_summary(paper, parsed)
        if core_summary is None:
            raise PublishDataValidationError('API 正式发布缺少经过核验的详细核心摘要。')
        core_summary_stage = stages.get('coreSummaryRepair')
        paper_id = normalize_publish_arxiv_id(
            paper.get('arxivId') or paper.get('paper_id')
        )
        bindings.append({
            'paperId': paper_id,
            'readerContract': LLM_API_READER_CONTRACT,
            'readerSourceBindingsContract': reader['sourceBindingProof']['contract'],
            'readerSourceBindingsSha256': reader['sourceBindingProof']['sha256'],
            'readerSourceTableBindingCount': reader['sourceBindingProof']['tableCount'],
            'readerSourceFormulaBindingCount': reader['sourceBindingProof']['formulaCount'],
            'readerStructuredArtifactsSha256': (
                reader['sourceBindingProof']['structuredArtifactsSha256']
            ),
            'readerAuthorIdentityContract': reader['authorIdentityProof']['contract'],
            'readerAuthorIdentitySha256': reader['authorIdentityProof']['sha256'],
            'readerAuthorCount': reader['authorIdentityProof']['count'],
            'readerResourceIdentityContract': reader['resourceIdentityProof']['contract'],
            'readerResourceIdentitySha256': reader['resourceIdentityProof']['sha256'],
            'readerResourceCount': reader['resourceIdentityProof']['count'],
            'readerAvailableResourceTypes': reader['resourceIdentityProof']['availableTypes'],
            'readerArticleSha256': reader['articleSha256'],
            'readerPlanSha256': reader['planSha256'],
            'readerFiguresSha256': _stable_json_sha256(reader['figures']),
            'readerFigurePersistence': reader['figurePersistence'],
            'readerAuthorsSha256': _stable_json_sha256(reader['readerAuthors']),
            'analysisSha256': analysis_sha,
            'coreSummaryContract': CORE_SUMMARY_DETAILED_CONTRACT,
            'coreSummarySha256': _javascript_string_sha256(core_summary),
            'coreSummaryBindingSha256': core_summary_stage['bindingSha256'],
            'sourceSha256': source_sha,
            'scoringContract': LLM_API_SCORING_CONTRACT,
            'scoringAuditSha256': scoring['auditSha256'],
            'scoringEvidenceSha256': scoring['evidenceSha256'],
            'finalScore': final_score_number,
            'model': model.strip(),
            'protocol': protocol.strip(),
        })
    return sorted(bindings, key=lambda item: item['paperId'])


def llm_api_production_proof(published_papers):
    """核对批次中每篇论文的 API 发布要求，生成批次发布证明。"""
    if not isinstance(published_papers, list) or not published_papers:
        raise PublishDataValidationError('API 正式发布的批次必须是非空的论文数组。')
    bindings = llm_api_publication_bindings(published_papers)
    if len(bindings) != len(published_papers):
        raise PublishDataValidationError(
            'API 正式发布要求每篇论文的读者文章、评分审计和来源记录都通过核验。'
        )
    if manual_v6_publication_bindings(published_papers):
        raise PublishDataValidationError('API 正式发布的批次中不能混入 Manual v6 论文记录。')
    paper_ids = [item['paperId'] for item in bindings]
    if len(set(paper_ids)) != len(paper_ids):
        raise PublishDataValidationError('API 正式发布的批次中存在重复的论文 ID。')
    return {
        'contract': LLM_API_PRODUCTION_CONTRACT,
        'readerContract': LLM_API_READER_CONTRACT,
        'readerSourceBindingsContract': LLM_API_READER_SOURCE_BINDING_CONTRACT,
        'readerAuthorIdentityContract': LLM_API_READER_AUTHOR_IDENTITY_CONTRACT,
        'readerResourceIdentityContract': LLM_API_READER_RESOURCE_IDENTITY_CONTRACT,
        'scoringContract': LLM_API_SCORING_CONTRACT,
        'paperCount': len(bindings),
        'paperIds': paper_ids,
        'bindingsFingerprint': _stable_json_sha256(bindings),
    }


def infer_generation_publication_mode(papers):
    """按全部论文记录的对应关系选择发布模式；旧 v5 维护模式须明确指定。"""
    if len(manual_v6_publication_bindings(papers)) == len(papers):
        return MANUAL_V6_PRODUCTION_MODE
    if len(llm_api_publication_bindings(papers)) == len(papers):
        return LLM_API_PRODUCTION_MODE
    raise PublishDataValidationError(
        '发布输入未全部满足 Manual v6 要求，也未全部满足 API 正式发布要求。'
    )


def validate_generation_publication_mode(papers, publication_mode):
    """按指定模式核对发布输入，拒绝将 Manual v6 记录按旧 v5 模式处理。"""
    if publication_mode == MANUAL_V6_PRODUCTION_MODE:
        return manual_v6_production_proof(papers)
    if publication_mode == LLM_API_PRODUCTION_MODE:
        return llm_api_production_proof(papers)
    if publication_mode == LEGACY_V5_MAINTENANCE_MODE:
        if manual_v6_publication_bindings(papers):
            raise PublishDataValidationError(
                '旧 v5 维护模式不能混入 Manual v6 论文记录，也不能将这些记录按旧版本处理。'
            )
        return None
    if publication_mode == SEALED_TUTORIAL_PREVIEW_MODE:
        return None
    raise PublishDataValidationError(f'未知发布数据模式: {publication_mode!r}')


def _single_publication_scope(include_id):
    if include_id is None:
        return None
    return {
        'mode': 'single-paper',
        'includeId': normalize_publish_arxiv_id(include_id),
    }


def _validate_publication_scope(manifest, published_papers=None):
    scope = manifest.get('publicationScope')
    if scope is None:
        return None
    if not isinstance(scope, dict) or set(scope) != {'mode', 'includeId'} \
            or scope.get('mode') != 'single-paper':
        raise PublishDataValidationError('generation publicationScope 非法')
    include_id = normalize_publish_arxiv_id(scope.get('includeId'))
    if scope.get('includeId') != include_id:
        raise PublishDataValidationError('generation 单篇 includeId 必须是规范化 arXiv ID')
    papers = published_papers if published_papers is not None else manifest.get('publishedPapers')
    if not isinstance(papers, list) or len(papers) != 1:
        raise PublishDataValidationError('单篇 generation 必须精确绑定一篇 publishedPapers')
    paper_id = normalize_publish_arxiv_id(papers[0].get('arxivId')) \
        if isinstance(papers[0], dict) else ''
    if paper_id != include_id:
        raise PublishDataValidationError('单篇 generation includeId 与 publishedPapers 不一致')
    return scope


def _validate_active_publication_scope(manifest):
    scope = _validate_publication_scope(manifest)
    actual = scope.get('includeId') if scope else None
    if actual != _ACTIVE_PUBLICATION_INCLUDE_ID:
        requested = _ACTIVE_PUBLICATION_INCLUDE_ID or 'batch'
        raise PublishDataValidationError(
            f'generation 发布作用域不匹配: 请求 {requested}，清单 {actual or "batch"}'
        )
    return scope


def _require_active_publication_request(include_id):
    expected = normalize_publish_arxiv_id(include_id) if include_id is not None else None
    if expected != _ACTIVE_PUBLICATION_INCLUDE_ID:
        raise PublishDataValidationError(
            '发布入口未在与 --include-id 一致的隔离事务作用域中运行'
        )
    return expected


def generation_input_fingerprint(
    papers, date_str, category, publish_all, include_id=None,
    input_source_reference=None,
):
    """Bind resumable generation to the exact publication inputs and options."""
    image_exclusions = []
    seen_exclusions = set()
    for paper in papers:
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
        raw_entries = paper.get(PUBLISH_IMAGE_EXCLUSIONS_FIELD, [])
        if not isinstance(raw_entries, list):
            raise PublishDataValidationError(
                f'{paper_id}.{PUBLISH_IMAGE_EXCLUSIONS_FIELD} 必须是数组'
            )
        for index, raw_entry in enumerate(raw_entries):
            entry = _validate_publish_image_exclusion(
                raw_entry, f'{paper_id}.{PUBLISH_IMAGE_EXCLUSIONS_FIELD}[{index}]',
            )
            if entry['normalizedArxivId'] != paper_id:
                raise PublishDataValidationError(
                    f'{paper_id} 发布图片排除项绑定了其他论文 '
                    f'{entry["normalizedArxivId"]}'
                )
            key = (paper_id, entry['url'])
            if key in seen_exclusions:
                raise PublishDataValidationError(f'{paper_id} 发布图片排除项 URL 重复')
            seen_exclusions.add(key)
            image_exclusions.append(entry)
    payload = {
        'date': validate_publish_date(date_str),
        'category': category,
        'publishAll': bool(publish_all),
        'papers': papers,
        PUBLISH_IMAGE_EXCLUSIONS_FIELD: sorted(
            image_exclusions,
            key=lambda item: (item['normalizedArxivId'], item['url']),
        ),
    }
    scope = _single_publication_scope(include_id)
    if scope is not None:
        payload['publicationScope'] = scope
    if input_source_reference is not None:
        payload['inputSourceReference'] = input_source_reference
    return _stable_json_sha256(payload)


def _validate_generation_input_integrity(manifest, date_str):
    """按论文快照和相关来源记录重新计算生成输入，核对记录、发布证明及其指纹。"""
    published_papers = manifest.get('publishedPapers')
    category = manifest.get('category')
    publish_all = manifest.get('publishAll')
    if (
        not isinstance(category, str)
        or not category.strip()
        or not isinstance(publish_all, bool)
        or not isinstance(published_papers, list)
        or not published_papers
    ):
        raise PublishDataValidationError(
            '正式生成清单中的类别、发布全部论文的选项或论文快照缺失，或格式无效。'
        )
    actual_input = str(manifest.get('inputFingerprint') or '')
    scope = _validate_publication_scope(manifest, published_papers)
    input_source_reference = manifest.get('inputSourceReference')
    # A schema-v3 snapshot that advertises fresh-source analysis must retain
    # the exact JSON input from which that provenance can be replayed.  Without
    # it, review/push could accept a manifest whose claimed fresh bundle cannot
    # be located or checked after `data/current` advances.
    if (
            any(
                isinstance(paper, dict)
                and 'freshRewriteProvenance' in paper
                for paper in published_papers
            )
            and input_source_reference is None
    ):
        raise PublishDataValidationError(
            '使用新来源重写的论文缺少生成输入的来源文件记录。'
        )
    if input_source_reference is not None:
        # Check source bytes before fingerprint replay, so a changed archive or
        # --data-file reports source drift rather than a generic mismatch.
        validate_generation_input_source_reference(manifest, date_str)
    expected_input = generation_input_fingerprint(
        published_papers, date_str, category, publish_all,
        scope.get('includeId') if scope else None,
        input_source_reference=input_source_reference,
    )
    if actual_input != expected_input:
        raise PublishDataValidationError(
            '正式生成清单的输入指纹与按论文快照及生成选项重新计算的结果不一致。'
        )
    if manifest.get('publishedPapersFingerprintContract') != PUBLISHED_PAPERS_FINGERPRINT_CONTRACT:
        raise PublishDataValidationError('正式生成清单缺少要求的论文快照指纹规则版本。')
    actual_snapshot = str(manifest.get('publishedPapersFingerprint') or '')
    expected_snapshot = published_papers_fingerprint(published_papers)
    if actual_snapshot != expected_snapshot:
        raise PublishDataValidationError('正式生成清单中的论文快照指纹与实际快照不一致。')
    expected_v6 = manual_v6_publication_bindings(published_papers)
    actual_v6 = manifest.get('manualV6Bindings')
    # Historical v5-only schema-v3 generations predate the explicit field.
    # They remain readable; a manifest containing any v6 paper never gets this
    # exception and must carry the complete explicit proof map.
    historical_v5_without_bindings = actual_v6 is None and not expected_v6
    if not historical_v5_without_bindings:
        if actual_v6 != expected_v6:
            raise PublishDataValidationError('正式生成清单中的 Manual v6 文件对应记录与论文记录不一致。')
        expected_v6_fingerprint = _stable_json_sha256(expected_v6)
        if manifest.get('manualV6BindingsFingerprint') != expected_v6_fingerprint:
            raise PublishDataValidationError('正式生成清单中的 Manual v6 文件对应记录指纹不一致。')
    expected_api = llm_api_publication_bindings(published_papers)
    actual_api = manifest.get('llmApiBindings')
    if actual_api is not None or expected_api:
        if actual_api != expected_api:
            raise PublishDataValidationError('正式生成清单中的 API 发布核验记录与论文记录不一致。')
        if manifest.get('llmApiBindingsFingerprint') != _stable_json_sha256(expected_api):
            raise PublishDataValidationError('正式生成清单中的 API 发布核验记录指纹不一致。')
    publication_mode = manifest.get('publicationMode')
    production_proof = manifest.get('manualV6Production')
    api_proof = manifest.get('llmApiProduction')
    if publication_mode == MANUAL_V6_PRODUCTION_MODE:
        if expected_api or api_proof is not None:
            raise PublishDataValidationError('Manual v6 生成清单中不能包含 API 发布证明。')
        expected_proof = manual_v6_production_proof(published_papers)
        if production_proof != expected_proof:
            raise PublishDataValidationError(
                '正式生成清单中的 Manual v6 发布证明与配置、材料记录及长文核验结果不一致。'
            )
        expected_proof_sha = _stable_json_sha256(expected_proof)
        if manifest.get('manualV6ProductionFingerprint') != expected_proof_sha:
            raise PublishDataValidationError('正式生成清单中的 Manual v6 发布证明指纹不一致。')
    elif publication_mode == LLM_API_PRODUCTION_MODE:
        if expected_v6 or production_proof is not None:
            raise PublishDataValidationError('API 生成清单中不能包含 Manual v6 发布证明。')
        expected_proof = llm_api_production_proof(published_papers)
        if api_proof != expected_proof:
            raise PublishDataValidationError('正式生成清单中的 API 发布证明与实际核验结果不一致。')
        expected_proof_sha = _stable_json_sha256(expected_proof)
        if manifest.get('llmApiProductionFingerprint') != expected_proof_sha:
            raise PublishDataValidationError('正式生成清单中的 API 发布证明指纹不一致。')
    elif publication_mode == LEGACY_V5_MAINTENANCE_MODE:
        if expected_v6 or expected_api or production_proof is not None or api_proof is not None:
            raise PublishDataValidationError('旧 v5 维护模式的生成清单中不能包含正式发布证明。')
    elif publication_mode == SEALED_TUTORIAL_PREVIEW_MODE:
        if scope is None or production_proof is not None or api_proof is not None:
            raise PublishDataValidationError('教程预览模式缺少单篇发布范围，或包含不允许的正式发布证明。')
    elif publication_mode is None and not expected_v6 and not expected_api:
        # Immutable schema-v3 history from before the production-mode field is
        # readable only as legacy maintenance.  It can never enter visuals.
        pass
    else:
        raise PublishDataValidationError('生成清单的发布模式缺失或不符合要求。')
    return expected_input, expected_snapshot


def _expected_post_publish_visuals(manifest, publication_scope_value=None):
    if publication_scope_value is not None:
        return 'not_applicable_single_paper'
    if (
        manifest.get('schemaVersion') == 3
        and manifest.get('publicationMode') in {
            MANUAL_V6_PRODUCTION_MODE, LLM_API_PRODUCTION_MODE,
        }
    ):
        return 'required'
    return 'not_applicable_legacy_maintenance'


def generation_template_fingerprint():
    """Fingerprint generation inputs so generate rerenders after code changes.

    This fingerprint controls generation reuse only.  Review accepts an older
    well-formed fingerprint and decides per-page reuse from the rendered bytes.
    """
    script_dir = Path(__file__).resolve().parent
    dependency_paths = {
        'publish-to-blog.py': script_dir / 'publish-to-blog.py',
        'publish_common.py': script_dir / 'publish_common.py',
        'utils.py': script_dir / 'utils.py',
        'analysis_sections.py': script_dir / 'analysis_sections.py',
        'tag_stage_record.py': script_dir / 'tag_stage_record.py',
        'path_config.py': script_dir / 'path_config.py',
        'markdown_hugo_gate.py': script_dir / 'markdown_hugo_gate.py',
        'manual/sealed_tutorial_preview.py': MANUAL_SCRIPTS_DIR / 'sealed_tutorial_preview.py',
        'manual/tutorial_payload_verifier.py': MANUAL_SCRIPTS_DIR / 'tutorial_payload_verifier.py',
    }
    dependencies = {
        name: _sha256_file(path)
        for name, path in dependency_paths.items()
    }
    return _stable_json_sha256({
        'dependencies': dependencies,
        'basePath': BASE_PATH,
        'taxonomyRegistrySha256': _PAGE_TAG_CATALOG['registrySha256'],
        'generationManifestSchema': 3,
        'generationJournalSchema': 1,
        'reviewFailureSchema': 3,
        'reviewPassCacheSchema': 1,
        'reviewReceiptSchema': 3,
    })


def validate_current_generation_template(manifest):
    """检查生成清单的格式标记，不改写已生成页面。"""
    if manifest.get('schemaVersion') != 3:
        return True
    actual = str(manifest.get('templateFingerprint') or '')
    if not re.fullmatch(r'[0-9a-f]{64}', actual):
        raise PublishDataValidationError('生成清单的模板格式标记不符合要求。')
    return True


def blog_runtime_fingerprint(blog_repo=None):
    """Hash the Hugo runtime that turns reviewed Markdown into public HTML.

    Generation deliberately stays independent from the blog theme: templates do
    not alter the Markdown bytes. Review and push are different—their evidence
    is only reusable while the Hugo config, layouts, data and executable web
    assets remain byte-for-byte identical.
    """
    repo = Path(blog_repo or BLOG_REPO).expanduser().resolve()
    config_names = (
        'hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json', 'go.mod', 'go.sum',
    )
    candidates = [repo / name for name in config_names if (repo / name).is_file()]

    # These trees are direct Hugo render inputs. Hash every regular file rather
    # than maintaining a fragile suffix list: i18n/config may use TOML/YAML/JSON,
    # while assets and layouts may legitimately contain SVG, templates or fonts.
    render_roots = [
        repo / name for name in ('layouts', 'assets', 'data', 'i18n', 'config')
    ]
    themes_root = repo / 'themes'
    if themes_root.is_dir():
        if themes_root.is_symlink():
            raise PublishDataValidationError(f'博客运行时禁止符号链接: {themes_root}')
        for theme in sorted(themes_root.iterdir(), key=lambda item: item.name):
            if theme.is_symlink():
                raise PublishDataValidationError(f'博客运行时禁止符号链接: {theme}')
            if not theme.is_dir():
                continue
            render_roots.extend(
                theme / name for name in ('layouts', 'assets', 'data', 'i18n', 'static')
            )
    for root in render_roots:
        if root.is_symlink():
            raise PublishDataValidationError(f'博客运行时禁止符号链接: {root}')
        if not root.is_dir():
            continue
        for path in root.rglob('*'):
            if path.is_symlink():
                raise PublishDataValidationError(f'博客运行时禁止符号链接: {path}')
            if path.is_file():
                candidates.append(path)

    # Top-level static is potentially hundreds of MiB. Only executable or
    # browser-consumed runtime files belong here. Generated paper sidecars and
    # media are already individually bound by generation/review receipts and
    # must not invalidate the global review protocol on every new paper.
    static_root = repo / 'static'
    static_runtime_suffixes = {
        '.css', '.html', '.js', '.mjs', '.json', '.svg', '.wasm',
        '.webmanifest', '.xml',
    }
    generated_prefixes = (
        ('static', 'data', 'papers'),
        ('static', 'images', 'papers'),
        ('static', 'images', 'visual-summaries'),
        ('static', 'images', 'digest-covers'),
    )
    if static_root.is_symlink():
        raise PublishDataValidationError(f'博客运行时禁止符号链接: {static_root}')
    if static_root.is_dir():
        for path in static_root.rglob('*'):
            if path.is_symlink():
                raise PublishDataValidationError(f'博客运行时禁止符号链接: {path}')
            if not path.is_file() or path.suffix.lower() not in static_runtime_suffixes:
                continue
            relative = path.relative_to(repo)
            if any(relative.parts[:len(prefix)] == prefix for prefix in generated_prefixes):
                continue
            candidates.append(path)
    records = []
    for path in sorted(set(candidates), key=lambda item: item.relative_to(repo).as_posix()):
        if path.is_symlink():
            raise PublishDataValidationError(f'博客运行时禁止符号链接: {path}')
        records.append({
            'path': path.relative_to(repo).as_posix(),
            'sha256': _sha256_file(path),
        })
    if not records:
        raise PublishDataValidationError(f'博客运行时文件缺失: {repo}')
    return _stable_json_sha256({
        'contract': 'hugo-blog-runtime-v1',
        'files': records,
    })


def review_protocol_fingerprint():
    """Bind reusable review evidence to code, prompts/models and Hugo runtime."""
    script_dir = Path(__file__).resolve().parent
    dependency_paths = {
        'publish-to-blog.py': script_dir / 'publish-to-blog.py',
        'review-blog.py': script_dir / 'review-blog.py',
        'manual/manual-review-blog.py': MANUAL_SCRIPTS_DIR / 'manual-review-blog.py',
        'markdown_hugo_gate.py': script_dir / 'markdown_hugo_gate.py',
        'manual/tutorial_payload_verifier.py': MANUAL_SCRIPTS_DIR / 'tutorial_payload_verifier.py',
        'publish_common.py': script_dir / 'publish_common.py',
        'llm_account_pool.py': script_dir / 'llm_account_pool.py',
        'utils.py': script_dir / 'utils.py',
        'analysis_sections.py': script_dir / 'analysis_sections.py',
        'tag_stage_record.py': script_dir / 'tag_stage_record.py',
    }
    dependencies = {
        name: _sha256_file(path)
        for name, path in dependency_paths.items()
    }
    hugo_path = shutil.which('hugo')
    try:
        hugo_stat = Path(hugo_path).stat() if hugo_path else None
        hugo_identity = (
            hugo_path,
            hugo_stat.st_mtime_ns if hugo_stat else None,
            hugo_stat.st_size if hugo_stat else None,
        )
    except OSError:
        hugo_identity = (hugo_path, None, None)
    runtime_fingerprint = blog_runtime_fingerprint()
    cache_key = _stable_json_sha256({
        'dependencies': dependencies,
        'primaryModel': os.environ.get('PAPER_ANALYZER_MODEL', ''),
        'primaryEndpoint': os.environ.get('PAPER_ANALYZER_ENDPOINT', ''),
        'secondaryModel': os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', ''),
        'secondaryEndpoint': os.environ.get('PAPER_ANALYZER_SECONDARY_ENDPOINT', ''),
        'reviewChunkChars': get_blog_review_chunk_chars(),
        'reviewMaxTokens': get_blog_review_max_tokens(),
        'hugoIdentity': hugo_identity,
        'blogRuntimeFingerprint': runtime_fingerprint,
    })
    if cache_key in _REVIEW_PROTOCOL_CACHE:
        return _REVIEW_PROTOCOL_CACHE[cache_key]
    try:
        hugo_result = _run_bounded_subprocess(
            [hugo_path or 'hugo', 'version'],
            cwd=PROJECT_ROOT,
            env=build_child_process_env(),
            timeout_seconds=10,
            text=True,
        )
        hugo_version = (
            hugo_result.stdout.strip()
            if hugo_result.returncode == 0 and not hugo_result.timed_out
            else 'unavailable'
        )
    except OSError:
        hugo_version = 'unavailable'
    fingerprint = _stable_json_sha256({
        'contractVersion': 3,
        'dependencies': dependencies,
        'primaryModel': os.environ.get('PAPER_ANALYZER_MODEL', ''),
        'primaryEndpoint': os.environ.get('PAPER_ANALYZER_ENDPOINT', ''),
        'secondaryModel': os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', ''),
        'secondaryEndpoint': os.environ.get('PAPER_ANALYZER_SECONDARY_ENDPOINT', ''),
        'textTemperature': 0.1,
        'imageTemperature': 0.1,
        'reviewChunkChars': get_blog_review_chunk_chars(),
        'reviewMaxTokens': get_blog_review_max_tokens(),
        'hugoVersion': hugo_version,
        'blogRuntimeFingerprint': runtime_fingerprint,
    })
    _REVIEW_PROTOCOL_CACHE.clear()
    _REVIEW_PROTOCOL_CACHE[cache_key] = fingerprint
    return fingerprint


def _load_json_object(path, label):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'{label}无法读取或解析：{path}') from exc
    if not isinstance(value, dict):
        raise PublishDataValidationError(f'{label}的内容必须是 JSON 对象：{path}')
    return value


def _save_generation_journal(path, journal):
    atomic_write_json(path, journal, ensure_ascii=False, indent=2, mode=0o600)


def prepare_generation_journal(
    date_str, papers, category, publish_all, input_fingerprint,
    template_fingerprint, base_head, include_id=None,
):
    """Create or validate a persistent per-page generation checkpoint."""
    journal_path = generation_journal_path(date_str)
    stage = generation_stage_path(date_str)
    planned = []
    seen = set()
    for paper in papers:
        arxiv_id = paper.get('arxivId', '')
        slug = paper_slug(paper.get('title', ''), arxiv_id)
        filename = f'{date_str}-{slug}.md'
        if filename in seen:
            raise PublishDataValidationError(f'重复论文会生成同一页面: {filename}')
        seen.add(filename)
        planned.append({
            'arxivId': arxiv_id,
            'filename': filename,
            'status': 'pending',
            'sha256': None,
        })
    expected_identity = [(item['arxivId'], item['filename']) for item in planned]
    publication_scope_value = _single_publication_scope(include_id)

    if journal_path.is_file():
        journal = _load_json_object(journal_path, '生成续跑日志')
        actual_identity = [
            (item.get('arxivId'), item.get('filename'))
            for item in journal.get('papers', []) if isinstance(item, dict)
        ]
        journal_mismatch = (
            journal.get('schemaVersion') != 1
            or journal.get('date') != date_str
            or journal.get('inputFingerprint') != input_fingerprint
            or journal.get('templateFingerprint') != template_fingerprint
            or journal.get('baseHead') != str(base_head).lower()
            or actual_identity != expected_identity
            or journal.get('publicationScope') != publication_scope_value
        )
        if journal_mismatch:
            # No target path has been snapshotted or installed yet, so this is
            # only derived staging state.  A record/template repair may safely
            # restart it from scratch.  Once installation begins we still fail
            # closed because the journal is then the rollback authority.
            if journal.get('installation') is not None:
                raise PublishDataValidationError(
                    f'未完成 generation 的输入、模板、博客基线或论文集合已变化；'
                    f'安装已开始，拒绝覆盖续跑状态: {journal_path}'
                )
            if stage.parent.exists():
                shutil.rmtree(stage.parent)
        else:
            for record in journal['papers']:
                if record.get('status') == 'generated':
                    staged = stage / record['filename']
                    if not staged.is_file() or _sha256_file(staged) != record.get('sha256'):
                        raise PublishDataValidationError(
                            f'已生成页面 checkpoint 损坏: {record["filename"]}'
                        )
            return journal, journal_path, stage

    if stage.parent.exists():
        shutil.rmtree(stage.parent)
    stage.mkdir(parents=True, exist_ok=True)
    journal = {
        'schemaVersion': 1,
        'date': date_str,
        'inputFingerprint': input_fingerprint,
        'templateFingerprint': template_fingerprint,
        'baseHead': str(base_head).lower(),
        'category': category,
        'publishAll': bool(publish_all),
        'publicationScope': publication_scope_value,
        'papers': planned,
        'index': (
            None if publication_scope_value is not None else
            {'filename': f'{date_str}.md', 'status': 'pending', 'sha256': None}
        ),
        'installation': None,
    }
    _save_generation_journal(journal_path, journal)
    return journal, journal_path, stage


def prepare_generation_installation(
    journal, journal_path, staged_posts, content_dir, date_str, staged_assets=None,
):
    """Snapshot the exact pre-install state before any target path is changed."""
    if journal.get('installation') is not None:
        return journal['installation']['files']
    # Review/receipt 必须覆盖本批所有生成页和受控删除，而不只是当前有字节差异的页面。
    # 真正的 commit delta 在 push 阶段再相对 baseHead 精确推导。
    publish_paths = publish_manifest_paths(
        staged_posts, content_dir, date_str, staged_assets=staged_assets,
        single_page=journal.get('publicationScope') is not None,
    )
    prior_exact = {}
    prior_manifest_path = generation_manifest_path(date_str)
    if prior_manifest_path.is_file():
        try:
            prior_manifest = _load_json_object(prior_manifest_path, '既有 generation manifest')
            for item in prior_manifest.get('files', []):
                if (isinstance(item, dict) and item.get('deleted') is not True
                        and isinstance(item.get('path'), str)
                        and re.fullmatch(r'[a-f0-9]{64}', str(item.get('sha256') or ''))):
                    target = Path(BLOG_REPO).expanduser().resolve() / item['path']
                    prior_exact[item['path']] = {
                        'sha256': item['sha256'],
                        'controlledBinary': is_api_reader_asset_path(target),
                        'controlledTaxonomy': _is_tag_catalog_file_path(item['path']),
                    }
        except PublishDataValidationError:
            prior_exact = {}
    validate_manifest_clean_against_head(
        publish_paths, allow_exact_pipeline_untracked=prior_exact,
    )
    stage_root = Path(staged_posts).resolve().parent
    staged_by_target = {}
    repo = Path(BLOG_REPO).expanduser().resolve()
    for source in Path(staged_posts).glob('*.md'):
        source = source.resolve()
        relative = source.relative_to(stage_root)
        staged_by_target[(repo / 'content' / 'posts' / source.name).resolve()] = relative.as_posix()
    for source in [Path(item) for item in (staged_assets or [])]:
        source = source.resolve()
        relative = source.relative_to(stage_root)
        staged_by_target[(repo / relative).resolve()] = relative.as_posix()
    records = []
    for target in publish_paths:
        target = Path(target).resolve()
        staged_relative = staged_by_target.get(target)
        source = stage_root / staged_relative if staged_relative else None
        deleting = staged_relative is None
        records.append({
            'path': target.relative_to(Path(BLOG_REPO).expanduser().resolve()).as_posix(),
            'delete': deleting,
            'expectedSha256': None if deleting else _sha256_file(source),
            'stagedRelativePath': None if deleting else staged_relative,
            'before': _file_fingerprint(target),
            'installed': False,
        })
    journal['installation'] = {'files': records}
    _save_generation_journal(journal_path, journal)
    return records


def resume_generation_installation(journal, journal_path, staged_posts):
    """Idempotently finish a journalled install, including crash-after-replace cases."""
    repo = Path(BLOG_REPO).expanduser().resolve()
    installed_paths = []
    for record in journal.get('installation', {}).get('files', []):
        target = (repo / record['path']).resolve()
        _manifest_record(target, repo)
        current = _file_fingerprint(target)
        expected = {
            'deleted': bool(record.get('delete')),
            'sha256': record.get('expectedSha256'),
        }
        if record.get('installed'):
            if current != expected:
                raise PublishDataValidationError(
                    f'generation 已安装页面后来发生变化，疑似人工修改: {record["path"]}'
                )
            installed_paths.append(target)
            continue
        if current == expected:
            # The process may have died after os.replace/unlink but before the
            # journal bit was flushed. Adopt only the exact expected bytes.
            record['installed'] = True
            _save_generation_journal(journal_path, journal)
            installed_paths.append(target)
            continue
        if current != record.get('before'):
            raise PublishDataValidationError(
                f'generation 待安装路径已偏离续跑前快照，拒绝覆盖人工修改: {record["path"]}'
            )
        if record.get('delete'):
            target.unlink(missing_ok=True)
        else:
            staged_relative = record.get('stagedRelativePath')
            if not isinstance(staged_relative, str) or not staged_relative:
                raise PublishDataValidationError(f'generation staging 路径缺失: {target.name}')
            stage_root = Path(staged_posts).resolve().parent
            source = (stage_root / staged_relative).resolve()
            try:
                source.relative_to(stage_root)
            except ValueError as exc:
                raise PublishDataValidationError(f'generation staging 路径逃逸: {staged_relative}') from exc
            if not source.is_file() or _sha256_file(source) != record.get('expectedSha256'):
                raise PublishDataValidationError(f'generation staging 页面缺失或损坏: {target.name}')
            _atomic_write_bytes(target, source.read_bytes())
        record['installed'] = True
        _save_generation_journal(journal_path, journal)
        installed_paths.append(target)
    return installed_paths


def _manifest_record(path, repo):
    path = Path(path).expanduser().resolve()
    try:
        relative = path.relative_to(repo)
    except ValueError as exc:
        raise PublishDataValidationError(f'博客清单中的文件位于仓库之外：{path}') from exc
    is_post = relative.parts[:2] == ('content', 'posts') and len(relative.parts) == 3
    is_visual_asset = (
        relative.parts[:3] == ('static', 'images', 'visual-summaries')
        and len(relative.parts) >= 6
        and re.fullmatch(r'\d{4}-\d{2}-\d{2}', relative.parts[3] or '')
        and relative.suffix.lower() == '.png'
        and relative.stem in VISUAL_SUMMARY_KINDS
    )
    is_digest_cover = (
        relative.parts[:3] == ('static', 'images', 'digest-covers')
        and len(relative.parts) == 5
        and re.fullmatch(r'\d{4}-\d{2}-\d{2}', relative.parts[3] or '')
        and relative.name == 'cover.png'
    )
    is_reader_asset = (
        relative.parts[:3] == ('static', 'images', 'papers')
        and len(relative.parts) == 5
        and re.fullmatch(r'\d{4}\.\d{4,5}', relative.parts[3] or '')
        and re.fullmatch(r'figure-\d+-[0-9a-f]{16}\.(?:png|svg)', relative.name or '')
    )
    is_researcher_sidecar = (
        relative.parts[:3] == ('static', 'data', 'papers')
        and len(relative.parts) == 6
        and re.fullmatch(r'\d{4}-\d{2}-\d{2}', relative.parts[3] or '')
        and re.fullmatch(r'[a-z0-9][a-z0-9-]*[a-z0-9]', relative.parts[4] or '')
        and relative.name in RESEARCHER_SIDECAR_FILENAMES
    )
    if not (
            is_post or is_visual_asset or is_digest_cover
            or is_reader_asset or is_researcher_sidecar
            or _is_tag_catalog_file_path(relative)):
        raise PublishDataValidationError(f'博客清单中包含不允许发布的路径：{relative}')
    return path, relative.as_posix()


def is_visual_summary_asset_path(path, date_str=None):
    """Return whether a path is a controlled visual-summary asset for this batch."""
    repo = Path(BLOG_REPO).expanduser().resolve()
    try:
        _target, relative = _manifest_record(path, repo)
    except PublishDataValidationError:
        return False
    parts = Path(relative).parts
    if parts[:3] not in (('static', 'images', 'visual-summaries'), ('static', 'images', 'digest-covers')):
        return False
    return date_str is None or parts[3] == validate_publish_date(date_str)


def is_api_reader_asset_path(path, paper_id=None):
    repo = Path(BLOG_REPO).expanduser().resolve()
    try:
        _target, relative = _manifest_record(path, repo)
    except PublishDataValidationError:
        return False
    parts = Path(relative).parts
    if parts[:3] == ('static', 'images', 'papers') and len(parts) == 5:
        return paper_id is None or parts[3] == normalize_publish_arxiv_id(paper_id)
    if parts[:3] != ('static', 'data', 'papers') or len(parts) != 6:
        return False
    if paper_id is None:
        return True
    safe_id = normalize_publish_arxiv_id(paper_id).replace('/', '-').replace('.', '-')
    return parts[4] == safe_id


def is_researcher_sidecar_path(path, paper_id=None, date_str=None):
    repo = Path(BLOG_REPO).expanduser().resolve()
    try:
        _target, relative = _manifest_record(path, repo)
    except PublishDataValidationError:
        return False
    parts = Path(relative).parts
    if parts[:3] != ('static', 'data', 'papers') or len(parts) != 6:
        return False
    if date_str is not None and parts[3] != validate_publish_date(date_str):
        return False
    if paper_id is not None:
        safe_id = normalize_publish_arxiv_id(paper_id).replace('/', '-').replace('.', '-')
        if parts[4] != safe_id:
            return False
    return True


def _validate_manifest_path_date(target, repo, date_str):
    _target, relative = _manifest_record(target, repo)
    validated_date = validate_publish_date(date_str)
    relative_path = Path(relative)
    if relative_path.parts[:2] == ('content', 'posts'):
        name = relative_path.name
        if (
            relative_path.suffix != '.md'
            or not (name == f'{validated_date}.md' or name.startswith(f'{validated_date}-'))
        ):
            raise PublishDataValidationError(
                f'博客页面路径不属于目标日期 {validated_date}: {relative}'
            )
    if relative.startswith('static/images/visual-summaries/'):
        asset_date = Path(relative).parts[3]
        if asset_date != validated_date:
            raise PublishDataValidationError(
                f'论文长图的批次日期与目标日期不一致：{relative}'
            )
    if relative.startswith('static/images/digest-covers/'):
        asset_date = Path(relative).parts[3]
        if asset_date != validated_date:
            raise PublishDataValidationError(f'汇总页封面的批次日期与目标日期不一致：{relative}')
    if relative.startswith('static/data/papers/'):
        asset_date = Path(relative).parts[3]
        if asset_date != validated_date:
            raise PublishDataValidationError(
                f'论文附属数据文件的批次日期与目标日期不一致：{relative}'
            )
    return relative


def save_generation_manifest(
    date_str, publish_paths, *, input_fingerprint=None,
    template_fingerprint=None, base_head=None, category='论文速递',
    published_papers=None, publish_all=False, include_id=None,
    publication_mode=None, input_source_reference=None,
):
    """Save the exact generated/removed path list for the separate review step."""
    _require_active_publication_request(include_id)
    existing_receipt_path = review_receipt_path(date_str)
    if existing_receipt_path.exists():
        try:
            existing_receipt = _load_json_object(existing_receipt_path, '审查凭证')
        except (OSError, UnicodeError, PublishDataValidationError) as exc:
            raise PublishDataValidationError(
                '同日期已有不可读审查凭证；拒绝覆盖可能的历史发布证据'
            ) from exc
        if any(existing_receipt.get(field) for field in (
            'publicationCommit', 'remoteVerifiedOid', 'remoteVerifiedAt',
            'remoteIdentitySha256',
        )):
            raise PublishDataValidationError(
                '同日期已有远端发布证据；generation manifest 与 receipt 必须保持只读'
            )
    # Migrate every historical per-file pass before replacing batch-level
    # evidence. Reuse remains safe because the durable cache is keyed by the
    # exact repository-relative path and reviewed SHA-256, not by this manifest.
    save_review_pass_cache(date_str)
    repo = Path(BLOG_REPO).expanduser().resolve()
    records = []
    for item in sorted({Path(value).expanduser().resolve() for value in publish_paths}):
        path = Path(item).expanduser().resolve()
        relative = _validate_manifest_path_date(path, repo, date_str)
        records.append({
            'path': relative,
            'deleted': not path.is_file(),
            'sha256': _sha256_file(path) if path.is_file() else None,
        })
    validated_date = validate_publish_date(date_str)
    validated_category = str(category or '论文速递')
    manifest = {
        'schemaVersion': 3 if input_fingerprint else 1,
        'date': validated_date,
        'generatedAt': datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat(),
        'files': records,
        'category': validated_category,
        # 视觉摘要属于远端发布成功后的独立阶段，不进入本次博客清单。
        'visualSummaryRequired': False,
        'digestCoverRequired': False,
    }
    if input_fingerprint:
        if not isinstance(published_papers, list) or not published_papers:
            raise PublishDataValidationError('正式生成清单必须包含非空的论文快照数组。')
        if not isinstance(publish_all, bool):
            raise PublishDataValidationError('正式生成清单中的发布全部论文选项必须是布尔值。')
        expected_input = generation_input_fingerprint(
            published_papers, validated_date, validated_category, publish_all,
            include_id, input_source_reference=input_source_reference,
        )
        if input_fingerprint != expected_input:
            raise PublishDataValidationError(
                '输入指纹与按本次输入及选项重新计算的结果不一致，不能保存生成清单。'
            )
        if publication_mode is None:
            publication_mode = infer_generation_publication_mode(published_papers)
        production_proof = validate_generation_publication_mode(
            published_papers, publication_mode,
        )
        api_bindings = llm_api_publication_bindings(published_papers)
        manifest.update({
            'inputFingerprint': input_fingerprint,
            'templateFingerprint': template_fingerprint,
            'baseHead': str(base_head or '').lower(),
            'publishAll': publish_all,
            'publishedPapers': published_papers,
            'publishedPapersFingerprintContract': PUBLISHED_PAPERS_FINGERPRINT_CONTRACT,
            'publishedPapersFingerprint': published_papers_fingerprint(published_papers),
            'manualV6Bindings': manual_v6_publication_bindings(published_papers),
            'llmApiBindings': api_bindings,
            'publicationMode': publication_mode,
        })
        if input_source_reference is not None:
            manifest['inputSourceReference'] = input_source_reference
        publication_scope_value = _single_publication_scope(include_id)
        if publication_scope_value is not None:
            _validate_publication_scope(
                {'publicationScope': publication_scope_value}, published_papers,
            )
            page_records = [record for record in records if record['path'].startswith('content/posts/')]
            asset_records = [
                record for record in records
                if record['path'].startswith((
                    'static/images/papers/', 'static/data/papers/',
                ))
            ]
            if len(page_records) != 1 or page_records[0]['deleted'] is True \
                    or page_records[0]['path'].endswith(f'/{validated_date}.md') \
                    or len(page_records) + len(asset_records) != len(records):
                raise PublishDataValidationError(
                    '单篇 generation manifest 必须绑定一个现存论文页及其受控正文图/sidecar'
                )
            expected_image_prefix = (
                f'static/images/papers/{publication_scope_value["includeId"]}/'
            )
            expected_sidecar_id = publication_scope_value['includeId'].replace('.', '-').replace('/', '-')
            expected_sidecar_prefix = (
                f'static/data/papers/{validated_date}/{expected_sidecar_id}/'
            )
            if any(
                    record['deleted'] is True
                    or not record['path'].startswith((
                        expected_image_prefix, expected_sidecar_prefix,
                    ))
                    for record in asset_records):
                raise PublishDataValidationError(
                    '单篇 generation 正文图/sidecar 与 includeId 不一致'
                )
            manifest['publicationScope'] = publication_scope_value
        manifest['manualV6BindingsFingerprint'] = _stable_json_sha256(
            manifest['manualV6Bindings']
        )
        manifest['llmApiBindingsFingerprint'] = _stable_json_sha256(api_bindings)
        if publication_mode == MANUAL_V6_PRODUCTION_MODE:
            manifest['manualV6Production'] = production_proof
            manifest['manualV6ProductionFingerprint'] = _stable_json_sha256(
                production_proof
            )
        elif publication_mode == LLM_API_PRODUCTION_MODE:
            manifest['llmApiProduction'] = production_proof
            manifest['llmApiProductionFingerprint'] = _stable_json_sha256(
                production_proof
            )
        _validate_generation_input_integrity(manifest, validated_date)
    path = generation_manifest_path(date_str)
    atomic_write_json(path, manifest, ensure_ascii=False, indent=2)
    # A new generation invalidates only batch-level evidence. Exact per-file
    # pass evidence survives in review_pass_cache_path(date_str).
    review_receipt_path(date_str).unlink(missing_ok=True)
    review_failure_path(date_str).unlink(missing_ok=True)
    return path


def plan_post_publish_visual_assets(date_str):
    """After remote publication succeeds, create TOP 10 infographic and digest-image tasks."""
    date_str = validate_publish_date(date_str)
    manifest = _load_json_object(generation_manifest_path(date_str), '生成清单')
    category = str(manifest.get('category') or '论文速递')
    command = [
        'node', str(PROJECT_ROOT / 'scripts' / 'visual-summary-integration.js'),
        '--date', date_str,
        '--category', category,
    ]
    try:
        timeout_seconds = _bounded_positive_seconds(
            'PD_VISUAL_PLANNER_TIMEOUT_SECONDS',
            VISUAL_PLANNER_TIMEOUT_SECONDS, 10, 900,
        )
        completed = _run_bounded_subprocess(
            command,
            cwd=PROJECT_ROOT,
            text=True,
            env=build_child_process_env(),
            timeout_seconds=timeout_seconds,
            max_output_bytes=HUGO_GATE_OUTPUT_TAIL_BYTES,
            combine_output=True,
            tail_output=True,
        )
    except OSError as exc:
        print(f'⚠️ 全部博客已经发布，但无法启动发布后视觉规划器: {exc}')
        print(f'   可重试: npm run visual:post-publish -- --date {date_str}')
        return False
    if completed.returncode != 0:
        reason = '超时且完整进程组已终止' if completed.timed_out else '子进程返回非零'
        print(f'⚠️ 全部博客已经发布，但发布后视觉任务建立失败（{reason}）；图片不回滚博客发布')
        detail = (completed.stderr or completed.stdout or '').strip()
        if detail:
            print(f'   诊断: {detail[-2000:]}')
        print(f'   可重试: npm run visual:post-publish -- --date {date_str}')
        return False
    return True


def preflight_post_publish_visual_capability(date_str, *, require_visual_plan=False):
    """Decide whether this reviewed generation can enter the modern visual stage.

    Historical schema v1/v2 manifests remain publishable for explicit maintenance,
    but they do not contain the authoritative paper snapshot needed by the modern
    post-publication visual contract.  Daily mode must reject them before Git is
    mutated instead of discovering the incompatibility after a remote push.
    """
    date_str = validate_publish_date(date_str)
    manifest_path = generation_manifest_path(date_str)
    manifest = _load_json_object(manifest_path, '生成清单')
    schema_version = manifest.get('schemaVersion')
    if manifest.get('date') != date_str or schema_version not in {1, 2, 3}:
        raise PublishDataValidationError('生成清单版本或日期不匹配')
    if schema_version == 3:
        validate_generation_visual_contract(manifest, date_str)
        scope = _validate_active_publication_scope(manifest)
        if scope is not None:
            if require_visual_plan:
                raise PublishDataValidationError(
                    '单篇灰度发布不建立批次 TOP 10/汇总图任务；不得使用 --require-visual-plan'
                )
            print('🎯 单篇灰度发布：发布后批次视觉任务明确标记为不适用')
            return False
        if manifest.get('publicationMode') not in {
                MANUAL_V6_PRODUCTION_MODE, LLM_API_PRODUCTION_MODE}:
            if require_visual_plan:
                raise PublishDataValidationError(
                    '发布后视觉只接受 production generation；legacy v5 maintenance 不适用'
                )
            print('🧰 legacy v5 maintenance 发布：发布后视觉任务明确标记为不适用')
            return False
        return True
    if require_visual_plan:
        raise PublishDataValidationError(
            f'标准日更要求发布后视觉任务，但 generation manifest schema v{schema_version} '
            '仅支持历史维护发布；请重新运行 generate-blog.py 生成 schema v3 清单'
        )
    print(
        f'🧰 generation manifest schema v{schema_version} 进入历史维护模式：'
        '允许博客推送，但发布后视觉任务明确标记为不适用'
    )
    return False


def validate_generation_visual_contract(manifest, date_str, repo=None):
    """Ensure post-publication visuals cannot leak into the blog publication commit."""
    if manifest.get('visualSummaryRequired') is not False:
        raise PublishDataValidationError('生成清单仍使用旧版发布前视觉摘要契约，请重新运行 generate-blog.py')
    if manifest.get('digestCoverRequired') is not False:
        raise PublishDataValidationError('生成清单仍使用旧版发布前汇总封面契约，请重新运行 generate-blog.py')
    if manifest.get('schemaVersion') == 3:
        _validate_generation_input_integrity(manifest, date_str)
    repo = Path(repo or BLOG_REPO).expanduser().resolve()
    paper_ids = set()
    workbench_paper_ids = set()
    for record in manifest.get('files') or []:
        if not isinstance(record, dict) or record.get('deleted') is True:
            continue
        relative = Path(str(record.get('path') or ''))
        parts = relative.parts
        if parts[:3] in (('static', 'images', 'visual-summaries'), ('static', 'images', 'digest-covers')):
            raise PublishDataValidationError(f'发布后视觉资产不得进入博客 generation manifest: {relative}')
        if parts[:2] == ('content', 'posts') and relative.suffix == '.md':
            target = (repo / relative).resolve()
            if not target.is_file():
                continue
            content = target.read_text(encoding='utf-8')
            controlled_prefixes = (
                f'{BASE_PATH.rstrip("/")}/images/visual-summaries/{date_str}/',
                f'{BASE_PATH.rstrip("/")}/images/digest-covers/{date_str}/',
            )
            if any(image['url'].startswith(controlled_prefixes) for image in parse_markdown_images(content)):
                raise PublishDataValidationError(f'博客页面提前引用发布后视觉资产: {relative}')
            if re.search(r'^paper_digest_page_type:\s*index\s*$', content, re.MULTILINE):
                continue
            if not re.search(r'^paper_digest_page_type:\s*paper\s*$', content, re.MULTILINE):
                continue
            match = re.search(r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', content, re.MULTILINE)
            if not match:
                raise PublishDataValidationError(f'论文页缺少 arXiv ID: {relative}')
            paper_id = normalize_publish_arxiv_id(match.group(1))
            paper_ids.add(paper_id)
            if re.search(
                    rf'^paper_digest_workbench_contract:\s*"?{re.escape(RESEARCHER_WORKBENCH_CONTRACT)}"?\s*$',
                    content, re.MULTILINE):
                workbench_paper_ids.add(paper_id)
    if not paper_ids:
        raise PublishDataValidationError('生成清单中没有可绑定视觉摘要的论文页')
    if manifest.get('schemaVersion') == 3:
        published_papers = manifest.get('publishedPapers')
        if (
            not re.fullmatch(r'[0-9a-f]{64}', str(manifest.get('inputFingerprint') or ''))
            or not isinstance(published_papers, list)
            or not published_papers
        ):
            raise PublishDataValidationError('正式生成清单缺少输入指纹或已发布论文权威快照')
        snapshot_ids = []
        for paper in published_papers:
            if not isinstance(paper, dict):
                raise PublishDataValidationError('已发布论文权威快照包含非法记录')
            snapshot_ids.append(normalize_publish_arxiv_id(paper.get('arxivId')))
        if len(snapshot_ids) != len(set(snapshot_ids)):
            raise PublishDataValidationError('已发布论文权威快照包含重复 arXiv ID')
        if set(snapshot_ids) != paper_ids:
            raise PublishDataValidationError('已发布论文权威快照与实际生成论文页集合不一致')
        actual_sidecars = {
            record['path']: record
            for record in manifest.get('files') or []
            if isinstance(record, dict)
            and isinstance(record.get('path'), str)
            and record['path'].startswith('static/data/papers/')
            and record.get('deleted') is not True
        }
        expected_sidecars = {}
        for paper in published_papers:
            paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
            if paper_id not in workbench_paper_ids:
                continue
            api_reader_payload = _api_reader_payload(paper)
            v6_payload = _manual_v6_reader_payload(paper)
            reader_plan = (
                v6_payload.get('plan') if isinstance(v6_payload, dict)
                else api_reader_payload.get('plan')
                if isinstance(api_reader_payload, dict)
                else _manual_reader_editorial_plan(paper)
            )
            bundle = build_researcher_workbench_bundle(
                paper, date_str, reader_plan=reader_plan,
                api_reader_payload=api_reader_payload, require_reader=True,
            )
            for relative, raw in bundle['sidecars'].items():
                relative_text = relative.as_posix()
                if relative_text in expected_sidecars:
                    raise PublishDataValidationError(
                        f'researcher sidecar 期望路径重复: {relative_text}'
                    )
                expected_sidecars[relative_text] = hashlib.sha256(raw).hexdigest()
        if set(actual_sidecars) != set(expected_sidecars):
            raise PublishDataValidationError(
                'researcher sidecar 路径集合与 workbench 论文集合不一致'
            )
        for relative, expected_sha in expected_sidecars.items():
            record = actual_sidecars[relative]
            if record.get('deleted') is not False or record.get('sha256') != expected_sha:
                raise PublishDataValidationError(
                    f'researcher sidecar manifest SHA 不一致: {relative}'
                )
    return True


def load_generation_manifest(date_str):
    """读取生成清单，核对版本、日期、允许的路径及相应版本的文件要求；不执行页面审查。"""
    manifest_path = generation_manifest_path(date_str)
    if not manifest_path.is_file():
        raise PublishDataValidationError(
            f'缺少生成清单：{manifest_path}；请先运行 generate-blog.py'
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'生成清单无法读取或解析：{manifest_path}') from exc
    if manifest.get('schemaVersion') not in {1, 2, 3} or manifest.get('date') != date_str:
        raise PublishDataValidationError('生成清单的版本不受支持，或日期与目标日期不一致。')
    _validate_active_publication_scope(manifest)
    validate_current_generation_template(manifest)
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('生成清单必须包含非空的文件记录数组。')
    repo = Path(BLOG_REPO).expanduser().resolve()
    paths = []
    seen = set()
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get('path'), str)
            or not isinstance(record.get('deleted'), bool)
        ):
            raise PublishDataValidationError('生成清单中的文件记录格式无效，或路径、删除标记不符合要求。')
        if manifest.get('schemaVersion') in {2, 3}:
            expected_sha = record.get('sha256')
            if record['deleted']:
                if expected_sha is not None:
                    raise PublishDataValidationError('生成清单中标记为删除的文件不应包含 SHA-256。')
            elif not re.fullmatch(r'[0-9a-f]{64}', str(expected_sha or '')):
                raise PublishDataValidationError('生成清单中未标记为删除的文件缺少有效的 SHA-256。')
        relative = Path(record['path'])
        if relative.is_absolute():
            raise PublishDataValidationError(f'生成清单中的文件路径必须是相对路径：{relative}')
        target = (repo / relative).resolve()
        normalized = _validate_manifest_path_date(target, repo, date_str)
        if normalized in seen:
            raise PublishDataValidationError(f'生成清单中存在重复的文件路径：{normalized}')
        seen.add(normalized)
        if record['deleted']:
            if target.exists():
                raise PublishDataValidationError(f'生成清单中标记为删除的文件仍然存在：{normalized}')
        elif not target.is_file():
            raise PublishDataValidationError(f'生成清单中应当存在的文件未找到：{normalized}')
        if manifest.get('schemaVersion') == 3:
            expected = {
                'deleted': record['deleted'],
                'sha256': None if record['deleted'] else record.get('sha256'),
            }
            if _file_fingerprint(target) != expected:
                raise PublishDataValidationError(
                    f'v3 生成记录中的文件内容或删除状态与生成清单不一致：{normalized}'
                )
        paths.append(target)
    validate_generation_visual_contract(manifest, date_str, repo)
    if manifest.get('schemaVersion') == 3:
        _validate_generation_input_integrity(manifest, date_str)
    return paths, manifest_path


def generation_manifest_expectations(manifest_path, date_str):
    """读取生成清单，返回各发布路径对应的预期删除状态；不核对文件内容哈希。"""
    manifest = _load_json_object(manifest_path, '生成清单')
    if manifest.get('schemaVersion') not in {1, 2, 3} or manifest.get('date') != date_str:
        raise PublishDataValidationError('生成清单的版本不受支持，或日期与目标日期不一致。')
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('生成清单必须包含非空的文件记录数组。')
    repo = Path(BLOG_REPO).expanduser().resolve()
    expectations = {}
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get('path'), str)
            or not isinstance(record.get('deleted'), bool)
        ):
            raise PublishDataValidationError('生成清单中的文件记录格式无效，或路径、删除标记不符合要求。')
        target = (repo / record['path']).resolve()
        relative = _validate_manifest_path_date(target, repo, date_str)
        if relative in expectations:
            raise PublishDataValidationError(f'生成清单中存在重复的文件路径：{relative}')
        expectations[relative] = record['deleted']
    return expectations


def validate_generation_manifest_file_bytes(manifest_path, date_str):
    """核对 v3 生成清单中的文件内容及删除状态。

    v1、v2 清单只检查版本和日期后便返回，不接受本函数的文件内容核验，
    也不会在这里升级或改写。
    """
    manifest = _load_json_object(manifest_path, '生成清单')
    if manifest.get('date') != date_str or manifest.get('schemaVersion') not in {1, 2, 3}:
        raise PublishDataValidationError('生成清单的版本不受支持，或日期与目标日期不一致。')
    if manifest.get('schemaVersion') != 3:
        return True
    repo = Path(BLOG_REPO).expanduser().resolve()
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('生成清单必须包含非空的文件记录数组。')
    seen = set()
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get('path'), str)
            or not isinstance(record.get('deleted'), bool)
        ):
            raise PublishDataValidationError('生成清单中的文件记录格式无效，或路径、删除标记不符合要求。')
        target = (repo / record['path']).resolve()
        relative = _validate_manifest_path_date(target, repo, date_str)
        if relative in seen:
            raise PublishDataValidationError(f'生成清单中存在重复的文件路径：{relative}')
        seen.add(relative)
        expected_sha = record.get('sha256')
        if record['deleted']:
            if expected_sha is not None:
                raise PublishDataValidationError(f'生成清单中标记为删除的文件，其 SHA 必须为 null：{relative}')
        elif not re.fullmatch(r'[0-9a-f]{64}', str(expected_sha or '')):
            raise PublishDataValidationError(f'生成清单中的文件 SHA 缺失或格式无效：{relative}')
        expected = {
            'deleted': record['deleted'],
            'sha256': None if record['deleted'] else expected_sha,
        }
        if _file_fingerprint(target) != expected:
            raise PublishDataValidationError(
                f'文件内容或删除状态与生成时的记录不一致：{relative}'
            )
    return True


def attest_visual_summary_assets(date_str, publish_paths, manifest_path, file_results):
    """Legacy attestation helper; review-blog no longer admits post-publication assets."""
    manifest = _load_json_object(manifest_path, '生成清单')
    records = manifest.get('files')
    if not isinstance(records, list):
        raise PublishDataValidationError('生成清单中没有文件记录')
    repo = Path(BLOG_REPO).expanduser().resolve()
    manifest_by_path = {
        record.get('path'): record for record in records if isinstance(record, dict)
    }
    pages = [
        Path(path).resolve() for path in publish_paths
        if Path(path).is_file() and not is_visual_summary_asset_path(path)
    ]
    page_urls = {}
    for page in pages:
        content = page.read_text(encoding='utf-8')
        page_urls[page] = {item['url'] for item in parse_markdown_images(content)}

    blocking = 0
    for item in publish_paths:
        asset = Path(item).resolve()
        if not is_visual_summary_asset_path(asset, date_str):
            continue
        relative = asset.relative_to(repo).as_posix()
        record = manifest_by_path.get(relative)
        if isinstance(record, dict) and record.get('deleted') is True and not asset.exists():
            continue
        result = {
            'passed': False, 'completed': True, 'failureKind': 'content',
            'blockingCount': 1, 'reviewedSha256': None,
        }
        expected_sha = record.get('sha256') if isinstance(record, dict) else None
        if (
            not isinstance(record, dict)
            or record.get('deleted') is not False
            or not re.fullmatch(r'[0-9a-f]{64}', str(expected_sha or ''))
            or not asset.is_file()
            or _sha256_file(asset) != expected_sha
        ):
            blocking += 1
            file_results[str(asset)] = result
            continue
        public_relative = relative[len('static/'):]
        expected_url = f'{BASE_PATH.rstrip("/")}/{public_relative}'
        references = [page for page, urls in page_urls.items() if expected_url in urls]
        if not references:
            blocking += 1
            file_results[str(asset)] = result
            continue
        reviewed = False
        for page in references:
            page_result = file_results.get(str(page), {})
            if (
                page_result.get('passed') is True
                and page_result.get('reviewedSha256') == _sha256_file(page)
            ):
                reviewed = True
                break
        if reviewed:
            result.update({
                'passed': True, 'failureKind': None, 'blockingCount': 0,
                'reviewedSha256': expected_sha,
            })
        else:
            # The referencing page already accounts for the blocking failure.
            result.update({'failureKind': 'transient'})
        file_results[str(asset)] = result
    return blocking


def review_tag_catalog_files(date_str, publish_paths, manifest_path, file_results):
    """按应发布的文件集合检查词表 JSON 内容、两处副本和版本记录。"""
    manifest = _load_json_object(manifest_path, 'generation manifest')
    repo = Path(BLOG_REPO).expanduser().resolve()
    records = {item['path']: item for item in manifest.get('files', [])
               if isinstance(item, dict) and isinstance(item.get('path'), str)}
    paths = [Path(item).resolve() for item in publish_paths
             if _is_tag_catalog_file_path(Path(item).resolve().relative_to(repo))]
    if not paths:
        return 0
    try:
        expected = tag_catalog_file_contents(repo)
        actual = {item.relative_to(repo).as_posix() for item in paths}
        if actual != set(expected):
            raise PublishDataValidationError('待审查的标签词表文件集合与应发布的版本文件集合不一致。')
        failure = None
    except (OSError, ValueError, UnicodeError, PublishDataValidationError) as exc:
        expected = {}
        failure = str(exc)
    blocking = 0
    for target in paths:
        relative = target.relative_to(repo).as_posix()
        record = records.get(relative, {})
        try:
            raw = target.read_bytes() if not target.is_symlink() else None
        except OSError:
            raw = None
        valid = bool(failure is None and raw is not None and raw == expected.get(relative)
                     and record.get('deleted') is False
                     and hashlib.sha256(raw).hexdigest() == record.get('sha256'))
        file_results[str(target)] = {
            'passed': valid, 'completed': True, 'failureKind': None if valid else 'content',
            'blockingCount': 0 if valid else 1,
            'reviewedSha256': record.get('sha256') if valid else None,
            'imageReviewMode': 'deterministic_only',
            'taxonomyReviewMode': 'frozen-version-bytes-v1',
        }
        blocking += not valid
    return blocking


def attest_api_reader_assets(date_str, publish_paths, manifest_path, file_results, *, preflight_only=False):
    """Bind every paper figure/sidecar to an exact reviewed page and byte record."""
    manifest = _load_json_object(manifest_path, '生成清单')
    records = manifest.get('files')
    if not isinstance(records, list):
        raise PublishDataValidationError('生成清单中没有文件记录')
    repo = Path(BLOG_REPO).expanduser().resolve()
    manifest_by_path = {
        record.get('path'): record for record in records if isinstance(record, dict)
    }
    pages = [
        Path(path).resolve() for path in publish_paths
        if Path(path).is_file() and Path(path).suffix == '.md'
    ]
    page_urls = {
        page: {item['url'] for item in parse_markdown_images(page.read_text(encoding='utf-8'))}
        for page in pages
    }
    page_frontmatter = {}
    for page in pages:
        try:
            page_frontmatter[page] = _load_frontmatter(page)[0]
        except (OSError, UnicodeError, PublishDataValidationError):
            page_frontmatter[page] = {}
    expected_sidecars = {}
    for paper in manifest.get('publishedPapers') or []:
        if not isinstance(paper, dict):
            continue
        api_reader_payload = _api_reader_payload(paper)
        v6_payload = _manual_v6_reader_payload(paper)
        reader_plan = (
            v6_payload.get('plan') if isinstance(v6_payload, dict)
            else api_reader_payload.get('plan') if isinstance(api_reader_payload, dict)
            else _manual_reader_editorial_plan(paper)
        )
        if not _researcher_workbench_eligible(v6_payload, api_reader_payload):
            continue
        if not isinstance(reader_plan, dict):
            continue
        bundle = build_researcher_workbench_bundle(
            paper, date_str, reader_plan=reader_plan,
            api_reader_payload=api_reader_payload, require_reader=True,
        )
        for sidecar_relative, sidecar_raw in bundle['sidecars'].items():
            key = sidecar_relative.as_posix()
            if key in expected_sidecars:
                raise PublishDataValidationError(f'researcher sidecar 权威路径重复: {key}')
            expected_sidecars[key] = (sidecar_raw, bundle)
    blocking = review_tag_catalog_files(date_str, publish_paths, manifest_path, file_results)
    for item in publish_paths:
        asset = Path(item).resolve()
        if not is_api_reader_asset_path(asset):
            continue
        relative = asset.relative_to(repo).as_posix()
        record = manifest_by_path.get(relative)
        if isinstance(record, dict) and record.get('deleted') is True and not asset.exists():
            continue
        result = {
            'passed': False, 'completed': True, 'failureKind': 'content',
            'blockingCount': 1, 'reviewedSha256': None,
            'imageReviewMode': 'deterministic_only',
        }
        expected_sha = record.get('sha256') if isinstance(record, dict) else None
        try:
            raw = asset.read_bytes()
        except OSError:
            raw = b''
        if is_researcher_sidecar_path(asset, date_str=date_str):
            expected = expected_sidecars.get(relative)
            page_candidates = [
                page for page, frontmatter in page_frontmatter.items()
                if frontmatter.get('paper_digest_workbench_contract')
                == RESEARCHER_WORKBENCH_CONTRACT
                and isinstance(expected, tuple)
                and frontmatter.get('paper_digest_arxiv_id')
                == expected[1]['identity']['baseId']
            ]
            valid = bool(
                isinstance(record, dict)
                and record.get('deleted') is False
                and re.fullmatch(r'[0-9a-f]{64}', str(expected_sha or ''))
                and isinstance(expected, tuple)
                and raw == expected[0]
                and hashlib.sha256(raw).hexdigest() == expected_sha
                and len(page_candidates) == 1
            )
            if valid:
                page = page_candidates[0]
                frontmatter = page_frontmatter[page]
                sidecar_record = frontmatter.get('paper_digest_sidecars', {}).get(asset.name) \
                    if isinstance(frontmatter.get('paper_digest_sidecars'), dict) else None
                expected_page_record = expected[1]['sidecarRecords'][asset.name]
                valid = (
                    sidecar_record == expected_page_record
                    and frontmatter.get('paper_digest_abstract_sha256')
                    == expected[1]['abstractSha256']
                    and (preflight_only or (
                        file_results.get(str(page), {}).get('passed') is True
                        and file_results.get(str(page), {}).get('reviewedSha256') == _sha256_file(page)
                    ))
                )
            if valid:
                result.update({
                    'passed': True, 'failureKind': None, 'blockingCount': 0,
                    'reviewedSha256': expected_sha,
                })
            else:
                blocking += 1
            file_results[str(asset)] = result
            continue
        if (
            not isinstance(record, dict)
            or record.get('deleted') is not False
            or not re.fullmatch(r'[0-9a-f]{64}', str(expected_sha or ''))
            or not raw.startswith(PNG_SIGNATURE)
            or hashlib.sha256(raw).hexdigest() != expected_sha
        ):
            blocking += 1
            file_results[str(asset)] = result
            continue
        public_url = f'{BASE_PATH.rstrip("/")}/{relative[len("static/"):]}'
        references = [page for page, urls in page_urls.items() if public_url in urls]
        reviewed_pages = [
            page for page in references
            if preflight_only or (
                file_results.get(str(page), {}).get('passed') is True
                and file_results.get(str(page), {}).get('reviewedSha256') == _sha256_file(page)
            )
        ]
        if not reviewed_pages:
            blocking += 1
            file_results[str(asset)] = result
            continue
        page_modes = {
            file_results.get(str(page), {}).get('imageReviewMode', 'deterministic_only')
            for page in reviewed_pages
        }
        result.update({
            'passed': True, 'failureKind': None, 'blockingCount': 0,
            'reviewedSha256': expected_sha,
            'imageReviewMode': (
                next(iter(page_modes)) if len(page_modes) == 1 else 'multimodal'
            ),
        })
        file_results[str(asset)] = result
    return blocking


def validate_reviewed_file_hashes(date_str, publish_paths, manifest_path, file_results):
    """核对生成时的文件状态、审查通过结果及内容哈希，拒绝缺失、变化或范围不符的发布文件。"""
    validate_generation_manifest_file_bytes(manifest_path, date_str)
    repo = Path(BLOG_REPO).expanduser().resolve()
    expectations = generation_manifest_expectations(manifest_path, date_str)
    actual_paths = set()
    for item in publish_paths:
        path, relative = _manifest_record(item, repo)
        actual_paths.add(relative)
        if relative not in expectations:
            raise PublishDataValidationError(f'发布路径未列入本次生成清单：{relative}')
        expected_deleted = expectations[relative]
        if expected_deleted:
            if path.exists():
                raise PublishDataValidationError(f'生成清单中预期删除的文件重新出现：{relative}')
            continue
        if not path.is_file():
            raise PublishDataValidationError(f'生成清单中应当存在的页面在审查期间消失：{relative}')
        result = file_results.get(str(path.resolve()), {})
        reviewed_sha = result.get('reviewedSha256')
        if result.get('passed') is not True or not re.fullmatch(r'[0-9a-f]{64}', str(reviewed_sha or '')):
            raise PublishDataValidationError(f'页面缺少有效的审查通过结果或已审内容哈希：{relative}')
        if _sha256_file(path) != reviewed_sha:
            raise PublishDataValidationError(f'页面在审查后发生变化，不能生成审查凭证：{relative}')
    if actual_paths != set(expectations):
        raise PublishDataValidationError('发布路径集合与本次生成清单不一致。')
    return True


def reusable_generation_manifest(
    date_str, input_fingerprint, template_fingerprint, base_head,
):
    """Return an identical completed generation without invalidating review state."""
    path = generation_manifest_path(date_str)
    if not path.is_file():
        return None
    try:
        manifest = _load_json_object(path, '生成清单')
        if (
            manifest.get('schemaVersion') != 3
            or manifest.get('date') != date_str
            or manifest.get('inputFingerprint') != input_fingerprint
            or manifest.get('templateFingerprint') != template_fingerprint
            or manifest.get('baseHead') != str(base_head).lower()
        ):
            return None
        _validate_generation_input_integrity(manifest, date_str)
        repo = Path(BLOG_REPO).expanduser().resolve()
        paths = []
        records = manifest.get('files')
        if not isinstance(records, list) or not records:
            return None
        seen = set()
        for record in records:
            if (
                not isinstance(record, dict)
                or not isinstance(record.get('path'), str)
                or not isinstance(record.get('deleted'), bool)
            ):
                return None
            relative = Path(record['path'])
            if relative.is_absolute():
                return None
            sha = record.get('sha256')
            if record['deleted']:
                if sha is not None:
                    return None
            elif not re.fullmatch(r'[0-9a-f]{64}', str(sha or '')):
                return None
            target = (repo / relative).resolve()
            normalized = _validate_manifest_path_date(target, repo, date_str)
            if normalized in seen:
                return None
            seen.add(normalized)
            expected = {
                'deleted': record['deleted'],
                'sha256': sha,
            }
            if _file_fingerprint(target) != expected:
                return None
            paths.append(target)
        return paths, path
    except (KeyError, TypeError, PublishDataValidationError):
        return None


def reusable_verified_publication_generation(
    date_str, input_fingerprint, template_fingerprint, current_head,
):
    """Reuse an exact already-published generation without destroying its receipt.

    The generation manifest records pre-review bytes, while the remote-verified
    receipt records the bytes that actually passed review and were committed.
    Consequently this check intentionally validates current files against the
    receipt, then validates the immutable publication commit against that same
    receipt.  It does not accept a changed input/template, a dirty manifest path,
    an unrelated commit, or a merely local/unverified review receipt.
    """
    manifest_path = generation_manifest_path(date_str)
    receipt_path = review_receipt_path(date_str)
    if not manifest_path.is_file() or not receipt_path.is_file():
        return None
    try:
        manifest = _load_json_object(manifest_path, '生成清单')
        if (
            manifest.get('schemaVersion') != 3
            or manifest.get('date') != date_str
            or manifest.get('inputFingerprint') != input_fingerprint
            or manifest.get('templateFingerprint') != template_fingerprint
        ):
            return None
        repo = Path(BLOG_REPO).expanduser().resolve()
        validate_generation_visual_contract(manifest, date_str, repo)
        validate_generation_manifest_file_bytes(manifest_path, date_str)
        _validate_generation_input_integrity(manifest, date_str)

        receipt = _load_json_object(receipt_path, '审查凭证')
        publication_commit = str(receipt.get('publicationCommit') or '').lower()
        remote_oid = str(receipt.get('remoteVerifiedOid') or '').lower()
        base_head = str(receipt.get('baseHead') or '').lower()
        protocol = str(receipt.get('reviewProtocolFingerprint') or '').lower()
        remote_name = receipt.get('remoteName')
        remote_identity = str(receipt.get('remoteIdentitySha256') or '').lower()
        remote_verified_at = receipt.get('remoteVerifiedAt')
        if not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00',
            str(remote_verified_at or ''),
        ):
            return None
        try:
            verified_time = datetime.datetime.fromisoformat(str(remote_verified_at))
        except (TypeError, ValueError):
            return None
        if (
            receipt.get('schemaVersion') != 3
            or receipt.get('date') != date_str
            or receipt.get('strictReview') is not True
            or receipt.get('hugoGate') != 'hugo'
            or receipt.get('postPublishVisuals')
            != _expected_post_publish_visuals(
                manifest, _validate_publication_scope(manifest)
            )
            or not re.fullmatch(r'[0-9a-f]{40,64}', publication_commit)
            or remote_oid != publication_commit
            or verified_time.utcoffset() != datetime.timedelta(hours=8)
            or not re.fullmatch(r'[0-9a-f]{40,64}', base_head)
            or manifest.get('baseHead') != base_head
            or protocol != review_protocol_fingerprint()
            or remote_name != GITHUB_REMOTE
            or not re.fullmatch(r'[0-9a-f]{64}', remote_identity)
            or receipt.get('generationManifestSha256') != _sha256_file(manifest_path)
            or receipt.get('generationInputIntegrity') != PUBLISHED_PAPERS_FINGERPRINT_CONTRACT
            or receipt.get('generationInputFingerprint') != manifest.get('inputFingerprint')
            or receipt.get('publishedPapersFingerprint')
            != manifest.get('publishedPapersFingerprint')
            or receipt.get('publicationMode') != manifest.get('publicationMode')
            or receipt.get('manualV6ProductionFingerprint')
            != manifest.get('manualV6ProductionFingerprint')
            or receipt.get('llmApiProductionFingerprint')
            != manifest.get('llmApiProductionFingerprint')
            or receipt.get('generationInputSourceReference')
            != manifest.get('inputSourceReference')
        ):
            return None

        expectations = generation_manifest_expectations(manifest_path, date_str)
        records = receipt.get('files')
        if not isinstance(records, list) or not records:
            return None
        paths = []
        seen = set()
        for record in records:
            if (
                not isinstance(record, dict)
                or not isinstance(record.get('path'), str)
                or not isinstance(record.get('deleted'), bool)
            ):
                return None
            relative = Path(record['path'])
            if relative.is_absolute():
                return None
            target = (repo / relative).resolve()
            normalized = _validate_manifest_path_date(target, repo, date_str)
            if normalized in seen or normalized not in expectations:
                return None
            seen.add(normalized)
            deleted = record['deleted']
            sha = record.get('sha256')
            if expectations[normalized] != deleted:
                return None
            if deleted:
                if sha is not None:
                    return None
            elif not re.fullmatch(r'[0-9a-f]{64}', str(sha or '')):
                return None
            if _file_fingerprint(target) != {'deleted': deleted, 'sha256': sha}:
                return None
            paths.append(target)
        if seen != set(expectations):
            return None

        if current_head != publication_commit:
            return None
        current_remote_identity, _identity_error = _remote_identity_sha256()
        if current_remote_identity != remote_identity:
            return None
        current_remote_oid, _remote_error = _remote_main_oid()
        if current_remote_oid != publication_commit:
            return None
        validate_git_commit_against_review_receipt(receipt, paths, publication_commit)
        validate_manifest_clean_against_head(paths)
        return paths, manifest_path, receipt_path
    except (
        KeyError, TypeError, ValueError, OSError, UnicodeError,
        subprocess.CalledProcessError, PublishDataValidationError,
    ):
        return None


def reusable_verified_publication_review(date_str, current_head):
    """Return a still-current remote publication receipt for review idempotence."""
    manifest_path = generation_manifest_path(date_str)
    try:
        manifest = _load_json_object(manifest_path, '生成清单')
        input_fingerprint = manifest.get('inputFingerprint')
        template_fingerprint = manifest.get('templateFingerprint')
        if not re.fullmatch(r'[0-9a-f]{64}', str(input_fingerprint or '')):
            return None
        if not re.fullmatch(r'[0-9a-f]{64}', str(template_fingerprint or '')):
            return None
    except (OSError, UnicodeError, PublishDataValidationError):
        return None
    return reusable_verified_publication_generation(
        date_str, input_fingerprint, template_fingerprint, current_head,
    )


def has_publication_evidence_for_generation(
    date_str, input_fingerprint=None, template_fingerprint=None,
):
    """Detect publication evidence that must never be silently overwritten.

    This deliberately treats an unreadable same-date receipt as evidence when
    the generation itself still matches.  A network outage, changed remote, or
    damaged receipt must stop the stage and preserve the only possible remote
    attestation for operator inspection.
    """
    manifest_path = generation_manifest_path(date_str)
    receipt_path = review_receipt_path(date_str)
    if not manifest_path.is_file() or not receipt_path.exists():
        return False
    try:
        receipt = _load_json_object(receipt_path, '审查凭证')
    except (OSError, UnicodeError, PublishDataValidationError):
        # An unreadable same-date receipt may be the only surviving publication
        # attestation. Never erase it from a generation path.
        return True
    if any(receipt.get(field) for field in (
        'publicationCommit', 'remoteVerifiedOid', 'remoteVerifiedAt',
        'remoteIdentitySha256',
    )):
        # Published v1/v2/v3 evidence is immutable history. Exact modern v3
        # reuse is handled earlier; every other same-date generation must stop.
        return True
    try:
        manifest = _load_json_object(manifest_path, '生成清单')
    except (OSError, UnicodeError, PublishDataValidationError):
        return True
    if manifest.get('schemaVersion') != 3 or manifest.get('date') != date_str:
        return False
    if input_fingerprint is not None and manifest.get('inputFingerprint') != input_fingerprint:
        return False
    if template_fingerprint is not None and manifest.get('templateFingerprint') != template_fingerprint:
        return False
    return False


def save_review_receipt(
    date_str, publish_paths, hugo_gate, expected_base_head=None,
    generation_manifest=None, reviewed_results=None, manual_review_record=None,
):
    """保存已审文件及本次生成清单的对应记录，供后续推送核验。"""
    if generation_manifest is None:
        raise PublishDataValidationError('签发审查凭证时必须提供本次生成清单。')
    if reviewed_results is None:
        raise PublishDataValidationError('签发审查凭证时必须提供各文件的审查结果及已审内容哈希。')
    current_protocol = review_protocol_fingerprint()
    for result in reviewed_results.values():
        if result.get('passed') is True:
            # A page pass is content-addressed, not protocol-addressed.  The
            # current batch receipt records the current protocol while exact
            # unchanged bytes retain their prior pass.
            result['reviewProtocolFingerprint'] = current_protocol
    validate_generation_manifest_file_bytes(generation_manifest, date_str)
    save_review_pass_cache(date_str, publish_paths, reviewed_results)
    pass_records = _collect_review_pass_records(date_str)
    validate_reviewed_file_hashes(
        date_str, publish_paths, generation_manifest, reviewed_results,
    )
    repo = Path(BLOG_REPO).expanduser().resolve()
    expectations = (
        generation_manifest_expectations(generation_manifest, date_str)
        if generation_manifest is not None else None
    )
    files = []
    for item in sorted({Path(value).expanduser().resolve() for value in publish_paths}):
        path, relative = _manifest_record(item, repo)
        expected_deleted = expectations.get(relative) if expectations is not None else not path.is_file()
        if expectations is not None and relative not in expectations:
            raise PublishDataValidationError(f'审查文件的路径不在本次生成清单中：{relative}')
        exists = path.is_file()
        if expected_deleted and exists:
            raise PublishDataValidationError(f'本次生成清单要求删除的文件重新出现：{relative}')
        if not expected_deleted and not exists:
            raise PublishDataValidationError(f'本次生成清单要求存在的页面在审查期间消失：{relative}')
        reviewed_sha = (
            None if expected_deleted
            else reviewed_results.get(str(path.resolve()), {}).get('reviewedSha256')
        )
        actual_sha = _sha256_file(path) if exists else None
        if not expected_deleted and actual_sha != reviewed_sha:
            raise PublishDataValidationError(f'页面内容在审查凭证签发时发生变化：{relative}')
        files.append({
            'path': relative,
            'deleted': expected_deleted,
            'sha256': reviewed_sha,
            'reviewProtocolFingerprint': (
                None if expected_deleted else pass_records.get(
                    (relative, reviewed_sha), {}
                ).get('reviewProtocolFingerprint')
            ),
            'imageReviewMode': (
                None if expected_deleted else pass_records.get(
                    (relative, reviewed_sha), {}
                ).get('imageReviewMode', 'deterministic_only')
            ),
        })
    if expectations is not None and {record['path'] for record in files} != set(expectations):
        raise PublishDataValidationError('审查文件的路径集合与本次生成清单不一致。')
    current_head = validate_git_publish_branch()
    if expected_base_head is not None and current_head != str(expected_base_head).lower():
        raise PublishDataValidationError(
            '审查期间博客仓库的 main 基线发生变化，不能签发审查凭证。'
        )
    file_image_modes = {
        record['imageReviewMode'] for record in files if not record['deleted']
    }
    aggregate_image_mode = (
        next(iter(file_image_modes)) if len(file_image_modes) == 1
        else ('mixed' if file_image_modes else 'deterministic_only')
    )
    generation_payload = _load_json_object(generation_manifest, '生成清单')
    generation_schema = generation_payload.get('schemaVersion')
    publication_scope_value = _validate_active_publication_scope(generation_payload)
    if generation_schema == 3:
        validate_generation_visual_contract(generation_payload, date_str, repo)
        generation_input_fingerprint_value, published_snapshot_fingerprint = (
            _validate_generation_input_integrity(generation_payload, date_str)
        )
    else:
        generation_input_fingerprint_value = None
        published_snapshot_fingerprint = None
    publication_mode = generation_payload.get('publicationMode')
    post_publish_visuals = _expected_post_publish_visuals(
        generation_payload, publication_scope_value,
    )
    receipt = {
        'schemaVersion': 3,
        'date': validate_publish_date(date_str),
        'reviewedAt': datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat(),
        'strictReview': True,
        'imageReview': {
            'mode': aggregate_image_mode,
            'secondaryModelConfigured': current_image_review_mode() == 'multimodal',
        },
        'hugoGate': hugo_gate,
        'baseHead': current_head,
        'reviewProtocolFingerprint': review_protocol_fingerprint(),
        'generationManifestSha256': (
            _sha256_file(generation_manifest) if generation_manifest is not None else None
        ),
        'generationInputIntegrity': (
            PUBLISHED_PAPERS_FINGERPRINT_CONTRACT if generation_schema == 3 else None
        ),
        'generationInputFingerprint': generation_input_fingerprint_value,
        'publishedPapersFingerprint': published_snapshot_fingerprint,
        'generationInputSourceReference': (
            generation_payload.get('inputSourceReference')
            if generation_schema == 3 else None
        ),
        # Explicitly bind whether this reviewed generation can enter the modern
        # post-publication visual state machine. The generation SHA remains the
        # cryptographic source of truth; this field makes maintenance intent
        # visible to push/status tooling.
        'postPublishVisuals': post_publish_visuals,
        'publicationMode': publication_mode,
        'manualV6ProductionFingerprint': generation_payload.get(
            'manualV6ProductionFingerprint'
        ),
        'llmApiProductionFingerprint': generation_payload.get(
            'llmApiProductionFingerprint'
        ),
        'publicationScope': publication_scope_value,
        'files': files,
    }
    if manual_review_record is not None:
        if not isinstance(manual_review_record, dict):
            raise PublishDataValidationError('人工审查记录必须是对象。')
        manual_review_record_copy = dict(manual_review_record)
        manual_review_record_copy.setdefault('generationManifestSha256', receipt['generationManifestSha256'])
        manual_review_record_copy.setdefault('baseHead', current_head)
        manual_review_record_copy.setdefault('fileCount', len(files))
        manual_review_record_copy.setdefault('reviewedPathSetSha256', _reviewed_path_set_sha256(files))
        manual_review_record_copy.setdefault('reviewProtocolFingerprint', receipt['reviewProtocolFingerprint'])
        receipt['reviewMode'] = MANUAL_REVIEW_MODE
        receipt['reviewProvenance'] = manual_review_record_copy
        manual_review_error = _manual_review_record_error(
            receipt,
            date_str=date_str,
            generation_manifest_sha256=receipt['generationManifestSha256'],
            expected_base_head=current_head,
        )
        if manual_review_error:
            raise PublishDataValidationError(manual_review_error)
    path = review_receipt_path(date_str)
    atomic_write_json(path, receipt, ensure_ascii=False, indent=2)
    return path


def _valid_review_pass_record(record, repo, date_str, default_protocol=None, default_time=None):
    """Normalize one historical file-level pass without trusting batch metadata."""
    if not isinstance(record, dict) or not isinstance(record.get('path'), str):
        return None
    sha256 = record.get('reviewedSha256') or record.get('sha256')
    if record.get('deleted') is True or not re.fullmatch(r'[0-9a-f]{64}', str(sha256 or '')):
        return None
    relative = Path(record['path'])
    if relative.is_absolute():
        return None
    try:
        target = (repo / relative).resolve()
        normalized = _validate_manifest_path_date(target, repo, date_str)
    except (OSError, ValueError, PublishDataValidationError):
        return None
    protocol = record.get('reviewProtocolFingerprint') or default_protocol
    if protocol is not None and not re.fullmatch(r'[0-9a-f]{64}', str(protocol)):
        protocol = None
    reviewed_at = record.get('reviewedAt') or default_time
    image_review_mode = record.get('imageReviewMode')
    if image_review_mode not in {'multimodal', 'deterministic_only', 'manual_semantic'}:
        image_review_mode = 'deterministic_only'
    return {
        'path': normalized,
        'sha256': str(sha256),
        'reviewedAt': reviewed_at if isinstance(reviewed_at, str) else None,
        'reviewProtocolFingerprint': protocol,
        'imageReviewMode': image_review_mode,
    }


def _collect_review_pass_records(date_str):
    """Collect passes by path plus exact bytes, preferring the durable cache."""
    date_str = validate_publish_date(date_str)
    repo = Path(BLOG_REPO).expanduser().resolve()
    collected = {}
    sources = (
        (review_pass_cache_path(date_str), {1}, None),
        (review_receipt_path(date_str), {3}, 'reviewedAt'),
        (review_failure_path(date_str), {1, 2, 3}, 'savedAt'),
    )
    for source_path, schemas, time_field in sources:
        try:
            payload = json.loads(source_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if (
            not isinstance(payload, dict)
            or payload.get('schemaVersion') not in schemas
            or payload.get('date') != date_str
            or not isinstance(payload.get('files'), list)
        ):
            continue
        if source_path == review_receipt_path(date_str) and payload.get('strictReview') is not True:
            continue
        default_protocol = payload.get('reviewProtocolFingerprint')
        default_time = payload.get(time_field) if time_field else payload.get('updatedAt')
        for raw_record in payload['files']:
            if not isinstance(raw_record, dict):
                continue
            if source_path == review_failure_path(date_str) and raw_record.get('passed') is not True:
                continue
            record = _valid_review_pass_record(
                raw_record, repo, date_str,
                default_protocol=default_protocol,
                default_time=default_time,
            )
            if record is not None:
                # The dedicated cache is first and may contain metadata rebound
                # for the current batch.  Older receipt/failure snapshots must
                # not overwrite that record for the same content address.
                collected.setdefault((record['path'], record['sha256']), record)
    return collected


def save_review_page_checkpoint(
    date_str, page_path, result, manifest_path, base_head,
    manifest_sha256=None,
):
    """Persist one worker result without scanning or rewriting the whole batch."""
    date_str = validate_publish_date(date_str)
    repo = Path(BLOG_REPO).expanduser().resolve()
    page, relative = _manifest_record(Path(page_path).expanduser().resolve(), repo)
    _validate_manifest_path_date(page, repo, date_str)
    if not isinstance(result, dict):
        raise PublishDataValidationError(f'review worker 结果不是对象: {relative}')
    fingerprint = _file_fingerprint(page)
    if fingerprint['deleted']:
        raise PublishDataValidationError(f'review worker 返回后页面已消失: {relative}')
    reviewed_sha = result.get('reviewedSha256')
    passed = result.get('passed') is True
    if passed and (
        not re.fullmatch(r'[0-9a-f]{64}', str(reviewed_sha or ''))
        or fingerprint['sha256'] != reviewed_sha
    ):
        raise PublishDataValidationError(f'review worker 返回后页面字节已变化: {relative}')
    failure_kind = result.get('failureKind')
    if failure_kind not in {None, 'pending', 'content', 'transient'}:
        raise PublishDataValidationError(f'review worker failureKind 非法: {relative}')
    protocol = result.get('reviewProtocolFingerprint')
    if not re.fullmatch(r'[0-9a-f]{64}', str(protocol or '')):
        protocol = review_protocol_fingerprint()
    normalized_result = {
        'passed': passed,
        'completed': bool(result.get('completed', False)),
        'failureKind': None if passed else (failure_kind or 'pending'),
        'blockingCount': int(result.get('blockingCount') or 0),
        'issues': list(result.get('issues') or []),
        'reviewedSha256': reviewed_sha if passed else None,
        'reviewProtocolFingerprint': protocol,
        'imageReviewMode': (
            result.get('imageReviewMode')
            if result.get('imageReviewMode') in {
                'multimodal', 'deterministic_only', 'manual_semantic',
            }
            else current_image_review_mode()
        ),
    }
    if manifest_sha256 is None:
        manifest_sha256 = _sha256_file(manifest_path)
    if not re.fullmatch(r'[0-9a-f]{64}', str(manifest_sha256 or '')):
        raise PublishDataValidationError('逐页 review checkpoint 的 generation manifest SHA 非法')
    payload = {
        'schemaVersion': 1,
        'date': date_str,
        'path': relative,
        'sha256': fingerprint['sha256'],
        'generationManifestSha256': manifest_sha256,
        'baseHead': str(base_head).lower(),
        'savedAt': datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat(),
        'result': normalized_result,
    }
    checkpoint = _review_page_checkpoint_path(date_str, relative)
    atomic_write_json(checkpoint, payload, ensure_ascii=False, indent=2, mode=0o600)
    return checkpoint


def _collect_review_page_checkpoints(date_str):
    """Load valid per-page checkpoints once; stale bytes are filtered by planner."""
    date_str = validate_publish_date(date_str)
    repo = Path(BLOG_REPO).expanduser().resolve()
    directory = review_page_checkpoint_dir(date_str)
    collected = {}
    if not directory.is_dir():
        return collected
    for checkpoint in sorted(directory.glob('*.json')):
        try:
            payload = json.loads(checkpoint.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if (
            not isinstance(payload, dict)
            or payload.get('schemaVersion') != 1
            or payload.get('date') != date_str
            or not isinstance(payload.get('path'), str)
            or not re.fullmatch(r'[0-9a-f]{64}', str(payload.get('sha256') or ''))
            or not isinstance(payload.get('result'), dict)
        ):
            continue
        relative = Path(payload['path'])
        if relative.is_absolute() or '..' in relative.parts:
            continue
        target = (repo / relative).resolve()
        try:
            normalized = _validate_manifest_path_date(target, repo, date_str)
        except PublishDataValidationError:
            continue
        result = payload['result']
        if (
            not isinstance(result.get('passed'), bool)
            or not isinstance(result.get('completed'), bool)
            or result.get('failureKind') not in {None, 'pending', 'content', 'transient'}
        ):
            continue
        collected[normalized] = {
            'deleted': False,
            'sha256': payload['sha256'],
            **result,
        }
    return collected


def clear_review_page_checkpoints(date_str):
    """Remove only this date's completed transient worker shards."""
    directory = review_page_checkpoint_dir(date_str)
    if not directory.is_dir():
        return
    for path in directory.glob('*.json'):
        path.unlink(missing_ok=True)
    try:
        directory.rmdir()
    except OSError:
        pass


def save_review_pass_cache(date_str, publish_paths=(), file_results=None):
    """Persist successful per-file review evidence independently of batch changes."""
    date_str = validate_publish_date(date_str)
    records = _collect_review_pass_records(date_str)
    file_results = file_results or {}
    repo = Path(BLOG_REPO).expanduser().resolve()
    now = datetime.datetime.now(
        datetime.timezone(datetime.timedelta(hours=8))
    ).isoformat()
    current_protocol = None
    for item in {Path(value).expanduser().resolve() for value in publish_paths}:
        result = file_results.get(str(item), {})
        if result.get('passed') is not True or not item.is_file():
            continue
        reviewed_sha = result.get('reviewedSha256')
        if (
            not re.fullmatch(r'[0-9a-f]{64}', str(reviewed_sha or ''))
            or _sha256_file(item) != reviewed_sha
        ):
            continue
        _path, relative = _manifest_record(item, repo)
        protocol = result.get('reviewProtocolFingerprint')
        if not re.fullmatch(r'[0-9a-f]{64}', str(protocol or '')):
            if current_protocol is None:
                current_protocol = review_protocol_fingerprint()
            protocol = current_protocol
        record = {
            'path': relative,
            'sha256': reviewed_sha,
            'reviewedAt': now,
            'reviewProtocolFingerprint': protocol,
            'imageReviewMode': (
                result.get('imageReviewMode')
                if result.get('imageReviewMode') in {'multimodal', 'deterministic_only', 'manual_semantic'}
                else current_image_review_mode()
            ),
        }
        records[(relative, reviewed_sha)] = record
    if not records:
        return None
    payload = {
        'schemaVersion': 1,
        'date': date_str,
        'updatedAt': now,
        'files': sorted(records.values(), key=lambda value: (value['path'], value['sha256'])),
    }
    path = review_pass_cache_path(date_str)
    atomic_write_json(path, payload, ensure_ascii=False, indent=2, mode=0o600)
    return path


def save_review_failure_state(
    date_str,
    publish_paths,
    manifest_path,
    base_head,
    file_results,
    *, batch_issues=None,
):
    """Persist per-file failed-review evidence for a safe incremental retry."""
    save_review_pass_cache(date_str, publish_paths, file_results)
    repo = Path(BLOG_REPO).expanduser().resolve()
    records = []
    current_protocol = review_protocol_fingerprint()
    for item in sorted({Path(value).expanduser().resolve() for value in publish_paths}):
        path, relative = _manifest_record(item, repo)
        result = file_results.get(str(path.resolve()), {})
        fingerprint = _file_fingerprint(path)
        reviewed_sha = result.get('reviewedSha256')
        result_passed = bool(result.get('passed', False))
        if result_passed and (
            fingerprint['deleted']
            or not re.fullmatch(r'[0-9a-f]{64}', str(reviewed_sha or ''))
            or fingerprint['sha256'] != reviewed_sha
        ):
            result_passed = False
        records.append({
            'path': relative,
            **fingerprint,
            'passed': result_passed if not fingerprint['deleted'] else True,
            'completed': bool(result.get('completed', False)) if not fingerprint['deleted'] else True,
            'issues': list(result.get('issues') or []),
            'failureKind': (
                None if result_passed or fingerprint['deleted']
                else result.get('failureKind') or 'pending'
            ),
            'reviewedSha256': reviewed_sha if result_passed else None,
            'imageReviewMode': (
                result.get('imageReviewMode')
                if result.get('imageReviewMode') in {'multimodal', 'deterministic_only', 'manual_semantic'}
                else current_image_review_mode()
            ),
            'reviewProtocolFingerprint': (
                result.get('reviewProtocolFingerprint')
                if re.fullmatch(
                    r'[0-9a-f]{64}', str(result.get('reviewProtocolFingerprint') or '')
                ) else current_protocol
            ),
        })
    state = {
        'schemaVersion': 3,
        'date': validate_publish_date(date_str),
        'baseHead': str(base_head).lower(),
        'generationManifestSha256': _sha256_file(manifest_path),
        'reviewProtocolFingerprint': current_protocol,
        'savedAt': datetime.datetime.now(
            datetime.timezone(datetime.timedelta(hours=8))
        ).isoformat(),
        'files': records,
        'issues': list(batch_issues or []),
    }
    path = review_failure_path(date_str)
    atomic_write_json(path, state, ensure_ascii=False, indent=2, mode=0o600)
    review_receipt_path(date_str).unlink(missing_ok=True)
    return path


def plan_incremental_review(date_str, publish_paths, manifest_path, base_head):
    """Reuse exact passed bytes and select only new, changed, or failed pages."""
    state_path = review_failure_path(date_str)
    repo = Path(BLOG_REPO).expanduser().resolve()
    ordered_paths = sorted({Path(value).expanduser().resolve() for value in publish_paths})
    full = {
        'mode': 'full',
        'paths': [path for path in ordered_paths if path.is_file()],
        'priorResults': {},
        'unchangedFailed': [],
        'reusedPassed': 0,
        'reason': None,
    }
    pass_records = _collect_review_pass_records(date_str)
    page_checkpoints = _collect_review_page_checkpoints(date_str)
    failed_records = {}
    current_protocol = review_protocol_fingerprint()
    evidence_exists = bool(pass_records or page_checkpoints)
    state_error = None
    try:
        if state_path.is_file():
            state = json.loads(state_path.read_text(encoding='utf-8'))
            if state.get('schemaVersion') not in {1, 2, 3} or state.get('date') != date_str:
                raise ValueError('失败状态版本或日期不匹配')
            records = state.get('files')
            if not isinstance(records, list):
                raise ValueError('失败状态缺少文件记录')
            for record in records:
                if not isinstance(record, dict) or not isinstance(record.get('path'), str):
                    raise ValueError('失败状态文件记录格式非法')
                if record.get('passed') is True:
                    continue
                relative = Path(record['path'])
                if relative.is_absolute():
                    raise ValueError('失败状态包含非法绝对路径')
                target = (repo / relative).resolve()
                normalized = _validate_manifest_path_date(target, repo, date_str)
                if state.get('schemaVersion') in {2, 3} and (
                    not isinstance(record.get('completed'), bool)
                    or record.get('failureKind') not in {None, 'pending', 'content', 'transient'}
                ):
                    raise ValueError('失败状态完成标记或失败类型非法')
                normalized_record = dict(record)
                if not re.fullmatch(
                    r'[0-9a-f]{64}',
                    str(normalized_record.get('reviewProtocolFingerprint') or ''),
                ):
                    normalized_record['reviewProtocolFingerprint'] = state.get(
                        'reviewProtocolFingerprint'
                    )
                failed_records[normalized] = normalized_record
            evidence_exists = True
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
        state_error = str(exc)
        failed_records = {}

    try:
        expectations = generation_manifest_expectations(manifest_path, date_str)
        current_relatives = {
            _manifest_record(item, repo)[1] for item in ordered_paths
        }
        if current_relatives != set(expectations):
            raise ValueError('发布路径集合与 generation manifest 不一致')
        selected = []
        unchanged_failed = []
        prior_results = {}
        reused_passed = 0
        for item in ordered_paths:
            _path, relative = _manifest_record(item, repo)
            current = _file_fingerprint(item)
            if current['deleted']:
                continue
            cached = pass_records.get((relative, current['sha256']))
            checkpoint = page_checkpoints.get(relative)
            if (
                cached is None
                and checkpoint is not None
                and checkpoint.get('sha256') == current['sha256']
                and checkpoint.get('passed') is True
                and checkpoint.get('reviewedSha256') == current['sha256']
            ):
                cached = {
                    'reviewProtocolFingerprint': checkpoint.get(
                        'reviewProtocolFingerprint'
                    ),
                    'imageReviewMode': checkpoint.get(
                        'imageReviewMode', 'deterministic_only'
                    ),
                }
            key = str(item.resolve())
            if cached is not None:
                prior_results[key] = {
                    'passed': True, 'completed': True, 'failureKind': None,
                    'reviewedSha256': current['sha256'],
                    # Review evidence is permanently content-addressed.  A
                    # batch manifest or implementation fingerprint change
                    # must not invalidate unchanged file bytes.
                    'reviewProtocolFingerprint': current_protocol,
                    'imageReviewMode': cached.get('imageReviewMode', 'deterministic_only'),
                }
                reused_passed += 1
                continue
            record = (
                checkpoint
                if checkpoint is not None and checkpoint.get('sha256') == current['sha256']
                else failed_records.get(relative)
            )
            if record is None:
                selected.append(item.resolve())
                continue
            if not isinstance(record, dict) or not isinstance(record.get('passed'), bool):
                raise ValueError('失败状态文件记录格式非法')
            recorded = {
                'deleted': record.get('deleted') is True,
                'sha256': record.get('sha256'),
            }
            failure_kind = record.get('failureKind') or (
                'content' if record.get('completed', True) else 'pending'
            )
            if failure_kind == 'content':
                # Older checkpoints classified absolute image-download
                # deadlines as content failures. Re-evaluate their recorded
                # issue with the current classifier so unchanged page bytes
                # can retry the transport failure without inventing an edit.
                if classify_review_failure(record.get('issues') or []) == 'transient':
                    failure_kind = 'transient'
            if (
                current == recorded
                and failure_kind == 'content'
            ):
                unchanged_failed.append(item.resolve())
                prior_results[key] = {
                    'passed': False, 'completed': True, 'failureKind': 'content',
                    'issues': list(record.get('issues') or []),
                }
            else:
                selected.append(item.resolve())
        return {
            'mode': 'incremental' if evidence_exists else 'full',
            'paths': selected,
            'priorResults': prior_results,
            'unchangedFailed': unchanged_failed,
            'reusedPassed': reused_passed,
            'reason': state_error,
        }
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError, TypeError) as exc:
        full['reason'] = str(exc)
        return full


def load_verified_review_receipt(date_str):
    """读取严格审查凭证，并逐项核对当前博客文件的内容哈希。"""
    path = review_receipt_path(date_str)
    if not path.is_file():
        raise PublishDataValidationError(
            f'缺少已通过审查的发布凭证：{path}；请先运行审查，且不传 --push。'
        )
    try:
        receipt = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'审查凭证无法解析: {path}') from exc
    if receipt.get('schemaVersion') != 3 or receipt.get('date') != date_str:
        raise PublishDataValidationError('审查凭证版本或日期不匹配')
    if receipt.get('strictReview') is not True:
        raise PublishDataValidationError('发布凭证未标明已通过严格审查。')
    if receipt.get('hugoGate') != 'hugo':
        raise PublishDataValidationError('发布凭证未记录通过 Hugo 构建检查。')
    if receipt.get('reviewProtocolFingerprint') != review_protocol_fingerprint():
        raise PublishDataValidationError(
            '当前审查协议已变化；请重新运行审查，复用内容未变页面的通过记录，并重新签发本批发布凭证。'
        )
    manifest_path = generation_manifest_path(date_str)
    expected_manifest_sha = receipt.get('generationManifestSha256')
    if (
        not re.fullmatch(r'[0-9a-f]{64}', str(expected_manifest_sha or ''))
        or not manifest_path.is_file()
        or _sha256_file(manifest_path) != expected_manifest_sha
    ):
        raise PublishDataValidationError('发布凭证中的生成清单 SHA 格式无效，或对应清单缺失、内容已变化。')
    manual_review_error = _manual_review_record_error(
        receipt,
        date_str=date_str,
        generation_manifest_sha256=expected_manifest_sha,
        expected_base_head=receipt.get('baseHead'),
    )
    if manual_review_error:
        raise PublishDataValidationError(manual_review_error)
    try:
        generation_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError('生成清单无法解析。') from exc
    validate_current_generation_template(generation_manifest)
    publication_scope_value = _validate_active_publication_scope(generation_manifest)
    validate_generation_visual_contract(generation_manifest, date_str)
    validate_generation_manifest_file_bytes(manifest_path, date_str)
    if generation_manifest.get('schemaVersion') == 3:
        _validate_generation_input_integrity(generation_manifest, date_str)
    if generation_manifest.get('schemaVersion') == 3 and (
        receipt.get('generationInputIntegrity') != PUBLISHED_PAPERS_FINGERPRINT_CONTRACT
        or receipt.get('generationInputFingerprint') != generation_manifest.get('inputFingerprint')
        or receipt.get('publishedPapersFingerprint')
        != generation_manifest.get('publishedPapersFingerprint')
        or receipt.get('generationInputSourceReference')
        != generation_manifest.get('inputSourceReference')
    ):
        raise PublishDataValidationError('发布凭证中的生成输入核验记录不符合要求，或与本次生成清单不一致。')
    if (
        receipt.get('publicationMode') != generation_manifest.get('publicationMode')
        or receipt.get('manualV6ProductionFingerprint')
        != generation_manifest.get('manualV6ProductionFingerprint')
        or receipt.get('llmApiProductionFingerprint')
        != generation_manifest.get('llmApiProductionFingerprint')
    ):
        raise PublishDataValidationError('发布凭证中的发布模式或正式生成记录与本次生成清单不一致。')
    expected_visual_capability = _expected_post_publish_visuals(
        generation_manifest, publication_scope_value,
    )
    receipt_visual_capability = receipt.get('postPublishVisuals')
    if (
        receipt_visual_capability is not None
        and receipt_visual_capability != expected_visual_capability
    ):
        raise PublishDataValidationError('发布凭证中的发布后图片任务设置与本次生成清单不一致。')
    if receipt.get('publicationScope') != publication_scope_value:
        raise PublishDataValidationError('发布凭证中的发布范围与本次生成清单不一致。')
    expectations = generation_manifest_expectations(manifest_path, date_str)
    records = receipt.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('审查凭证没有发布文件清单')
    file_image_modes = {
        record.get('imageReviewMode') for record in records
        if isinstance(record, dict) and record.get('deleted') is not True
    }
    if not file_image_modes or not file_image_modes.issubset({'multimodal', 'deterministic_only', 'manual_semantic'}):
        raise PublishDataValidationError('发布凭证中的逐文件图片审查方式不符合要求。')
    expected_image_mode = (
        next(iter(file_image_modes)) if len(file_image_modes) == 1 else 'mixed'
    )
    image_review = receipt.get('imageReview')
    if (
        not isinstance(image_review, dict)
        or image_review.get('mode') != expected_image_mode
        or not isinstance(image_review.get('secondaryModelConfigured'), bool)
    ):
        raise PublishDataValidationError('发布凭证中的图片审查汇总格式无效，或与逐文件审查记录不一致。')

    repo = Path(BLOG_REPO).expanduser().resolve()
    paths = []
    seen = set()
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('path'), str):
            raise PublishDataValidationError('发布凭证中的文件记录格式无效，或文件路径不是字符串。')
        relative = Path(record['path'])
        if relative.is_absolute():
            raise PublishDataValidationError(f'审查凭证包含非法路径: {relative}')
        target = (repo / relative).resolve()
        key = _validate_manifest_path_date(target, repo, date_str)
        if key in seen:
            raise PublishDataValidationError(f'审查凭证包含重复路径: {key}')
        seen.add(key)
        if key not in expectations or expectations[key] != (record.get('deleted') is True):
            raise PublishDataValidationError(f'发布凭证中的文件路径或删除标记与本次生成清单不一致：{key}')
        if record.get('deleted') is True:
            if target.exists():
                raise PublishDataValidationError(f'审查后，已确认删除的文件重新出现：{key}')
        else:
            expected = record.get('sha256')
            if not target.is_file() or not re.fullmatch(r'[0-9a-f]{64}', str(expected or '')):
                raise PublishDataValidationError(f'已审文件缺失，或凭证中的内容哈希格式无效：{key}')
            evidence_protocol = record.get('reviewProtocolFingerprint')
            if evidence_protocol != receipt.get('reviewProtocolFingerprint'):
                raise PublishDataValidationError(
                    f'逐文件凭证中的审查协议指纹与本批发布凭证不一致：{key}'
                )
            actual = _sha256_file(target)
            if actual != expected:
                raise PublishDataValidationError(f'文件内容在审查后发生变化，不能推送：{key}')
        paths.append(target)
    if seen != set(expectations):
        raise PublishDataValidationError('发布凭证中的文件集合与本次生成清单不一致。')
    if receipt.get('reviewMode') == MANUAL_REVIEW_MODE:
        manual_review_record = receipt['reviewProvenance']
        if manual_review_record.get('fileCount') != len(records):
            raise PublishDataValidationError('人工审查记录中的文件数量与发布凭证不一致。')
        if manual_review_record.get('reviewedPathSetSha256') != _reviewed_path_set_sha256(records):
            raise PublishDataValidationError('人工审查记录中的文件集合哈希与发布凭证不一致。')
        if manual_review_record.get('reviewProtocolFingerprint') != receipt.get('reviewProtocolFingerprint'):
            raise PublishDataValidationError('人工审查记录中的审查协议指纹与发布凭证不一致。')
    return paths, path


def exclude_papers_for_publish(papers, excluded_ids):
    """Exclude explicitly named papers while failing closed on typos or stale IDs."""
    normalized_excluded = {
        normalize_publish_arxiv_id(value) for value in (excluded_ids or [])
    }
    if not normalized_excluded:
        return list(papers), []
    available = {
        normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        for paper in papers
    }
    missing = sorted(normalized_excluded - available)
    if missing:
        raise PublishDataValidationError(
            f'--exclude-id 未命中当前发布批次: {", ".join(missing)}'
        )
    kept = [
        paper for paper in papers
        if normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        not in normalized_excluded
    ]
    return kept, sorted(normalized_excluded)


def include_single_paper_for_publish(papers, include_id):
    """Select exactly one paper and reject aliases that collide after normalization."""
    if include_id is None:
        return list(papers), None
    normalized_include = normalize_publish_arxiv_id(include_id)
    matches = [
        paper for paper in papers
        if normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        == normalized_include
    ]
    if not matches:
        raise PublishDataValidationError(
            f'--include-id 未命中当前发布批次: {normalized_include}'
        )
    if len(matches) != 1:
        raise PublishDataValidationError(
            f'--include-id 在当前发布批次命中重复规范化 ID: {normalized_include}'
        )
    return matches, normalized_include


def parse_generation_args(argv=None):
    """Strictly parse generation-only CLI arguments.

    Single-value flags use ``append`` so duplicate values cannot silently let
    the last spelling win. ``--exclude-id`` is intentionally repeatable;
    ``--include-id`` uses append only to detect and reject duplicate spellings.
    """
    parser = argparse.ArgumentParser(
        prog=Path(sys.argv[0]).name,
        description='生成并写入博客页面及本批次生成清单。本入口不执行审查或推送。',
        allow_abbrev=False,
    )
    parser.add_argument('data_file', nargs='?', help='可选的深度分析 JSON 文件')
    parser.add_argument('--date', action='append', metavar='YYYY-MM-DD')
    parser.add_argument('--category', action='append')
    parser.add_argument('--exclude-id', action='append', default=[], metavar='ARXIV_ID')
    parser.add_argument('--include-id', action='append', default=[], metavar='ARXIV_ID')
    parser.add_argument('--sealed-tutorial-preview', action='count', default=0,
                        help='只把通过核验的单篇教程预览包中的 post.md 按原始字节写入博客。')
    parser.add_argument('--legacy-v5-maintenance', action='count', default=0,
                        help='显式读取旧 v5 分析记录进行维护。本开关不用于默认日更，生成过程仍会写入博客文件。')
    parser.add_argument('--all', action='count', default=0)
    parser.add_argument('--skip-push', action='count', default=0,
                        help='兼容旧调用；生成入口本身从不 push')
    parser.add_argument('--push', action='count', default=0,
                        help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    for values, label in ((args.date, '--date'), (args.category, '--category')):
        if values and len(values) > 1:
            parser.error(f'{label} 只能指定一次')
    if args.all > 1:
        parser.error('--all 只能指定一次')
    if args.skip_push > 1:
        parser.error('--skip-push 只能指定一次')
    if args.sealed_tutorial_preview > 1:
        parser.error('--sealed-tutorial-preview 只能指定一次')
    if args.legacy_v5_maintenance > 1:
        parser.error('--legacy-v5-maintenance 只能指定一次')
    if args.push:
        parser.error('生成、review 和推送已分离；请依次使用 generate-blog.py、review-blog.py、push-blog.py')
    if len(args.include_id) > 1:
        parser.error('--include-id 只能指定一次')
    if args.include_id and (args.exclude_id or args.all):
        parser.error('--include-id 与 --exclude-id/--all 互斥')
    if args.sealed_tutorial_preview and not args.include_id:
        parser.error('--sealed-tutorial-preview 必须与 --include-id 一起使用')
    if args.sealed_tutorial_preview and (args.data_file or args.exclude_id or args.all):
        parser.error('--sealed-tutorial-preview 禁止 data_file、--exclude-id 或 --all')
    if args.sealed_tutorial_preview and args.legacy_v5_maintenance:
        parser.error('--sealed-tutorial-preview 与 --legacy-v5-maintenance 互斥')
    return {
        'data_file': args.data_file,
        'target_date': args.date[0] if args.date else None,
        'category': args.category[0] if args.category else '论文速递',
        'publish_all': bool(args.all),
        'excluded_ids': list(args.exclude_id),
        'include_id': args.include_id[0] if args.include_id else None,
        'sealed_tutorial_preview': bool(args.sealed_tutorial_preview),
        'legacy_v5_maintenance': bool(args.legacy_v5_maintenance),
    }


def select_generation_data_file(
        data_file, target_date, publish_all=False, legacy_v5_maintenance=False):
    """Resolve production v6 by default; archive fallback is legacy-only."""
    if data_file is not None:
        return data_file
    if not legacy_v5_maintenance:
        # Production v6 is promoted into the one standard canonical.  Never
        # infer a production input from a stale archive or data/ legacy file.
        return str(DEEP_ANALYSIS_RESULT_FILE)
    if publish_all or not target_date:
        return str(resolve_deep_analysis_result_path())
    current = Path(resolve_deep_analysis_result_path())
    if current.is_file():
        try:
            raw = json.loads(current.read_text(encoding='utf-8'))
            papers = raw.get('papers') if isinstance(raw, dict) else raw
            paper_dates = {
                paper_batch_date(paper)
                for paper in papers if isinstance(paper, dict)
            } if isinstance(papers, list) else set()
            if papers and paper_dates == {target_date}:
                return str(current)
        except (OSError, UnicodeError, json.JSONDecodeError):
            # Preserve the existing loader's fail-closed error when no exact
            # archived batch is available.
            pass
    archived = ARCHIVE_DIR / validate_publish_date(target_date) / 'deep-analysis-result.json'
    if archived.is_file():
        print(f'♻️ 当前分析文件不属于目标批次，改用受控归档: {archived}')
        return str(archived)
    return str(current)


def has_verified_publication_receipt(date_str):
    """Return true only for a receipt already verified against remote main."""
    path = review_receipt_path(date_str)
    try:
        receipt = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return False
    publication_commit = str(receipt.get('publicationCommit') or '').lower()
    remote_oid = str(receipt.get('remoteVerifiedOid') or '').lower()
    return bool(
        receipt.get('schemaVersion') == 3
        and receipt.get('date') == validate_publish_date(date_str)
        and re.fullmatch(r'[0-9a-f]{40,64}', publication_commit)
        and remote_oid == publication_commit
        and receipt.get('remoteVerifiedAt')
    )


def generate_main(options=None):
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    options = options or parse_generation_args()
    data_file = options['data_file']
    target_date = options['target_date']
    category = options['category']
    publish_all = options['publish_all']
    excluded_ids = options['excluded_ids']
    include_id = options.get('include_id')
    use_tutorial_preview = bool(options.get('sealed_tutorial_preview'))
    legacy_v5_maintenance = bool(options.get('legacy_v5_maintenance'))

    try:
        blog_repo, content_dir = validate_publish_target()
        today = validate_publish_date(get_today_bj(target_date))
    except PublishDataValidationError as exc:
        print(f"\n❌ 发布目标校验失败: {exc}")
        sys.exit(1)
    print(f"📅 博客日期: {today}")
    tutorial_preview = None
    input_source_reference = None
    if use_tutorial_preview:
        publication_mode = SEALED_TUTORIAL_PREVIEW_MODE
        normalized_include = normalize_publish_arxiv_id(include_id)
        try:
            tutorial_preview = load_verified_tutorial_preview(today, normalized_include)
        except PublishDataValidationError as exc:
            print(f"\n❌ 教程预览检查失败，未读取正式分析记录，也未写入博客页面：{exc}")
            sys.exit(1)
        papers = [tutorial_preview['snapshot']]
        normalized_excluded = []
        print(
            f'🔒 单篇教程预览：{normalized_include}；'
            '将按 post.md 的原始字节写入博客页面，不读取正式分析记录、不清洗正文，也不生成汇总页。'
        )
    else:
        publication_mode = LEGACY_V5_MAINTENANCE_MODE if legacy_v5_maintenance else None
        data_file = select_generation_data_file(
            data_file, today, publish_all, legacy_v5_maintenance,
        )
        input_source_reference = build_generation_input_source_reference(data_file)
        # This preflight is intentionally before paper filtering and Markdown
        # generation: a daily API record that claims fresh provenance must
        # prove the full sealed selected set, not only a later subset.
        validate_daily_fresh_sources_for_publish(data_file, today)
        papers = load_papers(data_file)
        # 优先使用抓取器写入的不可变 fetchBatchDate，旧数据才回退严格北京 fetchedAt。
        if not publish_all:
            papers = [p for p in papers if paper_batch_date(p) == today]
        else:
            print("📦 --all: 跳过批次日期过滤，发布输入文件中的全部论文")
        filter_note = '全部论文' if publish_all else f'fetchBatchDate={today}'
        print(f"📄 过滤后: {len(papers)} 篇论文 ({filter_note})")
        try:
            papers, normalized_include = include_single_paper_for_publish(papers, include_id)
            papers, normalized_excluded = exclude_papers_for_publish(papers, excluded_ids)
        except PublishDataValidationError as exc:
            print(f"\n❌ 发布排除项校验失败，未生成任何博客文件：{exc}")
            sys.exit(1)
    if normalized_excluded:
        print(
            f"🚫 本次明确排除 {len(normalized_excluded)} 篇: "
            f"{', '.join(normalized_excluded)}；实际发布 {len(papers)} 篇"
        )
    if normalized_include:
        print(f'🎯 单篇灰度 generation: {normalized_include}；不生成汇总页、不清理同日其他页面')
    _require_active_publication_request(normalized_include)

    if not papers:
        if has_verified_publication_receipt(today):
            raise PublishDataValidationError(
                f'目标批次 {today} 已有远端验证发布凭证，但当前输入没有论文；'
                '已保留既有 generation/review/push 证据'
            )
        # A failed empty generation must not leave a same-date manifest or
        # review/publication receipt that a separately invoked later stage
        # could mistake for this run's output.
        generation_manifest_path(today).unlink(missing_ok=True)
        review_receipt_path(today).unlink(missing_ok=True)
        review_failure_path(today).unlink(missing_ok=True)
        generation_journal_path(today).unlink(missing_ok=True)
        shutil.rmtree(generation_stage_path(today).parent, ignore_errors=True)
        raise PublishDataValidationError(
            f'目标批次 {today} 没有论文可生成；已阻止复用该日期的旧 generation/review/push 证据'
        )

    if tutorial_preview is None:
        try:
            papers = validate_papers_for_publish(papers)
            papers = apply_publish_image_exclusions(papers)
            papers = validate_papers_for_publish(
                papers, validate_manual_stage_records=False,
            )
        except PublishDataValidationError as exc:
            print(f"\n❌ 发布数据预检失败，未生成任何博客文件：\n{exc}")
            sys.exit(1)
    if tutorial_preview is not None:
        # A single-page sealed release has no digest index to rank.  Its score
        # is already rendered and hash-bound inside post.md; reparsing a
        # canonical analysis here would violate the cold-start boundary.
        scored, unscored = [], list(papers)
    else:
        scored, unscored = score_and_sort(papers)
    baseline_label = 'sealed tutorial preview' if tutorial_preview else 'analysis 重解析结果'
    print(f"✅ 发布数据预检通过: {len(papers)} 篇论文以 {baseline_label} 为发布基线")

    input_fingerprint = generation_input_fingerprint(
        papers, today, category, publish_all, normalized_include,
        input_source_reference=input_source_reference,
    )
    template_fingerprint = generation_template_fingerprint()
    base_head = validate_git_publish_branch()
    published_reusable = reusable_verified_publication_generation(
        today, input_fingerprint, template_fingerprint, base_head,
    )
    if published_reusable is not None:
        _publish_paths, manifest_path, receipt_path = published_reusable
        generation_journal_path(today).unlink(missing_ok=True)
        shutil.rmtree(generation_stage_path(today).parent, ignore_errors=True)
        print(
            '♻️ 相同非空批次已由远端验证发布，复用 generation 并保留唯一发布凭证: '
            f'{receipt_path}'
        )
        print(f'🧾 生成清单保持不变: {manifest_path}')
        return
    if has_publication_evidence_for_generation(
        today, input_fingerprint, template_fingerprint,
    ):
        raise PublishDataValidationError(
            '相同 generation 已存在发布证据，但当前协议、文件、提交或实时 remote/OID '
            '无法全部复核；已保留既有 generation/receipt，拒绝重新生成覆盖。'
            '请先恢复网络与原 remote，或人工核查证据漂移'
        )
    if tutorial_preview is None:
        try:
            if publication_mode is None:
                publication_mode = infer_generation_publication_mode(papers)
            validate_generation_publication_mode(papers, publication_mode)
        except PublishDataValidationError as exc:
            print(f"\n❌ 发布 production 契约预检失败，未生成任何博客文件：\n{exc}")
            sys.exit(1)
    reusable = reusable_generation_manifest(
        today, input_fingerprint, template_fingerprint, base_head,
    )
    if reusable is not None:
        publish_paths, manifest_path = reusable
        generation_journal_path(today).unlink(missing_ok=True)
        shutil.rmtree(generation_stage_path(today).parent, ignore_errors=True)
        print(f'♻️ 相同 generation 已完整安装，复用生成清单且保留 review 状态: {manifest_path}')
        return

    # 生成前先核验所有词表版本。文件随后通过安装记录写入，
    # 实际写入范围必须与审查凭证绑定的文件集合一致。
    try:
        _validate_tag_catalog_snapshot(build_tag_catalog_snapshot())
    except (OSError, PublishDataValidationError) as exc:
        print(f"\n❌ 标签词表快照导出失败，未生成任何博客文件：{exc}")
        sys.exit(1)

    publish_paths = []
    try:
        journal, journal_path, staged_posts = prepare_generation_journal(
            today, papers, category, publish_all, input_fingerprint,
            template_fingerprint, base_head, normalized_include,
        )
        # 发布后长图仍不进入本事务；读者正文实际引用的论文图则必须与页面
        # 一起 staged、review、receipt 和 commit，避免远程热链产生空图。
        staged_assets = prepare_api_reader_staged_assets(
            papers, Path(staged_posts).resolve().parent,
        )
        staged_assets.extend(prepare_tag_catalog_staged_files(
            Path(staged_posts).resolve().parent, blog_repo,
            single_page=journal.get('publicationScope') is not None,
            installation=journal.get('installation'),
        ))
        staged_assets.extend(prepare_researcher_workbench_staged_assets(
            papers, today, Path(staged_posts).resolve().parent,
        ))
        paper_slugs = {}
        for paper, record in zip(papers, journal['papers']):
            slug = record['filename'][len(today) + 1:-3]
            paper_slugs[paper.get('arxivId', '')] = slug
            if record.get('status') != 'generated':
                if tutorial_preview is not None:
                    paper_md = tutorial_preview['postText']
                    slug = paper_slug(paper.get('title', ''), paper.get('arxivId', ''))
                else:
                    paper_md, slug = generate_paper_page(paper, today, category)
                    paper_md = sanitize_markdown_for_publish(paper_md)
                    manual_v4_issue = validate_final_manual_v4_markdown(paper_md, paper)
                    if manual_v4_issue:
                        raise PublishDataValidationError(
                            f'{paper.get("arxivId", "unknown")} sanitize/render 后 '
                            f'Manual v4 最终 Markdown 无效: {manual_v4_issue}'
                        )
                paper_file = staged_posts / record['filename']
                if record['filename'] != f'{today}-{slug}.md':
                    raise PublishDataValidationError(
                        f'论文 slug 在 generation 内不稳定: {record["filename"]} != {today}-{slug}.md'
                    )
                atomic_write_text(paper_file, paper_md)
                record['sha256'] = _sha256_file(paper_file)
                record['status'] = 'generated'
                _save_generation_journal(journal_path, journal)
                print(f'📄 generation checkpoint: {paper_file.name}')
            else:
                paper_file = staged_posts / record['filename']
                if not paper_file.is_file() or _sha256_file(paper_file) != record.get('sha256'):
                    raise PublishDataValidationError(
                        f'论文页 generation checkpoint 损坏: {record["filename"]}'
                    )
                if tutorial_preview is not None:
                    if paper_file.read_text(encoding='utf-8') != tutorial_preview['postText']:
                        raise PublishDataValidationError(
                            f'{paper.get("arxivId", "unknown")} sealed generation checkpoint '
                            '不再逐字等于 post.md'
                        )
                else:
                    manual_v4_issue = validate_final_manual_v4_markdown(
                        paper_file.read_text(encoding='utf-8'), paper,
                    )
                    if manual_v4_issue:
                        raise PublishDataValidationError(
                            f'{paper.get("arxivId", "unknown")} 复用 generation checkpoint 前 '
                            f'Manual v4 最终 Markdown 无效: {manual_v4_issue}'
                        )
                print(f'♻️ 跳过已生成论文页: {record["filename"]}')

        print(f"📄 staging 已具备 {len(paper_slugs)} 篇论文独立页面")
        index_record = journal['index']
        if index_record is None:
            print('🎯 单篇灰度 generation 跳过批次汇总页')
        elif index_record.get('status') != 'generated':
            index_md = generate_index_page(scored, unscored, today, paper_slugs, category)
            index_md = sanitize_markdown_for_publish(index_md)
            index_quality_issue = validate_digest_index_reader_quality(index_md, required=True)
            if index_quality_issue:
                raise PublishDataValidationError(
                    f'汇总页 sanitize/render 后读者质量无效: {index_quality_issue}'
                )
            index_file = staged_posts / index_record['filename']
            atomic_write_text(index_file, index_md)
            index_record['sha256'] = _sha256_file(index_file)
            index_record['status'] = 'generated'
            _save_generation_journal(journal_path, journal)
            print(f"📄 staging 汇总页面: {index_file.name} ({len(index_md)} chars)")
        else:
            index_file = staged_posts / index_record['filename']
            if not index_file.is_file() or _sha256_file(index_file) != index_record.get('sha256'):
                raise PublishDataValidationError('汇总页 generation checkpoint 损坏')
            index_quality_issue = validate_digest_index_reader_quality(
                index_file.read_text(encoding='utf-8'), required=True,
            )
            if index_quality_issue:
                raise PublishDataValidationError(
                    f'复用汇总页 generation checkpoint 前读者质量无效: {index_quality_issue}'
                )
            print(f'♻️ 跳过已生成汇总页: {index_file.name}')

        authoritative_papers = {
            record['filename']: paper
            for paper, record in zip(papers, journal['papers'])
        }
        validate_staged_posts(
            staged_posts, today, authoritative_papers=authoritative_papers,
        )
        prepare_generation_installation(
            journal, journal_path, staged_posts, content_dir, today,
            staged_assets=staged_assets,
        )
        publish_paths = resume_generation_installation(
            journal, journal_path, staged_posts,
        )
    except PublishDataValidationError as exc:
        print(f"\n❌ 生成事务已阻断；可在修复原因后使用同一输入安全续跑: {exc}")
        sys.exit(1)
    except (subprocess.CalledProcessError, OSError) as exc:
        print(f"\n❌ 生成事务失败，博客工作树未写入本次 staging 内容: {exc}")
        sys.exit(1)

    deleted_count = sum(1 for path in publish_paths if not Path(path).exists())
    print(f"📦 已安装本次清单: {len(publish_paths) - deleted_count} 个更新，{deleted_count} 个旧页删除")
    manifest_path = save_generation_manifest(
        today, publish_paths,
        input_fingerprint=input_fingerprint,
        template_fingerprint=template_fingerprint,
        base_head=base_head,
        category=category,
        published_papers=papers,
        publish_all=publish_all,
        include_id=normalized_include,
        publication_mode=publication_mode,
        input_source_reference=input_source_reference,
    )
    generation_journal_path(today).unlink(missing_ok=True)
    shutil.rmtree(generation_stage_path(today).parent, ignore_errors=True)
    print(f"🧾 生成清单: {manifest_path}")
    include_hint = f' --include-id {normalized_include}' if normalized_include else ''
    print(
        f"\n✅ 博客文件生成完成；下一步: python3 scripts/review-blog.py "
        f"--date {today}{include_hint}"
    )


def main():
    """Compatibility generation entry point; review and push live in separate scripts."""
    options = parse_generation_args()
    try:
        date_str = validate_publish_date(get_today_bj(options['target_date']))
        with publication_scope(options.get('include_id')):
            with blog_publication_lock(date_str):
                return generate_main(options)
    except PublishDataValidationError as exc:
        print(f'\n❌ 博客生成失败: {exc}')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 同日期博客事务正在运行: {exc}')
        sys.exit(1)


if __name__ == '__main__':
    require_external_runtime('publish-to-blog.py')
    main()
