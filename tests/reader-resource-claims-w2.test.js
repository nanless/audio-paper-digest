'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const claims = require('../scripts/lib/reader-resource-claims.js');
const proseNorm = require('../scripts/lib/reader-prose-normalization.js');
const { stableFingerprint } = require('../scripts/lib/public-resource-probe.js');

const sha = text => crypto.createHash('sha256').update(String(text || '')).digest('hex');

function makeIdentity(sourceText, resources = []) {
    const body = {
        contract: 'api-reader-resource-identity-v1',
        sourceTextSha256: sha(sourceText),
        resources: resources.map(r => ({
            origin: 'paper_source',
            sourceQuoteSha256: sha(r.sourceQuote),
            finalUrl: r.finalUrl || r.originalUrl,
            redirects: [],
            status: r.availability === 'available' ? 200 : (r.availability === 'unavailable' ? 404 : null),
            retryable: r.availability === 'temporarily_unreachable',
            ...r
        }))
    };
    return { ...body, identitySha256: stableFingerprint(body) };
}

describe('CP-P1-4 + CP-P2-5: reader-resource-claims distinction & gated dataset exemption', () => {
    it('accepts "区分三件事，代码开源、权重可下载与系统可运行" while keeping ALL affirmative followups fail-closed', () => {
        const sourceText = 'We describe our audio modeling experiments on standard benchmarks.';
        const identity = makeIdentity(sourceText, []);
        const check = body => claims.readerResourceClaimIssues(
            { sections: [{ kind: 'reproduction', body }] },
            identity,
            sourceText
        );

        const validStatements = [
            '复现前需区分三件事，代码开源、权重可下载与系统可运行。',
            '区分三件事，代码开源、权重可下载与系统可运行。',
            '复现时应区分三件事：代码开源、权重可下载与系统可运行，当前均未核实。',
            '需区分三件事，代码开源、权重可下载与系统可运行，不要将论文提及链接等同于已公开。',
            '复现前要区分代码开源、权重可下载与系统可运行三件事。'
        ];
        for (const text of validStatements) {
            assert.deepEqual(check(text), [], `Should accept concept distinction: ${text}`);
        }

        const mustFailClosed = [
            '区分三件事，代码开源、权重可下载与系统可运行，三者均已公开。',
            '区分三件事，代码开源、权重可下载与系统可运行，均已公开。',
            '区分三件事，代码开源、权重可下载与系统可运行；三者均已公开。',
            '区分三件事，代码开源、权重可下载与系统可运行，但本文权重已公开。',
            '复现前需区分三件事，代码开源、权重可下载与系统可运行，目前均已公开。',
            '复现前需区分三件事，代码开源、权重可下载与系统可运行，但本文代码已经开源。',
            '区分三件事，本文代码开源、权重可下载与系统可运行。',
            '“区分三件事，代码开源、权重可下载与系统可运行”这一说法是错误的。'
        ];
        for (const text of mustFailClosed) {
            assert.ok(check(text).length > 0, `Must fail closed on affirmative/owner/retraction followup: ${text}`);
        }
    });

    it('exempts gated-access dataset page descriptions ONLY when a verified available URL exists for that dataset/resource', () => {
        const gatedQuote = 'The dataset page is hosted at https://zenodo.org/records/9876543 and requires email verification and signing a license agreement.';
        const sourceWithGatedUrl = `Overview.\n\n${gatedQuote}`;
        const availableGatedIdentity = makeIdentity(sourceWithGatedUrl, [{
            type: 'third_party',
            originalUrl: 'https://zenodo.org/records/9876543',
            sourceQuote: gatedQuote,
            availability: 'available'
        }]);

        const validGatedTexts = [
            '该数据集页面当前可访问但需邮件验证并签署使用协议。',
            '对应数据集页面当前可访问但需申请审核并签署数据协议，不属于直接开放下载。',
            '数据集页面当前可访问但需注册并签署许可协议。',
            '数据集页面当前可访问但需签署协议。'
        ];
        for (const body of validGatedTexts) {
            const issues = claims.readerResourceClaimIssues(
                { sections: [{ kind: 'reproduction', body }] },
                availableGatedIdentity,
                sourceWithGatedUrl
            );
            assert.deepEqual(issues, [], `Should allow gated-access dataset description with verified available URL: ${body}`);
        }

        // Negative 1: NO verified available URL at all -> MUST fail closed
        const emptyIdentity = makeIdentity(sourceWithGatedUrl, []);
        assert.ok(
            claims.readerResourceClaimIssues(
                { sections: [{ kind: 'reproduction', body: validGatedTexts[0] }] },
                emptyIdentity,
                sourceWithGatedUrl
            ).length > 0,
            'Must fail closed when no verified available URL exists'
        );

        // Negative 2: dataset URL is unavailable (404) -> MUST fail closed
        const deadDatasetQuote = 'Our dataset is available at https://zenodo.org/records/9876543.';
        const unavailableDatasetIdentity = makeIdentity(deadDatasetQuote, [{
            type: 'dataset',
            originalUrl: 'https://zenodo.org/records/9876543',
            sourceQuote: deadDatasetQuote,
            availability: 'unavailable'
        }]);
        assert.ok(
            claims.readerResourceClaimIssues(
                { sections: [{ kind: 'reproduction', body: `https://zenodo.org/records/9876543 对应${validGatedTexts[0]}` }] },
                unavailableDatasetIdentity,
                deadDatasetQuote
            ).length > 0,
            'Must fail closed when dataset URL is unavailable'
        );

        // Negative 3: only unrelated code URL is available (no dataset resource) -> MUST fail closed
        const codeQuote = 'Our code is available at https://github.com/example/audio-code.';
        const codeOnlyIdentity = makeIdentity(codeQuote, [{
            type: 'code',
            originalUrl: 'https://github.com/example/audio-code',
            sourceQuote: codeQuote,
            availability: 'available'
        }]);
        assert.ok(
            claims.readerResourceClaimIssues(
                { sections: [{ kind: 'reproduction', body: validGatedTexts[0] }] },
                codeOnlyIdentity,
                codeQuote
            ).length > 0,
            'Must fail closed when only an unrelated code URL is available'
        );

        // Negative 4: subsequent unconditional release claim alongside gated description -> MUST fail closed
        assert.ok(
            claims.readerResourceClaimIssues(
                { sections: [{ kind: 'reproduction', body: '该数据集页面当前可访问但需邮件验证并签署协议，但完整数据集已公开下载。' }] },
                availableGatedIdentity,
                sourceWithGatedUrl
            ).length > 0,
            'Must fail closed on subsequent unconditional dataset release claim'
        );

        // Negative 5: ungated accessibility claim -> MUST fail closed
        assert.ok(
            claims.readerResourceClaimIssues(
                { sections: [{ kind: 'reproduction', body: '该数据集页面当前可访问，可直接下载。' }] },
                availableGatedIdentity,
                sourceWithGatedUrl
            ).length > 0,
            'Must fail closed on ungated accessibility claim'
        );
    });
});

describe('PC-P1-8: reader-prose-normalization Arabic frequency unit normalization', () => {
    it('normalizes Arabic-digit frequency phrases like "16 千赫" -> "16 kHz" while preserving coordinate lists', () => {
        const freqIssue = [{ code: 'quantitative_chinese_numeral', match: '采样率为16 千赫' }];
        assert.equal(
            proseNorm.normalizeReaderProseFormatting('音频采样率为 16 千赫。', freqIssue),
            '音频采样率为 16 kHz。'
        );
        assert.equal(
            proseNorm.normalizeReaderProseFormatting('载波频率为 24.5 兆赫兹。', freqIssue),
            '载波频率为 24.5 MHz。'
        );
        assert.equal(
            proseNorm.normalizeReaderProseFormatting('音频采样率为十六千赫兹。', freqIssue),
            '音频采样率为 16 kHz。'
        );
        // Coordinated list without unit on first item must stay untouched
        assert.equal(
            proseNorm.normalizeReaderProseFormatting('支持 16 与 48 千赫。', freqIssue),
            '支持 16 与 48 千赫。'
        );
    });
});
