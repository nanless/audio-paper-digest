"""Pure review-input/byte-pin tests, zero model requests or source qualification."""
import ast
import base64
from contextlib import contextmanager
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import stat
import tempfile
import unittest
from unittest.mock import patch
ROOT=next(p for p in Path(__file__).resolve().parents if (p/'package.json').is_file())
O=next((p for p in Path(__file__).resolve().parents if (p/'proposed/scripts/publish-to-blog.py').is_file()),None)
filename=O/'proposed/scripts/publish-to-blog.py' if O else ROOT/'scripts/publish-to-blog.py'
tree=ast.parse(filename.read_text())
class Rejected(ValueError):pass
ns={'os':os,'re':re,'Path':Path,'stat':stat,'hashlib':hashlib,'base64':base64,'json':json,'io':io,'math':math,
    'PublishDataValidationError':Rejected,'REVIEW_IMAGE_MAX_BYTES':8*1024*1024,'REVIEW_IMAGE_MAX_EDGE':4096,
    'REVIEW_IMAGE_MAX_PIXELS':16*1024*1024,'REVIEW_IMAGE_MIME_TYPES':{'image/png'},
    '_IMAGE_REPO_SUFFIX_MIME':{'.png':'image/png'}}
names={'_publication_figure_review_context_note','_open_review_image_under_directory','_load_review_image_from_local_repo',
       '_load_review_image','_prepare_raster_for_review','_validate_image_signature','parse_markdown_images',
       '_review_image_context_regions','multimodal_review_images'}
for node in tree.body:
    if isinstance(node,ast.FunctionDef) and node.name in names:
        exec(compile(ast.Module(body=[node],type_ignores=[]),'<actual proposed review functions>','exec'),ns)
URL='https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/111111111111/figure-2.png'
def context():return {'paperId':'conference:interspeech:2026:conference-paper-id:test','imageSha256':'a'*64,
    'sourceNote':'原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页）',
    'reviewTarget':{'displayMode':'source-pdf-full-page-v1','pdfPage':2,'targetPrintedFigureNumber':3,
                    'originalPdfSha256':'b'*64,'completeTargetCaption':'Figure 3: True complete target caption.'}}

class PublicationFigureReviewContextTests(unittest.TestCase):
    def test_full_page_scope_is_explicit_and_true_scientific_checks_remain(self):
        note,pin=ns['_publication_figure_review_context_note'](URL,{URL:context()})
        self.assertEqual(pin,'a'*64)
        for phrase in ['完整原页','印刷 Figure 3','同页另一幅图','真实错图','图例/数值/方向/来源冲突','不自动通过','不是对旧 Reader']:
            self.assertIn(phrase,note)
        self.assertIn('True complete target caption.',note)
    def test_other_figure_cannot_resolve_target_scientific_conflict(self):
        # The review instruction cannot let an English-panel neighbour justify
        # an English claim attached to an Arabic-only target Figure.
        c=context();c['reviewTarget']['completeTargetCaption']='Figure 3: Arabic subset results.'
        note,_=ns['_publication_figure_review_context_note'](URL,{URL:c})
        for phrase in ['只以已标明目标 Figure 的图元','不默认归属目标','即使同页另一图支持','真实科学冲突仍须作为 error','不自动通过']:
            self.assertIn(phrase,note)
        self.assertIn('Arabic subset results.',note)

    def test_attested_page_only_reports_missing_caption_without_scientific_exemption(self):
        for status in ['unavailable','partial']:
            c=context();c['reviewTarget'].update(displayMode='source-pdf-attested-source-page-only-v1',completeTargetCaption=None,captionExtractionStatus=status)
            c['sourceNote']='原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页；图注未完整抽取，以原页为准）'
            note,pin=ns['_publication_figure_review_context_note'](URL,{URL:c})
            for phrase in ['completeTargetCaption 为 null','残缺图注或 alt 不得冒作完整原文图注','实际像素','真实科学冲突仍须作为 error','不自动通过']:
                self.assertIn(phrase,note)
            self.assertNotIn('下面完整原图注唯一定位',note)
            self.assertEqual(pin,'a'*64)
            for change in [{'completeTargetCaption':'invented complete caption'},{'captionExtractionStatus':'complete'},{'pdfPage':None}]:
                bad={**c,'reviewTarget':{**c['reviewTarget'],**change}}
                with self.assertRaises(Rejected):ns['_publication_figure_review_context_note'](URL,{URL:bad})
            with self.assertRaises(Rejected):ns['_publication_figure_review_context_note'](URL,{URL:{**c,'sourceNote':'原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页）'}})
            bad={**c,'reviewTarget':{k:v for k,v in c['reviewTarget'].items() if k!='captionExtractionStatus'}}
            with self.assertRaises(Rejected):ns['_publication_figure_review_context_note'](URL,{URL:bad})

    def test_crop_and_untyped_source_note_never_gain_full_page_scope(self):
        c=context();c['reviewTarget']['displayMode']='source-pdf-figure-crop-v1'
        c['sourceNote']='原论文 PDF 第 2 页 Figure 3（出版显示裁切）'
        note,_=ns['_publication_figure_review_context_note'](URL,{URL:c})
        self.assertIn('出版裁切展示',note)
        self.assertNotIn('不能仅因它们存在',note)
        self.assertNotIn('本张 PNG 是同篇已认证 PDF 第 2 页的完整原页',note)
        self.assertEqual(ns['_publication_figure_review_context_note'](URL,None),('',None))
        for mode in ['full-page-media-box-v1','full-page','source-pdf-full-page-v0']:
            c=context();c['reviewTarget']['displayMode']=mode
            with self.assertRaises(Rejected):ns['_publication_figure_review_context_note'](URL,{URL:c})

    def test_unmatched_url_and_default_do_not_gain_a_full_page_claim(self):
        self.assertEqual(ns['_publication_figure_review_context_note'](URL,None),('',None))
        self.assertEqual(ns['_publication_figure_review_context_note'](URL+'other',{URL:context()}),('',None))
    def test_forged_mode_note_number_and_missing_complete_caption_rejected(self):
        for change in [{'sourceNote':'原论文 PDF 第 2 页，本文讨论 Figure 4（完整原页）'},
                       {'reviewTarget':{**context()['reviewTarget'],'displayMode':'free-pass'}},
                       {'reviewTarget':{**context()['reviewTarget'],'completeTargetCaption':''}},
                       {'imageSha256':'wrong'}]:
            with self.assertRaises(Rejected):ns['_publication_figure_review_context_note'](URL,{URL:{**context(),**change}})
    def test_raw_bound_png_sha_checked_before_review_preparation(self):
        from PIL import Image
        with tempfile.TemporaryDirectory(dir=str(O) if O else None) as temp:
            root=Path(temp);p=root/'interspeech-2026/111111111111/figure-2.png';p.parent.mkdir(parents=True)
            stream=io.BytesIO();Image.new('RGB',(2,2),'white').save(stream,format='PNG');raw=stream.getvalue();p.write_bytes(raw)
            with patch.dict(os.environ,{'PAPER_DIGEST_IMAGE_REPO':str(root),
                                         'PAPER_DIGEST_IMAGE_BASE_URL':'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main'}):
                result=ns['_load_review_image'](URL,expected_source_sha256=hashlib.sha256(raw).hexdigest())
                self.assertEqual(base64.b64decode(result['data']),raw)
                with self.assertRaises(Rejected):ns['_load_review_image'](URL,expected_source_sha256='0'*64)
    def test_bound_asset_missing_never_uses_remote_or_outer_url_fallback(self):
        with patch.dict(ns,{'_load_review_image_from_local_repo':lambda *a,**k:None,
                            '_download_review_image':lambda *a,**k:(_ for _ in ()).throw(AssertionError('remote requested'))}):
            with self.assertRaises(Rejected):ns['_load_review_image'](URL,expected_source_sha256='a'*64)
    def test_real_request_input_builder_receives_context_and_exact_pixel_pin_without_api(self):
        requests=[];pins=[]
        def load(url,**kw):pins.append(kw);return {'media_type':'image/png','data':'fixture-only-not-a-real-model-input'}
        def fake_call(prompt,**kwargs):requests.append((prompt,kwargs));return '{"passed":true,"issues":[]}'
        hooks={'plain_title_for_publish':lambda x:x,'_review_source_figure_semantics_note':lambda p:'',
            '_load_review_image':load,'_digest_cover_review_expectation':lambda u:'',
            'call_llm_api':fake_call,'get_blog_review_max_tokens':lambda:4000,'parse_review_json':json.loads,
            'validate_review_payload':lambda value,**k:(value['passed'],value['issues']),
            'review_cached_unit':lambda kind,inputs,run:run()}
        text=f'导读。\n\n> **看图路径：** 看目标图。\n\n![原论文 Figure 3：Example.]({URL})\n\n> **图片来源：** 原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页）。\n\n*论文图 2。原论文 Figure 3：“Example.”。*\n\n完整解释。'
        with patch.dict(ns,hooks),patch.dict(os.environ,{'PAPER_ANALYZER_MODEL':'unit-test-only-no-api'}):
            ns['multimodal_review_images'](text,'test',True,publication_figure_contexts={URL:context()})
        self.assertEqual(len(requests),1);self.assertEqual(pins,[{'expected_source_sha256':'a'*64}])
        self.assertIn('完整原页',requests[0][0]);self.assertIn('True complete target caption.',requests[0][0]);self.assertIn('完整解释。',requests[0][0])
    def test_bound_source_error_escapes_instead_of_becoming_content_or_fallback(self):
        def load(*a,**k):raise Rejected('real asset drift')
        hooks={'plain_title_for_publish':lambda x:x,'_review_source_figure_semantics_note':lambda p:'',
               '_load_review_image':load,'_linked_image_source_url':lambda *a:(_ for _ in ()).throw(AssertionError('outer fallback'))}
        with patch.dict(ns,hooks),patch.dict(os.environ,{'PAPER_ANALYZER_MODEL':'unit-test-only-no-api'}):
            with self.assertRaisesRegex(Rejected,'real asset drift'):
                ns['multimodal_review_images'](f'![原图]({URL})','test',True,publication_figure_contexts={URL:context()})

if __name__=='__main__':unittest.main(verbosity=2)
