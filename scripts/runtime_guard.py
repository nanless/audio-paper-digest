"""需要宿主机联网的命令共用的运行时前置检查。"""

import json
import os
import stat
import sys
from pathlib import Path


class ExternalRuntimeRequired(RuntimeError):
    """需要联网或 Git 的命令在 Codex 沙箱里执行时抛出。"""


PROJECT_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE_ROLE_MARKER = '.paper-digest-workspace-role.json'
CROSS_ROLE_ENV = 'PD_WORKSPACE_ALLOW_CROSS_ROLE'
CROSS_ROLE_VALUE = '1'


def _env_file_value(env_file, key):
    """读工作区 .env 里的一个键。开关由本模块自己解析，因为 python 入口
    在 npm 包装层检查时还没有任何脚本读过 .env。"""
    try:
        raw = env_file.read_text(encoding='utf-8')
    except OSError:
        return ''
    value = ''
    for line in raw.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith('#'):
            continue
        name, sep, rest = trimmed.partition('=')
        if not sep or name.strip() != key:
            continue
        value = rest.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
    return value


def _cross_role_switch(root):
    from_env = os.environ.get(CROSS_ROLE_ENV, '').strip()
    if from_env:
        return from_env
    return _env_file_value(Path(root) / '.env', CROSS_ROLE_ENV).strip()


def _allows_cross_role(actual_role, required_role, root):
    """只放宽 daily 工作区执行 history 命令；反向仍然拒绝。"""
    return (actual_role == 'daily' and required_role == 'history'
            and _cross_role_switch(root) == CROSS_ROLE_VALUE)


def required_workspace_role_for_command(command_name):
    name = Path(str(command_name or '')).name
    wrapped = os.environ.get('AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE', '').strip()
    if (name == 'conference-extract.py'
            and os.environ.get('AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE') == '1'
            and wrapped == 'daily'):
        return 'daily'
    if name in {'full-fetch.js', 'generate-blog.py', 'review-blog.py',
                'push-blog.py', 'publish-to-blog.py',
                'conference-filter-evidence-extract.py'}:
        return 'daily'
    if name in {'conference-extract.py', 'history-inventory.py'}:
        return 'history'
    return None


def require_workspace_role(required_role, project_root=PROJECT_ROOT):
    if required_role not in {'daily', 'history'}:
        raise ExternalRuntimeRequired(f'未知的工作区角色要求: {required_role}')
    root = Path(project_root).resolve(strict=True)
    if not root.is_dir() or Path(project_root).is_symlink():
        raise ExternalRuntimeRequired('工作区根目录必须存在且不能是符号链接')
    marker = root / WORKSPACE_ROLE_MARKER
    try:
        info = marker.lstat()
    except FileNotFoundError as exc:
        raise ExternalRuntimeRequired(
            '工作区角色标记缺失；先运行 npm run workspace:role -- set daily|history') from exc
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or marker.is_symlink():
        raise ExternalRuntimeRequired('工作区角色标记必须是只有一个硬链接的普通文件，不能是符号链接')
    try:
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(marker, flags)
        try:
            opened = os.fstat(fd)
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)):
                raise ExternalRuntimeRequired(
                    '工作区角色标记不是只有一个硬链接的普通文件，或打开的文件与先前检查的文件不同。')
            if os.name != 'nt' and opened.st_mode & 0o077:
                raise ExternalRuntimeRequired('工作区角色标记权限必须为 0600')
            raw = os.read(fd, max(opened.st_size + 1, 4096))
            if len(raw) > 4096 or len(raw) != opened.st_size:
                raise ExternalRuntimeRequired('工作区角色标记超过 4096 字节，或读取长度与打开时记录的长度不同。')
        finally:
            os.close(fd)
        value = json.loads(raw.decode('utf-8'))
    except (OSError, ValueError) as exc:
        raise ExternalRuntimeRequired(f'工作区角色标记读取失败或 JSON 无法解析: {exc}') from exc
    if (not isinstance(value, dict)
            or set(value) != {'contract', 'version', 'role', 'workspaceRealpath'}
            or value.get('contract') != 'paper-digest-workspace-role-v1'
            or value.get('version') != 1
            or value.get('role') not in {'daily', 'history'}
            or value.get('workspaceRealpath') != str(root)):
        raise ExternalRuntimeRequired('工作区角色标记的字段结构、contract、version、role 或 workspaceRealpath 路径与当前工作区不符。')
    if value['role'] != required_role:
        # realpath 校验在上面已完成；开关不碰它。
        if not _allows_cross_role(value['role'], required_role, root):
            reversed_hint = ''
            if (value['role'] == 'history' and required_role == 'daily'
                    and _cross_role_switch(root) == CROSS_ROLE_VALUE):
                reversed_hint = (f'（{CROSS_ROLE_ENV}=1 只放行 daily 工作区执行 history 命令，'
                                 '反向不放行）')
            raise ExternalRuntimeRequired(
                f'当前工作区 role={value["role"]}，该命令只允许 role={required_role}{reversed_hint}')
        print(f'[workspace-role] 跨角色放行：当前工作区 role={value["role"]}，'
              f'命令要求 role={required_role}（{CROSS_ROLE_ENV}={CROSS_ROLE_VALUE}）。'
              '日更、会议和历史任务的生成、审查和推送必须错峰，不得同时发布；旧历史工作区已废弃。',
              file=sys.stderr)
    return value


def require_external_runtime(command_name, project_root=PROJECT_ROOT,
                             enforce_workspace_role=False):
    """拦下需要联网或 Git 的命令在沙箱内的执行。"""
    sandbox = os.environ.get('CODEX_SANDBOX', '').strip()
    # 提权包装层把命令挪出 seatbelt 沙箱后，仍会保留
    # CODEX_SANDBOX_NETWORK_DISABLED。区分真正沙箱和那个外部运行时的稳定
    # 标志是 CODEX_SANDBOX。
    if sandbox:
        raise ExternalRuntimeRequired(
            f'{command_name} 必须在沙箱外运行（检测到 CODEX_SANDBOX={sandbox}）。'
            '该流程会直连 LLM、下载审查图片、执行 Hugo/Git，并可能访问本机代理；'
            '请以沙箱外权限重新执行，禁止在沙箱内降级或跳过这些步骤。'
        )
    inferred = required_workspace_role_for_command(command_name)
    wrapped = os.environ.get('AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE', '').strip()
    direct = bool(sys.argv and sys.argv[0]
                  and Path(sys.argv[0]).name == Path(str(command_name)).name)
    enforce = bool(wrapped) or direct or enforce_workspace_role
    if enforce and wrapped and inferred and wrapped != inferred:
        raise ExternalRuntimeRequired(
            f'{command_name} 固定要求 role={inferred}，当前环境指定 wrapper={wrapped}，两者不一致')
    required = (inferred or wrapped) if enforce else None
    if required:
        require_workspace_role(required, project_root)


if __name__ == '__main__':
    require_external_runtime('runtime_guard.py')
