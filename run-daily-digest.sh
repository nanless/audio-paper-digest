#!/bin/bash
# Codex 默认“某日论文速递”编排入口。默认使用 LLM/API；Manual v6 须显式 --manual。
#
# 本脚本负责所有可由项目脚本确定性执行的阶段：
# 抓取/筛选/深度分析 → 博客生成 → review → push → 发布后视觉任务规划与参考图准备。
# 最后的论文长图与汇总封面必须由 Codex 内置 image_gen 生成，项目脚本不得调用图像 API。

set -eu

usage() {
  cat <<'EOF'
用法:
  ./run-daily-digest.sh YYYY-MM-DD [--from fetch|tasks|spec|analyze|generate|review|push|visual] [--api|--manual]

默认运行 LLM/API 自动抓取、筛选、深度分析和博客 review。只有显式 --manual
才切换 production Manual v6，并在需要逐论文人工产物的边界停下。
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
api_mode="${PD_DAILY_API_MODE:-1}"
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
    --manual)
      api_mode=0
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
  tasks) start_index=2 ;;
  spec) start_index=3 ;;
  analyze) start_index=4 ;;
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

# full-fetch.js deliberately binds a fresh crawl to its Beijing start date and
# has no historical-date override. Reject a mismatched fetch before it can
# archive or overwrite current runtime data. Historical batches may still
# resume safely from tasks/spec/analyze/generate/review/push/visual.
if [ "$start_index" -eq 1 ]; then
  beijing_today="$(TZ=Asia/Shanghai date +%Y-%m-%d)"
  if [ "$target_date" != "$beijing_today" ]; then
    echo "抓取阶段只允许北京时间当天（今天 ${beijing_today}，请求 ${target_date}）。" >&2
    echo "历史批次只能使用 --from tasks|spec|analyze|generate|review|push|visual 续跑。" >&2
    exit 2
  fi
fi

if [ "$api_mode" -eq 1 ] && [ "$start_index" -ge 2 ] && [ "$start_index" -le 4 ]; then
  echo "默认 LLM/API 模式不使用 Manual v6 的 tasks/spec/analyze 阶段；请从 fetch 或 generate/review/push/visual 续跑，或显式传 --manual。" >&2
  exit 2
fi

cd "$(dirname "$0")"

v6_root="data/current/manual-v6/${target_date}"
records_v4="${v6_root}/records-v4.json"
spec_v6="${v6_root}/spec.json"

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
    npm run manual:fetch -- --date "$target_date" --raw
  echo "==> 生产 Manual v6 默认链路已到人工筛选边界。"
  echo "==> 下一步：每篇候选由独立 subagent 审核，生成 manual_offline spec 后运行："
  echo "    npm run manual:fetch -- --date ${target_date} --select FILTER_SPEC.json"
  echo "    npm run manual:fulltext -- ${target_date}"
  echo "    npm run manual:tasks -- init --date ${target_date}"
  echo "    npm run manual:packet -- --date ${target_date} --paper ARXIV_ID --role author"
  echo "    npm run manual:tasks -- status --date ${target_date}"
  echo "==> task runner 只持久化、claim 和校验真实任务；不会创建 subagent、物化 role packet 或组装 records envelope。"
  echo "==> 主 Agent 必须逐篇创建 Terra-high leaf subagent；四类任务全部 validated 后运行 manual:records 确定性密封 records v4。"
  echo "==> 全部任务 validated 且 records envelope 就绪后，用 --from spec 续跑生产 spec v6/canonical。"
  exit 3
fi

if [ "$start_index" -eq 1 ]; then
  run_stage 1 "默认 LLM/API 抓取、筛选、深度分析" node scripts/full-fetch.js
fi

if [ "$api_mode" -ne 1 ]; then
  if [ "$start_index" -le 2 ]; then
    run_stage 2 "初始化生产 Manual v6 task runner" \
      npm run manual:tasks -- init --date "$target_date"
    npm run manual:tasks -- status --date "$target_date"
    echo "==> task runner 已停在真实人工编排边界；它不会创建 subagent、物化 packet 或组装 records-v4.json。"
    echo "==> 主 Agent 用 manual:packet 物化每个 role packet，并完成逐篇 register/claim/start/submit；随后用 --from spec 续跑。"
    exit 3
  fi
  run_stage 3 "确定性密封生产 Manual records v4" \
    npm run manual:records -- --date "$target_date"
  run_stage 3 "组装生产 Manual spec v6" \
    npm run manual:spec -- --date "$target_date" --records "$records_v4"
  run_stage 4 "写入生产 Manual v6 canonical" \
    npm run manual:analyze -- --date "$target_date" --spec "$spec_v6"
fi

run_stage 5 "生成博客" python3 scripts/generate-blog.py --date "$target_date"
if [ "$api_mode" -eq 1 ]; then
  run_stage 6 "LLM Review 博客" python3 scripts/review-blog.py --date "$target_date"
elif [ "$start_index" -le 6 ]; then
  echo "==> Manual 默认链路已到逐页语义审查边界。"
  echo "==> generation 中每个页面必须由主 Agent 直接调度独立 leaf review subagent，生成逐图 attestation v3（禁止 broker 占槽）。"
  echo "==> 汇总 shard 后运行 blog:manual-attest 与 manual-review-blog.py，再用 --from push 续跑。"
  exit 3
fi
if [ "$start_index" -le 7 ]; then
  run_stage 7 "发布博客并规划视觉任务" python3 scripts/push-blog.py --date "$target_date" --require-visual-plan
else
  run_stage 8 "规划发布后视觉任务" python3 scripts/plan-post-publish-visuals.py --date "$target_date"
fi
run_stage 8 "准备论文关键图输入" node scripts/visual-summary-state.js prepare --date "$target_date"

echo "==> digest:prepare 仅完成博客发布与视觉输入准备；退出成功不代表整条论文速递完成。"
echo "==> Codex 现在必须继续生成、目检并登记 TOP 10 论文长图和汇总封面。"
echo "==> 若用户明确取消视觉，改运行 digest:waive-visuals，禁止调用 image_gen 或伪造 complete。"
echo "==> 最终门禁: npm run visual:status -- --date ${target_date}"
echo "==> 最终门禁: npm run cover:status -- --date ${target_date}"
