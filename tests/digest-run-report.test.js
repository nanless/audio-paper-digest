const { describe, it } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const {
    parseDate,
    sourceHealthComplete,
    samePaperIds,
    visualAssetsAreValid,
    formatDigestRunSummary
} = require('../scripts/digest-run-report.js');
const Config = require('../scripts/config.js');
const {
    cardTaskToken,
    visualSummaryAssetPath
} = require('../scripts/visual-summary-state.js');

function crc32(buffer) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let value = n;
        for (let k = 0; k < 8; k += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[n] = value >>> 0;
    }
    let value = 0xffffffff;
    for (const byte of buffer) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(kind, payload) {
    const type = Buffer.from(kind, 'ascii');
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length, 0);
    type.copy(chunk, 4);
    payload.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(Buffer.concat([type, payload])), 8 + payload.length);
    return chunk;
}

function makePng() {
    const width = 768;
    const height = 1200;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 0, 0, 0, 0], 8);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(Buffer.alloc((width + 1) * height))),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}

describe('digest run report', () => {
    it('严格解析批次日期', () => {
        assert.strictEqual(parseDate(['--date', '2026-07-29']), '2026-07-29');
        assert.throws(() => parseDate(['--date', '2026-02-30']), /日期非法/);
        assert.throws(() => parseDate([]), /用法/);
    });

    it('抓取健康必须覆盖配置中的全部来源', () => {
        const raw = {
            batchDate: '2026-07-29',
            papers: [{ arxivId: '2607.1' }],
            sourceHealth: {
                arxiv: {
                    ok: true,
                    categories: Config.ARXIV_CATEGORIES.map(item => ({ id: item.id, ok: true }))
                },
                huggingface: { ok: true }
            }
        };
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), true);
        raw.sourceHealth.arxiv.categories.pop();
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), false);
        raw.sourceHealth.arxiv.categories = Config.ARXIV_CATEGORIES.map(() => ({ id: 'eess.AS', ok: true }));
        assert.strictEqual(sourceHealthComplete(raw, '2026-07-29'), false);
    });

    it('分析集合必须按规范化论文 ID 精确覆盖筛选集合', () => {
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1v2' }], [{ arxivId: '2607.1' }]),
            true
        );
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1' }], [{ arxivId: '2607.2' }]),
            false
        );
        assert.strictEqual(
            samePaperIds([{ arxivId: '2607.1' }, { arxivId: '2607.1v2' }], [{ arxivId: '2607.1' }]),
            false
        );
    });

    it('默认终端摘要保留门禁数字但不展开来源健康大对象', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: ['长图未完成'],
            fetch: { complete: true, rawCandidateCount: 42, sourceHealth: { huge: true } },
            filter: { complete: true, selectedCount: 6, totalCandidates: 42, pendingDecisions: 0 },
            analysis: { complete: true, successful: 6, total: 6, failed: 0 },
            blog: { complete: true, strictReview: true, publicationVerified: true },
            visuals: { gateComplete: false, complete: 8, total: 10, pending: 2, failed: 0 },
            cover: { complete: true, status: 'complete' }
        });
        assert.match(summary, /candidates=42/);
        assert.match(summary, /complete=8\/10/);
        assert.match(summary, /错误: 长图未完成/);
        assert.doesNotMatch(summary, /sourceHealth|huge/);
    });

    it('长图计数满额但资产门禁失败时终端不得误报 complete', () => {
        const summary = formatDigestRunSummary({
            batchDate: '2026-07-29',
            overallStatus: 'incomplete',
            errors: ['TOP 10 论文长图状态或资产校验未完成'],
            fetch: { complete: true, rawCandidateCount: 10 },
            filter: { complete: true, selectedCount: 10, totalCandidates: 10, pendingDecisions: 0 },
            analysis: { complete: true, successful: 10, total: 10, failed: 0 },
            blog: { complete: true, strictReview: true, publicationVerified: true },
            visuals: {
                gateComplete: false,
                status: 'complete',
                complete: 10,
                total: 10,
                pending: 0,
                failed: 0,
                assetsValid: false,
                archiveUnique: true
            },
            cover: { complete: true, status: 'complete' }
        });
        assert.match(summary, /长图 incomplete \| complete=10\/10/);
        assert.doesNotMatch(summary, /长图 complete \|/);
    });

    it('统一状态门禁与 visual:status 一样严格绑定 canonical 长图路径', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-report-visual-'));
        const originalAssetDir = Config.FILES.visualSummaryAssetDir;
        try {
            Config.FILES.visualSummaryAssetDir = path.join(dir, 'archive');
            const date = '2026-07-29';
            const id = '2607.12345';
            const title = 'Canonical visual';
            const analysisSha = 'a'.repeat(64);
            const promptSha = 'b'.repeat(64);
            const publication = {
                publicationCommit: 'c'.repeat(40),
                generationManifestSha256: 'd'.repeat(64)
            };
            const canonical = visualSummaryAssetPath(date, id, 'infographic', 1, title);
            const raw = makePng();
            fs.mkdirSync(path.dirname(canonical), { recursive: true });
            fs.writeFileSync(canonical, raw);
            const visual = {
                batchDate: date,
                publication,
                papers: {
                    [id]: {
                        normalizedArxivId: id,
                        title,
                        rank: 1,
                        analysisSha256: analysisSha,
                        promptSha256: promptSha,
                        cards: {
                            infographic: {
                                status: 'complete',
                                analysisSha256: analysisSha,
                                promptSha256: promptSha,
                                taskToken: cardTaskToken(
                                    id, 'infographic', analysisSha, promptSha, 1, publication
                                ),
                                assetPath: path.relative(Config.PROJECT_ROOT, canonical),
                                assetSha256: crypto.createHash('sha256').update(raw).digest('hex')
                            }
                        }
                    }
                }
            };
            assert.deepStrictEqual(visualAssetsAreValid(visual), {
                visualCards: [{
                    id,
                    paper: visual.papers[id],
                    kind: 'infographic',
                    card: visual.papers[id].cards.infographic
                }],
                assetsValid: true,
                archiveUnique: true
            });

            const nonCanonical = path.join(Config.FILES.visualSummaryAssetDir, 'other.png');
            fs.renameSync(canonical, nonCanonical);
            visual.papers[id].cards.infographic.assetPath = path.relative(
                Config.PROJECT_ROOT, nonCanonical
            );
            const invalid = visualAssetsAreValid(visual);
            assert.strictEqual(invalid.assetsValid, false);
        } finally {
            Config.FILES.visualSummaryAssetDir = originalAssetDir;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
