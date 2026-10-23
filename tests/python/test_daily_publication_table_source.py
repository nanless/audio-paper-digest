"""Authenticated daily source propagation across the shared publication gate."""
import copy
import gzip
import hashlib
import json
import sys
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_daily_fresh_publish_gate import _daily_payload, publish_to_blog as publisher
from publish_common import (_publication_table_source_text, PublishDataValidationError,
                            EXPERIMENT_TABLE_CONTRACT_VERSION)

ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def verified_input(*, ids=('2609.12341',), prepare=None, source_texts=None):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / 'sources'
        payload = _daily_payload(root, ids, source_texts=source_texts)
        if prepare:
            prepare(payload)
        data = Path(directory) / 'result.json'
        data.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        with mock.patch.object(publisher, 'DAILY_FRESH_SOURCE_RUNS_DIR', root):
            yield root, data, payload


def source_directory(root, payload, paper_id=None):
    return root / payload['dailyFreshSourceRun']['runId'] / 'sources' / (
        paper_id or payload['papers'][0]['arxivId']) / 'generation-000001'


class DailyPublicationTableSourceTest(unittest.TestCase):
    def test_scope_uses_actual_source_and_accepts_unchanged_deepcopy(self):
        with verified_input() as (root, data, payload):
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            raw_assert, raw_reader = publisher._daily_publication_operation_state(owner)
            original = (source_directory(root, payload) / 'source.txt').read_text()
            with publisher._daily_publication_table_source_scope(owner) as capability:
                self.assertEqual(_publication_table_source_text(copy.deepcopy(payload['papers'][0]), capability), original)
            with self.assertRaises(PublishDataValidationError):
                _publication_table_source_text(payload['papers'][0], capability)
            with self.assertRaises(PublishDataValidationError):
                raw_reader(payload['papers'][0])
            with self.assertRaises(PublishDataValidationError):
                raw_assert()
            with self.assertRaises(PublishDataValidationError):
                with publisher._daily_publication_table_source_scope(owner):
                    self.fail('expired owner must not reenter')

    def test_owner_is_opaque_and_fake_clone_or_unfinished_run_cannot_authorize(self):
        with verified_input(ids=('2609.12341', '2609.12342')) as (root, data, payload):
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            for key, value in (('records', {'text': 'forged'}), ('source_bytes', b'forged'), ('text', 'forged')):
                with self.assertRaises(AttributeError):
                    setattr(owner, key, value)
            for fake in ({'records': 'forged'}, str(data), copy.copy(owner), publisher._DailyPublicationTableSourceOperation()):
                with self.assertRaises(PublishDataValidationError):
                    with publisher._daily_publication_table_source_scope(fake):
                        self.fail('fake owner must not enter')
            (source_directory(root, payload, '2609.12342') / 'source.pdf').unlink()
            with self.assertRaises(PublishDataValidationError):
                publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            with self.assertRaises(PublishDataValidationError):
                with publisher._daily_publication_table_source_scope(owner):
                    self.fail('changed source must revoke owner')
            self.assertNotIn(owner, publisher._DAILY_PUBLICATION_SOURCE_OPERATIONS)

    def test_daily_missing_capability_never_uses_manual_claims_or_source_field(self):
        with verified_input() as (_, _, payload):
            paper = payload['papers'][0]
            paper['sourceText'] = 'forged source field'
            paper['analysisManifest']['manualTakeover'] = {'resultClaims': [{'sourceQuote': 'manual quote'}]}
            for top_proof in (True, False):
                item = copy.deepcopy(paper)
                if not top_proof:
                    item.pop('freshRewriteProvenance')
                with self.subTest(top_proof=top_proof), self.assertRaises(PublishDataValidationError):
                    _publication_table_source_text(item)
                for fake in ({'text': 'forged'}, 'manual quote', str(Path('/fake/source.txt'))):
                    with self.assertRaises(PublishDataValidationError):
                        _publication_table_source_text(item, fake)

    def test_manual_and_non_daily_conference_provenance_keep_original_path(self):
        manual = {'analysisManifest': {'manualTakeover': {'resultClaims': [{'sourceQuote': 'original manual evidence'}]}}}
        self.assertEqual(_publication_table_source_text(manual), 'original manual evidence')
        conference = copy.deepcopy(manual)
        conference['freshRewriteProvenance'] = {'contract': 'fresh-conference-source-analysis-v1', 'sourceGeneration': 1}
        self.assertEqual(_publication_table_source_text(conference), 'original manual evidence')
        historical = copy.deepcopy(manual)
        historical['freshRewriteProvenance'] = {'contract': 'fresh-source-analysis-v1', 'runId': 'legacy-manual'}
        self.assertEqual(_publication_table_source_text(historical), 'original manual evidence')

    def test_protected_entire_paper_not_just_analysis_and_source(self):
        def prepare(payload):
            payload['papers'][0].update(title='Original title', authors=['Original Author'], analysis='Original analysis', core='original')
        with verified_input(prepare=prepare) as (_, data, payload):
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            with publisher._daily_publication_table_source_scope(owner) as capability:
                for key, value in (('title', 'forged'), ('authors', ['Other']), ('analysis', 'different'),
                                   ('core', 'forged'), ('sourceText', 'forged'), ('sourceSha256', '0' * 64),
                                   ('normalizedArxivId', '2609.12342')):
                    item = copy.deepcopy(payload['papers'][0]); item[key] = value
                    with self.subTest(field=key), self.assertRaises(PublishDataValidationError):
                        _publication_table_source_text(item, capability)

    def test_each_source_file_and_input_and_run_reread_on_use_and_scope_return(self):
        for name in ('source.txt', 'source.pdf', 'source-runtime.json', 'source-manifest.json', 'input', 'run'):
            for at_exit in (False, True):
                with self.subTest(file=name, at_exit=at_exit), verified_input() as (root, data, payload):
                    owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
                    file = (data if name == 'input' else root / payload['dailyFreshSourceRun']['runId'] / 'run.json'
                            if name == 'run' else source_directory(root, payload) / name)
                    with self.assertRaises(PublishDataValidationError):
                        with publisher._daily_publication_table_source_scope(owner) as capability:
                            file.write_bytes(file.read_bytes() + b'changed')
                            if not at_exit:
                                _publication_table_source_text(payload['papers'][0], capability)
                    self.assertNotIn(owner, publisher._DAILY_PUBLICATION_SOURCE_OPERATIONS)

    def test_only_complete_existing_image_exclusion_projection_can_read_source(self):
        url = 'https://arxiv.org/html/2609.12341/Fig1.png'
        def prepare(payload):
            payload['papers'][0].update(analysis=f'Before.\n\n![Figure]({url})\n\nAfter.',
                                       selectedImageUrls=[url], parsed={})
        with verified_input(prepare=prepare) as (_, data, payload):
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            original = payload['papers'][0]
            exclusion = {'normalizedArxivId': original['arxivId'], 'url': url, 'reason': 'Source image is blank and cannot support this paragraph.'}
            # Legacy image projection changes parsed content only if it has strings;
            # the exact current helper still supplies the full view and original SHA proof.
            derived = publisher.apply_publish_image_exclusions([original], [exclusion])[0]
            with publisher._daily_publication_table_source_scope(owner) as capability:
                self.assertTrue(_publication_table_source_text(derived, capability))
                for mutate in (lambda p: p.update(title='forged'), lambda p: p.update(authors=['Other']),
                               lambda p: p.update(core='forged'), lambda p: p['publishImageExclusionView'].update(sourceAnalysisSha256='0' * 64),
                               lambda p: p['analysisManifest']['sourceAcquisition'].update(sourceSha256='0' * 64)):
                    forged = copy.deepcopy(derived); mutate(forged)
                    with self.assertRaises(PublishDataValidationError):
                        _publication_table_source_text(forged, capability)

    def test_date_member_proof_and_forged_reference_fail_before_owner_is_issued(self):
        mutations = (lambda p: p['dailyFreshSourceRun'].update(batchDate='2026-09-06'), lambda p: p['papers'].pop(),
                     lambda p: p['papers'][1]['freshRewriteProvenance'].update(sourceSha256='0' * 64),
                     lambda p: p['dailyFreshSourceRun'].update(path='/fake/source.txt'))
        for mutate in mutations:
            with self.subTest(mutation=mutate), verified_input(ids=('2609.12341', '2609.12342')) as (_, data, payload):
                mutate(payload); data.write_text(json.dumps(payload))
                before = len(publisher._DAILY_PUBLICATION_SOURCE_OPERATIONS)
                with self.assertRaises(PublishDataValidationError):
                    publisher.validate_daily_fresh_sources_for_publish(data, '2026-09-07')
                self.assertEqual(len(publisher._DAILY_PUBLICATION_SOURCE_OPERATIONS), before)

    def test_review_and_push_source_reference_replay_same_full_source_gate(self):
        with verified_input() as (root, data, payload):
            reference = publisher.build_generation_input_source_reference(data)
            manifest = {'inputSourceReference': reference}
            self.assertEqual(publisher.validate_generation_input_source_reference(manifest, payload['batchDate']), str(data.resolve()))
            (source_directory(root, payload) / 'source-runtime.json').write_bytes(b'forged')
            with self.assertRaises(PublishDataValidationError):
                publisher.validate_generation_input_source_reference(manifest, payload['batchDate'])

    def test_pending_author_semantic_failure_does_not_mint_source_owner(self):
        with verified_input() as (_, data, payload):
            before = len(publisher._DAILY_PUBLICATION_SOURCE_OPERATIONS)
            with mock.patch.object(publisher, '_flush_reader_author_replay_batch',
                                   side_effect=PublishDataValidationError('actual author semantic replay failed')):
                with self.assertRaisesRegex(PublishDataValidationError, 'author semantic'):
                    publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            self.assertEqual(len(publisher._DAILY_PUBLICATION_SOURCE_OPERATIONS), before)

    def test_both_normal_preflights_keep_capability_across_exact_normalized_view(self):
        from test_publish_common import complete_paper, attach_tag_stage_record
        from publish_common import validate_papers_for_publish, EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION
        def prepare(payload):
            paper = payload['papers'][0]
            original_manifest = paper['analysisManifest']
            paper.update(complete_paper())
            paper['parsed']['summary'] = 'Old non-scoring cached summary.'
            original_manifest.update(version=1, contracts={'experimentTables': EXPERIMENT_TABLE_LEGACY_CONTRACT_VERSION},
                stages={name: {'status': status} for name, status in {
                    'imageDownload': 'complete', 'primaryAnalysis': 'complete',
                    'openSourceScan': 'complete', 'demoLinkScan': 'not_needed',
                    'revision': 'complete', 'tableRepair': 'not_needed',
                    'methodRepair': 'not_needed', 'structureRepair': 'not_needed',
                    'scoringAudit': 'complete', 'imageSupplement': 'no_candidates',
                }.items()})
            paper['analysisManifest'] = original_manifest
            attach_tag_stage_record(paper, original_manifest)
        with verified_input(ids=('2607.00001',), prepare=prepare) as (_, data, payload):
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            with self.assertRaisesRegex(PublishDataValidationError, 'capability'):
                validate_papers_for_publish(payload['papers'])
            with publisher._daily_publication_table_source_scope(owner) as capability:
                first = validate_papers_for_publish(payload['papers'], _daily_source_capability=capability)
                self.assertNotEqual(first[0]['parsed'], payload['papers'][0]['parsed'])
                view = publisher.apply_publish_image_exclusions(first, [])
                second = validate_papers_for_publish(view, validate_manual_stage_records=False,
                                                     _daily_source_capability=capability)
                self.assertEqual(first, second)

    def test_real_hearing_manuscript_source_reaches_shared_table_contract(self):
        fixture = json.loads(gzip.decompress((ROOT / 'tests/fixtures/validate-daily-source-20261023-real.json.gz').read_bytes()))
        sources = json.loads(gzip.decompress((ROOT / 'tests/fixtures/structure-checkpoint-20261023-real.json.gz').read_bytes()))['papers']
        source = next(p['sourceText'] for p in sources if p['paperId'] == fixture['paperId'])
        self.assertEqual(hashlib.sha256(source.encode()).hexdigest(), fixture['sourceSha256'])
        self.assertEqual(hashlib.sha256(fixture['analysis'].encode()).hexdigest(), fixture['analysisSha256'])
        def prepare(payload):
            paper = payload['papers'][0]; paper['analysis'] = fixture['analysis']
            paper['analysisManifest']['contracts'] = {'experimentTables': EXPERIMENT_TABLE_CONTRACT_VERSION}
            paper['analysisManifest']['sourceAcquisition']['modelTextSanitizationContract'] = 'model-text-unicode-scalars-v1'
        with verified_input(ids=(fixture['paperId'],), source_texts={fixture['paperId']: source}, prepare=prepare) as (_, data, payload):
            # This checks the real source-aware table with the same full-run source4
            # proof gate used by generate and generation-reference replay (review/push).
            owner = publisher.validate_daily_fresh_sources_for_publish(data, payload['batchDate'])
            with publisher._daily_publication_table_source_scope(owner) as capability:
                self.assertEqual(_publication_table_source_text(payload['papers'][0], capability), source)
            manifest = {'inputSourceReference': publisher.build_generation_input_source_reference(data)}
            self.assertEqual(publisher.validate_generation_input_source_reference(manifest, payload['batchDate']), str(data.resolve()))


if __name__ == '__main__':
    unittest.main()
