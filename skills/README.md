# skills 目录

`skills/` 保存三份可复用的工作方法。仓库里的版本是权威来源；本机 `~/.codex/skills/` 下的同名目录是安装副本，供执行时读取。

## 三份 skill 的适用范围

| skill | 用于 | 不用于 |
|---|---|---|
| [clear-technical-writing](clear-technical-writing/SKILL.md) | 撰写、改写和审阅中文技术说明、研究解读、操作文档、提示词与工作汇报 | 判断作者身份、追求检测器分数、代替来源与事实核验 |
| [stateful-workflow-maintenance](stateful-workflow-maintenance/SKILL.md) | 维护、迁移带保存点、历史凭证、失败恢复或对外发布的流程 | 一次性无状态脚本、代替项目权限与费用规则、改写历史记录 |
| [phone-first-demo-production](phone-first-demo-production/SKILL.md) | 制作、改版和验收手机端演示短片、封面与发帖文案 | 自动发布、账号登录、版权素材的授权判断 |

每份 skill 的正文都写明“何时使用与不适用”和“交付前检查清单”，以对应的 `SKILL.md` 为准。

## 修改后怎样同步

1. 先改仓库里的 `skills/<name>/`，按任务实际要求验证。只改内容时，至少核对命令、链接和术语没有漂移。
2. 同步安装副本：

   ```bash
   rsync -a --delete skills/<name>/ ~/.codex/skills/<name>/
   ```

   没有 `rsync` 时，用 `cp -R skills/<name>/. ~/.codex/skills/<name>/` 覆盖。
3. 核对两边一致：

   ```bash
   diff -r skills/<name> ~/.codex/skills/<name>
   ```

   输出为空才算同步完成。安装副本不会因为仓库提交自动更新。
4. 如果在安装副本上直接改过，先把改动放回仓库并完成提交，再按上面的步骤同步回去；不要只保留本机改动。

三份 skill 的安装位置都在 `~/.codex/skills/<name>/`。仓库与安装副本不一致时，以仓库版本为准。

## 项目规则写在哪里

论文速递的术语、来源、权限、发布和版本规则属于本项目，写在 `docs/`、`AGENTS.md` 和两端应用文档里，不写进 skill：

- 写作约定与项目术语：`docs/writing-guide.md`
- 执行约束与权威来源：`AGENTS.md`
- 客户端版本与发行：两端 README、`docs/README.md` 与当期 `docs/workbench-*-review.md`

skill 只保留可迁移的方法和通用检查。两边冲突时，按项目文档和实际实现执行；也不要把项目专属规则复制回 skill 当作通用要求。
