'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const deep = require('../scripts/deep-analyzer');
const repair = require('../scripts/lib/reader-repair');
const { fixture, sign } = require('./reader-signed-draft-fixture');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function example() {
    const quotes = [
        'The source reports a controlled measurement of 1.0 under the same protocol.',
        'Our code is available at https://github.com/example/own-code.',
        'Our model weights are available at https://huggingface.co/example/own-model.',
        'Our dataset is available at https://huggingface.co/datasets/example/own-data.',
        'We use the third-party baseline at https://github.com/example/prior-code.',
        'Our audio demo is available at https://example.com/audio-demo.',
        'We evaluate released checkpoints of an existing baseline as calibration references.'
    ];
    const sourceText = quotes.join('\n\n');
    const f = fixture({ noFigures: true, sourceText });
    f.draft.tableBindings.forEach(binding => { binding.sourceQuotes = [quotes[0]]; });
    const resources = [
        ['code', quotes[1], 'https://github.com/example/own-code', 'available', 200],
        ['model', quotes[2], 'https://huggingface.co/example/own-model', 'unavailable', 404],
        ['dataset', quotes[3], 'https://huggingface.co/datasets/example/own-data', 'temporarily_unreachable', null],
        ['third_party', quotes[4], 'https://github.com/example/prior-code', 'available', 200],
        ['demo', quotes[5], 'https://example.com/audio-demo', 'available', 200]
    ].map(([type, sourceQuote, url, availability, status]) => ({ type, origin: 'paper_source',
        sourceQuote, sourceQuoteSha256: sha(sourceQuote), originalUrl: url, finalUrl: url,
        redirects: [], availability, status, retryable: availability === 'temporarily_unreachable' }));
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText), resources };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    return { ...f, identity, options: { arxivId: f.paper.arxivId, requiredVersion: 3,
        requireIntegratedTables: true, minimumIntegratedTables: 2, requireSourceBindings: true,
        availableFigureOrdinals: [], structuredArtifacts: f.sourceDetails.structuredArtifacts,
        sourceText, verifiedResourceIdentity: identity } };
}

function parseWithClaim(f, text, index = 10) {
    const draft = structuredClone(f.draft);
    draft.sections[index].body += '\n\n' + text;
    return deep.parseApiReaderArticleResult(JSON.stringify(draft), f.options);
}

// 10月20日已保存失败稿的原句及封存原文片段；不依赖本机运行数据。
const oct20ResourceCases = [
    { claim: 'SheetSage-MSA 的起点是 SheetSage-data 仓库已发布的函数标签和边界注释。',
        source: 'We construct an MSA dataset from the function\nlabels and boundary annotations released with\nSheetSage11\n 1\n https://github.com/chrisdonahue/sheetsage-data/\n [15].',
        urls: ['https://github.com/chrisdonahue/sheetsage-data/'] },
    { claim: '复现应从公开检查点和数据划分做起：学生用CosyVoice-1 300M和GPT-SoVITS v4的已发布权重，合成专家用Qwen3-TTS-12Hz-1.7B-Base生成，评价转写用Whisper-large-v3，说话人嵌入用ERes2Net，内容与相似度工具遵循CV3-Eval。',
        source: 'We initialize the students from the publicly released\nCosyVoice-1 300M11\n 1\n https://huggingface.co/FunAudioLLM/CosyVoice-300M\nand GPT-SoVITS v422\n 2\n https://huggingface.co/lj1995/GPT-SoVITS\ncheckpoints.',
        urls: ['https://huggingface.co/FunAudioLLM/CosyVoice-300M', 'https://huggingface.co/lj1995/GPT-SoVITS'] },
    { claim: '本文没有公开代码、模型或数据可用的证据，来源清单显示无可用作者资源，所以复现只能按正文参数自己实现，不存在权重下载或开箱运行之说。',
        source: 'We report a single-subject feasibility case study.' },
    { claim: '需要先明确：论文没有提出并训练新的识别结构，它的训练动作是对已有预训练语音模型做微调，作为验证数据集可用的基线。',
        source: 'The results of our baseline experiments demonstrate that the datasets are useful for examining gender and speaker-type attribute bias in the target languages.' },
    { claim: '关于资源，本次只确认论文提到的公开基准与模型名称，未确认作者代码权重是否当前可用，因此应把代码可得、权重可下载与系统可运行分开核对，不要把论文提到链接等同于已开源。',
        source: 'We evaluate neural speech decoding on existing benchmarks.' }
];

function oct20Identity(row, source = row.source) {
    const resources = (row.urls || []).map(originalUrl => ({ type: 'third_party', origin: 'paper_source',
        sourceQuote: source, sourceQuoteSha256: sha(source), originalUrl, finalUrl: originalUrl,
        redirects: [], availability: 'available', status: 200, retryable: false }));
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(source), resources };
    return { ...body, identitySha256: deep.stableFingerprint(body) };
}

test('五份真实失败原句分别按第三方输入、闭合否定及实验用途完整解析，不升级作者资源', () => {
    for (const row of oct20ResourceCases) {
        const sourceText = 'The source reports a controlled measurement of 1.0 under the same protocol.\n\n' + row.source;
        const f = fixture({ noFigures: true, sourceText });
        f.draft.tableBindings.forEach(binding => { binding.sourceQuotes = [sourceText.split('\n\n')[0]]; });
        f.draft.sections[10].body += '\n\n' + row.claim;
        const identity = oct20Identity(row, sourceText);
        const before = JSON.stringify(f.draft);
        const result = deep.parseApiReaderArticleResult(before, { arxivId: f.paper.arxivId,
            requiredVersion: 3, requireIntegratedTables: true, minimumIntegratedTables: 2,
            requireSourceBindings: true, availableFigureOrdinals: [],
            structuredArtifacts: f.sourceDetails.structuredArtifacts, sourceText,
            verifiedResourceIdentity: identity });
        assert.ok(result.article, row.claim);
        assert.equal(JSON.stringify(f.draft), before);
        assert.ok(identity.resources.every(resource => resource.type === 'third_party'));
        for (const suffix of ['但权重已可下载。', '但事实上本文代码已经开源。', '数据集现已公开下载。']) {
            const issues = deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction',
                body: row.claim + suffix }] }, identity, sourceText);
            assert.ok(issues.length > 0, row.claim + suffix);
        }
    }
});

test('闭合否定、功能用途与裸概念区分不能掩盖反驳、引述、撤回或另一项真实开放声明', () => {
    const row = oct20ResourceCases[2], identity = oct20Identity(row);
    const issues = text => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] },
        identity, row.source);
    for (const text of [
        '本文没有公开代码、模型或数据可用的证据，但权重已可下载。',
        '并非本文没有公开代码、模型或数据可用的证据，本文代码当前可用。',
        '不能否认本文代码已开源，本文没有公开代码、模型或数据可用的证据。',
        '“本文没有公开代码、模型或数据可用的证据”这一说法是错误的，本文代码已开源。',
        '本文没有公开代码、模型或数据可用的证据，上述否定已撤回，本文代码已开源。',
        '作为验证数据集已经公开下载的基线。',
        '作为验证数据集可用的基线，但数据集现已公开下载。',
        '因此应把本文代码可得、权重可下载与系统可运行分开核对。',
        '因此应把代码可得、权重可下载与系统可运行分开核对，但本文模型权重已公开。'
    ]) assert.ok(issues(text).length > 0, text);
    for (const text of ['如果以后数据集可用，可以再设基线。',
        '若本文权重当前可下载，仍需先核对许可。',
        '因此应把代码可得、权重可下载与系统可运行分开核对。']) {
        assert.deepEqual(issues(text), [], text);
    }
});

test('第三方输入豁免绑定同一原文、资源名与学生版本，假设、否定及错误归属不给能力', () => {
    for (const row of oct20ResourceCases.slice(0, 2)) {
        const issues = (claim, source = row.source) => deep.readerResourceClaimIssues({ sections: [
            { kind: 'reproduction', body: claim }
        ] }, oct20Identity(row, source), source);
        assert.deepEqual(issues(row.claim), []);
        for (const source of ['If ' + row.source, 'We never said: ' + row.source,
            'A previous paper reported: ' + row.source, '“' + row.source + '”',
            row.source + ' This statement is false.', row.source + ' This claim has been withdrawn.']) {
            assert.ok(issues(row.claim, source).length > 0, source);
        }
        assert.ok(issues(row.claim.replace('SheetSage-data', 'Invented-data')
            .replace('GPT-SoVITS v4', 'GPT-SoVITS v42')).length > 0);
        assert.ok(issues(row.claim + '第三方资源可用，因此本文微调后的模型权重已经公开。').length > 0);
    }
});

test('一份来源内其他仓库的肯定声明不能为假设、否定或另一引文的仓库背书', () => {
    for (const row of oct20ResourceCases.slice(0, 2)) {
        const other = row.source.replaceAll('SheetSage', 'Other').replace('chrisdonahue', 'another-team')
            .replaceAll('CosyVoice', 'DifferentVoice').replaceAll('GPT-SoVITS', 'Different-TTS');
        for (const first of ['If ' + row.source, 'We never said: ' + row.source,
            'A previous paper reported: ' + row.source]) {
            for (const later of [other, row.source]) {
                const source = first + '\n\n' + later;
                const { identitySha256: _old, ...body } = oct20Identity(row, source);
                body.resources = body.resources.map(resource => ({ ...resource, sourceQuote: first,
                    sourceQuoteSha256: sha(first) }));
                const checked = { ...body, identitySha256: deep.stableFingerprint(body) };
                assert.ok(deep.readerResourceClaimIssues({ sections: [{ kind: 'component', body: row.claim }] },
                    checked, source).length > 0, first);
            }
        }
    }
});

test('旧会议资源原身份只读，当前投影不把项目链接升级为数据开放且仍拒虚假正文', () => {
    const sourceText = '1Project page: https://example.com/project/';
    const originalUrl = 'https://example.com/project/';
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(sourceText),
        resources: [{ type: 'dataset', origin: 'paper_source', sourceQuote: sourceText,
            sourceQuoteSha256: sha(sourceText), originalUrl, finalUrl: originalUrl,
            redirects: [], status: 200, availability: 'available', retryable: false }] };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    const paper = { id: 'conference:interspeech:2026:conference-paper-id:test', source: 'conference',
        sourceSha256: sha(sourceText), apiReaderResources: identity,
        analysisManifest: { contracts: { apiReaderResourceIdentity: identity.contract },
            stages: { apiReaderArticle: { resourceIdentityContractVersion: identity.contract } } } };
    paper.conferencePaperId = paper.id;
    const before = JSON.stringify(paper);
    assert.throws(() => deep.replayVerifiedReaderResourceIdentity(identity, sourceText));
    const view = deep.readerResourcePublicationResources(paper, sourceText);
    assert.equal(view[0].type, 'third_party');
    const draft = text => ({ sections: [{ kind: 'reproduction', body: text }] });
    assert.deepEqual(deep.readerResourceClaimIssues(draft('项目页链接可访问，但数据和模型开放状态尚未确认。'),
        identity, sourceText, { paper }), []);
    assert.ok(deep.readerResourceClaimIssues(draft('本文数据集已公开，可以直接下载。'),
        identity, sourceText, { paper }).length);
    assert.equal(JSON.stringify(paper), before);
    assert.throws(() => deep.readerResourcePublicationResources(paper, sourceText + 'wrong'));
    for (const mutate of [
        p => { p.source = 'arxiv'; },
        p => { p.analysisManifest.stages.apiReaderArticle.resourceIdentityContractVersion = 'unknown'; },
        p => { p.analysisManifest.contracts.readerResourceClaims = 'unknown'; },
        p => { p.analysisManifest.contracts.readerResourceClaims = deep.API_READER_RESOURCE_CLAIMS_CONTRACT;
            p.analysisManifest.stages.apiReaderArticle.readerResourceClaimsContractVersion = deep.API_READER_RESOURCE_CLAIMS_CONTRACT; },
        p => { p.apiReaderResources.identitySha256 = '0'.repeat(64); }
    ]) { const changed = structuredClone(paper); mutate(changed);
        assert.throws(() => deep.readerResourcePublicationResources(changed, sourceText)); }
});

test('证据中未给出的资源声明与数量一致的并列主张后置否定仅豁免自身，转折及双重否定仍拒绝', () => {
    const cases = require('./reader-resource-scoped-denial-fixture.json');
    const f = example();
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(f.options.sourceText), resources: [] };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    const issues = text => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] },
        identity, f.options.sourceText);
    for (const text of cases.accept) assert.deepEqual(issues(text), [], text);
    for (const text of cases.reject) assert.ok(issues(text).length > 0, text);
    for (const text of cases.accept.slice(0, 2)) {
        const draft = structuredClone(f.draft);
        draft.sections[10].body += '\n\n' + text;
        const bytes = JSON.stringify(draft);
        assert.ok(deep.parseApiReaderArticleResult(bytes, { ...f.options, verifiedResourceIdentity: identity }).article);
        assert.equal(JSON.stringify(draft), bytes);
    }
});

test('原文发布归属与当前不可确认分开核验，只豁免有来源的reported范围', () => {
    const source = 'The implementation code is publicly\navailable for reproducibility at Github repository.';
    const identityFor = text => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(text), resources: [] };
        return { ...body, identitySha256: deep.stableFingerprint(body) };
    };
    const issues = (text, evidence = source) => deep.readerResourceClaimIssues({ sections: [
        { kind: 'reproduction', body: text }
    ] }, identityFor(evidence), evidence);
    const actual = '关于资源可得性，论文正文称实现代码在Github仓库公开可复现，但本次可核验的来源中没有确认可达的代码链接，因此这里不能写代码当前可用或已公开，需要读者自行按论文信息检索并核对版本。';
    assert.deepEqual(issues(actual), []);
    const printed = 'The implementation code is publicly\n'
        + 'maximally informative about the transcription target while dis-\n'
        + 'available for reproducibility at Github repository.';
    assert.deepEqual(issues(actual, printed), [], '原PDF文字层的有界跨行保留逐字上下文');
    for (const text of [
        actual.replace('不能写代码当前可用或已公开', '本文代码当前可用且已公开'),
        actual.replace('，需要读者', '，但事实上本文代码已经开源，需要读者'),
        actual.replace('代码链接', '模型权重链接'),
        actual.replace('没有确认可达的代码链接', '并非没有确认可达的代码链接'),
        '论文正文称实现代码在Github仓库公开可复现，因此本文代码当前可用。',
        '论文正文称实现代码在Github仓库公开可复现，但本次可核验的来源中没有确认可达的代码链接，本文模型权重已经公开。',
        '论文正文称模型权重已经公开，但本次可核验的来源中没有确认可达的代码链接，因此不能写代码当前可用或已公开。'
    ]) assert.ok(issues(text).length > 0, text);
    for (const missing of ['The paper describes an audio model.',
        'The implementation code is not publicly available at this time.',
        'If the implementation code is publicly available, reproduce the experiment.',
        'The third-party baseline code is publicly available.',
        'The example string is "The implementation code is publicly available".',
        printed.replace('maximally informative', 'not confirmed or claimed')]) {
        assert.ok(issues(actual, missing).length > 0, missing);
    }
});

test('普通日更 v3 正式解析按代码、权重、数据各自可达状态拒绝不实当前宣称，不能通过 false 开关绕过', () => {
    const f = example();
    assert.ok(deep.parseApiReaderArticleResult(JSON.stringify(f.draft), f.options).article);
    assert.ok(parseWithClaim(f, '本文代码已开源且当前可用。').article);
    for (const text of [
        '本文模型权重现已公开并可下载。',
        '本文数据集已经公开且当前可用。',
        '本文代码与模型权重均已公开。',
        '本文代码已经开源，并且本文数据集当前可用。',
        '不但本文模型权重已开源，而且当前可用。',
        '未发现证据否定本文模型权重已经开源。',
        '不声称本文权重已公开，但事实上本文模型权重已经开源。'
    ]) {
        const draft = structuredClone(f.draft);
        draft.sections[10].body += '\n\n' + text;
        const before = JSON.stringify(draft);
        assert.throws(() => deep.parseApiReaderArticleResult(before,
            { ...f.options, enforceResourceAvailabilityClaims: false }), error => {
            assert.equal(error.code, 'READER_RESOURCE_AVAILABILITY_CLAIM');
            assert.ok(error.readerIssues.length > 0);
            assert.ok(error.readerIssues.every(issue => issue.code === 'reader_resource_availability_claim'
                && issue.path === '/sections/10/body' && issue.conflictExcerpt.length <= 240));
            return true;
        }, text);
        assert.equal(JSON.stringify(draft), before, '验证不得改正文或补写成功证明');
    }
});

test('否定、条件、作者未来承诺与当前无法确认不等于作者没有发布，实际日更解析接受准确限定', () => {
    const f = example();
    for (const text of [
        '目前无法确认作者是否已公开模型权重。',
        '不能声称本文模型权重已开源或当前可用。',
        '若本文模型权重当前可用，复现前仍需核对具体版本。',
        '如果本文数据集已经公开，应先检查访问权限与数据划分。',
        '原文称模型权重已公开，但本次链接返回 HTTP 404，当前不可用。',
        '本文数据集链接本次未能确认可达，不把这一状态写成作者未发布数据。',
        '作者计划公开模型权重，当前还需等待实际发布与下载状态。',
        '代码开源、权重可下载、系统可运行是三件不同的事，需要分别确认。',
        '代码开源、权重可下载、系统可运行要分开看，作者是否已发布仍需逐项确认。',
        '代码可运行、权重可下载与环境可复现是三件事，要分别确认。',
        '代码开源、权重可下载、系统可运行是三件独立的事：论文提到基线链接可用，仍需核对作者资源。',
        '来源尚未确认，需要分开看待代码开源、权重可下载和系统可运行三件事。',
        '复现时要把代码可用、权重可下载和系统可运行三件事分开。',
        '本文尚未发现经校验可用的代码、模型或数据链接，不得声称已公开。',
        '需要补的验证是公开切分脚本与投票代码，当前并无本文开源状态的确认。',
        '演示链接当前可用但模型权重按伦理声明不开源，这是发布策略而非方法失败。',
        '没有实际验证权重可下载，因此不能写作者资源已公开。',
        '权重与完整系统的可用情况目前尚无法确认，实际使用前需查证。',
        '关于资源需要分开说三件事：代码开源、当前可达和未来提供是不同状态。',
        '本文模型权重需从原模型社区按各自许可获取，系统需按接口组装。',
        '基线已发布检查点的评测作为校准参照，不作为本文的训练基线。',
        '论文称模型权重已公开，但本次检查显示相关链接当前不可达。',
        '只能说明第三方链接本次可达，不能据此宣告模型权重已公开。',
        '权重方面，本篇没有神经网络训练，不涉及权重公开确认，尚无法确认权重事项。',
        '需要区分代码开源、模型权重可下载和端到端系统可运行。',
        '不能把本文代码可用等同于模型权重完整可用。'
    ]) assert.doesNotThrow(() => parseWithClaim(f, text), text);
    assert.throws(() => parseWithClaim(f,
        '代码开源、权重可下载、系统可运行是三件不同的事；本文模型权重已经公开。'),
    error => error.code === 'READER_RESOURCE_AVAILABILITY_CLAIM');
});

test('第三方公开基准、开源依赖与代码切换术语不冒充作者资源；第三方可达不授予本文权重发布声明', () => {
    const f = example();
    for (const text of [
        '相关基线在公开数据集上评测，这只描述实验输入，不表示本文发布了数据集。',
        '第三方代码仓库当前可用，但这不代表本文完整系统可以运行。',
        '本文采用外部预训练模型，通过公开权重加载其基础表示。',
        '本文研究代码切换语音，评测结果表明协议在现实噪声下当前可用。'
    ]) assert.doesNotThrow(() => parseWithClaim(f, text), text);
    assert.throws(() => parseWithClaim(f,
        '第三方仓库当前可用，本文模型权重现已公开并可下载。'),
    error => error.code === 'READER_RESOURCE_AVAILABILITY_CLAIM');
});

test('同类型一个可达链接不能替代另一不可达链接；引文与状态自签哈希也必须对应真实来源', () => {
    const f = example();
    const text = '本文模型权重地址 https://huggingface.co/example/own-model 当前可用。';
    assert.throws(() => parseWithClaim(f, text), /可达状态为 unavailable/);
    for (const mutate of [
        value => { value.sourceTextSha256 = 'a'.repeat(64); },
        value => { value.resources[0].sourceQuote = 'Invented own code is available at https://github.com/example/own-code.';
            value.resources[0].sourceQuoteSha256 = sha(value.resources[0].sourceQuote); },
        value => { value.resources[1].availability = 'available'; },
        value => { value.resources[2].status = 404; }
    ]) {
        const { identitySha256: _previous, ...body } = structuredClone(f.identity);
        mutate(body);
        const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
        assert.throws(() => deep.parseApiReaderArticleResult(JSON.stringify(f.draft),
            { ...f.options, verifiedResourceIdentity: identity }),
        error => error.code === 'READER_RESOURCE_IDENTITY_INVALID');
    }
});

test('当前来源装配文章与未装配 draft 使用同一资源语义检查，旧会议导出保持完全同一实现', () => {
    const f = example();
    const parsed = parseWithClaim(f, '原文称模型权重已公开，但本次链接返回 HTTP 404，当前不可用。');
    const draft = deep.readerResourceClaimDraftFromArticle(parsed.plan, parsed.article);
    assert.deepEqual(deep.readerResourceClaimIssues(draft, f.identity, f.options.sourceText), []);
    assert.equal(deep.readerResourceClaimIssues, deep.conferenceReaderResourceClaimIssues);
    assert.equal(deep.enforceReaderResourceClaims, deep.enforceConferenceReaderResourceClaims);
    draft.sections[10].body += '\n\n本文模型权重现已公开。';
    assert.throws(() => deep.enforceReaderResourceClaims(draft, f.identity, f.options.sourceText),
        error => error.code === 'READER_RESOURCE_AVAILABILITY_CLAIM');
    assert.throws(() => deep.readerResourceClaimDraftFromArticle(parsed.plan,
        parsed.article.replace(/^### [^\n]+/m, '### 不属于正式计划的标题')), /逐节对应/);
});

test('普通生成发现资源错误后走现有精确局部补丁，保留已付费尝试与其他节点', async t => {
    const f = example();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'daily-reader-resource-claims-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const draft = structuredClone(f.draft);
    draft.sections[10].body += '\n\n本文模型权重现已公开并可下载。';
    let calls = 0;
    const result = await deep.generateApiReaderArticleDetailed({ ...f.paper, apiReaderResources: f.identity },
        '', f.options.sourceText, { sourceText: f.options.sourceText,
            structuredArtifacts: f.sourceDetails.structuredArtifacts, readerAttemptsDir: directory,
            readerMaxAttempts: 2, readerMaterializeFigures: async () => [], readerRecordDisposition: () => {},
            readerCallModel: async (messages, _budget, options) => {
                if (++calls === 1) return JSON.stringify(draft);
                assert.equal(options.usageContext.stage, 'apiReaderRepair');
                const prompt = messages[0].content[0].text;
                const request = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"draftSha256":')));
                assert.deepEqual(request.targets.map(target => target.path), ['/sections/10/body']);
                return JSON.stringify({ version: 1, draftSha256: request.draftSha256,
                    replacements: request.targets.map(target => ({ path: target.path, oldSha256: target.oldSha256,
                        value: target.value.replace('本文模型权重现已公开并可下载。',
                            '原文称模型权重已公开，但本次链接返回 HTTP 404，当前不可用。') })) });
            }
        });
    assert.equal(calls, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.fullAttempts, 1);
    assert.deepEqual(result.plan.tableBindings,
        deep.parseApiReaderArticleResult(JSON.stringify(f.draft), f.options).plan.tableBindings);
    assert.match(result.article, /当前不可用/);
    assert.doesNotMatch(result.article, /本文模型权重现已公开并可下载/);
    assert.deepEqual(repair.buildRepairTargets(draft,
        deep.readerResourceClaimIssues(draft, f.identity, f.options.sourceText)).map(target => target.path),
    ['/sections/10/body']);
});

test('旧未声明语义版本的记录保持原协议只读，新声明缺少真实来源或只写一侧版本则不能获得新证明', () => {
    const f = fixture({ noFigures: true });
    const engine = require('../scripts/analysis-engine');
    f.paper.apiReaderArticle += '\n\n本文模型权重现已公开并可下载。';
    sign(f.paper);
    const before = JSON.stringify(f.paper);
    assert.equal(engine.hasValidApiReaderV3Records(f.paper), true, '旧协议结构完整性不是当前出版资源证明');
    assert.throws(() => deep.enforceReaderResourceClaims(
        deep.readerResourceClaimDraftFromArticle(f.paper.apiReaderPlan, f.paper.apiReaderArticle),
        f.paper.apiReaderResources, f.sourceDetails.text),
    error => error.code === 'READER_RESOURCE_AVAILABILITY_CLAIM');
    assert.equal(JSON.stringify(f.paper), before);
    for (const [manifestVersion, stageVersion] of [
        [deep.API_READER_RESOURCE_CLAIMS_CONTRACT, undefined],
        [undefined, deep.API_READER_RESOURCE_CLAIMS_CONTRACT],
        [deep.API_READER_RESOURCE_CLAIMS_CONTRACT, deep.API_READER_RESOURCE_CLAIMS_CONTRACT],
        ['unknown-resource-claims', 'unknown-resource-claims']
    ]) {
        const paper = structuredClone(f.paper);
        if (manifestVersion) paper.analysisManifest.contracts.readerResourceClaims = manifestVersion;
        if (stageVersion) paper.analysisManifest.stages.apiReaderArticle.readerResourceClaimsContractVersion = stageVersion;
        assert.equal(engine.hasValidApiReaderV3Records(paper), false);
    }
});

test('真实私有 FD 出版 worker 与普通 Reader parser 共用严格规则，缺版本不能绕过当前出版且拒绝Source SHA不符', t => {
    const f = example();
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reader-resource-worker-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'input.json');
    const run = (paper, sourceText) => {
        fs.writeFileSync(file, JSON.stringify({ paper, sourceText }), { mode: 0o600 });
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
            const child = spawnSync(process.execPath,
                [path.resolve(__dirname, '../scripts/lib/reader-resource-claims-replay-cli.js'), '3'], {
                    cwd: path.resolve(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe', fd],
                    encoding: 'utf8', timeout: 10000
                });
            assert.equal(child.signal, null, child.stderr);
            return { status: child.status, value: JSON.parse(child.stdout) };
        } finally { fs.closeSync(fd); }
    };
    const paper = { ...f.paper, apiReaderResources: f.identity };
    assert.deepEqual(run(paper, f.options.sourceText), { status: 0, value: { verified: true } });
    const wrongClaim = structuredClone(paper);
    wrongClaim.apiReaderArticle += '\n\n本文模型权重现已公开并可下载。';
    const rejected = run(wrongClaim, f.options.sourceText);
    assert.equal(rejected.status, 1);
    assert.equal(rejected.value.code, 'READER_RESOURCE_AVAILABILITY_CLAIM');
    assert.ok(rejected.value.issues.length > 0);
    const wrongSource = run(paper, f.options.sourceText + '\nChanged source bytes.');
    assert.equal(wrongSource.status, 1);
    assert.equal(wrongSource.value.verified, false);
    assert.match(wrongSource.value.message, /authenticated source bytes/);
});


test('前置定语资源概念列表仅豁免列表自身，不掩盖独立公开与双重否定声明', () => {
    const f = example();
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(f.options.sourceText), resources: [] };
    const identity = { ...body, identitySha256: deep.stableFingerprint(body) };
    const issues = text => deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] },
        identity, f.options.sourceText);
    const list = '开源代码、可下载权重与可运行系统是三件事，需要分别确认';
    for (const text of [
        '作者在文中给出代码链接，经本次核验该第三方镜像链接当前可达，但这只证明链接可打开，不证明权重已公开或系统可一键运行，' + list + '。',
        list + '。',
        list + '，不能据此认为全部已公开。',
        list + '，三者是否已公开尚无法确认。',
        '开源的代码、可下载的模型权重和可一键运行的系统属于3件独立的事，需要分别确认。',
        '代码开源、权重可下载、系统可运行是三件事，需要分别确认。'
    ]) assert.deepEqual(issues(text), [], text);
    for (const text of [
        '本文权重已经公开，' + list + '。',
        list + '，但本文权重已经公开。',
        '本文提供开源代码、可下载权重与可运行系统，均已公开。',
        '本文开源代码、可下载权重与可运行系统是三件事，全部已公开。',
        '开源代码、可下载权重与可运行系统是三件事，全部已公开。',
        '开源代码、可下载权重与可运行系统是三件事，均由本文提供。',
        '开源代码、可下载权重与可运行系统是三件事，这三项都已由作者公开。',
        '开源代码、可下载权重与可运行系统是三件事，本工作均提供下载。',
        '开源代码、可下载权重与可运行系统是三件事，三者均已发布。',
        '开源代码、可下载权重与可运行系统是三件事，本文全部提供。',
        '开源代码、可下载权重与可运行系统是三件事，这三者已全部公开。',
        '开源代码、可下载权重与可运行系统是三件事，它们均已可用。',
        '这些开源代码、可下载权重与可运行系统是三件事。',
        '我们拥有的开源代码、可下载权重与可运行系统是三件事，需要分别确认。',
        '该论文的开源代码、可下载权重与可运行系统是三件事，需要分别确认。',
        '未发现证据否定本文模型权重已经开源，' + list + '。',
        '不证明权重已公开，但本文权重已经公开。',
        '本文可下载权重已经公开。'
    ]) assert.ok(issues(text).some(issue => /model/.test(issue.message)), text);
});
