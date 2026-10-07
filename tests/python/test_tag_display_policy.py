"""Offline publisher transactions; public fixtures only, no env/model/main imports."""
import ast
import copy
import io
from contextlib import redirect_stdout
import hashlib
import json
import os
import subprocess
import unittest
from pathlib import Path
import test_tag_version_files as assets_test
SOURCE = assets_test.SOURCE


BASE = 'a3b75a149852076933ec2895de77c09c73667c8334bff046dde3b20b69ded03d'
PREFERRED = {
    '68bbb2a0fb3c142ef21369320aca58f17b0ff7072e85923ec1c33dc2be98428c':
        ('a0aabb8814f1d9819e4b72e3304cee6b100c937744a626a24654f4a471f46af9',
         'c3f225b6fce48d50474719e96ba558f11df4917bdf9d1d60f61aa7d24eb0ff74'),
    '8c89a69ffe7daba6cc9da4ea5789101d6118e326b9978ec3edae1a85e965c8e3':
        ('91947cb14473c88009c2821336ea25bd8a2173b4fea58fc69e1ed1d571613e4f',
         '257d5d219ddd4750a0cc5491a418753d051456d027a648c7e41f7f640e6774f0')}
FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
POLICIES = ['data/taxonomy-presentation-policy.json',
            'static/data/taxonomy-presentation-policy.json']
DATE = '2026-10-01'


class PresentationPolicyTests(unittest.TestCase):
    # 复用 AST 隔离那套基础设施，但不继承也不重跑它的
    # 用例。另外几个真实的生产事务函数也是按 AST 加载的。
    setUp = assets_test.TagVersionFilesTests.setUp
    call = assets_test.TagVersionFilesTests.call
    write = staticmethod(assets_test.TagVersionFilesTests.write)
    put = assets_test.TagVersionFilesTests.put

    def prepare(self, preferred=None):
        self.policy_paths = list(POLICIES)
        preferred = preferred or list(PREFERRED)[1]
        self.base = json.loads((FIXTURES / (BASE + '.json')).read_text())
        self.preferred = json.loads((FIXTURES / (preferred + '.json')).read_text())
        # 重建真实快照构建函数要读的那些原始运行时字段。
        # 这里既不是替换词表，也不是签名操作。
        self.env['_PAGE_TAG_CATALOG'] = {
            'version': self.base['registryVersion'], 'registrySha256': BASE,
            'concepts': [dict(id=n['id'], facet=n['facet'],
                preferredLabel={'zh': n['zh'], 'en': n['en']}, aliases=n['aliases'],
                broaderId=n['ancestorIds'][-1] if n['ancestorIds'] else None,
                **{k: n[k] for k in ('definition', 'scopeNote', 'status') if k in n})
                for n in self.base['concepts']]}
        self.assertEqual(self.call('build_tag_catalog_snapshot', snapshot_contract='paper-taxonomy-registry-snapshot-v1'), self.base)
        catalog = {'contract': 'paper-taxonomy-version-catalog-v1',
            'currentSha256': preferred, 'snapshots': [self.base, self.preferred]}
        for prefix in ('data', 'static/data'):
            self.put(f'{prefix}/taxonomy-registry.json', self.preferred)
            self.put(f'{prefix}/taxonomy-catalog.json', catalog)
            for snapshot in [self.base, self.preferred]:
                self.put(f'{prefix}/taxonomy-snapshots/{snapshot["registrySha256"]}.json', snapshot)
        self.policy = {'contract': 'paper-taxonomy-presentation-selection-v1',
            'baseRegistrySha256': BASE,
            'baseSnapshotSha256': '05046ef39ee694db3da5de2e24193bd7ec31b39efd18388bb0ae7c740f2b56b2',
            'preferredRegistrySha256': preferred,
            'preferredSnapshotSha256': PREFERRED[preferred][0],
            'preferredProjectionSha256': PREFERRED[preferred][1]}
        # 故意保留非标准的原始字节，包括缩进。
        self.policy_bytes = (json.dumps(self.policy, ensure_ascii=False, indent=4)+'\n').encode()
        self.policy_write(self.policy_bytes)

    def policy_write(self, raw):
        for relative in self.policy_paths:
            self.write(self.repo / relative, raw)

    def git(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)

    def transaction(self):
        self.prepare()
        self.env['_PAGE_TAG_CATALOG']['registrySha256'] = 'b'*64
        self.env['_PAGE_TAG_CATALOG']['version'] = 'paper-tag-catalog-v2'
        current = self.call('build_tag_catalog_snapshot')
        self.policy = dict(self.policy, contract='paper-tag-presentation-policy-v2',
            baseRegistrySha256='b'*64,
            baseSnapshotSha256=hashlib.sha256(self.call('tag_catalog_snapshot_bytes', current)).hexdigest())
        self.policy_bytes = (json.dumps(self.policy, ensure_ascii=False, indent=4)+'\n').encode()
        self.write(self.env['TAG_DISPLAY_POLICY_PATH'], self.policy_bytes)
        self.policy_paths = ['data/tag-presentation-policy.json', 'static/data/tag-presentation-policy.json']
        self.policy_write(self.policy_bytes)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Offline fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', '公开词表基线')
        self.before_head = self.git('rev-parse', 'HEAD').stdout
        extra = {'_validate_manifest_path_date', 'validate_generation_manifest_file_bytes',
                 'load_verified_review_receipt', 'git_push', '_file_fingerprint', 'restore_git_publish_state'}
        nodes = [n for n in ast.parse(SOURCE.read_text()).body
                 if isinstance(n, ast.FunctionDef) and n.name in extra]
        self.assertEqual({n.name for n in nodes}, extra)
        exec(compile(ast.Module(body=nodes, type_ignores=[]), str(SOURCE), 'exec'), self.env)
        self.env.update({
            '_git_relative_manifest': lambda paths: [Path(p).resolve().relative_to(self.repo).as_posix()
                                                     for p in paths],
            '_run_git': lambda args, **kw: self.git(*args),
            'validate_publish_date': lambda date: date,
            '_load_json_object': lambda path, *_: json.loads(Path(path).read_text()),
            'prior_api_reader_manifest_assets': lambda date: [],
            '_is_pipeline_owned_paper': lambda *args: False,
            'is_api_reader_asset_path': lambda *args: False, 'subprocess': subprocess,
            'generation_manifest_path': lambda date: self.root / 'generation.json',
            '_save_generation_journal': lambda path, journal: self.write(path,
                (json.dumps(journal)+'\n').encode())})
        self.posts = self.stage / 'posts'
        self.posts.mkdir()
        self.write(self.posts / f'{DATE}-fixture.md', b'---\npaper_digest_pipeline_owned: true\n---\npublic page\n')
        self.content = self.repo / 'content/posts'
        self.content.mkdir(parents=True)
        self.assets = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo)
        self.journal = {}
        self.records = self.call('prepare_generation_installation', self.journal,
            self.root/'journal.json', self.posts, self.content, DATE, staged_assets=self.assets)
        self.paths = self.call('resume_generation_installation', self.journal,
            self.root/'journal.json', self.posts)
        self.manifest = {'schemaVersion': 3, 'date': DATE,
            'files': [{'path': p.relative_to(self.repo).as_posix(),
                       **self.call('_file_fingerprint', p)} for p in self.paths]}
        self.manifest_path = self.root / 'generation.json'
        self.write(self.manifest_path, (json.dumps(self.manifest)+'\n').encode())
        return self.paths

    def byte_gate(self):
        return self.call('validate_generation_manifest_file_bytes', self.manifest_path, DATE)

    def test_real_262_to_330_and_338_preserve_exact_original_policy_bytes(self):
        for preferred in PREFERRED:
            with self.subTest(preferred=preferred):
                self.prepare(preferred)
                assets = self.call('_legacy_tag_catalog_file_contents', self.repo)
                self.assertIn(len(assets), (10, 12))
                for relative in self.policy_paths:
                    self.assertEqual(assets[relative], self.policy_bytes)
                self.assertEqual(json.loads(assets['data/taxonomy-registry.json']), self.preferred)
                self.assertEqual(json.loads(assets['data/taxonomy-catalog.json'])['currentSha256'], preferred)
                self.assertEqual(self.call('build_tag_catalog_snapshot', snapshot_contract='paper-taxonomy-registry-snapshot-v1'), self.base)
                for relative, raw in assets.items():
                    self.write(self.repo / relative, raw)
                self.assertEqual(self.call('_legacy_tag_catalog_file_contents', self.repo), assets)

    def test_without_policy_keeps_original_base_selection(self):
        self.prepare()
        for relative in self.policy_paths: (self.repo / relative).unlink()
        assets = self.call('_legacy_tag_catalog_file_contents', self.repo)
        self.assertEqual(len(assets), 8)
        self.assertEqual(json.loads(assets['data/taxonomy-registry.json']), self.base)

    def test_each_binding_and_unknown_field_fail_before_stage_writes(self):
        self.prepare()
        for key in self.policy:
            with self.subTest(key=key):
                wrong = dict(self.policy); wrong[key] = '0'*64
                self.policy_write(json.dumps(wrong).encode())
                with self.assertRaises(self.error):
                    self.call('_legacy_tag_catalog_file_contents', self.repo)
                self.assertEqual(list(self.stage.iterdir()), [])
        wrong = dict(self.policy, downgradeAllowed=True)
        self.policy_write(json.dumps(wrong).encode())
        with self.assertRaises(self.error): self.call('_legacy_tag_catalog_file_contents', self.repo)

    def test_duplicate_key_and_semantically_equal_mirror_bytes_rejected(self):
        self.prepare()
        self.write(self.repo/self.policy_paths[1], json.dumps(self.policy).encode())
        with self.assertRaisesRegex(self.error, '标签展示策略只缺少一份副本，或 data 与 static/data 中的文件内容不完全一致。'): self.call('_legacy_tag_catalog_file_contents', self.repo)
        raw = self.policy_bytes[:-2] + b', "contract":"paper-taxonomy-presentation-selection-v1"}\n'
        self.policy_write(raw)
        with self.assertRaisesRegex(self.error, '重复键'): self.call('_legacy_tag_catalog_file_contents', self.repo)

    def test_missing_mirror_archive_catalog_and_dangling_symlink_rejected(self):
        self.prepare()
        for relative in [self.policy_paths[1], 'static/data/taxonomy-snapshots/'+self.preferred['registrySha256']+'.json',
                         'static/data/taxonomy-catalog.json']:
            with self.subTest(relative=relative):
                path=self.repo/relative; raw=path.read_bytes(); path.unlink()
                with self.assertRaises(self.error): self.call('_legacy_tag_catalog_file_contents', self.repo)
                path.write_bytes(raw)
        path=self.repo/self.policy_paths[0]; path.unlink(); path.symlink_to(self.root/'missing')
        with self.assertRaisesRegex(self.error, '符号链接'): self.call('_legacy_tag_catalog_file_contents', self.repo)

    def test_hardlink_and_parent_symlink_rejected(self):
        self.prepare()
        path=self.repo/self.policy_paths[0]; other=self.root/'link'; os.link(path, other)
        with self.assertRaisesRegex(self.error, '标签展示策略和快照必须是普通文件，且只能有一个硬链接。'): self.call('_legacy_tag_catalog_file_contents', self.repo)
        other.unlink()
        data=self.repo/'static/data'; moved=self.repo/'static/moved'; data.rename(moved); data.symlink_to(moved)
        with self.assertRaisesRegex(self.error, '符号链接'): self.call('_legacy_tag_catalog_file_contents', self.repo)

    def test_approved_bytes_cannot_hide_changed_base_concept_or_graph(self):
        self.prepare()
        changed=copy.deepcopy(self.preferred); changed['concepts'][0]['zh'] += '改'
        # 即使策略摘要刚刚被改过，这个增量语义检查
        # 仍须拒绝已有标签、定义和父级的改动。
        for prefix in ('data', 'static/data'):
            catalog=json.loads((self.repo/f'{prefix}/taxonomy-catalog.json').read_text())
            catalog['snapshots'][1]=changed
            self.put(f'{prefix}/taxonomy-catalog.json',catalog)
            self.put(f'{prefix}/taxonomy-registry.json',changed)
            self.put(f'{prefix}/taxonomy-snapshots/{changed["registrySha256"]}.json',changed)
        self.policy['preferredSnapshotSha256']=hashlib.sha256(self.call('tag_catalog_snapshot_bytes',changed)).hexdigest()
        self.policy['preferredProjectionSha256']=self.call('_historical_tag_prompt_text_sha256',changed)
        self.policy_write(json.dumps(self.policy).encode())
        with self.assertRaisesRegex(self.error, '标签展示策略选用的词表修改了已有概念，或改变了它们的顺序；只允许在原列表末尾追加概念。'): self.call('_legacy_tag_catalog_file_contents',self.repo)

    def test_generation_journal_precise_members_install_and_idempotent_resume(self):
        self.transaction()
        self.assertEqual(len(self.records),13)
        self.assertEqual({r['path'] for r in self.records}, {p.relative_to(self.repo).as_posix() for p in self.paths})
        for relative in self.policy_paths:
            self.assertEqual((self.repo/relative).read_bytes(),self.policy_bytes)
            self.assertEqual((self.stage/relative).read_bytes(),self.policy_bytes)
        self.assertTrue(self.byte_gate())
        results={}
        self.assertEqual(self.call('review_tag_catalog_files', DATE,self.paths,self.manifest_path,results),0)
        self.assertEqual(len(results),12)
        self.assertEqual(self.call('resume_generation_installation',self.journal,self.root/'journal.json',self.posts),self.paths)
        self.assertEqual(self.git('rev-parse','HEAD').stdout,self.before_head)

    def test_policy_change_before_installation_rejected_by_real_git_ownership(self):
        self.transaction()
        # 在外来策略改动之前准备好的新暂存内容，
        # 无权覆盖那次改动；真实的 git status 会拒绝没有凭证的字节。
        self.policy_write(self.policy_bytes+b' ')
        self.journal={}
        with self.assertRaisesRegex(self.error,'人工'):
            self.call('prepare_generation_installation', self.journal,self.root/'next.json',self.posts,
                      self.content,DATE,staged_assets=self.assets)

    def test_generation_policy_drift_even_json_whitespace_blocks_review(self):
        self.transaction()
        self.policy_write(self.policy_bytes+b' ')
        with self.assertRaisesRegex(self.error,'文件内容或删除状态与生成时的记录不一致'):self.byte_gate()
        self.assertGreater(self.call('review_tag_catalog_files',DATE,self.paths,self.manifest_path,{}),0)

    def test_policy_removed_after_generation_cannot_silently_downgrade(self):
        self.transaction()
        for relative in self.policy_paths: (self.repo/relative).unlink()
        with self.assertRaisesRegex(self.error,'文件内容或删除状态与生成时的记录不一致'): self.byte_gate()
        self.assertGreater(self.call('review_tag_catalog_files',DATE,self.paths,self.manifest_path,{}),0)

    def test_source_registry_advance_is_unknown_even_if_richer(self):
        self.prepare()
        self.env['_PAGE_TAG_CATALOG']['registrySha256']='1'*64
        with self.assertRaisesRegex(self.error,'实际签发来源'):
            self.call('_legacy_tag_catalog_file_contents',self.repo)

    def test_policy_and_archive_paths_only_exact_whitelist(self):
        self.prepare()
        for path in ['data/other-policy.json','data/taxonomy-presentation-policy.json/child',
                     'static/data/../data/taxonomy-presentation-policy.json',
                     '/data/taxonomy-presentation-policy.json',
                     'static\\data\\taxonomy-presentation-policy.json']:
            with self.subTest(path=path): self.assertFalse(self.call('_is_tag_catalog_file_path',path))
        for path in self.policy_paths: self.assertTrue(self.call('_is_tag_catalog_file_path',path))

    def test_prior_receipt_allows_exact_policy_only(self):
        self.transaction()
        allowances={r['path']:{'sha256':r['sha256'],'controlledTagFiles':True} for r in self.manifest['files']
                    if self.call('_is_tag_catalog_file_path',r['path'])}
        paths=[self.repo/p for p in allowances]
        self.call('validate_manifest_clean_against_head',paths,allowances)
        self.policy_write(self.policy_bytes+b' ')
        with self.assertRaises(self.error):self.call('validate_manifest_clean_against_head',paths,allowances)

    def test_post_review_policy_drift_reaches_real_push_gate_before_any_git_write(self):
        self.transaction()
        self.assertEqual(self.call('review_tag_catalog_files',DATE,self.paths,self.manifest_path,{}),0)
        receipt={'schemaVersion':3,'date':DATE,'strictReview':True,'hugoGate':'hugo',
            'reviewProtocolFingerprint':'offline-protocol',
            'generationManifestSha256':hashlib.sha256(self.manifest_path.read_bytes()).hexdigest()}
        path=self.root/'receipt.json';self.write(path,json.dumps(receipt).encode())
        self.env.update({'review_receipt_path':lambda date:path,
            'review_protocol_fingerprint':lambda:'offline-protocol',
            '_manual_review_record_error':lambda *a,**kw:None,
            'validate_current_generation_template':lambda *a:None,
            '_validate_active_publication_scope':lambda *a:None,
            'validate_generation_visual_contract':lambda *a:None})
        before=self.git('status','--porcelain=v1','-z').stdout
        index=self.git('write-tree').stdout
        self.policy_write(self.policy_bytes+b' ')
        dirty=self.git('status','--porcelain=v1','-z').stdout
        # 生产用的 git_push、load_verified_review_receipt 和字节校验器
        # 都会真实执行。只有不相干的协议/模型来源前置步骤被替换成桩。
        # 过了字节检查之后的每一次 git 调用都被禁止。
        self.env['_run_git']=lambda *a,**kw: self.fail('push attempted Git mutation/remote operation')
        output = io.StringIO()
        with redirect_stdout(output):
            self.assertFalse(self.call('git_push',DATE,self.paths))
        self.assertIn('文件内容或删除状态与生成时的记录不一致', output.getvalue())
        self.assertNotIn('恢复失败', output.getvalue())
        self.assertEqual(self.git('rev-parse','HEAD').stdout,self.before_head)
        self.assertEqual(self.git('write-tree').stdout,index)
        self.assertEqual(self.git('status','--porcelain=v1','-z').stdout,dirty)
        self.assertNotEqual(before,dirty) # 篡改之前，索引里的策略是干净的

    def test_interrupted_policy_installation_uses_only_frozen_stage_and_rejects_drift(self):
        self.transaction()
        # 已安装的版本会沿用冻结的原始策略，即使镜像出来的
        # 当前工作区字节已经不同。它不能重新生成选择结果。
        changed=self.policy_bytes+b' '
        self.write(self.repo/self.policy_paths[0],changed)
        with self.assertRaises(self.error):self.call('resume_generation_installation',self.journal,self.root/'journal.json',self.posts)
        with self.assertRaises(self.error):self.call('tag_catalog_file_contents',self.repo)
        self.assertEqual(set(self.call('prepare_tag_catalog_staged_files',self.stage,self.repo,
            installation=self.journal['installation'])),set(self.assets))
        self.write(self.stage/self.policy_paths[0],changed)
        with self.assertRaises(self.error):self.call('prepare_tag_catalog_staged_files',self.stage,self.repo,
            installation=self.journal['installation'])


    def test_new_policy_uses_new_base_but_original_preferred_proof(self):
        self.transaction()
        versions = json.loads((self.repo/'data/tag-catalog-versions.json').read_text())
        issued = {item['registrySha256']: item for item in versions['snapshots']}
        self.assertEqual(issued[self.preferred['registrySha256']], self.preferred)
        display = json.loads((self.repo/'data/tag-catalog-snapshot.json').read_text())
        self.assertEqual(display, dict(self.preferred, contract='paper-tag-catalog-snapshot-v2'))
        self.assertEqual(issued['b'*64]['contract'], 'paper-tag-catalog-snapshot-v2')
        self.assertEqual(self.policy['preferredSnapshotSha256'], PREFERRED[self.preferred['registrySha256']][0])
        self.assertEqual(self.policy['preferredProjectionSha256'], PREFERRED[self.preferred['registrySha256']][1])
        self.assertEqual(self.call('export_tag_catalog_files', self.repo), [])
        relative = 'data/tag-catalog-history/'+self.preferred['registrySha256']+'.json'
        self.assertIn(self.repo / relative, self.paths)
        self.assertFalse(any('/taxonomy-snapshots/' in item['path'] for item in self.records))
        self.assertEqual((self.repo / relative).read_bytes(),
                         (self.repo/'data/taxonomy-snapshots'/(self.preferred['registrySha256']+'.json')).read_bytes())
        self.env['_PAGE_TAG_CATALOG']['registrySha256'] = '1'*64
        with self.assertRaisesRegex(self.error, '实际签发来源'):
            self.call('tag_catalog_file_contents', self.repo)

    def test_old_policy_bytes_restore_after_current_source_changes(self):
        self.prepare()
        assets = self.call('_legacy_tag_catalog_file_contents', self.repo)
        for relative, raw in assets.items():
            self.write(self.stage / relative, raw)
        records = [{'path': relative, 'delete': False, 'stagedRelativePath': relative,
            'expectedSha256': hashlib.sha256(raw).hexdigest()} for relative, raw in assets.items()]
        self.env['_PAGE_TAG_CATALOG']['registrySha256'] = 'b'*64
        self.env['TAG_DISPLAY_POLICY_PATH'].write_text('{}')
        paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                          installation={'files': records})
        self.assertEqual({p.relative_to(self.stage).as_posix() for p in paths}, set(assets))
        for relative in self.policy_paths:
            self.assertEqual((self.stage / relative).read_bytes(), self.policy_bytes)
        # 即使记录跟随新 SHA 更新，改变归档排版也不能替代策略批准的原字节。
        sha = self.preferred['registrySha256']
        altered = (json.dumps(self.preferred, ensure_ascii=False, indent=2)+'\n').encode()
        for prefix in ('data', 'static/data'):
            relative = f'{prefix}/taxonomy-snapshots/{sha}.json'
            self.write(self.stage / relative, altered)
            next(record for record in records if record['path'] == relative)['expectedSha256'] = hashlib.sha256(altered).hexdigest()
        with self.assertRaisesRegex(self.error, '归档原字节与批准的快照 SHA 不一致'):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                      installation={'files': records})

    def test_当前归档完整安装和审查只复用保存的原字节(self):
        self.transaction()
        records = self.journal['installation']['files']
        archive_paths = [item['path'] for item in records if '/tag-catalog-history/' in item['path']]
        self.assertEqual(len(archive_paths), 6)
        self.assertFalse(any('/taxonomy-snapshots/' in item['path'] for item in records))
        before = {item['path']: (self.repo / item['path']).read_bytes() for item in records}
        saved_records = copy.deepcopy(records)
        def forbidden_default(*args, **kwargs):
            self.fail('安装恢复和审查不得调用当前默认生成器')
        self.env['tag_catalog_file_contents'] = forbidden_default
        paths = self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                          installation=self.journal['installation'])
        self.assertEqual({path.relative_to(self.stage).as_posix() for path in paths},
                         {item['path'] for item in records if item['path'].startswith(('data/', 'static/data/'))})
        self.call('resume_generation_installation', self.journal, self.root/'journal.json', self.posts)
        self.assertEqual(records, saved_records)
        self.assertTrue(self.byte_gate())
        results = {}
        self.assertEqual(self.call('review_tag_catalog_files', DATE,
            [self.repo / item['path'] for item in records], self.manifest_path, results), 0)
        self.assertEqual(len(results), 12)
        self.assertEqual({item['path']: (self.repo / item['path']).read_bytes() for item in records}, before)

    def test_当前归档先核保存的原字节再核展示策略所选快照(self):
        self.transaction()
        sha = self.preferred['registrySha256']
        relatives = [f'{prefix}/tag-catalog-history/{sha}.json' for prefix in ('data', 'static/data')]
        raw = (json.dumps(self.preferred, ensure_ascii=False, indent=2) + '\n').encode()
        records = copy.deepcopy(self.journal['installation']['files'])
        for relative in relatives:
            self.write(self.stage / relative, raw)
        # 原安装 SHA 未更新时，字节不符必须先于策略或 JSON 内容判断。
        with self.assertRaisesRegex(self.error, '字节或 SHA 与原记录不一致'):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                      installation={'files': records})
        for item in records:
            if item['path'] in relatives:
                item['expectedSha256'] = hashlib.sha256(raw).hexdigest()
        # 即使两个副本对象相等且各自记录匹配，批准的首选快照仍绑定原始文件 SHA。
        with self.assertRaisesRegex(self.error, '归档原字节与批准的快照 SHA 不一致'):
            self.call('prepare_tag_catalog_staged_files', self.stage, self.repo,
                      installation={'files': records})


if __name__ == '__main__':
    unittest.main()
