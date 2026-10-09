"""真实完整 v6 文章按外层模型规则读取，旧样本不改字节。"""
import copy
import hashlib
import json
import subprocess
import unittest
from pathlib import Path
from test_publish_to_blog import manual_v6_publication_fixture, publish_to_blog as publisher
from publish_common import (validate_manual_v6_payload, _validate_manual_takeover_manifest,
    _manual_v6_hash, _manual_hash, PublishDataValidationError)

POLICY = 'manual-agents-sol-high-v2'


def rebind(paper):
    bundle = paper['manualReaderLongform']
    sha = _manual_v6_hash(bundle)
    paper['manualV6Provenance']['readerLongformSha256'] = sha
    takeover = paper['analysisManifest']['manualTakeover']
    takeover['v6Provenance'] = copy.deepcopy(paper['manualV6Provenance'])
    paper['analysisManifest']['sourceAcquisition']['readerLongformSha256'] = sha
    for field in ('researchBrief', 'scoringCalibration', 'readabilityRubric'):
        if field in takeover:
            takeover[field + 'Sha256'] = _manual_hash(takeover[field])
    return paper


def current_paper():
    paper = manual_v6_publication_fixture()
    manifest = paper['analysisManifest']; takeover = manifest['manualTakeover']
    manifest['modelPolicy'] = takeover['modelPolicy'] = POLICY
    takeover['version'] = 2
    manifest['contracts']['perPaperSubagent'] = 'isolated-single-paper-v2'
    bundle = paper['manualReaderLongform'];bundle['modelPolicy'] = POLICY
    for field, role in (('authorReceipt', 'author'), ('finalRevisionAuthorReceipt', 'author_revision')):
        bundle[field].update(version=2, modelPolicy=POLICY, model='gpt-6.1-sol', role=role,
                             outputSha256='7' * 64)
    tasks = paper['manualV6Provenance']['taskNames']
    identity = {'modelPolicy': POLICY, 'model': 'gpt-6.1-sol', 'reasoningEffort': 'high'}
    takeover['researchBrief'].update(modelPolicy=POLICY, contract='audio-researcher-v1', audience='audio_researcher',
        paperSubagent={**identity, 'version': 2, 'paperId':paper['arxivId'], 'taskName':tasks['author'],
                      'singlePaperOnly':True, 'isolatedContext':True,'completedAt':'2026-08-28T09:20:00+08:00'})
    takeover['scoringCalibration'] = {**identity, 'version':1, 'independentReview':True,
                                      'reviewerTaskName':tasks['technicalScoring']}
    takeover['readabilityRubric'] = {**identity, 'paperId':paper['arxivId'],'independentReview':True,
                                    'reviewerTaskName':tasks['pedagogyReadability']}
    return rebind(paper)


class ManualV6ModelPolicyTest(unittest.TestCase):
    def test_identity_helper_requires_explicit_trusted_policy_and_does_not_default_none_to_legacy(self):
        from manual_agent_policy import analysis_identity_error
        legacy={'model':'gpt-5.6-terra','reasoningEffort':'high'}
        for policy in (None,False,'','unknown'):
            with self.subTest(policy=policy):self.assertIsNotNone(analysis_identity_error(legacy,policy))
        self.assertIsNone(analysis_identity_error(legacy,'manual-agents-terra-high-v1'))

    def test_declared_policy_cannot_skip_the_public_takeover_check_when_takeover_is_missing(self):
        paper=current_paper();m=paper['analysisManifest'];m.pop('manualTakeover')
        with self.assertRaises(PublishDataValidationError):
            _validate_manual_takeover_manifest(paper,m,paper['arxivId'])

    def test_original_complete_legacy_fixture_still_reads_without_any_mutation(self):
        paper=manual_v6_publication_fixture();raw=json.dumps(paper,ensure_ascii=False)
        actual=validate_manual_v6_payload(paper)
        self.assertEqual(publisher._manual_reader_article(paper, None),actual['article'])
        self.assertEqual(json.dumps(paper,ensure_ascii=False),raw)
        self.assertNotIn('version',paper['manualReaderLongform']['authorReceipt'])

    def test_current_complete_article_is_accepted_by_public_validator_and_real_renderer(self):
        paper=current_paper();before=copy.deepcopy(paper)
        actual=validate_manual_v6_payload(paper)
        self.assertEqual(publisher._manual_reader_article(paper, None),actual['article'])
        self.assertEqual(paper,before)
        self.assertIn('7.1%',actual['article'])
        self.assertIn('L = -log p(y|x)',actual['article'])

    def test_actual_signed_v6_takeover_entry_checks_current_policy_before_its_early_return(self):
        paper=current_paper();m=paper['analysisManifest'];mode='signed-v6-task-evidence-override-v1'
        m['contracts']['editorialQuality']='reader-facing-v1'
        paper['manualV6CompatibilityMode']=mode
        paper['manualV6Provenance']['v5BridgeMode']=mode
        m['sourceAcquisition']['v5BridgeMode']=mode
        rebind(paper)
        _validate_manual_takeover_manifest(paper,m,paper['arxivId'])
        m['manualTakeover']['modelPolicy']='unknown'
        with self.assertRaises(PublishDataValidationError):
            _validate_manual_takeover_manifest(paper,m,paper['arxivId'])

    def test_outer_policy_and_contract_copies_cannot_mix_even_after_hash_rebinding(self):
        for location,key,value in [('manifest','modelPolicy',None),('takeover','modelPolicy',None),
                ('manifest','modelPolicy','unknown'),('takeover','version',1),
                ('contracts','perPaperSubagent','isolated-single-paper-v1')]:
            paper=current_paper();m=paper['analysisManifest'];target={'manifest':m,'takeover':m['manualTakeover'],'contracts':m['contracts']}[location]
            if value is None:target.pop(key)
            else:target[key]=value
            rebind(paper)
            with self.subTest(location=location,key=key),self.assertRaises(PublishDataValidationError):
                validate_manual_v6_payload(paper)

    def test_current_receipt_and_research_review_identities_cannot_self_select_or_omit_fields(self):
        mutations=[]
        for field in ['authorReceipt','finalRevisionAuthorReceipt']:
            for key,value in [('model','gpt-5.6-terra'),('version',1),('modelPolicy',None),('reasoningEffort',None)]:
                mutations.append(('bundle',field,key,value))
        for field in ['scoringCalibration','readabilityRubric']:
            for key,value in [('model','gpt-5.6-terra'),('modelPolicy',None),('reviewerTaskName','other-task')]:
                mutations.append(('takeover',field,key,value))
        for location,field,key,value in mutations:
            paper=current_paper();target=paper['manualReaderLongform'][field] if location=='bundle' else paper['analysisManifest']['manualTakeover'][field]
            if value is None:target.pop(key)
            else:target[key]=value
            rebind(paper)
            with self.subTest(field=field,key=key),self.assertRaises(PublishDataValidationError):
                publisher._manual_reader_article(paper, None)

    def test_old_context_rejects_new_nested_identity_and_unknown_markers(self):
        for location in ['manifest','takeover','bundle','authorReceipt','finalRevisionAuthorReceipt']:
            paper=manual_v6_publication_fixture();m=paper['analysisManifest'];b=paper['manualReaderLongform']
            target={'manifest':m,'takeover':m['manualTakeover'],'bundle':b,
                    'authorReceipt':b['authorReceipt'],'finalRevisionAuthorReceipt':b['finalRevisionAuthorReceipt']}[location]
            target['modelPolicy']=POLICY;rebind(paper)
            with self.subTest(location=location),self.assertRaises(PublishDataValidationError):validate_manual_v6_payload(paper)
        for value in [None,'',False,'unknown','manual-agents-terra-high-v1']:
            paper=manual_v6_publication_fixture();paper['analysisManifest']['modelPolicy']=value
            with self.subTest(value=value),self.assertRaises(PublishDataValidationError):validate_manual_v6_payload(paper)

    def test_old_takeover_early_branch_rejects_current_or_unknown_markers_before_reading_old_body(self):
        for value in [POLICY,'unknown']:
            paper={'arxivId':'2608.30001','analysisManifest':{'contracts':{'manualDepth':'full-text-evidence-v3'},
                    'manualTakeover':{'version':1,'modelPolicy':value}}}
            with self.subTest(value=value),self.assertRaisesRegex(PublishDataValidationError,'模型规则'):
                _validate_manual_takeover_manifest(paper,paper['analysisManifest'],paper['arxivId'])

    def test_old_early_return_cannot_borrow_nested_current_task_identity(self):
        paper={'arxivId':'2608.30001','analysisManifest':{'contracts':{'manualDepth':'full-text-evidence-v3'},
            'manualTakeover':{'version':1,'researchBrief':{'paperSubagent':{'version':2,'modelPolicy':POLICY,'model':'gpt-6.1-sol','reasoningEffort':'high'}}}}}
        with self.assertRaises(PublishDataValidationError):
            _validate_manual_takeover_manifest(paper,paper['analysisManifest'],paper['arxivId'])

    def test_new_identity_does_not_relax_original_table_formula_or_block_content_checks(self):
        for kind in ['number','formula','shortblock']:
            paper=current_paper();bundle=paper['manualReaderLongform']
            if kind=='number':bundle['tables'][0]['coveredNumericCellIds']=[]
            elif kind=='formula':bundle['formulas'][0]['explanation']='不符'
            else:bundle['blocks'][0]['markdown']='短文'
            rebind(paper)
            with self.subTest(kind=kind),self.assertRaises(PublishDataValidationError):validate_manual_v6_payload(paper)

    def test_current_bundle_hash_matches_actual_node_v6_hash_protocol(self):
        paper=current_paper();root=Path(__file__).resolve().parents[2]
        code="const fs=require('fs');const {stableSignatureSha256}=require('./manual/scripts/manual-signature-contract.js');console.log(stableSignatureSha256(JSON.parse(fs.readFileSync(0,'utf8'))))"
        # 使用同一生产校验规则，由 Node 独立计算；不调用模型或网络。
        completed=subprocess.run(['node','-e',code],cwd=root,input=json.dumps(paper['manualReaderLongform']),capture_output=True,text=True)
        self.assertEqual(completed.returncode,0,completed.stderr)
        self.assertEqual(completed.stdout.strip(),_manual_v6_hash(paper['manualReaderLongform']))

if __name__=='__main__':unittest.main()
