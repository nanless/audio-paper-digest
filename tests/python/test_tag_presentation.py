import copy
import sys
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from tag_catalog import load_tag_catalog
from tag_presentation import (build_tag_hierarchy, render_tag_hierarchy_markdown,
                             TAG_HIERARCHY_START, TAG_HIERARCHY_END)


class TagPresentationTest(unittest.TestCase):
    def setUp(self):
        self.catalog = load_tag_catalog()
        self.ids = ['task.av-speech-separation', 'method.transformer', 'research_focus.robustness']
        by_id = {node['id']: node for node in self.catalog['concepts']}
        self.metadata = {'registryVersion': self.catalog['version'], 'registrySha256': self.catalog['registrySha256'],
            'concepts': [{'id': cid, 'facet': by_id[cid]['facet'], 'label': by_id[cid]['preferredLabel']['zh']}
                         for cid in self.ids]}

    def test_only_hit_facets_and_ancestor_paths_with_stable_concept_links(self):
        before = copy.deepcopy((self.metadata, self.catalog))
        facets = build_tag_hierarchy(self.metadata, self.catalog)
        self.assertEqual([item['id'] for item in facets], ['task', 'method', 'research_focus'])
        self.assertEqual([n['id'] for n in facets[0]['paths'][0]['nodes']],
                         ['task.audio-separation', 'task.av-source-separation', 'task.av-speech-separation'])
        text = render_tag_hierarchy_markdown(self.metadata, self.catalog)
        self.assertIn('**研究方法**', text)
        self.assertIn('](/audio-paper-digest-blog/papers/?concept=task.av-speech-separation)', text)
        self.assertNotIn('/tags/', text)
        self.assertNotIn('研究条件', text)
        self.assertNotIn('task.asr', text)
        self.assertEqual((self.metadata, self.catalog), before)

    def test_links_respect_subpath_and_root_deployment(self):
        for base, expected in (('/audio-paper-digest-blog', '/audio-paper-digest-blog/papers/'),
                               ('/custom/site/', '/custom/site/papers/'), ('/', '/papers/'), ('', '/papers/')):
            with mock.patch.dict('os.environ', {'PAPER_DIGEST_BLOG_BASE_PATH': base}):
                text = render_tag_hierarchy_markdown(self.metadata, self.catalog)
            self.assertIn(f']({expected}?concept=task.av-speech-separation)', text)
        text = render_tag_hierarchy_markdown(self.metadata, self.catalog, base_path='/explicit')
        self.assertIn('](/explicit/papers/?concept=task.av-speech-separation)', text)
        for invalid in ('//example.com', 'https://example.com', '/a/../b', '/a/./b', '/a//b',
                        '/a?x=1', '/a#x', '/%2e%2e', '/a\\b'):
            with self.assertRaises(ValueError):
                render_tag_hierarchy_markdown(self.metadata, self.catalog, base_path=invalid)

    def test_generated_boundaries_survive_real_publish_sanitizer(self):
        from publish_common import sanitize_markdown_for_publish
        text = render_tag_hierarchy_markdown(self.metadata, self.catalog)
        self.assertEqual(text.count(TAG_HIERARCHY_START), 1)
        self.assertEqual(text.count(TAG_HIERARCHY_END), 1)
        self.assertTrue(text.startswith(TAG_HIERARCHY_START + '\n\n'))
        self.assertTrue(text.endswith('\n\n' + TAG_HIERARCHY_END + '\n\n'))
        self.assertEqual(sanitize_markdown_for_publish(text), text)

    def test_empty_and_strict_metadata_boundaries(self):
        empty = dict(self.metadata, concepts=[])
        self.assertEqual(render_tag_hierarchy_markdown(empty, self.catalog), '')
        for mutate in (
                lambda m: m.update(registrySha256='0' * 64),
                lambda m: m.update(registryVersion='other'),
                lambda m: m['concepts'][0].update(id='task.unknown'),
                lambda m: m['concepts'][0].update(facet='method'),
                lambda m: m['concepts'][0].update(label='自造标签'),
                lambda m: m['concepts'].append(copy.deepcopy(m['concepts'][0]))):
            value = copy.deepcopy(self.metadata); mutate(value)
            with self.assertRaises(ValueError):
                render_tag_hierarchy_markdown(value, self.catalog)


if __name__ == '__main__':
    unittest.main()
