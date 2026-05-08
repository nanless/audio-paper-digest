# 维护约定

## 维护约定

- 流程、路径、关键参数变更后，**必须同步更新** `README.md` 与 `SKILL.md`
- 文档冲突时，以当前脚本行为为准并立即修正文档
- **禁止在脚本中硬编码真实 API key、微信凭证或飞书凭证**，所有凭证统一通过环境变量读取
- 新增脚本需在 `README.md` 第 4 节和 `SKILL.md` 第 5 节登记
- 新增分析相关脚本应优先复用 `analysis-engine.js`，避免重复实现重试/保存逻辑
- 新增可配置参数应放入 `config.js`，并同步添加环境变量覆写支持
- 修改 `prompts/deep-analysis.md` 或 `prompts/filter.md` 后，代码会自动读取最新内容，无需改代码
- 修改 `deep-analyzer.js` 输出契约后，需同步检查 `scripts/utils.js` 与 `scripts/utils.py`
- 修改 `config.js` 后，需同步更新 `tests/config.test.js`
- 修改评分/标签/机器摘要格式后，需抽样验证 `data/current/deep-analysis-result.json` 和最终博客/社媒产物
- **安全审计**：定期检查代码中是否意外泄露 API key、token、凭证备份文件或环境变量快照；`data/` 和 `logs/` 目录下的临时/备份文件严禁提交到版本控制
- **`.gitignore` 要求**：确保 `data/`、`logs/`、`*.env`、`*.backup*`、`.DS_Store`、`*-cache.json`、敏感日志等被正确忽略

---

---

## 附录：当前评分与标签口径

`deep-analyzer.js` 当前使用三段式评分体系，并要求同步输出机器摘要：

### 14.1 评分公式

总分 = 学术质量分（0-7）+ 选题价值分（0-2）+ 开源与复现加成（-1 到 +1）

同时必须输出以下机器摘要字段：
- `rank_bucket`
- `quality_score`
- `value_score`
- `reproducibility_bonus`
- `confidence`
- `primary_task_tag`
- `primary_method_tag`
- `sota_claim`
- `has_code`
- `has_model`
- `has_dataset`

### 14.2 分项定义

| 维度 | 范围 | 说明 |
|------|------|------|
| 学术质量 | 0-7 | 综合创新性、技术正确性、实验充分性、证据可信度 |
| 选题价值 | 0-2 | 综合前沿性、潜在影响、实际应用空间、与语音/音频读者相关性 |
| 开源与复现加成 | -1 到 +1 | 代码、模型、数据、训练细节、超参数、复现实操信息是否充分 |

### 14.3 分档要求

- `rank_bucket` 只能从 `前10% / 前25% / 前50% / 后50%` 中选择
- `9.0-10.0`：突破性、极强说服力、领域里程碑候选
- `7.5-8.5`：明显优秀，有扎实创新和较强影响力
- `5.5-7.0`：有价值但不够突出，属于合格到良好
- `3.0-5.0`：创新有限、实验薄弱、结论一般或存在明显短板
- `1.0-2.5`：问题严重，不推荐投入时间

### 14.4 标签输出要求

- 最终标签总数为 3-5 个
- 必须至少包含 1 个【任务】标签和 1 个【方法/模型】标签
- 必须额外输出 `主任务标签`、`主方法标签`、`补充标签`
- `主任务标签` 和 `主方法标签` 都只能有 1 个，且必须来自最终标签集合
- `音频大模型` 与 `语音大模型` 二选一；使用 `多模态模型` 时通常不再重复标 `音视频`

### 14.5 输出契约变更检查清单

当 `prompts/deep-analysis.md` 或评分/标签规范发生变化时，至少检查以下内容：

1. 确认 `scripts/utils.js` 中的 `loadPrompt()` 能正确读取 `prompts/` 目录下的 markdown 文件
2. `scripts/utils.js` 与 `scripts/utils.py` 是否仍能正确解析 `### 机器摘要`、标签和评分字段
3. 抽样检查 `data/current/deep-analysis-result.json`，确认存在 `rank_bucket`、`primary_task_tag`、`primary_method_tag`
4. 验证博客发布脚本产物，确认榜单、单篇页和热门方向正确显示新字段
5. 验证微信/小红书脚本产物，确认文案中没有因字段缺失导致的空值或格式错位

---

---

## 参考与致谢

- 本项目在设计和实现过程中参考了 [speech-paper-daily-skill](https://github.com/JusperLee/speech-paper-daily-skill) 的思路与结构