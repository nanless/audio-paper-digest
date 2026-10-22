#!/usr/bin/env python3
"""推送已审查的博客页面，核对远端 OID，再规划相互独立的视觉任务。"""

import argparse
import json
import sys
import time
from contextlib import nullcontext
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime

_LIB_DIR = Path(__file__).resolve().parent / 'lib'
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from error_guidance import print_error_guidance, redact_sensitive  # noqa: E402


def parse_options(module, argv=None):
    parser = argparse.ArgumentParser(
        prog='push-blog.py',
        description='只提交并推送已经取得审查通过凭证的博客文件。',
        allow_abbrev=False,
    )
    parser.add_argument('--date', action='append',
                        help='博客批次日期（YYYY-MM-DD；省略时为北京时间今天）')
    parser.add_argument('--require-visual-plan', action='store_true',
                        help='图片任务规划失败时以非零状态退出（默认日更流程使用）')
    parser.add_argument('--include-id', action='append', metavar='ARXIV_ID',
                        help='只推送指定单篇论文；ID 必须与生成和审查时一致')
    parser.add_argument('--dry-run', action='store_true',
                        help='只列出审查凭证允许的精确文件，不 commit/push')
    args = parser.parse_args(argv)
    if args.date and len(args.date) > 1:
        parser.error('--date 只能指定一次')
    if args.include_id and len(args.include_id) > 1:
        parser.error('--include-id 只能指定一次')
    if args.include_id and args.require_visual_plan:
        parser.error('单篇发布不建立整批图片任务，--include-id 不能与 --require-visual-plan 同时使用')
    return (
        module.validate_publish_date(module.get_today_bj(args.date[0] if args.date else None)),
        args.require_visual_plan,
        args.include_id[0] if args.include_id else None,
    )


def parse_date(module, argv=None):
    return parse_options(module, argv)[0]


def _dry_run_requested(argv=None):
    """--dry-run 是只读开关；保持 parse_options 返回三元组的既有契约。"""
    values = sys.argv[1:] if argv is None else list(argv)
    return '--dry-run' in values


def _date_from_argv(argv):
    """在 parse_options 之前从 argv 提取 --date，供阶段摘要按批次日期归档。"""
    for index, value in enumerate(argv):
        if value == '--date' and index + 1 < len(argv):
            return argv[index + 1]
        if isinstance(value, str) and value.startswith('--date='):
            return value.split('=', 1)[1]
    return None


def _as_text(value):
    if isinstance(value, bytes):
        return value.decode('utf-8', 'replace')
    return str(value or '')


def _relative_manifest(module, paths):
    """绝对路径 -> 博客仓库相对路径。优先复用 publish-to-blog 的同一实现。"""
    helper = getattr(module, '_git_relative_manifest', None)
    if callable(helper):
        return [str(item) for item in helper(paths)]
    repo = Path(getattr(module, 'BLOG_REPO', '.')).expanduser().resolve()
    relatives = set()
    for item in paths:
        relatives.add(str(Path(item).resolve().relative_to(repo)))
    return sorted(relatives)


def parse_git_status_porcelain_z(output):
    """解析 `git status --porcelain=v1 -z`，含 rename/copy 的双路径记录。"""
    tokens = [token for token in _as_text(output).split('\0') if token]
    entries = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if len(token) < 4 or token[2] != ' ':
            continue
        code, relative = token[:2], token[3:]
        original = None
        if 'R' in code or 'C' in code:
            if index < len(tokens):
                original = tokens[index]
                index += 1
        entries.append({'code': code, 'path': relative, 'originalPath': original})
    return entries


def _path_prefix(relative):
    parts = [part for part in str(relative).split('/') if part]
    if len(parts) >= 2:
        return '/'.join(parts[:2]) + '/'
    return (parts[0] + '/') if parts else ''


def _load_receipt(receipt):
    """接收凭证对象或路径；读不出时返回空对象（不阻断 dry-run 的路径清单）。"""
    if isinstance(receipt, dict):
        return receipt
    try:
        return json.loads(Path(receipt).read_text(encoding='utf-8'))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}


def plan_dry_run(module, paths, receipt):
    """只读计算 dry-run 清单：精确文件、状态、路径前缀与清单外改动。"""
    manifest = _relative_manifest(module, paths)
    allowed = set(manifest)
    status = module._run_git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'], check=True,
    )
    entries = parse_git_status_porcelain_z(getattr(status, 'stdout', b''))
    by_path = {}
    unrelated = []
    for entry in entries:
        touched = {entry['path']}
        if entry['originalPath']:
            touched.add(entry['originalPath'])
        if not (touched & allowed):
            unrelated.append(entry['path'])
            continue
        for relative in touched:
            if relative in allowed:
                by_path.setdefault(relative, entry['code'])
    receipt_object = _load_receipt(receipt)
    deleted = {
        record.get('path')
        for record in (receipt_object.get('files') or [])
        if isinstance(record, dict) and record.get('deleted') is True
    }
    files = []
    for relative in manifest:
        if relative in by_path:
            code = by_path[relative]
        elif relative in deleted:
            code = 'D '
        else:
            code = 'M '
        files.append({'path': relative, 'status': code})
    prefixes = {}
    for item in files:
        prefix = _path_prefix(item['path'])
        prefixes[prefix] = prefixes.get(prefix, 0) + 1
    return {
        'files': files,
        'unrelated': unrelated,
        'prefixes': prefixes,
        'count': len(files),
    }


def run_dry_run(module, date_str, paths, receipt, *, include_id=None, print_fn=print):
    """只读预检并打印精确清单；绝不 git add/commit/push，也不规划视觉任务。"""
    plan = plan_dry_run(module, paths, receipt)
    if plan['unrelated']:
        preview = ', '.join(plan['unrelated'][:10])
        more = '' if len(plan['unrelated']) <= 10 else f' 等 {len(plan["unrelated"])} 项'
        raise module.PublishDataValidationError(
            'dry-run 检测到审查清单外改动，拒绝继续（不 stash、不清理；请先人工确认或提交/丢弃这些改动）：'
            + preview + more
        )
    print_fn('🧪 [dry-run] 只读预检：不执行 git add/commit/push，也不规划视觉任务')
    print_fn(f'📦 将提交 {plan["count"]} 个已审查文件')
    for prefix, count in sorted(plan['prefixes'].items()):
        print_fn(f'  前缀 {prefix}  {count} 个')
    print_fn('📄 精确清单：')
    for item in plan['files']:
        print_fn(f'  {(item["status"].strip() or "??"):>2} {item["path"]}')
    receipt_label = receipt if isinstance(receipt, str) else '<内存凭证>'
    print_fn(f'🧾 审查凭证: {receipt_label}')
    suffix = f' --include-id {include_id}' if include_id else ''
    print_fn(f'✅ 未发现审查清单外改动；确认后可运行: npm run blog:push -- --date {date_str}{suffix}')
    return plan


def main():
    require_external_runtime('push-blog.py')
    from log_setup import setup_script_logging, write_stage_summary
    setup_script_logging(__file__)
    module = load_publish_to_blog()
    date_str = None
    started = time.monotonic()
    reported_exit = False
    write_stage_summary('推送', 'start', '按审查凭证提交并推送博客页面', date=_date_from_argv(sys.argv))
    try:
        module.validate_publish_target()
        date_str, require_visual_plan, include_id = parse_options(module)
        dry_run = _dry_run_requested()
        scope_context = getattr(module, 'publication_scope', lambda _value: nullcontext())
        with scope_context(include_id):
            with module.blog_publication_lock(date_str):
                paths, receipt = module.load_verified_review_receipt(date_str)
                visual_capable = module.preflight_post_publish_visual_capability(
                    date_str, require_visual_plan=require_visual_plan,
                )
                module.validate_git_publish_branch()
                if include_id:
                    module.validate_single_publication_worktree(paths)
                module.validate_git_index(paths)
                print(f'🧾 已验证审查凭证: {receipt}')
                print(f'📦 直接提交推送 {len(paths)} 个已审查路径（不生成、不 review）')
                if dry_run:
                    plan = run_dry_run(module, date_str, paths, receipt, include_id=include_id)
                    write_stage_summary(
                        '推送', 'ok',
                        f'dry-run：列出 {plan["count"]} 个待提交文件；未执行 git add/commit/push',
                        elapsed_ms=(time.monotonic() - started) * 1000, date=date_str,
                    )
                    return
                if not module.git_push(date_str, paths):
                    raise module.PublishDataValidationError('Git 提交或推送未完成')
                if visual_capable:
                    print('🎨 全部博客已发布并通过远端 OID 校验，开始建立发布后视觉任务')
                    visual_planned = module.plan_post_publish_visual_assets(date_str)
                    if require_visual_plan and not visual_planned:
                        print('\n❌ 博客已发布并验证远端 OID，但发布后视觉任务规划失败')
                        print(f'   可重试: npm run visual:post-publish -- --date {date_str}')
                        write_stage_summary('推送', 'warn', '页面已推送并验证远端 OID，但发布后视觉任务规划失败',
                                            elapsed_ms=(time.monotonic() - started) * 1000, date=date_str)
                        reported_exit = True
                        sys.exit(2)
                else:
                    visual_planned = None
    except module.PublishDataValidationError as exc:
        print(f'\n❌ 博客推送失败: {exc}')
        write_stage_summary('推送', 'error', f'博客推送失败: {redact_sensitive(exc)}',
                            elapsed_ms=(time.monotonic() - started) * 1000, date=date_str)
        print_error_guidance(exc, 'blog-push')
        sys.exit(1)
    except TimeoutError as exc:
        print(f'\n❌ 博客仓库或同日期事务正在运行: {exc}')
        write_stage_summary('推送', 'error', f'博客仓库或同日期事务正在运行: {redact_sensitive(exc)}',
                            elapsed_ms=(time.monotonic() - started) * 1000, date=date_str)
        print_error_guidance(exc, 'blog-push')
        sys.exit(1)
    except SystemExit as exc:
        # 参数解析等显式退出：保持原退出码；0 视为正常结束。
        # 视觉规划失败分支已经写过 warn 摘要，不能再补一条误导性的 error。
        if reported_exit:
            raise
        code = exc.code if exc.code is not None else 0
        elapsed = (time.monotonic() - started) * 1000
        if code == 0:
            write_stage_summary('推送', 'ok', '推送结束（退出码 0）', elapsed_ms=elapsed, date=date_str)
        else:
            write_stage_summary('推送', 'error', f'推送参数或退出错误（退出码 {code}）',
                                elapsed_ms=elapsed, date=date_str)
            print_error_guidance(exc, 'blog-push')
        raise
    except Exception as exc:
        write_stage_summary('推送', 'error', f'推送异常: {redact_sensitive(exc)}',
                            elapsed_ms=(time.monotonic() - started) * 1000, date=date_str)
        print_error_guidance(exc, 'blog-push')
        raise
    write_stage_summary('推送', 'ok', f'发布 {len(paths)} 个已审查页面，远端 OID 已核验',
                        elapsed_ms=(time.monotonic() - started) * 1000, date=date_str)
    if visual_planned:
        print('\n🎉 全部博客推送完成；TOP 10 论文长图与汇总图任务已建立！')
    elif visual_planned is False:
        print('\n🎉 全部博客推送完成；发布后视觉任务尚待重试。')
    elif include_id:
        print('\n🎉 单篇灰度博客推送完成；未修改汇总页，也未建立批次视觉任务。')
    else:
        print('\n🎉 历史维护博客推送完成；该 generation schema 不适用发布后视觉任务。')


if __name__ == '__main__':
    main()
