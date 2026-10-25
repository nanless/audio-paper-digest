# 论文速递 Android

Android 原生客户端读取网站已经发布的论文目录与图文导读，提供原始 PDF 阅读、本机研究、笔记、离线资料及可选的 Zotero 和坚果云连接。手机使用底部导航和单阅读面板；宽窗口在打开 PDF 后才显示并排阅读。

当前处于开发验收阶段，debug 安装成功不代表正式发行或真实服务已经验收。完整要求见 [跨端实施范围](../../docs/android-app-plan.md)、[逐项验收表](../../docs/android-feature-parity.md)、[Zotero 调研](../../docs/android-zotero-research.md)及[备份合同](../../docs/android-cloud-contract.md)。Mac 仍有独立验收，不能用 Android 的结果替代。

## 本机构建

需要 Node、JDK 17、Android SDK 平台 37、Build Tools 36.0.0，以及 Mac 子项目已锁定的 KaTeX 依赖。Gradle Wrapper 随源码保存；首次构建需要联网下载其锁定版本与依赖。`build.sh` 优先使用现有 `JAVA_HOME` 与 `ANDROID_HOME`，也能识别本机 Homebrew 的安装路径，不修改全局设置。

在仓库根目录执行：

```bash
./apps/android/build.sh :app:assembleDebug
./apps/android/test.sh
```

默认安装包位于 `apps/android/app/build/outputs/apk/debug/app-debug.apk`。它只用于开发测试。正式 APK 必须另做发行签名、优化构建、安装及升级验证，私钥和口令不能进入仓库。

## 设备验证

合同单测与 Lint 不能替代 Android 系统、原生 PDF 组件和系统文件选择器验证。已准备独立的 `PaperDigest_QA_API28` 和 `PaperDigest_QA_API35` 模拟器；不要使用或改动用户已有的其他模拟器。

```bash
./apps/android/install.sh emulator-5580
./apps/android/test.sh --device emulator-5580
```

安装和设备测试脚本对模拟器检查实际 AVD 名称。设备测试必须显式选择一个序列号，也可使用单一 `ANDROID_SERIAL`；缺少选择、多选、未知模拟器或设备未就绪时停止，不向所有已连接设备派发。不要把某次设备或夹具的结果写成所有设备通过。公开图文样稿、合成离线包、模拟服务和真实账号的验收分别保留证据。`.qa/`、构建输出、设备状态及本地签名材料均已忽略。

## 资料与凭据

研究资料保存在应用自己的目录，使用与 Mac 兼容的完整备份和离线包合同。模型输入、原始响应、真实用量、文章版本、PDF 原件、笔记及批注都保留来源。重启、同步和恢复备份不会自动重发已派发的付费请求。

模型、Zotero 与坚果云凭据分别由本机 Android Keystore 保护，不随研究备份迁移。Android 的 Zotero 使用单独配置的官方 Web API；不能继承 Mac 本地许可。坚果云使用第三方应用密码，采用独立研究目录，不进入 Zotero 的附件同步目录。

Android 代码不读取项目 `.env`，APK 不打包生产运行数据、个人研究、账号或密码。公开样稿与数学排版资源通过 `prepare-assets.mjs` 从已经锁定的公开材料准备，不触发论文重分析。
