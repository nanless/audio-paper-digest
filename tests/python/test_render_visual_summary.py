import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

SPEC = importlib.util.spec_from_file_location(
    "render_visual_summary", SCRIPTS / "render-visual-summary.py"
)
renderer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(renderer)


def paper_spec():
    return {
        "kind": "paper",
        "title": "Exact English Paper Title: A Deterministic Test",
        "chapters": [
            {
                "heading": "研究问题与核心贡献",
                "paragraphs": ["现有方法在长尾数据上表现不稳，本文提供确定性解决方案。"],
            },
            {
                "heading": "方法架构与数据流",
                "paragraphs": ["数据依次经过编码、平衡采样与统一训练，箭头表示真实数据流。"],
                "modules": ["输入", "编码", "平衡采样", "训练", "输出"],
            },
            {
                "heading": "关键实验发现",
                "paragraphs": ["测试集上的WER越低越好，所有数值均由spec明确提供。"],
                "chart": {
                    "type": "bars",
                    "title": "WER（越低越好）",
                    "items": [
                        {"label": "基线", "value": 20.0, "display": "20.0"},
                        {"label": "本文", "value": 10.0, "display": "10.0"},
                    ],
                },
            },
            {
                "heading": "结论与局限",
                "paragraphs": ["结论：方法有效。局限：仍需更多语言和真实场景验证。"],
            },
        ],
    }


def cover_spec():
    return {
        "kind": "digest-cover",
        "title": "语音 / 音乐 / 音频论文速递",
        "subtitle": "2026-07-14 · 今日值得关注的研究",
        "directions": ["语音识别", "语音伪造检测", "音频生成"],
        "ranking": [
            {
                "rank": index,
                "title": f"Top paper {index}: verified title",
                "score": f"{10 - index / 10:.1f}",
                "primaryTask": "研究方向",
            }
            for index in range(1, 11)
        ],
    }


class RenderVisualSummaryTests(unittest.TestCase):
    def test_import_is_environment_side_effect_free(self):
        module_path = str(SCRIPTS / 'render-visual-summary.py')
        code = (
            "import importlib.util, os, sys; "
            f"sys.path.insert(0, {str(SCRIPTS)!r}); "
            "os.environ['PAPER_ANALYZER_API_KEY']='outer-test-key'; "
            f"spec=importlib.util.spec_from_file_location('visual_import_probe', {module_path!r}); "
            "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
            "print(os.environ.get('PAPER_ANALYZER_API_KEY',''))"
        )
        completed = subprocess.run(
            [sys.executable, '-c', code], cwd=ROOT,
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stdout.strip(), 'outer-test-key')

    @classmethod
    def setUpClass(cls):
        cls.font_path = renderer.resolve_cjk_font()

    def test_wrap_text_keeps_every_line_within_width(self):
        image = Image.new("RGB", (800, 300), "white")
        draw = ImageDraw.Draw(image)
        font = renderer.load_font(self.font_path, 42)
        text = "中文自动换行必须保持清晰，HuBERT-style technical-token 不应被随意拆开。"
        lines = renderer.wrap_text(draw, text, font, 360)
        self.assertGreater(len(lines), 1)
        self.assertTrue(all(draw.textlength(line, font=font) <= 360 for line in lines))
        self.assertIn("technical-token", "".join(lines))

    def test_wrap_text_keeps_accented_technical_word_intact(self):
        image = Image.new("RGB", (1000, 200), "white")
        draw = ImageDraw.Draw(image)
        font = renderer.load_font(self.font_path, 42)
        lines = renderer.wrap_text(draw, "MeanFlow-Anchored Fréchet-Distance Post-Training", font, 620)
        self.assertIn("Fréchet-Distance", " ".join(lines))

    def test_structured_diagram_validates_parallel_nodes_and_edges(self):
        spec = paper_spec()
        spec["chapters"][1]["diagram"] = {
            "caption": "中文重绘：双分支汇合",
            "columns": [
                [{"id": "input", "label": "统一输入"}],
                [
                    {"id": "a", "label": "分支 A", "group": "并行"},
                    {"id": "b", "label": "分支 B", "group": "并行"},
                ],
                [{"id": "merge", "label": "联合输出"}],
            ],
            "edges": [
                {"from": "input", "to": "a"},
                {"from": "input", "to": "b"},
                {"from": "a", "to": "merge"},
                {"from": "b", "to": "merge"},
            ],
        }
        renderer.validate_spec(spec)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "parallel.png"
            renderer.render_visual(spec, output, font_path=self.font_path)
            self.assertTrue(output.is_file())

    def test_paper_output_has_real_dimensions_palette_and_size_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "paper.png"
            renderer.render_visual(paper_spec(), output, font_path=self.font_path)
            self.assertTrue(output.is_file())
            self.assertLessEqual(output.stat().st_size, renderer.MAX_PNG_BYTES)
            with Image.open(output) as image:
                self.assertEqual(image.size, (2160, 4552))
                self.assertEqual(image.format, "PNG")
                self.assertEqual(image.mode, "P")

    def test_digest_cover_uses_shared_high_resolution_renderer(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "cover.png"
            renderer.render_visual(cover_spec(), output, font_path=self.font_path)
            self.assertLessEqual(output.stat().st_size, renderer.MAX_PNG_BYTES)
            with Image.open(output) as image:
                self.assertEqual(image.size, (2160, 4552))
                self.assertEqual(image.mode, "P")

    def test_digest_cover_fallback_lays_out_all_eight_directions(self):
        spec = cover_spec()
        spec["directions"] = [f"方向 {index} · {9 - index}" for index in range(1, 9)]
        layout = renderer.digest_cover_direction_layout(spec["directions"])
        self.assertEqual(len(layout), 8)
        self.assertEqual(layout[-2][0], "方向 7")
        self.assertEqual(layout[-1][0], "方向 8")
        self.assertLess(layout[-1][2] + layout[-1][3], 1470)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "cover-eight-directions.png"
            renderer.render_visual(spec, output, font_path=self.font_path)
            self.assertTrue(output.is_file())

    def test_paper_accepts_separate_text_free_method_and_result_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            illustration = root / "illustration.png"
            method = root / "method.png"
            result = root / "result.png"
            Image.new("RGB", (640, 360), "#dce9ee").save(illustration)
            Image.new("RGB", (800, 420), "#dde8d8").save(method)
            Image.new("RGB", (700, 400), "#f1d8cf").save(result)
            output = root / "paper-with-layers.png"
            renderer.render_visual(
                paper_spec(),
                output,
                illustration=illustration,
                reference=method,
                result_reference=result,
                font_path=self.font_path,
            )
            with Image.open(output) as image:
                self.assertEqual(image.size, (2160, 4552))
                self.assertEqual(image.format, "PNG")

    def test_accepts_verified_cache_bin_image(self):
        with tempfile.TemporaryDirectory() as directory:
            cached = Path(directory) / "verified-cache.bin"
            Image.new("RGB", (320, 180), "#dde8d8").save(cached, format="PNG")
            self.assertEqual(renderer.validate_image_path(cached, "reference"), cached.resolve())

    def test_rejects_invalid_paths_and_specs(self):
        with self.assertRaises(renderer.SpecError):
            renderer.load_spec("/definitely/missing/spec.json")
        broken = paper_spec()
        broken["chapters"] = broken["chapters"][:3]
        with self.assertRaisesRegex(renderer.SpecError, "四个"):
            renderer.validate_spec(broken)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(renderer.SpecError, r"\.png"):
                renderer.validate_output_path(Path(directory) / "result.jpg")
            with self.assertRaises(renderer.SpecError):
                renderer.validate_image_path(Path(directory) / "missing.png", "reference")

    def test_rejects_invalid_digest_cover(self):
        broken = cover_spec()
        broken["ranking"] = []
        with self.assertRaisesRegex(renderer.SpecError, "ranking"):
            renderer.validate_spec(broken)

    def test_rejects_digest_cover_ranking_over_top10_or_out_of_order(self):
        too_many = cover_spec()
        too_many["ranking"].append({"rank": 11, "title": "Eleventh"})
        with self.assertRaisesRegex(renderer.SpecError, "1–10"):
            renderer.validate_spec(too_many)

        out_of_order = cover_spec()
        out_of_order["ranking"][5]["rank"] = 9
        with self.assertRaisesRegex(renderer.SpecError, "降序顺序一致"):
            renderer.validate_spec(out_of_order)


if __name__ == "__main__":
    unittest.main()
