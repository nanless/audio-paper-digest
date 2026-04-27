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
import fitz  # PyMuPDF

# 尝试导入 Pillow，如果不可用则跳过图片缩放
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


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

        # 提取图片（过滤小图标，按页面顺序）
        images = []
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

                    # 过滤小图标
                    area = width * height
                    if width < min_image_dim or height < min_image_dim:
                        continue
                    if area < min_image_area:
                        continue

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
