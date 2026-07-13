import importlib.util
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
sys.path.insert(0, str(SCRIPTS))


def load_script():
    path = SCRIPTS / 'publish-xiaohongshu.py'
    spec = importlib.util.spec_from_file_location('publish_xiaohongshu_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publish_xiaohongshu = load_script()


class PublishXiaohongshuConcurrencyTest(unittest.TestCase):
    def test_oneliner_removes_conflicting_open_source_claim(self):
        self.assertEqual(
            publish_xiaohongshu.sanitize_oneliner_claims(
                '跨语言泛化超强，代码已开源！', {'hasCode': '否'},
            ),
            '跨语言泛化超强。',
        )
        self.assertEqual(
            publish_xiaohongshu.sanitize_oneliner_claims(
                '跨语言泛化超强，代码已开源！', {'hasCode': '是'},
            ),
            '跨语言泛化超强，代码已开源！',
        )
        self.assertEqual(
            publish_xiaohongshu.sanitize_oneliner_claims(
                '性能领先，模型权重已公开，数据集已发布！',
                {'hasModel': '否', 'hasDataset': ''},
            ),
            '性能领先。',
        )

    def test_open_source_badge_distinguishes_unknown_from_explicit_no(self):
        self.assertEqual(
            publish_xiaohongshu.format_oss_badge({}),
            '📦 开源：未说明',
        )
        self.assertEqual(
            publish_xiaohongshu.format_oss_badge(
                {'hasCode': '否', 'hasModel': '否', 'hasDataset': '否'},
            ),
            '📦 开源：❌未开源',
        )
        self.assertEqual(
            publish_xiaohongshu.format_oss_badge({'hasModel': '是'}),
            '📦 开源：✅模型',
        )

    def test_safe_oneliner_rejects_content_left_empty_after_sanitizing(self):
        self.assertIsNone(
            publish_xiaohongshu.safe_oneliner(
                '- 代码已经开源！', {'hasCode': '否'},
            ),
        )

    def test_oneliner_context_includes_structured_open_source_truth(self):
        context = publish_xiaohongshu.build_oneliner_context(
            '标题', '摘要正文', {'hasCode': '是', 'hasModel': '否'},
        )
        self.assertIn('摘要：摘要正文', context)
        self.assertIn('代码=已公开；模型=未公开；数据集=未说明', context)

    def test_oneliner_concurrency_defaults_and_bounds(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PD_XIAOHONGSHU_ONELINER_CONCURRENCY', None)
            self.assertEqual(publish_xiaohongshu.get_oneliner_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_XIAOHONGSHU_ONELINER_CONCURRENCY': '1'}):
            self.assertEqual(publish_xiaohongshu.get_oneliner_concurrency(), 1)
        with mock.patch.dict(os.environ, {'PD_XIAOHONGSHU_ONELINER_CONCURRENCY': '4'}):
            self.assertEqual(publish_xiaohongshu.get_oneliner_concurrency(), 4)
        with mock.patch.dict(os.environ, {'PD_XIAOHONGSHU_ONELINER_CONCURRENCY': '5'}):
            self.assertEqual(publish_xiaohongshu.get_oneliner_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_XIAOHONGSHU_ONELINER_CONCURRENCY': '99'}):
            self.assertEqual(publish_xiaohongshu.get_oneliner_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_XIAOHONGSHU_ONELINER_CONCURRENCY': '0'}):
            self.assertEqual(publish_xiaohongshu.get_oneliner_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_XIAOHONGSHU_ONELINER_CONCURRENCY': 'bad'}):
            self.assertEqual(publish_xiaohongshu.get_oneliner_concurrency(), 5)

    def test_empty_batch_does_not_create_executor_or_call_api(self):
        with mock.patch.object(publish_xiaohongshu.concurrent.futures, 'ThreadPoolExecutor') as executor, \
                mock.patch.object(publish_xiaohongshu, 'call_llm_for_oneliner') as call:
            self.assertEqual(publish_xiaohongshu.generate_llm_oneliners([]), {})
        executor.assert_not_called()
        call.assert_not_called()

    def test_oneliners_run_concurrently_and_keep_rank_indexes(self):
        active = 0
        peak = 0
        lock = threading.Lock()
        delays = {'A': 0.06, 'B': 0.01, 'C': 0.03}

        def generate(title, _abstract, _parsed):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(delays[title])
            with lock:
                active -= 1
            return f'{title}-亮点'

        papers = [
            (9.0, {'title': title, 'abstract': ''}, {})
            for title in ('A', 'B', 'C')
        ]
        with mock.patch.object(publish_xiaohongshu, 'get_oneliner_concurrency', return_value=3), \
                mock.patch.object(publish_xiaohongshu, 'call_llm_for_oneliner', side_effect=generate):
            results = publish_xiaohongshu.generate_llm_oneliners(papers)

        self.assertGreater(peak, 1)
        self.assertLessEqual(peak, 3)
        self.assertEqual(results, {0: 'A-亮点', 1: 'B-亮点', 2: 'C-亮点'})

    def test_oneliner_exception_is_redacted_and_other_results_survive(self):
        papers = [
            (9.0, {'title': title, 'abstract': ''}, {})
            for title in ('A', 'B', 'C')
        ]

        def generate(title, _abstract, _parsed):
            if title == 'B':
                raise RuntimeError('secret-token-must-not-appear')
            return None if title == 'C' else f'{title}-亮点'

        output = io.StringIO()
        with mock.patch.object(publish_xiaohongshu, 'get_oneliner_concurrency', return_value=2), \
                mock.patch.object(publish_xiaohongshu, 'call_llm_for_oneliner', side_effect=generate), \
                contextlib.redirect_stdout(output):
            results = publish_xiaohongshu.generate_llm_oneliners(papers)

        self.assertEqual(results, {0: 'A-亮点'})
        self.assertNotIn('secret-token-must-not-appear', output.getvalue())
        self.assertIn('第 2 名：调用异常', output.getvalue())
        self.assertIn('第 3 名：LLM 无可用结果', output.getvalue())

    def test_successful_oneliner_cache_is_reused_without_api_call(self):
        papers = [(9.0, {
            'arxivId': '2607.00001', 'title': 'A', 'abstract': '摘要', 'analysis': '分析一',
        }, {})]
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            with mock.patch.object(
                publish_xiaohongshu, 'call_llm_for_oneliner',
                return_value='这是第一篇论文足够完整的一句话亮点。',
            ) as call:
                first = publish_xiaohongshu.generate_llm_oneliners(
                    papers, date_str='2026-07-13', cache_path=cache_path,
                )
                second = publish_xiaohongshu.generate_llm_oneliners(
                    papers, date_str='2026-07-13', cache_path=cache_path,
                )
        self.assertEqual(first, second)
        self.assertEqual(call.call_count, 1)

    def test_fallback_cache_entry_is_retried_next_run(self):
        papers = [(9.0, {
            'arxivId': '2607.00002', 'title': 'B', 'abstract': '摘要', 'analysis': '分析二',
        }, {})]
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            with mock.patch.object(
                publish_xiaohongshu, 'call_llm_for_oneliner',
                side_effect=[None, '第二次生成成功且内容足够完整可用。'],
            ) as call:
                first = publish_xiaohongshu.generate_llm_oneliners(
                    papers, date_str='2026-07-13', cache_path=cache_path,
                )
                second = publish_xiaohongshu.generate_llm_oneliners(
                    papers, date_str='2026-07-13', cache_path=cache_path,
                )
            saved = json.loads(cache_path.read_text(encoding='utf-8'))
        self.assertEqual(first, {})
        self.assertEqual(second, {0: '第二次生成成功且内容足够完整可用。'})
        self.assertEqual(call.call_count, 2)
        self.assertEqual(saved['entries']['2607.00002']['status'], 'success')

    def test_analysis_change_invalidates_only_matching_oneliner(self):
        papers = [
            (9.0, {'arxivId': '2607.00003', 'title': 'A', 'analysis': '旧分析'}, {}),
            (8.0, {'arxivId': '2607.00004', 'title': 'B', 'analysis': '稳定分析'}, {}),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            with mock.patch.object(
                publish_xiaohongshu, 'call_llm_for_oneliner',
                side_effect=['论文A第一次生成的完整亮点。', '论文B第一次生成的完整亮点。'],
            ):
                publish_xiaohongshu.generate_llm_oneliners(
                    papers, date_str='2026-07-13', cache_path=cache_path,
                )
            papers[0][1]['analysis'] = '新分析'
            with mock.patch.object(
                publish_xiaohongshu, 'call_llm_for_oneliner',
                return_value='论文A分析变化后重新生成亮点。',
            ) as call:
                result = publish_xiaohongshu.generate_llm_oneliners(
                    papers, date_str='2026-07-13', cache_path=cache_path,
                )
        self.assertEqual(call.call_count, 1)
        self.assertEqual(result[0], '论文A分析变化后重新生成亮点。')
        self.assertEqual(result[1], '论文B第一次生成的完整亮点。')

    def test_completed_entry_survives_later_worker_failure(self):
        papers = [
            (9.0, {'arxivId': '2607.00005', 'title': 'A', 'analysis': '分析A'}, {}),
            (8.0, {'arxivId': '2607.00006', 'title': 'B', 'analysis': '分析B'}, {}),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            with mock.patch.object(publish_xiaohongshu, 'get_oneliner_concurrency', return_value=1), \
                    mock.patch.object(
                        publish_xiaohongshu, 'call_llm_for_oneliner',
                        side_effect=['论文A成功结果会立即持久保存。', RuntimeError('temporary')],
                    ):
                result = publish_xiaohongshu.generate_llm_oneliners(
                    papers, date_str='2026-07-13', cache_path=cache_path,
                )
            saved = json.loads(cache_path.read_text(encoding='utf-8'))
        self.assertEqual(result, {0: '论文A成功结果会立即持久保存。'})
        self.assertEqual(saved['entries']['2607.00005']['status'], 'success')
        self.assertEqual(saved['entries']['2607.00006']['status'], 'error')

    def test_cached_oneliner_is_sanitized_again_before_reuse(self):
        paper = {'arxivId': '2607.00007', 'title': 'A', 'analysis': '分析', 'abstract': '摘要'}
        parsed = {'hasCode': '否'}
        fingerprint = publish_xiaohongshu.build_oneliner_fingerprint(paper, parsed)
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            cache_path.write_text(json.dumps({
                'schemaVersion': 1,
                'date': '2026-07-13',
                'entries': {
                    '2607.00007': {
                        **fingerprint,
                        'status': 'success',
                        'oneliner': '- 核心方法显著提升跨域效果，代码已经开源！\n结果稳定。',
                    },
                },
            }, ensure_ascii=False), encoding='utf-8')
            with mock.patch.object(publish_xiaohongshu, 'call_llm_for_oneliner') as call:
                result = publish_xiaohongshu.generate_llm_oneliners(
                    [(9.0, paper, parsed)], date_str='2026-07-13', cache_path=cache_path,
                )
        call.assert_not_called()
        self.assertNotIn('开源', result[0])
        self.assertNotIn('\n', result[0])

    def test_malformed_single_cache_entry_only_regenerates_that_paper(self):
        paper = {'arxivId': '2607.00008', 'title': 'A', 'analysis': '分析'}
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            cache_path.write_text(json.dumps({
                'schemaVersion': 1, 'date': '2026-07-13',
                'entries': {'2607.00008': 'broken-entry'},
            }), encoding='utf-8')
            with mock.patch.object(
                publish_xiaohongshu, 'call_llm_for_oneliner',
                return_value='损坏缓存只影响当前论文并重新生成。',
            ) as call:
                result = publish_xiaohongshu.generate_llm_oneliners(
                    [(9.0, paper, {})], date_str='2026-07-13', cache_path=cache_path,
                )
        self.assertEqual(call.call_count, 1)
        self.assertEqual(result, {0: '损坏缓存只影响当前论文并重新生成。'})

    def test_corrupt_cache_is_quarantined_and_rebuilt(self):
        paper = {'arxivId': '2607.00010', 'title': 'A', 'analysis': '分析'}
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            cache_path.write_text('{broken', encoding='utf-8')
            with mock.patch.object(
                publish_xiaohongshu, 'call_llm_for_oneliner',
                return_value='损坏派生缓存隔离后重新生成成功。',
            ):
                result = publish_xiaohongshu.generate_llm_oneliners(
                    [(9.0, paper, {})], date_str='2026-07-13', cache_path=cache_path,
                )
            quarantined = list(Path(tmp).glob('cache.json.corrupt-*'))
            rebuilt = json.loads(cache_path.read_text(encoding='utf-8'))
        self.assertEqual(result, {0: '损坏派生缓存隔离后重新生成成功。'})
        self.assertEqual(len(quarantined), 1)
        self.assertEqual(rebuilt['entries']['2607.00010']['status'], 'success')

    def test_stale_cache_write_cannot_replace_newer_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache_path = Path(tmp) / 'cache.json'
            newer = {
                'analysisSha256': 'b' * 64,
                'promptSha256': 'c' * 64,
                'configSha256': 'd' * 64,
                'model': 'new-model',
                'renderContractVersion': 1,
                'status': 'success',
                'oneliner': '更新的成功结果',
            }
            cache_path.write_text(json.dumps({
                'schemaVersion': 1, 'date': '2026-07-13',
                'entries': {'2607.00011': newer},
            }), encoding='utf-8')
            wrote = publish_xiaohongshu._save_oneliner_cache_entry(
                cache_path, '2026-07-13', '2607.00011',
                {'analysisSha256': 'a' * 64}, 'fallback', None,
                expected_entry=None,
            )
            saved = json.loads(cache_path.read_text(encoding='utf-8'))
        self.assertFalse(wrote)
        self.assertEqual(saved['entries']['2607.00011'], newer)

    def test_main_rejects_invalid_date_before_loading_data(self):
        with mock.patch.object(sys, 'argv', ['publish-xiaohongshu.py', '--date', '/../../escape']), \
                mock.patch.object(publish_xiaohongshu, 'load_papers') as load:
            with self.assertRaises(ValueError):
                publish_xiaohongshu.main()
        load.assert_not_called()

    def test_cache_write_failure_does_not_discard_successful_llm_result(self):
        paper = {'arxivId': '2607.00009', 'title': 'A', 'analysis': '分析'}
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(
                    publish_xiaohongshu, 'call_llm_for_oneliner',
                    return_value='缓存失败也保留本轮已经成功生成的结果。',
                ), \
                mock.patch.object(
                    publish_xiaohongshu, '_save_oneliner_cache_entry',
                    side_effect=OSError('disk full'),
                ):
            result = publish_xiaohongshu.generate_llm_oneliners(
                [(9.0, paper, {})], date_str='2026-07-13',
                cache_path=Path(tmp) / 'cache.json',
            )
        self.assertEqual(result, {0: '缓存失败也保留本轮已经成功生成的结果。'})

    def test_top_post_keeps_rank_order_and_falls_back_per_paper(self):
        papers = [
            (9.0, {'title': '第一篇'}, {'summary': '第一篇本地摘要足够长用于安全回退。'}),
            (8.0, {'title': '第二篇'}, {'summary': '第二篇本地摘要足够长用于安全回退。'}),
            (7.0, {'title': '第三篇'}, {'summary': '第三篇本地摘要足够长用于安全回退。'}),
        ]
        with mock.patch.object(
            publish_xiaohongshu, 'generate_llm_oneliners', return_value={1: '第二篇模型亮点足够完整。'},
        ):
            result = publish_xiaohongshu.generate_top_n_post(papers, [], '2026-07-13', 3)

        self.assertLess(result.index('第一篇'), result.index('第二篇'))
        self.assertLess(result.index('第二篇'), result.index('第三篇'))
        self.assertIn('第一篇本地摘要足够长用于安全回退', result)
        self.assertIn('第二篇模型亮点足够完整', result)
        self.assertIn('第三篇本地摘要足够长用于安全回退', result)

    def test_main_validates_before_scoring_and_uses_atomic_write(self):
        paper = {'arxivId': '2607.00001', 'fetchedAt': '2026-07-13T08:00:00+08:00'}
        validated = dict(paper, parsed={'score': 8.0})
        with mock.patch.object(sys, 'argv', ['publish-xiaohongshu.py', '--date', '2026-07-13']), \
                mock.patch.object(publish_xiaohongshu, 'load_papers', return_value=[paper]), \
                mock.patch.object(publish_xiaohongshu, 'validate_papers_for_publish', return_value=[validated]) as validate, \
                mock.patch.object(publish_xiaohongshu, 'score_and_sort', return_value=([], [])) as score, \
                mock.patch.object(publish_xiaohongshu, 'generate_top_n_post', return_value='文案'), \
                mock.patch.object(publish_xiaohongshu, 'xiaohongshu_markdown_path', return_value=Path('/tmp/xhs.md')), \
                mock.patch.object(publish_xiaohongshu, 'atomic_write_text') as atomic, \
                mock.patch.object(publish_xiaohongshu, 'file_lock', return_value=contextlib.nullcontext()), \
                contextlib.redirect_stdout(io.StringIO()):
            publish_xiaohongshu.main()

        validate.assert_called_once_with([paper])
        score.assert_called_once_with([validated])
        atomic.assert_called_once_with(Path('/tmp/xhs.md'), '文案')


if __name__ == '__main__':
    unittest.main()
