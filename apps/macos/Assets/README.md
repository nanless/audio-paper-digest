# Mac 应用图标

`AppIcon.png` 是本次构建使用的 1024 × 1024 RGBA 图标。石墨底上的单一象牙色折页以斜向负形连接“原文与理解”，橙色内折只作次级强调。去掉上一版的展开书、三柱图与纸纹。设计研究、三个方向的比较和验收范围见 [图标设计研究](../../../docs/mac-app-icon-design.md)。

上一版深青展开书图标已被用户明确拒绝，不能将前一轮“尺寸可读”记录当作审美认可。本次选择 C「石墨边注」作为候选；A「朱红折页」和 B「钴蓝文献」仅作探索，不用于构建。候选经独立视觉对比，但审美仍以用户反馈为准。

使用 imagegen 技能和内置 `image_gen`，未调用项目论文模型账号池。原始输出：`01a162ed-db18-7000-8840-f9262fd79e83/exec-b3dc30ac-d9e7-4113-964c-e6c830bb84f8.png`，1280 × 1280 RGBA，SHA-256 `0c1b41ede3030e46df5caa8bd9759328bbca6283222de76ea57cf9f35f43f6f1`。仅使用系统 sips 等比缩至 1024 × 1024，保留透明度，未修画或追加装饰。生产 PNG SHA-256：`18b7f280a530e6a881bc7017a1f78d6ba2c1a65741dea6a04116782433e3fbfb`。

当前交付为静态 PNG → ICNS，包含 16 至 1024 的 10 层尺寸。不是 Icon Composer 分层动态玻璃，也不宣称支持其动态效果。透明边缘、浅深背景、实际 ICNS 小尺寸和安装后图标须分别验收。16px 橙色内折不承担识别任务，黑白主体和负形为主要识别依据。

## 最终生成提示词

```text
Use case: logo-brand. Asset type: finished macOS desktop research application icon. Premium minimal dark editorial identity. One bold ivory continuous folded paper mark shaped like a clean abstract page turning, with two large interleaved offset rectangular planes and one deep diagonal negative space; a small restrained burnt-orange inner fold is the single accent, physically part of the mark. Charcoal graphite squircle tile, clean satin surface, almost flat but beautifully precise subtle edge lighting, restrained depth. Sophisticated, quiet, serious, instantly memorable. No realistic book pages, no paper texture, no bars, no waveform, no magnifying glass, no feather, no stars or sparkle or AI ornaments, no text, no rounded scroll, no chrome, no heavy gradients. Huge simple silhouette with strong figure-ground contrast and 16 pixel readability. Front-facing orthographic, meticulously balanced optical alignment, tile about88% square canvas and mark about65% tile. Transparent outside tile, no surrounding scene/mockup/contact sheet. One icon only, finished professional artwork.
```
