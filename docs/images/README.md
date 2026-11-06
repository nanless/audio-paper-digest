# 文档示意图

这个目录存放 README 与项目导读使用的 SVG 示意图，用来说明项目结构和数据关系。图只负责把关系画清楚，执行约束以图注链接的文档为准，图里的文字不能替代正文要求。

## 现有文件

| 文件 | 说明什么 | 引用位置 |
|---|---|---|
| `pipeline-overview.zh.svg` | 三条生产流程（当天日更、官方会议整理、历史博客更新）分别取得本次真实来源，共用分析与写作，生成页面后独立审查，再推送、部署并逐页核验。箭头表示内容与来源记录传给下一步；日更默认不生图，原论文图照常核验。 | `README.md`、[项目导读](../project-guide.md) |
| `pipeline-overview.en.svg` | 上一张的英文版，内容相同。 | `README.en.md` |
| `client-data-flow.svg` | 网站公开内容只读进入 Mac 与 Android 工作台；个人研究按用户主动操作把选定文字发给用户配置的模型服务；Mac 使用本机 Zotero 接口，Android 使用 Zotero Web API；研究资料备份独立保存版本，虚线表示确认后恢复，不自动合并，也不迁移模型密钥、登录凭据和本机完整性校验密钥。 | `README.md`、[项目导读](../project-guide.md) |
| `client-data-flow.en.svg` | 上一张的英文版，内容相同。 | `README.en.md` |

图的文字依据：三条流程见[项目导读](../project-guide.md)与[三条流程](../three-workflows.md)；客户端数据流见[项目导读](../project-guide.md)、[Mac 云端备份](../mac-app-cloud.md)与 [Android 备份合同](../android-cloud-contract.md)。

## 命名约定

新增图统一使用 `<主题>.<语言>.svg` 或 `<主题>.svg`：

- 主题用小写英文和连字符，例如 `reader-pipeline`。
- 同一张图有中英两版时，两版都带语言后缀：`<主题>.zh.svg`、`<主题>.en.svg`。
- 只有一种语言的图用 `<主题>.svg`；语言后缀用小写两位语言代码。

现有四个文件的命名不完全一致：`pipeline-overview.zh.svg` 带 `.zh`，`client-data-flow.svg` 不带后缀但同样是中文版。改名会牵动 `README.md`、`README.en.md` 和 `docs/project-guide.md` 的图片链接，所以四个文件保持原名，新增图按上面的规则命名。

## 改图要一起改什么

- 图里的文字和箭头要与依据文档一致。流程或数据关系变了，先改文档和图注，再改图。
- 引用图的页面要同步：`README.md`、`README.en.md`、`docs/project-guide.md`。
- 保留 `<svg>` 根元素上的 `role="img"`、`aria-labelledby`，以及 `<title>` 和 `<desc>`。图题和完整说明写实际内容，读屏软件依赖它们。
- 四个文件共用同一套内联样式和字体栈，新增图沿用这套样式，避免同一页面上的图风格不一致。
- 新增或改名后运行 `npm run docs:check` 和 `node --test tests/documentation.test.js`；后者会检查 Markdown 相对链接是否存在。
