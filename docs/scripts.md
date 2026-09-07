# 默认 API 命令与脚本职责

## 如何使用本页

面向操作者，按“我要完成什么”列命令。逐文件依赖图见 [scripts/README.md](../scripts/README.md)，命令别名以 `package.json` 为准。Manual 内部命令只见 [manual/README.md](../manual/README.md)。

## 工作区角色

生产命令运行前先检查：

```bash
npm run workspace:role -- status
```

`digest:*`、`fetch`、`blog:generate/review/push` 只允许 `daily`；`history:*`、`conference:*`、`rewrite:source` 与 `blog:activate-fresh` 只允许 `history`。首次绑定用 `npm run workspace:role -- set daily|history`；整库复制后 marker 仍绑定旧 realpath，必须在确认副本用途后显式执行 `npm run workspace:role -- set history --force`。marker 为 Git 忽略的 `0600` 本机文件。

## 日更脚本阶段与业务终态

| 命令 | 用途 |
|---|---|
| `npm run digest:prepare -- DATE` | 默认 LLM/API 脚本阶段：发布博客并准备视觉输入；退出 0 不等于视觉业务终态 |
| `npm run digest:api -- DATE` | 同义显式别名 |
| `./run-daily-digest.sh DATE --from STAGE` | 从安全阶段恢复 |
| `npm run digest:status -- --date DATE` | 只读最终状态快照 |
| `npm run digest:waive-visuals -- --date DATE --reason TEXT` | 用户明确不生图时签发 waiver |

`digest:manual` 只在用户明确要求人工流程时使用。

只有后续内置生图与 record 完成，或存在有效视觉 waiver，并且 `digest:status` 返回 0，整批业务才是 complete。

## 数据阶段

| 命令 | 行为 |
|---|---|
| `npm run fetch` | 归档、抓取、筛选、分析；不发布 |
| `npm run deep -- --date DATE` | 从 current sealed PDF/TXT source run 续分析；不能补抓或使用 legacy cache |
| `npm run batch` | 仅用 current sealed PDF/TXT 批量处理 canonical 中未完成论文 |
| `npm run reanalyze -- --concurrency N` | 强制全量重分析，仍只重放 current sealed PDF/TXT |
| `node scripts/analyze-single-paper.js ID --force` | 单篇分析 |
| `node scripts/reanalyze-selected.js ID...` | 指定集合重分析 |
| `node scripts/refilter-reanalyze-by-date.js DATE` | 历史日期重筛与重分析 |
| `npm run api:reader:refresh -- --all --date DATE --concurrency N --scoring-and-reader` | 批量刷新评分与 Reader；重放 sealed PDF/TXT，图像仅临时物化 |
| `npm run validate:data` | 只读 current 契约检查 |
| `npm run keyword:recall` | 关键词预筛金标准回放 |
| `npm run backfill` | 仅补录历史 paper ID |
| `npm run paper:rethink` | 历史独立维护工具；博客已取消集成，读者无需启动。旧接口保留于[历史说明](paper-rethink-companion.md)。 |

`full-fetch.js` 从 fetch 开始时只接受北京时间当天。后台运行可直接调用 `node scripts/full-fetch.js`，避免 npm/TTY 包装干扰。

以上四个恢复入口都要求 `deep-analysis-result.json.dailyFreshSourceRun` 可精确重放：canonical batchDate、论文集和每个 `source.txt`、`source.pdf`、runtime/manifest 必须闭合。缺失、损坏或漂移会在模型或图片请求前失败；运行 `npm run digest:prepare -- DATE` 重新建立 source phase，不能手补 checkpoint。

## 博客事务

| 命令 | 唯一职责 |
|---|---|
| `npm run blog:generate -- --date DATE` | 生成页面和 generation manifest |
| `npm run blog:review -- --date DATE` | 只读 review、Hugo gate、receipt |
| `npm run blog:push -- --date DATE` | 精确 commit/push 与远端 OID |
| `--include-id ID` | 单篇隔离范围，适用阶段必须保持同一 ID |
| `--exclude-id ID` | generate 阶段显式排除，可重复 |

generation manifest 会把实际选中的 current、日期 archive 或显式 `--data-file` 写成
`generation-input-source-reference-v1`：绝对路径、字节数和 SHA-256 同时进入 input fingerprint。review 和
push 只重放该文件及其 `dailyFreshSourceRun`，不会退回当时的 `DEEP_ANALYSIS_RESULT_FILE`；输入或 sealed
TXT/PDF 漂移时必须重新 generate。

不得把三个入口合并为一个模糊的“发布脚本”。`publish-to-blog.py` 是共享实现与生成兼容入口，不替代三阶段门禁。
三个入口都会先取得博客仓库 Git common-dir 下的私有共享锁，再取得本项目的日期事务锁；因此即使两个
`audio-paper-digest` 工作区指向同一个 `PAPER_DIGEST_BLOG_REPO`，也不能同时修改其 worktree、index 或 HEAD。
共享锁位于 Git 私有目录，不进入博客工作树或提交内容；失效回收和释放只删除 inode/token/SHA 仍精确匹配的锁文件。

## 会议论文（生产链已接通，历史发布仍建设中）

会议命令按 `discover → filter/filter:run → extract → reviewed staging → import → plan/execution → analyze → postprocess` 顺序运行，所有写入阶段都有显式 dry-run/apply 或 receipt/CAS 门禁。当前主分支已有真实 LLM 筛选、共用深度分析/Reader 和确定性单篇/会议汇总 postprocess。仍未完成的是旧会议 URL/task 页映射、conference aggregate 接入 historical publication，以及会议历史 review/push/remote-OID 闭环。因此 `conference:*` 仍不是可直接发布全历史的一键入口。准确参数、运行目录和人工工件格式见[会议论文工作流](conference-workflow.md)。

## 全历史重写（建设中）

`npm run history:inventory -- --dry-run` 只读扫描配置博客的历史页面、公开 URL、逐次聚合
入链、Git tracked tree、日期/cohort 与旧标签的未核验 URL 候选，并只保存正文 SHA，不保存
旧正文或 sidecar 路径。确认博客位于 clean `main` 后，使用：

```bash
npm run history:inventory -- --apply \
  --ledger all-history.json --receipt all-history.receipt.json
```

双文件会写入受保护的 `data/runtime/historical-page-inventories`。本地好数据不等待 crosswalk；当前
执行链为 `conference-local-sources → direct-inputs → conference-projections → direct-plan → direct-scheduler
→ direct-run → direct-aggregate`。arXiv route 来自冻结页已有的单一 arXiv hint，并在每次 generation 新拉、
封存官方 TXT/PDF/runtime/manifest；会议只重放绑定的本地 metadata/PDF SHA。crosswalk 仅处理 named fresh arXiv
acquisition handoff；本地会议输入缺失/损坏使 direct item 失败关闭。历史专属 review、activation、commit/push receipt
与 remote OID 仍未实现。

```bash
# 所有文件参数均为绝对路径；先用 --dry-run，确认后才改为 --apply
npm run history:conference-local-sources -- --apply [--output conference-local-sources-v1.json]
npm run history:direct-inputs -- --apply --conference-manifest /abs/conference-local-sources-v1.json \
  --inventory /abs/all-history.json --blog-root /abs/audio-paper-digest-blog [--name scoped-historical-local-data-v4.json]
npm run history:conference-projections -- --apply --catalog /abs/scoped-historical-local-data-v4.json \
  --inventory /abs/all-history.json [--output conference-page-projections-v2.json]
npm run history:direct-plan -- --apply --catalog /abs/scoped-historical-local-data-v4.json \
  --inventory /abs/all-history.json --conference-projections /abs/conference-page-projections-v2.json \
  [--output direct-rewrite-plan-v4.json]
npm run history:direct-scheduler -- --apply --plan /abs/direct-rewrite-plan-v4.json \
  [--queue all|arxiv|conference] [--generation N] [--paper-ids ID[,ID...]] [--max-papers N] \
  [--arxiv-concurrency 1-8] [--conference-concurrency 1-8]
npm run history:direct-run -- --apply --plan /abs/direct-rewrite-plan-v4.json \
  [--queue all|arxiv|conference] [--generation N] [--paper-ids ID[,ID...]] \
  [--max-papers N] [--concurrency 1-8]
npm run history:status -- --plan /abs/direct-rewrite-plan-v4.json [--generation N] [--watch-seconds N]
npm run history:pause -- --plan /abs/direct-rewrite-plan-v4.json --phase source|analysis [--generation N]
npm run history:resume -- --plan /abs/direct-rewrite-plan-v4.json --phase source|analysis [--generation N]
npm run history:direct-aggregate -- projection --apply --plan-file /abs/direct-rewrite-plan-v4.json \
  --inventory-file /abs/all-history.json --output-name direct-aggregate-projection-v2.json
npm run history:direct-aggregate -- aggregate --apply --plan-file /abs/direct-rewrite-plan-v4.json \
  --registry-file /abs/direct-rewrite-registry.json --projection-file /abs/direct-aggregate-projection-v2.json \
  (--daily YYYY-MM-DD|--conference conference-key)
```

aggregate projection v2 会把 inventory 中的会议 task 页作为独立 coverage report 保存并自哈希；在 task renderer
实现前，它们保持 `pending`、`unsupported`、`publicationReady=false`。task 页不参与 daily/conference 汇总成员或
排名，后续历史 publication 必须消费该阻断状态，不能把汇总 staging 完成解释为 task 页已重写。

长任务通过 `history:pause --phase source|analysis` 请求在活动来源/论文完成后安全暂停；看到相应 operation lock
已释放后才运行同 phase 的 `history:resume`。`history:status` 是只读快照，`--watch-seconds` 持续输出 NDJSON；最终 `completion.blockers`
会继续列出未覆盖论文页、失败/未 staged 论文、缺失汇总、会议 task 页和尚未接通的历史 publication。

`history:crosswalk` 只保留 legacy pending decision state 的只读/审计用途。`history:arxiv-batch` 必须明确传入
`--handoffs NAME.json[,NAME.json...]`，并且只接受 direct scheduler/run 写入的 named immutable fresh-arXiv failure
handoff；它不枚举 pending 页。`history:local-crawl-batch`（及 `archive-crawl-batch`）和
`history:conference-crawl-batch` 是 fail-closed retired compatibility endpoints，不能写 crosswalk。准确来源边界和
recovery 见[历史重写底座](history-rewrite.md)。

## 视觉状态机

| 命令 | 行为 |
|---|---|
| `npm run visual:post-publish -- --date DATE` | 从已验证 publication 规划两类任务 |
| `npm run visual:prepare -- --date DATE` | 校验参考缓存并输出绝对图片路径 |
| `npm run visual:status -- --date DATE` | TOP 10 长图只读状态 |
| `npm run visual:record -- --date DATE --paper ID --kind infographic --file /abs/result.png --token TOKEN --qa-attested true` | 登记已目检论文图；`--file` 可换成 `--output-hint HINT` |
| `npm run visual:fail -- ...` | 记录论文图失败 |
| `npm run cover:status -- --date DATE` | 汇总封面只读状态 |
| `npm run cover:record -- --date DATE --file /abs/cover.png --token TOKEN --qa-attested true` | 登记已目检封面；`--file` 可换成 `--output-hint HINT` |
| `npm run cover:fail -- ...` | 记录封面失败 |

实际成图只能使用 Codex 内置 `image_gen`；`visual:render:debug` 仅供本地调试/离线兜底。
`TOKEN` 来自对应 `visual:status` / `cover:status` 待办项打印的 `taskToken`，不得复用旧任务 token。

## 配置与公共实现

- `scripts/config.js`：Node 参数与 `data/current` 路径。
- `scripts/env-loader.js` / `scripts/project_env.py`：项目环境与沙箱守卫。
- `scripts/utils.js`：API 路由、代理、Prompt、原子写、时间和 ID。
- `scripts/llm-account-pool.js`：OpenCode Go 长期 sticky 账号池、明确额度错误分类与 Node/Python 共享状态。
- `scripts/analysis-engine.js`：论文锁、重试、checkpoint 与 canonical 合并。
- `scripts/deep-analyzer.js`：单篇多阶段分析和 Reader。
- `scripts/path_config.py`：Python 发布路径。
- `scripts/llm_account_pool.py`：Python 发布链的同 schema 账号选择和配额切换。
- `scripts/publish_common.py`：发布数据、评分、LLM 与 provenance 公共层。
- `scripts/publish-to-blog.py`：博客 generation/review/push 共享事务实现。
- `scripts/python-runtime.sh`：默认博客/视觉入口的 Python 3.11+、OpenSSL 与项目 `.venv` 选择门禁。

## 运行存储

| 命令 | 行为 |
|---|---|
| `npm run storage:status` | 只读统计 `data/current`、`data/archive`、`logs` 和重点缓存的大小/文件数 |
| `npm run storage:prune` | 扫描权威 JSON 引用并输出 dry-run 删除清单，不删文件 |
| `npm run storage:prune -- --apply` | 预检无 JSON 损坏、symlink、路径逃逸或漂移后，仅删除白名单根内超期且未引用文件 |

实现为 `scripts/runtime-storage.js`。它不删 canonical JSON、发布/视觉 manifest、博客或归档成品；完整安全边界见 [维护指南](maintenance.md#运行存储诊断与清理)。

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
