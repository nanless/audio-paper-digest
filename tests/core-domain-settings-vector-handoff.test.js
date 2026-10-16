'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = process.cwd();
const contractPath = path.join(root, 'scripts/analysis-contract.js');
const contractSource = process.env.CORE_SETTING_TEST_CONTRACT || contractPath;
const compiled = new Module(contractPath, module);
compiled.filename = contractPath;
compiled.paths = Module._nodeModulePaths(path.dirname(contractPath));
compiled._compile(fs.readFileSync(contractSource, 'utf8')
    + '\nmodule.exports.setting=hasConcreteCoreSummarySetting;module.exports.vector=hasExplicitEditedVectorHandoff;module.exports.quantitative=coreSummaryQuantitativeResultState;module.exports.strip=stripCoreSummaryNonResultNumerals;', contractPath);
const current = compiled.exports;
const fixture = JSON.parse(fs.readFileSync(process.env.CORE_SETTING_TEST_FIXTURE
    || path.join(root, 'tests/fixtures/core-domain-settings-vector-handoff-cases.json')));
const python = String.raw`import ast,json,re,sys
from pathlib import Path
source=Path(sys.argv[1]);functions={node.name:node for node in ast.parse(source.read_text()).body if isinstance(node,ast.FunctionDef)}
names={'_detailed_core_summary_semantic_issue','_has_concrete_core_summary_setting','_has_explicit_edited_vector_handoff'}
while True:
 new=names|{node.func.id for name in names for node in ast.walk(functions[name]) if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in functions}
 if new==names:break
 names=new
env={'re':re};exec(compile(ast.Module(body=[functions[n] for n in functions if n in names],type_ignores=[]),str(source),'exec'),env)
p=json.load(sys.stdin)
# Small test metric sets exercise the new pure setting grammar. Complete paid
# summaries below use the actual publisher's own authoritative metric patterns.
metric=re.compile(r'指标|准确率|正确率|SI-SDR|压缩率|对数似然比代价');conference=re.compile(r'声压级|声对比度')
print(json.dumps({'settings':[env['_has_concrete_core_summary_setting'](s,metric,conference) for s,_ in p['settingCases']], 'vectors':[env['_has_explicit_edited_vector_handoff'](s) for s,_ in p['vectorCases']], 'paid':[env['_detailed_core_summary_semantic_issue'](r['summary']) for r in p['paidSummaries']], 'retained':[env['_detailed_core_summary_semantic_issue'](r['summary']) for r in p['retainedFailures']], 'domain':[env['_detailed_core_summary_semantic_issue'](r['summary']) for r in p['domainMetricCases']], 'years':[env['_strip_core_summary_non_result_numerals'](s) for s,_ in p['yearCases']], 'legacyYears':[env['_detailed_core_summary_semantic_issue'](r['summary']) for r in p['legacyYearSummaries']]},ensure_ascii=False))`;
const call = spawnSync('bash', ['scripts/python-runtime.sh', '-c', python,
    process.env.CORE_SETTING_TEST_PUBLISHER || path.join(root, 'scripts/publish-to-blog.py')],
{ cwd: root, encoding: 'utf8', input: JSON.stringify(fixture), maxBuffer: 4 * 1024 * 1024 });
assert.equal(call.status, 0, call.stderr);
const py = JSON.parse(call.stdout);

test('specific measured settings bind a nearby metric/value; counts, generic experiments and model-name substrings cannot substitute', () => {
    fixture.settingCases.forEach(([text, expected], index) => {
        assert.equal(current.setting(text), expected, text);
        assert.equal(py.settings[index], expected, 'Python: ' + text);
    });
});

test('encoder, edit and decoder hand off the same complete variable and its primed result in order', () => {
    fixture.vectorCases.forEach(([text, expected], index) => {
        assert.equal(current.vector(text), expected, text);
        assert.equal(py.vectors[index], expected, 'Python: ' + text);
    });
});

test('four real saved summary surfaces pass core semantics in both languages without creating execution evidence', () => {
    assert.equal(fixture.paidSummaries.length, 4);
    fixture.paidSummaries.forEach((record, index) => {
        assert.equal(crypto.createHash('sha256').update(record.summary).digest('hex'), record.summarySha256);
        assert.equal(current.validateCoreSummarySemanticContract('## 核心摘要\n' + record.summary), null, record.paperId);
        assert.equal(py.paid[index], null, 'Python: ' + record.paperId);
    });
});

test('uncertain settings, overlapping intervals, optimum parameters and missing boundary remain rejected', () => {
    fixture.retainedFailures.forEach((record, index) => {
        assert.ok(current.validateCoreSummarySemanticContract('## 核心摘要\n' + record.summary), record.paperId);
        assert.ok(py.retained[index], 'Python: ' + record.paperId);
    });
});

// All independent-review counterexamples use an already-valid named setting,
// so new metric aliases cannot hide behind the new setting predicate.
test('complete metric aliases cannot backtrack through spaces/case or borrow model, equipment or importance values', () => {
    fixture.domainMetricCases.forEach((record, index) => {
        assert.equal(current.quantitative(record.text).complete, record.expected, record.text);
        const issue = current.validateCoreSummarySemanticContract('## 核心摘要\n' + record.summary);
        assert.equal(issue === null, record.expected, record.text);
        assert.equal(py.domain[index] === null, record.expected, 'Python: ' + record.text);
    });
});

test('Chinese-adjacent years use identical ASCII boundaries without stripping model identifiers or result decimals', () => {
    fixture.yearCases.forEach(([text, expected], index) => {
        assert.equal(current.strip(text), expected, text);
        assert.equal(py.years[index], expected, 'Python: ' + text);
    });
    fixture.legacyYearSummaries.forEach((record, index) => {
        assert.equal(crypto.createHash('sha256').update(record.summary).digest('hex'), record.summarySha256);
        assert.equal(current.validateCoreSummarySemanticContract('## 核心摘要\n' + record.summary), null, record.paperId);
        assert.equal(py.legacyYears[index], null, 'Python: ' + record.paperId);
    });
});
