"""真实逐页缓存支持混合审查；这些本地样例不代表模型实际执行。"""
import copy
import contextlib
import hashlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from test_manual_review_blog import current_attestation, manual_review_blog
from test_manual_review_arxiv_identity import publisher, assembler

DATE = '2026-08-25'


@contextlib.contextmanager
def actual_cache_fixture(recorded_identity=False):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory); repo = root / 'blog'; repo.mkdir(); current = root / 'current'; current.mkdir()
        for args in (['init', '-b', 'main'], ['config', 'user.email', 'test@example.invalid'],
                     ['config', 'user.name', 'Local fixture']):
            subprocess.run(['git', '-C', str(repo), *args], check=True, capture_output=True)
        (repo / 'hugo.yaml').write_text('baseURL: https://example.invalid/\n')
        subprocess.run(['git', '-C', str(repo), 'add', 'hugo.yaml'], check=True, capture_output=True)
        subprocess.run(['git', '-C', str(repo), 'commit', '-m', 'initial'], check=True, capture_output=True)
        pages=[]
        for suffix, paper_id in [('old','2608.12345'),('new','2608.12346')]:
            page=repo / f'content/posts/{DATE}-{suffix}.md';page.parent.mkdir(parents=True,exist_ok=True)
            page.write_text(f'---\npaper_digest_page_type: paper\npaper_digest_arxiv_id: "{paper_id}"\n---\n正文报告 WER 7.1%。\n');pages.append(page)
        old_sha=hashlib.sha256(pages[0].read_bytes()).hexdigest();relative=pages[0].relative_to(repo).as_posix()
        old_record={'path':relative,'sha256':old_sha,'reviewProtocolFingerprint':'a'*64,
                    'reviewedAt':'2026-08-25T10:00:00+08:00','imageReviewMode':'manual_semantic'}
        if recorded_identity:
            old_record['reviewIdentity']={'status':'recorded','reviewSubagent':{
                'version':1,'model':'gpt-5.6-terra','reasoningEffort':'high',
                'taskName':'original-terra-page-review','singleFileOnly':True,'isolatedContext':True}}
        with mock.patch.object(publisher,'BLOG_REPO',str(repo)), mock.patch.object(publisher,'CURRENT_DIR',current):
            cache=publisher.review_pass_cache_path(DATE);cache.write_text(json.dumps({'schemaVersion':1,'date':DATE,'files':[old_record]}))
            manifest=publisher.save_generation_manifest(DATE,pages)
            shards=publisher.manual_review_page_dir(DATE);shards.mkdir(parents=True)
            new=current_attestation()['files'][0];new['path']=pages[1].relative_to(repo).as_posix()
            new['sha256']=hashlib.sha256(pages[1].read_bytes()).hexdigest();new['reviewSubagent']['paperId']='2608.12346'
            new['notes']='2608.12346：核对 WER 7.1% 实验数值、方法说明、开源范围以及局限边界。'
            (shards/'new.json').write_text(json.dumps(new))
            yield root,repo,pages,cache,manifest,old_record


def assemble_actual():
    with mock.patch.object(assembler,'load_publish_to_blog',return_value=publisher), \
            mock.patch.object(sys,'argv',['assemble','--date',DATE]),contextlib.redirect_stdout(io.StringIO()):
        assembler.main()
    return publisher.manual_review_statement_path(DATE)


class ManualReviewCacheReuseTest(unittest.TestCase):
    def test_actual_cache_assembler_loader_save_and_receipt_validation_preserve_old_identity(self):
        for recorded in (False,True):
            with self.subTest(recorded=recorded), actual_cache_fixture(recorded) as (_root,repo,pages,cache,manifest,old):
                original_cache=cache.read_bytes();page_bytes=[p.read_bytes() for p in pages]
                plan=publisher.plan_incremental_review(DATE,pages,manifest,publisher.validate_git_publish_branch())
                self.assertEqual(plan['reusedPassed'],1);self.assertEqual(plan['paths'],[pages[1].resolve()])
                statement_path=assemble_actual();statement,_=manual_review_blog._load_review_statement(statement_path)
                self.assertEqual(cache.read_bytes(),original_cache)
                reused=next(item for item in statement['files'] if item['path']==old['path'])
                self.assertNotIn('reviewSubagent',reused);self.assertNotIn('imageFindings',reused)
                identity=reused['cacheReuse']['record']['modelIdentity']
                self.assertEqual(identity,old.get('reviewIdentity',{'status':'not_recorded'}))
                statement['completedAt']='2026-08-25T12:00:00.000+08:00';before=copy.deepcopy(statement)
                results={str(p.resolve()):{'passed':True,'reviewedSha256':hashlib.sha256(p.read_bytes()).hexdigest(),
                                         'imageReviewMode':'manual_semantic'} for p in pages}
                base=publisher.validate_git_publish_branch()
                receipt_path=publisher.save_review_receipt(DATE,pages,'local-test-gate',expected_base_head=base,
                    generation_manifest=manifest,reviewed_results=results,manual_review_record=statement)
                saved=json.loads(receipt_path.read_text())
                self.assertIsNone(publisher._manual_review_record_error(saved,date_str=DATE,
                    generation_manifest_sha256=hashlib.sha256(manifest.read_bytes()).hexdigest(),expected_base_head=base))
                self.assertEqual(saved['reviewProvenance']['files'][0].get('cacheReuse') or
                                 saved['reviewProvenance']['files'][1]['cacheReuse'],reused['cacheReuse'])
                self.assertEqual(publisher.manual_cache_reuse_for_file(DATE,old['path'],old['sha256']),reused['cacheReuse'])
                self.assertEqual(statement,before);self.assertEqual([p.read_bytes() for p in pages],page_bytes)
                # 缓存的批次元数据可以更新；原证据副本必须继续保持原身份和 SHA。
                records=json.loads(cache.read_text())['files'];record=next(r for r in records if r['path']==old['path'])
                self.assertEqual(record['originalReviewEvidence'],reused['cacheReuse'])
                new_entry=next(i for i in statement['files'] if i['path']==pages[1].relative_to(repo).as_posix())
                new_reuse=publisher.manual_cache_reuse_for_file(DATE,new_entry['path'],new_entry['sha256'])
                self.assertEqual(new_reuse['record']['modelIdentity'],{'status':'recorded',
                    'reviewSubagent':new_entry['reviewSubagent']})
                next_statement,_=manual_review_blog._load_review_statement(assemble_actual())
                self.assertTrue(all('cacheReuse' in i and 'reviewSubagent' not in i for i in next_statement['files']))
                self.assertEqual(next(i for i in next_statement['files'] if i['path']==new_entry['path'])['cacheReuse'],new_reuse)
                # 后续合法声明不能替换相同正文原来记录的模型身份或任务名称。
                another=copy.deepcopy(statement)
                next(i for i in another['files'] if i['path']==new_entry['path'])['reviewSubagent']['taskName']='another-current-review-task'
                publisher.save_review_pass_cache(DATE,pages,results,manual_review_record=another,generation_manifest=manifest)
                self.assertEqual(publisher.manual_cache_reuse_for_file(DATE,new_entry['path'],new_entry['sha256']),new_reuse)

    def test_real_cache_authority_rejects_missing_changed_digest_mixed_and_erased_identity(self):
        with actual_cache_fixture(True) as (_root,_repo,pages,cache,_manifest,old):
            statement_path=assemble_actual();statement,_=manual_review_blog._load_review_statement(statement_path)
            item=next(i for i in statement['files'] if 'cacheReuse' in i)
            for kind in ('digest','body','identity','mixed','version'):
                invalid=copy.deepcopy(item)
                if kind=='digest':invalid['cacheReuse']['recordSha256']='b'*64
                elif kind=='body':invalid['sha256']='b'*64
                elif kind=='identity':
                    invalid['cacheReuse']['record']['modelIdentity']={'status':'not_recorded'}
                    invalid['cacheReuse']['recordSha256']=publisher._stable_json_sha256(invalid['cacheReuse']['record'])
                elif kind=='mixed':invalid['reviewSubagent']=current_attestation()['files'][0]['reviewSubagent']
                else:invalid['cacheReuse']['version']=True
                with self.subTest(kind=kind),self.assertRaises(publisher.PublishDataValidationError):
                    publisher.validate_manual_cache_reuse(invalid,DATE)
            old_cache=cache.read_bytes();cache.unlink()
            with self.assertRaises(publisher.PublishDataValidationError):publisher.validate_manual_cache_reuse(item,DATE)
            cache.write_bytes(old_cache);pages[0].write_text(pages[0].read_text()+'修改后的字节\n')
            self.assertIsNone(publisher.manual_cache_reuse_for_file(DATE,old['path'],old['sha256']))

    def test_real_local_hugo_save_and_public_receipt_loader_recheck_original_evidence(self):
        with actual_cache_fixture(True) as (_root,repo,pages,cache,manifest,_old):
            statement,_=manual_review_blog._load_review_statement(assemble_actual())
            statement['completedAt']='2026-08-25T12:00:00.000+08:00'
            layout=repo/'layouts/_default/single.html';layout.parent.mkdir(parents=True)
            layout.write_text('{{ .Content }}');(repo/'layouts/index.html').write_text('本地构建样例')
            gate=publisher.run_hugo_gate(repo,pages[0].parent,required=True,source_paths=pages)
            results={str(p.resolve()):{'passed':True,'reviewedSha256':hashlib.sha256(p.read_bytes()).hexdigest(),
                                     'imageReviewMode':'manual_semantic'} for p in pages}
            publisher.save_review_receipt(DATE,pages,gate,expected_base_head=publisher.validate_git_publish_branch(),
                generation_manifest=manifest,reviewed_results=results,manual_review_record=statement)
            actual=publisher.load_verified_review_receipt(DATE)
            self.assertEqual(json.loads(actual[1].read_text())['reviewProvenance']['version'],4)
            new_entry=next(i for i in statement['files'] if 'cacheReuse' not in i)
            new_cache=publisher.manual_cache_reuse_for_file(DATE,new_entry['path'],new_entry['sha256'])
            self.assertEqual(new_cache['record']['modelIdentity'],{'status':'recorded','reviewSubagent':new_entry['reviewSubagent']})
            cached=json.loads(cache.read_text());raw=cache.read_bytes()
            reused=next(record for record in cached['files'] if 'originalReviewEvidence' in record
                        and record['originalReviewEvidence']['record']['modelIdentity'].get('reviewSubagent',{}).get('model')=='gpt-5.6-terra')
            reused['originalReviewEvidence']['record']['modelIdentity']={'status':'not_recorded'}
            reused['originalReviewEvidence']['recordSha256']=publisher._stable_json_sha256(reused['originalReviewEvidence']['record'])
            cache.write_text(json.dumps(cached))
            with self.assertRaises(publisher.PublishDataValidationError):publisher.load_verified_review_receipt(DATE)
            cache.write_bytes(raw)
            self.assertEqual(publisher.load_verified_review_receipt(DATE),actual)

    def test_mixed_statement_is_rejected_before_cache_write(self):
        with actual_cache_fixture() as (root,_repo,pages,_cache,manifest,_old):
            statement,_=manual_review_blog._load_review_statement(assemble_actual());statement['completedAt']='2026-08-25T12:00:00.000+08:00'
            cached=next(i for i in statement['files'] if 'cacheReuse' in i);cached['reviewSubagent']=current_attestation()['files'][0]['reviewSubagent']
            original=copy.deepcopy(statement);disk={p:p.read_bytes() for p in (root/'current').rglob('*') if p.is_file()}
            results={str(p.resolve()):{'passed':True,'reviewedSha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in pages};before=copy.deepcopy(results)
            with mock.patch.object(publisher,'save_review_pass_cache',wraps=publisher.save_review_pass_cache) as writer:
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher.save_review_receipt(DATE,pages,'local-test-gate',generation_manifest=manifest,
                                                  reviewed_results=results,manual_review_record=statement)
                writer.assert_not_called()
            self.assertEqual(statement,original);self.assertEqual(results,before)
            self.assertEqual({p:p.read_bytes() for p in (root/'current').rglob('*') if p.is_file()},disk)
            # 直接调用缓存保存入口也不能用自报的未核验声明添加模型身份。
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher.save_review_pass_cache(DATE,pages,results,manual_review_record=statement,generation_manifest=manifest)
            self.assertEqual({p:p.read_bytes() for p in (root/'current').rglob('*') if p.is_file()},disk)


if __name__=='__main__':unittest.main()
