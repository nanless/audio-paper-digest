"""Temporary public-fixture repositories and real local Mach-O/codesign/ditto.
No personal app/profile/Keychain access, network, tag push or GitHub mutation.
"""
import base64, copy, hashlib, io, json, os, pathlib, platform, plistlib, shutil, subprocess, tarfile
import sys, tempfile, unittest
sys.dont_write_bytecode=True

SCRIPT=pathlib.Path(__file__).resolve().parents[1]/'release.sh'
HELPER=SCRIPT.with_name('release_tools.py')
def real_repo():
    return pathlib.Path(subprocess.check_output(['git','-C',str(SCRIPT.parent),'rev-parse','--show-toplevel'],text=True).strip())
sha=lambda raw:hashlib.sha256(raw).hexdigest()

def execute(args,cwd=None,env=None):
    return subprocess.run([str(x) for x in args],cwd=cwd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)

def success(args,cwd=None):
    r=execute(args,cwd);assert r.returncode==0,r.stderr.decode();return r.stdout

def write(path,raw):
    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)

def save(path,value):
    write(path,(json.dumps(value,ensure_ascii=False,indent=2)+'\n').encode())

class Packaging(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('CODEX_SANDBOX'):raise RuntimeError('请在本机正常开发环境执行测试')
        if platform.system()!='Darwin':raise unittest.SkipTest('真实codesign/ditto/DMG验收需要macOS，不伪造通过')
        cls.base=tempfile.TemporaryDirectory(prefix='paperdigest-release-test-template-');cls.template=pathlib.Path(cls.base.name)
        repo=cls.template/'repo';repo.mkdir();app=cls.template/'论文速递.app';resources=app/'Contents/Resources'
        cls.arch=platform.machine()
        cls.fixed={'Seed/assets/fixture.pdf':b'Explicit public fixture PDF bytes.','Seed/assets/fixture.png':b'Explicit public fixture image bytes.','Web/vendor/katex/katex.min.js':b'// Explicit pinned public fixture math library.','Web/vendor/katex/fonts/fixture.woff2':b'Explicit fixture font bytes.','Web/vendor/katex/LICENSE':b'Explicit public fixture MIT license.'}
        sample={'pdf':{'src':'fixture.pdf','sha256':sha(cls.fixed['Seed/assets/fixture.pdf'])},'figures':[{'src':'fixture.png','sha256':sha(cls.fixed['Seed/assets/fixture.png'])}]}
        packed=io.BytesIO()
        with tarfile.open(fileobj=packed,mode='w:gz') as tar:
            for name,data in {'package/dist/katex.min.js':cls.fixed['Web/vendor/katex/katex.min.js'],'package/dist/fonts/fixture.woff2':cls.fixed['Web/vendor/katex/fonts/fixture.woff2'],'package/LICENSE':cls.fixed['Web/vendor/katex/LICENSE'],'package/package.json':b'{"name":"katex","version":"0.19.1"}'}.items():
                entry=tarfile.TarInfo(name);entry.size=len(data);tar.addfile(entry,io.BytesIO(data))
        archive=packed.getvalue();integrity=hashlib.sha512(archive).digest();key=integrity.hex();cache=cls.template/'cache/_cacache/content-v2/sha512'/key[:2]/key[2:4]/key[4:];write(cache,archive)
        lock={'packages':{'node_modules/katex':{'version':'0.19.1','resolved':'https://registry.npmjs.org/katex/-/katex-0.19.1.tgz','integrity':'sha512-'+base64.b64encode(integrity).decode()}}}
        files={'apps/macos/Sources/Main.swift':b'// Explicit isolated public-source fixture, never user app.\n', 'apps/macos/build.sh':b'#!/bin/bash\n# Explicit isolated build fixture.\n', 'apps/macos/Resources/index.html':b'<html><body>Isolated release fixture</body></html>\n','apps/macos/llm-worker.cjs':b'// Explicit isolated fixture; no model service.\n','prototypes/macos-research/sample.json':json.dumps(sample).encode(),'.gitignore':b'prototypes/macos-research/assets/\n','apps/macos/package.json':b'{"dependencies":{"katex":"0.19.1"}}','apps/macos/package-lock.json':json.dumps(lock).encode()}
        # Explicit private-QA fixtures preserve all historical sample assertions.
        files['apps/macos/build_resources.py']=SCRIPT.with_name('build_resources.py').read_bytes()
        for notice in (SCRIPT.parent/'Resources').rglob('*'):
            if notice.is_file():files['apps/macos/Resources/'+notice.relative_to(SCRIPT.parent/'Resources').as_posix()]=notice.read_bytes()
        plist={'CFBundleIdentifier':'com.nanless.PaperDigest','CFBundleName':'论文速递','CFBundleExecutable':'PaperDigest','CFBundlePackageType':'APPL','CFBundleShortVersionString':'1.0.0','CFBundleVersion':'1','LSMinimumSystemVersion':'15.0'}
        files['apps/macos/Info.plist']=plistlib.dumps(plist)
        for name,raw in files.items():write(repo/name,raw)
        success(['git','init','-q',repo]);success(['git','config','user.name','Isolated Release Fixture'],repo);success(['git','config','user.email','fixture@example.invalid'],repo);success(['git','add','.'],repo);success(['git','commit','-qm','Isolated public fixture'],repo)
        cls.commit=success(['git','rev-parse','HEAD'],repo).decode().strip()
        mapping={'Sources/Main.swift':'apps/macos/Sources/Main.swift','Build/build.sh':'apps/macos/build.sh','Web/index.html':'apps/macos/Resources/index.html','Seed/sample.json':'prototypes/macos-research/sample.json','Contents/Info.plist':'apps/macos/Info.plist','Contents/Resources/llm-worker.cjs':'apps/macos/llm-worker.cjs'}
        for source in files:
            if source.startswith('apps/macos/Resources/') and source!='apps/macos/Resources/index.html':mapping['Web/'+source[len('apps/macos/Resources/'):]]=source
        mapping['Build/build_resources.py']='apps/macos/build_resources.py'
        entries=[]
        for relative,source in mapping.items():
            raw=files[source];entries.append({'path':relative,'bytes':len(raw),'sha256':sha(raw)})
            if not relative.startswith(('Sources/','Build/')):write(app/(relative if relative.startswith('Contents/') else 'Contents/Resources/'+relative),raw)
        for relative,raw in cls.fixed.items():
            write(resources/relative,raw);entries.append({'path':relative,'bytes':len(raw),'sha256':sha(raw)})
            if relative.startswith('Seed/assets/'):write(repo/('prototypes/macos-research/assets/'+relative[len('Seed/assets/'):]),raw)
        source=cls.template/'main.c';source.write_text('#include <stdio.h>\n#include <stdlib.h>\nint main(void) { if(getenv("NODE_OPTIONS")) return 9; puts("v24.19.0"); return 0; }\n')
        main=app/'Contents/MacOS/PaperDigest';main.parent.mkdir(parents=True)
        success(['/usr/bin/clang','-target',cls.arch+'-apple-macos15.0',source,'-o',main])
        node=resources/'Runtime/node';node.parent.mkdir(parents=True);shutil.copy2(main,node)
        success(['/usr/bin/codesign','--force','--sign','-','--timestamp=none',node])
        write(resources/'Runtime/NODE-LICENSE',files['apps/macos/Resources/licenses/Node-v24.19.0-LICENSE.txt'])
        for relative in ['Contents/Resources/Runtime/node','Contents/Resources/Runtime/NODE-LICENSE']:
            raw=(app/relative).read_bytes();entries.append({'path':relative,'bytes':len(raw),'sha256':sha(raw)})
        save(resources/'build-metadata.json',{'contract':'paper-digest-mac-build-v1','distributionChannel':'private-qa','builtAt':'2026-10-24T18:15:23.755225+00:00','sourceCommit':cls.commit,'architecture':cls.arch,'signing':'ad-hoc; not notarized','files':entries})
        cls.sign(app)
        cls.make_record(app,cls.template/'record.json')

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls,'base'):cls.base.cleanup()

    @staticmethod
    def sign(app):success(['/usr/bin/codesign','--force','--sign','-','--timestamp=none','--identifier','com.nanless.PaperDigest',app])

    @staticmethod
    def make_record(app,path):
        metadata=app/'Contents/Resources/build-metadata.json';m=json.loads(metadata.read_bytes());binary=app/'Contents/MacOS/PaperDigest';raw=binary.read_bytes()
        save(path,{'contract':'paper-digest-mac-signed-build-v1','builtAt':m['builtAt'],'sourceCommit':m['sourceCommit'],'architecture':m['architecture'],'signing':m['signing'],'bundlePath':'/explicit/private/fixture/path/not-for-public-output','buildMetadataSHA256':sha(metadata.read_bytes()),'binary':{'path':'Contents/MacOS/PaperDigest','bytes':len(raw),'sha256':sha(raw)}})

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='paperdigest-release-test-');self.root=pathlib.Path(self.temp.name)
        self.repo=self.root/'repo';shutil.copytree(self.template/'repo',self.repo)
        self.app=self.root/'论文速递.app';success(['/usr/bin/ditto',self.template/'论文速递.app',self.app])
        self.record=self.root/'record.json';shutil.copy2(self.template/'record.json',self.record);self.output=self.root/'out'
        self.cache=self.root/'cache';shutil.copytree(self.template/'cache',self.cache)

    def tearDown(self):self.temp.cleanup()

    def call(self,command='inspect',*options,expected=0,env=None):
        if command in ['inspect','prepare']:args=['--app',self.app,'--build-record',self.record,'--repo',self.repo,*options]
        else:args=['--prepared',self.output,'--repo',self.repo,*options]
        env=dict(os.environ if env is None else env,PD_RELEASE_NPM_CACHE=str(self.cache));r=execute(['/bin/bash',SCRIPT,command,*args],env=env)
        if expected==0:self.assertEqual(r.returncode,0,r.stderr.decode());return json.loads(r.stdout)
        self.assertNotEqual(r.returncode,0,'negative case must not succeed');return r.stderr.decode()

    def change_metadata(self,action):
        p=self.app/'Contents/Resources/build-metadata.json';m=json.loads(p.read_bytes());action(m);save(p,m);self.sign(self.app);self.make_record(self.app,self.record)

    def prepare(self,dmg=False):return self.call('prepare','--output',self.output,*(['--dmg'] if dmg else []))

    def make_formal(self):
        # Resign only this unsigned-fixture rebuild: never delete a real signed candidate.
        unsigned=self.root/'unsigned-formal.app';success(['/usr/bin/ditto',self.app,unsigned])
        shutil.rmtree(unsigned/'Contents/_CodeSignature');shutil.rmtree(unsigned/'Contents/Resources/Seed')
        metadata=unsigned/'Contents/Resources/build-metadata.json';value=json.loads(metadata.read_bytes());value['distributionChannel']='release';value['files']=[row for row in value['files']if not row['path'].startswith('Seed/')];save(metadata,value)
        self.sign(unsigned);self.make_record(unsigned,self.record);shutil.rmtree(self.app);unsigned.rename(self.app)

    def test_01_real_signed_fixture_inspects_without_launching(self):
        r=self.call();self.assertEqual(r['architecture'],self.arch);self.assertFalse(r['publicationEligible']);self.assertEqual(r['sourceCommit'],self.commit)

    def test_02_zip_real_decode_signature_and_privacy(self):
        before=sha((self.app/'Contents/MacOS/PaperDigest').read_bytes());r=self.prepare();self.assertFalse(r['publicationEligible']);self.assertTrue(self.call('verify')['verified'])
        self.assertEqual(sha((self.app/'Contents/MacOS/PaperDigest').read_bytes()),before)
        public=(self.output/'build-info.json').read_text();self.assertNotIn(str(self.root),public);self.assertNotIn('/explicit/private',public);self.assertNotIn('bundlePath',public);self.assertNotIn('.qa/',public)

    def test_03_dmg_actual_readonly_mount_and_applications_link(self):
        r=self.prepare(True);self.assertTrue(any(p.endswith('.dmg') for p in r['artifacts']));self.assertTrue(self.call('verify')['verified'])

    def test_04_mismatched_bundle_version_refused(self):self.assertIn('版本',self.call('inspect','--version','0.1.0',expected=1))
    def test_05_dirty_source_refused(self):write(self.repo/'apps/macos/Sources/Main.swift',b'changed');self.assertIn('未提交',self.call(expected=1))
    def test_06_dirty_documentation_also_refused(self):write(self.repo/'docs/changed.md',b'doc');self.assertIn('未提交',self.call(expected=1))
    def test_07_untracked_file_refused(self):write(self.repo/'untracked-file',b'not committed');self.assertIn('未提交',self.call(expected=1))

    def test_08_committed_documentation_only_head_is_explicit(self):
        write(self.repo/'docs/release.md',b'Public documentation only.');success(['git','add','.'],self.repo);success(['git','commit','-qm','Documentation only'],self.repo)
        r=self.call();self.assertEqual(r['documentationOnlyChanges'],['docs/release.md']);self.assertNotEqual(r['sourceCommit'],r['releaseHead'])

    def test_09_committed_runtime_change_requires_new_build(self):
        write(self.repo/'apps/macos/Resources/index.html',b'changed');success(['git','add','.'],self.repo);success(['git','commit','-qm','Changed runtime'],self.repo)
        self.assertIn('非文档变更',self.call(expected=1))

    def test_android_only_change_preserves_exact_mac_candidate(self):
        write(self.repo/'apps/android/app/src/main/java/Fixture.kt',b'// Independent Android fixture, no Mac input.\n')
        success(['git','add','.'],self.repo);success(['git','commit','-qm','Independent Android fixture'],self.repo)
        r=self.call();self.assertEqual(r['documentationOnlyChanges'],[])
        self.assertEqual(r['otherNonRuntimeChanges'],['apps/android/app/src/main/java/Fixture.kt'])
        self.assertEqual(r['sourceCommit'],self.commit);self.assertNotEqual(r['sourceCommit'],r['releaseHead'])
        self.assertFalse(r['publicationEligible'])

    def test_android_change_cannot_hide_changed_shared_mac_input(self):
        write(self.repo/'apps/android/Fixture.kt',b'// Independent Android fixture.\n')
        write(self.repo/'prototypes/macos-research/sample.json',b'{}')
        success(['git','add','.'],self.repo);success(['git','commit','-qm','Changed shared sample'],self.repo)
        self.assertIn('非文档变更',self.call(expected=1))

    def test_verifier_only_change_is_separate_from_documentation(self):
        write(self.repo/'apps/macos/release_tools.py',b'# Isolated verifier fixture, not bundled.\n')
        success(['git','add','.'],self.repo);success(['git','commit','-qm','Verifier fixture'],self.repo)
        r=self.call();self.assertEqual(r['documentationOnlyChanges'],[])
        self.assertEqual(r['otherNonRuntimeChanges'],['apps/macos/release_tools.py'])

    def test_other_mac_tool_change_is_not_assumed_outside_build(self):
        write(self.repo/'apps/macos/package-lock.json',b'{}')
        success(['git','add','.'],self.repo);success(['git','commit','-qm','Changed dependency lock'],self.repo)
        self.assertIn('非文档变更',self.call(expected=1))

    def test_10_production_environment_file_is_refused(self):write(self.app/'Contents/Resources/.env',b'EXPLICIT_PRIVATE_TEST_VALUE');self.assertIn('私人',self.call(expected=1))
    def test_11_private_qa_data_is_refused(self):write(self.app/'Contents/Resources/.qa/private.json',b'{}');self.assertIn('私人',self.call(expected=1))
    def test_12_bundle_symlink_is_refused(self):os.symlink('/tmp',self.app/'Contents/Resources/link');self.assertIn('符号链接',self.call(expected=1))

    def test_13_unknown_bundle_file_is_not_hidden_by_resigning(self):
        write(self.app/'Contents/Resources/extra.json',b'{}');self.sign(self.app);self.make_record(self.app,self.record);self.assertIn('额外',self.call(expected=1))

    def test_14_broken_real_signature_is_refused(self):
        p=self.app/'Contents/MacOS/PaperDigest';raw=bytearray(p.read_bytes());raw[1024]^=1;p.write_bytes(raw);self.make_record(self.app,self.record);self.call(expected=1)

    def test_15_signed_binary_must_match_review_record(self):
        r=json.loads(self.record.read_bytes());r['binary']['sha256']='0'*64;save(self.record,r);self.assertIn('审定候选',self.call(expected=1))

    def test_16_metadata_must_match_review_record(self):
        r=json.loads(self.record.read_bytes());r['buildMetadataSHA256']='0'*64;save(self.record,r);self.assertIn('清单SHA',self.call(expected=1))

    def test_17_false_notarization_claim_is_refused(self):self.change_metadata(lambda m:m.update(signing='Developer ID; notarized'));self.assertIn('ad-hoc',self.call(expected=1))
    def test_18_wrong_architecture_is_refused(self):self.change_metadata(lambda m:m.update(architecture='x86_64' if self.arch=='arm64' else 'arm64'));self.assertIn('架构',self.call(expected=1))
    def test_19_parent_path_in_manifest_is_refused(self):self.change_metadata(lambda m:m['files'][0].update(path='../escape'));self.assertIn('越界',self.call(expected=1))
    def test_20_duplicate_manifest_path_is_refused(self):self.change_metadata(lambda m:m['files'].append(copy.deepcopy(m['files'][0])));self.assertIn('重复',self.call(expected=1))
    def test_21_omitted_native_source_is_refused(self):self.change_metadata(lambda m:m.update(files=[x for x in m['files'] if not x['path'].startswith('Sources/')]));self.assertIn('遗漏原生',self.call(expected=1))
    def test_22_fake_source_digest_is_refused(self):self.change_metadata(lambda m:m['files'][0].update(sha256='0'*64));self.assertIn('Git字节',self.call(expected=1))

    def test_23_existing_output_is_never_overwritten(self):
        self.output.mkdir();write(self.output/'preserve',b'keep');self.assertIn('已存在',self.call('prepare','--output',self.output,expected=1));self.assertEqual((self.output/'preserve').read_bytes(),b'keep')

    def test_24_archive_tampering_is_refused(self):
        self.prepare();p=next(self.output.glob('*.zip'));p.write_bytes(p.read_bytes()+b'tamper');self.assertIn('SHA',self.call('verify',expected=1))

    def test_25_extra_output_file_is_refused(self):self.prepare();write(self.output/'private.json',b'{}');self.assertIn('额外',self.call('verify',expected=1))

    def test_26_unknown_candidate_cannot_be_promoted(self):
        self.prepare();p=self.output/'build-info.json';r=json.loads(p.read_bytes());r['publicationEligible']=True;save(p,r);self.assertIn('正式',self.call('verify',expected=1))

    def test_27_pending_acceptance_cannot_even_generate_a_gh_command(self):
        self.prepare();status=self.root/'status.md';status.write_text(self.status('待验'));self.assertIn('尚未全部通过',self.call('publish-plan','--acceptance-status',status,expected=1))

    @staticmethod
    def status(state):
        return '\n'.join('| '+prefix+'-'+str(i).zfill(2)+' | '+state+' | explicit fixture |' for prefix,count in [('APP',9),('DATA',13),('READ',9),('LIB',3),('NOTE',3),('EXP',3),('LLM',10),('JOB',5),('ZOT',14)] for i in range(1,count+1))

    def test_28_complete_fixture_only_produces_nonexecuted_verify_tag_draft_plan(self):
        self.make_formal();self.prepare();status=self.root/'status.md';status.write_text(self.status('通过'));cloud=self.root/'cloud.md';cloud.write_text(self.cloud_status('通过'));r=self.call('publish-plan','--acceptance-status',status,'--cloud-acceptance',cloud,'--prerelease')
        self.assertFalse(r['executed']);self.assertFalse(r['automaticTagCreation']);self.assertFalse(r['publicPublication']);self.assertIn('--verify-tag',r['argv']);self.assertIn('--draft',r['argv']);self.assertIn('--prerelease',r['argv']);self.assertEqual(r['argv'][3],'v1.0.0')
        self.assertEqual(success(['git','tag'],self.repo),b'')

    def test_29_duplicate_or_missing_acceptance_ids_refused(self):
        self.prepare();status=self.root/'status.md';text=self.status('通过');status.write_text(text.replace('ZOT-14','ZOT-13'));self.assertIn('尚未全部通过',self.call('publish-plan','--acceptance-status',status,expected=1))

    def test_30_external_guard_cannot_be_bypassed_by_direct_python(self):
        env=dict(os.environ,CODEX_SANDBOX='1');self.assertIn('正常开发环境',self.call(expected=1,env=env))
        r=execute(['/usr/bin/python3',HELPER,'--help'],env=env);self.assertNotEqual(r.returncode,0);self.assertIn('正常开发环境',r.stderr.decode())

    @staticmethod
    def cloud_status(state):return '\n'.join('| '+p+'-'+str(i).zfill(2)+' | '+state+' | fixture |' for p,n in [('CLOUD',12),('REL',5)] for i in range(1,n+1))

    def test_31_original69_pass_but_cloud17_pending_refuses_plan(self):
        self.prepare();status=self.root/'status.md';status.write_text(self.status('通过'));cloud=self.root/'cloud.md';cloud.write_text(self.cloud_status('待验'));self.assertIn('17项尚未',self.call('publish-plan','--acceptance-status',status,'--cloud-acceptance',cloud,expected=1))

    def test_32_cloud_duplicate_id_refuses_plan(self):
        self.prepare();status=self.root/'status.md';status.write_text(self.status('通过'));cloud=self.root/'cloud.md';cloud.write_text(self.cloud_status('通过').replace('REL-05','REL-04'));self.assertIn('17项尚未',self.call('publish-plan','--acceptance-status',status,'--cloud-acceptance',cloud,expected=1))

    def test_33_ignored_seed_is_genuinely_not_git_tracked(self):
        self.assertEqual(success(['git','ls-files','prototypes/macos-research/assets'],self.repo),b'');self.call();self.prepare()

    def test_34_extra_seed_cannot_be_authorized_by_self_reported_metadata(self):
        raw=b'explicit private fixture not approved';write(self.app/'Contents/Resources/Seed/assets/private.json',raw);self.change_metadata(lambda m:m['files'].append({'path':'Seed/assets/private.json','bytes':len(raw),'sha256':sha(raw)}));self.assertIn('未知非Git',self.call(expected=1))

    def test_35_extra_katex_cannot_be_authorized_by_self_reported_metadata(self):
        raw=b'explicit private fixture not approved';write(self.app/'Contents/Resources/Web/vendor/katex/private.json',raw);self.change_metadata(lambda m:m['files'].append({'path':'Web/vendor/katex/private.json','bytes':len(raw),'sha256':sha(raw)}));self.assertIn('未知非Git',self.call(expected=1))

    def test_36_katex_same_name_modified_bytes_rejected(self):
        raw=b'changed library';write(self.app/'Contents/Resources/Web/vendor/katex/katex.min.js',raw);self.change_metadata(lambda m:next(x for x in m['files'] if x['path']=='Web/vendor/katex/katex.min.js').update(bytes=len(raw),sha256=sha(raw)));self.assertIn('锁定字节',self.call(expected=1))

    def test_37_cache_tamper_rejected_before_vendor_trust(self):
        file=next(p for p in self.cache.rglob('*') if p.is_file());file.write_bytes(file.read_bytes()+b'tampered');self.assertIn('SHA512',self.call(expected=1))

    def test_38_app_root_private_finder_comment_rejected(self):
        success(['/usr/bin/xattr','-w','com.apple.metadata:kMDItemFinderComment','Explicit synthetic private fixture',self.app]);self.assertIn('私人',self.call(expected=1))

    def test_39_contents_directory_private_download_location_rejected(self):
        success(['/usr/bin/xattr','-w','com.apple.metadata:kMDItemWhereFroms','Explicit synthetic private fixture',self.app/'Contents']);self.assertIn('私人',self.call(expected=1))

    def test_40_real_public_seed_and_locked_katex_topology_readonly(self):
        import runpy
        module=runpy.run_path(str(HELPER));repo=real_repo();commit=success(['git','rev-parse','HEAD'],repo).decode().strip();fixed=module['fixed_public_inputs'](repo,commit)
        for relative,entry in fixed.items():
            if relative.startswith('Seed/assets/'):file=repo/'prototypes/macos-research/assets'/relative[len('Seed/assets/'):]
            else:
                tail=relative[len('Web/vendor/katex/'):];file=repo/'apps/macos/node_modules/katex'/('LICENSE' if tail=='LICENSE' else 'dist/'+tail)
            self.assertEqual(sha(file.read_bytes()),entry['sha256'])

    def test_41_app_root_symlink_not_silently_resolved(self):
        alias=self.root/'linked.app';os.symlink(self.app,alias);r=execute(['/bin/bash',SCRIPT,'inspect','--app',alias,'--repo',self.repo,'--build-record',self.record]);self.assertNotEqual(r.returncode,0);self.assertIn('根不能是符号链接',r.stderr.decode())

    def add_formal_resource(self,name,raw):
        write(self.repo/('apps/macos/Resources/'+name),raw)
        success(['git','add','.'],self.repo);success(['git','commit','-qm','Explicit formal resource negative fixture'],self.repo)
        commit=success(['git','rev-parse','HEAD'],self.repo).decode().strip();write(self.app/('Contents/Resources/Web/'+name),raw)
        self.change_metadata(lambda m:(m.update(sourceCommit=commit),m['files'].append({'path':'Web/'+name,'bytes':len(raw),'sha256':sha(raw)})))

    def test_46_formal_empty_bootstrap_has_no_scientific_seed_and_keeps_licenses(self):
        self.make_formal();r=self.call();self.assertEqual('release',r['distributionChannel']);self.assertFalse((self.app/'Contents/Resources/Seed').exists());self.assertTrue((self.app/'Contents/Resources/Web/third-party-notices.html').is_file());self.prepare();self.assertTrue(self.call('verify')['verified'])

    def test_47_private_qa_cannot_publish_even_with_all86_fixture_checks(self):
        self.prepare();status=self.root/'status.md';status.write_text(self.status('通过'));cloud=self.root/'cloud.md';cloud.write_text(self.cloud_status('通过'));self.assertIn('私有QA',self.call('publish-plan','--acceptance-status',status,'--cloud-acceptance',cloud,expected=1))

    def test_48_legacy_missing_channel_is_inspect_only_not_formal(self):
        self.change_metadata(lambda m:m.pop('distributionChannel'));self.assertEqual('legacy-private-qa',self.call()['distributionChannel']);self.assertIn('仅可inspect',self.call('prepare','--output',self.output,expected=1))

    def test_49_unknown_channel_or_empty_seed_in_formal_is_rejected(self):
        self.change_metadata(lambda m:m.update(distributionChannel='invented'));self.assertIn('通道',self.call(expected=1))
        self.change_metadata(lambda m:m.update(distributionChannel='private-qa'));self.make_formal();(self.app/'Contents/Resources/Seed').mkdir();self.sign(self.app);self.make_record(self.app,self.record);self.assertIn('Seed',self.call(expected=1))

    def test_50_renamed_known_scientific_original_cannot_hide_in_git_mapped_resource(self):
        self.make_formal();self.add_formal_resource('innocent.dat',self.fixed['Seed/assets/fixture.pdf']);self.assertIn('样稿',self.call(expected=1))

    def test_51_embedded_data_uri_scientific_figure_is_refused(self):
        self.make_formal();raw=b'<img src="data:image/png;base64,'+base64.b64encode(self.fixed['Seed/assets/fixture.png'])+b'">';self.add_formal_resource('innocent.html',raw);self.assertIn('原图',self.call(expected=1))

    def test_52_renamed_entire_sample_and_omitted_full_license_are_refused(self):
        self.make_formal();self.add_formal_resource('renamed.json',(self.repo/'prototypes/macos-research/sample.json').read_bytes());self.assertIn('样稿',self.call(expected=1))

    def test_53_missing_offline_license_never_becomes_formal(self):
        self.make_formal();(self.app/'Contents/Resources/Web/licenses/SIL-OFL-1.1.txt').unlink();self.sign(self.app);self.make_record(self.app,self.record);self.call(expected=1)

    def test_54_qa_then_release_unsigned_staging_without_clean_cannot_leak_old_seed(self):
        import runpy
        module=runpy.run_path(str(SCRIPT.with_name('build_resources.py')))
        app=self.repo/'apps/macos';vendor=self.repo/'prototypes/macos-research/vendor'
        for name in ['marked.esm.js','lucide.min.js','MARKED-LICENSE.md','LUCIDE-LICENSE']:write(vendor/name,b'Explicit synthetic staging fixture '+name.encode())
        write(app/'node_modules/katex/dist/katex.min.js',self.fixed['Web/vendor/katex/katex.min.js']);write(app/'node_modules/katex/LICENSE',self.fixed['Web/vendor/katex/LICENSE'])
        qa=self.root/'unsigned-first.app/Contents/Resources';qa.mkdir(parents=True);formal=self.root/'unsigned-next.app/Contents/Resources';formal.mkdir(parents=True)
        module['stage'](self.repo,app,qa,'private-qa','v24.19.0');before={p.relative_to(qa).as_posix():sha(p.read_bytes())for p in qa.rglob('*')if p.is_file()}
        with self.assertRaises(ValueError):module['stage'](self.repo,app,qa,'release','v24.19.0')
        module['stage'](self.repo,app,formal,'release','v24.19.0');self.assertFalse((formal/'Seed').exists());self.assertTrue(module['assert_no_scientific_seed'](formal,self.repo));self.assertEqual(before,{p.relative_to(qa).as_posix():sha(p.read_bytes())for p in qa.rglob('*')if p.is_file()});self.assertTrue((qa/'Seed/assets/fixture.pdf').is_file())

    def reseal_outer_fixture(self):
        manifest=self.output/'release-manifest.json';m=json.loads(manifest.read_bytes())
        for name in m['assets']:
            p=self.output/name;m['assets'][name]={'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())}
        save(manifest,m);(self.output/'SHA256SUMS').write_text(''.join(sha(p.read_bytes())+'  '+p.name+'\n'for p in sorted(self.output.iterdir())if p.is_file()and p.name!='SHA256SUMS'))

    def test_55_outer_qa_channel_cannot_be_laundered_to_formal_by_resealing_checksums(self):
        self.prepare();p=self.output/'build-info.json';m=json.loads(p.read_bytes());m['distributionChannel']='release';save(p,m);self.reseal_outer_fixture();self.assertIn('通道',self.call('verify',expected=1))

    def test_56_outer_source_version_cannot_override_signed_application_identity(self):
        self.make_formal();self.prepare();p=self.output/'build-info.json';m=json.loads(p.read_bytes());m['version']='2.0.0';save(p,m);self.reseal_outer_fixture();self.call('verify',expected=1)

    def test_57_node_version_probe_never_inherits_user_node_options(self):
        env=dict(os.environ,NODE_OPTIONS='--require /explicit-synthetic-nonexistent-should-not-execute')
        self.assertEqual('private-qa',self.call(env=env)['distributionChannel'])

    def test_58_case_parameters_and_percent_encoded_data_urls_cannot_embed_scientific_figure(self):
        self.make_formal();data=self.fixed['Seed/assets/fixture.png'];plain=base64.b64encode(data).decode();escaped=''.join('%'+format(v,'02X')for v in plain.encode())
        variants=['DATA:image/png;BASE64,'+plain,'data:image/png;charset=UTF-8; base64,'+plain,'data:application/octet-stream;BASE64,'+escaped]
        for i,uri in enumerate(variants):
            self.add_formal_resource('case-'+str(i)+'.css',('body{background:url("'+uri+'")}').encode());self.assertIn('原图',self.call(expected=1))
            # Clear only the fixture's injected preceding case, preserving the original app/source files.
            file='case-'+str(i)+'.css';(self.app/('Contents/Resources/Web/'+file)).unlink();(self.repo/('apps/macos/Resources/'+file)).unlink();success(['git','add','.'],self.repo);success(['git','commit','-qm','Remove explicit case negative fixture'],self.repo);commit=success(['git','rev-parse','HEAD'],self.repo).decode().strip();self.change_metadata(lambda m:(m.update(sourceCommit=commit),m.update(files=[x for x in m['files']if x['path']!='Web/'+file])))


    def test_59_non_base64_percent_encoded_data_url_cannot_embed_scientific_figure(self):
        from urllib.parse import quote_from_bytes
        self.make_formal();data=self.fixed['Seed/assets/fixture.png']
        encoded=quote_from_bytes(data,safe='')
        self.add_formal_resource('raw-data-uri.css',('body{background:url("DATA:image/png;charset=UTF-8,'+encoded+'")}').encode())
        self.assertIn('原图',self.call(expected=1))


class VerifyDmgCleanup(unittest.TestCase):
    """Current public verify_dmg control flow; only ordinary simulated files and tools.

    Run independently with: python3 apps/macos/Tests/ReleasePackaging.test.py VerifyDmgCleanup
    This class never constructs Packaging's signed-app template or calls a real hdiutil.
    """
    def setUp(self):
        import ast, types
        if os.environ.get('CODEX_SANDBOX'):
            raise RuntimeError('请在本机正常开发环境执行测试')
        self.temp=tempfile.TemporaryDirectory(prefix='paperdigest-dmg-cleanup-unit-')
        self.root=pathlib.Path(self.temp.name)
        self.image=self.root/'candidate.dmg'
        self.image.write_bytes(b'Explicit simulated image, never passed to a real tool')
        self.state={'active':False,'mount':None,'temporary':None,'calls':[],
                    'recursiveCleanup':False,'payload':None,'auditCalls':0,'rmdirAttempts':[],
                    'detachAttempts':0,'afterBusy':False,'sleeps':[]}
        self.ast=ast;self.types=types

    def tearDown(self):
        # A retained simulated mount is only normal owned fixture files. Always clean
        # this sandbox too; never leave fault fixtures under .qa or touch a real volume.
        root=self.root
        self.temp.cleanup()
        self.assertFalse(root.exists())

    def exercise(self,attach_error=False,detach_error=False,body_error=False,
                 foreign=False,detach_lies=False,info_error=False,notmounted=False,
                 busy=0,nonbusy=False,ownership_flips=False,unmounted_after_busy=False):
        from unittest import mock
        import re
        state=self.state
        def make(prefix):
            path=pathlib.Path(tempfile.mkdtemp(prefix=prefix,dir=self.root))
            state['temporary']=path
            return str(path)
        def recursive_cleanup_forbidden(*args,**kwargs):
            state['recursiveCleanup']=True
            raise AssertionError('verify_dmg must not recursively clean a mount')
        # Load only these current public definitions. No ignored before-file,
        # copied verifier body, tool module import, or legacy control is used.
        nodes=[node for node in self.ast.parse(HELPER.read_text()).body
               if isinstance(node,(self.ast.FunctionDef,self.ast.ClassDef))
               and node.name in ('Rejected','require','verify_dmg')]
        self.assertEqual({node.name for node in nodes},{'Rejected','require','verify_dmg'})
        env={'pathlib':pathlib,'plistlib':plistlib,
             'tempfile':self.types.SimpleNamespace(mkdtemp=make,TemporaryDirectory=recursive_cleanup_forbidden),
             'shutil':self.types.SimpleNamespace(rmtree=recursive_cleanup_forbidden),
             're':re,'sys':sys}
        exec(compile(self.ast.Module(body=nodes,type_ignores=[]),str(HELPER),'exec'),env)
        rejected=env['Rejected']
        original=rejected('ATTACH_ORIGINAL') if attach_error else rejected('BODY_ORIGINAL')
        detach=rejected('DETACH_BUSY_ORIGINAL');information=rejected('INFO_ORIGINAL')
        def run(args):
            self.assertEqual(args[0],'/usr/bin/hdiutil')
            action=args[1];state['calls'].append(action)
            if action=='verify':return b''
            if action=='attach':
                mount=pathlib.Path(args[args.index('-mountpoint')+1])
                state['mount']=mount;state['active']=not notmounted
                payload=mount/'Fixture.app/Contents/_CodeSignature/CodeResources'
                payload.parent.mkdir(parents=True);payload.write_text('Owned simulated payload')
                state['payload']=payload
                (mount/'Applications').symlink_to('/Applications')
                if attach_error:raise original
                return b''
            if action=='info':
                if info_error:raise information
                image=self.root/'FOREIGN.dmg' if foreign or (ownership_flips and state['afterBusy']) else self.image
                return plistlib.dumps({'images':[{'image-path':str(image),
                    'system-entities':[{'mount-point':str(state['mount']),'dev-entry':'/dev/QA-SIMULATED'}]}]})
            if action=='detach':
                self.assertEqual(pathlib.Path(args[2]),state['mount'])
                self.assertEqual(state['calls'][-2],'info','Fresh ownership required before each detach')
                self.assertNotIn('-force',args)
                state['detachAttempts']+=1
                if state['detachAttempts']<=busy:
                    state['afterBusy']=True
                    if unmounted_after_busy:
                        state['active']=False
                        shutil.rmtree(state['mount']/'Fixture.app');(state['mount']/'Applications').unlink()
                    raise rejected('hdiutil: could not unmount test device - Resource busy')
                if nonbusy:raise rejected('hdiutil: Permission denied')
                if detach_error:raise detach
                if detach_lies:return b''
                state['active']=False
                # This fake unmount removes only known ordinary simulated payloads,
                # exposing the original empty directory. No real mount is involved.
                shutil.rmtree(state['mount']/'Fixture.app')
                (state['mount']/'Applications').unlink()
                return b''
            raise AssertionError('Unexpected simulated tool operation')
        def audit(*args):
            state['auditCalls']+=1
            if body_error:raise original
            return {'bundleInventorySHA256':'exact'}
        env.update(run=run,audit_app=audit,
                   os=self.types.SimpleNamespace(path=self.types.SimpleNamespace(
                       ismount=lambda path:state['active'] and pathlib.Path(path)==state['mount'],
                       realpath=os.path.realpath),readlink=os.readlink))
        real_rmdir=pathlib.Path.rmdir
        def observe_rmdir(path):
            self.assertIn(path,(state['mount'],state['temporary']))
            state['rmdirAttempts'].append((path,state['active'],not any(path.iterdir())))
            return real_rmdir(path)
        error=None
        with mock.patch.object(pathlib.Path,'rmdir',observe_rmdir), mock.patch('time.sleep',side_effect=state['sleeps'].append):
            try:
                env['verify_dmg'](self.image,self.root,{'bundleName':'Fixture.app','record':{},
                    'version':'1','bundleInventorySHA256':'exact'})
            except BaseException as caught:
                error=caught
        self.assertFalse(state['recursiveCleanup'])
        self.assertEqual(state['calls'].count('attach'),1)
        self.assertTrue(all(seconds==0.25 for seconds in state['sleeps']))
        self.assertLessEqual(sum(state['sleeps']),0.5)
        self.assertTrue(all(not active for _,active,_ in state['rmdirAttempts']))
        if state['active']:
            self.assertEqual(state['payload'].read_text(),'Owned simulated payload')
            self.assertTrue(state['mount'].parent.exists())
            self.assertEqual(state['rmdirAttempts'],[])
        return error,original,detach,information,rejected

    def assert_empty_removed(self):
        self.assertFalse(self.state['active'])
        self.assertFalse(self.state['mount'].parent.exists())
        self.assertEqual([(active,empty)for _,active,empty in self.state['rmdirAttempts']],[(False,True),(False,True)])

    def test_success_detaches_then_removes_only_empty_owned_directories(self):
        error,*_=self.exercise()
        self.assertIsNone(error);self.assertEqual(self.state['auditCalls'],1)
        self.assertIn('detach',self.state['calls']);self.assert_empty_removed()

    def test_partial_attach_preserves_original_and_detaches_owned_mount(self):
        error,original,*_=self.exercise(attach_error=True)
        self.assertIs(error,original);self.assertEqual(self.state['auditCalls'],0)
        self.assertIn('detach',self.state['calls']);self.assert_empty_removed()

    def test_body_failure_preserves_original_and_detaches(self):
        error,original,*_=self.exercise(body_error=True)
        self.assertIs(error,original);self.assertEqual(self.state['auditCalls'],1)
        self.assertIn('detach',self.state['calls']);self.assert_empty_removed()

    def test_detach_failure_retains_payload_and_exact_detach_error(self):
        error,_,detach,*_=self.exercise(detach_error=True)
        self.assertIs(error,detach);self.assertTrue(self.state['active'])

    def test_body_and_detach_failures_keep_both_messages_and_original_cause(self):
        error,original,_,_,rejected=self.exercise(body_error=True,detach_error=True)
        self.assertIsInstance(error,rejected);self.assertIs(error.__cause__,original)
        self.assertIn('BODY_ORIGINAL',str(error));self.assertIn('DETACH_BUSY_ORIGINAL',str(error))

    def test_attach_and_detach_failures_keep_both_messages_and_original_cause(self):
        error,original,_,_,rejected=self.exercise(attach_error=True,detach_error=True)
        self.assertIsInstance(error,rejected);self.assertIs(error.__cause__,original)
        self.assertIn('ATTACH_ORIGINAL',str(error));self.assertIn('DETACH_BUSY_ORIGINAL',str(error))

    def test_partial_attach_foreign_owner_is_never_audited_or_detached(self):
        error,original,_,_,rejected=self.exercise(attach_error=True,foreign=True)
        self.assertIsInstance(error,rejected);self.assertIs(error.__cause__,original)
        self.assertIn('归属未确认',str(error));self.assertEqual(self.state['auditCalls'],0)
        self.assertNotIn('detach',self.state['calls']);self.assertTrue(self.state['active'])

    def test_successful_detach_exit_with_live_mount_is_rejected(self):
        error,_,_,_,rejected=self.exercise(detach_lies=True)
        self.assertIsInstance(error,rejected);self.assertIn('未释放',str(error))
        self.assertTrue(self.state['active'])

    def test_info_failure_keeps_original_attach_cause_and_mounted_evidence(self):
        error,original,_,_,rejected=self.exercise(attach_error=True,info_error=True)
        self.assertIsInstance(error,rejected);self.assertIs(error.__cause__,original)
        self.assertIn('ATTACH_ORIGINAL',str(error));self.assertIn('INFO_ORIGINAL',str(error))
        self.assertNotIn('detach',self.state['calls']);self.assertTrue(self.state['active'])

    def test_attach_exit_zero_without_mount_never_audits_or_detaches_or_removes_payload(self):
        error,_,_,_,rejected=self.exercise(notmounted=True)
        self.assertIsInstance(error,rejected);self.assertIn('实际挂载未确认',str(error))
        self.assertEqual(self.state['auditCalls'],0);self.assertNotIn('detach',self.state['calls'])
        self.assertEqual(self.state['payload'].read_text(),'Owned simulated payload')
        self.assertEqual([(active,empty)for _,active,empty in self.state['rmdirAttempts']],[(False,False)])

    def test_attach_exit_zero_foreign_owner_never_audits_or_detaches(self):
        error,_,_,_,rejected=self.exercise(foreign=True)
        self.assertIsInstance(error,rejected);self.assertIn('归属未确认',str(error))
        self.assertEqual(self.state['auditCalls'],0);self.assertNotIn('detach',self.state['calls'])
        self.assertTrue(self.state['active'])


    def test_two_busy_failures_recheck_owner_then_third_normal_detach_succeeds(self):
        error,*_=self.exercise(busy=2)
        self.assertIsNone(error);self.assertEqual(self.state['detachAttempts'],3)
        self.assertEqual(self.state['sleeps'],[0.25,0.25]);self.assert_empty_removed()

    def test_persistent_busy_stops_after_third_attempt_and_retains_evidence(self):
        error,_,_,_,rejected=self.exercise(busy=3)
        self.assertIsInstance(error,rejected);self.assertIn('Resource busy',str(error))
        self.assertEqual(self.state['detachAttempts'],3);self.assertTrue(self.state['active'])
        self.assertEqual(self.state['sleeps'],[0.25,0.25])

    def test_nonbusy_failure_is_not_retried(self):
        error,_,_,_,rejected=self.exercise(nonbusy=True)
        self.assertIsInstance(error,rejected);self.assertIn('Permission denied',str(error))
        self.assertEqual(self.state['detachAttempts'],1);self.assertEqual(self.state['sleeps'],[])
        self.assertTrue(self.state['active'])

    def test_owner_change_after_busy_prevents_any_second_detach(self):
        error,_,_,_,rejected=self.exercise(busy=1,ownership_flips=True)
        self.assertIsInstance(error,rejected);self.assertIn('归属未确认',str(error))
        self.assertEqual(self.state['detachAttempts'],1);self.assertEqual(self.state['sleeps'],[0.25])
        self.assertTrue(self.state['active'])

    def test_mount_already_gone_after_busy_is_not_detached_again(self):
        error,*_=self.exercise(busy=1,unmounted_after_busy=True)
        self.assertIsNone(error);self.assertEqual(self.state['detachAttempts'],1)
        self.assertEqual(self.state['sleeps'],[0.25]);self.assert_empty_removed()

if __name__=='__main__':unittest.main(verbosity=2)
