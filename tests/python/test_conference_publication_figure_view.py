"""UNINSTALLED view/consumer tests. Mocked Node output NEVER grants source authority.

Real private generation/page bytes are optional integration fixtures, not a
replacement for the real Node derive+cold replay required before installation.
"""
import ast
import base64
import copy
from contextlib import nullcontext
import hashlib
import importlib.util
import json
import re
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve()
ROOT = next(p for p in HERE.parents if (p / 'package.json').is_file())
# This also works after installation under tests/python.
PROPOSAL = next((p for p in HERE.parents if (p / 'proposed/scripts').is_dir()), None)
SCRIPTS = (PROPOSAL / 'proposed/scripts') if PROPOSAL else ROOT / 'scripts'
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(SCRIPTS))
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module
view = load('conference_publication_figure_view', SCRIPTS / 'conference_publication_figure_view.py')
sys.modules['conference_publication_figure_view'] = view
pub = load('publication_figure_consumer_proposal', SCRIPTS / 'publish-conference.py')
# Parse with the actual production parser without loading publication services.
tree = ast.parse((ROOT / 'scripts/publish-to-blog.py').read_text())
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'parse_markdown_images')
ns = {'re': re, 'PublishDataValidationError': ValueError}
exec(compile(ast.Module(body=[fn], type_ignores=[]), '<native-image-parser>', 'exec'), ns)
parse = ns['parse_markdown_images']
context_fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == '_review_image_context_regions')
exec(compile(ast.Module(body=[context_fn], type_ignores=[]), '<native image context regions>', 'exec'), ns)
regions = ns['_review_image_context_regions']
CONFERENCE = 'interspeech-2026'
PROCESS = 'd1dcba74-6042-43cb-8352-6f81723055bc'
PRIVATE_GENERATION = ROOT / 'data/runtime/conference-publications' / CONFERENCE / PROCESS / 'generation.json'

class PublicationFigureViewTests(unittest.TestCase):
    def setUp(self):
        # For the uninstalled proposal all writes stay inside the owned O dir.
        self.temp = tempfile.TemporaryDirectory(dir=str(PROPOSAL) if PROPOSAL else None)
        self.root = Path(self.temp.name); self.addCleanup(self.temp.cleanup)
        self.oldurl = 'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/111111111111/figure-1.png'
        self.newurl = self.oldurl.replace('111111111111', '222222222222')
        self.paperid = 'conference:interspeech:2026:conference-paper-id:fixture'
        self.raw = '---\npaper_digest_api_reader_article_sha256: "'+'a'*64+'"\ntags: ["原标签"]\n---\n\n科学主文\n\n[![原图]('+self.oldurl+')]('+self.oldurl+')\n\n原评分与解释。\n'
        self.page = self.record('paper', self.paperid, 'content/posts/paper.md', self.raw.encode())
        self.aggregate = self.record('aggregate', None, 'content/posts/summary.md', b'---\ntitle: summary\n---\nsummary unchanged\n')
        self.image = self.record('asset', self.paperid, 'interspeech-2026/111111111111/figure-1.png', b'old image fixture bytes')
        self.bundle = {'completion': {'receiptSha256': 'b'*64}, 'state': {},
                       'files': [self.page, self.aggregate], 'imageFiles': [self.image]}
        self.pixels = self.root / 'derived.png'; self.pixels.write_bytes(b'derived fixture pixels')
        self.item = {'paperId': self.paperid, 'figureOrdinal': 1, 'figureNumber': 3,
                     'originalImagePath': self.image['path'], 'originalUrl': self.oldurl,
                     'newImagePath': 'interspeech-2026/222222222222/figure-1.png', 'newUrl': self.newurl,
                     'derivedSourcePath': str(self.pixels), 'sha256': view.sha(self.pixels.read_bytes()),
                     'size': self.pixels.stat().st_size, 'proofPath': str(self.root/'proof.json'),
                     'proofSha256': 'c'*64, 'sourceNote': '原论文 PDF 第 2 页 Figure 3（出版显示裁切）',
                     'reviewTarget': {'displayMode':'source-pdf-figure-crop-v1','pdfPage':2,'targetPrintedFigureNumber':3,
                                      'originalPdfSha256':'4'*64,'completeTargetCaption':'Figure 3: Example.'}}
        self.outcome = self.outcome_for([self.item])
    def record(self, kind, paperid, target, data):
        p = self.root / ('raw-' + view.sha(target.encode())); p.write_bytes(data)
        return {'kind': kind, 'paperId': paperid, 'path': target, 'sourcePath': str(p),
                'manifestSha256': 'd'*64, 'sourceSha256': view.sha(data), 'size': len(data)}
    def outcome_for(self, items, **extra):
        body = {'contract': view.CROP_CONTRACT, 'purpose': 'publication-display-only',
                'conferenceId': CONFERENCE, 'processId': PROCESS, 'baseGenerationSha256': 'e'*64,
                'baseGenerationFileSha256': 'f'*64, 'manifestFileSha256': '1'*64,
                'derivations': copy.deepcopy(items), 'status': 'complete', 'blocked': [],
                'unresolvedRoutes': [], 'deferredRoutes': [], 'publicationPassed': False, **extra}
        return {**body, 'derivationSha256': view.stable(body)}
    def project(self, bundle=None, outcome=None, **kw):
        return view.materialize_view(bundle or self.bundle, outcome or self.outcome,
            root=self.root, conference_id=CONFERENCE, process_id=PROCESS,
            manifest_path=str(self.root/'manifest.json'), parse_images=parse,
            read_bytes=pub.read_bytes, write_exact=pub.write_exact, **kw)
    def test_real_body_sha_both_urls_and_old_signatures_preserved(self):
        oldfiles=copy.deepcopy(self.bundle); result=self.project(); declaration=result['figurePublicationView']
        page=next(p for p in result['files'] if p['kind']=='paper'); text=Path(page['sourcePath']).read_text()
        self.assertIn('[![原图]('+self.newurl+')]('+self.newurl+')', text)
        self.assertNotIn(self.oldurl,text); self.assertIn('paper_digest_api_reader_article_sha256: "'+'a'*64+'"',text)
        self.assertIn('tags: ["原标签"]',text); self.assertTrue(text.endswith('原评分与解释。\n'))
        body=text.split('\n---\n',1)[1]; self.assertIn('paper_digest_publication_view_article_sha256: "'+view.sha(body.encode())+'"',text)
        self.assertNotEqual(page['sourceSha256'],self.page['sourceSha256'])
        self.assertIn(self.image,result['imageFiles']); self.assertEqual(len(result['imageFiles']),2)
        self.assertIn(self.aggregate,result['files']); self.assertEqual(self.bundle,oldfiles)
        replay=self.project(expected_declaration=declaration,replay=True,require_ready=True)
        self.assertEqual(replay,result)
    def test_full_page_source_note_grammar_and_native_five_part_context(self):
        old=self.oldurl
        native='导读说明。\n\n> **看图路径：** 逐项观察。\n\n[![原论文 Figure 3：Example.]('+old+')]('+old+')\n\n*论文图 1。原论文 Figure 3：“Example.”。*\n\n完整解释段落，必须进入审查上下文。\n'
        item={**self.item,'sourceNote':'原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页）'}
        projected=view.project_image_nodes(native,[item],parse)
        self.assertIn('> **图片来源：** 原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页）。',projected)
        before,after=regions(native,parse(native))[0],regions(projected,parse(projected))[0]
        self.assertTrue(before['readerFigureCluster']);self.assertTrue(after['readerFigureCluster'])
        self.assertIn('完整解释段落',projected[after['start']:after['end']])
        bad={**item,'sourceNote':'原论文 PDF 第 2 页，本文讨论 Figure 3（任意新说明）'}
        with self.assertRaises(view.FigureViewRejected):view.project_image_nodes(native,[bad],parse)

    def test_attested_page_only_visible_note_target_and_native_context_preserved(self):
        self.item['sourceNote']='原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页；图注未完整抽取，以原页为准）'
        self.item['reviewTarget'].update(displayMode='source-pdf-attested-source-page-only-v1',completeTargetCaption=None,captionExtractionStatus='unavailable')
        self.outcome=self.outcome_for([self.item]);result=self.project();contexts=view.review_contexts_from_generation(result)
        self.assertIsNone(contexts[self.newurl]['reviewTarget']['completeTargetCaption'])
        text=Path(next(p for p in result['files'] if p['kind']=='paper')['sourcePath']).read_text()
        self.assertIn('图注未完整抽取，以原页为准',text)
        for mode,caption in [('source-pdf-figure-crop-v1',None),('source-pdf-full-page-v1',None),('source-pdf-attested-source-page-only-v1','invented')]:
            bad=copy.deepcopy(result);target=bad['figurePublicationView']['nodeDerivation']['derivations'][0]['reviewTarget'];target['displayMode']=mode;target['completeTargetCaption']=caption
            with self.assertRaises(view.FigureViewRejected):view.review_contexts_from_generation(bad)

    def test_target_context_applies_only_to_actual_image_including_summary(self):
        result=self.project();contexts=view.review_contexts_from_generation(result)
        text=Path(next(p for p in result['files'] if p['kind']=='paper')['sourcePath']).read_text()
        self.assertEqual(set(view.review_contexts_for_page(contexts,self.page,text,parse)),{self.newurl})
        self.assertEqual(view.review_contexts_for_page(contexts,self.aggregate,'No image',parse),{})
        self.assertEqual(set(view.review_contexts_for_page(contexts,self.aggregate,text,parse)),{self.newurl})
        with self.assertRaises(view.FigureViewRejected):
            view.review_contexts_for_page(contexts,{**self.page,'paperId':'conference:other'},text,parse)

    def test_pure_fd_transform_reuses_exact_page_projection_without_granting_authority(self):
        cli=load('view_pure_transform',SCRIPTS/'conference_publication_figure_view_replay.py')
        value={'contract':'conference-publication-figure-view-transform-input-v1',
               'rawPageBase64':base64.b64encode(self.raw.encode()).decode(),
               'rawPageSha256':view.sha(self.raw.encode()),'kind':'paper','paperId':self.paperid,
               'nodeDerivation':self.outcome}
        result=cli.transform(value)
        page=next(p for p in self.project()['files'] if p['kind']=='paper')
        self.assertEqual(base64.b64decode(result['projectedPageBase64']),Path(page['sourcePath']).read_bytes())
        self.assertEqual(result['projectedPageSha256'],page['sourceSha256'])
        self.assertIs(result['doesNotGrantSourceOrReviewOrPublication'],True)
        for bad in [{**value,'rawPageSha256':'0'*64},{**value,'kind':'asset'},
                    {**value,'path':'/arbitrary/path'},{**value,'nodeDerivation':{**self.outcome,'derivationSha256':'0'*64}}]:
            with self.assertRaises(ValueError):cli.transform(bad)
        noimage={**value,'kind':'aggregate','paperId':None,'rawPageBase64':base64.b64encode(b'No image').decode(),'rawPageSha256':view.sha(b'No image')}
        self.assertEqual(base64.b64decode(cli.transform(noimage)['projectedPageBase64']),b'No image')
        declaration=self.project()['figurePublicationView']
        self.assertEqual(declaration['rawFiles'],view.records(self.bundle['files']))
        self.assertEqual(declaration['rawImageFiles'],view.records(self.bundle['imageFiles']))

    def test_summary_only_changes_when_exact_image_present(self):
        same=self.project(); self.assertIn(self.aggregate,same['files'])
        aggregate=self.record('aggregate',None,self.aggregate['path'],('---\ntitle: summary\n---\n\n![图]('+self.oldurl+')\n').encode())
        b={**self.bundle,'files':[self.page,aggregate]};result=self.project(b)
        updated=next(r for r in result['files'] if r['kind']=='aggregate')
        self.assertIn(self.newurl,Path(updated['sourcePath']).read_text())
    def test_duplicate_wrapped_inline_code_and_changed_origin_rejected(self):
        for content in [self.raw+self.raw.split('\n---\n',1)[1], self.raw.replace('[![原图]', '文字[![原图]'),
                        '```\n'+self.raw+'\n```', self.raw.replace(']('+self.oldurl+')\n','](https://bad.invalid/x)\n')]:
            with self.assertRaises(view.FigureViewRejected):view.project_image_nodes(content,[self.item],parse)
        bad={**self.item,'newUrl':'https://bad.invalid/x'}
        with self.assertRaises(view.FigureViewRejected):view.project_image_nodes(self.raw,[bad],parse)
    def test_tampered_png_view_source_and_declaration_rejected(self):
        result=self.project(); declaration=result['figurePublicationView']
        edited=copy.deepcopy(declaration);edited['changedPages'][0]['publicationViewSha256']='0'*64
        with self.assertRaises(view.FigureViewRejected):self.project(expected_declaration=edited,replay=True)
        page=next(p for p in result['files'] if p['kind']=='paper');Path(page['sourcePath']).write_text('tampered')
        with self.assertRaises(view.FigureViewRejected):self.project(expected_declaration=declaration,replay=True)
        self.pixels.write_bytes(b'changed')
        with self.assertRaises(view.FigureViewRejected):self.project()
    def test_wrong_owner_collision_source_note_rejected(self):
        for update in [{'paperId':'wrong'}, {'newImagePath':self.image['path'],'newUrl':self.oldurl},
                       {'sourceNote':'自由正文'}, {'size':0}]:
            out=self.outcome_for([{**self.item,**update}])
            with self.assertRaises(view.FigureViewRejected):self.project(outcome=out)
    def test_partial_can_build_view_but_cannot_publish(self):
        outcome=self.outcome_for([self.item],status='partial',blocked=[{'reasonCode':'CROP_UNSUPPORTED_GEOMETRY'}])
        result=self.project(outcome=outcome)
        with self.assertRaises(pub.ConferencePublicationError):pub.require_publication_figure_view_ready(result)
        with self.assertRaises(view.FigureViewRejected):self.project(outcome=outcome,require_ready=True)
        unresolved=self.outcome_for([self.item],unresolvedRoutes=[{'reason':'needs source'}])
        with self.assertRaises(view.FigureViewRejected):self.project(outcome=unresolved,require_ready=True)
    def test_publisher_calls_raw_bundle_before_any_derivation(self):
        with patch.object(pub,'blog_repo',return_value=self.root),patch.object(pub,'image_repo',return_value=self.root), \
             patch.object(pub,'publication_dir',return_value=self.root),patch.object(pub,'shared_blog_repository_lock',return_value=nullcontext()), \
             patch.object(pub,'process_bundle',side_effect=RuntimeError('raw source rejected')), \
             patch.object(pub,'_publication_figure_view_bundle') as node:
            with self.assertRaisesRegex(RuntimeError,'raw source rejected'):
                pub.generate(CONFERENCE,PROCESS,figure_crop_manifest=str(self.root/'m.json'),figure_crop_base_sha='e'*64)
            node.assert_not_called()
    def generation(self,result):
        body={'contract':'conference-blog-generation-v1','version':2,'conferenceId':CONFERENCE,'processId':PROCESS,
              'completionReceiptSha256':self.bundle['completion']['receiptSha256'],'implementationSha256':'9'*64,
              'baseHead':'a'*40,'remoteMainBefore':'a'*40,'remoteIdentitySha256':'7'*64,
              'imageBaseHead':'b'*40,'imageRemoteMainBefore':'b'*40,'imageRemoteIdentitySha256':'8'*64,
              'files':result['files'],'imageFiles':result['imageFiles'],'figurePublicationView':result['figurePublicationView']}
        return {**body,'generationSha256':pub.stable(body)}
    def test_real_cli_boundary_required_fresh_replay_not_a_json_file_authority(self):
        calls=[]
        def bounded(argv, **kwargs):
            self.assertEqual(argv[1],str(self.root/'scripts/lib/conference-publication-figure-crop-replay-cli.js'))
            self.assertEqual(kwargs['pass_fds'],(int(argv[2]),))
            payload=json.loads(os.pread(int(argv[2]),16*1024*1024,0));calls.append(payload)
            self.assertEqual(payload['runtimeRoot'],str(self.root/'data/runtime'))
            self.assertNotIn('NODE_OPTIONS',kwargs['env']);self.assertNotIn('NODE_PATH',kwargs['env'])
            self.assertEqual(kwargs['env'].get('VERIFY_PROJECT_DISABLE_FILE_LOGS'),'1')
            self.assertEqual(kwargs['timeout_seconds'],3600)
            return SimpleNamespace(returncode=0,timed_out=False,output_truncated=False,
                                   stdout=json.dumps(self.outcome),stderr='')
        module=SimpleNamespace(parse_markdown_images=parse,_run_bounded_subprocess=bounded)
        with patch.object(pub,'ROOT',self.root),patch.object(pub,'RUNTIME',self.root/'data/runtime'), \
             patch.object(pub,'load_publish_to_blog',return_value=module),patch.object(pub.shutil,'which',return_value='/usr/bin/node'):
            selection={'manifestPath':str(self.root/'manifest.json'),'expectedGenerationSha256':'e'*64}
            first=pub._publication_figure_view_bundle(self.bundle,CONFERENCE,PROCESS,selection=selection)
            pub._publication_figure_view_bundle(self.bundle,CONFERENCE,PROCESS,expected=first['figurePublicationView'],replay=True)
            self.assertNotIn('expectedDerivation',calls[0]);self.assertEqual(calls[1]['expectedDerivation'],self.outcome)
            module._run_bounded_subprocess=lambda *a,**k:SimpleNamespace(returncode=1,timed_out=False,output_truncated=False,stderr='cold source rejected')
            with self.assertRaisesRegex(pub.ConferencePublicationError,'真实 Node'):
                pub._publication_figure_view_bundle(self.bundle,CONFERENCE,PROCESS,expected=first['figurePublicationView'],replay=True)

    def test_generation_validation_replays_each_time_and_rejects_self_hash_forgery(self):
        result=self.project();g=self.generation(result)
        def cold(*args,**kw):return self.project(expected_declaration=kw['expected'],replay=True)
        with patch.object(pub,'load_generation',return_value=g),patch.object(pub,'process_bundle',return_value=self.bundle), \
             patch.object(pub,'_publication_figure_view_bundle',side_effect=cold) as replay, \
             patch.object(pub,'gate_fingerprint',return_value='9'*64),patch.object(pub,'validate_conference_tag_catalogs'), \
             patch.object(pub,'transaction_snapshot',return_value={}),patch.object(pub,'target_bytes',side_effect=lambda repo,record:Path(record['sourcePath']).read_bytes()):
            pub.validate_generation(CONFERENCE,PROCESS,self.root,self.root)
            pub.validate_generation(CONFERENCE,PROCESS,self.root,self.root)
            self.assertEqual(replay.call_count,2)
            forged=copy.deepcopy(g);forged['files'][0]['sourcePath']=str(self.root/'arbitrary')
            forged['generationSha256']=pub.stable({k:v for k,v in forged.items() if k!='generationSha256'})
            with patch.object(pub,'load_generation',return_value=forged):
                with self.assertRaisesRegex(pub.ConferencePublicationError,'逐记录'):
                    pub.validate_generation(CONFERENCE,PROCESS,self.root,self.root)
    def test_actual_review_pages_receives_only_cold_generation_typed_targets(self):
        # The source/Node boundary is explicit mock here: this proves only the
        # real conference review->review_pages->shared request plumbing.
        self.item['reviewTarget']['displayMode']='source-pdf-full-page-v1'
        self.item['sourceNote']='原论文 PDF 第 2 页，本文讨论 Figure 3（完整原页）'
        self.outcome=self.outcome_for([self.item])
        result=self.project();g=self.generation(result);events=[];calls=[];dispatch=[]
        def validate(*args,**kwargs):events.append('cold generation verified');return g,{},{}
        def dispatch_pages(records,worker,workers):
            dispatch.append(([r['kind'] for r in records],workers));return [worker(r) for r in records]
        def multi(content,title,**kwargs):
            events.append('shared image review');calls.append((content,kwargs));return True,[]
        module=SimpleNamespace(parse_markdown_images=parse,split_review_content=lambda text,n:[text],
            get_blog_review_chunk_chars=lambda:100000,_llm_review_post_chunk=lambda text,*a,**k:text,
            count_blocking_review_issues=lambda issues:0,multimodal_review_images=multi)
        with patch.object(pub,'blog_repo',return_value=self.root),patch.object(pub,'image_repo',return_value=self.root), \
             patch.object(pub,'publication_dir',return_value=self.root),patch.object(pub,'PUBLICATION_ROOT',self.root/'review'), \
             patch.object(pub,'shared_blog_repository_lock',return_value=nullcontext()), \
             patch.object(pub,'validate_generation',side_effect=validate),patch.object(pub,'require_content_review_runtime'), \
             patch.object(pub,'load_publish_to_blog',return_value=module),patch.object(pub,'content_review_protocol',return_value='1'*64), \
             patch.object(pub,'_content_review_failure_index',return_value={}),patch.object(pub,'text_review_unit_pass',return_value=None), \
             patch.object(pub,'interpret_readonly_text_unit',side_effect=lambda original,proposed:(True,[],proposed)), \
             patch.object(pub,'run_bounded_llm_tasks',side_effect=dispatch_pages), \
             patch.object(pub,'target_bytes',side_effect=lambda repo,record:Path(record['sourcePath']).read_bytes()), \
             patch.object(pub,'run_hugo',return_value={'status':'passed'}),patch.object(pub,'rewrite_unpublished_receipt') as seal, \
             patch.dict(os.environ,{'PAPER_ANALYZER_MODEL':'offline-mock-no-requests'}):
            pub.review(CONFERENCE,PROCESS)
        self.assertEqual(dispatch,[(['aggregate','paper'],5)])
        sealed=json.loads(seal.call_args.args[1]);self.assertEqual([r['path'] for r in sealed['contentReview']['pages']],[r['path'] for r in pub.publication_page_files(g)])
        self.assertEqual(len(calls),1)
        self.assertLess(events.index('cold generation verified'),events.index('shared image review'))
        content,kwargs=calls[0];self.assertIs(kwargs['required'],True)
        targets=kwargs['publication_figure_contexts'];self.assertEqual(set(targets),{self.newurl})
        self.assertEqual(targets[self.newurl]['imageSha256'],self.item['sha256'])
        self.assertEqual(targets[self.newurl]['reviewTarget'],self.item['reviewTarget'])
        self.assertEqual(targets[self.newurl]['sourceNote'],self.item['sourceNote'])
        self.assertIn(self.newurl,content);self.assertNotIn(self.oldurl,content)

    def test_partial_review_runs_pages_but_never_seals_receipt_push_never_commits(self):
        g=self.generation(self.project(outcome=self.outcome_for([self.item],status='partial',blocked=[{'reasonCode':'CROP_UNSUPPORTED_GEOMETRY'}])))
        with patch.object(pub,'blog_repo',return_value=self.root),patch.object(pub,'image_repo',return_value=self.root), \
             patch.object(pub,'publication_dir',return_value=self.root),patch.object(pub,'shared_blog_repository_lock',side_effect=lambda *a,**k:nullcontext()), \
             patch.object(pub,'validate_generation',return_value=(g,{},{})),patch.object(pub,'require_content_review_runtime'), \
             patch.object(pub,'review_pages',return_value={'status':'passed'}) as pages,patch.object(pub,'run_hugo',return_value={}), \
             patch.object(pub,'rewrite_unpublished_receipt') as seal,patch.object(pub,'commit_delta') as commit:
            with self.assertRaises(pub.ConferencePublicationError):pub.review(CONFERENCE,PROCESS)
            pages.assert_called_once();seal.assert_not_called()
            with self.assertRaises(pub.ConferencePublicationError):pub.push(CONFERENCE,PROCESS)
            commit.assert_not_called()
    def test_published_history_does_not_consume_future_pending_task(self):
        (self.root/'publish.json').write_text('{}')
        with patch.object(pub,'blog_repo',return_value=self.root),patch.object(pub,'image_repo',return_value=self.root), \
             patch.object(pub,'publication_dir',return_value=self.root),patch.object(pub,'published_state',return_value={'status':'complete'}) as history, \
             patch.object(pub,'validate_generation',side_effect=AssertionError('history called active consumer')):
            self.assertEqual(pub.publication_state(CONFERENCE,PROCESS),{'status':'complete'})
            history.assert_called_once()
    def test_first_verify_publication_seal_requires_current_source_authority(self):
        result=self.project();g=self.generation(result)
        (self.root/'generation.json').write_text('{}');(self.root/'review.json').write_text('{}')
        snapshot={'head':'a'*40,'remoteMain':'a'*40}
        def validation(*args,**kwargs):
            if kwargs.get('verify_author_sources') is False:return g,snapshot,snapshot
            raise pub.ConferencePublicationError('pending current maintenance rejected')
        with patch.object(pub,'blog_repo',return_value=self.root),patch.object(pub,'image_repo',return_value=self.root), \
             patch.object(pub,'publication_dir',return_value=self.root),patch.object(pub,'validate_generation',side_effect=validation), \
             patch.object(pub,'load_review',return_value={'contentReview':{'status':'passed'}}),patch.object(pub,'validate_review'), \
             patch.object(pub,'verify_tree'),patch.object(pub,'shared_blog_repository_lock',return_value=nullcontext()), \
             patch.object(pub,'accept_publication') as accept:
            with self.assertRaisesRegex(pub.ConferencePublicationError,'pending current'):
                pub.publication_state(CONFERENCE,PROCESS,verify_urls=True)
            accept.assert_not_called()

    def test_real_private_old_new_generation_byte_projection(self):
        candidates=[PRIVATE_GENERATION,*PRIVATE_GENERATION.parent.glob('generation.superseded-*.json')]
        matches=[]
        for filename in candidates:
            if filename.exists():
                saved=json.loads(filename.read_bytes())
                if saved.get('generationSha256')=='dd8d562256f5121ccc88bf9e4749134e3d835251775c6b21ddbe888c64707e25':
                    matches.append((filename,saved))
        if not matches:self.skipTest('private original dd8d5622 generation not available')
        self.assertEqual(len(matches),1,'private original generation is ambiguous')
        filename,g=matches[0]
        self.assertEqual(view.sha(filename.read_bytes()),'9327a412d6e2e26f503c89fe52a4f6b2904ea819f094b5b8ca08c6ee42fba05e')
        page=next(r for r in g['files'] if r.get('paperId','') and r['paperId'].endswith(':ai26_interspeech') and r['kind']=='paper')
        if not Path(page['sourcePath']).exists():self.skipTest('private original page not available')
        image=next(r for r in g['imageFiles'] if r['paperId']==page['paperId'])
        text=Path(page['sourcePath']).read_text(); url=next(r['url'] for r in parse(text) if r['url'].endswith('/'+image['path']))
        item={**self.item,'paperId':page['paperId'],'originalImagePath':image['path'],'originalUrl':url}
        item['newUrl']=url[:-len(image['path'])]+item['newImagePath']
        b={'completion':{'receiptSha256':g['completionReceiptSha256']},'files':[page,self.aggregate],'imageFiles':[image]}
        result=self.project(bundle=b,outcome=self.outcome_for([item]));new=next(r for r in result['files'] if r['kind']=='paper')
        rendered=Path(new['sourcePath']).read_text();self.assertEqual(parse(text)[0]['alt'],parse(rendered)[0]['alt'])
        self.assertIn(image,result['imageFiles']);self.assertEqual(view.sha(Path(page['sourcePath']).read_bytes()),page['sourceSha256'])
        self.assertNotEqual(new['sourceSha256'],page['sourceSha256'])
        self.assertEqual([r['readerFigureCluster'] for r in regions(text,parse(text))],
                         [r['readerFigureCluster'] for r in regions(rendered,parse(rendered))])

if __name__=='__main__':unittest.main(verbosity=2)
