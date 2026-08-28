const { describe, it } = require('node:test');
const assert = require('node:assert');
const { parseArgs, buildTemplate } = require('../scripts/create-manual-record-template.js');

describe('Manual v5 isolated paper template', () => {
    it('requires one date and one paper ID', () => {
        assert.deepEqual(parseArgs(['--date', '2026-08-26', '--paper', '2608.12345v1']), {
            date: '2026-08-26', paper: '2608.12345'
        });
        assert.throws(() => parseArgs(['--date', '2026-08-26']), /paper/);
    });

    it('creates exactly one paper and inventories every manifest image', () => {
        const paper = { arxivId: '2608.12345v1', title: 'Paper' };
        const template = buildTemplate('2026-08-26', '2608.12345', {
            filtered: { batchDate: '2026-08-26', status: 'complete', papers: [paper] },
            manifest: { papers: { '2608.12345': {
                status: 'complete', path: '/tmp/paper.txt', sourceSha256: 'a'.repeat(64),
                imageInfos: [
                    { url: 'https://arxiv.org/a.png', caption: 'Figure 1' },
                    { url: 'https://arxiv.org/b.png', caption: 'Figure 2' }
                ]
            } } },
            artifactManifest: { papers: { '2608.12345': {
                status: 'complete', path: '/tmp/artifact.json'
            } } }
        });
        assert.equal(template.version, 3);
        assert.deepEqual(Object.keys(template.papers), ['2608.12345']);
        assert.equal(template.papers['2608.12345'].researchBrief.paperSubagent.singlePaperOnly, true);
        assert.equal(template.papers['2608.12345'].researchBrief.paperSubagent.model, 'gpt-5.6-terra');
        assert.equal(template.papers['2608.12345'].researchBrief.paperSubagent.reasoningEffort, 'high');
        assert.equal(template.papers['2608.12345'].researchBrief.editorialPlan.version, 2);
        assert.equal(
            template.papers['2608.12345'].researchBrief.editorialPlan.readerFormatContract,
            'graduate-researcher-tutorial-quality-v2'
        );
        assert.equal(template.papers['2608.12345'].freshAuthoring.contract, 'fresh-authoring-v1');
        assert.deepEqual(template.papers['2608.12345'].freshAuthoring.prohibitedProseInputs, []);
        assert.equal(template.tutorialPayloadContract, 'manual-v5-tutorial-payload-v1');
        assert.equal(template.papers['2608.12345'].tutorialPayload.contract, 'manual-v5-tutorial-payload-v1');
        assert.match(template.papers['2608.12345'].tutorialPayload.qualityPath, /quality\.json$/);
        assert.match(template.papers['2608.12345'].tutorialPayload.artifactPlanPath, /artifact-plan\.json$/);
        assert.deepEqual(
            template.papers['2608.12345'].figureReview.decisions.map(item => item.url),
            ['https://arxiv.org/a.png', 'https://arxiv.org/b.png']
        );
    });
});
