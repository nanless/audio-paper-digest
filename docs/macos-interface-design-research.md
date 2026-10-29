# 论文速递工作台 Mac 版：界面与阅读设计

工作台采用原生 Mac 窗口和操作习惯，将科研正文、原图与原文放在主要位置。AppKit 提供系统窗口、菜单和设置，WebKit 排版导读，PDFKit 显示原始 PDF。

## 工作区

| 区域 | 当前用途 |
|---|---|
| 资料侧栏 | 进入资料库、收藏、待读、网站页面、个人研究与后台任务，可收起 |
| 论文列表 | 显示标题、作者、来源、日期、评分和状态，提供搜索、组合筛选、排序、多选与分页 |
| 单栏阅读 | 默认只显示导读或个人内容，不预留空 PDF 栏 |
| PDF 双栏 | 打开原文后左侧保留导读、解析或笔记，右侧显示 PDF，比例可调 |
| 个人解析 | 选择实际材料、填写问题，阅读已保存回答与证据 |
| 独立设置 | 通过应用菜单或 `⌘,` 调整阅读、模型、网络、Zotero 与坚果云 |

1440 × 900 是设计参考尺寸，不限制真实窗口。较窄窗口先收起辅助导航，保护主要操作和正文可读性；分隔线与字号变化保留阅读位置。宽窗口不无限拉长正文行。

## 长文与 PDF

- 中文正文、标题、作者和辅助信息有清楚层次，长题名可以完整查看。
- 图片保持原比例和原色，图注、表注和来源与内容一起呈现。
- 宽表和长公式局部滚动，优先保持字号，不把整篇缩成小字。
- PDF 按实际字节显示，提供翻页、页码、缩放、适宽、查找和文字选择；扫描页如实显示提取能力。
- 开关 PDF、切换页签和调整比例时保存合理上下文；证据定位使用真实物理页和同一 PDF SHA，不按滚动百分比同步两边。
- 网站导读、原文证据和个人解析分别显示，模型回答不改写正式来源或网站评分。

个人笔记当前为 Markdown 编辑，支持正常中文输入、撤销重做及自动保存。保存失败保留编辑内容并显示错误。问题草稿、笔记和已保存回答分别管理。

## 状态与操作

后台任务显示实际对象、阶段、状态和下一步。下载可以显示实际字节，模型等待使用不确定进度；取消和失败保留真实费用状态。部分归档与完整回读有不同结果。

控件名称、选中、禁用、进度和错误应能被系统读出。标准快捷键保持作用域，中文组合输入期间不发送模型请求。设置关闭重开保留合理位置与草稿，原生确认操作结束后回到原阅读上下文。

浅深外观、对比度、减少透明度、减少动态效果与字号共同服务于阅读；科学图和 PDF 不被主题改色。网站与模型内容放入受限文档，不能调用原生桥或读取凭据。

## 日常检查

| 检查对象 | 重点 |
|---|---|
| 资料库 | 长标题、缺字段、组合筛选、无结果、多选与返回位置 |
| 单栏与双栏 | 同一真实长文中的图、表、公式、来源及原文可读性 |
| 个人解析与笔记 | 中文输入、发送、保存、失败草稿、来源返回和重启恢复 |
| 任务与归档 | 等待、取消、部分完成、冲突、完整回读与下一步 |
| 窗口与设置 | 多尺寸、活动与失焦、键盘、系统读出和不同外观 |

原生实际操作、隔离浏览器测试和静态包检查分别保留范围。既有已安装版本的操作结果与 1.0.1 新包未执行图形启动的事实见[验证说明](mac-app-validation.md)，详细功能要求见[验收矩阵](mac-app-acceptance.md)。

## 设计依据

主要参考 Apple 的 [macOS 设计](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos)、[窗口](https://developer.apple.com/design/human-interface-guidelines/windows)、[分栏](https://developer.apple.com/design/human-interface-guidelines/split-views)、[设置](https://developer.apple.com/design/human-interface-guidelines/settings)、[排版](https://developer.apple.com/design/human-interface-guidelines/typography)与[辅助功能](https://developer.apple.com/design/human-interface-guidelines/accessibility)规范。

[Zotero 阅读器](https://www.zotero.org/support/pdf_reader)、[Highlights](https://highlightsapp.net/how-to/mac/add-notes-to-pdf/)及 [Bear 排版设置](https://bear.app/faq/typography-options/)用于研究原文往返和长文阅读方式，不代表对这些产品的完整实测，也不表示工作台已提供它们的全部能力。
