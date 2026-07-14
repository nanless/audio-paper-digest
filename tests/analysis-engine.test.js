const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const {
    mergeAndSaveResults,
    analyzeBatch,
    analyzePaperWithRetry,
    getInvalidAnalysisReason,
    readJsonFileStrict,
    updateJsonFileLocked,
    acquireFileLockSync,
    canReclaimFileLock,
    withFileLock,
    isSuccessfulAnalysisRecord,
    getAnalysisRunStatus,
    getAnalysisExitCode
} = require('../scripts/analysis-engine.js');
const { getMissingRequiredSections } = require('../scripts/analysis-contract.js');
const { validAnalysisText } = require('./valid-analysis-fixture.js');

function legacyValidAnalysisText() {
    return `## 评分
7.7/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前25%
innovation: 1.5
technical_rigor: 1.2
experimental_sufficiency: 1.1
clarity: 0.8
impact: 1.0
open_source: 0
reproducibility: 0.3
engineering_score: 1.0
confidence: 高
primary_task_tag: #语音识别
primary_method_tag: #Transformer
sota_claim: 否
has_code: 否
has_model: 否
has_dataset: 否

## 标签
#语音识别 #Transformer #鲁棒性
主任务标签: #语音识别
主方法标签: #Transformer
补充标签: #鲁棒性

## 作者与机构
作者信息未说明。

## 毒舌点评
这项工作有明确问题设定，但亮点不算夸张。

## 核心摘要
这篇论文围绕语音识别场景提出改进方法，核心目标是提升复杂声学条件下的稳定性。方法通过编码器、上下文建模和解码模块协同工作，并用多个基准验证效果。论文还讨论了低信噪比、跨说话人和不同录音条件下的表现，说明方法主要改善鲁棒性而不是单纯扩大模型规模。

## 方法概述和架构
方法包含输入特征提取、声学编码、上下文融合和输出解码四个阶段。音频首先被转换为声学特征，再送入 Transformer 编码器建模长程依赖，随后通过任务头输出识别结果。上下文模块把局部帧级信息与更长时间跨度的语义提示结合，用于减少噪声片段对解码路径的干扰，整体结构清楚且和常见 ASR pipeline 兼容。

## 核心创新点
第一，论文把上下文建模显式加入声学编码流程。第二，实验设计覆盖了主要噪声条件。第三，方法结构相对清晰，便于后续复现。

## 实验结果
实验在多个语音识别数据集上比较 WER，结果显示该方法在低信噪比场景下优于基线。论文给出了关键指标，并报告了消融实验。消融部分比较了去掉上下文模块、只保留声学编码器和完整模型三种设置，说明主要收益来自上下文融合设计。

## 细节详述
训练细节包括数据处理、模型训练策略和推理设置。部分超参数在论文中未完整说明。

## 评分理由
创新性：1.5/2，有明确方法增量，虽然不是全新范式，但把上下文信息显式并入声学编码流程，针对噪声鲁棒性给出清楚设计。
技术严谨性：1.2/1.5，公开的方法逻辑基本合理，核心假设没有明显漏洞，但边界条件仍可讨论得更完整。
实验充分性：1.1/1.5，覆盖主要基准并提供消融实验，但跨域数据和真实远场场景还可以进一步扩展。
清晰度：0.8/1，结构描述清楚，模块关系和指标解释都比较直接，读者可以较快理解方法作用。
影响力：1.0/1.5，对语音识别读者有参考价值，尤其适合关注噪声鲁棒和上下文建模的研究者。
开源：0/1.5，未说明开源资源，因此代码、模型和数据可得性都不能确认。
可复现性：0.3/0.5，部分细节缺失，但主体 pipeline、评测任务和指标足以支撑粗粒度复现。
工程/实践价值：1.0/1.5，有一定部署参考价值，结构能接入常见 ASR 系统，但论文没有充分讨论延迟、吞吐和资源开销。

## 局限与问题
论文对极端噪声和跨域数据的讨论不足。

## 开源详情
未提及。`;
}

describe('mergeAndSaveResults', () => {
    it('不会用无 analysis 的失败结果覆盖已有成功结果', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-test-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({
            timestamp: '2026-01-01T00:00:00.000+08:00',
            papers: [{
                arxivId: '2604.12345v1',
                title: 'Existing success',
                analysis: validAnalysisText(),
                parsed: { score: '8.0' }
            }]
        }, null, 2));

        await mergeAndSaveResults([{
            arxivId: '2604.12345v2',
            title: 'Failed retry',
            analysis: null,
            parsed: null,
            error: 'failed'
        }], file);

        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.strictEqual(saved.papers.length, 1);
        assert.strictEqual(saved.papers[0].title, 'Existing success');
        assert.strictEqual(saved.papers[0].analysis, validAnalysisText());
        assert.deepStrictEqual(saved.papers[0].parsed, { score: '8.0' });
    });

    it('损坏的当前 JSON 会阻断覆盖', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-corrupt-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, '{broken');

        await assert.rejects(
            mergeAndSaveResults([{ arxivId: '2604.99999', analysis: 'new' }], file),
            /JSON 文件损坏或不可读，已阻止覆盖/
        );
        assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    });

    it('结构非法的 current JSON 不会被当作缺失文件覆盖', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-null-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, 'null');
        assert.throws(() => updateJsonFileLocked(file, () => ({ papers: [] })), /顶层必须是对象或数组/);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), 'null');
    });

    it('多个进程并发锁内合并不会丢更新', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-lock-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        fs.writeFileSync(file, JSON.stringify({ papers: [] }));
        const enginePath = path.resolve(__dirname, '../scripts/analysis-engine.js');
        const worker = `
            const { updateJsonFileLocked } = require(process.argv[1]);
            const file = process.argv[2];
            const prefix = process.argv[3];
            for (let i = 0; i < 12; i++) {
                updateJsonFileLocked(file, current => ({
                    ...current,
                    papers: [...(current.papers || []), { arxivId: prefix + '.' + i }]
                }));
            }
        `;

        await Promise.all(['a', 'b', 'c', 'd'].map(prefix =>
            execFileAsync(process.execPath, ['-e', worker, enginePath, file, prefix])
        ));

        const saved = readJsonFileStrict(file);
        assert.strictEqual(saved.papers.length, 48);
        assert.strictEqual(new Set(saved.papers.map(p => p.arxivId)).size, 48);
        assert.strictEqual(saved.generation, 48);
    });

    it('进程崩溃遗留的锁可由后续写入立即回收', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-dead-lock-'));
        const file = path.join(dir, 'result.json');
        const lockDir = `${file}.lock`;
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
            pid: 2147483647,
            hostname: os.hostname()
        }));
        updateJsonFileLocked(file, () => ({ papers: [] }), { timeoutMs: 100 });
        assert.strictEqual(readJsonFileStrict(file).generation, 1);
        assert.strictEqual(fs.existsSync(lockDir), false);
    });
});

describe('analyzePaperWithRetry', () => {
    it('完整分析通过校验并返回 parsed', async () => {
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00001', title: 'Valid' },
            {
                maxRetries: 0,
                analyzeFn: async () => ({ analysis: validAnalysisText() })
            }
        );

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.result.error, null);
        assert.ok(result.result.parsed.score);
        assert.strictEqual(result.result.parsed.documentType, '方法研究');
        assert.strictEqual(result.result.parsed.scoringRubricVersion, 'type-aware-v1');
        assert.strictEqual(result.result.scoringRubricVersion, 'type-aware-v1');
    });

    it('保留深度分析返回的 imageManifest', async () => {
        const imageManifest = {
            totalFound: 3,
            candidates: [{ url: 'https://example.com/architecture.png', score: 10 }],
            downloaded: [{ url: 'https://example.com/architecture.png', mime: 'image/png' }],
            selected: ['https://example.com/architecture.png']
        };
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00010', title: 'Valid with images' },
            {
                maxRetries: 0,
                analyzeFn: async () => ({
                    analysis: validAnalysisText(),
                    selectedImageUrls: imageManifest.selected,
                    allImageUrls: imageManifest.candidates.map(x => x.url),
                    imageManifest
                })
            }
        );

        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.result.imageManifest, imageManifest);
    });

    it('显式保留深度分析的来源与恢复 manifest，不依赖输入对象被修改', async () => {
        const sourceSha256 = 'a'.repeat(64);
        const analysisManifest = {
            version: 1,
            stages: {},
            sourceAcquisition: { analysisSource: 'abstract', sourceSha256 }
        };
        const result = await analyzePaperWithRetry({ arxivId: '2607.12345' }, {
            maxRetries: 0,
            analyzeFn: async () => ({
                analysis: validAnalysisText(),
                analysisSource: 'abstract',
                sourceTextChars: 800,
                usedTextChars: 800,
                fullTextChars: 0,
                fullTextAvailable: false,
                truncated: false,
                sourceSha256,
                analysisConfidence: 'degraded_abstract',
                sourceWarnings: ['全文不可用'],
                analysisManifest
            })
        });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.result.analysisSource, 'abstract');
        assert.strictEqual(result.result.sourceSha256, sourceSha256);
        assert.deepStrictEqual(result.result.analysisManifest, analysisManifest);
    });

    it('缺少必要章节会重试后失败', async () => {
        let calls = 0;
        let retries = 0;
        const result = await analyzePaperWithRetry(
            { arxivId: '2604.00002', title: 'Invalid' },
            {
                maxRetries: 1,
                retryDelayMs: 0,
                analyzeFn: async () => {
                    calls++;
                    return { analysis: '## 评分\n8.0/10\n\n## 实验结果\n结果' };
                },
                onRetry: () => { retries++; }
            }
        );

        assert.strictEqual(calls, 2);
        assert.strictEqual(retries, 1);
        assert.strictEqual(result.success, false);
        assert.match(result.error, /缺少必要章节/);
    });

    it('校验会拒绝缺少核心字段的分析', () => {
        assert.strictEqual(getInvalidAnalysisReason(validAnalysisText(), require('../scripts/utils.js').parseAnalysis(validAnalysisText())), null);
        assert.match(getInvalidAnalysisReason('## 评分\n8.0/10', {}), /缺少必要章节/);
    });

    it('结构契约会返回精确缺失章节供局部修复', () => {
        const text = validAnalysisText().replace(/## 细节详述[\s\S]*?(?=\n## 评分理由)/, '');
        assert.deepStrictEqual(getMissingRequiredSections(text), ['细节详述']);
        assert.match(getInvalidAnalysisReason(text, require('../scripts/utils.js').parseAnalysis(text)), /细节详述/);
    });

    it('校验会拒绝缺少文档类型的新分析', () => {
        const text = validAnalysisText().replace('document_type: 方法研究\n', '');
        const parsed = require('../scripts/utils.js').parseAnalysis(text);
        assert.match(getInvalidAnalysisReason(text, parsed), /document_type|文档类型/);
    });

    it('校验不会把 0 分误判为缺少评分', () => {
        let text = validAnalysisText()
            .replace('6.9/10', '0.0/10')
            .replace('rank_bucket: 前50%', 'rank_bucket: 后50%');
        for (const key of [
            'innovation', 'technical_rigor', 'experimental_sufficiency', 'clarity',
            'impact', 'open_source', 'reproducibility', 'engineering_score'
        ]) {
            text = text.replace(new RegExp(`^${key}: [^\\n]+`, 'm'), `${key}: 0.0`);
        }
        for (const label of [
            '创新性', '技术严谨性', '实验充分性', '清晰度',
            '影响力', '开源', '可复现性', '工程/实践价值'
        ]) {
            text = text.replace(new RegExp(`^${label}：[^/]+/`, 'm'), `${label}：0.0/`);
        }
        const parsed = require('../scripts/utils.js').parseAnalysis(text);
        assert.strictEqual(parsed.score, '0.0');
        assert.strictEqual(getInvalidAnalysisReason(text, parsed), null);
    });

    it('成功判断会重解析正文，不信任陈旧 parsed 缓存', () => {
        assert.strictEqual(isSuccessfulAnalysisRecord({
            arxivId: '2604.00020',
            analysis: 'truncated',
            parsed: require('../scripts/utils.js').parseAnalysis(validAnalysisText())
        }), false);
        assert.strictEqual(isSuccessfulAnalysisRecord({
            arxivId: '2604.00021',
            analysis: validAnalysisText(),
            parsed: null
        }), true);
    });

    it('恢复 manifest 未完成时不视为成功，失败尝试会保留 checkpoint', async () => {
        const manifest = {
            version: 1,
            stages: {
                imageDownload: { status: 'no_candidates' },
                primaryAnalysis: { status: 'complete' },
                openSourceScan: { status: 'transient_failure' }
            }
        };
        assert.strictEqual(isSuccessfulAnalysisRecord({
            arxivId: '2604.00022',
            analysis: validAnalysisText(),
            analysisManifest: manifest
        }), false);

        const paper = { arxivId: '2604.00023', title: 'Recoverable' };
        const attempt = await analyzePaperWithRetry(paper, {
            maxRetries: 0,
            analyzeFn: async current => {
                current.analysisManifest = manifest;
                current.analysisCheckpoint = validAnalysisText();
                return { analysis: null, error: 'stage timeout' };
            }
        });
        assert.strictEqual(attempt.success, false);
        assert.strictEqual(attempt.result.analysisCheckpoint, validAnalysisText());
        assert.strictEqual(attempt.result.analysisManifest, manifest);
    });

    it('失败重试不覆盖旧成功正文，但合并恢复元数据供下次续跑', () => {
        const complete = {
            arxivId: '2604.00024', title: 'Existing', analysis: validAnalysisText(),
            imageManifest: { selected: ['old-image'] }
        };
        const failed = {
            arxivId: '2604.00024',
            title: 'Existing',
            analysis: null,
            error: 'secondary timeout',
            imageManifest: { selected: [], downloaded: [] },
            analysisCheckpoint: validAnalysisText(),
            analysisManifest: { version: 1, stages: { imageDownload: { status: 'transient_failure' } } }
        };
        const { mergePapersById } = require('../scripts/analysis-engine.js');
        const [merged] = mergePapersById([complete], [failed], { preserveSuccessfulAnalysis: true });
        assert.strictEqual(merged.analysis, complete.analysis);
        assert.strictEqual(merged.analysisCheckpoint, failed.analysisCheckpoint);
        assert.deepStrictEqual(merged.imageManifest, complete.imageManifest);
        assert.deepStrictEqual(merged.analysisRecoveryImageManifest, failed.imageManifest);
        assert.strictEqual(merged.latestAnalysisAttemptError, 'secondary timeout');
        assert.strictEqual(isSuccessfulAnalysisRecord(merged), false);

        const [mergedAgain] = mergePapersById([merged], [{
            ...failed,
            error: 'secondary timeout again',
            analysisCheckpoint: null
        }], { preserveSuccessfulAnalysis: true });
        assert.strictEqual(mergedAgain.analysis, complete.analysis);
        assert.strictEqual(mergedAgain.latestAnalysisAttemptError, 'secondary timeout again');
    });

    it('最终契约拒绝展示总分或分档与八维重算结果不一致', () => {
        const wrongScore = validAnalysisText().replace('6.9/10', '6.0/10');
        assert.match(getInvalidAnalysisReason(wrongScore, require('../scripts/utils.js').parseAnalysis(wrongScore)), /总分.*不一致/);
        const wrongRank = validAnalysisText().replace('rank_bucket: 前50%', 'rank_bucket: 后50%');
        assert.match(getInvalidAnalysisReason(wrongRank, require('../scripts/utils.js').parseAnalysis(wrongRank)), /rank_bucket.*不一致/);
    });
});

describe('analyzeBatch', () => {
    it('同篇论文的锁覆盖最新状态重读、分析和写回，排队请求不会覆盖新结果', async () => {
        let canonical = null;
        let analyzeCalls = 0;
        const suffix = String(10000 + Math.floor(Math.random() * 89999));
        const paperId = `2607.${suffix}`;
        const papers = [
            { arxivId: paperId, title: 'same paper' },
            { arxivId: `${paperId}v2`, title: 'same paper queued' }
        ];
        const { stats } = await analyzeBatch(papers, {
            concurrency: 2,
            maxRetries: 0,
            preparePaperLocked: paper => canonical && isSuccessfulAnalysisRecord(canonical)
                ? { paper: canonical, skip: true }
                : { paper, skip: false },
            analyzeFn: async () => {
                analyzeCalls++;
                return { analysis: validAnalysisText() };
            },
            onPaperResultLocked: async (_paper, result) => {
                canonical = result.result;
            }
        });
        assert.strictEqual(analyzeCalls, 1);
        assert.strictEqual(stats.success, 1);
        assert.strictEqual(stats.skipped, 1);
        assert.strictEqual(isSuccessfulAnalysisRecord(canonical), true);
    });

    it('拒绝零、负数和非整数并发，避免循环无法推进', async () => {
        for (const concurrency of [0, -1, 1.5, Number.NaN]) {
            await assert.rejects(analyzeBatch([], { concurrency }), /concurrency 必须是正整数/);
        }
    });

    it('透传自定义 analyzeFn 到每篇论文分析', async () => {
        const calls = [];
        const { results, stats } = await analyzeBatch(
            [{ arxivId: '2604.00003', title: 'Custom analyzer' }],
            {
                concurrency: 1,
                maxRetries: 0,
                analyzeFn: async (paper) => {
                    calls.push(paper.arxivId);
                    return { analysis: validAnalysisText() };
                }
            }
        );

        assert.deepStrictEqual(calls, ['2604.00003']);
        assert.strictEqual(stats.success, 1);
        assert.strictEqual(results.length, 1);
        assert.strictEqual(results[0].error, null);
    });

    it('阶段 checkpoint 在单篇运行锁内立即原子写入 canonical 结果', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-stage-checkpoint-'));
        const file = path.join(dir, 'deep-analysis-result.json');
        updateJsonFileLocked(file, () => ({ papers: [{ arxivId: '2604.00033', title: 'Checkpoint' }] }));

        await analyzeBatch([{ arxivId: '2604.00033', title: 'Checkpoint' }], {
            concurrency: 1,
            maxRetries: 0,
            checkpointFilePath: file,
            analyzeFn: async paper => {
                paper.analysisCheckpoint = validAnalysisText();
                paper.analysisManifest = {
                    version: 1,
                    stages: { primaryAnalysis: { status: 'complete' } }
                };
                paper[Symbol.for('audio-paper-digest.analysisCheckpointCallback')](paper);
                throw new Error('simulated crash after primary analysis');
            }
        });

        const saved = readJsonFileStrict(file).papers[0];
        assert.strictEqual(saved.analysisCheckpoint, validAnalysisText());
        assert.strictEqual(saved.analysisManifest.stages.primaryAnalysis.status, 'complete');
        assert.strictEqual(saved.analysis, null);
    });

    it('shouldSkip 决策只对每篇论文计算一次', async () => {
        const calls = new Map();
        const papers = [
            { arxivId: '2604.00001v1', title: 'A' },
            { arxivId: '2604.00002v1', title: 'B' }
        ];

        const { stats } = await analyzeBatch(papers, {
            concurrency: 2,
            shouldSkip: (paper) => {
                calls.set(paper.arxivId, (calls.get(paper.arxivId) || 0) + 1);
                return true;
            }
        });

        assert.strictEqual(stats.skipped, 2);
        assert.strictEqual(calls.get('2604.00001v1'), 1);
        assert.strictEqual(calls.get('2604.00002v1'), 1);
    });

    it('onPaperDone 异常会终止批次并向入口传播', async () => {
        await assert.rejects(analyzeBatch(
            [{ arxivId: '2604.00011', title: 'Callback failure' }],
            {
                concurrency: 1,
                maxRetries: 0,
                analyzeFn: async () => ({ analysis: validAnalysisText() }),
                onPaperDone: () => { throw new Error('paper save failed'); }
            }
        ), /paper save failed/);
    });

    it('异步 onBatchDone 异常会终止批次并向入口传播', async () => {
        await assert.rejects(analyzeBatch(
            [{ arxivId: '2604.00012', title: 'Batch callback failure' }],
            {
                concurrency: 1,
                maxRetries: 0,
                analyzeFn: async () => ({ analysis: validAnalysisText() }),
                onBatchDone: async () => { throw new Error('batch save failed'); }
            }
        ), /batch save failed/);
    });
});

describe('analysis run status', () => {
    it('区分 complete、partial_failed 和 failed 并映射非零退出码', () => {
        assert.strictEqual(getAnalysisRunStatus({ success: 2, failed: 0 }), 'complete');
        assert.strictEqual(getAnalysisRunStatus({ success: 2, failed: 1 }), 'partial_failed');
        assert.strictEqual(getAnalysisRunStatus({ success: 0, failed: 2 }), 'failed');
        assert.strictEqual(getAnalysisExitCode('complete'), 0);
        assert.strictEqual(getAnalysisExitCode('partial_failed'), 2);
        assert.strictEqual(getAnalysisExitCode('failed'), 1);
    });

    it('锁内更新为对象结果自动递增 generation', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-generation-'));
        const file = path.join(dir, 'result.json');
        updateJsonFileLocked(file, () => ({ papers: [] }));
        updateJsonFileLocked(file, current => ({ ...current, marker: true }));
        const saved = readJsonFileStrict(file);
        assert.strictEqual(saved.generation, 2);
        assert.strictEqual(saved.marker, true);
    });

    it('活着的本机 PID 不会仅因锁超龄而被回收', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-live-'));
        const lockPath = path.join(dir, 'result.json.lock');
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            token: 'live-owner'
        }));
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
        fs.utimesSync(lockPath, old, old);

        assert.strictEqual(canReclaimFileLock(lockPath, 1), false);
    });

    it('远端主机锁只有租约超龄后才可回收', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-remote-'));
        const lockPath = path.join(dir, 'result.json.lock');
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 12345,
            hostname: `${os.hostname()}-remote`,
            token: 'remote-owner'
        }));
        const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
        fs.utimesSync(lockPath, old, old);

        assert.strictEqual(canReclaimFileLock(lockPath, 1), true);
    });

    it('旧 owner 的 release 不会删除同路径的新锁', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-aba-'));
        const target = path.join(dir, 'result.json');
        const releaseOld = acquireFileLockSync(target);
        fs.rmSync(`${target}.lock`, { recursive: true, force: true });
        const releaseNew = acquireFileLockSync(target);

        assert.strictEqual(releaseOld(), false);
        assert.strictEqual(fs.existsSync(`${target}.lock`), true);
        assert.strictEqual(releaseNew(), true);
    });

    it('异步锁在 callback 完成前保持持有', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-lock-async-'));
        const target = path.join(dir, 'run');
        await withFileLock(target, async () => {
            assert.strictEqual(fs.existsSync(`${target}.lock`), true);
            await new Promise(resolve => setTimeout(resolve, 5));
            assert.strictEqual(fs.existsSync(`${target}.lock`), true);
        });
        assert.strictEqual(fs.existsSync(`${target}.lock`), false);
    });
});

describe('selected reanalysis stats', () => {
    it('只把旧评分契约恢复为当前契约的论文计入恢复数', () => {
        const { updateReanalysisStats } = require('../scripts/reanalyze-selected.js');
        const data = {
            papers: [{ arxivId: 'a' }, { arxivId: 'b' }, { arxivId: 'c' }],
            stats: { reanalyzed: 1, reanalyzeFailed: 2 }
        };
        const results = [
            { arxivId: 'a', parsed: { scoringRubricVersion: 'type-aware-v1' } },
            { arxivId: 'b', parsed: { scoringRubricVersion: 'type-aware-v1' } }
        ];
        const recovered = updateReanalysisStats(data, results, new Set(['a']), { success: 2, failed: 0 }, '2026-07-10T18:00:00+08:00');

        assert.strictEqual(recovered, 1);
        assert.strictEqual(data.stats.reanalyzed, 2);
        assert.strictEqual(data.stats.reanalyzeFailed, 1);
        assert.strictEqual(data.stats.selectedReanalyzed, 2);
        assert.strictEqual(data.stats.selectedReanalyzeFailed, 0);
    });
});
