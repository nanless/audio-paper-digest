#!/bin/bash
# 使用前请在项目根目录的 .env 文件中配置（外层 shell 同名变量会被清理）：
#   PAPER_ANALYZER_API_KEY
#   PAPER_ANALYZER_ENDPOINT
#   PAPER_ANALYZER_MODEL
#
# 如需发布微信公众号，额外设置：
#   WECHAT_APP_ID
#   WECHAT_APP_SECRET

if [ -n "${CODEX_SANDBOX:-}" ]; then
  echo "run-full-fetch.sh 必须在沙箱外运行（检测到 CODEX_SANDBOX=${CODEX_SANDBOX}）。" >&2
  exit 2
fi

cd "$(dirname "$0")"
exec node scripts/full-fetch.js 2>&1
