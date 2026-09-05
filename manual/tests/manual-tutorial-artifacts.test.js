'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    classifyFigureCandidate,
    numericCellIds,
    tableDisplayProjection,
    renderMarkdownTable,
    sanitizeTableDisplayText,
    buildTutorialArtifactPlan,
    validateTutorialArtifactPlan
} = require('../scripts/manual-tutorial-artifacts.js');

const ROOT = path.resolve(__dirname, '..', '..');
const CURRENT_ALLMUSICCAPS = path.join(
    ROOT,
    'data/current/manual-full-text/2026-08-27/artifacts',
    '2608.25244-47bef50ad6d3-c87b46d9e280-284e444b1444-f5bd72ef94ef.artifact.json'
);

function sha(value) {
    return require('node:crypto').createHash('sha256').update(value).digest('hex');
}

function table(id, kind, caption, matrix) {
    return { id, kind, caption, matrix, matrixSha256: sha(JSON.stringify(matrix)) };
}

function fallbackAllMusicCapsFixture() {
    const tables = [
        table('TAB0001', 'result', 'Table 1: Downstream performance of each review-derived text corpus, the baseline (LPMC + M4-RAG + FS + PSE), and their combinations. Bold = best per column.', [
            ['', 'Retrieval', 'Retrieval', 'ZS Class.', 'ZS Class.'],
            ['Data', 'MuCaps', 'SongD.', 'GTZAN', 'FMA-S'],
            ['', 'MRR↑\\uparrow', 'MRR↑\\uparrow', 'Acc.↑\\uparrow', 'Acc.↑\\uparrow'],
            ['baseline', '7.2', '15.1', '86.4', '55.0'],
            ['AMCQuotes', '5.6', '14.7', '81.7', '48.0'],
            ['AMCStruct', '4.6', '15.4', '84.3', '47.5'],
            ['baseline+AMCQuotes', '7.3', '18.8', '87.1', '55.5'],
            ['baseline+AMCStruct', '7.3', '17.9', '85.6', '55.0']
        ]),
        table('TAB0002', 'other', 'Table 2: Top-3 queries with the largest rank improvement when adding review supervision. Δ\\Delta rank = rank under review-augmented model −- rank under baseline. Larger is better. Captions are truncated to fit.', [
            ['baseline+AMCQuotes vs. baseline', 'baseline+AMCQuotes vs. baseline'],
            ['Δ\\Delta rank', 'Query'],
            ['MusicCaps', 'MusicCaps'],
            ['++1951', 'This music is instrumental. The tempo is slow with the musician plucking a single string of a ukelele. This audio is of a Ukelele being tuned.'],
            ['++1869', 'This audio recording features a crickets sound effect, sea waves sound effect and mellow synth pad chords in the background, followed by shimmering tambourine and muffled snare…'],
            ['++1822', 'This piece is a live performance of dancers playing the tambourine over a rock music piece in the background. The background piece has a female vocal and an electric guitar…'],
            ['Song Describer', 'Song Describer'],
            ['++291', 'A rock song with a slow base well marked by drums and distorted guitars.'],
            ['++282', 'A power-pop song with a lot of idiosyncracies like flutes, a kid’s choir, and guitar solo played backwards.'],
            ['++246', 'Male vocalist with a raspy voice singing over melancholic piano chords and drums increasing in intensity, with a slighty dissonant chorus featuring distorted guitars.']
        ]),
        table('TAB0003', 'result', 'Table 3: Audio encoder layer selection. All models use frozen text encoder and InfoNCE loss on baseline+AMCQuotes data. Bold = best per column.', [
            ['', 'Retrieval', 'Retrieval', 'ZS Class.', 'ZS Class.', 'Sim.'],
            ['Layer', 'MuCaps', 'SongD.', 'GTZAN', 'FMA-S', 'DimSim'],
            ['', 'MRR↑\\uparrow', 'MRR↑\\uparrow', 'Acc.↑\\uparrow', 'Acc.↑\\uparrow', 'Acc.↑\\uparrow'],
            ['Layer 12', '7.3', '18.8', '87.1', '55.5', '74.3'],
            ['Layer 6', '6.5', '17.9', '83.5', '55.0', '82.0'],
            ['All layers', '7.8', '19.3', '85.4', '55.5', '83.0'],
            ['', 'MLP Probing', 'MLP Probing', 'MLP Probing', 'MLP Probing', 'MLP Probing'],
            ['Layer', 'MTT', 'J.Genre', 'J.Instr.', 'J.Mood', 'MGPHot'],
            ['', 'MAP↑\\uparrow', 'MAP↑\\uparrow', 'MAP↑\\uparrow', 'MAP↑\\uparrow', 'RMSE↓\\downarrow'],
            ['Layer 12', '43.4', '21.7', '17.1', '15.2', '0.162'],
            ['Layer 6', '44.7', '20.5', '15.0', '14.3', '0.162'],
            ['All layers', '44.5', '21.6', '16.7', '15.2', '0.161']
        ])
    ];
    const figures = [
        ['IMG0001', 'https://arxiv.org/html/2608.25244v1/allmusicquotes_diagram.svg', 'Figure 1: AllMusicCaps caption generation example'],
        ['IMG0002', 'https://arxiv.org/html/2608.25244v1/complexity_split_mrr_stacked.svg', 'Figure 2: Retrieval MRR by caption complexity'],
        ['IMG0003', 'https://arxiv.org/html/2608.25244v1/training_dynamics_horizontal.svg', 'Figure 3: Downstream performance over training steps'],
        ['IMG0004', 'https://arxiv.org/static/base/1.0.1/images/funders/simons-foundation.png', 'Simons Foundation'],
        ['IMG0005', 'https://arxiv.org/static/base/1.0.1/images/funders/simons-foundation-international.png', 'Simons Foundation International'],
        ['IMG0006', 'https://arxiv.org/static/base/1.0.1/images/funders/schmidt-sciences.png', 'Schmidt Sciences']
    ].map(([id, url, caption], index) => ({
        id, url, caption, alt: '', figureOrdinal: index < 3 ? index + 1 : null, figureLabel: index < 3 ? `Figure ${index + 1}:` : ''
    }));
    return {
        paperId: '2608.25244', outputSha256: 'a'.repeat(64), tables, figures,
        formulas: [{ id: 'FOR0001', raw: '\\mathcal{L}_{InfoNCE}' }]
    };
}

function allMusicCapsArtifact() {
    if (process.env.PD_TEST_FORCE_FALLBACK_ARTIFACT !== '1' && fs.existsSync(CURRENT_ALLMUSICCAPS)) {
        return JSON.parse(fs.readFileSync(CURRENT_ALLMUSICCAPS, 'utf8'));
    }
    return fallbackAllMusicCapsFixture();
}

describe('Manual tutorial artifact projection', () => {
    it('accepts the three original AllMusicCaps HTTPS SVG figures and rejects the three funder logos', () => {
        const index = allMusicCapsArtifact();
        const decisions = index.figures.map(classifyFigureCandidate);
        assert.equal(decisions.filter(item => item.eligible).length, 3);
        assert.equal(decisions.filter(item => item.eligible && item.mediaType === 'image/svg+xml').length, 3);
        assert.equal(decisions.filter(item => !item.eligible && /Logo/.test(item.reason)).length, 3);
        assert.equal(classifyFigureCandidate({
            id: 'IMG9999', url: 'https://example.org/images/funders/anonymous.png',
            caption: 'Anonymous donor', figureOrdinal: 99
        }).eligible, false);
    });

    it('renders all three AllMusicCaps tables deterministically with complete numeric fidelity', () => {
        const index = allMusicCapsArtifact();
        assert.equal(index.tables.length, 3);
        const plan = buildTutorialArtifactPlan(index);
        assert.equal(plan.tables.length, 3);
        for (const item of plan.tables) {
            const source = index.tables.find(table => table.id === item.id);
            assert.equal(item.renderedMarkdown, renderMarkdownTable(source));
            assert.deepEqual(item.numericCellIds, numericCellIds(source));
            assert.deepEqual(item.coverage.coveredNumericCellIds, numericCellIds(source));
            assert.equal(item.coverage.missingNumericCellIds.length, 0);
            assert.equal(item.coverage.numericFidelity, 1);
        }
        assert.doesNotThrow(() => validateTutorialArtifactPlan(index, plan));
    });

    it('flattens colspan-expanded headers into ordinary Markdown columns without simulated spans', () => {
        const index = allMusicCapsArtifact();
        const source = index.tables.find(item => item.id === 'TAB0002');
        const rendered = renderMarkdownTable(source);
        assert.match(rendered, /^\*\*baseline\+AMCQuotes vs\. baseline\*\*$/m);
        assert.match(rendered, /reported rank differences/i);
        assert.doesNotMatch(rendered, /largest rank improvement|Larger is better/i);
        assert.match(rendered, /^\| Δ rank \| Query \|$/m);
        assert.match(rendered, /^\*\*MusicCaps\*\*$/m);
        assert.match(rendered, /^\*\*Song Describer\*\*$/m);
        assert.match(rendered, /^\| 1951† \| This music is instrumental\./m);
        assert.doesNotMatch(rendered, /\| \+\+1951 \|/);
        assert.match(rendered, /> 符号说明：†/);
        assert.match(rendered, /方向按未知处理，不得据此判断上升或下降/);
        assert.doesNotMatch(rendered, /TAB0002:r\d+:c\d+|原始符号片段/);
        assert.equal((rendered.match(/\*\*MusicCaps\*\*/g) || []).length, 1);
        assert.equal((rendered.match(/\*\*Song Describer\*\*/g) || []).length, 1);
        assert.doesNotMatch(rendered, /\| MusicCaps \| MusicCaps \|/);
        assert.deepEqual(numericCellIds(source), buildTutorialArtifactPlan(index).tables.find(item => item.id === 'TAB0002').numericCellIds);
    });

    it('flattens multirow Table 1 and splits Table 3 logical header groups without repeated colspan labels', () => {
        const index = allMusicCapsArtifact();
        const tableOne = renderMarkdownTable(index.tables.find(item => item.id === 'TAB0001'));
        const tableThree = renderMarkdownTable(index.tables.find(item => item.id === 'TAB0003'));
        assert.match(tableOne, /^\| Data \| Retrieval \/ MuCaps \/ MRR↑ \| Retrieval \/ SongD\. \/ MRR↑ \| ZS Class\. \/ GTZAN \/ Acc\.↑ \| ZS Class\. \/ FMA-S \/ Acc\.↑ \|$/m);
        assert.doesNotMatch(tableOne, /^\|  \| Retrieval \| Retrieval \|/m);
        assert.match(tableThree, /^\*\*MLP Probing\*\*$/m);
        assert.match(tableThree, /^\| Layer \| MTT \/ MAP↑ \|/m);
        assert.doesNotMatch(tableThree, /^\|  \| MLP Probing \| MLP Probing \|/m);
    });

    it('cleans only duplicate display symbols while retaining source SHA binding and numeric values', () => {
        const index = allMusicCapsArtifact();
        const plan = buildTutorialArtifactPlan(index);
        const tableOne = plan.tables.find(item => item.id === 'TAB0001');
        const tableTwo = plan.tables.find(item => item.id === 'TAB0002');
        const tableThree = plan.tables.find(item => item.id === 'TAB0003');
        assert.equal(tableOne.sourceMatrixBound, true);
        assert.match(tableOne.renderedMarkdown, /MRR↑/);
        assert.match(tableOne.renderedMarkdown, /Acc\.↑/);
        assert.doesNotMatch(tableOne.renderedMarkdown, /\\uparrow/);
        assert.match(tableTwo.renderedMarkdown, /1951†/);
        assert.doesNotMatch(tableTwo.renderedMarkdown, /\| \+\+1951 \|/);
        assert.match(tableTwo.renderedMarkdown, /Δ rank/);
        assert.doesNotMatch(tableTwo.renderedMarkdown, /Δ\\Delta|−-/);
        assert.match(tableThree.renderedMarkdown, /RMSE↓/);
        assert.doesNotMatch(tableThree.renderedMarkdown, /\\downarrow/);
        assert.equal(sanitizeTableDisplayText('Δ\\Delta rank −- baseline ++1951'), 'Δ rank − baseline 1951†');
        const projection = tableDisplayProjection(index.tables.find(item => item.id === 'TAB0002'));
        assert.ok(projection.transformations.length >= 1);
        const transformed = projection.transformations.find(item => item.rawValue === '++1951');
        assert.equal(transformed.neutralValue, '1951');
        assert.equal(transformed.direction, 'unknown');
        assert.equal(transformed.displayValue, '1951†');
        assert.equal(transformed.rawValueSha256, sha('++1951'));
        assert.match(transformed.cellId, /^TAB0002:r3:c0:/);
        assert.equal(projection.sourceValuesPreserved, true);
        assert.equal(
            numericCellIds(index.tables.find(item => item.id === 'TAB0002'))[0],
            `TAB0002:r3:c0:${sha('++1951').slice(0, 12)}`
        );
        assert.doesNotThrow(() => validateTutorialArtifactPlan(index, plan));
    });

    it('neutralizes repeated sign fragments without guessing their direction and audits every transformed cell', () => {
        const source = table('TAB9000', 'other', 'Ambiguous extracted signs', [
            ['delta', 'query'], ['--12', 'a'], ['+-3.5%', 'b'], ['+7', 'ordinary positive'], ['-8', 'ordinary negative']
        ]);
        const projection = tableDisplayProjection(source);
        assert.deepEqual(projection.displayMatrix.slice(1).map(row => row[0]), ['12†', '3.5%†', '+7', '-8']);
        assert.deepEqual(projection.transformations.map(item => item.direction), ['unknown', 'unknown']);
        assert.deepEqual(projection.transformations.map(item => item.rawValue), ['--12', '+-3.5%']);
        assert.match(renderMarkdownTable(source), /方向按未知处理/);
    });

    it('fails closed on an omitted figure, numeric-cell drift, and altered deterministic table bytes', () => {
        const index = allMusicCapsArtifact();
        const plan = buildTutorialArtifactPlan(index);
        const missingFigure = structuredClone(plan);
        missingFigure.figures.pop();
        assert.throws(() => validateTutorialArtifactPlan(index, missingFigure), /逐项处置/);

        const missingNumber = structuredClone(plan);
        missingNumber.tables[0].coverage.coveredNumericCellIds.pop();
        assert.throws(() => validateTutorialArtifactPlan(index, missingNumber), /100%/);

        const altered = structuredClone(plan);
        altered.tables[0].renderedMarkdown = altered.tables[0].renderedMarkdown.replace(/\d/, '9');
        assert.throws(() => validateTutorialArtifactPlan(index, altered), /确定性完整渲染/);

        const guessedDirection = structuredClone(plan);
        const ambiguousTable = guessedDirection.tables.find(item => item.id === 'TAB0002');
        ambiguousTable.displayProjection.transformations[0].direction = 'positive';
        assert.throws(() => validateTutorialArtifactPlan(index, guessedDirection), /试图推断符号方向/);
    });

    it('把无数值的长文本协议矩阵逐记录拆成窄表且不遗漏源字段', () => {
        const source = table('TAB0005', 'protocol', 'Corpus paths', [
            ['Corpus', 'Generation', 'Validation', 'TTS Path'],
            ['Banking77', 'expand each short intent query into a natural spoken transcript', 're-classify the expanded transcript and retain every matching label', 'sample speakers, emotion and background-noise conditions'],
            ['MultiWOZ', 'reuse sampled human-written dialogues as source transcripts', 'retain only dialogues where two independent classifiers agree', 'synthesize every dialogue turn with distinct speakers']
        ]);
        const markdown = renderMarkdownTable(source);
        assert.match(markdown, /\*\*Banking77\*\*/);
        assert.match(markdown, /\| Field \| Source text \|/);
        for (const value of source.matrix.flat()) assert.match(markdown, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.doesNotMatch(markdown, /\| Corpus \| Generation \| Validation \| TTS Path \|/);
    });
});
