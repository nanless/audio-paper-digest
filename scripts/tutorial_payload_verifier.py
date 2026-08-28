"""Fail-closed verification for sealed Manual v5 tutorial payloads.

This module owns the filesystem replay boundary only.  It deliberately does
not render Markdown, mutate canonical data, or know about publication scope.
The generator may therefore reuse it for batch and single-paper releases
without creating a second authoring path.
"""

import hashlib
import json
import re
import unicodedata
from pathlib import Path

from path_config import CURRENT_DIR, PROJECT_ROOT
from publish_common import PublishDataValidationError, normalize_publish_arxiv_id


TUTORIAL_FORMAT_CONTRACT = 'graduate-researcher-tutorial-quality-v2'
FRESH_AUTHORING_CONTRACT = 'fresh-authoring-v1'
FRESH_AUTHORING_MODE = 'fresh_from_evidence'
MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT = 'manual-v5-tutorial-payload-v1'
MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT = 'manual-tutorial-validation-orchestrator-v1'
MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT = (
    '18809add501110190affd304aff462c504770ce2b8c48a08b11b6bdf46058f7b'
)
FRESH_AUTHORING_INPUT_KINDS = (
    'paper_metadata', 'source_snapshot', 'artifact_index',
    'authoring_prompt', 'editorial_contract', 'blank_schema',
)
OPTIONAL_FRESH_AUTHORING_INPUT_KINDS = ('official_project_evidence',)


def stable_json_sha256(value):
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def normalize_fresh_article(value):
    return unicodedata.normalize('NFKC', str(value or '')).replace(
        '\r\n', '\n',
    ).replace('\r', '\n').strip()


def validate_manual_v5_fresh_authoring(
        paper, article, date_str, *, current_dir=CURRENT_DIR,
        project_root=PROJECT_ROOT):
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    fresh = takeover.get('freshAuthoring') if isinstance(takeover, dict) else None
    paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
    if not isinstance(fresh, dict) \
            or fresh.get('contract') != FRESH_AUTHORING_CONTRACT \
            or fresh.get('mode') != FRESH_AUTHORING_MODE:
        raise PublishDataValidationError(
            f'{paper_id} Manual v5 缺少 {FRESH_AUTHORING_CONTRACT} 文件凭证'
        )
    if not isinstance(fresh.get('authoringSessionId'), str) \
            or len(fresh['authoringSessionId'].strip()) < 12:
        raise PublishDataValidationError(f'{paper_id} fresh authoring session 非法')
    if fresh.get('prohibitedProseInputs') != []:
        raise PublishDataValidationError(
            f'{paper_id} fresh prohibitedProseInputs 必须为空，旧正文不得进入生成或修订输入'
        )
    expected_article_path = (
        current_dir / 'manual-tutorial-previews' / date_str / paper_id
        / 'draft' / 'article.md'
    ).resolve()
    try:
        article_path = Path(str(fresh.get('articlePath') or '')).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise PublishDataValidationError(f'{paper_id} fresh article.md 不存在') from exc
    if article_path != expected_article_path or article_path.is_symlink() \
            or not article_path.is_file():
        raise PublishDataValidationError(f'{paper_id} fresh article.md 未绑定受控路径')
    raw_bytes = article_path.read_bytes()
    raw_sha = hashlib.sha256(raw_bytes).hexdigest()
    try:
        file_article = raw_bytes.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise PublishDataValidationError(f'{paper_id} fresh article.md 不是 UTF-8') from exc
    normalized_sha = hashlib.sha256(
        normalize_fresh_article(file_article).encode('utf-8')
    ).hexdigest()
    if fresh.get('articleFileSha256') != raw_sha \
            or fresh.get('articleSha256') != normalized_sha \
            or normalize_fresh_article(article) != normalize_fresh_article(file_article):
        raise PublishDataValidationError(
            f'{paper_id} fresh article.md raw/NFKC SHA 或正文发生漂移'
        )

    official_evidence_path = (
        current_dir / 'manual-full-text' / date_str / 'external-evidence'
        / f'{paper_id}-official-project.json'
    ).resolve()
    expected_kinds = list(FRESH_AUTHORING_INPUT_KINDS)
    if official_evidence_path.is_file():
        expected_kinds.append('official_project_evidence')
    inputs = fresh.get('inputs')
    if not isinstance(inputs, list) or len(inputs) != len(expected_kinds):
        raise PublishDataValidationError(
            f'{paper_id} fresh inputs 未精确覆盖当前权威输入'
        )
    by_kind = {}
    allowed_kinds = FRESH_AUTHORING_INPUT_KINDS + OPTIONAL_FRESH_AUTHORING_INPUT_KINDS
    for item in inputs:
        if not isinstance(item, dict) or item.get('kind') not in allowed_kinds \
                or item['kind'] in by_kind:
            raise PublishDataValidationError(f'{paper_id} fresh inputs kind 非法或重复')
        by_kind[item['kind']] = item
    if set(by_kind) != set(expected_kinds):
        raise PublishDataValidationError(
            f'{paper_id} fresh inputs 含缺失、额外或旧 prose 输入'
        )
    static_paths = {
        'authoring_prompt': (
            project_root / 'prompts' / 'manual-tutorial-article.md'
        ).resolve(),
        'editorial_contract': (
            project_root / 'docs' / 'manual-editorial-reference-contract.md'
        ).resolve(),
        'blank_schema': (
            project_root / 'scripts' / 'manual-tutorial-quality-contract.js'
        ).resolve(),
    }
    evidence_root = (current_dir / 'manual-full-text' / date_str).resolve()
    for kind in expected_kinds:
        item = by_kind[kind]
        try:
            bound_path = Path(str(item.get('path') or '')).resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise PublishDataValidationError(
                f'{paper_id} fresh authority {kind} 不存在'
            ) from exc
        if bound_path.is_symlink() or not bound_path.is_file():
            raise PublishDataValidationError(
                f'{paper_id} fresh authority {kind} 不是普通文件'
            )
        if kind in static_paths and bound_path != static_paths[kind]:
            raise PublishDataValidationError(
                f'{paper_id} fresh authority {kind} 未绑定当前固定契约'
            )
        if kind == 'paper_metadata' \
                and bound_path != (current_dir / 'filtered-papers.json').resolve():
            raise PublishDataValidationError(
                f'{paper_id} fresh metadata 未绑定当前 filtered-papers.json'
            )
        if kind in {'source_snapshot', 'artifact_index'}:
            try:
                bound_path.relative_to(evidence_root)
            except ValueError as exc:
                raise PublishDataValidationError(
                    f'{paper_id} fresh authority {kind} 逃逸本日证据目录'
                ) from exc
        if kind == 'artifact_index':
            try:
                artifact_index = json.loads(bound_path.read_text(encoding='utf-8'))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PublishDataValidationError(
                    f'{paper_id} fresh ArtifactIndex 不可读'
                ) from exc
            if artifact_index.get('paperId') != paper_id \
                    or artifact_index.get('inventoryHealth', {}).get('status') != 'complete':
                raise PublishDataValidationError(
                    f'{paper_id} fresh ArtifactIndex 必须属于本篇且 inventory complete'
                )
        if kind == 'official_project_evidence':
            if bound_path != official_evidence_path:
                raise PublishDataValidationError(
                    f'{paper_id} official_project_evidence 未绑定日期级固定路径'
                )
            try:
                evidence = json.loads(bound_path.read_text(encoding='utf-8'))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise PublishDataValidationError(
                    f'{paper_id} official_project_evidence 不可读'
                ) from exc
            if evidence.get('paperId') != paper_id \
                    or evidence.get('kind') != 'official_project_evidence' \
                    or not str(evidence.get('url') or '').startswith('https://'):
                raise PublishDataValidationError(
                    f'{paper_id} official_project_evidence paperId/kind/HTTPS URL 非法'
                )
        actual_sha = hashlib.sha256(bound_path.read_bytes()).hexdigest()
        if item.get('sha256') != actual_sha:
            raise PublishDataValidationError(
                f'{paper_id} fresh authority {kind} 文件 SHA 漂移'
            )
    normalized_receipt = {
        'contract': FRESH_AUTHORING_CONTRACT,
        'mode': FRESH_AUTHORING_MODE,
        'authoringSessionId': fresh['authoringSessionId'].strip(),
        'articlePath': str(article_path),
        'articleSha256': normalized_sha,
        'articleFileSha256': raw_sha,
        'prohibitedProseInputs': [],
        'inputs': [by_kind[kind] for kind in expected_kinds],
    }
    receipt_sha = stable_json_sha256(normalized_receipt)
    if fresh.get('receiptSha256') != receipt_sha \
            or takeover.get('freshAuthoringSha256') != stable_json_sha256(fresh):
        raise PublishDataValidationError(
            f'{paper_id} fresh receipt/canonical SHA 不闭环'
        )
    return {'receiptSha256': receipt_sha, 'articleSha256': normalized_sha}


def validate_manual_v5_tutorial_payload(
        paper, article, date_str, *, current_dir=CURRENT_DIR):
    """Replay the sealed v5 quality/artifact package from its real files."""
    manifest = paper.get('analysisManifest') if isinstance(paper, dict) else None
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    takeover = manifest.get('manualTakeover') if isinstance(manifest, dict) else None
    paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
    if not isinstance(contracts, dict) \
            or contracts.get('tutorialPayload') != MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT:
        raise PublishDataValidationError(
            f'{paper_id} Manual v5 缺少 {MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT}；'
            '历史 v5 只读兼容但不得重新包装'
        )
    payload = takeover.get('tutorialPayload') if isinstance(takeover, dict) else None
    fresh = takeover.get('freshAuthoring') if isinstance(takeover, dict) else None
    if not isinstance(payload, dict) \
            or payload.get('contract') != MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT:
        raise PublishDataValidationError(
            f'{paper_id} canonical 缺少 sealed tutorial payload'
        )
    if payload.get('orchestratorContract') != MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT \
            or payload.get('orchestratorFingerprint') \
            != MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT:
        raise PublishDataValidationError(
            f'{paper_id} tutorial payload 未绑定当前统一质量 orchestrator 协议'
        )
    expected_root = (
        current_dir / 'manual-tutorial-previews' / date_str / paper_id
    ).resolve()
    expected_paths = {
        'qualityPath': expected_root / 'quality.json',
        'artifactPlanPath': expected_root / 'artifact-plan.json',
    }
    documents = {}
    for field, expected_path in expected_paths.items():
        try:
            bound_path = Path(str(payload.get(field) or '')).resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise PublishDataValidationError(
                f'{paper_id} tutorial payload {field} 不存在'
            ) from exc
        if bound_path != expected_path or bound_path.is_symlink() \
                or not bound_path.is_file():
            raise PublishDataValidationError(
                f'{paper_id} tutorial payload {field} 未绑定受控普通文件'
            )
        raw = bound_path.read_bytes()
        sha_field = (
            'qualityFileSha256' if field == 'qualityPath'
            else 'artifactPlanFileSha256'
        )
        if payload.get(sha_field) != hashlib.sha256(raw).hexdigest():
            raise PublishDataValidationError(
                f'{paper_id} tutorial payload {field} 文件 SHA 漂移'
            )
        try:
            documents[field] = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PublishDataValidationError(
                f'{paper_id} tutorial payload {field} JSON 损坏'
            ) from exc
    quality = documents['qualityPath']
    plan = documents['artifactPlanPath']
    if not isinstance(quality, dict) or not isinstance(plan, dict):
        raise PublishDataValidationError(
            f'{paper_id} tutorial quality/plan 顶层必须是对象'
        )
    quality_sha = stable_json_sha256(quality)
    plan_sha = stable_json_sha256(plan)
    if payload.get('qualityPacketSha256') != quality_sha \
            or payload.get('artifactPlanSha256') != plan_sha:
        raise PublishDataValidationError(
            f'{paper_id} tutorial quality/plan 对象 SHA 漂移'
        )
    if quality.get('contract') != TUTORIAL_FORMAT_CONTRACT \
            or quality.get('paperId') != paper_id \
            or payload.get('qualityContract') != TUTORIAL_FORMAT_CONTRACT:
        raise PublishDataValidationError(
            f'{paper_id} tutorial quality contract 或单篇身份非法'
        )
    normalized_article = normalize_fresh_article(article)
    article_sha = hashlib.sha256(normalized_article.encode('utf-8')).hexdigest()
    quality_fresh = quality.get('freshAuthoring')
    fresh_fields = (
        'contract', 'mode', 'authoringSessionId', 'articleSha256',
        'articleFileSha256', 'prohibitedProseInputs', 'inputs',
    )
    if not isinstance(quality_fresh, dict) or not isinstance(fresh, dict) \
            or stable_json_sha256({key: quality_fresh.get(key) for key in fresh_fields}) \
            != stable_json_sha256({key: fresh.get(key) for key in fresh_fields}) \
            or payload.get('articleSha256') != article_sha \
            or payload.get('freshAuthoringReceiptSha256') != fresh.get('receiptSha256'):
        raise PublishDataValidationError(
            f'{paper_id} tutorial payload 与 fresh article receipt 不一致'
        )
    plan_binding_sha = hashlib.sha256(json.dumps(
        plan, ensure_ascii=False, separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
    binding = quality.get('artifactPlan')
    if not isinstance(binding, dict) or binding.get('paperId') != paper_id \
            or binding.get('version') != plan.get('version') \
            or binding.get('sha256') != plan_binding_sha \
            or payload.get('artifactPlanBindingSha256') != plan_binding_sha \
            or plan.get('paperId') != paper_id:
        raise PublishDataValidationError(
            f'{paper_id} tutorial quality 未绑定当前 artifact plan'
        )
    fresh_inputs = {
        item.get('kind'): item
        for item in fresh.get('inputs', []) if isinstance(item, dict)
    }
    artifact_input = fresh_inputs.get('artifact_index')
    try:
        artifact_path = Path(
            str((artifact_input or {}).get('path') or '')
        ).resolve(strict=True)
        artifact_index = json.loads(artifact_path.read_text(encoding='utf-8'))
    except (OSError, RuntimeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PublishDataValidationError(
            f'{paper_id} tutorial ArtifactIndex 不可重放'
        ) from exc
    artifact_identity = (
        artifact_index.get('outputSha256')
        or artifact_index.get('artifactIndexSha256')
    )
    if artifact_index.get('paperId') != paper_id \
            or artifact_index.get('inventoryHealth', {}).get('status') != 'complete' \
            or payload.get('artifactIndexSha256') != artifact_identity \
            or plan.get('artifactIndexSha256') != artifact_identity:
        raise PublishDataValidationError(
            f'{paper_id} tutorial payload 未绑定 complete ArtifactIndex'
        )
    for key in ('tables', 'figures', 'formulas'):
        source_ids = [item.get('id') for item in artifact_index.get(key, [])]
        plan_ids = [item.get('id') for item in plan.get(key, [])]
        coverage_ids = [
            item.get('id')
            for item in plan.get('coverageMatrix', {}).get(key, [])
        ]
        if source_ids != plan_ids or source_ids != coverage_ids \
                or len(source_ids) != len(set(source_ids)):
            raise PublishDataValidationError(
                f'{paper_id} tutorial artifact plan 未逐项覆盖 {key}'
            )
    table_dispositions = {
        item.get('artifactId'): item
        for item in quality.get('artifactDisposition', {}).get('tables', [])
    }
    figure_dispositions = {
        item.get('artifactId'): item
        for item in quality.get('artifactDisposition', {}).get('figures', [])
    }
    for table in plan.get('tables', []):
        disposition = table_dispositions.get(table.get('id'))
        if not isinstance(disposition, dict) \
                or disposition.get('fullTableMarkdown') != table.get('renderedMarkdown'):
            raise PublishDataValidationError(
                f'{paper_id} quality 未逐字采用完整表格 {table.get("id")}'
            )
    for figure in plan.get('figures', []):
        disposition = figure_dispositions.get(figure.get('id'))
        expected = (
            'reject' if not figure.get('eligible') else figure.get('disposition')
        )
        if not isinstance(disposition, dict) \
                or disposition.get('disposition') != expected:
            raise PublishDataValidationError(
                f'{paper_id} quality 图片处置与 plan 不一致 {figure.get("id")}'
            )
    validation = payload.get('validation')
    section_count = len(re.findall(
        r'^###\s+[^#\n].*$', normalized_article, flags=re.MULTILINE,
    ))
    if not isinstance(validation, dict) \
            or validation.get('contract') != TUTORIAL_FORMAT_CONTRACT \
            or validation.get('paperId') != paper_id \
            or validation.get('articleSha256') != article_sha \
            or validation.get('articleCharacters') != len(normalized_article) \
            or validation.get('sectionCount') != section_count:
        raise PublishDataValidationError(
            f'{paper_id} tutorial quality validation 摘要不可重放'
        )
    receipt_body = dict(payload)
    receipt_body.pop('receiptSha256', None)
    if payload.get('receiptSha256') != stable_json_sha256(receipt_body) \
            or takeover.get('tutorialPayloadSha256') != stable_json_sha256(payload):
        raise PublishDataValidationError(
            f'{paper_id} tutorial payload receipt/canonical SHA 不闭环'
        )
    return payload
