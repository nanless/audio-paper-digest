# Mac 应用图标

`AppIcon.png` 是构建使用的 1024 × 1024 RGBA 图标。深墨青底上的暖纸白双页表示论文阅读，右页三个渐高的负形槽表示音频信号；两者组成同一个标记。图标不含文字、字母、AI 星形或通用文件折角。

图像通过 imagegen 技能调用内置 `image_gen` 生成，没有调用项目模型账号池。原始输出文件为 `exec-b14dce78-aa7a-4770-bfdb-9d2383d97e7b.png`，生成记录目录为 `01a16bd8-2122-7e00-874c-4c8635d653d5`。工具实际返回 1254 × 1254 RGBA，原文件 SHA-256 为 `f082a048638329a2e3cc2c8d38db1461df75842e44a83b251c6c93899d7579c7`。

为准备 macOS 资产，使用系统 `sips` 居中保留 1152 × 1152 画布、收整外侧透明留白，再等比缩放至 1024 × 1024。没有重画标记、改变配色或加入背景。生产文件 SHA-256 为 `43fbc5ddf45a23a488f25e295d82c4a329b3700c2e2d41de4102b184179b6c4b`。构建应从这个已保存的 PNG 生成各尺寸 ICNS，不在构建期间重新生成图像。

已在浅色、深色背景检查 16、32、64、128、256 像素显示。16 像素保留双页主轮廓，32、64 像素能辨认右页声纹；小尺寸不依赖细小纸张纹理。四个画布角的透明度均为零，外边缘没有不透明矩形背景。

## 生成提示词

```text
Use case: logo-brand. Asset type: final production macOS desktop application icon, exactly 1024 x 1024 pixels, RGBA transparent canvas. Create a superb, distinctive icon for a serious audio-paper research and reading application. One large tactile abstract emblem fuses the gesture of an open paper folio with the rhythm of an audio signal: two broad warm-ivory folded paper wings meet in a deliberate central valley; three bold, clean negative-space signal cuts are integrated into the right paper wing. It should feel like one original sculptural symbol, not separate book and equalizer clip-art, not an alphabet letter. Confident, restrained, highly memorable silhouette that survives 16, 32 and 64 pixels. Place the emblem on a deep ink-teal rounded-square tile, subtle top-left soft lighting, gently beveled paper edges, almost-flat premium material, understated depth and very fine paper grain only at large scale. The tile has the familiar softly continuous macOS icon corner shape, centered, with approximately 64 pixels of transparent margin on every side and generous internal breathing room. Palette: deep ink blue-teal and dark petrol, warm paper white/ivory, a restrained brighter teal reflection. Exactly one icon, perfectly frontal and centered; no perspective mockup, no desktop, no device, no UI. Outside the rounded-square tile must be actual alpha transparency, including the corners of the canvas; do not paint a checkerboard, white background or dark rectangular background. No text, no Chinese characters, no letters, no numbers, no border labels, no sparkle or AI star, no generic document sheet with folded corner, no microphone/headphones, no magnifying glass, no tiny ornamental details. Produce a fully finished clean icon asset, not a presentation sheet.
```
