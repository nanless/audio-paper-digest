"""Runtime preconditions shared by commands that require host networking."""

import os


class ExternalRuntimeRequired(RuntimeError):
    """Raised when a host-network command is launched inside a Codex sandbox."""


def require_external_runtime(command_name):
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


if __name__ == '__main__':
    require_external_runtime('runtime_guard.py')
