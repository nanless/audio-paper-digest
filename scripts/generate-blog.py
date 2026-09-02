#!/usr/bin/env python3
"""Generate and install blog Markdown only; never review, commit, or push."""

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


if __name__ == '__main__':
    require_external_runtime('generate-blog.py')
    from log_setup import setup_script_logging
    setup_script_logging(__file__)
    load_publish_to_blog().main()
