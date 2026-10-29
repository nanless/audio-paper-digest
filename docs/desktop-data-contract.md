# Mac 客户端静态数据合同

本文定义后续可选的 `desktop/v1` 静态数据接口。专用出口和导出器尚未启用；当前论文速递工作台通过已有搜索目录和已发布页面同步内容，见[网站数据适配](mac-app-data.md)及[Android 说明](../apps/android/README.md)。下文是新接口的字段与失败处理设计，当前搜索索引仍使用自己的既有协议。

产品范围与界面见[桌面研究工作台规划](desktop-research-workbench-plan.md)。本合同不修改日更、会议、历史的来源资格、审查、费用或发布凭证。

## 1. 数据从哪里来

推荐在博客构建阶段，从同一待部署提交中的已发布文章、front matter、引用 sidecar 和资源生成静态数据包。Mac 通过 HTTPS 同步；个人笔记、解析、阅读位置、模型密钥和 Zotero 映射留在本机。

生产项目负责生成与审查，博客构建负责公开数据投影，客户端负责阅读和个人研究。客户端不直接读取 `data/current/`、私有 runtime、生产账号池或费用账本，也不需要安装 Hugo、克隆两个仓库或重新运行论文 LLM。

现有实现可复用：

| 来源 | 已有内容 | 边界 |
|---|---|---|
| 博客 `layouts/_default/index.json` | 标题、短摘要、页面类型、分类、分数、身份与 citation 投影 | `summary` 不是完整 Reader；`date` 是页面日期 |
| 博客 `scripts/shard-search-index.js` | 带字节数、SHA、条数的内容寻址分片 | 现合同为 `paper-search-index-manifest-v1`，不直接改名成桌面协议 |
| 博客 `assets/js/search-index-loader.js` | 同源目录、UTF-8、字节、SHA、数量检查与旧格式兼容 | Mac 使用自己的下载、事务与缓存实现 |
| 博客 `content/posts/` | 已发布图文正文、评分解释、来源版本与标签元数据 | 不把未提交工作区、草稿、待审或失败稿当已发布内容 |
| 博客 `static/data/papers/` | `citation.json`、BibTeX、RIS、`rethink-context.json` | 后者是摘要和研究上下文，不包含完整长文 |
| 本项目 `scripts/publish-to-blog.py` | arXiv 与会议共用的四文件序列化及 SHA 记录 | 旧 `researcher-sidecars-v1` 和 URL 保持兼容 |

首次导出可以重新排版、序列化和校验已有成果，模型请求数必须为 0。历史缺失的作者、日期、来源版本或资产逐项留缺，不能借导出协议升级重写论文、补签旧资格或猜测事实。

## 2. 已发布提交与部署边界

导出器只接收干净的指定提交或构建系统检出的提交树，按正常发布集合排除 draft、未来未发布页、内部准备稿和审查未通过对象。博客正文中的参考文献不能被当作当前论文身份。

`sourceCommit` 表示生成这份数据的博客 Git OID，不单独证明该提交已部署。构建应在数据包、网站和校验全部完成后一次部署；部署与网页核验仍按原发布流程执行。不得从旁边的未提交文件夹补资源，或把生产项目中“分析成功但尚未发布”的结果自动加进目录。

需要补充生产数据时，只在构建期从已经核验且与该页面绑定的记录中选取明确字段，输出公开研究对象。不能原样发布模型响应、失败稿、私有路径、认证信息、用量账或原始检查点。

## 3. 文件布局与完整性

路径相对站点部署前缀；当前前缀为 `/audio-paper-digest-blog/`，不能拼接为域名根目录。

```text
desktop/v1/manifest.json
desktop/v1/snapshots/<sha256>.json
desktop/v1/catalog/<sha256>.json
desktop/v1/papers/<sha256>.json
desktop/v1/articles/<sha256>.html
desktop/v1/assets/<sha256>.<ext>
```

`manifest.json` 是可变入口，其他由内容 SHA 寻址的对象不可原地改写。JSON 使用 UTF-8；SHA-256 按实际下载文件的原始字节计算，不能对解析后重新序列化的对象计算，也不能用 URL 的哈希冒充资源 SHA。

### 3.1 Manifest 与快照

| 字段 | 类型与含义 |
|---|---|
| `contract` | 固定 `paper-desktop-manifest-v1` |
| `schemaVersion` | 整数 `1` |
| `snapshotId` | 快照 JSON 原始字节 SHA-256，64 位小写十六进制 |
| `snapshot` | 文件描述符，指向对应 `snapshots/<snapshotId>.json` |
| `generatedAt` | 真实构建时间，带时区的 ISO 时间 |
| `sourceCommit` | 真实博客 Git OID |
| `basePath` | 站点部署前缀，首尾有 `/` |

快照 JSON 固定合同 `paper-desktop-snapshot-v1`，包含 `schemaVersion`、`sourceCommit`、`catalogShards`、`recordCount`、`paperCount`、`appearanceCount`、`tombstoneShards`、`tombstoneCount`、`tagCatalogs`。无删除记录时使用空数组和 0，不省略成未知。快照不包含自己的 SHA，避免循环计算。

文件描述符固定为 `url`、`bytes`、`sha256`；含记录数组的文件另外有 `recordCount`。URL 必须是协议限定的相对站内路径，不含凭据、查询串、片段或 `..`。所有计数是非负安全整数；实际 UTF-8 JSON、记录数、总数和文件字节必须一致。

v1 初始调度上限：目录单分片 1 MiB、最多 128 个、目录总量 64 MiB，沿用现有搜索协议的量级；完整正文不放进目录。实现还须分别设置详情、正文和资产的文件大小及总下载预算，超限保留旧版本并报告原因，不能自动放宽。协议不识别的合同版本拒绝切换；已知版本的新增可选字段可以忽略，不能忽略完整性所需字段或改变必需字段的含义。

SHA 证明字节一致，不证明科学正确，也不能替代 HTTPS 或原发布资格。

### 3.2 轻量目录

目录分片是记录数组，每条按 `appearanceId` 唯一，包含 `paperId`、`identityStatus`、`sourceKind`、`sourceVersionId`、`pageType`、`publicationStatus`、`title`、`titleZh`、`summary`、`blogPublishedAt`、`articleUpdatedAt`、`pageUrl`、`score`、`tagConceptIds`、`articleRevisionId`、`detail` 文件描述符。`publicationStatus` 至少区分 `active` 与有证据的 `retracted`，撤稿提示不要求抹去仍可阅读的导读。

`paperId`、`sourceVersionId` 在未核验时可以为 null，且 `identityStatus` 必须解释该状态；不能用伪造 ID 满足非空要求。单页多论文的汇总应以页面记录和成员关系表示，不能把汇总标题创建为一篇论文。目录的页面记录数与去重论文数分别计数。

App 首次只同步完整轻目录和必要词表，详情、正文、图片与 PDF 按需读取；不能首次启动就下载全站原文。

## 4. 身份、版本和出现记录

| 实体 | 关键字段与含义 |
|---|---|
| `Paper` | `paperId`、`identityStatus`、`sourceKind`、已核验来源标识和官方链接 |
| `SourceVersion` | `sourceVersionId`、`paperId`、明确来源版本、PDF URL、可用的原字节证明、版本披露 |
| `ArticleRevision` | `articleRevisionId`、`appearanceId`、`sourceVersionId`、正文描述符、评分、标签版本与资源列表 |
| `Appearance` | `appearanceId`、页面 URL、页面类型、日更日期或会议/汇总成员关系、当前导读修订 |

arXiv 基础论文身份和 `v1/v2` 来源版本分开；会议继续保留如 `conference:interspeech:2026:conference-paper-id:a26_interspeech` 的实际规范身份。身份未核验时只保留站内页面身份，不按译题、标题相似度或正文出现的 DOI 自动合并。预印本和正式论文只有可核验关系时建立关联。

`appearanceId` 应由生产者给出稳定页面身份或规范页面路径，不能使用标题；更改 URL 时提供已证明的重定向关系。多个日更或会议页面引用同一论文只增加 Appearance，私人笔记仍关联同一 Paper 或具体版本。

`articleRevisionId` 是导读内容、来源版本、评分、标签和资源引用组成的确定性修订身份。正文更新不覆盖旧修订；旧模型回答、笔记和定位仍绑定原 `sourceVersionId` 与实际 PDF SHA。

特殊替代 PDF、非 camera-ready、历史来源不完整等原提示进入 `sourceVersionWarning` 或 `provenanceDisclosure`；不能在导出过程中去掉限制、改成正式版本或重新授予来源资格。

## 5. 论文详情、引用完整性与评分

详情 JSON 固定合同 `paper-desktop-detail-v1`，包含论文身份、来源版本、出现记录、当前导读修订、引用资料、作者、原摘要及可用出处。详情可以按修订分文件，目录通过文件描述符引用，避免下载时混入后来版本。

| 字段组 | 必须保留的含义 |
|---|---|
| 标题 | `originalTitle` 与 `readerTitle` 分开；中文译题不冒充原题 |
| 作者 | 保留原顺序、原始姓名和有证据的机构；未知姓/名拆分、ORCID 为 null |
| 日期 | `paperPublishedAt`、`blogPublishedAt`、`articleUpdatedAt` 分开；App 自记 `syncedAt` |
| 书目 | DOI、arXiv、venue、卷期页码、语言、许可等只填真实已有字段 |
| 摘要 | `abstract` 为原摘要；`oneSentenceThesis` 等网站总结单独保存 |
| 分类 | 概念 ID、原词表身份、当前显示词表和 withheld/缺失状态 |
| 评分 | 网站原总分、原量表版本、分项和解释，不调用客户端模型重评或猜测换算 |

`citation` 保留现有 `paper-citation-source-v1` 投影或明确版本适配结果。`verified` 只说明当前论文身份已核验，`complete` 按身份、原题、来源链接、作者、论文日期等原标准计算。另给 `missingFields` 和逐字段来源/可用状态，不能只用一个布尔隐藏缺口。DOI 缺失不自动推导身份无效，也不能因为有作者就宣称所有标准书目字段齐全。

现有 Citation JSON、BibTeX、RIS 四文件中的三种引用导出保持兼容并提供原 SHA。完整性不同的旧记录可导入，缺项如实展示；不生成伪造作者、日期或 DOI。

Zotero 将原题、作者、日期和 DOI 等写入标准字段；网站评分与图文导读、个人解析与笔记分别保存。原摘要不被 AI 概括覆盖。归档的字段、附件和笔记逐项回读，元数据成功而 PDF 失败属于部分完成。

## 6. 正文和资源

构建器直接从已发布正文生成可安全渲染的 HTML 片段，保留章节、原表、原公式、图注、资源出处和原站链接。片段不携带站点导航、菜单或客户端桥接脚本。科学内容不得因换皮改写；正文清理与渲染版本写入修订信息。

HTML 禁止脚本、事件属性、嵌入框架、表单、任意文件访问和危险 URL。正文只能显示内容，不能获取模型密钥、调用本地文件或触发模型与 Zotero 操作。渲染层的用户动作经明确、受限的客户端接口处理。

资源记录含 `resourceId`、`kind`、`mediaType`、`sourceUrl`、`availability`、`requiredForOffline`；本站已经保存的字节另有文件描述符，外链尚未获取时描述符为 null。`availability` 区分 `bundled`、`external`、`missing`，不能把缺失长度或 SHA 补成 0 或随机值。数学字体和渲染依赖同样纳入离线清单。

PDF 默认保留导读绑定的精确官方版本 URL，打开或离线时按需下载，不要求把所有历史 PDF 重新分发到站点。下载检查协议、重定向、地址、媒体类型与大小；arXiv 接入沿用项目代理要求，App 提供自己的网络配置。

客户端记录的下载 SHA 只证明本次实际字节。只有与发布者原封存 PDF SHA 匹配时才声称为同一文件；只有版本化 URL 一致时不能声称逐字节相同。指定版本不可得时保留导读并提示，不静默改读最新版。

页内证据包含实际 PDF SHA、物理页序、可用印刷页码标签及真实匹配的文本/坐标；找不到对应范围时降级为页级或未定位，不能伪造高亮。

## 7. 增量、撤稿和删除

v1 使用完整轻目录快照和内容寻址对象，不要求先实现差量补丁。客户端按 SHA 复用已有对象，只下载变化项；详情、正文或资源被需要时才取。这样已经具备增量下载能力。

目录中消失的记录只有在新快照全部校验完成后才能被判定为站点移除，下载失败或部分分片缺失不能解释为删除。生产者为实际移除提供 tombstone，字段为 `appearanceId`、适用的 `paperId`、`previousArticleRevisionId`、`reason`、`effectiveAt`、`sourceCommit` 和可选 `replacementAppearanceId`。

`reason` 区分 `site-removed`、`retracted`、`replaced`。站点删除不等于论文撤稿；正式撤稿必须另有 `evidenceUrl` 和真实来源提示，不能按 HTTP 404 推断。撤稿但页面仍保留时更新目录的 `publicationStatus`，只有退出当前可用页面集合时才生成 tombstone。修订更正属于新 ArticleRevision，不删除旧证据。移除汇总中的一次出现不删除其他页面的同一论文。

每份快照的 tombstone 集合只描述当前已经移除的 Appearance，与当前目录的 `appearanceId` 不相交。恢复原页面时，在新目录重新列入该稳定身份并退出当前 tombstone 集合，客户端保留此前删除事件和这次恢复事件；不能重放旧 tombstone 再次隐藏已恢复记录。

客户端应用 tombstone 后更新站点可见状态并解释原因，但保留私人笔记、旧解析、证据依赖文件与 Zotero 映射。自动缓存回收不能清除用户固定离线包或仍被私人证据引用的版本。恢复被移除内容产生新快照和可追溯状态，不擦掉个人库中的旧删除记录。

## 8. 原子同步与失败恢复

1. 下载 manifest，核验合同、版本、可信站点与路径。
2. 获取并核对快照原字节 SHA、长度和来源提交一致性。
3. 下载全部目录及必要词表到暂存区，核对逐文件和总数量、唯一身份、引用与 tombstone 关系。
4. 用本地事务切换当前站点快照。未下载的详情仍明确为按需状态，不授予离线资格。
5. 需要详情或资源时按当前修订的描述符读取，校验成功后原子保存；失败保留旧可读版本并显示当前缺项。

CDN 混入不同版本、文件 404、SHA/大小不符、UTF-8/JSON 无效、未知合同、磁盘写入失败均不切换成半批“完整更新”。请求失败可有限重试原资源，不能调用 LLM 修补导入、不改字段或重签清单。

原不可变资源被新部署清理而下载失败时，先保留原快照可读部分，再重新读取入口检查新版本；未能完成新快照仍不替换。发布者宜保留一个明确的旧对象兼容窗口，不能承诺无限保留所有站点历史资产。

“目录已同步”“导读离线完整”“PDF 已离线”“Zotero 完整归档”分别记录，不能由同一次 HTTP 成功共同授予。应用重启校验暂存状态，只续未完成步骤。HTTP ETag 可减少传输，不能代替协议内的字节核验。

## 9. 个人数据隔离

站点快照与 `Note`、`Annotation`、`StudySession`、`ReadingState`、`ArchiveOperation`、`ZoteroMapping` 分开存储，通过稳定身份和修订关联。网站同步、更正、撤稿与缓存清理均不能覆盖用户编辑。

模型请求只在用户主动研究时发生；输入范围、模型、时间、真实用量与结果版本保留在个人层。密钥使用正式应用的系统凭据存储，不进入静态数据包、网页存储或诊断导出。Zotero 连接授权也不属于网站同步协议。

## 10. 首批验收

- 日更 arXiv、正式会议、历史未核验页、汇总和特殊版本披露均有真实样本；页面数与去重论文数分别正确。
- 已发布提交树导出无模型请求，不混入未提交会议修改、生产失败稿或私有运行账。
- 相同输入产生相同内容对象；manifest 不出现自引用 SHA；目录和详情不能跨快照串稿。
- 标题、作者顺序、博客/论文日期、分数、分类、版本 PDF 和来源警告与原结果相同，未知字段不补猜。
- 图文、公式、宽表离线依赖逐项可查；外部图缺失不标完整离线。
- 新增、更正、移除、正式撤稿、替换和恢复均保留个人内容与旧证据关联。
- SHA 错误、缺分片、混版本、断网、磁盘失败和重启后只恢复必要步骤，保留上一份完整快照。
- 未实现的静态出口、真实模型与 Zotero 能力不能借原型的演示状态标为已完成。
