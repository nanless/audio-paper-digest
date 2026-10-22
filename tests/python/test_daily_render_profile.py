"""Normal-owner profile and fingerprint boundaries, using real config bytes."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_publish_to_blog import publish_to_blog as publisher


class DailyRenderProfileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name).resolve()
        self.config = self.repo / 'hugo.yaml'
        self.config.write_text('baseURL: https://example.test/research/base/\n')
        layouts = self.repo / 'layouts'
        (layouts / '_default').mkdir(parents=True)
        (layouts / '_default' / 'baseof.html').write_text(
            '<html>{{ block "main" . }}{{ end }}</html>')
        self.single = layouts / 'single.html'
        self.single.write_text('{{ define "main" }}{{ .Content }}{{ end }}')
        self.artifacts = {'page': {'frontmatter': {}}}

    def profile(self):
        return publisher._daily_render_layout_profile(self.repo, self.artifacts)

    def test_policy_is_derived_from_the_same_selected_config_bytes(self):
        import hashlib
        layout, policy = self.profile()
        self.assertEqual(layout['status'], 'supported')
        self.assertEqual(policy, {'origin': 'https://example.test', 'basePath': '/research/base/'})
        self.assertEqual(layout['configPath'], str(self.config))
        self.assertEqual(layout['configSha256'], hashlib.sha256(self.config.read_bytes()).hexdigest())
        self.config.write_text('baseURL: https://other.test/other/\n')
        changed, policy = self.profile()
        self.assertNotEqual(changed['configSha256'], layout['configSha256'])
        self.assertEqual(policy['origin'], 'https://other.test')

    def test_actual_local_theme_and_single_language_home_formats_are_supported(self):
        theme = self.repo / 'themes' / 'PaperMod' / 'layouts' / '_default'
        theme.mkdir(parents=True)
        (theme / 'baseof.html').write_text('<html>{{ block "main" . }}{{ end }}</html>')
        (theme / 'single.html').write_text('{{ define "main" }}{{ .Content }}{{ end }}')
        self.single.unlink()
        (self.repo / 'layouts' / '_default' / 'baseof.html').unlink()
        self.config.write_text(
            'baseURL: https://example.test/base/\ntheme: PaperMod\nenableGitInfo: true\n'
            'languages:\n  zh-CN:\n    languageCode: zh-CN\n    languageName: 简体中文\n    weight: 1\n'
            'outputs:\n  home: [HTML, RSS, JSON]\n  section: [HTML]\n')
        layout, _policy = self.profile()
        self.assertEqual(layout['status'], 'supported')
        self.assertEqual(layout['effectiveBaseof'], str(theme / 'baseof.html'))
        self.assertEqual(layout['themeLayouts'], [str(theme.parent)])

    def test_standalone_and_unproven_profiles_are_explicitly_unsupported(self):
        normal = self.single.read_bytes()
        self.single.write_text('<html>{{ .Content }}</html>')
        self.assertEqual(self.profile()[0]['status'], 'unsupported')
        self.single.write_bytes(normal)
        baseline = self.config.read_bytes()
        for extra in (
            b'theme: [one, two]\n', b'languages: {en: {}, zh: {}}\n',
            b'languages: {zh: invalid}\n', b'outputs: {page: [HTML, AMP]}\n',
            b'layoutDir: elsewhere\n', b'module: {mounts: []}\n',
        ):
            with self.subTest(extra=extra):
                self.config.write_bytes(baseline + extra)
                self.assertEqual(self.profile()[0]['status'], 'unsupported')
        self.config.write_bytes(baseline)
        for key in ('layout', 'type', 'outputs', 'lang'):
            self.artifacts = {'page': {'frontmatter': {key: 'custom'}}}
            self.assertEqual(self.profile()[0]['status'], 'unsupported')

    def test_comment_or_quoted_define_cannot_promote_a_standalone_layout(self):
        for raw in (
            '{{/* {{ define "main" }} */}}<html>{{ .Content }}</html>',
            '{{ printf `{{ define "main" }}` }}<html>{{ .Content }}</html>',
        ):
            self.single.write_text(raw)
            with self.subTest(raw=raw):
                self.assertEqual(self.profile()[0]['status'], 'unsupported')
        self.single.write_text('{{/* leading comment */}}\n{{- define "main" -}}{{ .Content }}{{ end }}')
        self.assertEqual(self.profile()[0]['status'], 'supported')

    def test_duplicate_or_malformed_yaml_fails_before_observation(self):
        for raw in ('baseURL: [\n', 'baseURL: https://one.test/\nbaseURL: https://two.test/\n'):
            self.config.write_text(raw)
            with self.subTest(raw=raw), self.assertRaises(publisher.PublishDataValidationError):
                self.profile()

    def test_profile_config_and_single_reads_use_the_safe_original_byte_reader(self):
        capture = publisher.daily_hugo_capture
        with mock.patch.object(capture, 'read_profile_file', wraps=capture.read_profile_file) as read:
            self.assertEqual(self.profile()[0]['status'], 'supported')
            self.assertEqual([call.args[0] for call in read.call_args_list], [self.config, self.single])
        for target in (self.config, self.single):
            original = target.read_bytes()
            ordinary = target.with_name(target.name + '.ordinary')
            ordinary.write_bytes(original)
            target.unlink()
            target.symlink_to(ordinary)
            with self.subTest(target=target), self.assertRaises(publisher.PublishDataValidationError):
                self.profile()
            target.unlink()
            target.write_bytes(original)
            ordinary.unlink()

    def test_supported_fallback_root_configs_are_part_of_normal_runtime_identity(self):
        for name in ('config.yaml', 'config.yml', 'config.toml', 'config.json'):
            with self.subTest(name=name):
                alternate = self.repo / name
                first = publisher.blog_runtime_fingerprint(self.repo)
                alternate.write_text('real config input bytes\n')
                added = publisher.blog_runtime_fingerprint(self.repo)
                self.assertNotEqual(added, first)
                alternate.write_bytes(alternate.read_bytes() + b'\n')
                self.assertNotEqual(publisher.blog_runtime_fingerprint(self.repo), added)
                alternate.unlink()
                self.assertEqual(publisher.blog_runtime_fingerprint(self.repo), first)

    def test_capture_helper_changes_invalidate_warm_normal_review_protocol_cache(self):
        original = publisher.SHARED_SCRIPTS_DIR / 'daily_hugo_capture.py'
        copied = self.repo / 'helper.py'
        raw = original.read_bytes()
        copied.write_bytes(raw)
        real_hash = publisher._sha256_file
        seen = []

        def digest(path):
            path = Path(path)
            seen.append(path)
            return real_hash(copied if path == original else path)

        publisher._REVIEW_PROTOCOL_CACHE.clear()
        self.addCleanup(publisher._REVIEW_PROTOCOL_CACHE.clear)
        with mock.patch.object(publisher, 'BLOG_REPO', str(self.repo)), \
                mock.patch.object(publisher, '_sha256_file', side_effect=digest):
            first = publisher.review_protocol_fingerprint()
            self.assertEqual(publisher.review_protocol_fingerprint(), first)
            self.assertIn(original, seen)
            copied.write_bytes(raw + b'\n')
            self.assertNotEqual(publisher.review_protocol_fingerprint(), first)
            copied.write_bytes(raw)
            self.assertEqual(publisher.review_protocol_fingerprint(), first)
            copied.unlink()
            with self.assertRaises(FileNotFoundError):
                publisher.review_protocol_fingerprint()
        self.assertEqual(original.read_bytes(), raw)


if __name__ == '__main__':
    unittest.main()
