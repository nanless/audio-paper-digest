'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const binding = require('../scripts/lib/reader-resource-binding');
const probe = require('../scripts/lib/public-resource-probe');
const scoring = require('../scripts/lib/scoring-audit-contract');
const deep = require('../scripts/deep-analyzer');

const sha = value => crypto.createHash('sha256').update(String(value || '')).digest('hex');

function makeAudit(overrides = {}) {
    const dimensions = Object.fromEntries([
        ['innovation', 1.4], ['technicalRigor', 1.4], ['experimentalSufficiency', 1.5],
        ['clarity', 0.9], ['impact', 1.3], ['openSource', 0.5],
        ['reproducibility', 0.4], ['engineering', 1.4]
    ].map(([key, score]) => [key, {
        score: overrides[key] ?? score,
        reason: '[A_METHOD] 本项依据对应证据和实验结果给出评价，不重复跨维度扣分。'
    }]));
    const header = {
        contract: 'scoring-evidence-profile',
        schemaFingerprint: 'cd86b88de878f041f2dab1c8153fdac9e98272cc1ff3ba90161a79f1349e6d9f'
    };
    return scoring.parseScoringAuditResult(JSON.stringify({
        documentType: overrides.documentType || '模型报告',
        confidence: '高',
        evidenceProfile: {
            ...header,
            multiComponentClaimed: overrides.multiComponentClaimed ?? true,
            ablationStatus: overrides.ablationStatus ?? 'partial',
            targetEvaluation: overrides.targetEvaluation ?? 'public',
            sampleScaleReported: true,
            deploymentMeasured: false,
            publicGeneralizationEvaluated: overrides.publicGeneralizationEvaluated ?? true,
            engineeringEvidence: 'reusable_pipeline',
            evidenceBoundary: '[A_METHOD] 主结论基于公开多基准评测与部分组件消融，未包含延迟实测。',
            evidenceIds: ['A_METHOD']
        },
        dimensions
    }), new Set(['A_METHOD', 'A_OPEN']));
}

test('Wave 8: 2611.26409 WeMM-Video 紧随公开发布句的独立 URL 块识别 code 与 model 且可完整重放', async () => {
    const source = [
        'WeMM-Video outperforms larger open-source Qwen3-Omni-30B-A3B-Instruct. We publicly release the WeMM-Video family along with our evaluation and reproduction pipeline to foster further research and development in the open-source community.',
        'https://huggingface.co/collections/tencent/wemm-video',
        'https://github.com/Tencent/WeMM-Video',
        'Figure 1: WeMM-Video perceives omni-modal inputs.'
    ].join('\n');
    const hfUrl = 'https://huggingface.co/collections/tencent/wemm-video';
    const ghUrl = 'https://github.com/Tencent/WeMM-Video';
    assert.deepEqual(binding.paperSourceResourceFacets(source, hfUrl), ['model']);
    assert.deepEqual(binding.paperSourceResourceFacets(source, ghUrl), ['code']);

    const readme = '# WeMM-Video\n## Installation\npip install -r requirements.txt\n## Evaluation\npython eval.py\n## Training\ntorchrun train.py\n';
    const analysis = [
        '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否',
        '## 开源详情',
        `- 代码：${ghUrl}`,
        `- 模型权重：${hfUrl}`
    ].join('\n');
    const identity = await probe.buildApiReaderResourceIdentity(
        analysis,
        source,
        { discoveredLinks: [ghUrl, hfUrl] },
        {
            paper: { sources: ['arxiv', 'huggingface'], hf_github_repo: ghUrl },
            validateUrlImpl: async raw => new URL(raw),
            requestImpl: async raw => ({
                status: 200,
                headers: { get: name => (name.toLowerCase() === 'content-type' ? 'text/plain; charset=utf-8' : null) },
                arrayBuffer: async () => Buffer.from(raw.includes('README.md') ? readme : 'ok')
            })
        }
    );
    const codeRes = identity.resources.find(r => r.originalUrl === ghUrl);
    const modelRes = identity.resources.find(r => r.originalUrl === hfUrl);
    assert.equal(codeRes?.type, 'code');
    assert.equal(codeRes?.origin, 'paper_source');
    assert.equal(codeRes?.documentationEvidence?.completeness, 'complete');
    assert.equal(binding.paperSourceQuoteBindsOriginalUrl(codeRes), true);
    assert.equal(modelRes?.type, 'model');
    assert.equal(modelRes?.origin, 'paper_source');
    assert.equal(binding.paperSourceQuoteBindsOriginalUrl(modelRes), true);

    const audit = makeAudit({ openSource: 0.5 });
    const validated = scoring.validateScoringAuditAgainstAnalysis(analysis, audit, identity, source);
    assert.equal(validated.dimensions.openSource.score, 1.5);
    assert.equal(validated.dimensions.experimentalSufficiency.score, 1.4);
});

test('Wave 8: 2611.25773 Duopra HTML 隐藏外链锚点保留与页眉徽章分类，正文引用不误判', async () => {
    const html = `<!doctype html><html><body><div class="ltx_page_content">
        <h1>Duopra: From Full-Duplex Conversation to Full-Duplex Agency</h1>
        <div class="ltx_authors">
            <a href="https://cychen2003.github.io/duopra/">Project Page</a>$|$
            <a href="https://github.com/cyChen2003/duopra">GitHub</a>$|$
            <a href="https://huggingface.co/Chechen123/Duopra">Hugging Face</a>
            <a href="https://arxiv.org/abs/2611.25773">arXiv</a>
            <a href="https://orcid.org/0000-0001-0000-0000">ORCID</a>
        </div>
        <h2>Abstract</h2>
        <p>We introduce Duopra.</p>
        <h2>1 Introduction</h2>
        <p>Existing baseline: <a href="https://github.com/other/baseline">GitHub</a>.</p>
    </div></body></html>`;
    const extracted = deep.extractArxivHtmlText(html);
    assert.ok(extracted.includes('Project Page (https://cychen2003.github.io/duopra/)'));
    assert.ok(extracted.includes('GitHub (https://github.com/cyChen2003/duopra)'));
    assert.ok(extracted.includes('Hugging Face (https://huggingface.co/Chechen123/Duopra)'));
    assert.ok(!extracted.includes('(https://arxiv.org/abs/2611.25773)'));
    assert.ok(!extracted.includes('(https://orcid.org/'));

    assert.deepEqual(binding.paperSourceResourceFacets(extracted, 'https://cychen2003.github.io/duopra/'), ['demo']);
    assert.deepEqual(binding.paperSourceResourceFacets(extracted, 'https://github.com/cyChen2003/duopra'), ['code']);
    assert.deepEqual(binding.paperSourceResourceFacets(extracted, 'https://huggingface.co/Chechen123/Duopra'), ['model']);
    // 1 Introduction 之后的 GitHub 链接不得误判为作者页眉徽章
    assert.deepEqual(binding.paperSourceResourceFacets(extracted, 'https://github.com/other/baseline'), ['third_party']);

    // 非 HF 论文传入 options.paper 时也会检查 GitHub README 文档完整度
    const partialReadme = '# Duopra\n## Setup\npip install -e .\n## Demo\npython demo.py\n';
    const analysis = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n## 开源详情\n- 代码：https://github.com/cyChen2003/duopra\n- 模型权重：https://huggingface.co/Chechen123/Duopra\n- Demo：https://cychen2003.github.io/duopra/';
    const identity = await probe.buildApiReaderResourceIdentity(analysis, extracted, {}, {
        paper: { sources: ['arxiv'] },
        validateUrlImpl: async raw => new URL(raw),
        requestImpl: async raw => ({
            status: 200,
            headers: { get: name => (name.toLowerCase() === 'content-type' ? 'text/markdown' : null) },
            arrayBuffer: async () => Buffer.from(raw.includes('README.md') ? partialReadme : 'ok')
        })
    });
    const gh = identity.resources.find(r => r.type === 'code');
    assert.equal(gh?.documentationEvidence?.completeness, 'partial');
    assert.equal(gh?.documentationEvidence?.capabilities?.installation, true);
    assert.equal(gh?.documentationEvidence?.capabilities?.inference, true);
    assert.equal(gh?.documentationEvidence?.capabilities?.fineTuning, false);
    const validated = scoring.validateScoringAuditAgainstAnalysis(analysis, makeAudit({ openSource: 1.0 }), identity, extracted);
    assert.equal(validated.dimensions.openSource.score, 1.2);
});

test('Wave 8: UMelCodec / AURA / FLUID / Sonic Palette 一方 Demo 识别且去重不留双 third_party', async () => {
    const cases = [
        [
            'III-B Implementation\nFor UMelCodec11\n 1\n Audio samples can be found at https://redmist328.github.io/UMelCodecdemo/., mel spectrograms were extracted.',
            'https://redmist328.github.io/UMelCodecdemo/'
        ],
        [
            'Full videos for all sequences, including AURA 1.3B samples, are on the project page at https://kyutai.org/aura/.\n5 Conclusions',
            'https://kyutai.org/aura/'
        ],
        [
            'Together, FLUID moves situated task guidance beyond rigid reference matching. Project page: https://fluid-guidance.github.io.\n1 Introduction',
            'https://fluid-guidance.github.io'
        ],
        [
            'These differences are also illustrated in the accompanying demo video11\n 1\n https://youtu.be/VnEoSkbveXE. Overall, the results support our design.',
            'https://youtu.be/VnEoSkbveXE'
        ]
    ];
    for (const [source, url] of cases) {
        assert.deepEqual(binding.paperSourceResourceFacets(source, url), ['demo'], url);
        const quote = binding.paperSourceResourceQuote(source, url);
        assert.ok(quote.includes(url), url);
        assert.equal(binding.paperSourceQuoteBindsOriginalUrl({
            type: 'demo', origin: 'paper_source', originalUrl: url, sourceQuote: quote
        }), true, url);
        const analysis = `## 开源详情\n- Demo：<${url}>\n- 其他资源链接：${url}`;
        assert.deepEqual(probe.extractDemoUrls(analysis), [url]);
        const identity = await probe.buildApiReaderResourceIdentity(analysis, source, {}, {
            validateUrlImpl: async raw => new URL(raw),
            requestImpl: async () => ({ status: 200, headers: { get: () => null } })
        });
        assert.equal(identity.resources.length, 1, url);
        assert.equal(identity.resources[0].type, 'demo', url);
    }
});

test('Wave 8: 对抗负例与第三方基线均维持 third_party，不放宽安全边界', () => {
    const ghUrl = 'https://github.com/example/repo';
    const demoUrl = 'https://example.github.io/demo';
    for (const [source, url] of [
        [`We will publicly release our family.\n${ghUrl}`, ghUrl],
        [`We do not release our family.\n${ghUrl}`, ghUrl],
        [`Smith wrote:\nWe publicly release the model family.\n${ghUrl}`, ghUrl],
        [`> We publicly release the model family.\n${ghUrl}`, ghUrl],
        [`\`\`\`\nWe publicly release the model family.\n${ghUrl}\n\`\`\``, ghUrl],
        [`ExternalLib Project Page: ${demoUrl}`, demoUrl],
        [`Baseline project page: ${demoUrl}`, demoUrl],
        [`Smith wrote: Project page: ${demoUrl}`, demoUrl],
        [`We compare against AudioLDM [12].\n1 Introduction\nSee the project page: ${demoUrl}`, demoUrl],
        [`AudioLDM2:\nProject page: ${demoUrl}`, demoUrl],
        [` 1 Introduction\nGitHub: ${ghUrl}`, ghUrl],
        [`We evaluate Qwen2-Audio (Chu et al., 2024). The authors publicly release the model weights.\nhttps://huggingface.co/Qwen/Qwen2-Audio-7B`, 'https://huggingface.co/Qwen/Qwen2-Audio-7B'],
        [`Whisper is a strong ASR model. The code is publicly available.\nhttps://github.com/openai/whisper`, 'https://github.com/openai/whisper'],
        [`Audio samples of AudioLDM (Liu et al., 2023) are available on the project page at https://audioldm.github.io/.`, 'https://audioldm.github.io/'],
        [`We publicly release our evaluation code.\nhttps://github.com/org/eval\nhttps://huggingface.co/datasets/thirdparty/corpus`, 'https://huggingface.co/datasets/thirdparty/corpus'],
        [`We publicly release our model weights and code.\nhttps://huggingface.co/org/my-model\nhttps://github.com/org/my-code\nHowever, our code is private and not released.`, 'https://github.com/org/my-code'],
        [`We publicly release our model weights.\nhttps://huggingface.co/org/my-model\nHowever, our model weights are private and not released.`, 'https://huggingface.co/org/my-model'],
        [`The baseline architecture is based on Sepformer implemented in Speechbrain11\n 1\n https://github.com/speechbrain/speechbrain`, 'https://github.com/speechbrain/speechbrain'],
        [`We initialize the weights from the pretrained model22\n 2\n https://huggingface.co/ASLP-lab/SenSE`, 'https://huggingface.co/ASLP-lab/SenSE'],
        [`The source-aware codec is initialized from the pretrained OmniCodec checkpoint 11\n 1\n https://github.com/ASLP-lab/OmniCodec`, 'https://github.com/ASLP-lab/OmniCodec']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(source, url), ['third_party'], source);
    }
    // R2: 正例不被误伤 — 小写 "from scratch"、单换行正文中的先前引号、以及后文普通模型描述句
    const validWithFromScratch = `The paper calls this "omni" audio.\nWe publicly release our model trained from scratch and evaluation code.\n${ghUrl}\nOur model is a 7B omni-modal transformer trained on 100k hours.`;
    assert.deepEqual(binding.paperSourceResourceFacets(validWithFromScratch, ghUrl), ['code']);
    // GitHub 托管数据集若发布句明确只谈 benchmark/dataset，应按 dataset 归类而非错配为 code
    const ghDataset = 'We publicly release our benchmark dataset.\nhttps://github.com/org/my-audio-bench';
    assert.deepEqual(binding.paperSourceResourceFacets(ghDataset, 'https://github.com/org/my-audio-bench'), ['dataset']);
});

test('Wave 8: 2611.25521 / 2611.25960 / 2611.26000 / 2611.25781 未来发布承诺准确识别为 0.5，且拒绝日常章节点评与 cannot 否定', () => {
    const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
    const evalPromise = source => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(source), resources: [] };
        const identity = { ...body, identitySha256: probe.stableFingerprint(body) };
        const audit = makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' });
        return scoring.validateScoringAuditAgainstAnalysis(noRes, audit, identity, source);
    };
    for (const [source, expectConditional] of [
        ['This report’s appendix summarizes licensing.\nWe plan to release the model weights and accompanying code under Apache License 2.0, retaining upstream attribution and applicable third-party terms.', false],
        ['Code, selected heads, settings, and the evidence records behind every reported number will be publicly released.', false],
        ['The teacher’s output is distilled.\nWe will release model weights, four evaluation benchmarks, and supporting code and annotation guidelines.', false],
        ['Upon acceptance, we will release source links for the official music videos, along with frame-wise color-theme annotations, to support reproducibility and future research.', true]
    ]) {
        const validated = evalPromise(source);
        assert.equal(validated.dimensions.openSource.score, 0.5, source);
        if (expectConditional) {
            assert.match(validated.dimensions.openSource.reason, /有条件.*计划/);
        }
    }
    // 对抗负例：章节导览、论文发表计划、结果发布与 cannot 否定均不得计 0.5
    for (const negSource of [
        'We will provide details of the model architecture in Section 3.',
        'We will provide a comprehensive analysis of the dataset in the appendix.',
        'We will publish a follow-up paper analyzing this model on additional benchmarks.',
        'Model predictions and qualitative examples will be published in the supplementary report.',
        'Benchmark results for AudioLDM will be made available in Appendix B.',
        'We will provide qualitative examples of our model, though the model weights cannot be released.',
        'We plan to release third-party weights from another organization.'
    ]) {
        assert.equal(evalPromise(negSource).dimensions.openSource.score, 0, negSource);
    }
});

test('Wave 8: isMetadataResourceDiscoveryLink、HF Spaces 降级为 demo、空 README 不提分与 HTML URL 主机校验', async () => {
    const hfPaper = { sources: ['arxiv', 'huggingface'], hf_github_repo: 'https://github.com/Tencent/WeMM-Video' };
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/collections/tencent/wemm-video'), true);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/datasets/tencent/wemm-data'), true);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/spaces/tencent/wemm-demo'), true);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/spaces/tencent'), false);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/collections/tencent'), false);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/papers/2611.26409'), false);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/docs/transformers'), false);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/collections/tencent/wemm-video?foo=1'), false);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://huggingface.co/collections/tencent/wemm-video#frag'), false);
    assert.equal(probe.isMetadataResourceDiscoveryLink(hfPaper, 'https://github.com/user-attachments/assets'), false);
    // C1: 无 hf_github_repo 元数据的纯 arXiv 论文不得把项目页页脚模板仓库当作作者代码
    const plainPaper = { sources: ['arxiv'] };
    assert.equal(probe.isMetadataResourceDiscoveryLink(plainPaper, 'https://github.com/nerfies/nerfies.github.io'), false);
    assert.equal(probe.isMetadataResourceDiscoveryLink(plainPaper, 'https://github.com/user-attachments/assets'), false);

    // C2: HF Spaces 只能归类为 demo（不是 model），且不把 has_model 改为 是
    const spaceUrl = 'https://huggingface.co/spaces/tencent/wemm-demo';
    const updatedAnalysis = probe.updateOpensourceFromDemoLinks('## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n无', [spaceUrl]);
    assert.match(updatedAnalysis, /has_model: 否/);
    assert.match(updatedAnalysis, /在线演示/);
    const spaceIdentity = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无',
        'Our online demo is hosted separately.',
        { discoveredLinks: [spaceUrl] },
        {
            validateUrlImpl: async raw => new URL(raw),
            requestImpl: async () => ({ status: 200, headers: { get: () => null } })
        }
    );
    assert.equal(spaceIdentity.resources.length, 1);
    assert.equal(spaceIdentity.resources[0].type, 'demo');

    // M1: 空/Coming soon README（全部 capabilities 为 false）不得把开源分从 1.0 抬到 1.2，但真实安装说明应允许 1.2
    const makeReadmeIdentity = capabilities => {
        const body = {
            contract: 'api-reader-resource-identity-v1',
            sourceTextSha256: sha('src'),
            resources: [
                {
                    type: 'code', origin: 'paper_source', originalUrl: 'https://github.com/org/repo',
                    finalUrl: 'https://github.com/org/repo', redirects: [], status: 200, availability: 'available',
                    retryable: false, sourceQuote: 'Our code is at https://github.com/org/repo',
                    sourceQuoteSha256: sha('Our code is at https://github.com/org/repo'),
                    documentationEvidence: {
                        contract: 'repository-documentation-evidence-v1',
                        repositoryUrl: 'https://github.com/org/repo',
                        sourceUrl: 'https://raw.githubusercontent.com/org/repo/main/README.md',
                        status: 200,
                        sourceSha256: sha(capabilities.installation ? '# Install\npip install foo' : '# Coming soon'),
                        capabilities,
                        completeness: 'partial'
                    }
                },
                {
                    type: 'model', origin: 'paper_source', originalUrl: 'https://huggingface.co/org/model',
                    finalUrl: 'https://huggingface.co/org/model', redirects: [], status: 200, availability: 'available',
                    retryable: false, sourceQuote: 'Our model is at https://huggingface.co/org/model',
                    sourceQuoteSha256: sha('Our model is at https://huggingface.co/org/model')
                }
            ]
        };
        return { ...body, identitySha256: probe.stableFingerprint(body) };
    };
    const emptyReadmeIdentity = makeReadmeIdentity({ installation: false, inference: false, fineTuning: false });
    assert.equal(
        probe.validRepositoryDocumentationEvidence(emptyReadmeIdentity.resources[0].documentationEvidence, 'https://github.com/org/repo'),
        true
    );
    const validatedEmptyReadme = scoring.validateScoringAuditAgainstAnalysis(
        '## 机器摘要\nhas_code: 是\nhas_model: 是\nhas_dataset: 否\n\n## 开源详情\n- 代码：https://github.com/org/repo\n- 模型：https://huggingface.co/org/model',
        makeAudit({ openSource: 1.0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }),
        emptyReadmeIdentity,
        'src'
    );
    assert.equal(validatedEmptyReadme.dimensions.openSource.score, 1.0);

    const partialInstallIdentity = makeReadmeIdentity({ installation: true, inference: false, fineTuning: false });
    const validatedPartialInstall = scoring.validateScoringAuditAgainstAnalysis(
        '## 机器摘要\nhas_code: 是\nhas_model: 是\nhas_dataset: 否\n\n## 开源详情\n- 代码：https://github.com/org/repo\n- 模型：https://huggingface.co/org/model',
        makeAudit({ openSource: 1.0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }),
        partialInstallIdentity,
        'src'
    );
    assert.equal(validatedPartialInstall.dimensions.openSource.score, 1.2);

    // M3: extractArxivHtmlText 仅按真实 hostname 识别 .github.io，忽略伪装路径
    const spoofHtml = '<html><body><article class="ltx_document"><p><a href="https://evil.com/foo.github.io/bar">Docs</a></p></article></body></html>';
    const spoofText = deep.extractArxivHtmlText(spoofHtml);
    assert.equal(spoofText.includes('evil.com'), false);
});

test('Wave 8 R2 回归：保留前缀、末尾斜杠/句号、收缩否定、小数截断、弱动词、多链接清理与一致性检查全覆盖', async () => {
    // R2 #1: updateOpensourceFromDemoLinks 与 buildApiReaderResourceIdentity 拒绝 HF 保留前缀与非法 ModelScope 路径
    const updatedReserved = probe.updateOpensourceFromDemoLinks(
        '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n无',
        [
            'https://huggingface.co/papers/2611.26409',
            'https://huggingface.co/docs/transformers',
            'https://huggingface.co/spaces/tencent',
            'https://modelscope.cn/docs/foo'
        ]
    );
    assert.match(updatedReserved, /has_model:\s*否/);
    assert.equal(updatedReserved.includes('模型权重'), false);

    const reservedIdentity = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无',
        'Paper text.',
        {
            discoveredLinks: [
                'https://huggingface.co/papers/2611.26409',
                'https://huggingface.co/docs/transformers',
                'https://huggingface.co/spaces/tencent',
                'https://modelscope.cn/docs/foo'
            ]
        },
        {
            verifyUrlImpl: async url => ({
                originalUrl: url, finalUrl: url, redirects: [], status: 200, availability: 'available', retryable: false
            })
        }
    );
    assert.deepEqual(reservedIdentity.resources, []);

    // R2 #2: checkDemoPageForOpensource 支持末尾斜杠与正文句点，过滤保留前缀与伪造路径前缀
    const demoHtml = [
        '<a href="https://huggingface.co/Tencent/WeMM-Video/">Model</a>',
        '<a href="https://github.com/Tencent/WeMM-Video/">Code</a>',
        '<a href="https://huggingface.co/collections/tencent/wemm-video/">Collection</a>',
        '<p>See https://huggingface.co/Tencent/WeMM-Video-7B.</p>',
        '<a href="https://huggingface.co/papers/2611.26409">Paper</a>',
        '<a href="https://huggingface.co/docs/transformers">Docs</a>',
        '<a href="https://huggingface.co/spaces/tencent">IncompleteSpace</a>',
        '<a href="https://evil.com/github.com/org/repo">Spoof</a>',
        '<a href="https://github.com/Tencent/WeMM-Video/blob/main/README.md">Subpath</a>'
    ].join('\n');
    const extractedDemoLinks = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(demoHtml, 'utf8')
        })
    });
    assert.deepEqual(extractedDemoLinks.sort(), [
        'https://github.com/Tencent/WeMM-Video',
        'https://huggingface.co/Tencent/WeMM-Video',
        'https://huggingface.co/Tencent/WeMM-Video-7B',
        'https://huggingface.co/collections/tencent/wemm-video'
    ]);

    // R2 #3: Introduction 后接空行或缩进行时正确识别正文边界，不误认第三方 GitHub/Project page
    const introBlank = 'Title\nAbstract\nWe propose X.\n\nIntroduction\n\nWe compare against Whisper.\nGitHub: https://github.com/openai/whisper';
    assert.deepEqual(binding.paperSourceResourceFacets(introBlank, 'https://github.com/openai/whisper'), ['third_party']);
    const introIndent = 'Title\nAbstract\nWe propose X.\nIntroduction\n In this paper we compare with Y.\nProject page: https://other.github.io/y';
    assert.deepEqual(binding.paperSourceResourceFacets(introIndent, 'https://other.github.io/y'), ['third_party']);

    // R2 #4 & #5: sourceReleasePromise 拦截 can't/won't 收缩否定、弱动词泛述，并不在小数 2.0 处截断
    for (const badPromise of [
        "We will provide an interactive walkthrough of our model, though the model weights can't be released.",
        "We will provide an interactive walkthrough of our model, though the weights won't be released.",
        'We will provide an interactive walkthrough of our model, though the weights can’t be released.',
        'We will provide a theoretical justification for our model in Section 4.',
        'We will provide a detailed comparison of these models in Table 2.',
        'We will provide a thorough evaluation of our model on public datasets.',
        'We will provide the mathematical formulation of our model below.',
        'We plan to publish our experimental findings on this dataset in future work.',
        'We plan to release the model under Apache License 2.0, though the proprietary weights cannot be released.'
    ]) {
        assert.equal(scoring.sourceReleasePromise(badPromise, { sourceTextSha256: sha(badPromise) }), null, badPromise);
    }
    const decimalConditional = 'We plan to release the model weights and code under Apache License 2.0 upon acceptance.';
    const decimalRes = scoring.sourceReleasePromise(decimalConditional, { sourceTextSha256: sha(decimalConditional) });
    assert.deepEqual(decimalRes, { conditional: true, consentOrInstitution: false });

    // R2 #6: hasFollowingResourceRetraction 不误杀正常后续句与跨模态未来代码承诺，并拦截 Note:/closed-source/Code is not yet released
    const benignBench = 'We publicly release our model and evaluation code.\nhttps://github.com/org/repo\nOur model will be evaluated on additional public benchmarks.';
    assert.deepEqual(binding.paperSourceResourceFacets(benignBench, 'https://github.com/org/repo'), ['code']);
    const benignPrivate = 'We publicly release our model and code.\nhttps://github.com/org/repo\nThis model does not require private training data.';
    assert.deepEqual(binding.paperSourceResourceFacets(benignPrivate, 'https://github.com/org/repo'), ['code']);
    const demoWithFutureCode = 'Project page: https://org.github.io/demo\nOur code will be released upon acceptance.';
    assert.deepEqual(binding.paperSourceResourceFacets(demoWithFutureCode, 'https://org.github.io/demo'), ['demo']);
    const noteClosed = 'We publicly release our code.\nhttps://github.com/org/repo\nNote: our code is closed-source and proprietary.';
    assert.deepEqual(binding.paperSourceResourceFacets(noteClosed, 'https://github.com/org/repo'), ['third_party']);
    const notYetReleased = 'We publicly release our code.\nhttps://github.com/org/repo\nCode is not yet released.';
    assert.deepEqual(binding.paperSourceResourceFacets(notYetReleased, 'https://github.com/org/repo'), ['third_party']);

    // R2 #7: open-source 不再绕过主机-资源类型对应
    const ghDataset = 'We open-source our benchmark dataset.\nhttps://github.com/org/my-audio-bench';
    assert.deepEqual(binding.paperSourceResourceFacets(ghDataset, 'https://github.com/org/my-audio-bench'), ['dataset']);
    const hfOnlyCode = 'We publicly release our evaluation code for the open-source community.\nhttps://huggingface.co/org/some-model';
    assert.deepEqual(binding.paperSourceResourceFacets(hfOnlyCode, 'https://huggingface.co/org/some-model'), ['third_party']);

    // R2 #8: 多链接旧 其他资源链接 行在全部晋升为第一方后被完整清理
    const wemmSrc = 'We publicly release the WeMM-Video family along with our evaluation and reproduction pipeline.\nhttps://github.com/Tencent/WeMM-Video\nhttps://huggingface.co/Tencent/WeMM-Video';
    const multiOldAnalysis = [
        '## 机器摘要',
        'has_code: 否',
        'has_model: 否',
        'has_dataset: 否',
        '',
        '## 开源详情',
        '- 其他资源链接：<https://github.com/Tencent/WeMM-Video>（已验证可访问，HTTP 200）；<https://huggingface.co/Tencent/WeMM-Video>（已验证可访问，HTTP 200）（未据此确认作者已开放资源）'
    ].join('\n');
    const multiIdBody = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: sha(wemmSrc),
        resources: [
            {
                type: 'code', origin: 'paper_source', originalUrl: 'https://github.com/Tencent/WeMM-Video',
                finalUrl: 'https://github.com/Tencent/WeMM-Video', redirects: [], status: 200, availability: 'available',
                retryable: false, sourceQuote: binding.paperSourceResourceQuote(wemmSrc, 'https://github.com/Tencent/WeMM-Video'),
                sourceQuoteSha256: sha(binding.paperSourceResourceQuote(wemmSrc, 'https://github.com/Tencent/WeMM-Video'))
            },
            {
                type: 'model', origin: 'paper_source', originalUrl: 'https://huggingface.co/Tencent/WeMM-Video',
                finalUrl: 'https://huggingface.co/Tencent/WeMM-Video', redirects: [], status: 200, availability: 'available',
                retryable: false, sourceQuote: binding.paperSourceResourceQuote(wemmSrc, 'https://huggingface.co/Tencent/WeMM-Video'),
                sourceQuoteSha256: sha(binding.paperSourceResourceQuote(wemmSrc, 'https://huggingface.co/Tencent/WeMM-Video'))
            }
        ]
    };
    const multiId = { ...multiIdBody, identitySha256: probe.stableFingerprint(multiIdBody) };
    const cleanedAnalysis = probe.applyApiReaderResourceAvailability(multiOldAnalysis, multiId);
    assert.equal(cleanedAnalysis.includes('其他资源链接'), false);
    assert.match(cleanedAnalysis, /- 代码：<https:\/\/github\.com\/Tencent\/WeMM-Video>/);
    assert.match(cleanedAnalysis, /- 模型权重：<https:\/\/huggingface\.co\/Tencent\/WeMM-Video>/);

    // R2 #10: resourceClassificationIsCurrent 校验 validated_demo、paper_source 非 third_party 及 presentedLibraryRepositoryQuote
    assert.equal(binding.resourceClassificationIsCurrent({
        origin: 'validated_demo', type: 'model', originalUrl: 'https://huggingface.co/spaces/tencent/demo'
    }, 'src'), false);
    assert.equal(binding.resourceClassificationIsCurrent({
        origin: 'validated_demo', type: 'demo', originalUrl: 'https://huggingface.co/spaces/tencent/demo'
    }, 'src'), true);
    assert.equal(binding.resourceClassificationIsCurrent({
        origin: 'paper_source', type: 'demo', originalUrl: 'https://other.github.io/y',
        sourceQuote: 'Project page: https://other.github.io/y'
    }, introIndent), false);

    // R2 #11: isMetadataResourceDiscoveryLink 拒绝点段路径与裸 ? / #
    const paperMeta = { hf_github_repo: 'https://github.com/Tencent/WeMM-Video' };
    for (const badUrl of [
        'https://huggingface.co/org/foo/.',
        'https://huggingface.co/org/foo/../bar',
        'https://huggingface.co/org/model?',
        'https://huggingface.co/org/model#',
        'https://huggingface.co/org/foo/%2e',
        'https://huggingface.co/org/foo/%2e%2e/bar',
        'https://huggingface.co/papers/%2e%2e/org/model',
        'https://huggingface.co/org/foo\\..\\bar',
        'https://huggingface.co/papers\\..\\org\\model',
        'https://huggingface.co/org/model '
    ]) {
        assert.equal(probe.isMetadataResourceDiscoveryLink(paperMeta, badUrl), false, badUrl);
        assert.equal(binding.classifyRepositoryHostFacets(badUrl), null, badUrl);
    }
});

test('Wave 8 R3 回归：validated_demo 主机类型强约束、repoBadge 前置否定/冒号守卫、缩写与名词修饰、完成时否定与 demo 链接尾部收紧', async () => {
    const okVerify = async url => ({
        originalUrl: url, finalUrl: url, redirects: [], status: 200, availability: 'available', retryable: false
    });

    // R3 #1: validated_demo 强制与主机类型一致，拒绝保留前缀与错标 has_model
    const spaceMislabel = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 模型权重：https://huggingface.co/spaces/tencent/wemm-demo',
        'Our demo is hosted separately.',
        { discoveredLinks: ['https://huggingface.co/spaces/tencent/wemm-demo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.equal(spaceMislabel.resources.length, 1);
    assert.equal(spaceMislabel.resources[0].type, 'demo');
    assert.equal(binding.resourceClassificationIsCurrent(spaceMislabel.resources[0], 'Our demo is hosted separately.'), true);

    const paperPrefixMislabel = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 模型权重：https://huggingface.co/papers/2611.26409',
        'Paper text without URL.',
        { discoveredLinks: ['https://huggingface.co/papers/2611.26409'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(paperPrefixMislabel.resources, []);

    const ghMislabel = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 模型权重：https://github.com/org/repo',
        'Paper text without URL.',
        { discoveredLinks: ['https://github.com/org/repo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.equal(ghMislabel.resources.length, 1);
    assert.equal(ghMislabel.resources[0].type, 'code');
    assert.equal(binding.resourceClassificationIsCurrent(ghMislabel.resources[0], 'Paper text without URL.'), true);

    // R3 #2: repoBadge 补齐前序同段 RESOURCE_NOT_RELEASED 与前一行第三方冒号标题守卫
    for (const [src, url] of [
        ['Title\nAbstract\nOur code will be released upon acceptance.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur code is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nAudioLDM2:\nGitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R3 #3: sourceReleasePromise 拒绝名词修饰泛述，且不在 e.g. / Sec. 处截断掩盖尾部否定
    for (const bad of [
        'We will provide the model architecture in Section 3.',
        'We will provide our model design and training details in Section 3.',
        'We will provide the dataset statistics in Table 1.',
        'We will provide the benchmark setup in Appendix A.',
        'We will publish our benchmark results in the camera-ready version.',
        'We will publish our model evaluation results in the final report.',
        'We plan to release the model (e.g. weights) in the future, though it cannot be released publicly.',
        'We plan to release our model in Sec. 4, although weights cannot be released.'
    ]) {
        assert.equal(scoring.sourceReleasePromise(bad, { sourceTextSha256: sha(bad) }), null, bad);
    }

    // R3 #5: hasFollowingResourceRetraction 识别完成时/过去时/缩写否定及 PDF 单换行断句
    for (const retracted of [
        'We publicly release our code.\nhttps://github.com/org/repo\nThe code has not been released.',
        'We publicly release our code.\nhttps://github.com/org/repo\nWe have not released our code.',
        'We publicly release our code.\nhttps://github.com/org/repo\nWe did not release our code.',
        "We publicly release our code.\nhttps://github.com/org/repo\nOur code isn't available yet.",
        'We publicly release our code.\nhttps://github.com/org/repo\nHowever, our code is not yet\nreleased due to policy.'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(retracted, 'https://github.com/org/repo'), ['third_party'], retracted);
    }

    // R3 #6: checkDemoPageForOpensource 拒绝 /.. /%.. /@.. /~.. :port 并小写化主机名
    const adversarialDemoHtml = [
        '<a href="https://github.com/org/repo/../other">dotdot</a>',
        '<a href="https://github.com/org/repo/%2e%2e/secret">pct</a>',
        '<a href="https://huggingface.co/org/model/@rev">at</a>',
        '<a href="https://huggingface.co/org/model/~branch">tilde</a>',
        '<a href="https://github.com/org/repo:8080">port</a>',
        '<a href="https://GitHub.com/Tencent/WeMM-Video">MixedCase</a>'
    ].join('\n');
    const extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(adversarialDemoHtml, 'utf8')
        })
    });
    assert.deepEqual(extracted, ['https://github.com/Tencent/WeMM-Video']);
    assert.equal(
        probe.isMetadataResourceDiscoveryLink({ sources: ['huggingface'], hf_github_repo: 'https://github.com/Tencent/WeMM-Video' }, extracted[0]),
        true
    );
});

test('Wave 8 R4 回归：回撤断行/make语义、dataset-only validated_demo 守卫、被动承诺同步与缩写/名词修饰、authority/segment 严格化、多徽章冒号守卫与 demo 反斜杠/?#边界', async () => {
    const okVerify = async url => ({
        originalUrl: url, finalUrl: url, redirects: [], status: 200, availability: 'available', retryable: false
    });

    // R4 #1: hasFollowingResourceRetraction 不被括号徽章、横排多徽章、堆叠徽章、无标点章节标题或 make/not currently 绕过
    for (const [src, url] of [
        ['Title\nAbstract\nGitHub (https://github.com/org/repo)\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nProject Page (https://org.github.io/demo)\nOur demo is currently unavailable.\n1 Introduction', 'https://org.github.io/demo'],
        ['Title\nAbstract\nProject page: https://org.github.io/demo | GitHub: https://github.com/org/repo\nOur demo is not yet available.\n1 Introduction', 'https://org.github.io/demo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo\nHugging Face: https://huggingface.co/org/model\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\n1 Introduction\nOur code has not been released yet.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nWe cannot make our code publicly available due to licensing.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nWe did not make our code publicly available.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nWe plan to make our code publicly available in the future.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nOur code is not currently available.', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R4 #2: dataset-only GitHub repo + discoveredLinks 不伪造 code；缩写否定回撤不借 validated_demo 复活；错标 analysis 行不残留在 validated_demo sourceQuote
    const datasetOnlyRepo = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 数据集：https://github.com/org/my-audio-bench',
        'We open-source our benchmark dataset.\nhttps://github.com/org/my-audio-bench',
        { discoveredLinks: ['https://github.com/org/my-audio-bench'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(datasetOnlyRepo.resources.map(r => [r.type, r.origin]), [['dataset', 'paper_source']]);

    const retractedViaDemo = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 代码：https://github.com/org/repo',
        "Our code repository is https://github.com/org/repo.\nOur code isn't available yet.",
        { discoveredLinks: ['https://github.com/org/repo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(retractedViaDemo.resources.map(r => [r.type, r.origin]), [['third_party', 'paper_source']]);

    const mislabeledValidatedDemo = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 模型权重：https://huggingface.co/spaces/tencent/wemm-demo',
        'Our demo is hosted separately.',
        { discoveredLinks: ['https://huggingface.co/spaces/tencent/wemm-demo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.equal(mislabeledValidatedDemo.resources[0].type, 'demo');
    assert.equal(mislabeledValidatedDemo.resources[0].origin, 'validated_demo');
    assert.equal(mislabeledValidatedDemo.resources[0].sourceQuote, 'validated project metadata: https://huggingface.co/spaces/tencent/wemm-demo');

    // R4 #3: sourceReleasePromise 被动分支支持 e.g./URL/Sec./Fig. 且拒绝被动/主动泛述和复数缩写后尾部否定
    for (const good of [
        'Our code (e.g., training scripts) will be publicly released upon acceptance.',
        'Our code at https://github.com/org/repo will be publicly released upon acceptance.',
        'Our model (see Sec. 3) will be made publicly available upon publication.',
        'Our dataset, described in Fig. 2, will be released publicly.'
    ]) {
        assert.notEqual(scoring.sourceReleasePromise(good, { sourceTextSha256: sha(good) }), null, good);
    }
    for (const bad of [
        'Our model evaluation results will be made publicly available.',
        'Our dataset examples will be made available in the appendix.',
        'We will provide the model architectures in Section 3.',
        'We will provide our model designs in Section 3.',
        'We will provide the benchmark comparisons in Table 2.',
        'We will provide our model training details in Appendix A.',
        'We will provide the dataset training statistics in Table 1.',
        'We will provide the model hyperparameters in Appendix B.',
        'We will provide the dataset splits in Table 2.',
        'We plan to release our model in Secs. 3 and 4, although weights cannot be released.',
        'We plan to release our model (see Figs. 2 and 3), though weights cannot be released.',
        'We plan to release our model in Sect. 4, though weights cannot be released.',
        'We plan to release our model (cf. Table 1), though weights cannot be released.'
    ]) {
        assert.equal(scoring.sourceReleasePromise(bad, { sourceTextSha256: sha(bad) }), null, bad);
    }

    // R4 #4: authority 严格比对（拒绝空 userinfo 与默认/空端口）及 segment 字符限制
    const paperMeta = { sources: ['huggingface'], hf_github_repo: 'https://github.com/org/repo' };
    for (const malformed of [
        'https://@huggingface.co/org/model',
        'https://:@huggingface.co/org/model',
        'https://huggingface.co:443/org/model',
        'https://huggingface.co:/org/model',
        'https://github.com/org/repo:8080',
        'https://huggingface.co/org/model@rev'
    ]) {
        assert.equal(binding.classifyRepositoryHostFacets(malformed), null, malformed);
        assert.equal(probe.isMetadataResourceDiscoveryLink(paperMeta, malformed), false, malformed);
    }

    // R4 #5: 前一行第三方冒号标题覆盖整条横排多徽章栏
    const bar1 = 'Title\nAbstract\nAudioLDM2:\nProject page: https://audioldm.github.io/audioldm2 | GitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction';
    assert.deepEqual(binding.paperSourceResourceFacets(bar1, 'https://audioldm.github.io/audioldm2'), ['third_party']);
    assert.deepEqual(binding.paperSourceResourceFacets(bar1, 'https://github.com/haoheliu/AudioLDM2'), ['third_party']);
    const bar2 = 'Title\nAbstract\nAudioLDM2:\nGitHub (https://github.com/haoheliu/AudioLDM2) | Hugging Face (https://huggingface.co/cvssp/audioldm2)\n1 Introduction';
    assert.deepEqual(binding.paperSourceResourceFacets(bar2, 'https://github.com/haoheliu/AudioLDM2'), ['third_party']);
    assert.deepEqual(binding.paperSourceResourceFacets(bar2, 'https://huggingface.co/cvssp/audioldm2'), ['third_party']);

    // R4 #6: checkDemoPageForOpensource 拒绝反斜杠及 ?/#/\\ 前导串接
    const r4DemoHtml = [
        '<a href="https://github.com/org/repo\\..\\other">bs1</a>',
        '<a href="https://github.com/org/repo/\\..\\other">bs2</a>',
        '<a href="https://evil.com?github.com/org/repo">q</a>',
        '<a href="https://evil.com#github.com/org/repo">h</a>',
        '<a href="https://evil.com\\github.com/org/repo">bs3</a>',
        '<a href="https://github.com/Tencent/WeMM-Video">ok</a>'
    ].join('\n');
    const r4Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r4DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r4Extracted, ['https://github.com/Tencent/WeMM-Video']);
});

test('Wave 8 R5 回归：dataset-only 保留、retraction 尾斜杠/复合宾语/堆叠徽章、possessive/跨子句被动与 demo URL 边界', async () => {
    const okVerify = async rawUrl => ({
        originalUrl: rawUrl, finalUrl: rawUrl, redirects: [], status: 200, availability: 'available', retryable: false
    });

    // R5 #1: dataset-only GitHub paper_source with discoveredLinks keeps ['dataset','paper_source'] and passes resourceClassificationIsCurrent
    const dsSrc = 'We open-source our benchmark dataset.\nhttps://github.com/org/my-audio-bench';
    for (const analysisText of [
        '## 开源详情\n- 其他资源链接：https://github.com/org/my-audio-bench',
        '## 开源详情\n无',
        '## 开源详情\n- 代码：https://github.com/org/my-audio-bench',
        '## 开源详情\n- 数据集：https://github.com/org/my-audio-bench'
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            analysisText, dsSrc,
            { discoveredLinks: ['https://github.com/org/my-audio-bench'] },
            { verifyUrlImpl: okVerify }
        );
        assert.deepEqual(id.resources.map(r => [r.type, r.origin]), [['dataset', 'paper_source']], analysisText);
        assert.equal(id.resources.every(r => binding.resourceClassificationIsCurrent(r, dsSrc)), true, analysisText);
    }

    // R5 #2: RETRACTED_OR_CLOSED_SOURCE base-form release/compound object/private/under review + RESOURCE_NOT_RELEASED contractions
    for (const [src, url] of [
        ['Due to privacy constraints, we cannot release our code at https://github.com/org/repo.', 'https://github.com/org/repo'],
        ["We can't release our code at https://github.com/org/repo due to IP.", 'https://github.com/org/repo'],
        ["We won't release our code at https://github.com/org/repo.", 'https://github.com/org/repo'],
        ["We didn't release the weights at https://huggingface.co/org/model.", 'https://huggingface.co/org/model'],
        ["We don't release the repo https://github.com/org/repo.", 'https://github.com/org/repo'],
        ['Our repository is https://github.com/org/repo, though we cannot release our code.', 'https://github.com/org/repo'],
        ['Our model is at https://huggingface.co/org/model.\nWe cannot make our model weights publicly available due to licensing.', 'https://huggingface.co/org/model'],
        ['This private repository https://github.com/org/repo is currently under review.', 'https://github.com/org/repo']
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            '## 开源详情\n无', src, { discoveredLinks: [url] }, { verifyUrlImpl: okVerify }
        );
        assert.equal(id.resources.some(r => r.origin === 'validated_demo'), false, `should not promote: ${src}`);
    }
    for (const [src, url] of [
        ["We haven't released the weights at https://huggingface.co/org/model.", 'https://huggingface.co/org/model'],
        ["Our code isn't available at https://github.com/org/repo.", 'https://github.com/org/repo'],
        ['Our code cannot be released at https://github.com/org/repo.', 'https://github.com/org/repo'],
        ["Title\nAbstract\nOur code isn't available yet.\nGitHub: https://github.com/org/repo\n1 Introduction", 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo (currently unavailable)\n1 Introduction', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R5 #3: hasFollowingResourceRetraction trailing '/', compound objects, stacked badges, IEEE/unnumbered headings, predicates
    for (const [src, url] of [
        ['Title\nAbstract\nGitHub: https://github.com/org/repo/\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub (https://github.com/org/repo/)\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nProject page: https://org.github.io/demo/\nOur demo is currently unavailable.\n1 Introduction', 'https://org.github.io/demo'],
        ['We publicly release our model weights.\nhttps://huggingface.co/org/my-model\nWe cannot make our model weights publicly available due to licensing.', 'https://huggingface.co/org/my-model'],
        ['We publicly release our model weights.\nhttps://huggingface.co/org/my-model\nWe did not make our model weights available.', 'https://huggingface.co/org/my-model'],
        ['We publicly release our model weights.\nhttps://huggingface.co/org/my-model\nWe plan to make our model weights publicly available in the future.', 'https://huggingface.co/org/my-model'],
        ['We publicly release our benchmark dataset.\nhttps://github.com/org/bench\nWe cannot make our benchmark dataset publicly available.', 'https://github.com/org/bench'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo\nPaper: https://arxiv.org/abs/2611.99999\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo\nHuggingFace Space: https://huggingface.co/spaces/org/app\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nProject page: https://org.github.io/demo (under review)\nOur demo is not yet available.\n1 Introduction', 'https://org.github.io/demo'],
        ['Title\nAbstract\nProject Page (https://org.github.io/demo) / GitHub (placeholder)\nOur demo is currently unavailable.\n1 Introduction', 'https://org.github.io/demo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nIII-B Code Availability\nOur code is not yet released.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nData Availability\nOur code has not been released yet.', 'https://github.com/org/repo'],
        ["We publicly release our code.\nhttps://github.com/org/repo\nWe don't release our code publicly.", 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nOur code is no longer available.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nOur code will soon be released.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nWe cannot currently release our code.', 'https://github.com/org/repo'],
        ['We publicly release our code.\nhttps://github.com/org/repo\nDue to licensing restrictions, we cannot release our code.', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R5 #4: sourceReleasePromise possessive nonArtifactHead, multi-clause passive bleed-through, Sects./Chaps./etc.
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes, makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }), id, src
        ).dimensions.openSource.score;
    };
    for (const nonPromise of [
        "Our model's evaluation results will be made publicly available.",
        'Our model’s architecture will be made publicly available in Section 3.',
        "We will provide our model's architecture in Section 3.",
        "We will provide the dataset's statistics in Table 1.",
        "Our dataset's examples will be made available in the appendix.",
        "We will release our model's predictions in Appendix A.",
        "Our benchmark's evaluation results will be publicly released.",
        'Our code will be evaluated on LibriSpeech, while the evaluation report will be made publicly available.',
        'The model is trained on public audio, and our evaluation results will be made publicly available.',
        'Our model outperforms baselines; supplementary tables will be made publicly available.',
        'We plan to release our model (see Sects. 3 and 4), though weights cannot be released.',
        'We plan to release our model (see Chaps. 2 and 3), though weights cannot be released.'
    ]) {
        assert.equal(checkPromise(nonPromise), 0, `false positive promise: ${nonPromise}`);
    }
    assert.equal(
        checkPromise('We plan to release our model, code, weights, etc. In Section 4, we show our method does not degrade.'),
        0.5
    );
    assert.equal(
        checkPromise('Our model (which is trained on LibriSpeech) will be publicly released.'),
        0.5
    );

    // R5 #5: isBlockedByPrecedingColonHeading stacked multi-line badges + bulleted/Code:/Paper: period bars
    for (const [src, url] of [
        ['Title\nAbstract\nAudioLDM2:\nProject page: https://audioldm.github.io/audioldm2\nGitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nAudioLDM2:\nGitHub: https://github.com/haoheliu/AudioLDM2\nHugging Face: https://huggingface.co/cvssp/audioldm2\n1 Introduction', 'https://huggingface.co/cvssp/audioldm2'],
        ['Title\nAbstract\nAudioLDM2:\n• Project page: https://audioldm.github.io/audioldm2. GitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nAudioLDM2:\nCode: https://github.com/haoheliu/AudioLDM2. Hugging Face: https://huggingface.co/cvssp/audioldm2\n1 Introduction', 'https://huggingface.co/cvssp/audioldm2'],
        ['Title\nAbstract\nAudioLDM2:\nPaper: https://arxiv.org/abs/2308.05734. GitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nOur resources:\nProject page: https://org.github.io/demo\nGitHub: https://github.com/org/repo\n1 Introduction',
            'https://github.com/org/repo'
        ),
        ['code']
    );

    // R5 #6: checkDemoPageForOpensource dot-continuation & query/redirect prefixes
    const r5DemoHtml = [
        '<a href="https://github.com/org/repo1.\\..\\other">1</a>',
        '<a href="https://github.com/org/repo2.?foo=1">2</a>',
        '<a href="https://github.com/org/repo3.#frag">3</a>',
        '<a href="https://github.com/org/repo4.%2e%2e/secret">4</a>',
        '<a href="https://github.com/org/repo5.:8080">5</a>',
        '<a href="https://github.com/org/repo6.~branch">6</a>',
        '<a href="https://evil.com/?url=https://github.com/org/repo7">7</a>',
        '<a href="https://evil.com/?a=1&github.com/org/repo8">8</a>',
        '<a href="https://evil.com:github.com/org/repo9">9</a>',
        '<a href="https://github.com/org/repo10/+extra">10</a>',
        '<a href=https://github.com/org/unquoted-ok>ok1</a>',
        '<a href="https://github.com/Tencent/WeMM-Video">ok2</a>'
    ].join('\n');
    const r5Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r5DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r5Extracted, ['https://github.com/org/unquoted-ok', 'https://github.com/Tencent/WeMM-Video']);

    // R5 #7: isMetadataResourceDiscoveryLink rejects trailing-dot GitHub segment before returning true
    const dotPaper = { sources: ['huggingface'], hf_github_repo: 'https://github.com/org/repo.' };
    assert.equal(probe.isMetadataResourceDiscoveryLink(dotPaper, 'https://github.com/org/repo.'), false);
    assert.deepEqual(probe.resolveMetadataResourceLinks(dotPaper), []);
});

test('Wave 8 R6 回归：真实论文 2609.27389/2610.08125、predicative private/restricted、尾斜杠 dataset、retraction 补全与 URL 边界', async () => {
    const okVerify = async rawUrl => ({
        originalUrl: rawUrl, finalUrl: rawUrl, redirects: [], status: 200, availability: 'available', retryable: false
    });

    // R6 #1: comparative closed-source & unrelated technical "cannot adapt" do NOT kill real papers;
    // predicative private/restricted/withheld/pending/TBD/to be released block validated_demo promotion
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nFixed data cannot adapt as the learner improves. We therefore propose EvoAudio11\n 1\n Demo page: https://jensenyx.github.io/EvoAudio.github.io/\n1 Introduction',
            'https://jensenyx.github.io/EvoAudio.github.io/'
        ),
        ['demo']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Unlike closed-source models, we publicly release our model and code.\nhttps://github.com/org/repo',
            'https://github.com/org/repo'
        ),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nUnlike closed-source commercial systems, our open model achieves strong results.\nGitHub: https://github.com/org/repo\n1 Introduction',
            'https://github.com/org/repo'
        ),
        ['code']
    );
    for (const [src, url] of [
        ['Our repository https://github.com/org/repo is currently private.', 'https://github.com/org/repo'],
        ['The code at https://github.com/org/repo remains private.', 'https://github.com/org/repo'],
        ['Our repository https://github.com/org/myproj is restricted due to licensing.', 'https://github.com/org/myproj'],
        ['Our code repository (https://github.com/org/repo) is pending approval.', 'https://github.com/org/repo'],
        ['Our code repository (https://github.com/org/repo, to be released).', 'https://github.com/org/repo'],
        ['Our code repository (https://github.com/org/repo, TBD).', 'https://github.com/org/repo'],
        ['Our code at https://github.com/org/repo is currently withheld.', 'https://github.com/org/repo']
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            '## 开源详情\n无', src, { discoveredLinks: [url] }, { verifyUrlImpl: okVerify }
        );
        assert.equal(id.resources.some(r => r.origin === 'validated_demo'), false, `should not promote: ${src}`);
    }

    // R6 #2: trailing '/' on standalone URL line still preserves dataset-only paper_source
    const dsTrailing = 'We open-source our benchmark dataset.\nhttps://github.com/org/my-audio-bench/';
    assert.deepEqual(binding.paperSourceResourceFacets(dsTrailing, 'https://github.com/org/my-audio-bench'), ['dataset']);
    const dsId = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无', dsTrailing,
        { discoveredLinks: ['https://github.com/org/my-audio-bench'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(dsId.resources.map(r => [r.type, r.origin]), [['dataset', 'paper_source']]);

    // R6 #3: hasFollowingResourceRetraction will (not) be available, adjectives, barriers, Roman/appendix headings, inline fallback, mixed-modality FP
    for (const [src, url] of [
        ['We publicly release our code.\nhttps://github.com/org/myproj\nOur code will not be available.', 'https://github.com/org/myproj'],
        ["We publicly release our code.\nhttps://github.com/org/myproj\nOur code won't be publicly available.", 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nOur code will be publicly available soon.', 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nOur training code is not yet released.', 'https://github.com/org/myproj'],
        ['Title\nAbstract\nGitHub: https://github.com/org/myproj\nThe official repository is currently private.\n1 Introduction', 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nWe cannot release code publicly.', 'https://github.com/org/myproj'],
        ['Title\nAbstract\nGitHub: https://github.com/org/myproj\narXiv: 2611.99999\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/myproj'],
        ['Title\nAbstract\nGitHub: https://github.com/org/myproj [Paper]\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nIII Code Availability\nOur code is not yet released.', 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nA.1 Code Availability\nOur code is not yet released.', 'https://github.com/org/myproj'],
        ['Our code is publicly available at https://github.com/org/myproj.\nHowever, our code is not yet released.', 'https://github.com/org/myproj']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'We publicly release our code.\nhttps://github.com/org/myproj\nOur code is available under Apache 2.0, and our model weights will be released upon acceptance.',
            'https://github.com/org/myproj'
        ),
        ['code']
    );

    // R6 #4: sourceReleasePromise prepositional objects (2610.08125), adjectives/demos/samples, passive clauses, Supp./Alg., relative clauses, plural possessive
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes, makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }), id, src
        ).dimensions.openSource.score;
    };
    for (const nonPromise of [
        'We will release the scenarios, role prompts, and recording protocols between two full-duplex models, without any pre-recorded audio.',
        "Our model's qualitative results will be made publicly available.",
        "We will release our model's qualitative predictions in Appendix A.",
        "We will provide our dataset's detailed statistics in Table 1.",
        'We will release qualitative examples of our model in Appendix A.',
        'We will make publicly available a detailed analysis of our dataset in Appendix B.',
        'Our model produces high-quality audio, and supplementary tables will be made publicly available.',
        'Our dataset contains 10k clips, and the evaluation report will be publicly released.',
        'Our code works well while the documentation will be made publicly available.',
        'We will release our model demo upon acceptance.',
        'Our model samples will be made publicly available.',
        'We plan to release our model (see Supp. A), though weights cannot be released.',
        'We plan to release our model (see Alg. 1), though weights cannot be released.'
    ]) {
        assert.equal(checkPromise(nonPromise), 0, `false positive promise: ${nonPromise}`);
    }
    for (const validPromise of [
        'Our model, which is trained on LibriSpeech, will be publicly released.',
        'The code that we have developed will be publicly released upon acceptance.',
        "We will release our models' weights upon acceptance."
    ]) {
        assert.equal(checkPromise(validPromise), 0.5, `false negative promise: ${validPromise}`);
    }

    // R6 #5: isBlockedByPrecedingColonHeading blank-line symmetry, Space/Repository stack, NeurIPS 2023 prefix
    for (const [src, url] of [
        ['Title\nAbstract\nAudioLDM2:\n\nProject page: https://audioldm.github.io/audioldm2\nGitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nAudioLDM2:\nHuggingFace Space: https://huggingface.co/spaces/cvssp/audioldm2\nGitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nAudioLDM2:\nRepository: https://github.com/haoheliu/AudioLDM2\nHugging Face: https://huggingface.co/cvssp/audioldm2\n1 Introduction', 'https://huggingface.co/cvssp/audioldm2'],
        ['Title\nAbstract\nAudioLDM2:\nNeurIPS 2023. GitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R6 #6: checkDemoPageForOpensource #url=, /redirect/url=, +/=/$/! boundaries & URL-comma prefix
    const r6DemoHtml = [
        '<a href="https://evil.com/#url=https://github.com/org/repo1">1</a>',
        '<a href="https://evil.com/redirect/url=https://github.com/org/repo2">2</a>',
        '<a href="https://github.com/org/repo3+extra">3</a>',
        '<a href="https://github.com/org/repo4=extra">4</a>',
        '<a href="https://evil.com/go,github.com/org/repo5">5</a>',
        '<a href="https://github.com/org/repo6/$foo">6</a>',
        '<a href="https://github.com/org/repo7/!foo">7</a>',
        '<a href=https://github.com/org/unquoted-ok>ok1</a>',
        '<p>See also, github.com/org/prose-ok; and https://github.com/Tencent/WeMM-Video&nbsp;</p>'
    ].join('\n');
    const r6Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r6DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r6Extracted, [
        'https://github.com/org/unquoted-ok',
        'https://github.com/org/prose-ok',
        'https://github.com/Tencent/WeMM-Video'
    ]);

    // R6 #7: resolveMetadataResourceLinks validates raw string before WHATWG new URL normalization
    for (const badRaw of [
        'https://github.com/org/foo/../repo',
        'https://github.com/org/foo/%2e%2e/repo',
        'https://github.com/org/repo/.',
        'https://github.com/org/repo?',
        'https://github.com/org/repo#',
        'https://@github.com/org/repo',
        'https://github.com:443/org/repo',
        'https://github.com/org/repo//',
        'https://github.com/org/repo\\..\\other'
    ]) {
        assert.deepEqual(probe.resolveMetadataResourceLinks({ sources: ['huggingface'], hf_github_repo: badRaw }), [], badRaw);
    }
});

test('Wave 8: applyScoringEvidenceCaps 仅对公开泛化的模型/系统报告将 partial 消融上限放宽至 1.4，方法研究与无消融内部评测保持原上限', () => {
    const modelReport = scoring.applyScoringEvidenceCaps(makeAudit({
        documentType: '模型报告', ablationStatus: 'partial', targetEvaluation: 'public', publicGeneralizationEvaluated: true
    }));
    assert.equal(modelReport.dimensions.experimentalSufficiency.score, 1.4);

    const methodPaper = scoring.applyScoringEvidenceCaps(makeAudit({
        documentType: '方法研究', ablationStatus: 'partial', targetEvaluation: 'public', publicGeneralizationEvaluated: true
    }));
    assert.equal(methodPaper.dimensions.experimentalSufficiency.score, 1.3);

    const internalReport = scoring.applyScoringEvidenceCaps(makeAudit({
        documentType: '系统技术报告', ablationStatus: 'none', targetEvaluation: 'internal', publicGeneralizationEvaluated: false,
        innovation: 1.0, technicalRigor: 1.0, impact: 1.0, openSource: 0.5, engineering: 1.0
    }));
    assert.equal(internalReport.dimensions.experimentalSufficiency.score, 1.2);
});

test('Wave 8: 2026-11-20 真实封存 source.txt 端到端资源分类与发布承诺抽检（若本地封存目录存在）', () => {
    const sealedRoot = path.resolve(__dirname, '../data/runtime/daily-fresh-source-runs/7c002250-94e3-4988-9018-f38ee7733a27/sources');
    if (!fs.existsSync(sealedRoot)) return;
    const readSealed = id => fs.readFileSync(path.join(sealedRoot, id, 'generation-000001', 'source.txt'), 'utf8');
    const wemm = readSealed('2611.26409');
    assert.deepEqual(binding.paperSourceResourceFacets(wemm, 'https://github.com/Tencent/WeMM-Video'), ['code']);
    assert.deepEqual(binding.paperSourceResourceFacets(wemm, 'https://huggingface.co/collections/tencent/wemm-video'), ['model']);
    assert.deepEqual(binding.paperSourceResourceFacets(readSealed('2611.25569'), 'https://redmist328.github.io/UMelCodecdemo/'), ['demo']);
    assert.deepEqual(binding.paperSourceResourceFacets(readSealed('2611.26540'), 'https://kyutai.org/aura/'), ['demo']);
    assert.deepEqual(binding.paperSourceResourceFacets(readSealed('2611.26491'), 'https://fluid-guidance.github.io'), ['demo']);
    assert.deepEqual(binding.paperSourceResourceFacets(readSealed('2611.25781'), 'https://youtu.be/VnEoSkbveXE'), ['demo']);
    // 真实第三方基线保持 third_party
    assert.deepEqual(binding.paperSourceResourceFacets(readSealed('2611.26317'), 'https://github.com/speechbrain/speechbrain'), ['third_party']);
    assert.deepEqual(binding.paperSourceResourceFacets(readSealed('2611.25503'), 'https://github.com/ASLP-lab/OmniCodec'), ['third_party']);
    assert.deepEqual(binding.paperSourceResourceFacets(readSealed('2611.25808'), 'https://github.com/kan-bayashi/LibriTTSLabel'), ['third_party']);
    // H6: 真实完整封存 2611.25521 / 2611.25960 / 2611.26000 / 2611.25781 均应识别出未来发布承诺（0.5）
    const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
    for (const id of ['2611.25521', '2611.25960', '2611.26000', '2611.25781']) {
        const src = readSealed(id);
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const identity = { ...body, identitySha256: probe.stableFingerprint(body) };
        const validated = scoring.validateScoringAuditAgainstAnalysis(
            noRes,
            makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }),
            identity,
            src
        );
        assert.equal(validated.dimensions.openSource.score, 0.5, `sealed ${id} release promise`);
    }
});

test('Wave 8 R7 回归：真实封存 2610.32749/2611.13430/2610.14232/2611.17955/2609.38878 与 8 项边界修复', async () => {
    const okVerify = async rawUrl => ({
        originalUrl: rawUrl, finalUrl: rawUrl, redirects: [], status: 200, availability: 'available', retryable: false
    });
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes, makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }), id, src
        ).dimensions.openSource.score;
    };

    // R7 #1: hasValidStrongDirectArtifact non-greedy per-artifact scan + general prepositional guard + nonArtifactAdj/Head
    for (const genuine of [
        'We will release the generation scripts and the metadata together with the dataset.',
        'We will release the weights of our model.',
        'We will release our code for evaluating our model.',
        'We will release the weights and training code of our model.',
        'We will release the model weights along with our dataset.',
        'We will release the demo page along with our code upon acceptance.',
        'We will release our model weights and evaluation scripts on the benchmark.',
        'We will release the full version of our dataset upon acceptance.'
    ]) {
        assert.equal(checkPromise(genuine), 0.5, `genuine promise must score 0.5: ${genuine}`);
    }
    for (const fp of [
        'We will release qualitative listening samples of our proposed model.',
        'We will release audio recordings from our audio-language model.',
        'We will release a demo page for our neural audio model.',
        'We will release audio samples to illustrate our model.',
        "We will release our model's listening samples.",
        "We will release our model's human evaluation scores.",
        "We will release our benchmark's public leaderboard.",
        "We will release our dataset's documentation."
    ]) {
        assert.equal(checkPromise(fp), 0, `non-artifact release must score 0: ${fp}`);
    }

    // R7 #2: hasValidPassiveDirectArtifact subject-relative clause (2611.13430), coordinated passive, and finite verb guard
    for (const genuine of [
        'The code and per-pair results that support the findings of this study will be open-sourced upon manuscript acceptance.',
        'Our model achieves SOTA on LibriSpeech, and our code will be publicly released upon acceptance.'
    ]) {
        assert.equal(checkPromise(genuine), 0.5, `passive promise must score 0.5: ${genuine}`);
    }
    for (const fp of [
        'Our model in this paper learns robust representations, and supplementary tables will be made publicly available.',
        'Our dataset for speech synthesis covers 12 languages, and the annotation guidelines will be publicly released.',
        'Our model, trained on 10k hours, excels at ASR, and supplementary tables will be made publicly available.'
    ]) {
        assert.equal(checkPromise(fp), 0, `passive FP must score 0: ${fp}`);
    }

    // R7 #3: non-commercial license restriction (2610.14232), per-facet inline retraction, determinerless mixed-modality clause
    const src2610_14232 = 'Code is available at https://github.com/theboringai-work/surround-sound and pre-trained weights are hosted at https://huggingface.co/theboringai-work/surround-sound; the weights are restricted to non-commercial use by the terms of the training data (Section 9).';
    assert.deepEqual(binding.paperSourceResourceFacets(src2610_14232, 'https://github.com/theboringai-work/surround-sound'), ['code']);
    assert.deepEqual(binding.paperSourceResourceFacets(src2610_14232, 'https://huggingface.co/theboringai-work/surround-sound'), ['model']);
    const id14232 = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无', src2610_14232,
        { discoveredLinks: ['https://github.com/theboringai-work/surround-sound', 'https://huggingface.co/theboringai-work/surround-sound'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(id14232.resources.map(r => [r.type, r.origin]).sort(), [['code', 'paper_source'], ['model', 'paper_source']]);
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Our code and model weights are available at https://github.com/org/myproj.\nHowever, our model weights will be released upon acceptance.',
            'https://github.com/org/myproj'
        ),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'We publicly release our code.\nhttps://github.com/org/myproj\nOur code is available under Apache 2.0, while model weights will be released upon acceptance.',
            'https://github.com/org/myproj'
        ),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'We publicly release our code.\nhttps://github.com/org/myproj\nOur code is available under Apache 2.0, and pretrained weights will be released later.',
            'https://github.com/org/myproj'
        ),
        ['code']
    );

    // R7 #4: determinerless make available, is not yet made available, expanded nouns, multi-tag & Homepage barriers
    for (const [src, url] of [
        ['We publicly release our code.\nhttps://github.com/org/myproj\nWe cannot make code publicly available.', 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nWe did not make code available.', 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nWe will make code publicly available.', 'https://github.com/org/myproj'],
        ['We publicly release our model weights.\nhttps://huggingface.co/org/my-model\nWe cannot make model weights publicly available.', 'https://huggingface.co/org/my-model'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nOur code is not yet made publicly available.', 'https://github.com/org/myproj'],
        ['We publicly release our code.\nhttps://github.com/org/myproj\nOur implementation is not yet released.', 'https://github.com/org/myproj'],
        ['We open-source our benchmark dataset.\nhttps://github.com/org/bench\nOur corpus is currently private.', 'https://github.com/org/bench'],
        ['Title\nAbstract\nGitHub: https://github.com/org/myproj [Paper] [Demo]\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/myproj'],
        ['Title\nAbstract\nGitHub: https://github.com/org/myproj\nHomepage: coming soon\nOur code is not yet released.\n1 Introduction', 'https://github.com/org/myproj']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R7 #5: wrapped preceding lines, bare model/implementation/corpus, inline private/to be released/TBD/review/pending,
    // AND real single-line abstracts (2611.17955, 2609.38878) + benign technical negation + comparative closed-source in probe
    for (const [src, url] of [
        ['Title\nAbstract\nOur code\nis not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur code is\nnot yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur model weights\nwill be released upon acceptance.\nHugging Face: https://huggingface.co/org/model\n1 Introduction', 'https://huggingface.co/org/model'],
        ['Title\nAbstract\nOur model is not yet released.\nHugging Face: https://huggingface.co/org/model\n1 Introduction', 'https://huggingface.co/org/model'],
        ['Title\nAbstract\nOur implementation is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur corpus is not yet released.\nHugging Face: https://huggingface.co/datasets/org/corpus\n1 Introduction', 'https://huggingface.co/datasets/org/corpus'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo (currently private)\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo (to be released)\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo (TBD)\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo (under anonymous review)\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo (pending approval)\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur code is currently private.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur code is to be released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo (to be released).', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nExisting benchmarks do not meaningfully evaluate web agents. Project page: https://webarena-pro.github.io.\n1 Introduction',
            'https://webarena-pro.github.io'
        ),
        ['demo']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nOur approach outperforms DART, the strongest baseline on average across tasks. Project page: https://audio-triage.github.io\n1 Introduction',
            'https://audio-triage.github.io'
        ),
        ['demo']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nExisting benchmarks do not cover noisy multilingual speech.\nHugging Face: https://huggingface.co/datasets/org/noisy-bench\n1 Introduction',
            'https://huggingface.co/datasets/org/noisy-bench'
        ),
        ['dataset']
    );
    const idContrast = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无',
        'Unlike closed-source models, we provide Foo at https://github.com/org/repo.',
        { discoveredLinks: ['https://github.com/org/repo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(idContrast.resources.map(r => [r.type, r.origin]), [['code', 'validated_demo']]);

    // R7 #6: trailing-slash URL dedup & mislabeled paper_source re-typing maintains resourceClassificationIsCurrent
    const dsTrailing = 'We open-source our benchmark dataset.\nhttps://github.com/org/my-audio-bench/';
    for (const [analysisText, discover] of [
        ['## 开源详情\n- 代码：https://github.com/org/my-audio-bench/', ['https://github.com/org/my-audio-bench']],
        ['## 开源详情\n- 代码：https://github.com/org/my-audio-bench', []],
        ['## 开源详情\n- 数据集：https://github.com/org/my-audio-bench/', ['https://github.com/org/my-audio-bench']]
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            analysisText, dsTrailing, { discoveredLinks: discover }, { verifyUrlImpl: okVerify }
        );
        assert.equal(id.resources.length, 1, `${analysisText} => ${JSON.stringify(id.resources)}`);
        assert.deepEqual([id.resources[0].type, id.resources[0].origin], ['dataset', 'paper_source'], analysisText);
        assert.equal(binding.resourceClassificationIsCurrent(id.resources[0], dsTrailing), true, analysisText);
    }

    // R7 #7: isBlockedByPrecedingColonHeading blank line between stacked badges & trailing-dot standalone URL
    for (const [src, url] of [
        ['Title\nAbstract\nAudioLDM2:\nProject page: https://audioldm.github.io/audioldm2\n\nGitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nAudioLDM2:\nhttps://audioldm.github.io/audioldm2.\nGitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R7 #8: checkDemoPageForOpensource spoofs via !, $, *, |, (, relative commas, * / non-entity & / quoted-href ;
    const r7DemoHtml = [
        '<a href="https://evil.com/redirect!https://github.com/org/repo1">1</a>',
        '<a href="https://evil.com/redirect$https://github.com/org/repo2">2</a>',
        '<a href="https://evil.com/redirect*https://github.com/org/repo3">3</a>',
        '<a href="https://evil.com/redirect|https://github.com/org/repo4">4</a>',
        '<a href="https://evil.com/redirect(https://github.com/org/repo5)">5</a>',
        '<a href="/redirect,https://github.com/org/repo6">6</a>',
        '<a href="//evil.com/go,github.com/org/repo7">7</a>',
        '<a href="https://github.com/org/repo8;v=2">8</a>',
        '<a href="https://github.com/org/repo9*extra">9</a>',
        '<a href="https://github.com/org/repo10&extra=1">10</a>',
        '<a href=https://github.com/org/unquoted-ok>ok1</a>',
        'See, github.com/org/prose-ok and [https://a.com](https://github.com/org/md-ok) and https://github.com/org/ent-ok&nbsp;done'
    ].join('\n');
    const r7Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r7DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r7Extracted, [
        'https://github.com/org/unquoted-ok',
        'https://github.com/org/prose-ok',
        'https://github.com/org/md-ok',
        'https://github.com/org/ent-ok'
    ]);
});

test('Wave 8 R8 回归：双链接并列不切分、介词短语并列/集体容器/牛津逗号被动、尾部斜杠防损坏、pre-trained/复现撤回与 Demo 边界全收敛', async () => {
    const okVerify = async rawUrl => ({
        originalUrl: rawUrl, finalUrl: rawUrl, redirects: [], status: 200, availability: 'available', retryable: false
    });
    const scorePromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes, makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }), id, src
        ).dimensions.openSource.score;
    };

    // R8 #1: bare "URL1 and URL2" preserves first-party classification for URL2 while independent clause still splits
    for (const [src, url, expected] of [
        [
            'Code and weights are available at https://github.com/third-intelligence/RubatoCodec and https://huggingface.co/third-intelligence/RubatoCodec.',
            'https://huggingface.co/third-intelligence/RubatoCodec',
            ['code', 'model']
        ],
        [
            'We open-source the model weights and code\nat https://huggingface.co/netease-youdao/Confucius4-R2T2 and\nhttps://github.com/netease-youdao/Confucius4-R2T2.',
            'https://github.com/netease-youdao/Confucius4-R2T2',
            ['code', 'model']
        ],
        [
            'The dataset and LUMO implementation are publicly available at https://github.com/mehedinaeem/lumo-speech-dataset and https://github.com/mehedinaeem/Lumo, respectively.',
            'https://github.com/mehedinaeem/Lumo',
            ['code', 'dataset']
        ],
        [
            'Data Availability\nOur dataset is available at https://github.com/org/my-vad and https://huggingface.co/datasets/org/my-vad.',
            'https://huggingface.co/datasets/org/my-vad',
            ['dataset']
        ],
        [
            'Data Availability\nLibriVAD is available at https://github.com/zhenghuatan/LibriVAD and https://huggingface.co/datasets/LibriVAD/LibriVAD.',
            'https://huggingface.co/datasets/LibriVAD/LibriVAD',
            ['third_party']
        ],
        [
            'Code is available at https://github.com/org/proj and pre-trained weights are hosted at https://huggingface.co/org/proj.',
            'https://github.com/org/proj',
            ['code']
        ],
        [
            'Code is available at https://github.com/org/proj and pre-trained weights are hosted at https://huggingface.co/org/proj.',
            'https://huggingface.co/org/proj',
            ['model']
        ]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url).sort(), expected.sort(), `${url} in ${src}`);
    }

    // R8 #2: active coordinated prepositional object FP rejected; collective containers (2609.25165) accepted
    for (const fp of [
        'We will release comparisons between our model and baseline models.',
        'We will release audio samples from our model and baseline models.',
        'We will release qualitative examples of our model and dataset.',
        'We will release our evaluation results for both our dataset and our model.',
        'We will release qualitative examples of our proposed, newly designed model.',
        "We will release our model's synthetic audio samples.",
        "We will release our model's inference samples."
    ]) {
        assert.equal(scorePromise(fp), 0, `active FP must score 0: ${fp}`);
    }
    assert.equal(
        scorePromise('We will release a family of state-of-the-art checkpoints covering both\nvision–language and native omni-modal retrieval, together with training\nand inference code and a unified evaluation toolkit.'),
        0.5
    );

    // R8 #3: passive prepositional object FP rejected; Oxford-comma subject list (2609.35564) accepted
    for (const fp of [
        'Our model is evaluated on LibriSpeech, and qualitative samples of our dataset will be made publicly available.',
        'Our model outperforms baselines, and audio samples of our model will be publicly released.',
        'Our dataset includes 10k clips, and the demo for our model will be publicly released.',
        'Our model generates audio, and the results on the benchmark will be publicly released.',
        'Our model achieves SOTA on the benchmark where listening samples of the dataset will be made publicly available.'
    ]) {
        assert.equal(scorePromise(fp), 0, `passive FP must score 0: ${fp}`);
    }
    for (const tp of [
        'The dataset, all evaluation scripts, model-output transcripts, and per-utterance metric reports will be released under a permissive licence, alongside a datasheet.',
        'Our code, checkpoints, and supplementary tables will be publicly released.'
    ]) {
        assert.equal(scorePromise(tp), 0.5, `passive TP must score 0.5: ${tp}`);
    }

    // R8 #4: canonical demoLinks, applyApiReaderResourceAvailability trailing-slash preservation, boundByKey paper_source priority
    const idDemoSlash = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 代码：https://github.com/org/repo',
        'This paper proposes FooNet.',
        { discoveredLinks: ['https://github.com/org/repo/'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(idDemoSlash.resources.map(r => [r.type, r.origin]), [['code', 'validated_demo']]);

    const idBareSlash = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无',
        'We present FooNet at https://github.com/org/repo.',
        { discoveredLinks: ['https://github.com/org/repo/'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(idBareSlash.resources.map(r => [r.type, r.origin]), [['code', 'validated_demo']]);

    const slashSrc = 'Code is released at https://github.com/kamperh/inforate/.';
    const slashAnalysis = '## 开源详情\n- 代码：https://github.com/kamperh/inforate/\n\n详见 https://github.com/kamperh/inforate/ 。';
    const idSlash = await probe.buildApiReaderResourceIdentity(
        slashAnalysis, slashSrc, { discoveredLinks: ['https://github.com/kamperh/inforate'] }, { verifyUrlImpl: okVerify }
    );
    const appliedSlash = probe.applyApiReaderResourceAvailability(slashAnalysis, idSlash);
    assert.doesNotMatch(appliedSlash, /未找到论文原文或已验证 Demo 中的精确链接/);
    assert.match(appliedSlash, /https:\/\/github\.com\/kamperh\/inforate/);

    const idPriority = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 模型权重：https://GitHub.com/org/myrepo/',
        'We publicly release our code.\nhttps://GitHub.com/org/myrepo/',
        { discoveredLinks: ['https://github.com/org/myrepo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.equal(idPriority.resources.length, 1);
    assert.deepEqual([idPriority.resources[0].type, idPriority.resources[0].origin], ['code', 'paper_source']);

    // R8 #5: pre-trained hyphenation, reproduction/demo facet retraction, inline prose tail unavailability
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'We publicly release our code.\nhttps://github.com/org/myproj\nOur code is available under Apache 2.0, and pre-trained weights will be released later.',
            'https://github.com/org/myproj'
        ),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'We publicly release our model weights.\nhttps://huggingface.co/org/m\nOur pre-trained weights are not yet released.',
            'https://huggingface.co/org/m'
        ),
        ['third_party']
    );
    for (const [src, url] of [
        ['Resources for this study are publicly available at https://github.com/org/myproj.\nHowever, our repository is currently private.', 'https://github.com/org/myproj'],
        ['Our code and reproduction artifacts are available at https://github.com/org/myproj.\nHowever, our code is not yet released.', 'https://github.com/org/myproj'],
        ['Our code and demo are available at https://github.com/org/myproj.\nHowever, our repository is currently private.', 'https://github.com/org/myproj'],
        ['Our code is available at https://github.com/org/repo (currently private).', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo (withheld).', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo (placeholder).', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo, to be released.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo; to be released upon acceptance.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo, which is currently private.', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R8 #6: preceding badge retraction, prior-work non-blocking, and multi-badge pipe isolation
    for (const src of [
        'Title\nAbstract\nCode: coming soon\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nCode: will be released upon acceptance\nGitHub: https://github.com/org/repo\n1 Introduction'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'), ['third_party'], src);
    }
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nMost existing speech models remain closed-source and unavailable. We propose OpenSpeech.\nHugging Face: https://huggingface.co/org/openspeech\n1 Introduction',
            'https://huggingface.co/org/openspeech'
        ),
        ['model']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nIn real-world scenarios, speaker annotations are unavailable. We introduce OpenBench.\nHugging Face: https://huggingface.co/datasets/org/openbench\n1 Introduction',
            'https://huggingface.co/datasets/org/openbench'
        ),
        ['dataset']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nProject page: https://myproj.github.io | GitHub: https://github.com/org/repo (coming soon)\n1 Introduction',
            'https://myproj.github.io'
        ),
        ['demo']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nProject page: https://myproj.github.io | GitHub: https://github.com/org/repo (coming soon)\n1 Introduction',
            'https://github.com/org/repo'
        ),
        ['third_party']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'Title\nAbstract\nCode: coming soon | Project page: https://myproj.github.io\n1 Introduction',
            'https://myproj.github.io'
        ),
        ['demo']
    );

    // R8 #7: all 17 checkDemoPageForOpensource URL boundary bypasses blocked
    const r8DemoHtml = [
        '<a href="/redirect(https://github.com/org/spoof1)">1</a>',
        '<a href="//evil.com/go(https://github.com/org/spoof2)">2</a>',
        '<a href="https://evil.com/a(b)/!https://github.com/org/spoof3">3</a>',
        '<a href="https://evil.com/a(b),github.com/org/spoof4">4</a>',
        '<a href="../redirect,https://github.com/org/spoof5">5</a>',
        '<a href="redirect!https://github.com/org/spoof6">6</a>',
        '<a href="https://github.com/org/spoof7|extra">7</a>',
        '<a href="https://github.com/org/spoof8(extra)">8</a>',
        '<a href="https://github.com/org/spoof9/|extra">9</a>',
        '<a href=https://github.com/org/spoof10;v=2>10</a>',
        '<a href=https://github.com/org/spoof11,extra>11</a>',
        '<iframe src="https://github.com/org/spoof12;v=2"></iframe>',
        '<a href="https://evil.com/go\'https://github.com/org/spoof13">13</a>',
        '<a href="https://github.com/org/spoof14\'extra">14</a>',
        '<a href="https://evil.com/go[https://github.com/org/spoof15]">15</a>',
        '<a href="https://evil.com/go{https://github.com/org/spoof16}">16</a>',
        '<a href="https://evil.com/go^https://github.com/org/spoof17">17</a>',
        '<meta name="description" content="Code: https://github.com/org/meta-ok">',
        '<a href="https://github.com/org/real-ok">ok</a>'
    ].join('\n');
    const r8Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r8DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r8Extracted, [
        'https://github.com/org/meta-ok',
        'https://github.com/org/real-ok'
    ]);
});

test('Wave 8 R9 回归：规范化来源回查防撤回/防伪造 code、applyApiReaderResourceAvailability 尾斜杠洁净、16 项 URL 属性边界、主被动非产物短语与跨徽章/elided-verb 精确隔离', async () => {
    const okVerify = async url => ({
        originalUrl: url,
        finalUrl: url,
        availability: 'available',
        status: 200
    });

    // R9 #1: discoveredLinks with trailing slash or different host case MUST still resolve sourceText retraction and dataset-only facet
    const retractedSlash = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 代码：https://github.com/org/repo',
        "Our code repository is https://github.com/org/repo.\nOur code isn't available yet.",
        { discoveredLinks: ['https://github.com/org/repo/'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(retractedSlash.resources.map(r => [r.type, r.origin]), [['third_party', 'paper_source']]);

    const retractedCase = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 代码：https://github.com/org/repo',
        'Our code repository is https://GitHub.com/org/repo.\nOur code is currently private.',
        { discoveredLinks: ['https://github.com/org/repo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(retractedCase.resources.map(r => [r.type, r.origin]), [['third_party', 'paper_source']]);

    const datasetSlash = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 数据集：https://github.com/org/my-audio-bench',
        'We open-source our benchmark dataset.\nhttps://github.com/org/my-audio-bench',
        { discoveredLinks: ['https://github.com/org/my-audio-bench/'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(datasetSlash.resources.map(r => [r.type, r.origin]), [['dataset', 'paper_source']]);

    // R9 #2: applyApiReaderResourceAvailability must NOT inject bogus "其他资源链接：来源未确认" or leave stale trailing-slash third-party lines
    const idInforate = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 代码：https://github.com/kamperh/inforate/',
        'Our code is publicly available at https://github.com/kamperh/inforate.',
        { discoveredLinks: ['https://github.com/kamperh/inforate'] },
        { verifyUrlImpl: okVerify }
    );
    const appliedInforate = probe.applyApiReaderResourceAvailability(
        '## 开源详情\n- 代码：https://github.com/kamperh/inforate/\n- 其他资源链接：<https://github.com/kamperh/inforate/>（已验证可访问，HTTP 200）（未据此确认作者已开放资源）',
        idInforate
    );
    assert.doesNotMatch(appliedInforate, /来源未确认属于作者已开放的资源/);
    assert.doesNotMatch(appliedInforate, /未据此确认作者已开放资源/);
    assert.match(appliedInforate, /- 代码：<https:\/\/github\.com\/kamperh\/inforate>/);

    // R9 #3: all 16 URL-attribute & tail spoof bypasses blocked + leading-space valid href preserved
    const r9DemoHtml = [
        '<a href="redirect\'https://github.com/org/spoof-a">a</a>',
        '<a href="https://evil.com/go\'a!https://github.com/org/spoof-b">b</a>',
        '<a href="https://github.com/org/spoof-d^extra">d</a>',
        '<a href="https://github.com/org/spoof-e[extra]">e</a>',
        '<a href="https://github.com/org/spoof-f{extra}">f</a>',
        '<a href="https://github.com/org/spoof-g`extra">g</a>',
        '<a href="https://github.com/org/spoof-h)extra">h</a>',
        '<a href="https://github.com/org/spoof-i]extra">i</a>',
        '<a href="https://github.com/org/spoof-j}extra">j</a>',
        '<a href="https://github.com/org/spoof-k.">k</a>',
        '<a href="https://github.com/org/spoof-l&amp;x=1">l</a>',
        '<a href="https://github.com/org/spoof-m&#47;blob/main/README.md">m</a>',
        '<a href="https://github.com/org/spoof-q extra">q</a>',
        '<a href=https://github.com/org/spoof-n)extra>n</a>',
        '<a href=https://github.com/org/spoof-o]extra>o</a>',
        '<a href=https://github.com/org/spoof-p^extra>p</a>',
        '<a href=" https://github.com/org/real-leading-space">ok</a>',
        '<a href="https://github.com/org/real-trailing-space ">ok2</a>'
    ].join('\n');
    const r9Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r9DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r9Extracted, [
        'https://github.com/org/real-leading-space',
        'https://github.com/org/real-trailing-space'
    ]);

    // R9 #4 & #5: active & passive non-artifact container/coordinated-prep/appositive FPs rejected, real sealed 2609.25165 & 2609.35564 preserved
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes,
            makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }),
            id,
            src
        ).dimensions.openSource.score;
    };
    for (const fp of [
        'We will release a set of audio samples for our model.',
        'We will release a collection of listening samples of our model.',
        'We will release a suite of diagnostic tests for our model.',
        'We will release a series of qualitative analyses of our dataset.',
        'We will release a subset of generated clips from our model.',
        'We will release a bundle of audio demos for our model.',
        'We will release qualitative samples of System A, System B, and our model.',
        'We will release listening samples from clean, noisy, and real-world datasets.',
        'We will release qualitative examples of our model, our dataset, and our benchmark.',
        'We will release the prompt templates used in our model.',
        'We will release audio demos generated in our benchmark.',
        'We will release listening samples evaluated under our benchmark.',
        'We will release qualitative comparisons against our model.',
        'Our model achieves SOTA on LibriSpeech, and qualitative samples of our proposed, newly trained dataset will be publicly released.',
        'Our model achieves SOTA, and audio samples from our model and baseline models will be publicly released.',
        'Our model achieves SOTA, and comparisons between our model and baseline models will be made publicly available.',
        'Our model achieves SOTA, and qualitative examples of our model and dataset will be publicly released.',
        'Our model achieves SOTA, and evaluation results for both our dataset and our model will be publicly released.',
        'Our model achieves SOTA, and a set of audio samples for our model will be publicly released.',
        'Our model, a 7B transformer, outperformed all baselines, and supplementary tables will be publicly released.',
        'Our model, evaluated on LibriSpeech, achieved 2.1% WER, and supplementary tables will be made publicly available.',
        'Our model, trained on 10k hours, generalizes well to unseen speakers, and supplementary tables will be made publicly available.',
        'Our model for speech synthesis generalizes well, and qualitative evaluations will be made publicly available.'
    ]) {
        assert.equal(checkPromise(fp), 0, `R9 FP must score 0: ${fp}`);
    }
    assert.equal(checkPromise('We will release a family of models upon acceptance.'), 0.5);
    assert.equal(checkPromise('Our model, code, and supplementary materials will be publicly released.'), 0.5);
    assert.equal(checkPromise('Our model trained on LibriSpeech will be publicly released.'), 0.5);

    // R9 #6: standalone demo isolation, reproduction retraction, parenthesized & "and is currently private" inline retractions
    assert.deepEqual(
        binding.paperSourceResourceFacets('Project page: https://org.github.io/demo\nOur code repository will be released upon acceptance.', 'https://org.github.io/demo'),
        ['demo']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('Title\nAbstract\nOur repository will be released upon acceptance.\nProject page: https://org.github.io/demo\n1 Introduction', 'https://org.github.io/demo'),
        ['demo']
    );
    for (const [src, url] of [
        ['Resources for this study are publicly available at https://github.com/org/repo.\nHowever, our reproduction materials are currently private.', 'https://github.com/org/repo'],
        ['Our code is available at (https://github.com/org/repo), which is currently private.', 'https://github.com/org/repo'],
        ['Our code is available at (https://github.com/org/repo) (currently private).', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo and is currently private.', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], src);
    }

    // R9 #7: preceding badge bar splitting, verbless badge tags, host-name facet mapping, first-person prior-work exemption, plural tail stops
    for (const [src, url, expected] of [
        ['Title\nAbstract\nProject page: https://myproj.github.io | Code: coming soon\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nCode: private\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nCode: withheld\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nCode: placeholder\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: coming soon | Project page: https://myproj.github.io\n1 Introduction', 'https://myproj.github.io', ['demo']],
        ['Title\nAbstract\nHugging Face: coming soon | GitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['code']],
        ['Title\nAbstract\nPaper: arXiv 2611.99999 | Code: coming soon | GitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nOur code for evaluating existing speech models will be released upon acceptance.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nOur dataset of real-world speaker annotations is not yet released.\nHugging Face: https://huggingface.co/datasets/org/ds\n1 Introduction', 'https://huggingface.co/datasets/org/ds', ['third_party']],
        ['Title\nAbstract\nProject page: https://myproj.github.io Models: coming soon\n1 Introduction', 'https://myproj.github.io', ['demo']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, src);
    }

    // R9 #8: dual-URL splitting isolation + elided-verb URL2 (incl. 2609.16614) + self-contained quote replay
    for (const [src, url, expected] of [
        ['Demo is available at https://example.github.io/demo and code at https://github.com/org/empty (coming soon).', 'https://example.github.io/demo', ['demo']],
        ['Demo is available at https://example.github.io/demo and code at https://github.com/org/empty (coming soon).', 'https://github.com/org/empty', ['third_party']],
        ['Code is available at https://github.com/org/proj and weights at https://huggingface.co/org/proj are currently private.', 'https://github.com/org/proj', ['code']],
        ['Code is available at https://github.com/org/proj and weights at https://huggingface.co/org/proj are currently private.', 'https://huggingface.co/org/proj', ['third_party']],
        ['Code is available at https://github.com/org/proj and AudioLDM2 (Liu et al.) at https://github.com/haoheliu/AudioLDM2.', 'https://github.com/haoheliu/AudioLDM2', ['third_party']],
        ['Code is available at https://github.com/org/proj and demo is at https://example.github.io/demo.', 'https://example.github.io/demo', ['demo']],
        ['The benchmark is publicly available at https://huggingface.co/datasets/Greenbean/RoleBreak, and the code at https://github.com/bugggggggg/RoleBreak.', 'https://github.com/bugggggggg/RoleBreak', ['code']],
        ['We release our code at https://github.com/org/proj and our model weights at https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj', ['model']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `${url} in ${src}`);
        if (expected[0] !== 'third_party') {
            const q = binding.paperSourceResourceQuote(src, url);
            assert.deepEqual(binding.paperSourceResourceFacets(q, url), expected, `quote replay failed for ${url}: ${q}`);
        }
    }
});

test('Wave 8 R10 回归：elided-verb 第一方归属与对比边界、2610.38276/2610.05608 真实封存回归、先验文献例外、双向徽章/管道/尾部撤回、URL 前缀与复活防护、主被动发布承诺与 Demo 属性提取全收敛', async () => {
    const okVerify = async url => ({
        originalUrl: url,
        finalUrl: url,
        availability: 'available',
        status: 200
    });
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes,
            makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }),
            id,
            src
        ).dimensions.openSource.score;
    };

    // R10 #1 & #2: elided-verb lead first-party validation, contrast boundaries, real sealed 2610.38276, trailing slash/license, 3-URL lists
    for (const [src, url, expected] of [
        ['Whisper is publicly available at https://github.com/openai/whisper and the weights at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['Qwen2-Audio (Chu et al., 2024) is publicly available at https://github.com/QwenLM/Qwen2-Audio, and the model weights at https://huggingface.co/Qwen/Qwen2-Audio-7B.', 'https://huggingface.co/Qwen/Qwen2-Audio-7B', ['third_party']],
        ['Our demo is publicly available at https://org.github.io/demo, while AudioLDM2 is at https://github.com/other/audioldm2 and the weights at https://huggingface.co/other/audioldm2.', 'https://huggingface.co/other/audioldm2', ['third_party']],
        ['Our demo is publicly available at https://org.github.io/demo, but our code is currently private at https://github.com/org/proj, and the weights at https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj', ['third_party']],
        ['Our weights are not released, but our benchmark is publicly available at https://huggingface.co/datasets/org/bench, and our code at https://github.com/org/proj.', 'https://github.com/org/proj', ['code']],
        ['The benchmark dataset11\n 1\n https://doi.org/10.5281/zenodo.23702059 and code22\n 2\n https://github.com/Sound-Captioning-for-Accessibility/mixcardbench are publicly available, and demo examples are at https://mixcards-anon.github.io/mixcards-demo/', 'https://mixcards-anon.github.io/mixcards-demo/', ['demo']],
        ['Our code is publicly available at https://github.com/org/proj under Apache 2.0, and the weights at https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj', ['model']],
        ['Our code is available at https://github.com/org/proj (currently private) and the weights at https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj', ['third_party']],
        ['The benchmark is publicly available at https://huggingface.co/datasets/org/bench, and the code at https://github.com/org/proj/.', 'https://github.com/org/proj', ['code']],
        ['The benchmark is publicly available at https://huggingface.co/datasets/org/bench, and the code at https://github.com/org/proj under the MIT license.', 'https://github.com/org/proj', ['code']],
        ['Our code, weights, and dataset are available at https://github.com/org/proj, https://huggingface.co/org/proj, and https://huggingface.co/datasets/org/proj.', 'https://huggingface.co/org/proj', ['code', 'dataset', 'model']],
        ['Our code, weights, and dataset are available at https://github.com/org/proj, https://huggingface.co/org/proj, and https://huggingface.co/datasets/org/proj.', 'https://huggingface.co/datasets/org/proj', ['code', 'dataset', 'model']],
        ['Code and weights are available at https://github.com/org/proj, and https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj', ['code', 'model']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url).sort(), expected.slice().sort(), `R10 #1/#2 ${url} in ${src}`);
        if (expected[0] !== 'third_party') {
            const q = binding.paperSourceResourceQuote(src, url);
            assert.deepEqual(binding.paperSourceResourceFacets(q, url).sort(), expected.slice().sort(), `R10 #1/#2 quote replay for ${url}: ${q}`);
        }
    }

    // R10 #3: first-person abstract citing closed-source prior work must NOT kill own badges; own-code retraction still blocks
    for (const [src, url, expected] of [
        ['Title\nAbstract\nWe build our dataset because existing datasets are not publicly available.\nHugging Face: https://huggingface.co/datasets/org/our-ds\n1 Introduction', 'https://huggingface.co/datasets/org/our-ds', ['dataset']],
        ['Title\nAbstract\nWe propose OpenAudio to address the limitation that existing speech models are currently closed-source and unavailable.\nHugging Face: https://huggingface.co/org/openaudio\n1 Introduction', 'https://huggingface.co/org/openaudio', ['model']],
        ['Title\nAbstract\nOur model improves over existing speech models that remain closed-source and proprietary.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nWe evaluate our model against commercial models that remain proprietary and unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nOur code for evaluating existing speech models will be released upon acceptance.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R10 #3 ${src}`);
    }

    // R10 #4: real sealed 2610.05608 Kandinsky 6.0 Website: header & HTML Website (URL) no longer self-sabotage badges
    const kandinskySrc = 'Abstract\n... we release the code, model checkpoints, and diffusers integration under the MIT license.\nDate: October 6, 2026\nWebsite: https://kandinskylab.ai\nGitHub: https://github.com/kandinskylab/kandinsky-6\nHugging Face: https://huggingface.co/collections/kandinskylab/kandinsky-60-diffusers\n1 Introduction';
    assert.deepEqual(binding.paperSourceResourceFacets(kandinskySrc, 'https://github.com/kandinskylab/kandinsky-6'), ['code']);
    assert.deepEqual(binding.paperSourceResourceFacets(kandinskySrc, 'https://huggingface.co/collections/kandinskylab/kandinsky-60-diffusers'), ['model']);
    const htmlBadgeSrc = 'Title\nAbstract\nWebsite (https://kandinskylab.ai) | GitHub (https://github.com/kandinskylab/kandinsky-6)\n1 Introduction';
    assert.deepEqual(binding.paperSourceResourceFacets(htmlBadgeSrc, 'https://github.com/kandinskylab/kandinsky-6'), ['code']);

    // R10 #5: following badge/pipe symmetry, $|$, repoHostDemo, scripts?, but <predicate>, (currently private, see Sec. 4), Spaces/ModelScope Studio
    for (const [src, url, expected] of [
        ['Title\nAbstract\nGitHub: https://github.com/org/repo\nCode: private\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo | Code: coming soon\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo | Code: private\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo\nOur GitHub is currently private.\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nProject Page (https://myproj.github.io) $|$ Code: coming soon\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nProject page: https://github.com/org/repo\nHowever, our repository is currently private.\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Audio samples are on the project page at https://github.com/org/repo.\nHowever, our repository is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['We publicly release our evaluation scripts.\nhttps://github.com/org/repo\nOur evaluation scripts are currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nHugging Face Spaces: coming soon\nHugging Face: https://huggingface.co/spaces/org/demo\n1 Introduction', 'https://huggingface.co/spaces/org/demo', ['third_party']],
        ['Our code is available at https://github.com/org/repo but is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo but has not been released yet.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo but will not be released.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo but cannot be released.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo (currently private, see Sec. 4).', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nProject page: https://myproj.github.io ModelScope Studio: coming soon\n1 Introduction', 'https://myproj.github.io', ['demo']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R10 #5 ${src}`);
    }

    // R10 #6: prefix hallucination, cross-repo blocking, dual-URL prefix collision, retracted-URL resurrection via discoveredLinks
    const idHallucinated = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n- 代码：https://github.com/org/repo',
        'Our code is publicly available at https://github.com/org/repo-v2.',
        {},
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(idHallucinated.resources, [], 'prefix hallucination must not bind org/repo to org/repo-v2');

    const idCrossRepo = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无',
        'We do not release https://github.com/org/repo-old.',
        { discoveredLinks: ['https://github.com/org/repo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(idCrossRepo.resources.map(r => [r.type, r.origin, r.originalUrl]), [['code', 'validated_demo', 'https://github.com/org/repo']]);

    assert.deepEqual(
        binding.paperSourceResourceFacets(
            'The benchmark is publicly available at https://github.com/org/proj-bench, and the code at https://github.com/org/proj.',
            'https://github.com/org/proj'
        ),
        ['code']
    );

    for (const retractedSrc of [
        'Our code repository is github.com/org/repo.\nOur code is currently private.',
        'Our code repository is https://github.com/\norg/repo.\nOur code is currently private.',
        'Our code repository (https://GitHub.com/org/repo),coming soon.',
        'Our code at https://GitHub.com/org/repo#readme is currently private.',
        `See https://github.com/org/repo.\n\n${'x'.repeat(800)}\n\nOur code at https://GitHub.com/org/repo is currently private.`
    ]) {
        const res = await probe.buildApiReaderResourceIdentity(
            '## 开源详情\n无',
            retractedSrc,
            { discoveredLinks: ['https://github.com/org/repo'] },
            { verifyUrlImpl: okVerify }
        );
        assert.deepEqual(res.resources.map(r => [r.type, r.origin]), [['third_party', 'paper_source']], `R10 #6 resurrection blocked: ${retractedSrc.slice(0, 60)}`);
    }

    // R10 #7: sourceReleasePromise active/passive FPs rejected + 3 coordinatedInPrepRe FNs restored
    for (const fp of [
        'We will release qualitative samples of our 7.5B model.',
        'We will release audio demos of our Qwen2.5 model.',
        'We will release listening samples from our text-to-speech/audio model.',
        'We will release qualitative samples of our (quantized) model.',
        'We will release qualitative samples of System A (2024) and our model.',
        'We will release qualitative samples of our end-to-end streaming full-duplex neural audio language model.',
        "We will release our model's prompts in the appendix.",
        "We will release our dataset's annotation guidelines upon acceptance.",
        "We will release our benchmark's prompt templates upon acceptance.",
        "We will release our model's audio recordings upon acceptance.",
        'The accompanying repository will provide qualitative samples of our model.',
        'Our model that achieves SOTA produces listening samples that will be publicly released.',
        'Our model that was evaluated on LibriSpeech has audio demos that will be publicly released.',
        'Our model, proposed in Section 3, exhibits strong robustness, and supplementary tables will be made publicly available.',
        'Our model, the proposed architecture, degrades under noise, and supplementary tables will be publicly released.',
        'Our model trained on LibriSpeech fails on noise, although qualitative demos will be made publicly available.',
        'Our model for speech synthesis reconstructs waveforms, where listening samples will be publicly released.'
    ]) {
        assert.equal(checkPromise(fp), 0, `R10 #7 FP must score 0: ${fp}`);
    }
    for (const tp of [
        'We will release a demo page for our work and our code upon acceptance.',
        'We will release audio samples of our system and our model weights upon acceptance.',
        'We will release the evaluation results on LibriSpeech and our dataset upon acceptance.'
    ]) {
        assert.equal(checkPromise(tp), 0.5, `R10 #7 TP must score 0.5: ${tp}`);
    }

    // R10 #8: checkDemoPageForOpensource multiline/512+ attrs, backtick/delimiter else prefixes, srcset, prose entity slash
    const r10DemoHtml = [
        '<a href="https://evil.com/go\nhttps://github.com/org/spoof-nl1">nl1</a>',
        '<a href="\nhttps://github.com/org/spoof-nl2\n/blob/main/README.md">nl2</a>',
        `<a href="https://evil.com/${'a'.repeat(520)}!https://github.com/org/spoof-512">512</a>`,
        '<meta name="x" content="https://evil.com/go`https://github.com/org/spoof-bt">',
        '<a data-link="https://github.com/org/spoof-dl2)extra">dl2</a>',
        '<img srcset="https://github.com/org/spoof-srcset 2x">',
        '<p>https://github.com/org/spoof-prose-ent&#47;blob/main/README.md</p>',
        '<p>https://github.com/org/spoof-prose-hex&#x2f;blob/main/README.md</p>',
        '<p>https://github.com/org/spoof-prose-sol&sol;blob/main/README.md</p>',
        '<a href="\n  https://github.com/org/real-multiline  \n">ok-ml</a>',
        '<p>Code: https://github.com/org/real-nbsp&nbsp;available</p>'
    ].join('\n');
    const r10Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r10DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r10Extracted, [
        'https://github.com/org/real-multiline',
        'https://github.com/org/real-nbsp'
    ]);
});

test('Wave 8 R11 回归：#readme/http/www/.git/subpath 身份绑定与复活阻断、although/多URL前导、We先验/because因果、双平台撤回、括号/斜杠/空格徽章、被动that/which与Demo长属性全收敛', async () => {
    const okVerify = async rawUrl => ({
        originalUrl: rawUrl, finalUrl: rawUrl, redirects: [], status: 200, availability: 'available', retryable: false
    });
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes, makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }), id, src
        ).dimensions.openSource.score;
    };

    // R11 #1: mixed-case #readme/?tab=readme produces bindable paper_source passing applyApiReaderResourceAvailability;
    //         http://, www., .git, /tree/main retractions never resurrect as validated_demo;
    //         paperSourceQuoteBindsOriginalUrlBinding rejects prefix hallucination org/repo vs org/repo-v2.
    for (const [src, expectedType] of [
        ['Our code at https://GitHub.com/org/repo#readme is currently private.', 'third_party'],
        ['Our code at https://GitHub.com/org/repo?tab=readme is currently private.', 'third_party'],
        ['Our code is publicly available at https://GitHub.com/org/repo#readme.', 'code']
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            '## 开源详情\n无', src, { discoveredLinks: ['https://github.com/org/repo'] }, { verifyUrlImpl: okVerify }
        );
        assert.equal(id.resources.length, 1, src);
        assert.deepEqual([id.resources[0].type, id.resources[0].origin], [expectedType, 'paper_source'], src);
        assert.equal(binding.paperSourceQuoteBindsOriginalUrl(id.resources[0]), true, `must bind cleanly: ${src}`);
        assert.doesNotThrow(() => probe.applyApiReaderResourceAvailability('## 开源详情\n无', id), `applyApiReaderResourceAvailability must not throw: ${src}`);
    }
    for (const retractedVariant of [
        'Our code at https://www.github.com/org/repo is currently private.',
        'Our code at http://github.com/org/repo is currently private.',
        'Our code at https://github.com/org/repo.git is currently private.',
        'Our code at https://github.com/org/repo/tree/main is currently private.'
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            '## 开源详情\n无', retractedVariant, { discoveredLinks: ['https://github.com/org/repo'] }, { verifyUrlImpl: okVerify }
        );
        assert.equal(id.resources.some(r => r.origin === 'validated_demo'), false, `must not resurrect as validated_demo: ${retractedVariant}`);
        assert.equal(id.resources.every(r => r.origin !== 'paper_source' || binding.paperSourceQuoteBindsOriginalUrl(r)), true, retractedVariant);
    }
    assert.equal(binding.paperSourceQuoteBindsOriginalUrl({
        type: 'third_party',
        origin: 'paper_source',
        originalUrl: 'https://github.com/org/repo',
        sourceQuote: 'Our code is publicly available at https://github.com/org/repo-v2.'
    }), false);
    assert.equal(binding.paperSourceQuoteBindsOriginalUrlBinding({
        type: 'code',
        origin: 'paper_source',
        originalUrl: 'https://github.com/org/repo',
        sourceQuote: 'Our code is publicly available at https://github.com/org/repo-v2.'
    }), false);

    // R11 #2: although/though/yet & intermediate third-party URL clauses in elided-verb multi-URL sentences
    for (const src of [
        'Our demo is publicly available at https://org.github.io/demo, although AudioLDM2 is at https://github.com/other/audioldm2 and the weights at https://huggingface.co/other/audioldm2.',
        'Our demo is publicly available at https://org.github.io/demo, though AudioLDM2 is at https://github.com/other/audioldm2 and the weights at https://huggingface.co/other/audioldm2.',
        'Our demo is publicly available at https://org.github.io/demo, yet AudioLDM2 is at https://github.com/other/audioldm2 and the weights at https://huggingface.co/other/audioldm2.',
        'Our code is publicly available at https://github.com/org/proj, AudioLDM2 is at https://github.com/other/audioldm2, and the weights at https://huggingface.co/other/audioldm2.',
        'Our code is publicly available at https://github.com/org/proj, and AudioLDM2 is at https://github.com/other/audioldm2 and the weights at https://huggingface.co/other/audioldm2.'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://huggingface.co/other/audioldm2'), ['third_party'], `R11 #2 ${src}`);
    }

    // R11 #3: We-subject retractions with prior-work PPs + subordinate because-clause motivation FP guard in both directions
    for (const [src, url, expected] of [
        ['Title\nAbstract\nWe will release our code for evaluating existing speech models upon acceptance.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nWe cannot release our dataset of real-world speaker annotations due to privacy.\nHugging Face: https://huggingface.co/datasets/org/ds\n1 Introduction', 'https://huggingface.co/datasets/org/ds', ['third_party']],
        ['Title\nAbstract\nWe have not yet released our code for benchmarking existing speech models.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nOur model bridges the gap for existing speech models because they are currently unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nHugging Face: https://huggingface.co/org/our-model\nWe build our model because existing models are closed-source and unavailable.\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R11 #3 ${src}`);
    }

    // R11 #4: isHostedDemoPlatformMismatch dual-platform retraction + demoPlatform passed in standaloneReleaseBlockMatch,
    //         hasInlineTailRetractionForFacet, and buildApiReaderResourceIdentity
    for (const [src, url, expected] of [
        ['Title\nAbstract\nOur Hugging Face Space and ModelScope Studio are coming soon.\nHugging Face: https://huggingface.co/spaces/org/demo\n1 Introduction', 'https://huggingface.co/spaces/org/demo', ['third_party']],
        ['We publicly release our interactive demo.\nhttps://huggingface.co/spaces/org/demo\nOur Hugging Face Space is coming soon.', 'https://huggingface.co/spaces/org/demo', ['third_party']],
        ['Our demo is available at https://myproj.github.io (ModelScope Studio: coming soon).', 'https://myproj.github.io', ['demo']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R11 #4 ${src}`);
    }
    const idHfSpaceRetracted = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无',
        `See https://huggingface.co/spaces/org/demo for details. ${'We evaluate our method on standard audio tasks. '.repeat(4)}\nOur Hugging Face Space is currently private.`,
        { discoveredLinks: ['https://huggingface.co/spaces/org/demo'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(idHfSpaceRetracted.resources.map(r => [r.type, r.origin]), [['third_party', 'paper_source']]);

    // R11 #5: benign parenthetical before trailing retraction, but/while + subject, slash & space-separated badge bars
    for (const [src, url] of [
        ['Our code is available at https://github.com/org/repo (v1.0), which is currently private.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo (Apache 2.0) but is currently private.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo but it is currently private.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo but the repository is currently private.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo while it is currently private.', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub (https://github.com/org/repo) / Code: private\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo / Code: coming soon\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nProject page: https://myproj.github.io Code: coming soon\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo Hugging Face: https://huggingface.co/org/m Code: private\n1 Introduction', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R11 #5 ${src}`);
    }

    // R11 #6: trailing that/which in passive relative clauses & over-broad "and the <adj>" coordination FPs
    for (const fp of [
        'Our model with audio samples that will be publicly released is evaluated on LibriSpeech.',
        'Our dataset with listening clips which will be publicly released is described in Section 3.',
        'Our code with demo examples that will be publicly released is evaluated in Section 4.',
        'Our model for qualitative demos that will be publicly released achieves strong performance.',
        'The model with supplementary tables which will be publicly released is analyzed in Appendix A.',
        'We will release outputs of our model and the baseline implementation upon acceptance.',
        'We will release audio samples of our model and the reference implementation upon acceptance.',
        'We will release listening samples from the base model and the fine-tuned checkpoints upon acceptance.',
        'We will release audio samples from our model and the baseline checkpoints upon acceptance.'
    ]) {
        assert.equal(checkPromise(fp), 0, `R11 #6 FP must score 0: ${fp}`);
    }
    assert.equal(checkPromise('Our model that supports streaming will be publicly released.'), 0.5);

    // R11 #7: checkDemoPageForOpensource imagesrcset, data/ping attrs, ]-before-delimiter, and >4096-char href
    const r11DemoHtml = [
        '<link rel="preload" as="image" imagesrcset="https://github.com/org/spoof-imagesrcset 2x">',
        '<object data="https://github.com/org/spoof-obj)extra"></object>',
        '<a ping="https://github.com/org/spoof-ping)extra" href="https://example.org">x</a>',
        '<meta name="x" content="https://evil.com/a]b!https://github.com/org/spoof-bracket">',
        `<a href="https://evil.com/${'a'.repeat(4100)}!https://github.com/org/spoof-4100">x</a>`,
        '<p>Markdown [https://a.com](https://github.com/org/real-md-ok) and <a href="https://github.com/org/real-ok">ok</a></p>'
    ].join('\n');
    const r11Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r11DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r11Extracted, [
        'https://github.com/org/real-md-ok',
        'https://github.com/org/real-ok'
    ]);
});

test('Wave 8 R12 回归：#readme/?tab 尾撤回/徽章栏、HF collections 根键隔离、多URL前导与et al、prior-work 对比不误杀与多括号/修饰撤回、because自有资源、repoHostDemo/混合括号、被动prep+which/adverb与Demo长属性全收敛', async () => {
    const okVerify = async rawUrl => ({
        originalUrl: rawUrl, finalUrl: rawUrl, redirects: [], status: 200, availability: 'available', retryable: false
    });
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes, makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }), id, src
        ).dimensions.openSource.score;
    };

    // R12 #1: #fragment/?query repo URLs advance end past suffix for inline tail & badge-bar retraction
    for (const src of [
        'Our code is publicly available at https://github.com/org/repo#readme, which is currently private.',
        'Our code is publicly available at https://github.com/org/repo?tab=readme, which is currently private.',
        'Our code is publicly available at https://github.com/org/repo#readme but it is currently private.',
        'Our code is publicly available at https://github.com/org/repo#readme; however, it is currently private.',
        'Title\nAbstract\nGitHub: https://github.com/org/repo#readme | Code: private\n1 Introduction',
        'Title\nAbstract\nGitHub: https://github.com/org/repo?tab=readme | Code: coming soon\n1 Introduction'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'), ['third_party'], `R12 #1 ${src}`);
    }

    // R12 #2: HF collections use 3-segment root key so unrelated org collection does not kill validated_demo
    const idHfCol = await probe.buildApiReaderResourceIdentity(
        '## 开源详情\n无',
        'We compare against https://huggingface.co/collections/tencent/old-baseline (third-party).\nOur new model collection is hosted separately.',
        { discoveredLinks: ['https://huggingface.co/collections/tencent/wemm-video'] },
        { verifyUrlImpl: okVerify }
    );
    assert.deepEqual(idHfCol.resources.map(r => [r.type, r.origin, r.originalUrl]), [
        ['model', 'validated_demo', 'https://huggingface.co/collections/tencent/wemm-video']
    ]);

    // R12 #3: multi-URL lead clause retractions, bare-URL tails, compound-subject third-party, and et al. in elided locative
    for (const [src, url] of [
        ['Our code is publicly available at https://github.com/org/proj, our demo at https://org.github.io/demo, our model weights are currently private, and the weights at https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj'],
        ['Our code is publicly available at https://github.com/org/proj, https://github.com/org/proj2 (currently private), and the weights at https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj'],
        ['Our code is publicly available at https://github.com/org/proj and https://github.com/other/audioldm2 (third-party baseline), and the weights at https://huggingface.co/other/audioldm2.', 'https://huggingface.co/other/audioldm2'],
        ['Our code at https://github.com/org/proj and AudioLDM2 at https://github.com/other/audioldm2 are publicly available, and the weights at https://huggingface.co/other/audioldm2.', 'https://huggingface.co/other/audioldm2'],
        ['Our code is publicly available at https://github.com/org/proj, and the code of Whisper (Radford et al.) at https://github.com/openai/whisper.', 'https://github.com/openai/whisper']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R12 #3 ${src}`);
    }

    // R12 #4: prior-work contrast FPs preserved + double-paren, post-modifier, bare/verbless but, and paren-before-pipe retractions blocked
    assert.deepEqual(
        binding.paperSourceResourceFacets('Our code is publicly available at https://github.com/org/repo, while commercial systems are closed-source.', 'https://github.com/org/repo'),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('Our model is publicly available at https://huggingface.co/org/model, whereas most prior models remain closed-source.', 'https://huggingface.co/org/model'),
        ['model']
    );
    for (const src of [
        'Our code is available at https://github.com/org/repo (v1.0, MIT) (currently private).',
        'Our code is available at https://github.com/org/repo under the MIT license, which is currently private.',
        'Our code is available at https://github.com/org/repo under Apache 2.0 but it is currently private.',
        'Our code is available at https://github.com/org/repo but we do not release it.',
        'Our code is available at https://github.com/org/repo but currently private.',
        'Title\nAbstract\nGitHub: https://github.com/org/repo (v1.0) | Code: private\n1 Introduction'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'), ['third_party'], `R12 #4 ${src}`);
    }

    // R12 #5: because own-resource retraction kept, distilled from / comparing against prior-work stripped, ", which" FP preserved
    for (const [src, url, expected] of [
        ['Title\nAbstract\nWe provide a placeholder repo because our code is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nWe cannot release our model weights distilled from commercial models due to licensing.\nHugging Face: https://huggingface.co/org/model\n1 Introduction', 'https://huggingface.co/org/model', ['third_party']],
        ['Title\nAbstract\nWe will release our code comparing against existing speech models upon acceptance.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nWe evaluate our model on existing models, which remain closed-source and unavailable.\nHugging Face: https://huggingface.co/org/model\n1 Introduction', 'https://huggingface.co/org/model', ['model']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R12 #5 ${src}`);
    }

    // R12 #6: repoHostDemo retraction & mixed primary+hosted-platform parenthetical retraction
    assert.deepEqual(
        binding.paperSourceResourceFacets('Title\nAbstract\nOur repository and Hugging Face Space are currently private.\nProject page: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'),
        ['third_party']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('Our demo is available at https://myproj.github.io (currently private and ModelScope Studio is coming soon).', 'https://myproj.github.io'),
        ['third_party']
    );

    // R12 #7: passive prep+which / adverb-only relative body & our-lead baseline/fine-tuned coordination FPs
    for (const fp of [
        'Our model for which audio samples will be publicly released is described in Section 3.',
        'Our model with audio samples that soon will be publicly released is evaluated on LibriSpeech.',
        'We will release audio samples of our base model and our fine-tuned checkpoints upon acceptance.',
        'We will release qualitative samples of our model and our baseline implementation upon acceptance.'
    ]) {
        assert.equal(checkPromise(fp), 0, `R12 #7 FP must score 0: ${fp}`);
    }

    // R12 #8: slash-separated legitimate badge bars preserved
    assert.deepEqual(
        binding.paperSourceResourceFacets('Title\nAbstract\nProject page: https://myproj.github.io / GitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('Title\nAbstract\nCode: coming soon / Project page: https://myproj.github.io\n1 Introduction', 'https://myproj.github.io'),
        ['demo']
    );

    // R12 #9: checkDemoPageForOpensource Markdown label with words, unanchored MD spoof, and >-in-earlier-attr >4096-char href
    const r12DemoHtml = [
        '<p>Markdown [Demo at https://a.com](https://github.com/org/real-md-space)</p>',
        '<meta name="x" content="https://evil.com/go[https://a.com](https://github.com/org/spoof-md-inject)">',
        `<a title="a > b" href="https://evil.com/${'a'.repeat(4100)} https://github.com/org/spoof-gt-4100">x</a>`
    ].join('\n');
    const r12Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r12DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r12Extracted, ['https://github.com/org/real-md-space']);
});

test('Wave 8 R13 回归：/#readme/?tab 后缀、elided/lead 第三方归属与无URL子句、内联许可链/无动词撤回/demo内联、because/distilled+which、HF Spaces repoHostDemo、被动whose/多词副词与单引号MD注入全收敛', async () => {
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes,
            makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }),
            id,
            src
        ).dimensions.openSource.score;
    };

    // R13 #1: advanceEndPastUrlSuffix handles /#readme and /?tab=readme
    for (const src of [
        'Our code is publicly available at https://github.com/org/repo/#readme, which is currently private.',
        'Our code is publicly available at https://github.com/org/repo/?tab=readme, which is currently private.',
        'Our code is publicly available at https://github.com/org/repo/#readme but it is currently private.',
        'Our code is publicly available at https://github.com/org/repo/?tab=readme; however, it is currently private.'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'), ['third_party'], `R13 #1 ${src}`);
    }
    assert.equal(
        binding.paperSourceResourceQuote('Title\nAbstract\nGitHub (https://github.com/org/repo/#readme)\n1 Introduction', 'https://github.com/org/repo'),
        'GitHub (https://github.com/org/repo/#readme)'
    );

    // R13 #2: post-facet third-party attribution, citations, and URL-less third-party clauses after URL1
    for (const [src, url] of [
        ['Our code is publicly available at https://github.com/org/proj, and the code of Whisper at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['Our code is publicly available at https://github.com/org/proj, and the code of Whisper [12] at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['Our code at https://github.com/org/proj and the code of AudioLDM2 at https://github.com/other/audioldm2 are publicly available, and the weights at https://huggingface.co/other/audioldm2.', 'https://huggingface.co/other/audioldm2'],
        ['Our code is publicly available at https://github.com/org/proj, AudioLDM2 is open-source, and the weights at https://huggingface.co/haoheliu/AudioLDM2.', 'https://huggingface.co/haoheliu/AudioLDM2'],
        ['Our code is publicly available at https://github.com/org/proj, our demo at https://org.github.io/demo, AudioLDM2 is open-source, and the weights at https://huggingface.co/haoheliu/AudioLDM2.', 'https://huggingface.co/haoheliu/AudioLDM2'],
        ['Our code is publicly available at https://github.com/org/proj, where AudioLDM2 is open-source, and the weights at https://huggingface.co/haoheliu/AudioLDM2.', 'https://huggingface.co/haoheliu/AudioLDM2']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R13 #2 ${src}`);
    }

    // R13 #3: Apache License 2.0, chained modifiers, verbless negation/deferral, and/which prior-work PP, and authorFirstPartyDemoQuote inline retraction
    for (const [src, url] of [
        ['Our code is available at https://github.com/org/repo under Apache License 2.0, which is currently private.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo under the MIT license for non-commercial use, which is currently private.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo but not yet released.', 'https://github.com/org/repo'],
        ['Our code is available at https://github.com/org/repo but to be released upon acceptance.', 'https://github.com/org/repo'],
        ['Our code is publicly available at https://github.com/org/repo, and our code for evaluating existing speech models is currently private.', 'https://github.com/org/repo'],
        ['Our code is publicly available at https://github.com/org/repo, which is currently private for evaluating existing speech models.', 'https://github.com/org/repo'],
        ['Full videos for all sequences are on the project page at https://kyutai.org/aura/, which is currently private.', 'https://kyutai.org/aura/'],
        ['Full videos for all sequences are on the project page at https://kyutai.org/aura/ (coming soon).', 'https://kyutai.org/aura/']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R13 #3 ${src}`);
    }

    // R13 #4: because/since own-resource vs third-party, distilled/evaluating + relative clause
    for (const [src, url, expected] of [
        ['Title\nAbstract\nWe provide a placeholder repo because the code is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nWe provide a placeholder repo since we cannot release the code yet.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nWe build our model because they are closed-source and our code is publicly available.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nWe cannot release our model weights distilled from commercial models, which are proprietary.\nHugging Face: https://huggingface.co/org/model\n1 Introduction', 'https://huggingface.co/org/model', ['third_party']],
        ['Title\nAbstract\nWe will release our code for evaluating existing speech models that are widely used upon acceptance.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R13 #4 ${src}`);
    }

    // R13 #5: HF Spaces / ModelScope Studios repoHostDemo=false + bounded hosted-platform clause replacement
    for (const [src, url, expected] of [
        ['Our demo is publicly available at https://huggingface.co/spaces/org/demo.\nOur GitHub repository will be released upon acceptance.', 'https://huggingface.co/spaces/org/demo', ['demo']],
        ['Title\nAbstract\nProject page: https://huggingface.co/spaces/org/demo\nOur GitHub repository will be released upon acceptance.\n1 Introduction', 'https://huggingface.co/spaces/org/demo', ['demo']],
        ['Our demo is publicly available at https://modelscope.cn/studios/org/demo.\nOur GitHub repository will be released upon acceptance.', 'https://modelscope.cn/studios/org/demo', ['demo']],
        ['Our demo is available at https://myproj.github.io (ModelScope Studio is coming soon and it is currently private).', 'https://myproj.github.io', ['third_party']],
        ['Our demo is available at https://myproj.github.io (ModelScope Studio: coming soon and currently private).', 'https://myproj.github.io', ['third_party']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R13 #5 ${src}`);
    }

    // R13 #6: passive multi-word adverbial that, whose, upon/against which FPs rejected
    for (const fp of [
        'Our model with audio samples that upon acceptance will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that in the future will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that after publication will be publicly released is evaluated on LibriSpeech.',
        'Our model, whose audio samples will be publicly released, is described in Section 3.',
        'Our model, upon which qualitative demos will be publicly released, is described in Section 3.',
        'Our model, against which qualitative demos will be publicly released, is described in Section 3.'
    ]) {
        assert.equal(checkPromise(fp), 0, `R13 #6 FP must score 0: ${fp}`);
    }
    assert.equal(checkPromise('Our model, whose code will be publicly released, is described in Section 3.'), 0.5);

    // R13 #7: repoBadge rejects third-party parenthesized citations/orgs before GitHub:
    for (const [src, url] of [
        ['Title\nAbstract\nWhisper (OpenAI) GitHub: https://github.com/openai/whisper\n1 Introduction', 'https://github.com/openai/whisper'],
        ['Title\nAbstract\nAudioLDM (Liu, 2023) GitHub: https://github.com/other/audioldm2\n1 Introduction', 'https://github.com/other/audioldm2']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R13 #7 ${src}`);
    }

    // R13 #8: single-quote inside double-quoted non-URL attribute cannot trigger isMarkdownLinkOpen spoof bypass
    const r13DemoHtml = `<meta name="x" content="https://evil.com/go'[https://a.com](https://github.com/org/spoof-sq-md)">`;
    const r13Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r13DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r13Extracted, []);
});

test('Wave 8 R14 回归：不可用/闭源标签与徽章行内撤回、PDF换行与多子句隔离、有界从句回退、后置第三方/分句校验、托管平台与被动/Demo属性收口', async () => {
    const checkPromise = src => {
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(src), resources: [] };
        const id = { ...body, identitySha256: probe.stableFingerprint(body) };
        const noRes = '## 机器摘要\nhas_code: 否\nhas_model: 否\nhas_dataset: 否\n\n## 开源详情\n未核实当前资源可用。';
        return scoring.validateScoringAuditAgainstAnalysis(
            noRes, makeAudit({ openSource: 0, documentType: '方法研究', multiComponentClaimed: false, ablationStatus: 'not_applicable' }), id, src
        ).dimensions.openSource.score;
    };

    // R14 #1: unavailable/unreleased/closed-source/proprietary in verbless inline & badge retractions + badge calling hasInlineTailRetraction
    for (const [src, url, expected] of [
        ['Our code is available at https://github.com/org/repo but currently unavailable.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo but unreleased.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo, currently unavailable.', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo | Code: unavailable\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo | Code: unreleased\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo | Code: closed-source\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nCode: unavailable\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo; however, not yet released.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo, though not yet released.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo, although not yet available.', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo, which is proprietary.\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo (proprietary)\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo under the MIT license for non-commercial academic research use, which is currently private.\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Unlike closed-source models, our code is publicly available at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['Unlike proprietary models, our code is publicly available at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R14 #1 ${src}`);
    }

    // R14 #2: PDF single-newline wrap, multi-clause inline tail isolation (FN + FP), decimal v0.1, prior-work rel facetText
    for (const [src, url, expected] of [
        ['Our code is publicly available at https://github.com/org/repo,\nwhich is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo\nbut it is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Full videos for all sequences are on the project page at https://kyutai.org/aura/\n(currently private).', 'https://kyutai.org/aura/', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo, which is currently private, and our model weights are publicly available.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo, which provides the implementation, while our model weights are currently private.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo, which is currently private for evaluating existing speech models that are widely used.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is available at https://github.com/org/repo, currently at v0.1 and not yet released.', 'https://github.com/org/repo', ['third_party']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R14 #2 ${src}`);
    }

    // R14 #3: bounded PRIOR_WORK_PREP_MOD_WITH_REL_RE & SUBORDINATE_REL_PRIOR_WORK_RE + mixed because subclauses
    for (const [src, url] of [
        ['Title\nAbstract\nOur code for evaluating existing speech models that are widely used will be released upon acceptance.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur model weights distilled from commercial models, which are proprietary, are currently private.\nHugging Face: https://huggingface.co/org/model\n1 Introduction', 'https://huggingface.co/org/model'],
        ['Title\nAbstract\nWe provide a placeholder repo because existing models are closed-source and our code is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nWe provide a placeholder repo because our code for evaluating existing speech models that are widely used is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo'],
        ['Title\nAbstract\nOur code for benchmarks where existing models fail is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R14 #3 ${src}`);
    }

    // R14 #4: URL-less lead split, classifySingleClauseFirstPartyFacets post-facet third-party, appositive/for/paren proper nouns, #readme/#code-and-data, Apache License 2.0, trailing-slash paren badge
    for (const [src, url, expected] of [
        ['Our code is open-source, and AudioLDM2 is at https://github.com/other/audioldm2, and the weights at https://huggingface.co/other/audioldm2.', 'https://huggingface.co/other/audioldm2', ['third_party']],
        ['Our code is publicly available at https://github.com/org/proj, our demo is open-source, and AudioLDM2 is at https://github.com/other/audioldm2, and the weights at https://huggingface.co/other/audioldm2.', 'https://huggingface.co/other/audioldm2', ['third_party']],
        ['Our code is publicly available at https://github.com/org/proj, and the code of Whisper [12] is available at https://github.com/openai/whisper.', 'https://github.com/openai/whisper', ['third_party']],
        ['The code of Whisper is publicly available at https://github.com/openai/whisper, and the weights at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['Our code is publicly available at https://github.com/org/proj, the model of Whisper [12] is publicly available, and the weights at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['Our code is publicly available at https://github.com/org/proj, and the code for Whisper at https://github.com/openai/whisper.', 'https://github.com/openai/whisper', ['third_party']],
        ['Our code is publicly available at https://github.com/org/proj, and the weights of the official Whisper model at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['Our code is publicly available at https://github.com/org/proj, and the model AudioLDM2 at https://huggingface.co/haoheliu/AudioLDM2.', 'https://huggingface.co/haoheliu/AudioLDM2', ['third_party']],
        ['Our code is publicly available at https://github.com/org/proj, and the weights (AudioLDM2) at https://huggingface.co/haoheliu/AudioLDM2.', 'https://huggingface.co/haoheliu/AudioLDM2', ['third_party']],
        ['The benchmark is publicly available at https://huggingface.co/datasets/org/bench, and the code at https://github.com/org/proj/#readme.', 'https://github.com/org/proj', ['code']],
        ['The benchmark is publicly available at https://huggingface.co/datasets/org/bench, and the code at https://github.com/org/proj#readme.', 'https://github.com/org/proj', ['code']],
        ['Our code is publicly available at https://github.com/org/repo#code-and-data.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/proj, https://github.com/org/proj2 under Apache License 2.0, and the weights at https://huggingface.co/org/proj.', 'https://huggingface.co/org/proj', ['model']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), expected, `R14 #4 ${src}`);
    }
    assert.equal(
        binding.paperSourceResourceQuote('Title\nAbstract\nGitHub (https://github.com/org/repo/)\n1 Introduction', 'https://github.com/org/repo'),
        'GitHub (https://github.com/org/repo/)'
    );

    // R14 #5: isHostedDemoPlatformMismatch preserves coordinated retraction verbs & negations
    for (const src of [
        'Our demo is available at https://myproj.github.io (ModelScope Studio is coming soon and is currently private).',
        'Our demo is available at https://myproj.github.io (ModelScope Studio is coming soon and remains private).',
        'Our demo is available at https://myproj.github.io (ModelScope Studio is coming soon and will not be released).',
        'Our demo is available at https://myproj.github.io (ModelScope Studio is coming soon and cannot be accessed).',
        'Our demo is available at https://myproj.github.io (ModelScope Studio: coming soon and not publicly available).',
        'Our demo is available at https://myproj.github.io (ModelScope Studio: coming soon and currently unavailable).'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://myproj.github.io'), ['third_party'], `R14 #5 ${src}`);
    }

    // R14 #6: passive finite-verb relative clause requirement, non-blind `, which ...,` stripping, and showcase gerunds
    for (const fp of [
        'Our model with audio samples that very soon will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that once approved will be publicly released is evaluated on LibriSpeech.',
        'Our model, which produces qualitative demos that, in Appendix A, will be publicly released, is evaluated in Section 4.',
        'Our model, which produces audio samples that, for reproducibility, will be publicly released, achieves SOTA.',
        'Our model with audio samples, which also, in Appendix A, will be publicly released, is evaluated on LibriSpeech.',
        'We will release audio demos showcasing our model.',
        'We will release audio demos illustrating our model.',
        'We will release audio demos demonstrating our model.',
        'We will release audio demos to showcase our model.'
    ]) {
        assert.equal(checkPromise(fp), 0, `R14 #6 FP must score 0: ${fp}`);
    }

    // R14 #7: checkDemoPageForOpensource blocks =' / =" inside URLs & " inside single-quoted attrs while allowing valid attr md link
    const r14DemoHtml = [
        `<meta name="x" content="https://evil.com/go='[https://a.com](https://github.com/org/spoof-eq-sq)">`,
        `<meta name="x" content='https://evil.com/go="[https://a.com](https://github.com/org/spoof-eq-dq)'>`,
        `<meta name="x" content='https://evil.com/go"https://github.com/org/spoof-dq-sp '>`,
        `<meta name="x" content='https://evil.com/go"!https://github.com/org/spoof-dq-bang '>`,
        `<meta name="x" content="[Demo](https://github.com/org/real-md-attr)">`
    ].join('\n');
    const r14Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r14DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r14Extracted, ['https://github.com/org/real-md-attr']);
});

test('Wave 8 R15 回归：徽章无动词否定/独立块内联撤回、指代从句/prior-work 协调动词、后置引文与多子句/多URL第三方、托管平台、主被动连字符/动词形态与 validated_demo 防复活', async () => {
    // R15 #1: badge verbless negations, pre-verb adverbs/tags in inlineConjunctionClauseRe & singleModPat, standaloneReleaseBlockMatch inline tail
    for (const src of [
        'Title\nAbstract\nGitHub: https://github.com/org/repo | Code: not yet released\n1 Introduction',
        'Title\nAbstract\nCode: not yet released\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nGitHub: https://github.com/org/repo | Code (not yet released)\n1 Introduction',
        'Our code is available at https://github.com/org/repo but unfortunately not yet released.',
        'Our code is available at https://github.com/org/repo but it currently remains private.',
        'Our code is available at https://github.com/org/repo but placeholder.',
        'Our code is available at https://github.com/org/repo, but restricted.',
        'Our code is publicly available at https://github.com/org/repo for non-commercial use only, which is currently private.',
        'Our code is publicly available at https://github.com/org/repo for research purposes, which is currently private.',
        'We publicly release our evaluation code.\nhttps://github.com/org/repo\n(currently private)',
        'We publicly release our evaluation code.\nhttps://github.com/org/repo\nbut it is currently private.'
    ]) {
        assert.deepEqual(
            binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'),
            ['third_party'],
            `R15 #1 expected third_party: ${src}`
        );
    }

    // R15 #2: hasInlineTailRetraction anaphoric which/it/they without cross-facet cancellation + though/although/yet splits
    for (const src of [
        'Our code is publicly available at https://github.com/org/repo, which is currently private due to model safety.',
        'Our code is publicly available at https://github.com/org/repo, which is not yet released for dataset privacy.',
        'Our code is publicly available at https://github.com/org/repo, though it is currently private.',
        'Our code is publicly available at https://github.com/org/repo, although currently private.',
        'Our code is publicly available at https://github.com/org/repo, yet not yet released.'
    ]) {
        assert.deepEqual(
            binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'),
            ['third_party'],
            `R15 #2 expected third_party: ${src}`
        );
    }

    // R15 #3: prior-work coordinated relative clauses preserved; main-clause retraction verbs & compound/anaphoric because clauses caught
    for (const src of [
        'Title\nAbstract\nOur model addresses the gap where existing models are proprietary and unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction',
        'Title\nAbstract\nOur model improves on existing speech models that are proprietary and remain unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction'
    ]) {
        assert.deepEqual(
            binding.paperSourceResourceFacets(src, 'https://huggingface.co/org/our-model'),
            ['model'],
            `R15 #3 FP expected model: ${src}`
        );
    }
    for (const src of [
        'Title\nAbstract\nOur code for evaluating existing speech models that are widely used is under review.\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nOur code for benchmarks where existing models fail is coming soon.\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nOur code for evaluating existing speech models that are widely used will soon be released.\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nOur code is not yet released because our model weights are under review.\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nWe provide a placeholder repo because our code and weights are not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nWe provide a placeholder repo for our code because it is not yet released.\nGitHub: https://github.com/org/repo\n1 Introduction'
    ]) {
        assert.deepEqual(
            binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'),
            ['third_party'],
            `R15 #3 FN expected third_party: ${src}`
        );
    }

    // R15 #4: post-verb citations/attribution, unsplit named third-party clauses, URL-less tail clauses & multi-URL parts[0]
    for (const [src, url] of [
        ['The code is publicly available at https://github.com/openai/whisper [12].', 'https://github.com/openai/whisper'],
        ['The code is publicly available at https://github.com/openai/whisper (Smith, 2023).', 'https://github.com/openai/whisper'],
        ['The model weights are publicly available from OpenAI at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper'],
        ['The code is released by OpenAI at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['The code and AudioLDM2 are publicly available at https://github.com/other/audioldm2.', 'https://github.com/other/audioldm2'],
        ['Our code is publicly available, and Whisper is hosted at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['We release our model, and AudioLDM2 is available at https://github.com/haoheliu/AudioLDM2.', 'https://github.com/haoheliu/AudioLDM2'],
        ['Our code is publicly available at https://github.com/org/proj, and our demo is open-source, and AudioLDM2 is open-source, and the weights at https://huggingface.co/haoheliu/AudioLDM2.', 'https://huggingface.co/haoheliu/AudioLDM2'],
        ['Our code at https://github.com/org/proj, AudioLDM2 at https://github.com/other/audioldm2 are publicly available, and our demo at https://org.github.io/demo, and the weights at https://huggingface.co/other/audioldm2.', 'https://huggingface.co/other/audioldm2']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R15 #4 expected third_party: ${src}`);
    }

    // R15 #5: isHostedDemoPlatformMismatch determiners & coordinated/slash retractions
    for (const src of [
        'Title\nAbstract\nProject page: https://myproj.github.io\nThe Hugging Face Space is coming soon.\n1 Introduction',
        'Our demo is available at https://myproj.github.io (the ModelScope Studio is coming soon).'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://myproj.github.io'), ['demo'], `R15 #5 FP: ${src}`);
    }
    for (const src of [
        'Title\nAbstract\nProject page: https://myproj.github.io\nModelScope Studio is coming soon yet is currently private.\n1 Introduction',
        'Our demo is available at https://myproj.github.io (ModelScope Studio is coming soon and may be released later).',
        'Our demo is available at https://myproj.github.io (ModelScope Studio is coming soon / currently private).'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://myproj.github.io'), ['third_party'], `R15 #5 FN: ${src}`);
    }

    // R15 #6: scoring-audit-contract passive relative verb morphology, compound-adjective & active relative/gerund guards
    const checkPromise = text => Boolean(scoring.sourceReleasePromise(text, {
        sourceTextSha256: crypto.createHash('sha256').update(text).digest('hex')
    }));
    for (const valid of [
        'Our code, which implements our method, will be publicly released.',
        'Our dataset, which spans 50 languages, will be publicly released.',
        'Our benchmark that measures audio reasoning will be publicly released.'
    ]) {
        assert.equal(checkPromise(valid), true, `R15 #6 FN: ${valid}`);
    }
    for (const invalid of [
        'We will release model-generated audio samples upon acceptance.',
        'Model-generated audio samples will be publicly released.',
        'Our model, whose audio demos showcasing our model will be publicly released, is described in Section 3.',
        'We will release qualitative examples where our model outperforms baselines.',
        'We will release a demo page that runs our model.',
        'Our model with audio samples that as is shown in Table 1 will be publicly released is evaluated on LibriSpeech.'
    ]) {
        assert.equal(checkPromise(invalid), false, `R15 #6 FP: ${invalid}`);
    }

    // R15 #7: checkDemoPageForOpensource quote-aware = spoofs, unquoted =" / :" / ," spoofs, and single-quoted JSON attrs
    const r15DemoHtml = [
        `<meta name="x" content="https://evil.com/go'a=https://github.com/org/spoof-sq-eq">`,
        `<meta name="x" content='https://evil.com/go"a=https://github.com/org/spoof-dq-eq '>`,
        `<p>https://evil.com/go="https://github.com/org/spoof-eq-dq</p>`,
        `<p>https://evil.com/go:"https://github.com/org/spoof-colon-dq</p>`,
        `<p>https://evil.com/go,"https://github.com/org/spoof-comma-dq</p>`,
        `<meta name="x" content='"https://evil.com/go"foo"https://github.com/org/spoof-quoted-foo'>`,
        `<div data-config='{"url":"https://example.com","repo":"https://github.com/org/real-sq-json"}'>`
    ].join('\n');
    const r15Extracted = await probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(r15DemoHtml, 'utf8')
        })
    });
    assert.deepEqual(r15Extracted, ['https://github.com/org/real-sq-json']);

    // R15 #8: buildApiReaderResourceIdentity blocks validated_demo resurrection on inline-tail & preceding-badge retractions
    const okVerify = async u => ({
        originalUrl: u, finalUrl: u, redirects: [], status: 200, availability: 'available', retryable: false
    });
    for (const src of [
        'Our code is publicly available at https://github.com/org/repo (placeholder).',
        'Our code is publicly available at https://github.com/org/repo (private).',
        'Title\nAbstract\nCode: private\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Title\nAbstract\nCode: private | GitHub: https://github.com/org/repo\n1 Introduction'
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            '## 开源详情\n无',
            src,
            { discoveredLinks: ['https://github.com/org/repo'] },
            { verifyUrlImpl: okVerify }
        );
        assert.deepEqual(
            id.resources.map(r => [r.type, r.origin]),
            [['third_party', 'paper_source']],
            `R15 #8 resurrection blocked: ${src}`
        );
    }
});

test('Wave 8 R16 回归：单引号链接恢复与HTML欺骗拦截、validated_demo 跨facet/第三方阻断、行内他主语保留、真语料第三/第一方修复与承诺误报收紧', async () => {
    // R16 #1: single-quoted href/JS restored + </>/single-quoted JSON spoofs blocked
    const runHtml = html => probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(html, 'utf8')
        })
    });
    assert.deepEqual(await runHtml(`<a href='https://github.com/org/real-sq-href'>Code</a>`), ['https://github.com/org/real-sq-href']);
    assert.deepEqual(await runHtml(`<a href='https://huggingface.co/org/real-sq-model'>Model</a>`), ['https://huggingface.co/org/real-sq-model']);
    assert.deepEqual(await runHtml(`<script>const c={'a':'https://example.com','b':'https://github.com/org/real-js-sq'};</script>`), ['https://github.com/org/real-js-sq']);
    assert.deepEqual(await runHtml(`<script>const a=['https://example.com','https://github.com/org/real-js-sq-arr'];</script>`), ['https://github.com/org/real-js-sq-arr']);
    assert.deepEqual(await runHtml(`<meta name="x" content="https://evil.com/go>https://github.com/org/spoof-gt">`), []);
    assert.deepEqual(await runHtml(`<meta name="x" content="https://evil.com/go<https://github.com/org/spoof-lt">`), []);
    assert.deepEqual(await runHtml(`<div data-x='{"a":"https://evil.com/go"x:"https://github.com/org/spoof-4"}'>`), []);
    assert.deepEqual(await runHtml(`<meta name="x" content='/redirect"x:"https://github.com/org/spoof-1 '>`) , []);

    // R16 #2: cross-facet retraction & explicit third-party citations/colon-headings blocked from validated_demo resurrection
    const okVerify = async u => ({
        originalUrl: u, finalUrl: u, redirects: [], status: 200, availability: 'available', retryable: false
    });
    for (const [src, url] of [
        ['Our dataset is publicly available at https://github.com/org/my-bench. ' + 'We evaluate our method on standard audio tasks. '.repeat(4) + '\nHowever, our dataset is currently private.', 'https://github.com/org/my-bench'],
        ['Title\nAbstract\nProject page: https://github.com/org/my-demo\n' + 'We evaluate our method on standard audio tasks. '.repeat(4) + '\nHowever, our demo is currently private.\n1 Introduction', 'https://github.com/org/my-demo'],
        ['Our dataset is publicly available at https://github.com/org/my-bench (covering English, Mandarin, French, German, Spanish, Japanese, and Korean speech benchmarks), while our dataset is private.', 'https://github.com/org/my-bench'],
        ['Whisper (Radford et al., 2023) is publicly available at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['The code of Whisper [12] is publicly available at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['The code is released by OpenAI at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['Title\nAbstract\nAudioLDM2:\nGitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2']
    ]) {
        const id = await probe.buildApiReaderResourceIdentity(
            '## 开源详情\n无',
            src,
            { discoveredLinks: [url] },
            { verifyUrlImpl: okVerify }
        );
        assert.deepEqual(id.resources.map(r => [r.type, r.origin]), [['third_party', 'paper_source']], `R16 #2: ${src.slice(0, 80)}`);
    }

    // R16 #3: inline tail coordinated predicates & anaphoric they on other subjects do not kill our code
    for (const src of [
        'Our code is publicly available at https://github.com/org/repo, whereas existing models are closed-source and unavailable.',
        'Our code is publicly available at https://github.com/org/repo, while commercial systems are proprietary and closed-source.',
        'Our code is publicly available at https://github.com/org/repo, while our model weights are currently private and will be released upon acceptance.',
        'Our code is publicly available at https://github.com/org/repo, while our dataset is under review and not yet released.',
        'Our code is publicly available at https://github.com/org/repo, while our model weights remain private and are not yet released.',
        'Our code is publicly available at https://github.com/org/repo, while our model weights are under review, though they will be released upon acceptance.'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'), ['code'], `R16 #3: ${src}`);
    }

    // R16 #4: internal only, placeholder prose, parenthesized badge trailing period
    for (const src of [
        'Title\nAbstract\nCode: (not yet released).\nGitHub: https://github.com/org/repo\n1 Introduction',
        'Our code is publicly available at https://github.com/org/repo (internal only).',
        'Title\nAbstract\nGitHub: https://github.com/org/repo | Code: internal only\n1 Introduction',
        'Title\nAbstract\nOur repository is currently a placeholder.\nGitHub: https://github.com/org/repo\n1 Introduction'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'), ['third_party'], `R16 #4: ${src}`);
    }

    // R16 #5: adverb after and in prior-work relative clauses, because we cannot release it yet, leading Since/Because, bare baselines
    for (const [src, url, exp] of [
        ['Title\nAbstract\nOur model improves on existing speech models that are proprietary and still remain unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nOur model improves on existing speech models that are proprietary and still cannot be accessed.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nOur model addresses the gap where existing models are proprietary and still remain unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nWe provide a placeholder repo for our code because we cannot release it yet.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nSince our code is not yet released, we provide a placeholder repo.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nBecause our code is currently private, we share an empty repo.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nOur models outperform baselines because they are closed-source and unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nOur code and model address prior work because existing models are expensive and they are currently unavailable.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), exp, `R16 #5: ${src}`);
    }

    // R16 #6: real-corpus third-party patterns, parenthesized/license citations, on/with proper nouns, named clauses, newline bleed & first-party FNs
    for (const [src, url] of [
        ['We evaluate three open-source models, Qwen2.5-Omni-3B at https://huggingface.co/Qwen/Qwen2.5-Omni-3B.', 'https://huggingface.co/Qwen/Qwen2.5-Omni-3B'],
        ['We also used the following publicly released pretrained models: https://huggingface.co/microsoft/wavlm-large.', 'https://huggingface.co/microsoft/wavlm-large'],
        ['We partitioned the dataset into training, validation, and test sets according to Guideline from the open-source VITS repository at https://github.com/jaywalnut310/vits/tree/main.', 'https://github.com/jaywalnut310/vits/tree/main'],
        ['The checkpoints made available by the authors are used at https://github.com/sp-uhh/sgmse.', 'https://github.com/sp-uhh/sgmse'],
        ['Original recordings and public metadata are available from the Speech Accent Archive (https://accent.gmu.edu/).', 'https://accent.gmu.edu/'],
        ['The code is publicly available at (https://github.com/openai/whisper) [12].', 'https://github.com/openai/whisper'],
        ['The code is publicly available at (https://github.com/openai/whisper) (Smith, 2023).', 'https://github.com/openai/whisper'],
        ['The code is publicly available at https://github.com/openai/whisper under MIT [12].', 'https://github.com/openai/whisper'],
        ["The code is publicly available on OpenAI's GitHub at https://github.com/openai/whisper.", 'https://github.com/openai/whisper'],
        ["The model weights are hosted on Meta's Hugging Face at https://huggingface.co/meta-llama/Llama-3.", 'https://huggingface.co/meta-llama/Llama-3'],
        ["Our code is publicly available at https://github.com/org/proj, and the code on OpenAI's GitHub at https://github.com/openai/whisper.", 'https://github.com/openai/whisper'],
        ['Our code is publicly available, and Whisper can be found at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['We release our model, and AudioLDM2 can be accessed at https://github.com/haoheliu/AudioLDM2.', 'https://github.com/haoheliu/AudioLDM2'],
        ["Our code is publicly available, and OpenAI's Whisper is hosted at https://github.com/openai/whisper.", 'https://github.com/openai/whisper'],
        ['Our code is publicly available, and Qwen2-Audio (7B) is hosted at https://huggingface.co/Qwen/Qwen2-Audio-7B.', 'https://huggingface.co/Qwen/Qwen2-Audio-7B'],
        ['Our code is publicly available, and Whisper has open-source weights at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper']
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), ['third_party'], `R16 #6 TP: ${src}`);
    }
    assert.deepEqual(
        binding.paperSourceResourceFacets('Project code is available at https://github.com/org/proj Index Terms—Large audio language models', 'https://github.com/org/proj'),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('Demo is available at\nhttps://org.github.io/demo/\nIntroduction\nRecent advances (Chen et al., 2024).', 'https://org.github.io/demo/'),
        ['demo']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('The inference code is publicly available at https://github.com/upskyy/komos and the trained model at https://huggingface.co/upskyy/komos.', 'https://github.com/upskyy/komos'),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('The inference code is publicly available at https://github.com/upskyy/komos and the trained model at https://huggingface.co/upskyy/komos.', 'https://huggingface.co/upskyy/komos'),
        ['model']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('Codes and pre-trained weights are available at https://github.com/Andong-Li-speech/BiVoC.', 'https://github.com/Andong-Li-speech/BiVoC'),
        ['code', 'model']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('An online demo is available at https://cyclespeech.github.io.', 'https://cyclespeech.github.io'),
        ['demo']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('The code for data preprocessing and AAD analyses is available at GitHub: https://github.com/Mashirops/sound-bubble-eeg-code.', 'https://github.com/Mashirops/sound-bubble-eeg-code'),
        ['code']
    );

    // R16 #7: isHostedDemoPlatformMismatch pipe | and also
    for (const src of [
        'Our demo is available at https://myproj.github.io (ModelScope Studio: coming soon | currently private).',
        'Title\nAbstract\nProject page: https://myproj.github.io\nModelScope Studio is coming soon | currently private.\n1 Introduction',
        'Title\nAbstract\nProject page: https://myproj.github.io\nModelScope Studio is coming soon and also currently private.\n1 Introduction'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://myproj.github.io'), ['third_party'], `R16 #7: ${src}`);
    }

    // R16 #8: scoring-audit-contract non-restrictive relative, subordinating conj, attribution/adverb, to run/running, prefix-hyphen compounds
    const checkPromise = text => Boolean(scoring.sourceReleasePromise(text, {
        sourceTextSha256: crypto.createHash('sha256').update(text).digest('hex')
    }));
    for (const invalid of [
        'We will release qualitative examples, where our model outperforms baselines.',
        'We will release a demo page, which showcases our model.',
        'We will release audio samples, which our model generates.',
        'We will release a project page, where our model can be tested.',
        'We will release an interactive website, which runs our model.',
        'Our model with audio samples that although it is large will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that because it is compact will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that provided it is approved will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples, which the paper claims will be publicly released, is evaluated on LibriSpeech.',
        'Our model with audio samples that we confirmed will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that the authors promised will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that afterwards quickly will be publicly released is evaluated on LibriSpeech.',
        'We will release a demo page to run our model.',
        'We will release a web interface running our model.',
        'We will release cross-dataset generalization analysis upon acceptance.',
        'We will release per-model error breakdown upon acceptance.',
        'We will release pseudo-code in Appendix A.'
    ]) {
        assert.equal(checkPromise(invalid), false, `R16 #8 FP: ${invalid}`);
    }
});

test('Wave 8 R17 回归：GitHub脚注/codebase修复、大小写敏感换行截断、单引号JSON词法器、跨facet与具名标签防复活、他主语逗号谓词与前置从句、真实语料防漏与评分承诺收敛', async () => {
    // R17 #1: GitHub11/Github.33 footnote-glued hosts & codebase
    assert.deepEqual(
        binding.paperSourceResourceFacets('The code is released under AGPLv3 on GitHub22\n 2\n https://github.com/TheBv/faces-dataset-pre-study', 'https://github.com/TheBv/faces-dataset-pre-study'),
        ['code']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('The dataset, code, and evaluation criterion are publicly available on Github.33\n 3\n https://github.com/dhanunjaya-varma/AVSD-Scenes.git', 'https://github.com/dhanunjaya-varma/AVSD-Scenes.git'),
        ['code', 'dataset']
    );
    assert.deepEqual(
        binding.paperSourceResourceFacets('We make our codebase openly available on GitHub33\n 3\n https://github.com/dmbdpt/asr-unlearning-evaluation', 'https://github.com/dmbdpt/asr-unlearning-evaluation'),
        ['code']
    );

    // R17 #2: case-sensitive afterSectionOrCaptionBreak keeps wrapped prose citations intact
    for (const s of [
        'The code is publicly available at https://github.com/openai/whisper in\n2024 by OpenAI [12].',
        'The code is publicly available at https://github.com/openai/whisper for\nexperiments by Smith et al. (2023).',
        'The code is publicly available at https://github.com/openai/whisper on\n15 benchmarks [12].'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(s, 'https://github.com/openai/whisper'), ['third_party'], `R17 #2: ${s}`);
    }

    // R17 #3: checkDemoPageForOpensource single-quoted JSON lexer & unquoted quote-sandwiched spoofs
    const runHtml = html => probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(html, 'utf8')
        })
    });
    assert.deepEqual(await runHtml(`<div data-config='{"links":["https://github.com/org/real"]}'>`), ['https://github.com/org/real']);
    assert.deepEqual(await runHtml(`<div data-config='[["https://github.com/org/real"]]'>`), ['https://github.com/org/real']);
    assert.deepEqual(await runHtml(`<div data-config='{"a":"https://evil.com/go,"https://github.com/org/spoof"}'>`), []);
    assert.deepEqual(await runHtml(`<div data-config='{"a":"https://evil.com/go{"k":"https://github.com/org/spoof"}'>`), []);
    assert.deepEqual(await runHtml(`<script>const x=['https://evil.com/go'https://github.com/org/spoof'];</script>`), []);
    assert.deepEqual(await runHtml(`<p>https://evil.com/go"foo"https://github.com/org/spoof</p>`), []);
    assert.deepEqual(await runHtml(`<p>https://evil.com/go'foo'https://github.com/org/spoof</p>`), []);

    // R17 #4: standalone/post-URL cross-facet retraction & named third-party badges blocked from validated_demo resurrection
    const okVerify = async u => ({
        originalUrl: u, finalUrl: u, redirects: [], status: 200, availability: 'available', retryable: false
    });
    for (const [src, url] of [
        ['We publicly release our benchmark dataset.\nhttps://github.com/org/my-bench\n' + 'We evaluate our method on standard audio tasks. '.repeat(4) + '\nHowever, our dataset is currently private.', 'https://github.com/org/my-bench'],
        ['At https://github.com/org/my-bench we host our dataset. ' + 'We evaluate our method on standard audio tasks. '.repeat(4) + '\nHowever, our dataset is currently private.', 'https://github.com/org/my-bench'],
        ['Title\nAbstract\nAudioLDM2 GitHub: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\n- AudioLDM2: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nAudioLDM 2: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nWhisper (https://github.com/openai/whisper)\n1 Introduction', 'https://github.com/openai/whisper']
    ]) {
        const id = await probe.buildApiReaderResourceIdentity('## 开源详情\n无', src, { discoveredLinks: [url] }, { verifyUrlImpl: okVerify });
        assert.deepEqual(id.resources.map(r => [r.type, r.origin]), [['third_party', 'paper_source']], `R17 #4: ${src.slice(0, 70)}`);
    }

    // R17 #5 & #6: comma-split other-subject predicates, bare baselines/prior work/commercial APIs/submission, leading subordinate clauses
    for (const src of [
        'Our code is publicly available at https://github.com/org/repo, while our model weights are currently private, and will be released upon acceptance.',
        'Our code is publicly available at https://github.com/org/repo, while baselines are closed-source.',
        'Our code is publicly available at https://github.com/org/repo, whereas prior work is proprietary and closed-source.',
        'Our code is publicly available at https://github.com/org/repo, while commercial APIs remain closed-source.',
        'Our code is publicly available at https://github.com/org/repo, while our submission is under review.'
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, 'https://github.com/org/repo'), ['code'], `R17 #5: ${src}`);
    }
    for (const [src, url, exp] of [
        ['Title\nAbstract\nSince our dataset is currently private, we release only our code.\nGitHub: https://github.com/org/our-code\n1 Introduction', 'https://github.com/org/our-code', ['code']],
        ['Title\nAbstract\nWhile our model weights remain private, our code is publicly released.\nGitHub: https://github.com/org/our-code\n1 Introduction', 'https://github.com/org/our-code', ['code']],
        ['Title\nAbstract\nOur model improves on baselines that are closed-source.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']],
        ['Title\nAbstract\nOur model outperforms prior work that is closed-source.\nHugging Face: https://huggingface.co/org/our-model\n1 Introduction', 'https://huggingface.co/org/our-model', ['model']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), exp, `R17 #6: ${src}`);
    }

    // R17 #7: 2610.06013 third-party pretrained model, hyphenated Data-preparation, comma/range citations, PyTorch framework & venue-year tags
    assert.deepEqual(
        binding.paperSourceResourceFacets('We then cluster episode-local character groups into show-level character identities, using embedding centroids from a publicly available speaker embedding model trained on an anime dataset22\n 2\n huggingface.co/litagin/anime_speaker_embedding_ecapa_tdnn_groupnorm.', 'huggingface.co/litagin/anime_speaker_embedding_ecapa_tdnn_groupnorm'),
        ['third_party']
    );
    assert.ok(
        !binding.paperSourceResourceFacets('Data-preparation templates are available: https://github.com/gsyllas/greek-stable-tts/tree/main/scripts/data to enable reproduction', 'https://github.com/gsyllas/greek-stable-tts/tree/main/scripts/data').includes('dataset')
    );
    assert.deepEqual(binding.paperSourceResourceFacets('The code is publicly available at https://github.com/openai/whisper, [12].', 'https://github.com/openai/whisper'), ['third_party']);
    assert.deepEqual(binding.paperSourceResourceFacets('The code is publicly available at https://github.com/openai/whisper [12-15].', 'https://github.com/openai/whisper'), ['third_party']);
    assert.deepEqual(binding.paperSourceResourceFacets('Our models are implemented using PyTorch and publicly released at https://github.com/org/our-repo.', 'https://github.com/org/our-repo'), ['model']);
    assert.deepEqual(binding.paperSourceResourceFacets('Our code (Interspeech 2026) is publicly available at https://github.com/org/our-repo.', 'https://github.com/org/our-repo'), ['code']);

    // R17 #8: scoring-audit-contract source-code, weight/checkpoint hyphen compounds, parenthetical reporting frames & demo shells
    const checkPromise = text => Boolean(scoring.sourceReleasePromise(text, {
        sourceTextSha256: crypto.createHash('sha256').update(text).digest('hex')
    }));
    assert.equal(checkPromise('We will release our source-code upon acceptance.'), true);
    assert.equal(checkPromise('Our source-code will be publicly released upon acceptance.'), true);
    for (const invalid of [
        'We will release our weight-decay ablations upon acceptance.',
        'We will release attention-weights visualizations upon acceptance.',
        'We will release per-checkpoint error analysis upon acceptance.',
        'We will release checkpoint-level metrics upon acceptance.',
        'We will release model-weight statistics upon acceptance.',
        'Our model with audio samples, which the paper shows will be publicly released, is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper shows will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper, as is shown in Table 1, will be publicly released is evaluated on LibriSpeech.',
        'We will release a web interface that runs our model.',
        'We will release a demo page where users can enter text, and our model synthesizes speech.',
        'We will release an online demo, updated weekly, which showcases our model.'
    ]) {
        assert.equal(checkPromise(invalid), false, `R17 #8 FP: ${invalid}`);
    }
});

test('Wave 8 R18 回归：HTML属性精确索引与RFC8259词法器、through/via与连字符白名单、标题边界与逗号外属、大小写引文、真实语料6篇、前置从句与评分承诺收口', async () => {
    const okVerify = async url => ({ url, status: 200, availability: 'available' });
    const runHtml = html => probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(html)
        })
    });

    // R18 #1: HTML attribute-boundary open-redirect, RFC 8259 JSON key/value & post-root concat, and quote-crossed unquoted spoofs
    for (const spoofHtml of [
        '<p>https://evil.com/redirect?src=https://github.com/org/spoof </p>',
        '<div data-x="https://evil.com/go?src=https://github.com/org/spoof "></div>',
        '<div data-x=\'https://evil.com/go/href="https://github.com/org/spoof"\'></div>',
        '<div data-x="https://evil.com/go/href=\'https://github.com/org/spoof\'"></div>',
        '<div data-x=\'{"a":"https://evil.com/go":"https://github.com/org/spoof"}\'>',
        '<div data-x=\'{"https://evil.com/go","b":"https://github.com/org/spoof"}\'>',
        '<div data-x=\'{"a":"https://evil.com/go"}["https://github.com/org/spoof"]\'>',
        '<p>https://evil.com/go"foo"!https://github.com/org/spoof</p>',
        '<p>https://evil.com/go\'foo\'!https://github.com/org/spoof</p>',
        '<p>https://evil.com/go"a=https://github.com/org/spoof</p>',
        '<p>https://evil.com/go\'a=https://github.com/org/spoof</p>'
    ]) {
        assert.deepEqual(await runHtml(spoofHtml), [], `R18 #1 spoof must be blocked: ${spoofHtml}`);
    }
    assert.deepEqual(
        await runHtml('<div title="a > b" data-cfg=\'{"url":"https://example.org","repo":"https://github.com/org/real-r18"}\'><a href="https://huggingface.co/org/real-r18">ok</a></div>'),
        ['https://github.com/org/real-r18', 'https://huggingface.co/org/real-r18']
    );

    // R18 #2, #3, #4, #5, #7: facet & attribution accuracy (including 6 real sealed corpus papers)
    for (const [src, url, exp] of [
        ['Model checkpoints and project resources are available through NVIDIA research releases and Hugging Face.44\n 4\n https://huggingface.co/nvidia/audio-flamingo-next-hf', 'https://huggingface.co/nvidia/audio-flamingo-next-hf', ['third_party']],
        ['Public model implementations and checkpoints are available through the Qwen repositories.55\n 5\n https://github.com/QwenLM/Qwen3-Omni', 'https://github.com/QwenLM/Qwen3-Omni', ['third_party']],
        ['The code is publicly available via OpenAI at https://github.com/openai/whisper.', 'https://github.com/openai/whisper', ['third_party']],
        ['The code of Audio-LDM is publicly available at https://github.com/haoheliu/AudioLDM.', 'https://github.com/haoheliu/AudioLDM', ['third_party']],
        ['The code of Speech-T5 is publicly available at https://github.com/microsoft/SpeechT5.', 'https://github.com/microsoft/SpeechT5', ['third_party']],
        ['The dataset of MIT-BIH is publicly available at https://github.com/other/mit-bih.', 'https://github.com/other/mit-bih', ['third_party']],
        ['The model Audio-LDM is publicly available at https://huggingface.co/haoheliu/AudioLDM.', 'https://huggingface.co/haoheliu/AudioLDM', ['third_party']],
        ['The code and Audio-LDM are publicly available at https://github.com/haoheliu/AudioLDM.', 'https://github.com/haoheliu/AudioLDM', ['third_party']],
        ['The code is publicly available at https://github.com/haoheliu/AudioLDM from Audio-LDM.', 'https://github.com/haoheliu/AudioLDM', ['third_party']],
        ['Acknowledgment\nWe also thank the LibriVAD authors.\nData Availability\nLibriVAD is available at https://github.com/zhenghuatan/LibriVAD and https://huggingface.co/datasets/LibriVAD/LibriVAD.', 'https://github.com/zhenghuatan/LibriVAD', ['third_party']],
        ['Appendix A Implementation Details\nOur code is available on Github11\n 1\n https://github.com/cpyang123/motigen.', 'https://github.com/cpyang123/motigen', ['code']],
        ['The code is publicly available at https://github.com/openai/whisper, developed by OpenAI.', 'https://github.com/openai/whisper', ['third_party']],
        ['The code is publicly available at https://github.com/openai/whisper, which is maintained by OpenAI.', 'https://github.com/openai/whisper', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo, developed by our team.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo (released in 2026).', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo (updated 2026).', 'https://github.com/org/repo', ['code']],
        ['Our code (INTERSPEECH 2026) is publicly available at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['Audio samples of AudioLDM [12-15] are available on the project page at https://audioldm.github.io/.', 'https://audioldm.github.io/', ['third_party']],
        ['Full videos for all sequences (Interspeech 2026) are on the project page at https://kyutai.org/aura/.', 'https://kyutai.org/aura/', ['demo']],
        ['We release all of our code11\n 1\n https://github.com/rasgaard/whisper-encoder-layer-prune and the pruned model22\n 2\n https://huggingface.co/rasgaard/whisper-large-v3-turbo-encoder-pruned.', 'https://github.com/rasgaard/whisper-encoder-layer-prune', ['code']],
        ['We release all of our code11\n 1\n https://github.com/rasgaard/whisper-encoder-layer-prune and the pruned model22\n 2\n https://huggingface.co/rasgaard/whisper-large-v3-turbo-encoder-pruned.', 'https://huggingface.co/rasgaard/whisper-large-v3-turbo-encoder-pruned', ['model']],
        ['The data ablation results are published at https://api.wandb.ai/links/bmessmer/2l4dpwl1.', 'https://api.wandb.ai/links/bmessmer/2l4dpwl1', ['third_party']],
        ['Code and corresponding data protocols are available at https://github.com/neamtucristian26/flame.', 'https://github.com/neamtucristian26/flame', ['code']],
        ['The model is implemented using the official open-source repository at https://github.com/other/repo.', 'https://github.com/other/repo', ['third_party']],
        ['The source-code is publicly available at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['We publicly release our codebase.\nhttps://github.com/org/repo', 'https://github.com/org/repo', ['code']],
        ['Our codebase is publicly available.\nhttps://github.com/org/repo', 'https://github.com/org/repo', ['code']],
        ['We publicly release our codes.\nhttps://github.com/org/repo', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo (while our paper is under review, our code is currently private).', 'https://github.com/org/repo', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo; while our paper is under review, it is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nHowever, since our dataset is publicly released, our code is currently private.\nGitHub: https://github.com/org/our-code\n1 Introduction', 'https://github.com/org/our-code', ['third_party']],
        ['Our code is publicly available at https://github.com/org/our-code.\nHowever, although our dataset is publicly released, our code is currently private.', 'https://github.com/org/our-code', ['third_party']],
        ['Our code is publicly available at https://github.com/org/our-code.\nNote that since our paper is under review, our code is currently private.', 'https://github.com/org/our-code', ['third_party']],
        ['Title\nAbstract\nWhile our dataset, models, and benchmarks are currently private, our code is publicly released.\nGitHub: https://github.com/org/our-code\n1 Introduction', 'https://github.com/org/our-code', ['code']],
        ['Title\nAbstract\nWhile our dataset is currently private, only our code is publicly released.\nGitHub: https://github.com/org/our-code\n1 Introduction', 'https://github.com/org/our-code', ['code']],
        ['Title\nAbstract\nOur code is publicly released, although our model weights are currently private.\nGitHub: https://github.com/org/our-code\n1 Introduction', 'https://github.com/org/our-code', ['code']],
        ['Our code is publicly available at https://github.com/org/repo.\nOur code is publicly released, though our dataset is under review.', 'https://github.com/org/repo', ['code']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), exp, `R18 facet: ${url} in ${src}`);
    }

    // R18 #2c, #3b, #6: validated_demo resurrection blocked for post-URL by/from, #readme suffix, comma external ownership, parenthesized labels, generic URL:/bullet under named heading, and sibling-URL/e.g. retraction context
    for (const [src, url] of [
        ['The code is publicly available at https://github.com/openai/whisper by OpenAI.', 'https://github.com/openai/whisper'],
        ['The code is publicly available at github.com/openai/whisper#readme, [12].', 'https://github.com/openai/whisper'],
        ['The code is publicly available at https://github.com/openai/whisper, developed by OpenAI.', 'https://github.com/openai/whisper'],
        ['Title\nAbstract\nWhisper (OpenAI) GitHub: https://github.com/openai/whisper\n1 Introduction', 'https://github.com/openai/whisper'],
        ['Title\nAbstract\nAudioLDM2:\nURL: https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        ['Title\nAbstract\nAudioLDM2:\n- https://github.com/haoheliu/AudioLDM2\n1 Introduction', 'https://github.com/haoheliu/AudioLDM2'],
        [`We publicly release our benchmark dataset.\nhttps://myproj.github.io/demo\nhttps://github.com/org/my-bench\n${'We evaluate our method on standard audio tasks. '.repeat(4)}\nHowever, our dataset is currently private.`, 'https://github.com/org/my-bench'],
        [`We publicly release our benchmark dataset (e.g. audio clips).\nhttps://github.com/org/my-bench\n${'We evaluate our method on standard audio tasks. '.repeat(4)}\nHowever, our dataset is currently private.`, 'https://github.com/org/my-bench']
    ]) {
        const identity = await probe.buildApiReaderResourceIdentity(
            `## 开源详情\n- 代码：${url}`,
            src,
            { discoveredLinks: [url] },
            { verifyUrlImpl: okVerify }
        );
        assert.ok(identity.resources.every(r => r.type === 'third_party'), `R18 no resurrection: ${src}`);
    }

    // R18 #8: scoring-audit-contract artifactNoun guards, code-base, reporting frames & coordinated relative verbs/participles
    const checkPromise = text => Boolean(scoring.sourceReleasePromise(text, {
        sourceTextSha256: crypto.createHash('sha256').update(text).digest('hex')
    }));
    for (const invalid of [
        'We will release source-code snippets in Appendix A.',
        'We will release source code snippets in Appendix A.',
        'We will release pseudo-source-code in Appendix A.',
        'We will release our code-base analysis upon acceptance.',
        'We will release implementation details in Appendix A.',
        'We will provide the implementation details in Section 3.',
        'We will release corpus statistics upon acceptance.',
        'We will release toolkit documentation in Appendix A.',
        'Our model with audio samples that we explicitly show will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper has shown will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper, in Section 3, shows will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper, as we show in Table 1, claims will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper notes will be publicly released is evaluated on LibriSpeech.',
        'We will release a demo page where users enter text, and our models synthesize speech.',
        'We will release a demo page where users upload audio, and our models run in real time.'
    ]) {
        assert.equal(checkPromise(invalid), false, `R18 #8 FP: ${invalid}`);
    }
    assert.equal(checkPromise('We will release a demo page where users can listen to samples, and our code hosted on GitHub.'), true);
});

test('Wave 8 R19 回归：Demo O(n) ReDoS/HTML5注释/RAWTEXT与JSON边界、fine-tune/adapt第三方、连字符白名单与via/through、外属对称、防复活全收口、后置引文、复合URL2、LaTeXML脚注与从句/承诺收口', async () => {
    const okVerify = async url => ({ url, status: 200, availability: 'available' });
    const runHtml = html => probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async raw => new URL(raw),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html']]),
            arrayBuffer: async () => Buffer.from(html)
        })
    });

    // R19 #1a: Quadratic ReDoS eliminated (<100ms on 32KB payload)
    const t0 = Date.now();
    const r1a = await runHtml(`<p>${'"/'.repeat(16000)},"https://github.com/org/x</p>`);
    assert.ok(Date.now() - t0 < 100, 'R19 #1a ReDoS must complete in <100ms');
    assert.deepEqual(r1a, []);

    // R19 #1b & #1c: HTML5 abrupt comments, xlink:href, body-text/RAWTEXT spoofing, and RFC 8259 strict JSON
    for (const spoofHtml of [
        '<!--><a href="https://evil.com/go https://github.com/org/spoof">bad</a>',
        '<!---><a href="https://evil.com/go https://github.com/org/spoof">bad</a>',
        '<a xlink:href="https://evil.com/go https://github.com/org/spoof">bad</a>',
        '<p>https://evil.com/go"a,b"https://github.com/org/spoof</p>',
        '<p>https://evil.com/go\'a,b\'https://github.com/org/spoof</p>',
        '<p>https://evil.com/go"a:b"https://github.com/org/spoof</p>',
        '<script>const u = \'https://evil.com/go"a,b"https://github.com/org/spoof\';</script>',
        '<script>const u = "https://evil.com/go>https://github.com/org/spoof";</script>',
        '<script>const u = "https://evil.com/go<https://github.com/org/spoof";</script>',
        '<textarea>https://evil.com/go>https://github.com/org/spoof</textarea>',
        '<script>const x={"a":"https://evil.com/go":"https://github.com/org/spoof"};</script>',
        '<script>const x={"a":"https://evil.com/go"}["https://github.com/org/spoof"];</script>',
        '<div data-x=\'{"a":"https://github.com/org/spoof"\'>',
        '<div data-x=\'{"a":"bad\nstr","b":"https://github.com/org/spoof"}\'>'
    ]) {
        assert.deepEqual(await runHtml(spoofHtml), [], `R19 #1 spoof must be blocked: ${spoofHtml}`);
    }
    assert.deepEqual(
        await runHtml('<script>const x={"a":"https://evil.com/go","b":"https://github.com/org/ok-r19"};</script>'),
        ['https://github.com/org/ok-r19']
    );
    assert.deepEqual(
        await runHtml('<script type="application/json">{"repo":"https://github.com/org/json-r19"}</script>'),
        ['https://github.com/org/json-r19']
    );

    // R19 #2, #3, #4, #6, #7, #8, #9: Facet & attribution regressions
    for (const [src, url, exp] of [
        // #2: real corpus fine-tuned public checkpoint & adapt Pipecat's open-source benchmark
        ['For DiariZen, we fine-tuned the public checkpoint22\n 2\n https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md following the official diar_ssl recipe.', 'https://huggingface.co/BUT-FIT/diarizen-wavlm-large-s80-md', ['third_party']],
        ['we adapt Pipecat’s open-source STT benchmark22\n 2\n https://github.com/pipecat-ai/stt-benchmark.', 'https://github.com/pipecat-ai/stt-benchmark', ['third_party']],
        ['We fine-tune our model and make our code publicly available at https://github.com/org/ok.', 'https://github.com/org/ok', ['code', 'model']],
        // #3a: hyphenated licenses/domain phrases & dotted hosts restored
        ['The dataset is publicly available with CC-BY-4.0 license at https://huggingface.co/datasets/org/data.', 'https://huggingface.co/datasets/org/data', ['dataset']],
        ['The code is publicly available with Apache-2.0 license at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['The code is publicly available for Text-to-Speech at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['The code is publicly available for Speech-to-Text at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['The code is publicly available for Audio-Visual tasks at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['The code is publicly available on GitHub.com at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        // #3b: post-URL via/through
        ['The code is publicly available at https://github.com/openai/whisper via OpenAI.', 'https://github.com/openai/whisper', ['third_party']],
        ['The weights are publicly available at https://huggingface.co/nvidia/model through NVIDIA.', 'https://huggingface.co/nvidia/model', ['third_party']],
        // #4a: first-party ownership not treated as retraction
        ['Our code is publicly available at https://github.com/org/repo.\nOur code is maintained by our team.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo.\nThe repository is developed by the authors.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo.\nThe code is provided by us under the MIT license.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo, hosted by GitHub.', 'https://github.com/org/repo', ['code']],
        // #4b: comma-separated released/published/created by OpenAI & maintained by the authors of Whisper
        ['The code is publicly available at https://github.com/openai/whisper, released by OpenAI.', 'https://github.com/openai/whisper', ['third_party']],
        ['The model weights are publicly available at https://huggingface.co/openai/whisper, published by OpenAI.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['The code is publicly available at https://github.com/openai/whisper, created by OpenAI.', 'https://github.com/openai/whisper', ['third_party']],
        ['The code is publicly available at https://github.com/openai/whisper, maintained by the authors of Whisper.', 'https://github.com/openai/whisper', ['third_party']],
        // #6: post-URL citations in demo quote, badge, and trailing-slash postUrlCitation
        ['Full videos for all sequences are on the project page at https://audioldm.github.io/ [12].', 'https://audioldm.github.io/', ['third_party']],
        ['Full videos for all sequences are on the project page at https://audioldm.github.io/ (Liu et al., 2023).', 'https://audioldm.github.io/', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/openai/whisper [12]\n1 Introduction', 'https://github.com/openai/whisper', ['third_party']],
        ['Title\nAbstract\nProject page: https://audioldm.github.io/ (Liu et al., 2023)\n1 Introduction', 'https://audioldm.github.io/', ['third_party']],
        ['The code is publicly available at https://github.com/openai/whisper/, [12].', 'https://github.com/openai/whisper', ['third_party']],
        // #7: compound elided-verb URL2 subject (2610.06817)
        ['Code is available at github.com/sahilmahendrakar/paradee, and the model files and audio samples at huggingface.co/sahilmahendrakar/Paradee-8M-v1.0.', 'huggingface.co/sahilmahendrakar/Paradee-8M-v1.0', ['model']],
        ['Our code is available at https://github.com/org/repo, and the model weights and dataset at https://huggingface.co/org/model.', 'https://huggingface.co/org/model', ['model', 'dataset']],
        // #8a, #8b, #8c: LaTeXML available11/released11, 2-digit 1010/1111, source-code/codebase parity
        ['Our code and benchmark are publicly available11\n 1\n https://github.com/RongHuiQiang/OmniConfess.', 'https://github.com/RongHuiQiang/OmniConfess', ['code', 'dataset']],
        ['Code and model weights are released11\n 1\n https://github.com/lee-jhwn/myocodec.', 'https://github.com/lee-jhwn/myocodec', ['code', 'model']],
        ['We release all of our code1010\n 10\n https://github.com/org/code and the pruned model1111\n 11\n https://huggingface.co/org/model.', 'https://huggingface.co/org/model', ['model']],
        ['We publicly release our source-code.\nhttps://github.com/org/repo\nOur source-code is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo | Source-code: private\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        ['Title\nAbstract\nGitHub: https://github.com/org/repo | Codebase: private\n1 Introduction', 'https://github.com/org/repo', ['third_party']],
        // #9a, #9b, #9c: subordinate/coordinated clause splits & isSubordinateLead resource-facet tracking
        ['Our code is publicly available at https://github.com/org/repo, and while our paper is under review, our code is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo, and while our paper is under review, it is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo.\nOur dataset is publicly released, while our paper is under review, our code is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo.\nWe release our code, and our model weights are currently private.', 'https://github.com/org/repo', ['code']],
        ['Title\nAbstract\nWe release our code, and our model weights are currently private.\nGitHub: https://github.com/org/repo\n1 Introduction', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo.\nOur repository provides our code, and our model weights are currently private.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo.\nNote: while our dataset is currently private, our code is publicly released.', 'https://github.com/org/repo', ['code']],
        ['Our code is publicly available at https://github.com/org/repo; while our paper undergoes review, it is currently private.', 'https://github.com/org/repo', ['third_party']],
        ['Our code is publicly available at https://github.com/org/repo; while our model weights are hosted elsewhere, they are currently private.', 'https://github.com/org/repo', ['code']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), exp, `R19 facet: ${url} in ${src}`);
    }

    // R19 #3b & #5: validated_demo resurrection prevention (including 2610.14607 LibriVAD & 2611.12527 VibeVoice)
    for (const [src, url] of [
        ['The code is publicly available at github.com/openai/whisper#readme via OpenAI.', 'https://github.com/openai/whisper'],
        ['Acknowledgment\nWe also thank the LibriVAD authors.\nData Availability\nLibriVAD is available at https://github.com/zhenghuatan/LibriVAD and https://huggingface.co/datasets/LibriVAD/LibriVAD.', 'https://github.com/zhenghuatan/LibriVAD'],
        ['Acknowledgment\nWe also thank the LibriVAD authors.\nData Availability\nLibriVAD is available at https://github.com/zhenghuatan/LibriVAD and https://huggingface.co/datasets/LibriVAD/LibriVAD.', 'https://huggingface.co/datasets/LibriVAD/LibriVAD'],
        ['They release their open-source implementation1010\n 10\n https://github.com/microsoft/VibeVoice and real-time model1111\n 11\n https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B.', 'https://github.com/microsoft/VibeVoice'],
        ['They release their open-source implementation1010\n 10\n https://github.com/microsoft/VibeVoice and real-time model1111\n 11\n https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B.', 'https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B'],
        ['Whisper code is publicly available at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['AudioLDM2 is publicly available at https://github.com/haoheliu/AudioLDM2.', 'https://github.com/haoheliu/AudioLDM2'],
        ['Whisper is available at https://github.com/openai/whisper by OpenAI.', 'https://github.com/openai/whisper'],
        ['Title\nAbstract\nOfficial Whisper GitHub: https://github.com/openai/whisper\n1 Introduction', 'https://github.com/openai/whisper'],
        ['The code11\n 1\n of Whisper is publicly available at https://github.com/openai/whisper.', 'https://github.com/openai/whisper']
    ]) {
        const identity = await probe.buildApiReaderResourceIdentity(
            `## 开源详情\n- 资源：${url}`,
            src,
            { discoveredLinks: [url] },
            { verifyUrlImpl: okVerify }
        );
        assert.ok(identity.resources.every(r => r.type === 'third_party'), `R19 no resurrection: ${url} in ${src}`);
    }

    // R19 #10: scoring-audit-contract evaluation/reproduction guards, reporting-frame locative, pre-verb adverbs/(v2), passiveSubject parity
    const checkPromise = text => Boolean(scoring.sourceReleasePromise(text, {
        sourceTextSha256: crypto.createHash('sha256').update(text).digest('hex')
    }));
    for (const invalid of [
        'We will release evaluation pipeline details in Appendix A.',
        'We will release evaluation suite results in Appendix A.',
        'We will release reproduction code snippets in Appendix A.',
        'We will release evaluation code snippets in Appendix A.',
        'Our model with audio samples that our paper shows in Section 3 will be publicly released is evaluated on LibriSpeech.',
        'We will release a demo page where users upload audio, and our models also synthesize speech.',
        'We will release a demo page where users upload audio, and our model (v2) generates speech.'
    ]) {
        assert.equal(checkPromise(invalid), false, `R19 #10 FP: ${invalid}`);
    }
    for (const valid of [
        'Our corpus will be publicly released upon acceptance.',
        'Our repository will be publicly released upon acceptance.',
        'Our implementation will be publicly released upon acceptance.',
        'Our training scripts will be publicly released upon acceptance.',
        'Our codes will be publicly released upon acceptance.'
    ]) {
        assert.equal(checkPromise(valid), true, `R19 #10 FN: ${valid}`);
    }
});

test('Wave 8 R20 回归：Demo O(N) ReDoS/HTML5注释/RAWTEXT/JS词法/JSON完整校验、explicitAuthor消费动词与真实语料防误报/防漏/防分数膨胀、防复活与评分承诺全收口', async () => {
    const okVerify = async url => ({ url, ok: true, status: 200, finalUrl: url });
    const mockDemo = html => probe.checkDemoPageForOpensource('https://example.org/demo', {
        validateUrlImpl: async u => new URL(u),
        detectProxyImpl: () => '',
        requestImpl: async () => ({
            status: 200,
            headers: new Map([['content-type', 'text/html; charset=utf-8']]),
            arrayBuffer: async () => Buffer.from(html, 'utf8')
        })
    });

    // R20 #1: Linear-time O(N) attribute prefix & single-pass JSON indexing (no ReDoS / O(M*N))
    for (const [label, html, expectedCount] of [
        ['slash-100k', `<div data-x="${'/'.repeat(100000)} https://github.com/org/x"></div>`, 1],
        ['https-25k', `<div data-x="${'https://'.repeat(25000)}!a https://github.com/org/x"></div>`, 1],
        ['json-12k', `<script type="application/json">[${Array.from({ length: 12000 }, (_, i) => `"https://github.com/org/r${i}"`).join(',')}]</script>`, 12000]
    ]) {
        const t0 = Date.now();
        const links = await mockDemo(html);
        const dt = Date.now() - t0;
        assert.equal(links.length, expectedCount, `R20 #1 ${label} count`);
        assert.ok(dt < 500, `R20 #1 ${label} took ${dt}ms (must be < 500ms)`);
    }

    // R20 #2: HTML5 --!>, non-self-closing RAWTEXT, iframe/noscript/plaintext, body >/<, script template/regex/obj/JSON spoofs, single-quoted [Code]
    for (const badHtml of [
        '<!-- x --!><a href="https://evil.com/go https://github.com/org/spoof">bad</a>',
        '<!-- x --!><img srcset="https://github.com/org/spoof 2x">',
        '<script/>const u = "https://evil.com/go>https://github.com/org/spoof";</script>',
        '<iframe>https://evil.com/go>https://github.com/org/spoof</iframe>',
        '<noscript>https://evil.com/go>https://github.com/org/spoof</noscript>',
        '<plaintext>https://evil.com/go>https://github.com/org/spoof',
        '<p>https://evil.com/go>https://github.com/org/spoof</p>',
        '<p>https://evil.com/go<https://github.com/org/spoof</p>',
        '<script>const u = `https://github.com/org/spoof </script>',
        '<script>const s = `hello ${1} https://github.com/org/spoof </script>',
        '<script>const s = `${"{"}` + obj["https://github.com/org/spoof"];</script>',
        '<script>const s = `${obj["https://github.com/org/spoof"]}`;</script>',
        '<script>const u = `${"https://evil.com/go/"}https://github.com/org/spoof `;</script>',
        '<script>if (a) /"/.test(b); const u = x["https://github.com/org/spoof"];</script>',
        '<script>const x={"https://evil.com/go","b":"https://github.com/org/spoof"};</script>',
        '<script>const x={"a":"https://evil.com/go"x:"https://github.com/org/spoof"};</script>',
        '<script>const x="https://evil.com/go""https://github.com/org/spoof";</script>',
        '<script>const x={"a":("https://evil.com/go"):"https://github.com/org/spoof"};</script>',
        '<script type="application/json">{"a":"https://github.com/org/spoof extra"}</script>',
        '<script type="application/json">{"a":"https://github.com/org/spoof\tbad"}</script>',
        '<script type="application/json">{"a":"https://github.com/org/spoof",</script>',
        '<div data-x=\'{"a":"https://github.com/org/spoof",\'></div>',
        '<div data-x=\'{"a":"https://github.com/org/spoof" ]\'></div>'
    ]) {
        assert.deepEqual(await mockDemo(badHtml), [], `R20 #2 spoof rejected: ${badHtml}`);
    }
    assert.deepEqual(
        await mockDemo("<div title='[Code] Available at https://github.com/org/real'></div>"),
        ['https://github.com/org/real'],
        'R20 #2 single-quoted [Code] text attribute preserved'
    );
    assert.deepEqual(
        await mockDemo('<script>const cfg = { a: fn(1, 2), b: obj.prop, url: "https://github.com/org/real" };</script>'),
        ['https://github.com/org/real'],
        'R20 #2 valid JS object with call & member access preserved'
    );

    // R20 #3, #5, #6, #7: paperSourceResourceFacets real-corpus & synthetic cases
    for (const [src, url, exp] of [
        // R20 #3: third-party consumption verbs (2609.04867) & stacked fine-tune/adapt & elided adjectival released
        ['MOVA (SII-OpenMOSS Team, 2026). We evaluate MOVA locally using the public codebase1010\n 10\n https://github.com/OpenMOSS/MOVA.', 'https://github.com/OpenMOSS/MOVA', ['third_party']],
        ['We fine-tuned the publicly released checkpoint at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['We fine-tuned Whisper using the public checkpoint at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['We adapt the publicly released benchmark at https://github.com/other/bench.', 'https://github.com/other/bench', ['third_party']],
        ['We download the publicly available checkpoint of Whisper at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['Our pipeline uses the open-source model of Whisper at https://huggingface.co/openai/whisper.', 'https://huggingface.co/openai/whisper', ['third_party']],
        ['They release their code at https://github.com/other/code and the publicly released model at https://huggingface.co/other/model.', 'https://huggingface.co/other/model', ['third_party']],
        // R20 #5: first-party RESOURCE_AFFIRMATIVE adverbs/verbs, coordinated noun phrases, bare footnote marker before URL2
        ['We publicly release our code at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['We also release our code and pre-trained model to support reproducibility and future research11\n 1\n https://github.com/vspeech/ESDCodec.', 'https://github.com/vspeech/ESDCodec', ['code', 'model', 'reproduction']],
        ['In order to facilitate further research in this area, we publish our models and code11\n 1\n https://huggingface.co/collections/MU-NLPC/prosody-to-text.', 'https://huggingface.co/collections/MU-NLPC/prosody-to-text', ['code', 'model']],
        ['We openly share our code at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['We release our code and the pre-trained model at https://github.com/org/repo.', 'https://github.com/org/repo', ['code', 'model']],
        ['Our code and our model are publicly available at https://github.com/org/repo.', 'https://github.com/org/repo', ['code', 'model']],
        ['The benchmark manifest, the evaluation code, and the model are publicly available11\n 1\n github.com/sizigi/kyarabench.', 'github.com/sizigi/kyarabench', ['code', 'model', 'dataset']],
        ['The source code and model checkpoint are available at 11\n 1\n https://github.com/xiaomi-research/midashenglm-spatial and 22\n 2\n https://huggingface.co/mispeech/midashenglm-spatial.', 'https://huggingface.co/mispeech/midashenglm-spatial', ['code', 'model']],
        // R20 #6: no fake model/dataset facets from compounds or mid-sentence LaTeXML footnote bleed
        ['The benchmark, evaluation protocols, and model results are released openly11\n 1\n https://github.com/AI4Bharat/Vimarsha', 'https://github.com/AI4Bharat/Vimarsha', ['dataset']],
        ['The code, per-sample VAD features, validity-checked model predictions and prompt templates are released as an incongruence-aware benchmark at https://github.com/Guylaban/incongruence-aware-ser.', 'https://github.com/Guylaban/incongruence-aware-ser', ['code', 'dataset']],
        ['The source code, model implementation, and experimental scripts used in this study are publicly available in the project repository.22\n 2\n https://github.com/debolina-34/SnaanGhar7', 'https://github.com/debolina-34/SnaanGhar7', ['code']],
        ['Our implementation, including data generation, model training, and parameter refinement, is available as open-source code.11\n 1\n github.com/davidmarttila/dafx_challenge', 'github.com/davidmarttila/dafx_challenge', ['code']],
        ['We have released the code, dataset details and model weights.11\n 1\n https://github.com/KadeeYoung/TEMA', 'https://github.com/KadeeYoung/TEMA', ['code', 'model']],
        ['In this section, we evaluate the performance of the proposed continuous-time generative models for au11\n 1\n The source code is available at https://github.com/Amitmils/GenAU.', 'https://github.com/Amitmils/GenAU', ['code']],
        ['Prior methods [22] are less interpretable11\n 1\n Code is available at https://github.com/org/interp.', 'https://github.com/org/interp', ['code']],
        // R20 #7: Source-code / Codebase badge tail stop & AGPL-3.0 / MPL-2.0 license whitelist
        ['Title\nAbstract\nHugging Face: https://huggingface.co/org/model Source-code: private\n1 Introduction', 'https://huggingface.co/org/model', ['model']],
        ['Title\nAbstract\nHugging Face: https://huggingface.co/org/model Codebase: private\n1 Introduction', 'https://huggingface.co/org/model', ['model']],
        ['The code is publicly available with AGPL-3.0 license at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']],
        ['The code is publicly available with MPL-2.0 license at https://github.com/org/repo.', 'https://github.com/org/repo', ['code']]
    ]) {
        assert.deepEqual(binding.paperSourceResourceFacets(src, url), exp, `R20 facet: ${url} in ${src}`);
    }

    // R20 #4: validated_demo resurrection prevention
    for (const [src, url] of [
        ['AudioLDM2 can be found at https://github.com/haoheliu/AudioLDM2.', 'https://github.com/haoheliu/AudioLDM2'],
        ['AudioLDM2 has been released at https://github.com/haoheliu/AudioLDM2.', 'https://github.com/haoheliu/AudioLDM2'],
        ['Whisper is accessible at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['OpenAI released Whisper at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['They open-sourced Whisper at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['The official Whisper is publicly available at https://github.com/openai/whisper.', 'https://github.com/openai/whisper'],
        ['They release their code at https://github.com/other/code and public model at https://huggingface.co/other/model.', 'https://huggingface.co/other/model'],
        ['They release https://github.com/a/b and the model at https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B-LongName.', 'https://huggingface.co/microsoft/VibeVoice-Realtime-0.5B-LongName'],
        ['Title\nAbstract\nWhisper official GitHub: https://github.com/openai/whisper\n1 Introduction', 'https://github.com/openai/whisper'],
        ["Title\nAbstract\nWhisper's GitHub: https://github.com/openai/whisper\n1 Introduction", 'https://github.com/openai/whisper'],
        ["Title\nAbstract\nOpenAI's Whisper: https://github.com/openai/whisper\n1 Introduction", 'https://github.com/openai/whisper'],
        ['Title\nAbstract\nWhisper on GitHub: https://github.com/openai/whisper\n1 Introduction', 'https://github.com/openai/whisper'],
        ["Title\nAbstract\nMeta's EnCodec (https://github.com/facebookresearch/encodec)\n1 Introduction", 'https://github.com/facebookresearch/encodec'],
        ['Title\nAbstract\nfairseq GitHub: https://github.com/facebookresearch/fairseq\n1 Introduction', 'https://github.com/facebookresearch/fairseq']
    ]) {
        const identity = await probe.buildApiReaderResourceIdentity(
            `## 开源详情\n- 代码：${url}`,
            src,
            { discoveredLinks: [url] },
            { verifyUrlImpl: okVerify }
        );
        assert.ok(identity.resources.every(r => r.type === 'third_party'), `R20 #4 no resurrection: ${url} in ${src}`);
    }

    // R20 #8: scoring-audit-contract nonArtifactHead, parentheticalReportingFrameRe, coordRel*, passive/real-corpus FNs
    const checkPromise = text => Boolean(scoring.sourceReleasePromise(text, {
        sourceTextSha256: crypto.createHash('sha256').update(text).digest('hex')
    }));
    for (const invalid of [
        'We will release our model evaluation suite results in Appendix A.',
        'We will release model evaluation code snippets in Appendix A.',
        'We will release our model evaluation pipeline details in Appendix A.',
        'We will release our dataset evaluation suite results in Appendix A.',
        'We will release our model logs in Appendix A.',
        'We will release our model curves in Appendix A.',
        'We will release our dataset protocols in Appendix A.',
        'Our model with audio samples that our paper in Section 3 shows will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper shows above will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper shows in the appendix will be publicly released is evaluated on LibriSpeech.',
        'Our model with audio samples that our paper can show will be publicly released is evaluated on LibriSpeech.',
        'We will release a demo page where users upload text, and our model trained on 10k hours synthesizes speech.',
        'We will release a demo page where users upload text, and our model hosted on GPU synthesizes speech.',
        'We will release a demo page where users upload audio, and our model for TTS generates speech.',
        'We will release a demo page where users upload audio, and our model with 8B parameters synthesizes speech.',
        'We will release a demo page where users upload audio, and our model v2 generates speech.',
        'We will release a demo page where users upload audio, and our model often generates speech.'
    ]) {
        assert.equal(checkPromise(invalid), false, `R20 #8 FP: ${invalid}`);
    }
    for (const valid of [
        'Our evaluation suite will be publicly released upon acceptance.',
        'Our evaluation pipeline will be publicly released upon acceptance.',
        'The code supporting the proposed method will be released upon acceptance with appropriate documentation.',
        'The implementation is provided as supplementary material; pretrained checkpoints will be released upon acceptance.',
        'Justification:\nWe will release the code upon publication.',
        'Code Availability:\nWe will release our code and models upon acceptance.',
        'We will release a demo page where users upload audio, and our model with 8B parameters upon acceptance.',
        'We will release a demo page where users listen to samples, and our model hosted on Hugging Face.'
    ]) {
        assert.equal(checkPromise(valid), true, `R20 #8 FN: ${valid}`);
    }
});
