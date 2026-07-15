#!/usr/bin/env python3
"""Deterministic local debug/fallback compositor for paper-digest visuals.

The default final-asset workflow uses built-in full image generation. This
Pillow renderer remains available for tests, diagnosis, and offline fallback;
importing it is side-effect free.
"""

from project_env import load_project_env

load_project_env()

import argparse
import json
import os
import re
import tempfile
from pathlib import Path

from log_setup import setup_script_logging
from runtime_guard import require_external_runtime

try:
    from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageOps
except ImportError as exc:  # pragma: no cover - exercised only on misconfigured hosts
    raise RuntimeError("visual:render:debug 需要 Pillow：python3 -m pip install Pillow") from exc


CANVAS_WIDTH = 2160
CANVAS_HEIGHT = 4552
MAX_PNG_BYTES = 8 * 1024 * 1024
MAX_SPEC_BYTES = 2 * 1024 * 1024
MAX_INPUT_IMAGE_BYTES = 32 * 1024 * 1024

PALETTE = {
    "background": "#F7F2E8",
    "ink": "#26384A",
    "muted": "#607285",
    "line": "#C8D0CC",
    "mist": "#DCE9EE",
    "sage": "#DDE8D8",
    "coral": "#F1D8CF",
    "apricot": "#F3E1C5",
    "lavender": "#E5DFEC",
    "white": "#FFFDF8",
    "accent": "#547C8A",
    "shadow": "#D9D2C6",
    "fiber": "#E8E0D2",
    "tape_blue": "#C9DEE1",
    "tape_apricot": "#EBD7B8",
}

FONT_CANDIDATES = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/PrivateFrameworks/FontServices.framework/Resources/Reserved/PingFangUI.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
)


class SpecError(ValueError):
    """Raised when a visual-summary spec is unsafe or malformed."""


def resolve_cjk_font():
    configured = os.environ.get("PD_VISUAL_CJK_FONT", "").strip()
    candidates = (configured,) + FONT_CANDIDATES if configured else FONT_CANDIDATES
    for candidate in candidates:
        path = Path(candidate).expanduser()
        if path.is_file():
            try:
                ImageFont.truetype(str(path), 24)
            except OSError:
                if configured and candidate == configured:
                    raise SpecError(f"PD_VISUAL_CJK_FONT 不是可用字体: {path}")
                continue
            return path
    raise SpecError(
        "未找到可用 CJK 字体；请在项目 .env 设置 PD_VISUAL_CJK_FONT=/absolute/font/path"
    )


def load_font(font_path, size, *, bold=False):
    # PingFang/Heiti collections expose a usable regular face at index 0.  A
    # slightly larger regular face remains more portable than guessing TTC indices.
    return ImageFont.truetype(str(font_path), int(size), index=0)


def _tokens(text):
    return re.findall(r"\n|[A-Za-zÀ-ÖØ-öø-ÿ0-9][A-Za-zÀ-ÖØ-öø-ÿ0-9._+%:/\-–—]*|\s+|.", str(text))


def wrap_text(draw, text, font, max_width):
    """Wrap mixed CJK/Latin text without splitting Latin technical tokens."""
    if max_width <= 0:
        raise ValueError("max_width 必须为正数")
    lines = []
    current = ""
    for token in _tokens(text):
        if token == "\n":
            lines.append(current.rstrip())
            current = ""
            continue
        if token.isspace():
            if current and not current.endswith(" "):
                current += " "
            continue
        candidate = current + token
        if not current or draw.textlength(candidate, font=font) <= max_width:
            current = candidate
            continue
        lines.append(current.rstrip())
        if draw.textlength(token, font=font) <= max_width:
            current = token
            continue
        # A pathological long token (usually a URL) is split deterministically.
        current = ""
        for char in token:
            candidate = current + char
            if current and draw.textlength(candidate, font=font) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
    if current or not lines:
        lines.append(current.rstrip())
    return lines


def draw_wrapped_text(draw, xy, text, font, fill, max_width, *, spacing=14, max_lines=None):
    x, y = xy
    lines = wrap_text(draw, text, font, max_width)
    if max_lines is not None and len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1].rstrip("…")
        while last and draw.textlength(last + "…", font=font) > max_width:
            last = last[:-1]
        lines[-1] = last + "…"
    bbox = draw.textbbox((0, 0), "国Ag", font=font)
    line_height = bbox[3] - bbox[1]
    for line in lines:
        draw.text((x, y), line, font=font, fill=fill)
        y += line_height + spacing
    return y


def _require_string(value, field, *, max_length=4000):
    if not isinstance(value, str) or not value.strip():
        raise SpecError(f"{field} 必须是非空字符串")
    if len(value) > max_length:
        raise SpecError(f"{field} 过长（最多 {max_length} 字符）")
    return value.strip()


def _validate_chart(chart, field):
    if chart is None:
        return
    if not isinstance(chart, dict) or chart.get("type") not in {"bars", "metrics"}:
        raise SpecError(f"{field}.chart.type 只支持 bars 或 metrics")
    items = chart.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 8:
        raise SpecError(f"{field}.chart.items 必须包含 1–8 项")
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            raise SpecError(f"{field}.chart.items[{index}] 必须是对象")
        _require_string(item.get("label"), f"{field}.chart.items[{index}].label", max_length=100)
        _require_string(str(item.get("display", "")), f"{field}.chart.items[{index}].display", max_length=40)
        if chart["type"] == "bars":
            value = item.get("value")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
                raise SpecError(f"{field}.chart.items[{index}].value 必须是非负数")


def _validate_diagram(diagram, field):
    if diagram is None:
        return
    if not isinstance(diagram, dict):
        raise SpecError(f"{field}.diagram 必须是对象")
    _require_string(diagram.get("caption"), f"{field}.diagram.caption", max_length=160)
    columns = diagram.get("columns")
    if not isinstance(columns, list) or not 2 <= len(columns) <= 6:
        raise SpecError(f"{field}.diagram.columns 必须包含 2–6 列")
    node_ids = set()
    node_count = 0
    for c_index, column in enumerate(columns):
        if not isinstance(column, list) or not 1 <= len(column) <= 4:
            raise SpecError(f"{field}.diagram.columns[{c_index}] 必须包含 1–4 个节点")
        for n_index, node in enumerate(column):
            node_field = f"{field}.diagram.columns[{c_index}][{n_index}]"
            if not isinstance(node, dict):
                raise SpecError(f"{node_field} 必须是对象")
            node_id = _require_string(node.get("id"), f"{node_field}.id", max_length=40)
            if not re.fullmatch(r"[A-Za-z0-9_-]+", node_id) or node_id in node_ids:
                raise SpecError(f"{node_field}.id 非法或重复: {node_id}")
            node_ids.add(node_id)
            node_count += 1
            _require_string(node.get("label"), f"{node_field}.label", max_length=80)
            if node.get("group") is not None:
                _require_string(node["group"], f"{node_field}.group", max_length=40)
    if node_count > 16:
        raise SpecError(f"{field}.diagram 节点最多 16 个")
    edges = diagram.get("edges", [])
    if not isinstance(edges, list) or len(edges) > 24:
        raise SpecError(f"{field}.diagram.edges 最多 24 条")
    for e_index, edge in enumerate(edges):
        edge_field = f"{field}.diagram.edges[{e_index}]"
        if not isinstance(edge, dict) or edge.get("from") not in node_ids or edge.get("to") not in node_ids:
            raise SpecError(f"{edge_field} 必须引用已定义节点")
        if edge.get("label") is not None:
            _require_string(edge["label"], f"{edge_field}.label", max_length=30)


def validate_spec(spec):
    if not isinstance(spec, dict):
        raise SpecError("spec 根节点必须是 JSON 对象")
    kind = spec.get("kind", "paper")
    if kind not in {"paper", "digest-cover"}:
        raise SpecError("spec.kind 只支持 paper 或 digest-cover")
    _require_string(spec.get("title"), "title", max_length=600)
    if kind == "paper":
        chapters = spec.get("chapters")
        if not isinstance(chapters, list) or len(chapters) != 4:
            raise SpecError("paper spec 必须恰好包含四个 chapters")
        for index, chapter in enumerate(chapters):
            field = f"chapters[{index}]"
            if not isinstance(chapter, dict):
                raise SpecError(f"{field} 必须是对象")
            _require_string(chapter.get("heading"), f"{field}.heading", max_length=100)
            paragraphs = chapter.get("paragraphs")
            if not isinstance(paragraphs, list) or not 1 <= len(paragraphs) <= 6:
                raise SpecError(f"{field}.paragraphs 必须包含 1–6 段")
            for p_index, paragraph in enumerate(paragraphs):
                _require_string(paragraph, f"{field}.paragraphs[{p_index}]", max_length=800)
            modules = chapter.get("modules", [])
            if not isinstance(modules, list) or len(modules) > 8:
                raise SpecError(f"{field}.modules 最多 8 项")
            for m_index, module in enumerate(modules):
                _require_string(module, f"{field}.modules[{m_index}]", max_length=80)
            _validate_chart(chapter.get("chart"), field)
            _validate_diagram(chapter.get("diagram"), field)
            if chapter.get("figureCaption") is not None:
                _require_string(chapter["figureCaption"], f"{field}.figureCaption", max_length=180)
    else:
        _require_string(spec.get("subtitle"), "subtitle", max_length=300)
        directions = spec.get("directions")
        if not isinstance(directions, list) or not 1 <= len(directions) <= 8:
            raise SpecError("digest-cover directions 必须包含 1–8 项")
        for index, direction in enumerate(directions):
            _require_string(direction, f"directions[{index}]", max_length=80)
        ranking = spec.get("ranking")
        if not isinstance(ranking, list) or not 1 <= len(ranking) <= 10:
            raise SpecError("digest-cover ranking 必须包含 1–10 项")
        for index, item in enumerate(ranking):
            if not isinstance(item, dict):
                raise SpecError(f"ranking[{index}] 必须是对象")
            _require_string(item.get("title"), f"ranking[{index}].title", max_length=500)
            if "label" in item:
                _require_string(item["label"], f"ranking[{index}].label", max_length=80)
            if "primaryTask" in item:
                _require_string(item["primaryTask"], f"ranking[{index}].primaryTask", max_length=80)
            if "score" in item:
                _require_string(str(item["score"]), f"ranking[{index}].score", max_length=20)
            if "rank" in item and (
                not isinstance(item["rank"], int) or isinstance(item["rank"], bool)
                or item["rank"] != index + 1
            ):
                raise SpecError(f"ranking[{index}].rank 必须是与降序顺序一致的整数")
    return spec


def load_spec(path):
    spec_path = Path(path).expanduser()
    if spec_path.suffix.lower() != ".json" or not spec_path.is_file() or spec_path.is_symlink():
        raise SpecError(f"spec 路径必须是存在的 .json 文件: {spec_path}")
    if spec_path.stat().st_size > MAX_SPEC_BYTES:
        raise SpecError("spec 文件超过 2 MiB")
    try:
        with spec_path.open("r", encoding="utf-8") as handle:
            spec = json.load(handle)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SpecError(f"无法读取 JSON spec: {exc}") from exc
    return validate_spec(spec)


def validate_image_path(path, field):
    if path is None:
        return None
    image_path = Path(path).expanduser()
    if image_path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bin"}:
        raise SpecError(f"{field} 只支持 PNG/JPEG/WebP 或已校验的图片缓存 .bin")
    if not image_path.is_file() or image_path.is_symlink():
        raise SpecError(f"{field} 必须是存在的普通文件: {image_path}")
    if image_path.stat().st_size > MAX_INPUT_IMAGE_BYTES:
        raise SpecError(f"{field} 超过 32 MiB")
    try:
        with Image.open(image_path) as image:
            image.verify()
    except (OSError, ValueError) as exc:
        raise SpecError(f"{field} 不是有效图片: {image_path}") from exc
    return image_path.resolve()


def validate_output_path(path, input_paths=()):
    output = Path(path).expanduser()
    if output.suffix.lower() != ".png":
        raise SpecError("输出路径必须以 .png 结尾")
    if output.exists() and (output.is_dir() or output.is_symlink()):
        raise SpecError("输出路径不能是目录或符号链接")
    resolved = output.resolve()
    if any(resolved == Path(item).resolve() for item in input_paths if item):
        raise SpecError("输出路径不能覆盖输入文件")
    output.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def _rounded_panel(draw, box, fill, *, outline=PALETTE["line"], radius=42, width=3):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def _add_paper_texture(canvas, *, seed=20260714):
    """Add subtle deterministic fibres without making the page look dirty."""
    draw = ImageDraw.Draw(canvas)
    state = seed & 0x7FFFFFFF

    def next_value(limit):
        nonlocal state
        state = (1103515245 * state + 12345) & 0x7FFFFFFF
        return state % limit

    # Short, low-contrast fibres survive palette optimization better than noise,
    # while remaining nearly invisible behind body copy.
    for _ in range(4200):
        x = next_value(CANVAS_WIDTH)
        y = next_value(CANVAS_HEIGHT)
        length = 2 + next_value(10)
        color = PALETTE["fiber"] if next_value(4) else "#EEE6D9"
        if next_value(3):
            draw.line((x, y, min(CANVAS_WIDTH - 1, x + length), y), fill=color, width=1)
        else:
            draw.line((x, y, x, min(CANVAS_HEIGHT - 1, y + length)), fill=color, width=1)


def _paper_panel(draw, box, fill, *, radius=42, tape=None, deckle=True):
    """Draw a clean editorial paper card with a restrained stationery accent."""
    x0, y0, x1, y1 = map(int, box)
    draw.rounded_rectangle(
        (x0 + 16, y0 + 20, x1 + 16, y1 + 20),
        radius=radius,
        fill=PALETTE["shadow"],
    )
    draw.rounded_rectangle(
        (x0, y0, x1, y1),
        radius=radius,
        fill=fill,
        outline="#C4CAC5",
        width=2,
    )
    if deckle:
        # One short irregular lower edge is enough to suggest cut paper. Keep it
        # away from content and avoid a scrapbook-like border around every side.
        start = x0 + 72
        end = min(x1 - 72, start + 420)
        points = [(start, y1 - 1)]
        step = 30
        for index, x in enumerate(range(start + step, end, step)):
            points.append((x, y1 + (5 if index % 2 else 1)))
        points.extend(((end, y1 - 1), (start, y1 - 1)))
        draw.polygon(points, fill=fill)
    if tape:
        tape_width = 210
        tape_left = x1 - 310 if tape == "right" else x0 + 92
        tape_color = PALETTE["tape_blue"] if tape == "right" else PALETTE["tape_apricot"]
        draw.polygon(
            (
                (tape_left, y0 - 20),
                (tape_left + tape_width, y0 - 9),
                (tape_left + tape_width - 8, y0 + 43),
                (tape_left + 7, y0 + 32),
            ),
            fill=tape_color,
        )


def _draw_paper_cut_decor(draw):
    """A few quiet paper-cut shapes establish visual rhythm in empty margins."""
    draw.ellipse((-90, 160, 215, 465), fill="#E3ECE3")
    draw.polygon(((1980, 290), (2160, 170), (2160, 520), (2025, 455)), fill="#F0DCD4")
    draw.arc((60, 4200, 410, 4520), 195, 350, fill="#C9D9D7", width=16)


def _paste_contained(canvas, path, box):
    if path is None:
        return
    x0, y0, x1, y1 = map(int, box)
    with Image.open(path) as source:
        image = ImageOps.exif_transpose(source).convert("RGBA")
        # Scientific figures often contain very large uniform margins. Crop only
        # when the detected content occupies a meaningfully smaller area.
        background = Image.new("RGBA", image.size, image.getpixel((0, 0)))
        bbox = ImageChops.difference(image, background).getbbox()
        if bbox:
            left, top, right, bottom = bbox
            if (right - left) * (bottom - top) < image.width * image.height * 0.90:
                pad_x = max(8, int((right - left) * 0.025))
                pad_y = max(8, int((bottom - top) * 0.025))
                image = image.crop((max(0, left - pad_x), max(0, top - pad_y), min(image.width, right + pad_x), min(image.height, bottom + pad_y)))
        image.thumbnail((max(1, x1 - x0), max(1, y1 - y0)), Image.Resampling.LANCZOS)
        x = x0 + (x1 - x0 - image.width) // 2
        y = y0 + (y1 - y0 - image.height) // 2
        canvas.paste(image, (x, y), image)


def _draw_module_flow(draw, modules, box, font):
    if not modules:
        return
    x0, y0, x1, y1 = box
    gap = 24
    count = len(modules)
    width = (x1 - x0 - gap * (count - 1)) / count
    y_mid = (y0 + y1) / 2
    for index, label in enumerate(modules):
        left = x0 + index * (width + gap)
        right = left + width
        _rounded_panel(draw, (left, y0, right, y1), PALETTE["white"], radius=26, width=2)
        lines = wrap_text(draw, label, font, width - 30)[:2]
        line_h = draw.textbbox((0, 0), "国Ag", font=font)[3]
        ty = y_mid - len(lines) * line_h / 2
        for line in lines:
            tw = draw.textlength(line, font=font)
            draw.text((left + (width - tw) / 2, ty), line, font=font, fill=PALETTE["ink"])
            ty += line_h + 5
        if index < count - 1:
            start = (right + 5, y_mid)
            end = (right + gap - 5, y_mid)
            draw.line((start, end), fill=PALETTE["accent"], width=5)
            draw.polygon(((end[0], end[1]), (end[0] - 15, end[1] - 10), (end[0] - 15, end[1] + 10)), fill=PALETTE["accent"])


def _draw_module_grid_flow(draw, modules, box, fonts):
    """Use a spacious paper-note flow when no verified architecture is available."""
    if not modules:
        return
    x0, y0, x1, y1 = map(int, box)
    columns = 3
    rows = (len(modules) + columns - 1) // columns
    gap_x, gap_y = 38, 42
    card_w = (x1 - x0 - gap_x * (columns - 1)) / columns
    card_h = min(230, (y1 - y0 - gap_y * (rows - 1)) / rows)
    colors = (PALETTE["white"], "#F8FBF6", "#FFF9F3")
    centers = []
    for index, label in enumerate(modules):
        row, column = divmod(index, columns)
        left = x0 + column * (card_w + gap_x)
        top = y0 + row * (card_h + gap_y)
        _rounded_panel(draw, (left, top, left + card_w, top + card_h), colors[index % len(colors)], radius=30, width=2)
        draw.text((left + 24, top + 18), f"{index + 1:02d}", font=fonts["index"], fill=PALETTE["muted"])
        lines = wrap_text(draw, label, fonts["small_bold"], card_w - 48)[:2]
        line_h = draw.textbbox((0, 0), "国Ag", font=fonts["small_bold"])[3]
        text_top = top + card_h * 0.48 - len(lines) * (line_h + 5) / 2
        for line in lines:
            text_w = draw.textlength(line, font=fonts["small_bold"])
            draw.text((left + (card_w - text_w) / 2, text_top), line, font=fonts["small_bold"], fill=PALETTE["ink"])
            text_top += line_h + 5
        centers.append((left + card_w / 2, top + card_h / 2, row, column))
    for index in range(len(centers) - 1):
        x_a, y_a, row_a, col_a = centers[index]
        x_b, y_b, row_b, col_b = centers[index + 1]
        if row_a == row_b:
            start, end = (x_a + card_w / 2 + 6, y_a), (x_b - card_w / 2 - 8, y_b)
        else:
            # Row numbers preserve sequence; a long wraparound connector would
            # cross the grid and falsely imply a direct branch relationship.
            continue
        draw.line((start, end), fill=PALETTE["accent"], width=5)
        draw.ellipse((end[0] - 7, end[1] - 7, end[0] + 7, end[1] + 7), fill=PALETTE["accent"])


def _draw_structured_diagram(draw, diagram, box, fonts):
    """Render verified branch/merge semantics from explicit nodes and edges."""
    x0, y0, x1, y1 = map(int, box)
    draw.text((x0, y0), diagram["caption"], font=fonts["metric_label"], fill=PALETTE["muted"])
    panel_top = y0 + 52
    _rounded_panel(draw, (x0, panel_top, x1, y1), PALETTE["white"], radius=34, width=2)
    columns = diagram["columns"]
    gap_x = 38
    content_left, content_right = x0 + 36, x1 - 36
    content_top, content_bottom = panel_top + 34, y1 - 34
    column_w = (content_right - content_left - gap_x * (len(columns) - 1)) / len(columns)
    positions = {}
    group_colors = {}
    color_cycle = (PALETTE["mist"], PALETTE["sage"], PALETTE["coral"], PALETTE["apricot"], PALETTE["lavender"])
    for c_index, column in enumerate(columns):
        gap_y = 24
        card_h = min(142, (content_bottom - content_top - gap_y * (len(column) - 1)) / len(column))
        stack_h = card_h * len(column) + gap_y * (len(column) - 1)
        stack_top = content_top + (content_bottom - content_top - stack_h) / 2
        left = content_left + c_index * (column_w + gap_x)
        for n_index, node in enumerate(column):
            top = stack_top + n_index * (card_h + gap_y)
            group = node.get("group", "")
            if group and group not in group_colors:
                group_colors[group] = color_cycle[len(group_colors) % len(color_cycle)]
            fill = group_colors.get(group, "#F7F7F2")
            positions[node["id"]] = (left, top, left + column_w, top + card_h)

    # Edges are drawn before nodes so connectors never cross readable labels.
    for edge in diagram.get("edges", []):
        source = positions[edge["from"]]
        target = positions[edge["to"]]
        if target[0] > source[2]:
            start = (source[2], (source[1] + source[3]) / 2)
            end = (target[0], (target[1] + target[3]) / 2)
            mid_x = (start[0] + end[0]) / 2
            points = (start, (mid_x, start[1]), (mid_x, end[1]), end)
        else:
            start = ((source[0] + source[2]) / 2, source[3])
            end = ((target[0] + target[2]) / 2, target[1])
            mid_y = (start[1] + end[1]) / 2
            points = (start, (start[0], mid_y), (end[0], mid_y), end)
        draw.line(points, fill=PALETTE["accent"], width=5, joint="curve")
        draw.polygon(((end[0], end[1]), (end[0] - 13, end[1] - 9), (end[0] - 13, end[1] + 9)), fill=PALETTE["accent"])
        # Edge labels remain in the auditable spec but are intentionally omitted
        # from dense phone-scale diagrams; stage semantics belong in node/group
        # labels and the diagram caption, where they cannot collide with arrows.

    for column in columns:
        for node in column:
            left, top, right, bottom = positions[node["id"]]
            group = node.get("group", "")
            fill = group_colors.get(group, "#F7F7F2")
            _rounded_panel(draw, (left, top, right, bottom), fill, radius=26, width=2)
            if group:
                draw.text((left + 18, top + 12), group, font=fonts["diagram_group"], fill=PALETTE["muted"])
            lines = wrap_text(draw, node["label"], fonts["small_bold"], column_w - 36)[:3]
            line_h = draw.textbbox((0, 0), "国Ag", font=fonts["small_bold"])[3]
            text_y = top + (bottom - top - len(lines) * (line_h + 4)) / 2 + (12 if group else 0)
            for line in lines:
                text_w = draw.textlength(line, font=fonts["small_bold"])
                draw.text((left + (column_w - text_w) / 2, text_y), line, font=fonts["small_bold"], fill=PALETTE["ink"])
                text_y += line_h + 4


def _draw_note_card(draw, box, label, text, fonts, *, fill=PALETTE["white"], max_lines=5):
    x0, y0, x1, y1 = map(int, box)
    _rounded_panel(draw, (x0, y0, x1, y1), fill, radius=30, width=2)
    draw.text((x0 + 28, y0 + 22), label, font=fonts["metric_label"], fill=PALETTE["accent"])
    draw_wrapped_text(
        draw,
        (x0 + 28, y0 + 72),
        text,
        fonts["body"],
        PALETTE["ink"],
        x1 - x0 - 56,
        spacing=12,
        max_lines=max_lines,
    )


def _draw_reference_panel(canvas, draw, path, box, caption, fonts):
    x0, y0, x1, y1 = map(int, box)
    draw_wrapped_text(draw, (x0, y0), caption, fonts["metric_label"], PALETTE["muted"], x1 - x0, spacing=3, max_lines=2)
    panel_top = y0 + 78
    _rounded_panel(draw, (x0, panel_top, x1, y1), PALETTE["white"], radius=30, width=2)
    _paste_contained(canvas, path, (x0 + 22, panel_top + 22, x1 - 22, y1 - 22))


def _two_note_texts(paragraphs):
    if len(paragraphs) == 1:
        return [paragraphs[0]]
    if len(paragraphs) == 2:
        return list(paragraphs)
    split = (len(paragraphs) + 1) // 2
    return ["\n".join(paragraphs[:split]), "\n".join(paragraphs[split:])]


def _draw_chart(draw, chart, box, fonts):
    if not chart:
        return
    x0, y0, x1, y1 = box
    title = chart.get("title")
    if title:
        draw.text((x0, y0), str(title), font=fonts["small_bold"], fill=PALETTE["ink"])
        y0 += 70
    items = chart["items"]
    if chart["type"] == "metrics":
        available_width = x1 - x0
        columns = 4 if len(items) <= 4 and available_width >= 1500 else (2 if len(items) > 2 else len(items))
        rows = (len(items) + columns - 1) // columns
        gap = 22
        card_w = (x1 - x0 - gap * (columns - 1)) / columns
        available_h = y1 - y0
        card_h = min(240, (available_h - gap * (rows - 1)) / rows)
        grid_h = card_h * rows + gap * (rows - 1)
        grid_top = y0 + max(0, (available_h - grid_h) / 2)
        for index, item in enumerate(items):
            row, column = divmod(index, columns)
            left = x0 + column * (card_w + gap)
            top = grid_top + row * (card_h + gap)
            _rounded_panel(draw, (left, top, left + card_w, top + card_h), PALETTE["white"], radius=28, width=2)
            draw_wrapped_text(draw, (left + 24, top + 18), item["label"], fonts["metric_label"], PALETTE["muted"], card_w - 48, spacing=3, max_lines=2)
            display = str(item["display"])
            tw = draw.textlength(display, font=fonts["metric"])
            metric_bbox = draw.textbbox((0, 0), display, font=fonts["metric"])
            metric_h = metric_bbox[3] - metric_bbox[1]
            draw.text((left + (card_w - tw) / 2, top + card_h - metric_h - 20), display, font=fonts["metric"], fill=PALETTE["accent"])
        return
    max_value = max(float(item["value"]) for item in items) or 1.0
    row_h = (y1 - y0) / len(items)
    label_w = min(310, (x1 - x0) * 0.30)
    value_w = 190
    bar_left = x0 + label_w
    bar_width = x1 - bar_left - value_w
    colors = (PALETTE["mist"], PALETTE["sage"], PALETTE["coral"], PALETTE["apricot"], PALETTE["lavender"])
    for index, item in enumerate(items):
        cy = y0 + row_h * index + row_h / 2
        draw_wrapped_text(draw, (x0, cy - 30), item["label"], fonts["small"], PALETTE["ink"], label_w - 20, spacing=3, max_lines=2)
        draw.rounded_rectangle((bar_left, cy - 18, bar_left + bar_width, cy + 18), radius=18, fill="#E8E7E0")
        fill_w = max(8, bar_width * float(item["value"]) / max_value)
        draw.rounded_rectangle((bar_left, cy - 18, bar_left + fill_w, cy + 18), radius=18, fill=colors[index % len(colors)])
        draw.text((bar_left + bar_width + 25, cy - 28), str(item["display"]), font=fonts["small_bold"], fill=PALETTE["ink"])


def _fonts(font_path):
    return {
        "title": load_font(font_path, 102),
        "cover_title": load_font(font_path, 138),
        "hero_number": load_font(font_path, 238),
        "subtitle": load_font(font_path, 54),
        "chapter": load_font(font_path, 58),
        "body": load_font(font_path, 39),
        "small": load_font(font_path, 32),
        "small_bold": load_font(font_path, 35),
        "metric_label": load_font(font_path, 27),
        "diagram_group": load_font(font_path, 23),
        "metric": load_font(font_path, 58),
        "index": load_font(font_path, 30),
    }


def render_paper(spec, *, illustration=None, reference=None, result_reference=None, font_path=None):
    font_path = font_path or resolve_cjk_font()
    fonts = _fonts(font_path)
    canvas = Image.new("RGB", (CANVAS_WIDTH, CANVAS_HEIGHT), PALETTE["background"])
    _add_paper_texture(canvas)
    draw = ImageDraw.Draw(canvas)
    _draw_paper_cut_decor(draw)
    margin = 132
    content_width = CANVAS_WIDTH - margin * 2

    # Exact English title is always real font text and occupies a stable header.
    y = 115
    y = draw_wrapped_text(draw, (margin, y), spec["title"], fonts["title"], PALETTE["ink"], content_width, spacing=20, max_lines=4)
    draw.line((margin, 610, CANVAS_WIDTH - margin, 610), fill=PALETTE["line"], width=4)

    section_top = 670
    gaps = 48
    # Each chapter has a purpose-built composition instead of a generic text
    # block. The method remains largest, while problem and conclusion use paired
    # notes so copy, figures, and evidence read as one editorial sequence.
    section_heights = (620, 1380, 950, 570)
    tints = (PALETTE["mist"], PALETTE["sage"], PALETTE["apricot"], PALETTE["lavender"])
    for index, (chapter, height) in enumerate(zip(spec["chapters"], section_heights)):
        top = section_top
        bottom = top + height
        _paper_panel(
            draw,
            (margin, top, CANVAS_WIDTH - margin, bottom),
            tints[index],
            radius=50,
            tape="left" if index == 0 else ("right" if index == 2 else None),
        )
        draw.text((margin + 42, top + 36), f"{index + 1:02d}", font=fonts["index"], fill=PALETTE["muted"])
        draw.text((margin + 118, top + 25), chapter["heading"], font=fonts["chapter"], fill=PALETTE["ink"])
        inner_x = margin + 48
        inner_right = CANVAS_WIDTH - margin - 48
        inner_width = inner_right - inner_x
        paragraphs = _two_note_texts(chapter["paragraphs"])

        if index == 0:
            note_top, note_bottom = top + 120, bottom - 45
            if illustration:
                note_right = inner_x + inner_width * 0.48
                note_gap = 18
                note_h = (note_bottom - note_top - note_gap) / max(1, len(paragraphs))
                labels = ("研究问题", "核心贡献")
                for p_index, paragraph in enumerate(paragraphs):
                    card_top = note_top + p_index * (note_h + note_gap)
                    _draw_note_card(draw, (inner_x, card_top, note_right, card_top + note_h), labels[min(p_index, 1)], paragraph, fonts, max_lines=4)
                image_left = note_right + 35
                _rounded_panel(draw, (image_left, note_top, inner_right, note_bottom), PALETTE["white"], radius=34, width=2)
                _paste_contained(canvas, illustration, (image_left + 24, note_top + 24, inner_right - 24, note_bottom - 24))
            else:
                columns = len(paragraphs)
                gap = 28
                card_w = (inner_width - gap * (columns - 1)) / columns
                labels = ("研究问题", "核心贡献")
                for p_index, paragraph in enumerate(paragraphs):
                    left = inner_x + p_index * (card_w + gap)
                    _draw_note_card(draw, (left, note_top, left + card_w, note_bottom), labels[min(p_index, 1)], paragraph, fonts, max_lines=7)

        elif index == 1:
            notes_top, notes_bottom = top + 115, top + 350
            gap = 28
            card_w = (inner_width - gap) / 2
            method_labels = ("模块与输入", "交互与输出")
            for p_index, paragraph in enumerate(paragraphs[:2]):
                left = inner_x + p_index * (card_w + gap)
                _draw_note_card(draw, (left, notes_top, left + card_w, notes_bottom), method_labels[p_index], paragraph, fonts, max_lines=4)
            diagram = chapter.get("diagram")
            if diagram:
                diagram_bottom = bottom - 350 if reference else bottom - 60
                _draw_structured_diagram(draw, diagram, (inner_x, top + 380, inner_right, diagram_bottom), fonts)
                if reference:
                    caption = chapter.get("figureCaption") or "论文原图｜结构依据与细节参考"
                    _draw_reference_panel(canvas, draw, reference, (inner_x, bottom - 315, inner_right, bottom - 55), caption, fonts)
            elif reference:
                caption = chapter.get("figureCaption") or "论文原图｜方法架构与数据流"
                _draw_reference_panel(canvas, draw, reference, (inner_x, top + 380, inner_right, bottom - 275), caption, fonts)
                if chapter.get("modules"):
                    _draw_module_flow(draw, chapter["modules"], (inner_x, bottom - 225, inner_right, bottom - 60), fonts["small"])
            elif chapter.get("modules"):
                _draw_module_grid_flow(draw, chapter["modules"], (inner_x, top + 395, inner_right, bottom - 65), fonts)

        elif index == 2:
            chart = chapter.get("chart")
            if result_reference:
                split_x = inner_x + inner_width * 0.48
                _draw_note_card(
                    draw,
                    (inner_x, top + 120, split_x - 18, top + 475),
                    "实验解读",
                    "\n".join(paragraphs),
                    fonts,
                    max_lines=7,
                )
                caption = chapter.get("figureCaption") or "论文原图｜关键实验结果"
                ref_bottom = top + 475 if chart else bottom - 45
                _draw_reference_panel(canvas, draw, result_reference, (split_x + 18, top + 120, inner_right, ref_bottom), caption, fonts)
                if chart:
                    _draw_chart(draw, chart, (inner_x, top + 510, inner_right, bottom - 45), fonts)
            else:
                notes_top, notes_bottom = top + 120, top + 390
                gap = 28
                card_w = (inner_width - gap * (len(paragraphs) - 1)) / len(paragraphs)
                for p_index, paragraph in enumerate(paragraphs):
                    left = inner_x + p_index * (card_w + gap)
                    _draw_note_card(draw, (left, notes_top, left + card_w, notes_bottom), f"发现 {p_index + 1}", paragraph, fonts, max_lines=5)
                if chart:
                    _draw_chart(draw, chart, (inner_x, top + 430, inner_right, bottom - 45), fonts)

        else:
            note_top, note_bottom = top + 115, bottom - 45
            gap = 28
            card_w = (inner_width - gap) / 2
            conclusion = paragraphs[0]
            limitation = paragraphs[1] if len(paragraphs) > 1 else "论文未单独列出更多局限，仍需在更广泛场景中验证。"
            _draw_note_card(draw, (inner_x, note_top, inner_x + card_w, note_bottom), "结论", conclusion, fonts, fill="#FFFDF8", max_lines=6)
            _draw_note_card(draw, (inner_x + card_w + gap, note_top, inner_right, note_bottom), "局限与边界", limitation, fonts, fill="#F9F6FB", max_lines=6)
        section_top = bottom + gaps
    return canvas


def digest_cover_direction_layout(directions, hero_top=560, hero_bottom=1470):
    """Parse and place every validated hot direction without silent truncation."""
    parsed = []
    for direction in directions:
        match = re.match(r"^(.*?)\s*[·:]\s*(\d+)\s*$", direction)
        parsed.append((match.group(1).strip(), int(match.group(2))) if match else (direction, 1))
    row_top = hero_top + 165
    row_bottom = hero_bottom - 70
    row_gap = (row_bottom - row_top) / max(1, len(parsed))
    bar_height = min(46, max(24, row_gap * 0.42))
    return [
        (label, count, row_top + index * row_gap, bar_height)
        for index, (label, count) in enumerate(parsed)
    ]


def render_digest_cover(spec, *, illustration=None, reference=None, font_path=None):
    font_path = font_path or resolve_cjk_font()
    fonts = _fonts(font_path)
    canvas = Image.new("RGB", (CANVAS_WIDTH, CANVAS_HEIGHT), PALETTE["background"])
    _add_paper_texture(canvas, seed=20260715)
    draw = ImageDraw.Draw(canvas)
    _draw_paper_cut_decor(draw)
    margin = 150
    width = CANVAS_WIDTH - margin * 2
    y = 150
    y = draw_wrapped_text(draw, (margin, y), spec["title"], fonts["cover_title"], PALETTE["ink"], width, spacing=24, max_lines=4)
    y += 35
    y = draw_wrapped_text(draw, (margin, y), spec["subtitle"], fonts["subtitle"], PALETTE["muted"], width, spacing=14, max_lines=3)
    hero_top, hero_bottom = 560, 1470
    _paper_panel(draw, (margin, hero_top, CANVAS_WIDTH - margin, hero_bottom), PALETTE["mist"], radius=58, tape="right")
    draw.text((margin + 55, hero_top + 48), "热门方向分布", font=fonts["chapter"], fill=PALETTE["ink"])
    parsed_directions = digest_cover_direction_layout(spec["directions"], hero_top, hero_bottom)
    max_count = max(count for _, count, _y, _height in parsed_directions)
    bar_left = margin + 470
    bar_right = CANVAS_WIDTH - margin - 100
    colors = (PALETTE["sage"], PALETTE["coral"], PALETTE["lavender"], PALETTE["apricot"], "#C9DEE1", "#D8E2D1")
    for index, (label, count, y_pos, bar_height) in enumerate(parsed_directions):
        draw.text((margin + 60, y_pos), label, font=fonts["small_bold"], fill=PALETTE["ink"])
        draw.rounded_rectangle(
            (bar_left, y_pos + 4, bar_right, y_pos + 4 + bar_height),
            radius=bar_height / 2, fill="#EDF0EB",
        )
        fill_right = bar_left + (bar_right - bar_left) * count / max_count
        draw.rounded_rectangle(
            (bar_left, y_pos + 4, fill_right, y_pos + 4 + bar_height),
            radius=bar_height / 2, fill=colors[index % len(colors)],
        )
        count_text = str(count)
        draw.text((bar_right + 25, y_pos - 2), count_text, font=fonts["small_bold"], fill=PALETTE["accent"])
    list_top = 1580
    ranking = spec["ranking"]
    draw.text((margin, list_top), "TOP 10", font=fonts["chapter"], fill=PALETTE["ink"])
    row_top = list_top + 105
    available_height = CANVAS_HEIGHT - row_top - 130
    row_height = available_height / len(ranking)
    panel_height = max(180, row_height - 22)
    colors = (PALETTE["mist"], PALETTE["sage"], PALETTE["coral"], PALETTE["apricot"], PALETTE["lavender"])
    for index, item in enumerate(ranking):
        top = row_top + index * row_height
        _paper_panel(
            draw,
            (margin, top, CANVAS_WIDTH - margin, top + panel_height),
            colors[index % len(colors)],
            radius=30,
            tape="left" if index == 0 else None,
            deckle=index in {0, 2, 4},
        )
        rank = item.get("rank", index + 1)
        draw.text((margin + 42, top + 28), f"{rank:02d}", font=fonts["chapter"], fill=PALETTE["accent"])
        title_bottom = draw_wrapped_text(
            draw, (margin + 170, top + 24), item["title"], fonts["body"],
            PALETTE["ink"], width - 260, spacing=8, max_lines=2,
        )
        metadata = item.get("label") or " · ".join(
            value for value in (str(item.get("score") or ""), item.get("primaryTask") or "") if value
        )
        if metadata:
            metadata_y = min(top + panel_height - 58, title_bottom + 8)
            draw.text((margin + 170, metadata_y), metadata, font=fonts["small"], fill=PALETTE["muted"])
    return canvas


def save_optimized_png(image, output_path):
    """Write an atomic, palette-optimized PNG under the publication size cap."""
    output_path = Path(output_path)
    fd, temp_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
    os.close(fd)
    temp_path = Path(temp_name)
    try:
        for colors in (256, 192, 128, 96, 64):
            quantized = image.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
            quantized.save(temp_path, format="PNG", optimize=True, compress_level=9)
            if temp_path.stat().st_size <= MAX_PNG_BYTES:
                break
        else:
            raise SpecError("PNG 经调色板优化后仍超过 8 MiB")
        with Image.open(temp_path) as check:
            if check.size != (CANVAS_WIDTH, CANVAS_HEIGHT) or check.format != "PNG":
                raise SpecError("输出 PNG 尺寸或格式门禁失败")
            check.verify()
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, output_path)
    finally:
        temp_path.unlink(missing_ok=True)
    return output_path


def render_visual(spec, output_path, *, illustration=None, reference=None, result_reference=None, font_path=None):
    validate_spec(spec)
    illustration_path = validate_image_path(illustration, "illustration")
    reference_path = validate_image_path(reference, "reference")
    result_reference_path = validate_image_path(result_reference, "result_reference")
    output = validate_output_path(output_path, (illustration_path, reference_path, result_reference_path))
    chosen_font = Path(font_path).expanduser() if font_path else resolve_cjk_font()
    if not chosen_font.is_file():
        raise SpecError(f"字体不存在: {chosen_font}")
    if spec.get("kind", "paper") == "digest-cover":
        image = render_digest_cover(spec, illustration=illustration_path, reference=reference_path, font_path=chosen_font)
    else:
        image = render_paper(
            spec,
            illustration=illustration_path,
            reference=reference_path,
            result_reference=result_reference_path,
            font_path=chosen_font,
        )
    save_optimized_png(image, output)
    return output


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="本地调试/离线兜底：确定性合成论文长图或批次封面")
    parser.add_argument("--spec", required=True, help="JSON spec 路径")
    parser.add_argument("--output", required=True, help="输出 PNG 路径")
    parser.add_argument("--illustration", help="可选的无字调试插画")
    parser.add_argument("--reference", help="可选的论文参考图")
    parser.add_argument("--result-reference", help="可选的论文关键实验参考图")
    parser.add_argument("--font", help="可选 CJK 字体；优先级高于 PD_VISUAL_CJK_FONT")
    return parser.parse_args(argv)


def main(argv=None):
    require_external_runtime(Path(__file__).name)
    setup_script_logging(__file__)
    args = parse_args(argv)
    try:
        spec = load_spec(args.spec)
        output = render_visual(
            spec,
            args.output,
            illustration=args.illustration,
            reference=args.reference,
            result_reference=args.result_reference,
            font_path=args.font,
        )
    except SpecError as exc:
        print(f"视觉合成失败: {exc}")
        return 2
    size = output.stat().st_size
    print(f"视觉合成完成: {output} ({CANVAS_WIDTH}x{CANVAS_HEIGHT}, {size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
