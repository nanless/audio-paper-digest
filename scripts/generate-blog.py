#!/usr/bin/env python3
"""Generate and install blog Markdown only; never review, commit, or push."""

from project_env import load_project_env
load_project_env()

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


if __name__ == '__main__':
    require_external_runtime('generate-blog.py')
    load_publish_to_blog().generate_main()
