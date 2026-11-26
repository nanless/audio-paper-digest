#!/usr/bin/env python3
"""对已暂存的一篇会议 PDF 做文本与视觉审计抽取，产物不再改动；这是它的命令行入口。"""

import json
import os
from pathlib import Path
import sys

from runtime_guard import require_external_runtime
from conference_extractor import (
    ConferenceExtractionError,
    DEFAULT_STAGING_SOURCE_DIR,
    parse_args,
    run_extraction,
    verify_extraction,
)
from conference_extractor_v2 import (
    RECEIPT_V2_CONTRACT,
    run_extraction_v2,
    verify_extraction_v2,
)


def _split_wrapper_flags(argv):
    extractor = None
    explicit_source_root = None
    remaining = []
    index = 0
    is_verify = "--verify" in argv
    while index < len(argv):
        arg = argv[index]
        if arg == "--extractor":
            if index + 1 >= len(argv):
                raise ConferenceExtractionError("missing value for --extractor (expected v1 or v2)")
            extractor = argv[index + 1].strip().lower()
            index += 2
            continue
        if arg.startswith("--extractor="):
            extractor = arg.split("=", 1)[1].strip().lower()
            index += 1
            continue
        if not is_verify and arg == "--source-root":
            if index + 1 >= len(argv):
                raise ConferenceExtractionError("missing value for --source-root")
            raw_root = argv[index + 1]
            if not Path(raw_root).is_absolute():
                raise ConferenceExtractionError("--source-root must be an absolute path")
            explicit_source_root = Path(raw_root)
            index += 2
            continue
        remaining.append(arg)
        index += 1
    if extractor is not None and extractor not in ("v1", "v2"):
        raise ConferenceExtractionError(f"unsupported --extractor value: {extractor!r} (expected v1 or v2)")
    return extractor, explicit_source_root, remaining


def _detect_existing_receipt_extractor(manifest_name, source_root):
    root = Path(source_root or DEFAULT_STAGING_SOURCE_DIR)
    try:
        manifest_path = root / manifest_name
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        receipt_name = (manifest.get("outputs") or {}).get("receiptFile")
        if not isinstance(receipt_name, str) or not receipt_name:
            return "v1"
        receipt_path = root / receipt_name
        if not receipt_path.is_file():
            return "v1"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if isinstance(receipt, dict) and receipt.get("contract") == RECEIPT_V2_CONTRACT:
            return "v2"
    except Exception:
        return "v1"
    return "v1"


def _resolve_extractor_version(explicit_extractor, mode, manifest_name, source_root):
    if explicit_extractor is not None:
        return explicit_extractor
    if mode == "verify":
        return _detect_existing_receipt_extractor(manifest_name, source_root)
    env_value = os.environ.get("PD_CONFERENCE_EXTRACTOR_VERSION", "").strip().lower()
    if env_value:
        if env_value not in ("v1", "v2"):
            raise ConferenceExtractionError(
                f"unsupported PD_CONFERENCE_EXTRACTOR_VERSION: {env_value!r} (expected v1 or v2)"
            )
        return env_value
    return "v2"


def main(argv=None):
    # 先挡掉沙箱内的直接调用，连命令行参数都还没解析。下面那次按模式区分的
    # 检查保留直接入口的角色要求，同时允许已经过角色校验的流程做固定版本只读重放。
    require_external_runtime("conference-extraction-replay")
    explicit_extractor, explicit_source_root, remaining = _split_wrapper_flags(list(sys.argv[1:] if argv is None else argv))
    mode, manifest_name, source_root = parse_args(remaining)
    if explicit_source_root is not None:
        source_root = explicit_source_root
    # 校验模式也用作已过角色校验的 Node 生产流程内部的固定版本只读重放。
    # apply 和 dry-run 的直接角色要求不变；新会议 npm 包装层显式启用会议模式并核 daily，
    # 旧历史调用仍受自己的角色检查，不能从注释推导跨角色权限。
    require_external_runtime(
        "conference-extract.py" if mode != "verify" else "conference-extraction-replay"
    )
    extractor_version = _resolve_extractor_version(explicit_extractor, mode, manifest_name, source_root)
    if extractor_version == "v2":
        result = (verify_extraction_v2(manifest_name, source_root=source_root)
                  if mode == "verify"
                  else run_extraction_v2(manifest_name, apply=mode == "apply", source_root=source_root))
    else:
        result = (verify_extraction(manifest_name, source_root=source_root)
                  if mode == "verify"
                  else run_extraction(manifest_name, apply=mode == "apply", source_root=source_root))
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return result


if __name__ == "__main__":
    try:
        main()
    except ConferenceExtractionError as exc:
        print(f"[conference-extract] {exc}", file=sys.stderr)
        raise SystemExit(1)
