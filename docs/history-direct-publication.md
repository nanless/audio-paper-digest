# 全历史 direct publication 闭环

此入口只消费 `historical-direct-rewrite-plan-v5`、对应 execution registry、当前
`historical-direct-aggregate-projection-v3`、全部 direct page staging 和
`historical-direct-aggregate-v2`。它不读取日更 canonical，不签发日更 schema-v3 receipt，
也不把旧 `history:publication` 私有 bundle 当成 direct-local 证明。

## 状态机

```text
visual disposition
  → immutable publication plan
  → immutable private generation
  → deterministic historical review + Hugo gate
  → publish --apply 持有博客 Git common-dir 共享锁
       ├─ activation CAS / crash recovery
       ├─ exact staged delta / single-parent commit
       ├─ push
       └─ live remote identity + main OID receipt
  → status（默认再次 live 验证 remote）
```

projection 必须证明全部 inventory 页面闭合。论文页、107 个日汇总、3 个会议汇总和
193 个会议 task 页属于 rewrite；projection 中的 `retainedPages` 必须逐字保持 Git baseline。
任一缺页、非 staged 论文、aggregate 缺失、producer SHA 漂移或博客 baseline 前进都会失败关闭。
publication authority 还会从实际 `content/posts` producer 数量重算
`rewritten + retain-unchanged = inventoryPageCount`，并把完整 `pageCoverage` 写入 authority proof；publication
plan 会重新验证该关系、精确 delta 的派生结果及 retained/generated 路径不重叠，不能只信一个布尔完成位。

## 命令

先签发显式视觉范围。`excluded` 表示视觉根本不属于这次全历史正文发布事务；`waived`
只能用于用户明确豁免。二者都不会伪造成图片 `complete`，最终 status 会显示
`published-with-visual-excluded|waived`。

```bash
npm run history:direct-publication -- visual-disposition --apply \
  --plan-file /absolute/direct-plan.json \
  --mode excluded \
  --reason '全历史正文发布与逐日视觉生成是不同事务，本次明确排除视觉。' \
  --output /absolute/project/data/runtime/historical-direct-visual-dispositions/full-history.json

npm run history:direct-publication -- plan --apply \
  --publication-id UUID \
  --plan-file /absolute/direct-plan.json \
  --registry-file /absolute/direct-registry.json \
  --projection-file /absolute/direct-aggregate-projection-v3.json \
  --visual-disposition /absolute/full-history.json

npm run history:direct-publication -- generate --apply \
  --publication-id UUID \
  --plan-file /absolute/direct-plan.json \
  --registry-file /absolute/direct-registry.json \
  --projection-file /absolute/direct-aggregate-projection-v3.json \
  --visual-disposition /absolute/full-history.json

npm run history:direct-publication -- review --apply --publication-id UUID
npm run history:direct-publication -- publish --apply --publication-id UUID
npm run history:direct-publication -- status --publication-id UUID
```

`activate --apply` 被 CLI 禁用。真正写博客只能通过 `publish --apply`，使 activation、commit、
push 和远端验证处于与日更相同的 Git common-dir 共享锁内。activation intent 允许每条路径处于
baseline 或目标 SHA 后继续，第三种字节立即阻断；commit 已完成而 push 失败时会复用已签 commit
receipt。Git add 分批执行，避免全历史路径集合超过系统 `ARG_MAX`。

`status --live-remote false` 仅供离线诊断并永远返回 incomplete。默认 status 查询 live remote；
只有 receipt、remote identity 和 `refs/heads/main` OID 全部闭合，publication 才可成为终态。

历史 review 使用独立的 `historical-semantic-multimodal-v1` receipt：确定性预检覆盖逐文件 SHA、
front matter、taxonomy contract、链接协议和特殊非 camera-ready 披露；随后真实 Hugo gate，并由独立
Python coordinator 复用发布公共 LLM 路由执行逐页、逐文本分块和存在图片时的多模态审查。并发由
`PD_HISTORY_REVIEW_CONCURRENCY` 控制，范围 1–5。每个通过的分块和页面保存可恢复 checkpoint；失败
attempt 保留审计但不会冒充可复用成功。模型、endpoint SHA、Prompt/实现 SHA、预算、并发和协议 SHA
全部进入 review fingerprint。它仍是历史专属协议，不复用或冒充日更 schema-v3 receipt。
