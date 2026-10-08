"""发布图片解析器与 URL 不变闸门的离线回归。"""
import importlib.util
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

from project_env_isolation import project_env_scope

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('image_parser_publisher', ROOT / 'scripts/publish-to-blog.py')
publisher = importlib.util.module_from_spec(SPEC)
# publish-to-blog.py 导入时会读 .env 并写 os.environ，用完还给进程。
with project_env_scope():
    SPEC.loader.exec_module(publisher)

URL = 'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main/interspeech-2026/78eda30f9f11/figure-2.png'
ALT = r'原论文 Figure 2：Pitch doubling in \[ph5P\](‘beat’): under structured irregular excitation, trackers may lock to τ/2…'
FIGURE = f'[![{ALT}]({URL})]({URL})'


class MarkdownImageParserTest(unittest.TestCase):
    def test_real_du26b_escaped_figure2_keeps_complete_label_and_url(self):
        image, = publisher.parse_markdown_images(FIGURE)
        self.assertEqual(image['alt'], ALT)
        self.assertEqual(image['url'], URL)
        self.assertEqual(image['raw'], FIGURE[1:-(len(URL) + 3)])
        self.assertEqual(publisher._linked_image_source_url(FIGURE, image['end']), URL)
        self.assertEqual(FIGURE[image['start']:image['end']], image['raw'])

    def test_nested_label_brackets_and_inner_parentheses_are_caption_text(self):
        for alt in ('Caption [ph5P](‘beat’)', 'outer [middle [inner](label)] end', 'array [1, [2, 3]]'):
            with self.subTest(alt=alt):
                image, = publisher.parse_markdown_images(f'![{alt}]({URL})')
                self.assertEqual(image['alt'], alt)
                self.assertEqual(image['url'], URL)

    def test_escape_parity_preserves_literals_without_inventing_images(self):
        self.assertEqual(publisher.parse_markdown_images(r'\![literal](https://example.org/a.png)'), [])
        image, = publisher.parse_markdown_images(r'\\![a \] literal](https://example.org/a.png)')
        self.assertEqual(image['alt'], r'a \] literal')
        self.assertEqual(image['url'], 'https://example.org/a.png')

    def test_plain_images_and_balanced_destination_parentheses(self):
        image, = publisher.parse_markdown_images('![Figure](https://example.org/a(b(c)).png)')
        self.assertEqual(image['url'], 'https://example.org/a(b(c)).png')
        self.assertEqual(image['alt'], 'Figure')

    def test_url_title_and_angle_destination_keep_existing_behavior(self):
        for destination in ('https://example.org/a.png "Figure title"', '<https://example.org/a.png>'):
            with self.subTest(destination=destination):
                image, = publisher.parse_markdown_images(f'![图]({destination})')
                self.assertEqual(image['url'], 'https://example.org/a.png')

    def test_multiple_figures_keep_exact_offsets_and_do_not_merge_contexts(self):
        content = '说明\n' + FIGURE + '\n第二图\n![Second](https://example.org/two(2).png)\n后文'
        images = publisher.parse_markdown_images(content)
        self.assertEqual(len(images), 2)
        self.assertEqual([i['url'] for i in images], [URL, 'https://example.org/two(2).png'])
        self.assertLess(images[0]['end'], images[1]['start'])
        for image in images:
            self.assertEqual(content[image['start']:image['end']], image['raw'])

    def test_non_inline_reference_labels_remain_outside_parser_scope(self):
        content = '![reference][id]\n[id]: https://example.org/a.png\n![inline](https://example.org/b.png)'
        image, = publisher.parse_markdown_images(content)
        self.assertEqual(image['url'], 'https://example.org/b.png')

    def test_broken_image_syntax_fails_closed_instead_of_omitting_image(self):
        malformed = (
            '![label', '![nested [label](https://example.org/a.png)',
            '![label](https://example.org/a(b).png', '![label]()',
            '![label](   )', '![label](<>)',
        )
        for content in malformed:
            with self.subTest(content=content):
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher.parse_markdown_images(content)

    def test_valid_first_image_does_not_hide_later_broken_image(self):
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher.parse_markdown_images('![ok](https://example.org/a.png)\n![broken](https://example.org/b.png')

    def test_unsupported_urls_still_reach_unchanged_fail_closed_loader(self):
        for destination in ('‘beat’', 'javascript:alert(1)', 'http://example.org/a.png', 'file:///tmp/a.png', '//example.org/a.png'):
            with self.subTest(destination=destination), \
                    mock.patch.object(publisher, '_download_review_image') as download:
                image, = publisher.parse_markdown_images(f'![图]({destination})')
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher._load_review_image(image['url'])
                download.assert_not_called()

    def test_real_alt_context_and_payload_stay_aligned_through_required_review(self):
        payload = {'media_type': 'image/png', 'data': 'cG5n'}
        content = FIGURE + '\n![Other](https://example.org/other.png)'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-test-model'}), \
                mock.patch.object(publisher, '_load_review_image', return_value=payload) as load, \
                mock.patch.object(publisher, 'call_llm_api', return_value='{"passed":true,"issues":[]}') as api:
            passed, issues = publisher.multimodal_review_images(content, 'du26b', required=True)
        self.assertEqual((passed, issues), (True, []))
        self.assertEqual([c.args[0] for c in load.call_args_list], [URL, 'https://example.org/other.png'])
        self.assertEqual(api.call_count, 2)
        self.assertIn(ALT, api.call_args_list[0].args[0])
        self.assertNotIn('alt: `Other`', api.call_args_list[0].args[0])
        self.assertIn('alt: `Other`', api.call_args_list[1].args[0])
        for call in api.call_args_list:
            self.assertEqual(call.kwargs['images'], [payload])

    def test_required_review_never_calls_model_after_bad_url_or_syntax(self):
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-test-model'}), \
                mock.patch.object(publisher, 'call_llm_api') as api:
            passed, issues = publisher.multimodal_review_images('![图](javascript:alert(1))', required=True)
            self.assertFalse(passed)
            self.assertEqual(issues[0]['severity'], 'error')
            with self.assertRaises(publisher.PublishDataValidationError):
                publisher.multimodal_review_images('![broken](https://example.org/a.png', required=True)
            api.assert_not_called()

    def test_quoted_titles_allow_single_sided_parentheses(self):
        for title in ('"caption ("', '"caption )"', "'caption ('", "'caption )'"):
            with self.subTest(title=title):
                image, = publisher.parse_markdown_images(f'![Figure]({URL} {title})')
                self.assertEqual(image['url'], URL)
                self.assertEqual(image['raw'], f'![Figure]({URL} {title})')

    def test_quoted_title_escape_does_not_change_destination_balance(self):
        image, = publisher.parse_markdown_images(f'![Figure]({URL} "caption \\" (")')
        self.assertEqual(image['url'], URL)

    def test_angle_url_parentheses_do_not_need_balancing(self):
        image, = publisher.parse_markdown_images('![Figure](<https://example.org/a(b.png> "caption )")')
        self.assertEqual(image['url'], 'https://example.org/a(b.png')

    def test_inline_code_literal_malformed_image_is_ignored(self):
        for code in ('`![literal`', '`![literal](broken`', '``![literal` inside``'):
            with self.subTest(code=code):
                self.assertEqual(publisher.parse_markdown_images(code), [])

    def test_multiline_inline_code_literal_is_ignored(self):
        self.assertEqual(publisher.parse_markdown_images('before `line one\n![literal` after'), [])

    def test_code_literals_do_not_hide_adjacent_actual_images(self):
        content = f'`![literal`\n{FIGURE}\n`![second literal](bad`\n![actual]({URL})'
        images = publisher.parse_markdown_images(content)
        self.assertEqual([m['url'] for m in images], [URL, URL])
        self.assertEqual([m['alt'] for m in images], [ALT, 'actual'])

    def test_fenced_code_ignores_malformed_and_valid_image_literals(self):
        for fence in ('```markdown', '~~~text', '   ````markdown'):
            closing = fence.strip().split('markdown')[0].split('text')[0]
            content = f'{fence}\n![broken\n![not rendered]({URL})\n{closing}\n![actual]({URL})'
            with self.subTest(fence=fence):
                image, = publisher.parse_markdown_images(content)
                self.assertEqual(image['alt'], 'actual')

    def test_unclosed_fence_remains_code_not_a_broken_image(self):
        self.assertEqual(publisher.parse_markdown_images('```markdown\n![literal'), [])

    def test_shorter_or_wrong_fence_does_not_close_the_code_block(self):
        content = f'````markdown\n```\n![literal\n~~~\n````\n![actual]({URL})'
        image, = publisher.parse_markdown_images(content)
        self.assertEqual(image['alt'], 'actual')

    def test_escaped_malformed_image_marker_is_literal(self):
        self.assertEqual(publisher.parse_markdown_images(r'\![literal'), [])
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher.parse_markdown_images(r'\\![broken')

    def test_unclosed_inline_code_does_not_mask_next_paragraph_image(self):
        image, = publisher.parse_markdown_images(f'`unclosed literal\n\n![actual]({URL})')
        self.assertEqual(image['alt'], 'actual')

    def test_backtick_inside_image_title_cannot_mask_later_actual_image(self):
        content = f'![one]({URL} "literal `")\n![two]({URL})\n`other text`'
        self.assertEqual([m['alt'] for m in publisher.parse_markdown_images(content)], ['one', 'two'])

    def test_unclosed_code_delimiter_cannot_cross_heading_or_list_block(self):
        for separator in ('# Heading', '- List item', '> Quote', '---'):
            with self.subTest(separator=separator):
                content = f'`unclosed\n{separator}\n![actual]({URL})\n`later`'
                image, = publisher.parse_markdown_images(content)
                self.assertEqual(image['alt'], 'actual')

    def test_escaped_backtick_cannot_open_a_code_span(self):
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher.parse_markdown_images(r'\`![broken`')

    def test_lf_crlf_and_cr_paragraph_boundaries_preserve_actual_images(self):
        for newline in ('\n', '\r\n', '\r'):
            with self.subTest(newline=repr(newline)):
                content = f'`open{newline}{newline}![actual]({URL}){newline}close`'
                image, = publisher.parse_markdown_images(content)
                self.assertEqual((image['alt'], image['url']), ('actual', URL))

    def test_lf_crlf_and_cr_heading_list_quote_and_fence_boundaries(self):
        for newline in ('\n', '\r\n', '\r'):
            for separator in ('# Heading', '#', '- List item', '> Quote', '---'):
                with self.subTest(newline=repr(newline), separator=separator):
                    content = f'`open{newline}{separator}{newline}![actual]({URL}){newline}close`'
                    image, = publisher.parse_markdown_images(content)
                    self.assertEqual(image['alt'], 'actual')
            content = f'```markdown{newline}![literal{newline}```{newline}![actual]({URL})'
            image, = publisher.parse_markdown_images(content)
            self.assertEqual(image['alt'], 'actual')

    def test_matching_label_code_spans_preserve_brackets_raw_and_offsets(self):
        for alt in ('a `x]` caption', 'a `[x` caption', 'a ``[x]` y`` caption'):
            with self.subTest(alt=alt):
                content = f'prefix ![{alt}]({URL}) suffix'
                image, = publisher.parse_markdown_images(content)
                self.assertEqual((image['alt'], image['url']), (alt, URL))
                self.assertEqual(content[image['start']:image['end']], image['raw'])

    def test_unmatched_label_code_delimiter_is_literal_not_bracket_mask(self):
        image, = publisher.parse_markdown_images(f'![a ` literal]({URL})')
        self.assertEqual(image['alt'], 'a ` literal')
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher.parse_markdown_images(f'![a `[x caption]({URL})')

    def test_only_ordered_start_one_interrupts_code_paragraph(self):
        for newline in ('\n', '\r\n', '\r'):
            for marker in ('1.', '01.', '000000001.', '1)'):
                with self.subTest(newline=repr(newline), marker=marker):
                    image, = publisher.parse_markdown_images(f'`before{newline}{marker} words{newline}![actual]({URL}){newline}after`')
                    self.assertEqual(image['alt'], 'actual')
            for marker in ('2.', '02.', '2)', '10.'):
                with self.subTest(newline=repr(newline), marker=marker):
                    self.assertEqual(publisher.parse_markdown_images(f'`before{newline}{marker} words{newline}![literal]({URL}){newline}after`'), [])

    def test_bare_heading_and_empty_list_quote_boundaries_follow_hugo(self):
        for newline in ('\n', '\r\n', '\r'):
            for marker in ('#', '##', '######', '- ', '>'):
                with self.subTest(newline=repr(newline), marker=marker):
                    image, = publisher.parse_markdown_images(f'`before{newline}{marker}{newline}![actual]({URL}){newline}after`')
                    self.assertEqual(image['alt'], 'actual')

    def test_empty_plus_and_star_do_not_interrupt_paragraph_code(self):
        for newline in ('\n', '\r\n', '\r'):
            for marker in ('+ ', '* ', '1. ', '01. ', '1) '):
                with self.subTest(newline=repr(newline), marker=marker):
                    self.assertEqual(publisher.parse_markdown_images(f'`before{newline}{marker}{newline}![literal]({URL}){newline}after`'), [])

    def test_true_malformed_syntax_and_title_outside_code_remain_blocking(self):
        for content in (f'![x]({URL} "unclosed)', f'![x](<{URL})',
                        f'![x]({URL} "done" garbage)', f'![x]({URL} "one" "two")'):
            with self.subTest(content=content):
                with self.assertRaises(publisher.PublishDataValidationError):
                    publisher.parse_markdown_images(content)

    def test_legacy_truncated_data_uri_is_not_silently_fixed_or_accepted(self):
        uri = 'data:image/svg+xml;base64,PHN2ZyB...[truncated 56464 chars]...'
        image, = publisher.parse_markdown_images(f'![legacy]({uri})')
        self.assertEqual(image['url'], uri)
        with self.assertRaises(publisher.PublishDataValidationError):
            publisher._load_review_image(image['url'])

    def test_code_literals_never_load_or_call_model(self):
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'offline-test-model'}), \
                mock.patch.object(publisher, '_load_review_image') as load, \
                mock.patch.object(publisher, 'call_llm_api') as api:
            self.assertEqual(publisher.multimodal_review_images('`![literal`\n```\n![literal\n```', required=True), (True, []))
            load.assert_not_called()
            api.assert_not_called()


if __name__ == '__main__':
    unittest.main()
