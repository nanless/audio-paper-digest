#!/usr/bin/env python3
"""Project-scoped environment loader.

Project scripts must use the current repository's .env for Paper Digest
configuration so inherited Trae/Codex/shell variables cannot be mixed with it.
"""

import os
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = PROJECT_ROOT / ".env"

PROJECT_ENV_PREFIXES = (
    "PAPER_ANALYZER_",
    "PAPER_DIGEST_",
    "PD_",
    "WECHAT_",
    "FEISHU_",
    "XIAOHONGSHU_",
)

PROJECT_ENV_KEYS = {
    "KIMI_API_KEY",
}


def resolve_env_file(env_file=None):
    if env_file is not None:
        return Path(env_file)
    if os.environ.get("PAPER_DIGEST_TEST_ENV_FILE"):
        return Path(os.environ["PAPER_DIGEST_TEST_ENV_FILE"])
    return DEFAULT_ENV_FILE


def is_project_env_key(key):
    return key in PROJECT_ENV_KEYS or any(key.startswith(prefix) for prefix in PROJECT_ENV_PREFIXES)


def parse_env_file(env_file=None):
    parsed = {}
    env_file = resolve_env_file(env_file)
    if not env_file.exists():
        return parsed

    with env_file.open("r", encoding="utf-8") as f:
        for line in f:
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip()
            if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
                value = value[1:-1]
            if key:
                parsed[key] = value

    return parsed


def load_project_env(env_file=None):
    parsed = parse_env_file(env_file)

    for key in list(os.environ.keys()):
        if key == "PAPER_DIGEST_TEST_ENV_FILE":
            continue
        if is_project_env_key(key):
            os.environ.pop(key, None)

    os.environ.update(parsed)
    return parsed
