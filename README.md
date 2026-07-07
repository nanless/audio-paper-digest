# Paper Digest - 语音/音乐/音频论文速递全流程自动化

**[English](README.en.md)** | 中文

本项目用于自动生成"语音/音乐/音频论文速递"，覆盖从 arXiv 和 HuggingFace Papers 抓取、LLM 筛选、多模态深度分析，到发布 Hugo 博客、微信公众号草稿、小红书文案和飞书文档的完整链路。

---

## 文档说明

| 文件 | 用途 | 读者 |
|------|------|------|
| `README.md` | 项目概览、快速开始、命令速查 | 人类用户 |
| `SKILL.md` | 给 Agent 的执行规则与安全约束 | AI Agent |
| `docs/workflow.md` | 主流程详解（归档、抓取、筛选、分析、保存） | 使用者 |
| `docs/scripts.md` | 全部脚本功能说明 | 开发者 |
| `docs/data-format.md` | 数据文件格式与字段说明 | 开发者 |
| `docs/setup.md` | 安装初始化、环境变量、日志、代理配置 | 新用户 |
| `docs/troubleshooting.md` | 常见问题排查与修复 | 使用者 |
| `docs/maintenance.md` | 维护约定、评分标准、标签口径 | 维护者 |
| `prompts/filter.md` | 筛选阶段 LLM prompt | 维护者 |
| `prompts/deep-analysis.md` | 深度分析主 prompt（Round 1，纯文本） | 维护者 |
| `prompts/image-supplement.md` | 图像筛选与补充 prompt（双模型模式） | 维护者 |
| `prompts/opensource-scan.md` | 开源链接扫描 prompt（Round 2） | 维护者 |
| `prompts/gap-fill.md` | 审校重写 prompt（Round 3） | 维护者 |

> **铁律**：真实行为以 `scripts/*.js` / `scripts/*.py` 当前实现为最终准绳。若文档与代码冲突，以代码为准并修正文档。

---

## 项目结构

```
audio-paper-digest/
├── scripts/              # 全部脚本
├── tests/                # 单元测试
├── data/                 # 工作数据与归档（gitignored）
│   ├── current/          # 当前工作数据
│   └── archive/          # 按日期自动归档
├── logs/                 # 运行日志（gitignored）
├── prompts/              # LLM prompt 文件
├── docs/                 # 详细文档
├── package.json          # npm scripts
├── run-full-fetch.sh     # 全流程入口
└── README.md / SKILL.md
```

详见 [`docs/scripts.md`](docs/scripts.md) 了解每个脚本的功能，[`docs/data-format.md`](docs/data-format.md) 了解数据文件格式。

---

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置 API Key（写入 `.env`）
#    主模型（文本分析，必填）
#    PAPER_ANALYZER_API_KEY=your-key
#    PAPER_ANALYZER_MODEL=deepseek-v4-pro
#    PAPER_ANALYZER_ENDPOINT=https://api.deepseek.com/anthropic
#
#    副模型（多模态图像分析，可选）
#    PAPER_ANALYZER_SECONDARY_MODEL=mimo-v2.5
#    PAPER_ANALYZER_SECONDARY_ENDPOINT=https://token-plan-cn.xiaomimimo.com/v1
#    PAPER_ANALYZER_SECONDARY_API_KEY=tp-your-key

# 3. 运行全流程（抓取 + 筛选 + 深度分析）
./run-full-fetch.sh

# 4. 发布博客
python3 scripts/publish-to-blog.py --date 2026-05-08

# 5. 生成小红书文案
python3 scripts/publish-xiaohongshu.py
```

完整安装指南见 [`docs/setup.md`](docs/setup.md)。

---

## 8. 常用命令速查

### npm scripts

```bash
# 全流程（抓取 + 筛选 + 深度分析）
npm run fetch

# 仅深度分析续跑（跳过已有 analysis；无分析结果时可从 filtered-papers.json 初始化）
npm run deep

# 全量重分析
npm run reanalyze

# 批量分析未分析论文
npm run batch

# 运行单元测试
npm test

# 快速测试（抓+筛选，不分析）
node scripts/quick-test.js

# 补录历史 paper ID
npm run backfill

# 生成博客 Markdown（默认不推送）
npm run publish -- --date 2026-04-21

# 正式发布博客（提交并推送）
npm run publish -- --push --date 2026-04-21

# 生成微信公众号草稿
npm run wechat
# 仅生成公众号预览，不调用微信接口
python3 scripts/publish-wechat-full.py --dry-run
# 发布输入文件全部论文到公众号草稿
python3 scripts/publish-wechat-full.py --all

# 生成小红书文案
npm run xiaohongshu

# 小红书自动发布（需先登录）
npm run xhs-login
npm run xhs-publish
npm run xhs-publish-all

# 生成飞书文档
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
# 仅预览飞书文档规模，不创建文档
python3 scripts/publish-to-feishu.py --dry-run --date 2026-04-21
# 发布输入文件全部论文到飞书
python3 scripts/publish-to-feishu.py --all
```

### 直接调用

```bash
# ========== 核心流程 ==========
# 全流程（推荐入口）
./run-full-fetch.sh

# 或直接用 Node
node scripts/full-fetch.js

# 仅深度分析续跑（跳过已有 analysis；无分析结果时可从 filtered-papers.json 初始化）
node scripts/deep-analysis-only.js

# 全量重分析
node scripts/reanalyze.js

# 指定并发度重分析
node scripts/reanalyze.js --concurrency 3 data/current/deep-analysis-result.json

# 快速测试（抓+筛选，不分析）
node scripts/quick-test.js

# 批量分析未分析论文
node scripts/batch-analyze.js

# 单独分析一篇论文
node scripts/analyze-single-paper.js 2604.16044 --force

# ========== 发布 ==========
# 发布博客（强烈建议显式 --date）
python3 scripts/publish-to-blog.py --date 2026-04-21

# 只生成 Markdown，不推送
python3 scripts/publish-to-blog.py --skip-push --date 2026-04-21

# 正式提交并推送
python3 scripts/publish-to-blog.py --push --date 2026-04-21

# 用自定义数据发布
python3 scripts/publish-to-blog.py --date 2026-04-21 data/current/deep-analysis-result.json
python3 scripts/publish-to-blog.py --all data/current/deep-analysis-result.json

# 生成微信公众号草稿
python3 scripts/publish-wechat-full.py
python3 scripts/publish-wechat-full.py --dry-run

# 用自定义数据生成微信草稿
python3 scripts/publish-wechat-full.py data/current/deep-analysis-result.json
python3 scripts/publish-wechat-full.py --all data/current/deep-analysis-result.json

# 生成小红书文案（默认 TOP 5）
python3 scripts/publish-xiaohongshu.py
python3 scripts/publish-xiaohongshu.py --top 7
python3 scripts/publish-xiaohongshu.py --all

# 小红书自动发布（需先登录）
python3 scripts/xiaohongshu-publisher.py --login
python3 scripts/xiaohongshu-publisher.py
python3 scripts/xiaohongshu-publisher.py --all

# 生成飞书文档
python3 scripts/publish-to-feishu.py
python3 scripts/publish-to-feishu.py --date 2026-04-21
python3 scripts/publish-to-feishu.py --dry-run --date 2026-04-21
python3 scripts/publish-to-feishu.py --all

# ========== 辅助 ==========
# 补录论文 ID（不分析）
python3 scripts/backfill_papers.py

# 按日期重新筛选 + 分析
node scripts/refilter-reanalyze-by-date.js 2026-07-01
```

---

## 更多文档

- [主流程详解](docs/workflow.md) — 自动归档、抓取、筛选、深度分析的完整流程
- [脚本分工](docs/scripts.md) — 全部脚本的功能说明与用法
- [数据格式](docs/data-format.md) — papers.json、filtered-papers.json、deep-analysis-result.json 结构
- [安装与配置](docs/setup.md) — 依赖安装、环境变量、模型配置、日志机制
- [排错手册](docs/troubleshooting.md) — API 错误、代理问题、发布失败的排查方法
- [维护约定](docs/maintenance.md) — 代码规范、评分标签口径、变更检查清单

---

## 参考与致谢

- 本项目在设计和实现过程中参考了 [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill) 的思路与结构
