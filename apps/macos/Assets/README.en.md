# Mac application icon

[简体中文](README.md)

This directory contains the icon source used to build the Mac application. The current design, “石墨边注” (Graphite Margin Note), combines a graphite base, an ivory folded page, and a small orange inner fold. At small sizes, recognition depends mainly on the black-and-white silhouette and empty space between shapes, also called negative space. Orange is a secondary detail.

The build reads [AppIcon.png](AppIcon.png), a 1024 × 1024 pixel image with transparency. It generates ten ICNS representations from 16 through 1024 pixels for the system's different display sizes, then checks their dimensions and the highest-resolution pixels. Both the source PNG and generated ICNS enter the application.

This is a static icon. It does not include Icon Composer layers or materials that change with system appearance. Changes should preserve the existing visual identity and check light and dark backgrounds, transparent edges, small-size silhouettes, and actual Finder and Dock presentation.

See the [icon design explanation (Chinese)](../../../docs/mac-app-icon-design.md). This README does not participate in icon generation and is not copied into the application.
