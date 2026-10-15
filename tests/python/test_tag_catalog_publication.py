import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
import tag_catalog_publication as guard
from tag_catalog import load_tag_catalog
from blog_entry_loader import load_publish_to_blog

sys.path.insert(0, str(Path(__file__).resolve().parent))
from project_env_isolation import isolate_module_environment
setUpModule, tearDownModule = isolate_module_environment()


class TagCatalogPublicationTest(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        repo = Path(temp.name).resolve()
        source = load_tag_catalog()
        publisher = load_publish_to_blog()
        snapshot = publisher.build_tag_catalog_snapshot(source)
        versions = {'contract': publisher.TAG_CATALOG_VERSIONS_CONTRACT,
                    'currentSha256': source['registrySha256'], 'snapshots': [snapshot]}
        values = {'tag-catalog-snapshot.json': snapshot,
                  'tag-catalog-versions.json': versions,
                  f'tag-catalog-history/{source["registrySha256"]}.json': snapshot}
        for name, value in values.items():
            self.write_pair(repo, name, value)
        return repo, source, snapshot, versions

    def write_pair(self, repo, name, value):
        raw = (json.dumps(value, ensure_ascii=False, sort_keys=True) + '\n').encode()
        for prefix in ('data', 'static/data'):
            target = repo / prefix / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)

    def test_real_source_and_exact_six_installed_files_are_read_only(self):
        repo, source, _, _ = self.fixture()
        before = {p.relative_to(repo).as_posix(): p.read_bytes()
                  for p in repo.rglob('*') if p.is_file()}
        result = guard.validate_published_tag_catalog(
            repo, source['registrySha256'], source['version'])
        self.assertTrue(result['valid'])
        self.assertEqual(len(result['files']), 6)
        self.assertEqual(result['sourceCatalogSha256'], source['registrySha256'])
        self.assertEqual(before, {p.relative_to(repo).as_posix(): p.read_bytes()
                                for p in repo.rglob('*') if p.is_file()})

    def test_missing_or_changed_mirror_unknown_version_and_symlink_fail_closed(self):
        for mutation in ('missing', 'bytes', 'version', 'symlink'):
            with self.subTest(mutation=mutation):
                repo, source, _, _ = self.fixture()
                target = repo / 'static/data/tag-catalog-versions.json'
                if mutation == 'missing':
                    target.unlink()
                elif mutation == 'bytes':
                    target.write_bytes(target.read_bytes() + b' ')
                elif mutation == 'symlink':
                    original = repo / 'saved.json'
                    original.write_bytes(target.read_bytes())
                    target.unlink()
                    target.symlink_to(original)
                version = 'wrong-version' if mutation == 'version' else source['version']
                with self.assertRaisesRegex(ValueError, '受控词表发布同步'):
                    guard.validate_published_tag_catalog(repo, source['registrySha256'], version)

    def test_forged_consistent_catalog_or_missing_archive_is_rejected(self):
        for mutation in ('label', 'path', 'archive', 'duplicate'):
            with self.subTest(mutation=mutation):
                repo, source, snapshot, versions = self.fixture()
                changed = copy.deepcopy(snapshot)
                if mutation == 'label':
                    changed['concepts'][0]['zh'] += '伪造'
                elif mutation == 'path':
                    child = next(x for x in changed['concepts'] if x['ancestorIds'])
                    child['ancestorIds'] = []
                if mutation in ('label', 'path'):
                    versions['snapshots'] = [changed]
                    self.write_pair(repo, 'tag-catalog-snapshot.json', changed)
                    self.write_pair(repo, 'tag-catalog-versions.json', versions)
                    self.write_pair(repo, f'tag-catalog-history/{source["registrySha256"]}.json', changed)
                elif mutation == 'archive':
                    (repo / 'data/tag-catalog-history' / f'{source["registrySha256"]}.json').unlink()
                else:
                    versions['snapshots'].append(copy.deepcopy(snapshot))
                    self.write_pair(repo, 'tag-catalog-versions.json', versions)
                with self.assertRaisesRegex(ValueError, '受控词表发布同步'):
                    guard.validate_published_tag_catalog(repo, source['registrySha256'], source['version'])

    def test_original_config_archive_must_have_real_whole_file_sha(self):
        repo, source, _, _ = self.fixture()
        config = repo / 'config/tag-catalog.json'
        config.parent.mkdir()
        config.write_bytes(b'{}')
        archived = config.parent / 'tag-catalog-history' / f'{source["registrySha256"]}.json'
        archived.parent.mkdir()
        archived.write_bytes(Path(guard.tag_paths.TAG_CATALOG_FILE).read_bytes())
        publisher = load_publish_to_blog()
        with mock.patch.object(guard.tag_paths, 'TAG_CATALOG_FILE', str(config)), \
                mock.patch.object(guard, 'load_publish_to_blog', return_value=publisher):
            result = guard.validate_published_tag_catalog(repo, source['registrySha256'], source['version'])
            self.assertTrue(result['valid'])
            archived.write_bytes(archived.read_bytes() + b' ')
            with self.assertRaisesRegex(ValueError, '原词表字节'):
                guard.validate_published_tag_catalog(repo, source['registrySha256'], source['version'])


if __name__ == '__main__':
    unittest.main()
