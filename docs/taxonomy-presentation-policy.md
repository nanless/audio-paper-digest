# 显式保留博客展示词表

发布器默认继续使用当前源仓库的签发词表。博客已批准更丰富的追加词表时，可在博客仓库中提供 `data/taxonomy-presentation-policy.json` 与 `static/data/taxonomy-presentation-policy.json` 两份逐字节相同的策略。策略只选择目录展示版本，不改变日更单篇的标签、主任务、主方法或签发 registry SHA。

策略 contract 为 `paper-taxonomy-presentation-selection-v1`，且只允许以下六个字段：

| 字段 | 绑定内容 |
| --- | --- |
| `contract` | 上述固定协议 |
| `baseRegistrySha256` | 实际日更签发的原始 registry 文件 SHA，不是快照文件 SHA |
| `baseSnapshotSha256` | 发布器由日更 registry 生成的 canonical 快照字节 SHA |
| `preferredRegistrySha256` | 已批准的展示 registry 原始文件 SHA |
| `preferredSnapshotSha256` | 已冻结的展示快照 canonical 字节 SHA |
| `preferredProjectionSha256` | `historical-taxonomy-prompt-projection-v2` 的实际提示投影 SHA |

首选版本必须已存在于 data/static 两份 catalog 和 SHA 命名归档，归档字节必须精确相同。每个原概念的全部字段、名称、父链与概念顺序必须作为首选快照的完整前缀保留。显式策略由既有来源与审批证明绑定；单凭概念数量、日期或名称不能自动批准版本。投影重建与已批准 hash 不符时失败关闭。

策略 JSON 保留原字节，包括排版与尾换行；重复键、额外字段、单镜像缺失、镜像排版不同、符号链接、硬链接、未知源 registry、缺少归档以及任何 SHA/父链漂移都拒绝。存在策略时不会静默降回日更词表；没有策略时保持原有逻辑。

策略两份原字节作为受控 taxonomy 资产进入现有 generation staging、安装 journal、schema-v3 manifest、review 与精确 push delta。协议不增加新的 manifest 字段。生成后或审后即使只改一个空格，也必须重新正常 generate → review，不能补改 receipt。中断安装只能恢复原 journal 绑定的完整 staging 字节；目标已发生外部改动时拒绝覆盖。单篇发布仍不得升级全站版本资产。

此策略不代表旧文章已完成来源分类，也不重签已有历史记录。部署 richer catalog/消费者后才可批准并提交相应策略；新增词表不能靠发布器自行制造或仅靠策略文件自我声明。
