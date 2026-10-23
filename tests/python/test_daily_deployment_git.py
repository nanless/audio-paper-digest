"""Actual local Git config mapping; never network, normal or GitHub routing authority."""
import importlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import local_git_test_fixture as fixture


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


class DailyDeploymentGitTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='deployment-git-map-')
        self.addCleanup(self.temporary.cleanup)
        self.repo, objects = fixture.create_repo(Path(self.temporary.name).resolve())
        self.base = objects['commit'][0]
        (self.repo / 'page.md').write_bytes(b'Candidate page\n')
        fixture.git(self.repo, 'add', '--', 'page.md')
        fixture.git(self.repo, 'commit', '-m', 'Mechanical mapped candidate')
        self.current = fixture.git(self.repo, 'rev-parse', 'HEAD').stdout.decode().strip()
        self.expected = [{'path': 'page.md', 'deleted': False, 'sha256': fixture.sha(b'Candidate page\n')}]
        self.url = 'https://github.com/nanless/audio-paper-digest-blog.git'
        fixture.git(self.repo, 'remote', 'add', 'origin', self.url)
        self.module = importlib.import_module('local_git_publication')

    def inputs(self, context=False):
        inputs = {'commit_oid': self.current, 'remote_name': 'origin',
                  'expected_remote_identity_sha256': fixture.sha(canonical({'remote': 'origin', 'pushUrl': self.url}))}
        if not context:
            inputs.update(base_oid=self.base, expected_files=self.expected)
        return inputs

    def read(self, context=False):
        name = '_read_local_github_publication_context' if context else '_read_local_github_publication_git'
        return getattr(self.module, name)(str(self.repo), **self.inputs(context))

    def test_actual_existing_context_precedes_the_new_fixed_mapping_entry(self):
        before = fixture.inventory(self.repo)
        existing = self.module.read_local_publication_context(str(self.repo), **self.inputs(True))
        self.assertEqual(existing['status'], 'local_publication_context_observed')
        self.assertNotIn('repositoryMapping', existing)
        observed = self.read()
        self.assertEqual(observed['status'], 'local_publication_git_observed')
        self.assertEqual(observed['context']['repositoryMapping']['fullName'], 'nanless/audio-paper-digest-blog')
        self.assertEqual(fixture.inventory(self.repo), before)

    def set_url(self, value):
        fixture.git(self.repo, 'remote', 'set-url', 'origin', value)
        self.url = value

    def assert_mapping(self, context):
        expected = {'repositoryId': 1214235086, 'fullName': 'nanless/audio-paper-digest-blog',
                    'workflowId': 262722446, 'workflowPath': '.github/workflows/hugo.yaml',
                    'branch': 'main', 'environment': 'github-pages', 'localRepositoryMapping': 'verified'}
        policy = (('repositoryId', 1214235086), ('fullName', 'nanless/audio-paper-digest-blog'),
                  ('workflowId', 262722446), ('workflowPath', '.github/workflows/hugo.yaml'),
                  ('branch', 'main'), ('environment', 'github-pages'),
                  ('urlProfile', 'fixed-literal-github-remote-v1'), ('host', 'github.com'),
                  ('httpsPort', '443'), ('sshPort', '22'), ('sshUser', 'git'),
                  ('protocols', ('https', 'ssh', 'scp')), ('pathSuffixes', ('/', '.git')))
        self.assertEqual(self.module._GITHUB_POLICY, policy)
        expected['policySha256'] = fixture.sha(canonical(policy))
        self.assertEqual(context['repositoryMapping'], expected)
        self.assertEqual(context['localRemoteConfigurationMatch'], 'verified')
        self.assertEqual(context['headOid'], self.current)
        self.assertEqual(context['observationSha256'], fixture.sha(canonical({
            key: value for key, value in context.items() if key != 'observationSha256'})))
        self.assertNotIn(self.url, json.dumps(context))
        self.assertNotIn(self.inputs(True)['expected_remote_identity_sha256'], json.dumps(context))
        return context

    def mapping_error(self, code, reason='remote_profile', context=True):
        with self.assertRaises(self.module.LocalPublicationReadError) as caught:
            self.read(context=context)
        self.assertEqual((caught.exception.domain, caught.exception.code, caught.exception.reason),
                         ('publication', code, reason))
        self.assertNotIn(self.url, str(caught.exception))
        self.assertNotIn(str(self.repo), str(caught.exception))

    def test_all_fixed_literal_protocols_suffixes_and_case_have_real_contexts(self):
        urls = ('https://github.com/nanless/audio-paper-digest-blog',
                'HTTPS://GitHub.COM:443/nanless/audio-paper-digest-blog.git/',
                'ssh://git@github.com/nanless/audio-paper-digest-blog.git',
                'SsH://git@GITHUB.COM:22/nanless/audio-paper-digest-blog/',
                'git@GitHub.COM:nanless/audio-paper-digest-blog.git',
                'git@github.com:nanless/audio-paper-digest-blog.git/')
        for url in urls:
            with self.subTest(url=url):
                self.set_url(url)
                before = fixture.inventory(self.repo)
                self.assert_mapping(self.read(context=True))
                self.assertEqual(fixture.inventory(self.repo), before)

    def test_complete_delta_and_repeat_use_the_same_real_mapping(self):
        actual = self.module._github_mapping
        with mock.patch.object(self.module, '_github_mapping', wraps=actual) as mapped:
            observed = self.read()
        self.assertEqual(mapped.call_count, 2)
        self.assert_mapping(observed['context'])
        self.assertEqual(observed['delta']['baseOid'], self.base)
        self.assertEqual(observed['delta']['commitOid'], self.current)
        self.assertEqual(observed['delta']['pathCount'], 1)
        self.assertEqual(observed['observationSha256'], fixture.sha(canonical({
            key: value for key, value in observed.items() if key != 'observationSha256'})))
        self.assertEqual(observed['coverage']['normal'], 'not_checked')
        self.assertEqual(observed['coverage']['deployment'], 'not_checked')

    def test_valid_other_repositories_protocols_and_aliases_do_not_acquire_mapping(self):
        for url in ('https://github.com/other/project.git',
                    'https://github.com/Nanless/audio-paper-digest-blog.git',
                    'https://example.invalid/nanless/audio-paper-digest-blog.git',
                    'http://github.com/nanless/audio-paper-digest-blog.git',
                    'file:///tmp/mechanical-only.git', 'git@github-alias:nanless/audio-paper-digest-blog.git',
                    'ext::not-executed-helper'):
            with self.subTest(url=url):
                self.set_url(url)
                # The old route deliberately observes local identity without a GitHub policy.
                prior = self.module.read_local_publication_context(str(self.repo), **self.inputs(True))
                self.assertNotIn('repositoryMapping', prior)
                self.assertEqual(prior['status'], 'local_publication_context_observed')
                self.mapping_error('unsupported_state')

    def test_fixed_host_malformed_urls_never_gain_mapping_or_echo_secrets(self):
        for url in ('https://github.com', 'https://github.com/',
                    'https://user:SecretNeedle@github.com/nanless/audio-paper-digest-blog.git',
                    'https://github.com:444/nanless/audio-paper-digest-blog.git',
                    'https://github.com:443x/nanless/audio-paper-digest-blog.git',
                    'https://github.com/nanless/audio-paper-digest-blog.git?x=1',
                    'https://github.com/nanless/audio-paper-digest-blog.git#x',
                    'https://github.com/nanless/audio%2Dpaper-digest-blog.git',
                    'https://github.com/nanless/audio-paper-digest-blog.git//',
                    'https://github.com/nanless/../audio-paper-digest-blog.git',
                    'https://github.com/nanless/audio paper-digest-blog.git',
                    'https://github.com/nanless/audio\\paper-digest-blog.git',
                    'ssh://GIT@github.com/nanless/audio-paper-digest-blog.git',
                    'ssh://git@github.com:443/nanless/audio-paper-digest-blog.git',
                    'git@github.com:', 'GIT@github.com:nanless/audio-paper-digest-blog.git'):
            with self.subTest(url=url):
                self.set_url(url)
                self.mapping_error('invalid_argument')

    def test_original_remote_digest_is_checked_before_any_literal_mapping(self):
        inputs = self.inputs(True)
        inputs['expected_remote_identity_sha256'] = '1' * 64
        with mock.patch.object(self.module, '_github_mapping', side_effect=AssertionError('No mapping before original digest')):
            with self.assertRaises(self.module.LocalPublicationReadError) as caught:
                self.module._read_local_github_publication_context(str(self.repo), **inputs)
        self.assertEqual((caught.exception.code, caught.exception.reason), ('state_mismatch', 'remote_identity'))

    def test_ambiguous_urls_and_rewrites_remain_the_original_gates(self):
        fixture.git(self.repo, 'config', '--add', 'remote.origin.pushurl', self.url)
        fixture.git(self.repo, 'config', '--add', 'remote.origin.pushurl', self.url)
        self.mapping_error('unsupported_state', 'remote_url_count')
        fixture.git(self.repo, 'config', '--unset-all', 'remote.origin.pushurl')
        fixture.git(self.repo, 'config', 'url.https://example.invalid/.insteadOf', 'https://github.com/')
        with self.assertRaises(self.module.LocalPublicationReadError) as caught:
            self.read(context=True)
        self.assertEqual((caught.exception.domain, caught.exception.code, caught.exception.reason),
                         ('raw', 'unsupported_repository', 'config_policy'))

    def test_unique_pushurl_is_used_and_ssh_only_claims_literal_local_configuration(self):
        fixture.git(self.repo, 'remote', 'set-url', 'origin', 'https://example.invalid/fetch-only.git')
        self.url = 'ssh://git@github.com:22/nanless/audio-paper-digest-blog.git'
        fixture.git(self.repo, 'config', 'remote.origin.pushurl', self.url)
        self.assert_mapping(self.read(context=True))

    def test_private_entries_guard_before_any_argument_or_repository_io(self):
        import runtime_guard
        for function in (self.module._read_local_github_publication_git,
                         self.module._read_local_github_publication_context):
            with self.subTest(function=function.__name__), mock.patch.object(runtime_guard, 'require_external_runtime',
                    side_effect=RuntimeError('actual guard first')):
                with self.assertRaisesRegex(RuntimeError, 'actual guard first'):
                    if function is self.module._read_local_github_publication_git:
                        function(None, base_oid=None, commit_oid=None, expected_files=None,
                                 remote_name=None, expected_remote_identity_sha256=None)
                    else:
                        function(None, commit_oid=None, remote_name=None, expected_remote_identity_sha256=None)
