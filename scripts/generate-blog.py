#!/usr/bin/env python3
"""只生成博客 Markdown 并保存为文件；不审查、不提交、不推送。"""

import sys
import time
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime

_LIB_DIR = Path(__file__).resolve().parent / 'lib'
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from error_guidance import print_error_guidance, redact_sensitive  # noqa: E402


def _date_from_argv(argv):
    """在 parse_options 之前从 argv 提取 --date，供阶段摘要按批次日期归档。"""
    for index, value in enumerate(argv):
        if value == '--date' and index + 1 < len(argv):
            return argv[index + 1]
        if isinstance(value, str) and value.startswith('--date='):
            return value.split('=', 1)[1]
    return None


if __name__ == '__main__':
    require_external_runtime('generate-blog.py')
    from log_setup import setup_script_logging, write_stage_summary
    setup_script_logging(__file__)
    started = time.monotonic()
    batch_date = _date_from_argv(sys.argv)
    write_stage_summary('生成', 'start', '生成博客页面与 schema v3 生成清单', date=batch_date)
    try:
        load_publish_to_blog().main()
    except SystemExit as exc:
        # publish 模块内部已打印具体错误并 sys.exit；这里保持原退出码。
        # SystemExit(0)（如 --help）是正常结束，不能写成失败摘要或兜底指引。
        code = exc.code if exc.code is not None else 0
        elapsed = (time.monotonic() - started) * 1000
        if code == 0:
            write_stage_summary('生成', 'ok', '生成结束（退出码 0）', elapsed_ms=elapsed, date=batch_date)
        else:
            write_stage_summary('生成', 'error', f'生成未完成（退出码 {code}）', elapsed_ms=elapsed, date=batch_date)
            print_error_guidance(exc, 'blog-generate')
        raise
    except Exception as exc:
        write_stage_summary('生成', 'error', f'生成失败: {redact_sensitive(exc)}',
                            elapsed_ms=(time.monotonic() - started) * 1000, date=batch_date)
        print_error_guidance(exc, 'blog-generate')
        raise
    write_stage_summary('生成', 'ok', '页面与生成清单已保存，下一步执行 review',
                        elapsed_ms=(time.monotonic() - started) * 1000, date=batch_date)
