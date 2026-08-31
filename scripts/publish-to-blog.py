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
import difflib
import json, re, sys, os, subprocess, datetime, base64, concurrent.futures, hashlib, math
import ipaddress, shutil, socket, tempfile, stat, struct, zlib, unicodedata
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    extract_all_tags, score_emoji, format_medal, build_paper_meta,
    fix_latex_delimiters, escape_html_like_tags, fix_image_markdown,
    truncate_base64_datauri, fix_yaml_double_commas, strip_raw_inline_html,
    fix_empty_markdown_links, dedupe_image_alts, fix_yaml_unbalanced_quotes,
    sanitize_markdown_for_publish, strip_internal_scoring_anchors,
    call_publish_llm_api, PublishLLMUnavailable,
    PublishDataValidationError, count_blocking_review_issues, is_blocking_review_issue,
    normalize_publish_arxiv_id, review_protocol_failure,
    validate_papers_for_publish, validate_review_payload,
    validate_final_manual_v4_markdown, MANUAL_DEPTH_CONTRACT_VERSION_V4,
    MANUAL_DEPTH_CONTRACT_VERSION_V5, MANUAL_DEPTH_CONTRACT_VERSION_V6,
    MANUAL_LONGFORM_CONTRACT_VERSION_V2, validate_manual_v6_payload,
    validate_digest_index_reader_quality, DIGEST_INDEX_READER_QUALITY_VERSION,
)
from path_config import (
    PROJECT_ROOT,
    ARCHIVE_DIR,
    CURRENT_DIR,
    DEEP_ANALYSIS_RESULT_FILE,
    resolve_deep_analysis_result_path,
    DIGEST_COVER_ASSET_DIR,
    DIGEST_COVER_MANIFEST_DIR,
    VISUAL_SUMMARY_ASSET_DIR,
    VISUAL_SUMMARY_MANIFEST_DIR,
    atomic_write_json,
    atomic_write_text,
    file_lock,
)
from project_env import VCS_CHILD_ENV_KEYS, build_child_process_env, get_required_fetch_proxy
from runtime_guard import require_external_runtime
from utils import strip_md, parse_analysis
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
)
from sealed_tutorial_preview import load_sealed_tutorial_preview

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
PUBLISH_IMAGE_EXCLUSIONS_SCHEMA_VERSION = 1
PUBLISH_IMAGE_EXCLUSIONS_PATH = PROJECT_ROOT / 'config' / 'publish-image-exclusions.json'
PUBLISH_IMAGE_EXCLUSIONS_FIELD = 'publishImageExclusions'
PUBLISH_IMAGE_VIEW_FIELD = 'publishImageExclusionView'
PUBLISHED_PAPERS_FINGERPRINT_CONTRACT = 'typed-json-f64-utf16-v1'
MANUAL_V6_PRODUCTION_MODE = 'manual_v6_production'
MANUAL_V6_PRODUCTION_CONTRACT = 'manual-v6-production-publication-v1'
LLM_API_PRODUCTION_MODE = 'llm_api_production'
LLM_API_PRODUCTION_CONTRACT = 'llm-api-production-publication-v1'
LLM_API_READER_CONTRACT = 'beginner-researcher-v2'
LLM_API_READER_LEGACY_CONTRACT = 'beginner-researcher-v1'
LLM_API_SCORING_CONTRACT = 'api-scoring-audit-v2'
LEGACY_V5_MAINTENANCE_MODE = 'legacy_v5_maintenance'
SEALED_TUTORIAL_PREVIEW_MODE = 'sealed_tutorial_preview'
MANUAL_REVIEW_MODE = 'manual_complete'
FINAL_PAGE_ARTIFACT_VERSION = 1
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
    """Hash the exact reviewed path/deletion/SHA set for provenance binding."""
    entries = []
    for record in files:
        entries.append({
            'path': record.get('path'),
            'deleted': record.get('deleted') is True,
            'sha256': None if record.get('deleted') is True else record.get('sha256'),
        })
    entries.sort(key=lambda item: (str(item.get('path')), bool(item.get('deleted'))))
    payload = json.dumps(entries, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def _manual_review_provenance_error(receipt, *, date_str=None,
                                    generation_manifest_sha256=None,
                                    expected_base_head=None):
    """Validate an explicitly human/agent-attested review receipt.

    ``manual_complete`` is deliberately not an implicit fallback for an LLM
    outage.  It is a separate, auditable mode whose attestation is bound to
    the exact generation manifest and Git base used for the review.
    """
    mode = receipt.get('reviewMode')
    if mode is None:
        return None
    if mode != MANUAL_REVIEW_MODE:
        return f'审查凭证 reviewMode 非法: {mode}'
    provenance = receipt.get('reviewProvenance')
    if not isinstance(provenance, dict):
        return 'manual_complete 审查缺少 reviewProvenance'
    if provenance.get('version') not in (1, 2, 3) or provenance.get('mode') != MANUAL_REVIEW_MODE:
        return 'manual_complete reviewProvenance 版本或模式非法'
    legacy_v1 = provenance.get('version') == 1
    current_v3 = provenance.get('version') == 3
    if not isinstance(provenance.get('agent'), str) or not provenance['agent'].strip():
        return 'manual_complete reviewProvenance 缺少 agent'
    if provenance.get('basis') != 'deterministic_and_manual_semantic_review':
        return 'manual_complete reviewProvenance basis 必须为完整确定性+人工语义审查'
    if not isinstance(provenance.get('reason'), str) or len(provenance['reason'].strip()) < 20:
        return 'manual_complete reviewProvenance reason 过短'
    completed_at = provenance.get('completedAt')
    if not isinstance(completed_at, str) or not BEIJING_TIMESTAMP_RE.fullmatch(completed_at):
        return 'manual_complete reviewProvenance completedAt 必须为北京时间戳'
    checks = provenance.get('checks')
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
        return 'manual_complete reviewProvenance checks 必须完整且全部为 true'
    manifest_sha = provenance.get('generationManifestSha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(manifest_sha or '')):
        return 'manual_complete provenance 缺少 generationManifestSha256'
    if generation_manifest_sha256 is not None and manifest_sha != generation_manifest_sha256:
        return 'manual_complete provenance 与 generation manifest SHA 不一致'
    base_head = provenance.get('baseHead')
    if not re.fullmatch(r'[0-9a-f]{40}', str(base_head or '').lower()):
        return 'manual_complete provenance 缺少合法 baseHead'
    if expected_base_head is not None and str(base_head).lower() != str(expected_base_head).lower():
        return 'manual_complete provenance 与 review 基线不一致'
    file_count = provenance.get('fileCount')
    if not isinstance(file_count, int) or file_count <= 0:
        return 'manual_complete provenance fileCount 非法'
    attested_files = provenance.get('files')
    receipt_files = receipt.get('files')
    if legacy_v1:
        # v1 never carried per-page attestations. It is accepted only as
        # immutable historical publication evidence, never as a new/pending
        # receipt that could authorize another push under today's protocol.
        if not all(receipt.get(field) for field in (
            'publicationCommit', 'remoteVerifiedOid', 'remoteVerifiedAt',
            'remoteIdentitySha256',
        )):
            return 'manual_complete provenance v1 仅允许只读历史发布证据'
        if not isinstance(receipt_files, list) or len(receipt_files) != file_count:
            return 'manual_complete provenance v1 fileCount 与 receipt 文件数不一致'
        path_set_sha = provenance.get('reviewedPathSetSha256')
        if path_set_sha != _reviewed_path_set_sha256(receipt_files):
            return 'manual_complete provenance v1 reviewedPathSetSha256 不一致'
        return None
    required_file_checks = {
        'titleAndMetadata', 'technicalNarrative', 'factualClaims',
        'experimentComparisons', 'reproducibility', 'limitations',
        'scoring', 'images',
    }
    if not isinstance(attested_files, list) or len(attested_files) != file_count:
        return 'manual_complete provenance 必须保留逐文件语义审查明细'
    if not isinstance(receipt_files, list) or len(receipt_files) != file_count:
        return 'manual_complete provenance fileCount 与 receipt 文件数不一致'
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

    seen_attested_paths = set()
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
            return f'manual_complete provenance notes 去除页面 ID 后仍重复: {path}'
        seen_semantic_notes.add(key)
        return None

    for item in attested_files:
        if not isinstance(item, dict):
            return 'manual_complete provenance 逐文件必须是对象'
        allowed_fields = {'path', 'sha256', 'checks', 'notes', 'deleted'}
        required_fields = {'path', 'sha256', 'checks', 'notes'}
        if current_v3:
            allowed_fields.update({'reviewSubagent', 'imageFindings'})
            required_fields.update({'reviewSubagent', 'imageFindings'})
        if not required_fields.issubset(item) \
                or not set(item).issubset(allowed_fields):
            return 'manual_complete provenance 逐文件字段非法'
        path = item.get('path')
        if not isinstance(path, str) or path in seen_attested_paths or path not in receipt_by_path:
            return 'manual_complete provenance 逐文件路径非法、重复或不在 receipt'
        relative_path = Path(path)
        if relative_path.is_absolute() or '..' in relative_path.parts:
            return f'manual_complete provenance 逐文件路径越界: {path}'
        seen_attested_paths.add(path)
        receipt_item = receipt_by_path[path]
        deleted = receipt_item.get('deleted') is True
        if deleted != (item.get('deleted') is True) \
                or item.get('sha256') != receipt_item.get('sha256'):
            return f'manual_complete provenance 逐文件 SHA/删除语义不一致: {path}'
        item_checks = item.get('checks')
        if deleted:
            if item_checks != {'deletionVerified': True}:
                return f'manual_complete provenance 删除项检查不完整: {path}'
        elif (
                not isinstance(item_checks, dict)
                or set(item_checks) != required_file_checks
                or any(item_checks.get(key) is not True for key in required_file_checks)):
            return f'manual_complete provenance 逐文件检查不完整: {path}'
        if not isinstance(item.get('notes'), str) or len(item['notes'].strip()) < 20:
            return f'manual_complete provenance 逐文件 notes 过短: {path}'
        subagent = item.get('reviewSubagent')
        if current_v3 and (not isinstance(subagent, dict) or subagent.get('version') != 1
                or not isinstance(subagent.get('taskName'), str)
                or len(subagent['taskName'].strip()) < 4
                or subagent.get('singleFileOnly') is not True
                or subagent.get('isolatedContext') is not True
                or subagent.get('model') != MANUAL_REVIEW_SUBAGENT_MODEL
                or subagent.get('reasoningEffort') != MANUAL_REVIEW_SUBAGENT_REASONING):
            return f'manual_complete provenance 缺少独立单页 reviewSubagent: {path}'
        if current_v3 and not isinstance(item.get('imageFindings'), list):
            return f'manual_complete provenance imageFindings 非法: {path}'
        if current_v3:
            task_name = subagent['taskName'].strip()
            if task_name in seen_review_tasks:
                return 'manual_complete provenance reviewSubagent.taskName 必须逐页全局唯一'
            seen_review_tasks.add(task_name)
        normalized_notes = re.sub(r'[\W_]+', '', item['notes'], flags=re.UNICODE).casefold()
        if normalized_notes in seen_notes:
            return 'manual_complete provenance 逐文件 notes 不独立'
        seen_notes.add(normalized_notes)
        if deleted:
            if '删除' not in item['notes'] or Path(path).stem not in item['notes']:
                return f'manual_complete provenance 删除项 notes 缺少页面特有事实: {path}'
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
                return f'manual_complete provenance 逐文件路径越界: {path}'
            try:
                content = target.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                return f'manual_complete provenance 无法读取已审查页面: {path}'
            arxiv_match = re.search(
                r'^paper_digest_arxiv_id:\s*"?([^"\s]+)"?\s*$', content, re.MULTILINE,
            )
            if arxiv_match and arxiv_match.group(1) not in item['notes']:
                return f'manual_complete provenance 论文页 notes 缺少 arXiv ID: {path}'
            if current_v3 and arxiv_match:
                paper_id = subagent.get('paperId')
                if not re.fullmatch(r'\d{4}\.\d{5}', str(paper_id or '')):
                    return f'manual_complete provenance 论文页 reviewSubagent.paperId 缺失或非法: {path}'
                if normalize_publish_arxiv_id(paper_id) != \
                        normalize_publish_arxiv_id(arxiv_match.group(1)):
                    return f'manual_complete provenance reviewSubagent.paperId 与页面不一致: {path}'
            image_urls = [image.get('url') for image in parse_markdown_images(content)]
            findings = item.get('imageFindings')
            if current_v3 and [finding.get('url') for finding in findings if isinstance(finding, dict)] != image_urls:
                return f'manual_complete provenance imageFindings 未按正文顺序逐图覆盖: {path}'
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
                    return f'manual_complete provenance 逐图像素事实审查不完整: {path}'
            if arxiv_match and not notes_bind_reader_fact(
                    item['notes'], content, (arxiv_match.group(1), date_str)):
                return f'manual_complete provenance 论文页 notes 缺少正文技术词或实验数字: {path}'
            if not arxiv_match and (
                    not date_str or date_str not in item['notes'] or '汇总' not in item['notes']):
                return f'manual_complete provenance 汇总页 notes 缺少日期与页面事实: {path}'
            if not arxiv_match and not notes_bind_reader_fact(
                    item['notes'], content, (date_str,)):
                return f'manual_complete provenance 汇总页 notes 缺少正文排名、数量或论文术语: {path}'
            semantic_error = require_unique_note_semantics(
                item['notes'],
                ((arxiv_match.group(1) if arxiv_match else None), date_str),
                path,
            )
            if semantic_error:
                return semantic_error
    if seen_attested_paths != set(receipt_by_path):
        return 'manual_complete provenance 逐文件集合与 receipt 不一致'
    path_set_sha = provenance.get('reviewedPathSetSha256')
    if not re.fullmatch(r'[0-9a-f]{64}', str(path_set_sha or '')):
        return 'manual_complete provenance 缺少 reviewedPathSetSha256'
    protocol = provenance.get('reviewProtocolFingerprint')
    if not re.fullmatch(r'[0-9a-f]{64}', str(protocol or '')):
        return 'manual_complete provenance 缺少 reviewProtocolFingerprint'
    return None


def blog_transaction_lock(date_str, *, timeout_seconds=30):
    """Serialize generation, review, and push for the same publication date."""
    date_str = validate_publish_date(date_str)
    return file_lock(
        CURRENT_DIR / f'blog-publication-{date_str}.transaction',
        timeout_seconds=timeout_seconds,
    )


def blog_repository_lock(*, timeout_seconds=30):
    """Serialize all operations that touch the shared blog worktree/index/HEAD."""
    repo_key = hashlib.sha256(
        str(Path(BLOG_REPO).expanduser().resolve()).encode('utf-8')
    ).hexdigest()[:16]
    return file_lock(
        CURRENT_DIR / f'blog-repository-{repo_key}.transaction',
        timeout_seconds=timeout_seconds,
    )


@contextmanager
def blog_publication_lock(date_str, *, timeout_seconds=30):
    """Acquire locks in one global order: repository first, publication date second."""
    date_str = validate_publish_date(date_str)
    with blog_repository_lock(timeout_seconds=timeout_seconds):
        with blog_transaction_lock(date_str, timeout_seconds=timeout_seconds):
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
        if os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', '').strip()
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
7. **中文栏目语言**：`毒舌点评` 必须以简体中文为主；如果整段主要是英文，必须报告为 error，并要求依据原点评含义改写为中文，不能只删除内容

【重要区分】以下情况**不要**作为错误报告：
- 已经用反引号包裹的 HTML-like 标记（如 `` `<S>` ``）→ 这是正确格式
- 纯文本中的数学符号或公式描述（未使用 `$` 包裹）→ 这不是 LaTeX 格式问题
- 仅属于风格建议的问题（如 alt 文本可以更详细、列表格式可以更统一）→ 这些应评为 info 级别或干脆不报告
- 技术术语未用反引号包裹 → 这不是格式错误，除非它会被 Hugo 解析为 HTML

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
        # DeepSeek 偶尔把严格 JSON review 的预算全部消耗在隐藏推理上。
        # 发布审查仍必须经过同一 JSON 契约；在主模型基础设施失败时，
        # 仅切换到已配置的副模型重做本次文本审查，不降低门禁或伪造通过。
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
            _failed, protocol_issues = review_protocol_failure(
                f"LLM 文本 review: {title}",
                'reviewer 明确返回 passed=false，即使 issues 为空也必须阻断',
            )
            issues = protocol_issues
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
                _failed, protocol_issues = review_protocol_failure(
                    f"LLM 文本 review: {title}",
                    'reviewer 明确返回 passed=false，即使 issues 为空也必须阻断',
                )
                issues = protocol_issues
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
        return _llm_review_post_chunk(
            chunks[index],
            title,
            required=required,
            chunk_label=f'{index + 1}/{len(chunks)}',
        )

    # The large daily index is otherwise the serial bottleneck. Paper pages are
    # already parallelized by review_all_posts, so keep their chunks sequential
    # to avoid multiplying page concurrency by chunk concurrency.
    if title == "汇总页" and len(chunks) > 1:
        workers = min(get_blog_review_concurrency(), len(chunks))
        print(f"    🔀 汇总页文本分块 review 并发度: {workers}")
        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(review_chunk, index): index
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
    fixed_content = apply_llm_fixes(content, all_issues)
    if count_blocking_review_issues(all_issues):
        passed = False
    return passed, all_issues, fixed_content


REVIEW_IMAGE_MIME_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}
REVIEW_IMAGE_MAX_BYTES = 8 * 1024 * 1024


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
        except (AttributeError, OSError, ValueError):
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
    """Download a public image with redirect, MIME, and size validation."""
    import requests

    session = requests.Session()
    session.trust_env = False
    proxy = get_required_fetch_proxy()
    proxy_addresses = _resolve_proxy_addresses(proxy)
    session.proxies.update({'http': proxy, 'https': proxy})
    try:
        current = url
        for _redirect in range(4):
            resolved_addresses = _validate_public_image_url(current)
            response = session.get(current, timeout=30, stream=True, allow_redirects=False)
            try:
                _validate_response_peer_with_transport(response, resolved_addresses, proxy_addresses)
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get('Location')
                    if not location:
                        raise PublishDataValidationError('图片重定向缺少 Location')
                    from urllib.parse import urljoin
                    current = urljoin(current, location)
                    continue
                response.raise_for_status()
                media_type = response.headers.get('Content-Type', '').split(';', 1)[0].lower()
                if media_type not in REVIEW_IMAGE_MIME_TYPES:
                    raise PublishDataValidationError(f'图片 MIME 不受支持: {media_type or "unknown"}')
                declared_size = response.headers.get('Content-Length')
                if declared_size and int(declared_size) > REVIEW_IMAGE_MAX_BYTES:
                    raise PublishDataValidationError('图片超过 8 MiB review 上限')
                chunks = []
                size = 0
                for chunk in response.iter_content(65536):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > REVIEW_IMAGE_MAX_BYTES:
                        raise PublishDataValidationError('图片超过 8 MiB review 上限')
                    chunks.append(chunk)
                raw = b''.join(chunks)
                _validate_image_signature(media_type, raw)
                return {
                    'media_type': media_type,
                    'data': base64.b64encode(raw).decode('ascii'),
                }
            finally:
                close = getattr(response, 'close', None)
                if callable(close):
                    close()
        raise PublishDataValidationError('图片重定向次数过多')
    except PublishDataValidationError:
        raise
    except (requests.RequestException, OSError, ValueError) as exc:
        raise PublishDataValidationError(f'图片下载失败: {exc}') from exc
    finally:
        session.close()


def _validate_image_signature(media_type, raw):
    signatures = {
        'image/jpeg': raw.startswith(b'\xff\xd8\xff'),
        'image/png': raw.startswith(b'\x89PNG\r\n\x1a\n'),
        'image/gif': raw.startswith((b'GIF87a', b'GIF89a')),
        'image/webp': len(raw) >= 12 and raw.startswith(b'RIFF') and raw[8:12] == b'WEBP',
    }
    if not raw:
        raise PublishDataValidationError('图片内容为空')
    if not signatures.get(media_type, False):
        raise PublishDataValidationError(f'图片内容与 MIME 签名不一致: {media_type}')


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
        return {'media_type': media_type, 'data': base64.b64encode(raw).decode('ascii')}
    if url.startswith('https://'):
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
        _validate_image_signature('image/png', raw)
        return {'media_type': 'image/png', 'data': base64.b64encode(raw).decode('ascii')}
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
    """Parse inline Markdown images while preserving balanced URL parentheses."""
    images = []
    cursor = 0
    while True:
        start = content.find('![', cursor)
        if start < 0:
            break
        alt_end = content.find('](', start + 2)
        if alt_end < 0:
            break
        depth = 1
        escaped = False
        end = alt_end + 2
        while end < len(content):
            char = content[end]
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '(':
                depth += 1
            elif char == ')':
                depth -= 1
                if depth == 0:
                    break
            end += 1
        if depth != 0:
            cursor = alt_end + 2
            continue
        destination = content[alt_end + 2:end].strip()
        title_match = re.match(r'^(.*?)(?:\s+["\'].*["\'])$', destination)
        url = (title_match.group(1) if title_match else destination).strip()
        if url.startswith('<') and url.endswith('>'):
            url = url[1:-1].strip()
        raw = content[start:end + 1]
        images.append({
            'alt': content[start + 2:alt_end], 'url': url,
            'start': start, 'end': end + 1, 'raw': raw,
        })
        cursor = end + 1
    return images


def multimodal_review_images(content, title="", required=False):
    """Send actual image bytes to the routed multimodal publish API."""
    title = plain_title_for_publish(title) if title else title
    image_matches = parse_markdown_images(content)

    if not image_matches:
        return True, []
    # The secondary model is optional for the analysis pipeline. Keep blog
    # review consistent with that contract: without it, deterministic image
    # syntax checks still run, but no required multimodal API call is made.
    if not os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', '').strip():
        return True, []

    img_summary = []
    image_payloads = []
    load_issues = []
    for match in image_matches:
        alt, url = match['alt'], match['url']
        nearby = content[max(0, match['start'] - 600):min(len(content), match['end'] + 600)]
        nearby = nearby.replace(match['raw'], f'图片（alt：{alt}）').strip()
        try:
            image_payload = _load_review_image(url)
        except PublishDataValidationError as exc:
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

    result = call_llm_api(
        prompt,
        max_tokens=get_blog_review_max_tokens(),
        temperature=0.1,
        required=required,
        context=f"多模态图片 review: {title}",
        images=image_payloads,
        use_secondary=True,
        structured_output=True,
    )
    if not result:
        if required:
            return review_protocol_failure(f"多模态图片 review: {title}", '响应为空')
        return True, []

    try:
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
            context=f"多模态图片 review: {title}",
        )
        return passed, load_issues + issues
    except (json.JSONDecodeError, TypeError, ValueError):
        fallback = cleaned.strip()
        if required:
            passed, issues = repair_review_payload(
                result,
                f"多模态图片 review: {title}",
                use_secondary=True,
                retry_prompt=prompt,
                retry_images=image_payloads,
            )
            return passed, load_issues + issues
        lower = fallback.lower()
        error_markers = ['error', '错误', '阻断', '不合理', '无法渲染', '过长', '空 alt', '重复 alt']
        pass_markers = ['passed', '"passed": true', '通过', '无问题', '没有问题', '未发现问题']
        if any(marker in lower for marker in error_markers):
            return False, [{
                "severity": "error",
                "description": f"多模态图片 review 返回非 JSON，但文本中包含错误信号：{fallback[:240]}"
            }]
        if any(marker in lower for marker in pass_markers):
            return True, []
        return True, []


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
        next_paper = dict(paper)
        active = [dict(item) for item in by_id.get(normalized_id, [])]
        if active:
            analysis = next_paper.get('analysis')
            if not isinstance(analysis, str) or not analysis.strip():
                raise PublishDataValidationError(
                    f'{normalized_id} 缺少可派生发布快照的 analysis'
                )
            source_analysis_sha256 = hashlib.sha256(analysis.encode('utf-8')).hexdigest()
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
                'analysisSha256': hashlib.sha256(analysis.encode('utf-8')).hexdigest(),
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
    protected_percentages = []

    def stash_percentage(match):
        protected_percentages.append(match.group(0))
        return f'__PD_PERCENT_{len(protected_percentages) - 1}__'

    value = re.sub(
        r'(?:[一-鿿])?[-+]?\d+(?:\.\d+)?\s*%',
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
    value = re.sub(r'(?<![一-鿿])一半', '1/2', value)
    count_units = (
        '个|对|种|条|篇|张|段|轮|步|次|倍|人|名|例|维|层|位|核|类|'
        '组|路|级|阶|流|通道|阶段|分支|模型|基准|数据集|会话|样本|参数|'
        '题|轨迹|主干|帧|秒|分钟|小时|天|赫兹|分贝|字节|豪秒|像素|采样|自由度|'
        '目录|艺人|轨道|模态|套|卡|分制|男|女|组件|任务|条件|类别|'
        '时间点|方向|卷积块|动作|片段|关键词|文件|刺激|参与者|病例|录音|场景|组合|候选|折'
    )
    value = re.sub(
        rf'(?<!第)([{chars}]+)\s*({count_units})',
        lambda match: f'{chinese_integer(match.group(1))} {match.group(2)}',
        value,
    )
    value = re.sub(r'(\d+/\d+)(?=[一-鿿])', r'\1 ', value)
    value = re.sub(r'([一-鿿])([-+]?\d)', r'\1 \2', value)
    value = re.sub(r'(\d)([一-鿿])', r'\1 \2', value)
    value = re.sub(r'([同唯统单])\s*1\s*(?=[一-鿿])', r'\1一', value)
    value = re.sub(r'归\s*1\s*(?=(?:化|后|组合|处理|权重))', '归一', value)
    value = re.sub(
        r'([下上这另哪])\s*1\s*(?=(?:步|层|类|种|段|项|组|张|个))',
        r'\1一',
        value,
    )
    value = re.sub(
        r'([-+]?\d+(?:\.\d+)?)(?=(?:mW|mJ|ms|dB|Hz|kHz|MHz|KiB|KB|MB|GB|MACs?|tokens?|FPS|bit)\b)',
        r'\1 ',
        value,
        flags=re.I,
    )
    for index, original in enumerate(protected_percentages):
        value = value.replace(f'__PD_PERCENT_{index}__', original)
    return value


def compact_index_opensource(pa, paper, limit=4):
    """Keep the digest index navigable; full provenance remains on each paper page."""
    oss_text = enrich_opensource(pa, paper)
    urls = []
    for raw in re.findall(r'https://[^\s<>()\[\]{}"\']+', oss_text):
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


def generate_index_page(scored, unscored, date_str, paper_slugs, category='论文速递'):
    """生成每日汇总页面（index.md），包含概览和每篇论文的链接"""
    total = len(scored) + len(unscored)
    tag_set = extract_all_tags([p for _, p, _ in scored] + unscored, limit=10)
    top_tags = extract_top_tags([p for _, p, _ in scored] + unscored, limit=8)

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
---

# {conference_title}

共分析 **{total}** 篇论文

---

## ⚡ 今日概览

✅ 筛选入选 {total} 篇 → 🔬 深度分析完成

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
    for i, (score, p, pa) in enumerate(scored):
        m = format_medal(i)
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        rank_bucket = pa.get('rankBucket', '') or '-'
        document_type = pa.get('documentType', '') or '-'
        primary_task = pa.get('primaryTaskTag', '') or '-'
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
    md += "## 📋 论文列表\n\n"

    for i, (score, p, pa) in enumerate(scored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')
        m = format_medal(i)

        pa = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
        aid = p.get('arxivId', '')
        aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
        reader_plan = _manual_reader_editorial_plan(p)
        reader_article = _manual_reader_article(p, reader_plan, date_str)
        reader_title = reader_plan['readerTitle'].strip() if reader_article else title
        if slug:
            md += f"### {m} [{reader_title}]({BASE_PATH}/posts/{date_str}-{slug})\n\n"
        else:
            md += f"### {m} {reader_title}\n\n"
        if reader_article:
            english_title = f'[{title}]({aurl})' if aurl else title
            md += f"> 英文题目：*{english_title}*\n\n"
        tags = pa.get('tags') or []
        if isinstance(tags, str):
            tags = [tag for tag in tags.split() if tag]
        if tags:
            md += f"标签：{' '.join(tags)}\n\n"
        
        score_line = format_complete_score_line(pa)
        if score_line:
            md += f"评分：{score_line}\n\n"
        
        meta = build_paper_meta(pa, aurl)
        if pa.get('roast'):
            md += f"💡 **毒舌点评**\n\n{pa['roast']}\n\n"

        if pa.get('summary'):
            summary = pa['summary']
            # 如果 summary 中混入了详细分析内容（因标题损坏导致解析边界失效），截断到详细分析之前
            cutoff = re.search(r'\n##\s*详细分', summary)
            if cutoff:
                summary = summary[:cutoff.start()].strip()
            md += f"📌 **核心摘要**\n\n{summary}\n\n"

        if pa.get('opensource'):
            md += f"🔗 **开源资源**\n\n{compact_index_opensource(pa, p)}\n\n"

        # The reader-facing sequence ends at open resources.  Keep provenance
        # and author details afterwards, so they do not interrupt the verdict.
        if meta:
            md += f"{meta}\n\n"
        if pa.get('authors'):
            authors_clean = pa['authors'].replace('- **第一作者**', '第一作者').replace('- **通讯作者**', '通讯作者').replace('- **作者列表**', '作者列表')
            md += f"👥 **作者与机构**\n\n{authors_clean}\n\n"

        md += "---\n\n"

    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        slug = paper_slugs.get(p.get('arxivId', ''), '')

        # unscored 论文也使用与评分论文相同的读者顺序。
        pa = p.get('parsed') or parse_analysis(p.get('analysis', '')) or {}
        aid = p.get('arxivId', '')
        aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
        reader_plan = _manual_reader_editorial_plan(p)
        reader_article = _manual_reader_article(p, reader_plan)
        reader_title = reader_plan['readerTitle'].strip() if reader_article else title
        if slug:
            md += f"### {len(scored)+i+1}. [{reader_title}]({BASE_PATH}/posts/{date_str}-{slug})\n\n"
        else:
            md += f"### {len(scored)+i+1}. {reader_title}\n\n"
        if reader_article:
            english_title = f'[{title}]({aurl})' if aurl else title
            md += f"> 英文题目：*{english_title}*\n\n"
        tags = pa.get('tags') or []
        if isinstance(tags, str):
            tags = [tag for tag in tags.split() if tag]
        if tags:
            md += f"标签：{' '.join(tags)}\n\n"
        md += '评分：N/A（分析未提供可验证的八维评分）\n\n'
        meta = build_paper_meta(pa, aurl)

        if pa.get('roast'):
            md += f"💡 **毒舌点评**\n\n{pa['roast']}\n\n"

        if pa.get('summary'):
            summary = pa['summary']
            cutoff = re.search(r'\n##\s*详细分', summary)
            if cutoff:
                summary = summary[:cutoff.start()].strip()
            md += f"📌 **核心摘要**\n\n{summary}\n\n"

        if pa.get('opensource'):
            md += f"🔗 **开源资源**\n\n{compact_index_opensource(pa, p)}\n\n"

        if meta:
            md += f"{meta}\n\n"
        if pa.get('authors'):
            authors_clean = pa['authors'].replace('- **第一作者**', '第一作者').replace('- **通讯作者**', '通讯作者').replace('- **作者列表**', '作者列表')
            md += f"👥 **作者与机构**\n\n{authors_clean}\n\n"

        md += "---\n\n"

    return normalize_digest_index_reader_surface(md)


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


def enrich_opensource(pa, paper):
    """仅从已审计的本地输入提取开源链接，生成阶段不联网。"""
    oss = pa.get('opensource', '')
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
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


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
    data_sha = hashlib.sha256(json.dumps(
        context, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
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


def _api_reader_payload(paper):
    """Replay the API reader article contract from canonical bytes."""
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    reader_contract = contracts.get('apiReaderArticle')
    if reader_contract not in {
            LLM_API_READER_LEGACY_CONTRACT, LLM_API_READER_CONTRACT}:
        return None
    article = paper.get('apiReaderArticle')
    plan = paper.get('apiReaderPlan')
    stage = (manifest.get('stages') or {}).get('apiReaderArticle') or {}
    if not isinstance(article, str) or not article.strip() or not isinstance(plan, dict):
        raise PublishDataValidationError('API reader contract 缺少读者文章或编辑计划')
    article = article.strip()
    article_sha = hashlib.sha256(article.encode('utf-8')).hexdigest()
    plan_sha = _stable_json_sha256(plan)
    if (paper.get('apiReaderArticleSha256') != article_sha
            or paper.get('apiReaderPlanSha256') != plan_sha
            or stage.get('status') != 'complete'
            or stage.get('articleSha256') != article_sha
            or stage.get('planSha256') != plan_sha):
        raise PublishDataValidationError('API reader contract 文章/计划 SHA 或阶段状态不闭环')
    if plan.get('version') != 1 or plan.get('contract') != reader_contract:
        raise PublishDataValidationError('API reader plan 版本或契约非法')
    if not isinstance(plan.get('readerTitle'), str) \
            or not isinstance(plan.get('oneSentenceThesis'), str):
        raise PublishDataValidationError('API reader plan 缺少读者标题或一句话主线')
    plan_sections = plan.get('sections')
    allowed_kinds = (
        'background', 'related_work', 'problem', 'method_overview', 'component',
        'training', 'experiment_setup', 'result', 'ablation', 'limitation',
        'reproduction', 'synthesis',
    )
    required_kinds = ({
        'background', 'related_work', 'method_overview', 'training',
        'experiment_setup', 'result', 'limitation', 'reproduction', 'synthesis',
    } if reader_contract == LLM_API_READER_CONTRACT else {
        'background', 'related_work', 'method_overview', 'experiment_setup',
        'result', 'limitation', 'synthesis',
    })
    minimum_sections = 8 if reader_contract == LLM_API_READER_CONTRACT else 6
    if not isinstance(plan_sections, list) or not minimum_sections <= len(plan_sections) <= 12:
        raise PublishDataValidationError(
            f'API reader plan 必须包含 {minimum_sections}-12 个小节'
        )
    kinds = []
    planned_headings = []
    previous_rank = -1
    for section in plan_sections:
        if not isinstance(section, dict) or set(section) != {'kind', 'heading'}:
            raise PublishDataValidationError('API reader plan 小节字段非法')
        kind = section.get('kind')
        heading = section.get('heading')
        if kind not in allowed_kinds or not isinstance(heading, str) or not heading.strip():
            raise PublishDataValidationError('API reader plan 小节 kind/heading 非法')
        rank = allowed_kinds.index(kind)
        if rank < previous_rank:
            raise PublishDataValidationError('API reader plan 小节顺序违反学习依赖')
        previous_rank = rank
        kinds.append(kind)
        planned_headings.append(heading.strip())
    if not required_kinds.issubset(kinds):
        raise PublishDataValidationError('API reader plan 缺少必需教学阶段')
    article_headings = re.findall(r'^###\s+(.+?)\s*$', article, flags=re.MULTILINE)
    if article_headings != planned_headings or len(set(article_headings)) != len(article_headings):
        raise PublishDataValidationError('API reader plan 与正文小节标题/顺序不一致')
    figures = paper.get('apiReaderFigures')
    if reader_contract == LLM_API_READER_CONTRACT:
        if not isinstance(figures, list):
            raise PublishDataValidationError('API reader v2 缺少结构化 figure 绑定数组')
        figures_sha = _stable_json_sha256(figures)
        if stage.get('figureCount') != len(figures) \
                or stage.get('figuresSha256') != figures_sha:
            raise PublishDataValidationError('API reader v2 figure 数量或 SHA 未闭环')
        article_image_urls = re.findall(r'!\[[^\]]*\]\((https://[^\s)]+)\)', article)
        figure_urls = [item.get('url') for item in figures if isinstance(item, dict)]
        if article_image_urls != figure_urls or len(set(figure_urls)) != len(figure_urls):
            raise PublishDataValidationError('API reader v2 正文图片与 figure 绑定不一致')
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId') or paper.get('paper_id'))
        figure_assets = []
        for item in figures:
            if not isinstance(item, dict) or set(item) != {
                    'ordinal', 'label', 'caption', 'url', 'mediaType',
                    'sourceDomSha256', 'targetKind', 'targetHeading',
                    'cachePath', 'assetFilename', 'assetMediaType',
                    'assetSha256', 'assetBytes', 'assetWidth', 'assetHeight'}:
                raise PublishDataValidationError('API reader v2 figure 字段非法')
            parsed_url = urlparse(item['url'])
            if parsed_url.scheme != 'https' \
                    or parsed_url.hostname not in {'arxiv.org', 'www.arxiv.org'} \
                    or not re.fullmatch(r'[0-9a-f]{64}', str(item['sourceDomSha256'])):
                raise PublishDataValidationError('API reader v2 figure 来源绑定非法')
            declared_cache_path = Path(str(item['cachePath'] or '')).expanduser()
            if declared_cache_path.is_symlink() or declared_cache_path.parent.is_symlink():
                raise PublishDataValidationError('API reader v2 figure 缓存路径不得使用符号链接')
            cache_path = declared_cache_path.resolve()
            cache_root = (Path(CURRENT_DIR) / 'api-reader-assets' / paper_id).resolve()
            try:
                cache_path.relative_to(cache_root)
            except ValueError as exc:
                raise PublishDataValidationError('API reader v2 figure 缓存路径逃逸') from exc
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
                raise PublishDataValidationError('API reader v2 figure 缓存字节或 SHA 不一致')
            destination = Path('static') / 'images' / 'papers' / paper_id / cache_path.name
            public_url = f'{BASE_PATH.rstrip("/")}/images/papers/{paper_id}/{cache_path.name}'
            figure_assets.append({
                'sourcePath': str(cache_path),
                'destination': destination.as_posix(),
                'publicUrl': public_url,
                'sourceUrl': item['url'],
                'sha256': item['assetSha256'],
            })
        reader_authors = paper.get('apiReaderAuthors')
        if not isinstance(reader_authors, dict) \
                or set(reader_authors) != {'authors', 'sourceDomSha256'} \
                or not isinstance(reader_authors.get('authors'), list) \
                or not re.fullmatch(
                    r'[0-9a-f]{64}', str(reader_authors.get('sourceDomSha256') or '')
                ) \
                or stage.get('readerAuthorsSha256') != _stable_json_sha256(reader_authors):
            raise PublishDataValidationError('API reader v2 作者与机构来源绑定非法')
        for author in reader_authors['authors']:
            if not isinstance(author, dict) or set(author) != {'name', 'affiliations'} \
                    or not isinstance(author.get('name'), str) \
                    or not isinstance(author.get('affiliations'), list) \
                    or not author['name'].strip() \
                    or not author['affiliations'] \
                    or not all(isinstance(value, str) and value.strip()
                               for value in author['affiliations']):
                raise PublishDataValidationError('API reader v2 作者或机构字段非法')
    else:
        figures = []
        figure_assets = []
        reader_authors = None
    rendered_article = article
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
        'readerAuthors': reader_authors,
    }


def _normalize_fresh_article(value):
    """Compatibility facade for the extracted payload verifier."""
    return _normalize_fresh_article_impl(value)


def _validate_manual_v5_fresh_authoring(paper, article, date_str):
    """Compatibility facade for the extracted payload verifier."""
    return _verify_manual_v5_fresh_authoring(
        paper, article, date_str,
        current_dir=CURRENT_DIR, project_root=PROJECT_ROOT,
    )


def _validate_manual_v5_tutorial_payload(paper, article, date_str):
    """Replay the sealed v5 quality/artifact package from its real files."""
    return _verify_manual_v5_tutorial_payload(
        paper, article, date_str, current_dir=CURRENT_DIR,
    )


def _manual_reader_article(paper, plan, date_str=None):
    """Read the separately attested reader article; never trust an unhashed draft."""
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    if isinstance(contracts, dict) \
            and contracts.get('manualDepth') == MANUAL_DEPTH_CONTRACT_VERSION_V6:
        # This branch raises on every missing field/SHA drift.  It deliberately
        # cannot inherit the historical v5 "None means use the old layout"
        # compatibility behavior.
        return validate_manual_v6_payload(paper)['article']
    if not plan or plan.get('version') != 2:
        return None
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    takeover = manifest.get('manualTakeover') if isinstance(manifest.get('manualTakeover'), dict) else {}
    article = takeover.get('readerArticle')
    expected_sha = takeover.get('readerArticleSha256')
    if not isinstance(article, str) or not article.strip() or not isinstance(expected_sha, str):
        return None
    actual_sha = hashlib.sha256(article.encode('utf-8')).hexdigest()
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
    # main() replaces parsed with the validated analysis baseline before generation.
    pa = dict(paper.get('parsed') or parse_analysis(paper.get('analysis', '')) or {})
    # 补充 opensource 中缺失的具体链接
    if pa and pa.get('opensource'):
        pa['opensource'] = enrich_opensource(pa, paper)
    title = paper.get('title', 'Unknown')
    display_title = plain_title_for_publish(title)
    aid = paper.get('arxivId', '')
    aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
    slug = paper_slug(title, aid)

    score_str = pa['score'] if pa and pa.get('score') else ''
    task_str = pa['primaryTaskTag'].replace('#', '') if pa and pa.get('primaryTaskTag') else ''
    desc = f"{task_str} | {score_str}/10" if score_str and task_str else display_title
    tags = pa.get('tags', []) if pa else []
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
        provenance = v6_payload['provenance']
        v6_marker = (
            'paper_digest_v6_runtime_mode: "production"\n'
            f'paper_digest_reader_longform: "{MANUAL_LONGFORM_CONTRACT_VERSION_V2}"\n'
            f'paper_digest_reader_longform_sha256: "{provenance["readerLongformSha256"]}"\n'
            f'paper_digest_reader_article_sha256: "{v6_payload["articleSha256"]}"\n'
            f'paper_digest_artifact_index_sha256: "{v6_payload["artifactIndexSha256"]}"\n'
            + ''.join(
                f'paper_digest_v6_{marker}: "{provenance[field]}"\n'
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
        api_reader_marker = (
            f'paper_digest_api_reader_contract: "{api_reader_payload["contract"]}"\n'
            f'paper_digest_api_reader_article_sha256: "{api_reader_payload["articleSha256"]}"\n'
            f'paper_digest_api_reader_plan_sha256: "{api_reader_payload["planSha256"]}"\n'
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
    reader_first = reader_plan is not None and reader_article is not None
    api_reader_v2 = bool(
        api_reader_payload
        and api_reader_payload.get('contract') == LLM_API_READER_CONTRACT
    )
    # Modern Manual pages must never be reconstructed from the legacy fixed
    # canonical sections.  A missing, partial or tampered reader payload is a
    # hard failure: silently falling back would turn an old analysis into a
    # newly generated blog page and bypass fresh authoring.
    if manual_depth in {
            MANUAL_DEPTH_CONTRACT_VERSION_V5,
            MANUAL_DEPTH_CONTRACT_VERSION_V6,
    } and not reader_first:
        raise PublishDataValidationError(
            f'{aid or title} 当前 Manual 页面缺少完整且哈希一致的 reader article；'
            '禁止从旧 canonical 固定章节回拼正文，必须从论文证据冷启动生成新稿'
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
    md = f"""---
title: "{yaml_escape(display_title)}"
date: {date_str}
draft: false
tags: [{', '.join([t.replace('#', '') for t in tags])}]
categories: [{category}]
description: "{yaml_escape(desc)}"
hiddenInHomeList: true
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
paper_digest_arxiv_id: "{normalize_arxiv_id(aid)}"
{manual_depth_marker}{fresh_marker}{v6_marker}{api_reader_marker}---

# 📄 {reader_title}

"""
    if reader_first:
        paper_link = f'[{display_title}]({aurl})' if aurl else display_title
        # Keep the Chinese reader title in the H1, then expose the paper's
        # original English title and canonical link explicitly.  Calling this
        # merely “论文” made the reader-first identity block ambiguous and
        # broke the same title/link contract used by the daily index.
        md += f'> 英文题目：*{paper_link}*\n>\n> 一句话：**{reader_plan["oneSentenceThesis"].strip()}**\n\n'
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
    if pa:
        reader_identity_lines = []
        if tags:
            metadata_block += f"标签：{' '.join(tags)}\n\n"
            reader_identity_lines.append(f"标签：{' '.join(tags)}")

        score_line = format_complete_score_line(pa)
        if score_line:
            metadata_block += f"{score_line}\n\n"
            reader_identity_lines.append(f"评分：{score_line}")

        meta = build_paper_meta(pa, aurl)
        if meta:
            metadata_block += f"{meta}\n\n"

        if pa.get('authors') and not api_reader_v2:
            metadata_block += f"\n### 👥 作者与机构\n\n{pa['authors']}\n"

        if reader_first and reader_identity_lines:
            md += '> ' + '\n>\n> '.join(reader_identity_lines) + '\n\n'
        elif not reader_first:
            md += metadata_block
        if api_reader_v2 and reader_authors_content:
            md += f"\n## 👥 作者与机构\n\n{reader_authors_content}\n"

        # 分离补充信息（从 opensource 中提取）
        opensource_content = pa.get('opensource', '')
        supplementary = ''
        if opensource_content:
            supp_match = re.search(r'##\s*补充信息\s*\n([\s\S]*)', opensource_content)
            if supp_match:
                supplementary = supp_match.group(1).strip()
                opensource_content = opensource_content[:supp_match.start()].strip()

        sections = (
            [
                ('💬 毒舌点评', 'roast'),
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
        )
        scoring_evidence = ''
        for item in sections:
            if len(item) == 3:
                label, key, content = item
            else:
                label, key = item
                content = pa.get(key, '')
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
        if reader_first and scoring_evidence:
            md += (
                f'\n{"##" if api_reader_v2 else "###"} ⚖️ 评分依据与证据（展开查看）\n\n'
                f'<details>\n<summary>逐维得分、全文证据与扣分边界</summary>\n\n'
                f'{scoring_evidence}\n\n</details>\n'
            )
    else:
        md += '> ⚠️ 该论文分析失败\n'

    md += f'\n---\n\n[← 返回 {date_str} 语音/音乐/音频论文速递]({BASE_PATH}/posts/{date_str}/)\n'

    return md, slug


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
            or normalized.startswith(('---', '#', '|', '-', '*', '>', '```', '~~~', '!['))
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

    def factual_guard_signature(text):
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
            or normalized.startswith(('---', '#', '|', '-', '*', '>', '```', '~~~', '!['))
            or '\n|' in block
            or re.search(r'!\[[^\]]*\]\([^)]+\)', block)
        )
        if protected:
            continue
        fingerprint = unicodedata.normalize('NFKC', normalized).casefold()
        duplicate = any(
            factual_guard_signature(fingerprint) == previous_signature
            and min(len(fingerprint), len(previous)) / max(len(fingerprint), len(previous)) >= 0.9
            and difflib.SequenceMatcher(
                None, fingerprint, previous, autojunk=False,
            ).ratio() >= 0.97
            for previous, previous_signature in seen_near
        )
        if duplicate:
            blocks[index] = ''
            if index + 1 < len(blocks):
                blocks[index + 1] = ''
            near_duplicate_count += 1
        else:
            seen_near.append((fingerprint, factual_guard_signature(fingerprint)))
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
    latex_pattern = re.compile(r'(?<!\\)\$([^\s$][^$]*?)\$(?!\d)')
    latex_matches = latex_pattern.findall(content)
    if latex_matches:
        issues.append(f"发现 {len(latex_matches)} 个未转换的 LaTeX 行内公式")
        content = fix_latex_delimiters(content)

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
        expected_columns = len(re.findall(r'(?<!\\)\|', line)) - 1
        start = index - 1
        end = index + 1
        while start >= 0 and table_lines[start].lstrip().startswith('|'):
            start -= 1
        while end < len(table_lines) and table_lines[end].lstrip().startswith('|'):
            end += 1
        malformed = []
        for row_index in range(start + 1, end):
            row = table_lines[row_index]
            columns = len(re.findall(r'(?<!\\)\|', row)) - 1
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
    roast_pattern = re.compile(
        r'(?:^|\n)(?:#{1,6}\s*)?💡\s*(?:\*\*)?毒舌点评(?:\*\*)?\s*\n+'
        r'([\s\S]*?)(?=\n(?:#{1,6}\s+|(?:📌|🔗|🏗️|📊|🔬|⚖️|🚨|📎)\s*\*\*|---\s*$)|\Z)',
        flags=re.MULTILINE,
    )
    for roast_match in roast_pattern.finditer(content):
        roast = roast_match.group(1)
        han_count = len(re.findall(r'[\u3400-\u9fff]', roast))
        latin_count = len(re.findall(r'[A-Za-z]', roast))
        if latin_count >= 120 and (han_count < 20 or latin_count > han_count * 3):
            issues.append('毒舌点评以英文为主，必须改为简体中文后才能发布')
            break

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
        issues.append(f'Manual v4 最终 Markdown 门禁失败: {manual_v4_issue}')
    index_quality_issue = validate_digest_index_reader_quality(content)
    if index_quality_issue:
        issues.append(f'汇总页读者质量门禁失败: {index_quality_issue}')

    return fixed, issues


def classify_review_failure(issues):
    """Separate retryable review infrastructure/protocol failures from content defects."""
    blocking = [issue for issue in (issues or []) if is_blocking_review_issue(issue)]
    if not blocking:
        return None
    transient_markers = (
        '连续失败', '调用失败', '返回非 json', '响应不完整', '协议',
        '下载失败', '超时', 'timeout', 'unavailable',
    )
    if all(
        isinstance(issue, dict)
        and any(marker in str(issue.get('description', '')).lower() for marker in transient_markers)
        for issue in blocking
    ):
        return 'transient'
    return 'content'


def _review_single_paper(args):
    """并发只读 review 单篇论文，返回路径、标题、计数和输出。"""
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
        lines.append("    ⛔ 代码层存在可修复问题；最终 review 保持只读，请回到 generation 修复")
    remaining_code_issues = issues
    blocking_count += len(remaining_code_issues)
    blocking_details.extend({'severity': 'error', 'description': str(issue)} for issue in remaining_code_issues)
    for issue in issues:
        lines.append(f"    ⚠️  代码层: {issue}")

    # 2. LLM 文本审查
    llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, title, required=require_llm)
    if llm_passed is False and count_blocking_review_issues(llm_issues) == 0:
        llm_issues = list(llm_issues or []) + [{
            'severity': 'error',
            'description': 'LLM 文本 reviewer 明确返回 passed=false，fail closed',
        }]
    if llm_issues:
        for issue in llm_issues:
            sev = issue.get('severity', 'warning')
            desc = issue.get('description', '')
            lines.append(f"    🤖 LLM ({sev}): {desc}")
    if llm_fixed_content != content:
        readonly_issue = {
            'severity': 'error',
            'description': 'LLM 建议修改最终页；review 阶段禁止写回，请回到 generation 修复后重新审查',
        }
        llm_issues = list(llm_issues or []) + [readonly_issue]
        lines.append(f"    🤖 LLM (error): {readonly_issue['description']}")
    if llm_issues:
        llm_blocking = count_blocking_review_issues(llm_issues)
        blocking_count += llm_blocking
        blocking_details.extend(issue for issue in llm_issues if is_blocking_review_issue(issue))
        advisory_count += len(llm_issues) - llm_blocking

    # 3. 多模态图片审查
    img_passed, img_issues = multimodal_review_images(content, title, required=require_llm)
    if img_passed is False and count_blocking_review_issues(img_issues) == 0:
        img_issues = list(img_issues or []) + [{
            'severity': 'error',
            'description': '图片 reviewer 明确返回 passed=false，fail closed',
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
        raise PublishDataValidationError(f'{os.path.basename(paper_file)} 在只读 review 期间发生变化')
    return (
        os.path.realpath(paper_file), title, fixed_count, blocking_count,
        advisory_count, lines, failure_kind, reviewed_sha256,
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
    for score, p, pa in scored_papers:
        paper_id = normalize_publish_arxiv_id(p.get('arxivId', ''))
        title_map[paper_id] = p.get('title', '')
        paper_map[paper_id] = p

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
            print("    ⛔ 代码层存在可修复问题；最终 review 保持只读，请回到 generation 修复")
        remaining_code_issues = issues
        total_blocking_issues += len(remaining_code_issues)
        for issue in issues:
            print(f"    ⚠️  代码层: {issue}")

        # 2. LLM 文本审查
        llm_passed, llm_issues, llm_fixed_content = llm_review_post(content, "汇总页", required=require_llm)
        if llm_passed is False and count_blocking_review_issues(llm_issues) == 0:
            llm_issues = list(llm_issues or []) + [{
                'severity': 'error',
                'description': '汇总页 LLM reviewer 明确返回 passed=false，fail closed',
            }]
        if llm_issues:
            for issue in llm_issues:
                sev = issue.get('severity', 'warning')
                desc = issue.get('description', '')
                print(f"    🤖 LLM ({sev}): {desc}")
        if llm_fixed_content != content:
            readonly_issue = {
                'severity': 'error',
                'description': 'LLM 建议修改最终页；review 阶段禁止写回，请回到 generation 修复后重新审查',
            }
            llm_issues = list(llm_issues or []) + [readonly_issue]
            print(f"    🤖 LLM (error): {readonly_issue['description']}")
        llm_blocking = count_blocking_review_issues(llm_issues)
        total_blocking_issues += llm_blocking
        total_advisory_issues += len(llm_issues) - llm_blocking

        # 汇总页同样可能包含论文图片，必须经过与独立论文页一致的多模态审查。
        _img_passed, img_issues = multimodal_review_images(content, '汇总页面', required=require_llm)
        if _img_passed is False and count_blocking_review_issues(img_issues) == 0:
            img_issues = list(img_issues or []) + [{
                'severity': 'error',
                'description': '汇总页图片 reviewer 明确返回 passed=false，fail closed',
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
            raise PublishDataValidationError('汇总页在只读 review 期间发生变化')
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
                    }
                    if result_callback:
                        result_callback(path, file_results[path])
                    continue
                if result is None:
                    continue
                (
                    path, title, fixed_count, blocking_count, advisory_count,
                    lines, failure_kind, reviewed_sha256,
                ) = result
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
    return _validate_hugo_rendered_html_gate_impl(output_dir, source_artifacts)


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
        markdown_format_issues = artifact['markdownFormatIssues']
        if markdown_format_issues:
            raise PublishDataValidationError(
                f'{path.name} Markdown/Hugo 格式门禁失败: ' + '; '.join(markdown_format_issues)
            )
        manual_v4_issue = artifact['manualIssue']
        if manual_v4_issue:
            raise PublishDataValidationError(
                f'{path.name} Manual v4 最终 Markdown 门禁失败: {manual_v4_issue}'
            )
        index_quality_issue = artifact['indexQualityIssue']
        if index_quality_issue:
            raise PublishDataValidationError(
                f'{path.name} 汇总页读者质量门禁失败: {index_quality_issue}'
            )
        if artifact_cache is not None:
            artifact_cache[str(path.resolve())] = artifact
    return files


def run_hugo_gate(blog_repo, staged_posts_dir, required=False, source_paths=None):
    """Build staged content with Hugo, then gate source Markdown and rendered HTML."""
    hugo = shutil.which('hugo')
    if not hugo:
        if required:
            raise PublishDataValidationError('正式 --push 要求 Hugo 可用，当前未找到 hugo 命令')
        print('  ℹ️ Hugo 不可用，已执行严格 YAML/Markdown 回退门禁')
        return 'fallback'
    with tempfile.TemporaryDirectory(prefix='paper-digest-hugo-') as output_dir:
        result = subprocess.run(
            [
                hugo,
                '--contentDir', str(Path(staged_posts_dir).parent),
                '--destination', output_dir,
                '--cleanDestinationDir',
                '--noBuildLock',
            ],
            cwd=blog_repo,
            capture_output=True,
            text=True,
            env=build_child_process_env(),
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout or '').strip()
            raise PublishDataValidationError(f'Hugo 构建门禁失败: {detail[-2000:]}')
        source_artifacts = []
        source_files = (
            sorted(
                Path(path).resolve() for path in source_paths
                if Path(path).is_file() and Path(path).suffix == '.md'
            )
            if source_paths is not None else
            sorted(Path(staged_posts_dir).glob('*.md'))
        )
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
                'Hugo 渲染 HTML 格式门禁失败: ' + '; '.join(rendered_issues)
            )
    print('  ✅ Hugo staging 构建通过')
    return 'hugo'


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
                raise PublishDataValidationError('单篇 generation 只允许绑定正文论文图资产')
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
    return build_child_process_env(allowed_keys=VCS_CHILD_ENV_KEYS)


def validate_git_publish_branch():
    """Formal publication is only allowed from the blog repository's main branch."""
    branch = subprocess.run(
        ['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        env=_git_env(),
    )
    current = branch.stdout.strip() if branch.returncode == 0 else '<detached HEAD>'
    if current != 'main':
        raise PublishDataValidationError(
            f'正式发布要求博客仓库当前分支为 main，当前为 {current}'
        )
    head = subprocess.run(
        ['git', 'rev-parse', '--verify', 'HEAD'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        check=True,
        env=_git_env(),
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
    result = subprocess.run(
        [
            'git', 'status', '--porcelain=v1', '-z', '--untracked-files=all',
            '--', *manifest,
        ],
        cwd=BLOG_REPO,
        capture_output=True,
        check=True,
        env=_git_env(),
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
            expected_sha = allowed.get(relative)
            try:
                text = target.read_text(encoding='utf-8')
            except (OSError, UnicodeError):
                unsafe.append(entry)
                continue
            if (not expected_sha or _sha256_file(target) != expected_sha
                    or 'paper_digest_pipeline_owned: true' not in text):
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
    index_tree = subprocess.run(
        ['git', 'write-tree'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        check=True,
        env=_git_env(),
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
    current = subprocess.run(
        ['git', 'rev-parse', '--verify', 'HEAD'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        check=True,
        env=_git_env(),
    ).stdout.strip().lower()
    original = state['head'].lower()
    if current != original:
        subprocess.run(
            ['git', 'update-ref', 'refs/heads/main', original, current],
            cwd=BLOG_REPO,
            check=True,
            env=_git_env(),
        )
    subprocess.run(
        ['git', 'read-tree', state['index_tree']],
        cwd=BLOG_REPO,
        check=True,
        env=_git_env(),
    )
    for path, snapshot in state['snapshots'].items():
        if snapshot is None:
            path.unlink(missing_ok=True)
        else:
            _atomic_write_bytes(path, snapshot['content'], mode=snapshot['mode'])


def validate_git_index(paths):
    allowed = set(_git_relative_manifest(paths))
    result = subprocess.run(
        ['git', 'diff', '--cached', '--name-only', '-z'],
        cwd=BLOG_REPO,
        capture_output=True,
        check=True,
        env=_git_env(),
    )
    staged = {item.decode('utf-8') for item in result.stdout.split(b'\0') if item}
    unrelated = sorted(staged - allowed)
    if unrelated:
        raise PublishDataValidationError(
            f'博客仓库已有无关 staged 文件，拒绝提交: {", ".join(unrelated)}'
        )


def validate_single_publication_worktree(paths):
    """Require one paper page plus only its bound local figures to be dirty."""
    allowed = set(_git_relative_manifest(paths))
    pages = {item for item in allowed if item.startswith('content/posts/') and item.endswith('.md')}
    assets = {item for item in allowed if item.startswith('static/images/papers/')}
    if len(pages) != 1 or len(pages) + len(assets) != len(allowed):
        raise PublishDataValidationError('单篇灰度发布必须绑定一个论文页及其受控正文图')
    result = subprocess.run(
        ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
        cwd=BLOG_REPO,
        capture_output=True,
        check=True,
        env=_git_env(),
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
        staged = subprocess.run(
            ['git', 'show', f':{relative}'],
            cwd=BLOG_REPO,
            capture_output=True,
            env=_git_env(),
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
        baseline = subprocess.run(
            ['git', 'show', f'{base_head}:{relative}'],
            cwd=BLOG_REPO, capture_output=True, env=_git_env(),
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
    parents = subprocess.run(
        ['git', 'rev-list', '--parents', '-n', '1', commit],
        cwd=BLOG_REPO, capture_output=True, text=True, check=True, env=_git_env(),
    ).stdout.strip().lower().split()
    if len(parents) != 2 or parents[1] != base_head:
        raise PublishDataValidationError('发布提交必须是 review 基线的唯一单父提交')
    actual_delta = set(filter(None, subprocess.run(
        ['git', 'diff-tree', '--no-commit-id', '--name-only', '-r', commit],
        cwd=BLOG_REPO, capture_output=True, text=True, check=True, env=_git_env(),
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
        committed = subprocess.run(
            ['git', 'show', f'{commit}:{relative}'],
            cwd=BLOG_REPO,
            capture_output=True,
            env=_git_env(),
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
    result = subprocess.run(
        ['git', 'ls-remote', '--exit-code', GITHUB_REMOTE, 'refs/heads/main'],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        env=_git_env(),
    )
    if result.returncode != 0:
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
    result = subprocess.run(
        ['git', 'remote', 'get-url', '--push', GITHUB_REMOTE],
        cwd=BLOG_REPO,
        capture_output=True,
        text=True,
        env=_git_env(),
    )
    if result.returncode != 0:
        return None, f'无法解析当前 Git remote {GITHUB_REMOTE!r} 的 push URL'
    push_url = (result.stdout or '').strip()
    if not push_url or '\n' in push_url or '\x00' in push_url:
        return None, f'当前 Git remote {GITHUB_REMOTE!r} 的 push URL 非法'
    payload = json.dumps(
        {'remote': GITHUB_REMOTE, 'pushUrl': push_url},
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(payload).hexdigest(), ''


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


def git_push(date_str, publish_paths, rollback_state=None):
    """Commit, push HEAD explicitly to main, and verify the remote object ID."""
    manifest = _git_relative_manifest(publish_paths)
    state = rollback_state
    try:
        verified_paths, _verified_receipt_path = load_verified_review_receipt(date_str)
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
            parent = subprocess.run(
                ['git', 'rev-parse', 'HEAD^'], cwd=BLOG_REPO, capture_output=True,
                text=True, check=True, env=_git_env(),
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
            subprocess.run(
                ['git', 'add', '--', *manifest],
                check=True,
                cwd=BLOG_REPO,
                env=_git_env(),
            )
            validate_git_index(publish_paths)
            validate_git_index_against_review_receipt(receipt, publish_paths)
        staged = subprocess.run(
            ['git', 'diff', '--cached', '--quiet', '--', *manifest],
            cwd=BLOG_REPO,
            env=_git_env(),
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
            subprocess.run(
                [
                    'git', 'commit',
                    '-m', f'content: 发布 {date_str} 论文速递并同步评分与审查结果',
                    '-m', review_description
                          + '推送前已逐文件校验审查凭证 SHA-256，本步不重新生成或 review。',
                ],
                check=True, cwd=BLOG_REPO,
                env=_git_env()
            )
            local_head = validate_git_publish_branch()
            validate_git_commit_against_review_receipt(receipt, publish_paths, local_head)
            receipt['publicationCommit'] = local_head
            atomic_write_json(receipt_path, receipt, ensure_ascii=False, indent=2)
        elif staged is not None and staged.returncode > 1:
            raise subprocess.CalledProcessError(staged.returncode, staged.args)
        else:
            raise PublishDataValidationError('审查文件相对基线没有可提交差异，拒绝推送任意已有本地提交')
    except (subprocess.CalledProcessError, PublishDataValidationError, OSError, UnicodeError) as exc:
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
    result = subprocess.run(
        ['git', 'push', GITHUB_REMOTE, 'HEAD:main'],
        capture_output=True, text=True, cwd=BLOG_REPO,
        env=_git_env(),
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
    push_detail = (result.stderr or result.stdout or '').strip()
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


def manual_review_attestation_path(date_str):
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


def _stable_json_sha256(value):
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')
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
        provenance = payload['provenance']
        bindings.append({
            'paperId': payload['paperId'],
            'manualDepth': MANUAL_DEPTH_CONTRACT_VERSION_V6,
            'runtimeMode': provenance['runtimeMode'],
            'specVersion': provenance['specVersion'],
            'specRootSha256': provenance['specRootSha256'],
            'paperSpecSha256': provenance['paperSpecSha256'],
            'recordSemanticSha256': provenance['sealedRecordSha256'],
            'recordFileSha256': provenance['recordFileSha256'],
            'artifactIndexSha256': payload['artifactIndexSha256'],
            'artifactIndexFileSha256': provenance['artifactIndexFileSha256'],
            'recordsEnvelopeFileSha256': provenance['recordsEnvelopeFileSha256'],
            'taskEvidenceSha256': provenance['taskEvidenceSha256'],
            'readerLongformContract': MANUAL_LONGFORM_CONTRACT_VERSION_V2,
            'readerLongformSha256': provenance['readerLongformSha256'],
            'readerArticleSha256': payload['articleSha256'],
        })
    return sorted(bindings, key=lambda item: item['paperId'])


def manual_v6_production_proof(published_papers):
    """Build the batch proof required by every production-v6 generation.

    ``specRootSha256`` is the official spec-v6 Merkle root.  Per-paper
    bindings retain the exact paper shard, sealed records-v4 envelope,
    ArtifactIndex, task evidence and reader-longform identities.
    """
    if not isinstance(published_papers, list) or not published_papers:
        raise PublishDataValidationError('production v6 发布批次不能为空')
    bindings = manual_v6_publication_bindings(published_papers)
    if len(bindings) != len(published_papers):
        raise PublishDataValidationError(
            '默认发布只接受全量 Manual v6 canonical；legacy v5 必须显式使用 maintenance 开关'
        )
    roots = {item['specRootSha256'] for item in bindings}
    if len(roots) != 1:
        raise PublishDataValidationError('production v6 论文未绑定同一个 spec v6 Merkle root')
    paper_ids = [item['paperId'] for item in bindings]
    if len(set(paper_ids)) != len(paper_ids):
        raise PublishDataValidationError('production v6 论文 ID 重复')
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
    """Replay each API canonical and bind the exact article/scoring/source bytes."""
    bindings = []
    for paper in published_papers:
        if not isinstance(paper, dict):
            continue
        manifest = paper.get('analysisManifest')
        contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
        if not isinstance(contracts, dict) \
                or contracts.get('apiReaderArticle') != LLM_API_READER_CONTRACT:
            continue
        reader = _api_reader_payload(paper)
        analysis = paper.get('analysis')
        stages = manifest.get('stages') if isinstance(manifest.get('stages'), dict) else {}
        scoring = stages.get('scoringAudit') if isinstance(stages.get('scoringAudit'), dict) else {}
        reader_stage = stages.get('apiReaderArticle') \
            if isinstance(stages.get('apiReaderArticle'), dict) else {}
        source = manifest.get('sourceAcquisition') \
            if isinstance(manifest.get('sourceAcquisition'), dict) else {}
        if not isinstance(analysis, str) or not analysis.strip():
            raise PublishDataValidationError('LLM API production canonical 缺少最终 analysis')
        analysis_sha = hashlib.sha256(analysis.encode('utf-8')).hexdigest()
        source_sha = source.get('sourceSha256')
        paper_source_sha = paper.get('sourceSha256')
        if not re.fullmatch(r'[0-9a-f]{64}', str(source_sha or '')) \
                or paper_source_sha != source_sha:
            raise PublishDataValidationError('LLM API production 来源 SHA 未闭环')
        if (
            scoring.get('status') != 'complete'
            or scoring.get('scoringContract') != LLM_API_SCORING_CONTRACT
            or scoring.get('outputAnalysisSha256') != analysis_sha
            or not re.fullmatch(r'[0-9a-f]{64}', str(scoring.get('auditSha256') or ''))
            or not re.fullmatch(r'[0-9a-f]{64}', str(scoring.get('evidenceSha256') or ''))
        ):
            raise PublishDataValidationError('LLM API production 评分审计未闭环')
        model = reader_stage.get('model')
        protocol = reader_stage.get('protocol')
        if not isinstance(model, str) or not model.strip() \
                or not isinstance(protocol, str) or not protocol.strip():
            raise PublishDataValidationError('LLM API production 读者文章缺少模型/协议绑定')
        final_score = scoring.get('finalScore')
        parsed = paper.get('parsed') if isinstance(paper.get('parsed'), dict) else {}
        try:
            parsed_score = float(parsed.get('score'))
            final_score_number = float(final_score)
        except (TypeError, ValueError) as exc:
            raise PublishDataValidationError('LLM API production 最终评分非法') from exc
        if not math.isfinite(parsed_score) or not math.isfinite(final_score_number) \
                or abs(parsed_score - final_score_number) > 1e-9:
            raise PublishDataValidationError('LLM API production parsed 与评分审计总分不一致')
        paper_id = normalize_publish_arxiv_id(
            paper.get('arxivId') or paper.get('paper_id')
        )
        bindings.append({
            'paperId': paper_id,
            'readerContract': LLM_API_READER_CONTRACT,
            'readerArticleSha256': reader['articleSha256'],
            'readerPlanSha256': reader['planSha256'],
            'readerFiguresSha256': _stable_json_sha256(reader['figures']),
            'readerAuthorsSha256': _stable_json_sha256(reader['readerAuthors']),
            'analysisSha256': analysis_sha,
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
    """Build the proof required for a fully API-authored production generation."""
    if not isinstance(published_papers, list) or not published_papers:
        raise PublishDataValidationError('LLM API production 发布批次不能为空')
    bindings = llm_api_publication_bindings(published_papers)
    if len(bindings) != len(published_papers):
        raise PublishDataValidationError(
            'LLM API production 只接受 reader/scoring/source 全部闭环的 API canonical'
        )
    if manual_v6_publication_bindings(published_papers):
        raise PublishDataValidationError('LLM API production 不得混入 Manual v6 canonical')
    paper_ids = [item['paperId'] for item in bindings]
    if len(set(paper_ids)) != len(paper_ids):
        raise PublishDataValidationError('LLM API production 论文 ID 重复')
    return {
        'contract': LLM_API_PRODUCTION_CONTRACT,
        'readerContract': LLM_API_READER_CONTRACT,
        'scoringContract': LLM_API_SCORING_CONTRACT,
        'paperCount': len(bindings),
        'paperIds': paper_ids,
        'bindingsFingerprint': _stable_json_sha256(bindings),
    }


def infer_generation_publication_mode(papers):
    """Infer only homogeneous production inputs; legacy always stays explicit."""
    if len(manual_v6_publication_bindings(papers)) == len(papers):
        return MANUAL_V6_PRODUCTION_MODE
    if len(llm_api_publication_bindings(papers)) == len(papers):
        return LLM_API_PRODUCTION_MODE
    raise PublishDataValidationError(
        '默认发布输入既不是完整 Manual v6，也不是完整 LLM API production canonical'
    )


def validate_generation_publication_mode(papers, publication_mode):
    """Fail closed on an implicit v5 fallback or a mixed v5/v6 generation."""
    if publication_mode == MANUAL_V6_PRODUCTION_MODE:
        return manual_v6_production_proof(papers)
    if publication_mode == LLM_API_PRODUCTION_MODE:
        return llm_api_production_proof(papers)
    if publication_mode == LEGACY_V5_MAINTENANCE_MODE:
        if manual_v6_publication_bindings(papers):
            raise PublishDataValidationError(
                'legacy v5 maintenance 输入不得混入或降级 Manual v6 canonical'
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
    return _stable_json_sha256(payload)


def _validate_generation_input_integrity(manifest, date_str):
    """Recompute every schema-v3 input binding from its authoritative snapshot."""
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
            '正式生成清单缺少 category、publishAll 或已发布论文权威快照'
        )
    actual_input = str(manifest.get('inputFingerprint') or '')
    scope = _validate_publication_scope(manifest, published_papers)
    expected_input = generation_input_fingerprint(
        published_papers, date_str, category, publish_all,
        scope.get('includeId') if scope else None,
    )
    if actual_input != expected_input:
        raise PublishDataValidationError(
            '正式生成清单 inputFingerprint 无法从 publishedPapers 反向重算'
        )
    if manifest.get('publishedPapersFingerprintContract') != PUBLISHED_PAPERS_FINGERPRINT_CONTRACT:
        raise PublishDataValidationError('正式生成清单缺少已发布论文快照指纹契约')
    actual_snapshot = str(manifest.get('publishedPapersFingerprint') or '')
    expected_snapshot = published_papers_fingerprint(published_papers)
    if actual_snapshot != expected_snapshot:
        raise PublishDataValidationError('正式生成清单已发布论文权威快照指纹不匹配')
    expected_v6 = manual_v6_publication_bindings(published_papers)
    actual_v6 = manifest.get('manualV6Bindings')
    # Historical v5-only schema-v3 generations predate the explicit field.
    # They remain readable; a manifest containing any v6 paper never gets this
    # exception and must carry the complete explicit proof map.
    historical_v5_without_bindings = actual_v6 is None and not expected_v6
    if not historical_v5_without_bindings:
        if actual_v6 != expected_v6:
            raise PublishDataValidationError('正式生成清单 Manual v6 显式 provenance 绑定不匹配')
        expected_v6_fingerprint = _stable_json_sha256(expected_v6)
        if manifest.get('manualV6BindingsFingerprint') != expected_v6_fingerprint:
            raise PublishDataValidationError('正式生成清单 Manual v6 provenance 指纹不匹配')
    expected_api = llm_api_publication_bindings(published_papers)
    actual_api = manifest.get('llmApiBindings')
    if actual_api is not None or expected_api:
        if actual_api != expected_api:
            raise PublishDataValidationError('正式生成清单 LLM API 显式绑定不匹配')
        if manifest.get('llmApiBindingsFingerprint') != _stable_json_sha256(expected_api):
            raise PublishDataValidationError('正式生成清单 LLM API 绑定指纹不匹配')
    publication_mode = manifest.get('publicationMode')
    production_proof = manifest.get('manualV6Production')
    api_proof = manifest.get('llmApiProduction')
    if publication_mode == MANUAL_V6_PRODUCTION_MODE:
        if expected_api or api_proof is not None:
            raise PublishDataValidationError('Manual v6 generation 混入 LLM API 证明')
        expected_proof = manual_v6_production_proof(published_papers)
        if production_proof != expected_proof:
            raise PublishDataValidationError(
                '正式 generation 未强绑定 spec v6/records v4/Merkle/longform provenance'
            )
        expected_proof_sha = _stable_json_sha256(expected_proof)
        if manifest.get('manualV6ProductionFingerprint') != expected_proof_sha:
            raise PublishDataValidationError('正式 generation production v6 证明指纹不匹配')
    elif publication_mode == LLM_API_PRODUCTION_MODE:
        if expected_v6 or production_proof is not None:
            raise PublishDataValidationError('LLM API generation 混入 Manual v6 证明')
        expected_proof = llm_api_production_proof(published_papers)
        if api_proof != expected_proof:
            raise PublishDataValidationError('正式 generation 未强绑定 LLM API production 证明')
        expected_proof_sha = _stable_json_sha256(expected_proof)
        if manifest.get('llmApiProductionFingerprint') != expected_proof_sha:
            raise PublishDataValidationError('正式 generation LLM API production 证明指纹不匹配')
    elif publication_mode == LEGACY_V5_MAINTENANCE_MODE:
        if expected_v6 or expected_api or production_proof is not None or api_proof is not None:
            raise PublishDataValidationError('legacy v5 maintenance generation 混入 production 证明')
    elif publication_mode == SEALED_TUTORIAL_PREVIEW_MODE:
        if scope is None or production_proof is not None or api_proof is not None:
            raise PublishDataValidationError('sealed tutorial generation 模式或 production 证明非法')
    elif publication_mode is None and not expected_v6 and not expected_api:
        # Immutable schema-v3 history from before the production-mode field is
        # readable only as legacy maintenance.  It can never enter visuals.
        pass
    else:
        raise PublishDataValidationError('generation publicationMode 缺失或非法')
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
    """Bind generated bytes to code dependencies, URL base, and persisted schemas."""
    script_dir = Path(__file__).resolve().parent
    dependencies = {}
    for name in (
            'publish-to-blog.py', 'publish_common.py', 'utils.py', 'path_config.py',
            'sealed_tutorial_preview.py', 'markdown_hugo_gate.py',
            'tutorial_payload_verifier.py'):
        path = script_dir / name
        dependencies[name] = _sha256_file(path)
    return _stable_json_sha256({
        'dependencies': dependencies,
        'basePath': BASE_PATH,
        'generationManifestSchema': 3,
        'generationJournalSchema': 1,
        'reviewFailureSchema': 3,
        'reviewPassCacheSchema': 1,
        'reviewReceiptSchema': 3,
    })


def validate_current_generation_template(manifest):
    """Reject schema-v3 pages generated by a different publication template."""
    if manifest.get('schemaVersion') != 3:
        return True
    expected = generation_template_fingerprint()
    actual = str(manifest.get('templateFingerprint') or '')
    if not re.fullmatch(r'[0-9a-f]{64}', actual) or actual != expected:
        raise PublishDataValidationError(
            'generation 模板/发布契约指纹已变化，请重新运行 generate-blog.py'
        )
    return True


def review_protocol_fingerprint():
    """Bind reusable review evidence to code, prompts/models and Hugo runtime."""
    script_dir = Path(__file__).resolve().parent
    dependencies = {
        name: _sha256_file(script_dir / name)
        for name in (
            'publish-to-blog.py', 'review-blog.py', 'manual-review-blog.py',
            'publish_common.py', 'utils.py',
        )
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
    cache_key = _stable_json_sha256({
        'dependencies': dependencies,
        'primaryModel': os.environ.get('PAPER_ANALYZER_MODEL', ''),
        'primaryEndpoint': os.environ.get('PAPER_ANALYZER_ENDPOINT', ''),
        'secondaryModel': os.environ.get('PAPER_ANALYZER_SECONDARY_MODEL', ''),
        'secondaryEndpoint': os.environ.get('PAPER_ANALYZER_SECONDARY_ENDPOINT', ''),
        'reviewChunkChars': get_blog_review_chunk_chars(),
        'reviewMaxTokens': get_blog_review_max_tokens(),
        'hugoIdentity': hugo_identity,
    })
    if cache_key in _REVIEW_PROTOCOL_CACHE:
        return _REVIEW_PROTOCOL_CACHE[cache_key]
    try:
        hugo_version = subprocess.run(
            [hugo_path or 'hugo', 'version'], capture_output=True, text=True, timeout=10,
            env=build_child_process_env(),
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        hugo_version = 'unavailable'
    fingerprint = _stable_json_sha256({
        'contractVersion': 2,
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
    })
    _REVIEW_PROTOCOL_CACHE.clear()
    _REVIEW_PROTOCOL_CACHE[cache_key] = fingerprint
    return fingerprint


def _load_json_object(path, label):
    try:
        value = json.loads(Path(path).read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'{label}无法解析: {path}') from exc
    if not isinstance(value, dict):
        raise PublishDataValidationError(f'{label}格式非法: {path}')
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
                    prior_exact[item['path']] = item['sha256']
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
        raise PublishDataValidationError(f'博客清单路径逃逸仓库: {path}') from exc
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
        and re.fullmatch(r'figure-\d+-[0-9a-f]{16}\.png', relative.name or '')
    )
    if not (is_post or is_visual_asset or is_digest_cover or is_reader_asset):
        raise PublishDataValidationError(f'博客清单包含非受控路径: {relative}')
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
    if parts[:3] != ('static', 'images', 'papers') or len(parts) != 5:
        return False
    return paper_id is None or parts[3] == normalize_publish_arxiv_id(paper_id)


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
                f'视觉摘要资产批次日期不匹配: {relative}'
            )
    if relative.startswith('static/images/digest-covers/'):
        asset_date = Path(relative).parts[3]
        if asset_date != validated_date:
            raise PublishDataValidationError(f'汇总页封面批次日期不匹配: {relative}')
    return relative


def save_generation_manifest(
    date_str, publish_paths, *, input_fingerprint=None,
    template_fingerprint=None, base_head=None, category='论文速递',
    published_papers=None, publish_all=False, include_id=None,
    publication_mode=None,
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
            raise PublishDataValidationError('正式 generation manifest 缺少已发布论文权威快照')
        if not isinstance(publish_all, bool):
            raise PublishDataValidationError('正式 generation manifest publishAll 必须是布尔值')
        expected_input = generation_input_fingerprint(
            published_papers, validated_date, validated_category, publish_all,
            include_id,
        )
        if input_fingerprint != expected_input:
            raise PublishDataValidationError(
                '拒绝保存无法从 publishedPapers 反向重算的 inputFingerprint'
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
        publication_scope_value = _single_publication_scope(include_id)
        if publication_scope_value is not None:
            _validate_publication_scope(
                {'publicationScope': publication_scope_value}, published_papers,
            )
            page_records = [record for record in records if record['path'].startswith('content/posts/')]
            asset_records = [record for record in records if record['path'].startswith('static/images/papers/')]
            if len(page_records) != 1 or page_records[0]['deleted'] is True \
                    or page_records[0]['path'].endswith(f'/{validated_date}.md') \
                    or len(page_records) + len(asset_records) != len(records):
                raise PublishDataValidationError(
                    '单篇 generation manifest 必须绑定一个现存论文页及其受控正文图'
                )
            expected_asset_prefix = (
                f'static/images/papers/{publication_scope_value["includeId"]}/'
            )
            if any(record['deleted'] is True
                   or not record['path'].startswith(expected_asset_prefix)
                   for record in asset_records):
                raise PublishDataValidationError('单篇 generation 正文图与 includeId 不一致')
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
        completed = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            text=True,
            env=build_child_process_env(),
        )
    except OSError as exc:
        print(f'⚠️ 全部博客已经发布，但无法启动发布后视觉规划器: {exc}')
        print(f'   可重试: npm run visual:post-publish -- --date {date_str}')
        return False
    if completed.returncode != 0:
        print('⚠️ 全部博客已经发布，但发布后视觉任务建立失败；图片不回滚博客发布')
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
    return True


def load_generation_manifest(date_str):
    """Load and constrain the generation manifest without performing review."""
    manifest_path = generation_manifest_path(date_str)
    if not manifest_path.is_file():
        raise PublishDataValidationError(
            f'缺少生成清单: {manifest_path}；请先运行 generate-blog.py'
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'生成清单无法解析: {manifest_path}') from exc
    if manifest.get('schemaVersion') not in {1, 2, 3} or manifest.get('date') != date_str:
        raise PublishDataValidationError('生成清单版本或日期不匹配')
    _validate_active_publication_scope(manifest)
    validate_current_generation_template(manifest)
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('生成清单中没有文件')
    repo = Path(BLOG_REPO).expanduser().resolve()
    paths = []
    seen = set()
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get('path'), str)
            or not isinstance(record.get('deleted'), bool)
        ):
            raise PublishDataValidationError('生成清单文件记录格式非法')
        if manifest.get('schemaVersion') in {2, 3}:
            expected_sha = record.get('sha256')
            if record['deleted']:
                if expected_sha is not None:
                    raise PublishDataValidationError('生成清单删除记录不应包含 SHA-256')
            elif not re.fullmatch(r'[0-9a-f]{64}', str(expected_sha or '')):
                raise PublishDataValidationError('生成清单非删除记录缺少合法 SHA-256')
        relative = Path(record['path'])
        if relative.is_absolute():
            raise PublishDataValidationError(f'生成清单包含绝对路径: {relative}')
        target = (repo / relative).resolve()
        normalized = _validate_manifest_path_date(target, repo, date_str)
        if normalized in seen:
            raise PublishDataValidationError(f'生成清单包含重复路径: {normalized}')
        seen.add(normalized)
        if record['deleted']:
            if target.exists():
                raise PublishDataValidationError(f'生成清单标记删除但文件仍存在: {normalized}')
        elif not target.is_file():
            raise PublishDataValidationError(f'生成文件缺失: {normalized}')
        if manifest.get('schemaVersion') == 3:
            expected = {
                'deleted': record['deleted'],
                'sha256': None if record['deleted'] else record.get('sha256'),
            }
            if _file_fingerprint(target) != expected:
                raise PublishDataValidationError(
                    f'generation schema v3 文件字节与生成清单不一致: {normalized}'
                )
        paths.append(target)
    validate_generation_visual_contract(manifest, date_str, repo)
    return paths, manifest_path


def generation_manifest_expectations(manifest_path, date_str):
    """Return strict path -> expected deletion state from the generation manifest."""
    manifest = _load_json_object(manifest_path, '生成清单')
    if manifest.get('schemaVersion') not in {1, 2, 3} or manifest.get('date') != date_str:
        raise PublishDataValidationError('生成清单版本或日期不匹配')
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('生成清单中没有文件')
    repo = Path(BLOG_REPO).expanduser().resolve()
    expectations = {}
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get('path'), str)
            or not isinstance(record.get('deleted'), bool)
        ):
            raise PublishDataValidationError('生成清单文件记录格式非法')
        target = (repo / record['path']).resolve()
        relative = _validate_manifest_path_date(target, repo, date_str)
        if relative in expectations:
            raise PublishDataValidationError(f'生成清单包含重复路径: {relative}')
        expectations[relative] = record['deleted']
    return expectations


def validate_generation_manifest_file_bytes(manifest_path, date_str):
    """Verify immutable schema-v3 generation bytes and explicit deletions.

    Historical schema v1/v2 manifests remain read-only maintenance evidence;
    they predate this byte contract and are never upgraded or rewritten here.
    """
    manifest = _load_json_object(manifest_path, '生成清单')
    if manifest.get('date') != date_str or manifest.get('schemaVersion') not in {1, 2, 3}:
        raise PublishDataValidationError('生成清单版本或日期不匹配')
    if manifest.get('schemaVersion') != 3:
        return True
    repo = Path(BLOG_REPO).expanduser().resolve()
    records = manifest.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('生成清单中没有文件')
    seen = set()
    for record in records:
        if (
            not isinstance(record, dict)
            or not isinstance(record.get('path'), str)
            or not isinstance(record.get('deleted'), bool)
        ):
            raise PublishDataValidationError('生成清单文件记录格式非法')
        target = (repo / record['path']).resolve()
        relative = _validate_manifest_path_date(target, repo, date_str)
        if relative in seen:
            raise PublishDataValidationError(f'生成清单包含重复路径: {relative}')
        seen.add(relative)
        expected_sha = record.get('sha256')
        if record['deleted']:
            if expected_sha is not None:
                raise PublishDataValidationError(f'生成清单删除项必须使用 null SHA: {relative}')
        elif not re.fullmatch(r'[0-9a-f]{64}', str(expected_sha or '')):
            raise PublishDataValidationError(f'生成清单页面 SHA 非法: {relative}')
        expected = {
            'deleted': record['deleted'],
            'sha256': None if record['deleted'] else expected_sha,
        }
        if _file_fingerprint(target) != expected:
            raise PublishDataValidationError(
                f'generation 后页面字节或删除状态已变化: {relative}'
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


def attest_api_reader_assets(date_str, publish_paths, manifest_path, file_results):
    """Bind each local paper figure to an exact reviewed page and PNG byte record."""
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
    blocking = 0
    for item in publish_paths:
        asset = Path(item).resolve()
        if not is_api_reader_asset_path(asset):
            continue
        relative = asset.relative_to(repo).as_posix()
        record = manifest_by_path.get(relative)
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
            if file_results.get(str(page), {}).get('passed') is True
            and file_results.get(str(page), {}).get('reviewedSha256') == _sha256_file(page)
        ]
        if not reviewed_pages:
            blocking += 1
            file_results[str(asset)] = result
            continue
        page_modes = {
            file_results[str(page)].get('imageReviewMode', 'deterministic_only')
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
    """Fail if any reviewed byte changes or an expected page disappears."""
    validate_generation_manifest_file_bytes(manifest_path, date_str)
    repo = Path(BLOG_REPO).expanduser().resolve()
    expectations = generation_manifest_expectations(manifest_path, date_str)
    actual_paths = set()
    for item in publish_paths:
        path, relative = _manifest_record(item, repo)
        actual_paths.add(relative)
        if relative not in expectations:
            raise PublishDataValidationError(f'发布路径不在 generation manifest: {relative}')
        expected_deleted = expectations[relative]
        if expected_deleted:
            if path.exists():
                raise PublishDataValidationError(f'generation 预期删除的文件重新出现: {relative}')
            continue
        if not path.is_file():
            raise PublishDataValidationError(f'generation 预期存在的页面在 review 期间消失: {relative}')
        result = file_results.get(str(path.resolve()), {})
        reviewed_sha = result.get('reviewedSha256')
        if result.get('passed') is not True or not re.fullmatch(r'[0-9a-f]{64}', str(reviewed_sha or '')):
            raise PublishDataValidationError(f'页面缺少已通过 review 的字节凭证: {relative}')
        if _sha256_file(path) != reviewed_sha:
            raise PublishDataValidationError(f'页面在 review 后发生变化，拒绝签发凭证: {relative}')
    if actual_paths != set(expectations):
        raise PublishDataValidationError('发布路径集合与 generation manifest 不一致')
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
    generation_manifest=None, reviewed_results=None, review_provenance=None,
):
    """Persist the exact reviewed blog manifest for a later push-only command."""
    if generation_manifest is None:
        raise PublishDataValidationError('签发审查凭证必须绑定 generation manifest')
    if reviewed_results is None:
        raise PublishDataValidationError('签发审查凭证必须绑定逐文件 review 字节凭证')
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
            raise PublishDataValidationError(f'审查路径不在 generation manifest: {relative}')
        exists = path.is_file()
        if expected_deleted and exists:
            raise PublishDataValidationError(f'generation 预期删除的文件重新出现: {relative}')
        if not expected_deleted and not exists:
            raise PublishDataValidationError(f'generation 预期存在的页面在 review 期间消失: {relative}')
        reviewed_sha = (
            None if expected_deleted
            else reviewed_results.get(str(path.resolve()), {}).get('reviewedSha256')
        )
        actual_sha = _sha256_file(path) if exists else None
        if not expected_deleted and actual_sha != reviewed_sha:
            raise PublishDataValidationError(f'页面在 receipt 签发时发生变化: {relative}')
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
        raise PublishDataValidationError('审查路径集合与 generation manifest 不一致')
    current_head = validate_git_publish_branch()
    if expected_base_head is not None and current_head != str(expected_base_head).lower():
        raise PublishDataValidationError(
            'review 期间博客 main 基线发生变化，拒绝签发审查凭证'
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
    if review_provenance is not None:
        if not isinstance(review_provenance, dict):
            raise PublishDataValidationError('review_provenance 必须是对象')
        provenance = dict(review_provenance)
        provenance.setdefault('generationManifestSha256', receipt['generationManifestSha256'])
        provenance.setdefault('baseHead', current_head)
        provenance.setdefault('fileCount', len(files))
        provenance.setdefault('reviewedPathSetSha256', _reviewed_path_set_sha256(files))
        provenance.setdefault('reviewProtocolFingerprint', receipt['reviewProtocolFingerprint'])
        receipt['reviewMode'] = MANUAL_REVIEW_MODE
        receipt['reviewProvenance'] = provenance
        provenance_error = _manual_review_provenance_error(
            receipt,
            date_str=date_str,
            generation_manifest_sha256=receipt['generationManifestSha256'],
            expected_base_head=current_head,
        )
        if provenance_error:
            raise PublishDataValidationError(provenance_error)
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
    """Collect durable and legacy pass evidence keyed by path plus exact bytes."""
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
                collected[(record['path'], record['sha256'])] = record
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
                    'reviewProtocolFingerprint': cached.get('reviewProtocolFingerprint'),
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
            if (
                current == recorded
                and failure_kind == 'content'
                and record.get('reviewProtocolFingerprint') == current_protocol
            ):
                unchanged_failed.append(item.resolve())
                prior_results[key] = {
                    'passed': False, 'completed': True, 'failureKind': 'content',
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
    """Load a strict review receipt and verify every current blog file hash."""
    path = review_receipt_path(date_str)
    if not path.is_file():
        raise PublishDataValidationError(
            f'缺少已通过审查的发布凭证: {path}；请先不带 --push 运行 review'
        )
    try:
        receipt = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'审查凭证无法解析: {path}') from exc
    if receipt.get('schemaVersion') != 3 or receipt.get('date') != date_str:
        raise PublishDataValidationError('审查凭证版本或日期不匹配')
    if receipt.get('strictReview') is not True:
        raise PublishDataValidationError('审查凭证不是严格 review 结果')
    if receipt.get('hugoGate') != 'hugo':
        raise PublishDataValidationError('审查凭证未通过 Hugo staging gate')
    if receipt.get('reviewProtocolFingerprint') != review_protocol_fingerprint():
        raise PublishDataValidationError('审查代码、模型或 Hugo 协议指纹已变化，请重新 review')
    manifest_path = generation_manifest_path(date_str)
    expected_manifest_sha = receipt.get('generationManifestSha256')
    if (
        not re.fullmatch(r'[0-9a-f]{64}', str(expected_manifest_sha or ''))
        or not manifest_path.is_file()
        or _sha256_file(manifest_path) != expected_manifest_sha
    ):
        raise PublishDataValidationError('审查凭证绑定的 generation manifest 缺失或已变化')
    provenance_error = _manual_review_provenance_error(
        receipt,
        date_str=date_str,
        generation_manifest_sha256=expected_manifest_sha,
        expected_base_head=receipt.get('baseHead'),
    )
    if provenance_error:
        raise PublishDataValidationError(provenance_error)
    try:
        generation_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError('generation manifest 无法解析') from exc
    validate_current_generation_template(generation_manifest)
    publication_scope_value = _validate_active_publication_scope(generation_manifest)
    validate_generation_visual_contract(generation_manifest, date_str)
    validate_generation_manifest_file_bytes(manifest_path, date_str)
    if generation_manifest.get('schemaVersion') == 3 and (
        receipt.get('generationInputIntegrity') != PUBLISHED_PAPERS_FINGERPRINT_CONTRACT
        or receipt.get('generationInputFingerprint') != generation_manifest.get('inputFingerprint')
        or receipt.get('publishedPapersFingerprint')
        != generation_manifest.get('publishedPapersFingerprint')
    ):
        raise PublishDataValidationError('审查凭证未绑定已反向验证的 generation 输入快照')
    if (
        receipt.get('publicationMode') != generation_manifest.get('publicationMode')
        or receipt.get('manualV6ProductionFingerprint')
        != generation_manifest.get('manualV6ProductionFingerprint')
        or receipt.get('llmApiProductionFingerprint')
        != generation_manifest.get('llmApiProductionFingerprint')
    ):
        raise PublishDataValidationError('审查凭证未绑定 generation production 模式/证明')
    expected_visual_capability = _expected_post_publish_visuals(
        generation_manifest, publication_scope_value,
    )
    receipt_visual_capability = receipt.get('postPublishVisuals')
    if (
        receipt_visual_capability is not None
        and receipt_visual_capability != expected_visual_capability
    ):
        raise PublishDataValidationError('审查凭证的发布后视觉能力与 generation manifest 不一致')
    if receipt.get('publicationScope') != publication_scope_value:
        raise PublishDataValidationError('审查凭证的发布作用域与 generation manifest 不一致')
    expectations = generation_manifest_expectations(manifest_path, date_str)
    records = receipt.get('files')
    if not isinstance(records, list) or not records:
        raise PublishDataValidationError('审查凭证没有发布文件清单')
    file_image_modes = {
        record.get('imageReviewMode') for record in records
        if isinstance(record, dict) and record.get('deleted') is not True
    }
    if not file_image_modes or not file_image_modes.issubset({'multimodal', 'deterministic_only', 'manual_semantic'}):
        raise PublishDataValidationError('审查凭证逐文件图片 review 模式非法')
    expected_image_mode = (
        next(iter(file_image_modes)) if len(file_image_modes) == 1 else 'mixed'
    )
    image_review = receipt.get('imageReview')
    if (
        not isinstance(image_review, dict)
        or image_review.get('mode') != expected_image_mode
        or not isinstance(image_review.get('secondaryModelConfigured'), bool)
    ):
        raise PublishDataValidationError('审查凭证图片 review 汇总与逐文件证据不一致')

    repo = Path(BLOG_REPO).expanduser().resolve()
    paths = []
    seen = set()
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get('path'), str):
            raise PublishDataValidationError('审查凭证文件记录格式非法')
        relative = Path(record['path'])
        if relative.is_absolute():
            raise PublishDataValidationError(f'审查凭证包含非法路径: {relative}')
        target = (repo / relative).resolve()
        key = _validate_manifest_path_date(target, repo, date_str)
        if key in seen:
            raise PublishDataValidationError(f'审查凭证包含重复路径: {key}')
        seen.add(key)
        if key not in expectations or expectations[key] != (record.get('deleted') is True):
            raise PublishDataValidationError(f'审查凭证删除语义与 generation manifest 不一致: {key}')
        if record.get('deleted') is True:
            if target.exists():
                raise PublishDataValidationError(f'review 后应删除的文件重新出现: {key}')
        else:
            expected = record.get('sha256')
            if not target.is_file() or not re.fullmatch(r'[0-9a-f]{64}', str(expected or '')):
                raise PublishDataValidationError(f'已审查文件缺失或哈希非法: {key}')
            evidence_protocol = record.get('reviewProtocolFingerprint')
            if evidence_protocol is not None and not re.fullmatch(
                r'[0-9a-f]{64}', str(evidence_protocol)
            ):
                raise PublishDataValidationError(f'已审查文件协议指纹非法: {key}')
            actual = _sha256_file(target)
            if actual != expected:
                raise PublishDataValidationError(f'文件在 review 后已变更，拒绝推送: {key}')
        paths.append(target)
    if seen != set(expectations):
        raise PublishDataValidationError('审查凭证文件集合与 generation manifest 不一致')
    if receipt.get('reviewMode') == MANUAL_REVIEW_MODE:
        provenance = receipt['reviewProvenance']
        if provenance.get('fileCount') != len(records):
            raise PublishDataValidationError('manual_complete provenance fileCount 与凭证不一致')
        if provenance.get('reviewedPathSetSha256') != _reviewed_path_set_sha256(records):
            raise PublishDataValidationError('manual_complete provenance 文件集合哈希不一致')
        if provenance.get('reviewProtocolFingerprint') != receipt.get('reviewProtocolFingerprint'):
            raise PublishDataValidationError('manual_complete provenance 协议指纹不一致')
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
        description='只生成并安装博客页面及 generation manifest；不 review、不推送。',
        allow_abbrev=False,
    )
    parser.add_argument('data_file', nargs='?', help='可选的深度分析 JSON 文件')
    parser.add_argument('--date', action='append', metavar='YYYY-MM-DD')
    parser.add_argument('--category', action='append')
    parser.add_argument('--exclude-id', action='append', default=[], metavar='ARXIV_ID')
    parser.add_argument('--include-id', action='append', default=[], metavar='ARXIV_ID')
    parser.add_argument('--sealed-tutorial-preview', action='count', default=0,
                        help='仅将受控单篇 tutorial preview 的 post.md 原字节发布')
    parser.add_argument('--legacy-v5-maintenance', action='count', default=0,
                        help='显式只读旧 v5 canonical 维护入口；禁止成为默认日更输入')
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
    sealed_tutorial_preview = bool(options.get('sealed_tutorial_preview'))
    legacy_v5_maintenance = bool(options.get('legacy_v5_maintenance'))

    try:
        blog_repo, content_dir = validate_publish_target()
        today = validate_publish_date(get_today_bj(target_date))
    except PublishDataValidationError as exc:
        print(f"\n❌ 发布目标校验失败: {exc}")
        sys.exit(1)
    print(f"📅 博客日期: {today}")
    sealed_preview = None
    if sealed_tutorial_preview:
        publication_mode = SEALED_TUTORIAL_PREVIEW_MODE
        normalized_include = normalize_publish_arxiv_id(include_id)
        try:
            sealed_preview = load_sealed_tutorial_preview(today, normalized_include)
        except PublishDataValidationError as exc:
            print(f"\n❌ sealed tutorial preview 预检失败，未读取 canonical、未写博客：{exc}")
            sys.exit(1)
        papers = [sealed_preview['snapshot']]
        normalized_excluded = []
        print(
            f'🔒 sealed tutorial preview：{normalized_include}；'
            '原字节发布，不读取 canonical、不 sanitize、不生成汇总页'
        )
    else:
        publication_mode = LEGACY_V5_MAINTENANCE_MODE if legacy_v5_maintenance else None
        data_file = select_generation_data_file(
            data_file, today, publish_all, legacy_v5_maintenance,
        )
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

    if sealed_preview is None:
        try:
            papers = validate_papers_for_publish(papers)
            papers = apply_publish_image_exclusions(papers)
            papers = validate_papers_for_publish(
                papers, validate_manual_provenance=False,
            )
            if publication_mode is None:
                publication_mode = infer_generation_publication_mode(papers)
            validate_generation_publication_mode(papers, publication_mode)
        except PublishDataValidationError as exc:
            print(f"\n❌ 发布数据预检失败，未生成任何博客文件：\n{exc}")
            sys.exit(1)
    if sealed_preview is not None:
        # A single-page sealed release has no digest index to rank.  Its score
        # is already rendered and hash-bound inside post.md; reparsing a
        # canonical analysis here would violate the cold-start boundary.
        scored, unscored = [], list(papers)
    else:
        scored, unscored = score_and_sort(papers)
    baseline_label = 'sealed tutorial preview' if sealed_preview else 'analysis 重解析结果'
    print(f"✅ 发布数据预检通过: {len(papers)} 篇论文以 {baseline_label} 为发布基线")

    input_fingerprint = generation_input_fingerprint(
        papers, today, category, publish_all, normalized_include,
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
    reusable = reusable_generation_manifest(
        today, input_fingerprint, template_fingerprint, base_head,
    )
    if reusable is not None:
        publish_paths, manifest_path = reusable
        generation_journal_path(today).unlink(missing_ok=True)
        shutil.rmtree(generation_stage_path(today).parent, ignore_errors=True)
        print(f'♻️ 相同 generation 已完整安装，复用生成清单且保留 review 状态: {manifest_path}')
        return

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
        paper_slugs = {}
        for paper, record in zip(papers, journal['papers']):
            slug = record['filename'][len(today) + 1:-3]
            paper_slugs[paper.get('arxivId', '')] = slug
            if record.get('status') != 'generated':
                if sealed_preview is not None:
                    paper_md = sealed_preview['postText']
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
                if sealed_preview is not None:
                    if paper_file.read_text(encoding='utf-8') != sealed_preview['postText']:
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
