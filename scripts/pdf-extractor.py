#!/usr/bin/env python3
"""
PDF 提取器 - 从本地 PDF 提取文本和图片
供 Node.js 分析流程调用

用法:
    python3 pdf-extractor.py <pdf_path> [--max-text-chars 100000] [--max-images 10] [--max-base64-chars 500000]

输出: JSON 到 stdout
{
  "success": true,
  "text": "提取的文本...",
  "textLength": 12345,
  "pageCount": 5,
  "images": [
    {
      "index": 0,
      "page": 1,
      "width": 800,
      "height": 600,
      "format": "png",
      "base64": "iVBORw0KGgo...",
      "size": 12345
    }
  ],
  "imageCount": 5,
  "error": null
}
"""

import sys
import os
import json
import base64
import argparse
import io
import re
import fitz  # PyMuPDF

# 禁用 MuPDF 错误消息输出到 stdout，避免污染 JSON 输出
fitz.set_messages(path='/dev/null')

# 尝试导入 Pillow，如果不可用则跳过图片缩放
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


# 架构/结果图关键词（用于页面渲染优先级排序）
FIGURE_KEYWORDS = [
    'architecture', 'framework', 'model', 'network', 'design',
    'overview', 'pipeline', 'structure', 'schematic',
    'results', 'experiments', 'comparison', 'performance',
    'ablation', 'evaluation', 'visualization'
]


def is_likely_avatar(width, height):
    """判断是否为头像/小图标：接近正方形且面积较小"""
    if width <= 0 or height <= 0:
        return False
    ratio = min(width, height) / max(width, height)
    area = width * height
    return ratio > 0.75 and 1000 < area < 60000


def is_fragment_strip(width, height):
    """判断是否为表格/图表碎片条带：超宽且很矮"""
    if height <= 0 or width <= 0:
        return False
    wh_ratio = width / height
    return wh_ratio > 8 and width > 600 and height < 250


def is_page_mostly_text(page_pixmap_bytes):
    """检查渲染的页面是否主要是文字（白色背景占比过高）"""
    if not HAS_PIL:
        return False
    try:
        img = Image.open(io.BytesIO(page_pixmap_bytes)).convert('L')
        small = img.resize((32, 32))
        pixels = list(small.getdata())
        avg = sum(pixels) / len(pixels)
        return avg > 248  # 几乎全白
    except Exception:
        return False


def render_page(page, dpi=150):
    """渲染页面为图片，裁剪页眉页脚，返回 PNG bytes 或 None"""
    rect = page.rect
    # 裁剪顶部 100px（会议标题/页眉）和底部 40px（页码/页脚）
    clip = fitz.Rect(rect.x0, rect.y0 + 100, rect.x1, rect.y1 - 40)
    if clip.height <= 200 or clip.width <= 200:
        return None

    try:
        pix = page.get_pixmap(dpi=dpi, clip=clip)
        img_bytes = pix.tobytes("png")
        if is_page_mostly_text(img_bytes):
            return None
        return img_bytes
    except Exception:
        return None


def get_page_figure_priority(page_text):
    """计算页面的图表优先级分数，越高越值得渲染"""
    text_lower = page_text.lower()
    score = 0
    # 有 Figure 引用加分
    if re.search(r'figure\s*\d+', text_lower):
        score += 3
    if re.search(r'fig\.\s*\d+', text_lower):
        score += 2
    # 架构/结果关键词加分
    for kw in FIGURE_KEYWORDS:
        if kw in text_lower:
            score += 2
    # 有表格加分
    if 'table' in text_lower:
        score += 1
    return score


def resize_image_if_needed(image_bytes, max_base64_chars=500000, max_dimension=1200):
    """
    如果图片太大，缩放并压缩以适应 base64 大小限制。
    返回处理后的图片字节。
    """
    if not HAS_PIL:
        return image_bytes

    # base64 编码后大约增长 33%，所以原始大小限制约为 max_base64_chars * 0.75
    target_raw_size = int(max_base64_chars * 0.7)

    if len(image_bytes) <= target_raw_size:
        return image_bytes

    try:
        img = Image.open(io.BytesIO(image_bytes))

        # 如果尺寸过大，先缩放到合理尺寸
        w, h = img.size
        if w > max_dimension or h > max_dimension:
            ratio = min(max_dimension / w, max_dimension / h)
            new_w = int(w * ratio)
            new_h = int(h * ratio)
            img = img.resize((new_w, new_h), Image.LANCZOS)

        # 尝试不同质量级别来压缩
        for quality in [85, 70, 50, 30]:
            buf = io.BytesIO()
            # 转换为 RGB（处理RGBA等模式）
            if img.mode in ('RGBA', 'P'):
                rgb_img = img.convert('RGB')
            else:
                rgb_img = img
            rgb_img.save(buf, format='JPEG', quality=quality, optimize=True)
            result = buf.getvalue()
            if len(result) <= target_raw_size:
                return result

        # 如果还是太大，进一步缩小尺寸
        while True:
            w, h = img.size
            if w < 200 or h < 200:
                break
            img = img.resize((w // 2, h // 2), Image.LANCZOS)
            buf = io.BytesIO()
            rgb_img = img.convert('RGB') if img.mode in ('RGBA', 'P') else img
            rgb_img.save(buf, format='JPEG', quality=30, optimize=True)
            result = buf.getvalue()
            if len(result) <= target_raw_size:
                return result

        return result
    except Exception:
        # 处理失败，返回原始图片
        return image_bytes


def extract_pdf_content(pdf_path, max_text_chars=100000, max_images=10, max_base64_chars=500000,
                        min_image_dim=100, min_image_area=10000):
    """
    从 PDF 提取文本和图片

    Args:
        pdf_path: PDF 文件路径
        max_text_chars: 最大文本字符数
        max_images: 最大提取图片数
        max_base64_chars: 单张图片 base64 字符数上限
        min_image_dim: 最小图片宽高
        min_image_area: 最小图片面积（宽*高）
    """
    if not os.path.exists(pdf_path):
        return {"success": False, "error": f"文件不存在: {pdf_path}"}

    try:
        doc = fitz.open(pdf_path)
    except Exception as e:
        return {"success": False, "error": f"打开 PDF 失败: {e}"}

    try:
        page_count = len(doc)

        # 提取文本
        all_text_parts = []
        for page_num in range(page_count):
            page = doc[page_num]
            text = page.get_text()
            if text and text.strip():
                all_text_parts.append(text)

        full_text = "\n\n".join(all_text_parts)
        text_length = len(full_text)

        # 截断文本
        if len(full_text) > max_text_chars:
            full_text = full_text[:max_text_chars]

        # 检测异常内容（如IEEE版权页而非论文正文）
        content_warning = None
        if full_text:
            copyright_markers = full_text.count('©2026 IEEE') + full_text.count('Authorized licensed use')
            non_empty_lines = [l.strip() for l in full_text.split('\n') if l.strip()]
            if copyright_markers >= 3 and len(non_empty_lines) > 0:
                # 检查前5行是否主要是版权/会议信息
                header_lines = non_empty_lines[:5]
                header_text = ' '.join(header_lines)
                if 'IEEE' in header_text and 'ICASSP' in header_text:
                    content_warning = f"检测到PDF内容可能为会议版权页而非论文正文（版权标记出现{copyright_markers}次）"

        # 阶段1: 页面渲染补充 —— 优先渲染包含架构图/结果图的页面，捕获矢量图形
        images = []
        page_priorities = []
        for page_num in range(page_count):
            page = doc[page_num]
            text = page.get_text()
            priority = get_page_figure_priority(text)
            page_imgs = page.get_images(full=True)

            # 如果一页有很多碎片图（被拆分的架构图/表格），优先渲染
            if len(page_imgs) > 3:
                try:
                    avg_h = sum(
                        doc.extract_image(img[0]).get("height", 0)
                        for img in page_imgs
                    ) / len(page_imgs)
                    if avg_h < 200:
                        priority += 5  # 碎片页高优先级
                except Exception:
                    pass

            if priority > 0:
                page_priorities.append((page_num, priority))

        # 按优先级排序，优先渲染高分页面
        page_priorities.sort(key=lambda x: -x[1])
        max_render = min(5, max_images)

        for page_num, _ in page_priorities[:max_render]:
            if len(images) >= max_images:
                break

            page = doc[page_num]
            rendered = render_page(page, dpi=150)
            if not rendered:
                continue

            # 压缩渲染图
            processed = resize_image_if_needed(rendered, max_base64_chars, max_dimension=1600)
            b64 = base64.b64encode(processed).decode("utf-8")
            if len(b64) > max_base64_chars:
                continue

            images.append({
                "index": len(images),
                "page": page_num + 1,
                "width": 0,  # 渲染图尺寸未知，标记为0
                "height": 0,
                "format": "png",
                "base64": b64,
                "size": len(processed),
                "rendered": True  # 标记为渲染图
            })

        # 阶段2: 提取 PDF 内嵌图片（过滤小图标、碎片、头像）
        seen_xrefs = set()
        for page_num in range(page_count):
            if len(images) >= max_images:
                break

            page = doc[page_num]
            page_images = page.get_images(full=True)

            for img_info in page_images:
                if len(images) >= max_images:
                    break

                xref = img_info[0]
                if xref in seen_xrefs:
                    continue
                seen_xrefs.add(xref)

                try:
                    base_image = doc.extract_image(xref)
                    if not base_image:
                        continue

                    image_bytes = base_image["image"]
                    ext = base_image["ext"]  # png, jpeg, etc.
                    width = base_image.get("width", 0)
                    height = base_image.get("height", 0)

                    # 过滤空/损坏图片（文件大小异常小）
                    if len(image_bytes) < 1500:
                        continue

                    # 过滤小图标
                    area = width * height
                    if width < min_image_dim or height < min_image_dim:
                        continue
                    if area < min_image_area:
                        continue

                    # 过滤头像/小图标（正方形且面积小）
                    if is_likely_avatar(width, height):
                        continue

                    # 过滤表格/图表碎片条带（超宽且很矮）
                    if is_fragment_strip(width, height):
                        continue

                    # 过滤纯黑/纯白图片（渲染失败或空白遮罩）
                    if HAS_PIL and ext in ('png', 'jpg', 'jpeg'):
                        try:
                            img = Image.open(io.BytesIO(image_bytes)).convert('RGB').resize((8, 8))
                            px = list(img.getdata())
                            avg = sum(sum(p) // 3 for p in px) / len(px)
                            if avg < 8 or avg > 252:  # 纯黑或纯白
                                continue
                        except Exception:
                            pass

                    # 压缩/缩放图片
                    processed_bytes = resize_image_if_needed(image_bytes, max_base64_chars)

                    # 转换为 base64
                    b64 = base64.b64encode(processed_bytes).decode("utf-8")

                    # 最终检查 base64 长度
                    if len(b64) > max_base64_chars:
                        continue

                    images.append({
                        "index": len(images),
                        "page": page_num + 1,
                        "width": width,
                        "height": height,
                        "format": ext,
                        "base64": b64,
                        "size": len(processed_bytes)
                    })
                except Exception:
                    continue

        return {
            "success": True,
            "text": full_text,
            "textLength": text_length,
            "pageCount": page_count,
            "images": images,
            "imageCount": len(images),
            "warning": content_warning,
            "error": None
        }

    finally:
        doc.close()


def main():
    parser = argparse.ArgumentParser(description="从 PDF 提取文本和图片")
    parser.add_argument("pdf_path", help="PDF 文件路径")
    parser.add_argument("--max-text-chars", type=int, default=100000, help="最大文本字符数")
    parser.add_argument("--max-images", type=int, default=10, help="最大提取图片数")
    parser.add_argument("--max-base64-chars", type=int, default=500000, help="单张图片 base64 字符数上限")
    parser.add_argument("--min-image-dim", type=int, default=100, help="最小图片宽高")
    parser.add_argument("--min-image-area", type=int, default=10000, help="最小图片面积")
    args = parser.parse_args()

    result = extract_pdf_content(
        args.pdf_path,
        max_text_chars=args.max_text_chars,
        max_images=args.max_images,
        max_base64_chars=args.max_base64_chars,
        min_image_dim=args.min_image_dim,
        min_image_area=args.min_image_area
    )

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
