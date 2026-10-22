"""Mechanical same-render capture tests; no scientific/source qualification claims."""
import copy
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import daily_hugo_capture as capture


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


class CaptureTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='capture-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.workspace = self.root / 'workspace'
        self.workspace.mkdir()
        self.store = self.root / 'observations'
        self.layouts = self.repo / 'layouts'
        (self.layouts / '_default').mkdir(parents=True)
        self.base = self.layouts / '_default/baseof.html'
        self.base.write_text('<html><head><link rel="canonical" href="{{ .Permalink }}">'
                             '{{ range .OutputFormats }}<meta data-output="{{ .Name }}">{{ end }}'
                             '</head><body>{{ block "main" . }}{{ end }}</body></html>')
        (self.layouts / 'single.html').write_text('{{ define "main" }}<h1>{{ .Title }}</h1>{{ .Content }}{{ end }}')
        (self.layouts / 'home.html').write_text('{{ define "main" }}Home{{ end }}')
        (self.layouts / 'home.json').write_text('{{ dict "original" "json" | jsonify }}')
        (self.repo / 'hugo.toml').write_text('baseURL="https://example.invalid/base/"\n'
            'languageCode="zh-CN"\ndefaultContentLanguage="zh-cn"\n'
            '[outputs]\nhome=["HTML","RSS","JSON"]\npage=["HTML"]\n')
        self.sources = []
        for name, front, text in [('a.md', 'url: /special/custom/', 'Alpha'),
                                 ('b.md', 'slug: custom-slug', 'Beta'),
                                 ('中文.md', 'slug: 声音模型', '中文')]:
            page = self.repo / 'content' / 'posts' / name
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text('---\ntitle: Same title\ndate: 2026-01-02\n' + front + '\n---\n' + text)
            self.sources.append(page)
        self.files = [{'path': p.relative_to(self.repo).as_posix(), 'deleted': False,
                       'sha256': sha(p.read_bytes())} for p in self.sources]
        self.known = dict(generationManifestSha256='a' * 64, baseHead='b' * 40,
                          reviewProtocolFingerprint='c' * 64, runtimeFingerprint='d' * 64,
                          unknownInputs=['dynamic readFile / GitInfo / clock not fixed'])
        self.binding = dict(date='2026-10-23', publicationMode='llm_api_production',
            publicationScope=None, blogRoot=str(self.repo),
            generationManifestSha256='a' * 64, baseHead='b' * 40,
            reviewProtocolFingerprint='c' * 64, files=self.files,
            pages=[{'path': r['path'], 'sha256': r['sha256']} for r in self.files],
            layoutPlan=dict(status='supported', profile='single-theme-baseof-layoutdir-v1',
                            rootLayouts=str(self.layouts), effectiveBaseof=str(self.base), themeLayouts=[],
                            configPath=str(self.repo / 'hugo.toml'),
                            configSha256=sha((self.repo / 'hugo.toml').read_bytes())),
            sitePolicy=dict(origin='https://example.invalid', basePath='/base/'))
        self.final = {k: copy.deepcopy(self.binding[k]) for k in
            ('date', 'publicationMode', 'publicationScope', 'generationManifestSha256', 'baseHead',
             'reviewProtocolFingerprint', 'files')}
        self.final['reviewedAt'] = '2026-10-23T12:00:00+08:00'

    def scope(self, **extra):
        return capture.review_scope(binding=self.binding, known_input_reader=lambda: copy.deepcopy(self.known),
                                    observation_root=self.store, **extra)

    def build(self, session, *, run=True):
        patch = capture.prepare_workspace(session, workspace=self.workspace, source_files=tuple(self.sources))
        for name in ('static', 'resources', 'assets', 'cache'):
            (self.workspace / name).mkdir(exist_ok=True)
        overlay = self.workspace / 'overlay.json'
        overlay.write_text(json.dumps(dict(staticDir=str(self.workspace / 'static'),
             resourceDir=str(self.workspace / 'resources'), assetDir=str(self.workspace / 'assets'), **patch)))
        hugo = shutil.which('hugo')
        if not hugo:
            self.fail('real Hugo is required for this capture test')
        configs = (self.repo / 'hugo.toml', overlay)
        argv = (hugo, '--config', ','.join(map(str, configs)), '--contentDir', str(self.workspace / 'content'),
                '--destination', str(self.workspace / 'public'), '--cacheDir', str(self.workspace / 'cache'),
                '--cleanDestinationDir', '--noBuildLock')
        ticket = capture.pin_invocation(session, argv=argv, cwd=self.repo, config_files=configs,
                                        overlay=overlay, env_facts={})
        if run:
            env = {k: os.environ[k] for k in ('PATH', 'LANG') if k in os.environ}
            env.update(HOME=str(self.root), TMPDIR=str(self.root), GOPROXY='off', GOSUMDB='off',
                GOTOOLCHAIN='local', HUGO_MODULE_PROXY='off', HTTP_PROXY='http://127.0.0.1:9',
                HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9', NO_PROXY='',
                HUGO_SECURITY_HTTP_URLS='^$', HUGO_SECURITY_HTTP_METHODS='^$')
            result = subprocess.run(argv, cwd=self.repo, env=env, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
        return ticket

    def captured(self, session):
        ticket = self.build(session)
        capture.collect_actual_render(session, ticket, output_dir=self.workspace / 'public')

    def test_real_hugo_persist_and_cold_read_keep_same_raw_html(self):
        with self.scope() as session:
            self.assertIs(capture.current_session(), session)
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        self.assertIsNone(capture.current_session())
        value = capture.validate_ref(observation_root=self.store, ref=ref, expected=self.final)
        summary = capture.observation_summary(value)
        self.assertEqual(summary['status'], 'observation_available')
        self.assertEqual(summary['inputBinding'], 'observed_before_after')
        self.assertEqual(summary['fullInputSnapshot'], 'not_established')
        self.assertEqual(len(summary['pages']), 3)
        self.assertTrue(summary['coverage']['primaryHtml']['completeForDeclaredSourceSet'])
        for page in summary['pages']:
            raw = (self.store / ref['path']).parent.joinpath(page['html']['path']).read_bytes()
            self.assertEqual(sha(raw), page['html']['sha256'])
        self.assertEqual(summary['coverage']['currentEligibility'], 'not_checked')
        with self.assertRaises(capture.CaptureError):
            capture.persist_review_observation(session, final_binding=self.final)

    def test_unsupported_is_only_none_route(self):
        self.binding['layoutPlan'] = {'status': 'unsupported', 'reason': 'standalone layout'}
        with self.scope() as session:
            self.assertFalse(session.supported)
            self.assertIsNone(capture.persist_review_observation(session, final_binding=self.final))
        self.assertIsNone(capture.validate_ref(observation_root=self.store, ref=None, expected=self.final))
        self.assertEqual(capture.observation_summary(None), {'status': 'not_recorded'})

    def test_plain_and_cloned_sessions_cannot_be_used(self):
        with self.scope() as session:
            for fake in ({}, copy.copy(session), copy.deepcopy(session)):
                with self.assertRaises(capture.CaptureError):
                    capture.prepare_workspace(fake, workspace=self.workspace, source_files=tuple(self.sources))

    def test_cross_scope_use_rejected(self):
        with self.scope() as first:
            pass
        with self.scope():
            with self.assertRaises(capture.CaptureError):
                capture.prepare_workspace(first, workspace=self.workspace, source_files=tuple(self.sources))

    def test_source_changed_after_binding_blocks(self):
        with self.scope() as session:
            self.sources[0].write_text('changed')
            with self.assertRaises(capture.CaptureError):
                self.build(session, run=False)
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)

    def test_source_symlink_and_hardlink_rejected(self):
        for link in ('symlink', 'hardlink'):
            with self.subTest(link=link):
                original = self.sources[0].read_bytes()
                other = self.root / ('other-' + link)
                other.write_bytes(original)
                self.sources[0].unlink()
                if link == 'symlink':
                    self.sources[0].symlink_to(other)
                else:
                    os.link(other, self.sources[0])
                with self.assertRaises(capture.CaptureError):
                    with self.scope():
                        pass
                self.sources[0].unlink()
                self.sources[0].write_bytes(original)

    def test_final_file_or_owner_identity_drift_blocks(self):
        with self.scope() as session:
            self.captured(session)
            self.known['runtimeFingerprint'] = 'e' * 64
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)
        self.assertFalse(self.store.exists())

    def test_new_higher_priority_config_is_drift(self):
        with self.scope() as session:
            self.captured(session)
            (self.repo / 'hugo.yaml').write_text('baseURL: https://example.invalid/base/')
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)

    def test_layout_tree_new_member_is_drift(self):
        with self.scope() as session:
            self.captured(session)
            (self.layouts / 'new.html').write_text('new')
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)

    def test_wrong_actual_argv_or_overlay_blocks_before_hugo(self):
        with self.scope() as session:
            patch = capture.prepare_workspace(session, workspace=self.workspace, source_files=tuple(self.sources))
            overlay = self.workspace / 'overlay.json'
            overlay.write_text(json.dumps(patch))
            with self.assertRaises(capture.CaptureError):
                capture.pin_invocation(session, argv=('hugo', '--destination', '/wrong'), cwd=self.repo,
                                       config_files=(self.repo / 'hugo.toml', overlay), overlay=overlay, env_facts={})

    def test_supported_missing_map_cannot_fallback_to_none(self):
        with self.scope() as session:
            ticket = self.build(session)
            for record in (self.workspace / 'public').glob('__digest_observation_*/*.json'):
                record.unlink()
            with self.assertRaises(capture.CaptureError):
                capture.collect_actual_render(session, ticket, output_dir=self.workspace / 'public')
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)

    def test_missing_blob_corrupt_ref_and_binding_are_rejected(self):
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        bad = dict(ref, sha256='0' * 64)
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref=bad, expected=self.final)
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref={}, expected=self.final)
        wrong = copy.deepcopy(self.final)
        wrong['files'][0]['sha256'] = 'e' * 64
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref=ref, expected=wrong)
        manifest = json.loads((self.store / ref['path']).read_text())
        (self.store / ref['path']).parent.joinpath(manifest['pages'][0]['html']['path']).unlink()
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref=ref, expected=self.final)

    def test_storage_fsync_failure_never_returns_ref_and_session_fails(self):
        with self.scope() as session:
            self.captured(session)
            with mock.patch.object(capture.os, 'fsync', side_effect=OSError('injected fsync')):
                with self.assertRaises(capture.CaptureError):
                    capture.persist_review_observation(session, final_binding=self.final)
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)

    def test_site_origin_and_path_boundary_are_not_self_attested_by_map(self):
        for url in ('https://evil.invalid/base/x/', 'https://example.invalid/elsewhere/',
                    'https://example.invalid/base/%2e%2e/x/',
                    'https://example.invalid/base/%2fsecret/', 'https://user@example.invalid/base/x/'):
            with self.subTest(url=url):
                with self.assertRaises(capture.CaptureError):
                    capture.validate_site_url(url, self.binding['sitePolicy'])
        capture.validate_site_url('https://example.invalid/base/%E5%A3%B0%E9%9F%B3/', self.binding['sitePolicy'])

    def test_candidate_and_file_limits_are_enforced(self):
        limits = capture.CaptureLimits(file_bytes=16, html_bytes=16, total_bytes=128, max_files=2)
        with self.assertRaises(capture.CaptureError):
            with self.scope(limits=limits):
                pass

    def test_config_changed_between_profile_parsing_and_scope_is_not_a_new_baseline(self):
        (self.repo / 'hugo.toml').write_text('baseURL="https://other.invalid/"')
        with self.assertRaises(capture.CaptureError) as caught:
            with self.scope():
                pass
        self.assertEqual(caught.exception.code, 'stale')

    def test_old_theme_baseof_cannot_override_new_root_priority(self):
        theme = self.repo / 'themes' / 'One' / 'layouts'
        (theme / '_default').mkdir(parents=True)
        base = theme / '_default' / 'baseof.html'
        base.write_bytes(self.base.read_bytes())
        self.binding['layoutPlan'].update(themeLayouts=[str(theme)], effectiveBaseof=str(base))
        with self.assertRaises(capture.CaptureError) as caught:
            with self.scope():
                pass
        self.assertEqual(caught.exception.code, 'stale')

    def test_actual_copied_source_drift_is_detected_before_hugo(self):
        with self.scope() as session:
            capture.prepare_workspace(session, workspace=self.workspace, source_files=tuple(self.sources))
            (self.workspace / 'content' / 'posts' / 'a.md').write_text('changed copy')
            with self.assertRaises(capture.CaptureError):
                capture.pin_invocation(session, argv=(), cwd=self.repo, config_files=(),
                    overlay=self.workspace / 'overlay.json', env_facts={})

    def test_out_of_order_supported_adoption_poison_session(self):
        with self.scope() as session:
            capture.prepare_workspace(session, workspace=self.workspace, source_files=tuple(self.sources))
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)
            self.assertEqual(session._state, 'failed')

    def test_nested_scope_does_not_create_second_session(self):
        with self.scope() as session:
            with self.assertRaises(capture.CaptureError):
                with self.scope():
                    pass
            self.assertIs(capture.current_session(), session)

    def test_extra_source_cannot_enter_capture(self):
        extra = self.repo / 'content' / 'posts' / 'extra.md'
        extra.write_text('not a member')
        with self.scope() as session:
            with self.assertRaises(capture.CaptureError):
                capture.prepare_workspace(session, workspace=self.workspace,
                    source_files=tuple([*self.sources, extra]))

    def test_scope_cannot_declare_subset_of_reviewed_markdown_pages(self):
        self.binding['pages'].pop()
        with self.assertRaises(capture.CaptureError):
            with self.scope():
                pass

    def test_cold_record_cannot_remove_a_reviewed_page_and_claim_complete(self):
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        path = self.store / ref['path']
        manifest = json.loads(path.read_text())
        removed = manifest['pages'].pop()
        manifest['copiedSources'] = [r for r in manifest['copiedSources'] if r['path'] != removed['sourcePath']]
        manifest['coverage']['primaryHtml'].update(expectedCount=2, capturedCount=2)
        raw = capture._json_bytes(manifest) + b'\n'
        path.write_bytes(raw)
        changed_ref = dict(ref, sha256=sha(raw))
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref=changed_ref, expected=self.final)

    def test_cold_record_requires_known_input_shape_not_just_two_equal_objects(self):
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        path = self.store / ref['path']
        manifest = json.loads(path.read_text())
        manifest['knownInputsBefore'] = {}
        manifest['knownInputsAfter'] = {}
        raw = capture._json_bytes(manifest) + b'\n'
        path.write_bytes(raw)
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref=dict(ref, sha256=sha(raw)), expected=self.final)

    def test_cold_record_cannot_switch_to_another_whitelisted_publication_mode(self):
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        path = self.store / ref['path']
        manifest = json.loads(path.read_text())
        manifest['publicationMode'] = 'legacy_v5_maintenance'
        raw = capture._json_bytes(manifest) + b'\n'
        path.write_bytes(raw)
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref=dict(ref, sha256=sha(raw)), expected=self.final)

    def test_cold_nested_execution_copy_and_map_contracts_cannot_be_erased(self):
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        path = self.store / ref['path']
        original = json.loads(path.read_text())
        record_path = path.parent / original['pages'][0]['record']['path']
        original_record = record_path.read_bytes()
        for kind in ('render', 'copy_metadata', 'map', 'coverage_bool', 'known_after_bool', 'env_value'):
            with self.subTest(kind=kind):
                manifest = copy.deepcopy(original)
                record_path.write_bytes(original_record)
                if kind == 'render':
                    manifest['render'] = None
                elif kind == 'copy_metadata':
                    manifest['copiedSources'][0]['observedMetadata'] = None
                elif kind == 'coverage_bool':
                    manifest['coverage']['primaryHtml']['completeForDeclaredSourceSet'] = 1
                elif kind == 'known_after_bool':
                    manifest['knownInputsAfter']['layoutTrees'][0]['exists'] = 1
                elif kind == 'env_value':
                    manifest['render']['environmentFacts']['LANG'] = 42
                else:
                    record = json.loads(original_record)
                    record.update(kind='section', outputs=None)
                    record_raw = capture._json_bytes(record)
                    record_path.write_bytes(record_raw)
                    manifest['pages'][0]['record'].update(sha256=sha(record_raw), bytes=len(record_raw))
                raw = capture._json_bytes(manifest) + b'\n'
                path.write_bytes(raw)
                with self.assertRaises(capture.CaptureError):
                    capture.validate_ref(observation_root=self.store, ref=dict(ref, sha256=sha(raw)), expected=self.final)

    def test_profile_leaf_rejects_fifo_symlink_and_oversize_without_opening_them(self):
        target = self.root / 'profile'
        target.write_bytes(b'valid')
        self.assertEqual(capture.read_profile_file(target), b'valid')
        link = self.root / 'profile-link'
        link.symlink_to(target)
        with self.assertRaises(capture.CaptureError):
            capture.read_profile_file(link)
        fifo = self.root / 'profile-fifo'
        os.mkfifo(fifo)
        with self.assertRaises(capture.CaptureError):
            capture.read_profile_file(fifo)
        with self.assertRaises(capture.CaptureError):
            capture.read_profile_file(target, limits=capture.CaptureLimits(file_bytes=4))

    def test_cold_actual_output_paths_are_safe_html_and_unique(self):
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        path = self.store / ref['path']
        original = json.loads(path.read_text())
        for value in ('../escape.html', None, 'page.json', original['pages'][1]['html']['actualOutputPath']):
            with self.subTest(value=value):
                manifest = copy.deepcopy(original)
                manifest['pages'][0]['html']['actualOutputPath'] = value
                raw = capture._json_bytes(manifest) + b'\n'
                path.write_bytes(raw)
                with self.assertRaises(capture.CaptureError):
                    capture.validate_ref(observation_root=self.store, ref=dict(ref, sha256=sha(raw)), expected=self.final)

    def test_cold_unknown_disclosure_cannot_be_erased(self):
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        path = self.store / ref['path']
        original = json.loads(path.read_text())
        for disclosure in ([], original['unknownInputs'][1:]):
            with self.subTest(disclosure=disclosure):
                manifest = copy.deepcopy(original)
                manifest['unknownInputs'] = disclosure
                raw = capture._json_bytes(manifest) + b'\n'
                path.write_bytes(raw)
                with self.assertRaises(capture.CaptureError):
                    capture.validate_ref(observation_root=self.store, ref=dict(ref, sha256=sha(raw)), expected=self.final)

    def test_low_aggregate_limit_blocks_before_excessive_temp_writes(self):
        limit = capture.CaptureLimits(total_bytes=66)
        with self.assertRaises(capture.CaptureError):
            with self.scope(limits=limit) as session:
                capture.prepare_workspace(session, workspace=self.workspace, source_files=tuple(self.sources))
        self.assertEqual([p for p in self.workspace.rglob('*') if p.is_file()], [])

    def test_layout_and_helper_budget_is_reserved_before_writing(self):
        limit_bytes = sum(len(p.read_bytes()) for p in self.repo.rglob('*') if p.is_file())
        with self.assertRaises(capture.CaptureError):
            with self.scope(limits=capture.CaptureLimits(total_bytes=limit_bytes)) as session:
                capture.prepare_workspace(session, workspace=self.workspace, source_files=tuple(self.sources))
        written = sum(p.stat().st_size for p in self.workspace.rglob('*') if p.is_file())
        self.assertLessEqual(written, limit_bytes)

    def test_declared_tree_inventory_enforces_aggregate_bytes(self):
        with self.assertRaises(capture.CaptureError):
            capture._inventory(self.layouts, capture.CaptureLimits(total_bytes=16))

    def test_cold_file_count_includes_manifest_and_both_blobs_per_page(self):
        page = self.repo / 'content' / 'posts' / 'fourth.md'
        page.write_text('---\ntitle: Fourth\ndate: 2026-01-02\n---\nFourth body')
        self.sources.append(page)
        row = {'path': 'content/posts/fourth.md', 'sha256': sha(page.read_bytes()), 'deleted': False}
        self.binding['files'].append(row)
        self.binding['pages'].append({'path': row['path'], 'sha256': row['sha256']})
        self.final['files'] = copy.deepcopy(self.binding['files'])
        with self.scope() as session:
            self.captured(session)
            ref = capture.persist_review_observation(session, final_binding=self.final)
        with self.assertRaises(capture.CaptureError):
            capture.validate_ref(observation_root=self.store, ref=ref, expected=self.final,
                                 limits=capture.CaptureLimits(max_files=8))

    def test_storage_parent_symlink_and_blob_link_rejected(self):
        with self.scope() as session:
            self.captured(session)
            target = self.root / 'elsewhere'
            target.mkdir()
            self.store.symlink_to(target, target_is_directory=True)
            with self.assertRaises(capture.CaptureError):
                capture.persist_review_observation(session, final_binding=self.final)
        self.assertEqual(list(target.iterdir()), [])

    def test_duplicate_actual_canonical_is_ambiguous(self):
        with self.scope() as session:
            ticket = self.build(session)
            output = self.workspace / 'public'
            page = next(p for p in output.rglob('*.html') if 'Alpha' in p.read_text())
            (output / 'duplicate.html').write_bytes(page.read_bytes())
            with self.assertRaises(capture.CaptureError):
                capture.collect_actual_render(session, ticket, output_dir=output)

    def test_observation_preserves_all_original_outputs_and_root_bytes(self):
        original = {p.relative_to(self.repo).as_posix(): p.read_bytes()
                    for p in self.repo.rglob('*') if p.is_file()}
        with self.scope() as session:
            ticket = self.build(session)
            mapped = {p.relative_to(self.workspace / 'public').as_posix(): p.read_bytes()
                      for p in (self.workspace / 'public').rglob('*') if p.is_file()
                      and not p.relative_to(self.workspace / 'public').as_posix().startswith('__digest_observation_')}
            argv = list(session._invocation['argv'])
            overlay = self.workspace / 'baseline.json'
            actual_overlay = json.loads((self.workspace / 'overlay.json').read_text())
            actual_overlay.pop('layoutDir')
            overlay.write_text(json.dumps(actual_overlay))
            argv[2] = str(self.repo / 'hugo.toml') + ',' + str(overlay)
            argv[argv.index('--destination') + 1] = str(self.workspace / 'baseline-public')
            env = {k: os.environ[k] for k in ('PATH', 'LANG') if k in os.environ}
            env.update(HOME=str(self.root), GOPROXY='off', GOSUMDB='off', GOTOOLCHAIN='local',
                HUGO_MODULE_PROXY='off', HTTP_PROXY='http://127.0.0.1:9',
                HTTPS_PROXY='http://127.0.0.1:9', ALL_PROXY='http://127.0.0.1:9',
                HUGO_SECURITY_HTTP_URLS='^$', HUGO_SECURITY_HTTP_METHODS='^$')
            result = subprocess.run(argv, cwd=self.repo, env=env, capture_output=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout.decode() + result.stderr.decode())
            baseline = {p.relative_to(self.workspace / 'baseline-public').as_posix(): p.read_bytes()
                        for p in (self.workspace / 'baseline-public').rglob('*') if p.is_file()}
            self.assertEqual(mapped, baseline)
            self.assertIn('index.json', baseline)
            self.assertIn('index.xml', baseline)
            capture.collect_actual_render(session, ticket, output_dir=self.workspace / 'public')
        current = {p.relative_to(self.repo).as_posix(): p.read_bytes()
                   for p in self.repo.rglob('*') if p.is_file()}
        self.assertEqual(original, current)


if __name__ == '__main__':
    unittest.main()
