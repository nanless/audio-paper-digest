#!/usr/bin/env python3
"""
检测一张图是否主要是"文字段落截图"（垃圾配图）。

启发式方法（不依赖 OCR）：
1. 转灰度 + 二值化
2. 行投影找"暗带"（连续的暗像素行 = 文字行）
3. 文字段落特征：>= N 个等宽暗带 + 暗像素总占比合理 + 行高均匀

用法（自检）：
    python3 garbage_image_filter.py /path/to/image.png         # 单张图
    python3 garbage_image_filter.py /path/to/dir --recursive   # 批量

可作为 module 用：
    from garbage_image_filter import is_image_text_dominant
"""
import os
import sys
import argparse

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False


def is_image_text_dominant(image_path, debug=False):
    """
    判断一张图是否主要是文字段落（应作为垃圾图过滤）。

    返回 (is_text, debug_info_dict)
    - is_text: bool
    - debug_info_dict: 用于人工审视启发式决策细节
    """
    info = {'reason': '', 'metrics': {}}
    if not HAS_PIL:
        info['reason'] = 'PIL not available'
        return False, info
    try:
        img = Image.open(image_path).convert('L')
        w, h = img.size
        if w < 100 or h < 100:
            info['reason'] = 'image too small to assess'
            return False, info

        # 用原图分辨率分析（缩小会丢失文字细节）。
        # 但限制最大边到 ~1500，避免超大图慢
        if w > 1500 or h > 1500:
            scale = 1500 / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)))
            w, h = img.size

        pixels = list(img.getdata())
        n = w * h

        # 暗像素阈值放宽到 < 200（包含抗锯齿过的文字灰边）
        DARK_THRESH = 200
        dark_count = sum(1 for p in pixels if p < DARK_THRESH)
        dark_ratio = dark_count / n if n else 0
        info['metrics']['dark_ratio'] = round(dark_ratio, 4)
        info['metrics']['size'] = (w, h)

        # 行投影：每行的暗像素数
        # 行内暗像素超过 4% 视为"暗带"（即文字行）
        row_thresh = w * 0.04
        bands = []
        in_band = False
        start = 0
        for y in range(h):
            base = y * w
            d = 0
            for x in range(w):
                if pixels[base + x] < DARK_THRESH:
                    d += 1
                    if d > row_thresh:
                        break
            is_dark_row = d > row_thresh
            if is_dark_row and not in_band:
                start = y
                in_band = True
            elif not is_dark_row and in_band:
                bands.append((start, y))
                in_band = False
        if in_band:
            bands.append((start, h))

        info['metrics']['band_count'] = len(bands)
        if not bands:
            info['reason'] = 'no dark bands'
            return False, info

        band_heights = [e - s for s, e in bands]
        avg_h = sum(band_heights) / len(band_heights)
        var = sum((bh - avg_h) ** 2 for bh in band_heights) / len(band_heights)
        std_h = var ** 0.5
        info['metrics']['avg_band_h'] = round(avg_h, 2)
        info['metrics']['std_band_h'] = round(std_h, 2)

        sum_band_h = sum(band_heights)
        coverage = sum_band_h / h
        info['metrics']['band_coverage'] = round(coverage, 4)

        # 文字段落典型特征：
        # - 至少 18 个暗带（即文字行——经验阈值，正文/附录/prompt 都至少 ~20 行）
        # - 平均行高 3..15 像素（标准正文行高）
        # - 行高均匀（std/avg < 0.8）
        # - 暗像素占比 0.04..0.20（白底黑字段落）
        # - 暗带覆盖率 0.25..0.55（行间空白存在）
        cond_band_count = len(bands) >= 18
        cond_band_height = 3 <= avg_h <= 15
        cond_band_uniform = avg_h > 0 and std_h / avg_h < 0.85
        cond_dark_ratio = 0.03 <= dark_ratio <= 0.22
        cond_band_coverage = 0.20 <= coverage <= 0.60

        # 宽矮裁剪文字段(如 1275x206 仅几段附录正文) 行数会少, 用宽高比补一条
        aspect = w / max(h, 1)
        cond_wide_short = aspect >= 3 and len(bands) >= 5

        info['metrics']['conds'] = {
            'band_count>=18': cond_band_count,
            'avg_h_in_3_15': cond_band_height,
            'std/avg<0.85': cond_band_uniform,
            'dark_ratio_in_03_22': cond_dark_ratio,
            'coverage_20_60': cond_band_coverage,
            'wide_short_5bands': cond_wide_short,
        }
        # 主条件: 行数足够多的标准文字段
        is_text_normal = (cond_band_count and cond_band_height
                          and cond_band_uniform and cond_dark_ratio
                          and cond_band_coverage)
        # 补充条件: 宽矮裁剪 (低 band_count 但其余特征仍是文字)
        is_text_wide = (cond_wide_short and cond_band_height
                        and cond_band_uniform and cond_dark_ratio
                        and cond_band_coverage)
        is_text = is_text_normal or is_text_wide

        if is_text:
            info['reason'] = 'text-dominant by row-projection heuristic'
        else:
            info['reason'] = 'not flagged'
        return is_text, info
    except Exception as e:
        info['reason'] = f'exception: {e}'
        return False, info


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('path')
    ap.add_argument('--recursive', action='store_true', help='扫描目录')
    ap.add_argument('--debug', action='store_true')
    args = ap.parse_args()

    if os.path.isfile(args.path):
        is_text, info = is_image_text_dominant(args.path, debug=True)
        flag = 'TEXT' if is_text else 'OK'
        print(f"[{flag}] {args.path}")
        if args.debug:
            print(f"      {info}")
        return

    if not os.path.isdir(args.path):
        print(f"❌ 不是文件也不是目录: {args.path}", file=sys.stderr)
        sys.exit(1)

    text_count = 0
    total = 0
    for root, _, files in os.walk(args.path):
        for f in sorted(files):
            if not f.lower().endswith(('.png', '.jpg', '.jpeg')):
                continue
            full = os.path.join(root, f)
            total += 1
            is_text, info = is_image_text_dominant(full, debug=True)
            if is_text:
                text_count += 1
                print(f"[TEXT] {full}")
                if args.debug:
                    print(f"      {info['metrics']}")
            elif args.debug:
                print(f"[OK]   {full}")
                print(f"      {info['metrics']}")
        if not args.recursive:
            break
    print(f"\n汇总: {text_count}/{total} 张图被判为文字主导", file=sys.stderr)


if __name__ == '__main__':
    main()
