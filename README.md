# Paper Digest - ICML 2026 论文深度分析

本分支（`icml-2026-analysis`）专门用于 ICML 2026 会议论文的筛选与深度分析，覆盖从 icml.cc 官网爬取、LLM 筛选、基于摘要的深度分析到 Hugo 博客发布的完整链路。

> 如需查看 arXiv / HuggingFace 每日论文速递流程，请切换至 `main` 分支。

---

## 1. 文档说明

| 文件 | 用途 | 读者 |
|------|------|------|
| `README.md` | 给人的完整运行手册（架构、配置、命令、排错） | 人类用户 |
| `SKILL.md` | 给 Agent 的执行规则与安全约束 | AI Agent |
| `prompts/icml-filter.md` | 筛选阶段 LLM prompt（判断论文是否语音/音乐/音频相关） | 维护者 |
| `prompts/icml-deep-analysis.md` | 深度分析阶段 LLM prompt（输出格式、标签体系、评分标准） | 维护者 |

> **铁律**：真实行为以 `scripts/*.js` / `scripts/*.py` 当前实现为最终准绳。若文档与代码冲突，以代码为准并修正文档。

---

## 2. 项目结构

```
audio-paper-digest/
├── scripts/
│   ├── fetch-icml2026.py       # 从 icml.cc 爬取完整论文列表
│   ├── icml-filter.js          # 筛选音频/语音/音乐相关论文
│   ├── icml-batch-analyze.js   # 批量深度分析（基于摘要）
│   ├── icml-retry-failed.js    # 重试分析失败的论文
│   ├── publish-to-blog.py      # 发布到 Hugo 博客
│   ├── publish-wechat-full.py  # 生成微信公众号图文草稿
│   ├── publish-xiaohongshu.py  # 生成小红书文案
│   ├── utils.js                # 公共工具函数
│   ├── utils.py                # 公共工具函数（Python）
│   └── config.js               # 统一配置中心
├── data/
│   ├── icml2026_papers.json    # 完整论文列表（6567篇，从icml.cc爬取）
│   └── current/
│       ├── icml_2026_filtered.json      # 筛选通过的论文
│       ├── icml_2026_excluded.json      # 排除的论文
│       └── icml_2026_deep_analysis.json # 深度分析结果
├── prompts/
│   ├── icml-filter.md          # ICML 筛选 prompt
│   └── icml-deep-analysis.md   # ICML 深度分析 prompt
├── package.json
└── README.md / SKILL.md
```

---

## 3. ICML 2026 工作流

### 3.1 整体流程

```
icml.cc 官网 (6567篇)
    │
    ▼
爬取论文列表 (fetch-icml2026.py)
    │
    ▼
LLM 筛选音频相关论文 (icml-filter.js)
    │
    ▼
基于摘要的深度分析 (icml-batch-analyze.js)
    │
    ▼
发布到博客 / 公众号 / 小红书
```

### 3.2 数据来源特点

- **来源**：`icml.cc/virtual/2026/papers.html`
- **格式**：每篇论文包含 `id`（poster ID）、`title`、`authors`、`abstract`、`date_published`、`url`
- **限制**：无 PDF 全文，无图片，分析完全基于标题和摘要
- **数据文件**：`data/icml2026_papers.json`

### 3.3 环境变量配置

在 `~/.hermes/.env` 中配置：

```bash
# LLM API 配置（筛选和分析共用）
PAPER_ANALYZER_ENDPOINT=https://api.xxx.com/v1
PAPER_ANALYZER_API_KEY=sk-xxx
PAPER_ANALYZER_MODEL=claude-sonnet-4-6

# 博客发布配置
PAPER_DIGEST_BLOG_URL=https://nanless.github.io/audio-paper-digest-blog/posts
PAPER_DIGEST_BLOG_REPO=/Users/xxx/audio-paper-digest-blog

# 可选：ICML 专用配置
ICML_FILTER_CONCURRENCY=8       # 筛选并发数
ICML_ANALYSIS_CONCURRENCY=3     # 分析并发数
```

---

## 4. 运行命令

### 4.1 爬取完整论文列表

```bash
npm run icml-fetch
```

或：
```bash
python3 scripts/fetch-icml2026.py
```

输出：`data/icml2026_papers.json`（约 8 MB，6567 篇论文）

### 4.2 筛选音频相关论文

```bash
npm run icml-filter
```

或：
```bash
node scripts/icml-filter.js
```

输出：
- `data/current/icml_2026_filtered.json` — 筛选通过的论文
- `data/current/icml_2026_excluded.json` — 排除的论文

**断点续传**：
```bash
# 从第 500 篇开始，最多筛选 1000 篇
ICML_FILTER_OFFSET=500 ICML_FILTER_LIMIT=1000 node scripts/icml-filter.js
```

### 4.3 批量深度分析

```bash
npm run icml-analyze
```

或：
```bash
node scripts/icml-batch-analyze.js
```

输出：`data/current/icml_2026_deep_analysis.json`

**断点续传**：
```bash
# 从第 50 篇开始，最多分析 100 篇
ICML_OFFSET=50 ICML_LIMIT=100 node scripts/icml-batch-analyze.js
```

### 4.4 重试失败分析

```bash
npm run icml-retry
```

或：
```bash
node scripts/icml-retry-failed.js
```

### 4.5 发布

```bash
# 发布到博客
npm run publish

# 生成微信公众号草稿
npm run wechat

# 生成小红书文案
npm run xiaohongshu
```

---

## 5. 数据文件格式

### 5.1 爬取结果 `data/icml2026_papers.json`

```json
{
  "conference": "ICML 2026",
  "count": 6567,
  "fetched_at": "2026-05-23T12:00:00+08:00",
  "papers": [
    {
      "id": "61337",
      "title": "Hyper-ICL: Attention Calibration with Hyperbolic Anchor Distillation for Multimodal In-Context Learning",
      "authors": ["Niloufar Alipour Talemi", "Hossein Kashiani", "Fatemeh Afghah"],
      "date_published": "2026-05-05",
      "abstract": "Multimodal In-Context Learning (ICL) has emerged as...",
      "url": "https://icml.cc/virtual/2026/poster/61337"
    }
  ]
}
```

### 5.2 筛选结果 `data/current/icml_2026_filtered.json`

```json
{
  "count": 171,
  "papers": [
    {
      "id": "61337",
      "title": "...",
      "authors": [...],
      "abstract": "...",
      "url": "..."
    }
  ]
}
```

### 5.3 深度分析结果 `data/current/icml_2026_deep_analysis.json`

```json
{
  "conference": "ICML 2026",
  "count": 171,
  "analyzed_at": "2026-05-23T15:00:00+08:00",
  "papers": [
    {
      "id": "61337",
      "title": "...",
      "authors": [...],
      "abstract": "...",
      "url": "...",
      "analysis": "## 评分\n7.5/10\n\n## 机器摘要\n...",
      "parsed": {
        "score": 7.5,
        "rank_bucket": "前25%",
        "primary_task_tag": "#多模态学习",
        "primary_method_tag": "#注意力机制"
      },
      "error": null
    }
  ]
}
```

---

## 6. 与 arXiv 流程的差异

| 维度 | arXiv 流程 (main) | ICML 流程 (本分支) |
|------|-------------------|-------------------|
| 数据来源 | arXiv API + HuggingFace | icml.cc 官网爬取 |
| 论文总量 | 每日新增数十篇 | 固定 6567 篇 |
| 全文获取 | arXiv HTML 全文 | 仅摘要 |
| 图片分析 | 有（arXiv 图片） | 无 |
| 筛选依据 | 标题 + 摘要 + arXiv 类别 | 标题 + 摘要 |
| 分析深度 | 全文 + 图片 | 摘要（较浅） |
| 数据更新 | 每日增量 | 一次性全量 |

---

## 7. 排错

### 7.1 筛选阶段

- **API 超时**：降低 `ICML_FILTER_CONCURRENCY`，增加 `ICML_FILTER_TIMEOUT`
- **大量失败**：检查 `PAPER_ANALYZER_ENDPOINT` / `KEY` / `MODEL` 配置
- **断点续传失败**：检查 `data/current/icml_2026_filtered.json` 和 `excluded.json` 是否损坏

### 7.2 分析阶段

- **API 拒绝（rejected）**：通常是内容安全过滤，可尝试 `icml-retry-failed.js`
- **解析失败**：检查模型输出格式，必要时更新 `prompts/icml-deep-analysis.md`
- **内存不足**：减少 `ICML_ANALYSIS_CONCURRENCY`，分批运行

---

## 8. 技术栈

- **Node.js** >= 18
- **Python** 3.x
- **API**：Anthropic / OpenAI 兼容接口
- **数据存储**：JSON 文件
- **博客**：Hugo + GitHub Pages
