'use strict';
const sourceProject = process.env.PD_READER_FACT_LOCAL_SOURCE_PROJECT;
const paperSnapshot = process.env.PD_READER_FACT_LOCAL_PAPER_SNAPSHOT;
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const realDirectory = process.env.PD_READER_FACT_LOCAL_REQUEST_DIR;
const feedbackDirectory = process.env.PD_READER_FACT_LOCAL_FEEDBACK_DIR;
const test = require('node:test');
const assert = require('node:assert/strict');
const repair = require('../scripts/lib/reader-repair');
const claim = '这是已经核实需要纠正的完整错误原句。';
function sample() { return { sections: [{ body: '正确正文。' }], conceptBridges: [{ terms: ['机制甲', '机制乙'], explanation: `正确开头。${claim}正确结尾。` }] }; }
test('解释原句唯一命中并进入严格目标，terms 不授权', () => {
    const draft = sample();
    const issues = repair.assertReaderFactLocalCoverage(draft, [claim]);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, '/conceptBridges/0/explanation');
    const targets = repair.buildRepairContext(draft, issues, '', '', { readerFactLocalPaths: [issues[0].path], readerFactLocalClaims: [claim] }).targets;
    assert.equal(targets.length, 1);
    repair.factLocalPromptVariables({ targets }, '具体纠正意见', '逐字来源', ['逐字来源']);
    assert.throws(() => repair.factLocalPromptVariables({ targets: [{ ...targets[0], path: '/conceptBridges/0/terms' }] }, '意见', '来源', ['来源']));
});
test('重复错句、terms 错句、引文保护区和未知节点均在模型前拒绝', () => {
    for (const modify of [d => { d.sections[0].body = claim; }, d => { d.conceptBridges[0].terms.push(claim); }, d => { d.conceptBridges[0].explanation = `“${claim}”`; }, d => { d.readerTitle = claim; }]) {
        const draft = sample(); modify(draft);
        assert.throws(() => repair.assertReaderFactLocalCoverage(draft, [claim]), /未获准位置/);
    }
});
test('仅原解释完整错误句可替换，句外和 terms 改动被拒绝', () => {
    const draft = sample(); const targetPath = '/conceptBridges/0/explanation';
    const patch = { version: 1, draftSha256: repair.hashDraft(draft), replacements: [{ path: targetPath, oldSha256: repair.hashDraft(draft.conceptBridges[0].explanation), value: '正确开头。依据来源纠正的事实原句。正确结尾。' }] };
    const options = { readerFactLocalClaims: { [targetPath]: [claim] } };
    const result = repair.applyReaderPatch(draft, patch, [targetPath], options);
    assert.equal(result.conceptBridges[0].explanation, patch.replacements[0].value);
    assert.deepEqual(result.conceptBridges[0].terms, draft.conceptBridges[0].terms);
    assert.deepEqual(result.sections, draft.sections);
    assert.throws(() => repair.applyReaderPatch(draft, { ...patch, replacements: [{ ...patch.replacements[0], value: '额外改开头。依据来源纠正的事实原句。正确结尾。' }] }, [targetPath], options));
    assert.throws(() => repair.applyReaderPatch(draft, { ...patch, replacements: [{ path: '/conceptBridges/0', oldSha256: repair.hashDraft(draft.conceptBridges[0]), value: { ...draft.conceptBridges[0], terms: ['新术语'] } }] }, [targetPath], options));
});
const fs = require('node:fs');
const path = require('node:path');
test('真实11272和04871原请求应同时授权正文和漏掉的解释，全部错句覆盖', { skip: !realDirectory || !feedbackDirectory }, () => {
    for (const [id, bridge] of [['2610.11272', 4], ['2610.04871', 3]]) {
        const files = fs.readdirSync(realDirectory).filter(name => name.endsWith('.request.json'));
        const req = files.map(name => JSON.parse(fs.readFileSync(path.join(realDirectory, name)))).find(item => item.identity.paperId.split('v')[0] === id && item.prompt.length < 10000 && item.repairTargets?.length === 5);
        assert.ok(req, `${id} 实际短请求缺失`);
        const draft = typeof req.draft === 'string' ? JSON.parse(req.draft) : req.draft;
        const claims = JSON.parse(fs.readFileSync(path.join(feedbackDirectory, `${id}.json`))).rejectedReaderClaims;
        const issues = repair.assertReaderFactLocalCoverage(draft, claims);
        assert.equal(issues.length, 6);
        assert.ok(issues.some(item => item.path === `/conceptBridges/${bridge}/explanation`));
        const targets = repair.buildRepairContext(draft, issues, '', '', { readerFactLocalPaths: issues.map(item => item.path), readerFactLocalClaims: claims }).targets;
        assert.equal(targets.length, 6);
        assert.equal(targets.reduce((sum, item) => sum + item.authorizedClaims.length, 0), claims.length);
    }
});

test('两份真实签名稿经公共刷新入口派生六目标和新提示词身份，未覆盖时不请求模型',
    { skip: !realDirectory || !feedbackDirectory || !sourceProject || !paperSnapshot }, async t => {
        const os = require('node:os');
        const crypto = require('node:crypto');
        const Config = require('../scripts/config');
        const deep = require('../scripts/deep-analyzer');
        const daily = require('../scripts/lib/daily-fresh-source-plan');
        const facts = require('../scripts/lib/daily-fact-review');
        const prompts = require('../scripts/lib/prompt-text-versions');
        const utils = require('../scripts/utils');
        const publicRefresh = require('../scripts/refresh-api-reader').refreshApiReader;
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-real-bridge-public-'));
        const keys = ['deepAnalysisResult', 'papers', 'papersLegacy', 'runtimeDir', 'dailyFreshSourceRunsDir'];
        const saved = Object.fromEntries(keys.map(key => [key, Config.FILES[key]]));
        const originalRequest = utils.requestLlmJson;
        let modelCalls = 0;
        utils.requestLlmJson = async () => { modelCalls++; throw new Error('测试禁止实际模型请求'); };
        t.after(() => {
            Object.assign(Config.FILES, saved);
            utils.requestLlmJson = originalRequest;
            fs.rmSync(root, { recursive: true, force: true });
        });
        Config.FILES.deepAnalysisResult = path.join(root, 'analysis.json');
        Config.FILES.papers = path.join(root, 'papers.json');
        Config.FILES.papersLegacy = path.join(root, 'legacy.json');
        Config.FILES.runtimeDir = path.join(root, 'runtime');
        Config.FILES.dailyFreshSourceRunsDir = path.join(sourceProject, 'data/runtime/daily-fresh-source-runs');
        fs.writeFileSync(Config.FILES.papers, JSON.stringify({ papers: [] }));
        fs.writeFileSync(Config.FILES.papersLegacy, JSON.stringify({ papers: [] }));
        const snapshot = JSON.parse(fs.readFileSync(paperSnapshot, 'utf8'));
        const selected = Array.isArray(snapshot) ? snapshot : snapshot.papers;
        // 本测试只复制当前批次记录到临时文件；来源仍逐字读取原封存文件。
        const payload = JSON.parse(fs.readFileSync(path.join(sourceProject, 'data/current/deep-analysis-result.json'), 'utf8'));
        const rows = Array.isArray(payload) ? payload : payload.papers;
        for (const id of ['2610.11272', '2610.04871']) {
            const old = selected.find(paper => String(paper.arxivId || paper.id).replace(/v\d+$/, '') === id);
            assert.ok(old, `${id} 原签名稿缺失`);
            const index = rows.findIndex(paper => String(paper.arxivId || paper.id).replace(/v\d+$/, '') === id);
            assert.ok(index >= 0);
            rows[index] = old;
        }
        const plan = daily.requireDailyFreshSourceRecoveryPlan(payload, { rootDir: Config.FILES.dailyFreshSourceRunsDir });
        fs.writeFileSync(Config.FILES.deepAnalysisResult, JSON.stringify(payload));
        const digest = value => crypto.createHash('sha256').update(value).digest('hex');
        const inputSHA = digest(fs.readFileSync(Config.FILES.deepAnalysisResult));
        const sentinel = Object.assign(new Error('真实公共入口已到新身份与目标检查终点'), { code: 'TEST_PUBLIC_BOUNDARY', retryable: false });
        for (const [id, bridgeIndex] of [['2610.11272', 4], ['2610.04871', 3]]) {
            const old = selected.find(paper => String(paper.arxivId || paper.id).replace(/v\d+$/, '') === id);
            const feedback = facts.readFeedback(path.join(feedbackDirectory, `${id}.json`));
            const bound = facts.validateFeedback(feedback, plan, old);
            let visited = 0;
            await facts.withFactReview(bound, () => assert.rejects(publicRefresh(id, {
                readerFactLocalRevision: true,
                reviewFeedback: facts.reviewFeedback('apiReaderArticle', id),
                operations: { article: async (paper, source, options) => {
                    visited++;
                    const seed = deep.prepareApiReaderRevisionSeed(paper, source.text, options.reviewFeedback,
                        { readerFactLocalRevision: true });
                    const actual = { ...options, sourceText: source.text, structuredArtifacts: source.structuredArtifacts,
                        revisionSeed: seed, initialDraft: seed.initialDraft };
                    const start = deep.buildApiReaderGenerationStart(paper, actual);
                    assert.equal(start.readerFactLocalPaths.length, 6);
                    assert.ok(start.readerFactLocalPaths.includes(`/conceptBridges/${bridgeIndex}/explanation`));
                    const issues = repair.assertReaderFactLocalCoverage(start.signedRecoveryDraft, feedback.rejectedReaderClaims);
                    const targets = repair.buildRepairTargets(start.signedRecoveryDraft, issues, {
                        readerFactLocalPaths: start.readerFactLocalPaths, readerFactLocalClaims: feedback.rejectedReaderClaims });
                    assert.equal(targets.length, 6);
                    assert.equal(targets.reduce((count, target) => count + target.authorizedClaims.length, 0), feedback.rejectedReaderClaims.length);
                    const resources = deep.replayVerifiedReaderResourceIdentity(paper.apiReaderResources, source.text);
                    const evidence = deep.buildApiReaderEvidenceContext(paper.analysis, source.text, source.structuredArtifacts, id, null, resources);
                    const prepared = await deep.prepareApiReaderRetryIdentity(paper, paper.analysis, evidence,
                        { ...actual, readerResources: resources });
                    const newSHA = deep.runtimePromptTemplateSha256(prompts.promptFilePathForContract('apiReaderRepair', repair.FACT_LOCAL_PROMPT_CONTRACT));
                    assert.equal(prepared.identity.repairPromptSha256, newSHA);
                    assert.notEqual(newSHA, deep.runtimePromptTemplateSha256('prompts/api-reader-fact-local-v1.md'));
                    const outside = structuredClone(start.signedRecoveryDraft);
                    outside.readerTitle += feedback.rejectedReaderClaims[0];
                    assert.throws(() => repair.assertReaderFactLocalCoverage(outside, feedback.rejectedReaderClaims), /未获准位置/);
                    throw sentinel;
                } },
            }), /真实公共入口已到新身份/));
            assert.equal(visited, 1);
            assert.equal(modelCalls, 0);
            assert.equal(digest(fs.readFileSync(Config.FILES.deepAnalysisResult)), inputSHA);
        }
    });
