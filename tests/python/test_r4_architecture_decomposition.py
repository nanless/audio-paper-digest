"""Round 4 (Wave 4) Python architecture decomposition regression tests.

Verifies:
1. `markdown_hugo_gate.py` and `publish-to-blog.py` import `tutorial_payload_verifier_core`
   without depending on `manual/scripts` on `sys.path`.
2. `_REVIEW_IMPLEMENTATION_ENTRIES` and `review_implementation_closure()` include the new
   `scripts/` modules and exclude retired `manual/scripts/tutorial_payload_verifier.py`.
3. `publish_common.py` preserves re-exports and monkeypatch hooks for `publish_llm_client`
   and `publish_manual_legacy` (including Round 1 60s connect / 180s SSE idle budgets).
4. `blog_core_summary_verifier.py` works through `publish-to-blog.py` (parity, cache
   identity, monkeypatch hooks, and AST-isolated extraction).
5. `protocol_codec.py` strictly rejects `NaN`, `Infinity`, `-Infinity`, and UTF-8 BOM.
"""

import ast
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
MANUAL_SCRIPTS = ROOT / 'manual' / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from project_env_isolation import isolate_module_environment, project_env_scope  # noqa: E402

setUpModule, tearDownModule = isolate_module_environment()

import blog_core_summary_verifier  # noqa: E402
import markdown_hugo_gate  # noqa: E402
import protocol_codec  # noqa: E402
import publish_common  # noqa: E402
import publish_llm_client  # noqa: E402
import publish_manual_legacy  # noqa: E402
import tutorial_payload_verifier_core  # noqa: E402
from blog_entry_loader import load_publish_to_blog  # noqa: E402

with project_env_scope():
    publish_to_blog = load_publish_to_blog()


class R4ArchitectureDecompositionTests(unittest.TestCase):
    def test_markdown_hugo_gate_and_publisher_isolate_tutorial_payload_verifier_core(self):
        # AST-level import check: both modules import tutorial_payload_verifier_core, never tutorial_payload_verifier
        for rel_path in ('scripts/markdown_hugo_gate.py', 'scripts/publish-to-blog.py'):
            tree = ast.parse((ROOT / rel_path).read_text(encoding='utf-8'), filename=rel_path)
            imported_modules = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        imported_modules.add(alias.name)
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported_modules.add(node.module)
            self.assertIn('tutorial_payload_verifier_core', imported_modules, rel_path)
            self.assertNotIn('tutorial_payload_verifier', imported_modules, rel_path)

        # Subprocess import of markdown_hugo_gate with ONLY scripts/ on sys.path never injects manual/scripts
        probe = (
            'import json, sys\n'
            f'sys.path.insert(0, {str(SCRIPTS)!r})\n'
            'import markdown_hugo_gate\n'
            'print(json.dumps({\n'
            '    "manualOnPath": any("manual/scripts" in p.replace("\\\\", "/") for p in sys.path),\n'
            '    "coreLoaded": "tutorial_payload_verifier_core" in sys.modules,\n'
            '    "legacyLoaded": "tutorial_payload_verifier" in sys.modules,\n'
            '    "contract": markdown_hugo_gate.TUTORIAL_FORMAT_CONTRACT,\n'
            '}))\n'
        )
        clean_env = {k: v for k, v in os.environ.items() if k not in {'CODEX_SANDBOX', 'PYTHONPATH'}}
        result = subprocess.run(
            [sys.executable, '-c', probe], cwd=ROOT, env=clean_env,
            capture_output=True, text=True, timeout=15, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertFalse(payload['manualOnPath'])
        self.assertTrue(payload['coreLoaded'])
        self.assertFalse(payload['legacyLoaded'])
        self.assertEqual(payload['contract'], tutorial_payload_verifier_core.TUTORIAL_FORMAT_CONTRACT)

        # Thin compatibility wrapper in manual/scripts/tutorial_payload_verifier.py re-exports core symbols
        wrapper_probe = (
            'import importlib.util, json\n'
            f'spec = importlib.util.spec_from_file_location("manual_tpv", {str(MANUAL_SCRIPTS / "tutorial_payload_verifier.py")!r})\n'
            'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)\n'
            'import tutorial_payload_verifier_core as core\n'
            'print(json.dumps({\n'
            '    "sameNormalize": mod.normalize_fresh_article is core.normalize_fresh_article,\n'
            '    "sameFresh": mod.validate_manual_fresh_authoring is core.validate_manual_fresh_authoring,\n'
            '    "samePayload": mod.validate_manual_tutorial_payload is core.validate_manual_tutorial_payload,\n'
            '    "sameContract": mod.TUTORIAL_FORMAT_CONTRACT == core.TUTORIAL_FORMAT_CONTRACT,\n'
            '}))\n'
        )
        wrap_res = subprocess.run(
            [sys.executable, '-c', wrapper_probe], cwd=ROOT, env=clean_env,
            capture_output=True, text=True, timeout=15, check=False,
        )
        self.assertEqual(wrap_res.returncode, 0, wrap_res.stderr)
        wrap_data = json.loads(wrap_res.stdout)
        self.assertTrue(all(wrap_data.values()), wrap_data)

    def test_review_implementation_entries_and_closure_track_new_modules_without_retired_manual_entries(self):
        entries = set(publish_to_blog._REVIEW_IMPLEMENTATION_ENTRIES)
        expected_new = {
            'scripts/tutorial_payload_verifier_core.py',
            'scripts/blog_core_summary_verifier.py',
            'scripts/publish_llm_client.py',
            'scripts/publish_manual_legacy.py',
        }
        self.assertTrue(expected_new.issubset(entries), entries)
        # Retired manual/scripts/tutorial_payload_verifier.py is removed; only active manual-review-blog.py remains
        manual_entries = {e for e in entries if e.startswith('manual/')}
        self.assertNotIn('manual/scripts/tutorial_payload_verifier.py', entries)
        self.assertEqual(manual_entries, {'manual/scripts/manual-review-blog.py'})

        publish_to_blog._REVIEW_IMPLEMENTATION_CLOSURE_CACHE.clear()
        closure = set(publish_to_blog.review_implementation_closure())
        for rel in expected_new:
            self.assertIn(rel, closure)
        self.assertNotIn('manual/scripts/tutorial_payload_verifier.py', closure)

        # generation_template_fingerprint responds to byte changes in extracted generation modules
        real_sha = publish_to_blog._sha256_file
        baseline = publish_to_blog.generation_template_fingerprint()
        for mod_name in (
            'tutorial_payload_verifier_core.py',
            'blog_core_summary_verifier.py',
            'publish_manual_legacy.py',
        ):
            target = (SCRIPTS / mod_name).resolve()
            with self.subTest(module=mod_name), mock.patch.object(
                publish_to_blog, '_sha256_file',
                side_effect=lambda p, t=target: 'd' * 64 if Path(p).resolve() == t else real_sha(p),
            ):
                self.assertNotEqual(publish_to_blog.generation_template_fingerprint(), baseline)
        self.assertEqual(publish_to_blog.generation_template_fingerprint(), baseline)

    def test_publish_common_reexports_and_monkeypatch_hooks_for_llm_client_and_manual_legacy(self):
        # Timeout constants match Round 1 budgets
        self.assertEqual(publish_common.PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS, 60.0)
        self.assertEqual(publish_common.PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS, 180.0)
        self.assertEqual(publish_llm_client.PUBLISH_LLM_CONNECT_TIMEOUT_SECONDS, 60.0)
        self.assertEqual(publish_llm_client.PUBLISH_LLM_SSE_IDLE_TIMEOUT_SECONDS, 180.0)

        # publish_llm_client has zero top-level imports of publish_common or project_env (pure stdlib top-level)
        llm_tree = ast.parse((SCRIPTS / 'publish_llm_client.py').read_text(encoding='utf-8'))
        top_imports = set()
        for node in llm_tree.body:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    top_imports.add(alias.name)
            elif isinstance(node, ast.ImportFrom) and node.module:
                top_imports.add(node.module)
        for forbidden in ('publish_common', 'project_env', 'path_config', 'llm_account_pool', 'llm_usage'):
            self.assertNotIn(forbidden, top_imports)

        # Re-exported symbols exist on publish_common
        for attr in (
            'call_publish_llm_api', '_open_publish_json_with_account_pool',
            'build_publish_headers', 'build_publish_payload', 'parse_publish_sse_response',
            'resolve_stage_reasoning_effort', 'detect_publish_api_type',
            '_KeepAliveHTTPConnection', '_KeepAliveHTTPSConnection',
            '_PublishLLMRedirectError', '_PublishLLMNoRedirectHandler',
            'validate_signed_manual_payload', '_validate_manual_takeover_manifest',
            'validate_manual_depth_contract', 'validate_manual_reader_quality',
            'validate_final_structured_manual_markdown', '_manual_hash',
            'MANUAL_SIGNATURE_CONTRACT', 'MANUAL_DEPTH_SIGNED_LONGFORM_CONTRACT',
        ):
            self.assertTrue(hasattr(publish_common, attr), attr)

        # Monkeypatching publish_common.get_claude_code_version propagates into publish_llm_client
        with mock.patch.object(publish_common, 'get_claude_code_version', return_value='7.6.5'):
            headers = publish_common.build_publish_headers('anthropic', 'synthetic-key')
        self.assertEqual(headers['User-Agent'], 'claude-cli/7.6.5 (external, cli)')

        # Monkeypatching publish_common._extract_analysis_section propagates into publish_manual_legacy
        with mock.patch.object(publish_common, '_extract_analysis_section', return_value='') as extract_mock:
            issue = publish_common.validate_manual_depth_contract('## 核心摘要\n内容')
        self.assertIsNotNone(issue)
        self.assertTrue(extract_mock.called)

        # ContextVar hooks are thread-isolated across publish_llm_client, publish_manual_legacy, blog_core_summary_verifier
        for mod in (publish_llm_client, publish_manual_legacy, blog_core_summary_verifier):
            def check_thread(idx, m=mod):
                token_val = f'isolated-{idx}'
                with m._hooks_scope({'_SENTINEL': token_val}):
                    return m._H._SENTINEL

            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                observed = list(pool.map(check_thread, range(32)))
            self.assertEqual(observed, [f'isolated-{i}' for i in range(32)])

    def test_blog_core_summary_verifier_identity_hooks_and_ast_isolation(self):
        # Shared mutable cache and regex identity
        self.assertIs(
            publish_to_blog._CORE_SUMMARY_NODE_REPLAY_CACHE,
            blog_core_summary_verifier._CORE_SUMMARY_NODE_REPLAY_CACHE,
        )
        self.assertIs(
            publish_to_blog._EXECUTIVE_ABSTRACT_BOLD_LEAD_RE,
            blog_core_summary_verifier._EXECUTIVE_ABSTRACT_BOLD_LEAD_RE,
        )

        # Behavioral parity on semantic check and surface structure
        short_text = '这是一个过短的摘要。'
        self.assertEqual(
            publish_to_blog._detailed_core_summary_semantic_issue(short_text),
            blog_core_summary_verifier._detailed_core_summary_semantic_issue(short_text),
        )
        self.assertEqual(
            publish_to_blog._strip_core_summary_non_result_numerals('见 Fig. 2 与 2025 年统计，WER 为 3.2%。'),
            blog_core_summary_verifier._strip_core_summary_non_result_numerals('见 Fig. 2 与 2025 年统计，WER 为 3.2%。'),
        )

        # Monkeypatching publish_to_blog._source_bound_core_summary_semantic_issue propagates through _validated_detailed_core_summary
        paper = {
            'analysis': '## 核心摘要\n\n测试摘要正文。\n\n## 评分\n总分: 7.0/10\n',
            'analysisManifest': {
                'contracts': {'coreSummary': publish_to_blog.core_summary_formats.current_header()},
                'stages': {
                    'coreSummaryRepair': {
                        'status': 'complete',
                        **publish_to_blog.core_summary_formats.stage_fields(
                            publish_to_blog.core_summary_formats.current_header()
                        ),
                    },
                },
            },
        }
        with mock.patch.object(
            publish_to_blog, '_source_bound_core_summary_semantic_issue',
            return_value='合成钩子命中',
        ) as hooked_semantic:
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '合成钩子命中'):
                publish_to_blog._validated_detailed_core_summary(paper, {'summary': '测试摘要正文。'})
        self.assertEqual(hooked_semantic.call_count, 1)

        # AST transitive extraction from publish-to-blog.py still resolves both semantic check and numeral stripper
        source = (SCRIPTS / 'publish-to-blog.py').read_text(encoding='utf-8')
        funcs = {n.name: n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)}
        names = {'_detailed_core_summary_semantic_issue'}
        while True:
            expanded = names | {
                n.func.id
                for name in names
                for n in ast.walk(funcs[name])
                if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id in funcs
            }
            if expanded == names:
                break
            names = expanded
        self.assertIn('_strip_core_summary_non_result_numerals', names)
        env = {'re': re}
        exec(compile(ast.Module(body=[funcs[n] for n in funcs if n in names], type_ignores=[]), '<ast>', 'exec'), env)
        self.assertIn('中文字符必须为', env['_detailed_core_summary_semantic_issue'](short_text))
        self.assertNotIn('2025', env['_strip_core_summary_non_result_numerals']('2025年结果为91.2%'))

    def test_protocol_codec_strictly_rejects_nan_infinity_and_bom(self):
        for bad_float in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(value=repr(bad_float)):
                with self.assertRaises(ValueError):
                    protocol_codec.canonical({'value': bad_float})
                with self.assertRaises(ValueError):
                    protocol_codec.canonical([bad_float])

        # read_catalogs strictly rejects NaN / Infinity / -Infinity and UTF-8 BOM
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp).resolve()
            catalog_file = tmp_dir / 'sample.json'
            for payload_bytes in (
                b'{"protocols":[{"name":"bad-nan","currentVariant":"x","currentSchema":{"v":NaN},"historical":[]}]}',
                b'{"protocols":[{"name":"bad-inf","currentVariant":"x","currentSchema":{"v":Infinity},"historical":[]}]}',
                b'{"protocols":[{"name":"bad-ninf","currentVariant":"x","currentSchema":{"v":-Infinity},"historical":[]}]}',
                b'\xef\xbb\xbf{"protocols":[]}',
            ):
                catalog_file.write_bytes(payload_bytes)
                with self.assertRaises(ValueError):
                    protocol_codec.read_catalogs(tmp_dir)

            # Valid catalog still loads cleanly
            catalog_file.write_text(
                json.dumps({
                    'protocols': [{
                        'name': 'valid-record',
                        'currentVariant': 'source-bound',
                        'currentSchema': {'fields': ['paperId'], 'count': 1},
                        'historical': [],
                    }],
                }),
                encoding='utf-8',
            )
            loaded = protocol_codec.read_catalogs(tmp_dir)
            codec = protocol_codec.Codec(loaded)
            self.assertEqual(codec.contract('valid-record'), 'valid-record')

    def test_core_summary_node_replay_cache_patch_isolates_lookup_and_write(self):
        summary = 'R4 缓存隔离回归测试摘要。'
        source_text = 'R4 cache isolation synthetic paper source text.'
        runner_result = types.SimpleNamespace(
            returncode=0,
            timed_out=False,
            output_truncated=False,
            stdout=json.dumps({'issue': '合成节点问题'}),
            stderr='',
        )
        module_cache = blog_core_summary_verifier._CORE_SUMMARY_NODE_REPLAY_CACHE
        keys_before = set(module_cache)
        local_cache = {}
        with mock.patch.object(publish_to_blog, '_CORE_SUMMARY_NODE_REPLAY_CACHE', local_cache), \
                mock.patch.object(publish_to_blog, '_run_node_replay_cli', return_value=runner_result) as runner:
            first = publish_to_blog._run_core_summary_node_replay(
                {}, summary, source_text, stage_replay=False,
            )
            second = publish_to_blog._run_core_summary_node_replay(
                {}, summary, source_text, stage_replay=False,
            )
        self.assertEqual(first, '合成节点问题')
        self.assertEqual(second, '合成节点问题')
        self.assertEqual(runner.call_count, 1)
        self.assertEqual(len(local_cache), 1)
        self.assertEqual(set(module_cache), keys_before)

        cached_key = next(iter(local_cache))
        module_cache[cached_key] = '模块全局残留值'
        self.addCleanup(module_cache.pop, cached_key, None)

        # Patching publish_to_blog._CORE_SUMMARY_NODE_REPLAY_CACHE to a fresh dict ignores module_cache
        isolated_empty = {}
        with mock.patch.object(publish_to_blog, '_CORE_SUMMARY_NODE_REPLAY_CACHE', isolated_empty), \
                mock.patch.object(publish_to_blog, '_run_node_replay_cli', return_value=runner_result) as runner2:
            third = publish_to_blog._run_core_summary_node_replay(
                {}, summary, source_text, stage_replay=False,
            )
        self.assertEqual(third, '合成节点问题')
        self.assertEqual(runner2.call_count, 1)
        self.assertIn(cached_key, isolated_empty)

        # Pre-populated patched cache is read directly without spawning replay
        preloaded = {cached_key: '预置局部命中'}
        with mock.patch.object(publish_to_blog, '_CORE_SUMMARY_NODE_REPLAY_CACHE', preloaded), \
                mock.patch.object(publish_to_blog, '_run_node_replay_cli', return_value=runner_result) as runner3:
            fourth = publish_to_blog._run_core_summary_node_replay(
                {}, summary, source_text, stage_replay=False,
            )
        self.assertEqual(fourth, '预置局部命中')
        runner3.assert_not_called()

    def test_generation_fingerprint_and_core_summary_replay_cache_track_exemptions_and_runtime_paths(self):
        real_sha = publish_to_blog._sha256_file
        baseline = publish_to_blog.generation_template_fingerprint()
        exemptions_path = (SCRIPTS / 'lib' / 'analysis-contract-paper-exemptions.js').resolve()
        runtime_paths_path = (ROOT / 'config' / 'runtime-paths.json').resolve()
        for target in (exemptions_path, runtime_paths_path):
            with self.subTest(dependency=str(target.relative_to(ROOT))), mock.patch.object(
                publish_to_blog, '_sha256_file',
                side_effect=lambda p, t=target: 'e' * 64 if Path(p).resolve() == t else real_sha(p),
            ):
                self.assertNotEqual(publish_to_blog.generation_template_fingerprint(), baseline)
        self.assertEqual(publish_to_blog.generation_template_fingerprint(), baseline)

        # Changing analysis-contract-paper-exemptions.js invalidates _run_core_summary_node_replay cache key
        local_cache = {}
        runner_result = types.SimpleNamespace(
            returncode=0,
            timed_out=False,
            output_truncated=False,
            stdout=json.dumps({'issue': None}),
            stderr='',
        )
        with mock.patch.object(publish_to_blog, '_CORE_SUMMARY_NODE_REPLAY_CACHE', local_cache), \
                mock.patch.object(publish_to_blog, '_run_node_replay_cli', return_value=runner_result) as runner:
            self.assertIsNone(publish_to_blog._run_core_summary_node_replay(
                {}, '豁免指纹测试摘要。', 'Exemption hash cache test source.', stage_replay=False,
            ))
            self.assertEqual(runner.call_count, 1)
            with mock.patch.object(
                publish_to_blog, '_sha256_file',
                side_effect=lambda p: 'f' * 64 if Path(p).resolve() == exemptions_path else real_sha(p),
            ):
                self.assertIsNone(publish_to_blog._run_core_summary_node_replay(
                    {}, '豁免指纹测试摘要。', 'Exemption hash cache test source.', stage_replay=False,
                ))
            self.assertEqual(runner.call_count, 2)
            self.assertEqual(len(local_cache), 2)

    def test_publish_opencode_session_id_synchronizes_with_publish_common_global(self):
        orig_common = publish_common._PUBLISH_OPENCODE_SESSION_ID
        orig_client = publish_llm_client._PUBLISH_OPENCODE_SESSION_ID
        self.addCleanup(setattr, publish_common, '_PUBLISH_OPENCODE_SESSION_ID', orig_common)
        self.addCleanup(setattr, publish_llm_client, '_PUBLISH_OPENCODE_SESSION_ID', orig_client)

        publish_common._PUBLISH_OPENCODE_SESSION_ID = None
        publish_llm_client._PUBLISH_OPENCODE_SESSION_ID = 'standalone-client-sentinel'
        with mock.patch.dict(os.environ, {'PD_OPENCODE_SESSION_ID': ''}):
            generated = publish_common._publish_opencode_session_id()
            self.assertTrue(generated.startswith('audio-paper-digest-'))
            self.assertEqual(publish_common._PUBLISH_OPENCODE_SESSION_ID, generated)
            self.assertEqual(publish_common._publish_opencode_session_id(), generated)
            self.assertEqual(publish_llm_client._PUBLISH_OPENCODE_SESSION_ID, 'standalone-client-sentinel')

            publish_common._PUBLISH_OPENCODE_SESSION_ID = 'custom-session'
            self.assertEqual(publish_common._publish_opencode_session_id(), 'custom-session')

            publish_common._PUBLISH_OPENCODE_SESSION_ID = None
            regenerated = publish_common._publish_opencode_session_id()
            self.assertTrue(regenerated.startswith('audio-paper-digest-'))
            self.assertNotEqual(regenerated, 'custom-session')
            self.assertNotEqual(regenerated, generated)
            self.assertEqual(publish_common._PUBLISH_OPENCODE_SESSION_ID, regenerated)

            # Standalone call without hooks falls back to publish_llm_client module global
            self.assertEqual(publish_llm_client._publish_opencode_session_id(), 'standalone-client-sentinel')
            self.assertEqual(publish_common._PUBLISH_OPENCODE_SESSION_ID, regenerated)

    def test_publish_common_bound_llm_client_helpers_respect_direct_monkeypatches(self):
        with mock.patch.object(publish_common, 'reasoning_efforts_for', return_value=('low',)) as efforts_mock:
            self.assertEqual(
                publish_common.normalize_reasoning_effort('high', model='muse-spark-1.3-contributor'),
                '',
            )
            self.assertEqual(
                publish_common.normalize_reasoning_effort('low', model='muse-spark-1.3-contributor'),
                'low',
            )
        self.assertEqual(efforts_mock.call_count, 2)

        real_urlsplit = publish_common.urllib.parse.urlsplit
        fake_parse = mock.Mock()
        fake_parse.urlsplit.side_effect = real_urlsplit
        fake_urllib = types.SimpleNamespace(parse=fake_parse)
        with mock.patch.object(publish_common, 'urllib', fake_urllib):
            parsed = publish_common.validate_publish_api_endpoint_url('https://example.invalid/v1')
        self.assertEqual(parsed.hostname, 'example.invalid')
        fake_parse.urlsplit.assert_called_once_with('https://example.invalid/v1')


if __name__ == '__main__':
    unittest.main()
