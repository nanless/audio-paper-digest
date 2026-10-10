'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
    parseArgs,
    safeRelative,
    readBoundJsonRef,
    loadRecordsV4Envelopes,
    buildSpecV6,
    claimBatchTaskNames
} = require('../scripts/create-manual-analysis-spec-v6.js');
const { buildManifestContext } = require('../scripts/manual-fetch-fulltext.js');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');

describe('Manual v4 记录与 v6 分析配置组装', () => {
    it('命令参数须选择正式或隔离模式，不能自行指定输出路径', () => {
        assert.deepEqual(parseArgs([
            '--production', '--date', '2026-08-28', '--records', 'a.json', '--records', 'b.json'
        ]), {
            date: '2026-08-28', records: ['a.json', 'b.json'], force: false,
            runtimeMode: 'production'
        });
        assert.equal(parseArgs([
            '--shadow', '--date', '2026-08-28', '--records', 'a.json', '--force'
        ]).force, true);
        assert.throws(() => parseArgs([
            '--date', '2026-08-28', '--records', 'a.json'
        ]), /显式指定/);
        assert.throws(() => parseArgs([
            '--production', '--shadow', '--date', '2026-08-28', '--records', 'a.json'
        ]), /必须且只能/);
        assert.throws(() => parseArgs([
            '--production', '--date', '2026-08-28', '--records', 'a.json', '--output', 'data/current/x.json'
        ]), /未知参数/);
    });

    it('文件引用拒绝绝对路径和越界的相对路径', () => {
        assert.equal(safeRelative('packets/author.json', 'packet'), 'packets/author.json');
        for (const candidate of ['../x.json', '/tmp/x.json', '.', 'a/../../x.json']) {
            assert.throws(() => safeRelative(candidate, 'packet'), /安全相对路径/);
        }
    });

    it('文件引用核对内容 SHA，并拒绝重复路径与符号链接', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-ref-'));
        const bytes = Buffer.from('{"paperId":"2608.12345"}');
        fs.writeFileSync(path.join(root, '2608.12345-record.json'), bytes);
        const ref = { path: '2608.12345-record.json', sha256: sha(bytes) };
        const occupied = new Set();
        const loaded = readBoundJsonRef(root, ref, 'record', '2608.12345', occupied);
        assert.equal(loaded.fileSha256, ref.sha256);
        assert.throws(() => readBoundJsonRef(root, ref, 'record', '2608.12345', occupied), /复用同一文件路径/);
        assert.throws(() => readBoundJsonRef(root, { ...ref, sha256: '0'.repeat(64) },
            'record', '2608.12345', new Set()), /字节 SHA 不匹配/);
        fs.symlinkSync(path.join(root, '2608.12345-record.json'), path.join(root, 'alias.json'));
        assert.throws(() => readBoundJsonRef(root, { path: 'alias.json', sha256: ref.sha256 },
            'record', '2608.12345', new Set()), /符号链接/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('记录清单引用的逐篇文件缺失时，SHA 占位不能通过检查', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-envelope-'));
        const envelopePath = path.join(root, 'records.json');
        fs.writeFileSync(envelopePath, JSON.stringify({
            version: 4,
            mode: 'manual_analysis_records',
            date: '2026-08-28',
            agent: 'Codex',
            reviewProtocol: 'manual-v6-review-protocol-v1',
            papers: {
                '2608.12345': {
                    artifactRoot: 'paper-2608.12345',
                    record: { path: 'record.json', sha256: 'a'.repeat(64) }
                }
            }
        }));
        fs.mkdirSync(path.join(root, 'paper-2608.12345'));
        assert.throws(() => loadRecordsV4Envelopes([envelopePath], '2026-08-28'), /不存在|文件/);
        fs.rmSync(root, { recursive: true, force: true });
    });

    it('入选论文 ID 去除版本号后重复时，在读取后续文件前拒绝', () => {
        assert.throws(() => buildSpecV6({
            date: '2026-08-28',
            runtimeMode: 'production',
            filtered: {
                batchDate: '2026-08-28', status: 'complete',
                papers: [{ arxivId: '2608.12345v1' }, { arxivId: '2608.12345' }]
            },
            records: { papers: {} }
        }), /规范化重复/);
    });

    it('不同论文不能复用同一个任务名称', () => {
        const owners = new Map();
        claimBatchTaskNames(owners, '2608.12345', ['author-12345', 'review-12345']);
        assert.throws(() => claimBatchTaskNames(
            owners, '2608.54321', ['author-54321', 'review-12345']
        ), /批次全局复用/);
    });

    it('结构化来源清单未完成时，不能组装已完成的 v6 分析配置', () => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-v6-artifact-health-'));
        const filtered = {
            batchDate: '2026-08-28', status: 'complete',
            papers: [{
                arxivId: '2608.12345', title: 'A complete paper title',
                abstract: 'A sufficiently explicit abstract for identity binding.', authors: ['Researcher']
            }]
        };
        const context = buildManifestContext(filtered, '2026-08-28', outDir);
        const fullTextManifest = {
            version: 2, mode: 'manual_full_text_fetch', date: '2026-08-28',
            status: 'complete', failed: 0, count: 1,
            filteredBatchSha256: context.filteredBatchSha256,
            expectedPaperInputs: context.expectedPaperInputs,
            papers: { '2608.12345': {} }
        };
        assert.throws(() => buildSpecV6({
            date: '2026-08-28', runtimeMode: 'production', filtered,
            fullTextManifest, fullTextManifestPath: path.join(outDir, 'manifest.json'),
            artifactManifest: {
                version: 1, mode: 'manual_artifact_index', date: '2026-08-28',
                status: 'incomplete', count: 1, incomplete: 1, failed: 0,
                filteredBatchSha256: context.filteredBatchSha256,
                expectedPaperInputs: context.expectedPaperInputs,
                papers: { '2608.12345': {} }
            },
            artifactManifestPath: path.join(outDir, 'artifacts', 'manifest.json'),
            records: { papers: { '2608.12345': {} } }
        }), /complete ArtifactIndex manifest/);
        fs.rmSync(outDir, { recursive: true, force: true });
    });
});
