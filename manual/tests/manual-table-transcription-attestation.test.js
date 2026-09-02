'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT,
    loadTableTranscriptionAttestation
} = require('../scripts/manual-tutorial-contract-orchestrator.js');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'table-attestation-'));
    const paperId = '2608.25177';
    const filePath = path.join(root, paperId, 'reviews', 'final-table-attestation.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const articleSha256 = 'a'.repeat(64);
    const value = {
        version: 1, contract: TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT,
        paperId, articleSha256, passed: true, blockers: [], tables: [],
        provenance: {
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            taskName: '/root/table-review', independentTask: true
        }
    };
    fs.writeFileSync(filePath, JSON.stringify(value));
    return { root, paperId, filePath, articleSha256, value };
}

describe('manual table transcription attestation', () => {
    it('接受路径受控、SHA 正确且绑定当前文章的 Terra/high 独立逐表审查', () => {
        const f = fixture();
        const result = loadTableTranscriptionAttestation({
            contract: TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT,
            path: f.filePath,
            sha256: sha(fs.readFileSync(f.filePath))
        }, f.paperId, f.articleSha256, f.root);
        assert.equal(result.value.passed, true);
    });

    it('拒绝模型 provenance 缺失或文章 SHA 漂移', () => {
        const f = fixture();
        f.value.provenance.model = 'unknown';
        fs.writeFileSync(f.filePath, JSON.stringify(f.value));
        const binding = {
            contract: TABLE_TRANSCRIPTION_ATTESTATION_CONTRACT,
            path: f.filePath,
            sha256: sha(fs.readFileSync(f.filePath))
        };
        assert.throws(() => loadTableTranscriptionAttestation(
            binding, f.paperId, f.articleSha256, f.root
        ), /Terra\/high/);
    });
});
