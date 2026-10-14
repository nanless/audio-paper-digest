"""Private Git fixtures reuse real prompt objects without recreating old files."""

import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[2]


def install_git_prompt_evidence_fixture(project_root):
    project_root = Path(project_root).resolve()
    project_root.mkdir(parents=True, exist_ok=True)
    subprocess.run(['git', 'init', '-q', str(project_root)], check=True, capture_output=True)
    objects = subprocess.run(['git', '-C', str(ROOT), 'rev-parse', '--path-format=absolute',
                              '--git-common-dir'], check=True, capture_output=True, text=True).stdout.strip()
    alternates = project_root / '.git' / 'objects' / 'info' / 'alternates'
    alternates.parent.mkdir(parents=True, exist_ok=True)
    alternates.write_text(str(Path(objects) / 'objects') + '\n')
    index = project_root / 'scripts/lib/git-prompt-evidence-index.json'
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_bytes((ROOT / 'scripts/lib/git-prompt-evidence-index.json').read_bytes())
    os.chmod(index, 0o600)
    return project_root
