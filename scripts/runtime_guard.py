"""Runtime preconditions shared by commands that require host networking."""

import json
import os
import stat
import sys
from pathlib import Path


class ExternalRuntimeRequired(RuntimeError):
    """Raised when a host-network command is launched inside a Codex sandbox."""


PROJECT_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE_ROLE_MARKER = '.paper-digest-workspace-role.json'


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
        raise ExternalRuntimeRequired(f'未知 required workspace role: {required_role}')
    root = Path(project_root).resolve(strict=True)
    if not root.is_dir() or Path(project_root).is_symlink():
        raise ExternalRuntimeRequired('workspace root 必须是存在的真实目录且不得为 symlink')
    marker = root / WORKSPACE_ROLE_MARKER
    try:
        info = marker.lstat()
    except FileNotFoundError as exc:
        raise ExternalRuntimeRequired(
            'workspace role marker 缺失；先运行 npm run workspace:role -- set daily|history') from exc
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or marker.is_symlink():
        raise ExternalRuntimeRequired('workspace role marker 必须是单链接普通文件且不得为 symlink')
    try:
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        fd = os.open(marker, flags)
        try:
            opened = os.fstat(fd)
            if (not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1
                    or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino)):
                raise ExternalRuntimeRequired(
                    'workspace role marker 在读取期间发生身份漂移')
            if os.name != 'nt' and opened.st_mode & 0o077:
                raise ExternalRuntimeRequired('workspace role marker 权限必须为 0600')
            raw = os.read(fd, max(opened.st_size + 1, 4096))
            if len(raw) > 4096 or len(raw) != opened.st_size:
                raise ExternalRuntimeRequired('workspace role marker 字节长度非法或读取期间漂移')
        finally:
            os.close(fd)
        value = json.loads(raw.decode('utf-8'))
    except (OSError, ValueError) as exc:
        raise ExternalRuntimeRequired(f'workspace role marker JSON 损坏: {exc}') from exc
    if (not isinstance(value, dict)
            or set(value) != {'contract', 'version', 'role', 'workspaceRealpath'}
            or value.get('contract') != 'paper-digest-workspace-role-v1'
            or value.get('version') != 1
            or value.get('role') not in {'daily', 'history'}
            or value.get('workspaceRealpath') != str(root)):
        raise ExternalRuntimeRequired('workspace role marker schema、角色或 realpath 绑定非法')
    if value['role'] != required_role:
        raise ExternalRuntimeRequired(
            f'当前 workspace role={value["role"]}，该命令只允许 role={required_role}')
    return value


def require_external_runtime(command_name, project_root=PROJECT_ROOT,
                             enforce_workspace_role=False):
    """Reject sandbox execution for commands requiring host networking or Git."""
    sandbox = os.environ.get('CODEX_SANDBOX', '').strip()
    # The elevation wrapper preserves CODEX_SANDBOX_NETWORK_DISABLED even after
    # moving a command out of the seatbelt sandbox. CODEX_SANDBOX is the stable
    # marker that distinguishes the actual sandbox from that external runtime.
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
            f'{command_name} 的固定 workspace role={inferred} 与 wrapper={wrapped} 冲突')
    required = (inferred or wrapped) if enforce else None
    if required:
        require_workspace_role(required, project_root)


if __name__ == '__main__':
    require_external_runtime('runtime_guard.py')
