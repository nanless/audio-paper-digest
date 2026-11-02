# 本机论文样稿

[English](README.en.md)

此目录存放客户端测试使用的原始 MiCLA PDF 和 3 张科学图裁图，不纳入 Git。正文及公开元数据在上级 `sample.json` 中，原 PDF 与图的版权仍属于原作者。

原论文：[MiCLA v1 官方页面](https://arxiv.org/abs/2610.27491v1)

PDF：[MiCLA v1 原始 PDF](https://arxiv.org/pdf/2610.27491v1.pdf)

中文导读：[MiCLA 论文讲解](https://nanless.github.io/audio-paper-digest-blog/posts/2026-10-21-micla-mixture-to-constituent-latent-alignment-for-2610-27491/)

先按上级 [准备说明](../README.md#准备本机样稿)取得并指定这份 PDF，再由脚本生成三个固定裁图。准备脚本只读取明确指定的 PDF，不连接网络、不启动论文生产、不修改封存来源。

客户端和测试按样稿清单中的预期 SHA-256 校验值核对实际文件字节。文件缺失或字节不符时，不能作为已核验材料；仅有同名文件也不能证明准备完成。
