#!/usr/bin/env python3
"""Load publish-to-blog.py as a shared implementation module."""

import importlib.util
from pathlib import Path


def load_publish_to_blog():
    module_path = Path(__file__).resolve().parent / 'publish-to-blog.py'
    spec = importlib.util.spec_from_file_location('paper_digest_publish_to_blog', module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f'无法加载博客共享模块: {module_path}')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
