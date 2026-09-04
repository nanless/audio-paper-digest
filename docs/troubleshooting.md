# 故障排查

## 使用方法

先找到最早失败的门禁，不要从最后一个报错猜原因。所有诊断命令必须沙箱外运行；沙箱访问不到本地代理不代表目标站点故障。

## 1. 启动即报缺少配置

检查项目根 `.env`，不是 shell：

```bash
ls -l .env
node scripts/test-api-key.js
```

必需三元组为 `PAPER_ANALYZER_API_KEY/MODEL/ENDPOINT`。endpoint 必须 HTTPS。loader 会清理继承变量，因此 `.zshrc` 里的值不会补齐项目配置。

## 2. Muse 请求失败、超时或空响应

确认：

- model 精确为 `muse-spark-1.2-contributor`；
- `HTTPS_PROXY` 或 `HTTP_PROXY` 是 `http(s)://` CONNECT 地址；
- 命令在沙箱外；
- 代理出口和地区符合账户要求；
- `PD_OPENAI_RESPONSES_STREAM=1` 是否与代理兼容。

Muse 必须走 one-shot CONNECT agent。不要改成直连。若返回 `incomplete/max_output_tokens`，这是截断，不是成功；调整证据/输出预算或修复 Prompt 后重试，不能接受半截 JSON。

配置备用账号后，可检查 `data/runtime/llm-account-pool.json` 的 `activeAccountId`、`limitClass` 和 `blockedUntil`；文件不含原始 key。不要为“切回主账号”删除或手改状态：长期 sticky 策略只在当前账号自己收到明确 `GoUsageLimitError` 后重新选择。状态损坏、非法 generation 或状态路径异常会在网络请求前失败关闭。普通 429 不切号，仍按原有短期限流退避。

## 3. MiMo/Kimi 403

普通 MiMo/Kimi 预期 `agent:false` 直连。若 curl 直连正常而脚本 403，检查是否有调用方绕过 `requestLlmJson()` 或自行注入 agent。不要把 Muse 的强制代理策略套到其他模型。

## 4. arXiv/HuggingFace 抓取失败

检查项目代理和来源 checkpoint：

- arXiv Node 请求只接受 HTTP CONNECT。
- HuggingFace curl 可额外使用 `ALL_PROXY=socks5h://...`。
- 429 会按配置退避；不要删除 checkpoint 后高并发重打。
- 某来源候选数/SHA 不一致时，只重抓该来源。

HuggingFace 空结果不能在代理缺失时伪装成功。HTML 只有 metadata shell 时应继续 PDF fallback。

## 5. filtered 不完整

运行：

```bash
npm run validate:data
```

常见原因：raw 与 decision 输入 SHA 不同、决定未覆盖全部候选、API 错误项仍 pending、filtered 包含非 related 项、模型/Prompt/关键词版本变化后只更新了一部分文件。不要手工删掉未知决定；恢复筛选让缓存补齐。

## 6. 分析慢或反复失败

先看失败处于哪个 stage，而不是整篇重跑：

- `PD_ANALYSIS_CONCURRENCY` 默认 3；
- Reader 重阶段默认 5；
- Muse 筛选 batch 服从 `PD_FILTER_BATCH_SIZE`；
- 主分析、局部修复和 Reader 使用不同 token/context 预算。

```bash
npm run deep -- --date YYYY-MM-DD
npm run api:reader:refresh -- --all --date YYYY-MM-DD --concurrency 5 --scoring-and-reader
```

来源 SHA、Prompt 或模型变化会按指纹失效对应阶段。旧成功正文存在但最新尝试失败时仍需重试。

## 7. Reader 文章机械、表格或图片脱节

检查 `apiReaderPlan` 与正文：

- 术语桥是否同时解释两个术语的分工、搭配原因和组合意义；
- 表前是否提出比较问题，表后是否解释净收益、失败项和边界；
- Figure 是否有导读、可执行看图路径、原图、图注和解释；
- 未传像素时是否猜了颜色、坐标轴或模块；
- 段落中的“它/该方法/这一结果”是否唯一回指。

修复 Prompt 或结构化 findings 后刷新 Reader，不在博客 review 阶段原地改正文。

## 8. blog:generate 失败

优先检查 production proof、批次日期、评分八维、Reader v3、作者机构、图片 URL 安全和目标博客工作区。generate 会拒绝覆盖目标日期已有的人工 Git 修改。

单篇/排除参数未命中也会失败，这是范围保护，不应忽略。

## 9. blog:review 失败

review 是只读门禁。内容问题回到生成/分析修复；瞬时 API 失败只重试失败页。页面 SHA、generation、协议或 Git baseline 变化会使 receipt 失效。

Hugo 内存异常时先确认没有并行遗留 Hugo 进程、目标仓库和主题是否正确，再单独运行受控 Hugo gate；不要通过跳过 Hugo 签发 receipt。

## 10. blog:push 失败

检查：

- receipt 是否绑定当前 generation；
- 博客 HEAD 是否仍等于 review baseline；
- staged/unstaged/untracked delta 是否精确；
- remote 名称和 push URL 身份是否变化；
- 实时远端 `main` 是否仍匹配可重试提交。

push 不生成、不审查，也不能借已有本地 commit 绕过 receipt。

## 11. 视觉 pending 或 record 失败

先确认远端 publication OID，再运行：

```bash
npm run visual:prepare -- --date YYYY-MM-DD
npm run visual:status -- --date YYYY-MM-DD
npm run cover:status -- --date YYYY-MM-DD
```

只使用 prepare 输出的绝对参考路径。record 需要当前任务 token、canonical 文件和 `--qa-attested true`。manifest、publication 或资产 SHA 变化会使完成态失效。

## 12. 状态报告与现实不一致

`digest:status` 是读取时快照。push、record 或 waiver 后必须重新运行。当前日期不会用 archive 掩盖 current 故障；历史日期也只有跨文件契约闭合时才回退 archive。

## 仍无法定位

记录：命令、目标日期、最早错误、对应 stage、相关 manifest 路径和脱敏日志片段。不要附带 API key、认证头、Cookie 或完整 `.env`。
