import hashlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))

os.environ['VERIFY_PROJECT_DISABLE_FILE_LOGS'] = '1'


class Wave11Track11BPublishAndVisionTests(unittest.TestCase):
    def test_publish_common_uses_high_detail_for_multimodal_review_images(self):
        import publish_common

        images = [{'media_type': 'image/png', 'data': 'AAAA'}]
        responses_payload = publish_common.build_publish_payload(
            'openai_responses', 'muse-spark-1.3-contributor', 'review', 4096, 0.2, images
        )
        img_items = [item for item in responses_payload['input'][0]['content'] if item.get('type') == 'input_image']
        self.assertEqual(len(img_items), 1)
        self.assertEqual(img_items[0]['detail'], 'high')

        chat_payload = publish_common.build_publish_payload(
            'openai', 'mimo-v2.6-flash', 'review', 4096, 0.2, images
        )
        chat_imgs = [item for item in chat_payload['messages'][0]['content'] if item.get('type') == 'image_url']
        self.assertEqual(len(chat_imgs), 1)
        self.assertEqual(chat_imgs[0]['image_url']['detail'], 'high')

    def test_blog_review_image_loader_preserves_png_on_downsample_and_upscales_wide_strip_svg(self):
        import blog_review_image_loader as loader
        from PIL import Image, ImageDraw

        # Oversized (5000x2000 > REVIEW_IMAGE_MAX_EDGE=4096) academic line diagram must ACTUALLY enter
        # downsampling and stay lossless PNG when <= max_bytes.
        img = Image.new('RGB', (5000, 2000), 'white')
        draw = ImageDraw.Draw(img)
        draw.line([(100, 100), (4900, 1900)], fill='black', width=8)
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        media_type, prepared = loader.prepare_raster_for_review('image/png', buf.getvalue())
        self.assertEqual(media_type, 'image/png')
        with Image.open(io.BytesIO(prepared)) as out:
            self.assertLess(max(out.size), 5000)
            self.assertLessEqual(max(out.size), loader.REVIEW_IMAGE_MAX_EDGE)
            self.assertGreaterEqual(max(out.size), 4090)

        # When PNG exceeds max_bytes, downsample falls back to progressive JPEG cleanly.
        noisy = Image.effect_noise((4500, 2500), 30).convert('RGB')
        nbuf = io.BytesIO()
        noisy.save(nbuf, format='PNG')
        fb_type, fb_bytes = loader.prepare_raster_for_review(
            'image/png', nbuf.getvalue(), hooks={'REVIEW_IMAGE_MAX_BYTES': 4 * 1024 * 1024}
        )
        self.assertEqual(fb_type, 'image/jpeg')
        self.assertLessEqual(len(fb_bytes), 4 * 1024 * 1024)

        # Ultra-short wide strip SVG (1200x240, aspect 5:1, min_side < 320) gets 2x HiDPI scaling.
        strip_svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="240" viewBox="0 0 1200 240">'
            b'<rect width="1200" height="240" fill="#fff"/>'
            b'<text x="20" y="120" font-size="18">Encoder -> Bottleneck -> Decoder</text></svg>'
        )
        png_strip = loader.rasterize_svg_for_review(strip_svg)
        with Image.open(io.BytesIO(png_strip)) as out:
            self.assertEqual(out.size, (2400, 480))

        # Safe static LaTeXML foreignObject SVG (including <br/> AND conflicting id="figure") MUST render cleanly!
        safe_fo_svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg" id="figure" width="220" height="90" viewBox="0 0 220 90">'
            b'<foreignObject width="200" height="70">'
            b'<div xmlns="http://www.w3.org/1999/xhtml" style="color:#111;font-size:18px">Line 1<br/>Line 2</div>'
            b'</foreignObject></svg>'
        )
        png_fo = loader.rasterize_svg_for_review(safe_fo_svg)
        self.assertTrue(png_fo.startswith(b'\x89PNG\r\n\x1a\n'))
        with Image.open(io.BytesIO(png_fo)) as out:
            self.assertEqual(out.size, (660, 270))
            colors = out.convert('RGB').getcolors(maxcolors=256 * 256)
            self.assertIsNotNone(colors)
            self.assertGreater(len(colors), 1, 'foreignObject text must paint visible non-white pixels')

        # Wide (>1600px) foreignObject SVG with viewBox scales proportionally without vertical letterboxing.
        wide_fo_svg = (
            b'<svg xmlns="http://www.w3.org/2000/svg" id="pd-review-figure" width="2000" height="400" viewBox="0 0 2000 400">'
            b'<foreignObject width="1900" height="360">'
            b'<div xmlns="http://www.w3.org/1999/xhtml" style="color:#111;font-size:40px">Wide Audio Flow</div>'
            b'</foreignObject></svg>'
        )
        png_wide_fo = loader.rasterize_svg_for_review(wide_fo_svg)
        with Image.open(io.BytesIO(png_wide_fo)) as out:
            self.assertEqual(out.size, (1600, 320))

        # Unsafe foreignObject and namespace-prefixed <svg:foreignObject> / <svg:script> must be rejected!
        for bad_svg in (
            (
                b'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80">'
                b'<foreignObject width="180" height="60">'
                b'<video xmlns="http://www.w3.org/1999/xhtml" src="data:video/mp4;base64,AA=="/>'
                b'</foreignObject></svg>'
            ),
            (
                b'<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80">'
                b'<svg:foreignObject width="180" height="60">'
                b'<video xmlns="http://www.w3.org/1999/xhtml" src="data:video/mp4;base64,AA=="/>'
                b'</svg:foreignObject></svg:svg>'
            ),
            (
                b'<svg:svg xmlns:svg="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80">'
                b'<svg:script>alert(1)</svg:script></svg:svg>'
            ),
        ):
            with self.assertRaises(loader.PublishDataValidationError):
                loader.rasterize_svg_for_review(bad_svg)

    def test_publish_to_blog_typography_fixes_and_quality_gate_accepts_half_width(self):
        import importlib.util
        import publish_common

        spec = importlib.util.spec_from_file_location('publish_to_blog_w11b', ROOT / 'scripts' / 'publish-to-blog.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        normalized = mod.normalize_digest_index_reader_surface(
            '后 50% 的样本在置信区间半宽内保持稳定；每篇仅计入所属主方向。'
        )
        self.assertIn('后50%', normalized)
        self.assertNotIn('后 50%', normalized)
        self.assertIn('半宽', normalized)
        self.assertNotIn('1/2 宽', normalized)
        self.assertIn('每篇仅计入所属主方向', normalized)
        self.assertNotIn('1 个方向', normalized)

        # validate_digest_index_reader_quality(required=True) MUST actually execute quality checks,
        # accepting 半宽 while still rejecting banned Chinese numeral forms like 半数.
        q_header = publish_common.protocol_record_header(
            publish_common.DIGEST_INDEX_READER_QUALITY_CONTRACT,
            publish_common.DIGEST_INDEX_READER_QUALITY_CONTRACT,
        )
        def make_index_md(snippet):
            return (
                '---\n'
                'title: "语音/音乐/音频论文速递 2026-11-24"\n'
                'paper_digest_page_type: index\n'
                f'paper_digest_reader_quality: "{q_header["contract"]}"\n'
                f'paper_digest_reader_quality_schema_fingerprint: "{q_header["schemaFingerprint"]}"\n'
                '---\n\n'
                '## ⚡ 今日概览\n\n'
                f'本次共收录 1 篇论文，{snippet}。\n\n'
                '## 📋 论文列表\n\n'
                '### 1. 测试语音论文\n\n'
                '这里是测试导读内容。\n'
            )
        self.assertIsNone(
            publish_common.validate_digest_index_reader_quality(
                make_index_md('在置信区间半宽内保持稳定'), required=True
            )
        )
        self.assertIsNotNone(
            publish_common.validate_digest_index_reader_quality(
                make_index_md('在四分之一宽内保持稳定'), required=True
            )
        )

    def test_publish_to_blog_accepts_master_and_rst_readme_documentation_evidence(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location('publish_to_blog_w11b_doc', ROOT / 'scripts' / 'publish-to-blog.py')
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        def build_paper(doc_source_url):
            source_sha = 'a' * 64
            quote = 'Code: https://github.com/org/audio-repo'
            quote_sha = mod._javascript_string_sha256(quote)
            header = mod.public_protocols.record_header(
                'api-reader-resource-identity', 'api-reader-resource-identity'
            )
            identity_body = {
                **header,
                'sourceTextSha256': source_sha,
                'resources': [{
                    'type': 'code',
                    'origin': 'paper_source',
                    'sourceQuote': quote,
                    'sourceQuoteSha256': quote_sha,
                    'originalUrl': 'https://github.com/org/audio-repo',
                    'finalUrl': 'https://github.com/org/audio-repo',
                    'redirects': [],
                    'status': 200,
                    'availability': 'available',
                    'documentationEvidence': {
                        'contract': 'repository-documentation-evidence-v1',
                        'repositoryUrl': 'https://github.com/org/audio-repo',
                        'sourceUrl': doc_source_url,
                        'status': 200,
                        'sourceSha256': 'b' * 64,
                        'capabilities': {'installation': True, 'inference': True, 'fineTuning': False},
                        'completeness': 'partial',
                    },
                }],
            }
            identity_sha = mod._stable_json_sha256(identity_body)
            payload = {**identity_body, 'identitySha256': identity_sha}
            analysis_text = (
                '## 开源详情\n'
                '代码已开源，链接可达状态：code=available(HTTP 200)\n\n'
                '## 机器摘要\n'
                '- has_code: 是\n'
                '- has_model: 否\n'
                '- has_dataset: 否\n'
            )
            return {
                'sourceSha256': source_sha,
                'analysis': analysis_text,
                'apiReaderResources': payload,
                'analysisManifest': {
                    'contracts': {
                        'apiReaderResourceIdentity': header['contract'],
                    },
                    'stages': {
                        'openSourceScan': {
                            'resourceEvidenceSha256': identity_sha,
                            'resourceEvidenceProtocol': header,
                        },
                        'apiReaderArticle': {
                            'resourceIdentitySha256': identity_sha,
                            'resourceCount': 1,
                            'readerResourceIdentityProtocol': header,
                        },
                    },
                },
            }

        for branch in ('main', 'master'):
            for fname in ('README.md', 'readme.md', 'README.rst'):
                url = f'https://raw.githubusercontent.com/org/audio-repo/{branch}/{fname}'
                result = mod._validate_api_reader_resource_identity(build_paper(url))
                self.assertEqual(result['count'], 1)
                self.assertEqual(result['resources'][0]['documentationEvidence']['sourceUrl'], url)

        with self.assertRaises(mod.PublishDataValidationError):
            mod._validate_api_reader_resource_identity(
                build_paper('https://raw.githubusercontent.com/org/audio-repo/develop/README.md')
            )

    def test_historical_page_render_uses_base_path_on_back_link(self):
        src = (ROOT / 'scripts' / 'historical-page-render.py').read_text(encoding='utf-8')
        self.assertIn('{publisher.BASE_PATH}/posts/{date}/', src)
        self.assertNotIn('](/posts/{date}/)', src)

    def test_pdf_layout_extract_without_page_pngs_matches_strip_pixels_bit_for_bit(self):
        import importlib.util
        import fitz

        spec = importlib.util.spec_from_file_location('pdf_layout_extract_w11b', ROOT / 'scripts' / 'pdf-layout-extract.py')
        layout = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(layout)

        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / 'sample.pdf'
            doc = fitz.open()
            page = doc.new_page()
            page.insert_text((72, 72), 'Audio Transformer Table 1 Results')
            doc.save(pdf_path)
            doc.close()

            raw_bytes = pdf_path.read_bytes()
            backend = layout.load_pypdf_backend()
            legacy_stripped = layout.strip_pixels(backend.extract_visual_audit(raw_bytes, include_page_pngs=True))
            fast_no_png = backend.extract_visual_audit(raw_bytes, include_page_pngs=False)
            self.assertEqual(fast_no_png, legacy_stripped)
            self.assertEqual(fast_no_png['auditSha256'], legacy_stripped['auditSha256'])
            for p in fast_no_png['pages']:
                self.assertNotIn('pngBase64', p)
                self.assertEqual(len(p['sha256']), 64)


if __name__ == '__main__':
    unittest.main()
