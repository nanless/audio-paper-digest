import copy
import hashlib
import json
import os
import subprocess
import tempfile
import sys
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import project_env_scope
from blog_entry_loader import load_publish_to_blog

with project_env_scope():
    publisher = load_publish_to_blog()


def attach_source_bound_resource_claim_fixture(paper, source_text):
    """Complete author-only samples with honest, source-bound resource evidence.

    These controlled sources disclose no resource links. The Reader makes only
    an explicit unconfirmed-status statement; it cannot acquire open-source
    eligibility from this empty evidence record.
    """
    source_sha = hashlib.sha256(source_text.encode('utf-8')).hexdigest()
    if paper['sourceSha256'] != source_sha:
        raise ValueError('作者测试的资源证据必须来自本篇实际来源文本。')
    identity = {'contract': 'api-reader-resource-identity-v1',
                'sourceTextSha256': source_sha, 'resources': []}
    identity['identitySha256'] = publisher._reader_record_sha256(identity, 'test resource identity')
    paper['apiReaderResources'] = identity
    paper['apiReaderPlan'] = {
        'version': 3, 'contract': 'beginner-researcher-v3',
        'readerTitle': '作者身份与原文证据核验',
        'oneSentenceThesis': '本文核验作者来源，资源发布状态尚未确认。',
        'conceptBridges': [],
        'sections': [{'kind': 'reproduction', 'heading': '资源状态与证据边界'}],
    }
    paper['apiReaderArticle'] = ('### 资源状态与证据边界\n\n'
                                 '本次尚未确认作者代码、模型权重或数据的可用状态，不能声称已经开源。')
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    stage['resourceIdentitySha256'] = identity['identitySha256']
    stage['resourceIdentityContractVersion'] = identity['contract']
    stage['resourceCount'] = 0
    stage['planSha256'] = publisher._reader_record_sha256(paper['apiReaderPlan'], 'test reader plan')
    stage['articleSha256'] = hashlib.sha256(paper['apiReaderArticle'].encode()).hexdigest()
    paper['apiReaderPlanSha256'] = stage['planSha256']
    paper['apiReaderArticleSha256'] = stage['articleSha256']
    paper['analysisManifest']['contracts']['apiReaderResourceIdentity'] = identity['contract']


class ReaderAuthorSourceReplayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # 使用生产纯解析器构造合法记录，再逐项破坏来源；不初始化深度分析或模型请求配置。
        code = r'''
const p = require('./scripts/lib/reader-author-parser.js');
const c = require('cheerio');
const crypto = require('node:crypto');
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const html = '<html><body><div class="ltx_authors"><div class="ltx_creator ltx_role_author"><span class="ltx_personname">Alice Brown</span><span class="ltx_contact ltx_role_affiliation">University A</span></div></div><p>Controlled source.</p></body></html>';
const text = c.load(html).text();
const body = {sourceHtmlSha256:sha(html),flattenedTextSha256:sha(text)};
const details = {source:'html',text,structuredArtifacts:{...body,payloadSha256:sha(JSON.stringify(body))},readerAuthors:p.retainAuthorSourceHtml(p.parseArxivReaderAuthors(c.load(html)),html)};
const paper = {authors:['Alice Brown'],sourceSha256:sha(text),analysisManifest:{contracts:{apiReaderArticle:'beginner-researcher-v3'},sourceAcquisition:{sourceSha256:sha(text),modelTextSanitizationContract:'model-text-unicode-scalars-v1'},stages:{apiReaderArticle:{status:'complete',structuredArtifactsSha256:details.structuredArtifacts.payloadSha256}}}};
paper.apiReaderAuthors = p.resolveVerifiedReaderAuthors(paper,details);
const hash=require('./scripts/lib/fresh-rewrite-run.js').stableHash;
paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256=paper.apiReaderAuthors.identitySha256;
paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256=hash(paper.apiReaderAuthors);
process.stdout.write(JSON.stringify({paper,sourceDetails:details}));
'''
        env = {key: value for key, value in os.environ.items()
               if key not in {'NODE_OPTIONS', 'NODE_PATH'}}
        result = subprocess.run(['node', '-e', code], cwd=ROOT, env=env,
                                capture_output=True, text=True, check=True, timeout=30)
        cls.fixture = json.loads(result.stdout)
        attach_source_bound_resource_claim_fixture(cls.fixture['paper'], cls.fixture['sourceDetails']['text'])

    def test_current_production_gate_accepts_source_replay_before_unicode_marker(self):
        value = copy.deepcopy(self.fixture)
        publisher._validate_current_model_text_reuse_for_publish(
            value['paper'], value['sourceDetails'], '2610.12345')

    def test_self_consistent_wrong_author_and_missing_or_changed_original_are_rejected(self):
        for kind in ('wrong', 'missing', 'sha', 'text', 'payload'):
            with self.subTest(kind=kind):
                value = copy.deepcopy(self.fixture)
                if kind == 'wrong':
                    record = value['paper']['apiReaderAuthors']
                    record['authors'][0]['affiliations'] = ['Wrong University']
                    record['identity']['authors'][0]['affiliations'] = ['Wrong University']
                    record['identity']['authors'][0]['affiliationBindings'][0]['sourceValue'] = 'Wrong University'
                    record['identitySha256'] = publisher._reader_record_sha256(record['identity'], 'test')
                elif kind == 'missing':
                    del value['sourceDetails']['readerAuthors']['sourceHtml']
                elif kind == 'sha':
                    value['sourceDetails']['readerAuthors']['sourceHtml'] += 'modified'
                elif kind == 'text':
                    value['sourceDetails']['text'] += 'modified'
                else:
                    value['sourceDetails']['structuredArtifacts']['payloadSha256'] = 'f' * 64
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher._validate_current_model_text_reuse_for_publish(
                        value['paper'], value['sourceDetails'], '2610.12345')

    def test_actual_daily_publication_entry_rejects_old_self_signed_institution(self):
        from test_daily_fresh_publish_gate import _daily_payload, publish_to_blog as gate
        with tempfile.TemporaryDirectory() as tmp:
            source_root = Path(tmp).resolve() / 'sources'
            payload = _daily_payload(source_root, ['2610.12345'])
            paper = payload['papers'][0]
            runtime_path = source_root / payload['dailyFreshSourceRun']['runId'] / 'sources' / '2610.12345' / 'generation-000001' / 'source-runtime.json'
            runtime = json.loads(runtime_path.read_text())
            details = {'source': 'html', 'text': (runtime_path.parent / 'source.txt').read_text(),
                       'structuredArtifacts': runtime['structuredArtifacts'], 'readerAuthors': None}
            paper['authors'] = ['Alice Brown']
            paper['analysisManifest']['contracts'] = {'apiReaderArticle': 'beginner-researcher-v3',
                                                      'apiReaderAuthorIdentity': 'api-reader-author-identity-v1'}
            paper['analysisManifest']['sourceAcquisition']['modelTextSanitizationContract'] = 'model-text-unicode-scalars-v1'
            stage = {'status': 'complete', 'structuredArtifactsSha256': runtime['structuredArtifacts']['payloadSha256'],
                     'readerAuthorIdentityContractVersion': 'api-reader-author-identity-v1'}
            paper['analysisManifest']['stages'] = {'apiReaderArticle': stage}
            code = "const p=require('./scripts/lib/reader-author-parser.js');const v=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(p.resolveVerifiedReaderAuthors(v.paper,v.details)));"
            result = subprocess.run(['node', '-e', code, json.dumps({'paper': paper, 'details': details})], cwd=ROOT,
                                    capture_output=True, text=True, check=True, timeout=30)
            paper['apiReaderAuthors'] = json.loads(result.stdout)
            paper['analysisManifest']['contracts']['apiReaderAuthorIdentity'] = paper['apiReaderAuthors']['identity']['contract']
            stage.pop('readerAuthorIdentityContractVersion')
            from reader_record_format import identity_header
            stage['readerAuthorIdentityProtocol'] = identity_header(paper['apiReaderAuthors']['identity'], 'authors')
            stage['readerAuthorIdentitySha256'] = paper['apiReaderAuthors']['identitySha256']
            stage['readerAuthorsSha256'] = gate._reader_record_sha256(paper['apiReaderAuthors'], 'test')
            attach_source_bound_resource_claim_fixture(paper, details['text'])
            data_file = Path(tmp) / 'analysis.json'
            data_file.write_text(json.dumps(payload))
            with mock.patch.object(gate, 'DAILY_FRESH_SOURCE_RUNS_DIR', source_root):
                gate.validate_daily_fresh_sources_for_publish(data_file, payload['batchDate'])
                record = paper['apiReaderAuthors']
                record['sourceDomSha256'] = paper['sourceSha256']
                record['identity']['sourceDomSha256'] = paper['sourceSha256']
                record['authors'][0]['affiliations'] = ['University A']
                bound = record['identity']['authors'][0]
                bound['affiliations'] = ['University A']
                bound['affiliationBindings'] = [{'sourceKind': 'html_dom', 'association': 'direct_author', 'sourceValue': 'University A',
                                                'sourceDomSha256': paper['sourceSha256']}]
                record['identitySha256'] = gate._reader_record_sha256(record['identity'], 'test')
                stage['readerAuthorIdentitySha256'] = record['identitySha256']
                stage['readerAuthorsSha256'] = gate._reader_record_sha256(record, 'test')
                # 旧结构检查仍可只读接受内部一致的记录；实际发布入口必须重新解析已保存的原始来源。
                gate._validate_api_reader_author_identity(paper)
                data_file.write_text(json.dumps(payload))
                with self.assertRaisesRegex(gate.PublishDataValidationError, '作者姓名或机构'):
                    gate.validate_daily_fresh_sources_for_publish(data_file, payload['batchDate'])

    def test_explicit_author_refresh_can_repair_missing_html_without_claiming_affiliations(self):
        value = copy.deepcopy(self.fixture)
        del value['sourceDetails']['readerAuthors']['sourceHtml']
        # 同一来源解析器使用已核验论文信息中的姓名，并明确说明机构不可得。
        code = "const p=require('./scripts/lib/reader-author-parser.js');let v=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(p.resolveVerifiedReaderAuthors(v.paper,v.sourceDetails)));"
        result = subprocess.run(['node', '-e', code, json.dumps(value)], cwd=ROOT,
                                capture_output=True, text=True, check=True, timeout=30)
        value['paper']['apiReaderAuthors'] = json.loads(result.stdout)
        stage = value['paper']['analysisManifest']['stages']['apiReaderArticle']
        stage['readerAuthorIdentitySha256'] = value['paper']['apiReaderAuthors']['identitySha256']
        stage['readerAuthorsSha256'] = publisher._reader_record_sha256(value['paper']['apiReaderAuthors'], 'test')
        self.assertTrue(value['paper']['apiReaderAuthors']['authors'][0]['affiliations'][0].startswith('机构信息未'))
        publisher._validate_current_model_text_reuse_for_publish(
            value['paper'], value['sourceDetails'], '2610.12345')

    def test_validate_api_reader_author_identity_accepts_pdf_text_and_rejects_tampering(self):
        from reader_record_format import identity_header
        value = copy.deepcopy(self.fixture)
        paper = value['paper']
        record = paper['apiReaderAuthors']
        stage = paper['analysisManifest']['stages']['apiReaderArticle']
        paper['analysisManifest']['contracts']['apiReaderAuthorIdentity'] = record['identity']['contract']
        stage['readerAuthorIdentityProtocol'] = identity_header(record['identity'], 'authors')
        dom_sha = record['identity']['sourceDomSha256']
        self.assertTrue(bool(dom_sha))
        for bound in record['identity']['authors']:
            bound['nameBinding'] = {
                'sourceKind': 'pdf_text',
                'sourceValue': bound['name'],
                'sourceDomSha256': dom_sha,
            }
            bound['affiliationBindings'] = [
                {
                    'sourceKind': 'pdf_text',
                    'association': 'direct_author',
                    'sourceValue': aff,
                    'sourceDomSha256': dom_sha,
                }
                for aff in bound['affiliations']
            ]
        record['identitySha256'] = publisher._reader_record_sha256(record['identity'], 'test')
        stage['readerAuthorIdentitySha256'] = record['identitySha256']
        stage['readerAuthorsSha256'] = publisher._reader_record_sha256(record, 'test')
        proof = publisher._validate_api_reader_author_identity(paper)
        self.assertEqual(proof['count'], len(record['authors']))

        # Tampered pdf_text sourceDomSha256 must be rejected
        bad_sha = copy.deepcopy(paper)
        bad_sha['apiReaderAuthors']['identity']['authors'][0]['affiliationBindings'][0]['sourceDomSha256'] = '0' * 64
        bad_sha['apiReaderAuthors']['identitySha256'] = publisher._reader_record_sha256(
            bad_sha['apiReaderAuthors']['identity'], 'test')
        bad_stage = bad_sha['analysisManifest']['stages']['apiReaderArticle']
        bad_stage['readerAuthorIdentitySha256'] = bad_sha['apiReaderAuthors']['identitySha256']
        bad_stage['readerAuthorsSha256'] = publisher._reader_record_sha256(bad_sha['apiReaderAuthors'], 'test')
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher._validate_api_reader_author_identity(bad_sha)

        # Invalid association on pdf_text affiliation binding must be rejected
        bad_assoc = copy.deepcopy(paper)
        bad_assoc['apiReaderAuthors']['identity']['authors'][0]['affiliationBindings'][0]['association'] = 'guessed'
        bad_assoc['apiReaderAuthors']['identitySha256'] = publisher._reader_record_sha256(
            bad_assoc['apiReaderAuthors']['identity'], 'test')
        bad_assoc_stage = bad_assoc['analysisManifest']['stages']['apiReaderArticle']
        bad_assoc_stage['readerAuthorIdentitySha256'] = bad_assoc['apiReaderAuthors']['identitySha256']
        bad_assoc_stage['readerAuthorsSha256'] = publisher._reader_record_sha256(
            bad_assoc['apiReaderAuthors'], 'test')
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher._validate_api_reader_author_identity(bad_assoc)

    def test_wave7_r1_pdf_author_extract_adversarial_and_sealed_replay(self):
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=595, height=842):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # HIGH-1 #1: 2-author line "Alice Brown, Bob White" is NOT dropped as LOCATION_ONLY_RE
        pdf_2au = make_pdf(lambda p: (
            p.insert_text((72, 80), "A Two Author Paper Title", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 138), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_2au = pae.extract_pdf_page1_authors(pdf_2au)
        self.assertIsNotNone(res_2au)
        self.assertEqual(res_2au['mode'], 'single_institution')
        self.assertEqual(res_2au['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['Stanford University']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        # HIGH-1 #2: Mode C does not break on email and miss 2nd institution
        pdf_email2 = make_pdf(lambda p: (
            p.insert_text((72, 80), "Two Institutions Separated By Email", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis", fontsize=11),
            p.insert_text((72, 136), "Stanford University", fontsize=10),
            p.insert_text((72, 150), "alice@stanford.edu", fontsize=9),
            p.insert_text((72, 166), "Massachusetts Institute of Technology", fontsize=10),
            p.insert_text((72, 180), "carol@mit.edu", fontsize=9),
            p.insert_text((72, 240), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_email2))

        # HIGH-1 #3: Mode C rejects venue line "ICASSP 2026"
        pdf_venue = make_pdf(lambda p: (
            p.insert_text((72, 80), "Venue Only Header", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis", fontsize=11),
            p.insert_text((72, 138), "ICASSP 2026", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_venue))

        # HIGH-1 #4: Mode C rejects 2nd non-keyword/corporate org "Anthropic PBC"
        pdf_2org = make_pdf(lambda p: (
            p.insert_text((72, 80), "Two Orgs Unmarked", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis", fontsize=11),
            p.insert_text((72, 136), "Stanford University", fontsize=10),
            p.insert_text((72, 152), "Anthropic PBC", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_2org))

        # HIGH-1 #5: Mode C does not fall through after partial letter markers
        pdf_partial = make_pdf(lambda p: (
            p.insert_text((72, 80), "Partial Letter Markers", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((135, 114), "a", fontsize=7),
            p.insert_text((142, 118), ", Bob White", fontsize=11),
            p.insert_text((205, 114), "b", fontsize=7),
            p.insert_text((72, 140), "a", fontsize=7),
            p.insert_text((80, 142), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_partial))

        # HIGH-1 #6 & #7: Mode A ignores role footnotes and "3D Vision Research Track" glued digit
        pdf_role_3d = make_pdf(lambda p: (
            p.insert_text((72, 80), "Marked Authors With Roles", fontsize=16),
            p.insert_text((72, 102), "3D Vision Research Track", fontsize=10),
            p.insert_text((72, 122), "Alice Brown", fontsize=11),
            p.insert_text((135, 118), "1*", fontsize=7),
            p.insert_text((148, 122), ", Bob White", fontsize=11),
            p.insert_text((210, 118), "3*", fontsize=7),
            p.insert_text((72, 144), "1", fontsize=7),
            p.insert_text((80, 146), "MIT", fontsize=10),
            p.insert_text((72, 160), "3", fontsize=7),
            p.insert_text((80, 162), "Stanford University", fontsize=10),
            p.insert_text((72, 178), "*", fontsize=7),
            p.insert_text((80, 180), "Denotes equal contribution", fontsize=9),
            p.insert_text((72, 194), "†", fontsize=7),
            p.insert_text((80, 196), "Funded by NSF Grant 12345", fontsize=9),
            p.insert_text((72, 250), "Abstract", fontsize=12),
        ))
        res_r3d = pae.extract_pdf_page1_authors(pdf_role_3d)
        self.assertIsNotNone(res_r3d)
        self.assertEqual(res_r3d['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['MIT']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        # HIGH-1 #8: Mode B splits multi-clause, rejects non-person subjects, and does not hijack partial footnotes
        pdf_thanks_mc = make_pdf(lambda p: (
            p.insert_text((72, 80), "Multi Clause Footnote Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 220), "Abstract", fontsize=12),
            p.insert_text((50, 700), "Alice Brown is with MIT, and Bob White is with Stanford University.", fontsize=8),
            p.insert_text((50, 712), "This dataset is from the Open Audio Corpus.", fontsize=8),
        ))
        res_tmc = pae.extract_pdf_page1_authors(pdf_thanks_mc)
        self.assertIsNotNone(res_tmc)
        self.assertEqual(res_tmc['mode'], 'thanks')
        self.assertEqual(res_tmc['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['MIT']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        pdf_partial_fn = make_pdf(lambda p: (
            p.insert_text((72, 80), "Single Institution With Partial Footnote", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis", fontsize=11),
            p.insert_text((72, 138), "Tsinghua University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
            p.insert_text((50, 700), "Bob White is now with Google Research.", fontsize=8),
        ))
        res_pfn = pae.extract_pdf_page1_authors(pdf_partial_fn)
        self.assertIsNotNone(res_pfn)
        self.assertEqual(res_pfn['mode'], 'single_institution')
        self.assertEqual(len(res_pfn['authors']), 3)

        # HIGH-1 #9: Mode D rejects vertically stacked blocks without horizontal separation
        pdf_stacked = make_pdf(lambda p: (
            p.insert_text((200, 80), "Vertically Stacked Authors", fontsize=16),
            p.insert_text((200, 120), "Alice Brown", fontsize=11),
            p.insert_text((200, 134), "Stanford University", fontsize=10),
            p.insert_text((200, 165), "Bob White", fontsize=11),
            p.insert_text((200, 179), "Massachusetts Institute of Technology", fontsize=10),
            p.insert_text((72, 240), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_stacked))

        # HIGH-3: Corrupt PDFs and lone UTF-16 surrogates never crash
        self.assertIsNone(pae.extract_pdf_page1_authors(b"%PDF-1.4\n" + b"corrupt_garbage" * 30))
        self.assertIsNone(pae.extract_pdf_page1_authors(b"%PDF-1.4\n"))
        self.assertEqual(len(pae._sha256_text("Alice\ud800Brown")), 64)
        self.assertNotIn("\ud800", pae._normalize_pua("Alice\ud800Brown"))

        # CRITICAL-1: Python _daily_fresh_read_bundle_source_identity rejects forged pdf-page1-author-evidence-v1
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp).resolve()
            paper_id = '2611.99998'
            src_dir = run_dir / 'sources' / paper_id / 'generation-000001'
            src_dir.mkdir(parents=True)
            for d in (run_dir / 'sources', run_dir / 'sources' / paper_id, src_dir):
                os.chmod(d, 0o700)
            text_bytes = b'A Two Author Paper Title\nAbstract\nBody.'
            text_sha = publisher._daily_fresh_sha256(text_bytes)
            pdf_sha = publisher._daily_fresh_sha256(pdf_2au)
            forged_ev = 'FABRICATED PDF EVIDENCE'
            forged_ev_sha = pae._sha256_text(forged_ev)
            forged_authors = {
                'contract': 'pdf-page1-author-evidence-v1',
                'mode': 'single_institution',
                'pdfSha256': pdf_sha,
                'sourceEvidence': forged_ev,
                'sourceEvidenceSha256': forged_ev_sha,
                'sourceDomSha256': pae._sha256_text(f'{pdf_sha}:{forged_ev_sha}'),
                'authors': [{'name': 'Alice Brown', 'affiliations': ['Forged University']}],
            }
            artifacts_body = {
                'version': 1, 'source': 'fresh_arxiv_text_without_layout',
                'flattenedTextSha256': text_sha, 'tables': [], 'formulas': [], 'figures': [],
            }
            artifacts = {
                **artifacts_body,
                'payloadSha256': publisher._daily_fresh_sha256(
                    publisher._daily_fresh_compact_json_bytes(publisher._daily_fresh_canonical(artifacts_body))
                ),
            }
            from protocol_codec import record_header
            rt_header = record_header('fresh-arxiv-rewrite-runtime-metadata', 'fresh-arxiv-rewrite-runtime-metadata')
            mf_header = record_header('fresh-arxiv-source-manifest', 'fresh-arxiv-source-manifest')
            runtime = {
                **rt_header,
                'paperId': f'arxiv:{paper_id}',
                'textSha256': text_sha,
                'title': 'A Two Author Paper Title',
                'structuredArtifacts': artifacts,
                'imageInfos': [],
                'warnings': [],
                'htmlAttempts': 0,
                'htmlAvailability': 'unavailable',
                'readerAuthors': forged_authors,
            }
            runtime_bytes = (json.dumps(runtime, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
            ext_header = record_header('official-arxiv-fulltext-extraction', 'official-arxiv-fulltext-extraction')
            manifest = {
                **mf_header,
                'arxivId': paper_id,
                'paperId': f'arxiv:{paper_id}',
                'generation': 1,
                'capturedAt': '2026-11-20T00:00:00.000Z',
                'text': {
                    'extractor': {**ext_header, 'implementation': 'pymupdf'},
                    'fetchedAt': '2026-11-20T00:00:00.000Z',
                    'filename': 'source.txt', 'source': 'pdf', 'sourceId': paper_id,
                    'url': f'https://arxiv.org/pdf/{paper_id}.pdf',
                    'responseBytes': len(text_bytes), 'responseSha256': text_sha,
                },
                'pdf': {
                    'fetchedAt': '2026-11-20T00:00:00.000Z',
                    'filename': 'source.pdf',
                    'url': f'https://arxiv.org/pdf/{paper_id}.pdf',
                    'responseBytes': len(pdf_2au), 'responseSha256': pdf_sha,
                },
                'runtimeMetadata': {
                    'filename': 'source-runtime.json',
                    'responseBytes': len(runtime_bytes),
                    'responseSha256': publisher._daily_fresh_sha256(runtime_bytes),
                },
            }
            manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
            for fname, raw in (
                ('source.txt', text_bytes),
                ('source.pdf', pdf_2au),
                ('source-runtime.json', runtime_bytes),
                ('source-manifest.json', manifest_bytes),
            ):
                p = src_dir / fname
                p.write_bytes(raw)
                os.chmod(p, 0o600)
            proof = {
                'sourceManifestSha256': publisher._daily_fresh_sha256(manifest_bytes),
                'sourceSha256': text_sha,
            }
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher._daily_fresh_read_bundle_source_identity(run_dir, paper_id, proof, {})

            # LOW-2: read_pdf_file rejects symlink via O_NOFOLLOW
            real_p = run_dir / 'real.pdf'
            link_p = run_dir / 'link.pdf'
            real_p.write_bytes(pdf_2au)
            link_p.symlink_to(real_p)
            with self.assertRaises((OSError, ValueError)):
                pae.read_pdf_file(link_p)

    def test_wave7_r2_pdf_author_extract_and_sealed_pdf_contract_guard(self):
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=595, height=842):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R2 #2a: Mode C rejects 2nd inst containing an inline email
        pdf_inline_email = make_pdf(lambda p: (
            p.insert_text((72, 80), "A Multi Inst Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 138), "Stanford University", fontsize=10),
            p.insert_text((72, 154), "Massachusetts Institute of Technology, bob@mit.edu", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_inline_email))

        # R2 #2b: Mode C rejects 2nd non-keyword org after email line
        pdf_post_email_org = make_pdf(lambda p: (
            p.insert_text((72, 80), "A Post Email Org Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 138), "Stanford University", fontsize=10),
            p.insert_text((72, 152), "alice@stanford.edu", fontsize=9),
            p.insert_text((72, 166), "OpenAI", fontsize=10),
            p.insert_text((72, 180), "bob@openai.com", fontsize=9),
            p.insert_text((72, 240), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_post_email_org))

        # R2 #3: Mode B splits multi-author 2nd clause ("while Bob White, Carol Davis, and David Lee are with ...")
        pdf_thanks_multi = make_pdf(lambda p: (
            p.insert_text((72, 80), "An IEEE Thanks Multi Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis, and David Lee", fontsize=11),
            p.insert_text((72, 180), "Abstract", fontsize=12),
            p.insert_text((72, 740), "Alice Brown is with MIT, while Bob White, Carol Davis, and David Lee are with Stanford University.", fontsize=8),
        ))
        res_tm = pae.extract_pdf_page1_authors(pdf_thanks_multi)
        self.assertIsNotNone(res_tm)
        self.assertEqual(res_tm['mode'], 'thanks')
        self.assertEqual(res_tm['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['MIT']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
            {'name': 'Carol Davis', 'affiliations': ['Stanford University']},
            {'name': 'David Lee', 'affiliations': ['Stanford University']},
        ])

        # R2 #4a: Mode C recognizes marked role footnote with email ("* Corresponding author: alice@stanford.edu")
        pdf_role_email = make_pdf(lambda p: (
            p.insert_text((72, 80), "A Single Inst With Role Email", fontsize=16),
            p.insert_text((72, 118), "Alice Brown*, Bob White", fontsize=11),
            p.insert_text((72, 138), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
            p.insert_text((72, 750), "* Corresponding author: alice@stanford.edu", fontsize=8),
        ))
        res_re = pae.extract_pdf_page1_authors(pdf_role_email)
        self.assertIsNotNone(res_re)
        self.assertEqual(res_re['mode'], 'single_institution')
        self.assertEqual(res_re['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['Stanford University']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        # R2 #4b: Mode A preserves marked non-keyword org with inline email ("2 Anthropic, alice@anthropic.com")
        pdf_marked_email = make_pdf(lambda p: (
            p.insert_text((72, 80), "A Marked Email Org Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((132, 114), "1,2", fontsize=7.5),
            p.insert_text((146, 118), ", Bob White", fontsize=11),
            p.insert_text((206, 114), "1", fontsize=7.5),
            p.insert_text((72, 138), "1", fontsize=7.5),
            p.insert_text((80, 141), "Stanford University", fontsize=10),
            p.insert_text((72, 155), "2", fontsize=7.5),
            p.insert_text((80, 158), "Anthropic, alice@anthropic.com", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_me = pae.extract_pdf_page1_authors(pdf_marked_email)
        self.assertIsNotNone(res_me)
        self.assertEqual(res_me['mode'], 'markers')
        self.assertEqual(res_me['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['Stanford University', 'Anthropic']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        # R2 #6: Standalone 7pt LaTeX superscript line merges back into author row
        pdf_7pt = make_pdf(lambda p: (
            p.insert_text((72, 80), "A 7pt Superscript Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((132, 114), "1", fontsize=7.0),
            p.insert_text((142, 118), ", Bob White", fontsize=11),
            p.insert_text((205, 114), "2", fontsize=7.0),
            p.insert_text((72, 138), "1", fontsize=7.0),
            p.insert_text((80, 141), "MIT", fontsize=10),
            p.insert_text((72, 155), "2", fontsize=7.0),
            p.insert_text((80, 158), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_7pt = pae.extract_pdf_page1_authors(pdf_7pt)
        self.assertIsNotNone(res_7pt)
        self.assertEqual(res_7pt['mode'], 'markers')
        self.assertEqual(res_7pt['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['MIT']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        # R2 #1 (CRITICAL): Python sealed source:'pdf' rejects non-null readerAuthors missing contract
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = Path(tmp)
            paper_id = '2611.99997'
            src_dir = run_dir / 'sources' / paper_id / 'generation-000001'
            src_dir.mkdir(parents=True)
            os.chmod(run_dir / 'sources' / paper_id, 0o700)
            os.chmod(src_dir, 0o700)
            text_bytes = b'A Paper\nAbstract\nBody.'
            text_sha = publisher._daily_fresh_sha256(text_bytes)
            pdf_sha = publisher._daily_fresh_sha256(pdf_role_email)
            artifacts_body = {
                'version': 1, 'source': 'fresh_arxiv_text_without_layout',
                'flattenedTextSha256': text_sha, 'tables': [], 'formulas': [], 'figures': [],
            }
            artifacts = {
                **artifacts_body,
                'payloadSha256': publisher._daily_fresh_sha256(
                    publisher._daily_fresh_compact_json_bytes(publisher._daily_fresh_canonical(artifacts_body))
                ),
            }
            from protocol_codec import record_header
            rt_header = record_header('fresh-arxiv-rewrite-runtime-metadata', 'fresh-arxiv-rewrite-runtime-metadata')
            mf_header = record_header('fresh-arxiv-source-manifest', 'fresh-arxiv-source-manifest')
            ext_header = record_header('official-arxiv-fulltext-extraction', 'official-arxiv-fulltext-extraction')
            runtime = {
                **rt_header,
                'paperId': f'arxiv:{paper_id}',
                'textSha256': text_sha,
                'title': 'A Paper',
                'structuredArtifacts': artifacts,
                'imageInfos': [],
                'warnings': [],
                'htmlAttempts': 0,
                'htmlAvailability': 'unavailable',
                'readerAuthors': {
                    'authors': [{'name': 'Alice Brown', 'affiliations': ['Forged University of Mars']}],
                    'sourceDomSha256': 'a' * 64,
                },
            }
            runtime_bytes = (json.dumps(runtime, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
            manifest = {
                **mf_header,
                'arxivId': paper_id,
                'paperId': f'arxiv:{paper_id}',
                'generation': 1,
                'capturedAt': '2026-11-20T00:00:00.000Z',
                'text': {
                    'extractor': {**ext_header, 'implementation': 'pymupdf'},
                    'fetchedAt': '2026-11-20T00:00:00.000Z',
                    'filename': 'source.txt', 'source': 'pdf', 'sourceId': paper_id,
                    'url': f'https://arxiv.org/pdf/{paper_id}.pdf',
                    'responseBytes': len(text_bytes), 'responseSha256': text_sha,
                },
                'pdf': {
                    'fetchedAt': '2026-11-20T00:00:00.000Z',
                    'filename': 'source.pdf',
                    'url': f'https://arxiv.org/pdf/{paper_id}.pdf',
                    'responseBytes': len(pdf_role_email), 'responseSha256': pdf_sha,
                },
                'runtimeMetadata': {
                    'filename': 'source-runtime.json',
                    'responseBytes': len(runtime_bytes),
                    'responseSha256': publisher._daily_fresh_sha256(runtime_bytes),
                },
            }
            manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode('utf-8')
            for fname, raw in (
                ('source.txt', text_bytes),
                ('source.pdf', pdf_role_email),
                ('source-runtime.json', runtime_bytes),
                ('source-manifest.json', manifest_bytes),
            ):
                p = src_dir / fname
                p.write_bytes(raw)
                os.chmod(p, 0o600)
            proof = {
                'sourceManifestSha256': publisher._daily_fresh_sha256(manifest_bytes),
                'sourceSha256': text_sha,
            }
            with self.assertRaisesRegex(publisher.PublishDataValidationError, 'pdf-page1-author-evidence-v1'):
                publisher._daily_fresh_read_bundle_source_identity(run_dir, paper_id, proof, {})

    def test_wave7_r3_pdf_author_extract_bypasses_and_real_sealed_papers(self):
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=595, height=842):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R3 #1: Mode B preserves unlisted cities ("Santa Cruz") and splits comma-less conjunctions
        pdf_city = make_pdf(lambda p: (
            p.insert_text((72, 80), "City Thanks Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 180), "Abstract", fontsize=12),
            p.insert_text((72, 740), "Alice Brown is with University of California, Santa Cruz, and Bob White is with MIT.", fontsize=8),
        ))
        res_city = pae.extract_pdf_page1_authors(pdf_city)
        self.assertIsNotNone(res_city)
        self.assertEqual(res_city['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['University of California, Santa Cruz']},
            {'name': 'Bob White', 'affiliations': ['MIT']},
        ])

        pdf_nocomma = make_pdf(lambda p: (
            p.insert_text((72, 80), "No Comma Thanks Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 180), "Abstract", fontsize=12),
            p.insert_text((72, 740), "Alice Brown is with MIT and Bob White is with Stanford University.", fontsize=8),
        ))
        res_nc = pae.extract_pdf_page1_authors(pdf_nocomma)
        self.assertIsNotNone(res_nc)
        self.assertEqual(res_nc['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['MIT']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        # R3 #2: Mode C rejects side-by-side inline-email insts, side-by-side non-keyword 2nd org,
        # "Org, Country/Org", and lowercase-start / parens / Unicode 2nd orgs
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 80), "Side By Side Email", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 138), "Stanford University, alice@stanford.edu", fontsize=9),
                p.insert_text((320, 138), "MIT, bob@mit.edu", fontsize=9),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Side By Side OpenAI", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 138), "Stanford University", fontsize=10),
                p.insert_text((280, 138), "OpenAI", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Anthropic USA", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 138), "Stanford University", fontsize=10),
                p.insert_text((72, 154), "Anthropic, USA", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "FAIR Meta", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 138), "Stanford University", fontsize=10),
                p.insert_text((72, 154), "FAIR, Meta", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "xAI Paper", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 138), "Stanford University", fontsize=10),
                p.insert_text((72, 154), "xAI", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "ElevenLabs Paper", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 138), "Stanford University", fontsize=10),
                p.insert_text((72, 154), "ElevenLabs (London)", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Telecom Paper", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 138), "Stanford University", fontsize=10),
                p.insert_text((72, 154), "Télécom Paris", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        # R3 #4: Marked author-email footnote & author-prefixed equal-contribution footnote do NOT leak as affiliations
        pdf_au_email = make_pdf(lambda p: (
            p.insert_text((72, 80), "Author Email Footnote Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((132, 114), "1,*", fontsize=7.5),
            p.insert_text((146, 118), ", Bob White", fontsize=11),
            p.insert_text((206, 114), "2", fontsize=7.5),
            p.insert_text((72, 138), "1", fontsize=7.5),
            p.insert_text((80, 141), "MIT", fontsize=10),
            p.insert_text((72, 155), "2", fontsize=7.5),
            p.insert_text((80, 158), "Stanford University", fontsize=10),
            p.insert_text((72, 172), "*", fontsize=7.5),
            p.insert_text((80, 175), "Alice Brown, alice@mit.edu", fontsize=9),
            p.insert_text((72, 230), "Abstract", fontsize=12),
        ))
        res_ae = pae.extract_pdf_page1_authors(pdf_au_email)
        self.assertIsNotNone(res_ae)
        self.assertEqual(res_ae['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['MIT']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
        ])

        # R3 #3 & #4 on REAL sealed arXiv PDFs (when present on disk)
        runs_root = ROOT / 'data/runtime/daily-fresh-source-runs'
        if runs_root.exists():
            def find_sealed_pdf(arxiv_id):
                matches = list(runs_root.glob(f'*/sources/{arxiv_id}/generation-000001/source.pdf'))
                return matches[0] if matches else None

            for bad_id, forbidden_substr in [
                ('2611.17070', 'focuses on research'),
                ('2611.01721', 'Modern speaker recognition'),
                ('2611.16525', 'Evaluation'),
                ('2611.00657', 'contributed equally'),
            ]:
                pdf_p = find_sealed_pdf(bad_id)
                if pdf_p is not None:
                    res_real = pae.extract_pdf_page1_authors(pdf_p.read_bytes())
                    if bad_id == '2611.00657':
                        self.assertIsNotNone(res_real, '2611.00657 must still parse cleanly after R4 Pass 2 fix')
                    if res_real is not None:
                        all_affs = [a for au in res_real['authors'] for a in au['affiliations']]
                        for aff in all_affs:
                            self.assertNotIn(forbidden_substr, aff, f'{bad_id} leaked: {aff}')

    def test_wave7_r4_pdf_author_extract_regressions_and_real_sealed_corpus(self):
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=595, height=842):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R4 #1: Mode B Tier 3 leftmost split + Org. abbreviation boundary + U.S.A. rejection
        pdf_thanks_r4 = make_pdf(lambda p: (
            p.insert_text((72, 80), "Multi Clause Footnote R4", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis", fontsize=11),
            p.insert_text((72, 180), "Abstract", fontsize=12),
            p.insert_text((50, 720), "Alice Brown is with Tencent Inc. Bob White is with Stanford University, and Carol Davis is with MIT, U.S.A.", fontsize=8),
        ))
        res_tr4 = pae.extract_pdf_page1_authors(pdf_thanks_r4)
        self.assertIsNotNone(res_tr4)
        self.assertEqual(res_tr4['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['Tencent Inc.']},
            {'name': 'Bob White', 'affiliations': ['Stanford University']},
            {'name': 'Carol Davis', 'affiliations': ['MIT, U.S.A.']},
        ])

        # R4 #2: 1-token org/brand line NOT swallowed as wrapped surname; pre-extra org & Org+Loc/Org2+Loc rejected
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 80), "Wrapped Brand Paper", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 134), "Anthropic", fontsize=10),
                p.insert_text((72, 150), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Inline Email Pre Org", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Anthropic, alice@anthropic.com", fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Two Loc Orgs", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Stanford University, USA", fontsize=10),
                p.insert_text((72, 152), "Cartesia, USA", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        # R4 #3: Multi-column IEEE cards with emails do NOT trigger BMVC 2-col merge or Mode C false binding
        pdf_ieee_2col = make_pdf(lambda p: (
            p.insert_text((72, 80), "Two Column IEEE Card Paper", fontsize=16),
            p.insert_text((72, 120), "Alice Brown", fontsize=11),
            p.insert_text((320, 120), "Bob White", fontsize=11),
            p.insert_text((72, 134), "Stanford University", fontsize=9),
            p.insert_text((320, 134), "MIT", fontsize=9),
            p.insert_text((72, 148), "alice@stanford.edu", fontsize=8.5),
            p.insert_text((320, 148), "bob@mit.edu", fontsize=8.5),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_ieee = pae.extract_pdf_page1_authors(pdf_ieee_2col)
        if res_ieee is not None:
            by_name = {a['name']: a['affiliations'] for a in res_ieee['authors']}
            self.assertEqual(by_name.get('Alice Brown'), ['Stanford University'])
            self.assertEqual(by_name.get('Bob White'), ['MIT'])

        # R4 #4 & #5: 2-word marked orgs ("UC Berkeley", "Meta FAIR"), glued "1Department"/"2DeepMind",
        # role sentences with org keywords, trailing "- Corresponding author:", and title-sized "Abstract..."
        pdf_marked_r4 = make_pdf(lambda p: (
            p.insert_text((72, 70), "Abstract Reasoning in Speech Models", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((132, 114), "1,*", fontsize=7.5),
            p.insert_text((148, 118), ", Bob White", fontsize=11),
            p.insert_text((208, 114), "2,§", fontsize=7.5),
            p.insert_text((72, 140), "1Department of EECS, UC Berkeley - Corresponding author: Alice Brown", fontsize=10),
            p.insert_text((72, 156), "2DeepMind", fontsize=10),
            p.insert_text((72, 172), "*", fontsize=7.5),
            p.insert_text((80, 174), "Work done at Google Research.", fontsize=9),
            p.insert_text((72, 188), "§", fontsize=7.5),
            p.insert_text((80, 190), "Equal contribution.", fontsize=9),
            p.insert_text((72, 240), "Abstract", fontsize=12),
        ))
        res_mr4 = pae.extract_pdf_page1_authors(pdf_marked_r4)
        self.assertIsNotNone(res_mr4)
        self.assertEqual(res_mr4['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['Department of EECS, UC Berkeley']},
            {'name': 'Bob White', 'affiliations': ['DeepMind']},
        ])

        # R4 #6: Real sealed PDFs corpus spot-checks (when present on disk)
        runs_root = ROOT / 'data/runtime/daily-fresh-source-runs'
        if runs_root.exists():
            def find_sealed_pdf(arxiv_id):
                matches = list(runs_root.glob(f'*/sources/{arxiv_id}/generation-000001/source.pdf'))
                return matches[0] if matches else None

            # IEEE 2-col cards must not misbind across columns
            for card_id in ('2610.23526', '2610.38545'):
                pdf_p = find_sealed_pdf(card_id)
                if pdf_p is not None:
                    res = pae.extract_pdf_page1_authors(pdf_p.read_bytes())
                    if res is not None:
                        self.assertNotEqual(res.get('mode'), 'single_institution', f'{card_id} must not fall back to single_institution')

            # Real sealed PDFs that must have zero role/IEEE-member/independent-researcher leaks
            for check_id, forbidden in [
                ('2609.26488', 'Work done at'),
                ('2610.14299', 'work done'),
                ('2609.21789', 'Corresponding author'),
                ('2610.19893', 'contact:'),
                ('2610.24921', 'Member, IEEE'),
                ('2609.10862', 'Independent Researcher'),
            ]:
                pdf_p = find_sealed_pdf(check_id)
                if pdf_p is not None:
                    res = pae.extract_pdf_page1_authors(pdf_p.read_bytes())
                    if res is not None:
                        for au in res['authors']:
                            self.assertNotIn(forbidden.lower(), au['name'].lower(), f'{check_id} author leaked: {au}')
                            for aff in au['affiliations']:
                                self.assertNotIn(forbidden.lower(), aff.lower(), f'{check_id} aff leaked: {aff}')

            # 2-word marked orgs regression guard (must still parse!)
            for keep_id in ('2609.08275', '2609.25491', '2609.09554'):
                pdf_p = find_sealed_pdf(keep_id)
                if pdf_p is not None:
                    res = pae.extract_pdf_page1_authors(pdf_p.read_bytes())
                    self.assertIsNotNone(res, f'{keep_id} must still parse cleanly')
                    self.assertGreater(len(res['authors']), 0)

    def test_wave7_r5_pdf_author_extract_regressions_and_sealed_leaks(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=595, height=842):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R5 #1: Linear-time non-ReDoS sanitize + chained role/contact stripping
        t0 = time.perf_counter()
        self.assertEqual(pae._sanitize_affiliation('MIT' + '; Email: ' * 40), 'MIT')
        self.assertLess(time.perf_counter() - t0, 0.05)
        self.assertEqual(
            pae._sanitize_affiliation('KAIST; Corresponding author: Alice Brown; contact: a@kaist.ac.kr'),
            'KAIST',
        )
        self.assertEqual(
            pae._sanitize_affiliation('KAIST *Equal contribution. Corresponding author: Alice Brown'),
            'KAIST',
        )
        self.assertEqual(
            pae._sanitize_affiliation('Huawei Technologies Co., Ltd. 1An earlier version of this paper was presented at ICASSP.'),
            'Huawei Technologies Co., Ltd.',
        )

        # R5 #2: Santa Cruz preserved when tier2 has comma+conj; abbrRe splits new sentence; U.S./D.C. preserved
        pdf_r5_thanks = make_pdf(lambda p: (
            p.insert_text((72, 80), "Wave 7 R5 Thanks Splitting", fontsize=16),
            p.insert_text((72, 118), "Alice A. Brown, Bob White, Carol Davis", fontsize=11),
            p.insert_text((72, 180), "Abstract", fontsize=12),
            p.insert_text(
                (40, 720),
                "Alice Brown is with University of California, Santa Cruz, and Bob White and Carol Davis are with Huawei Technologies Co., Ltd. An earlier version of this work was presented at ICASSP.",
                fontsize=7.5,
            ),
        ))
        res_t = pae.extract_pdf_page1_authors(pdf_r5_thanks)
        self.assertIsNotNone(res_t)
        self.assertEqual(res_t['authors'], [
            {'name': 'Alice A. Brown', 'affiliations': ['University of California, Santa Cruz']},
            {'name': 'Bob White', 'affiliations': ['Huawei Technologies Co., Ltd.']},
            {'name': 'Carol Davis', 'affiliations': ['Huawei Technologies Co., Ltd.']},
        ])

        pdf_dc = make_pdf(lambda p: (
            p.insert_text((72, 80), "Washington DC Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 180), "Abstract", fontsize=12),
            p.insert_text((50, 720), "Alice Brown is with Dept. of Speech, Washington, D.C., U.S. Bob White is with MIT.", fontsize=8),
        ))
        res_dc = pae.extract_pdf_page1_authors(pdf_dc)
        self.assertIsNotNone(res_dc)
        self.assertEqual(res_dc['authors'], [
            {'name': 'Alice Brown', 'affiliations': ['Dept. of Speech, Washington, D.C., U.S.']},
            {'name': 'Bob White', 'affiliations': ['MIT']},
        ])

        # R5 #4: Mode C rejects pre-extra Org+State, ZIP-tail Org2, post-email Org2, Scale AI / Meta FAIR, and 4-author + Cartesia;
        #        preserves Yang Ai and genuine wrapped surnames ("... and John" + "McDonald" / "DUPONT")
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 80), "Pre Extra Org State", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Anthropic, CA", fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Zip Tail Org2", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Stanford University", fontsize=10),
                p.insert_text((72, 152), "Anthropic, CA 94305", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Post Email Org2", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Stanford University", fontsize=10),
                p.insert_text((72, 150), "alice@stanford.edu", fontsize=9),
                p.insert_text((72, 166), "Anthropic, USA", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Scale AI Org", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Scale AI", fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Four Authors Then Cartesia", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis, David Lee", fontsize=10.5),
                p.insert_text((72, 134), "Cartesia", fontsize=10),
                p.insert_text((72, 150), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        pdf_yang_ai = make_pdf(lambda p: (
            p.insert_text((72, 80), "Speech Paper By Yang Ai", fontsize=16),
            p.insert_text((72, 118), "Yang Ai, Bob White", fontsize=11),
            p.insert_text((72, 136), "University of Science and Technology of China", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_ya = pae.extract_pdf_page1_authors(pdf_yang_ai)
        self.assertIsNotNone(res_ya)
        self.assertEqual([a['name'] for a in res_ya['authors']], ['Yang Ai', 'Bob White'])

        pdf_wrapped_surname = make_pdf(lambda p: (
            p.insert_text((72, 80), "Wrapped Surname Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, and John", fontsize=11),
            p.insert_text((72, 133), "McDonald", fontsize=11),
            p.insert_text((72, 152), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_ws = pae.extract_pdf_page1_authors(pdf_wrapped_surname)
        self.assertIsNotNone(res_ws)
        self.assertEqual([a['name'] for a in res_ws['authors']], ['Alice Brown', 'Bob White', 'John McDonald'])

        # R5 #6: Residual leaks (initialed author, Work done as an intern, correspondence should be addressed,
        #        Life Senior Member IEEE, CRediT role footnote, Division org line)
        self.assertEqual(pae._sanitize_affiliation('Work done as an intern at Google'), '')
        self.assertEqual(pae._sanitize_affiliation('Author to whom correspondence should be addressed: a@mit.edu'), '')
        self.assertEqual(pae._sanitize_affiliation('Life Senior Member, IEEE'), '')
        self.assertEqual(pae._sanitize_affiliation('Senior Member, IEEE, Fellow, IEEE'), '')

        # Real sealed PDFs from Wave 7 R5 audit (when present on disk)
        runs_root = ROOT / 'data/runtime/daily-fresh-source-runs'
        if runs_root.exists():
            def find_sealed_pdf(arxiv_id):
                matches = list(runs_root.glob(f'*/sources/{arxiv_id}/generation-000001/source.pdf'))
                return matches[0] if matches else None

            for check_id, forbidden in [
                ('2610.27459', 'earlier version'),
                ('2610.20465', 'conceptualization'),
                ('2610.20465', 'paper author roles'),
                ('2610.07486', 'Speech Division'),
                ('2609.05506', 'inc.com'),
                ('2609.05506', 'Shanghai Jiao Tong'),
                ('2609.04867', 'Shanghai Artificial'),
                ('2609.30945', 'delayless'),
            ]:
                pdf_p = find_sealed_pdf(check_id)
                if pdf_p is not None:
                    res = pae.extract_pdf_page1_authors(pdf_p.read_bytes())
                    if res is not None:
                        for au in res['authors']:
                            self.assertNotIn(forbidden.lower(), au['name'].lower(), f'{check_id} author leaked: {au}')
                            for aff in au['affiliations']:
                                if (check_id, forbidden) in {
                                    ('2609.05506', 'Shanghai Jiao Tong'),
                                    ('2609.04867', 'Shanghai Artificial'),
                                }:
                                    continue  # valid inside affiliation, forbidden ONLY as author name
                                self.assertNotIn(forbidden.lower(), aff.lower(), f'{check_id} aff leaked: {aff}')

    def test_wave7_r6_trailing_semi_credit_column_blocks_unmarked_thanks_street_and_surnames(self):
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn):
            doc = fitz.open()
            page = doc.new_page(width=612, height=792)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R6 #1: Trailing semicolon short-circuit before tail-windowed loop
        self.assertEqual(
            pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown; e-mail: a@mit.edu'),
            'MIT',
        )
        self.assertEqual(pae._sanitize_affiliation('MIT; Equal contribution;'), 'MIT')

        # R6 #3: Legitimate departments preserved, meta headings & bare domains rejected
        for legit in [
            'Institute of Computer Graphics and Visualization',
            'Department of Statistical Methodology',
            'Verification and Validation Lab',
            'Center for Scientific Investigation',
            'Division of Supervision and Control',
        ]:
            self.assertEqual(pae._sanitize_affiliation(legit), legit)
        self.assertEqual(pae._sanitize_affiliation('Paper Author Roles and Affiliations'), '')
        self.assertEqual(pae._sanitize_affiliation('inc.com'), '')

        # R6 #4: Inline-email <Org>, <Country> bypasses & Meta, Menlo Park, CA phantom author blocked; ZIP city preserved
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 80), "Multi Org Inline Email Pre", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Sesame, USA, alice@sesame.com", fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Multi Org Inline Email Post", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Stanford University, CA", fontsize=10),
                p.insert_text((72, 152), "Sesame, USA, bob@sesame.com", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Phantom Author Menlo Park", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Meta, Menlo Park, CA", fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        pdf_zip = make_pdf(lambda p: (
            p.insert_text((72, 80), "Single Inst With ZIP City", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 136), "Stanford University", fontsize=10),
            p.insert_text((72, 152), "Stanford, CA 94305", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_zip = pae.extract_pdf_page1_authors(pdf_zip)
        self.assertIsNotNone(res_zip)
        self.assertEqual(res_zip['mode'], 'single_institution')
        self.assertEqual(res_zip['authors'][0]['affiliations'], ['Stanford University, Stanford, CA 94305'])
        res_zip_v1 = pae.extract_pdf_page1_authors_legacy(pdf_zip)
        self.assertIsNotNone(res_zip_v1)
        self.assertEqual(res_zip_v1['authors'][0]['affiliations'], ['Stanford University', 'Stanford, CA 94305'])

        # R6 #5: Oxford-comma 3+-author thanks clause with middle-initial mismatch
        pdf_oxford = make_pdf(lambda p: (
            p.insert_text((72, 80), "Oxford Comma Thanks Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Carol Davis, and David Lee", fontsize=11),
            p.insert_text((72, 220), "Abstract", fontsize=12),
            p.insert_text(
                (72, 720),
                "Alice Brown is with Stanford University, while Bob White, Carol Davis, and David M. Lee are with MIT.",
                fontsize=8,
            ),
        ))
        res_ox = pae.extract_pdf_page1_authors(pdf_oxford)
        self.assertIsNotNone(res_ox)
        self.assertEqual(
            [(a['name'], a['affiliations']) for a in res_ox['authors']],
            [
                ('Alice Brown', ['Stanford University']),
                ('Bob White', ['MIT']),
                ('Carol Davis', ['MIT']),
                ('David Lee', ['MIT']),
            ],
        )

        # R6 #6: Bare street address St. rejected, legitimate numbered affiliation with street address kept
        self.assertTrue(pae._is_bare_street_address('Main St., Cambridge, MA, USA'))
        self.assertTrue(pae._is_bare_street_address('Microsoft Way, Redmond, WA'))
        self.assertFalse(pae._is_bare_street_address('University of Toronto, 40 St. George Street, Toronto, Canada'))
        self.assertFalse(pae._is_bare_street_address('Microsoft Research, One Microsoft Way, Redmond, WA'))

        # R6 #7: Valid human surnames Honda, AI (ALL-CAPS), Cloud, Fair, Bosch preserved
        for pair in [
            ('Masaaki Honda', 'Bob White'),
            ('Yang AI', 'Bob White'),
            ('YANG AI', 'BOB WHITE'),
            ('David Cloud', 'John Fair'),
            ('Louis ten Bosch', 'Bob White'),
        ]:
            pdf_nm = make_pdf(lambda p, pr=pair: (
                p.insert_text((72, 80), "Speech Paper With Real Surnames", fontsize=16),
                p.insert_text((72, 118), f"{pr[0]}, {pr[1]}", fontsize=11),
                p.insert_text((72, 136), "University of Tokyo", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ))
            res_nm = pae.extract_pdf_page1_authors(pdf_nm)
            self.assertIsNotNone(res_nm, f"Expected valid authors for {pair}")
            self.assertEqual([a['name'] for a in res_nm['authors']], list(pair))

    def test_wave7_r7_column_blocks_unlisted_ai_thanks_gutter_and_real_names(self):
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R7 #1: Multi-author IEEEtran card with "Department of Computer Science, MIT" preserves BOTH authors
        pdf_2au_card = make_pdf(lambda p: (
            p.insert_text((72, 60), "Multi-Author Card Paper", fontsize=16),
            p.insert_textbox(fitz.Rect(60, 100, 280, 210), "Alice Brown\nBob White\nDepartment of Computer Science, MIT\nalice@mit.edu", fontsize=10),
            p.insert_textbox(fitz.Rect(330, 100, 550, 210), "Carol Davis\nStanford University\ncarol@stanford.edu", fontsize=10),
            p.insert_text((72, 260), "Abstract", fontsize=12),
        ))
        res_card = pae.extract_pdf_page1_authors(pdf_2au_card)
        self.assertIsNotNone(res_card)
        self.assertEqual(res_card['mode'], 'column_blocks')
        self.assertEqual(
            [(a['name'], a['affiliations']) for a in res_card['authors']],
            [
                ('Alice Brown', ['Department of Computer Science, MIT']),
                ('Bob White', ['Department of Computer Science, MIT']),
                ('Carol Davis', ['Stanford University']),
            ],
        )

        # R7 #2: Unlisted "<Org> AI" (Pine AI) blocked as phantom author & in multi-institution rows
        pdf_pine_pre = make_pdf(lambda p: (
            p.insert_text((72, 80), "Pine AI Multi Org Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 136), "Pine AI", fontsize=10),
            p.insert_text((72, 152), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_pine_pre))

        # R7 #3: Inline-email Inst 1 sets saw_resource_after_inst -> Sesame, CA becomes ambiguous
        for extra_line in ("Sesame, CA", "Sesame, CA, bob@s-ai.com"):
            pdf_ie1 = make_pdf(lambda p, el=extra_line: (
                p.insert_text((72, 80), "Inline Email Inst 1 Paper", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Stanford University, alice@stanford.edu", fontsize=10),
                p.insert_text((72, 152), el, fontsize=10),
                p.insert_text((72, 168), "bob@sesame.com", fontsize=9),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ))
            self.assertIsNone(pae.extract_pdf_page1_authors(pdf_ie1))

        # R7 #4: ORCID, DOI, and residual "; ." stripped BEFORE role loop
        self.assertEqual(pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown; (e-mail: a@mit.edu).'), 'MIT')
        self.assertEqual(pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown; ORCID: 0000-0002-1825-0097'), 'MIT')
        self.assertEqual(pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown; | DOI: 10.1109/ICASSP.2026.12345'), 'MIT')

        # R7 #5: Thanks splitter non-comma " and " and comma-splice before 3+-author Oxford-comma list
        for foot in (
            "Alice Brown is with Stanford University and Bob White, Carol Davis, and David Lee are with MIT.",
            "Alice Brown is with Stanford University, Bob White, Carol Davis, and David Lee are with MIT.",
        ):
            res_t = pae._try_mode_thanks([], [{'text': foot, 'x0': 50.0, 'x1': 290.0, 'y0': 700.0}], 612.0)
            self.assertIsNotNone(res_t)
            self.assertEqual(
                [(a['name'], a['affiliations']) for a in res_t[0]],
                [
                    ('Alice Brown', ['Stanford University']),
                    ('Bob White', ['MIT']),
                    ('Carol Davis', ['MIT']),
                    ('David Lee', ['MIT']),
                ],
            )

        # R7 #6: "Menlo Park, California" followed by "Stanford University" does not create phantom "Menlo Park"
        pdf_mp = make_pdf(lambda p: (
            p.insert_text((72, 80), "Menlo Park Full State Paper", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 136), "Menlo Park, California", fontsize=10),
            p.insert_text((72, 152), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_mp))

        # R7 #7: Justified left-column footnote fragment near gutter (x0=277.9 on 612pt page) coalesces cleanly
        res_gutter = pae._try_mode_thanks(
            [],
            [
                {'text': 'Qiaolin He is with the', 'x0': 50.0, 'x1': 272.0, 'y0': 607.7},
                {'text': 'School', 'x0': 277.9, 'x1': 300.0, 'y0': 607.7},
                {'text': 'of Electronics, Sun Yat-sen University, China.', 'x0': 50.0, 'x1': 270.0, 'y0': 617.7},
            ],
            612.0,
        )
        self.assertIsNotNone(res_gutter)
        self.assertEqual(
            res_gutter[0],
            [{'name': 'Qiaolin He', 'affiliations': ['School of Electronics, Sun Yat-sen University, China']}],
        )

        # R7 #8: Real surnames Grant & given name Athena preserved
        self.assertTrue(pae._is_valid_author_name('Christan Grant'))
        self.assertTrue(pae._is_valid_author_name('Athena Dai'))
        self.assertFalse(pae._is_valid_author_name('Grant Support'))

        # Optional real sealed corpus checks (when local runtime archive is present)
        runs_root = ROOT / 'data' / 'runtime' / 'daily-fresh-source-runs'
        if runs_root.is_dir():
            def find_sealed_pdf(aid):
                for p in runs_root.glob(f'*/sources/{aid}/generation-000001/source.pdf'):
                    return p
                return None
            for aid in ('2610.02774', '2610.07545', '2609.11353'):
                p = find_sealed_pdf(aid)
                if p:
                    r = pae.extract_pdf_page1_authors(p.read_bytes())
                    self.assertIsNotNone(r, f'Sealed IEEEtran paper {aid} must extract cleanly')
                    self.assertEqual(r['mode'], 'column_blocks', aid)
            p_pine = find_sealed_pdf('2609.04225')
            if p_pine:
                self.assertIsNone(pae.extract_pdf_page1_authors(p_pine.read_bytes()), '2609.04225 Pine AI + UW must not misbind')
            p_gutter = find_sealed_pdf('2609.18470')
            if p_gutter:
                r = pae.extract_pdf_page1_authors(p_gutter.read_bytes())
                self.assertIsNotNone(r)
                self.assertTrue(any('School of Electronics' in a for au in r['authors'] for a in au['affiliations']), r['authors'])
            p_grant = find_sealed_pdf('2609.07968')
            if p_grant:
                r = pae.extract_pdf_page1_authors(p_grant.read_bytes())
                self.assertIsNotNone(r)
                self.assertIn('Christan Grant', [au['name'] for au in r['authors']])

    def test_wave7_r8_redos_multi_inst_mode_d_orcid_locations_and_thanks_proximity(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R8 #1 (CRITICAL): Linear-time O(n) dangling tail stripping — n=50000 completes in <100ms
        redos_payload = 'MIT; ' + (' . ' * 50000) + 'x'
        t0 = time.perf_counter()
        out = pae._sanitize_affiliation(redos_payload)
        elapsed = time.perf_counter() - t0
        self.assertLess(elapsed, 0.1, f'R8 #1 ReDoS guard failed ({elapsed:.3f}s)')
        self.assertTrue(out.startswith('MIT'))
        self.assertEqual(pae._sanitize_affiliation('MIT; . , ; .'), 'MIT')

        # R8 #2: Inline-email Pine AI, inline-URL Anthropic/Stanford, Pine AI CA, OpenAI + Anthropic rejected
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 80), "Pine AI Email Pre", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Pine AI, alice@pine.ai", fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Anthropic URL Pre", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Anthropic, https://anthropic.com", fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "Pine AI CA Post", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "Stanford University", fontsize=10),
                p.insert_text((72, 152), "Pine AI, CA", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 80), "OpenAI Anthropic Side", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), "OpenAI", fontsize=10),
                p.insert_text((280, 136), "Anthropic", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        # R8 #4: Mode D preserves 2nd author above "Technology Center", rejects "Management and Organizations",
        #        rejects Pine AI as author in Mode D, and rejects sealed 2611.05638 corruption
        self.assertFalse(pae._is_valid_author_name('Management and Organizations'))
        pdf_tech_center = make_pdf(lambda p: (
            p.insert_text((72, 60), "Technology Center Card Paper", fontsize=16),
            p.insert_textbox(fitz.Rect(60, 100, 280, 210), "Alice Brown\nBob White\nTechnology Center, MIT\nalice@mit.edu", fontsize=10),
            p.insert_textbox(fitz.Rect(330, 100, 550, 210), "Carol Davis\nStanford University\ncarol@stanford.edu", fontsize=10),
            p.insert_text((72, 260), "Abstract", fontsize=12),
        ))
        res_tc = pae.extract_pdf_page1_authors(pdf_tech_center)
        self.assertIsNotNone(res_tc)
        self.assertEqual(res_tc['mode'], 'column_blocks')
        self.assertEqual([a['name'] for a in res_tc['authors']], ['Alice Brown', 'Bob White', 'Carol Davis'])

        pdf_pine_card = make_pdf(lambda p: (
            p.insert_text((72, 60), "Pine AI Card Paper", fontsize=16),
            p.insert_textbox(fitz.Rect(60, 100, 280, 210), "Alice Brown\nPine AI\nalice@pine.ai", fontsize=10),
            p.insert_textbox(fitz.Rect(330, 100, 550, 210), "Bob White\nStanford University\nbob@stanford.edu", fontsize=10),
            p.insert_text((72, 260), "Abstract", fontsize=12),
        ))
        res_pc = pae.extract_pdf_page1_authors(pdf_pine_card)
        if res_pc is not None:
            self.assertNotIn('Pine AI', [a['name'] for a in res_pc['authors']])

        # R8 #5: Lowercase ORCID/DOI + trailing dot + bare whitespace stripped before role loop
        self.assertEqual(pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown; doi: 10.1109/ICASSP.2026.12345.'), 'MIT')
        self.assertEqual(pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown orcid: 0000-0002-1825-0097.'), 'MIT')

        # R8 #6: Multi-word US states / Canadian provinces rejected as phantom authors
        for loc_line in ("New York, New York", "Salt Lake City, Utah", "Vancouver, British Columbia"):
            pdf_loc = make_pdf(lambda p, ll=loc_line: (
                p.insert_text((72, 80), "Multi Word State Paper", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), ll, fontsize=10),
                p.insert_text((72, 152), "Stanford University", fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ))
            self.assertIsNone(pae.extract_pdf_page1_authors(pdf_loc), f'R8 #6 must reject {loc_line}')

        # R8 #7: Mode B proximity row-clustering tolerates 0.1pt y0 jitter straddling 2.5pt bucket boundary
        res_jitter = pae._try_mode_thanks(
            [],
            [
                {'text': 'Qiaolin He is with the', 'x0': 50.0, 'x1': 272.0, 'y0': 601.2},
                {'text': 'School', 'x0': 277.9, 'x1': 300.0, 'y0': 601.3},
                {'text': 'of Electronics, Sun Yat-sen University, China.', 'x0': 50.0, 'x1': 270.0, 'y0': 611.3},
            ],
            612.0,
        )
        self.assertIsNotNone(res_jitter)
        self.assertEqual(
            res_jitter[0],
            [{'name': 'Qiaolin He', 'affiliations': ['School of Electronics, Sun Yat-sen University, China']}],
        )

        # Sealed 2611.05638 regression check (when local runtime archive is present)
        runs_root = ROOT / 'data' / 'runtime' / 'daily-fresh-source-runs'
        if runs_root.is_dir():
            for p in runs_root.glob('*/sources/2611.05638/generation-000001/source.pdf'):
                r = pae.extract_pdf_page1_authors(p.read_bytes())
                if r is not None:
                    for au in r['authors']:
                        self.assertNotIn('management and organizations', au['name'].lower(), r['authors'])
                        self.assertNotIn('university', au['name'].lower(), r['authors'])
                break

    def test_wave7_r9_redos_mode_d_email_chained_orcid_doi_dots_multi_ai_and_col_partition(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R9 #1: All hot-path ReDoS payloads complete strictly linearly (<100ms)
        for label, payload in [
            ("brace_no_at", "{a}" * 20000),
            ("long_a_with_at", "A" * 30000 + " bob@mit.edu"),
            ("paren_brace", "({a}" * 10000),
            ("open_brace", "{" * 15000 + "}x"),
            ("unclosed_email_paren", "MIT " + "(email " * 10000),
        ]:
            t0 = time.perf_counter()
            pae._sanitize_affiliation(payload)
            dt = time.perf_counter() - t0
            self.assertLess(dt, 0.1, f'R9 #1 Python ReDoS {label} took {dt:.3f}s')

        # R9 #3: Mode D stacked cards sharing a PyMuPDF block with email between them must NOT corrupt Author 1 / drop Author 2
        pdf_d_email = make_pdf(lambda p: (
            p.insert_text((72, 60), "Mode D Stacked Cards With Email", fontsize=16),
            p.insert_textbox(
                fitz.Rect(60, 100, 280, 260),
                "Alice Brown\nStanford University\nalice@stanford.edu\nBob White\nMIT\nbob@mit.edu",
                fontsize=10,
            ),
            p.insert_textbox(
                fitz.Rect(330, 100, 550, 200),
                "Carol Davis\nCMU\ncarol@cmu.edu",
                fontsize=10,
            ),
            p.insert_text((72, 320), "Abstract", fontsize=12),
        ))
        res_de = pae.extract_pdf_page1_authors(pdf_d_email)
        if res_de is not None:
            for au in res_de['authors']:
                for aff in au['affiliations']:
                    self.assertNotIn('Bob White', aff, res_de['authors'])

        # R9 #4: Chained trailing ORCID + DOI and multiple ORCIDs strip cleanly before role loop
        self.assertEqual(
            pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown; ORCID: 0000-0002-1825-0097; DOI: 10.1109/ICASSP.2026.12345'),
            'MIT',
        )
        self.assertEqual(
            pae._sanitize_affiliation('MIT; Corresponding author: Alice Brown; ORCID: 0000-0002-1825-0097; ORCID: 0000-0001-5109-3700'),
            'MIT',
        )

        # R9 #5: Whitespace-preceded dots ("MIT . . .") stripped while abbreviation dots ("Inc.") preserved
        self.assertEqual(pae._sanitize_affiliation('MIT (e-mail: a@mit.edu) .'), 'MIT')
        self.assertEqual(pae._sanitize_affiliation('MIT . . .'), 'MIT')
        self.assertEqual(pae._sanitize_affiliation('Huawei Technologies Inc.'), 'Huawei Technologies Inc.')

        # R9 #6: Multi-org unlisted AI row ("Pine AI, Nova AI") rejected as phantom authors
        pdf_multi_ai = make_pdf(lambda p: (
            p.insert_text((72, 80), "Multi Unlisted AI Orgs", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 136), "Pine AI, Nova AI", fontsize=10),
            p.insert_text((72, 152), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_multi_ai))

        # R9 #7: Mode B partitions left/right columns BEFORE y0 clustering so unrelated right-col y0 never drops left-col fragment
        res_col = pae._try_mode_thanks(
            [],
            [
                {'text': 'Right col text.', 'x0': 320.0, 'x1': 560.0, 'y0': 698.0},
                {'text': 'Alice Brown is with the', 'x0': 50.0, 'x1': 292.0, 'y0': 700.2},
                {'text': 'School', 'x0': 297.0, 'x1': 305.0, 'y0': 700.7},
                {'text': 'of Electronics, Stanford University.', 'x0': 50.0, 'x1': 270.0, 'y0': 710.7},
            ],
            612.0,
        )
        self.assertIsNotNone(res_col)
        self.assertEqual(
            res_col[0],
            [{'name': 'Alice Brown', 'affiliations': ['School of Electronics, Stanford University']}],
        )

    def test_wave7_r10_redos_cursor_mode_b_single_col_mode_d_fail_closed_locations_and_mode_a_guards(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R10 #1: Strictly O(n) end-cursor sanitizers & thanks parens (<150ms)
        for label, fn in [
            ("doi_redos", lambda: pae._sanitize_affiliation("10.1234/" * 8000 + "!")),
            ("chained_orcid", lambda: pae._sanitize_affiliation("MIT" + "; 0000-0002-1825-0097" * 4000)),
            ("chained_role", lambda: pae._sanitize_affiliation("A-" * 4000 + "; Corresponding author: x" * 2000)),
            ("thanks_paren", lambda: pae._try_mode_thanks([], [{"text": "(email " * 8000, "x0": 50.0, "x1": 500.0, "y0": 700.0}], 612.0)),
        ]:
            t0 = time.perf_counter()
            fn()
            dt = time.perf_counter() - t0
            self.assertLess(dt, 0.15, f"R10 #1 Python ReDoS {label} took {dt:.3f}s")

        # R10 #2: Single-column footnote split near mid_x must NOT cross-bind authors
        res_single_col = pae._try_mode_thanks(
            [],
            [
                {"text": "Alice Brown is with Department of CS,", "x0": 72.0, "x1": 304.0, "y0": 700.0},
                {"text": "Stanford University.", "x0": 308.0, "x1": 450.0, "y0": 700.0},
                {"text": "Bob White is with Department of EECS,", "x0": 72.0, "x1": 304.0, "y0": 710.0},
                {"text": "MIT.", "x0": 308.0, "x1": 340.0, "y0": 710.0},
            ],
            612.0,
        )
        self.assertIsNotNone(res_single_col)
        self.assertEqual(
            res_single_col[0],
            [
                {"name": "Alice Brown", "affiliations": ["Department of CS, Stanford University"]},
                {"name": "Bob White", "affiliations": ["Department of EECS, MIT"]},
            ],
        )

        # R10 #3: Mode D stacked card with email before b_affs AND 3-col fail-closed rejection (no silent truncation)
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 60), "Mode D Unlisted Org Email Stacked", fontsize=16),
                p.insert_textbox(fitz.Rect(60, 100, 280, 280), "Alice Brown\nAnthropic\nalice@anthropic.com\nBob White\nStanford University\nbob@stanford.edu", fontsize=10),
                p.insert_textbox(fitz.Rect(330, 100, 550, 200), "Carol Davis\nCMU\ncarol@cmu.edu", fontsize=10),
                p.insert_text((72, 320), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 60), "Mode D Email Only Before Author 2", fontsize=16),
                p.insert_textbox(fitz.Rect(60, 100, 280, 280), "Alice Brown\nalice@mit.edu\nBob White\nStanford University\nbob@stanford.edu", fontsize=10),
                p.insert_textbox(fitz.Rect(330, 100, 550, 200), "Carol Davis\nCMU\ncarol@cmu.edu", fontsize=10),
                p.insert_text((72, 320), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 60), "Mode D 3-Col Fail Closed", fontsize=16),
                p.insert_textbox(fitz.Rect(40, 100, 200, 280), "Alice Brown\nStanford University\nalice@stanford.edu\nBob White\nMIT\nbob@mit.edu", fontsize=10),
                p.insert_textbox(fitz.Rect(220, 100, 380, 200), "Carol Davis\nCMU\ncarol@cmu.edu", fontsize=10),
                p.insert_textbox(fitz.Rect(400, 100, 560, 200), "David Lee\nHarvard University\ndavid@harvard.edu", fontsize=10),
                p.insert_text((72, 320), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        # R10 #5: Parenthesized brace-email with trailing punctuation/role & comma-glued emails
        self.assertEqual(pae._sanitize_affiliation("MIT ({a,b}@mit.edu)."), "MIT")
        self.assertEqual(pae._sanitize_affiliation("MIT ({a,b}@mit.edu); Equal contribution"), "MIT")
        self.assertEqual(pae._sanitize_affiliation("Stanford University,alice@stanford.edu"), "Stanford University")
        self.assertEqual(pae._sanitize_affiliation("MIT,alice@mit.edu"), "MIT")

        # R10 #7: 3-part locations, non-ASCII cities, Mode A continuation guards (date & raw marker 2), & gap-separated Athena Dai
        for inst, loc in [
            ("Stanford University", "Stanford, CA, USA"),
            ("Tsinghua University", "Beijing, 100084, China"),
            ("ETH Zurich", "Zürich, Switzerland"),
        ]:
            pdf_loc = make_pdf(lambda p, i=inst, l=loc: (
                p.insert_text((72, 80), "Single Inst 3-Part Location", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), i, fontsize=10),
                p.insert_text((72, 152), l, fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ))
            res_loc = pae.extract_pdf_page1_authors(pdf_loc)
            self.assertIsNotNone(res_loc, f"R10 #7 failed on {inst} / {loc}")
            self.assertEqual([a["name"] for a in res_loc["authors"]], ["Alice Brown", "Bob White"])

        pdf_mode_a_guards = make_pdf(lambda p: (
            p.insert_text((72, 80), "Mode A Continuation Guards", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((132, 114), "1", fontsize=7.5),
            p.insert_text((140, 118), ", Bob White", fontsize=11),
            p.insert_text((200, 114), "2", fontsize=7.5),
            p.insert_text((72, 140), "1", fontsize=7.5),
            p.insert_text((80, 142), "Stanford University", fontsize=10),
            p.insert_text((72, 155), "2 MIT, Cambridge", fontsize=10),
            p.insert_text((72, 168), "November 20, 2026", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_ma = pae.extract_pdf_page1_authors(pdf_mode_a_guards)
        self.assertIsNotNone(res_ma)
        self.assertEqual(res_ma["authors"], [
            {"name": "Alice Brown", "affiliations": ["Stanford University"]},
            {"name": "Bob White", "affiliations": ["MIT, Cambridge"]},
        ])

        pdf_gap_athena = make_pdf(lambda p: (
            p.insert_text((72, 80), "Gap Separated Athena Authors", fontsize=16),
            p.insert_text((60, 118), "Athena Dai", fontsize=11),
            p.insert_text((160, 118), "Bob White", fontsize=11),
            p.insert_text((260, 118), "Carol Davis", fontsize=11),
            p.insert_text((360, 118), "David Lee", fontsize=11),
            p.insert_text((72, 140), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_ga = pae.extract_pdf_page1_authors(pdf_gap_athena)
        self.assertIsNotNone(res_ga)
        self.assertEqual(
            [a["name"] for a in res_ga["authors"]],
            ["Athena Dai", "Bob White", "Carol Davis", "David Lee"],
        )

    def test_wave7_r11_redos_mode_b_footer_mode_d_bypasses_mode_c_contact_all_caps_angles_and_rok(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R11 #1: All Python ReDoS / O(n^2) payloads complete strictly linearly (<200ms)
        for label, fn in [
            ("star_tail", lambda: pae._parse_authors_from_lines([{"text": "*" * 15000 + "x", "base_size": 10.0, "base_y": 100.0, "x0": 50.0, "x1": 500.0, "y0": 90.0, "y1": 102.0, "spans": [{"text": "*" * 15000 + "x", "size": 10.0, "flags": 0, "origin_y": 100.0, "bbox": (50.0, 90.0, 500.0, 102.0)}]}], set(), set())),
            ("space_run", lambda: pae._parse_authors_from_lines([{"text": "Alice Brown", "base_size": 10.0, "base_y": 100.0, "x0": 50.0, "x1": 500.0, "y0": 90.0, "y1": 102.0, "spans": [{"text": "Alice" + " " * 15000 + "Brown", "size": 10.0, "flags": 0, "origin_y": 100.0, "bbox": (50.0, 90.0, 500.0, 102.0)}]}], set(), set())),
            ("thanks_commas", lambda: pae._try_mode_thanks([], [{"text": "Alice Brown is with MIT, " + "Bob White, " * 600 + "Carol Davis is with CMU.", "x0": 50.0, "x1": 290.0, "y0": 700.0}], 612.0)),
        ]:
            t0 = time.perf_counter()
            fn()
            dt = time.perf_counter() - t0
            self.assertLess(dt, 0.25, f"R11 #1 Python ReDoS ({label}) took {dt:.3f}s")

        # R11 #2: Full-width IEEE copyright banner below two-column footnotes does NOT cross-bind columns
        res_footer = pae._try_mode_thanks(
            [],
            [
                {"text": "Alice Brown is with", "x0": 50.0, "x1": 290.0, "y0": 690.0},
                {"text": "MIT. Carol Davis is with", "x0": 315.0, "x1": 555.0, "y0": 690.0},
                {"text": "Stanford University.", "x0": 50.0, "x1": 290.0, "y0": 700.0},
                {"text": "CMU.", "x0": 315.0, "x1": 555.0, "y0": 700.0},
                {"text": "979-8-3503-0000-0/26/$31.00 (c) 2026 IEEE. Personal use is permitted.", "x0": 72.0, "x1": 540.0, "y0": 755.0},
            ],
            612.0,
        )
        self.assertIsNotNone(res_footer)
        self.assertEqual(
            res_footer[0],
            [
                {"name": "Alice Brown", "affiliations": ["Stanford University"]},
                {"name": "Carol Davis", "affiliations": ["CMU"]},
            ],
        )

        # R11 #3: Mode D fail-closed on unlisted stacked org, stacked Athena Dai, and 3-col multi-author Col 1
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_textbox(fitz.Rect(60, 100, 280, 260), "Alice Brown\nAnthropic\nBob White\nStanford University", fontsize=10),
                p.insert_textbox(fitz.Rect(330, 100, 550, 200), "Carol Davis\nCMU", fontsize=10),
                p.insert_text((72, 320), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_textbox(fitz.Rect(60, 100, 280, 260), "Alice Brown\nStanford University\nalice@stanford.edu\nAthena Dai\nMIT\nathena@mit.edu", fontsize=10),
                p.insert_textbox(fitz.Rect(330, 100, 550, 200), "Carol Davis\nCMU\ncarol@cmu.edu", fontsize=10),
                p.insert_text((72, 320), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_textbox(fitz.Rect(40, 100, 200, 200), "Alice Brown, Bob White\nStanford University", fontsize=10),
                p.insert_textbox(fitz.Rect(220, 100, 380, 200), "Carol Davis\nMIT", fontsize=10),
                p.insert_textbox(fitz.Rect(400, 100, 560, 200), "David Lee\nCMU", fontsize=10),
                p.insert_text((72, 260), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        # R11 #4: Mode C inline email + second org (semicolon, pre-gap, post-gap-loc) rejected
        for draw_fn in [
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "Stanford University", fontsize=10), p.insert_text((72, 152), "alice@stanford.edu; MIT", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "alice@stanford.edu", fontsize=10), p.insert_text((280, 136), "Anthropic", fontsize=10), p.insert_text((72, 152), "Stanford University", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "Stanford University", fontsize=10), p.insert_text((72, 152), "alice@stanford.edu", fontsize=10), p.insert_text((280, 152), "Sesame, CA", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        # R11 #5: ALL-CAPS 2nd-line author & gap-separated ALL-CAPS author row preserved
        pdf_ac_2 = make_pdf(lambda p: (
            p.insert_text((72, 80), "Speech Study", fontsize=16),
            p.insert_text((72, 118), "ALICE BROWN, BOB WHITE", fontsize=11),
            p.insert_text((72, 134), "CAROL DAVIS", fontsize=11),
            p.insert_text((72, 154), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_ac2 = pae.extract_pdf_page1_authors(pdf_ac_2)
        self.assertIsNotNone(res_ac2)
        self.assertEqual([a["name"] for a in res_ac2["authors"]], ["ALICE BROWN", "BOB WHITE", "CAROL DAVIS"])

        pdf_ac_gap = make_pdf(lambda p: (
            p.insert_text((72, 80), "Speech Study", fontsize=16),
            p.insert_text((72, 118), "ALICE BROWN", fontsize=11),
            p.insert_text((200, 118), "BOB WHITE", fontsize=11),
            p.insert_text((72, 140), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_acg = pae.extract_pdf_page1_authors(pdf_ac_gap)
        self.assertIsNotNone(res_acg)
        self.assertEqual([a["name"] for a in res_acg["authors"]], ["ALICE BROWN", "BOB WHITE"])

        # R11 #6: Angle-bracket emails, parenthesized URLs, and Inc. dot after parenthetical brace email
        self.assertEqual(pae._sanitize_affiliation("Stanford University <alice@stanford.edu>"), "Stanford University")
        self.assertEqual(pae._sanitize_affiliation("Stanford University (https://stanford.edu)"), "Stanford University")
        self.assertEqual(pae._sanitize_affiliation("MIT Inc. ({a,b}@mit.edu)."), "MIT Inc.")

        # R11 #7: Republic of Korea / USA / DC locations & Mode A Keywords: guard
        for inst, loc in [
            ("KAIST", "Daejeon, Republic of Korea"),
            ("MIT", "Cambridge, United States of America"),
            ("Georgetown University", "Washington, District of Columbia"),
        ]:
            pdf_rok = make_pdf(lambda p, i=inst, l=loc: (
                p.insert_text((72, 80), "T", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), i, fontsize=10),
                p.insert_text((72, 152), l, fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ))
            res_rok = pae.extract_pdf_page1_authors(pdf_rok)
            self.assertIsNotNone(res_rok, f"R11 #7 failed on {inst} / {loc}")
            self.assertEqual([a["name"] for a in res_rok["authors"]], ["Alice Brown", "Bob White"])

        pdf_kw = make_pdf(lambda p: (
            p.insert_text((72, 80), "T", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((132, 114), "1", fontsize=7.5),
            p.insert_text((140, 118), ", Bob White", fontsize=11),
            p.insert_text((200, 114), "2", fontsize=7.5),
            p.insert_text((72, 140), "1", fontsize=7.5),
            p.insert_text((80, 142), "Stanford University", fontsize=10),
            p.insert_text((72, 155), "2", fontsize=7.5),
            p.insert_text((80, 157), "MIT", fontsize=10),
            p.insert_text((72, 170), "Keywords: ASR, TTS", fontsize=9),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_kw = pae.extract_pdf_page1_authors(pdf_kw)
        self.assertIsNotNone(res_kw)
        self.assertEqual(res_kw["authors"], [
            {"name": "Alice Brown", "affiliations": ["Stanford University"]},
            {"name": "Bob White", "affiliations": ["MIT"]},
        ])

    def test_wave7_r12_redos_mode_b_bands_mode_c_raw_url_mode_d_fail_closed_and_mode_a_sup(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R12 #1: Python linear-time guards (em-space, thanks and-run, same-row 3000-span Mode B)
        for label, fn in [
            ("em_space", lambda: pae._parse_authors_from_lines([{"text": "Alice Brown", "base_size": 10.0, "base_y": 100.0, "x0": 50.0, "x1": 500.0, "y0": 90.0, "y1": 102.0, "spans": [{"text": "Alice" + "\u2003" * 15000 + "Brown", "size": 10.0, "flags": 0, "origin_y": 100.0, "bbox": (50.0, 90.0, 500.0, 102.0)}]}], set(), set())),
            ("thanks_and_run", lambda: pae._try_mode_thanks([], [{"text": "Alice Brown is with MIT " + "and Bob White " * 3000 + "is with CMU.", "x0": 50.0, "x1": 290.0, "y0": 700.0}], 612.0)),
            ("same_row_3000", lambda: pae._try_mode_thanks([], [{"text": f"s{i}", "x0": 50.0, "x1": 100.0, "y0": 700.0} for i in range(3000)] + [{"text": "r", "x0": 350.0, "x1": 450.0, "y0": 700.0}], 612.0)),
        ]:
            t0 = time.perf_counter()
            fn()
            dt = time.perf_counter() - t0
            self.assertLess(dt, 0.25, f"R12 #1 Python ReDoS ({label}) took {dt:.3f}s")

        # R12 #2: Mode B 3-span y0 drift single-col + 2-line wrapped IEEE copyright / page number below 2-col footnotes
        res_drift = pae._try_mode_thanks(
            [],
            [
                {"text": "Alice Brown", "x0": 72.0, "x1": 150.0, "y0": 698.0},
                {"text": "is with Dept. of CS,", "x0": 154.0, "x1": 304.0, "y0": 700.0},
                {"text": "Stanford University.", "x0": 308.0, "x1": 450.0, "y0": 700.6},
                {"text": "Bob White", "x0": 72.0, "x1": 150.0, "y0": 710.0},
                {"text": "is with Dept. of EECS,", "x0": 154.0, "x1": 304.0, "y0": 712.0},
                {"text": "MIT.", "x0": 308.0, "x1": 340.0, "y0": 712.6},
            ],
            612.0,
        )
        self.assertIsNotNone(res_drift)
        self.assertEqual(res_drift[0], [
            {"name": "Alice Brown", "affiliations": ["Dept. of CS, Stanford University"]},
            {"name": "Bob White", "affiliations": ["Dept. of EECS, MIT"]},
        ])

        res_wrap_copy = pae._try_mode_thanks(
            [],
            [
                {"text": "Alice Brown is with", "x0": 50.0, "x1": 290.0, "y0": 690.0},
                {"text": "MIT. Carol Davis is with", "x0": 315.0, "x1": 555.0, "y0": 690.0},
                {"text": "Stanford University.", "x0": 50.0, "x1": 290.0, "y0": 700.0},
                {"text": "CMU.", "x0": 315.0, "x1": 555.0, "y0": 700.0},
                {"text": "979-8-3503-0000-0/26/$31.00 (c) 2026 IEEE. Personal use is permitted.", "x0": 72.0, "x1": 540.0, "y0": 755.0},
                {"text": "IEEE permission.", "x0": 50.0, "x1": 140.0, "y0": 763.0},
                {"text": "1", "x0": 300.0, "x1": 310.0, "y0": 772.0},
            ],
            612.0,
        )
        self.assertIsNotNone(res_wrap_copy)
        self.assertEqual(res_wrap_copy[0], [
            {"name": "Alice Brown", "affiliations": ["Stanford University"]},
            {"name": "Carol Davis", "affiliations": ["CMU"]},
        ])

        # R12 #3: Mode C single-span double-space/tab multi-inst, URL contact parity, URL hostname match,
        # bracketed email comma split, and valid city-university preservation
        for draw_fn in [
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "Stanford University   Massachusetts Institute of Technology", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "Stanford University  MIT", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "Stanford University, www.stanford.edu", fontsize=10), p.insert_text((72, 152), "Sesame, CA, https://sesame.ai", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "Sesame, CA, https://sesame.ai", fontsize=10), p.insert_text((72, 152), "Stanford University", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "Stanford University", fontsize=10), p.insert_text((72, 152), "Sesame, CA   https://sesame.ai", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
            lambda p: (p.insert_text((72, 80), "T", fontsize=16), p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11), p.insert_text((72, 136), "MIT (alice@mit.edu), Stanford University (bob@stanford.edu)", fontsize=10), p.insert_text((72, 220), "Abstract", fontsize=12)),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        for inst, loc_line, loc_only in [
            ("Stanford University", "Stanford, CA, alice@stanford.edu", "Stanford, CA"),
            ("University of Tokyo", "Tokyo, Japan, alice@u-tokyo.ac.jp", "Tokyo, Japan"),
            ("University of Sydney", "Sydney, Australia, alice@sydney.edu.au", "Sydney, Australia"),
            ("UC Berkeley", "Berkeley, CA, alice@berkeley.edu", "Berkeley, CA"),
        ]:
            pdf_cu = make_pdf(lambda p, i=inst, ll=loc_line: (
                p.insert_text((72, 80), "T", fontsize=16),
                p.insert_text((72, 118), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 136), i, fontsize=10),
                p.insert_text((72, 152), ll, fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ))
            res_cu = pae.extract_pdf_page1_authors(pdf_cu)
            self.assertIsNotNone(res_cu, f"R12 #3 city-university falsely rejected: {inst} / {loc_line}")
            self.assertEqual(res_cu["authors"], [
                {"name": "Alice Brown", "affiliations": [f"{inst}, {loc_only}"]},
                {"name": "Bob White", "affiliations": [f"{inst}, {loc_only}"]},
            ])
            res_cu_v1 = pae.extract_pdf_page1_authors_legacy(pdf_cu)
            self.assertIsNotNone(res_cu_v1)
            self.assertEqual(res_cu_v1["authors"], [
                {"name": "Alice Brown", "affiliations": [inst, loc_only]},
                {"name": "Bob White", "affiliations": [inst, loc_only]},
            ])

        # R12 #4: Mode D fails closed on multi-author line after line 0, and preserves 1-line brand org cards (OpenAI/Pine AI)
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_textbox(fitz.Rect(60, 100, 280, 220), "Alice Brown\nBob White, Carol Davis\nStanford University", fontsize=10),
                p.insert_textbox(fitz.Rect(330, 100, 550, 220), "David Lee\nMIT", fontsize=10),
                p.insert_text((72, 280), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_textbox(fitz.Rect(60, 100, 280, 280), "Alice Brown\nStanford University\nalice@stanford.edu\nBob White, Carol Davis\nMIT\nbob@mit.edu", fontsize=10),
                p.insert_textbox(fitz.Rect(330, 100, 550, 220), "David Lee\nCMU\ndavid@cmu.edu", fontsize=10),
                p.insert_text((72, 320), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        pdf_brand = make_pdf(lambda p: (
            p.insert_text((72, 60), "T", fontsize=16),
            p.insert_textbox(fitz.Rect(40, 100, 200, 200), "Alice Brown\nOpenAI\nalice@openai.com", fontsize=10),
            p.insert_textbox(fitz.Rect(220, 100, 380, 200), "Bob White\nMIT\nbob@mit.edu", fontsize=10),
            p.insert_textbox(fitz.Rect(400, 100, 560, 200), "Carol Davis\nCMU\ncarol@cmu.edu", fontsize=10),
            p.insert_text((72, 260), "Abstract", fontsize=12),
        ))
        res_brand = pae.extract_pdf_page1_authors(pdf_brand)
        self.assertIsNotNone(res_brand)
        self.assertEqual(res_brand["authors"], [
            {"name": "Alice Brown", "affiliations": ["OpenAI"]},
            {"name": "Bob White", "affiliations": ["MIT"]},
            {"name": "Carol Davis", "affiliations": ["CMU"]},
        ])

        # R12 #6: Python sanitizer strips space-padded email wrappers & unclosed brace paren
        self.assertEqual(pae._sanitize_affiliation("Stanford University ({alice, bob,"), "Stanford University")
        self.assertEqual(pae._sanitize_affiliation("Stanford University ( alice@stanford.edu )"), "Stanford University")
        self.assertEqual(pae._sanitize_affiliation("Stanford University < alice@stanford.edu >"), "Stanford University")

        # R12 #7: Mode A continuation rejects interleaved marked author rows & CCS Concepts:
        pdf_interleaved = make_pdf(lambda p: (
            p.insert_text((72, 60), "T", fontsize=16),
            p.insert_text((72, 100), "Alice Brown", fontsize=11),
            p.insert_text((132, 96), "1", fontsize=7.5),
            p.insert_text((140, 100), ", Carol Davis", fontsize=11),
            p.insert_text((208, 96), "1", fontsize=7.5),
            p.insert_text((72, 118), "1", fontsize=7.5),
            p.insert_text((80, 120), "Stanford University", fontsize=10),
            p.insert_text((72, 134), "Bob White", fontsize=11),
            p.insert_text((126, 130), "2", fontsize=7.5),
            p.insert_text((134, 134), ", David Lee", fontsize=11),
            p.insert_text((196, 130), "2", fontsize=7.5),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_int = pae.extract_pdf_page1_authors(pdf_interleaved)
        self.assertIsNotNone(res_int)
        self.assertEqual(res_int["authors"], [
            {"name": "Alice Brown", "affiliations": ["Stanford University"]},
            {"name": "Carol Davis", "affiliations": ["Stanford University"]},
        ])
        pdf_ccs = make_pdf(lambda p: (
            p.insert_text((72, 60), "T", fontsize=16),
            p.insert_text((72, 100), "Alice Brown", fontsize=11),
            p.insert_text((132, 96), "1", fontsize=7.5),
            p.insert_text((140, 100), ", Bob White", fontsize=11),
            p.insert_text((198, 96), "2", fontsize=7.5),
            p.insert_text((72, 118), "1", fontsize=7.5),
            p.insert_text((80, 120), "Stanford University", fontsize=10),
            p.insert_text((72, 134), "2", fontsize=7.5),
            p.insert_text((80, 136), "MIT", fontsize=10),
            p.insert_text((72, 148), "CCS Concepts: Speech, Audio", fontsize=9),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        res_ccs = pae.extract_pdf_page1_authors(pdf_ccs)
        self.assertIsNotNone(res_ccs)
        self.assertEqual(res_ccs["authors"], [
            {"name": "Alice Brown", "affiliations": ["Stanford University"]},
            {"name": "Bob White", "affiliations": ["MIT"]},
        ])

    def test_wave7_r13_redos_multi_inst_mode_d_title_accents_parity_and_sanitizer(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn):
            doc = fitz.open()
            page = doc.new_page(width=612, height=792)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R13 #4 & #6: Strictly O(n) / O(L log L) on IEEE member repeats & Mode B vertical bands
        t0 = time.perf_counter()
        fake_lines = [{
            "block": 1, "x0": 72.0, "x1": 500.0, "y0": 100.0, "y1": 112.0,
            "max_size": 11.0, "base_size": 11.0, "base_y": 110.0,
            "text": "Alice Brown" + " , Member, IEEE" * 4000 + " Bob White",
            "spans": [{"text": "Alice Brown" + " , Member, IEEE" * 4000 + " Bob White", "size": 11.0, "flags": 0, "origin_y": 110.0, "bbox": (72.0, 100.0, 500.0, 112.0)}],
        }]
        pae._parse_authors_from_lines(fake_lines, set(), set(), is_two_col=False)
        self.assertLess(time.perf_counter() - t0, 0.25)

        t1 = time.perf_counter()
        fw = [{"text": "f", "x0": 50.0, "x1": 550.0, "y0": 600.0 + i * 0.01} for i in range(2000)]
        loc = [{"text": "l", "x0": 50.0, "x1": 100.0, "y0": 750.0 + i * 0.01} for i in range(2000)]
        pae._try_mode_thanks([], fw + loc, 612.0)
        self.assertLess(time.perf_counter() - t1, 0.25)

        # R13 #7 & #8: Bare/[...] email/URL comma multi-institution & wide-gap/3+-space Sesame, CA fail closed
        for bad_line in [
            "MIT, alice@mit.edu, Stanford University, bob@stanford.edu",
            "MIT [alice@mit.edu], Stanford University [bob@stanford.edu]",
            "MIT, https://mit.edu, Stanford University, https://stanford.edu",
            "MIT, e-mail: alice@mit.edu, Stanford University, e-mail: bob@stanford.edu",
            "Stanford University, alice@stanford.edu, MIT",
            "Stanford University     Sesame, CA",
            "Stanford University, CA   Sesame, CA",
        ]:
            pdf_bad = make_pdf(lambda p, line=bad_line: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_text((72, 100), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 120), line, fontsize=10),
                p.insert_text((72, 200), "Abstract", fontsize=12),
            ))
            self.assertIsNone(pae.extract_pdf_page1_authors(pdf_bad), f"R13 #7/#8 expected None: {bad_line}")
        pdf_gap_sesame = make_pdf(lambda p: (
            p.insert_text((72, 60), "T", fontsize=16),
            p.insert_text((72, 100), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 120), "Stanford University", fontsize=10),
            p.insert_text((300, 120), "Sesame, CA", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_gap_sesame))

        # R13 #9: Mode D rejects marked multi-author enumerations & keeps author Yang AI before USTC
        for draw_fn in [
            lambda p: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_textbox(fitz.Rect(40, 100, 200, 200), "Alice Brown*, Bob White*\nStanford University", fontsize=10),
                p.insert_textbox(fitz.Rect(220, 100, 380, 200), "Carol Davis\nMIT", fontsize=10),
                p.insert_textbox(fitz.Rect(400, 100, 560, 200), "David Lee\nCMU", fontsize=10),
                p.insert_text((72, 260), "Abstract", fontsize=12),
            ),
            lambda p: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_textbox(fitz.Rect(60, 100, 280, 220), "Alice Brown\nBob White*, Carol Davis\nStanford University", fontsize=10),
                p.insert_textbox(fitz.Rect(330, 100, 550, 220), "David Lee\nMIT", fontsize=10),
                p.insert_text((72, 260), "Abstract", fontsize=12),
            ),
        ]:
            self.assertIsNone(pae.extract_pdf_page1_authors(make_pdf(draw_fn)))

        pdf_yang_ai = make_pdf(lambda p: (
            p.insert_text((72, 60), "T", fontsize=16),
            p.insert_textbox(fitz.Rect(60, 100, 280, 220), "Alice Brown\nYang AI\nUSTC", fontsize=10),
            p.insert_textbox(fitz.Rect(330, 100, 550, 220), "David Lee\nMIT", fontsize=10),
            p.insert_text((72, 260), "Abstract", fontsize=12),
        ))
        res_yang = pae.extract_pdf_page1_authors(pdf_yang_ai)
        self.assertIsNotNone(res_yang)
        self.assertEqual(res_yang["authors"], [
            {"name": "Alice Brown", "affiliations": ["USTC"]},
            {"name": "Yang AI", "affiliations": ["USTC"]},
            {"name": "David Lee", "affiliations": ["MIT"]},
        ])

        # R13 #11 & #12: LaTeX spacing diacritics + H.-P. Du accepted; unanchored role & CRediT rejected
        self.assertEqual(pae._clean_ws("Melissa Ram\u00b4\u0131rez"), "Melissa Ramírez")
        self.assertEqual(pae._clean_ws("Okko R\u00a8as\u00a8anen"), "Okko Räsänen")
        self.assertTrue(pae._is_valid_author_name("H.-P. Du"))
        self.assertTrue(pae._is_valid_author_name("J.-C. Lin"))
        self.assertFalse(pae._is_valid_author_name("Alice Brown Contributed Equally"))
        self.assertFalse(pae._is_valid_author_name("Alice Brown Is Corresponding Author"))
        self.assertFalse(pae._is_valid_author_name("Formal Analysis"))

        # R13 #14: Mode A continuation rejects prose, IEEE member authors, marked authors, copyright lines
        for bad_cont in [
            "First, we propose",
            "Carol Davis, Member, IEEE",
            "Carol Davis*, David Lee",
            "2026, All Rights Reserved",
        ]:
            pdf_mc = make_pdf(lambda p, line=bad_cont: (
                p.insert_text((72, 60), "T", fontsize=16),
                p.insert_text((72, 100), "Alice Brown", fontsize=11),
                p.insert_text((132, 96), "1", fontsize=7.5),
                p.insert_text((140, 100), ", Bob White", fontsize=11),
                p.insert_text((198, 96), "2", fontsize=7.5),
                p.insert_text((72, 118), "1", fontsize=7.5),
                p.insert_text((80, 120), "Stanford University", fontsize=10),
                p.insert_text((72, 134), "2", fontsize=7.5),
                p.insert_text((80, 136), "MIT", fontsize=10),
                p.insert_text((80, 148), line, fontsize=10),
                p.insert_text((72, 220), "Abstract", fontsize=12),
            ))
            res_mc = pae.extract_pdf_page1_authors(pdf_mc)
            self.assertIsNotNone(res_mc)
            self.assertEqual(res_mc["authors"], [
                {"name": "Alice Brown", "affiliations": ["Stanford University"]},
                {"name": "Bob White", "affiliations": ["MIT"]},
            ], f"R13 #14 leaked continuation: {bad_cont}")

        # R13 #15: Space-padded bracketed email/URL/brace wrappers leave zero dangling brackets
        for raw_aff in [
            "Stanford University ( e-mail: alice@stanford.edu )",
            "Stanford University < e-mail: alice@stanford.edu >",
            "Stanford University [ e-mail: alice@stanford.edu ]",
            "Stanford University ( https://stanford.edu )",
            "Stanford University < https://stanford.edu >",
            "Stanford University ( {alice,bob}@stanford.edu )",
            "Stanford University ( {alice, bob,",
        ]:
            self.assertEqual(pae._sanitize_affiliation(raw_aff), "Stanford University", f"R13 #15: {raw_aff}")

    def test_wave7_r14_redos_corp_suffixes_cedilla_wraps_subtitles_sanitizer_nickname_cjk_and_bullets(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn):
            doc = fitz.open()
            page = doc.new_page(width=595, height=842)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R14 #2: Linear-time bare-email comma splitter
        t0 = time.monotonic()
        pae._is_multi_institution_unmarked_line("a" * 40000 + " x@y.com")
        self.assertLess(time.monotonic() - t0, 0.25)

        # R14 #4: Dot-ending corporate suffixes & Mode C fail-open
        for s in ["Philips B.V., Netherlands", "Societe S.A., France", "Societe S.A.S., France", "Firma A.G., Germany", "Azienda S.r.l., Italy", "Sony K.K., Japan"]:
            self.assertTrue(pae._has_affiliation_hint(s), s)
            self.assertFalse(pae._is_valid_author_name(s.split(",")[0]), s)
        pdf_bv = make_pdf(lambda p: (
            p.insert_text((72, 60), "Speech Paper", fontsize=16),
            p.insert_text((72, 100), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 120), "Stanford University", fontsize=10),
            p.insert_text((72, 136), "Philips B.V., Netherlands", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_bv))

        # R14 #5 & #12 #2: <SurnameCollidingOrgHead> <Location> rejected; real names & 2-char CJK preserved
        for bad in ["Bosch Germany", "Sony Japan", "Apple USA", "Honda Japan", "Athena France"]:
            self.assertFalse(pae._is_valid_author_name(bad), bad)
        for ok in ["Louis ten Bosch", "Athena Dai", "Masaaki Honda", "John Apple", "Mila Novak", "张三", "John (Toby) Van Der Berg"]:
            self.assertTrue(pae._is_valid_author_name(ok), ok)

        # R14 #6: Suffix cedilla & backtick quote safety
        self.assertEqual(pae._normalize_pua("Jean-Franc\u00b8ois Bonastre"), "Jean-François Bonastre")
        self.assertEqual(pae._normalize_pua("C\u00b8 a\u02d8gdas\u00b8 Bilen"), "Çağdaş Bilen")
        self.assertEqual(pae._normalize_pua("``Audio''"), "``Audio''")
        self.assertEqual(pae._normalize_pua("Polit`ecnica"), "Politècnica")

        # R14 #7 & #9 #3: Mid-author wrap, trailing 'and', and 5+ comma-separated superscripts
        pdf_wrap = make_pdf(lambda p: (
            p.insert_text((72, 60), "Wrapped Authors", fontsize=16),
            p.insert_text((72, 100), "Alice Brown", fontsize=11),
            p.insert_text((130, 96), "1", fontsize=7.5),
            p.insert_text((136, 100), ", Xinchen", fontsize=11),
            p.insert_text((72, 118), "Yuan", fontsize=11),
            p.insert_text((100, 114), "2", fontsize=7.5),
            p.insert_text((106, 118), ", Wei Ye", fontsize=11),
            p.insert_text((148, 114), "1", fontsize=7.5),
            p.insert_text((155, 118), "and", fontsize=11),
            p.insert_text((72, 136), "Rui Fan", fontsize=11),
            p.insert_text((112, 132), "1,2", fontsize=7.5),
            p.insert_text((72, 160), "1", fontsize=7.5),
            p.insert_text((80, 162), "MIT", fontsize=10),
            p.insert_text((72, 176), "2", fontsize=7.5),
            p.insert_text((80, 178), "Stanford University", fontsize=10),
            p.insert_text((72, 230), "Abstract", fontsize=12),
        ))
        res_wrap = pae.extract_pdf_page1_authors(pdf_wrap)
        self.assertIsNotNone(res_wrap)
        self.assertEqual([a["name"] for a in res_wrap["authors"]], ["Alice Brown", "Xinchen Yuan", "Wei Ye", "Rui Fan"])

        # R14 #8: First-line larger-font subtitle / lowercase 'and' title continuation rejected
        pdf_sub = make_pdf(lambda p: (
            p.insert_text((72, 60), "Main Title About Audio", fontsize=16),
            p.insert_text((72, 82), "and Conversation-Grounded Expansion", fontsize=14.5),
            p.insert_text((72, 110), "Alice Brown, Bob White, Carol Davis", fontsize=11),
            p.insert_text((72, 130), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_sub = pae.extract_pdf_page1_authors(pdf_sub)
        self.assertIsNotNone(res_sub)
        self.assertEqual([a["name"] for a in res_sub["authors"]], ["Alice Brown", "Bob White", "Carol Davis"])

        # R14 #11: Sanitizer brace-email without @, Contactless, parenthetical role, U.S.A./U.K./D.C./B.V., www.
        self.assertEqual(pae._sanitize_affiliation("Auditory Lab, SJTU ({lichenda1996, herobrine}sjtu.edu.cn)"), "Auditory Lab, SJTU")
        self.assertEqual(pae._sanitize_affiliation("Contactless Sensing Laboratory"), "Contactless Sensing Laboratory")
        self.assertEqual(pae._sanitize_affiliation("Stanford University (work was done while at Meta)"), "Stanford University")
        self.assertEqual(pae._sanitize_affiliation("Stanford University (equal contribution)"), "Stanford University")
        self.assertEqual(pae._sanitize_affiliation("Stanford University, U.S.A."), "Stanford University, U.S.A.")
        self.assertEqual(pae._sanitize_affiliation("University of Oxford, U.K."), "University of Oxford, U.K.")
        self.assertEqual(pae._sanitize_affiliation("Washington, D.C."), "Washington, D.C.")
        self.assertEqual(pae._sanitize_affiliation("Philips B.V."), "Philips B.V.")
        self.assertEqual(pae._sanitize_affiliation("www.example.com"), "")

        # R14 #12 #1: Thanks preserves mid-name nickname
        pdf_nick = make_pdf(lambda p: (
            p.insert_text((72, 60), "Nickname Paper", fontsize=16),
            p.insert_text((72, 100), "John (Toby) Van Der Berg, Bob White", fontsize=11),
            p.insert_text((72, 200), "Abstract", fontsize=12),
            p.insert_text((72, 740), "John (Toby) Van Der Berg is with MIT. Bob White is with Stanford University.", fontsize=8),
        ))
        res_nick = pae.extract_pdf_page1_authors(pdf_nick)
        self.assertIsNotNone(res_nick)
        self.assertEqual(res_nick["authors"], [
            {"name": "John (Toby) Van Der Berg", "affiliations": ["MIT"]},
            {"name": "Bob White", "affiliations": ["Stanford University"]},
        ])

        # R14 #13: Bullet marker • (with prose guard) & Mode D preposition-space join
        pdf_bullet = make_pdf(lambda p: (
            p.insert_htmlbox(
                fitz.Rect(72, 60, 520, 400),
                '<div style="font-size:16pt">Bullet Marker Paper</div>'
                '<div style="font-size:11pt">Kwanghee Choi&#x2022;, Bob White*</div>'
                '<div style="font-size:10pt">&#x2022;UT Austin, USA</div>'
                '<div style="font-size:10pt">*Stanford University</div>'
                '<div style="font-size:12pt">Abstract</div>',
            ),
        ))
        res_b = pae.extract_pdf_page1_authors(pdf_bullet)
        self.assertIsNotNone(res_b)
        self.assertEqual(res_b["authors"], [
            {"name": "Kwanghee Choi", "affiliations": ["UT Austin, USA"]},
            {"name": "Bob White", "affiliations": ["Stanford University"]},
        ])
        pdf_col_prep = make_pdf(lambda p: (
            p.insert_text((72, 60), "Preposition Column Join", fontsize=16),
            p.insert_text((72, 100), "Alice Brown", fontsize=11),
            p.insert_text((72, 114), "Central Conservatory of", fontsize=9.5),
            p.insert_text((72, 126), "Music", fontsize=9.5),
            p.insert_text((72, 138), "Beijing, China", fontsize=9.5),
            p.insert_text((320, 100), "Bob White", fontsize=11),
            p.insert_text((320, 114), "MIT", fontsize=9.5),
            p.insert_text((320, 126), "Cambridge, USA", fontsize=9.5),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_cp = pae.extract_pdf_page1_authors(pdf_col_prep)
        self.assertIsNotNone(res_cp)
        self.assertEqual(res_cp["authors"][0]["affiliations"], ["Central Conservatory of Music, Beijing, China"])

    def test_wave7_r15_redos_locations_initials_wraps_roles_quotes_subtitles_and_symbols(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R15 #1: ReDoS linear time + whitespace collapse
        for payload in [
            "MIT" + "(email)" * 15000 + " www.",
            "MIT" + "(email)" * 30000 + " :",
            "MIT" + "(email)" * 15000 + " {a}!",
        ]:
            t0 = time.perf_counter()
            pae._sanitize_affiliation(payload)
            self.assertLess(time.perf_counter() - t0, 0.25)
        self.assertEqual(
            pae._sanitize_affiliation("MIT (email: a@mit.edu) (equal contribution) Computer Science"),
            "MIT Computer Science",
        )

        # R15 #4, #5, #10, #13a, #13b, #13e
        self.assertFalse(pae._is_valid_author_name("Bosch United Kingdom"))
        self.assertFalse(pae._is_valid_author_name("Apple United States"))
        self.assertFalse(pae._is_valid_author_name("Sony Hong Kong"))
        self.assertTrue(pae._is_valid_author_name("Athena Ma"))
        self.assertTrue(pae._is_valid_author_name("Mila Oh"))
        self.assertTrue(pae._is_valid_author_name("K.K. Paliwal"))
        self.assertTrue(pae._is_valid_author_name("John Oppo"))
        self.assertTrue(pae._is_valid_author_name('Jan “Honza” Silovsky'))
        self.assertTrue(pae._is_valid_author_name('Jan "Honza" Silovsky'))
        self.assertEqual(pae._normalize_pua("``audio''"), "``audio''")
        self.assertEqual(pae._normalize_pua("``in-the-wild''"), "``in-the-wild''")
        self.assertEqual(pae._sanitize_affiliation("Keywords: ASR, TTS"), "")
        self.assertEqual(pae._sanitize_affiliation("Index Terms: ASR, TTS"), "")
        self.assertEqual(pae._sanitize_affiliation("Work carried out while at MIT"), "")
        self.assertEqual(pae._sanitize_affiliation("\x9b University Libraries, Carnegie Mellon University"), "University Libraries, Carnegie Mellon University")

        # R15 #4 fail-open Mode C check: Bosch United Kingdom + Stanford University rejected
        pdf_bu = make_pdf(lambda p: (
            p.insert_text((72, 60), "Speech Study", fontsize=16),
            p.insert_text((72, 100), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 118), "Bosch United Kingdom", fontsize=10),
            p.insert_text((72, 134), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_bu))

        # R15 #7a: Unmarked mid-author wrap ("Xinchen" / "Yuan, Carol Davis")
        pdf_umw = make_pdf(lambda p: (
            p.insert_text((72, 60), "Unmarked Wrap Paper", fontsize=16),
            p.insert_text((72, 100), "Alice Brown, Bob White, Xinchen", fontsize=11),
            p.insert_text((72, 114), "Yuan, Carol Davis", fontsize=11),
            p.insert_text((72, 134), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_umw = pae.extract_pdf_page1_authors(pdf_umw)
        self.assertIsNotNone(res_umw)
        self.assertEqual([a["name"] for a in res_umw["authors"]], ["Alice Brown", "Bob White", "Xinchen Yuan", "Carol Davis"])

        # R15 #7b: Nobiliary wrap ("Gonzalo" / "de Polavieja") with superscript markers
        pdf_nob = make_pdf(lambda p: (
            p.insert_text((72, 60), "Nobiliary Wrap Paper", fontsize=16),
            p.insert_text((72, 100), "Alice Brown", fontsize=11),
            p.insert_text((135, 96), "1", fontsize=7),
            p.insert_text((140, 100), ", Gonzalo", fontsize=11),
            p.insert_text((72, 114), "de Polavieja", fontsize=11),
            p.insert_text((135, 110), "2", fontsize=7),
            p.insert_text((72, 134), "1", fontsize=7),
            p.insert_text((78, 137), "MIT", fontsize=10),
            p.insert_text((72, 148), "2", fontsize=7),
            p.insert_text((78, 151), "Champalimaud Foundation", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_nob = pae.extract_pdf_page1_authors(pdf_nob)
        self.assertIsNotNone(res_nob)
        self.assertEqual([a["name"] for a in res_nob["authors"]], ["Alice Brown", "Gonzalo de Polavieja"])
        self.assertEqual(
            [a["affiliations"] for a in res_nob["authors"]],
            [["MIT"], ["Champalimaud Foundation"]],
        )

        # R15 #11: Mode B preserves trailing abbreviation dot on Ltd., U.K., S.r.l.
        res_tb = pae._try_mode_thanks(
            [],
            [{"text": "Alice Brown is with Huawei Technologies Co., Ltd. Bob White is with Imperial College London, U.K. Carol Davis is with Azienda S.r.l.", "x0": 50.0, "x1": 290.0, "y0": 700.0}],
            612.0,
        )
        self.assertIsNotNone(res_tb)
        self.assertEqual(
            [(a["name"], a["affiliations"]) for a in res_tb[0]],
            [
                ("Alice Brown", ["Huawei Technologies Co., Ltd."]),
                ("Bob White", ["Imperial College London, U.K."]),
                ("Carol Davis", ["Azienda S.r.l."]),
            ],
        )

        # R15 #12: Same-block title subtitle does not leak phantom authors
        pdf_sub = make_pdf(lambda p: (
            p.insert_text((72, 80), "A State-Space Model of Figured-Bass Realization", fontsize=17.2),
            p.insert_text((72, 96), "Local Constraints, Coupled Voices, and Polynomial-Time Solvability", fontsize=12.0),
            p.insert_text((200, 126), "Evan Unit Lim", fontsize=12.0),
            p.insert_text((170, 144), "National Taiwan Normal University", fontsize=10.9),
            p.insert_text((72, 210), "Abstract", fontsize=12),
        ))
        res_sub = pae.extract_pdf_page1_authors(pdf_sub)
        self.assertIsNotNone(res_sub)
        self.assertEqual(res_sub["authors"], [{"name": "Evan Unit Lim", "affiliations": ["National Taiwan Normal University"]}])

    def test_wave7_r16_redos_initials_us_role_wraps_sup_id_mode_d_and_sealed_corpus(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn) -> bytes:
            doc = fitz.open()
            page = doc.new_page(width=612, height=792)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R16 #2 & #3: O(n) ReDoS guards on bare URL comma splitter & thanks sentence merger
        t0 = time.perf_counter()
        self.assertFalse(pae._is_multi_institution_unmarked_line("http://" * 16000))
        self.assertFalse(pae._is_multi_institution_unmarked_line("www." * 16000))
        self.assertLess(time.perf_counter() - t0, 0.25)

        t0 = time.perf_counter()
        pae._try_mode_thanks(
            [],
            [{"text": "Alice Brown is with " + "Inc. " * 8000 + "Bob White is with MIT.", "x0": 50.0, "x1": 500.0, "y0": 700.0}],
            612.0,
        )
        self.assertLess(time.perf_counter() - t0, 0.25)

        # R16 #4: Initialed authors B.V. Kumar / A.G. Howard / S.A. King accepted; Philips B.V. rejected as author
        for nm in ("B.V. Kumar", "A.G. Howard", "S.A. King", "John B.V. Kumar"):
            self.assertTrue(pae._is_valid_author_name(nm), nm)
        self.assertFalse(pae._is_valid_author_name("Philips B.V."))
        self.assertTrue(pae._has_affiliation_hint("Philips B.V., Eindhoven"))

        # R16 #5: US / U.S. location codes
        for bad in ("Apple US", "Bosch US", "Sony US", "Honda US"):
            self.assertFalse(pae._is_valid_author_name(bad), bad)
        for loc in ("Cambridge, U.S.", "Cambridge, US"):
            self.assertTrue(pae._is_location_only_line(loc), loc)

        # R16 #6: Role footnote with optional "the"
        self.assertEqual(pae._sanitize_affiliation("represents the corresponding author. This work was supported by NSFC."), "")
        self.assertEqual(pae._sanitize_affiliation("MIT, * represents the corresponding author."), "MIT")

        # R16 #8a: Unmarked GAP-separated wrapped surname
        pdf_gap_wrap = make_pdf(lambda p: (
            p.insert_text((72, 60), "GAP Wrapped Surname Study", fontsize=16),
            p.insert_text((72, 100), "Alice Brown", fontsize=11),
            p.insert_text((170, 100), "Bob White", fontsize=11),
            p.insert_text((260, 100), "Xinchen", fontsize=11),
            p.insert_text((72, 114), "Yuan", fontsize=11),
            p.insert_text((150, 114), "Carol Davis", fontsize=11),
            p.insert_text((72, 134), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_gap_wrap = pae.extract_pdf_page1_authors(pdf_gap_wrap)
        self.assertIsNotNone(res_gap_wrap)
        self.assertEqual([a["name"] for a in res_gap_wrap["authors"]], ["Alice Brown", "Bob White", "Xinchen Yuan", "Carol Davis"])

        # R16 #8b: Symbol-marked wrapped surname ("Xinchen\nYuan*^2")
        pdf_sym_wrap = make_pdf(lambda p: (
            p.insert_text((72, 60), "Symbol Wrapped Surname Study", fontsize=16),
            p.insert_text((72, 100), "Alice Brown", fontsize=11),
            p.insert_text((134, 96), "1", fontsize=7),
            p.insert_text((140, 100), ", Xinchen", fontsize=11),
            p.insert_text((72, 114), "Yuan*", fontsize=11),
            p.insert_text((104, 110), "2", fontsize=7),
            p.insert_text((110, 114), ", Carol Davis", fontsize=11),
            p.insert_text((178, 110), "1", fontsize=7),
            p.insert_text((72, 134), "1", fontsize=7),
            p.insert_text((78, 137), "MIT", fontsize=10),
            p.insert_text((72, 148), "2", fontsize=7),
            p.insert_text((78, 151), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_sym_wrap = pae.extract_pdf_page1_authors(pdf_sym_wrap)
        self.assertIsNotNone(res_sym_wrap)
        self.assertEqual([a["name"] for a in res_sym_wrap["authors"]], ["Alice Brown", "Xinchen Yuan", "Carol Davis"])
        self.assertEqual([a["affiliations"] for a in res_sym_wrap["authors"]], [["MIT"], ["Stanford University"], ["MIT"]])

        # R16 #8c: Oxford-comma trailing "and" wrap in Mode C
        pdf_ox_wrap = make_pdf(lambda p: (
            p.insert_text((72, 60), "Oxford Comma Wrap Study", fontsize=16),
            p.insert_text((72, 100), "Alice Brown, Bob White, and", fontsize=11),
            p.insert_text((72, 114), "Carol Davis", fontsize=11),
            p.insert_text((72, 134), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_ox_wrap = pae.extract_pdf_page1_authors(pdf_ox_wrap)
        self.assertIsNotNone(res_ox_wrap)
        self.assertEqual([a["name"] for a in res_ox_wrap["authors"]], ["Alice Brown", "Bob White", "Carol Davis"])

        # R16 #9: Superscript symbol marker before ORCID ID ("Efthymios Georgiou[[SUP:*]] ID [[SUP:2]]")
        pdf_sup_id = make_pdf(lambda p: (
            p.insert_text((72, 60), "Interspeech ORCID Sup Study", fontsize=16),
            p.insert_text((72, 100), "Georgios Syllas ID", fontsize=11),
            p.insert_text((170, 96), "1", fontsize=7),
            p.insert_text((176, 100), ", Efthymios Georgiou", fontsize=11),
            p.insert_text((284, 96), "*", fontsize=7),
            p.insert_text((290, 100), " ID", fontsize=11),
            p.insert_text((308, 96), "2", fontsize=7),
            p.insert_text((72, 134), "1", fontsize=7),
            p.insert_text((78, 137), "MIT", fontsize=10),
            p.insert_text((72, 148), "2", fontsize=7),
            p.insert_text((78, 151), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_sup_id = pae.extract_pdf_page1_authors(pdf_sup_id)
        self.assertIsNotNone(res_sup_id)
        self.assertEqual(
            [(a["name"], a["affiliations"]) for a in res_sup_id["authors"]],
            [("Georgios Syllas", ["MIT"]), ("Efthymios Georgiou", ["Stanford University"])],
        )

        # R16 #10: Mode D same-row merge sorts fragments by x0 and uses max base_size
        res_mode_d = pae._try_mode_column_blocks([
            {"text": "\u02da", "block": 1, "x0": 109.0, "x1": 112.0, "y0": 99.5, "y1": 105.0, "base_size": 7.0, "max_size": 7.0, "is_bold": False, "is_italic": False, "spans": [{"text": "\u02da", "bbox": [109.0, 99.5, 112.0, 105.0]}]},
            {"text": "Kalle", "block": 1, "x0": 80.0, "x1": 108.0, "y0": 101.0, "y1": 112.0, "base_size": 11.0, "max_size": 11.0, "is_bold": True, "is_italic": False, "spans": [{"text": "Kalle", "bbox": [80.0, 101.0, 108.0, 112.0]}]},
            {"text": "Aström", "block": 1, "x0": 113.0, "x1": 150.0, "y0": 101.0, "y1": 112.0, "base_size": 11.0, "max_size": 11.0, "is_bold": True, "is_italic": False, "spans": [{"text": "Aström", "bbox": [113.0, 101.0, 150.0, 112.0]}]},
            {"text": "Lund University", "block": 1, "x0": 80.0, "x1": 160.0, "y0": 118.0, "y1": 128.0, "base_size": 9.5, "max_size": 9.5, "is_bold": False, "is_italic": True, "spans": [{"text": "Lund University", "bbox": [80.0, 118.0, 160.0, 128.0]}]},
            {"text": "Bob White", "block": 2, "x0": 320.0, "x1": 380.0, "y0": 101.0, "y1": 112.0, "base_size": 11.0, "max_size": 11.0, "is_bold": True, "is_italic": False, "spans": [{"text": "Bob White", "bbox": [320.0, 101.0, 380.0, 112.0]}]},
            {"text": "MIT", "block": 2, "x0": 320.0, "x1": 345.0, "y0": 118.0, "y1": 128.0, "base_size": 9.5, "max_size": 9.5, "is_bold": False, "is_italic": True, "spans": [{"text": "MIT", "bbox": [320.0, 118.0, 345.0, 128.0]}]},
        ], 612.0)
        self.assertIsNotNone(res_mode_d)
        self.assertEqual(
            [(a["name"], a["affiliations"]) for a in res_mode_d[0]],
            [("Kalle Åström", ["Lund University"]), ("Bob White", ["MIT"])],
        )

        # R16 #11: Thanks "<Abbr>. while ...", glued sentence after parenthetical email & B.V., case-insensitive preserved dots
        for txt, expected in (
            (
                "Alice Brown is with Huawei Technologies Co., Ltd. while Bob White is with MIT.",
                [("Alice Brown", ["Huawei Technologies Co., Ltd."]), ("Bob White", ["MIT"])],
            ),
            (
                "Alice Brown is with Philips B.V. while Bob White is with MIT.",
                [("Alice Brown", ["Philips B.V."]), ("Bob White", ["MIT"])],
            ),
        ):
            res_tw = pae._try_mode_thanks([], [{"text": txt, "x0": 50.0, "x1": 500.0, "y0": 700.0}], 612.0)
            self.assertIsNotNone(res_tw)
            self.assertEqual([(a["name"], a["affiliations"]) for a in res_tw[0]], expected)
        self.assertEqual(pae._sanitize_affiliation("Sony Corp. (e-mail: a@sony.com) This work was supported by NSF."), "Sony Corp.")
        self.assertEqual(pae._sanitize_affiliation("Philips B.V. This work was supported by NSF."), "Philips B.V.")
        self.assertEqual(pae._sanitize_affiliation("Azienda s.r.l."), "Azienda s.r.l.")
        self.assertEqual(pae._sanitize_affiliation("Tencent Co., LTD."), "Tencent Co., LTD.")

        # R16 #12: smaller_non_title_fallback preserves 2-author "and" line, U+2225 ∥, Index Terms—
        self.assertEqual(pae._sanitize_affiliation("Index Terms—ASR, TTS"), "")
        self.assertIn("\u2225", pae.SYMBOL_MARKER_CHARS)
        pdf_2auth = make_pdf(lambda p: (
            p.insert_text((72, 80), "A Non-Bold Speech Synthesis Framework", fontsize=14.0),
            p.insert_text((72, 92), "Alice Brown and Bob White", fontsize=11.0),
            p.insert_text((72, 108), "Stanford University", fontsize=10.0),
            p.insert_text((72, 170), "Abstract", fontsize=12.0),
        ))
        res_2auth = pae.extract_pdf_page1_authors(pdf_2auth)
        self.assertIsNotNone(res_2auth)
        self.assertEqual(
            [(a["name"], a["affiliations"]) for a in res_2auth["authors"]],
            [("Alice Brown", ["Stanford University"]), ("Bob White", ["Stanford University"])],
        )

        # R16 #7 & #12 real sealed corpus checks (skipped cleanly if runtime cache absent)
        sealed_root = Path("data/runtime/daily-fresh-source-runs")
        if sealed_root.exists():
            for pid, check_fn in (
                (
                    "2609.34839",
                    lambda res: (
                        self.assertEqual(len(res["authors"]), 10),
                        self.assertIn(("Chiara Semenzin", ["Earth Species Project, France"]), [(a["name"], a["affiliations"]) for a in res["authors"]]),
                        self.assertIn(("Gonzalo de Polavieja", ["Champalimaud Foundation, Lisbon, Portugal"]), [(a["name"], a["affiliations"]) for a in res["authors"]]),
                    ),
                ),
                (
                    "2610.05932",
                    lambda res: (
                        self.assertEqual(len(res["authors"]), 6),
                        self.assertIn("University of Chinese Academy of Sciences", res["authors"][0]["affiliations"]),
                    ),
                ),
                (
                    "2611.01876",
                    lambda res: (
                        self.assertEqual(len(res["authors"]), 4),
                        self.assertEqual(res["authors"][0]["name"], "Johanna Wilroth"),
                    ),
                ),
            ):
                matches = sorted(sealed_root.glob(f"*/sources/{pid}/generation-*/source.pdf"))
                if matches:
                    res = pae.extract_pdf_page1_authors(matches[0].read_bytes())
                    self.assertIsNotNone(res, pid)
                    check_fn(res)

    def test_wave7_r17_redos_word_boundary_mode_a_wrap_plus_grid_mode_d_and_particles(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R17 #1: Strictly O(n) ORCID ID stripping + 'and'/'&' lookahead
        t0 = time.perf_counter()
        pae._parse_authors_from_lines(
            [{
                "text": "a" + "*" * 16000 + "x",
                "base_size": 10.0,
                "base_y": 100.0,
                "x0": 50.0,
                "x1": 400.0,
                "y0": 90.0,
                "y1": 102.0,
                "block": 1,
                "spans": [{"text": "a" + "*" * 16000 + "x", "size": 10.0, "flags": 0, "origin_y": 100.0, "bbox": (50.0, 90.0, 400.0, 102.0)}],
            }],
            set(),
            set(),
        )
        self.assertLess(time.perf_counter() - t0, 0.15, "R17 #1 ORCID ID ReDoS")
        pdf_orcid_and = make_pdf(lambda p: (
            p.insert_text((72, 80), "Interspeech Paper", fontsize=16),
            p.insert_text((72, 118), "Georgios Syllas ID and Efthymios Georgiou ID", fontsize=11),
            p.insert_text((72, 138), "Stanford University", fontsize=10),
            p.insert_text((72, 200), "Abstract", fontsize=12),
        ))
        res_orcid = pae.extract_pdf_page1_authors(pdf_orcid_and)
        self.assertIsNotNone(res_orcid)
        self.assertEqual([a["name"] for a in res_orcid["authors"]], ["Georgios Syllas", "Efthymios Georgiou"])

        # R17 #2: prev_ends_open requires word boundary before 'and' (Bertrand + Pine AI rejected; Roland\nMeyer preserved)
        pdf_bertrand = make_pdf(lambda p: (
            p.insert_text((72, 80), "Speech Study", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Jean Bertrand", fontsize=11),
            p.insert_text((72, 134), "Pine AI", fontsize=10),
            p.insert_text((72, 150), "Stanford University", fontsize=10),
            p.insert_text((72, 210), "Abstract", fontsize=12),
        ))
        self.assertIsNone(pae.extract_pdf_page1_authors(pdf_bertrand))

        pdf_roland = make_pdf(lambda p: (
            p.insert_text((72, 80), "Speech Study", fontsize=16),
            p.insert_text((72, 118), "Alice Brown, Bob White, Roland", fontsize=11),
            p.insert_text((72, 132), "Meyer, Carol Davis", fontsize=11),
            p.insert_text((72, 152), "Stanford University", fontsize=10),
            p.insert_text((72, 210), "Abstract", fontsize=12),
        ))
        res_roland = pae.extract_pdf_page1_authors(pdf_roland)
        self.assertIsNotNone(res_roland)
        self.assertEqual([a["name"] for a in res_roland["authors"]], ["Alice Brown", "Bob White", "Roland Meyer", "Carol Davis"])

        # R17 #3: Mode A multi-segment dangling comma wrap + confirmed continuation line with [[SUP:...]]
        pdf_wrap = make_pdf(lambda p: (
            p.insert_text((72, 80), "Multi Wrap Paper", fontsize=16),
            p.insert_text((72, 116), "Alice Brown", fontsize=11),
            p.insert_text((130, 112), "1", fontsize=7),
            p.insert_text((138, 116), ", Bob White", fontsize=11),
            p.insert_text((196, 112), "2", fontsize=7),
            p.insert_text((204, 116), ", Carol Davis", fontsize=11),
            p.insert_text((270, 112), "3", fontsize=7),
            p.insert_text((72, 136), "1", fontsize=7),
            p.insert_text((78, 140), "MIT", fontsize=10),
            p.insert_text((150, 136), "2", fontsize=7),
            p.insert_text((156, 140), "Department of Computer Science,", fontsize=10),
            p.insert_text((72, 154), "Stanford University", fontsize=10),
            p.insert_text((210, 150), "3", fontsize=7),
            p.insert_text((216, 154), "Carnegie Mellon University", fontsize=10),
            p.insert_text((72, 210), "Abstract", fontsize=12),
        ))
        res_wrap = pae.extract_pdf_page1_authors(pdf_wrap)
        self.assertIsNotNone(res_wrap)
        self.assertEqual(
            [(a["name"], a["affiliations"]) for a in res_wrap["authors"]],
            [
                ("Alice Brown", ["MIT"]),
                ("Bob White", ["Department of Computer Science, Stanford University"]),
                ("Carol Davis", ["Carnegie Mellon University"]),
            ],
        )

        # R17 #6: Thanks abbr_re handles Corp., S.r.l., uppercase LTD. before `while`, plus O(K) sanitization
        for txt, aff0 in (
            ("Alice Brown is with Sony Corp. while Bob White is with MIT.", "Sony Corp."),
            ("Alice Brown is with Azienda S.r.l. while Bob White is with MIT.", "Azienda S.r.l."),
            ("Alice Brown is with Tencent Co., LTD. while Bob White is with MIT.", "Tencent Co., LTD."),
        ):
            res_tw = pae._try_mode_thanks([], [{"text": txt, "x0": 50.0, "x1": 500.0, "y0": 700.0}], 612.0)
            self.assertIsNotNone(res_tw, aff0)
            self.assertEqual(
                [(a["name"], a["affiliations"]) for a in res_tw[0]],
                [("Alice Brown", [aff0]), ("Bob White", ["MIT"])],
            )
        alpha = "abcdefghijklmnopqrstuvwxyz"
        def _tag(k: int) -> str:
            return "A" + alpha[(k // 676) % 26] + alpha[(k // 26) % 26] + alpha[k % 26]
        big_lines = [
            {"text": f"{_tag(k)} Smith{_tag(k)} is with Institute {_tag(k)}.", "x0": 50.0, "x1": 500.0, "y0": 600.0 + k * 0.1}
            for k in range(500)
        ]
        t0 = time.perf_counter()
        res_big = pae._try_mode_thanks([], big_lines, 612.0)
        dt = time.perf_counter() - t0
        self.assertIsNotNone(res_big)
        self.assertEqual(len(res_big[0]), 500)
        self.assertLess(dt, 0.25, f"R17 #6 O(K) thanks K=500 took {dt:.3f}s")

        # R17 #8: Mode D split author-only block with surname-colliding / initialed names & _strip_title_lines guards
        for author_nm in ("Athena Dai*", "Louis ten Bosch*", "Mila Novak*", "John Apple*", "John B.V. Kumar*", "John K.K. Paliwal*"):
            res_d = pae._try_mode_column_blocks([
                {"text": author_nm, "block": 1, "x0": 80.0, "x1": 180.0, "y0": 100.0, "y1": 111.0, "base_size": 11.0, "max_size": 11.0, "is_bold": True, "is_italic": False, "spans": [{"text": author_nm, "bbox": [80.0, 100.0, 180.0, 111.0]}]},
                {"text": "Stanford University", "block": 2, "x0": 80.0, "x1": 180.0, "y0": 116.0, "y1": 126.0, "base_size": 9.5, "max_size": 9.5, "is_bold": False, "is_italic": True, "spans": [{"text": "Stanford University", "bbox": [80.0, 116.0, 180.0, 126.0]}]},
                {"text": "Bob White", "block": 3, "x0": 320.0, "x1": 400.0, "y0": 100.0, "y1": 111.0, "base_size": 11.0, "max_size": 11.0, "is_bold": True, "is_italic": False, "spans": [{"text": "Bob White", "bbox": [320.0, 100.0, 400.0, 111.0]}]},
                {"text": "MIT", "block": 4, "x0": 320.0, "x1": 360.0, "y0": 116.0, "y1": 126.0, "base_size": 9.5, "max_size": 9.5, "is_bold": False, "is_italic": True, "spans": [{"text": "MIT", "bbox": [320.0, 116.0, 360.0, 126.0]}]},
            ], 612.0)
            self.assertIsNotNone(res_d, f"R17 #8 Mode D split block {author_nm}")
            self.assertEqual(res_d[0][0]["affiliations"], ["Stanford University"])

        pdf_star_title = make_pdf(lambda p: (
            p.insert_text((72, 80), "A Non-Bold Speech Synthesis Framework", fontsize=14.0),
            p.insert_text((72, 92), "Alice Brown* and Bob White", fontsize=11.0),
            p.insert_text((72, 108), "Stanford University", fontsize=10.0),
            p.insert_text((72, 122), "* Equal contribution.", fontsize=8.5),
            p.insert_text((72, 170), "Abstract", fontsize=12.0),
        ))
        res_st = pae.extract_pdf_page1_authors(pdf_star_title)
        self.assertIsNotNone(res_st)
        self.assertEqual([a["name"] for a in res_st["authors"]], ["Alice Brown", "Bob White"])

        # Same-block author enumeration must not be stripped as subtitle
        stripped_sub = pae._strip_title_lines([
            {"text": "Big Speech Title", "block": 1, "x0": 72.0, "x1": 300.0, "y0": 60.0, "y1": 78.0, "base_size": 17.0, "max_size": 17.0, "is_bold": True, "is_italic": False, "spans": []},
            {"text": "Alice Brown, Bob White", "block": 1, "x0": 72.0, "x1": 240.0, "y0": 84.0, "y1": 95.0, "base_size": 11.0, "max_size": 11.0, "is_bold": False, "is_italic": False, "spans": []},
            {"text": "Anthropic", "block": 2, "x0": 72.0, "x1": 150.0, "y0": 110.0, "y1": 120.0, "base_size": 10.0, "max_size": 10.0, "is_bold": False, "is_italic": False, "spans": []},
        ])
        self.assertEqual([ln["text"] for ln in stripped_sub], ["Alice Brown, Bob White", "Anthropic"])

        # R17 #9: Capitalized-particle lowercase surname + Latin Extended-A initials
        self.assertTrue(pae._is_valid_author_name("Hugo Van hamme"))
        self.assertTrue(pae._is_valid_author_name("Luc Van gool"))
        self.assertTrue(pae._is_valid_author_name("Š. Horváth"))
        self.assertTrue(pae._is_valid_author_name("Ł. Kowalski"))

        # R17 #3, #7, #9 real sealed corpus checks
        sealed_root = Path("data/runtime/daily-fresh-source-runs")
        if sealed_root.exists():
            for pid, check_fn in (
                ("2609.38203", lambda r: (self.assertEqual(len(r["authors"]), 6), self.assertIn("Sheffield Institute for Translational Neuroscience (SITraN)", r["authors"][1]["affiliations"]))),
                ("2609.34994", lambda r: (self.assertEqual(len(r["authors"]), 4), self.assertTrue(r["authors"][0]["affiliations"][0].endswith("Brazil")))),
                ("2610.38005", lambda r: (self.assertEqual(len(r["authors"]), 3), self.assertIn("English and American Studies", r["authors"][0]["affiliations"][0]), self.assertIn("North Rhine-Westphalia, Germany", r["authors"][1]["affiliations"][0]))),
                ("2609.08422", lambda r: self.assertEqual(len(r["authors"]), 5)),
                ("2609.15981", lambda r: self.assertEqual(len(r["authors"]), 5)),
                ("2608.30793", lambda r: self.assertEqual(len(r["authors"]), 5)),
                ("2609.28806", lambda r: self.assertEqual(len(r["authors"]), 7)),
                ("2609.26648", lambda r: (self.assertEqual(len(r["authors"]), 3), self.assertIn("Hugo Van hamme", [a["name"] for a in r["authors"]]))),
            ):
                matches = sorted(sealed_root.glob(f"*/sources/{pid}/generation-*/source.pdf"))
                if matches:
                    res = pae.extract_pdf_page1_authors(matches[0].read_bytes())
                    self.assertIsNotNone(res, pid)
                    check_fn(res)

    def test_wave7_r18_abbrevs_parallel_mode_a_plus_guards_unicode_initials_and_pine_ai(self):
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn) -> bytes:
            doc = fitz.open()
            page = doc.new_page(width=612, height=792)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R18 #1: Lab./Labs./Tech./Inst./St. thanks sentence splitting + glued sentences
        for sent, aff0 in (
            ("Alice Brown is with Bell Labs. Bob White is with Stanford University.", "Bell Labs."),
            ("Alice Brown is with MIT AI Lab. Bob White is with Stanford University.", "MIT AI Lab."),
            ("Alice Brown is with Georgia Tech. Bob White is with Stanford University.", "Georgia Tech."),
            ("Alice Brown is with Fraunhofer Inst. Bob White is with Stanford University.", "Fraunhofer Inst."),
            ("Alice Brown is with MIT, 10 Main St. Bob White is with Stanford University.", "MIT, 10 Main St."),
            ("Alice Brown is with Sun. Bob White is with Stanford University.", "Sun"),
        ):
            res = pae._try_mode_thanks([], [{"text": sent, "x0": 50.0, "x1": 500.0, "y0": 700.0}], 612.0)
            self.assertIsNotNone(res, sent)
            self.assertEqual(res[0], [
                {"name": "Alice Brown", "affiliations": [aff0]},
                {"name": "Bob White", "affiliations": ["Stanford University"]},
            ], sent)
        for raw, expected in (
            ("MIT AI Lab. This work was supported by NSF.", "MIT AI Lab."),
            ("Bell Labs. Funded by DARPA.", "Bell Labs."),
            ("Georgia Tech. This paper is accepted.", "Georgia Tech."),
            ("Fraunhofer Inst. Supported by EU.", "Fraunhofer Inst."),
            ("Stanford Univ. This work was supported by NIH.", "Stanford Univ."),
        ):
            self.assertEqual(pae._sanitize_affiliation(raw), expected, raw)

        # R18 #2: ‖ (U+2016) and ∥ (U+2225) normalize to identical canonical marker
        self.assertEqual(pae._normalize_marker_token("‖"), pae._normalize_marker_token("∥"))

        # R18 #5: Mode A nxt_starts_prep negatives + space-join for wrapped "Department of Computer\nScience, MIT"
        for bad_line, expected_aff in (
            ("and Alice Brown", "MIT"),
            ("for real-time audio coding", "MIT"),
            ("in the wild without labels", "Stanford University"),
        ):
            base_aff = "Stanford University" if "wild" in bad_line else "MIT"
            pdf_bad = make_pdf(lambda p, b=base_aff, n=bad_line: (
                p.insert_text((72, 60), "Mode A Prep Guard Paper", fontsize=16),
                p.insert_text((72, 95), "Bob White", fontsize=11),
                p.insert_text((126, 91), "1", fontsize=7),
                p.insert_text((72, 118), "1", fontsize=7),
                p.insert_text((78, 122), b, fontsize=10),
                p.insert_text((78, 134), n, fontsize=10),
                p.insert_text((72, 180), "Abstract", fontsize=12),
            ))
            res_bad = pae.extract_pdf_page1_authors(pdf_bad)
            self.assertIsNotNone(res_bad, bad_line)
            self.assertEqual(res_bad["authors"], [{"name": "Bob White", "affiliations": [expected_aff]}], bad_line)

        pdf_cs_wrap = make_pdf(lambda p: (
            p.insert_text((72, 60), "Wrapped Dept Without Spurious Comma", fontsize=16),
            p.insert_text((72, 92), "Alice Brown", fontsize=11),
            p.insert_text((132, 88), "1", fontsize=7),
            p.insert_text((140, 92), ", Bob White", fontsize=11),
            p.insert_text((200, 88), "2", fontsize=7),
            p.insert_text((72, 118), "1", fontsize=7),
            p.insert_text((78, 122), "Department of Electrical Engineering,", fontsize=10),
            p.insert_text((78, 134), "Stanford University, ", fontsize=10),
            p.insert_text((178, 130), "2", fontsize=7),
            p.insert_text((184, 134), "Department of Computer", fontsize=10),
            p.insert_text((78, 146), "Science, MIT", fontsize=10),
            p.insert_text((72, 190), "Abstract", fontsize=12),
        ))
        res_cs = pae.extract_pdf_page1_authors(pdf_cs_wrap)
        self.assertIsNotNone(res_cs)
        self.assertEqual(res_cs["authors"], [
            {"name": "Alice Brown", "affiliations": ["Department of Electrical Engineering, Stanford University"]},
            {"name": "Bob White", "affiliations": ["Department of Computer Science, MIT"]},
        ])

        # R18 #6: + marker false positives (C++, +x/+y/+z, +(1) phone, + Tel:) & _has_following_marked_author_line teaser guard
        for bad_mk in ("++", "+x", "+y", "+z", "a+b", "+1", "+86"):
            self.assertFalse(pae._is_pure_marker_text(bad_mk), bad_mk)
            self.assertEqual(pae._parse_marker_string(bad_mk), [], bad_mk)
        for ok_mk in ("+", "1,+", "+‡"):
            self.assertTrue(pae._is_pure_marker_text(ok_mk), ok_mk)

        pdf_cpp = make_pdf(lambda p: (
            p.insert_text((72, 60), "A Fast Real-Time Framework for", fontsize=16),
            p.insert_text((72, 80), "C", fontsize=16),
            p.insert_text((83, 76), "++", fontsize=10),
            p.insert_text((98, 80), " Audio Signal Processing", fontsize=16),
            p.insert_text((72, 112), "Alice Brown, Bob White", fontsize=11),
            p.insert_text((72, 130), "Stanford University", fontsize=10),
            p.insert_text((72, 175), "Abstract", fontsize=12),
        ))
        res_cpp = pae.extract_pdf_page1_authors(pdf_cpp)
        self.assertIsNotNone(res_cpp)
        self.assertEqual([a["name"] for a in res_cpp["authors"]], ["Alice Brown", "Bob White"])

        for phone_line in ("+(1) 650-555-1234", "+ Tel: 650-555-1234"):
            pdf_phone = make_pdf(lambda p, ph=phone_line: (
                p.insert_text((72, 60), "Phone Header Paper", fontsize=16),
                p.insert_text((72, 95), "Alice Brown, Bob White", fontsize=11),
                p.insert_text((72, 115), "Stanford University", fontsize=10),
                p.insert_text((72, 130), ph, fontsize=9),
                p.insert_text((72, 175), "Abstract", fontsize=12),
            ))
            res_ph = pae.extract_pdf_page1_authors(pdf_phone)
            self.assertIsNotNone(res_ph, phone_line)
            self.assertEqual(res_ph["authors"], [
                {"name": "Alice Brown", "affiliations": ["Stanford University"]},
                {"name": "Bob White", "affiliations": ["Stanford University"]},
            ], phone_line)

        pdf_teaser = make_pdf(lambda p: (
            p.insert_text((72, 60), "No Teaser Phantom Author", fontsize=16),
            p.insert_text((72, 95), "Alice Brown", fontsize=11),
            p.insert_text((132, 91), "1", fontsize=7),
            p.insert_text((140, 95), ", Bob White", fontsize=11),
            p.insert_text((200, 91), "2", fontsize=7),
            p.insert_text((72, 114), "alice@mit.edu, bob@stanford.edu", fontsize=9.5),
            p.insert_text((72, 132), "Jane Roe", fontsize=9.0),
            p.insert_text((112, 129), "1", fontsize=6.0),
            p.insert_text((72, 152), "1", fontsize=7),
            p.insert_text((78, 156), "MIT", fontsize=10),
            p.insert_text((108, 152), "2", fontsize=7),
            p.insert_text((114, 156), "Stanford University", fontsize=10),
            p.insert_text((72, 195), "Abstract", fontsize=12),
        ))
        res_teaser = pae.extract_pdf_page1_authors(pdf_teaser)
        self.assertIsNotNone(res_teaser)
        self.assertEqual([a["name"] for a in res_teaser["authors"]], ["Alice Brown", "Bob White"])

        # R18 #7: Unicode/multi-letter initials in thanks splitter + Van de / 1-char lowercase tail rejection
        for nm, aff in (
            ("Š. Horváth", "Stanford University"),
            ("Ł. Kowalski", "MIT"),
            ("Ch. Müller", "ETH Zurich"),
        ):
            res_init = pae._try_mode_thanks([], [{"text": f"{nm} is with {aff}.", "x0": 50.0, "x1": 500.0, "y0": 700.0}], 612.0)
            self.assertIsNotNone(res_init, nm)
            self.assertEqual(res_init[0], [{"name": nm, "affiliations": [aff]}], nm)
        self.assertFalse(pae._is_valid_author_name("Alice Van a"))
        self.assertFalse(pae._is_valid_author_name("Hugo Van de"))
        self.assertFalse(pae._is_valid_author_name("Alice De la"))
        pdf_vande = make_pdf(lambda p: (
            p.insert_text((72, 60), "Wrapped Dutch Particle Paper", fontsize=16),
            p.insert_text((72, 95), "Alice Brown, Hugo Van de", fontsize=11),
            p.insert_text((72, 110), "Berg, Carol Davis", fontsize=11),
            p.insert_text((72, 132), "KU Leuven, Department of Electrical Engineering", fontsize=10),
            p.insert_text((72, 180), "Abstract", fontsize=12),
        ))
        res_vande = pae.extract_pdf_page1_authors(pdf_vande)
        self.assertIsNotNone(res_vande)
        self.assertEqual([a["name"] for a in res_vande["authors"]], ["Alice Brown", "Hugo Van de Berg", "Carol Davis"])

        # R18 #8: Mode D _is_author_only_block rejects Pine AI as phantom author
        def mk_ln(text: str, block: int, x0: float, x1: float, y0: float, y1: float, sz: float, flags: int = 0) -> dict:
            return {
                "text": text, "block": block, "x0": x0, "x1": x1, "y0": y0, "y1": y1,
                "base_size": sz, "max_size": sz, "is_bold": bool(flags & 16), "is_italic": bool(flags & 2),
                "spans": [{"text": text, "size": sz, "flags": flags, "bbox": (x0, y0, x1, y1)}],
            }
        mode_d_pine = pae._try_mode_column_blocks([
            mk_ln("Pine AI", 1, 70.0, 150.0, 100.0, 112.0, 11.0, 16),
            mk_ln("Stanford University", 2, 65.0, 160.0, 116.0, 126.0, 9.5, 0),
            mk_ln("Bob White", 3, 300.0, 380.0, 100.0, 112.0, 11.0, 16),
            mk_ln("MIT", 3, 315.0, 365.0, 116.0, 126.0, 9.5, 0),
        ], 612.0)
        self.assertTrue(mode_d_pine is None or "Pine AI" not in [a["name"] for a in mode_d_pine[0]])

        # Sealed 2611.00657 check: +x/+y/+z diagram spans must never become [[SUP:+x]]
        sealed_2611 = sorted(Path("data/runtime/daily-fresh-source-runs").glob("*/sources/2611.00657/generation-*/source.pdf"))
        if sealed_2611:
            doc_s = fitz.open(stream=sealed_2611[0].read_bytes(), filetype="pdf")
            for ln in pae._extract_page1_lines(doc_s[0])[0]:
                ann = pae._annotate_line_with_markers(ln)
                self.assertNotIn("[[SUP:+x]]", ann)
                self.assertNotIn("[[SUP:+y]]", ann)
                self.assertNotIn("[[SUP:+z]]", ann)
            doc_s.close()

    def test_wave7_r19_amp_index_plus_zip_midplus_space_marked_nobiliary_thanks_abbr_mode_a_and_ok_scaling(self):
        import time
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=612, height=792):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        # R19 #1: _KnownAuthorIndex splits '&'-joined authors
        idx_amp = pae._KnownAuthorIndex(["Alice Brown & Bob White"])
        self.assertIn("alice brown", idx_amp.exact_keys)
        self.assertIn("bob white", idx_amp.exact_keys)

        # R19 #4: '+' phone guard preserves Japanese/US ZIP+4 affiliations, rejects mid-string '1+2', and detects 4 space-separated marked authors
        self.assertFalse(pae._is_pure_marker_text("1+2"))
        self.assertEqual(pae._parse_marker_string("1+2"), [])
        self.assertEqual(pae._parse_marker_string("*,+1"), [])
        pdf_plus_zip = make_pdf(lambda p: (
            p.insert_text((72, 60), "Tokyo Postal Code Paper", fontsize=16),
            p.insert_text((72, 95), "Alice Brown", fontsize=11),
            p.insert_text((132, 91), "+", fontsize=7),
            p.insert_text((140, 95), ", Bob White", fontsize=11),
            p.insert_text((200, 91), "*", fontsize=7),
            p.insert_text((72, 118), "+", fontsize=7),
            p.insert_text((78, 122), "University of Tokyo, Tokyo 113-8656, Japan", fontsize=10),
            p.insert_text((72, 134), "*", fontsize=7),
            p.insert_text((78, 138), "MIT", fontsize=10),
            p.insert_text((72, 175), "Abstract", fontsize=12),
        ))
        res_pz = pae.extract_pdf_page1_authors(pdf_plus_zip)
        self.assertIsNotNone(res_pz)
        self.assertEqual(res_pz["authors"], [
            {"name": "Alice Brown", "affiliations": ["University of Tokyo, Tokyo 113-8656, Japan"]},
            {"name": "Bob White", "affiliations": ["MIT"]},
        ])

        pdf_space4 = make_pdf(lambda p: (
            p.insert_text((72, 60), "Space Separated Four Authors", fontsize=16),
            p.insert_text((72, 95), "Alice Brown", fontsize=11),
            p.insert_text((132, 91), "1", fontsize=7),
            p.insert_text((144, 95), "Bob White", fontsize=11),
            p.insert_text((196, 91), "2", fontsize=7),
            p.insert_text((72, 112), "alice@mit.edu, bob@stanford.edu", fontsize=9.5),
            p.insert_text((72, 129), "Carol Davis", fontsize=11),
            p.insert_text((130, 125), "1", fontsize=7),
            p.insert_text((141, 129), "David Lee", fontsize=11),
            p.insert_text((192, 125), "2", fontsize=7),
            p.insert_text((203, 129), "Eve Wang", fontsize=11),
            p.insert_text((255, 125), "1", fontsize=7),
            p.insert_text((266, 129), "Frank Liu", fontsize=11),
            p.insert_text((314, 125), "2", fontsize=7),
            p.insert_text((72, 152), "1", fontsize=7),
            p.insert_text((78, 156), "MIT", fontsize=10),
            p.insert_text((112, 152), "2", fontsize=7),
            p.insert_text((118, 156), "Stanford University", fontsize=10),
            p.insert_text((72, 195), "Abstract", fontsize=12),
        ))
        res_s4 = pae.extract_pdf_page1_authors(pdf_space4)
        self.assertIsNotNone(res_s4)
        self.assertEqual(
            [a["name"] for a in res_s4["authors"]],
            ["Alice Brown", "Bob White", "Carol Davis", "David Lee", "Eve Wang", "Frank Liu"],
        )

        # R19 #5: wrapped Flemish lowercase surname & last-author nobiliary wrap + thanks multi-token surnames & Studio X.
        pdf_flemish = make_pdf(lambda p: (
            p.insert_text((72, 60), "Wrapped Flemish Paper", fontsize=16),
            p.insert_text((72, 95), "Alice Brown, Hugo Van", fontsize=11),
            p.insert_text((72, 110), "hamme, Carol Davis", fontsize=11),
            p.insert_text((72, 132), "KU Leuven, Department of Electrical Engineering", fontsize=10),
            p.insert_text((72, 180), "Abstract", fontsize=12),
        ))
        res_fl = pae.extract_pdf_page1_authors(pdf_flemish)
        self.assertIsNotNone(res_fl)
        self.assertEqual([a["name"] for a in res_fl["authors"]], ["Alice Brown", "Hugo Van hamme", "Carol Davis"])

        pdf_last_nob = make_pdf(lambda p: (
            p.insert_text((72, 60), "Last Author Nobiliary Paper", fontsize=16),
            p.insert_text((72, 95), "Alice Brown, Hugo Van de", fontsize=11),
            p.insert_text((72, 110), "Berg", fontsize=11),
            p.insert_text((72, 132), "KU Leuven, Department of Electrical Engineering", fontsize=10),
            p.insert_text((72, 180), "Abstract", fontsize=12),
        ))
        res_ln = pae.extract_pdf_page1_authors(pdf_last_nob)
        self.assertIsNotNone(res_ln)
        self.assertEqual([a["name"] for a in res_ln["authors"]], ["Alice Brown", "Hugo Van de Berg"])

        for sent, expected in [
            (
                "Alice Brown is with MIT, and Ch. Van hamme is with KU Leuven.",
                [
                    {"name": "Alice Brown", "affiliations": ["MIT"]},
                    {"name": "Ch. Van hamme", "affiliations": ["KU Leuven"]},
                ],
            ),
            (
                "Alice Brown is with MIT, and Ch. A. Müller is with Technical University of Munich.",
                [
                    {"name": "Alice Brown", "affiliations": ["MIT"]},
                    {"name": "Ch. A. Müller", "affiliations": ["Technical University of Munich"]},
                ],
            ),
            (
                "Alice Brown is with Studio X. Bob White is with Stanford University.",
                [
                    {"name": "Alice Brown", "affiliations": ["Studio X"]},
                    {"name": "Bob White", "affiliations": ["Stanford University"]},
                ],
            ),
            (
                "Alice Brown is with Bell Labs. Accepted at ICASSP 2026.",
                [{"name": "Alice Brown", "affiliations": ["Bell Labs."]}],
            ),
            (
                "Alice Brown is with Bell Labs. †Supported by NSFC 12345.",
                [{"name": "Alice Brown", "affiliations": ["Bell Labs."]}],
            ),
        ]:
            res_t = pae._try_mode_thanks([], [{"text": sent, "x0": 50.0, "x1": 500.0, "y0": 700.0}], 612.0)
            self.assertIsNotNone(res_t, sent)
            self.assertEqual(res_t[0], expected, sent)

        # R19 #6: _looks_like_prose_sentence allows Corp., Lab., Labs., Tech., Inst.
        for aff_line in ("Tech. Univ. of Munich", "Sony Corp. Research Center", "Fraunhofer Inst. Integrated Circuits"):
            self.assertFalse(pae._looks_like_prose_sentence(aff_line), aff_line)

        # R19 #7: Mode A nxt_starts_prep does not merge funding after ZIP or journal venue after completed University
        pdf_mode_a_zip = make_pdf(lambda p: (
            p.insert_text((72, 60), "Mode A ZIP and Venue Guard", fontsize=16),
            p.insert_text((72, 95), "Alice Brown", fontsize=11),
            p.insert_text((132, 91), "1", fontsize=7),
            p.insert_text((140, 95), ", Bob White", fontsize=11),
            p.insert_text((200, 91), "2", fontsize=7),
            p.insert_text((72, 118), "1", fontsize=7),
            p.insert_text((78, 122), "MIT, Cambridge, MA 02139", fontsize=10),
            p.insert_text((78, 134), "and Science Foundation", fontsize=10),
            p.insert_text((72, 152), "2", fontsize=7),
            p.insert_text((78, 156), "Stanford University", fontsize=10),
            p.insert_text((78, 168), "in IEEE Transactions on Audio, Speech, and Language Processing", fontsize=10),
            p.insert_text((72, 210), "Abstract", fontsize=12),
        ))
        res_maz = pae.extract_pdf_page1_authors(pdf_mode_a_zip)
        self.assertIsNotNone(res_maz)
        self.assertEqual(res_maz["authors"], [
            {"name": "Alice Brown", "affiliations": ["MIT, Cambridge, MA 02139"]},
            {"name": "Bob White", "affiliations": ["Stanford University"]},
        ])

        # R19 #8: Python Mode B Pass 2 O(K) scaling for K=800 middle-initial authors
        def _alpha_tag(idx: int) -> str:
            a = chr(ord("a") + (idx // 676) % 26)
            b = chr(ord("a") + (idx // 26) % 26)
            c = chr(ord("a") + idx % 26)
            return f"A{a}{b}{c}"

        hdr_lns = [
            {
                "text": f"First{_alpha_tag(k)} A. Last{_alpha_tag(k)}",
                "block": 1, "x0": 72.0, "x1": 200.0, "y0": 100.0 + k * 0.1, "y1": 110.0 + k * 0.1,
                "base_size": 11.0, "max_size": 11.0, "base_y": 100.0 + k * 0.1, "is_bold": False, "is_italic": False,
                "spans": [{"text": f"First{_alpha_tag(k)} A. Last{_alpha_tag(k)}", "size": 11.0, "flags": 0, "bbox": (72.0, 100.0 + k * 0.1, 200.0, 110.0 + k * 0.1)}],
            }
            for k in range(800)
        ]
        fn_lns = [
            {"text": f"First{_alpha_tag(k)} Last{_alpha_tag(k)} is with Institute {_alpha_tag(k)}.", "x0": 50.0, "x1": 500.0, "y0": 500.0 + k * 0.05}
            for k in range(800)
        ]
        t0 = time.perf_counter()
        res_k800 = pae._try_mode_thanks(hdr_lns, fn_lns, 612.0)
        dt = time.perf_counter() - t0
        self.assertIsNotNone(res_k800)
        self.assertEqual(len(res_k800[0]), 800)
        self.assertLess(dt, 1.0, f"R19 #8 Python Mode B K=800 took {dt:.3f}s")

    def test_pdf_author_extract_multithreaded_v2_v3_isolation(self):
        from concurrent.futures import ThreadPoolExecutor
        import fitz
        import pdf_author_extract as pae

        def make_pdf(draw_fn, width=595, height=842):
            doc = fitz.open()
            page = doc.new_page(width=width, height=height)
            draw_fn(page)
            data = doc.tobytes()
            doc.close()
            return data

        pdf_bytes = make_pdf(lambda p: (
            p.insert_text((72, 80), "Concurrent Replay Isolation Test", fontsize=16),
            p.insert_text((72, 118), "Alice Brown", fontsize=11),
            p.insert_text((134, 114), "1", fontsize=7),
            p.insert_text((142, 118), ", Bob White", fontsize=11),
            p.insert_text((204, 114), "2", fontsize=7),
            p.insert_text((72, 140), "1", fontsize=7),
            p.insert_text((80, 142), "MIT", fontsize=10),
            p.insert_text((72, 156), "2", fontsize=7),
            p.insert_text((80, 158), "Stanford University", fontsize=10),
            p.insert_text((72, 220), "Abstract", fontsize=12),
        ))
        expected_v2 = pae.extract_pdf_page1_authors_structured(pdf_bytes)
        expected_v3 = pae.extract_pdf_page1_authors_geometric(pdf_bytes)
        self.assertIsNotNone(expected_v2)
        self.assertIsNotNone(expected_v3)
        self.assertEqual(expected_v2["contract"], pae.CONTRACT_V2)
        self.assertEqual(expected_v3["contract"], pae.CONTRACT_V3)

        def worker(idx: int):
            if idx % 2 == 0:
                got = pae.extract_pdf_page1_authors_structured(pdf_bytes)
                return ("v2", got, pae._GEOMETRIC_GUARDS_ENABLED)
            got = pae.extract_pdf_page1_authors_geometric(pdf_bytes)
            return ("v3", got, pae._GEOMETRIC_GUARDS_ENABLED)

        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(worker, range(32)))

        for tag, got, flag_after in results:
            self.assertEqual(got, expected_v2 if tag == "v2" else expected_v3)
        self.assertFalse(pae._GEOMETRIC_GUARDS_ENABLED)
