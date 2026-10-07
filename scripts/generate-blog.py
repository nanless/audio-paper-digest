#!/usr/bin/env python3
"""只生成并落盘博客 Markdown；不审查、不提交、不推送。"""

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


if __name__ == '__main__':
    require_external_runtime('generate-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    load_publish_to_blog().main()
