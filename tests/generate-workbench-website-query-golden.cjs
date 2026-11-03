'use strict';

// TEST ONLY: this generator never reads a user library or grants publication/source authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const target = path.join(__dirname, 'fixtures/workbench-website-query-golden.json');
const seedPath = path.join(__dirname, 'fixtures/workbench-website-taxonomy-golden.json');
// Original vendored Git blob of the golden fixture's official upstream resolver.
const coreBlob = 'e1de96d38294995cf742d5b1c2186e8dac3e7fde';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function loadAuthority() {
  const seedBytes = fs.readFileSync(seedPath), seed = JSON.parse(seedBytes);
  const bytes = execFileSync('git', ['cat-file', 'blob', coreBlob], { cwd: root });
  assert.equal(sha(bytes), seed.upstream.sha256, 'upstream resolver must remain byte-identical');
  const context = { module: { exports: {} } };
  vm.runInNewContext(bytes.toString('utf8'), context, { filename: `git-blob:${coreBlob}` });
  return { seed, seedBytes, core: context.module.exports };
}

function calculate(core, graph, records, queryCase) {
  try {
    const groups = core.groupPapers(queryCase.recordKeys.map(key => {
      assert.ok(Object.hasOwn(records, key), 'unknown test record: ' + key);
      return records[key];
    }), graph);
    const matched = core.query(groups, queryCase.filters, graph);
    // Asking the unchanged resolver about each individual guide preserves its AND boundary.
    const matchingGuides = matched.map(group => ({ groupKey: group.key,
      permalinks: group.articles.filter(record => core.query(core.groupPapers([record], graph), queryCase.filters, graph).length)
        .map(record => record.permalink) }));
    return clone({ groupKeys: matched.map(group => group.key), paperIDs: matched.map(group => group.paperId),
      matchingGuides, filteredCounts: core.counts(groups, graph, queryCase.filters),
      // Navigation may deliberately show alternatives before applying selected concept IDs.
      browseCounts: core.counts(groups, graph, { ...queryCase.filters, facets: {} }) });
  } catch (error) { return { error: true, message: error.message }; }
}

function buildFixture() {
  const { seed, seedBytes, core } = loadAuthority();
  const display = clone(seed.display);
  // Copied verbatim from the public current snapshot and each of these four saved versions.
  // Keeping the exact node here makes regeneration independent of ignored QA or the network.
  const supplementalNode = { aliases: [], ancestorIds: [], definition: '作为论文贡献提供数据集合。', en: 'Dataset',
    facet: 'artifact', id: 'artifact.dataset', scopeNote: '使用别人的数据集不等于贡献数据集。', status: 'active', zh: '数据集' };
  for (const snapshot of [display.snapshot, ...display.versions.snapshots]) snapshot.concepts.push(clone(supplementalNode));
  const graph = core.createRegistry(display.snapshot, display.versions);
  const records = {}, recordSources = {};
  function original(key, index) {
    records[key] = clone(seed.cases[index].record);
    recordSources[key] = { kind: 'unmodified-public-row', seedCase: seed.cases[index].name };
  }
  function synthetic(key, index, change) {
    const row = clone(seed.cases[index].record);
    // Synthetic identities and URLs cannot be mistaken for a real deployed guide.
    row.identityStatus = 'verified'; row.arxivId = ''; row.paperId = 'test:query-' + key;
    row.permalink = 'https://example.invalid/workbench-query/' + key + '/';
    change(row);
    records[key] = row;
    recordSources[key] = { kind: 'synthetic-query-input-only', seedCase: seed.cases[index].name,
      warning: 'Not a signed source, published paper, or scientific/publication qualification.' };
  }
  original('music', 0); original('historical', 1); original('science', 2); original('qualified1028', 3);
  for (const [key, index] of [['withheld', 4], ['unknownVersion', 5], ['unboundVersion', 6],
    ['invalidRole', 7], ['legacy', 11], ['invalidDirectLabel', 12]]) synthetic(key, index, () => {});
  synthetic('splitTask', 0, row => {
    row.paperId = 'test:query-split'; row.tagConcepts = row.tagConcepts.filter(node => node.facet === 'task');
    row.primaryMethodId = ''; row.method = '';
  });
  synthetic('splitMethod', 0, row => {
    row.paperId = 'test:query-split'; row.tagConcepts = row.tagConcepts.filter(node => node.id === 'method.statistical-analysis');
    row.primaryTaskId = ''; row.task = '';
  });
  synthetic('sameGuide', 0, row => { row.paperId = 'test:query-split'; });
  synthetic('repeatGuide', 0, row => { row.arxivId = records.music.arxivId; delete row.paperId; });
  synthetic('primarySubjective', 0, row => { row.primaryMethodId = 'method.subjective-evaluation'; row.method = '主观评测'; });
  synthetic('providerA', 0, row => {
    row.paperId = 'test:query-provider'; row.title = 'OnlyGuideAlpha'; row.titleZh = 'OnlyGuideAlpha'; row.summary = ''; row.tags = [];
    row.tagConcepts = row.tagConcepts.filter(node => node.id === 'method.statistical-analysis');
    row.primaryTaskId = ''; row.task = ''; row.score = '9'; row.sourceKind = 'conference'; row.date = '2026-10-30';
  });
  synthetic('providerB', 0, row => {
    row.paperId = 'test:query-provider'; row.title = 'OnlyGuideBeta'; row.titleZh = 'OnlyGuideBeta'; row.summary = ''; row.tags = [];
    row.tagConcepts = row.tagConcepts.filter(node => node.facet === 'task');
    row.primaryMethodId = ''; row.method = ''; row.score = '5'; row.sourceKind = 'arxiv'; row.date = '2026-10-29';
  });
  synthetic('unverifiedA', 0, row => { row.identityStatus = 'unverified'; row.paperId = 'test:do-not-merge'; });
  synthetic('unverifiedB', 0, row => { row.identityStatus = 'unverified'; row.paperId = 'test:do-not-merge'; });
  synthetic('scienceCrossDomain', 2, row => { row.domainScope = 'cross-domain'; });
  synthetic('scienceSecondaryArtifact', 2, row => { row.tagConcepts.push({ id: 'artifact.dataset', facet: 'artifact', label: '数据集' }); });
  synthetic('scienceSecondaryFocus', 2, row => { row.tagConcepts.push({ id: 'research_focus.robustness', facet: 'research_focus', label: '鲁棒性' }); });
  synthetic('scienceSecondaryTask', 2, row => { row.tagConcepts.push({ id: 'task.music-mixing', facet: 'task', label: '音乐混音' }); row.tagCatalogSha256 = display.snapshot.registrySha256; });
  synthetic('resource', 2, row => {
    row.tagCatalogSha256 = display.snapshot.registrySha256;
    row.researchType = 'resource'; delete row.primaryScientificTopicId; delete row.primaryScientificTopicLabel;
    row.primaryResearchRole = { kind: 'artifact', conceptId: 'artifact.dataset', label: '数据集' };
    row.tagConcepts = [{ id: 'artifact.dataset', facet: 'artifact', label: '数据集' },
      { id: 'method.statistical-analysis', facet: 'method', label: '统计分析' }];
  });
  synthetic('engineering', 2, row => {
    row.tagCatalogSha256 = display.snapshot.registrySha256;
    row.researchType = 'engineering'; row.domainScope = 'adjacent-domain';
    row.primaryTaskId = 'task.music-mixing'; row.task = '音乐混音';
    delete row.primaryScientificTopicId; delete row.primaryScientificTopicLabel;
    row.primaryResearchRole = { kind: 'task', conceptId: 'task.music-mixing', label: '音乐混音' };
    row.tagConcepts = ['task.music-mixing', 'method.statistical-analysis'].map(id => {
      const n = graph.byId[id]; return { id, facet: n.facet, label: n.zh };
    });
  });
  synthetic('engineeringMechanism', 2, row => {
    row.tagCatalogSha256 = display.snapshot.registrySha256;
    row.researchType = 'engineering'; row.domainScope = 'out-of-domain';
    row.tagClassificationContract = 'historical-source-taxonomy-classification-v3';
    row.tagEvidenceType = 'source-only-taxonomy-v3'; row.tagEvidenceContract = 'historical-source-taxonomy-supplement-v3';
    row.primaryTaskId = ''; row.task = ''; delete row.primaryScientificTopicId; delete row.primaryScientificTopicLabel;
    row.primaryResearchRole = { kind: 'method', conceptId: 'method.statistical-analysis', label: '统计分析' };
    row.tagConcepts = [{ id: 'method.statistical-analysis', facet: 'method', label: '统计分析' }];
  });
  for (const key of ['engineering', 'engineeringMechanism', 'scienceCrossDomain', 'resource',
    'scienceSecondaryArtifact', 'scienceSecondaryFocus', 'scienceSecondaryTask']) {
    assert.equal(graph.resolveRecord(records[key]).status, 'verified', 'test setup: ' + key);
  }
  const ordinary = ['music', 'historical', 'science', 'qualified1028', 'engineering', 'engineeringMechanism',
    'scienceCrossDomain', 'resource', 'withheld', 'unknownVersion', 'unboundVersion', 'invalidRole', 'legacy', 'invalidDirectLabel'];
  const cases = [];
  function query(name, filters, recordKeys = ordinary) {
    cases.push({ name, recordKeys, filters: { scope: 'subtree', role: 'any', researchType: 'all', domainScope: 'all', facets: {}, ...filters } });
  }
  query('no-direction-keeps-unclassified-readable', {});
  query('same-facet-is-OR', { facets: { task: ['task.music-mixing', 'task.speech-enhancement'] } });
  query('cross-facet-is-AND', { facets: { task: ['task.music-mixing'], method: ['method.statistical-analysis'] } });
  query('cross-facet-impossible-does-not-union-papers', { facets: { task: ['task.speech-enhancement'], method: ['method.statistical-analysis'] } });
  query('parent-subtree-includes-three-level-leaf', { facets: { task: ['task.audio-editing'] } }, ['music']);
  query('parent-direct-does-not-match-leaf', { scope: 'direct', facets: { task: ['task.audio-editing'] } }, ['music']);
  query('middle-subtree-includes-leaf', { facets: { task: ['task.music-post-production'] } }, ['music']);
  query('leaf-direct-matches', { scope: 'direct', facets: { task: ['task.music-mixing'] } }, ['music']);
  query('known-zero-node-is-valid-empty-result', { facets: { task: ['task.speech-enhancement'] } }, ['music']);
  query('secondary-method-matches-any', { facets: { method: ['method.subjective-evaluation'] } }, ['music']);
  query('secondary-method-does-not-match-primary', { role: 'primary', facets: { method: ['method.subjective-evaluation'] } }, ['music']);
  query('primary-method-matches', { role: 'primary', facets: { method: ['method.statistical-analysis'] } });
  query('primary-parent-cannot-borrow-secondary-child', { role: 'primary', facets: { method: ['method.human-evaluation'] } }, ['music']);
  query('primary-method-parent-subtree-matches', { role: 'primary', facets: { method: ['method.human-evaluation'] } }, ['primarySubjective']);
  query('signal-remains-relevant-in-primary-mode', { role: 'primary', facets: { signal: ['signal.speech'] } });
  query('science-primary-role-matches', { role: 'primary', facets: { scientific_topic: ['scientific_topic.prosody'] } });
  query('non-primary-scientific-topic-does-not-match-primary', { role: 'primary', facets: { scientific_topic: ['scientific_topic.auditory-cognition'] } }, ['historical']);
  query('qualified-evaluation-primary-focus', { role: 'primary', facets: { research_focus: ['research_focus.robustness'] } });
  query('resource-primary-artifact', { role: 'primary', facets: { artifact: ['artifact.dataset'] } });
  for (const [facet, key, id] of [['artifact', 'scienceSecondaryArtifact', 'artifact.dataset'],
    ['research_focus', 'scienceSecondaryFocus', 'research_focus.robustness'],
    ['task', 'scienceSecondaryTask', 'task.music-mixing']]) {
    query('non-primary-' + facet + '-matches-any', { facets: { [facet]: [id] } }, [key]);
    query('non-primary-' + facet + '-excluded-in-primary-mode', { role: 'primary', facets: { [facet]: [id] } }, [key]);
  }
  query('engineering-method-mechanism-primary', { role: 'primary', researchType: 'engineering', domainScope: 'out-of-domain', facets: { method: ['method.statistical-analysis'] } }, ['engineeringMechanism']);
  for (const researchType of ['science', 'engineering', 'evaluation', 'unclassified']) query('research-type-' + researchType, { researchType });
  for (const domainScope of ['in-domain', 'cross-domain', 'adjacent-domain', 'out-of-domain', 'unclassified']) query('domain-scope-' + domainScope, { domainScope });
  query('role-type-domain-and-direction-together', { role: 'primary', researchType: 'science', domainScope: 'cross-domain', facets: { scientific_topic: ['scientific_topic.prosody'], method: ['method.statistical-analysis'] } });
  query('legacy-role-types-not-inferred-from-flat-tags', { researchType: 'engineering' }, ['music', 'historical', 'legacy']);
  query('multiguide-AND-cannot-borrow-other-guide', { facets: { task: ['task.music-mixing'], method: ['method.statistical-analysis'] } }, ['splitTask', 'splitMethod']);
  query('multiguide-one-guide-satisfies-AND', { facets: { task: ['task.music-mixing'], method: ['method.statistical-analysis'] } }, ['splitTask', 'splitMethod', 'sameGuide']);
  query('multiguide-OR-counts-paper-once', { facets: { task: ['task.music-mixing'], method: [] } }, ['music', 'repeatGuide']);
  query('duplicate-guide-permalink-not-counted-twice', {}, ['music', 'music', 'repeatGuide']);
  query('unverified-identities-remain-separate-pages', {}, ['unverifiedA', 'unverifiedB']);
  query('withheld-cannot-use-flat-fallback', { facets: { task: ['task.music-mixing'] } }, ['withheld']);
  query('unknown-version-cannot-use-flat-fallback', { facets: { task: ['task.music-mixing'] } }, ['unknownVersion', 'unboundVersion']);
  query('invalid-role-cannot-use-visible-raw-labels', { facets: { scientific_topic: ['scientific_topic.prosody'] } }, ['invalidRole']);
  query('invalid-direct-label-is-not-selected', { facets: { task: ['task.music-mixing'] } }, ['invalidDirectLabel']);
  query('valid-other-labels-survive-invalid-direct-label', { facets: { method: ['method.statistical-analysis'] } }, ['invalidDirectLabel']);
  query('invalid-query-unknown-node', { facets: { task: ['task.not-a-real-node'] } });
  query('invalid-query-wrong-facet', { facets: { method: ['task.music-mixing'] } });
  query('invalid-query-unknown-facet', { facets: { invented: ['task.music-mixing'] } });
  query('invalid-query-facet-value-not-array', { facets: { task: 'task.music-mixing' } });
  query('invalid-query-facets-array', { facets: [] });
  query('invalid-query-scope', { scope: 'flat' });
  query('invalid-query-role', { role: 'secondary' });
  query('invalid-query-research-type', { researchType: 'invented' });
  query('invalid-query-domain', { domainScope: 'invented' });
  for (const item of cases) {
    item.expected = calculate(core, graph, records, item);
    assert.equal(item.expected.error === true, item.name.startsWith('invalid-query-'), 'unexpected query/setup failure: ' + item.name);
  }
  assert.deepEqual(cases.find(c => c.name === 'multiguide-AND-cannot-borrow-other-guide').expected.paperIDs, []);
  assert.equal(cases.find(c => c.name === 'multiguide-one-guide-satisfies-AND').expected.matchingGuides[0].permalinks.length, 1);
  const appIntegrationCases = [];
  function integration(name, nativeResults, eligibleRecordKeys, ordinaryFilters = {}) {
    const item = { name, scope: 'APP INTEGRATION ONLY: local text and private-note extensions are not website metadata query behavior.',
      recordKeys: ['providerA', 'providerB'], query: 'OnlyGuideAlpha', ordinaryFilters,
      filters: { facets: { task: ['task.music-mixing'] }, scope: 'subtree', role: 'any', researchType: 'all', domainScope: 'all' },
      nativeResults, eligibleRecordKeys };
    // Eligibility is an explicit test vector, not a copy of either platform's search implementation.
    item.expected = calculate(core, graph, records, { recordKeys: eligibleRecordKeys, filters: item.filters });
    assert.equal(item.expected.error, undefined);
    appIntegrationCases.push(item);
  }
  const paperID = 'test:query-provider';
  integration('metadata-query-does-not-borrow-other-guide', { library: { ids: [] }, personal: { ids: [] } }, ['providerA']);
  integration('untyped-native-ids-do-not-bypass-guide-query', { library: { ids: [paperID] }, personal: { ids: [] } }, ['providerA']);
  integration('typed-cached-text-is-explicit-paper-level-extension', { library: { ids: [paperID], cachedTextIDs: [paperID] }, personal: { ids: [] } }, ['providerA', 'providerB']);
  integration('private-note-is-explicit-paper-level-extension', { library: { ids: [] }, personal: { ids: [paperID] } }, ['providerA', 'providerB']);
  integration('paper-text-extension-cannot-borrow-score', { library: { cachedTextIDs: [paperID] }, personal: { ids: [] } }, ['providerA'], { score: '8' });
  integration('paper-text-extension-cannot-borrow-source', { library: { cachedTextIDs: [paperID] }, personal: { ids: [] } }, ['providerA'], { source: 'conference' });
  integration('paper-text-extension-cannot-borrow-date', { library: { cachedTextIDs: [paperID] }, personal: { ids: [] } }, ['providerA'], { from: '2026-10-30' });
  return { contract: 'workbench-website-query-golden-v1',
    scope: 'TEST ONLY. Classification/query display examples and finite ancestor-closed vocabulary copies. Synthetic rows are explicitly separated from unmodified public rows. No source, publication, cache, PDF, or scientific qualification is granted. Expected results are computed exclusively by byte-identical upstream tag-core.js.',
    upstream: { ...seed.upstream, seedFixture: 'tests/fixtures/workbench-website-taxonomy-golden.json', seedFixtureSHA256: sha(seedBytes) },
    comparison: { identity: 'groupKeys are authoritative for unverified page identities; paperIDs may be empty.',
      matchingGuides: 'Only guide permalinks independently satisfying every applied classification condition.',
      filteredCounts: 'Official counts with all selected facets applied; direct and subtree are distinct.',
      browseCounts: 'Official counts with only selected facet IDs cleared; retains role/type/domain. UI may use this named alternative for navigation.',
      ordinaryMetadata: 'Not included here: consumers must filter eligible guide rows by source/date/score/text before applying this same classification query.' },
    supplementalNodes: { origin: 'Verbatim artifact.dataset from the SHA-bound public snapshot and four saved versions.', concepts: [supplementalNode] },
    display, records, recordSources, cases, appIntegrationCases };
}

if (require.main === module) {
  const command = process.argv[2] || '--check';
  assert.ok(['--write', '--check'].includes(command), 'use --write or --check');
  const bytes = JSON.stringify(buildFixture(), null, 2) + '\n';
  if (command === '--write') fs.writeFileSync(target, bytes);
  else assert.equal(fs.readFileSync(target, 'utf8'), bytes, 'fixture must reproduce from unchanged upstream');
  console.log(command === '--write' ? 'Wrote TEST ONLY website query golden.' : 'PASS website query golden reproduces exactly.');
}
module.exports = { buildFixture, calculate, loadAuthority };
