# 文档示意图

这个目录存放 `README.md`、`README.en.md` 与[项目导读](../project-guide.md)使用的 SVG 示意图，用来说明项目结构和数据关系。图只负责把关系画清楚，执行约束以图注链接的文档为准，图里的文字不能替代正文要求。

## 现有文件

| 文件 | 说明什么 | 引用位置 |
|---|---|---|
| `hero-workbench.zh.svg` | 音频研究工作台（Audio Research Workbench）中文旗舰封面横幅：展示核心定位、声谱视觉母题与四项已核验核心指标。 | `README.md` |
| `hero-workbench.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `portal-home-preview.png` | 音频研究门户（Audio Research Portal）本地真实构建渲染首页实景截图（每日精选、快捷检索与顶会入口）。 | `README.md`、`README.en.md` |
| `portal-paper-preview.png` | 音频研究门户单篇论文深度精读页实景截图（音频速览卡、八维评分、KaTeX 公式与原图衔接）。 | `README.md`、`README.en.md` |
| `workbench-architecture.zh.svg` | 三层全景结构：音频研究工作台内容生产引擎（本仓库）、音频研究门户（Hugo）与 Mac / Android 音频研究工作台之间的单向推送、只读同步和凭据隔离关系。 | `README.md` |
| `workbench-architecture.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `daily-digest-flow.zh.svg` | 音频研究日报从 arXiv/HuggingFace 补抓去重、预筛与模型筛选、四文件来源封存，到全文分析、三层审查、推送部署与逐页核验的六阶段流程。 | `README.md` |
| `daily-digest-flow.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `client-experience.zh.svg` | Mac 与 Android 工作台 1.5.0 公开只读输入（网站快照、每日播客）与右侧三条独立个人扩展通道（个人研究模型、Zotero 归档、WebDAV 版本化备份）的数据边界。 | `README.md` |
| `client-experience.en.svg` | 上一张的英文版，内容与结构相同。 | `README.en.md` |
| `pipeline-overview.zh.svg` | 三条生产流程（当天日更、官方会议整理、历史博客更新）分别取得真实来源，共用分析与写作，独立审查并推送核验的竖版概览。 | [项目导读](../project-guide.md) |
| `pipeline-overview.en.svg` | 上一张的英文版，内容相同。 | 英文项目概览备份 |
| `client-data-flow.svg` | 网站公开内容与客户端个人研究、Zotero 及研究备份的竖版数据流图。 | [项目导读](../project-guide.md) |
| `client-data-flow.en.svg` | 上一张的英文版，内容相同。 | 英文客户端数据流备份 |

图的文字依据：三条流程见[项目导读](../project-guide.md)与[三条流程](../three-workflows.md)；客户端数据流见[项目导读](../project-guide.md)、[Mac 云端备份](../mac-app-cloud.md)与 [Android 备份合同](../android-cloud-contract.md)。

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
