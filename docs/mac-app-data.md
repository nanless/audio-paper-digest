# Mac 应用的数据接入与实际验证

正式原生客户端的数据服务为 [LibraryService.swift](../apps/macos/Sources/LibraryService.swift)，界面资料库为 [library-ui.js](../apps/macos/Resources/library-ui.js)。本页记录现有兼容接入；未来专用静态出口见[desktop/v1 合同](desktop-data-contract.md)。当前站点尚未提供该专用出口，客户端没有把它当作已经上线。

## 读取什么，保存在哪里

客户端通过 HTTPS 读取当前公开网站的 `/index.json` 和内容寻址搜索分片；日更、会议、历史论文使用同一资料库，不重新筛选、分析、评分或生成历史导读。汇总页保留在网站页面计数中，不当成一篇论文。

索引中的 `identityStatus`、规范会议 `paperId`、arXiv 基础 ID 与 `citation` 决定身份。已核验的同一论文合并多个出现页面，保留 `appearances`；未核验记录按页面路径隔离。中文译题和标题相似度不授予合并资格。网站日期不填入论文发表日期，缺失作者、DOI 或刊会信息不补猜。

站点资料保存在应用用户目录的 `PublishedLibrary/`：

| 路径 | 用途 |
|---|---|
| `current.json` | 一次完整同步后的站点目录快照 |
| `index/<sha>.json` | 已校验的不可变分片，每次复用仍检查真实字节 |
| `articles/<url-sha>.json` | 按需读取的安全正文、引用、版本、资源与获取时间 |
| `article-revisions/<page-sha>/<content-sha>.json` | 已读取的旧正文、来源和资源版本，按实际内容去重保留 |
| `assets/<content-sha>.*` | 按需保存的实际科学图 |
| `pdf/<content-sha>.pdf` | 实际读取并校验的指定版本 PDF |
| `pdf-pointers/` | 官方链接到最近一次已核验或明确陈旧的 PDF 回执映射 |
| `pdf-receipts/<paper-sha>/<pdf-sha>.json` | 原始 PDF 来源回执；后续同 URL 更新不改写先前 SHA 的记录 |
| `fulltext.json` | 只包含本机已读取导读的检索文本 |

个人笔记、阅读状态、收藏、待读、会话与 Zotero 映射由独立个人存储管理；模型密钥由系统钥匙串管理。这些内容不进入站点缓存，不随着网站同步覆盖。应用不读取生产项目 `.env`、账号池、运行账本或 `data/runtime/`。

## 目录一致性与增量

兼容 `paper-search-index-manifest-v1` 和旧数组索引。当前分片协议检查合同、唯一站内 URL、单分片和总大小、真实原始字节 SHA、分片条数和总条数；不把解析后重新序列化的 SHA 当作原字节证明。

目录先完整下载和核验，再以原子写入替换 `current.json`；失败或取消保留上一份完整快照。内容未变化时只重新读取入口清单，已保存分片经 SHA 与大小检查后复用。当前实现逐分片执行，进度显示真实完成数量，不用估计百分比冒充任务进度。

新完整目录里消失的论文记录为 `missingFromLatest`，保留此前元数据与本地正文，后续相同同步不会抹掉移除提示。重新出现后退出当前缺失集合。现有搜索出口没有正式 tombstone 或撤稿合同，因此这里仅称“目录移除”，不能从缺失或 404 推断论文撤稿；专用出口将按合同区分这些事件。

## 完整正文与元数据

打开论文时按需获取已发布页面。缓存绑定论文 ID、页面 URL、原文 URL、PDF URL、明确来源版本和目录验证 epoch；六小时到期或每次完整目录同步后，再打开时重新核对正文，即使目录入口字节没有变化。支持 `library.article` 的显式 refresh；缺图在后续正常打开或显式刷新时重试。正常再验证成功前保存旧内容修订，科学正文未变化时不会因验证时间变化重复归档。

复验失败仍可离线阅读旧稿，但返回 `isStale=true`、`cacheStatus=stale`、原始来源版本、当前期待版本和明确通知；不把旧稿重新标为当前版本。失败后五分钟内避免重复自动联网，显式刷新可立即重试。目录或来源版本再改变会突破该短暂退避。取消操作直接失败，不用旧稿把取消冒充成功。

唯一正文选择器为 `div#article-body.post-content`，必须恰好匹配一次；适配失败明确报错并保留旧正文，不退回抓整页导航或调用模型补写。

macOS Foundation 的 HTML tidy 会移除 HTML5 `article`、`section` 包装，所以不能依赖这些祖先标签。实现先显式使用 UTF-8 字符串构造 XMLDocument，避免 data 初始化导致中文乱码，再按唯一正文 ID 和类名定位。引用优先读取 `script.paper-tools__citation-record`，保留 `verified` 与 `complete` 的区别，并核对当前页面论文身份。

正文清理脚本、表单、事件属性、嵌入框架、危险 URL 和外部实体，保留原始文本、表格、公式与图片出处。原公式交由应用内数学引擎显示，网页自己的脚本不能进入本地桥接。

发现引用 sidecar 链接后，按需获取 `citation.json`、`rethink-context.json`，同时记录实际发布的 BibTeX/RIS 文件地址。导出引用时读取这些文件的真实原字节，返回文件名、文本及 SHA；文件缺失、格式或身份错误就报错，不在客户端凭字段重造一份“已发布引用”。原始结构化作者及机构保存在 sidecar 结果中；`rethink-context.json` 是摘要与研究上下文，不能冒充完整 Reader。

正文只含外部图片 URL 时，不授予离线完整状态。已保存的图以受控 data 图片交给阅读界面，不让正文获得整个文件系统读权限；缺图明确记录原因，正文仍可阅读。搜索覆盖元数据、本机已读取导读和个人笔记，不声称搜索尚未下载的全部 PDF。

## PDF、外部资源与取消

PDF 只使用已核验引用里的官方链接。arXiv 必须绑定明确版本，旧记录没有版本时不静默下载最新版。缓存记录真实下载 SHA、字节数、来源 URL 和版本；PDFKit 实际确认文档可读后才保存，错误 HTML 或截断文件不作为 PDF 缓存。

官方 arXiv 的明确版本（包含旧式 `math/0101001v1`）是不可变来源见证，目录同步不要求它重复下载。题名/来源声明为 v2 而原文链接仍为 v1 时，在传输前拒绝，不能给旧文件贴新版本。

会议等没有不可变版本见证的同 URL PDF，按目录验证 epoch 与六小时时限复核；`library.downloadPDF` 的 `refresh=true` 可立即复验。回执包含 `cacheStatus=current/revalidated/stale`、`isStale`、`validatedAt`、`currentness`、公开 SHA 和通知。真实更新按新内容 SHA 保存，旧 PDF 字节和原始来源回执保留，已有研究引用不迁移到新 SHA。重新核对失败时旧副本仍可阅读，但明确标为陈旧，保留原核验时间，不能冒充网站当前 PDF；五分钟自动退避可被显式刷新突破。取消直接失败，不以旧副本冒充取消成功。

当前兼容适配明确支持目录及其 citation 中的 `pdfSha256`/`pdfSHA256`；有效公开 SHA 必须与实际 PDF 字节一致，相互矛盾或坏值阻断新目录。匹配的公开 SHA 可以直接证明相同本机内容，避免无谓重传；不把正文、表格或任意其他 SHA 猜作 PDF 证明。

默认不缓存全站 PDF。外部下载只支持明确的官方 HTTPS 来源集合，逐次重定向重新检查域名、协议、凭据与端口，解析并拒绝私网和保留地址，再以固定公网 IP 建连、保留原主机名 TLS 校验。curl 自动重定向、URL 展开及用户 `.curlrc` 配置均禁用。arXiv 必须由应用设置提供 HTTP CONNECT 代理，未配置时保留已有导读并说明原因，不读取生产环境或静默直连。

单张图片上限16 MiB、单篇最多32张且累计64 MiB；PDF 上限100 MiB，大小与格式失败不保存完整状态。取消目录同步只终止该同步的请求，不会中断同时打开的文章或 PDF。文章、PDF 各自的任务取消由其独立 URLSession/curl 取消句柄清理；curl 启动与取消之间的竞态受锁保护。已完成文件复用，未完成临时传输清理；取消不删除个人数据。

参考：[Apple XMLDocument](https://developer.apple.com/documentation/foundation/xmldocument)、[URLSession AsyncBytes](https://developer.apple.com/documentation/foundation/urlsession/asyncbytes)、[curl 固定连接目标](https://curl.se/docs/manpage.html#--connect-to)。SHA 只证明文件字节，不能替代原发布的科学与来源审查。

## 应用内样稿与安装独立性

安装包可自带 `Resources/Seed/sample.json`、三张真实科学图和 MiCLA 原始13页 PDF。服务在空库时显示15条真实已发布样本，明确“尚未全站同步”；只有 MiCLA 包含完整离线样稿，其他条目按需从网站读取，不冒充全库离线。种子必须与目录中的 abs/pdf/blog 地址及明确版本完全一致；v1 固定字节不能用作 v2。完成全站同步后，正文优先重新读取网站，种子只作精确同版本的离线后备。种子 PDF 通过原 SHA、大小和实际页数检查后，复制到用户 `PublishedLibrary/pdf/` 并写正常指针，让 Zotero 附件遵循同一私有目录约束。

备份恢复后的旧绝对 PDF/图片路径只经 `PrivateStoragePaths.resolve` 和原 SHA 读取受控旧根映射，返回当前私有目录中的实际路径；不改写历史指针或把路径映射当作来源资格。

MiCLA 样稿的实际 Citation JSON 保存在 `citationSidecar`，保留作者和机构；真实摘要、来源、论点和原有评分字段进入 `researchContext`。该上下文明确标为 `desktop-bundled-research-context-v1` 与 `sampleOnly`，不伪装成远端 rethink v2 文件。样稿图片与 PDF 按实际 SHA 检查，PDF 还检查真实页数。样稿是构建时复制的自包含资源，安装后不依赖代码仓库或原型目录在场。正式全站同步后保留相同稳定论文身份，不重复个人笔记。

## 原生桥接口

`handle(command:payload:progress:)` 返回 JSON 兼容对象；异步进度包含 `phase`、用户可读 `message`、真实 `completed` 和 `total`。

| 命令 | 主要输入与结果 |
|---|---|
| `library.status` | 论文数、页面记录数、分片数、快照身份、同步时间与移除集合 |
| `library.sync` | 完整网站目录同步；不调用模型 |
| `library.list` | query/source/minimumScore/sort/offset/limit；返回筛选后 total、当页 papers 和全库 totalInLibrary |
| `library.search` | 返回本机已读导读中命中的论文 ID，不包括私人笔记或未下载 PDF |
| `library.article` | paperID、可选 refresh/downloadImages；返回安全 HTML/可选 Markdown、plainText、引用、资源、来源、版本与缺项 |
| `library.citationFile` | paperID、format=bib/ris/json；读取实际已发布引用文件，返回 filename/text/sha256/sourceURL，不现场生成 |
| `library.downloadPDF` | paperID、可选 refresh；返回实际本机路径、SHA、字节、来源版本/URL及当前性回执；旧缓存可能明确 stale |
| `library.network` | 本次应用的 HTTP CONNECT 代理配置，不接收模型密钥 |
| `library.cancel` | 只停止目录同步，保留其他文章/PDF任务及已有资料；具体资源任务由其自己的取消按钮停止 |

资料库界面每页渲染100行，支持任务、方法、来源、最低评分与网站日期组合筛选、中文搜索、收藏/待读、多选、右键菜单和分页。个人清单写入均经原生存储，不使用网页 localStorage。

## 本次已执行验证

2026-10-24，真实完整读取线上清单与22个分片，逐份核对原始 SHA、大小与条数：**8,720条页面记录，8,005篇按规范身份去重的论文**。这些数字属于当时快照，后续同步按实际清单变化。

真实 RubatoCodec 导读取得12,728个文本字符，保留实验表，发现4张原论文图，实际取得 Citation JSON 和研究上下文文件，未包含导航、评论或外部脚本。这轮没有下载它的全部图片或 PDF，也没有调用 LLM。

[LibraryServiceTests.swift](../apps/macos/Tests/LibraryServiceTests.swift) 的九组测试共85项断言通过，覆盖身份/出现记录、目录增量、原子失败和重启、取消、移除及恢复、中文正文、精确选择器、安全清理、错误身份、私网地址、代理约束，真实离线样稿/PDF与作者机构校验，以及引用原字节导出和缺失 RIS 拒绝。九组测试是分场景验证，不等于九次独立人工 review。新增真实 URLSession 并行同步/正文/PDF 取消隔离、直接任务取消、同 URL 修订、缓存期限、缺图恢复、v2 拒绝 v1 种子，以及恢复目录的 PDF 指针原字节保留。同日另实际读取 MiCLA 的 BibTeX、RIS、JSON 三份线上引用文件，六项内容与 SHA 断言通过。严格版本规则更新后，另实际读取 MiCLA 的当前 HTML 与两个 sidecar，两项原网页/当前原文版本断言通过，未下载整库或请求模型。

[LibraryPDFRevalidation.test.cjs](../apps/macos/Tests/LibraryPDFRevalidation.test.cjs) 实际启动本机 HTTP 服务，由原生 URLSession 进行8次 PDF GET、8次目录 GET，16项断言通过：同 URL、nil 版本的有效 PDF 从13页改为12页和11页，目录 epoch/期限/显式刷新取得新文件，原 SHA 文件与最初回执字节保留；离线失败明显陈旧，恢复和公开 SHA 坏值/匹配分别处理；明确官方 arXiv 版本不重复请求。所有通信只在 loopback，未调用模型或外部服务。

[LibraryUI.test.cjs](../apps/macos/Tests/LibraryUI.test.cjs) 使用真实 Chrome 对1,227条测试记录验证：100行分页、多选100篇并写原生清单、私人笔记/缓存正文搜索、组合筛选、右键操作、收藏/待读视图和1000像素桌面宽度；无页面异常，不写 localStorage。测试数据不混入正式文库。

[DesktopStoreTests.swift](../apps/macos/Tests/DesktopStoreTests.swift) 的22项本机回归覆盖个人数据去重、笔记 CAS、坏 schema、以及设置、清单、笔记、阅读位置、批注、任务和会话的真实磁盘写入失败；失败后内存事务回滚，已有文件不被当作成功保存。

[DesktopEvidenceReviewTests.swift](../apps/macos/Tests/DesktopEvidenceReviewTests.swift) 独立使用真实 PDFKit 和临时磁盘故障，最初复现父章节漏掉子标题、PDF 状态版本不符、批注增删先改画面后保存四个问题；修正后八项验证通过，覆盖真实 MiCLA 第1/5/13页、嵌套父章节完整范围、长选区保留和磁盘失败时画面/持久化一致。该回归不启动用户应用窗口，不接触钥匙串或生产资料。

[ModelWorker.test.cjs](../apps/macos/Tests/ModelWorker.test.cjs) 编译真实 Swift ModelService，再通过随应用打包的 Node worker 和公共 transport 访问本机 HTTP mock。45项原生断言、11次全部位于 loopback 的请求通过；没有读取真实模型密钥，没有收费调用。验证 Chat/Responses、完整系统提示和证据指纹复用、论文身份/检查用途隔离、实际检查预算、证据与输出预算变化、显式重做的父会话关系、截断拒绝、真实在途取消、消费金额未知，以及实际费用开始/终态共享 eventId。取消的请求只留下真实开始见证，不伪造完成终态。

[DesktopContextReviewTests.swift](../apps/macos/Tests/DesktopContextReviewTests.swift) 的13项独立原生交错验证通过：实际 WKWebView 保存等待期间 A→B/ABA 切换在模型凭据读取前拒绝；晚到阅读状态保留原论文身份；queued 任务首次执行检查来源和取消；最终原生打开/备份/恢复入口检查退出及维护互斥；相同 PDF 字节复用仍更新来源版本；归档材料准备进行中取消不会被可选 PDF 错误吞掉。真实隔离 Library 先同步 v1 再同步同 ID 的 v2，验证新正文/PDF不装入旧阅读身份、旧书目不夹新 PDF、离线包不混装版本。编译前后源码 SHA 相同，凭据 provider 调用0、外部网络和模型请求0。

[DesktopContextUI.test.cjs](../apps/macos/Tests/DesktopContextUI.test.cjs) 使用实际 Chrome 的三组迟到回复负例，修后全部通过：A 的刷新正文、打开 PDF 和材料预览回复晚于 B 的安装时，不能覆盖 B 的正文修订、单栏状态或材料标签。浏览器测试中的原生桥明确是 fixture，不冒充原生 PDFKit 或用户库验收。[DesktopProtocolReview.test.cjs](../apps/macos/Tests/DesktopProtocolReview.test.cjs) 另以注入传输验证三组协议边界和失败费用回执，不访问外部服务。

## 模型响应恢复与构建证据

模型请求前先保存不含 API 密钥的完整输入和 pending 会话。worker 返回的完整或失败结果先写 `ModelUsage/<sessionID>-response.json`，使用该个人空间的内部 HMAC 材料封存，再事务保存个人会话。`ModelUsage/response-integrity.key` 是32字节内部完整性材料，权限0600；它不是模型或 Zotero 凭据，随用户主动备份迁移，诊断报告不包含它。

启动或显式恢复只扫描这些已封存响应，核对会话 ID、完整提示指纹、原输入真实字节 SHA、来源和父会话身份及 HMAC。合法结果零请求采纳；失败仍为失败，消费仍保持未知。输入或响应篡改、无签名旧文件、不同已有终态均拒绝；写入失败回滚并保留响应，重复恢复不增加请求、不改个人文件字节。未恢复且已无进程的 pending 会话标为中断和消费未知，不自动重发。测试已实际覆盖上述采纳、重复、篡改、写失败、启动与冲突分支。

成功开发构建在签名后校验 bundle，再将源码与资源 SHA 清单、签名后原生程序的实际 SHA 保存到 `apps/macos/.qa/builds/<builtAt>/`。该历史证据在已签名应用之外，避免修改签名后的资源；每次构建保留独立记录。安装先验证新 bundle 后才替换原安装。当前使用本机 ad-hoc 签名，尚未进行 Apple 公证。

这些结果不替代安装包、真实 Zotero 写入、模型服务能力、异常网络和长期运行的独立验收。新变化仅复验其实际影响范围，不为重复证明相同结果反复下载全站。
