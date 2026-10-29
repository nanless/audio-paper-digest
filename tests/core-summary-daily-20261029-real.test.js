'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const stop = require('../scripts/lib/analysis-stop-control');
const filename = path.resolve(__dirname, '../scripts/analysis-contract.js');
const compiled = new Module(filename, module);
compiled.filename = filename;
compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(fs.readFileSync(filename, 'utf8') + `
module.exports.dnsMetric = (text, source) => hasSourceDefinedDnsMos(source)
    && hasAffirmativeDnsMosStatement(text, CORE_SUMMARY_DNSMOS_PATTERN);
module.exports.dnsBoundary = hasSourceBoundDnsMosBoundary;
module.exports.resultState = coreSummaryQuantitativeResultState;
module.exports.dailyMethod = hasSourceBoundEditedWaveformOrCachedAvChain;
module.exports.refinementDecline = sourceBoundPredictionRefinementDecline;
`, filename);
const api = compiled.exports;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const noModel = callback => () => stop.withModelRequestsForbidden(callback);

// Portable public-source excerpts, NOT a reconstructed paid response. Synthetic
// counterexamples below exercise the new guards independently of private data.
const definition = 'Because generative-model outputs are not necessarily sample-aligned with their references, we use the reference-free DNSMOS P.835 (SIG/BAK/OVL).';
const table = `Table 1: Comparison of different systems on the DNS Challenge test set.
System
Streamable
With Reverb
Without Reverb
Real Recordings
DNSMOS ↑\\uparrow
DNSMOS ↑\\uparrow
DNSMOS ↑\\uparrow
SIG
BAK
OVL
SIG
BAK
OVL
SIG
BAK
OVL
SELM [18]
✗
3.160
3.577
2.695
3.508
4.096
3.258
3.591
3.435
3.124
StreamSE (ℓ=0\\ell{=}0)
✓
3.417
3.990
3.086
3.617
4.124
3.361
3.399
3.830
3.016
3.1 Architecture Overview`;
const sourceExcerpt = table + '\nTest Data and Evaluation Metrics.\n' + definition;
const result = '在DNS Challenge 2020有混响合成集上，零前视StreamSE的DNSMOS OVL为3.086，超过SELM的2.695';
const boundary = '结论限于DNSMOS感知的合成分布，真实录音DNSMOS SIG和DNSMOS OVL仍落后于SELM';

test('构造回归：DNSMOS须为来源定义的完整子量表名，不接受裸SIG/BAK/OVL或模型别名', noModel(() => {
    assert.equal(api.dnsMetric(result, sourceExcerpt), true);
    assert.equal(api.resultState(result, sourceExcerpt).complete, true);
    assert.equal(api.resultState(result.replace('SELM的2.695', 'SELM的DNSMOS BAK为2.695'), sourceExcerpt).complete, false,
        'different DNSMOS subscales cannot supply one directional comparison');
    for (const name of ['DNSMOS BAK', 'DNSMOS SIG', 'DNSMOS P.835 OVL']) {
        assert.equal(api.dnsMetric(result.replace('DNSMOS OVL', name), sourceExcerpt), true, name);
    }
    for (const name of ['SIG', 'BAK', 'OVL', 'xDNSMOS OVL', 'DNSMOS OVLight', 'DNSMOS_OVL',
        'DNSMOS.OVL', 'DNSMOS-OVL', 'DNSMOS OVL模型', 'DNSMOS OVL model', 'DNSMOS OVL的基线']) {
        assert.equal(api.dnsMetric(result.replace('DNSMOS OVL', name), sourceExcerpt), false, name);
        assert.equal(api.resultState(result.replace('DNSMOS OVL', name), sourceExcerpt).complete, false, name);
    }
    for (const source of ['', 'DNSMOS is a model.', sourceExcerpt.replace(definition, 'Unrelated definition.')]) {
        assert.equal(api.resultState(result, source).complete, false);
        assert.equal(api.resultState(result.replace('DNSMOS OVL', 'DNSMOS OVL指标'), source).complete, false);
    }
}));

test('构造负例：否定、假设、第三方、撤回不能充当新DNSMOS实测证据', noModel(() => {
    for (const prefix of ['假设', '如果', '并非', '没有', '未来实验：', '第三方研究：',
        '先前工作：', '引用：', 'hypothetical: ', 'Previous work: ', 'not reported: ']) {
        assert.equal(api.dnsMetric(prefix + result, sourceExcerpt), false, prefix);
        assert.equal(api.resultState(prefix + result.replace('DNSMOS OVL', 'DNSMOS OVL指标'), sourceExcerpt).complete, false, prefix);
        assert.equal(api.dnsMetric(result, sourceExcerpt.replace(definition, prefix + definition)), false, prefix);
    }
    for (const heading of ['第三方研究：', '### Previous work:', '**假设：**']) {
        assert.equal(api.dnsMetric(heading + '\n' + result, sourceExcerpt), false, heading);
        assert.equal(api.dnsMetric(result, sourceExcerpt.replace(definition, heading + '\n' + definition)), false, heading);
    }
    assert.equal(api.dnsMetric(result + '。上述结果已撤回。', sourceExcerpt), false);
    assert.equal(api.resultState(result + '。上述结果已撤回。', sourceExcerpt).complete, false);
    assert.equal(api.dnsMetric(result, sourceExcerpt + '\nThis statement was withdrawn.'), false);
}));

test('构造回归：合成分布边界须有同来源P.835定义及真实录音SIG/OVL落后对照', noModel(() => {
    assert.equal(api.dnsBoundary(boundary, sourceExcerpt), true);
    assert.equal(api.dnsBoundary(boundary.replaceAll('DNSMOS SIG', 'SIG').replace('DNSMOS OVL', 'OVL'), sourceExcerpt), true);
    for (const bad of [boundary.replace('DNSMOS感知', '任意模型感知'),
        boundary.replace('真实录音', '其他分布'), boundary.replace('仍落后于', '优于'),
        boundary.replace('SELM', 'SELModel'), '结论限于任意合成分布']) {
        assert.equal(api.dnsBoundary(bad, sourceExcerpt), false, bad);
    }
    for (const prefix of ['假设', '如果', '并非', '第三方研究：', '引用：', '预计']) {
        assert.equal(api.dnsBoundary(prefix + boundary, sourceExcerpt), false, prefix);
    }
    assert.equal(api.dnsBoundary(boundary + '。上述结论已撤回。', sourceExcerpt), false);
    for (const badSource of ['', sourceExcerpt.replace(definition, ''),
        sourceExcerpt.replace('3.399', '3.999'), sourceExcerpt.replace('3.016', '3.999'),
        sourceExcerpt.replace('Real Recordings', 'Unrelated category'),
        sourceExcerpt.replace('Table 1:', 'Previous work: Table 1:')]) {
        assert.equal(api.dnsBoundary(boundary, badSource), false);
    }
}));

const run = path.resolve(__dirname, '../data/runtime/daily-fresh-source-runs/e766a04a-0ede-45d1-a154-a02308586172');
const sourceFile = path.join(run, 'sources/2610.37024/generation-000001/source.txt');
const diagnostics = path.join(run, 'reader-attempts/core-summary-repair/direct-31b0905c8b20e22421f69ff897f5c3c7d1f7687ca1bbf81f6f2ee7854722e041/request-diagnostics');
const paid = [
    ['770c2380-8d7b-48ce-869b-9fb80e654d57', '9fc051339e199c3f7dda3988ba25d53ac703b22f4ac788de85ba89d9e6e521b5'],
    ['98d28e76-a035-4e00-9f54-039ee049305f', 'c51dfef0415802334811873bf1b30e5945f4e420a6f34f76c9f285a29bcefbd3'],
    ['d22b444a-bd13-41be-9bdc-23138fd20f38', '158a5b228379be7574c7f30db5529e3ad8960b4a12ff51467b5a73e5d86a68cd']
];
for (const [index, [id, expected]] of paid.entries()) {
    test(`真实SHA绑定只读复验StreamSE付费稿${index + 1}（缺私有材料则跳过，不以构造稿代替）`, t => stop.withModelRequestsForbidden(() => {
        const responseFile = path.join(diagnostics, id + '.response.json');
        const dispositionFile = path.join(diagnostics, id + '.disposition.json');
        if (![sourceFile, responseFile, dispositionFile].every(file => fs.existsSync(file))) {
            t.skip('private sealed source/paid diagnostic unavailable');
            return;
        }
        const before = [sourceFile, responseFile, dispositionFile].map(file => fs.readFileSync(file));
        const source = before[0].toString('utf8');
        const response = JSON.parse(before[1]);
        assert.equal(sha(source), 'ab75b54aee316e179974783d2336214e4de8ec4decb9bf7130ce6e6ec673f042');
        assert.equal(response.id, id);
        assert.equal(response.outputTextSha256, expected);
        assert.equal(sha(response.rawResponse), expected);
        assert.equal(JSON.parse(before[2]).status, 'rejected');
        const issue = api.validateCoreSummarySemanticContract(response.rawResponse, { sourceText: source });
        if (index === 0) assert.match(issue, /方法链/u, 'independent first-draft method rejection remains');
        else assert.equal(issue, null);
        assert.doesNotMatch(String(issue), /关键定量结果|适用边界/u);
        [sourceFile, responseFile, dispositionFile].forEach((file, i) => assert.deepEqual(fs.readFileSync(file), before[i]));
        t.diagnostic(`rawSHA=${expected}; semantic=${issue || 'pass'}; zero requests / no adoption / history unchanged`);
    }));
}

// Literal method excerpts from the two paid responses; source excerpts are
// public evidence, while mutations are explicitly synthetic negative cases.
const methodCases = [
    {
        paper: '2610.37605', id: '87e595c2-96da-44b8-950b-1660cb5d6893',
        dir: '2ca668d4b061c63ae082ac56d689b06afb9a4674baf29a7b736e5deb05626d92',
        rawSha: '737c4ae18bac30ccf8f9a9033fc56087a1edf198a2f25677dc3cb6ed0e8d1321',
        sourceSha: '902672336026d21d16b48e5a9f6f5874f7fd1408a40cdba38e72dbda9f08ab92',
        window: '不同类替换把该区间换成另一选项类别的录音从而改变正确答案，同类替换用查询类别的另一段录音重写同一区间而保持正确答案，两者共享区间、响度估计、供体适配和交叉淡化，只有类别是否改变不同。替换后波形以两种选项顺序送入模型提问，得到的回答进入统计，回答变化率的配对差距把两类替换的差作为类别效应的度量，选择性准确率在原始和同类输入都答对的合格试验上检查新回答是否指向插入类别。',
        evidence: [
            'The different-class variant replaces the query event with a recording from the alternative class.',
            'Its matched same-class control inserts a different recording of the query class into exactly the same interval.',
            'Both variants use the same donor-fitting, level-estimation, background-copying, and crossfade procedures.',
            'Each waveform is queried in both option orders with “Which of these two sounds is present in it?”, requesting Answer: A or Answer: B.',
            'The answer-change gap Δ combines marginal correctness and dependence between condition outcomes.',
            'Selective accuracy measures whether a revised answer identifies the inserted class on eligible trials.'
        ],
        edges: ['不同类替换把该区间换成另一选项类别的录音', '同类替换用查询类别的另一段录音重写同一区间',
            '得到的回答进入统计', '回答变化率的配对差距把两类替换的差作为类别效应的度量',
            '检查新回答是否指向插入类别']
    },
    {
        paper: '2610.36643', id: '610eab01-588b-45f1-a353-4fd12ddfc574',
        dir: 'de0881a11bd7782a374c0b9e993c8897418718a615ba7dfc74a059f13e70686d',
        rawSha: '67b86d31bb55df6b953bf28b24e1b811070369e7d01dde5ec6b1a187666dbdd5',
        sourceSha: '3ce885fb992232c94c7f7e8c227f5377f0ca6d0767839d578741917389e738a2',
        window: 'Tap2Listen按模态分开计算，因果音频编码器只对混合频谱编码，经16ms窗8ms跳短时傅里叶变换投影到256维与6个局部因果自注意力块，输出音频表示并维护与目标无关的共享缓存。冻结视觉前端持续提取各人脸25Hz唇动特征与身份向量并存入4s滚动缓冲，切换时取出所选脸对齐片段送解码器而不重算编码器。解码器是唯一目标相关部分，把缓存音频表示与所选唇动拼接投影为键值、把身份向量加入解码查询，经4块交叉注意力与共享掩膜头估计复数比掩膜，再经逆变换重叠相加按每8ms重建波形。',
        evidence: [
            'Tap2Listen consists of a target-agnostic causal audio encoder that processes only the mixture and a target-conditioned decoder that uses the selected face.',
            'Because the encoder is target-agnostic, the encoder cache remains valid across target switches.',
            'Frozen visual frontends provide lip features from causal BlazeNet64.',
            'For a selected face, temporally aligned lip features are combined with the cached audio representation to form the attention memory.',
            'A shared mask head produces a complex ratio mask at each block, from which the iSTFT with overlap-add reconstructs the waveform at every hop.'
        ],
        edges: ['输出音频表示并维护与目标无关的共享缓存', '切换时取出所选脸对齐片段送解码器而不重算编码器',
            '把缓存音频表示与所选唇动拼接投影为键值', '把身份向量加入解码查询', '共享掩膜头估计复数比掩膜',
            '再经逆变换重叠相加按每8ms重建波形']
    }
];
for (const item of methodCases) {
    test(`方法节选与构造负例：${item.paper}逐边衔接、本文来源、归属及撤回保护`, noModel(() => {
        const source = item.evidence.join('\n');
        assert.equal(api.dailyMethod(item.window, source), true);
        for (const edge of item.edges) {
            assert.ok(item.window.includes(edge));
            assert.equal(api.dailyMethod(item.window.replace(edge, '独立存储并未交接'), source), false, edge);
        }
        for (const prefix of ['假设', '如果', '并未实现：', '第三方研究：', '引用：', 'Previous work: ',
            '以下属于另一独立方法：', '基线方法：', '对照系统：', '以下方法未执行：']) {
            assert.equal(api.dailyMethod(prefix + item.window, source), false, prefix);
            assert.equal(api.dailyMethod(prefix + '\n' + item.window, source), false, prefix + ' heading');
        }
        assert.equal(api.dailyMethod(item.window + '上述方法链已撤回。', source), false);
        for (const evidence of item.evidence) {
            assert.equal(api.dailyMethod(item.window, source.replace(evidence, 'UNRELATED')), false, evidence);
            assert.equal(api.dailyMethod(item.window, source.replace(evidence, 'Previous work: ' + evidence)), false, evidence);
            assert.equal(api.dailyMethod(item.window, source.replace(evidence, 'Hypothetically, ' + evidence)), false, evidence);
            assert.equal(api.dailyMethod(item.window, source.replace(evidence, 'Previous work.\n' + evidence)), false, evidence);
        }
        assert.equal(api.dailyMethod(item.window, ''), false);
        assert.equal(api.dailyMethod('先处理输入，再生成表示，最后输出结果。', source), false);
    }));
    test(`真实SHA绑定只读复验${item.paper}最新付费摘要，不改变原拒绝和预算`, t => stop.withModelRequestsForbidden(() => {
        const sourceFile = path.join(run, `sources/${item.paper}/generation-000001/source.txt`);
        const dir = path.join(run, `reader-attempts/core-summary-repair/direct-${item.dir}/request-diagnostics`);
        const files = [sourceFile, ...['request', 'response', 'disposition'].map(type => path.join(dir, `${item.id}.${type}.json`))];
        if (!files.every(file => fs.existsSync(file))) return t.skip('private paid source/diagnostics unavailable');
        const before = files.map(file => fs.readFileSync(file));
        const request = JSON.parse(before[1]), response = JSON.parse(before[2]);
        assert.equal(sha(before[0]), item.sourceSha);
        assert.equal(sha(response.rawResponse), item.rawSha);
        assert.equal(response.outputTextSha256, item.rawSha);
        assert.equal(response.requestSha256, sha(before[1]));
        assert.equal(request.identity.sourceTextSha256, item.sourceSha);
        assert.equal(request.identity.sourceIdentity.sourceSha256, item.sourceSha);
        assert.equal(request.identity.paperId, `arxiv:${item.paper}`);
        assert.equal(JSON.parse(before[3]).status, 'rejected');
        assert.ok(response.rawResponse.includes(item.window));
        assert.equal(api.dailyMethod(response.rawResponse, before[0].toString()), true);
        assert.equal(api.validateCoreSummarySemanticContract(response.rawResponse, { sourceText: before[0].toString() }), null);
        // Full SHA-bound paid drafts mutated only in memory: an early-return
        // profile cannot bypass the existing method-ownership/retraction gate.
        for (const prefix of ['以下属于另一独立方法：', '基线方法：', '对照系统：', '以下方法未执行：']) {
            for (const separator of ['', '\n', '。\n']) {
                const changed = response.rawResponse.replace(item.window, prefix + separator + item.window);
                assert.notEqual(changed, response.rawResponse);
                assert.equal(api.dailyMethod(changed, before[0].toString()), false, prefix + separator);
                assert.match(api.validateCoreSummarySemanticContract(changed, { sourceText: before[0].toString() }), /方法链/u, prefix + separator);
            }
        }
        for (const suffix of ['上述方法链已撤回。', '上述方法属于基线方法。', '该流程仅为另一独立方法。',
            '上述流程属于基线，并非本文方法。', '上述方法链属于基线。', '上述方法链仅供展示。',
            '不过，上述方法链属于基线。', '**上述方法链属于基线。**']) {
            const changed = response.rawResponse.replace(item.window, item.window + suffix);
            assert.equal(api.dailyMethod(changed, before[0].toString()), false, suffix);
            assert.match(api.validateCoreSummarySemanticContract(changed, { sourceText: before[0].toString() }), /方法链/u, suffix);
        }
        files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
        t.diagnostic(`rawSHA=${item.rawSha}; semantic=pass; original rejection retained; zero requests`);
    }));
}

const refinementSource = `Table 3. Performance of the CNN-BiGRU model.
Prediction Prediction Event
Task
Refinement Interval (sec) SEN PPV F1 Score
Off 5 0.858 0.841 0.850
Inhalation
On 5 0.828 0.848 0.838
SEN: sensitivity, and PPV: positive predictive value.
Furthermore, the
results indicate that prediction refinement traded off the SEN of inhalation detection against PPV,
thereby lowering the overall F1-score.`;
const refinement = '开启提炼后吸气灵敏度下降而阳性预测值上升，例如 5 s 间隔下灵敏度由 0.858 降至 0.828，阳性预测值由 0.841 升至 0.848，F1 由 0.850 降至 0.838。';
test('构造负例：实际提炼F1降至须同来源同间隔Off/On下降，不放行阈值或参数调整', noModel(() => {
    assert.equal(api.refinementDecline(refinement, refinementSource), true);
    for (const prefix of ['假设', '如果', '未发生：', '引用：', '第三方研究：', '预计', '并未']) {
        assert.equal(api.refinementDecline(prefix + refinement, refinementSource), false, prefix);
    }
    for (const bad of [refinement.replace('0.838', '0.938'), refinement.replace('F1 由', 'F1阈值由'),
        refinement.replace('F1 由', '参数F1由'), refinement.replace('5 s', '2 s'),
        refinement + '上述结果已撤回。']) assert.equal(api.refinementDecline(bad, refinementSource), false, bad);
    assert.equal(api.refinementDecline(refinement, ''), false);
    assert.equal(api.refinementDecline(refinement, refinementSource.replace('On 5', 'On 2')), false);
    assert.equal(api.refinementDecline(refinement, refinementSource.replace('results indicate', 'Previous work: results indicate')), false);
}));

test('真实SHA绑定复验Airmod已保存checkpoint（不是未保存的最后structure返回）', t => stop.withModelRequestsForbidden(() => {
    const current = path.resolve(__dirname, '../data/current/deep-analysis-result.json');
    const sourceFile = path.join(run, 'sources/2610.37083/generation-000001/source.txt');
    if (![current, sourceFile].every(file => fs.existsSync(file))) return t.skip('private saved checkpoint unavailable');
    const before = [current, sourceFile].map(file => fs.readFileSync(file));
    const paper = JSON.parse(before[0]).papers.find(row => row.arxivId === '2610.37083v1');
    if (!paper || sha(paper.analysisCheckpoint || '') !== 'bbfbb0fffeff3bcfba9f9f2be1af60ae7fe93264022909693957e25de7599e7d') {
        return t.skip('current checkpoint no longer matches immutable 2026-10-29 audit identity');
    }
    assert.equal(sha(before[1]), '9d1c89e0bdf4538eb92b6ec6131b3c10f954d28f05df68958ed1eb9e9b0f6425');
    assert.ok(paper.analysisCheckpoint.includes(refinement));
    assert.equal(api.refinementDecline(paper.analysisCheckpoint, before[1].toString()), true);
    assert.equal(api.validateExperimentTableContract(paper.analysisCheckpoint, { sourceText: before[1].toString() }), null);
    [current, sourceFile].forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
    t.diagnostic('saved checkpoint SHA=bbfbb0fffeff3bcfba9f9f2be1af60ae7fe93264022909693957e25de7599e7d; no final structure response preserved; zero requests');
}));
