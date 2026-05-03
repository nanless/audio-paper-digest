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
    'ablation', 'evaluation', 'visualization',
    'annotated', 'training', 'flow', 'diagram', 'method',
    'approach', 'system', 'module', 'component'
]

# 外部水印/图标检测关键词
WATERMARK_KEYWORDS = ['shutterstock', 'getty images', 'istock', 'adobe stock',
                      'depositphotos', 'dreamstime', 'alamy', 'fotolia',
                      '123rf', 'bigstock', 'canstock', 'pixabay']


def is_likely_avatar(width, height):
    """判断是否为头像/小图标：接近正方形且面积较小"""
    if width <= 0 or height <= 0:
        return False
    ratio = min(width, height) / max(width, height)
    area = width * height
    return ratio > 0.75 and 1000 < area < 150000


def is_decorative_icon(width, height):
    """判断是否为装饰性图标/Logo/小照片：正方形-ish 且不够大"""
    if width <= 0 or height <= 0:
        return False
    ratio = min(width, height) / max(width, height)
    area = width * height
    # 正方形-ish 小图 (头像、Logo、图标、teaser 图)
    if ratio > 0.7 and area < 350000:
        return True
    # 特别小的图
    if width < 250 or height < 180:
        return True
    # 近似正方形的中等图（可能是 mascot/logo）
    if ratio > 0.6 and width < 450 and height < 650 and area < 300000:
        return True
    return False


def is_fragment_strip(width, height):
    """判断是否为表格/图表碎片条带：超宽且很矮"""
    if height <= 0 or width <= 0:
        return False
    wh_ratio = width / height
    return wh_ratio > 6 and width > 600 and height < 200


def is_watermarked_image(image_bytes):
    """检测图片是否包含外部图库水印（通过检查二进制内容）"""
    # 检查常见的 PNG/JPG 水印签名
    text_signatures = [b'shutterstock', b'gettyimages', b'istockphoto',
                       b'adobe stock', b'depositphotos', b'dreamstime',
                       b'alamy.com', b'fotolia', b'123rf', b'bigstockphoto',
                       b'canstockphoto', b'pixabay']
    lower_bytes = image_bytes.lower()
    for sig in text_signatures:
        if sig in lower_bytes:
            return True
    return False


def is_rendered_watermarked(page, clip_rect):
    """检测渲染的页面区域内是否包含外部图库水印文字（通过提取PDF文本）"""
    watermark_keywords = ['shutterstock', 'getty images', 'istock', 'adobe stock',
                          'depositphotos', 'dreamstime', 'alamy', 'fotolia',
                          '123rf', 'bigstock', 'canstock', 'pixabay']
    try:
        text = page.get_textbox(clip_rect).lower()
        for kw in watermark_keywords:
            if kw in text:
                return True
    except Exception:
        pass
    return False


def is_page_mostly_text(page_pixmap_bytes):
    """检查渲染的页面是否主要是文字（白色背景占比过高）"""
    if not HAS_PIL:
        return False
    try:
        img = Image.open(io.BytesIO(page_pixmap_bytes)).convert('L')
        # 使用更大的采样以提高准确性
        small = img.resize((64, 64))
        pixels = list(small.getdata())
        avg = sum(pixels) / len(pixels)
        variance = sum((p - avg) ** 2 for p in pixels) / len(pixels)
        std = variance ** 0.5
        # 纯文字页：亮度高且方差小；图表页：亮度可能也高但方差大
        if avg > 242 and std < 8:
            return True
        # 额外检测：如果页面非常亮但文字密度高（深色像素少且集中）
        if avg > 245 and std < 12:
            return True
        return False
    except Exception:
        return False


def _find_figure_captions(page):
    """找到页面上所有 Figure/Table caption 的位置，返回 [(y0, y1)] 列表"""
    captions = []
    try:
        blocks = page.get_text("blocks")
    except Exception:
        return captions
    for b in blocks:
        text = b[4].strip()
        # 严格匹配：必须以 Figure/Fig/Table + 数字 开头
        # 如 "Figure 1:", "Fig. 2.", "Table 1 —", "Figure 3 -" 等
        if re.match(r'(?:Figure|Fig\.?|Table)\s*\d+\s*[:.\-\u2014\u2013]', text, re.I):
            rect = fitz.Rect(b[:4])
            captions.append((rect.y0, rect.y1))
    return captions


def _get_page_elements(page):
    """获取页面上的所有内容元素位置，返回 (text_ranges, drawing_rects, image_rects)"""
    caption_blocks = set()
    text_ranges = []
    try:
        blocks = page.get_text("blocks")
    except Exception:
        blocks = []
    for b in blocks:
        text = b[4].strip()
        y0, y1 = round(b[1], 1), round(b[3], 1)
        if re.match(r'(?:Figure|Fig\.?|Table)\s*\d+\s*[:.\-\u2014\u2013]', text, re.I):
            caption_blocks.add((y0, y1))
        else:
            text_ranges.append((y0, y1))

    drawing_rects = []
    try:
        for d in page.get_drawings():
            r = d.get('rect')
            if r and r.width > 5 and r.height > 5:
                drawing_rects.append(r)
    except Exception:
        pass

    image_rects = []
    try:
        seen = set()
        for img in page.get_images(full=True):
            for r in page.get_image_rects(img[0]):
                key = (round(r.x0, 1), round(r.y0, 1), round(r.x1, 1), round(r.y1, 1))
                if key not in seen:
                    seen.add(key)
                    image_rects.append(r)
    except Exception:
        pass

    return text_ranges, drawing_rects, image_rects


def _cluster_rects(rects, margin=30):
    """对矩形进行聚类，相交或接近的合并"""
    clusters = []
    for r in rects:
        merged = False
        for c in clusters:
            expanded = fitz.Rect(c.x0 - margin, c.y0 - margin, c.x1 + margin, c.y1 + margin)
            if expanded.intersects(r):
                c |= r
                merged = True
                break
        if not merged:
            clusters.append(fitz.Rect(r))

    changed = True
    while changed:
        changed = False
        new_clusters = []
        for r in clusters:
            merged = False
            for c in new_clusters:
                expanded = fitz.Rect(c.x0 - margin, c.y0 - margin, c.x1 + margin, c.y1 + margin)
                if expanded.intersects(r):
                    c |= r
                    merged = True
                    changed = True
                    break
            if not merged:
                new_clusters.append(fitz.Rect(r))
        clusters = new_clusters

    return clusters


def _find_largest_graphic_cluster(page, search_rect, min_area=3000):
    """在搜索区域内找到最大的 drawing/image 聚类"""
    _, drawing_rects, image_rects = _get_page_elements(page)
    all_elements = []
    for r in drawing_rects + image_rects:
        if search_rect.intersects(r):
            inter = search_rect.intersect(r)
            if inter and inter.width > 5 and inter.height > 5:
                all_elements.append(r)

    if not all_elements:
        return None

    clusters = _cluster_rects(all_elements, margin=40)
    clusters = [c for c in clusters if c.width * c.height >= min_area]
    if not clusters:
        return None

    clusters.sort(key=lambda c: c.width * c.height, reverse=True)
    return clusters[0]


def _find_figure_top_bound(caption_y0, text_ranges, drawing_rects, image_rects, page_top, max_figure_height=280):
    """
    综合 text blocks + drawing/image 元素，从 caption 向上找 figure 的上边界。
    优先看 drawing/image 元素的分布，其次看 text blocks。
    """
    # 收集 caption 上方所有相关元素
    relevant_text = [(y0, y1) for y0, y1 in text_ranges
                     if y1 < caption_y0 and y0 > caption_y0 - max_figure_height - 50]
    relevant_text.sort(key=lambda x: x[0], reverse=True)

    relevant_drawings = [r for r in drawing_rects
                         if r.y1 < caption_y0 and r.y0 > caption_y0 - max_figure_height - 50]

    relevant_images = [r for r in image_rects
                       if r.y1 < caption_y0 and r.y0 > caption_y0 - max_figure_height - 50]

    all_graphics = relevant_drawings + relevant_images
    if all_graphics:
        # 如果有 graphic 元素，figure 的上边界是最高 graphic 元素的 y0
        graphic_top = min(r.y0 for r in all_graphics)
        # 再往上看看有没有紧挨着的文字块
        for y0, y1 in relevant_text:
            if y1 < graphic_top and graphic_top - y1 < 30:
                # 文字块紧挨着 graphic，可能是 figure 的标题/标注
                continue
            elif y1 < graphic_top:
                # 文字块在 graphic 上方且有距离，figure 从 graphic 顶部开始
                break
        return max(page_top, graphic_top - 5)

    # 没有 graphic 元素，退化为 text-based 方法
    if not relevant_text:
        return max(page_top, caption_y0 - max_figure_height)

    nearest = relevant_text[0]
    gap = caption_y0 - nearest[1]
    if gap > 20:
        return max(page_top, nearest[1] + 2)
    else:
        last_y = nearest[0]
        for y0, y1 in relevant_text[1:]:
            gap = last_y - y1
            if gap > 25:
                return max(page_top, y1 + 2)
            last_y = y0
        return max(page_top, caption_y0 - max_figure_height)


def _find_figure_bottom_bound(caption_y1, text_ranges, drawing_rects, image_rects, page_bottom, max_figure_height=280):
    """
    从 caption 向下找 figure 的下边界。
    优先看 drawing/image 元素的分布（找到最低的 graphic 元素），
    其次看 text blocks（找到 figure 下方第一个正文段落）。
    """
    # 收集 caption 下方所有相关元素
    relevant_text = [(y0, y1) for y0, y1 in text_ranges
                     if y0 > caption_y1 and y1 < caption_y1 + max_figure_height + 100]
    relevant_text.sort(key=lambda x: x[0])

    relevant_drawings = [r for r in drawing_rects
                         if r.y0 > caption_y1 and r.y1 < caption_y1 + max_figure_height + 100]

    relevant_images = [r for r in image_rects
                       if r.y0 > caption_y1 and r.y1 < caption_y1 + max_figure_height + 100]

    all_graphics = relevant_drawings + relevant_images
    if all_graphics:
        # 如果有 graphic 元素，figure 的下边界是最低 graphic 元素的 y1
        graphic_bottom = max(r.y1 for r in all_graphics)
        # 往下看看有没有紧挨着的文字块（caption 子标签如 (a) (b)）
        for y0, y1 in relevant_text:
            if y0 > graphic_bottom and y0 - graphic_bottom < 25:
                # 文字块紧挨着 graphic，可能是子 caption
                continue
            elif y0 > graphic_bottom:
                # 文字块在 graphic 下方且有距离，figure 到 graphic 底部结束
                break
        return min(page_bottom, graphic_bottom + 5)

    # 没有 graphic 元素，用 text-based 方法
    if not relevant_text:
        return min(page_bottom, caption_y1 + max_figure_height)

    # 找 caption 下方第一个 text block
    nearest = relevant_text[0]
    gap = nearest[0] - caption_y1
    if gap > 20:
        # 第一个 text block 离 caption 较远，figure 可能就在中间
        return min(page_bottom, nearest[0] - 3)
    else:
        # text block 紧挨着 caption，继续往下找 gap
        last_y = nearest[1]
        for y0, y1 in relevant_text[1:]:
            gap = y0 - last_y
            if gap > 25:
                return min(page_bottom, y0 - 3)
            last_y = y1
        return min(page_bottom, caption_y1 + max_figure_height)


def _clip_to_figure_region(page, dpi=150):
    """
    多策略 figure 提取：
    1. 优先使用 caption 定位（最准确）
    2. 没有 caption 时用 drawing/image 聚类
    3. 最后回退到页面上半部
    返回 list of (png_bytes, clip_rect)。
    """
    rect = page.rect
    captions = _find_figure_captions(page)
    text_ranges, drawing_rects, image_rects = _get_page_elements(page)
    results = []

    # 策略1：caption 定位
    if captions:
        for cap_y0, cap_y1 in captions:
            # 尝试 caption 上方（caption 在 figure 下方）
            top = _find_figure_top_bound(cap_y0, text_ranges, drawing_rects, image_rects, rect.y0 + 80)
            bottom = cap_y0 - 3
            height = bottom - top

            # 检测是否可能是误提取的正文：
            # 如果高度很大且 crop 内没有任何 graphic 元素，说明 caption 下方没有 figure
            if height >= 60:
                clip_check = fitz.Rect(rect.x0, top, rect.x1, bottom)
                has_graphics = any(
                    clip_check.intersects(r) for r in drawing_rects + image_rects
                )
                # 没 graphic 元素且高度很大 → 可能是正文，强制切到 caption 上方模式
                if not has_graphics and height > 180:
                    height = 0  # 强制进入下方分支

            # 上方太小或无 figure，则尝试下方（caption 在 figure 上方）
            if height < 60:
                top = cap_y1 + 3
                bottom = _find_figure_bottom_bound(cap_y1, text_ranges, drawing_rects, image_rects, rect.y1 - 40)

            if bottom - top < 60 or bottom - top > 340:
                continue

            clip = fitz.Rect(rect.x0, top, rect.x1, bottom)

            # 检查裁剪区域是否包含外部水印
            if is_rendered_watermarked(page, clip):
                continue

            try:
                pix = page.get_pixmap(dpi=dpi, clip=clip)
                img_bytes = pix.tobytes("png")
                results.append((img_bytes, clip))
            except Exception:
                continue

    # 去重：如果多个 caption 产生高度重叠的裁剪区域，只保留第一个
    if len(results) > 1:
        deduped = [results[0]]
        for img_bytes, clip in results[1:]:
            is_duplicate = False
            for _, existing_clip in deduped:
                # 计算垂直方向重叠比例
                overlap = min(clip.y1, existing_clip.y1) - max(clip.y0, existing_clip.y0)
                h1, h2 = clip.height, existing_clip.height
                if h1 > 0 and h2 > 0:
                    overlap_ratio = overlap / min(h1, h2)
                    if overlap_ratio > 0.70:
                        is_duplicate = True
                        break
            if not is_duplicate:
                deduped.append((img_bytes, clip))
        results = deduped

    # 策略2：drawing/image 聚类（用于无 caption 的页面）
    if not results:
        search_rect = fitz.Rect(rect.x0, rect.y0 + 80, rect.x1, rect.y1 - 40)
        cluster = _find_largest_graphic_cluster(page, search_rect, min_area=5000)
        if cluster:
            margin = 15
            clip = fitz.Rect(
                max(rect.x0, cluster.x0 - margin),
                max(rect.y0 + 80, cluster.y0 - margin),
                min(rect.x1, cluster.x1 + margin),
                min(rect.y1 - 40, cluster.y1 + margin)
            )
            if clip.height >= 80 and clip.width >= 200:
                if is_rendered_watermarked(page, clip):
                    pass  # 有水印，跳过
                else:
                    try:
                        pix = page.get_pixmap(dpi=dpi, clip=clip)
                        img_bytes = pix.tobytes("png")
                        # 聚类裁剪也不应用 is_page_mostly_text，避免误杀架构图
                        results.append((img_bytes, clip))
                    except Exception:
                        pass

    # 策略3：回退到页面上半部（仅在此应用 is_page_mostly_text）
    if not results:
        # 结构预检：text blocks 很多且 drawing/image 很少 → 纯文字页，跳过
        is_text_page = False
        try:
            blocks = page.get_text("blocks")
            text_block_count = len([b for b in blocks if len(b[4].strip()) > 15])
            drawing_count = len(page.get_drawings())
            image_count = len(page.get_images(full=True))
            if text_block_count > 10 and (drawing_count + image_count) < 3:
                is_text_page = True
        except Exception:
            pass

        if not is_text_page:
            mid = rect.y0 + rect.height * 0.50
            clip = fitz.Rect(rect.x0, rect.y0 + 80, rect.x1, mid)
            if clip.height >= 150:
                if is_rendered_watermarked(page, clip):
                    pass  # 有水印，跳过
                else:
                    try:
                        pix = page.get_pixmap(dpi=dpi, clip=clip)
                        img_bytes = pix.tobytes("png")
                        if not is_page_mostly_text(img_bytes):
                            results.append((img_bytes, clip))
                    except Exception:
                        pass

    return results


def render_page(page, dpi=150):
    """渲染页面为图片，裁剪页眉页脚，返回 PNG bytes 或 None"""
    rect = page.rect
    # 裁剪顶部 100px（会议标题/页眉）和底部 40px（页码/页脚）
    clip = fitz.Rect(rect.x0, rect.y0 + 100, rect.x1, rect.y1 - 40)
    if clip.height <= 200 or clip.width <= 200:
        return None

    # 结构检测：如果页面 text blocks 很多且 drawing/image 很少，跳过
    try:
        blocks = page.get_text("blocks")
        text_block_count = len([b for b in blocks if len(b[4].strip()) > 15])
        drawing_count = len(page.get_drawings())
        image_count = len(page.get_images(full=True))
        if text_block_count > 10 and (drawing_count + image_count) < 3:
            return None
    except Exception:
        pass

    # 检查渲染区域是否包含外部水印
    if is_rendered_watermarked(page, clip):
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
    # 包含架构/流程图相关词汇的页面额外加分
    arch_keywords = ['architecture', 'framework', 'pipeline', 'schematic',
                     'overview', 'system design', 'model architecture']
    for kw in arch_keywords:
        if kw in text_lower:
            score += 3
    # 包含流程/方法图相关词汇额外加分
    flow_keywords = ['annotated', 'training pipeline', 'inference pipeline',
                     'workflow', 'procedure', 'process']
    for kw in flow_keywords:
        if kw in text_lower:
            score += 2
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
        max_render = min(8, max_images)  # 增加到8页以捕获更多架构图

        for page_num, priority in page_priorities[:max_render]:
            if len(images) >= max_images:
                break

            page = doc[page_num]
            # 跳过纯文字页：文本很长且内嵌图很少，且没有矢量图形或figure caption
            page_text = page.get_text()
            page_imgs = page.get_images(full=True)
            text_len = len(page_text.strip())
            if text_len > 3500 and len(page_imgs) < 2:
                # 检查页面是否有真正的 figure caption（而非正文引用）
                fig_captions = _find_figure_captions(page)
                # 检查是否有大量矢量 drawing（可能是 TikZ 图）
                drawings = page.get_drawings()
                # 如果既没有 caption 又没有足够 drawing，则跳过
                if len(fig_captions) == 0 and len(drawings) < 15:
                    continue

            # 优先尝试只提取 figure 区域（而非整页）
            figure_regions = _clip_to_figure_region(page, dpi=150)
            if not figure_regions:
                # 回退到整页渲染前先检查：如果页面 text blocks 很多但无 caption，
                # 大概率是纯文字页，跳过以避免提取正文
                try:
                    blocks = page.get_text("blocks")
                    has_caption = any(
                        re.match(r'(Figure|Fig\.?|Table)\s*\d+\s*[:.\-\u2014\u2013]', b[4].strip(), re.I)
                        for b in blocks
                    )
                    if len(blocks) > 12 and not has_caption:
                        continue
                except Exception:
                    pass
                # 回退到整页渲染
                rendered = render_page(page, dpi=150)
                if rendered:
                    figure_regions = [(rendered, None)]
                else:
                    continue

            for img_bytes, clip_rect in figure_regions:
                if len(images) >= max_images:
                    break

                # 压缩渲染图
                processed = resize_image_if_needed(img_bytes, max_base64_chars, max_dimension=1600)
                b64 = base64.b64encode(processed).decode("utf-8")
                if len(b64) > max_base64_chars:
                    continue

                width = int(clip_rect.width) if clip_rect else 0
                height = int(clip_rect.height) if clip_rect else 0
                images.append({
                    "index": len(images),
                    "page": page_num + 1,
                    "width": width,
                    "height": height,
                    "format": "png",
                    "base64": b64,
                    "size": len(processed),
                    "rendered": True,
                    "priority": priority
                })

        # 阶段2: 提取 PDF 内嵌图片（过滤小图标、碎片、头像）
        # 优先保留渲染图，内嵌图按面积排序只保留最大的几张
        embedded_candidates = []
        seen_xrefs = set()
        for page_num in range(page_count):
            page = doc[page_num]
            page_images = page.get_images(full=True)

            for img_info in page_images:
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

                    # 严格尺寸过滤
                    area = width * height
                    if width < 250 or height < 180:  # 最小尺寸
                        continue
                    if width > 1400 or height > 1000:  # 最大尺寸
                        continue
                    if area < 60000:  # 最小面积 (~250x240)
                        continue

                    # 过滤装饰性图标/Logo/小照片
                    if is_decorative_icon(width, height):
                        continue

                    # 过滤表格/图表碎片条带（超宽且很矮）
                    if is_fragment_strip(width, height):
                        continue

                    # 过滤极端宽高比
                    ratio = width / height if height > 0 else 0
                    if ratio < 0.4 or ratio > 4.0:
                        continue

                    # 过滤外部图库水印图片
                    if is_watermarked_image(image_bytes):
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

                    embedded_candidates.append({
                        "page": page_num + 1,
                        "width": width,
                        "height": height,
                        "format": ext,
                        "image_bytes": image_bytes,
                        "area": area
                    })
                except Exception:
                    continue

        # 按面积从大到小排序内嵌图，优先保留大图（更可能是架构图/结果图）
        embedded_candidates.sort(key=lambda x: -x["area"])
        # 为内嵌图分配剩余配额（渲染图最多占 max_images 的 60%，内嵌图占 40%）
        render_count = sum(1 for img in images if img.get("rendered"))
        remaining_slots = max_images - render_count
        embedded_limit = min(remaining_slots, max(3, max_images // 3))

        for candidate in embedded_candidates[:embedded_limit]:
            if len(images) >= max_images:
                break

            image_bytes = candidate["image_bytes"]
            ext = candidate["format"]
            width = candidate["width"]
            height = candidate["height"]
            page_num = candidate["page"]

            # 压缩/缩放图片
            processed_bytes = resize_image_if_needed(image_bytes, max_base64_chars)

            # 转换为 base64
            b64 = base64.b64encode(processed_bytes).decode("utf-8")

            # 最终检查 base64 长度
            if len(b64) > max_base64_chars:
                continue

            images.append({
                "index": len(images),
                "page": page_num,
                "width": width,
                "height": height,
                "format": ext,
                "base64": b64,
                "size": len(processed_bytes),
                "rendered": False  # 标记为内嵌图
            })

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
