#!/usr/bin/env python3
"""只生成博客 Markdown 并保存为文件；不审查、不提交、不推送。"""

import sys
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime

_LIB_DIR = Path(__file__).resolve().parent / 'lib'
if str(_LIB_DIR) not in sys.path:
    sys.path.insert(0, str(_LIB_DIR))

from error_guidance import print_error_guidance  # noqa: E402


if __name__ == '__main__':
    require_external_runtime('generate-blog.py')
    from log_setup import setup_script_logging, write_stage_summary
    setup_script_logging(__file__)
    write_stage_summary('生成', 'start', '生成博客页面与 schema v3 生成清单')
    try:
        load_publish_to_blog().main()
    except SystemExit as exc:
        # publish 模块内部已打印具体错误并 sys.exit；这里保持原退出码，
        # 只补充一条失败摘要和通用兜底指引，不吞掉原错误。
        code = exc.code if exc.code is not None else 0
        write_stage_summary('生成', 'error', f'生成未完成（退出码 {code}）')
        print_error_guidance(exc, 'blog-generate')
        raise
    except Exception as exc:
        write_stage_summary('生成', 'error', f'生成失败: {exc}')
        print_error_guidance(exc, 'blog-generate')
        raise
    write_stage_summary('生成', 'ok', '页面与生成清单已保存，下一步执行 review')
