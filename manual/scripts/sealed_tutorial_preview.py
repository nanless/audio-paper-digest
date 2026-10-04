"""核验单篇教程预览的文件和发布记录，不改写页面。

本模块按指定日期和论文定位固定预览目录，并核对相关文件的 SHA。
它不读取正式深度分析正文；核验通过后返回 post.md 的 UTF-8 页面文本和发布记录。
筛选结果文件仅提供论文元数据；预览检查通过不代表博客审查或部署已经完成。
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
            raise PublishDataValidationError(f'{label} 必须是普通文件，且不得是符号链接。')
        path = candidate.resolve(strict=True)
        if not path.is_file():
            raise PublishDataValidationError(f'{label} 必须是普通文件，且不得是符号链接。')
        return path.read_bytes()
    except OSError as exc:
        raise PublishDataValidationError(f'{label} 无法读取，路径为 {path}。') from exc


def _load_json_regular(path, label):
    raw = _read_regular(path, label)
    try:
        value = json.loads(raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(f'{label} 不是有效的 UTF-8 JSON。') from exc
    if not isinstance(value, dict):
        raise PublishDataValidationError(f'{label} 的顶层必须是对象。')
    return value, raw


def _exact_bound_file(binding, expected_path, label):
    if not isinstance(binding, dict):
        raise PublishDataValidationError(f'{label} 的文件记录缺失，或不是对象。')
    try:
        candidate = Path(str(binding.get('path') or ''))
        if candidate.is_symlink():
            raise PublishDataValidationError(f'{label} 不得使用符号链接。')
        actual_path = candidate.resolve(strict=True)
        expected_path = Path(expected_path).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PublishDataValidationError(f'{label} 记录的路径或指定文件路径不存在，或无法解析。') from exc
    if actual_path != expected_path:
        raise PublishDataValidationError(f'{label} 记录的路径与指定文件路径不一致。')
    raw = _read_regular(actual_path, label)
    digest = _sha256_bytes(raw)
    if binding.get('sha256') != digest:
        raise PublishDataValidationError(f'{label} 的 SHA-256 与记录不一致。')
    return raw, digest


def _find_filtered_metadata(date_str, paper_id, current_dir):
    filtered_path = Path(current_dir).resolve() / FILTERED_PAPERS_FILE.name
    filtered, _raw = _load_json_regular(filtered_path, 'filtered-papers')
    if filtered.get('status') != 'complete' or filtered.get('batchDate') != date_str:
        raise PublishDataValidationError(
            f'筛选结果的日期必须为 {date_str}，且批次状态必须为 complete。'
        )
    matches = [
        item for item in filtered.get('papers', []) if isinstance(item, dict)
        and normalize_publish_arxiv_id(item.get('arxivId')) == paper_id
    ]
    if len(matches) != 1:
        raise PublishDataValidationError(
            f'筛选结果中必须恰好包含一条论文 {paper_id} 的元数据记录。'
        )
    title = str(matches[0].get('title') or '').strip()
    if len(title) < 3:
        raise PublishDataValidationError(f'{paper_id} 的筛选记录标题长度不足 3 个字符。')
    return matches[0], filtered_path


def load_verified_tutorial_preview(date_str, paper_id, *, current_dir=CURRENT_DIR):
    """按原字节读取 post.md，不改写其正文，返回页面文本及不含分析正文的发布记录。"""
    paper_id = normalize_publish_arxiv_id(paper_id)
    if not paper_id:
        raise PublishDataValidationError('单篇教程预览缺少有效的 arXiv ID。')
    root = Path(current_dir).resolve() / 'manual-tutorial-previews' / date_str / paper_id
    manifest_path = root / 'manifest.json'
    post_path = root / 'post.md'
    manifest, manifest_bytes = _load_json_regular(
        manifest_path, '单篇教程预览清单'
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
            '单篇教程预览清单的版本、模式、状态、日期或论文 ID 与当前要求不一致。'
        )
    expected_isolation = {
        'singlePaperOnly': True,
        'blogRepositoryTouched': False,
        'canonicalMutated': False,
        'imagesGenerated': False,
        'otherPapersGenerated': False,
    }
    if manifest.get('isolation') != expected_isolation:
        raise PublishDataValidationError('单篇教程预览清单中的隔离声明与规定不一致。')

    output = manifest.get('output')
    if not isinstance(output, dict):
        raise PublishDataValidationError('单篇教程预览清单缺少有效的输出记录。')
    try:
        output_path = Path(str(output.get('path') or '')).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PublishDataValidationError('单篇教程预览的输出路径不存在，或无法解析。') from exc
    if output_path != post_path.resolve():
        raise PublishDataValidationError('单篇教程预览的输出路径不是指定的 post.md 文件。')
    post_bytes = _read_regular(post_path, '单篇教程预览 post.md')
    post_sha = _sha256_bytes(post_bytes)
    if output.get('postSha256') != post_sha or output.get('bytes') != len(post_bytes):
        raise PublishDataValidationError('单篇教程预览的 post.md SHA 或字节数与清单记录不一致。')
    try:
        post_text = post_bytes.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise PublishDataValidationError('单篇教程预览的 post.md 不是有效的 UTF-8 文本。') from exc

    inputs = manifest.get('inputs')
    if not isinstance(inputs, dict):
        raise PublishDataValidationError('单篇教程预览清单缺少有效的输入记录。')
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
        raise PublishDataValidationError('单篇教程材料记录缺失、格式无效，或论文 ID 与当前论文不一致。')
    for field in (
        'articleSha256', 'freshAuthoringReceiptSha256', 'qualityFileSha256',
        'qualityPacketSha256', 'artifactPlanFileSha256', 'artifactPlanSha256',
        'artifactPlanBindingSha256', 'receiptSha256',
    ):
        if not SHA256_RE.fullmatch(str(payload.get(field) or '')):
            raise PublishDataValidationError(f'单篇教程材料记录中的 {field} 缺失，或不是有效的 SHA。')
    if payload['qualityFileSha256'] != replayed['quality']['sha256']:
        raise PublishDataValidationError('单篇教程材料记录中的质量检查文件 SHA 与实际文件不一致。')
    article_file_sha = replayed['article']['sha256']
    article_binding_sha = str(inputs.get('article', {}).get('sha256') or '')
    if article_binding_sha != article_file_sha:
        raise PublishDataValidationError('单篇教程清单中的正文文件 SHA 与实际 article.md 文件不一致。')
    plan_path = root / 'artifact-plan.json'
    plan_raw, plan_file_sha = _exact_bound_file(
        {'path': payload.get('artifactPlanPath'), 'sha256': payload.get('artifactPlanFileSha256')},
        plan_path, 'tutorialPayload.artifactPlanPath',
    )
    try:
        plan_value = json.loads(plan_raw.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError('artifact-plan.json 不是有效的 UTF-8 JSON。') from exc
    stable_plan = json.dumps(
        plan_value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')
    if _sha256_bytes(stable_plan) != payload['artifactPlanSha256']:
        raise PublishDataValidationError('单篇教程材料记录中的图表计划对象 SHA 与按固定 JSON 格式重新计算的结果不一致。')

    try:
        frontmatter, body = parse_frontmatter_content(post_path, post_text)
    except PublishDataValidationError:
        raise
    if str(frontmatter.get('date') or '') != date_str:
        raise PublishDataValidationError(
            '单篇教程页面头部的日期与目标发布日期不一致。'
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
                f'单篇教程页面头部的 {field} 与规定值或教程材料记录不一致。'
            )
    format_issues = validate_markdown_format_gate(post_path, frontmatter, body)
    if format_issues:
        raise PublishDataValidationError('; '.join(format_issues))
    article_text = replayed['article']['raw'].decode('utf-8').strip()
    if body.count(article_text) != 1:
        raise PublishDataValidationError(
            '单篇教程页面必须恰好包含一次去除首尾空白后的 article.md 正文。'
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
