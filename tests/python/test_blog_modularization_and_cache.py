"""`publish-to-blog.py` 子模块解耦（Git 发布 + 审查取图）与有界确定性序列化缓存单元测试。"""

from __future__ import annotations

import ast
import concurrent.futures
import copy
import hashlib
import importlib.util
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
TESTS_PY = Path(__file__).resolve().parent
for _p in (str(SCRIPTS), str(TESTS_PY)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import blog_git_publication  # noqa: E402
import blog_review_image_loader  # noqa: E402
import protocol_codec as public_protocols  # noqa: E402
from project_env_isolation import isolate_module_environment, project_env_scope  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()

_SPEC = importlib.util.spec_from_file_location(
    'publish_to_blog_mod_cache_test', SCRIPTS / 'publish-to-blog.py',
)
publish_to_blog = importlib.util.module_from_spec(_SPEC)
with project_env_scope():
    _SPEC.loader.exec_module(publish_to_blog)


def _valid_png_bytes() -> bytes:
    from PIL import Image
    buf = io.BytesIO()
    Image.new('RGB', (4, 4), (255, 255, 255)).save(buf, format='PNG')
    return buf.getvalue()


def _sample_paper_and_plan() -> tuple[dict, dict]:
    catalog = publish_to_blog._PAGE_TAG_CATALOG
    active = [item for item in catalog['concepts'] if item.get('status') == 'active']
    task_node = next(item for item in active if item['facet'] == 'task')
    method_node = next(item for item in active if item['facet'] == 'method')
    other_node = next(
        item for item in active
        if item['id'] not in {task_node['id'], method_node['id']}
    )
    tags = [
        '#' + task_node['preferredLabel']['zh'],
        '#' + method_node['preferredLabel']['zh'],
        '#' + other_node['preferredLabel']['zh'],
    ]
    concept_ids = [task_node['id'], method_node['id'], other_node['id']]
    selection_header = public_protocols.record_header(
        publish_to_blog.TAG_SELECTION_CONTRACT, 'paper-tag-selection',
    )
    tag_validation = {
        **selection_header,
        'valid': True,
        'registryVersion': publish_to_blog.tag_catalog_identity(catalog),
        'registrySha256': catalog['registrySha256'],
        'primaryTaskId': task_node['id'],
        'primaryMethodId': method_node['id'],
        'conceptIds': concept_ids,
    }
    parsed = {
        'score': 8.5,
        'primaryTaskTag': tags[0],
        'primaryMethodTag': tags[1],
        'tags': tags,
        'tagValidation': tag_validation,
        'rankBucket': 'top',
        'documentType': 'empirical',
    }
    paper = {
        'arxivId': '2611.12345v1',
        'title': 'Deterministic Audio Token Modeling',
        'abstract': 'We study deterministic audio token modeling under strict replay.',
        'authors': [
            {'name': 'Alice Zhang', 'affiliations': ['Audio Lab']},
            {'name': 'Bob Li', 'affiliations': ['Speech Institute']},
        ],
        'parsed': parsed,
    }
    reader_plan = {
        'readerTitle': '确定性音频离散表征建模导读',
        'oneSentenceThesis': '本文提出在严格重放约束下的确定性音频离散表征建模方法。',
    }
    return paper, reader_plan


class BlogModularizationAndCacheTests(unittest.TestCase):
    def setUp(self):
        publish_to_blog._TAG_CATALOG_SERIALIZATION_CACHE.clear()
        publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE.clear()
        publish_to_blog._WORKBENCH_SIDECAR_RECORDS_CACHE.clear()

    def test_extracted_modules_reject_codex_sandbox_and_direct_cli_execution(self):
        sandbox_env = dict(os.environ, CODEX_SANDBOX='test-seatbelt')
        clean_env = {k: v for k, v in os.environ.items() if k != 'CODEX_SANDBOX'}
        for module_name in ('blog_git_publication.py', 'blog_review_image_loader.py'):
            script_path = SCRIPTS / module_name
            for extra_args in ([], ['-S']):
                with self.subTest(module=module_name, args=extra_args):
                    res = subprocess.run(
                        [sys.executable, *extra_args, str(script_path)],
                        cwd=ROOT,
                        env=sandbox_env,
                        capture_output=True,
                        text=True,
                        timeout=5,
                    )
                    output = res.stdout + res.stderr
                    self.assertNotEqual(res.returncode, 0)
                    self.assertIn('必须在沙箱外运行', output)
                    self.assertNotIn('ModuleNotFoundError', output)

            with self.subTest(module=module_name, mode='external_direct_cli'):
                res_ext = subprocess.run(
                    [sys.executable, str(script_path)],
                    cwd=ROOT,
                    env=clean_env,
                    capture_output=True,
                    text=True,
                    timeout=5,
                )
                self.assertNotEqual(res_ext.returncode, 0)
                self.assertIn('not a direct CLI', res_ext.stdout + res_ext.stderr)

    def test_pure_library_import_under_sandbox_env_does_not_trigger_entry_guard(self):
        sandbox_env = dict(os.environ, CODEX_SANDBOX='test-seatbelt')
        code = (
            f'import sys; sys.path.insert(0, {str(SCRIPTS)!r}); '
            'import blog_git_publication as bgp; '
            'import blog_review_image_loader as bril; '
            'from urllib.parse import urlparse; '
            'assert bril.pinned_https_url(urlparse("https://example.org/a.png"), "93.184.216.34") '
            '== "https://93.184.216.34/a.png"; '
            'assert callable(bgp.validate_git_commit_against_review_receipt); '
            'print("import-ok")'
        )
        res = subprocess.run(
            [sys.executable, '-c', code],
            cwd=ROOT,
            env=sandbox_env,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(res.stdout.strip(), 'import-ok')

    def test_git_publication_reexports_and_monkeypatch_compatibility(self):
        calls = []

        def fake_run_git(args, *, text=False, check=False, timeout_kind='local'):
            calls.append((tuple(args), text, check, timeout_kind))
            if args[:2] == ['ls-remote', '--exit-code']:
                return SimpleNamespace(
                    returncode=0, timed_out=False,
                    stdout='a' * 40 + '\trefs/heads/main\n', stderr='',
                )
            if args[:3] == ['remote', 'get-url', '--push']:
                return SimpleNamespace(
                    returncode=0, timed_out=False,
                    stdout='https://github.com/example/blog.git\n', stderr='',
                )
            if args[:3] == ['diff', '--cached', '--name-only']:
                return SimpleNamespace(
                    returncode=0, timed_out=False,
                    stdout=b'content/posts/2026-11-18.md\x00content/posts/unrelated.md\x00',
                    stderr=b'',
                )
            raise AssertionError(f'unexpected git args: {args}')

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp).resolve()
            (repo / 'content' / 'posts').mkdir(parents=True)
            post = repo / 'content' / 'posts' / '2026-11-18.md'
            post.write_text('body\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'custom-remote'), \
                    mock.patch.object(publish_to_blog, '_run_git', side_effect=fake_run_git):
                oid, err = publish_to_blog._remote_main_oid()
                self.assertEqual((oid, err), ('a' * 40, ''))
                ident, ident_err = publish_to_blog._remote_identity_sha256()
                self.assertEqual(ident_err, '')
                self.assertRegex(ident, r'^[0-9a-f]{64}$')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, r'无关 staged 文件.*unrelated\.md',
                ):
                    publish_to_blog.validate_git_index([post])

        self.assertEqual(calls[0][0], ('ls-remote', '--exit-code', 'custom-remote', 'refs/heads/main'))
        self.assertEqual(calls[1][0], ('remote', 'get-url', '--push', 'custom-remote'))

    def test_review_image_loader_reexports_and_monkeypatch_compatibility(self):
        png = _valid_png_bytes()

        def fake_getaddrinfo(_host, _port, *_args, **_kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('198.18.0.9', 0))]

        with mock.patch.dict(os.environ, {'HTTPS_PROXY': 'http://127.0.0.1:7897'}, clear=False), \
                mock.patch.object(publish_to_blog.socket, 'getaddrinfo', side_effect=fake_getaddrinfo):
            self.assertEqual(
                publish_to_blog._validate_public_image_url('https://example.org/fig.png'),
                {'198.18.0.9'},
            )

        policy_err = publish_to_blog.PublicNetworkPolicyError(
            'synthetic schema fault', 'PUBLIC_NETWORK_POLICY_SCHEMA',
        )
        with mock.patch.object(publish_to_blog, 'is_globally_routable_ip', side_effect=policy_err):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '公网安全策略异常'):
                publish_to_blog._validate_public_image_url('https://8.8.8.8/fig.png')

        with mock.patch.object(
            publish_to_blog, '_load_review_image_from_local_repo', return_value=None,
        ), mock.patch.object(
            publish_to_blog, '_download_review_image',
            return_value={'media_type': 'image/png', 'data': 'patched-ok'},
        ) as mocked_download:
            result = publish_to_blog._load_review_image('https://example.org/fig.png')
            self.assertEqual(result, {'media_type': 'image/png', 'data': 'patched-ok'})
            mocked_download.assert_called_once_with('https://example.org/fig.png')

        svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'
        pinned_resp = {
            'status': 200, 'location': None, 'media_type': 'image/svg+xml',
            'raw': svg, 'pinned_address': '93.184.216.34',
        }
        with mock.patch.object(publish_to_blog, 'get_required_fetch_proxy', return_value='http://127.0.0.1:7897'), \
                mock.patch.object(publish_to_blog, '_resolve_proxy_addresses', return_value={'127.0.0.1'}), \
                mock.patch.object(publish_to_blog, '_validate_public_image_url', return_value={'93.184.216.34'}), \
                mock.patch.object(publish_to_blog, '_read_pinned_review_image', return_value=pinned_resp), \
                mock.patch.object(publish_to_blog, '_rasterize_svg_for_review', return_value=png) as mocked_svg:
            downloaded = publish_to_blog._download_review_image('https://example.org/fig.svg')
            self.assertEqual(downloaded['media_type'], 'image/png')
            mocked_svg.assert_called_once_with(svg)

    def test_closure_includes_extracted_modules_while_generation_template_fingerprint_decouples(self):
        publish_to_blog._REVIEW_IMPLEMENTATION_CLOSURE_CACHE.clear()
        closure = set(publish_to_blog.review_implementation_closure())
        self.assertIn('scripts/blog_git_publication.py', closure)
        self.assertIn('scripts/blog_review_image_loader.py', closure)
        self.assertIn('scripts/public_network_policy.py', closure)
        self.assertIn('config/public-network-policy.json', closure)

        real_sha = publish_to_blog._sha256_file
        before_gen = publish_to_blog.generation_template_fingerprint()
        extracted_targets = {
            (SCRIPTS / 'blog_git_publication.py').resolve(),
            (SCRIPTS / 'blog_review_image_loader.py').resolve(),
        }
        with mock.patch.object(
            publish_to_blog, '_sha256_file',
            side_effect=lambda p: 'f' * 64 if Path(p).resolve() in extracted_targets else real_sha(p),
        ):
            self.assertEqual(publish_to_blog.generation_template_fingerprint(), before_gen)

    def test_tag_catalog_cache_deepcopy_isolation_and_single_byte_disk_tamper_detection(self):
        raw_catalog_bytes = (ROOT / 'config' / 'tag-catalog.json').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            isolated_catalog = root / 'tag-catalog.json'
            isolated_catalog.write_bytes(raw_catalog_bytes)
            isolated_history = root / 'tag-catalog-history'
            isolated_history.mkdir()
            isolated_policy = root / 'tag-display-policy.json'
            blog_repo = root / 'blog'
            blog_repo.mkdir()

            with mock.patch.object(publish_to_blog, 'TAG_CATALOG_PATH', isolated_catalog), \
                    mock.patch.object(publish_to_blog, 'TAG_CATALOG_HISTORY_DIR', isolated_history), \
                    mock.patch.object(publish_to_blog, 'TAG_DISPLAY_POLICY_PATH', isolated_policy):
                first = publish_to_blog.tag_catalog_file_contents(blog_repo)
                self.assertEqual(len(publish_to_blog._TAG_CATALOG_SERIALIZATION_CACHE), 1)
                snapshot_before = copy.deepcopy(first)

                # Mutating returned dictionary must never corrupt cached entries.
                first['data/tag-catalog-snapshot.json'] = b'tampered-in-memory'
                first['injected.json'] = b'bad'

                with mock.patch.object(
                    publish_to_blog, 'build_tag_catalog_snapshot',
                    side_effect=AssertionError('cache hit must not rebuild snapshot'),
                ):
                    second = publish_to_blog.tag_catalog_file_contents(blog_repo)
                self.assertEqual(second, snapshot_before)

                # Exporting files to blog_repo changes repo disk state -> immediate cache miss, same deterministic bytes.
                for rel, raw in second.items():
                    target = blog_repo / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(raw)
                third = publish_to_blog.tag_catalog_file_contents(blog_repo)
                self.assertEqual(third, snapshot_before)
                self.assertEqual(len(publish_to_blog._TAG_CATALOG_SERIALIZATION_CACHE), 2)

                # Changing 1 byte in disk tag-catalog.json (valid definition edit) -> immediate O_NOFOLLOW miss & recompute!
                parsed_cat = json.loads(raw_catalog_bytes.decode('utf-8'))
                parsed_cat['concepts'][0]['definition'] += '!'
                modified_bytes = (json.dumps(parsed_cat, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                isolated_catalog.write_bytes(modified_bytes)
                recomputed = publish_to_blog.tag_catalog_file_contents(blog_repo)
                self.assertNotEqual(
                    recomputed['data/tag-catalog-snapshot.json'],
                    snapshot_before['data/tag-catalog-snapshot.json'],
                )

                # Corrupting 1 byte in disk tag-catalog.json -> immediate O_NOFOLLOW miss & validation block!
                isolated_catalog.write_bytes(b'{' + raw_catalog_bytes[1:40])
                with self.assertRaises(publish_to_blog.PublishDataValidationError):
                    publish_to_blog.tag_catalog_file_contents(blog_repo)

                # Hardlink on tag-catalog.json -> immediate O_NOFOLLOW nlink block!
                isolated_catalog.write_bytes(raw_catalog_bytes)
                hardlink_path = root / 'hardlink-catalog.json'
                os.link(isolated_catalog, hardlink_path)
                try:
                    with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '硬链接'):
                        publish_to_blog.tag_catalog_file_contents(blog_repo)
                finally:
                    hardlink_path.unlink()

                # LRU maxsize bound check (<= TAG_CATALOG_SERIALIZATION_CACHE_MAX)
                for idx in range(6):
                    extra_repo = root / f'blog-{idx}'
                    extra_repo.mkdir()
                    publish_to_blog.tag_catalog_file_contents(extra_repo)
                self.assertLessEqual(
                    len(publish_to_blog._TAG_CATALOG_SERIALIZATION_CACHE),
                    publish_to_blog.TAG_CATALOG_SERIALIZATION_CACHE_MAX,
                )

    def test_workbench_sidecars_cache_deepcopy_isolation_and_single_char_miss(self):
        paper, plan = _sample_paper_and_plan()
        first = publish_to_blog.build_researcher_workbench_bundle(
            paper, '2026-11-18', reader_plan=plan, require_reader=True,
        )
        expected_sidecars = copy.deepcopy(first['sidecars'])
        expected_records = copy.deepcopy(first['sidecarRecords'])
        self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE), 1)

        # Mutate returned bundle in place -> next call must still return pristine bytes & records!
        any_path = next(iter(first['sidecars']))
        first['sidecars'][any_path] = b'corrupted'
        first['sidecarRecords']['rethink-context.json']['sha256'] = '0' * 64

        with mock.patch.object(
            publish_to_blog, '_json_sidecar_bytes',
            side_effect=AssertionError('sidecar cache hit must not re-run JSON serialization'),
        ):
            second = publish_to_blog.build_researcher_workbench_bundle(
                paper, '2026-11-18', reader_plan=plan, require_reader=True,
            )
        self.assertEqual(second['sidecars'], expected_sidecars)
        self.assertEqual(second['sidecarRecords'], expected_records)

        # Single-character change in abstract / title / score / date -> immediate cache miss & updated SHA!
        changed_paper = copy.deepcopy(paper)
        changed_paper['abstract'] = paper['abstract'][:-1] + '?'
        updated = publish_to_blog.build_researcher_workbench_bundle(
            changed_paper, '2026-11-18', reader_plan=plan, require_reader=True,
        )
        self.assertNotEqual(updated['abstractSha256'], second['abstractSha256'])
        self.assertNotEqual(
            updated['sidecarRecords']['rethink-context.json']['sha256'],
            second['sidecarRecords']['rethink-context.json']['sha256'],
        )
        self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE), 2)

        # Invalid paper input (score out of range) still blocks immediately!
        invalid_paper = copy.deepcopy(paper)
        invalid_paper['parsed']['score'] = 10.5
        with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '0-10'):
            publish_to_blog.build_researcher_workbench_bundle(
                invalid_paper, '2026-11-18', reader_plan=plan, require_reader=True,
            )

    def test_concurrent_lru_cache_read_write_and_eviction_thread_safety(self):
        base_paper, base_plan = _sample_paper_and_plan()
        distinct_papers = []
        expected_by_idx = {}
        for idx in range(320):
            p = copy.deepcopy(base_paper)
            p['arxivId'] = f'2611.{10000 + idx:05d}v1'
            p['title'] = f'Concurrent Deterministic Token Study #{idx}'
            p['abstract'] = f'Abstract #{idx}: deterministic cold-core verification.'
            distinct_papers.append(p)

        # Precompute deterministic reference for hot keys (0..7) and sample cold keys.
        for idx in (0, 1, 2, 3, 4, 5, 6, 7, 150, 319):
            ref = publish_to_blog.build_researcher_workbench_bundle(
                distinct_papers[idx], '2026-11-18', reader_plan=base_plan, require_reader=True,
            )
            expected_by_idx[idx] = (copy.deepcopy(ref['sidecars']), copy.deepcopy(ref['sidecarRecords']))
        publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE.clear()
        publish_to_blog._WORKBENCH_SIDECAR_RECORDS_CACHE.clear()

        schedule = []
        for idx in range(320):
            schedule.append(idx)
            schedule.append(idx % 8)  # interleave hot keys with >300 eviction-inducing keys

        def run_sidecar_task(paper_idx: int):
            out = publish_to_blog.build_researcher_workbench_bundle(
                distinct_papers[paper_idx], '2026-11-18', reader_plan=base_plan, require_reader=True,
            )
            if paper_idx in expected_by_idx:
                exp_sidecars, exp_records = expected_by_idx[paper_idx]
                self.assertEqual(out['sidecars'], exp_sidecars)
                self.assertEqual(out['sidecarRecords'], exp_records)
            return len(out['sidecars'])

        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            counts = list(pool.map(run_sidecar_task, schedule))
        self.assertTrue(all(c == 4 for c in counts))
        self.assertLessEqual(
            len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE),
            publish_to_blog.WORKBENCH_SIDECARS_SERIALIZATION_CACHE_MAX,
        )
        self.assertLessEqual(
            len(publish_to_blog._WORKBENCH_SIDECAR_RECORDS_CACHE),
            publish_to_blog.WORKBENCH_SIDECARS_SERIALIZATION_CACHE_MAX,
        )

        # Concurrent tag_catalog_file_contents stress across 10 repos (max=4 -> frequent evictions)
        raw_catalog_bytes = (ROOT / 'config' / 'tag-catalog.json').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            isolated_catalog = root / 'tag-catalog.json'
            isolated_catalog.write_bytes(raw_catalog_bytes)
            isolated_history = root / 'tag-catalog-history'
            isolated_history.mkdir()
            isolated_policy = root / 'tag-display-policy.json'
            repos = []
            for idx in range(10):
                r = root / f'repo-{idx}'
                r.mkdir()
                repos.append(r)

            with mock.patch.object(publish_to_blog, 'TAG_CATALOG_PATH', isolated_catalog), \
                    mock.patch.object(publish_to_blog, 'TAG_CATALOG_HISTORY_DIR', isolated_history), \
                    mock.patch.object(publish_to_blog, 'TAG_DISPLAY_POLICY_PATH', isolated_policy):
                baseline_assets = copy.deepcopy(publish_to_blog.tag_catalog_file_contents(repos[0]))
                publish_to_blog._TAG_CATALOG_SERIALIZATION_CACHE.clear()
                repo_schedule = [repos[i % 10] if i % 3 else repos[0] for i in range(96)]
                with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                    results = list(pool.map(publish_to_blog.tag_catalog_file_contents, repo_schedule))
                for item in results:
                    self.assertEqual(item, baseline_assets)
                self.assertLessEqual(
                    len(publish_to_blog._TAG_CATALOG_SERIALIZATION_CACHE),
                    publish_to_blog.TAG_CATALOG_SERIALIZATION_CACHE_MAX,
                )

                # max_entries <= 0 clears caches and keeps zero resident entries
                with mock.patch.object(publish_to_blog, 'TAG_CATALOG_SERIALIZATION_CACHE_MAX', 0), \
                        mock.patch.object(publish_to_blog, 'WORKBENCH_SIDECARS_SERIALIZATION_CACHE_MAX', 0):
                    self.assertEqual(publish_to_blog.tag_catalog_file_contents(repos[0]), baseline_assets)
                    self.assertEqual(len(publish_to_blog._TAG_CATALOG_SERIALIZATION_CACHE), 0)
                    b_zero = publish_to_blog.build_researcher_workbench_bundle(
                        distinct_papers[0], '2026-11-18', reader_plan=base_plan, require_reader=True,
                    )
                    self.assertEqual(b_zero['sidecars'], expected_by_idx[0][0])
                    self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE), 0)
                    self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECAR_RECORDS_CACHE), 0)

    def test_intermediate_directory_symlink_dirty_file_and_legacy_downgrade_rejected(self):
        raw_catalog_bytes = (ROOT / 'config' / 'tag-catalog.json').read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            isolated_catalog = root / 'tag-catalog.json'
            isolated_catalog.write_bytes(raw_catalog_bytes)
            isolated_history = root / 'tag-catalog-history'
            isolated_history.mkdir()
            isolated_policy = root / 'tag-display-policy.json'
            blog_repo = root / 'blog'
            blog_repo.mkdir()

            with mock.patch.object(publish_to_blog, 'TAG_CATALOG_PATH', isolated_catalog), \
                    mock.patch.object(publish_to_blog, 'TAG_CATALOG_HISTORY_DIR', isolated_history), \
                    mock.patch.object(publish_to_blog, 'TAG_DISPLAY_POLICY_PATH', isolated_policy):
                # Export canonical files and warm cache on populated blog_repo.
                exported = publish_to_blog.tag_catalog_file_contents(blog_repo)
                for rel, raw in exported.items():
                    target = blog_repo / rel
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(raw)
                warmed = publish_to_blog.tag_catalog_file_contents(blog_repo)
                self.assertEqual(warmed, exported)

                # 1) Replace blog_repo/static/data with a symlink to external dir with identical files!
                external_data = root / 'external-static-data'
                shutil.move(str(blog_repo / 'static' / 'data'), str(external_data))
                (blog_repo / 'static' / 'data').symlink_to(external_data, target_is_directory=True)
                with self.assertRaises(publish_to_blog.PublishDataValidationError):
                    publish_to_blog.tag_catalog_file_contents(blog_repo)

                # 2) Replace blog_repo/static/data with an internal symlink inside blog_repo!
                (blog_repo / 'static' / 'data').unlink()
                internal_copy = blog_repo / 'static' / 'moved-data'
                shutil.move(str(external_data), str(internal_copy))
                (blog_repo / 'static' / 'data').symlink_to(internal_copy, target_is_directory=True)
                with self.assertRaises(publish_to_blog.PublishDataValidationError):
                    publish_to_blog.tag_catalog_file_contents(blog_repo)

                # Restore real directory and re-warm cache.
                (blog_repo / 'static' / 'data').unlink()
                shutil.move(str(internal_copy), str(blog_repo / 'static' / 'data'))
                self.assertEqual(publish_to_blog.tag_catalog_file_contents(blog_repo), exported)

                # 3) Dirty file dirty.json in archive directory must bypass cache and raise!
                dirty = blog_repo / 'data' / 'tag-catalog-history' / 'dirty.json'
                dirty.write_text('{"bad": true}\n', encoding='utf-8')
                try:
                    with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'SHA 文件命名'):
                        publish_to_blog.tag_catalog_file_contents(blog_repo)
                finally:
                    dirty.unlink()

                # 4) Approved policy symlink / hardlink rejected via O_NOFOLLOW!
                policy_target = root / 'external-policy.json'
                policy_target.write_text('{}\n', encoding='utf-8')
                isolated_policy.symlink_to(policy_target)
                try:
                    with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '符号链接'):
                        publish_to_blog.tag_catalog_file_contents(blog_repo)
                finally:
                    isolated_policy.unlink()

                # 5) Legacy protocol downgrade in TAG_CATALOG_PATH must be rejected (uses_default_catalog=True)!
                import tag_catalog as tc
                downgraded = json.loads(raw_catalog_bytes.decode('utf-8'))
                for hdr_key in ('contract', 'version', 'schemaVersion', 'schemaFingerprint'):
                    downgraded.pop(hdr_key, None)
                downgraded.update(
                    public_protocols.record_header(tc.LEGACY_TAG_CATALOG_VERSION, 'paper-tag-catalog')
                )
                isolated_catalog.write_bytes(
                    (json.dumps(downgraded, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
                )
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '现行稳定协议'):
                    publish_to_blog.tag_catalog_file_contents(blog_repo)

    def test_blog_url_base_path_max_bytes_and_strict_key_defenses(self):
        paper, plan = _sample_paper_and_plan()
        base_bundle = publish_to_blog.build_researcher_workbench_bundle(
            paper, '2026-11-18', reader_plan=plan, require_reader=True,
        )
        self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE), 1)
        self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECAR_RECORDS_CACHE), 1)

        # Patching BLOG_URL immediately causes cache miss on both caches.
        with mock.patch.object(publish_to_blog, 'BLOG_URL', 'https://mirror.example.org/posts'):
            publish_to_blog.build_researcher_workbench_bundle(
                paper, '2026-11-18', reader_plan=plan, require_reader=True,
            )
        self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE), 2)
        self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECAR_RECORDS_CACHE), 2)

        # Patching BLOG_BASE_PATH immediately misses cache and updates generated sidecar URLs!
        with mock.patch.object(publish_to_blog, 'BLOG_BASE_PATH', '/custom-mirror-base'):
            custom_bundle = publish_to_blog.build_researcher_workbench_bundle(
                paper, '2026-11-18', reader_plan=plan, require_reader=True,
            )
        self.assertNotEqual(
            custom_bundle['sidecarRecords']['rethink-context.json']['url'],
            base_bundle['sidecarRecords']['rethink-context.json']['url'],
        )
        self.assertTrue(
            custom_bundle['sidecarRecords']['rethink-context.json']['url'].startswith('/custom-mirror-base/'),
        )
        self.assertEqual(len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE), 3)

        # Tightening RESEARCHER_SIDECAR_MAX_BYTES must miss BOTH caches and raise validation error!
        expected_ctx_hdr = public_protocols.record_header(
            publish_to_blog.RESEARCH_CONTEXT_CONTRACT, 'paper-research-context',
        )
        with mock.patch.object(publish_to_blog, 'RESEARCHER_SIDECAR_MAX_BYTES', 32):
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, 'researcher JSON sidecar 非规范或超过 256 KiB',
            ):
                publish_to_blog.build_researcher_workbench_bundle(
                    paper, '2026-11-18', reader_plan=plan, require_reader=True,
                )
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, 'researcher sidecar 非规范',
            ):
                publish_to_blog._workbench_sidecar_records(
                    base_bundle['sidecars'], expected_context_header=expected_ctx_hdr,
                )

        # Non-str dict keys ({1: 'v'}) and NaN floats must never collide or enter cache!
        self.assertFalse(publish_to_blog._has_only_strict_str_dict_keys({1: 'v'}))
        self.assertFalse(publish_to_blog._has_only_strict_str_dict_keys({'x': float('nan')}))
        self.assertTrue(publish_to_blog._has_only_strict_str_dict_keys({'1': 'v', 'n': 3}))

        publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE.clear()
        sample_identity = {'absUrl': 'https://arxiv.org/abs/2611.12345', 'pdfUrl': 'https://arxiv.org/pdf/2611.12345'}
        publish_to_blog._serialize_verified_workbench_sidecars(
            original_title='Title',
            authors=[{'name': 'Alice'}],
            citation_id='2611.12345',
            identity=sample_identity,
            citation={1: 'int-key'},
            context={'ok': 'yes'},
            root=Path('static/data/papers/2026-11-18/test-slug'),
        )
        self.assertEqual(
            len(publish_to_blog._WORKBENCH_SIDECARS_SERIALIZATION_CACHE), 0,
            'non-str dict keys must bypass cache completely to prevent key collisions',
        )

    def test_git_publication_minimal_env_timeout_and_explicit_kwarg_precedence(self):
        captured_runs = []

        def fake_subproc_run(cmd, **kwargs):
            captured_runs.append((cmd, kwargs))
            if cmd[:2] == ['git', 'cat-file']:
                return SimpleNamespace(returncode=0, stdout=b'2611.12345 missing\n', stderr=b'')
            return SimpleNamespace(returncode=0, stdout='', stderr='')

        fake_subproc = SimpleNamespace(
            run=fake_subproc_run,
            PIPE=subprocess.PIPE,
            TimeoutExpired=subprocess.TimeoutExpired,
            CalledProcessError=subprocess.CalledProcessError,
        )
        with mock.patch.dict(os.environ, {
            'PAPER_ANALYZER_API_KEY': 'sk-secret-must-never-leak',
            'PD_GIT_LOCAL_TIMEOUT_SECONDS': '17',
        }, clear=False):
            blobs = blog_git_publication.git_batch_blob_bytes(
                'HEAD', ['content/posts/2026-11-18.md'],
                blog_repo=str(ROOT), subprocess_module=fake_subproc,
            )
            self.assertEqual(blobs, {'content/posts/2026-11-18.md': None})
            tracked = blog_git_publication.git_tracks_path(
                'content/posts/2026-11-18.md',
                blog_repo=str(ROOT), subprocess_module=fake_subproc,
            )
            self.assertTrue(tracked)

        self.assertEqual(len(captured_runs), 2)
        for _cmd, kwargs in captured_runs:
            self.assertIsInstance(kwargs.get('env'), dict)
            self.assertNotIn('PAPER_ANALYZER_API_KEY', kwargs['env'])
            self.assertEqual(kwargs.get('timeout'), 17)

        # Explicit run_git= and batch_blob_bytes= must NOT be shadowed by hooks!
        explicit_git_calls = []

        def explicit_run_git(args, **_kw):
            explicit_git_calls.append(tuple(args))
            if args[0] == 'symbolic-ref':
                return SimpleNamespace(returncode=0, stdout='main\n')
            if args[0] == 'rev-parse':
                return SimpleNamespace(returncode=0, stdout='b' * 40 + '\n')
            if args[0] == 'write-tree':
                return SimpleNamespace(returncode=0, stdout='c' * 40 + '\n')
            raise AssertionError(args)

        shadowing_hooks = {
            '_git_relative_manifest': lambda _p: [],
            'validate_git_publish_branch': lambda: (_ for _ in ()).throw(
                AssertionError('hooks validate_git_publish_branch must not shadow explicit run_git')
            ),
            'BLOG_REPO': str(ROOT),
        }
        state = blog_git_publication.capture_git_publish_state(
            [], run_git=explicit_run_git, hooks=shadowing_hooks,
        )
        self.assertEqual(state['head'], 'b' * 40)
        self.assertTrue(any(c[0] == 'symbolic-ref' for c in explicit_git_calls))

        explicit_batch_revs = []

        def explicit_batch(rev, _rels):
            explicit_batch_revs.append(rev)
            if rev == 'a' * 40:
                return {'content/posts/2026-11-18.md': None}
            return {'content/posts/2026-11-18.md': b'body\n'}

        def commit_git_runner(args, **_kw):
            if args[0] == 'rev-list':
                return SimpleNamespace(returncode=0, stdout=f'{"b" * 40} {"a" * 40}\n')
            if args[0] == 'diff-tree':
                return SimpleNamespace(returncode=0, stdout='content/posts/2026-11-18.md\n')
            raise AssertionError(args)

        shadow_commit_hooks = {
            '_git_relative_manifest': lambda _p: ['content/posts/2026-11-18.md'],
            '_expected_commit_delta_paths': lambda *_a: (_ for _ in ()).throw(
                AssertionError('hooks _expected_commit_delta_paths must not shadow explicit batch_blob_bytes')
            ),
        }
        blog_git_publication.validate_git_commit_against_review_receipt(
            {
                'baseHead': 'a' * 40,
                'files': [{
                    'path': 'content/posts/2026-11-18.md',
                    'sha256': hashlib.sha256(b'body\n').hexdigest(),
                }],
            },
            ['content/posts/2026-11-18.md'],
            'b' * 40,
            run_git=commit_git_runner,
            batch_blob_bytes=explicit_batch,
            hooks=shadow_commit_hooks,
        )
        self.assertEqual(explicit_batch_revs, ['a' * 40, 'b' * 40])

        # Dynamic builtins.print resolution in report_push_retry
        with mock.patch('builtins.print') as mocked_print:
            blog_git_publication.report_push_retry('d' * 40, 'network timeout')
            self.assertGreaterEqual(mocked_print.call_count, 4)

    def test_local_controlled_review_image_rejects_symlinks_and_noncanonical_filenames(self):
        self.assertFalse(hasattr(blog_review_image_loader, '_RASTER_RECOVERY_SOURCE_BYTES'))
        png = _valid_png_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            repo = root / 'blog'
            canonical_rel = 'static/images/papers/2611.12345/figure-1-0123456789abcdef.png'
            canonical_file = repo / canonical_rel
            canonical_file.parent.mkdir(parents=True)
            canonical_file.write_bytes(png)

            # Valid canonical path succeeds even when _manifest_record is absent from hooks!
            minimal_hooks = {'BLOG_REPO': str(repo), 'BASE_PATH': '/audio-paper-digest-blog'}
            loaded = blog_review_image_loader.load_review_image(
                '/audio-paper-digest-blog/images/papers/2611.12345/figure-1-0123456789abcdef.png',
                hooks=minimal_hooks,
            )
            self.assertEqual(loaded['media_type'], 'image/png')

            # Non-canonical filename rejected even without _manifest_record!
            bad_file = repo / 'static/images/papers/2611.12345/uncontrolled.png'
            bad_file.write_bytes(png)
            with self.assertRaises(publish_to_blog.PublishDataValidationError):
                blog_review_image_loader.load_review_image(
                    '/audio-paper-digest-blog/images/papers/2611.12345/uncontrolled.png',
                    hooks=minimal_hooks,
                )

            # Empty segment / dot-dot segment rejected!
            with self.assertRaises(publish_to_blog.PublishDataValidationError):
                blog_review_image_loader.load_review_image(
                    '/audio-paper-digest-blog/images/papers//2611.12345/figure-1-0123456789abcdef.png',
                    hooks=minimal_hooks,
                )

            # Symlinked image file rejected!
            sym_rel = 'static/images/papers/2611.12345/figure-2-0123456789abcdef.png'
            (repo / sym_rel).symlink_to(canonical_file)
            with self.assertRaises(publish_to_blog.PublishDataValidationError):
                blog_review_image_loader.load_review_image(
                    '/audio-paper-digest-blog/images/papers/2611.12345/figure-2-0123456789abcdef.png',
                    hooks=minimal_hooks,
                )

    def test_ast_single_function_isolation_without_cache_globals_or_sys_path(self):
        source = (SCRIPTS / 'publish-to-blog.py').read_text(encoding='utf-8')
        tree = ast.parse(source)
        by_name = {
            node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)
        }
        sidecar_nodes = [
            by_name['_serialize_verified_workbench_sidecars'],
            by_name['_workbench_sidecar_records'],
            by_name['_researcher_public_url'],
        ]
        minimal_ns = {
            'Path': Path,
            're': __import__('re'),
            'json': json,
            'hashlib': hashlib,
            'BASE_PATH': '/audio-paper-digest-blog',
            'PublishDataValidationError': publish_to_blog.PublishDataValidationError,
            'public_protocols': public_protocols,
            '_bibtex_escape': lambda v, _lbl: str(v),
            '_json_sidecar_bytes': lambda v: (json.dumps(v, ensure_ascii=False, sort_keys=True) + '\n').encode('utf-8'),
        }
        exec(compile(ast.Module(body=sidecar_nodes, type_ignores=[]), '<ast>', 'exec'), minimal_ns)
        ctx_hdr = public_protocols.record_header(
            publish_to_blog.RESEARCH_CONTEXT_CONTRACT, 'paper-research-context',
        )
        sidecars = minimal_ns['_serialize_verified_workbench_sidecars'](
            original_title='AST Minimal Paper',
            authors=[{'name': 'Alice'}],
            citation_id='2611.12345',
            identity={'absUrl': 'https://arxiv.org/abs/2611.12345', 'pdfUrl': 'https://arxiv.org/pdf/2611.12345'},
            citation={'title': 'AST Minimal Paper'},
            context={**ctx_hdr, 'title': 'AST Minimal Paper'},
            root=Path('static/data/papers/2026-11-18/ast-paper'),
        )
        records = minimal_ns['_workbench_sidecar_records'](sidecars, expected_context_header=ctx_hdr)
        self.assertEqual(set(records), set(publish_to_blog.RESEARCHER_SIDECAR_FILENAMES))

        # Subprocess without scripts/ in sys.path still resolves extracted modules cleanly,
        # and raises ImportError (never StopIteration) when run from an empty temp cwd with stripped sys.path.
        probe_code = (
            'import ast, os, sys, tempfile\n'
            'from pathlib import Path\n'
            f'src = Path({str(SCRIPTS / "publish-to-blog.py")!r}).read_text(encoding="utf-8")\n'
            'tree = ast.parse(src)\n'
            'fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "restore_git_publish_state")\n'
            'ns = {}\n'
            'exec(compile(ast.Module(body=[fn], type_ignores=[]), "<ast>", "exec"), ns)\n'
            'ns["restore_git_publish_state"](None)\n'
            'assert "blog_git_publication" in ns\n'
            'ns2 = {}\n'
            'exec(compile(ast.Module(body=[fn], type_ignores=[]), "<ast>", "exec"), ns2)\n'
            'with tempfile.TemporaryDirectory() as td:\n'
            '    old_cwd = os.getcwd()\n'
            '    old_path = list(sys.path)\n'
            '    try:\n'
            '        os.chdir(td)\n'
            '        sys.path[:] = [td]\n'
            '        sys.modules.pop("blog_git_publication", None)\n'
            '        try:\n'
            '            ns2["restore_git_publish_state"](None)\n'
            '            raise AssertionError("expected ImportError")\n'
            '        except ImportError:\n'
            '            pass\n'
            '    finally:\n'
            '        os.chdir(old_cwd)\n'
            '        sys.path[:] = old_path\n'
            'print("ast-fallback-ok")\n'
        )
        clean_env = {k: v for k, v in os.environ.items() if k not in {'CODEX_SANDBOX', 'PYTHONPATH'}}
        res = subprocess.run(
            [sys.executable, '-c', probe_code],
            cwd=ROOT,
            env=clean_env,
            capture_output=True,
            text=True,
            timeout=10,
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertEqual(res.stdout.strip(), 'ast-fallback-ok')


if __name__ == '__main__':
    unittest.main()
