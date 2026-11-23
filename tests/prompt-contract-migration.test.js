'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const registry = require('../scripts/lib/prompt-contracts');
const legacy = require('../scripts/lib/prompt-legacy-codec');
const evidence = require('../scripts/lib/prompt-evidence');
const history = require('../scripts/lib/prompt-history');
const root = path.resolve(__dirname, '..');
const baseline = '05ab504df7f84da3b8d961878323cfa161f23eb0';
const git = (...args) => execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', ...args], { cwd: root });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('current templates preserve original text apart from the declared changes; all original Git identities remain exact', () => {
    assert.equal(registry.CURRENT_PROMPT_FILES.length, 16);
    for (const current of registry.CURRENT_PROMPT_FILES) {
        assert.match(current, /^prompts\/current\/[a-z-]+\.md$/);
        const original = legacy.currentPathPredecessors[current];
        assert.ok(original);
        const actual = evidence.readPromptEvidenceBytes(current);
        const originalBytes = git('show', `${baseline}:${original}`);
        if (current === 'prompts/current/api-reader-article.md') {
            const header = require('../scripts/lib/protocol-codec').record('reader-draft');
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.ok(text.includes(`"contract": "${header.contract}"`));
            assert.ok(text.includes(`"schemaFingerprint": "${header.schemaFingerprint}"`));
            assert.match(text, /五环架构与完整流水线清单/);
            assert.match(text, /四步深度实验剖析/);
            assert.match(text, /"chineseCaption"/);
            assert.match(text, /"implementationSpecs"/);
            assert.match(text, /"trainingData"/);
            assert.match(text, /"appendixHighlights"/);
            assert.match(text, /超过 950 个汉字/);
            assert.match(text, /严禁在全文中连续 3 节及以上套用/);
            assert.doesNotMatch(text, /"version":\s*3/);
        } else if (['prompts/current/api-reader-fact-local.md', 'prompts/current/api-reader-concept-terms.md'].includes(current)) {
            const fact = current.endsWith('/api-reader-fact-local.md');
            const header = require('../scripts/lib/protocol-codec').record(fact ? 'reader-fact-sentence-patch' : 'reader-concept-term-patch');
            let expected = originalBytes.toString().replace('{"version":1,"draftSha256"',
                JSON.stringify(header).slice(0, -1) + ',"draftSha256"')
                .replace('# Reader 已核验事实原句修订 v3', '# 已核验事实的原句修订');
            if (fact) {
                expected = expected.replace(
                    '不能返回完整正文、解释标题、Markdown标题、terms标题、换行、图表公式标记、表格或链接。',
                    '不能返回完整正文、解释标题、Markdown标题、terms标题、换行、图表公式标记、表格、链接、行内反引号 ` 或加粗标记 ** / __。'
                );
            }
            assert.notEqual(expected, originalBytes.toString());
            assert.equal(actual.toString(), expected);
        } else if (current === 'prompts/current/api-reader-repair.md') {
            const header = require('../scripts/lib/protocol-codec').record('reader-node-patch');
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.ok(text.includes(JSON.stringify(header).slice(0, -1) + ',"draftSha256"'));
            assert.match(text, /120–320 汉字（硬上限 420 字）/);
            assert.match(text, /散文超过 950 汉字的小节须使用 `####` 子标题或结构化列表/);
            assert.match(text, /`chineseCaption`/);
            assert.match(text, /`implementationSpecs`/);
            assert.match(text, /不得连续 3 节及以上套用/);
            assert.doesNotMatch(text, /\{"version":1,"draftSha256"/);
        } else if (current === 'prompts/current/primary-fact-local-repair.md') {
            const expected = originalBytes.toString().replace('主文局部事实纠错 v1', '主文局部事实纠错')
                .replace('"contract":"primary-local-fact-repair-v1"',
                    '"contract":"primary-local-fact-repair","schemaFingerprint":"{schemaFingerprint}"');
            assert.equal(actual.toString(), expected);
        } else if (current === 'prompts/current/structure-repair.md') {
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.match(text, /实验表格不符合数量、行列和解释要求/);
            assert.match(text, /核心摘要用 10–26 句完整中文句子，汉字与中文标点合计 700–1400 个/);
            assert.match(text, /核心实验数字主要集中在摘要和实验结果中/);
            assert.match(text, /<paper_input>[\s\S]*\{existingAnalysis\}[\s\S]*\{textForAnalysis\}[\s\S]*<\/paper_input>/);
        } else if (current === 'prompts/current/deep-analysis.md') {
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.match(text, /以下 18 个键必须各出现一次/);
            assert.match(text, /^rubric_version: type-aware-v2$/m);
            assert.match(text, /0\.0 \/ 1\.5 \/ 3\.0 \/ 6\.0 \/ 8\.0 \/ 10\.0/);
            assert.match(text, /全部采用 0\.0–10\.0 统一量表/);
            assert.match(text, /共选择 3–5 个标签，至少包含一个任务和一个方法，其中任务标签（`facet=task`）最多 3 个。/);
            assert.match(text, /<paper_input>[\s\S]*\{title\}[\s\S]*\{textForAnalysis\}[\s\S]*<\/paper_input>/);
            assert.doesNotMatch(text, /0\.0 \/ 0\.2 \/ 0\.5 \/ 1\.0 \/ 1\.2 \/ 1\.5/);
        } else if (current === 'prompts/current/scoring-audit.md') {
            const header = require('../scripts/lib/scoring-record-format').currentEvidenceProfileHeader();
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.ok(text.includes(`"contract": "${header.contract}"`));
            assert.ok(text.includes(`"schemaFingerprint": "${header.schemaFingerprint}"`));
            assert.match(text, /type-aware-v2/);
            assert.match(text, /"primaryStrengths"/);
            assert.match(text, /"primaryDefects"/);
            assert.match(text, /0\.0 \/ 1\.5 \/ 3\.0 \/ 6\.0 \/ 8\.0 \/ 10\.0/);
            assert.match(text, /总分不得超过 `8\.4`/);
            assert.match(text, /总分不得超过 `7\.2`/);
            assert.match(text, /<paper_input>[\s\S]*\{existingAnalysis\}[\s\S]*\{sourceEvidence\}[\s\S]*<\/paper_input>/);
            assert.doesNotMatch(text, /"version":\s*1/);
            assert.doesNotMatch(text, /\[A_LIMIT\]/);
        } else if (current === 'prompts/current/core-summary-repair.md') {
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.match(text, /摘要正文写 10–26 句，汉字与中文标点合计 700–1400 个/);
            assert.match(text, /### 核心代价、适用边界与深读导览/);
            assert.match(text, /不要把 `0\.85` 写成 `85\.00` 或 `85%`。/);
            assert.match(text, /<paper_input>[\s\S]*\{existingSummary\}[\s\S]*\{textForAnalysis\}[\s\S]*<\/paper_input>/);
        } else if (current === 'prompts/current/gap-fill.md') {
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.match(text, /rubric_version: type-aware-v2/);
            assert.match(text, /0\.0 \/ 1\.5 \/ 3\.0 \/ 6\.0 \/ 8\.0 \/ 10\.0/);
            assert.match(text, /0\.0–10\.0/);
            assert.match(text, /且任务标签（`facet=task`）总数最多 3 个/);
            assert.match(text, /<paper_input>[\s\S]*\{existingAnalysis\}[\s\S]*\{textForAnalysis\}[\s\S]*<\/paper_input>/);
            assert.doesNotMatch(text, /0\.0 \/ 0\.2 \/ 0\.5 \/ 1\.0 \/ 1\.2 \/ 1\.5/);
        } else if (current === 'prompts/current/tag-repair.md') {
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.match(text, /其中必须有上述主任务和主方法，且 `task\.\*` 任务标签最多 3 个。/);
            assert.match(text, /<paper_input>[\s\S]*\{validationFeedback\}[\s\S]*\{textForAnalysis\}[\s\S]*<\/paper_input>/);
        } else if (current === 'prompts/current/method-fill.md') {
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.match(text, /正文不少于 600 个中文字符，且至少分成 3 个由空行分隔的实质自然段（每段超过 20 个字符）。/);
            assert.match(text, /<paper_input>[\s\S]*\{methodSection\}[\s\S]*\{textForAnalysis\}[\s\S]*<\/paper_input>/);
        } else if (['prompts/current/filter.md', 'prompts/current/image-supplement.md', 'prompts/current/opensource-scan.md', 'prompts/current/table-fill.md'].includes(current)) {
            const text = actual.toString();
            assert.notEqual(text, originalBytes.toString());
            assert.match(text, /<paper_input>[\s\S]*<\/paper_input>/);
        } else assert.deepEqual(actual, originalBytes, current);
        assert.deepEqual(evidence.readPromptEvidenceBytes(original, { expectedSha256: sha(originalBytes) }), originalBytes);
        assert.equal(fs.existsSync(path.join(root, original)), false);
        assert.throws(() => evidence.readPromptEvidenceBytes(original, { expectedSha256: 'f'.repeat(64) }));
    }
    for (const stage of ['visualSummary', 'digestCover']) {
        const original = legacy.originalCurrent[stage];
        const bytes = git('show', `${baseline}:${original.path}`);
        assert.deepEqual(evidence.readPromptEvidenceBytes(original.path, { expectedSha256: sha(bytes) }), bytes);
        assert.equal(fs.existsSync(path.join(root, original.path)), false);
        assert.throws(() => registry.currentTextStagePromptPath(stage), /没有登记/);
    }
});

test('central historical codec exactly preserves every original declaration and budget', () => {
    // Execute only the exact former, pure registry module from the original Git
    // commit; no production module, request, data writer or caller JSON is run.
    const scope = { module: { exports: {} } };
    vm.runInNewContext(git('show', `${baseline}:scripts/lib/prompt-text-versions.js`).toString(), scope);
    const previous = scope.module.exports;
    for (const stage of Object.keys(previous.PROMPT_FILE_VERSIONS)) {
        for (const declared of legacy.legacyDeclarations(stage)) {
            assert.equal(registry.promptFilePathForContract(stage, declared), previous.promptFilePathForContract(stage, declared));
        }
        if (Object.hasOwn(registry.PROMPT_FILE_VERSIONS, stage))
            assert.equal(registry.currentPromptTextContract(stage), 'analysis-prompt-text');
        else assert.throws(() => registry.currentPromptTextContract(stage), /没有登记/);
        assert.equal(registry.promptStageMaxTokens(stage, registry.CURRENT_PROMPT_CONTRACT,
            { configured: 64000, localRepair: 16000, legacyCoreSummary: 8000 }), 64000);
        assert.throws(() => registry.promptFilePathForContract(stage, 'unregistered-prompt-declaration'));
        assert.throws(() => registry.promptStageMaxTokens(stage, 'unregistered-prompt-declaration', { configured: 64000 }));
    }
    for (const row of require('../scripts/lib/prompt-legacy-records.json').stages) {
        const original = row.contract;
        const wide = ['analysis-prompt-text-v3', 'analysis-prompt-text-v4', 'analysis-prompt-text-v5'];
        const summary = [...wide, 'analysis-prompt-text-v6', 'analysis-prompt-text-v7'];
        const expected = ['revision', 'structureRepair'].includes(row.stage) && !wide.includes(original) ? 16000
            : row.stage === 'coreSummaryRepair' && !summary.includes(original) ? 8000 : 64000;
        assert.equal(registry.promptStageMaxTokens(row.stage, original,
            { configured: 64000, localRepair: 16000, legacyCoreSummary: 8000 }), expected, row.stage + original);
    }
});

test('stable content declarations cannot borrow another stage or unknown SHA', () => {
    const article = registry.currentTextStagePromptPath('apiReaderArticle');
    const repair = registry.currentTextStagePromptPath('apiReaderRepair');
    const template = file => history.promptTemplateSha256(evidence.readPromptEvidenceBytes(file).toString());
    assert.ok(evidence.declaredPromptTemplateEvidence(article, template(article)));
    assert.equal(evidence.declaredPromptTemplateEvidence(article, template(repair)), null);
    assert.equal(evidence.declaredPromptTemplateEvidence(article, 'f'.repeat(64)), null);
    assert.throws(() => registry.promptFilePathForContract('unknownStage', registry.CURRENT_PROMPT_CONTRACT));
});

test('pre-edit Reader prompt Git blobs remain resolvable by template and whole-file SHA256', () => {
    const preEditCases = [
        {
            stage: 'apiReaderArticle',
            relativePath: 'prompts/current/api-reader-article.md',
            blobOid: 'ac05c8a2fbb62fbfcbfa26975ba8527fdd1c13af',
            wholeSha256: '8fd01908770424562dc68532725b1568b84b29f0eaefc8e63f97bcb7b7ba320d',
            templateSha256: '3d987ea345aee21223f30d514588ee9e2b2f5da7e8cb03894db921809de1cf18'
        },
        {
            stage: 'apiReaderRepair',
            relativePath: 'prompts/current/api-reader-repair.md',
            blobOid: '689c351b7641287148c3cf8bb8d46218abc1eb46',
            wholeSha256: '0037cfe5a2efa88683fcc6d2b1b599d680874b2c8d5fcde1acfec25ce2217e04',
            templateSha256: 'd00b3878979ae2849618cecf4bb8b519fae5292bb154a90281dfac726e3b0598'
        },
        {
            stage: 'apiReaderArticle',
            relativePath: 'prompts/current/api-reader-article.md',
            blobOid: '8b1135b3f5847ee384616b9c3e78b29f88b67a92',
            wholeSha256: '33c0660ab422ff0111eaaf7104bcb2aec87fb36ee1d5d2d7193b45ae43b7a2da',
            templateSha256: 'b97a038f6eb6317b8b25df48c87620acd89f82239b1e84b6d805544bd2f1fb2e'
        },
        {
            stage: 'scoringAudit',
            relativePath: 'prompts/current/scoring-audit.md',
            blobOid: 'e53bb4aca7a140c2b87af1e975ad3b2588375db8',
            wholeSha256: '4240010a4ebe63385bae91e9c35d8410d4feff349d24bcb9d379a76e90fc6089',
            templateSha256: '3d7d425186d96966d41a6169f3a9daa3d53f1579d34867230c2961d05f82cad5'
        },
        {
            stage: 'primaryAnalysis',
            relativePath: 'prompts/current/deep-analysis.md',
            blobOid: '63c2abeddb81e12132d59c39d733a4bea587c210',
            wholeSha256: 'fbe077aba8cd63e24341f0951941b95187400b053a493bff6cfb446d76c2b356',
            templateSha256: '53ad7ae690327a4efdcd909a843e1a0a6577482d4ecc312aaaf656fbb65f198c'
        },
        {
            stage: 'revision',
            relativePath: 'prompts/current/gap-fill.md',
            blobOid: '5fc9f9d395e61ed49fca515b6f81579ad3d6ca72',
            wholeSha256: 'a123550a5999e3be25c7622643c5e4ca07eb9ab5d0efbe3477e914afe3dce4b7',
            templateSha256: '7570b1b356516ef6ffb9e92bf42b331ff1542b0e987a2b4fb2278f7e72665f11'
        },
        {
            stage: 'tagSelection',
            relativePath: 'prompts/current/tag-repair.md',
            expectedStagePath: 'prompts/tag-repair-v3.md',
            blobOid: '35fb7f276c817d037abd60895801c5db0bfa0164',
            wholeSha256: '6edc21d29a772efb33dbe078416bdf1d7ad7e5f7b59f3f97cf99aeacbd56c462',
            templateSha256: '9bd48be61c64914f1d2aba0800a55e526388652afb4f569e4b787786cbd707b8'
        },
        {
            stage: 'methodRepair',
            relativePath: 'prompts/current/method-fill.md',
            expectedStagePath: 'prompts/method-fill-v3.md',
            blobOid: '3eac82836a6292d161f6b5a3d099ec778604856f',
            wholeSha256: '1fb72028192964aa827face9971bb2a5b42ea6d68b8c976b2721fc62faeae70f',
            templateSha256: '9945188fdef3929ca1b48a4c3c7099e916f93c266442b20510f37608d4113a8b'
        },
        {
            stage: null,
            relativePath: 'prompts/current/api-reader-fact-local.md',
            blobOid: 'f400057c762b28cc7f57e91c7cd1ff1761cf702a',
            wholeSha256: 'b92f33baf9fce1816a41fab3d071e73e1167f692827509a98d69e7ce3fdc771b',
            templateSha256: '032dc4df69177b237300ffd228aa82c79ee66c43aa977dfb48f9512d363eacb6'
        },
        {
            stage: 'coreSummaryRepair',
            relativePath: 'prompts/current/core-summary-repair.md',
            blobOid: 'bade528d6286db2f59ba0c6c6f9b2b31b4772eea',
            wholeSha256: 'bc714f37ec63f4c4e44731d80f612f8d1cc280118c014ba8754c2c80d37b26b7',
            templateSha256: 'eb356033d5a26b13ac30613541d5858e7d50f666469583c170b0ce35cf8312ed'
        },
        {
            stage: 'apiReaderRepair',
            relativePath: 'prompts/current/api-reader-repair.md',
            blobOid: 'da378bfb2ce8e9d3d5a2f770dafabcdfa1f9a3d4',
            wholeSha256: '8b4795e31bd2835c3e988ceb4b85040e5af0d11efafdcc36db28c9a00e7d4655',
            templateSha256: '43b810df3b1e51bc79c94de3b17ae93358bd2b479a882b7f8bf3e0e101304173'
        },
        {
            stage: 'scoringAudit',
            relativePath: 'prompts/current/scoring-audit.md',
            blobOid: 'cd059e6cf8a7009bdd53b6a5becf08911c878311',
            wholeSha256: '0b6252f820d00c5d790be921d665c4e0ee1ed0f6bbdf41e46557258780bc0607',
            templateSha256: 'a407e15dddf621806b96ca9ba1d3c78dc5476bb0e0d51a6a2b60970bc2e14c66'
        },
        {
            stage: 'primaryAnalysis',
            relativePath: 'prompts/current/deep-analysis.md',
            blobOid: 'badc08f3f7dc36318fcca93bf6e914b9e483293e',
            wholeSha256: '47be861fead2544080a5ceabd4f00c15cc20d49c8357e031630967ed5232fafa',
            templateSha256: 'c7fe81182d50951654ac824e1fb9e6d8488d45031724692accf2fa0f2dd75d3d'
        },
        {
            stage: 'revision',
            relativePath: 'prompts/current/gap-fill.md',
            blobOid: '7d095bc1c18f104e0ec8b14a73e6c1aee04fd6e3',
            wholeSha256: '3ca5aafaa4afce6a0bfd8462fb9d2114359c22567a641eca851962b8ad280e0f',
            templateSha256: '4e2a2cc7bc5c49646b39ce357282ea2fb351c7857f88014eda0760330eeab845'
        },
        {
            stage: 'apiReaderArticle',
            relativePath: 'prompts/current/api-reader-article.md',
            blobOid: 'aae3871c56189c0375a2e5e08d63a8f73c019fc2',
            wholeSha256: '018f222e4956e4add73c92de328771b0e89bc6ed6bfb7123a976781cc336ffe0',
            templateSha256: 'e24e5f27286c0edae3500c3a29476fa4968059e41e04f26d4446cbb5e2431978'
        },
        {
            stage: 'apiReaderRepair',
            relativePath: 'prompts/current/api-reader-repair.md',
            blobOid: '8f0eaf39da3a0b1bc5766adbfa4203d11da15829',
            wholeSha256: '73588526060a51256dfc37d4cadad977c88a0b28726f7f0912eb8ae4b8ade5ef',
            templateSha256: '3da6195e0b172e79f86923722e2f6fdc25716700186f865658c7dcaa5b1d6cba'
        }
    ];
    for (const item of preEditCases) {
        const expectedBytes = git('cat-file', 'blob', item.blobOid);
        assert.equal(sha(expectedBytes), item.wholeSha256);
        assert.equal(history.promptTemplateSha256(expectedBytes.toString('utf8')), item.templateSha256);

        if (item.stage) {
            const stageMatch = evidence.declaredStagePromptTemplateEvidence(item.stage, item.templateSha256);
            assert.ok(stageMatch, `${item.stage} pre-edit template SHA256 must resolve`);
            assert.equal(stageMatch.path, item.expectedStagePath || item.relativePath);
            assert.equal(stageMatch.fileSha256, item.wholeSha256);
            assert.equal(stageMatch.templateSha256, item.templateSha256);
            assert.deepEqual(stageMatch.bytes, expectedBytes);
            assert.deepEqual(
                history.promptBytesForSha256(item.stage, item.wholeSha256),
                expectedBytes
            );
        }
        const tplMatch = evidence.declaredPromptTemplateEvidence(item.relativePath, item.templateSha256);
        assert.ok(tplMatch, `${item.relativePath} pre-edit template SHA256 must resolve`);
        assert.equal(tplMatch.fileSha256, item.wholeSha256);
        assert.deepEqual(tplMatch.bytes, expectedBytes);

        assert.deepEqual(
            evidence.readDeclaredPromptEvidenceBytes(item.relativePath, item.wholeSha256),
            expectedBytes
        );
        assert.deepEqual(
            history.historicalPromptTemplateBytesForSha256(item.templateSha256),
            expectedBytes
        );
    }
});
