# 默认 API 命令与脚本职责

## 如何使用本页

面向操作者，按“我要完成什么”列命令。逐文件依赖图见 [scripts/README.md](../scripts/README.md)，命令别名以 `package.json` 为准。Manual 内部命令只见 [manual/README.md](../manual/README.md)。

## 完整日更

| 命令 | 用途 |
|---|---|
| `npm run digest:prepare -- DATE` | 默认 LLM/API 完整编排 |
| `npm run digest:api -- DATE` | 同义显式别名 |
| `./run-daily-digest.sh DATE --from STAGE` | 从安全阶段恢复 |
| `npm run digest:status -- --date DATE` | 只读最终状态快照 |
| `npm run digest:waive-visuals -- --date DATE --reason TEXT` | 用户明确不生图时签发 waiver |

`digest:manual` 只在用户明确要求人工流程时使用。

## 数据阶段

| 命令 | 行为 |
|---|---|
| `npm run fetch` | 归档、抓取、筛选、分析；不发布 |
| `npm run deep -- --date DATE` | 从 complete filtered 安全续分析 |
| `npm run batch` | 批量处理 canonical 中未完成论文 |
| `npm run reanalyze -- --concurrency N` | 强制全量重分析 |
| `node scripts/analyze-single-paper.js ID --force` | 单篇分析 |
| `node scripts/reanalyze-selected.js ID...` | 指定集合重分析 |
| `node scripts/refilter-reanalyze-by-date.js DATE` | 历史日期重筛与重分析 |
| `npm run api:reader:refresh -- --all --date DATE --concurrency N --scoring-and-reader` | 批量刷新评分与 Reader |
| `npm run validate:data` | 只读 current 契约检查 |
| `npm run keyword:recall` | 关键词预筛金标准回放 |
| `npm run backfill` | 仅补录历史 paper ID |

`full-fetch.js` 从 fetch 开始时只接受北京时间当天。后台运行可直接调用 `node scripts/full-fetch.js`，避免 npm/TTY 包装干扰。

## 博客事务

| 命令 | 唯一职责 |
|---|---|
| `npm run blog:generate -- --date DATE` | 生成页面和 generation manifest |
| `npm run blog:review -- --date DATE` | 只读 review、Hugo gate、receipt |
| `npm run blog:push -- --date DATE` | 精确 commit/push 与远端 OID |
| `--include-id ID` | 单篇隔离范围，适用阶段必须保持同一 ID |
| `--exclude-id ID` | generate 阶段显式排除，可重复 |

不得把三个入口合并为一个模糊的“发布脚本”。`publish-to-blog.py` 是共享实现与生成兼容入口，不替代三阶段门禁。

## 视觉状态机

| 命令 | 行为 |
|---|---|
| `npm run visual:post-publish -- --date DATE` | 从已验证 publication 规划两类任务 |
| `npm run visual:prepare -- --date DATE` | 校验参考缓存并输出绝对图片路径 |
| `npm run visual:status -- --date DATE` | TOP 10 长图只读状态 |
| `npm run visual:record -- ... --qa-attested true` | 登记已目检论文图 |
| `npm run visual:fail -- ...` | 记录论文图失败 |
| `npm run cover:status -- --date DATE` | 汇总封面只读状态 |
| `npm run cover:record -- ... --qa-attested true` | 登记已目检封面 |
| `npm run cover:fail -- ...` | 记录封面失败 |

实际成图只能使用 Codex 内置 `image_gen`；`visual:render:debug` 仅供本地调试/离线兜底。

## 配置与公共实现

- `scripts/config.js`：Node 参数与 `data/current` 路径。
- `scripts/env-loader.js` / `scripts/project_env.py`：项目环境与沙箱守卫。
- `scripts/utils.js`：API 路由、代理、Prompt、原子写、时间和 ID。
- `scripts/analysis-engine.js`：论文锁、重试、checkpoint 与 canonical 合并。
- `scripts/deep-analyzer.js`：单篇多阶段分析和 Reader。
- `scripts/path_config.py`：Python 发布路径。
- `scripts/publish_common.py`：发布数据、评分、LLM 与 provenance 公共层。
- `scripts/publish-to-blog.py`：博客 generation/review/push 共享事务实现。

## 可选渠道

`npm run wechat`、`npm run xiaohongshu`、`npm run xhs-login`、`npm run xhs-publish` 和 `python3 scripts/publish-to-feishu.py` 均不属于默认日更。除非用户明确要求，不执行真实渠道写入。

## 测试

```bash
npm test
npm run test:default
npm run test:manual
npm run validate:data -- --allow-empty
```

CI 还检查默认与 Manual 目录的 JS/Python 语法、两处 Python 测试和全仓 shell 语法。所有命令沙箱外运行。
