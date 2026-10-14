# 旧记录核验与独立人工审查

整批 Manual v5/v6/shadow 写作、任务分派、spec 和 records 生产已退役。新任务统一使用 [日更、会议与历史三流程](../docs/three-workflows.md)。只有用户明确授权单篇人工补救时，才进行受控修正或独立审查，保留真实来源、原稿、费用和失败记录。

本目录保留 `analysis-contract.js`、正式数据验证和发布器实际调用的旧来源、作者策略、签名、正文与教程合同核验模块。旧合同 Prompt 已从工作树移除，核验时通过受控 Git 索引取回原字节并核对原声明 SHA，不补签旧结果；两份冻结的编辑依据文件继续保留原字节，不能改写。

独立单页审查仍使用以下共享补救入口：

```bash
npm run blog:manual-plan -- --date YYYY-MM-DD
npm run blog:manual-attest -- --date YYYY-MM-DD ...
npm run blog:manual-review -- --date YYYY-MM-DD ...
```

参数及审查材料以对应程序的解析器和当前页面生成清单为准；上述省略号须补齐实际参数。真实审查与图片证据必须绑定最终页面字节，不能人工伪造已通过的模型审查记录。

兼容测试通过 `npm run test:compat` 运行；完整验收仍是 `npm run verify`，会同时运行三流程和旧记录核验测试。
