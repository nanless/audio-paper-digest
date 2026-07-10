#!/bin/bash
# 备份 deep-analysis-result.json 到 data/archive/
# 用法: bash scripts/backup-data.sh [标签]
# 示例: bash scripts/backup-data.sh pre-fetch

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_ROOT/data"
ARCHIVE_DIR="$DATA_DIR/archive"
LOGS_DIR="$PROJECT_ROOT/logs"

# 备份脚本及其外部命令使用最小环境，不继承项目凭据、代理或其他工具凭据。
for _env_name in $(compgen -e); do
    case "$_env_name" in
        PATH|HOME|TMPDIR|LANG|LC_*|TZ|USER|LOGNAME|SHELL|TERM|__CF_USER_TEXT_ENCODING) ;;
        *) unset "$_env_name" ;;
    esac
done

# 只读取项目根 .env 中的日志禁用开关，不接受外层 shell 同名变量。
PD_DISABLE_FILE_LOGS=""
PAPER_DIGEST_DISABLE_FILE_LOGS=""
if [ -f "$PROJECT_ROOT/.env" ]; then
    chmod 600 "$PROJECT_ROOT/.env"
    while IFS='=' read -r key value; do
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^['\"'\'']//' -e 's/['\"'\'']$//')"
        case "$key" in
            PD_DISABLE_FILE_LOGS) PD_DISABLE_FILE_LOGS="$value" ;;
            PAPER_DIGEST_DISABLE_FILE_LOGS) PAPER_DIGEST_DISABLE_FILE_LOGS="$value" ;;
        esac
    done < "$PROJECT_ROOT/.env"
fi

if [ "$PD_DISABLE_FILE_LOGS" != "1" ] && [ "$PAPER_DIGEST_DISABLE_FILE_LOGS" != "1" ]; then
    umask 077
    mkdir -p "$LOGS_DIR"
    LOG_FILE="$LOGS_DIR/backup-data-$(date +%Y%m%d-%H%M%S)-$$.log"
    exec 3>&1 4>&2
    exec > "$LOG_FILE" 2>&1
    trap '_status=$?; trap - EXIT; cat "$LOG_FILE" >&3; exit "$_status"' EXIT
    echo "[log] 输出文件: $LOG_FILE"
fi

RESULT_FILE="$DATA_DIR/current/deep-analysis-result.json"
PAPERS_FILE="$DATA_DIR/current/papers.json"

# 可选标签
LABEL="${1:-$(date +%Y%m%d-%H%M%S)}"
case "$LABEL" in
    ''|*/*|*'..'*)
        echo "错误: 备份标签不能为空、包含斜杠或包含 '..'" >&2
        exit 2
        ;;
esac

mkdir -p "$ARCHIVE_DIR"

echo "=== 数据备份 ==="
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "标签: $LABEL"
echo ""

# 安全读取 JSON 的论文数量
_count_papers() {
    local file="$1"
    if [ -f "$file" ]; then
        python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get("papers", d if isinstance(d, list) else [])))' "$file" 2>/dev/null || echo "?"
    else
        echo "0"
    fi
}

# 备份分析结果
if [ -f "$RESULT_FILE" ]; then
    BACKUP_NAME="deep-analysis-result-$LABEL.json"
    cp "$RESULT_FILE" "$ARCHIVE_DIR/$BACKUP_NAME"
    FILESIZE=$(du -h "$ARCHIVE_DIR/$BACKUP_NAME" | cut -f1)
    PAPER_COUNT=$(_count_papers "$RESULT_FILE")
    echo "✅ 分析结果已备份: $BACKUP_NAME ($FILESIZE, $PAPER_COUNT 篇)"
else
    echo "⚠️  分析结果不存在: $RESULT_FILE"
fi

# 备份论文去重数据库
if [ -f "$PAPERS_FILE" ]; then
    PAPERS_BACKUP="papers-$LABEL.json"
    cp "$PAPERS_FILE" "$ARCHIVE_DIR/$PAPERS_BACKUP"
    FILESIZE=$(du -h "$ARCHIVE_DIR/$PAPERS_BACKUP" | cut -f1)
    echo "✅ 论文数据库已备份: $PAPERS_BACKUP ($FILESIZE)"
else
    echo "⚠️  论文数据库不存在: $PAPERS_FILE"
fi

echo ""

# 清理过期备份（保留最近30个）
BACKUP_COUNT=$(ls -1 "$ARCHIVE_DIR"/deep-analysis-result-*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -gt 30 ]; then
    TO_DELETE=$((BACKUP_COUNT - 30))
    echo "🗑️  清理过期备份（保留最近30个，删除$TO_DELETE个旧备份）"
    ls -1t "$ARCHIVE_DIR"/deep-analysis-result-*.json | tail -n "$TO_DELETE" | xargs rm -f
    echo "✅ 已清理 $TO_DELETE 个过期备份"
fi

echo "📁 archive/ 目录:"
ls -lh "$ARCHIVE_DIR" | tail -20

echo ""
echo "✅ 备份完成"
