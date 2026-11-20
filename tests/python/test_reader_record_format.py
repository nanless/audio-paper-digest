import copy
import unittest

from test_publish_to_blog import publish_to_blog as pub, llm_api_publication_fixture, reseal_llm_api_reader_fixture
import protocol_codec as codec
import reader_record_format as formats


def _upgrade_paper_protocols(original, *, plan_header, cohesive_sections=False):
    paper = copy.deepcopy(original)
    plan = paper['apiReaderPlan']
    del plan['version']
    plan.update(plan_header)
    if cohesive_sections:
        dropped_kinds = {'background', 'related_work', 'experiment_setup', 'reproduction'}
        for section in plan['sections']:
            if section['kind'] in dropped_kinds:
                block = (
                    f"### {section['heading']}\n\n"
                    "这是围绕本篇论文证据展开的教学段落，说明输入、处理、输出、比较口径与不能外推的边界。\n\n"
                )
                paper['apiReaderArticle'] = paper['apiReaderArticle'].replace(block, '', 1)
        plan['sections'] = [s for s in plan['sections'] if s['kind'] not in dropped_kinds]
    source = codec.record_header(codec.contract('api-reader-source-bindings'), 'api-reader-source-bindings')
    plan['sourceBindingsContract'] = source['contract']
    plan['sourceBindingsSchemaFingerprint'] = source['schemaFingerprint']
    contracts = paper['analysisManifest']['contracts']
    contracts.update(apiReaderArticle=plan['contract'], apiReaderSourceBindings=source['contract'])
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    for key in formats.LEGACY['flatStageFields']:
        stage.pop(key, None)
    pipeline_headers = {
        role: codec.record_header(codec.contract(family), family)
        for role, family in formats.LEGACY['pipelineRoles'].items()
    }
    pipeline_headers['article'] = dict(plan_header)
    stage['readerProtocols'] = codec.record('reader-pipeline', pipeline_headers)
    stage['qualityMetrics'] = {**stage['readerProtocols']['qualityMetrics'], 'blockingIssueCount': 0}
    authors = paper['apiReaderAuthors']
    authors['identity'].pop('contract')
    authors['identity'].update(codec.record_header(codec.contract('api-reader-author-identity'), 'api-reader-author-identity'))
    authors['identitySha256'] = pub._stable_json_sha256(authors['identity'])
    resources = paper['apiReaderResources']
    resources.pop('contract')
    resources.update(codec.record_header(codec.contract('api-reader-resource-identity'), 'api-reader-resource-identity'))
    resources.pop('identitySha256')
    resources['identitySha256'] = pub._stable_json_sha256(resources)
    contracts.update(apiReaderAuthorIdentity=authors['identity']['contract'], apiReaderResourceIdentity=resources['contract'])
    for key in formats.IDENTITY_FIELDS.values():
        stage.pop(key, None)
    stage['readerIdentityProtocols'] = formats.identity_group(authors, resources)
    stage.update(readerAuthorsSha256=pub._stable_json_sha256(authors), readerAuthorIdentitySha256=authors['identitySha256'],
                 resourceIdentitySha256=resources['identitySha256'])
    scan = paper['analysisManifest']['stages']['openSourceScan']
    scan.pop('resourceEvidenceContract', None)
    scan.update(resourceEvidenceProtocol=formats.identity_header(resources, 'resources'), resourceEvidenceSha256=resources['identitySha256'])
    return reseal_llm_api_reader_fixture(paper)


def historical_fp_paper(original):
    return _upgrade_paper_protocols(
        original,
        plan_header=codec.historical_header('beginner-researcher', formats.INTEGRATED, formats.OLD_PLAN_FP),
        cohesive_sections=False,
    )


def current_paper(original):
    return _upgrade_paper_protocols(
        original,
        plan_header=codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher'),
        cohesive_sections=True,
    )


class ReaderRecordFormatTest(unittest.TestCase):
    def test_original_and_current_full_publication_reader_keep_same_content_and_actual_headers(self):
        old = llm_api_publication_fixture()
        before = copy.deepcopy(old)
        original = pub._api_reader_payload(old)
        historical_fp = pub._api_reader_payload(historical_fp_paper(old))
        current = pub._api_reader_payload(current_paper(old))
        self.assertEqual(old, before)
        self.assertEqual(historical_fp['article'], original['article'])
        self.assertEqual(historical_fp['renderedArticle'], original['renderedArticle'])
        self.assertEqual(historical_fp['contract'], codec.contract('beginner-researcher'))
        self.assertEqual(historical_fp['schemaFingerprint'], formats.OLD_PLAN_FP)
        self.assertEqual(len(current['plan']['sections']), 8)
        self.assertNotIn('schemaFingerprint', original)
        self.assertNotIn('schemaFingerprint', original['sourceBindingProof'])
        self.assertEqual(current['contract'], codec.contract('beginner-researcher'))
        self.assertEqual(current['schemaFingerprint'], codec.schema_fingerprint('beginner-researcher'))
        self.assertEqual(current['sourceBindingProof']['schemaFingerprint'], codec.schema_fingerprint('api-reader-source-bindings'))
        self.assertNotIn('schemaFingerprint', original['authorIdentityProof'])
        self.assertNotIn('schemaFingerprint', original['resourceIdentityProof'])
        self.assertEqual(current['authorIdentityProof']['schemaFingerprint'], codec.schema_fingerprint('api-reader-author-identity'))
        self.assertEqual(current['resourceIdentityProof']['schemaFingerprint'], codec.schema_fingerprint('api-reader-resource-identity'))

    def test_current_unknown_or_mixed_header_and_changed_source_cannot_fall_back_to_original(self):
        paper = current_paper(llm_api_publication_fixture())
        def bad_fp(p): p['apiReaderPlan']['schemaFingerprint'] = 'f' * 64
        def old_number(p): p['apiReaderPlan']['version'] = 3
        def no_group(p): del p['analysisManifest']['stages']['apiReaderArticle']['readerProtocols']
        def mixed(p): p['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsContractVersion'] = formats.LEGACY['originalHeaders']['sourceBindings']['contract']
        def no_source_fp(p): del p['apiReaderPlan']['sourceBindingsSchemaFingerprint']
        def source_dom(p): p['apiReaderPlan']['formulaBindings'][0]['sourceDomSha256'] = 'f' * 64
        for mutate in (bad_fp, old_number, no_group, mixed, no_source_fp, source_dom):
            changed = copy.deepcopy(paper)
            mutate(changed)
            reseal_llm_api_reader_fixture(changed)
            with self.subTest(mutation=mutate.__name__), self.assertRaises(pub.PublishDataValidationError):
                pub._api_reader_payload(changed)


if __name__ == '__main__':
    unittest.main()
