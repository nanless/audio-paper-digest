#!/bin/bash
# 已停用：旧抓取脚本既不建立日更补抓边界，也不经工作区角色检查。
# 直接调用 full-fetch.js 会改写 data/current，正式入口只有：
#   npm run digest:prepare -- YYYY-MM-DD
#   npm run fetch -- --date YYYY-MM-DD（只跑抓取阶段）
if [ -n "${CODEX_SANDBOX:-}" ]; then
  echo "run-full-fetch.sh 必须在沙箱外运行（检测到 CODEX_SANDBOX=${CODEX_SANDBOX}）。" >&2
  exit 2
fi

echo "run-full-fetch.sh 已停用，不再调用 scripts/full-fetch.js；正式入口是 npm run digest:prepare -- YYYY-MM-DD（只抓取用 npm run fetch -- --date YYYY-MM-DD）。" >&2
exit 2
