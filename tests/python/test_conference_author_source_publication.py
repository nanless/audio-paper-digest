import contextlib
import importlib.util
import json
import sys
import hashlib
import shutil
import os
import time
import types
import subprocess
import unittest
from pathlib import Path
from unittest import mock
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))

class ExistingConferenceAuthorPublicationTest(unittest.TestCase):
    def test_existing_complete_staged_author_replay_before_public_generate(self):
        self.maxDiff = None
        result = subprocess.run(['node', str(ROOT / 'tests/helpers/conference-publication-author-fixture.cjs')],
                                cwd=ROOT, capture_output=True, text=True, check=True)
        f = json.loads(result.stdout.splitlines()[-1])
        r = Path(f['runtimeRoot'])
        self.addCleanup(lambda: shutil.rmtree(r))
        spec = importlib.util.spec_from_file_location('author_conference_publisher', ROOT / 'scripts/publish-conference.py')
        new = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(new)
        # 直接读取旧实现的三个函数原文；其余公共辅助函数使用当前实现，因此这里不代表完整的旧发布器。
        old_source = (ROOT / 'tests/fixtures/conference-publication-old-core.py').read_bytes()
        self.assertEqual(hashlib.sha256(old_source).hexdigest(), 'f7d4e23944f8ddf2f887d2c9cde06045e11d5cf54682b79d40c4dd91b3b9600c')
        old = types.ModuleType('old_author_conference_core')
        old.__dict__.update(new.__dict__)
        exec(compile(old_source, 'conference-publication-old-core.py', 'exec'), old.__dict__)
        new.RUNTIME = r
        new.PROCESS_ROOT = r / 'conference-processes'
        new.PAGE_ROOT = r / 'conference-page-staging'
        new.AGGREGATE_ROOT = r / 'conference-aggregates'
        new.PUBLICATION_ROOT = r / 'conference-publications'
        for key in ('RUNTIME', 'PROCESS_ROOT', 'PAGE_ROOT', 'AGGREGATE_ROOT', 'PUBLICATION_ROOT'):
            setattr(old, key, getattr(new, key))
        class Reached(Exception):pass

        def invoke(m):
         m._MANIFEST_INDEX.clear()
         with mock.patch.object(m,'blog_repo',return_value=r/'fake-blog'),mock.patch.object(m,'image_repo',return_value=r/'fake-images'),mock.patch.object(m,'shared_blog_repository_lock',side_effect=lambda *a,**k:contextlib.nullcontext()),mock.patch.object(m,'_validate_paper_tag_format'),mock.patch.object(m,'_validate_aggregate_tag_format'),mock.patch.object(m,'remote_snapshot',side_effect=Reached('bundle accepted')):
          try:m.generate('odyssey-2026',f['processId'])
          except Reached:return 'ACCEPTED_BEFORE_TARGET_WRITE'
          except Exception as e:return 'REJECTED: '+str(e)
        def runtime_bytes():
            return {str(file.relative_to(r)): hashlib.sha256(file.read_bytes()).hexdigest()
                    for file in r.rglob('*') if file.is_file() and not file.is_symlink()}
        original_runtime = runtime_bytes()
        self.assertEqual(invoke(old), 'ACCEPTED_BEFORE_TARGET_WRITE')
        self.assertEqual(invoke(new), 'ACCEPTED_BEFORE_TARGET_WRITE')
        self.assertEqual(runtime_bytes(), original_runtime)
        visible_page = r / 'conference-page-staging' / 'fixture'
        manifest = json.loads((visible_page / 'manifest.json').read_text())
        proof = {key: manifest[key] for key in ('analysisSha256', 'completionReceiptSha256', 'sourceSnapshotSha256', 'authors')}
        visible = (visible_page / 'page.md').read_text()
        for opened, closed in [('<!--', '-->'), ('```markdown', '```')]:
            hidden = visible.replace('## 👥 作者与机构', opened + '\n## 👥 作者与机构').replace('## 正文', closed + '\n## 正文')
            with self.subTest(hidden_by=opened), self.assertRaisesRegex(new.ConferencePublicationError, 'HTML 包装、代码或注释'):
                new.validate_staged_authors(manifest, hidden, proof)
        for opening in ('<div hidden>', '<DIV hidden>', '<div hidden/>', '<details>'):
            wrapped = visible.replace('## 👥 作者与机构', opening + '\n## 👥 作者与机构') + '\n</div>\n'
            with self.subTest(html_wrapper=opening), self.assertRaisesRegex(new.ConferencePublicationError, 'HTML 包装、代码或注释'):
                new.validate_staged_authors(manifest, wrapped, proof)
        for prefix in ('<br>\n', '<img src="figure.png"/>\n', '示例 `<div>`。\n',
                       r'\`<div hidden>\`' + '\n'):
            with self.subTest(nonstandard_prefix=prefix), self.assertRaisesRegex(new.ConferencePublicationError, 'HTML 包装、代码或注释'):
                new.validate_staged_authors(manifest, visible.replace('## 👥 作者与机构', prefix + '## 👥 作者与机构'), proof)
        new.validate_staged_authors(manifest, visible, proof)
        fifo = r / 'conference-staging-sources' / 'malicious-extraction-receipt.json'
        os.mkfifo(fifo)
        started = time.monotonic()
        try:
            self.assertIn('会议作者来源未由', invoke(new))
            self.assertLess(time.monotonic() - started, 5)
        finally:
            fifo.unlink()
        def read(p):return json.loads(p.read_text())
        def write(p,v):p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n')
        def h(b):return hashlib.sha256(b).hexdigest()
        pd=r/'conference-processes'/f['processId'];page=r/'conference-page-staging'/'fixture'
        saved={file:file.read_bytes() for file in [pd/'state.json',pd/'completion-receipt.json',page/'manifest.json',page/'page.md']}
        m=read(page/'manifest.json');text=(page/'page.md').read_text().replace('机构信息未能从会议 PDF 纯文本可靠映射','Stale Visible University');(page/'page.md').write_text(text);m['contentSha256']=h((page/'page.md').read_bytes());m.pop('manifestSha256');m['manifestSha256']=new.stable(m);write(page/'manifest.json',m)
        state=read(pd/'state.json');state['items'][f['paperId']]['pageProof']['manifestSha256']=m['manifestSha256'];state['items'][f['paperId']]['pageProof']['contentSha256']=m['contentSha256'];completion=read(pd/'completion-receipt.json');completion['items'][0]['pageProof']=state['items'][f['paperId']]['pageProof'];completion.pop('receiptSha256');completion['receiptSha256']=new.stable(completion);state['completionReceiptSha256']=completion['receiptSha256'];write(pd/'state.json',state);write(pd/'completion-receipt.json',completion)
        self.assertEqual(invoke(old), 'ACCEPTED_BEFORE_TARGET_WRITE')
        self.assertIn('页面可见作者机构', invoke(new))
        for file,data in saved.items():file.write_bytes(data)
        p=r/'conference-analysis-executions'/f['executionId'];a=read(p/'analysis.json');paper=a['papers'][0];authors=paper['apiReaderAuthors'];authors['authors'][0]['affiliations']=['Invented University'];authors['identity']['authors'][0]['affiliations']=['Invented University'];authors['identity']['authors'][0]['affiliationBindings'][0]['sourceValue']='Invented University';authors['identitySha256']=new.stable(authors['identity']);stage=paper['analysisManifest']['stages']['apiReaderArticle'];stage['readerAuthorIdentitySha256']=authors['identitySha256'];stage['readerAuthorsSha256']=new.stable(authors);write(p/'analysis.json',a);ash=h((p/'analysis.json').read_bytes());run=read(p/'run.json');run['analysisSha256']=ash;receipt=run['completionReceipt'];receipt['analysisSha256']=ash;receipt.pop('receiptSha256');receipt['receiptSha256']=new.stable(receipt);run.pop('runSha256');run['runSha256']=new.stable(run);write(p/'run.json',run)
        page=r/'conference-page-staging'/'fixture';m=read(page/'manifest.json');m['analysisSha256']=ash;m['completionReceiptSha256']=receipt['receiptSha256'];m['authors']=authors['authors'];text=(page/'page.md').read_text().replace('机构信息未能从会议 PDF 纯文本可靠映射','Invented University');(page/'page.md').write_text(text);m['contentSha256']=h((page/'page.md').read_bytes());m.pop('manifestSha256');m['manifestSha256']=new.stable(m);write(page/'manifest.json',m)
        pd=r/'conference-processes'/f['processId'];state=read(pd/'state.json');item=state['items'][f['paperId']];item['analysisProof']['analysisSha256']=ash;item['analysisProof']['completionReceiptSha256']=receipt['receiptSha256'];item['pageProof']['manifestSha256']=m['manifestSha256'];item['pageProof']['contentSha256']=m['contentSha256'];completion=read(pd/'completion-receipt.json');completion['items'][0]['analysisProof']=item['analysisProof'];completion['items'][0]['pageProof']=item['pageProof'];completion.pop('receiptSha256');completion['receiptSha256']=new.stable(completion);state['completionReceiptSha256']=completion['receiptSha256'];write(pd/'state.json',state);write(pd/'completion-receipt.json',completion)
        self.assertIn('会议作者来源未由', invoke(new))
        def make_local_repo(name):
            remote, repo = r / (name + '.git'), r / name
            def git(*args):
                return subprocess.run(['git', *map(str,args)], check=True, capture_output=True, text=True)
            git('init','--bare',remote)
            git('init','-b','main',repo)
            git('-C',repo,'config','user.email','offline@example.invalid')
            git('-C',repo,'config','user.name','Offline Test')
            git('-C',repo,'config','commit.gpgsign','false')
            (repo/'README').write_text('offline base')
            git('-C',repo,'add','README')
            git('-C',repo,'commit','-m','offline base')
            git('-C',repo,'remote','add','origin',remote)
            git('-C',repo,'push','origin','HEAD:main')
            return repo
        blog, images = make_local_repo('legacy-blog'), make_local_repo('legacy-images')
        with contextlib.ExitStack() as patches:
            for module in [old, new]:
                patches.enter_context(mock.patch.object(module,'blog_repo',return_value=blog))
                patches.enter_context(mock.patch.object(module,'image_repo',return_value=images))
                patches.enter_context(mock.patch.object(module,'shared_blog_repository_lock',side_effect=lambda *a,**k:contextlib.nullcontext()))
                patches.enter_context(mock.patch.object(module,'_validate_paper_tag_format'))
                patches.enter_context(mock.patch.object(module,'_validate_aggregate_tag_format'))
            old.generate('odyssey-2026', f['processId'])
            full_generation = old.load_generation('odyssey-2026', f['processId'])
            old.validate_generation('odyssey-2026', f['processId'],blog,images)
            self.assertTrue(full_generation['files'])
            self.assertEqual(full_generation['completionReceiptSha256'],read(pd/'completion-receipt.json')['receiptSha256'])
            print('旧核心消费者实际生成的完整 v2 凭证已核验：',full_generation['generationSha256'])
            for action in [new.review,new.push]:
                with self.assertRaisesRegex(new.ConferencePublicationError,'会议作者来源未由'):
                    action('odyssey-2026',f['processId'])
            print('绑定完整来源的旧生成凭证已被真实审查与推送入口拒绝')
