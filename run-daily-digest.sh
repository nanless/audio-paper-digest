#!/bin/bash
# Codex 默认“某日论文速递”编排入口。默认使用 Manual；LLM/API 路线须显式 --api。
#
# 本脚本负责所有可由项目脚本确定性执行的阶段：
# 抓取/筛选/深度分析 → 博客生成 → review → push → 发布后视觉任务规划与参考图准备。
# 最后的论文长图与汇总封面必须由 Codex 内置 image_gen 生成，项目脚本不得调用图像 API。

set -eu

usage() {
  cat <<'EOF'
用法:
  ./run-daily-digest.sh YYYY-MM-DD [--from fetch|generate|review|push|visual] [--api]

默认从 Manual raw fetch 开始，并在需要逐论文人工产物的边界停下，由 Agent
逐篇分派独立 subagent 后继续。只有显式 --api 才运行旧 LLM/API 自动链路。
某一阶段失败后，修复问题并用 --from 从该阶段续跑：
  ./run-daily-digest.sh 2026-07-23 --from review

脚本成功结束表示发布已完成且视觉输入已准备好；Codex 必须继续使用内置
image_gen 生成并登记 TOP 10 论文长图和汇总封面，直到 visual:status 和
cover:status 均为 complete。
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
api_mode="${PD_DAILY_API_MODE:-0}"
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
      api_mode=1
      shift
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

case "$start_stage" in
  fetch) start_index=1 ;;
  generate) start_index=2 ;;
  review) start_index=3 ;;
  push) start_index=4 ;;
  visual) start_index=5 ;;
  *)
    echo "未知阶段: $start_stage" >&2
    usage >&2
    exit 2
    ;;
esac

# full-fetch.js deliberately binds a fresh crawl to its Beijing start date and
# has no historical-date override. Reject a mismatched fetch before it can
# archive or overwrite current runtime data. Historical batches may still
# resume safely from generate/review/push/visual.
if [ "$start_index" -eq 1 ]; then
  beijing_today="$(TZ=Asia/Shanghai date +%Y-%m-%d)"
  if [ "$target_date" != "$beijing_today" ]; then
    echo "抓取阶段只允许北京时间当天（今天 ${beijing_today}，请求 ${target_date}）。" >&2
    echo "历史批次只能使用 --from generate|review|push|visual 续跑。" >&2
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

if [ "$start_index" -eq 1 ] && [ "$api_mode" -ne 1 ]; then
  run_stage 1 "Manual 联网抓取候选（不调用筛选模型）" \
    node scripts/manual-fetch.js --date "$target_date" --raw
  echo "==> Manual 默认链路已到人工筛选边界。"
  echo "==> 下一步：每篇候选由独立 subagent 审核，生成 manual_offline spec 后运行："
  echo "    node scripts/manual-fetch.js --date ${target_date} --select FILTER_SPEC.json"
  echo "    npm run manual:fulltext -- ${target_date}"
  echo "==> 随后每篇由独立 paper subagent 写 records v3，再运行 manual:spec/manual:analyze。"
  exit 3
fi

if [ "$start_index" -eq 1 ]; then
  run_stage 1 "显式 LLM/API 抓取、筛选、深度分析" node scripts/full-fetch.js
fi
run_stage 2 "生成博客" python3 scripts/generate-blog.py --date "$target_date"
if [ "$api_mode" -eq 1 ]; then
  run_stage 3 "LLM Review 博客" python3 scripts/review-blog.py --date "$target_date"
elif [ "$start_index" -le 3 ]; then
  echo "==> Manual 默认链路已到逐页语义审查边界。"
  echo "==> generation 中每个页面必须由主 Agent 直接调度独立 leaf review subagent，生成逐图 attestation v3（禁止 broker 占槽）。"
  echo "==> 汇总 shard 后运行 blog:manual-attest 与 manual-review-blog.py，再用 --from push 续跑。"
  exit 3
fi
if [ "$start_index" -le 4 ]; then
  run_stage 4 "发布博客并规划视觉任务" python3 scripts/push-blog.py --date "$target_date" --require-visual-plan
else
  run_stage 5 "规划发布后视觉任务" python3 scripts/plan-post-publish-visuals.py --date "$target_date"
fi
run_stage 5 "准备论文关键图输入" node scripts/visual-summary-state.js prepare --date "$target_date"

echo "==> digest:prepare 仅完成博客发布与视觉输入准备；退出成功不代表整条论文速递完成。"
echo "==> Codex 现在必须继续生成、目检并登记 TOP 10 论文长图和汇总封面。"
echo "==> 若用户明确取消视觉，改运行 digest:waive-visuals，禁止调用 image_gen 或伪造 complete。"
echo "==> 最终门禁: npm run visual:status -- --date ${target_date}"
echo "==> 最终门禁: npm run cover:status -- --date ${target_date}"
