#!/usr/bin/env python3
"""博客审查状态账本：审查凭证读写校验、通过缓存、逐页检查点、失败状态与增量审查计划。"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import contextvars
import copy
import datetime
import json
import re
import subprocess
import sys
from collections.abc import Mapping
from contextlib import contextmanager
from pathlib import Path

_SHARED_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
_MANUAL_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent / 'manual' / 'scripts')
for _dir in (_SHARED_SCRIPTS_DIR, _MANUAL_SCRIPTS_DIR):
    if _dir not in sys.path:
        sys.path.insert(0, _dir)

import blog_record_format as blog_formats  # noqa: E402
import daily_hugo_capture  # noqa: E402
from manual_agent_policy import (  # noqa: E402
    cache_evidence_header,
    cache_subagent_policy,
    require_current_review_policy,
    review_subagent_identity_error,
    valid_cache_evidence_header,
)
from publish_common import (  # noqa: E402
    PublishDataValidationError,
    classify_review_failure,
    unchanged_content_rejection_blocks_retry,
)

MANUAL_REVIEW_MODE = 'manual_complete'
SEALED_TUTORIAL_PREVIEW_MODE = 'sealed_tutorial_preview'

_ACTIVE_HOOKS: contextvars.ContextVar[Mapping | None] = contextvars.ContextVar(
    'blog_review_state_hooks', default=None,
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
        raise RuntimeError(f'blog_review_state 缺少必需运行钩子: {name}')

    def get(self, name: str, default=None):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        return globals().get(name, default)


_H = _HookAccessor()


def validate_reviewed_file_hashes(date_str, publish_paths, manifest_path, file_results, *, hooks: Mapping | None = None):
    """核对生成时的文件状态、审查通过结果及内容哈希，拒绝缺失、变化或范围不符的发布文件。"""
    with _hooks_scope(hooks):
        _H.validate_generation_manifest_file_bytes(manifest_path, date_str)
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        expectations = _H.generation_manifest_expectations(manifest_path, date_str)
        actual_paths = set()
        for item in publish_paths:
            path, relative = _H._manifest_record(item, repo)
            actual_paths.add(relative)
            if relative not in expectations:
                raise _H.PublishDataValidationError(f'发布路径未列入本次生成清单：{relative}')
            expected_deleted = expectations[relative]
            if expected_deleted:
                if path.exists():
                    raise _H.PublishDataValidationError(f'生成清单中预期删除的文件重新出现：{relative}')
                continue
            if not path.is_file():
                raise _H.PublishDataValidationError(f'生成清单中应当存在的页面在审查期间消失：{relative}')
            result = file_results.get(str(path.resolve()), {})
            reviewed_sha = result.get('reviewedSha256')
            if result.get('passed') is not True or not re.fullmatch(r'[0-9a-f]{64}', str(reviewed_sha or '')):
                raise _H.PublishDataValidationError(f'页面缺少有效的审查通过结果或已审内容哈希：{relative}')
            if _H._sha256_file(path) != reviewed_sha:
                raise _H.PublishDataValidationError(f'页面在审查后发生变化，不能生成审查凭证：{relative}')
        if actual_paths != set(expectations):
            raise _H.PublishDataValidationError('发布路径集合与本次生成清单不一致。')
        return True


def reusable_generation_manifest(
    date_str, input_fingerprint, template_fingerprint, base_head,
 *, hooks: Mapping | None = None):
    """返回一次完全相同的已完成生成，同时不让审查状态失效。"""
    with _hooks_scope(hooks):
        path = _H.generation_manifest_path(date_str)
        if not path.is_file():
            return None
        try:
            manifest = _H._load_json_object(path, '生成清单')
            if (
                not blog_formats.source_bound_generation(manifest)
                or manifest.get('date') != date_str
                or manifest.get('inputFingerprint') != input_fingerprint
                or manifest.get('templateFingerprint') != template_fingerprint
                or manifest.get('baseHead') != str(base_head).lower()
            ):
                return None
            _H._validate_generation_input_integrity(manifest, date_str)
            repo = Path(_H.BLOG_REPO).expanduser().resolve()
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
                normalized = _H._validate_manifest_path_date(target, repo, date_str)
                if normalized in seen:
                    return None
                seen.add(normalized)
                expected = {
                    'deleted': record['deleted'],
                    'sha256': sha,
                }
                if _H._file_fingerprint(target) != expected:
                    return None
                paths.append(target)
            return paths, path
        except (KeyError, TypeError, _H.PublishDataValidationError):
            return None


def reusable_verified_publication_generation(
    date_str, input_fingerprint, template_fingerprint, current_head,
 *, hooks: Mapping | None = None):
    """复用一次完全一致的已发布生成，同时不破坏它的凭证。

    生成清单记录的是审查前的字节，而经过远端核验的
    凭证记录的是真正通过审查并已提交的字节。
    因此这项检查有意先对照凭证校验当前文件，
    再对照同一份凭证校验不可变的发布提交。
    它不接受改动过的输入或模板、处于改动状态的清单路径、
    无关的提交，以及仅仅存在于本地或未经核验的审查凭证。
    """
    with _hooks_scope(hooks):
        manifest_path = _H.generation_manifest_path(date_str)
        receipt_path = _H.review_receipt_path(date_str)
        if not manifest_path.is_file() or not receipt_path.is_file():
            return None
        try:
            manifest = _H._load_json_object(manifest_path, '生成清单')
            if (
                not blog_formats.source_bound_generation(manifest)
                or manifest.get('date') != date_str
                or manifest.get('inputFingerprint') != input_fingerprint
                or manifest.get('templateFingerprint') != template_fingerprint
            ):
                return None
            repo = Path(_H.BLOG_REPO).expanduser().resolve()
            _H.validate_generation_visual_contract(manifest, date_str, repo)
            _H.validate_generation_manifest_file_bytes(manifest_path, date_str)
            _H._validate_generation_input_integrity(manifest, date_str)

            receipt = _H._load_json_object(receipt_path, '审查凭证')
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
                not blog_formats.strict_receipt(receipt)
                or receipt.get('date') != date_str
                or receipt.get('strictReview') is not True
                or receipt.get('hugoGate') != 'hugo'
                or receipt.get('postPublishVisuals')
                != _H._expected_post_publish_visuals(
                    manifest, _H._validate_publication_scope(manifest)
                )
                or not re.fullmatch(r'[0-9a-f]{40,64}', publication_commit)
                or remote_oid != publication_commit
                or verified_time.utcoffset() != datetime.timedelta(hours=8)
                or not re.fullmatch(r'[0-9a-f]{40,64}', base_head)
                or manifest.get('baseHead') != base_head
                or protocol != _H.review_protocol_fingerprint()
                or remote_name != _H.GITHUB_REMOTE
                or not re.fullmatch(r'[0-9a-f]{64}', remote_identity)
                or receipt.get('generationManifestSha256') != _H._sha256_file(manifest_path)
                or not blog_formats.matches_snapshot_receipt(manifest, receipt)
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

            expectations = _H.generation_manifest_expectations(manifest_path, date_str)
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
                normalized = _H._validate_manifest_path_date(target, repo, date_str)
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
                if _H._file_fingerprint(target) != {'deleted': deleted, 'sha256': sha}:
                    return None
                paths.append(target)
            if seen != set(expectations):
                return None

            if current_head != publication_commit:
                return None
            current_remote_identity, _identity_error = _H._remote_identity_sha256()
            if current_remote_identity != remote_identity:
                return None
            current_remote_oid, _remote_error = _H._remote_main_oid()
            if current_remote_oid != publication_commit:
                return None
            _H.validate_git_commit_against_review_receipt(receipt, paths, publication_commit)
            _H.validate_manifest_clean_against_head(paths)
            _H._validate_render_observation_ref(receipt)
            return paths, manifest_path, receipt_path
        except (
            KeyError, TypeError, ValueError, OSError, UnicodeError,
            _H.subprocess.CalledProcessError, _H.PublishDataValidationError,
        ):
            return None


def reusable_verified_publication_review(date_str, current_head, *, hooks: Mapping | None = None):
    """返回仍然有效的远端发布凭证，用于审查的幂等判断。"""
    with _hooks_scope(hooks):
        manifest_path = _H.generation_manifest_path(date_str)
        try:
            manifest = _H._load_json_object(manifest_path, '生成清单')
            input_fingerprint = manifest.get('inputFingerprint')
            template_fingerprint = manifest.get('templateFingerprint')
            if not re.fullmatch(r'[0-9a-f]{64}', str(input_fingerprint or '')):
                return None
            if not re.fullmatch(r'[0-9a-f]{64}', str(template_fingerprint or '')):
                return None
        except (OSError, UnicodeError, _H.PublishDataValidationError):
            return None
        return _H.reusable_verified_publication_generation(
            date_str, input_fingerprint, template_fingerprint, current_head,
        )


def has_publication_evidence_for_generation(
    date_str, input_fingerprint=None, template_fingerprint=None,
 *, hooks: Mapping | None = None):
    """发现绝不能被悄悄覆盖的发布证据。

    当生成本身仍然匹配时，这里有意把同一天不可读的凭证
    也当作证据。网络中断、远端变化或
    凭证损坏都必须让当前阶段停下，并保留这份唯一可能的远端
    证明，交给运维人员检查。
    """
    with _hooks_scope(hooks):
        manifest_path = _H.generation_manifest_path(date_str)
        receipt_path = _H.review_receipt_path(date_str)
        if not manifest_path.is_file() or not receipt_path.exists():
            return False
        try:
            receipt = _H._load_json_object(receipt_path, '审查凭证')
        except (OSError, UnicodeError, _H.PublishDataValidationError):
            # 同一天不可读的凭证，可能是仅存的发布
            # 证明。生成路径绝不能抹掉它。
            return True
        if any(receipt.get(field) for field in (
            'publicationCommit', 'remoteVerifiedOid', 'remoteVerifiedAt',
            'remoteIdentitySha256',
        )):
            # 已发布的 v1/v2/v3 证据是不可变历史。现代 v3 的精确
            # 复用在前面的分支里处理；其他任何同一天的生成都必须停下。
            return True
        try:
            manifest = _H._load_json_object(manifest_path, '生成清单')
        except (OSError, UnicodeError, _H.PublishDataValidationError):
            return True
        if not blog_formats.source_bound_generation(manifest) or manifest.get('date') != date_str:
            return False
        if input_fingerprint is not None and manifest.get('inputFingerprint') != input_fingerprint:
            return False
        if template_fingerprint is not None and manifest.get('templateFingerprint') != template_fingerprint:
            return False
        return False


def save_review_receipt(
    date_str, publish_paths, hugo_gate, expected_base_head=None,
    generation_manifest=None, reviewed_results=None, manual_review_record=None,
 *, hooks: Mapping | None = None):
    """保存已审文件及本次生成清单的对应记录，供后续推送核验。"""
    with _hooks_scope(hooks):
        if manual_review_record is not None:
            try:
                require_current_review_policy(manual_review_record)
            except ValueError as exc:
                raise _H.PublishDataValidationError(str(exc)) from exc
        if generation_manifest is None:
            raise _H.PublishDataValidationError('签发审查凭证时必须提供本次生成清单。')
        if reviewed_results is None:
            raise _H.PublishDataValidationError('签发审查凭证时必须提供各文件的审查结果及已审内容哈希。')
        if _H._load_json_object(generation_manifest, '生成清单').get('publicationMode') == _H.SEALED_TUTORIAL_PREVIEW_MODE:
            raise _H.PublishDataValidationError(_H.RETIRED_TUTORIAL_PREVIEW_MESSAGE)
        current_protocol = _H.review_protocol_fingerprint()
        _H.validate_generation_manifest_file_bytes(generation_manifest, date_str)
        if manual_review_record is not None:
            manifest_payload = _H._load_json_object(generation_manifest, '生成清单')
            prospective_files = [{
                'path': item['path'],
                'deleted': item.get('deleted') is True,
                'sha256': None if item.get('deleted') is True else item.get('sha256'),
            } for item in manifest_payload['files']]
            _H._validated_current_manual_review_record(manual_review_record, {
                'files': prospective_files,
                'baseHead': _H.validate_git_publish_branch(),
                'generationManifestSha256': _H._sha256_file(generation_manifest),
                'reviewProtocolFingerprint': current_protocol,
            }, date_str)
        for result in reviewed_results.values():
            if result.get('passed') is True:
                # 页面通过记录按内容 SHA 复用；本批凭证另记当前审查规则。
                result['reviewProtocolFingerprint'] = current_protocol
        if manual_review_record is None:
            _H.save_review_pass_cache(date_str, publish_paths, reviewed_results)
        else:
            _H.save_review_pass_cache(date_str, publish_paths, reviewed_results,
                manual_review_record=manual_review_record, generation_manifest=generation_manifest)
        pass_records = _H._collect_review_pass_records(date_str)
        _H.validate_reviewed_file_hashes(
            date_str, publish_paths, generation_manifest, reviewed_results,
        )
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        expectations = (
            _H.generation_manifest_expectations(generation_manifest, date_str)
            if generation_manifest is not None else None
        )
        files = []
        for item in sorted({Path(value).expanduser().resolve() for value in publish_paths}):
            path, relative = _H._manifest_record(item, repo)
            expected_deleted = expectations.get(relative) if expectations is not None else not path.is_file()
            if expectations is not None and relative not in expectations:
                raise _H.PublishDataValidationError(f'审查文件的路径不在本次生成清单中：{relative}')
            exists = path.is_file()
            if expected_deleted and exists:
                raise _H.PublishDataValidationError(f'本次生成清单要求删除的文件重新出现：{relative}')
            if not expected_deleted and not exists:
                raise _H.PublishDataValidationError(f'本次生成清单要求存在的页面在审查期间消失：{relative}')
            reviewed_sha = (
                None if expected_deleted
                else reviewed_results.get(str(path.resolve()), {}).get('reviewedSha256')
            )
            actual_sha = _H._sha256_file(path) if exists else None
            if not expected_deleted and actual_sha != reviewed_sha:
                raise _H.PublishDataValidationError(f'页面内容在审查凭证签发时发生变化：{relative}')
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
            raise _H.PublishDataValidationError('审查文件的路径集合与本次生成清单不一致。')
        current_head = _H.validate_git_publish_branch()
        if expected_base_head is not None and current_head != str(expected_base_head).lower():
            raise _H.PublishDataValidationError(
                '审查期间博客仓库的 main 基线发生变化，不能签发审查凭证。'
            )
        file_image_modes = {
            record['imageReviewMode'] for record in files if not record['deleted']
        }
        aggregate_image_mode = (
            next(iter(file_image_modes)) if len(file_image_modes) == 1
            else ('mixed' if file_image_modes else 'deterministic_only')
        )
        generation_payload = _H._load_json_object(generation_manifest, '生成清单')
        generation_source_bound = blog_formats.source_bound_generation(generation_payload)
        publication_scope_value = _H._validate_active_publication_scope(generation_payload)
        if generation_source_bound:
            _H.validate_generation_visual_contract(generation_payload, date_str, repo)
            generation_input_fingerprint_value, published_snapshot_fingerprint = (
                _H._validate_generation_input_integrity(generation_payload, date_str)
            )
        else:
            generation_input_fingerprint_value = None
            published_snapshot_fingerprint = None
        publication_mode = generation_payload.get('publicationMode')
        post_publish_visuals = _H._expected_post_publish_visuals(
            generation_payload, publication_scope_value,
        )
        receipt = {
            **blog_formats.current_header(blog_formats.RECEIPT),
            'date': _H.validate_publish_date(date_str),
            'reviewedAt': datetime.datetime.now(
                datetime.timezone(datetime.timedelta(hours=8))
            ).isoformat(),
            'strictReview': True,
            'imageReview': {
                'mode': aggregate_image_mode,
                'secondaryModelConfigured': _H.current_image_review_mode() == 'multimodal',
            },
            'hugoGate': hugo_gate,
            'baseHead': current_head,
            'reviewProtocolFingerprint': _H.review_protocol_fingerprint(),
            'generationManifestSha256': (
                _H._sha256_file(generation_manifest) if generation_manifest is not None else None
            ),
            **blog_formats.receipt_snapshot_fields(generation_payload),
            'generationInputFingerprint': generation_input_fingerprint_value,
            'publishedPapersFingerprint': published_snapshot_fingerprint,
            'generationInputSourceReference': (
                generation_payload.get('inputSourceReference')
                if generation_source_bound else None
            ),
            # 生成 SHA 用于核对这次通过审查的生成记录。
            # 新记录的 not_requested 表示日更不生图；required 只保留原历史记录的含义；
            # not_applicable_single_paper 表示单篇发布不适用，
            # not_applicable_legacy_maintenance 表示旧格式维护不适用。
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
            receipt['reviewMode'] = _H.MANUAL_REVIEW_MODE
            # 缓存写入前已核验身份和声明；签发前再核对最终文件及最新 Git 基线。
            receipt['reviewProvenance'] = _H._validated_current_manual_review_record(
                manual_review_record, receipt, date_str,
            )
        session = daily_hugo_capture.current_session()
        if session is not None:
            reference = _H._render_observation_call(
                daily_hugo_capture.persist_review_observation, session,
                final_binding=_H._render_observation_final_binding(receipt),
            )
            if reference is not None:
                receipt['renderObservation'] = reference
        path = _H.review_receipt_path(date_str)
        _H.atomic_write_json(path, receipt, ensure_ascii=False, indent=2)
        return path


def _validate_original_cache_identity(identity, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        if not isinstance(identity, dict) or identity.get('status') not in {'recorded', 'not_recorded'}:
            raise ValueError('原逐页审查身份的记录方式未知。')
        if identity['status'] == 'not_recorded':
            if set(identity) != {'status'}:
                raise ValueError('未记录模型身份时不能夹带模型声明。')
            return
        if set(identity) != {'status', 'reviewSubagent'}:
            raise ValueError('原模型身份记录含有未知字段。')
        subagent = identity['reviewSubagent']
        expected = cache_subagent_policy(subagent)
        error = review_subagent_identity_error(subagent, expected)
        if error:
            raise ValueError(error)


def _original_review_cache_evidence(record, *, hooks: Mapping | None = None):
    """保留实际读到的原逐页通过记录，不把旧身份改成当前模型。"""
    with _hooks_scope(hooks):
        saved = record.get('originalReviewEvidence')
        if saved is not None:
            if (not valid_cache_evidence_header(saved)
                    or not isinstance(saved.get('record'), dict)
                    or _H._stable_json_sha256(saved['record']) != saved.get('recordSha256')):
                raise ValueError('原逐页通过记录的副本或 SHA 无效。')
            original = saved['record']
            if (set(original) != {'path', 'sha256', 'reviewedAt', 'reviewProtocolFingerprint',
                                  'imageReviewMode', 'modelIdentity'}
                    or original['path'] != record['path'] or original['sha256'] != record['sha256']):
                raise ValueError('原逐页通过记录与缓存的路径或正文 SHA 不一致。')
            identity = original['modelIdentity']
            if (not isinstance(identity, dict) or identity.get('status') not in {'recorded', 'not_recorded'}
                    or (identity['status'] == 'not_recorded' and set(identity) != {'status'})
                    or (identity['status'] == 'recorded' and (set(identity) != {'status', 'reviewSubagent'}
                        or not isinstance(identity['reviewSubagent'], dict)))):
                raise ValueError('原逐页审查身份的记录方式无效。')
            _H._validate_original_cache_identity(identity)
            return json.loads(json.dumps(saved))
        identity = record.get('reviewIdentity')
        if identity is None:
            identity = {'status': 'not_recorded'}
        elif not isinstance(identity, dict):
            raise ValueError('原逐页审查身份必须为对象。')
        _H._validate_original_cache_identity(identity)
        original = {key: record.get(key) for key in (
            'path', 'sha256', 'reviewedAt', 'reviewProtocolFingerprint', 'imageReviewMode')}
        original['modelIdentity'] = identity
        return {**cache_evidence_header(), 'record': original, 'recordSha256': _H._stable_json_sha256(original)}


def manual_cache_reuse_for_file(date_str, relative_path, body_sha256, *, hooks: Mapping | None = None):
    """只从真实通过缓存取证，并核对当前页面仍是相同字节。"""
    with _hooks_scope(hooks):
        record = _H._collect_review_pass_records(date_str).get((relative_path, body_sha256))
        if record is None:
            return None
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        target = (repo / relative_path).resolve()
        if _H._validate_manifest_path_date(target, repo, date_str) != relative_path \
                or not target.is_file() or _H._sha256_file(target) != body_sha256:
            return None
        return _H._original_review_cache_evidence(record)


def validate_manual_cache_reuse(item, date_str, *, hooks: Mapping | None = None):
    with _hooks_scope(hooks):
        evidence = item.get('cacheReuse')
        if (item.get('deleted') is True or 'reviewSubagent' in item or 'imageFindings' in item
                or not isinstance(evidence, dict)):
            raise _H.PublishDataValidationError('旧逐页复用不得混入新模型收据或删除记录。')
        try:
            _H._original_review_cache_evidence({'path': item.get('path'), 'sha256': item.get('sha256'),
                                             'originalReviewEvidence': evidence})
        except (ValueError, TypeError) as exc:
            raise _H.PublishDataValidationError(str(exc)) from exc
        actual = _H.manual_cache_reuse_for_file(date_str, item.get('path'), item.get('sha256'))
        # The wrapper carries no authority. Older declarations retain their own
        # wrapper after replay against the same actual cached record and body SHA.
        if actual is None or evidence['record'] != actual['record'] \
                or evidence['recordSha256'] != actual['recordSha256']:
            raise _H.PublishDataValidationError('逐页复用没有对应的真实原通过记录，或原证据不一致。')
        return evidence


def _valid_review_pass_record(record, repo, date_str, default_protocol=None, default_time=None, *, hooks: Mapping | None = None):
    """归一化一条历史里的文件级通过记录，不信任批次元数据。"""
    with _hooks_scope(hooks):
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
            normalized = _H._validate_manifest_path_date(target, repo, date_str)
        except (OSError, ValueError, _H.PublishDataValidationError):
            return None
        protocol = record.get('reviewProtocolFingerprint') or default_protocol
        if protocol is not None and not re.fullmatch(r'[0-9a-f]{64}', str(protocol)):
            protocol = None
        reviewed_at = record.get('reviewedAt') or default_time
        image_review_mode = record.get('imageReviewMode')
        if image_review_mode not in {'multimodal', 'deterministic_only', 'manual_semantic'}:
            image_review_mode = 'deterministic_only'
        result = {
            'path': normalized,
            'sha256': str(sha256),
            'reviewedAt': reviewed_at if isinstance(reviewed_at, str) else None,
            'reviewProtocolFingerprint': protocol,
            'imageReviewMode': image_review_mode,
        }
        if 'originalReviewEvidence' in record:
            result['originalReviewEvidence'] = record['originalReviewEvidence']
        if 'reviewIdentity' in record:
            result['reviewIdentity'] = record['reviewIdentity']
        try:
            result['originalReviewEvidence'] = _H._original_review_cache_evidence(result)
        except ValueError:
            return None
        return result


def _collect_review_pass_records(date_str, *, hooks: Mapping | None = None):
    """按路径和确切字节收集通过记录，优先采用持久缓存。"""
    with _hooks_scope(hooks):
        date_str = _H.validate_publish_date(date_str)
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        collected = {}
        sources = (
            (_H.review_pass_cache_path(date_str), blog_formats.PASS_CACHE, None),
            (_H.review_receipt_path(date_str), blog_formats.RECEIPT, 'reviewedAt'),
            (_H.review_failure_path(date_str), blog_formats.FAILURES, 'savedAt'),
        )
        for source_path, family, time_field in sources:
            try:
                payload = json.loads(source_path.read_text(encoding='utf-8'))
            except (OSError, UnicodeError, json.JSONDecodeError):
                continue
            if (
                not isinstance(payload, dict)
                or blog_formats.record_profile(payload, family) is None
                or payload.get('date') != date_str
                or not isinstance(payload.get('files'), list)
            ):
                continue
            if source_path == _H.review_receipt_path(date_str) and payload.get('strictReview') is not True:
                continue
            default_protocol = payload.get('reviewProtocolFingerprint')
            default_time = payload.get(time_field) if time_field else payload.get('updatedAt')
            provenance = payload.get('reviewProvenance')
            details = provenance.get('files', []) if isinstance(provenance, dict) else []
            original_details = {item.get('path'): item for item in
                details if isinstance(item, dict)}
            for raw_record in payload['files']:
                if not isinstance(raw_record, dict):
                    continue
                if source_path == _H.review_failure_path(date_str) and raw_record.get('passed') is not True:
                    continue
                raw_record = dict(raw_record)
                original_subagent = original_details.get(raw_record.get('path'), {}).get('reviewSubagent')
                if isinstance(original_subagent, dict) and 'originalReviewEvidence' not in raw_record:
                    raw_record['reviewIdentity'] = {'status': 'recorded', 'reviewSubagent': original_subagent}
                record = _H._valid_review_pass_record(
                    raw_record, repo, date_str,
                    default_protocol=default_protocol,
                    default_time=default_time,
                )
                if record is not None:
                    # 专用缓存排在最前，它可能含有为当前批次
                    # 重新绑定的元数据。针对同一个内容地址，
                    # 旧的凭证或失败快照不得覆盖这条记录。
                    collected.setdefault((record['path'], record['sha256']), record)
        return collected


def save_review_page_checkpoint(
    date_str, page_path, result, manifest_path, base_head,
    manifest_sha256=None,
 *, hooks: Mapping | None = None):
    """只持久化一个工作单元的结果，不扫描也不重写整个批次。"""
    with _hooks_scope(hooks):
        date_str = _H.validate_publish_date(date_str)
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        page, relative = _H._manifest_record(Path(page_path).expanduser().resolve(), repo)
        _H._validate_manifest_path_date(page, repo, date_str)
        if not isinstance(result, dict):
            raise _H.PublishDataValidationError(f'review worker 结果不是对象: {relative}')
        fingerprint = _H._file_fingerprint(page)
        if fingerprint['deleted']:
            raise _H.PublishDataValidationError(f'review worker 返回后页面已消失: {relative}')
        reviewed_sha = result.get('reviewedSha256')
        passed = result.get('passed') is True
        if passed and (
            not re.fullmatch(r'[0-9a-f]{64}', str(reviewed_sha or ''))
            or fingerprint['sha256'] != reviewed_sha
        ):
            raise _H.PublishDataValidationError(f'review worker 返回后页面字节已变化: {relative}')
        failure_kind = result.get('failureKind')
        if failure_kind not in {None, 'pending', 'content', 'transient'}:
            raise _H.PublishDataValidationError(f'review worker failureKind 非法: {relative}')
        protocol = result.get('reviewProtocolFingerprint')
        if not re.fullmatch(r'[0-9a-f]{64}', str(protocol or '')):
            protocol = _H.review_protocol_fingerprint()
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
                else _H.current_image_review_mode()
            ),
        }
        if manifest_sha256 is None:
            manifest_sha256 = _H._sha256_file(manifest_path)
        if not re.fullmatch(r'[0-9a-f]{64}', str(manifest_sha256 or '')):
            raise _H.PublishDataValidationError('逐页 review checkpoint 的 generation manifest SHA 非法')
        payload = {
            **blog_formats.current_header(blog_formats.CHECKPOINT),
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
        checkpoint = _H._review_page_checkpoint_path(date_str, relative)
        _H.atomic_write_json(checkpoint, payload, ensure_ascii=False, indent=2, mode=0o600)
        return checkpoint


def _collect_review_page_checkpoints(date_str, *, hooks: Mapping | None = None):
    """一次载入有效的逐页检查点；过期字节由规划器过滤掉。"""
    with _hooks_scope(hooks):
        date_str = _H.validate_publish_date(date_str)
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        directory = _H.review_page_checkpoint_dir(date_str)
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
                or blog_formats.record_profile(payload, blog_formats.CHECKPOINT) is None
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
                normalized = _H._validate_manifest_path_date(target, repo, date_str)
            except _H.PublishDataValidationError:
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


def clear_review_page_checkpoints(date_str, *, hooks: Mapping | None = None):
    """只删除本日期已完成运行的临时工作分片。"""
    with _hooks_scope(hooks):
        directory = _H.review_page_checkpoint_dir(date_str)
        if not directory.is_dir():
            return
        for path in directory.glob('*.json'):
            path.unlink(missing_ok=True)
        try:
            directory.rmdir()
        except OSError:
            pass


def save_review_pass_cache(date_str, publish_paths=(), file_results=None, *,
                           manual_review_record=None, generation_manifest=None, hooks: Mapping | None = None):
    """把成功的逐文件审查证据单独持久化，不受批次变化影响。"""
    with _hooks_scope(hooks):
        date_str = _H.validate_publish_date(date_str)
        manual_entries = {}
        if manual_review_record is not None:
            if generation_manifest is None:
                raise _H.PublishDataValidationError('保存人工审查身份时必须提供本次生成清单。')
            _H.validate_generation_manifest_file_bytes(generation_manifest, date_str)
            manifest_payload = _H._load_json_object(generation_manifest, '生成清单')
            prospective_files = [{
                'path': item['path'], 'deleted': item.get('deleted') is True,
                'sha256': None if item.get('deleted') is True else item.get('sha256'),
            } for item in manifest_payload['files']]
            validated = _H._validated_current_manual_review_record(manual_review_record, {
                'files': prospective_files, 'baseHead': _H.validate_git_publish_branch(),
                'generationManifestSha256': _H._sha256_file(generation_manifest),
                'reviewProtocolFingerprint': _H.review_protocol_fingerprint(),
            }, date_str)
            manual_entries = {item['path']: item for item in validated['files']}
        records = _H._collect_review_pass_records(date_str)
        file_results = file_results or {}
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
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
                or _H._sha256_file(item) != reviewed_sha
            ):
                continue
            _path, relative = _H._manifest_record(item, repo)
            protocol = result.get('reviewProtocolFingerprint')
            if not re.fullmatch(r'[0-9a-f]{64}', str(protocol or '')):
                if current_protocol is None:
                    current_protocol = _H.review_protocol_fingerprint()
                protocol = current_protocol
            record = {
                'path': relative,
                'sha256': reviewed_sha,
                'reviewedAt': now,
                'reviewProtocolFingerprint': protocol,
                'imageReviewMode': (
                    result.get('imageReviewMode')
                    if result.get('imageReviewMode') in {'multimodal', 'deterministic_only', 'manual_semantic'}
                    else _H.current_image_review_mode()
                ),
            }
            prior = records.get((relative, reviewed_sha))
            entry = manual_entries.get(relative)
            # 相同内容已有原证据时保留其原身份；新内容只记录完整核验过的真实声明。
            if prior is None and entry is not None and 'cacheReuse' not in entry:
                record['reviewIdentity'] = {'status': 'recorded',
                    'reviewSubagent': copy.deepcopy(entry['reviewSubagent'])}
            record['originalReviewEvidence'] = _H._original_review_cache_evidence(prior or record)
            records[(relative, reviewed_sha)] = record
        if not records:
            return None
        payload = {
            **blog_formats.current_header(blog_formats.PASS_CACHE),
            'date': date_str,
            'updatedAt': now,
            'files': sorted(records.values(), key=lambda value: (value['path'], value['sha256'])),
        }
        path = _H.review_pass_cache_path(date_str)
        _H.atomic_write_json(path, payload, ensure_ascii=False, indent=2, mode=0o600)
        return path


def save_review_failure_state(
    date_str,
    publish_paths,
    manifest_path,
    base_head,
    file_results,
    *, batch_issues=None,
 hooks: Mapping | None = None):
    """持久化逐文件的审查失败证据，便于安全地增量重试。"""
    with _hooks_scope(hooks):
        _H.save_review_pass_cache(date_str, publish_paths, file_results)
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        records = []
        current_protocol = _H.review_protocol_fingerprint()
        for item in sorted({Path(value).expanduser().resolve() for value in publish_paths}):
            path, relative = _H._manifest_record(item, repo)
            result = file_results.get(str(path.resolve()), {})
            fingerprint = _H._file_fingerprint(path)
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
                    else _H.current_image_review_mode()
                ),
                'reviewProtocolFingerprint': (
                    result.get('reviewProtocolFingerprint')
                    if re.fullmatch(
                        r'[0-9a-f]{64}', str(result.get('reviewProtocolFingerprint') or '')
                    ) else current_protocol
                ),
            })
        state = {
            **blog_formats.current_header(blog_formats.FAILURES),
            'date': _H.validate_publish_date(date_str),
            'baseHead': str(base_head).lower(),
            'generationManifestSha256': _H._sha256_file(manifest_path),
            'reviewProtocolFingerprint': current_protocol,
            'savedAt': datetime.datetime.now(
                datetime.timezone(datetime.timedelta(hours=8))
            ).isoformat(),
            'files': records,
            'issues': list(batch_issues or []),
        }
        path = _H.review_failure_path(date_str)
        _H.atomic_write_json(path, state, ensure_ascii=False, indent=2, mode=0o600)
        _H.review_receipt_path(date_str).unlink(missing_ok=True)
        return path


def plan_incremental_review(date_str, publish_paths, manifest_path, base_head, *, hooks: Mapping | None = None):
    """复用完全一致且已通过的字节，只挑出新增、变化或失败的页面。"""
    with _hooks_scope(hooks):
        state_path = _H.review_failure_path(date_str)
        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        ordered_paths = sorted({Path(value).expanduser().resolve() for value in publish_paths})
        full = {
            'mode': 'full',
            'paths': [path for path in ordered_paths if path.is_file()],
            'priorResults': {},
            'unchangedFailed': [],
            'reusedPassed': 0,
            'reason': None,
        }
        pass_records = _H._collect_review_pass_records(date_str)
        page_checkpoints = _H._collect_review_page_checkpoints(date_str)
        failed_records = {}
        current_protocol = _H.review_protocol_fingerprint()
        evidence_exists = bool(pass_records or page_checkpoints)
        state_error = None
        try:
            if state_path.is_file():
                state = json.loads(state_path.read_text(encoding='utf-8'))
                failure_profile = blog_formats.record_profile(state, blog_formats.FAILURES)
                if failure_profile is None or state.get('date') != date_str:
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
                    normalized = _H._validate_manifest_path_date(target, repo, date_str)
                    if failure_profile == 'typed-page-outcomes' and (
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
            expectations = _H.generation_manifest_expectations(manifest_path, date_str)
            current_relatives = {
                _H._manifest_record(item, repo)[1] for item in ordered_paths
            }
            if current_relatives != set(expectations):
                raise ValueError('发布路径集合与 generation manifest 不一致')
            selected = []
            unchanged_failed = []
            prior_results = {}
            reused_passed = 0
            for item in ordered_paths:
                _path, relative = _H._manifest_record(item, repo)
                current = _H._file_fingerprint(item)
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
                        # 审查证据永久按内容寻址。
                        # 批次清单或实现指纹变化，
                        # 都不能让没变过的文件字节失效。
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
                if failure_kind == 'content' and item.suffix.lower() != '.md' and not record.get('issues'):
                    # 关联页面未通过时，资产可能还未获得自己的核验结果。
                    failure_kind = 'pending'
                if failure_kind == 'content':
                    # 旧检查点把图片下载的绝对超时判成了内容失败。
                    # 用当前的分类器重新判定它们记录的问题，
                    # 这样没变过的页面字节就能重试这次传输失败，
                    # 而不必硬造出一处修改。
                    if classify_review_failure(record.get('issues') or []) == 'transient':
                        failure_kind = 'transient'
                previous_protocol = record.get('reviewProtocolFingerprint')
                if unchanged_content_rejection_blocks_retry(
                    same_input=current == recorded, completed=record.get('completed'),
                    failure_kind=failure_kind, previous_protocol=previous_protocol,
                    current_protocol=current_protocol,
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


def load_verified_review_receipt(date_str, *, hooks: Mapping | None = None):
    """读取严格审查凭证，并逐项核对当前博客文件的内容哈希。"""
    with _hooks_scope(hooks):
        import time
        started = time.monotonic()
        path = _H.review_receipt_path(date_str)
        if not path.is_file():
            raise _H.PublishDataValidationError(
                f'缺少已通过审查的发布凭证：{path}；请先运行审查，且不传 --push。'
            )
        try:
            receipt = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise _H.PublishDataValidationError(f'审查凭证无法解析: {path}') from exc
        if not blog_formats.strict_receipt(receipt) or receipt.get('date') != date_str:
            raise _H.PublishDataValidationError('审查凭证版本或日期不匹配')
        if receipt.get('strictReview') is not True:
            raise _H.PublishDataValidationError('发布凭证未标明已通过严格审查。')
        if receipt.get('hugoGate') != 'hugo':
            raise _H.PublishDataValidationError('发布凭证未记录通过 Hugo 构建检查。')
        if receipt.get('reviewProtocolFingerprint') != _H.review_protocol_fingerprint():
            raise _H.PublishDataValidationError(
                '当前审查协议已变化；请重新运行审查，复用内容未变页面的通过记录，并重新签发本批发布凭证。'
            )
        manifest_path = _H.generation_manifest_path(date_str)
        expected_manifest_sha = receipt.get('generationManifestSha256')
        if (
            not re.fullmatch(r'[0-9a-f]{64}', str(expected_manifest_sha or ''))
            or not manifest_path.is_file()
            or _H._sha256_file(manifest_path) != expected_manifest_sha
        ):
            raise _H.PublishDataValidationError('发布凭证中的生成清单 SHA 格式无效，或对应清单缺失、内容已变化。')
        manual_review_error = _H._manual_review_record_error(
            receipt,
            date_str=date_str,
            generation_manifest_sha256=expected_manifest_sha,
            expected_base_head=receipt.get('baseHead'),
        )
        if manual_review_error:
            raise _H.PublishDataValidationError(manual_review_error)
        try:
            generation_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise _H.PublishDataValidationError('生成清单无法解析。') from exc
        _H.validate_current_generation_template(generation_manifest)
        publication_scope_value = _H._validate_active_publication_scope(generation_manifest)
        _H.validate_generation_visual_contract(generation_manifest, date_str)
        _H.validate_generation_manifest_file_bytes(manifest_path, date_str)
        if blog_formats.source_bound_generation(generation_manifest):
            _H._validate_generation_input_integrity(generation_manifest, date_str)
        if blog_formats.source_bound_generation(generation_manifest) and (
            not blog_formats.matches_snapshot_receipt(generation_manifest, receipt)
            or receipt.get('generationInputFingerprint') != generation_manifest.get('inputFingerprint')
            or receipt.get('publishedPapersFingerprint')
            != generation_manifest.get('publishedPapersFingerprint')
            or receipt.get('generationInputSourceReference')
            != generation_manifest.get('inputSourceReference')
        ):
            raise _H.PublishDataValidationError('发布凭证中的生成输入核验记录不符合要求，或与本次生成清单不一致。')
        if (
            receipt.get('publicationMode') != generation_manifest.get('publicationMode')
            or receipt.get('manualV6ProductionFingerprint')
            != generation_manifest.get('manualV6ProductionFingerprint')
            or receipt.get('llmApiProductionFingerprint')
            != generation_manifest.get('llmApiProductionFingerprint')
        ):
            raise _H.PublishDataValidationError('发布凭证中的发布模式或正式生成记录与本次生成清单不一致。')
        expected_visual_capability = _H._expected_post_publish_visuals(
            generation_manifest, publication_scope_value,
        )
        receipt_visual_capability = receipt.get('postPublishVisuals')
        if (
            receipt_visual_capability is not None
            and receipt_visual_capability != expected_visual_capability
        ):
            raise _H.PublishDataValidationError('发布凭证中的发布后图片任务设置与本次生成清单不一致。')
        if receipt.get('publicationScope') != publication_scope_value:
            raise _H.PublishDataValidationError('发布凭证中的发布范围与本次生成清单不一致。')
        expectations = _H.generation_manifest_expectations(manifest_path, date_str)
        records = receipt.get('files')
        if not isinstance(records, list) or not records:
            raise _H.PublishDataValidationError('审查凭证没有发布文件清单')
        file_image_modes = {
            record.get('imageReviewMode') for record in records
            if isinstance(record, dict) and record.get('deleted') is not True
        }
        if not file_image_modes or not file_image_modes.issubset({'multimodal', 'deterministic_only', 'manual_semantic'}):
            raise _H.PublishDataValidationError('发布凭证中的逐文件图片审查方式不符合要求。')
        expected_image_mode = (
            next(iter(file_image_modes)) if len(file_image_modes) == 1 else 'mixed'
        )
        image_review = receipt.get('imageReview')
        if (
            not isinstance(image_review, dict)
            or image_review.get('mode') != expected_image_mode
            or not isinstance(image_review.get('secondaryModelConfigured'), bool)
        ):
            raise _H.PublishDataValidationError('发布凭证中的图片审查汇总格式无效，或与逐文件审查记录不一致。')

        repo = Path(_H.BLOG_REPO).expanduser().resolve()
        paths = []
        seen = set()
        for record in records:
            if not isinstance(record, dict) or not isinstance(record.get('path'), str):
                raise _H.PublishDataValidationError('发布凭证中的文件记录格式无效，或文件路径不是字符串。')
            relative = Path(record['path'])
            if relative.is_absolute():
                raise _H.PublishDataValidationError(f'审查凭证包含非法路径: {relative}')
            target = (repo / relative).resolve()
            key = _H._validate_manifest_path_date(target, repo, date_str)
            if key in seen:
                raise _H.PublishDataValidationError(f'审查凭证包含重复路径: {key}')
            seen.add(key)
            if key not in expectations or expectations[key] != (record.get('deleted') is True):
                raise _H.PublishDataValidationError(f'发布凭证中的文件路径或删除标记与本次生成清单不一致：{key}')
            if record.get('deleted') is True:
                if target.exists():
                    raise _H.PublishDataValidationError(f'审查后，已确认删除的文件重新出现：{key}')
            else:
                expected = record.get('sha256')
                if not target.is_file() or not re.fullmatch(r'[0-9a-f]{64}', str(expected or '')):
                    raise _H.PublishDataValidationError(f'已审文件缺失，或凭证中的内容哈希格式无效：{key}')
                evidence_protocol = record.get('reviewProtocolFingerprint')
                if evidence_protocol != receipt.get('reviewProtocolFingerprint'):
                    raise _H.PublishDataValidationError(
                        f'逐文件凭证中的审查协议指纹与本批发布凭证不一致：{key}'
                    )
                actual = _H._sha256_file(target)
                if actual != expected:
                    raise _H.PublishDataValidationError(f'文件内容在审查后发生变化，不能推送：{key}')
            paths.append(target)
        if seen != set(expectations):
            raise _H.PublishDataValidationError('发布凭证中的文件集合与本次生成清单不一致。')
        if receipt.get('reviewMode') == _H.MANUAL_REVIEW_MODE:
            manual_review_record = receipt['reviewProvenance']
            if manual_review_record.get('fileCount') != len(records):
                raise _H.PublishDataValidationError('人工审查记录中的文件数量与发布凭证不一致。')
            if manual_review_record.get('reviewedPathSetSha256') != _H._reviewed_path_set_sha256(records):
                raise _H.PublishDataValidationError('人工审查记录中的文件集合哈希与发布凭证不一致。')
            if manual_review_record.get('reviewProtocolFingerprint') != receipt.get('reviewProtocolFingerprint'):
                raise _H.PublishDataValidationError('人工审查记录中的审查协议指纹与发布凭证不一致。')
        _H._validate_render_observation_ref(receipt)
        print(f'  ⏱ 凭证复核: {time.monotonic() - started:.2f}s')
        return paths, path
