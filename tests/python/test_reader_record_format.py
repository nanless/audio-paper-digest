import copy
import unittest

from test_publish_to_blog import publish_to_blog as pub, llm_api_publication_fixture, reseal_llm_api_reader_fixture
import protocol_codec as codec
import reader_record_format as formats


def current_paper(original):
    paper = copy.deepcopy(original)
    plan = paper['apiReaderPlan']
    del plan['version']
    plan.update(codec.record_header(codec.contract('beginner-researcher'), 'beginner-researcher'))
    source = codec.record_header(codec.contract('api-reader-source-bindings'), 'api-reader-source-bindings')
    plan['sourceBindingsContract'] = source['contract']
    plan['sourceBindingsSchemaFingerprint'] = source['schemaFingerprint']
    contracts = paper['analysisManifest']['contracts']
    contracts.update(apiReaderArticle=plan['contract'], apiReaderSourceBindings=source['contract'])
    stage = paper['analysisManifest']['stages']['apiReaderArticle']
    for key in formats.LEGACY['flatStageFields']:
        stage.pop(key, None)
    stage['readerProtocols'] = codec.record('reader-pipeline', {
        role: codec.record_header(codec.contract(family), family)
        for role, family in formats.LEGACY['pipelineRoles'].items()
    })
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


class ReaderRecordFormatTest(unittest.TestCase):
    def test_original_and_current_full_publication_reader_keep_same_content_and_actual_headers(self):
        old = llm_api_publication_fixture()
        before = copy.deepcopy(old)
        original = pub._api_reader_payload(old)
        current = pub._api_reader_payload(current_paper(old))
        self.assertEqual(old, before)
        self.assertEqual(current['article'], original['article'])
        self.assertEqual(current['renderedArticle'], original['renderedArticle'])
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
