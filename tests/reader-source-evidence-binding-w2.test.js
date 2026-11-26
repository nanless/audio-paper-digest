'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const deep = require('../scripts/deep-analyzer.js');
const binding = require('../scripts/lib/reader-source-evidence-binding.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function bindTable(sourceText, header, cell) {
    const body = {
        version: 1,
        source: 'direct_conference_pdf_text',
        sourceKind: 'conference_pdf',
        tables: [],
        formulas: [],
        figures: [],
        flattenedTextSha256: sha(sourceText)
    };
    return deep.bindApiReaderSourceEvidence(
        `| Method | ${header} |\n|---|---|\n| A | ${cell} |`,
        [{
            tableIndex: 1,
            sourceType: 'source_quotes',
            sourceTableOrdinal: null,
            cellBindings: [],
            sourceQuotes: [sourceText]
        }],
        [],
        {
            sourceText,
            structuredArtifacts: { ...body, payloadSha256: deep.stableFingerprint(body) }
        }
    );
}

describe('PC-P0-3 (Node): readerTableHeaderUnitEvidenceFailures explicit cell units without mutating readerNumericTokens', () => {
    it('keeps global readerNumericTokens completely unchanged for cold-replay compatibility', () => {
        assert.deepEqual(binding.readerNumericTokens('12 MB'), ['12']);
        assert.deepEqual(binding.readerNumericTokens('16 GiB'), ['16']);
        assert.deepEqual(binding.readerNumericTokens('2.5 h'), ['2.5']);
        assert.deepEqual(binding.readerNumericTokens('128 kbps'), ['128']);
    });

    it('accepts explicit matching cell units (MB/KB/h/GiB/MiB/KiB/TB/GHz/kbps/Mbps) when quote carries the exact number+unit', () => {
        const validCases = [
            ['The checkpoint takes 12 MB on disk.', 'Size (MB)', '12 MB'],
            ['Peak memory reaches 16 GiB on a single GPU.', 'VRAM (GiB)', '16 GiB'],
            ['Full training completes in 2.5 h across 8 GPUs.', 'Duration (h)', '2.5 h'],
            ['Buffer uses 512 MiB and 64 KiB scratchpad.', 'Memory (MiB)', '512 MiB'],
            ['Scratchpad is 64 KiB per stream.', 'Cache (KiB)', '64 KiB'],
            ['Audio bitrate is 128 kbps in streaming mode.', 'Bitrate (kbps)', '128 kbps'],
            ['Transfer rate reaches 4.5 Mbps.', 'Bandwidth (Mbps)', '4.5 Mbps'],
            ['Corpus archive totals 1.2 TB.', 'Storage (TB)', '1.2 TB'],
            ['CPU clock runs at 3.2 GHz.', 'Clock (GHz)', '3.2 GHz'],
            ['Vocabulary file is 256 KB.', 'Vocab (KB)', '256 KB']
        ];
        for (const [quote, header, cell] of validCases) {
            assert.doesNotThrow(
                () => bindTable(quote, header, cell),
                `Should pass explicit matching cell unit: ${header} / ${cell} / ${quote}`
            );
        }
    });

    it('fails closed when unit mismatches, is missing in quote, or is negated in quote', () => {
        const invalidCases = [
            ['The checkpoint takes 12 KB on disk.', 'Size (MB)', '12 KB'],
            ['The checkpoint takes 12 on disk.', 'Size (MB)', '12 MB'],
            ['Peak memory reaches 16 GB on a single GPU.', 'VRAM (GiB)', '16 GiB'],
            ['Peak memory is not 16 GiB, it is 32 GiB.', 'VRAM (GiB)', '16 GiB'],
            ['Full training completes in 2.5 min.', 'Duration (h)', '2.5 h'],
            ['Model size is 12 MB.', 'Size (GB)', '12 MB']
        ];
        for (const [quote, header, cell] of invalidCases) {
            assert.throws(
                () => bindTable(quote, header, cell),
                /列头单位/,
                `Must fail closed: ${header} / ${cell} / ${quote}`
            );
        }
    });
});
