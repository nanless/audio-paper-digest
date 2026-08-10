import os
import sys
import contextlib
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPTS = os.path.join(ROOT, 'scripts')
sys.path.insert(0, SCRIPTS)

from publish_common import (  # noqa: E402
    PublishLLMUnavailable,
    PublishDataValidationError,
    build_publish_headers,
    build_publish_payload,
    build_publish_api_url,
    build_paper_meta,
    dedupe_image_alts,
    detect_publish_api_type,
    EXPERIMENT_TABLE_CONTRACT_VERSION,
    METHOD_DETAIL_CONTRACT_VERSION,
    extract_markdown_tables,
    fix_empty_markdown_links,
    fix_yaml_unbalanced_quotes,
    get_today_bj,
    load_papers,
    paper_batch_date,
    call_publish_llm_api,
    count_blocking_review_issues,
    resolve_publish_parsed,
    sanitize_markdown_for_publish,
    select_blog_published_snapshot,
    strip_raw_inline_html,
    validate_papers_for_publish,
    validate_experiment_table_contract,
    validate_method_detail_contract,
    validate_review_payload,
)
from utils import parse_analysis  # noqa: E402


def complete_analysis():
    return '''## 评分
7.0/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前50%
confidence: 高

## 标签
#语音识别 #Transformer

## 评分理由
* 创新性 (1/2)：具体理由充分
* 技术严谨性 (1/1.5)：具体理由充分
* 实验充分性 (1/1.5)：具体理由充分
* 清晰度 (1/1)：具体理由充分
* 影响力 (1/1.5)：具体理由充分
* 开源 (0/1.5)：具体理由充分
* 可复现性 (0.5/0.5)：具体理由充分
* 工程/实践价值 (1.5/1.5)：具体理由充分
'''


def complete_paper():
    analysis = complete_analysis()
    return {
        'arxivId': '2607.00001',
        'analysis': analysis,
        'parsed': parse_analysis(analysis),
        'scoringRubricVersion': 'type-aware-v1',
    }


class PublishCommonSanitizerTest(unittest.TestCase):
    def test_shared_publish_date_validation_rejects_impossible_dates(self):
        self.assertEqual(get_today_bj('2026-07-13'), '2026-07-13')
        for value in ('2026-02-30', '2026-7-3', 'not-a-date'):
            with self.subTest(value=value), self.assertRaises(PublishDataValidationError):
                get_today_bj(value)

    def test_default_channel_snapshot_missing_manifest_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'missing-generation.json'
            with self.assertRaisesRegex(PublishDataValidationError, '缺少同日博客 generation manifest'):
                select_blog_published_snapshot(
                    [{'arxivId': '2607.00001'}],
                    '2026-07-13',
                    manifest_path=missing,
                )

    def test_type_aware_analysis_and_publish_meta(self):
        analysis = '''## 评分
6.0/10

## 机器摘要
document_type: tech report
rank_bucket: 前50%
confidence: 中

## 标签
#语音识别 #Transformer
'''
        parsed = parse_analysis(analysis)
        self.assertEqual(parsed['documentType'], '系统技术报告')
        self.assertEqual(parsed['scoringRubricVersion'], 'type-aware-v1')
        meta = build_paper_meta(parsed)
        self.assertIn('文档类型：系统技术报告', meta)
        self.assertIn('评分置信度：中', meta)

    def test_empty_links_and_duplicate_alts(self):
        text = '![图]()\n![same](a.png)\n![same](b.png)\n[空]()'
        fixed = dedupe_image_alts(fix_empty_markdown_links(text))
        self.assertIn('![图](image_not_available)', fixed)
        self.assertIn('![same](a.png)', fixed)
        self.assertIn('![same - 图2](b.png)', fixed)
        self.assertIn('空', fixed)
        self.assertNotIn('[空]()', fixed)

    def test_strip_raw_inline_html(self):
        self.assertEqual(strip_raw_inline_html('A <u>under</u> B'), 'A under B')
        self.assertEqual(strip_raw_inline_html('A <b>x</b> B'), 'A x B')

    def test_yaml_unbalanced_quotes(self):
        text = '---\ntitle: "Bad title\n---\nbody'
        fixed = fix_yaml_unbalanced_quotes(text)
        self.assertIn('title: "Bad title"', fixed)

    def test_sanitize_markdown_for_publish_combines_rules(self):
        text = '---\ntitle: "Bad\n---\n<u>x</u>\n![same](a.png)\n![same](b.png)\n[empty]()\n配�置'
        fixed = sanitize_markdown_for_publish(text)
        self.assertNotIn('<u>', fixed)
        self.assertIn('![same - 图2](b.png)', fixed)
        self.assertNotIn('[empty]()', fixed)
        self.assertIn('title: "Bad"', fixed)
        self.assertIn('配置', fixed)
        self.assertNotIn('�', fixed)

    def test_publish_llm_api_routing(self):
        self.assertEqual(
            detect_publish_api_type('https://token-plan-cn.xiaomimimo.com/v1', 'mimo-v2.5'),
            'anthropic'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://token-plan-cn.xiaomimimo.com/v1'),
            'https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.kimi.com/coding/v1', 'kimi-for-coding'),
            'anthropic'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.kimi.com/coding/', 'k3'),
            'anthropic'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://api.kimi.com/coding/v1'),
            'https://api.kimi.com/coding/v1/messages'
        )
        self.assertEqual(
            build_publish_api_url('anthropic', 'https://api.kimi.com/coding/'),
            'https://api.kimi.com/coding/v1/messages'
        )
        self.assertEqual(
            detect_publish_api_type('https://api.deepseek.com/anthropic', 'deepseek-chat'),
            'openai'
        )
        self.assertEqual(
            build_publish_api_url('openai', 'https://api.deepseek.com/anthropic'),
            'https://api.deepseek.com/v1/chat/completions'
        )

    def test_publish_anthropic_headers_include_claude_version(self):
        headers = build_publish_headers('anthropic', 'key', claude_version='9.8.7')
        self.assertEqual(headers['User-Agent'], 'claude-cli/9.8.7 (external, cli)')

    def test_publish_openai_headers_override_urllib_user_agent(self):
        headers = build_publish_headers('openai', 'key')
        self.assertEqual(headers['User-Agent'], 'audio-paper-digest/1.0')
        self.assertEqual(headers['Authorization'], 'Bearer key')

    def test_publish_multimodal_payload_preserves_protocol_routing(self):
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        anthropic = build_publish_payload(
            'anthropic', 'mimo', 'review', 100, 0.1, images=[image]
        )
        blocks = anthropic['messages'][0]['content']
        self.assertEqual(blocks[0]['type'], 'image')
        self.assertEqual(blocks[0]['source']['data'], 'cG5n')
        self.assertEqual(blocks[-1], {'type': 'text', 'text': 'review'})

        openai = build_publish_payload(
            'openai', 'gpt', 'review', 100, 0.1, images=[image]
        )
        blocks = openai['messages'][0]['content']
        self.assertEqual(blocks[0], {'type': 'text', 'text': 'review'})
        self.assertEqual(blocks[1]['type'], 'image_url')
        self.assertTrue(blocks[1]['image_url']['url'].startswith('data:image/png;base64,'))

    def test_secondary_publish_llm_uses_secondary_model_with_primary_endpoint_and_key_fallback(self):
        response = mock.Mock()
        response.status = 200
        response.read.return_value = b'{"choices":[{"message":{"content":"ok"}}]}'
        response.__enter__ = mock.Mock(return_value=response)
        response.__exit__ = mock.Mock(return_value=False)
        opener = mock.Mock()
        opener.open.return_value = response
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
            'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener):
            result = call_publish_llm_api(
                'inspect', required=True, use_secondary=True, max_retries=1,
                images=[{'media_type': 'image/png', 'data': 'cG5n'}],
            )
        self.assertEqual(result, 'ok')
        request = opener.open.call_args.args[0]
        payload = json.loads(request.data.decode('utf-8'))
        self.assertEqual(request.full_url, 'https://api.example.com/v1/chat/completions')
        self.assertEqual(request.get_header('Authorization'), 'Bearer primary-key')
        self.assertEqual(payload['model'], 'vision-model')

    def test_empty_length_response_adapts_output_budget_before_retry(self):
        first = mock.Mock()
        first.status = 200
        first.read.return_value = (
            b'{"choices":[{"message":{"content":"",'
            b'"reasoning_content":"hidden reasoning"},"finish_reason":"length"}]}'
        )
        first.__enter__ = mock.Mock(return_value=first)
        first.__exit__ = mock.Mock(return_value=False)

        second = mock.Mock()
        second.status = 200
        second.read.return_value = b'{"choices":[{"message":{"content":"{\\"passed\\":true}"}}]}'
        second.__enter__ = mock.Mock(return_value=second)
        second.__exit__ = mock.Mock(return_value=False)

        opener = mock.Mock()
        opener.open.side_effect = [first, second]
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'reasoning-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep'):
            result = call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=2,
            )

        self.assertEqual(result, '{"passed":true}')
        requests = [call.args[0] for call in opener.open.call_args_list]
        payloads = [json.loads(request.data.decode('utf-8')) for request in requests]
        self.assertEqual(payloads[0]['max_tokens'], 4000)
        self.assertEqual(payloads[1]['max_tokens'], 8000)

    def test_structured_reasoning_exhaustion_has_one_bounded_json_retry(self):
        responses = []
        for _index in range(2):
            response = mock.Mock()
            response.status = 200
            response.read.return_value = (
                b'{"choices":[{"message":{"content":"",'
                b'"reasoning_content":"hidden reasoning"},"finish_reason":"length"}]}'
            )
            response.__enter__ = mock.Mock(return_value=response)
            response.__exit__ = mock.Mock(return_value=False)
            responses.append(response)

        opener = mock.Mock()
        opener.open.side_effect = responses
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'reasoning-model',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.time.sleep') as sleep, \
                self.assertRaises(PublishLLMUnavailable):
            call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=5,
                structured_output=True,
            )

        self.assertEqual(opener.open.call_count, 2)
        requests = [call.args[0] for call in opener.open.call_args_list]
        payloads = [json.loads(request.data.decode('utf-8')) for request in requests]
        self.assertEqual([payload['max_tokens'] for payload in payloads], [4000, 8000])
        self.assertNotIn('立即停止展开推理', payloads[0]['messages'][0]['content'])
        self.assertIn('立即停止展开推理', payloads[1]['messages'][0]['content'])
        sleep.assert_not_called()

    def test_kimi_anthropic_reasoning_response_uses_same_bounded_json_retry(self):
        first = mock.Mock()
        first.status = 200
        first.read.return_value = (
            b'{"content":[{"type":"thinking","thinking":"hidden reasoning"}],'
            b'"stop_reason":"max_tokens"}'
        )
        first.__enter__ = mock.Mock(return_value=first)
        first.__exit__ = mock.Mock(return_value=False)

        second = mock.Mock()
        second.status = 200
        second.read.return_value = (
            b'{"content":[{"type":"text","text":"{\\"passed\\":true,\\"issues\\":[]}"}],'
            b'"stop_reason":"end_turn"}'
        )
        second.__enter__ = mock.Mock(return_value=second)
        second.__exit__ = mock.Mock(return_value=False)

        opener = mock.Mock()
        opener.open.side_effect = [first, second]
        env = {
            'PAPER_ANALYZER_API_KEY': 'key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.kimi.com/coding/v1',
            'PAPER_ANALYZER_MODEL': 'kimi-k2',
        }
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch('urllib.request.build_opener', return_value=opener), \
                mock.patch('publish_common.get_claude_code_version', return_value='9.8.7'), \
                mock.patch('publish_common.time.sleep') as sleep:
            result = call_publish_llm_api(
                'inspect', required=True, max_tokens=4000, max_retries=5,
                structured_output=True,
            )

        self.assertEqual(result, '{"passed":true,"issues":[]}')
        self.assertEqual(opener.open.call_count, 2)
        requests = [call.args[0] for call in opener.open.call_args_list]
        self.assertEqual(requests[0].full_url, 'https://api.kimi.com/coding/v1/messages')
        payloads = [json.loads(request.data.decode('utf-8')) for request in requests]
        self.assertEqual([payload['max_tokens'] for payload in payloads], [4000, 8000])
        self.assertIn('立即停止展开推理', payloads[1]['messages'][0]['content'])
        sleep.assert_not_called()

    def test_required_secondary_publish_llm_does_not_fallback_to_primary_model(self):
        env = {
            'PAPER_ANALYZER_API_KEY': 'primary-key',
            'PAPER_ANALYZER_ENDPOINT': 'https://api.example.com/v1',
            'PAPER_ANALYZER_MODEL': 'text-model',
        }
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaisesRegex(PublishLLMUnavailable, 'PAPER_ANALYZER_SECONDARY_MODEL'):
                call_publish_llm_api('inspect', required=True, use_secondary=True)

    def test_required_publish_llm_without_key_fails(self):
        names = ('PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_ENDPOINT', 'PAPER_ANALYZER_MODEL')
        old = {name: os.environ.get(name) for name in names}
        try:
            os.environ.pop('PAPER_ANALYZER_API_KEY', None)
            with self.assertRaises(PublishLLMUnavailable):
                call_publish_llm_api('hello', required=True, context='test')
        finally:
            for name, value in old.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_publish_llm_requires_endpoint_and_model_instead_of_using_foreign_defaults(self):
        names = ('PAPER_ANALYZER_API_KEY', 'PAPER_ANALYZER_ENDPOINT', 'PAPER_ANALYZER_MODEL')
        old = {name: os.environ.get(name) for name in names}
        try:
            os.environ['PAPER_ANALYZER_API_KEY'] = 'provider-specific-key'
            os.environ.pop('PAPER_ANALYZER_ENDPOINT', None)
            os.environ.pop('PAPER_ANALYZER_MODEL', None)
            with self.assertRaises(PublishLLMUnavailable) as raised:
                call_publish_llm_api('hello', required=True, context='test')
            self.assertIn('PAPER_ANALYZER_ENDPOINT', str(raised.exception))
            self.assertIn('PAPER_ANALYZER_MODEL', str(raised.exception))
        finally:
            for name, value in old.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_only_error_review_issues_block_publish(self):
        self.assertEqual(
            count_blocking_review_issues([
                {'severity': 'warning'},
                {'severity': 'info'},
                {'severity': 'error'}
            ]),
            1
        )
        self.assertEqual(count_blocking_review_issues(['代码层硬问题']), 1)

    def test_load_papers_accepts_object_or_list_and_rejects_bad_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            object_file = os.path.join(tmp, 'object.json')
            list_file = os.path.join(tmp, 'list.json')
            bad_file = os.path.join(tmp, 'bad.json')

            with open(object_file, 'w', encoding='utf-8') as f:
                json.dump({'papers': [{'arxivId': '2607.00001'}]}, f)
            with open(list_file, 'w', encoding='utf-8') as f:
                json.dump([{'arxivId': '2607.00002'}], f)
            with open(bad_file, 'w', encoding='utf-8') as f:
                json.dump({'papers': {'bad': True}}, f)

            with contextlib.redirect_stdout(io.StringIO()):
                object_papers = load_papers(object_file)
                list_papers = load_papers(list_file)
            self.assertEqual(object_papers[0]['arxivId'], '2607.00001')
            self.assertEqual(list_papers[0]['arxivId'], '2607.00002')
            with self.assertRaises(ValueError):
                load_papers(bad_file)

    def test_paper_batch_date_prefers_immutable_batch_and_validates_legacy_timestamp(self):
        self.assertEqual(
            paper_batch_date({
                'arxivId': '2607.00001',
                'fetchBatchDate': '2026-07-13',
                'fetchedAt': '2026-07-14T00:00:00.000+08:00',
            }),
            '2026-07-13',
        )
        self.assertEqual(
            paper_batch_date({'fetchedAt': '2026-07-13T10:00:00.000+08:00'}),
            '2026-07-13',
        )
        with self.assertRaisesRegex(PublishDataValidationError, '严格北京时间戳'):
            paper_batch_date({'arxivId': 'bad', 'fetchedAt': '2026-07-13T02:00:00.000Z'})

    def test_publish_preflight_requires_complete_consistent_scoring(self):
        paper = complete_paper()
        validated = validate_papers_for_publish([paper])
        self.assertEqual(validated[0]['parsed']['score'], '7.0')
        self.assertEqual(validated[0]['parsed']['tags'], ['#语音识别', '#Transformer'])

        incomplete = copy.deepcopy(paper)
        incomplete['parsed'].pop('engineeringScore')
        with self.assertRaisesRegex(PublishDataValidationError, 'engineeringScore'):
            resolve_publish_parsed(incomplete)

    def test_publish_preflight_rejects_partial_scoring_reason(self):
        paper = complete_paper()
        paper['analysis'] = paper['analysis'].replace('* 工程/实践价值 (1.5/1.5)：具体理由充分\n', '')
        with self.assertRaisesRegex(PublishDataValidationError, '评分维度|工程/实践价值'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_rejects_dimension_without_reason(self):
        paper = complete_paper()
        paper['analysis'] = paper['analysis'].replace('* 创新性 (1/2)：具体理由充分', '* 创新性 (1/2)')
        with self.assertRaisesRegex(PublishDataValidationError, '创新性.*缺少具体评分理由'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_requires_explicit_manual_override_provenance(self):
        paper = complete_paper()
        paper['parsed']['engineeringScore'] = '1'
        paper['parsed']['score'] = '6.5'
        with self.assertRaisesRegex(PublishDataValidationError, 'parsedOverride'):
            resolve_publish_parsed(paper)

        paper['parsedOverride'] = {
            'type': 'manual',
            'source': 'editor:francis/review-2026-07-10',
            'reason': '人工复核后调整工程价值',
            'fields': ['engineeringScore', 'score'],
        }
        parsed = resolve_publish_parsed(paper)
        self.assertEqual(parsed['score'], '6.5')

    def test_publish_baseline_ignores_stale_cached_body_fields(self):
        paper = complete_paper()
        paper['parsed']['summary'] = '陈旧摘要不得发布'
        paper['parsed']['tags'] = {'invalid': '陈旧标签缓存也必须被忽略'}
        paper['parsed']['results'] = '陈旧实验结果'
        parsed = resolve_publish_parsed(paper)
        self.assertNotEqual(parsed.get('summary'), '陈旧摘要不得发布')
        self.assertEqual(parsed['tags'], ['#语音识别', '#Transformer'])
        self.assertNotEqual(parsed.get('results'), '陈旧实验结果')

    def test_manual_override_rejects_unknown_metadata_and_non_scoring_fields(self):
        paper = complete_paper()
        paper['parsed']['summary'] = '人工摘要'
        paper['parsedOverride'] = {
            'type': 'manual',
            'source': 'editor:test',
            'reason': 'test',
            'fields': ['summary'],
        }
        with self.assertRaisesRegex(PublishDataValidationError, '不允许覆盖'):
            resolve_publish_parsed(paper)

        paper = complete_paper()
        paper['parsed']['score'] = '6.5'
        paper['parsed']['engineeringScore'] = '1'
        paper['parsedOverride'] = {
            'type': 'manual',
            'source': 'editor:test',
            'reason': 'test',
            'fields': ['score', 'engineeringScore'],
            'unknown': True,
        }
        with self.assertRaisesRegex(PublishDataValidationError, '未知字段'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_requires_matching_top_level_version(self):
        paper = complete_paper()
        paper['scoringRubricVersion'] = 'legacy'
        with self.assertRaisesRegex(PublishDataValidationError, '顶层 scoringRubricVersion'):
            resolve_publish_parsed(paper)

    def test_publish_preflight_rejects_duplicate_normalized_arxiv_ids(self):
        first = complete_paper()
        first['arxivId'] = 'https://arxiv.org/abs/2607.00001v2'
        second = complete_paper()
        second['arxivId'] = 'arXiv:2607.00001'
        with self.assertRaisesRegex(PublishDataValidationError, '重复 normalized arXiv ID 2607.00001'):
            validate_papers_for_publish([first, second])

    def test_publish_preflight_blocks_unapproved_abstract_fallback_and_latest_failure(self):
        paper = complete_paper()
        paper['analysisSource'] = 'abstract'
        with self.assertRaisesRegex(PublishDataValidationError, '仅基于摘要分析'):
            validate_papers_for_publish([paper])

        paper['allowAbstractAnalysisPublish'] = True
        self.assertEqual(len(validate_papers_for_publish([paper])), 1)

        paper = complete_paper()
        paper['latestAnalysisAttemptError'] = '全文重分析失败'
        with self.assertRaisesRegex(PublishDataValidationError, '最新一次深度分析失败'):
            validate_papers_for_publish([paper])

    def test_publish_preflight_rejects_present_but_incomplete_analysis_manifest(self):
        paper = complete_paper()
        complete_statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        paper['analysisManifest'] = {
            'version': 1,
            'stages': {name: {'status': status} for name, status in complete_statuses.items()},
        }
        self.assertEqual(len(validate_papers_for_publish([paper])), 1)
        paper['analysisManifest']['stages']['scoringAudit']['status'] = 'transient_failure'
        with self.assertRaisesRegex(PublishDataValidationError, 'scoringAudit'):
            validate_papers_for_publish([paper])

    def test_versioned_publish_preflight_enforces_bounded_experiment_tables(self):
        headers = ['方法', '数据集'] + [f'M{i}' for i in range(1, 9)]
        separator = ['---'] * len(headers)
        rows = [
            [f'Model {i}', 'test'] + [str(i + j) for j in range(8)]
            for i in range(13)
        ]
        table = '\n'.join(
            f"| {' | '.join(row)} |" for row in [headers, separator, *rows]
        )
        paper = complete_paper()
        paper['analysis'] += f'\n\n## 实验结果\n{table}\n'
        paper['parsed'] = parse_analysis(paper['analysis'])
        statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        paper['analysisManifest'] = {
            'version': 1,
            'contracts': {'experimentTables': EXPERIMENT_TABLE_CONTRACT_VERSION},
            'stages': {name: {'status': status} for name, status in statuses.items()},
        }

        self.assertEqual(len(extract_markdown_tables(table)), 1)
        self.assertEqual(len(extract_markdown_tables(f'```markdown\n{table}\n```')), 0)
        self.assertRegex(validate_experiment_table_contract(paper['analysis']), '13 个数据行')
        with self.assertRaisesRegex(PublishDataValidationError, '表格契约无效'):
            validate_papers_for_publish([paper])

        legacy = copy.deepcopy(paper)
        del legacy['analysisManifest']['contracts']
        self.assertEqual(len(validate_papers_for_publish([legacy])), 1)

        mismatch = '| 方法 | 指标 |\n| --- | --- |\n| A | 1 | 多余 |'
        self.assertRegex(validate_experiment_table_contract(
            paper['analysis'].replace(table, mismatch)
        ), '数据行有 3 列')
        one_cell = '| 方法 | 指标 |\n| --- | --- |\n| only |'
        self.assertRegex(validate_experiment_table_contract(
            paper['analysis'].replace(table, one_cell)
        ), '数据行有 1 列')

    def test_versioned_publish_preflight_enforces_detailed_method_contract(self):
        paper = complete_paper()
        self.assertRegex(validate_method_detail_contract(paper['analysis']), '中文字符不足')
        statuses = {
            'imageDownload': 'complete', 'primaryAnalysis': 'complete',
            'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
            'revision': 'complete', 'tableRepair': 'not_needed',
            'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
            'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
        }
        paper['analysisManifest'] = {
            'version': 1,
            'contracts': {'methodDetail': METHOD_DETAIL_CONTRACT_VERSION},
            'stages': {name: {'status': status} for name, status in statuses.items()},
        }
        with self.assertRaisesRegex(PublishDataValidationError, '方法契约无效'):
            validate_papers_for_publish([paper])

    def test_required_review_payload_fails_closed_on_malformed_contract(self):
        for payload in (
            [],
            {'issues': []},
            {'passed': True},
            {'passed': True, 'issues': [{'severity': 'critical', 'description': 'bad'}]},
            {'passed': False, 'issues': [{'severity': 'warning', 'description': 'unclear'}]},
            {'passed': True, 'issues': [{'severity': 'info', 'description': '无法判断图片是否正确'}]},
        ):
            passed, issues = validate_review_payload(payload, required=True, context='test')
            self.assertFalse(passed)
            self.assertEqual(count_blocking_review_issues(issues), 1)

    def test_required_review_payload_accepts_valid_warning(self):
        passed, issues = validate_review_payload({
            'passed': True,
            'issues': [{'severity': 'warning', 'description': 'style'}],
        }, required=True, context='test')
        self.assertTrue(passed)
        self.assertEqual(count_blocking_review_issues(issues), 0)

    def test_non_auto_fixable_issue_may_omit_empty_fix_instruction(self):
        passed, issues = validate_review_payload({
            'passed': False,
            'issues': [{
                'severity': 'error',
                'type': 'content',
                'description': '图片与正文论点不匹配',
                'auto_fixable': False,
            }],
        }, required=True, context='test', issue_fields=('type', 'auto_fixable', 'fix_instruction'))
        self.assertFalse(passed)
        self.assertEqual(issues[0]['fix_instruction'], '')

    def test_publish_score_keeps_one_decimal_place(self):
        paper = complete_paper()
        paper['analysis'] = paper['analysis'].replace('7.0/10', '6.0/10').replace(
            '工程/实践价值 (1.5/1.5)',
            '工程/实践价值 (0.5/1.5)',
        )
        paper['parsed'] = parse_analysis(paper['analysis'])
        paper['scoringRubricVersion'] = paper['parsed']['scoringRubricVersion']
        resolved = resolve_publish_parsed(paper)
        self.assertEqual(resolved['score'], '6.0')

    def test_publish_rejects_multi_decimal_and_non_anchor_scores(self):
        paper = complete_paper()
        paper['parsed'] = copy.deepcopy(paper['parsed'])
        paper['parsed']['innovationScore'] = 1.01
        with self.assertRaisesRegex(PublishDataValidationError, '最多只能有一位小数'):
            validate_papers_for_publish([paper])

        paper = complete_paper()
        paper['parsed'] = copy.deepcopy(paper['parsed'])
        paper['parsed']['openSourceScore'] = 0.7
        paper['parsed']['score'] = 7.7
        paper['parsedOverride'] = {
            'type': 'manual_scoring_correction',
            'source': '人工复核论文正文',
            'reason': '根据公开资源状态修正评分字段',
            'fields': ['openSourceScore', 'score'],
        }
        with self.assertRaisesRegex(PublishDataValidationError, '固定锚点集合'):
            validate_papers_for_publish([paper])

    def test_build_paper_meta_deduplicates_equal_primary_tags(self):
        meta = build_paper_meta({
            'score': '6.0',
            'primaryTaskTag': '#多模态模型',
            'primaryMethodTag': '#多模态模型',
            'tags': ['#多模态模型', '#数据集'],
        })
        self.assertEqual(meta.count('#多模态模型'), 1)
        self.assertEqual(meta.count('#数据集'), 1)


if __name__ == '__main__':
    unittest.main()
