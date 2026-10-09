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
            source_root = Path(tmp) / 'sources'
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
            stage['readerAuthorIdentitySha256'] = paper['apiReaderAuthors']['identitySha256']
            stage['readerAuthorsSha256'] = gate._reader_record_sha256(paper['apiReaderAuthors'], 'test')
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
