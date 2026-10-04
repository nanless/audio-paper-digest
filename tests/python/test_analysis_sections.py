import copy
import hashlib
import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))

from analysis_sections import (  # noqa: E402
    analysis_heading_titles,
    evaluation_heading_issue,
    extract_evaluation_section,
    find_evaluation_headings,
)
from publish_common import (  # noqa: E402
    PublishDataValidationError,
    resolve_publish_parsed,
    validate_papers_for_publish,
    _manual_v4_reader_view,
    validate_manual_editorial_quality_v4,
)
from test_publish_common import complete_paper  # noqa: E402
from utils import parse_analysis  # noqa: E402


class EvaluationSectionTest(unittest.TestCase):
    def test_old_and_new_titles_parse_the_same_fields_without_rewriting_input(self):
        paper = complete_paper()
        old_analysis = paper['analysis'] + '\n## 毒舌点评\n证据充分，但部署范围尚有限。\n'
        old_bytes = old_analysis.encode()
        old_sha = hashlib.sha256(old_bytes).hexdigest()
        new_analysis = old_analysis.replace('## 毒舌点评\n', '## 论文评价\n')
        self.assertEqual(parse_analysis(old_analysis), parse_analysis(new_analysis))
        self.assertEqual(parse_analysis(old_analysis)['roast'], '证据充分，但部署范围尚有限。')
        self.assertEqual(old_analysis.encode(), old_bytes)
        self.assertEqual(hashlib.sha256(old_analysis.encode()).hexdigest(), old_sha)

    def test_cached_parsed_data_cannot_bypass_mixed_or_empty_duplicate_sections(self):
        paper = complete_paper()
        valid_analysis = paper['analysis'] + '\n## 论文评价\n贡献明确。\n'
        paper['analysis'] = valid_analysis
        paper['parsed'] = parse_analysis(valid_analysis)
        self.assertIsNotNone(resolve_publish_parsed(paper))
        for title in ('论文评价', '毒舌点评'):
            for body in ('', '另一段评价。'):
                with self.subTest(title=title, body=body):
                    changed = copy.deepcopy(paper)
                    changed['analysis'] += f'\n## {title}\n{body}\n'
                    self.assertIsNone(parse_analysis(changed['analysis']))
                    with self.assertRaisesRegex(PublishDataValidationError, '论文评价章节重复'):
                        resolve_publish_parsed(changed)
                    with self.assertRaisesRegex(PublishDataValidationError, '论文评价章节重复'):
                        validate_papers_for_publish([changed])

    def test_missing_section_keeps_soft_parsing_and_non_headings_do_not_count(self):
        analysis = complete_paper()['analysis']
        self.assertIsNotNone(parse_analysis(analysis))
        self.assertEqual(parse_analysis(analysis)['roast'], '')
        examples = ('普通句子提到论文评价。\n', '### 论文评价\n不是一级槽。\n',
                    '```markdown\n## 毒舌点评\n## 论文评价\n```\n',
                    '~~~\n## 论文评价\n~~~\n')
        for example in examples:
            with self.subTest(example=example):
                text = analysis + '\n' + example + '\n## 论文评价\n真实评价。\n'
                self.assertIsNone(evaluation_heading_issue(text))
                self.assertEqual(extract_evaluation_section(text), '真实评价。')
                self.assertIsNotNone(parse_analysis(text))

    def test_complete_titles_and_single_colon_share_one_slot(self):
        for title in ('论文评价', '毒舌点评'):
            for suffix in ('', ':', '：'):
                with self.subTest(title=title, suffix=suffix):
                    self.assertEqual(extract_evaluation_section(f'## {title}{suffix}\n正文。'), '正文。')
        for line in ('## 论文评价：附注', '## 论文评价::', '## 论文评价拓展'):
            self.assertEqual(find_evaluation_headings(line), [])

    def test_titles_without_spaces_use_the_same_extraction_boundary(self):
        text = '##论文评价\n评价。\n##核心摘要\n摘要。'
        self.assertEqual(extract_evaluation_section(text), '评价。')
        self.assertEqual(parse_analysis(text)['roast'], '评价。')

    def test_unicode_space_titles_have_the_same_identity_count_and_body(self):
        for spaces in ('', ' ', '\t', '\u3000', '\u00a0'):
            for ending in ('\n', '\r\n'):
                with self.subTest(spaces=spaces, ending=ending):
                    old_text = f'##{spaces}毒舌点评{spaces}：{spaces}{ending}评价。{ending}##核心摘要{ending}摘要。'
                    new_text = old_text.replace('毒舌点评', '论文评价')
                    self.assertEqual(parse_analysis(old_text), parse_analysis(new_text))
                    self.assertEqual(extract_evaluation_section(new_text), '评价。')
                    self.assertEqual(analysis_heading_titles(new_text), ['论文评价', '核心摘要'])
                    mixed = new_text + f'{ending}##{spaces}毒舌点评{ending}'
                    self.assertIsNone(parse_analysis(mixed))
                    self.assertIsNotNone(evaluation_heading_issue(mixed))

    def test_visible_heading_index_does_not_accept_a_fenced_missing_section(self):
        analysis = '## 评分\n7\n```md\n## 论文评价\n```\n## 核心摘要\n摘要。'
        self.assertEqual(analysis_heading_titles(analysis), ['评分', '核心摘要'])

    def test_manual_reader_view_uses_alias_only_in_validation_copy(self):
        old_page = '### 💬 毒舌点评\n\n证据明确，但部署范围有限。\n'
        new_page = old_page.replace('毒舌点评', '论文评价')
        original_bytes = old_page.encode()
        self.assertEqual(_manual_v4_reader_view(old_page), _manual_v4_reader_view(new_page))
        self.assertEqual(validate_manual_editorial_quality_v4(_manual_v4_reader_view(old_page)),
                         validate_manual_editorial_quality_v4(_manual_v4_reader_view(new_page)))
        self.assertEqual(old_page.encode(), original_bytes)

    def test_rendered_aliases_keep_original_body_and_detect_conflicts(self):
        for title in ('论文评价', '毒舌点评'):
            for heading in (f'### 💡 {title}', f'## 💬 {title}', f'💡 **{title}**'):
                with self.subTest(heading=heading):
                    content = heading + '\n\n原点评。\n\n📌 **核心摘要**\n\n摘要。'
                    self.assertEqual(extract_evaluation_section(content, rendered=True), '原点评。')
                    self.assertIsNone(evaluation_heading_issue(content, rendered=True))
        self.assertEqual(find_evaluation_headings('摘要句中提到论文评价，但这不是栏目。', rendered=True), [])
        self.assertIsNotNone(evaluation_heading_issue('💡 **论文评价**\n\n💬 **毒舌点评**\n', rendered=True))


if __name__ == '__main__':
    unittest.main()
