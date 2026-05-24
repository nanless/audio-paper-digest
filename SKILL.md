---
name: audio-paper-digest-icml2026
description: >
  ICML 2026 论文筛选与深度分析技能。从 icml.cc 官网爬取论文列表，使用环境变量配置的 LLM 做筛选与基于摘要的深度分析，
  输出结构化 JSON，并可发布到 GitHub Pages 博客、微信公众号草稿与小红书文案。
  适用场景：ICML 2026 会议论文筛选、深度分析、博客发布、微信发布与小红书发布。
---

# Paper Digest Skill — ICML 2026 分支

## 1. 文档定位

- `SKILL.md`：给 Agent 的执行规则与安全约束
- `README.md`：给人的运行手册（命令、配置、排错）
- `prompts/icml-filter.md`：筛选阶段 LLM prompt
- `prompts/icml-deep-analysis.md`：深度分析阶段 LLM prompt

当文档与代码冲突时，**以 `scripts/*` 当前实现为准，并同步更新文档**。

---

## 2. 当前真实流程

主入口：`npm run icml-fetch` → `npm run icml-filter` → `npm run icml-analyze`

1. **爬取论文列表**：`scripts/fetch-icml2026.py` 从 `icml.cc/virtual/2026/papers.html` 爬取完整论文列表
   - 输出：`data/icml2026_papers.json`（约 8 MB，6567 篇论文）
   - 每篇包含：`id`（poster ID）、`title`、`authors`、`abstract`、`date_published`、`url`
   - 并发 20，已验证：6567 篇全部有作者，5156 篇有摘要

2. **LLM 筛选**：`scripts/icml-filter.js` 基于标题+摘要判断语音/音乐/音频相关
   - 输入：`data/icml2026_papers.json`
   - 输出：`data/current/icml_2026_filtered.json`（通过）+ `icml_2026_excluded.json`（排除）
   - 并发 8 篇（`ICML_FILTER_CONCURRENCY`），单篇超时 60 秒，重试 3 次
   - 断点续传：支持 `ICML_FILTER_OFFSET` / `ICML_FILTER_LIMIT`

3. **深度分析**：`scripts/icml-batch-analyze.js` 基于摘要进行 LLM 深度分析
   - 输入：`data/current/icml_2026_filtered.json`
   - 输出：`data/current/icml_2026_deep_analysis.json`
   - 并发 3 篇（`ICML_ANALYSIS_CONCURRENCY`），每篇最多重试 2 次
   - 断点续传：支持 `ICML_OFFSET` / `ICML_LIMIT`
   - **仅文本分析**：无 PDF 全文，无图片

4. **重试失败**：`scripts/icml-retry-failed.js` 重新分析 error 不为空的论文

5. **发布**：`publish-to-blog.py` / `publish-wechat-full.py` / `publish-xiaohongshu.py`

---

## 3. 数据路径规范

### 3.1 ICML 专用数据文件

| 文件 | 用途 | 归档行为 |
|------|------|---------|
| `data/icml2026_papers.json` | 完整论文列表（从 icml.cc 爬取） | **不归档**，一次性爬取 |
| `data/current/icml_2026_filtered.json` | 筛选通过的论文 | 手动管理 |
| `data/current/icml_2026_excluded.json` | 排除的论文 | 手动管理 |
| `data/current/icml_2026_deep_analysis.json` | 深度分析结果 | 手动管理 |

### 3.2 数据格式差异

ICML 论文数据与 arXiv 不同：
- 使用 `id`（poster ID，如 `"61337"`）而非 `arxivId`
- 使用 `url`（`https://icml.cc/virtual/2026/poster/<id>`）而非 arXiv 链接
- 无 `categories`（arXiv 类别）
- 无 `published` 日期，有 `date_published`
- 无 PDF 全文，分析基于 `abstract` 字段

---

## 4. 模型与环境变量

### 4.1 统一存放位置

**所有环境变量统一放在 `~/.hermes/.env`。** `.zshrc` 已配置：
```zsh
set -a; source ~/.hermes/.env 2>/dev/null; set +a
```

### 4.2 筛选阶段（`icml-filter.js`）

- endpoint: `PAPER_ANALYZER_ENDPOINT`（必填）
- key: `PAPER_ANALYZER_API_KEY`（必填）
- model: `PAPER_ANALYZER_MODEL`（必填）
- **API 协议自动路由**：与 main 分支一致，详见 main 分支 SKILL.md 4.2 节
- prompt 来源：`prompts/icml-filter.md`，替换 `{title}`、`{abstract}`（无 `{categories}`）
- 判定口径：多模态模型只要明确涉及语音/音乐/音频即判定为相关

### 4.3 深度分析阶段（`icml-batch-analyze.js`）

- 统一使用 `PAPER_ANALYZER_*` 指定的 LLM
- max_tokens=64000，temperature=0.7
- prompt 来源：`prompts/icml-deep-analysis.md`，替换 `{title}`、`{authors}`、`{paperId}`、`{abstract}`
- 无 `{hasFullText}`、`{categories}`、`{arxivId}` 占位符
- **仅文本分析**：无 PDF，无图片
- 代码后处理：`parseAnalysis` 从 `## 评分理由` 提取七维分项重新计算总分
- 七维评分：创新性（0-3）+ 技术严谨性（0-1.5）+ 实验充分性（0-1.5）+ 清晰度（0-1）+ 影响力（0-2）+ 开源（0-1.5）+ 可复现性（0-0.5）

### 4.4 完整环境变量清单

```bash
# LLM API（筛选 + 深度分析）
PAPER_ANALYZER_API_KEY=your-key
PAPER_ANALYZER_MODEL=your-model
PAPER_ANALYZER_ENDPOINT=https://api.xxx.com/v1

# 博客发布
PAPER_DIGEST_BLOG_URL=https://nanless.github.io/audio-paper-digest-blog/posts
PAPER_DIGEST_BLOG_REPO=/Users/xxx/audio-paper-digest-blog

# 微信公众号
WECHAT_APP_ID=your-app-id
WECHAT_APP_SECRET=your-app-secret

# ICML 专用配置（可选）
# ICML_FILTER_CONCURRENCY=8
# ICML_ANALYSIS_CONCURRENCY=3
# ICML_FILTER_TIMEOUT=60000
# ICML_ANALYSIS_TIMEOUT=600000
```

---

## 5. 常用命令

```bash
cd ~/.hermes/skills/openclaw-imports/paper-digest

# 爬取完整论文列表
npm run icml-fetch

# 筛选音频相关论文
npm run icml-filter

# 从第 500 篇开始筛选 1000 篇
ICML_FILTER_OFFSET=500 ICML_FILTER_LIMIT=1000 npm run icml-filter

# 批量深度分析
npm run icml-analyze

# 从第 50 篇开始分析 100 篇
ICML_OFFSET=50 ICML_LIMIT=100 npm run icml-analyze

# 重试失败分析
npm run icml-retry

# 发布到博客
npm run publish -- --date 2026-05-23 data/current/icml_2026_deep_analysis.json

# 生成微信公众号草稿
npm run wechat -- --date 2026-05-23 data/current/icml_2026_deep_analysis.json

# 生成小红书文案
npm run xiaohongshu -- --date 2026-05-23 data/current/icml_2026_deep_analysis.json
```

---

## 6. 发布行为与日期安全

### 核心原则

- ICML 2026 是一次性全量分析，不是每日增量
- 发布时使用 `--date` 指定日期（如 `2026-05-23`），代表分析批次日期
- 发布脚本读取 `data/current/icml_2026_deep_analysis.json`

### 发布命令示例

```bash
# 发布到博客（需指定日期和数据文件）
npm run publish -- --date 2026-05-23 data/current/icml_2026_deep_analysis.json

# 只生成 markdown，不推送
npm run publish -- --skip-push --date 2026-05-23 data/current/icml_2026_deep_analysis.json
```

Agent 执行约束：
- 默认仅允许使用 `--skip-push` 模式验证博客生成结果
- 只有用户明确要求"正式发布 / 推送博客"时，才允许去掉 `--skip-push`

---

## 7. 日志与运行特性

- Node 脚本统一通过 `scripts/log-setup.js` 输出日志到 `logs/<script>-YYYYMMDD-HHMMSS.log`
- **自动清理**：每次启动时清理旧日志，保留最近 50 个
- `icml-filter.js` 每 50 篇保存一次中间结果
- `icml-batch-analyze.js` 每 10 篇保存一次中间结果
- `icml-retry-failed.js` 每 5 篇保存一次中间结果

---

## 8. Agent 执行规则（强约束）

1. **先查再改**：先读取相关脚本确认当前行为，再更新文档或执行命令。
2. **发布需确认日期**：未明确日期时，先问用户；默认不要依赖"今天"。
3. **禁止危险操作**：未获明确授权，禁止 `git reset --hard`、`git push -f`、批量删除历史文章。
4. **不自动扩展流程**：运行 `icml-filter.js` 或 `icml-batch-analyze.js` 后，不要擅自追加博客/微信发布，除非用户明确要求。
5. **改动留痕**：流程、参数、路径变化后，同步更新 `SKILL.md` 和 `README.md`。
6. **禁止硬编码密钥**：所有凭证统一从环境变量读取。
7. **修改脚本时防止安全机制破坏**：修改含 `API_KEY` 等字符的脚本时，修改后必须重新读取文件验证关键行未被破坏。
8. **环境变量统一管理**：新增脚本统一使用 `PAPER_ANALYZER_API_KEY`、`PAPER_ANALYZER_MODEL`、`PAPER_ANALYZER_ENDPOINT`。
9. **新增可配置参数放入 config.js**。
10. **博客验证默认不推送**：未获用户明确授权时，运行 `publish-to-blog.py` 必须带 `--skip-push`。
11. **输出契约改动要同步 parser**：修改 `prompts/icml-deep-analysis.md` 时，同步检查 `scripts/utils.js` 与 `scripts/utils.py`。
12. **变更后必须做产物级验证**：抽样检查 `data/current/icml_2026_deep_analysis.json`，确认字段完整。
13. **MiMo API 请求必须禁用代理连接复用**：`agent: false`。
14. **新增 LLM 端点必须接入 API 协议自动路由**：使用 `utils.js` 中的 `detectApiType()` 等函数。
15. **禁止将敏感文件提交到版本控制**：`data/`、`logs/`、`.env` 等严禁进入 git。

---

## 9. 最小排错手册

### 9.1 模型调用失败 / API 返回 401 / 403 / timeout

与 main 分支一致，详见 main 分支 SKILL.md 9.1 节。

### 9.2 筛选阶段大量失败

- 检查 `PAPER_ANALYZER_ENDPOINT` / `KEY` / `MODEL` 配置
- 降低 `ICML_FILTER_CONCURRENCY`
- 检查 `data/icml2026_papers.json` 是否存在且格式正确

### 9.3 分析阶段慢或频繁失败

- 降低 `ICML_ANALYSIS_CONCURRENCY`
- 检查代理设置
- 查看日志：`logs/icml-batch-analyze-*.log`

### 9.4 发布时找不到论文

- 确认 `data/current/icml_2026_deep_analysis.json` 存在
- 确认使用 `--date` 指定了日期
- 确认数据文件路径正确

### 9.5 ICML 数据文件损坏

- 重新爬取：`npm run icml-fetch`
- 注意：重新爬取会覆盖 `data/icml2026_papers.json`
