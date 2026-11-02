import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_publish_to_blog import publish_to_blog as publish

ROOT = Path(__file__).resolve().parents[2]
CASES = json.loads((ROOT / 'tests/fixtures/mflow-source-display-cases.json').read_text())


class MFlowSourceDisplayTests(unittest.TestCase):
    def test_non_daily_component_route_is_preserved_without_granting_daily_publication(self):
        run_id = '00000000-0000-4000-8000-000000000000'
        proof = {'contract': 'fresh-source-analysis-v1', 'runId': run_id}
        paper = {'freshRewriteProvenance': proof, 'analysisManifest': {'freshRewriteProvenance': copy.deepcopy(proof)},
                 'apiReaderPlan': {'tableBindings': [{'sourceType': 'artifact_table'}]}}
        self.assertIsNone(publish._verify_reader_paired_dom_bindings(paper))
        if os.environ.get('MFLOW_DISPLAY_CURRENT_FILE'):
            current = Path(os.environ['MFLOW_DISPLAY_CURRENT_FILE']).read_bytes()
            self.assertEqual(hashlib.sha256(current).hexdigest(), os.environ['MFLOW_DISPLAY_CURRENT_SHA256'])
            data = json.loads(current)
            reference = {**data['dailyFreshSourceRun'], 'runId': run_id}
            with tempfile.NamedTemporaryFile(mode='w+', encoding='utf-8') as source:
                json.dump({'dailyFreshSourceRun': reference, 'papers': [paper]}, source)
                source.flush()
                with self.assertRaises(publish.PublishDataValidationError):
                    publish.validate_daily_fresh_sources_for_publish(source.name, '2026-11-02')

    def test_literal_paired_arrows_and_operator_unit_cells_match_node_cases(self):
        for raw, expected in CASES['positive']:
            self.assertEqual(publish._normalize_api_reader_display_artifacts(raw), expected, raw)
        for raw in CASES['unchanged']:
            self.assertEqual(publish._normalize_api_reader_display_artifacts(raw), raw, raw)

    @unittest.skipUnless(os.environ.get('MFLOW_DISPLAY_CURRENT_FILE'), 'Requires explicit SHA-bound real current and paid candidate')
    def test_actual_five_tables_publication_cold_preserves_literal_sources_and_units(self):
        current = Path(os.environ['MFLOW_DISPLAY_CURRENT_FILE'])
        candidate = Path(os.environ['MFLOW_DISPLAY_CANDIDATE_FILE'])
        before = {current: hashlib.sha256(current.read_bytes()).hexdigest(),
                  candidate: hashlib.sha256(candidate.read_bytes()).hexdigest()}
        self.assertEqual(before[current], os.environ['MFLOW_DISPLAY_CURRENT_SHA256'])
        self.assertEqual(before[candidate], os.environ['MFLOW_DISPLAY_CANDIDATE_SHA256'])
        code = r"""
const fs=require('node:fs'),crypto=require('node:crypto');
console.log=()=>{};console.info=()=>{};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const bytes=fs.readFileSync(process.env.MFLOW_DISPLAY_CURRENT_FILE),paid=fs.readFileSync(process.env.MFLOW_DISPLAY_CANDIDATE_FILE);
if(sha(bytes)!==process.env.MFLOW_DISPLAY_CURRENT_SHA256||sha(paid)!==process.env.MFLOW_DISPLAY_CANDIDATE_SHA256)throw Error('actual input SHA differs');
const data=JSON.parse(bytes),candidate=JSON.parse(paid),paper=data.papers.find(p=>p.arxivId==='2610.41852v1');
const daily=require('./scripts/lib/daily-fresh-source-plan'),fresh=require('./scripts/lib/fresh-analysis-context'),deep=require('./scripts/deep-analyzer');
const plan=daily.readDailyFreshSourcePlan(data.dailyFreshSourceRun),source=daily.readDailyFreshSource(plan,paper);
const result=require('./scripts/lib/analysis-stop-control').withModelRequestsForbidden(()=>daily.withDailyFreshAnalysisContext(plan,()=>fresh.withFreshPaperContext(paper,()=>deep.parseApiReaderArticleResult(JSON.stringify(candidate.payload.draft),{
arxivId:paper.arxivId,requiredVersion:3,requireIntegratedTables:true,minimumIntegratedTables:2,requireSourceBindings:true,allowDeterministicQuoteRepair:true,allowDeterministicUnsupportedClaimPruning:true,enforceResourceAvailabilityClaims:true,verifiedResourceIdentity:deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources,source.text),availableFigureOrdinals:candidate.payload.imageEvidence.filter(i=>i.kind==='figure'&&i.status==='ready').map(i=>i.ordinal),structuredArtifacts:source.structuredArtifacts,sourceText:source.text}))));
fs.writeSync(1,JSON.stringify({paper,result,descriptor:source.freshSourceDescriptor,runDir:plan.runDir}));
"""
        output = subprocess.check_output(['node', '-e', code], cwd=ROOT,
                            env={**os.environ, 'VERIFY_PROJECT_DISABLE_FILE_LOGS': '1'}, timeout=60)
        packet = json.loads(output)
        paper = packet['paper']
        paper['apiReaderArticle'] = packet['result']['article']
        paper['apiReaderPlan'] = packet['result']['plan']
        stage = paper['analysisManifest']['stages']['apiReaderArticle']
        # Source-binding component view only: retain the real failed status,
        # scientific upstream and ledger. Nothing is adopted or completed.
        paper['analysisManifest']['contracts']['apiReaderSourceBindings'] = paper['apiReaderPlan']['sourceBindingsContract']
        stage.update(sourceBindingsSha256=paper['apiReaderPlan']['sourceBindingsSha256'],
                     sourceBindingsContractVersion='api-reader-source-bindings-v4',
                     sourceBindingsSourceTextSha256=packet['descriptor']['sourceSha256'],
                     structuredArtifactsSha256=packet['descriptor']['structuredArtifactsSha256'],
                     tableBindingCount=5, formulaBindingCount=len(paper['apiReaderPlan']['formulaBindings']))
        publish._daily_fresh_read_bundle_source_identity(Path(packet['runDir']), '2610.41852', paper['freshRewriteProvenance'], paper)
        publish._validate_api_reader_source_bindings(paper)
        mutations = [
            ('forged cell DOM', lambda p: p['apiReaderPlan']['tableBindings'][0]['cellBindings'][3].update(sourceDomSha256='0' * 64)),
            ('neighbor coordinates', lambda p: p['apiReaderPlan']['tableBindings'][0]['cellBindings'][3].update(sourceColumn=4)),
            ('missing payload', lambda p: p['apiReaderPlan'].pop('structuredSourcePayload')),
            ('table DOM substitution', lambda p: p['apiReaderPlan']['tableBindings'][4].update(sourceTableDomSha256='0' * 64)),
            ('incomplete table', lambda p: p['apiReaderPlan']['tableBindings'][0]['cellBindings'].pop()),
        ]
        def downgrade(p):
            for binding in p['apiReaderPlan']['tableBindings']:
                for cell in binding['cellBindings']:
                    cell.update(sourceText=cell['renderedText'], sourceDomSha256='0' * 64)
        mutations.append(('removed raw markers', downgrade))
        def wrong_source_tables(p):
            for binding in p['apiReaderPlan']['tableBindings']:
                binding['sourceTableOrdinal'] = 9
        mutations.append(('source table ordinal replacement', wrong_source_tables))
        mutations.append(('forged serialized payload', lambda p: p['apiReaderPlan'].update(structuredSourcePayload='forged')))
        for label, before_text, after_text in [
                ('wrong arrow', 'FD↓', 'FD↑'), ('changed precision', '22.23 ± 3.1 s', '22.230 ± 3.1 s'),
                ('changed unit', '5.23 ± 13 ms', '5.23 ± 13 s'),
                ('extra number', '22.23 ± 3.1 s', '22.23 ± 3.1 2 s'),
                ('extra unit', '22.23 ± 3.1 s', '22.23 ± 3.1 s ms')]:
            def replace(p, a=before_text, b=after_text):
                p['apiReaderArticle'] = p['apiReaderArticle'].replace(a, b)
                for binding in p['apiReaderPlan']['tableBindings']:
                    for cell in binding['cellBindings']:
                        if cell['renderedText'] == a:
                            cell['renderedText'] = b
            mutations.append((label, replace))
        for label, mutate in mutations:
            bad = copy.deepcopy(paper)
            mutate(bad)
            binding_sha = publish._stable_json_sha256({key: bad['apiReaderPlan'][key]
                for key in ('tableBindings', 'formulaBindings')})
            bad['apiReaderPlan']['sourceBindingsSha256'] = binding_sha
            bad['analysisManifest']['stages']['apiReaderArticle']['sourceBindingsSha256'] = binding_sha
            with self.subTest(label=label), self.assertRaises(publish.PublishDataValidationError):
                publish._validate_api_reader_source_bindings(bad)
        self.assertEqual([b['sourceTableOrdinal'] for b in paper['apiReaderPlan']['tableBindings']], [1, 2, 6, 7, 9])
        rendered = publish._api_reader_markdown_tables(paper['apiReaderArticle'])
        runtime_file = Path(packet['runDir']) / 'sources/2610.41852/generation-000001/source-runtime.json'
        originals = {table['ordinal']: table for table in json.loads(runtime_file.read_bytes())['structuredArtifacts']['tables']}
        for binding, view in zip(paper['apiReaderPlan']['tableBindings'], rendered):
            original = originals[binding['sourceTableOrdinal']]
            self.assertEqual(binding['sourceTableDomSha256'], original['sourceDomSha256'])
            self.assertEqual(len(view['rows']) + 1, len(original['matrix']))
            self.assertEqual(len(view['header']), len(original['matrix'][0]))
            self.assertEqual(len(binding['cellBindings']), sum(map(len, original['matrix'])))
            for cell in binding['cellBindings']:
                owners = [c for c in original['cells'] if c['row'] <= cell['sourceRow'] < c['row'] + c['rowspan']
                          and c['column'] <= cell['sourceColumn'] < c['column'] + c['colspan']]
                self.assertEqual(len(owners), 1)
                self.assertEqual(cell['sourceText'], owners[0]['text'])
                self.assertEqual(cell['sourceDomSha256'], owners[0]['sourceDomSha256'])
        self.assertEqual(rendered[0]['header'][3:], ['FD↓', 'KL↓', 'IS↑', 'FADv↓', 'CLAP↑', 'FADopenl3↓'])
        self.assertEqual(rendered[1]['rows'][0][1:3], ['22.23 ± 3.1 s', '5.23 ± 13 ms'])
        for file, expected in before.items():
            self.assertEqual(hashlib.sha256(file.read_bytes()).hexdigest(), expected)


if __name__ == '__main__':
    unittest.main()
