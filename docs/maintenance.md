# 维护指南

## 受众与原则

给修改默认 API、共享发布、Prompt、数据契约或文档的维护者。先确认变更属于哪个层，只改一处权威实现，再同步消费者、测试与文档。Manual 专属维护见 [manual/README.md](../manual/README.md)。

## 变更路由

| 变更 | 首要文件 | 必查消费者 |
|---|---|---|
| Node 参数/路径 | `scripts/config.js` | 入口脚本、测试、env.example |
| Python 发布路径 | `scripts/path_config.py` | generate/review/push、测试 |
| API 协议/代理 | `scripts/utils.js`、`publish_common.py` | 筛选、分析、review、API key 测试 |
| 分析恢复 | `analysis-engine.js`、`deep-analyzer.js` | 所有分析入口、digest 状态 |
| 分析结构/评分 | `analysis-contract.js`、Prompt | Node/Python parser、publisher |
| Reader 文风/图表 | `api-reader-article.md`、`editorial-quality.js` | Reader validator、博客 review |
| 博客事务 | `publish-to-blog.py` | 三个独立入口、receipt 测试 |
| 视觉状态 | 两个 state JS 与 integration | planner、status、record |
| 命令别名 | `package.json` | README、AGENTS、SKILL、docs |

## 不可破坏的边界

- 默认日更始终 LLM/API；API 错误不切 Manual。
- 项目环境只来自根 `.env`，凭据不进入外部子进程。
- Muse 与 arXiv 必须代理；其他 LLM 默认 `agent:false`。
- 同篇分析与共享 JSON 更新必须持锁并锁内重读。
- checkpoint 指纹变化只失效必要阶段，不能无条件清空全部成功项。
- generate、review、push 分离；review 只读最终字节。
- production proof、页面 SHA、Git baseline、remote OID 和视觉任务逐层绑定。
- 项目脚本不调用图像 API。

## Prompt 修改

`loadPrompt()` 读取 Markdown 第一个 fenced block。修改前确认：

1. 占位符与调用方一致；
2. JSON/章节结构与 parser 一致；
3. 示例不会被误认成外层 fence；
4. Prompt SHA 进入正确阶段指纹；
5. retry feedback 能精确修正而非整篇漂移；
6. 读者正文没有模板句、证据 ID 或流程元话语。

评分 Prompt 变更还需验证八维顺序、范围、开源固定锚点、证据 ID 和 deterministic caps。Reader Prompt 变更要抽检术语桥、表格前后叙事、图前/图后邻接、未传像素的描述边界。

## 数据契约修改

新增字段时区分：

- 权威事实：必须进入输入/来源 SHA；
- 派生缓存：必须可从权威字节重建；
- 恢复状态：必须带版本和阶段指纹；
- 发布凭证：必须绑定精确文件/外部状态；
- 可选诊断：不得改变业务完成结果。

结构变化同步 Node validator、Python publisher、fixtures、迁移/历史兼容和 `validate:data`。

## 并发与原子性

普通 JSON 用原子写。读改写对象必须使用公共文件锁，锁内重新读取最新 canonical，合并本次论文或字段并递增 generation。不要在锁外携带整份旧数组覆盖新结果。长任务使用 heartbeat/租约；只有超龄 owner 可回收。

## 安全与日志

- 真实 URL 只允许 HTTPS，loopback 测试除外。
- 外部重定向逐跳 DNS/IP 校验。
- 日志每个非空物理行使用毫秒级北京时间戳。
- 日志和 `.env` 权限 `0600`。
- 脱敏认证头、Cookie、token、secret、password、配置密钥实际值和 URL userinfo。
- `data/`、`logs/`、`.env`、备份、缓存均不提交。

## 运行存储诊断与清理

`npm run storage:status` 只读统计 `data/current`、`data/archive`、`logs` 及图片/Reader/视觉参考缓存的文件数和字节数。`npm run storage:prune` 默认仅输出 dry-run 删除清单；人工核对后才可运行：

```bash
npm run storage:prune -- --apply
```

清理器只能删除白名单根内超过 30 天的旧文件：`logs`、`image-cache`、`api-reader-assets`、`visual-reference-inputs` 和三个已无代码消费者的 legacy `*_input_output` 调试目录。三类缓存删除前会扫描 `data/current` / `data/archive` 的权威 JSON，重放绝对/相对路径和 URL SHA-256 引用。JSON 损坏、symlink、路径逃逸或计划后文件变化都会在 apply 前整批阻断。canonical JSON、发布/视觉 manifest、归档成品和博客文件不在删除白名单内。

`--apply` 只能在全部抓取、筛选、分析、博客生成/review/push 与视觉规划任务停止后运行。清理器会读取常见 full-fetch、逐论文分析和博客事务锁；本机 owner PID 仍存活、远端/非法 owner 无法可靠判活时均 fail closed，且绝不替调用方删除锁。锁检测与 unlink 之间仍不存在跨所有 writer 的统一事务，因此“无活动任务”是操作前提，而不是可省略的建议。

`--apply` 是停机维护命令：只能在抓取、分析、博客三阶段和视觉任务全部停止后运行。引用扫描无法替代所有 writer 共享的事务锁；若与新权威引用并发写入，仍存在扫描后竞态。正在运行的任务期间只允许 `storage:status` 或 dry-run。

## 验证矩阵

```bash
npm test
npm run test:default
npm run test:manual
npm run validate:data -- --allow-empty
git diff --check
```

CI 还执行 JS `node -c`、Python `py_compile`、两处 Python 单测和全仓 shell `bash -n`。涉及 Prompt/发布时增加一篇受控产物级测试；涉及代理时分别验证 Muse 和普通直连模型。

## 提交前清单

- [ ] 命令与 `package.json` 一致
- [ ] 中英文文档术语和默认值一致
- [ ] 无旧路径、悬空链接或不存在脚本
- [ ] 未混入 Manual 内部规则
- [ ] 未提交运行数据、日志或凭据
- [ ] dirty worktree 中用户无关改动被保留
- [ ] 中文提交信息说明原因、范围和兼容影响
