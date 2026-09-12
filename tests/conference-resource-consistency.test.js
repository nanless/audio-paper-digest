'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const deep = require('../scripts/deep-analyzer.js');
const { parseAnalysis } = require('../scripts/utils.js');
const context = require('../scripts/lib/conference-analysis-context.js');
const binding = require('../scripts/lib/reader-resource-binding.js');

const sha = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const EXECUTION = '123e4567-e89b-42d3-a456-426614174000';

function weakDetails(paperId, text) {
    const body = {
        version: 1,
        source: 'conference_pdf_weak_text',
        tables: [],
        formulas: [],
        figures: [],
        flattenedTextSha256: sha(text),
        capabilityProfile: 'weak-text-only-v1'
    };
    return {
        text,
        source: 'conference_pdf_text',
        sourceId: paperId,
        imageInfos: [],
        structuredArtifacts: { ...body, payloadSha256: sha(JSON.stringify(body)) },
        conferenceCapabilities: context.WEAK_CONFERENCE_CAPABILITIES
    };
}

const network = status => ({
    validateUrlImpl: async raw => new URL(raw),
    requestImpl: async () => ({ status, headers: { get: () => null } })
});

function auditWithOpenSource(score, reason) {
    const generic = '该维度仅依据已编号的论文证据独立评价，理由完整且不重复其他维度的缺陷。';
    return {
        documentType: '方法研究',
        confidence: '中',
        dimensions: {
            innovation: { score: 1.0, reason: generic },
            technicalRigor: { score: 1.0, reason: generic },
            experimentalSufficiency: { score: 1.0, reason: generic },
            clarity: { score: 0.8, reason: generic },
            impact: { score: 0.8, reason: generic },
            openSource: { score, reason },
            reproducibility: { score: 0.3, reason: generic },
            engineering: { score: 1.0, reason: generic }
        },
        total: 5.9 + score,
        rankBucket: '前50%'
    };
}

test('authenticated weak conference source binds a bare repository token to verified HTTPS and scoring', async () => {
    const paperId = 'conference:uai:2026:conference-paper-id:zhang26a';
    const text = 'We detail each component below. Code\nis available at github.com/ZhanqiZhang66/align.\nReproduction settings follow.';
    const details = weakDetails(paperId, text);
    const paper = { id: paperId, title: 'ALIGN' };
    const analysis = '## 机器摘要\nhas_code: 未说明\nhas_model: 否\nhas_dataset: 否\n\n'
        + '## 开源详情\n- 代码：论文给出 github.com/ZhanqiZhang66/align。';
    const identity = await context.withConferenceAnalysisSource({
        executionId: EXECUTION,
        executionDir: '/tmp/conference-resource-consistency',
        paperId,
        sourceDetails: details
    }, () => deep.buildApiReaderResourceIdentity(analysis, text, {}, {
        paper,
        structuredArtifacts: details.structuredArtifacts,
        ...network(200)
    }));

    assert.equal(identity.resources.length, 1);
    assert.equal(identity.resources[0].type, 'code');
    assert.equal(identity.resources[0].originalUrl, 'https://github.com/ZhanqiZhang66/align');
    assert.equal(identity.resources[0].sourceUrlToken, 'github.com/ZhanqiZhang66/align');
    assert.equal(identity.resources[0].sourceUrlBindingContract,
        binding.SOURCE_URL_NORMALIZATION_CONTRACT);
    assert.equal(binding.paperSourceQuoteBindsOriginalUrl(identity.resources[0]), true);

    const synchronized = deep.applyApiReaderResourceAvailability(analysis, identity);
    assert.match(synchronized, /^has_code: 是$/m);
    assert.match(synchronized,
        /^- 代码：<https:\/\/github\.com\/ZhanqiZhang66\/align>（已验证可访问，HTTP 200）$/m);
    assert.doesNotMatch(synchronized, /代码：[^\n]*未提及/);
    assert.match(parseAnalysis(synchronized).opensource,
        /代码：<https:\/\/github\.com\/ZhanqiZhang66\/align>（已验证可访问，HTTP 200）/);
    const normalizedAudit = deep.validateScoringAuditAgainstAnalysis(
        synchronized,
        auditWithOpenSource(0, '[A_OPEN] 论文未发布核心代码，也没有任何公开资源。'),
        identity
    );
    assert.equal(normalizedAudit.dimensions.openSource.score, 1.0);
    assert.match(normalizedAudit.dimensions.openSource.reason, /HTTPS 可达性验证确认代码可用/);
    const contradictoryReason = deep.validateScoringAuditAgainstAnalysis(
        synchronized,
        auditWithOpenSource(1.2, '[A_OPEN] 论文当前尚未发布核心代码，但文档结构较完整。'),
        identity
    );
    assert.equal(contradictoryReason.dimensions.openSource.score, 1.2);
    assert.doesNotMatch(contradictoryReason.dimensions.openSource.reason, /尚未发布/);
});

test('weak-source extraction remains conference-authenticated and ambiguous references do not become code', async () => {
    const paperId = 'conference:uai:2026:conference-paper-id:reference26a';
    const text = 'Related work can be found at github.com/example/reference-project.';
    const details = weakDetails(paperId, text);
    const paper = { id: paperId, title: 'Reference only' };
    let dailyRequests = 0;
    const daily = await deep.buildApiReaderResourceIdentity('', text, {}, {
        paper,
        structuredArtifacts: details.structuredArtifacts,
        validateUrlImpl: async raw => new URL(raw),
        requestImpl: async () => { dailyRequests += 1; return { status: 200, headers: { get: () => null } }; }
    });
    assert.deepEqual(daily.resources, []);
    assert.equal(dailyRequests, 0);

    const conferenceIdentity = await context.withConferenceAnalysisSource({
        executionId: EXECUTION,
        executionDir: '/tmp/conference-resource-reference',
        paperId,
        sourceDetails: details
    }, () => deep.buildApiReaderResourceIdentity('', text, {}, {
        paper,
        structuredArtifacts: details.structuredArtifacts,
        ...network(200)
    }));
    assert.equal(conferenceIdentity.resources[0].type, 'third_party');
    assert.doesNotMatch(
        deep.applyApiReaderResourceAvailability('## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未说明。', conferenceIdentity),
        /^has_code: 是$/m
    );
});

test('weak conference extraction reuses multi-facet and safe line-wrap repository binding', () => {
    const source = 'Code and dataset are available at huggingface.co/example/\nshared-assets.';
    const candidates = deep.extractWeakConferenceSourceResourceCandidates(source);
    assert.deepEqual(candidates, binding.extractPaperSourceRepositoryCandidates(source));
    assert.deepEqual(candidates.map(candidate => candidate.type), ['code', 'dataset']);
    assert.deepEqual([...new Set(candidates.map(candidate => candidate.url))],
        ['https://huggingface.co/example/shared-assets']);
    assert.ok(candidates.every(candidate => candidate.sourceToken
        === 'huggingface.co/example/\nshared-assets'));

    const colonWrapped = 'Code is available at https:\n//github.com/Helixometry/SIGNAL.git.';
    const wrappedCandidates = deep.extractWeakConferenceSourceResourceCandidates(colonWrapped);
    assert.equal(wrappedCandidates.length, 1);
    assert.equal(wrappedCandidates[0].type, 'code');
    assert.equal(wrappedCandidates[0].url, 'https://github.com/Helixometry/SIGNAL.git');
    assert.equal(wrappedCandidates[0].sourceToken,
        'https:\n//github.com/Helixometry/SIGNAL.git');
    const genericResources = deep.extractWeakConferenceSourceResourceCandidates(
        'Resources for this study are available at https:\n//github.com/Helixometry/SIGNAL.git.'
    );
    assert.equal(genericResources.length, 1);
    assert.equal(genericResources[0].type, 'reproduction');
    assert.equal(genericResources[0].url, 'https://github.com/Helixometry/SIGNAL.git');

    const footnoteJoined = deep.extractWeakConferenceSourceResourceCandidates(
        '1Code and dataset are available at:https://github.com/\nyophis/partial-yarn.'
    );
    assert.deepEqual(footnoteJoined.map(candidate => candidate.type), ['code', 'dataset']);
    assert.ok(footnoteJoined.every(candidate => candidate.url
        === 'https://github.com/yophis/partial-yarn'));

    const hyphenWrappedBenchmark = deep.extractWeakConferenceSourceResourceCandidates(
        'LISTEN benchmark is avail-\nable at: https://huggingface.co/datasets/\n'
        + 'VibeCheck1/LISTEN_full. Code is available at https://github.com/example/listen.'
    );
    assert.deepEqual(hyphenWrappedBenchmark.map(candidate => candidate.type), ['dataset', 'code']);
    assert.deepEqual(hyphenWrappedBenchmark.map(candidate => candidate.url), [
        'https://huggingface.co/datasets/VibeCheck1/LISTEN_full',
        'https://github.com/example/listen'
    ]);

    assert.deepEqual(deep.extractWeakConferenceSourceResourceCandidates(
        'Related work uses 1CodeBERT from https:\n//github.com/example/codebert.'
    ), []);
    assert.deepEqual(deep.extractWeakConferenceSourceResourceCandidates(
        'Resources for Foo are available at https:\n//github.com/example/foo.'
    ), []);
});

test('shared repository retains code and checkpoint facets and binds a comma status tail', async () => {
    const paperId = 'conference:eacl:2026:conference-paper-id:2026.eacl-long.149';
    const text = 'The code and checkpoints are available at https://github.com/audiosae/audiosae_demo.';
    const details = weakDetails(paperId, text);
    let requests = 0;
    const identity = await context.withConferenceAnalysisSource({
        executionId: EXECUTION,
        executionDir: '/tmp/conference-resource-multi-facet',
        paperId,
        sourceDetails: details
    }, () => deep.buildApiReaderResourceIdentity('', text, {}, {
        paper: { id: paperId, title: 'AudioSAE' },
        structuredArtifacts: details.structuredArtifacts,
        validateUrlImpl: async raw => new URL(raw),
        requestImpl: async () => {
            requests += 1;
            return { status: 200, headers: { get: () => null } };
        }
    }));
    assert.deepEqual(identity.resources.map(resource => resource.type), ['code', 'model']);
    assert.ok(identity.resources.every(resource => resource.originalUrl
        === 'https://github.com/audiosae/audiosae_demo'));
    assert.equal(requests, 1);

    const draft = {
        readerTitle: '共享仓库 facet 测试',
        oneSentenceThesis: '本文只核对资源声明的逐类型证据。',
        sections: [{ kind: 'background', body:
            '代码层面，论文声明代码与检查点在公开仓库，当前可用；复现时仍需核对许可。' }],
        conceptBridges: []
    };
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(draft, identity, text)
    );
    const codeOnlyBody = {
        contract: identity.contract,
        sourceTextSha256: identity.sourceTextSha256,
        resources: identity.resources.filter(resource => resource.type === 'code')
    };
    const codeOnly = { ...codeOnlyBody, identitySha256: deep.stableFingerprint(codeOnlyBody) };
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(draft, codeOnly, text),
        /本文 model 已开源或当前可用/
    );
});

test('Reader receives verified unavailable status and cannot treat a source URL as currently public', async () => {
    const paperId = 'conference:uai:2026:conference-paper-id:unavailable26a';
    const text = 'Code is available at github.com/example/unavailable-project.';
    const details = weakDetails(paperId, text);
    const paper = { id: paperId, title: 'Unavailable resource' };
    const identity = await context.withConferenceAnalysisSource({
        executionId: EXECUTION,
        executionDir: '/tmp/conference-resource-unavailable',
        paperId,
        sourceDetails: details
    }, () => deep.buildApiReaderResourceIdentity('', text, {}, {
        paper,
        structuredArtifacts: details.structuredArtifacts,
        ...network(404)
    }));
    const evidence = deep.buildApiReaderEvidenceContext(
        '', text, details.structuredArtifacts, paperId,
        context.WEAK_READER_CAPABILITY_POLICY, identity
    );
    assert.match(evidence, /availability=unavailable; status=404/);
    assert.match(evidence, /available 才可写“当前可用\/已公开”/);
    assert.match(evidence, /unavailable 必须写链接当前不可用/);

    const conflictingDraft = {
        readerTitle: '不可达资源声明测试',
        oneSentenceThesis: '本文仅讨论方法和实验，不在摘要中作资源可达性判断。',
        sections: [{ kind: 'reproduction', body:
            '本文代码已开源并可下载，仓库地址为 https://github.com/example/unavailable-project。' }],
        conceptBridges: []
    };
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(conflictingDraft, identity, text),
        /verified resource identity 为 unavailable/
    );
    const qualifiedDraft = structuredClone(conflictingDraft);
    qualifiedDraft.sections[0].body = '原文称代码已公开，但本次链接核验返回 HTTP 404，当前不可用。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(qualifiedDraft, identity, text)
    );
    const crossClauseCodeStatusDraft = structuredClone(conflictingDraft);
    crossClauseCodeStatusDraft.sections[0].body =
        '代码方面，原文给出了公开仓库链接 https://github.com/example/unavailable-project，'
        + '但已验证可达资源中该代码类型没有可用记录，本次未能确认其当前可达，不应表述为当前可用或已开源。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(crossClauseCodeStatusDraft, identity, text)
    );
    const noCodeIdentityBody = {
        contract: identity.contract,
        sourceTextSha256: identity.sourceTextSha256,
        resources: identity.resources.filter(resource => resource.type !== 'code')
    };
    const noCodeIdentity = {
        ...noCodeIdentityBody,
        identitySha256: deep.stableFingerprint(noCodeIdentityBody)
    };
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            crossClauseCodeStatusDraft, noCodeIdentity, text
        )
    );
    const explicitDenialDraft = structuredClone(conflictingDraft);
    explicitDenialDraft.sections[0].body = '本文模型权重没有可用记录，不声称模型已开源或当前可用。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(explicitDenialDraft, identity, text)
    );
    const broadExplicitDenialDraft = structuredClone(conflictingDraft);
    broadExplicitDenialDraft.sections[0].body =
        '本文没有公开可用的代码、模型或数据资源可供确认，因此不声称任何资源已公开。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(broadExplicitDenialDraft, identity, text)
    );
    const nonEquivalenceDraft = structuredClone(conflictingDraft);
    nonEquivalenceDraft.sections[0].body =
        '本次解读不把软件描述等同于权重可下载或一键可运行。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(nonEquivalenceDraft, identity, text)
    );
    const typedAbsenceDraft = structuredClone(conflictingDraft);
    typedAbsenceDraft.sections[0].body =
        '已验证资源中没有模型类型的可用记录，因此不声称本文模型已开源或当前可用。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(typedAbsenceDraft, identity, text)
    );
    for (const body of [
        '关于资源可用状态需要如实交代：正文给出代码仓库链接，但本次核验显示该复现链接当前不可用，不能写已公开可下载。',
        '论文声明代码已公开，但本次解读不对其可达性做断言。',
        '论文正文给出代码仓库链接，但本次核验显示该链接当前不可用，无法据此确认代码公开状态。'
    ]) {
        const statusDisclaimerDraft = structuredClone(conflictingDraft);
        statusDisclaimerDraft.sections[0].body = body;
        assert.doesNotThrow(
            () => deep.enforceConferenceReaderResourceClaims(statusDisclaimerDraft, identity, text)
        );
    }
    for (const body of [
        '不能声称本文代码已开源或当前可用。',
        '不应表示本文代码已公开。',
        '不可确认本文代码可下载。',
        '不宜声称本文代码当前可用。',
        '第三方链接当前可用但仅为通用代码托管域名，不能据此声称本文代码权重或系统已公开可运行。',
        '不能把使用开源模型等同于本文代码已开源。',
        '不应将论文的未来承诺视为本文代码当前可用。'
    ]) {
        const modalDenialDraft = structuredClone(conflictingDraft);
        modalDenialDraft.sections[0].body = body;
        assert.doesNotThrow(
            () => deep.enforceConferenceReaderResourceClaims(modalDenialDraft, identity, text)
        );
    }
    for (const body of [
        '复现时必须区分代码开源、模型权重可下载与端到端可运行，这三种条件并不等价。',
        '这里要辨别模型权重可下载、代码仓库公开和端到端可运行的不同层级。'
    ]) {
        const distinctionDraft = structuredClone(conflictingDraft);
        distinctionDraft.sections[0].body = body;
        assert.doesNotThrow(
            () => deep.enforceConferenceReaderResourceClaims(distinctionDraft, identity, text)
        );
    }
    const futureReleaseDraft = structuredClone(conflictingDraft);
    futureReleaseDraft.sections[0].body =
        '论文作者承诺代码未来将开源，但当前未给出可验证仓库。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(futureReleaseDraft, identity, text)
    );
    for (const body of [
        '论文引用的第三方偏好评估代码仓库在本次核对时显示可用，但这只是正文开源声明之外的第三方资源，不能等同于本文全部数据和代码已公开。',
        '本解读的输入是论文正文连续文本，不含可用的表格结构、公式源代码与图像像素。',
        '这篇解读的输入是会议弱文本来源的论文全文连续证据，不包含可用的表格结构、公式代码与图像像素，因此定量结果只能按自然段转述。',
        '若要谈冻结，只能说调用的是已发布权重，原文未给出内部适配器是否更新，这属于具体缺项，不从模型名称推定实现。',
        '凡是涉及代码与数据集可获取性的说法，本文只依据论文正文提到的仓库与数据集链接，不另行断言当前可下载或可运行，因为本次没有对这些链接做可达验证。',
        '资源状态方面，正文开源声明是唯一依据，本次收到的资源信息显示第三方相关仓库当前可用，但论文主仓库的可达性在本次未能确认，复现前应先核实代码与权重是否真正可下载、可运行，再规划多卡预算。',
        '正文提及的两个第三方仓库链接本次均可访问，已验证第三方资源状态为可用，本文自有代码未在已验证资源身份中记为可用，本次不作可用声明。',
        '发声特征样本直接汇聚公开仓库，不做合成叠加，要求先简述再做七分类。',
        '发声特征按公开仓库汇聚并核对五类数量。',
        '是否包含权重与能否一键运行仍需以仓库实际内容为准，不能把代码可用等同于系统可运行。',
        '区分代码开源、权重下载与系统可运行：有评测代码不等于有训练数据，有权重不等于能在你的硬件上流畅运行，实际延迟与输出帧率要单独测量。'
    ]) {
        const realExcerptNonClaimDraft = structuredClone(conflictingDraft);
        realExcerptNonClaimDraft.sections[0].body = body;
        assert.doesNotThrow(
            () => deep.enforceConferenceReaderResourceClaims(
                realExcerptNonClaimDraft, identity, text
            )
        );
    }
    for (const body of [
        '代码仓库在正文声明中给出链接且当前可用。',
        '代码仓库当前可用，但权重、数据许可与运行脚本仍需逐项核对。',
        '论文声明代码已公开，当前可达性仍需进一步核验。'
    ]) {
        const realExcerptClaimDraft = structuredClone(conflictingDraft);
        realExcerptClaimDraft.sections[0].body = body;
        assert.throws(
            () => deep.enforceConferenceReaderResourceClaims(
                realExcerptClaimDraft, identity, text
            ),
            /本文 code 已开源或当前可用/
        );
    }
    const mixedOwnershipDraft = structuredClone(conflictingDraft);
    mixedOwnershipDraft.sections[0].body = '本文代码与第三方模型权重均已公开。';
    const mixedOwnershipIssues = deep.conferenceReaderResourceClaimIssues(
        mixedOwnershipDraft, identity, text
    );
    assert.equal(mixedOwnershipIssues.length, 1);
    assert.match(mixedOwnershipIssues[0].message, /本文 code 已开源或当前可用/);
    const availableDependency = (type, url) => ({
        type,
        origin: 'validated_demo',
        sourceQuote: url,
        sourceQuoteSha256: sha(url),
        originalUrl: url,
        finalUrl: url,
        redirects: [],
        status: 200,
        availability: 'available',
        retryable: false
    });
    const dependencyIdentityBody = {
        contract: identity.contract,
        sourceTextSha256: identity.sourceTextSha256,
        resources: [
            ...identity.resources,
            availableDependency('model', 'https://github.com/example/visual-language-model'),
            availableDependency('third_party', 'https://github.com/example/face-tool')
        ]
    };
    const dependencyIdentity = {
        ...dependencyIdentityBody,
        identitySha256: deep.stableFingerprint(dependencyIdentityBody)
    };
    const codeAvailableIdentityBody = {
        contract: identity.contract,
        sourceTextSha256: identity.sourceTextSha256,
        resources: [
            ...identity.resources,
            availableDependency('code', 'https://github.com/example/available-code')
        ]
    };
    const codeAvailableIdentity = {
        ...codeAvailableIdentityBody,
        identitySha256: deep.stableFingerprint(codeAvailableIdentityBody)
    };
    const negatedCompletenessDraft = structuredClone(conflictingDraft);
    negatedCompletenessDraft.sections[0].body = '原文给出代码链接，本次收到的资源状态显示该代码链接当前可用，'
        + '但仍需以实际克隆与运行为准，不把可访问等同于权重、数据与环境完整可用。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            negatedCompletenessDraft, codeAvailableIdentity, text
        )
    );
    const affirmativeWeightDraft = structuredClone(conflictingDraft);
    affirmativeWeightDraft.sections[0].body = '代码链接当前可用，模型权重当前可用。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(
            affirmativeWeightDraft, codeAvailableIdentity, text
        ),
        /本文 model 已开源或当前可用/
    );
    const dependencyDraft = structuredClone(conflictingDraft);
    dependencyDraft.sections[0].body = '多个人脸与语音预训练权重的托管链接在本次核验中未能确认可达，'
        + '只有视觉语言模型的代码仓库与两个人脸工具仓库确认可用，因此不能默认所有权重可一键下载。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(dependencyDraft, dependencyIdentity, text)
    );
    const namedDependencyDraft = structuredClone(conflictingDraft);
    namedDependencyDraft.sections[0].body =
        'DeepSeek-VL2的仓库链接当前可用，OpenFace工具包链接当前可用，人脸对齐仓库链接当前可用。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(namedDependencyDraft, dependencyIdentity, text)
    );
    const modelDistinctionDraft = structuredClone(conflictingDraft);
    modelDistinctionDraft.sections[0].body =
        '开放权重模型可下载复现，商业模型只能通过接口复现，系统可运行不等于权重可下载，这点在引用时要区分。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(modelDistinctionDraft, dependencyIdentity, text)
    );
    const unavailableModelUrl = 'https://huggingface.co/example/unavailable-model';
    const unavailableModel = {
        type: 'model',
        origin: 'validated_demo',
        sourceQuote: unavailableModelUrl,
        sourceQuoteSha256: sha(unavailableModelUrl),
        originalUrl: unavailableModelUrl,
        finalUrl: unavailableModelUrl,
        redirects: [],
        status: 404,
        availability: 'unavailable',
        retryable: false
    };
    const unavailableModelIdentityBody = {
        contract: identity.contract,
        sourceTextSha256: identity.sourceTextSha256,
        resources: [...identity.resources, unavailableModel]
    };
    const unavailableModelIdentity = {
        ...unavailableModelIdentityBody,
        identitySha256: deep.stableFingerprint(unavailableModelIdentityBody)
    };
    const VoxtralDisclaimerDraft = structuredClone(conflictingDraft);
    VoxtralDisclaimerDraft.sections[0].body =
        '区分三种公开含义，论文提到 Voxtral 权重可下载、正文开源声明与接口可调用是不同事项，'
        + '只有明确给出可达链接才能写已公开，复现前应先确认所用模型接口与权重当前是否可用。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            VoxtralDisclaimerDraft, unavailableModelIdentity, text
        )
    );
    const futureVerificationDraft = structuredClone(conflictingDraft);
    futureVerificationDraft.sections[0].body =
        '若要继续推进，应先补做三项验证，一是公开可运行的代码与环境，'
        + '二是可下载的冻结权重与嵌入缓存，三是阈值在新生成器上的重标定流程，'
        + '并记录硬件预算与推理延迟。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            futureVerificationDraft, identity, text
        )
    );
    const explicitPaperCodeAbsenceDraft = structuredClone(conflictingDraft);
    explicitPaperCodeAbsenceDraft.sections[0].body =
        '代码与权重方面，论文未声明自研代码开源，语言模型可通过本地运行框架获取，'
        + '语音模型链接本次未能确认可达，演讲语料来源本次可确认为可用，'
        + '复现前应先确认权重与数据可达性并记录版本。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            explicitPaperCodeAbsenceDraft, unavailableModelIdentity, text
        )
    );
    const datasetStatusUrl = 'https://github.com/example/dataset-assets';
    const datasetStatusResource = {
        type: 'dataset',
        origin: 'validated_demo',
        sourceQuote: datasetStatusUrl,
        sourceQuoteSha256: sha(datasetStatusUrl),
        originalUrl: datasetStatusUrl,
        finalUrl: datasetStatusUrl,
        redirects: [],
        status: 200,
        availability: 'available',
        retryable: false
    };
    const datasetStatusIdentityBody = {
        contract: identity.contract,
        sourceTextSha256: identity.sourceTextSha256,
        resources: [...identity.resources, datasetStatusResource]
    };
    const datasetStatusIdentity = {
        ...datasetStatusIdentityBody,
        identitySha256: deep.stableFingerprint(datasetStatusIdentityBody)
    };
    const datasetRepositorySummaryDraft = structuredClone(conflictingDraft);
    datasetRepositorySummaryDraft.sections[0].body =
        '资源可达性按本次验证状态交代，ASVspoof2019官网、DECRO在Zenodo的记录、'
        + 'WildDeepfake与FakeAVCeleb的代码仓库本次验证为可用，其余数据集链接本次未能依据验证资源确认为可用，不写已公开。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            datasetRepositorySummaryDraft, datasetStatusIdentity, text
        )
    );
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(dependencyDraft, identity, text),
        /本文 code 已开源或当前可用/
    );
    const selfOwnedDependencyDraft = structuredClone(conflictingDraft);
    selfOwnedDependencyDraft.sections[0].body = '本文视觉语言模型的代码仓库确认可用。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(
            selfOwnedDependencyDraft, dependencyIdentity, text
        ),
        /本文 code 已开源或当前可用/
    );
    const thirdPartyCodeDraft = structuredClone(conflictingDraft);
    thirdPartyCodeDraft.sections[0].body = '资源状态方面，正文开源声明的唯一依据是本次收到的资源标识，'
        + '其中第三方代码链接当前可用，但这只是与文本基准方法相关的仓库，'
        + '不是AudioJudge完整系统可运行的保证，复现前应把代码可用、权重可下载与端到端可运行区分开。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            thirdPartyCodeDraft, dependencyIdentity, text
        )
    );
    const thirdPartyNonPaperDisclaimerDraft = structuredClone(conflictingDraft);
    thirdPartyNonPaperDisclaimerDraft.sections[0].body =
        '资源状态方面，论文正文提到的项目代码在本次阅读中未给出可用链接依据，'
        + '第三方 AlpacaEval 仓库本次可达但只是排名方法的参考实现，不是本论文代码，'
        + '因此复现应以论文文字模板为准，不要假设官方代码已公开。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            thirdPartyNonPaperDisclaimerDraft, dependencyIdentity, text
        )
    );
    for (const body of [
        '受害模型是既有系统，通过应用程序接口或已发布权重以推理方式调用。',
        '关于可用性，论文正文引用的商业模型音频性能页面链接当前不可用，语音适配模型权重页面本次未能确认可达，因此复现时应以论文描述的模型版本名为准，先核对本地可下载的权重与推理代码是否与版本号一致，再补做可达性验证，不把链接可打开等同于结果可复现。',
        '把代码可用误解为模型可用是常见的误读，需要避免。',
        '关于资源状态，本次收到的证据中未发现经验证可用的代码模型或数据链接，因此不能声称代码已公开或可一键运行，复现需按上述描述自行实现。',
        '论文称已公开代码、检查点与三个多语评测集，复现时以实际可达为准，若链接不可用则明确写本次未能确认可达，不把可下载权重等同于系统可运行。',
        '论文给出项目页面地址，但已验证资源身份中没有本文代码的可用记录，因此此处不将其表述为已公开、已开源或当前可用。'
            , '代码方面，原文给出了公开仓库链接，但已验证可达资源中该代码类型没有可用记录，本次未能确认其当前可达，复现前应先自行确认该仓库当前是否可达，不应表述为当前可用或已开源。'
    ]) {
        const qualifiedDraft = structuredClone(conflictingDraft);
        qualifiedDraft.sections[0].body = body;
        assert.doesNotThrow(
            () => deep.enforceConferenceReaderResourceClaims(qualifiedDraft, identity, text)
        );
    }
    const verifiedThirdPartyRepositoryDraft = structuredClone(conflictingDraft);
    verifiedThirdPartyRepositoryDraft.sections[0].body =
        '论文声明将公开人类思维链重标注和TRACE框架，本次收到的资源信息显示代码仓库链接当前可用，但重标注数据的实际下载路径和版本仍需以仓库中的说明为准。';
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(
            verifiedThirdPartyRepositoryDraft, dependencyIdentity, text
        )
    );
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(thirdPartyCodeDraft, identity, text),
        /本文 code 已开源或当前可用/
    );
    const selfOwnedCodeLinkDraft = structuredClone(conflictingDraft);
    selfOwnedCodeLinkDraft.sections[0].body = '本文代码链接当前可用，但这不是AudioJudge完整系统可运行的保证。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(
            selfOwnedCodeLinkDraft, dependencyIdentity, text
        ),
        /本文 code 已开源或当前可用/
    );
    for (const body of [
        '本文基准覆盖代码切换语音，评测结果表明系统在现实噪声下当前可用。',
        '本文评估语码切换条件，并给出当前可用的评测协议。',
        '本文研究代码混合场景，所用语音样本目前已可用。',
        '实验结果可用于研究不同模态的差异。',
        'This paper covers code-switching speech and reports that the protocol is currently available.',
        'This work studies code mixing and provides a publicly available evaluation protocol.'
    ]) {
        const linguisticCodeDraft = structuredClone(conflictingDraft);
        linguisticCodeDraft.sections[0].body = body;
        assert.doesNotThrow(
            () => deep.enforceConferenceReaderResourceClaims(linguisticCodeDraft, identity, text)
        );
    }
    const nearerModelDraft = structuredClone(conflictingDraft);
    nearerModelDraft.sections[0].body =
        '本文代码部分只解释训练流程而不作发布声明并明确说明模型权重现已公开。';
    const nearerModelIssues = deep.conferenceReaderResourceClaimIssues(
        nearerModelDraft, identity, text
    );
    assert.equal(nearerModelIssues.length, 1);
    assert.match(nearerModelIssues[0].message, /本文 model 已开源或当前可用/);
    assert.doesNotMatch(nearerModelIssues[0].message, /本文 code /);

    const coordinatedDraft = structuredClone(conflictingDraft);
    coordinatedDraft.sections[0].body = '本文代码与模型均已公开。';
    const coordinatedIssues = deep.conferenceReaderResourceClaimIssues(
        coordinatedDraft, identity, text
    );
    assert.equal(coordinatedIssues.length, 2);
    assert.deepEqual(
        coordinatedIssues.map(issue => issue.message.match(/本文 (code|model) /)?.[1]),
        ['code', 'model']
    );

    const longConflictDraft = structuredClone(conflictingDraft);
    longConflictDraft.sections[0].body = '本文代码只用于说明实现差异 '
        + '背景 '.repeat(100) + '\n   模型权重现已公开。';
    const longConflictIssues = deep.conferenceReaderResourceClaimIssues(
        longConflictDraft, identity, text
    );
    assert.equal(longConflictIssues.length, 1);
    assert.match(longConflictIssues[0].message, /本文 model 已开源或当前可用/);
    assert.ok(longConflictIssues[0].conflictExcerpt.length <= 240);
    assert.doesNotMatch(longConflictIssues[0].conflictExcerpt, /\s{2,}|[\r\n]/);
    assert.match(longConflictIssues[0].conflictExcerpt, /模型权重现已公开/);
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(longConflictDraft, identity, text),
        error => {
            assert.match(error.message, /conflictExcerpt=/);
            assert.match(error.message, /模型权重现已公开/);
            assert.ok(error.readerIssues[0].conflictExcerpt.length <= 240);
            return true;
        }
    );
    const modelConflictDraft = structuredClone(conflictingDraft);
    modelConflictDraft.sections[0].body = '本文模型权重已开源并可用。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(modelConflictDraft, identity, text),
        /verified resource identity 中该类型没有 available 记录/
    );
    for (const body of [
        '本文代码已开源，但模型权重当前不可用。',
        '模型权重当前不可用，但本文代码已开源。'
    ]) {
        const crossTypeConflictDraft = structuredClone(conflictingDraft);
        crossTypeConflictDraft.sections[0].body = body;
        assert.throws(
            () => deep.enforceConferenceReaderResourceClaims(crossTypeConflictDraft, identity, text),
            /本文 code 已开源或当前可用/
        );
    }
    const doubleNegationDraft = structuredClone(conflictingDraft);
    doubleNegationDraft.sections[0].body = '没有证据否定本文模型权重已经开源。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(doubleNegationDraft, identity, text),
        /本文 model 已开源或当前可用/
    );
    const contrastAfterDenialDraft = structuredClone(conflictingDraft);
    contrastAfterDenialDraft.sections[0].body = '不声称模型权重已开源，但事实上本文模型权重已经开源。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(contrastAfterDenialDraft, identity, text),
        /本文 model 已开源或当前可用/
    );
    const emphasisDraft = structuredClone(conflictingDraft);
    emphasisDraft.sections[0].body = '不但本文模型权重已开源，而且当前可用。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(emphasisDraft, identity, text),
        /本文 model 已开源或当前可用/
    );
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims({
            sections: [{ kind: 'reproduction', body:
                '本文代码已开源，但模型权重当前不可用。' }]
        }, identity, text),
        /本文 code 已开源或当前可用/
    );
    const bareUnavailableSlugDraft = structuredClone(conflictingDraft);
    bareUnavailableSlugDraft.sections[0].body =
        '本文代码已开源，地址 github.com/example/unavailable-project。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(bareUnavailableSlugDraft, identity, text),
        /verified resource identity 为 unavailable/
    );

    const twoCodeText = [
        'Code: https://github.com/example/unavailable-a.',
        'Code: https://github.com/example/unavailable-b.'
    ].join('\n');
    const twoCodeDetails = weakDetails(paperId, twoCodeText);
    const twoCodeIdentity = await context.withConferenceAnalysisSource({
        executionId: EXECUTION,
        executionDir: '/tmp/conference-resource-two-unavailable',
        paperId,
        sourceDetails: twoCodeDetails
    }, () => deep.buildApiReaderResourceIdentity('', twoCodeText, {}, {
        paper,
        structuredArtifacts: twoCodeDetails.structuredArtifacts,
        ...network(404)
    }));
    const crossedLinksDraft = structuredClone(conflictingDraft);
    crossedLinksDraft.sections[0].body = '本文代码仓库 '
        + 'https://github.com/example/unavailable-a 当前可用，但代码仓库 '
        + 'https://github.com/example/unavailable-b 当前不可用。';
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(
            crossedLinksDraft, twoCodeIdentity, twoCodeText
        ),
        /verified resource identity/
    );
    const repeatedTokenDraft = structuredClone(conflictingDraft);
    repeatedTokenDraft.sections[0] = {
        kind: 'background',
        body: 'github.com/example/unavailable-project 当前不可用；稍后访问 '
            + 'github.com/example/unavailable-project 时显示当前可用。'
    };
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(repeatedTokenDraft, identity, text),
        /verified resource identity 为 unavailable/
    );
    for (const [kind, body, type] of [
        ['method_overview', '代码已经开源，可直接下载。', 'code'],
        ['synthesis', '模型权重现已公开。', 'model'],
        ['background', '公开仓库可以直接访问。', 'code'],
        ['method_overview', '与实验相关的代码已经开源。', 'code'],
        ['result', '此前代码未公开但现在已经开源。', 'code'],
        ['method_overview', '代码为开源项目。', 'code'],
        ['result', '模型权重公开。', 'model'],
        ['reproduction', '代码仓库公开。', 'code'],
        ['method_overview', 'The code repository is public.', 'code'],
        ['synthesis', 'This is an open-source code repository.', 'code']
    ]) {
        const implicitSubjectDraft = structuredClone(conflictingDraft);
        implicitSubjectDraft.sections[0] = { kind, body };
        assert.throws(
            () => deep.enforceConferenceReaderResourceClaims(implicitSubjectDraft, identity, text),
            new RegExp(`本文 ${type} 已开源或当前可用`)
        );
    }
    const unavailableAnalysis = deep.applyApiReaderResourceAvailability(
        '## 机器摘要\nhas_code: 是\nhas_model: 否\nhas_dataset: 否\n\n'
            + '## 开源详情\n- 代码：论文中未提及代码链接\n- Demo：论文中未提及',
        identity
    );
    assert.match(unavailableAnalysis,
        /^- 代码：<https:\/\/github\.com\/example\/unavailable-project>（当前不可用，HTTP 404）$/m);
    assert.doesNotMatch(unavailableAnalysis, /代码：[^\n]*未提及/);
    const unrelatedPublicData = structuredClone(conflictingDraft);
    unrelatedPublicData.sections[0] = {
        kind: 'background',
        body: '相关基线在公开数据集上评测，这只描述实验输入，不表示本文发布了数据集。'
    };
    assert.doesNotThrow(
        () => deep.enforceConferenceReaderResourceClaims(unrelatedPublicData, identity, text)
    );

    const forgedTemporary = structuredClone(identity);
    forgedTemporary.resources[0].availability = 'temporarily_unreachable';
    forgedTemporary.resources[0].status = 404;
    forgedTemporary.resources[0].retryable = true;
    const { identitySha256: _discarded, ...forgedBody } = forgedTemporary;
    forgedTemporary.identitySha256 = deep.stableFingerprint(forgedBody);
    assert.throws(
        () => deep.enforceConferenceReaderResourceClaims(qualifiedDraft, forgedTemporary, text),
        /需要可重放的 verified resource identity/
    );
});

test('canonical open-source detail rows project each verified status and preserve unverified rows', async () => {
    const sourceText = [
        'Code: https://github.com/example/code.',
        'Model weights: https://huggingface.co/example/model.',
        'Dataset: https://huggingface.co/datasets/example/data.',
        'Demo: https://example.org/demo.',
        'Reproduction materials: https://example.org/reproduce.'
    ].join('\n');
    const analysis = [
        '## 机器摘要',
        'has_code: 否',
        'has_model: 否',
        'has_dataset: 否',
        '',
        '## 开源详情',
        '- 代码：论文中未提及代码链接',
        '- 模型权重：论文中未提及',
        '- 数据集：论文中未提及',
        '- Demo：论文中未提及',
        '- 复现材料：论文中未提及'
    ].join('\n');
    const statusByPath = new Map([
        ['/example/code', 200],
        ['/example/model', 404],
        ['/datasets/example/data', 503],
        ['/demo', 200],
        ['/reproduce', 425]
    ]);
    const discoveryAnalysis = analysis.replace(
        '- 代码：论文中未提及代码链接\n- 模型权重：论文中未提及\n- 数据集：论文中未提及\n'
            + '- Demo：论文中未提及\n- 复现材料：论文中未提及',
        '- 代码：https://github.com/example/code\n- 模型权重：https://huggingface.co/example/model\n'
            + '- 数据集：https://huggingface.co/datasets/example/data\n- Demo：https://example.org/demo\n'
            + '- 复现材料：https://example.org/reproduce'
    );
    const identity = await deep.buildApiReaderResourceIdentity(discoveryAnalysis, sourceText, {}, {
        validateUrlImpl: async raw => new URL(raw),
        requestImpl: async raw => ({
            status: statusByPath.get(new URL(raw).pathname),
            headers: { get: () => null }
        })
    });
    assert.deepEqual(identity.resources.map(resource => resource.type),
        ['code', 'model', 'dataset', 'demo', 'reproduction']);
    const projected = deep.applyApiReaderResourceAvailability(analysis, identity);
    assert.match(projected, /^has_code: 是$/m);
    assert.match(projected, /^has_model: 否$/m);
    assert.match(projected, /^has_dataset: 否$/m);
    assert.match(projected, /^- 代码：<https:\/\/github\.com\/example\/code>（已验证可访问，HTTP 200）$/m);
    assert.match(projected, /^- 模型权重：<https:\/\/huggingface\.co\/example\/model>（当前不可用，HTTP 404）$/m);
    assert.match(projected, /^- 数据集：<https:\/\/huggingface\.co\/datasets\/example\/data>（本次暂时无法确认可达，HTTP 503）$/m);
    assert.match(projected, /^- Demo：<https:\/\/example\.org\/demo>（已验证可访问，HTTP 200）$/m);
    assert.match(projected, /^- 复现材料：<https:\/\/example\.org\/reproduce>（本次暂时无法确认可达，HTTP 425）$/m);
    assert.doesNotMatch(projected, /(?:许可证|文档|权重已公开|权重可用)/);

    const emptyBody = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: sha(sourceText),
        resources: []
    };
    const empty = { ...emptyBody, identitySha256: deep.stableFingerprint(emptyBody) };
    const unchangedRows = deep.applyApiReaderResourceAvailability(analysis, empty);
    for (const line of analysis.split('\n').filter(line => /^- (?:代码|模型权重|数据集|Demo|复现材料)：/.test(line))) {
        assert.match(unchangedRows, new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    }
    assert.match(unchangedRows, /资源可达性验证：未发现可验证的官方 HTTPS 资源 URL/);
});

test('repository token normalizer rejects credentials, ports, query strings and encoded traversal', () => {
    for (const value of [
        'https://user:pass@github.com/owner/repo',
        'github.com:8443/owner/repo',
        'github.com/owner/repo?token=secret',
        'github.com/owner/%2e%2e/private'
    ]) {
        assert.equal(binding.normalizePaperSourceRepositoryToken(value), null, value);
        assert.deepEqual(deep.extractWeakConferenceSourceResourceCandidates(
            `Code is available at ${value}.`
        ), [], value);
    }
});

test('resource reachability authenticates a large or continuous GET 200 response from headers only', async () => {
    const calls = [];
    const result = await deep.verifyApiReaderResourceUrl('https://github.com/example/large-repository', {
        validateUrlImpl: async raw => new URL(raw),
        requestImpl: async (raw, options) => {
            calls.push({ raw, ...options });
            if (options.responseBodyMode !== 'headers_only') {
                const error = new Error('large successful HTML body exceeded the old 256 KiB limit');
                error.code = 'RESPONSE_TOO_LARGE';
                throw error;
            }
            return { status: 200, headers: { get: () => null }, continuousBody: true };
        }
    });
    assert.equal(result.availability, 'available');
    assert.equal(result.status, 200);
    assert.deepEqual(calls.map(item => item.method), ['GET']);
    assert.equal(Object.hasOwn(calls[0], 'maxBytes'), false);
});

test('resource reachability uses one headers-only GET per hop and revalidates a redirect target', async () => {
    const calls = [];
    const validations = [];
    const result = await deep.verifyApiReaderResourceUrl('https://github.com/example/repository', {
        validateUrlImpl: async raw => {
            validations.push(raw);
            return new URL(raw);
        },
        requestImpl: async (raw, options) => {
            calls.push({ raw, method: options.method, mode: options.responseBodyMode });
            assert.equal(options.responseBodyMode, 'headers_only');
            if (raw.endsWith('/repository')) {
                return { status: 302, headers: { get: name => name === 'location' ? '/example/repository/' : null } };
            }
            return { status: 200, headers: { get: () => null } };
        }
    });
    assert.equal(result.availability, 'available');
    assert.equal(result.finalUrl, 'https://github.com/example/repository/');
    assert.deepEqual(validations, [
        'https://github.com/example/repository',
        'https://github.com/example/repository/'
    ]);
    assert.deepEqual(calls, [
        { raw: 'https://github.com/example/repository', method: 'GET', mode: 'headers_only' },
        { raw: 'https://github.com/example/repository/', method: 'GET', mode: 'headers_only' }
    ]);
    assert.deepEqual(result.redirects, [{
        from: 'https://github.com/example/repository',
        to: 'https://github.com/example/repository/',
        status: 302
    }]);
});

test('resource reachability classifies GET terminal statuses without reading response bodies', async () => {
    const verifyStatus = status => deep.verifyApiReaderResourceUrl('https://github.com/example/repository', {
        validateUrlImpl: async raw => new URL(raw),
        requestImpl: async (_raw, options) => {
            assert.equal(options.method, 'GET');
            assert.equal(options.responseBodyMode, 'headers_only');
            return { status, headers: { get: () => null } };
        }
    });
    assert.equal((await verifyStatus(404)).availability, 'unavailable');
    for (const status of [408, 425, 429, 500, 503]) {
        const result = await verifyStatus(status);
        assert.equal(result.availability, 'temporarily_unreachable', String(status));
        assert.equal(result.retryable, true, String(status));
    }
});

test('resource reachability hard-fails a redirect whose next hop resolves to private space', async () => {
    let requests = 0;
    await assert.rejects(deep.verifyApiReaderResourceUrl('https://github.com/example/repository', {
        validateUrlImpl: async raw => {
            if (raw === 'https://127.0.0.1/private') throw new Error('URL 指向非公网 IP: 127.0.0.1');
            return new URL(raw);
        },
        requestImpl: async () => {
            requests += 1;
            return { status: 302, headers: { get: name => name === 'location' ? 'https://127.0.0.1/private' : null } };
        }
    }), /非公网 IP/);
    assert.equal(requests, 1);
});

function fakePinnedRequest(response) {
    const request = new EventEmitter();
    request.destroyed = false;
    request.setTimeout = () => {};
    request.destroy = error => {
        request.destroyed = true;
        if (error) queueMicrotask(() => request.emit('error', error));
    };
    request.end = () => queueMicrotask(() => response.callback(response.stream));
    return request;
}

function pinnedDependencies(stream, state) {
    return {
        validateUrlImpl: async raw => Object.assign(new URL(raw), {
            validatedAddress: '8.8.8.8', validatedHostname: '8.8.8.8'
        }),
        detectProxyImpl: () => 'http://127.0.0.1:7897',
        createAgentImpl: () => ({ destroy: () => { state.agentDestroyed = true; } }),
        requestImpl: (_options, callback) => {
            state.method = _options.method;
            const request = fakePinnedRequest({ stream, callback });
            state.request = request;
            return request;
        }
    };
}

test('headers-only pinned response settles after cancellation and exposes no fake empty body', async () => {
    const state = {};
    const stream = new Readable({ read() {} });
    stream.statusCode = 200;
    stream.headers = { 'content-length': String(1024 * 1024 * 1024) };
    const result = await deep.requestPinnedPublicHttps('https://8.8.8.8/repository', {
        method: 'GET', responseBodyMode: 'headers_only', timeoutMs: 1000
    }, pinnedDependencies(stream, state));
    assert.equal(result.status, 200);
    assert.equal(state.method, 'GET');
    assert.equal(stream.destroyed, true);
    assert.equal(state.request.destroyed, true);
    assert.equal(state.agentDestroyed, true);
    await assert.rejects(result.arrayBuffer(), error => error.code === 'RESPONSE_BODY_NOT_AVAILABLE');
    stream.emit('error', new Error('late response error after cancellation'));
    state.request.emit('error', new Error('late request error after cancellation'));
});

test('default pinned buffer mode retains RESPONSE_TOO_LARGE protection', async () => {
    const state = {};
    const stream = Readable.from([Buffer.alloc(4), Buffer.alloc(4)]);
    stream.statusCode = 200;
    stream.headers = {};
    await assert.rejects(deep.requestPinnedPublicHttps('https://8.8.8.8/repository', {
        maxBytes: 5, timeoutMs: 1000
    }, pinnedDependencies(stream, state)), error => error.code === 'RESPONSE_TOO_LARGE');
    assert.equal(state.method, 'GET');
    assert.equal(state.agentDestroyed, true);
});

test('conference Reader resource gate distinguishes explicit denials, dataset repositories and third-party tools', () => {
    const sourceText = '';
    const available = (type, url) => ({
        type,
        origin: 'validated_demo',
        sourceQuote: url,
        sourceQuoteSha256: sha(url),
        originalUrl: url,
        finalUrl: url,
        redirects: [],
        status: 200,
        availability: 'available',
        retryable: false
    });
    const identityFor = resources => {
        const body = {
            contract: 'api-reader-resource-identity-v1',
            sourceTextSha256: sha(sourceText),
            resources
        };
        return { ...body, identitySha256: deep.stableFingerprint(body) };
    };
    const denialIdentity = identityFor([]);
    for (const body of [
        '资源状态方面，没有完成可用性验证的代码模型数据链接，因此不能写代码模型数据已公开。',
        '资源状态方面，论文正文给出了代码仓库地址，但本次阅读未能确认其可达性，因此不得声称代码、模型或数据已公开可用。',
        '资源状态方面，本次没有发现完成验证的可用资源，因此不得声称代码模型或数据已公开。'
    ]) {
        assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims(
            { sections: [{ kind: 'reproduction', body }] }, denialIdentity, sourceText
        ));
    }

    const datasetIdentity = identityFor([
        available('dataset', 'https://example.org/dataset')
    ]);
    assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims({
        sections: [{ kind: 'reproduction', body:
            '资源可达性方面，语音欺骗数据库官网、多语言数据集记录页、野外伪造仓库与音视频名人仓库当前可用。' }]
    }, datasetIdentity, sourceText));

    const thirdPartyIdentity = identityFor([
        available('third_party', 'https://example.org/third-party-tool')
    ]);
    assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims({
        sections: [{ kind: 'reproduction', body:
            '第三方语音识别加对齐工具的代码仓库链接本次确认可用，但并非本文自有代码，本文自有代码本次不作可用声明。' }]
    }, thirdPartyIdentity, sourceText));

    const establishedDatasetIdentity = identityFor([
        available('dataset', 'https://example.org/established-dataset')
    ]);
    assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims({
        sections: [{ kind: 'reproduction', body:
            '实验沿用已有的 Common Voice 与 NCHLT 语音数据集；本次核验只确认这些公开数据集记录页可达。' }]
    }, establishedDatasetIdentity, sourceText));

    const baselineModelIdentity = identityFor([
        available('model', 'https://example.org/public-baseline')
    ]);
    assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims({
        sections: [{ kind: 'reproduction', body:
            '本研究未训练被评测的多模态大模型，公开权重基线与闭源接口均直接调用；这不等于本文模型已开源。' }]
    }, baselineModelIdentity, sourceText));

    const fabricatedCodeIdentity = identityFor([]);
    assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims({
        sections: [{ kind: 'reproduction', body:
            '原文提到欺骗语音评测集官网、野外伪造代码仓库与名人音视频仓库，但其中“伪造代码仓库”不是本文发布的代码资源。' }]
    }, fabricatedCodeIdentity, sourceText));

    assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims({
        sections: [{ kind: 'reproduction', body:
            '关于资源可达性，本次收到的官方验证显示所列的 ASVspoof 官方页、DECRO 存档页、WildDeepfake 代码页与 FakeAVCeleb 代码页当前可用，状态码为二百，可以作为复现起点。' }]
    }, datasetIdentity, sourceText));

    assert.doesNotThrow(() => deep.enforceConferenceReaderResourceClaims({
        sections: [{ kind: 'reproduction', body:
            '第一类是数据与模型访问：三个公开基准的对应版本、两个闭源音频模型的接口权限与默认配置、开源音频模型的权重与生成参数、语音合成模型的可用版本。' }]
    }, datasetIdentity, sourceText));
});

test('multi-pass scoring consensus remains replayable after a noisy second audit', () => {
    const hash = 'a'.repeat(64);
    const stage = {
        stabilityWarning: true,
        stabilityResolution: {
            contract: deep.SCORING_STABILITY_RESOLUTION_CONTRACT,
            status: 'resolved',
            method: 'multi_pass_consensus',
            scoreDifference: 0.2,
            secondAuditSha256: hash
        }
    };
    assert.equal(deep.scoringStabilityResolutionIsValid(stage), true);
    stage.stabilityResolution.scoreDifference = 0.4;
    assert.equal(deep.scoringStabilityResolutionIsValid(stage), false);
});
