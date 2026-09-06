"""Central paths for the isolated taxonomy preview, not publication templates."""
import os
from pathlib import Path
from path_config import PROJECT_ROOT, DATA_DIR

TAXONOMY_REGISTRY_FILE = PROJECT_ROOT / 'config' / 'paper-taxonomy.json'
TAXONOMY_PREVIEW_DIR = DATA_DIR / 'runtime' / 'taxonomy-preview'


def resolve_blog_repo_path(explicit=None):
    """Resolve the Hugo checkout after the caller loads the project env."""
    return Path(explicit or os.environ.get('PAPER_DIGEST_BLOG_REPO')
                or Path.home() / 'code' / 'github_repos' / 'audio-paper-digest-blog').expanduser().absolute()


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('taxonomy_paths.py')
    print('Taxonomy path library; use npm run taxonomy:preview.')
