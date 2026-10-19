'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const deep = require(path.join(process.cwd(), 'scripts/deep-analyzer.js'));
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
// Minimal public scientific cell text only. Local display checks do not grant
// source authenticity; the normal parser and saved-source qualification do.
const realCells = [{"source": "4.39±0.12\\mathbf{4.39\\pm 0.12}", "display": "4.39 ± 0.12"}, {"source": "4.16±0.11\\mathbf{4.16\\pm 0.11}", "display": "4.16 ± 0.11"}, {"source": "4.44±0.12\\mathbf{4.44\\pm 0.12}", "display": "4.44 ± 0.12"}, {"source": "4.19±0.15\\mathbf{4.19\\pm 0.15}", "display": "4.19 ± 0.15"}, {"source": "4.01±0.12\\mathbf{4.01\\pm 0.12}", "display": "4.01 ± 0.12"}, {"source": "4.18±0.15\\mathbf{4.18\\pm 0.15}", "display": "4.18 ± 0.15"}, {"source": "4.20±0.15\\mathbf{4.20\\pm 0.15}", "display": "4.20 ± 0.15"}, {"source": "4.04±0.12\\mathbf{4.04\\pm 0.12}", "display": "4.04 ± 0.12"}, {"source": "4.17±0.15\\mathbf{4.17\\pm 0.15}", "display": "4.17 ± 0.15"}, {"source": "4.52±0.10\\mathbf{4.52\\pm 0.10}", "display": "4.52 ± 0.10"}, {"source": "4.07±0.11\\mathbf{4.07\\pm 0.11}", "display": "4.07 ± 0.11"}, {"source": "4.53±0.10\\mathbf{4.53\\pm 0.10}", "display": "4.53 ± 0.10"}, {"source": "4.08±0.16\\mathbf{4.08\\pm 0.16}", "display": "4.08 ± 0.16"}, {"source": "3.89±0.12\\mathbf{3.89\\pm 0.12}", "display": "3.89 ± 0.12"}, {"source": "4.06±0.16\\mathbf{4.06\\pm 0.16}", "display": "4.06 ± 0.16"}];
function paperFor(source, display) {
    const markdown = `| Metric | Value |
| --- | --- |
| System A | ${display} |`;
    const article = '### 实验对照\n\n' + markdown;
    const matrix = [['Metric', 'Value'], ['System A', display]];
    const cells = matrix.flatMap((row, r) => row.map((value, c) => ({
        renderedRow:r, renderedColumn:c, sourceRow:r, sourceColumn:c,
        renderedText:value, sourceText:r===1&&c===1?source:value,
        sourceDomSha256:hash(`cell-${r}-${c}`)
    })));
    const bindings = [{tableIndex:1,sourceType:'artifact_table',sourceTableOrdinal:1,
        sourceTableDomSha256:hash('table'),renderedTableSha256:hash(markdown),cellBindings:cells,sourceQuotes:[]}];
    const plan = {version:3,readerTitle:'实验对照',oneSentenceThesis:'保留原科学数值。',
        conceptBridges:[],sections:[{kind:'experiments',heading:'实验对照'}],
        tableBindings:bindings,formulaBindings:[],
        sourceBindingsSha256:deep.stableFingerprint({tableBindings:bindings,formulaBindings:[]})};
    return {apiReaderArticle:article,apiReaderArticleSha256:hash(article),apiReaderPlan:plan,
        apiReaderPlanSha256:deep.stableFingerprint(plan),analysisManifest:{stages:{apiReaderArticle:{
            status:'complete',articleSha256:hash(article),planSha256:deep.stableFingerprint(plan)
        }}}};
}
for (const [index, cell] of realCells.entries()) test(`saved normal repair preserves actual styled uncertainty cell ${index+1}`, () => {
    const p=paperFor(cell.source,cell.display),before=JSON.stringify(p);
    assert.doesNotThrow(()=>deep.repairApiReaderArticleAndPlanBindings(p,p.analysisManifest));
    assert.equal(JSON.stringify(p),before);
});
const negatives = [
    ['changed mean','4.39±0.12\\mathbf{4.39\\pm 0.12}','4.40 ± 0.12'],
    ['changed uncertainty','4.39±0.12\\mathbf{4.39\\pm 0.12}','4.39 ± 0.13'],
    ['changed sign','4.39±0.12\\mathbf{4.39\\pm 0.12}','-4.39 ± 0.12'],
    ['different explicit value','4.39±0.12\\mathbf{4.40\\pm 0.12}','4.39 ± 0.12'],
    ['different explicit uncertainty','4.39±0.12\\mathbf{4.39\\pm 0.13}','4.39 ± 0.12'],
    ['added unit','4.39±0.12\\mathbf{4.39\\pm 0.12}','4.39 ± 0.12 dB'],
    ['bare numeric repeat','4.39±0.124.39±0.12','4.39 ± 0.12'],
    ['missing explicit command','4.39±0.12{4.39pm 0.12}','4.39 ± 0.12'],
    ['negated source','not measured: 4.39±0.12\\mathbf{4.39\\pm 0.12}','4.39 ± 0.12'],
    ['negated display','4.39±0.12\\mathbf{4.39\\pm 0.12}','not 4.39 ± 0.12'],
    ['nested power remains publication-only','[4]32[4^{3}]^{2}','\\([4^{3}]^{2}\\)']
];
for (const [name,source,display] of negatives) test(`saved repair rejects ${name}`,()=>{
    const p=paperFor(source,display);
    assert.throws(()=>deep.repairApiReaderArticleAndPlanBindings(p,p.analysisManifest),/表格单元格与绑定的原始来源不一致/);
});

test('saved repair keeps the existing identical plain-cell branch', () => {
    const p=paperFor('4.39 ± 0.12','4.39 ± 0.12'),before=JSON.stringify(p);
    assert.doesNotThrow(()=>deep.repairApiReaderArticleAndPlanBindings(p,p.analysisManifest));
    assert.equal(JSON.stringify(p),before);
});
