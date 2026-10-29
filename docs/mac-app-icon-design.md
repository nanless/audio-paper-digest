# 论文速递工作台 Mac 图标设计

当前采用“石墨边注”图标。石墨底板上的单一象牙白折页，用斜向负形连接“原文与理解”；橙色内折作为次要强调。主体保持简洁，不把 PDF、笔记、模型和 Zotero 等所有功能堆进一个图案。

## 视觉原则

- 小尺寸先看轮廓、黑白对比和主要留白，不依赖微小橙色细节识别。
- 图文阅读是产品主体，图标采用安静、清楚的文献形体。
- 浅深背景下都应保持透明边缘干净，避免白边、碎边与过重投影。
- 使用自身图形，不使用或模仿 Zotero 等第三方品牌标志。

## 资产与构建

源图为[AppIcon.png](../apps/macos/Assets/AppIcon.png)，1024 × 1024 RGBA。构建从同一源图生成 16 至 1024 像素的 10 层 ICNS，回读尺寸，并比较最高分辨率层的实际像素。

当前是静态 PNG 与 ICNS，不包含 Icon Composer 分层，也不提供动态玻璃、清透或着色外观。未来改变格式时须同时处理系统支持和旧系统回退。

## 维护检查

| 场景 | 检查内容 |
|---|---|
| 16、32 像素 | 主体可识别，主要负形不闭合，去掉强调色仍能辨认 |
| 64 像素及以上 | 转角、比例和光源一致，细节服务于主体 |
| 浅深背景、灰度 | 透明外沿干净，颜色不是唯一识别依据 |
| 实际 ICNS、Finder、Dock | 尺寸齐全、视觉体量适当，显示与源资产一致 |

修改应保留现有视觉身份，并对实际资产做独立视觉检查。1.0.1 新包的静态资产检查与应用启动后的呈现分别说明，详见[验证范围](mac-app-validation.md)。

设计参考：[Apple App icons](https://developer.apple.com/design/human-interface-guidelines/app-icons)、[Icon Composer](https://developer.apple.com/icon-composer/)、[Zotero 品牌资源](https://www.zotero.org/support/brand)。
