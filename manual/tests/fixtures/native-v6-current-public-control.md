# native v6 合成测试资料

`native-v6-current-public-control.json` 保存项目正式入口生成的原始内容，以 gzip/base64 压缩。论文编号、模型、助手任务和审查通过声明均为本地测试输入，不证明真实模型调用或真实论文实验。不包含环境配置、密钥或论文运行数据。

三项压缩数据共 34817 字节；外层 JSON 因 base64 编码为 47144 字节：

| 项目 | 原字节数 | 压缩字节数 | 原 SHA-256 |
| --- | ---: | ---: | --- |
| canonical | 176363 | 26273 | 979461621e0c8d26ce0669454842c24776b582f38244174ec4a9d0d2bb125bb4 |
| authorDraft | 64125 | 7962 | d1559150178e4a00ca7f4de9ecb5def0fe76683f8a85ad292da4b9a0294d901e |
| fulltext | 4271 | 582 | ca7064b133f003e4c9ed673df2267d12e14efe979792c99a06c8532607daae36 |

`canonical` 来自实际四角色提交、修订绑定、封印、来源检查点、spec6 和深度录入。包含原系统临时目录的绝对路径；只读检查不通过这些路径读取文件，也不改写路径或重新计算其旧凭证。该样例来自修复后的成功输出，不是把旧双层包装失败结果改写成成功。

`authorDraft` 与 `fulltext` 是同次合成任务的草稿和全文。新流程辅助函数将草稿作为测试模板，在新的临时目录建立新的来源身份、任务包、实际开始记录和四份输出；评分、可读性审查与最终修订均实际提交和核验。它不把原草稿的旧文件 SHA 当成新任务凭证。正式审查声明是测试构造的格式输入；全文预检查、绑定和提交使用真实公开函数，不替换检查器。

读取辅助函数限制每项压缩数据小于 30000 字节，解压结果最多 200000 字节，并核对固定原 SHA 和原大小。查看原始 canonical 可在仓库根运行：

```bash
node -e "process.stdout.write(require('./manual/tests/helpers/current-v6-public-pipeline.cjs').savedBytes('canonical'))"
```

也可将 `canonical` 换为 `authorDraft` 或 `fulltext`。此命令只解压输出资料，不运行模型或发布。
