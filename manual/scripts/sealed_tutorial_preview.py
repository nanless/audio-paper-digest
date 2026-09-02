"""Verify a sealed single-paper tutorial preview for byte-exact publication.

This boundary intentionally never opens the canonical deep-analysis file.  It
accepts only the fixed preview directory for the requested date/paper, replays
the file hashes that author the visible page, and returns the already-reviewed
``post.md`` bytes unchanged.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

SHARED_SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
if str(SHARED_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SHARED_SCRIPTS))

from markdown_hugo_gate import (
    parse_frontmatter_content,
    validate_markdown_format_gate,
)
from path_config import CURRENT_DIR, FILTERED_PAPERS_FILE
from publish_common import PublishDataValidationError, normalize_publish_arxiv_id
from tutorial_payload_verifier import (
    FRESH_AUTHORING_CONTRACT,
    MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
    TUTORIAL_FORMAT_CONTRACT,
)


SEALED_TUTORIAL_PUBLICATION_CONTRACT = 'sealed-tutorial-preview-publication-v1'
PREVIEW_MODE = 'manual_tutorial_preview'
PREVIEW_VERSION = 5
SHA256_RE = re.compile(r'^[a-f0-9]{64}$')


def _sha256_bytes(value):
    return hashlib.sha256(value).hexdigest()


def _read_regular(path, label):
    candidate = Path(path)
    try:
        if candidate.is_symlink():
            raise PublishDataValidationError(f'{label} 必须是非符号链接普通文件')
        path = candidate.resolve(strict=True)
        if not path.is_file():
            raise PublishDataValidationError(f'{label} 必须是非符号链接普通文件')
        return path.read_bytes()
    except OSError as exc:
        raise PublishDataValidationError(f'{label} 无法读取: {path}') from exc


def _load_json_regular(path, label):
    raw = _read_regular(path, label)
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'{label} 不是合法 UTF-8 JSON') from exc
    if not isinstance(value, dict):
        raise PublishDataValidationError(f'{label} 顶层必须是对象')
    return value, raw


def _exact_bound_file(binding, expected_path, label):
    if not isinstance(binding, dict):
        raise PublishDataValidationError(f'{label} 缺少文件绑定')
    try:
        candidate = Path(str(binding.get('path') or ''))
        if candidate.is_symlink():
            raise PublishDataValidationError(f'{label} 不得使用符号链接')
        actual_path = candidate.resolve(strict=True)
        expected_path = Path(expected_path).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PublishDataValidationError(f'{label} 绑定路径不存在') from exc
    if actual_path != expected_path:
        raise PublishDataValidationError(f'{label} 未绑定固定受控路径')
    raw = _read_regular(actual_path, label)
    digest = _sha256_bytes(raw)
    if binding.get('sha256') != digest:
        raise PublishDataValidationError(f'{label} SHA-256 漂移')
    return raw, digest


def _find_filtered_metadata(date_str, paper_id, current_dir):
    filtered_path = Path(current_dir).resolve() / FILTERED_PAPERS_FILE.name
    filtered, _raw = _load_json_regular(filtered_path, 'filtered-papers')
    if filtered.get('status') != 'complete' or filtered.get('batchDate') != date_str:
        raise PublishDataValidationError(
            f'filtered-papers 必须是 {date_str} 的 complete 批次'
        )
    matches = [
        item for item in filtered.get('papers', []) if isinstance(item, dict)
        and normalize_publish_arxiv_id(item.get('arxivId')) == paper_id
    ]
    if len(matches) != 1:
        raise PublishDataValidationError(
            f'filtered-papers 必须精确包含一条 {paper_id} metadata'
        )
    title = str(matches[0].get('title') or '').strip()
    if len(title) < 3:
        raise PublishDataValidationError(f'{paper_id} filtered metadata 缺少标题')
    return matches[0], filtered_path


def load_sealed_tutorial_preview(date_str, paper_id, *, current_dir=CURRENT_DIR):
    """Return byte-exact post text and a prose-free publication snapshot."""
    paper_id = normalize_publish_arxiv_id(paper_id)
    if not paper_id:
        raise PublishDataValidationError('sealed tutorial preview 缺少合法 arXiv ID')
    root = Path(current_dir).resolve() / 'manual-tutorial-previews' / date_str / paper_id
    manifest_path = root / 'manifest.json'
    post_path = root / 'post.md'
    manifest, manifest_bytes = _load_json_regular(
        manifest_path, 'sealed tutorial preview manifest'
    )
    if (
        manifest.get('version') != PREVIEW_VERSION
        or manifest.get('mode') != PREVIEW_MODE
        or manifest.get('status') != 'complete'
        or manifest.get('date') != date_str
        or normalize_publish_arxiv_id(manifest.get('paperId')) != paper_id
        or manifest.get('paperId') != paper_id
    ):
        raise PublishDataValidationError(
            'sealed tutorial preview manifest 版本、模式、状态、日期或论文身份不匹配'
        )
    expected_isolation = {
        'singlePaperOnly': True,
        'blogRepositoryTouched': False,
        'canonicalMutated': False,
        'imagesGenerated': False,
        'otherPapersGenerated': False,
    }
    if manifest.get('isolation') != expected_isolation:
        raise PublishDataValidationError('sealed tutorial preview isolation 声明非法')

    output = manifest.get('output')
    if not isinstance(output, dict):
        raise PublishDataValidationError('sealed tutorial preview 缺少 output')
    try:
        output_path = Path(str(output.get('path') or '')).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PublishDataValidationError('sealed tutorial preview output.path 不存在') from exc
    if output_path != post_path.resolve():
        raise PublishDataValidationError('sealed tutorial preview output.path 路径逃逸')
    post_bytes = _read_regular(post_path, 'sealed tutorial preview post.md')
    post_sha = _sha256_bytes(post_bytes)
    if output.get('postSha256') != post_sha or output.get('bytes') != len(post_bytes):
        raise PublishDataValidationError('sealed tutorial preview post.md SHA/字节数漂移')
    try:
        post_text = post_bytes.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise PublishDataValidationError('sealed tutorial preview post.md 不是 UTF-8') from exc

    inputs = manifest.get('inputs')
    if not isinstance(inputs, dict):
        raise PublishDataValidationError('sealed tutorial preview 缺少 inputs')
    controlled_files = {
        'article': root / 'draft' / 'article.md',
        'quality': root / 'quality.json',
        'editorialContract': Path(__file__).resolve().parents[1] / 'prompts' / 'manual-tutorial-article.md',
        'referenceContract': Path(__file__).resolve().parents[1] / 'docs' / 'editorial-reference-contract.md',
        'qualitySchema': Path(__file__).resolve().parent / 'manual-tutorial-quality-contract.js',
    }
    replayed = {}
    for key, expected in controlled_files.items():
        raw, digest = _exact_bound_file(inputs.get(key), expected, f'preview.inputs.{key}')
        replayed[key] = {'raw': raw, 'sha256': digest}

    payload = inputs.get('tutorialPayload')
    if not isinstance(payload, dict) \
            or payload.get('contract') != MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT \
            or payload.get('paperId') != paper_id:
        raise PublishDataValidationError('sealed tutorial payload contract/paperId 非法')
    for field in (
        'articleSha256', 'freshAuthoringReceiptSha256', 'qualityFileSha256',
        'qualityPacketSha256', 'artifactPlanFileSha256', 'artifactPlanSha256',
        'artifactPlanBindingSha256', 'receiptSha256',
    ):
        if not SHA256_RE.fullmatch(str(payload.get(field) or '')):
            raise PublishDataValidationError(f'sealed tutorial payload 缺少 SHA: {field}')
    if payload['qualityFileSha256'] != replayed['quality']['sha256']:
        raise PublishDataValidationError('sealed tutorial payload quality 文件绑定漂移')
    article_file_sha = replayed['article']['sha256']
    article_binding_sha = str(inputs.get('article', {}).get('sha256') or '')
    if article_binding_sha != article_file_sha:
        raise PublishDataValidationError('sealed tutorial payload article 文件绑定漂移')
    plan_path = root / 'artifact-plan.json'
    plan_raw, plan_file_sha = _exact_bound_file(
        {'path': payload.get('artifactPlanPath'), 'sha256': payload.get('artifactPlanFileSha256')},
        plan_path, 'tutorialPayload.artifactPlanPath',
    )
    try:
        plan_value = json.loads(plan_raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError('artifact-plan.json 非法') from exc
    stable_plan = json.dumps(
        plan_value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')
    if _sha256_bytes(stable_plan) != payload['artifactPlanSha256']:
        raise PublishDataValidationError('sealed tutorial payload artifact plan 语义 SHA 漂移')

    try:
        frontmatter, body = parse_frontmatter_content(post_path, post_text)
    except PublishDataValidationError:
        raise
    if str(frontmatter.get('date') or '') != date_str:
        raise PublishDataValidationError(
            'sealed tutorial preview frontmatter date 未绑定 sealed payload'
        )
    expected_frontmatter = {
        'draft': False,
        'paper_digest_pipeline_owned': True,
        'paper_digest_page_type': 'paper',
        'paper_digest_arxiv_id': paper_id,
        'paper_digest_tutorial_contract': TUTORIAL_FORMAT_CONTRACT,
        'paper_digest_fresh_authoring_contract': FRESH_AUTHORING_CONTRACT,
        'paper_digest_tutorial_payload_contract': MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
        'paper_digest_fresh_authoring_sha256': payload['freshAuthoringReceiptSha256'],
        'paper_digest_reader_article_sha256': payload['articleSha256'],
        'paper_digest_tutorial_payload_sha256': payload['receiptSha256'],
        'paper_digest_tutorial_quality_sha256': payload['qualityPacketSha256'],
        'paper_digest_tutorial_artifact_plan_sha256': payload['artifactPlanSha256'],
    }
    for field, expected in expected_frontmatter.items():
        if frontmatter.get(field) != expected:
            raise PublishDataValidationError(
                f'sealed tutorial preview frontmatter {field} 未绑定 sealed payload'
            )
    format_issues = validate_markdown_format_gate(post_path, frontmatter, body)
    if format_issues:
        raise PublishDataValidationError('; '.join(format_issues))
    article_text = replayed['article']['raw'].decode('utf-8').strip()
    if body.count(article_text) != 1:
        raise PublishDataValidationError(
            'sealed tutorial preview 必须逐字且仅一次包含 fresh article.md'
        )

    metadata, filtered_path = _find_filtered_metadata(date_str, paper_id, current_dir)
    snapshot = {
        'arxivId': paper_id,
        'title': str(metadata.get('title')).strip(),
        'authors': metadata.get('authors', []),
        'fetchBatchDate': date_str,
        'publishImageExclusions': [],
        'sealedTutorialPreview': {
            'contract': SEALED_TUTORIAL_PUBLICATION_CONTRACT,
            'manifestPath': str(manifest_path.resolve()),
            'manifestSha256': _sha256_bytes(manifest_bytes),
            'postSha256': post_sha,
            'articleFileSha256': article_file_sha,
            'tutorialPayloadSha256': payload['receiptSha256'],
            'qualityFileSha256': replayed['quality']['sha256'],
            'artifactPlanFileSha256': plan_file_sha,
            'filteredMetadataPath': str(filtered_path),
        },
    }
    return {
        'postText': post_text,
        'postSha256': post_sha,
        'manifest': manifest,
        'snapshot': snapshot,
        'frontmatter': frontmatter,
    }
