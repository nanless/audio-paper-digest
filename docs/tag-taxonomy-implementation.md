# 标签体系实施与验收计划

本轮从已完成的[设计](tag-taxonomy-design.md)进入代码实现。保持现有日更、Reader、评分和已发布博客字节不变；先交付独立的共享词表、映射层、全历史预览和检索工作台。预览不是正式语义重标，不改变历史论文标签URL，也不偷偷启用新分析协议。

## 分工与依赖

| 阶段 | 负责范围 | 交付与验收 |
|---|---|---|
| P0，共享词表 | registry与Node实现 | 稳定ID、九个分面、单父层级、严格别名；拒冲突、环和未知引用，保留非同义边界 |
| P1，Python兼容与历史构建 | Python loader与只读Hugo扫描器 | 两端解析一致；来源SHA/输入前后状态闭合；全部旧词都有映射或待核结果，不改源 |
| P2，检索界面 | 静态HTML/CSS/JS | 同分面OR、跨分面AND、父节点召回、别名搜索、清除/分页/错误态、安全链接与可访问性 |
| 集成，主代理 | CLI、集中路径、受限本地服务、文档与全量验证 | 真实4185页回放，Node/Python parity，旧canonical/博客SHA不变，完整项目回归 |

P0接口先固定，P1/P2围绕相同快照契约并行实现。每个代理只修改分配文件，交付后由另一代理或主代理复核；任何失败先修再重验，不通过修改成功标记消除问题。

## 固定协议

registry版本为 `paper-taxonomy-v1`。记录含 `id/facet/preferredLabel{zh,en}/aliases/broaderId/definition/scopeNote/status/replacedBy`；分面是task、method、setting、signal、application、research_focus、artifact、scientific_topic、model_family。父关系仅在同分面，v1单父无环。别名不可把PEFT收窄到LoRA、数据增强改成预训练、说话人识别改成验证。

预览版本为 `paper-taxonomy-preview-v1`，绑定registry原字SHA和实际博客Git/页面SHA。每条保留原tags、全部映射ID和未知tags；只有用于展示的ID去掉冗余祖先，原始证据不删除。主任务仅来自显式主任务字段且确实解析为task；首标签不补主任务。

状态只表达映射完整度：`legacy_mapped`全部旧词可映射、`partial`部分未知、`unresolved`尚无映射。三者都不是 `reviewed`，也不证明论文语义分类正确。没有标签仍保留记录。已知arXiv ID以最新页为显示代表并保留重复路径，未知ID按路径哈希独立保存，不伪称全部唯一论文。

## 安全边界

- 默认从项目配置读取真实Hugo仓库，输出仅到独立runtime目录；构建前后核输入状态，拒绝源路径逃逸/符号链接，不写博客或current。
- Web快照不包含论文正文、凭据或用户绝对路径。仅提供已发布HTTPS论文链接；不把论文文本拼接为HTML。
- 本地服务只监听127.0.0.1，只开放首页、样式、脚本、快照四个固定路径，不暴露runtime目录列表或审计文件；限制Host/Origin和方法，设置CSP。
- 不安装新依赖、不调用论文LLM、不为标签重写全文。现有Node/Python legacy解析行为暂不全局替换，避免使既有生产凭证漂移；新映射层明确修正语义边界。

## 验收矩阵

1. registry完整：ID、首选名、别名、父边、状态和说明；恶意/歧义/重复输入失败关闭。
2. 跨语言：对全部概念名称/别名、未知词、PEFT/LoRA等边界逐项对照；同一原字SHA、同样结果。
3. 历史扫描：论文页/已知ID/未知ID/重复ID分别统计；每个旧tag在处置表有归宿，未知不静默丢失。
4. 检索：上级含自身与后代；同分面OR、跨分面AND；科学主题、空主任务、缺标签、无结果、坏快照和恶意URL。
5. 非干扰：构建前后Hugo commit、工作区、全部页面SHA与current canonical/已发布receipt不变。
6. 完整回归：沙箱外 `npm run verify`，包含真实Hugo、默认/Manual JS/Python和数据门禁；记录实际结果，不把单测当语义正确率。

## 后续正式切换的前提

正式生产分类协议、分类证据审核、历史分层语义评测、Hugo主题页接入与旧URL迁移需要下一批独立验收。当前预览中的未知数量将决定补词和复核顺序；不能为了提高覆盖率把歧义标签随意压到允许的某个词。仅当分类证据与预览稳定后，才规划独立generate/review/push，不沿用旧receipt。

## 执行记录

### 已实现的第一批

- `config/paper-taxonomy.json`：204概念、9分面，含90任务、51方法；每个概念都有中英文名、严格别名、定义与范围说明。原125个表内历史词中124个可精确映射，裸“离线”因语义不明保留待核。
- Node/Python共享加载器逐项一致；所有名称、别名、祖先及展示去重进行跨语言回放。不再在新映射层将PEFT收窄为LoRA，也不混淆说话人识别/验证。
- Python新路径集中于 `taxonomy_paths.py`，仅引用既有项目根；正式 `path_config.py` 保持原字节，避免预览功能使已发布模板指纹无关失效。
- 历史构建器只读扫描4490个Markdown，得到4185个论文页、4069条显示记录、2651个可核唯一arXiv ID及1418个未定ID页面。全部1243种原标签都进入处置表，不按标题猜去重。
- 实际映射178种标签，类型覆盖14.32%；覆盖13932/15774次标签出现，即88.32%。剩余1065种完整保留。2699条记录为完整字面映射、1044条部分映射、326条尚无映射；**语义审核记录数仍为0**，这些不是分类准确率。
- 输出目录锁、全部源文件前后SHA/Git验证、ID来源冲突拒绝、CSV公式转义、最后签发bundle四项均已实现。服务启动复验index/report/CSV全部字节及registry/source身份，不接受半次构建。
- 检索界面保留原标签及主任务异常；同分面OR、跨分面AND、祖先召回、别名搜索、分页、可访问错误态均可用。主任务不重复为chip，窄屏初始折叠分面。

### 实际验收

正式索引原字SHA为 `11fd0fa81cd71e5722305e8f57ca3b7a3a92b6809ba37438d7b33c90cff40517`，registry SHA为 `dcf83f84857d45d6a36ee20d9235d7566d9a3a53644ab442d8eb64b5e81a9adf`，绑定博客 `bf263b803bd353f1411d94f27c621edb33dbb898`。数据位于 `data/runtime/taxonomy-preview/`，包括 `index.json`、`migration-report.json`、`tag-disposition.csv`、`bundle-manifest.json`，权限0600。

实际数据联验：ASR含子节点600条、AV-ASR4条；LoRA13条被PEFT父查询178条包含；未映射/主任务待核筛选1370条，等于1044部分映射加326尚无映射。30条显式主任务保留来源，4039条缺失主任务未从首标签猜测。Edge成功加载真实4069记录；非空渲染、手机/桌面初始折叠与去重复由回归用例覆盖。

初次完整验证发现新Python库直接执行缺少runtime guard，已修正并复验。隔离Python路径后最终全套通过 **1178项JS、431项默认Python、24项Manual Python**、固定Hugo、全仓语法及严格数据检查；最终日志 `/private/tmp/taxonomy-isolation-verify-final.log`。测试中的模拟LLM与临时Git推送日志不代表生产动作，已复核测试mock和临时仓库路径。

当前canonical SHA `a450aa54f6a2b463b83409fe02f88c73f80d68d0146dfdd69e1d343429ef9925` 与四篇纠错安装凭据相等；博客HEAD仍为上述发布版本、工作区干净。正式 `path_config.py` 相对实施前diff为空；npm预览入口在隔离后再次实际构建成功，统计与之前相同。没有重写Reader、改评分、改历史标签URL或推送博客。未进行付费论文分类请求；这不包含本会话/子代理本身用量，不宣称整项工作零Token。临时预览服务已停止，可按下面命令重新启动。

### 使用方法

```bash
# 校验共享词表
npm run taxonomy:validate
# 从项目.env指定的干净Hugo仓库重新构建只读预览
npm run taxonomy:preview
# 打开命令打印的本机URL；Ctrl+C停止
npm run taxonomy:serve
# 可选换端口；不支持绑定公网地址
npm run taxonomy:serve -- --port 8999
```

运行仍必须沙箱外；构建不联网。更改词表后先重新preview，旧bundle将因registry SHA不匹配而被拒绝。没有Hugo仓库的干净CI只需运行词表/fixture测试，不可把无数据当真实历史验收。本预览是短时静态工作台，不是博客功能依赖的本机AI助手，不常驻或自动启动。

旧日更Prompt、四行标签契约及legacy解析默认行为尚未切换到新分类。下一批需要源证据语义审核、正式分类schema和Hugo发布投影接入，再独立完成旧URL迁移及发布；本轮不得称全站已重标。
