"""Actual temporary Git B/C facts; expected rows never grant review authority."""
import importlib
import contextlib
import copy
import dataclasses
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
import local_git_test_fixture as fixture


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=False, allow_nan=False).encode('utf-8')


class LocalGitCommitDeltaIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='commit-delta-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo, self.initial_objects = fixture.create_repo(self.root)

    def module(self):
        return importlib.import_module('local_git_commit_delta')

    def put(self, path, raw):
        target = self.repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)

    def commit(self, message):
        fixture.git(self.repo, 'add', '--', '.')
        fixture.git(self.repo, 'commit', '--allow-empty', '-m', message)
        return fixture.git(self.repo, 'rev-parse', 'HEAD').stdout.decode().strip()

    def prepare_pair(self):
        for path, raw in (('page.md', b'old page\n'), ('static/asset.json', b'{"same":true}\n'),
                          ('removed.txt', b'remove this body\n')):
            self.put(path, raw)
        self.base = self.commit('Mechanical base B')
        self.put('page.md', b'new page\n')
        self.put('new.md', b'new body\n')
        (self.repo / 'removed.txt').unlink()
        self.current = self.commit('Mechanical candidate C')
        self.expected = [
            {'path': path, 'deleted': False, 'sha256': fixture.sha((self.repo / path).read_bytes())}
            for path in ('page.md', 'new.md', 'static/asset.json')]
        self.expected += [{'path': path, 'deleted': True, 'sha256': None}
                          for path in ('removed.txt', 'never-existed.txt')]

    def read(self, *, base=None, current=None, expected=None, repo=None, **kwargs):
        return self.module().read_local_commit_delta(str(repo or self.repo), base_oid=base or self.base,
            commit_oid=current or self.current,
            expected_files=self.expected if expected is None else expected, **kwargs)

    def blob(self, raw):
        return fixture.git(self.repo, 'hash-object', '-w', '--stdin', data=raw).stdout.decode().strip()

    def tree(self, rows, *, sort=True):
        # A fixture constructor, never the production parser or delta oracle.
        values = [(name.encode() if isinstance(name, str) else name, mode, oid) for name, mode, oid in rows]
        if sort:
            values.sort(key=lambda row: row[0] + (b'/' if row[1] == '40000' else bytes([0])))
        raw = b''.join(mode.encode() + b' ' + name + bytes([0]) + bytes.fromhex(oid)
                       for name, mode, oid in values)
        return self.raw_object('tree', raw)

    def raw_object(self, kind, raw):
        oid = fixture.git(self.repo, 'hash-object', '-w', '-t', kind, '--literally', '--stdin',
                          data=raw).stdout.decode().strip()
        self.assertEqual(fixture.object_oid(kind, raw), oid)
        return oid

    def raw_commit(self, tree, parents=(), *, message=b'Mechanical commit\n', optional=b''):
        raw = ('tree ' + tree + '\n' + ''.join('parent ' + oid + '\n' for oid in parents)
               + 'author Fixture <fixture@example.invalid> 0 +0000\n'
               + 'committer Fixture <fixture@example.invalid> 0 +0000\n').encode()
        return self.raw_object('commit', raw + optional + b'\n' + message)

    def custom_pair(self, base_tree, current_tree=None, *, base_parents=()):
        self.base = self.raw_commit(base_tree, base_parents, message=b'Base\n')
        self.current = self.raw_commit(current_tree or base_tree, [self.base], message=b'Candidate\n')

    def row(self, path, raw=None, *, deleted=False):
        return {'path': path, 'deleted': deleted, 'sha256': None if deleted else fixture.sha(raw)}

    def assert_error(self, code, **kwargs):
        module = self.module()
        with self.assertRaises(module.CommitDeltaReadError) as caught:
            self.read(**kwargs)
        self.assertEqual(caught.exception.code, code)
        self.assertNotIn('fatal:', str(caught.exception))
        self.assertNotIn('absent-success', str(caught.exception))
        return caught.exception

    def assert_observed(self, result):
        self.assertEqual(result['status'], 'commit_delta_observed', result)
        self.assertEqual(result['contract'], 'local-git-commit-delta-observation-v1')
        self.assertEqual(result['version'], 1)
        self.assertEqual(result['inputBinding'], 'before_after_observation')
        for field in ('allDeclaredDirectoryTreeObjects', 'allDeclaredPathDescriptors',
                      'candidateSingleParentEqualsBase', 'expectedFileContentAndDeletion',
                      'exactOrdinaryLeafDescriptorDelta'):
            self.assertEqual(result['coverage'][field], 'verified')
        for field in ('unreviewedBlobBodies', 'unreviewedBlobExistence', 'unreviewedBlobObjectTypes',
                      'completeGitObjectGraph', 'ancestorGraph', 'commitSignature', 'executableModeReview',
                      'worktree', 'index', 'head', 'branch', 'remote', 'source', 'normal', 'publication',
                      'deployment', 'productionArtifact'):
            self.assertEqual(result['coverage'][field], 'not_checked')
        for field in ('localPublicationProof', 'published', 'full', 'normalQualified', 'raw', 'files'):
            self.assertNotIn(field, result)
        contract = result['contract']
        paths = result['delta']['paths']
        self.assertEqual(paths, sorted(paths, key=lambda value: value.encode()))
        self.assertEqual(result['delta']['count'], len(paths))
        self.assertEqual(result['delta']['pathsSha256'], fixture.sha(canonical({
            'contract': contract, 'version': 1, 'baseOid': self.base, 'commitOid': self.current,
            'paths': paths})))
        self.assertEqual(result['expectedFilesSha256'], fixture.sha(canonical(
            sorted(self.expected, key=lambda row: row['path'].encode()))))
        self.assertEqual(result['observationSha256'], fixture.sha(canonical({
            key: value for key, value in result.items() if key != 'observationSha256'})))
        stats = result['rawObjectsRead']
        self.assertEqual(stats['totalUnique'], sum(stats[key] for key in ('uniqueCommits', 'uniqueTrees', 'uniqueBlobs')))
        self.assertEqual(result['trees']['uniqueTreeObjectsRead'], stats['uniqueTrees'])
        for side in ('base', 'candidate'):
            counts = result['trees'][side]
            self.assertEqual(counts['nodes'], counts['directories'] + counts['leaves'])
        return result

    def remove_object(self, oid):
        path = self.repo / '.git/objects' / oid[:2] / oid[2:]
        raw, mode = path.read_bytes(), path.stat().st_mode & 0o777
        path.unlink()
        return path, raw, mode

    @contextlib.contextmanager
    def at_child(self, predicate, mutation):
        actual = subprocess.Popen
        hits = []

        def popen(argv, *args, **kwargs):
            if not hits and predicate(list(argv)):
                hits.append(True)
                mutation()
            return actual(argv, *args, **kwargs)

        with mock.patch.object(subprocess, 'Popen', side_effect=popen):
            yield hits
        self.assertEqual(hits, [True], 'The intended real child phase must be reached')

    def test_actual_complete_delta_and_required_body_facts(self):
        self.prepare_pair()
        raw_leaf = importlib.import_module('local_git_object')
        for oid in (self.base, self.current):
            raw = fixture.git(self.repo, 'cat-file', 'commit', oid).stdout
            self.assertEqual(fixture.object_oid('commit', raw), oid)
            self.assertEqual(raw_leaf.read_local_git_object(str(self.repo), oid=oid,
                             expected_type='commit')['object']['raw'], raw)
        before = fixture.inventory(self.repo)
        result = self.read()
        self.assert_observed(result)
        self.assertEqual(result['delta']['paths'], ['new.md', 'page.md', 'removed.txt'])
        facts = []
        before_body = {'page.md': b'old page\n', 'static/asset.json': b'{"same":true}\n',
                       'removed.txt': b'remove this body\n'}
        after_body = {'page.md': b'new page\n', 'static/asset.json': b'{"same":true}\n', 'new.md': b'new body\n'}
        for row in sorted(self.expected, key=lambda row: row['path'].encode()):
            sides = []
            for bodies in (before_body, after_body):
                body = bodies.get(row['path'])
                sides.append(None if body is None else {'mode': '100644', 'oid': fixture.object_oid('blob', body),
                                                       'bytes': len(body), 'sha256': fixture.sha(body)})
            facts.append({'path': row['path'], 'deleted': row['deleted'], 'expectedSha256': row['sha256'],
                          'base': sides[0], 'candidate': sides[1]})
        self.assertEqual(result['reviewedFileFactsSha256'], fixture.sha(canonical({
            'contract': result['contract'], 'version': 1, 'files': facts})))
        self.assertEqual(result['rawObjectsRead']['uniqueBlobs'], 5)
        self.assertEqual(result['rawObjectsRead']['uniqueCommits'], 2)
        self.assertEqual(fixture.inventory(self.repo), before)

    def test_candidate_parent_list_is_raw_exact_and_base_may_be_a_merge(self):
        tree = self.initial_objects['tree'][0]
        initial = self.initial_objects['commit'][0]
        other = self.raw_commit(tree, message=b'Other ancestor\n')
        self.custom_pair(tree, base_parents=(initial, other, 'f' * 40))
        self.expected = [self.row('中文 tree/name with space.bin', self.initial_objects['blob'][1])]
        result = self.assert_observed(self.read())
        self.assertEqual(result['commits']['base']['parentOids'], [initial, other, 'f' * 40])
        self.assertEqual(result['commits']['candidate']['parentOid'], self.base)
        for parents in ((), (other,), (self.base, other)):
            with self.subTest(parents=parents):
                self.current = self.raw_commit(tree, parents)
                self.assert_error('parent_mismatch')
        self.current = self.raw_commit(tree, [self.base, self.base])
        self.assert_error('unsupported_commit')

    def test_commit_body_and_signature_continuations_do_not_create_parents(self):
        tree = self.initial_objects['tree'][0]
        self.custom_pair(tree)
        self.expected = [self.row('中文 tree/name with space.bin', self.initial_objects['blob'][1])]
        optional = (b'gpgsig -----BEGIN-----\n parent ' + b'f' * 40 + b'\n -----END-----\n'
                    b'encoding UTF-8\ngpgsig-sha256 second\n tree ' + b'f' * 40 + b'\n')
        self.current = self.raw_commit(tree, [self.base], optional=optional,
            message=b'parent ' + b'f' * 40 + b'\ntree ' + b'f' * 40 + b'\nopaque\x00\rbody\n')
        self.assert_observed(self.read())
        valid = ('tree ' + tree + '\nparent ' + self.base + '\n'
                 'author Fixture <fixture@example.invalid> 0 +0000\n'
                 'committer Fixture <fixture@example.invalid> 0 +0000\n').encode()
        cases = (
            valid.replace(b'tree ', b'tree ' + b'0' * 40 + b'\ntree ', 1) + b'\nmessage',
            valid.replace(self.base.encode(), b'0' * 40) + b'\nmessage',
            valid.replace(tree.encode(), b'0' * 40) + b'\nmessage',
            valid.replace(b'author ', b' author ') + b'\nmessage',
            valid + b'encoding UTF-8\n illegal continuation\n\nmessage',
            valid + b'encoding UTF-8\nencoding UTF-8\n\nmessage',
            valid.replace(b'committer ', b'committer\r ') + b'\nmessage',
            valid.replace(b'author ', b'author \x00') + b'\nmessage',
            valid + b'message without empty separator',
        )
        for raw in cases:
            with self.subTest(rawBytes=len(raw)):
                self.current = self.raw_object('commit', raw)
                self.assert_error('unsupported_commit')

    def test_root_empty_tree_can_complete_real_all_deletion(self):
        blob = self.blob(b'delete me')
        base_tree = self.tree([('p', '100644', blob)])
        empty = self.tree([])
        self.custom_pair(base_tree, empty)
        self.expected = [self.row('p', deleted=True)]
        result = self.assert_observed(self.read())
        self.assertEqual(result['delta']['paths'], ['p'])
        self.assertEqual(result['trees']['candidate'], {'nodes': 1, 'directories': 1, 'leaves': 0})

    def test_directory_nodes_are_never_inferred_absent_from_a_leaf_only_map(self):
        body = b'child'
        oid = self.blob(body)
        child = self.tree([('a', '100644', oid)])
        root = self.tree([('p', '40000', child)])
        self.custom_pair(root)
        self.expected = [self.row('p/a', body)]
        self.assert_observed(self.read())
        self.assert_error('unsupported_tree', expected=[self.row('p', deleted=True)])
        self.custom_pair(self.tree([('q', '100644', oid)]), root)
        self.expected = [self.row('p', deleted=True)]
        self.assert_error('deletion_mismatch')

    def test_empty_subtree_is_rejected_even_when_the_same_oid_was_a_legal_base_root(self):
        empty = self.tree([])
        root = self.tree([('empty', '40000', empty)])
        self.custom_pair(empty, root)
        self.expected = [self.row('absent', deleted=True)]
        self.assert_error('unsupported_tree')

    def test_actual_git_sort_order_and_utf8_names_are_preserved(self):
        body = b'shared'
        oid = self.blob(body)
        child = self.tree([('child', '100644', oid)])
        root = self.tree([('a', '40000', child), ('a.c', '100644', oid),
                          ('é', '100644', oid), ('e\u0301', '100644', oid),
                          ('中文 space', '100755', oid)])
        pretty = fixture.git(self.repo, 'ls-tree', '--name-only', root).stdout.splitlines()
        self.assertEqual(pretty[:2], [b'a.c', b'a'])
        self.custom_pair(root)
        self.expected = [self.row(path, body) for path in ('a/child', 'a.c', 'é', 'e\u0301', '中文 space')]
        result = self.assert_observed(self.read())
        self.assertEqual(result['delta']['paths'], [])
        self.assertEqual(result['trees']['base'], {'nodes': 7, 'directories': 2, 'leaves': 5})

    def test_malformed_tree_entries_are_rejected_after_real_raw_oid_admission(self):
        oid, body = self.initial_objects['blob']
        base = self.tree([('p', '100644', oid)])
        self.custom_pair(base)
        self.expected = [self.row('p', body)]
        self.assert_observed(self.read())
        item = b'100644 p' + bytes([0]) + bytes.fromhex(oid)
        cases = (
            item + item,
            b'100644 z' + bytes([0]) + bytes.fromhex(oid) + item,
            b'100644 p' + bytes([0]) + bytes(20),
            item[:-1], item + b'junk',
            b'100644 p' + bytes.fromhex(oid),
            b'100644 \xff' + bytes([0]) + bytes.fromhex(oid),
            b'100644 ..' + bytes([0]) + bytes.fromhex(oid),
            b'100644 a/b' + bytes([0]) + bytes.fromhex(oid),
            b'100644 .git' + bytes([0]) + bytes.fromhex(oid),
            b'100644 bad\nname' + bytes([0]) + bytes.fromhex(oid),
            b'040000 p' + bytes([0]) + bytes.fromhex(oid),
        )
        for raw in cases:
            with self.subTest(rawBytes=len(raw)):
                bad_tree = self.raw_object('tree', raw)
                self.current = self.raw_commit(bad_tree, [self.base])
                self.assert_error('unsupported_tree')
        for mode in ('120000', '160000', '100664'):
            with self.subTest(mode=mode):
                self.current = self.raw_commit(self.tree([('p', mode, oid)]), [self.base])
                self.assert_error('unsupported_tree')

    def test_a_directory_mode_pointing_to_a_blob_fails_the_actual_type_gate(self):
        oid, body = self.initial_objects['blob']
        base = self.tree([('p', '100644', oid)])
        self.custom_pair(base, self.tree([('directory', '40000', oid)]))
        self.expected = [self.row('p', body)]
        self.assert_error('type_mismatch')

    def test_shared_subtree_expands_every_prefix_and_charges_path_placements(self):
        module = self.module()
        body = b'shared body'
        oid = self.blob(body)
        child = self.tree([('item', '100644', oid)])
        root = self.tree([('left', '40000', child), ('right', '40000', child)])
        self.custom_pair(root)
        self.expected = [self.row(path, body) for path in ('left/item', 'right/item')]
        result = self.assert_observed(self.read())
        self.assertEqual(result['trees']['base'], {'nodes': 5, 'directories': 3, 'leaves': 2})
        self.assertEqual(result['trees']['uniqueTreeObjectsRead'], 2)
        self.assertEqual(result['rawObjectsRead']['uniqueBlobs'], 1)
        self.assertEqual(result['rawObjectsRead']['totalUnique'], 5)
        self.assert_error('size_exceeded', limits=dataclasses.replace(module.DEFAULT_LIMITS, max_nodes_per_root=4))
        # These expected paths themselves exceed the supplied depth: this is a
        # parameter rejection, before any repository traversal is permitted.
        self.assert_error('invalid_argument', limits=dataclasses.replace(module.DEFAULT_LIMITS, max_depth=1))
        # A root-level absent noop is legal at depth one. The same complete
        # trees still contain depth-two leaves, so this reaches the tree gate.
        self.expected = [self.row('absent', deleted=True)]
        self.assert_observed(self.read())
        self.assert_error('size_exceeded', limits=dataclasses.replace(module.DEFAULT_LIMITS, max_depth=1))

    def test_missing_unchanged_tree_never_becomes_absence_or_a_skipped_cache_hit(self):
        body = b'expected'
        oid = self.blob(body)
        child = self.tree([('item', '100644', oid)])
        root = self.tree([('nested', '40000', child), ('p', '100644', oid)])
        self.custom_pair(root)
        self.expected = [self.row('p', body)]
        self.assert_observed(self.read())
        self.remove_object(child)
        self.assert_error('object_unavailable')

    def test_every_required_blob_including_unchanged_and_deleted_base_must_exist(self):
        body = b'must read base body'
        oid = self.blob(body)
        root = self.tree([('p', '100644', oid)])
        empty = self.tree([])
        for deleted in (False, True):
            with self.subTest(deleted=deleted):
                self.custom_pair(root, empty if deleted else root)
                self.expected = [self.row('p', body, deleted=deleted)]
                self.assert_observed(self.read())
                path, raw, mode = self.remove_object(oid)
                self.assert_error('object_unavailable')
                path.write_bytes(raw)
                path.chmod(mode)

    def test_unreviewed_unchanged_missing_or_nonblob_bodies_are_explicitly_not_checked(self):
        body = b'needed small body'
        required = self.blob(body)
        missing = self.blob(b'unreviewed much larger than chosen body budget' * 16)
        initial_commit = self.initial_objects['commit'][0]
        root = self.tree([('p', '100644', required), ('unreviewed', '100644', missing),
                          ('unknown-type', '100644', initial_commit)])
        self.custom_pair(root)
        self.expected = [self.row('p', body)]
        self.remove_object(missing)
        result = self.assert_observed(self.read())
        self.assertEqual(result['rawObjectsRead']['uniqueBlobs'], 1)
        self.assertEqual(result['rawObjectsRead']['uniqueCommits'], 2)
        self.assertEqual(result['coverage']['completeGitObjectGraph'], 'not_checked')

    def test_unreviewed_changed_descriptors_are_rejected_even_if_their_body_is_missing_or_wrong_type(self):
        body = b'needed'
        oid = self.blob(body)
        base = self.tree([('p', '100644', oid)])
        extra = self.blob(b'extra unavailable body')
        for extra_oid in (extra, self.initial_objects['commit'][0]):
            with self.subTest(extra_oid=extra_oid):
                self.custom_pair(base, self.tree([('extra', '100644', extra_oid), ('p', '100644', oid)]))
                self.expected = [self.row('p', body)]
                if extra_oid == extra:
                    self.remove_object(extra)
                self.assert_error('delta_mismatch')

    def test_mode_only_is_rejected_but_content_and_mode_same_path_is_not_claimed_reviewed(self):
        old, new = b'old', b'new'
        old_oid, new_oid = self.blob(old), self.blob(new)
        base = self.tree([('p', '100644', old_oid)])
        self.custom_pair(base, self.tree([('p', '100755', old_oid)]))
        self.expected = [self.row('p', old)]
        self.assert_error('delta_mismatch')
        self.custom_pair(base, self.tree([('p', '100755', new_oid)]))
        self.expected = [self.row('p', new)]
        result = self.assert_observed(self.read())
        self.assertEqual(result['delta']['paths'], ['p'])
        self.assertEqual(result['coverage']['executableModeReview'], 'not_checked')

    def test_rename_is_delete_plus_add_and_never_a_heuristic_alias(self):
        body = b'same bytes moved'
        oid = self.blob(body)
        self.custom_pair(self.tree([('old', '100644', oid)]), self.tree([('new', '100644', oid)]))
        self.expected = [self.row('old', deleted=True), self.row('new', body)]
        result = self.assert_observed(self.read())
        self.assertEqual(result['delta']['paths'], ['new', 'old'])
        self.assertEqual(result['rawObjectsRead']['uniqueBlobs'], 1)

    def test_noop_expected_rows_can_produce_zero_delta_without_a_review_claim(self):
        tree = self.initial_objects['tree'][0]
        self.custom_pair(tree)
        self.expected = [self.row('actually-absent', deleted=True)]
        result = self.assert_observed(self.read())
        self.assertEqual(result['delta']['paths'], [])
        self.assertEqual(result['rawObjectsRead']['uniqueBlobs'], 0)

    def test_candidate_content_sha_and_required_blob_type_are_independently_checked(self):
        body = b'actual body'
        oid = self.blob(body)
        root = self.tree([('p', '100644', oid)])
        self.custom_pair(root)
        self.expected = [self.row('p', b'wrong expected body')]
        self.assert_error('expected_content_mismatch')
        root = self.tree([('p', '100644', self.initial_objects['commit'][0])])
        self.custom_pair(root)
        self.expected = [self.row('p', body)]
        self.assert_error('type_mismatch')

    def test_tree_and_blob_aggregate_budgets_reserve_before_requesting_raw_bytes(self):
        module = self.module()
        self.prepare_pair()
        self.assert_observed(self.read())
        real = subprocess.Popen
        for field, kind in (('max_total_tree_bytes', 'tree'), ('max_total_blob_bytes', 'blob')):
            calls = []

            def popen(argv, *args, **kwargs):
                tokens = list(argv)
                if 'cat-file' in tokens and tokens[tokens.index('cat-file') + 1] == kind:
                    calls.append(tokens)
                return real(argv, *args, **kwargs)

            with self.subTest(field=field), mock.patch.object(subprocess, 'Popen', side_effect=popen):
                self.assert_error('size_exceeded', limits=dataclasses.replace(module.DEFAULT_LIMITS, **{field: 1}))
            self.assertEqual(calls, [], 'An exhausted aggregate budget must reject before raw transfer')

    def test_unique_objects_and_total_paths_and_result_budgets_are_whole_scope(self):
        module = self.module()
        self.prepare_pair()
        good = self.assert_observed(self.read())
        for field in ('max_unique_objects', 'max_total_path_bytes', 'max_result_bytes'):
            with self.subTest(field=field):
                self.assert_error('size_exceeded', limits=dataclasses.replace(module.DEFAULT_LIMITS, **{field: 1}))
        self.assertGreater(len(canonical(good)), 1)

    def test_success_parent_mismatch_and_missing_object_all_keep_the_final_snapshot_gate(self):
        self.prepare_pair()
        self.assert_observed(self.read())
        config = self.repo / '.git/config'
        saved = config.read_bytes()
        candidate = self.current
        tree = fixture.git(self.repo, 'rev-parse', self.current + '^{tree}').stdout.decode().strip()
        wrong_parent = self.initial_objects['commit'][0]
        for terminal in ('success', 'parent_mismatch', 'missing_object'):
            with self.subTest(terminal=terminal):
                self.current = candidate
                removed = None
                if terminal == 'parent_mismatch':
                    self.current = self.raw_commit(tree, [wrong_parent])
                    target_oid, command_kind = self.current, 'commit'
                elif terminal == 'missing_object':
                    target_oid = fixture.object_oid('blob', b'old page\n')
                    removed = self.remove_object(target_oid)
                    command_kind = '-t'
                else:
                    target_oid, command_kind = fixture.object_oid('blob', b'old page\n'), 'blob'

                def predicate(tokens):
                    return 'cat-file' in tokens and tokens[tokens.index('cat-file') + 1:] == [command_kind, target_oid]

                with self.at_child(predicate, lambda: config.write_bytes(saved + b'\n')):
                    self.assert_error('metadata_changed')
                config.write_bytes(saved)
                if removed is not None:
                    path, raw, mode = removed
                    path.write_bytes(raw)
                    path.chmod(mode)
        self.current = candidate
        self.assert_observed(self.read())

    def test_admission_failure_after_a_real_before_snapshot_still_checks_the_tail(self):
        self.prepare_pair()
        self.assert_observed(self.read())
        raw = importlib.import_module('local_git_object')
        config = self.repo / '.git/config'
        original = config.read_bytes()
        unsupported = original + b'\n[core]\n\tfsmonitor = false\n'
        real_command = raw._git_command
        changes = []

        def interfere(binary, directory, env, args, limit, limits, deadline, *, phase):
            output = real_command(binary, directory, env, args, limit, limits, deadline, phase=phase)
            if args == ['version'] and not changes:
                # The real before snapshot and real version subprocess have
                # completed. This is a valid but unsupported Git setting.
                config.write_bytes(unsupported)
                changes.append(True)
            return output

        try:
            with mock.patch.object(raw, '_repository_snapshot', wraps=raw._repository_snapshot) as snapshots, \
                    mock.patch.object(raw, '_git_command', side_effect=interfere):
                self.assert_error('metadata_changed')
            self.assertEqual(changes, [True])
            self.assertEqual(snapshots.call_count, 2)
            self.assertNotEqual(fixture.sha(original), fixture.sha(config.read_bytes()))
            # Stable unsupported input must keep the original admission error.
            with mock.patch.object(raw, '_repository_snapshot', wraps=raw._repository_snapshot) as snapshots:
                error = self.assert_error('unsupported_repository')
            self.assertEqual(error.reason, 'config_policy')
            self.assertEqual(snapshots.call_count, 2)
            # The old public raw entry retains its early-error priority and
            # does not acquire the new delta session's all-terminal tail.
            with mock.patch.object(raw, '_repository_snapshot', wraps=raw._repository_snapshot) as snapshots:
                with self.assertRaises(raw.LocalGitReadError) as caught:
                    raw.read_local_git_object(str(self.repo), oid=self.base, expected_type='commit')
            self.assertEqual((caught.exception.code, caught.exception.reason),
                             ('unsupported_repository', 'config_policy'))
            self.assertEqual(snapshots.call_count, 1)
        finally:
            config.write_bytes(original)
        self.assert_observed(self.read())

    def test_entry_budget_error_keeps_priority_over_a_tail_only_timeout(self):
        self.prepare_pair()
        self.assert_observed(self.read())
        module = self.module()
        raw = importlib.import_module('local_git_object')
        limits = dataclasses.replace(module.DEFAULT_LIMITS, max_result_bytes=1,
                                     child_deadline_seconds=1)
        primary = self.assert_error('size_exceeded', limits=limits)
        self.assertEqual(primary.reason, 'result_metadata')
        real_final = raw._assert_unchanged
        config = self.repo / '.git/config'
        original = config.read_bytes()
        before = fixture.inventory(self.repo)
        for drift in (False, True):
            tails = []

            def delayed_final(state):
                tails.append(True)
                time.sleep(max(0, state['deadline'] - time.monotonic()) + 0.03)
                if drift:
                    config.write_bytes(original + b'\n')
                # The real snapshot, binary identity, and deadline checks run.
                return real_final(state)

            try:
                with self.subTest(drift=drift), \
                        mock.patch.object(raw, '_assert_unchanged', side_effect=delayed_final), \
                        mock.patch.object(raw, '_repository_snapshot', wraps=raw._repository_snapshot) as snapshots:
                    error = self.assert_error('metadata_changed' if drift else 'size_exceeded', limits=limits)
                    self.assertEqual(snapshots.call_count, 2)
                    self.assertEqual(tails, [True])
                    if not drift:
                        self.assertEqual(error.reason, 'result_metadata')
                        self.assertEqual(fixture.inventory(self.repo), before)
            finally:
                config.write_bytes(original)
        self.assert_observed(self.read())

    def test_final_binary_resolution_failure_is_metadata_changed(self):
        self.prepare_pair()
        raw = importlib.import_module('local_git_object')
        actual_entry = raw._select_git().resolve(strict=True)
        entry = self.root / 'temporary-git-entry'
        entry.symlink_to(actual_entry)
        before = fixture.inventory(self.repo)
        command = raw._git_command
        hits = []

        def interfere(binary, directory, env, args, limit, limits, deadline, *, phase):
            output = command(binary, directory, env, args, limit, limits, deadline, phase=phase)
            if args == ['cat-file', 'commit', self.current] and not hits:
                hits.append(True)
                entry.unlink()
                entry.symlink_to(entry.name)
            return output

        # Only the external selection leaf is redirected to a controlled temp
        # symlink; actual identity, Git execution, OID reads and tail stay real.
        with mock.patch.object(raw, '_select_git', return_value=entry):
            self.assert_observed(self.read())
            with mock.patch.object(raw, '_git_command', side_effect=interfere), \
                    mock.patch.object(raw, '_repository_snapshot', wraps=raw._repository_snapshot) as snapshots:
                error = None
                try:
                    self.read()
                except self.module().CommitDeltaReadError as caught:
                    error = caught
                self.assertEqual(hits, [True], 'The real candidate commit must be read first')
                self.assertTrue(entry.is_symlink())
                self.assertEqual(entry.readlink(), Path(entry.name))
                self.assertEqual(snapshots.call_count, 2)
                self.assertEqual(fixture.inventory(self.repo), before)
                self.assertIsNotNone(error)
                # resolve() differs across supported Python versions; the
                # public meaning of an unreadable final identity is fixed.
                self.assertEqual(error.code, 'metadata_changed')
        entry.unlink()
        self.assert_observed(self.read())

    def test_actual_shared_scope_does_not_repeat_binary_or_repository_observations_for_each_object(self):
        self.prepare_pair()
        raw = importlib.import_module('local_git_object')
        with mock.patch.object(raw, '_binary_identity', wraps=raw._binary_identity) as binary, \
                mock.patch.object(raw, '_repository_snapshot', wraps=raw._repository_snapshot) as repository:
            self.assert_observed(self.read())
        self.assertEqual(binary.call_count, 2)
        self.assertEqual(repository.call_count, 2)

    def test_expected_rows_are_frozen_before_io_and_cannot_change_the_active_comparison(self):
        self.prepare_pair()
        original = copy.deepcopy(self.expected)

        def mutate():
            self.expected[0]['sha256'] = '0' * 64
            self.expected.append(self.row('invented-after-admission', deleted=True))

        with self.at_child(lambda argv: 'cat-file' in argv and self.current in argv, mutate):
            result = self.read()
        self.expected = original
        self.assert_observed(result)

    def test_real_promisor_required_bodies_share_the_scope_without_lazy_fetch_or_repo_writes(self):
        self.prepare_pair()
        needed = {fixture.object_oid('blob', body) for body in (
            b'old page\n', b'new page\n', b'new body\n', b'remove this body\n', b'{"same":true}\n')}
        missing_oid = fixture.object_oid('blob', b'new page\n')
        partial, canary = fixture.create_promisor(self.root, self.repo, missing_oid, name='delta-partial')
        for oid in needed:
            target = partial / '.git/objects' / oid[:2] / oid[2:]
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(self.repo / '.git/objects' / oid[:2] / oid[2:], target)
        before = fixture.inventory(partial)
        self.assert_observed(self.read(repo=partial))
        self.assertFalse(canary.exists())
        self.assertEqual(fixture.inventory(partial), before)
        missing_path = partial / '.git/objects' / missing_oid[:2] / missing_oid[2:]
        missing_path.unlink()
        environment = fixture.git_environment(self.root)
        environment['GIT_ALLOW_PROTOCOL'] = 'ext'
        control = fixture.git(partial, 'cat-file', 'blob', missing_oid, environment=environment, check=False)
        self.assertNotEqual(control.returncode, 0)
        self.assertEqual(canary.read_text().splitlines(), ['entered'])
        before = fixture.inventory(partial)
        calls = []
        real = subprocess.Popen

        def popen(argv, *args, **kwargs):
            tokens = list(argv)
            if 'cat-file' in tokens and missing_oid in tokens:
                calls.append((tokens, kwargs.get('env', {})))
            return real(argv, *args, **kwargs)

        with mock.patch.object(subprocess, 'Popen', side_effect=popen):
            self.assert_error('object_unavailable', repo=partial)
        self.assertTrue(calls, 'The actual missing required blob must reach the new scope runner')
        for tokens, env in calls:
            self.assertIn('--no-lazy-fetch', tokens)
            self.assertIn('--no-replace-objects', tokens)
            self.assertEqual(env['GIT_ALLOW_PROTOCOL'], '')
            self.assertEqual(env['GIT_NO_LAZY_FETCH'], '1')
        self.assertEqual(canary.read_text().splitlines(), ['entered'])
        self.assertEqual(fixture.inventory(partial), before)


if __name__ == '__main__':
    unittest.main()
