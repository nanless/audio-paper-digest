#!/bin/bash
# 日更唯一入口：共享 LLM/API 流程，单篇人工修正通过受控恢复入口处理。
#
# 本脚本负责项目脚本能自动跑完的所有阶段：
# 抓取/筛选/深度分析 → 博客生成 → 审查 → 推送 → 发布后视觉任务规划与参考图准备。
# 最后的论文长图与汇总封面必须由 Codex 内置 image_gen 生成，项目脚本不得调用图像 API。

set -eu

usage() {
  cat <<'EOF'
用法:
  ./run-daily-digest.sh YYYY-MM-DD [--from fetch|generate|review|push|visual] [--api] [--no-visuals]

运行 LLM/API 抓取、筛选、深度分析和博客审查。已退役整批 Manual 写作链；
单篇受控人工修正与独立审查仍可用于三个流程的失败恢复。
某一阶段失败后，修复问题并用 --from 从该阶段续跑：
  ./run-daily-digest.sh 2026-07-23 --from review

脚本成功结束表示博客已推送且视觉输入已准备好；Codex 必须继续使用内置
image_gen 生成并登记 TOP 10 论文长图和汇总封面，直到 visual:status 和
cover:status 均为 complete。还须确认对应提交的 GitHub Pages 构建和部署成功，
逐页检查正式地址、HTTP 200 与标题，再重新读取 digest:status。
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  usage
  exit 0
fi

if [ -n "${CODEX_SANDBOX:-}" ]; then
  echo "run-daily-digest.sh 必须在沙箱外运行（检测到 CODEX_SANDBOX=${CODEX_SANDBOX}）。" >&2
  exit 2
fi

target_date="${1:-}"
if ! [[ "$target_date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  usage >&2
  exit 2
fi

validate_calendar_date() {
  local value="$1"
  local year month day max_day
  year="${value:0:4}"
  month=$((10#${value:5:2}))
  day=$((10#${value:8:2}))
  if [ $((10#$year)) -lt 1 ] || [ "$month" -lt 1 ] || [ "$month" -gt 12 ] || [ "$day" -lt 1 ]; then
    return 1
  fi
  case "$month" in
    1|3|5|7|8|10|12) max_day=31 ;;
    4|6|9|11) max_day=30 ;;
    2)
      max_day=28
      if { [ $((10#$year % 4)) -eq 0 ] && [ $((10#$year % 100)) -ne 0 ]; } \
          || [ $((10#$year % 400)) -eq 0 ]; then
        max_day=29
      fi
      ;;
  esac
  [ "$day" -le "$max_day" ]
}

if ! validate_calendar_date "$target_date"; then
  echo "非法日期: ${target_date}" >&2
  exit 2
fi
shift

start_stage="fetch"
no_visuals=0
if [ "${PD_DAILY_API_MODE:-1}" != "1" ]; then
  echo "整批 Manual 流程已退役，请使用日更 API 流程或受控单篇恢复。" >&2
  exit 2
fi
while [ "$#" -gt 0 ]; do
  case "${1:-}" in
    --from)
      if [ "$#" -lt 2 ]; then
        usage >&2
        exit 2
      fi
      start_stage="${2:-}"
      shift 2
      ;;
    --api)
      shift
      ;;
    --no-visuals)
      if [ "$no_visuals" -eq 1 ]; then
        echo "--no-visuals 不能重复使用" >&2
        exit 2
      fi
      no_visuals=1
      shift
      ;;
    --manual)
      echo "整批 Manual 流程已退役，请使用日更 API 流程或受控单篇恢复。" >&2
      exit 2
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

case "$start_stage" in
  fetch) start_index=1 ;;
  generate) start_index=5 ;;
  review) start_index=6 ;;
  push) start_index=7 ;;
  visual) start_index=8 ;;
  *)
    echo "未知阶段: $start_stage" >&2
    usage >&2
    exit 2
    ;;
esac

# full-fetch.js 将新抓取绑定到启动时的北京时间日期，不能指定历史日期。
# 在归档或覆盖当前运行数据前拒绝日期不符的请求。历史批次可从已有数据续跑；
# 历史日批次只允许从现有生成或发布阶段恢复；重写走 history 流程。
if [ "$start_index" -eq 1 ]; then
  beijing_today="$(TZ=Asia/Shanghai date +%Y-%m-%d)"
  if [ "$target_date" != "$beijing_today" ]; then
    echo "抓取阶段只允许北京时间当天（今天 ${beijing_today}，请求 ${target_date}）。" >&2
    echo "历史批次只能使用 --from generate|review|push|visual 续跑，重写使用 history:run。" >&2
    exit 2
  fi
fi

cd "$(dirname "$0")"

run_stage() {
  stage_index="$1"
  stage_name="$2"
  shift 2
  if [ "$start_index" -le "$stage_index" ]; then
    echo "==> 论文速递阶段: ${stage_name}"
    "$@" || {
      status=$?
      echo "❌ 阶段失败: ${stage_name}（退出码 ${status}），停止后续阶段。" >&2
      return "$status"
    }
  fi
}

if [ "$start_index" -eq 1 ]; then
  run_stage 1 "默认 LLM/API 抓取、筛选、深度分析" node scripts/full-fetch.js --date "$target_date" --require-previously-fetched
fi

run_stage 5 "生成博客" bash scripts/python-runtime.sh scripts/generate-blog.py --date "$target_date"
run_stage 6 "模型审查博客" bash scripts/python-runtime.sh scripts/review-blog.py --date "$target_date"
if [ "$start_index" -le 7 ]; then
  run_stage 7 "发布博客并规划视觉任务" bash scripts/python-runtime.sh scripts/push-blog.py --date "$target_date" --require-visual-plan
else
  run_stage 8 "规划发布后视觉任务" bash scripts/python-runtime.sh scripts/plan-post-publish-visuals.py --date "$target_date"
fi
if [ "$no_visuals" -eq 1 ]; then
  run_stage 8 "登记用户授权的本次视觉豁免" node scripts/waive-post-publish-visuals.js --date "$target_date" --reason "用户明确要求本次完整日更不执行视觉任务，保留与当前已验证发布版本绑定的豁免。"
  echo "==> 已登记当前发布版本的视觉豁免；继续完成部署与逐页上线核验。"
else
  run_stage 8 "准备论文关键图输入" node scripts/visual-summary-state.js prepare --date "$target_date"
  echo "==> digest:prepare 仅完成博客发布与视觉输入准备；退出成功不代表整条论文速递完成。"
  echo "==> Codex 现在必须继续生成、目检并登记 TOP 10 论文长图和汇总封面。"
  echo "==> 若用户明确取消视觉，改运行 digest:waive-visuals，禁止调用 image_gen 或伪造 complete。"
  echo "==> 最终检查: npm run visual:status -- --date ${target_date}"
  echo "==> 最终检查: npm run cover:status -- --date ${target_date}"
fi

echo "==> 还须确认对应提交的 GitHub Pages 构建、部署成功，并逐页核对正式地址、HTTP 200 与标题。"
echo "==> 完成图片登记或后续推送后重新读取: npm run digest:status -- --date ${target_date}"
