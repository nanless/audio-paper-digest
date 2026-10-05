"""集中定义标签词表和私有预览的路径。"""
import os
from pathlib import Path
from path_config import PROJECT_ROOT, DATA_DIR

TAG_CATALOG_FILE = PROJECT_ROOT / 'config' / 'tag-catalog.json'
TAG_PREVIEW_DIR = DATA_DIR / 'runtime' / 'tag-preview'


def resolve_blog_repo_path(explicit=None):
    """先取显式路径，再取环境变量中的博客路径，最后使用默认目录；调用方应先加载项目环境。"""
    return Path(explicit or os.environ.get('PAPER_DIGEST_BLOG_REPO')
                or Path.home() / 'code' / 'github_repos' / 'audio-paper-digest-blog').expanduser().absolute()


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('tag_paths.py')
    print('这是标签路径模块；生成预览请运行 npm run tags:preview。')
