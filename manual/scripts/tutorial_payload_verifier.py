"""兼容薄壳：转导 scripts/tutorial_payload_verifier_core.py 的核心实现。

日常发布与渲染门禁已直接导入 scripts/tutorial_payload_verifier_core.py，
不再依赖 manual/scripts 在 sys.path 中；本文件仅保留给 manual/ 历史工具与旧测试兼容读取。
"""

import sys
from pathlib import Path

SHARED_SCRIPTS = Path(__file__).resolve().parents[2] / 'scripts'
if str(SHARED_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SHARED_SCRIPTS))

from tutorial_payload_verifier_core import (  # noqa: E402, F401
    CURRENT_DIR,
    FRESH_AUTHORING_CONTRACT,
    FRESH_AUTHORING_INPUT_KINDS,
    FRESH_AUTHORING_MODE,
    MANUAL_TUTORIAL_ORCHESTRATOR_CONTRACT,
    MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
    MANUAL_TUTORIAL_PAYLOAD_CONTRACT,
    OPTIONAL_FRESH_AUTHORING_INPUT_KINDS,
    PROJECT_ROOT,
    PublishDataValidationError,
    TUTORIAL_FORMAT_CONTRACT,
    normalize_fresh_article,
    normalize_publish_arxiv_id,
    stable_json_sha256,
    validate_manual_fresh_authoring,
    validate_manual_tutorial_payload,
)
