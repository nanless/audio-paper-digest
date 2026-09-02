# 契约与兼容矩阵

本页区分“仍可读取”“可维护”和“允许进入默认 production”。旧产物可读不代表能够重新包装成新日更。

| 产物 | 当前 writer | 历史读取 | 默认 production |
|---|---|---|---|
| filter decision | decision contract v3 | 只在输入、模型和 Prompt 指纹匹配时复用 | 必须完整覆盖 raw candidates |
| analysis manifest | manifest v1 + 当前阶段契约 | 旧阶段可用于显式恢复或迁移 | 必须满足 API 或 Manual 对应终态集合 |
| API Reader | Reader v3 + source v4 + author/resource identity v1 | v1/v2 和缺任一当前来源合同的 v3 只读 | 只接受 article/plan/Figure/作者机构/资源状态及其来源 SHA 闭环 |
| scoring audit | `api-scoring-audit-v2` | 旧评分可显示 | 必须重算八维总分并绑定最终 analysis |
| generation manifest | schema v3 | v1/v2 仅显式历史维护 | 新日更只接受 v3、`publishedPapers` 和同质 proof |
| review receipt | 当前 review protocol | 精确页面 SHA 未变时可复用逐页 pass | 必须重绑 generation、Git baseline 和 Hugo gate |
| visual summary | v3 TOP 10 | v1/v2 由显式迁移命令处理 | 必须绑定 publication commit/OID 与当前 token |
| Manual canonical | production v6 | v5/shadow/sealed preview 只作历史维护 | 默认 API 不读取为自动分析证明 |

## 迁移原则

1. production writer 只写当前版本，不回写旧 schema。
2. 兼容读取器不得静默赋予旧产物新的 production 资格。
3. 迁移必须重开来源文件并验证 realpath、bytes 和 SHA。
4. 版本、Prompt、预算或算法变化进入对应阶段指纹，只失效必要下游。
5. 无法证明来源或集合完整性时 fail closed，不以“页面看起来正常”代替契约。
