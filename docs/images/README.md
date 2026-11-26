# 文档示意图

这个目录存放 `README.md`、`README.en.md` 与[项目导读](../project-guide.md)使用的 Studio Monograph 风格 SVG 示意图和真实构建门户截图，用来说明项目结构、流水线与数据边界。图只负责把关系画清楚，执行约束以图注链接的文档为准，图里的文字不能替代正文要求。

## 现有文件

| 文件 | 说明什么 | 引用位置 |
|---|---|---|
| `hero-workbench.zh.svg` | 音频研究工作台（Audio Research Workbench）Studio Monograph 深岩青声谱旗舰封面：展示核心定位、9,300+ 篇中文精读（8,650+ 篇论文）、400 项九维分类与 8 大 SOTA 专题、三条齐平产线、每日播客及 Mac/Android 1.5.x 核心指标。 | `README.md` |
| `hero-workbench.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `portal-home-preview.png` | 音频研究门户 Studio Monograph 2.0 暖纸版首页本地真实渲染 2× 截图：包含 `最新一期 2026.11.26` 声谱封面与本期选读、`⌘K` 快捷检索栏及下方 8 大音频研究专题榜单卡片。 | `README.md`、`README.en.md` |
| `portal-paper-preview.png` | 音频研究门户单篇深度精读页本地真实渲染 2× 截图：同屏呈现左侧跟随目录、正文 KaTeX 数学公式与带“反色 / 放大查看”工具栏的已核验论文原图，以及右侧悬浮的八维评分环/分项条与来源信息卡。 | `README.md`、`README.en.md` |
| `workbench-architecture.zh.svg` | Studio Monograph 暖纸三层架构图：内容生产引擎（日更、会议、历史三线齐平）、音频研究门户（Studio Monograph 2.0）与 Mac / Android 1.5.x 双端原生工作台的单向推送、只读同步与凭据隔离关系。 | `README.md` |
| `workbench-architecture.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `daily-digest-flow.zh.svg` | Studio Monograph 暖纸六阶段日更流程图：从 arXiv / HuggingFace 边界补抓与去重、预筛与模型筛选、四文件来源封存，到深度分析与 Reader 长文、生成与三层审查、推送部署与逐页核验。 | `README.md` |
| `daily-digest-flow.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `client-experience.zh.svg` | Mac 与 Android 1.5.0 工作台数据边界图：左侧门户快照与每日音频播客只读流入，右侧四条隔离通道分别处理个人研究模型、Zotero 文献归档、一键双向同步 WebDAV（含笔记冲突无损合并）及完整研究空间快照备份。 | `README.md` |
| `client-experience.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `pipeline-overview.zh.svg` | 三条生产流程（当天日更、官方会议整理、历史博客更新）分别取得真实来源，共用分析与写作，独立审查并推送核验的竖版概览。 | [项目导读](../project-guide.md) |
| `pipeline-overview.en.svg` | 上一张的英文版，内容相同。 | 英文项目概览备份 |
| `client-data-flow.svg` | 音频研究门户公开快照、1.5.0 每日音频播客与客户端个人研究、Zotero、一键双向同步 WebDAV 及完整研究空间快照备份的竖版数据流图。 | [项目导读](../project-guide.md) |
| `client-data-flow.en.svg` | 上一张的英文版，内容相同。 | 英文客户端数据流备份 |

图的文字依据：三条流程见[项目导读](../project-guide.md)与[三条流程](../three-workflows.md)；客户端数据流与双端同步见[项目导读](../project-guide.md)、[同步与冲突处理](../workbench-full-webdav-sync.md)、[Mac 云端备份](../mac-app-cloud.md)与 [Android 备份合同](../android-cloud-contract.md)。

## 命名约定

新增图统一使用 `<主题>.<语言>.svg` 或 `<主题>.svg`：

- 主题用小写英文和连字符，例如 `daily-digest-flow`。
- 同一张图有中英两版时，两版都带语言后缀：`<主题>.zh.svg`、`<主题>.en.svg`。
- 只有一种语言的图用 `<主题>.svg`；语言后缀用小写两位语言代码。

旧有四个文件（`pipeline-overview.{zh,en}.svg`、`client-data-flow{.en,}.svg`）为保留既有链接保持原名，新增图均遵循 `<主题>.<语言>.svg`。

## 改图要一起改什么

- 图里的文字和箭头必须与依据文档一致；流程或数据关系变动时先改文档，再改图。
- 引用图的页面要同步更新：`README.md`、`README.en.md`、`docs/project-guide.md`。
- 保留 `<svg>` 根元素上的 `role="img"`、`aria-labelledby` 以及 `<title>` 和 `<desc>`。
- 每次修改 SVG 后须实际渲染成像素图检查文字裁切、箭头交叉与留白，不能只看文件存在或语法有效。
- 新增或改名后运行 `npm run docs:check` 和 `node --test tests/documentation.test.js`。
