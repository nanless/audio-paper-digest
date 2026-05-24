#!/bin/bash
# 使用前请确保以下环境变量已设置，或在项目根目录的 .env 文件中配置：
#   PAPER_ANALYZER_API_KEY
#   PAPER_ANALYZER_ENDPOINT
#   PAPER_ANALYZER_MODEL
#
# 如需发布微信公众号，额外设置：
#   WECHAT_APP_ID
#   WECHAT_APP_SECRET

cd "$(dirname "$0")"
exec node scripts/full-fetch.js 2>&1
