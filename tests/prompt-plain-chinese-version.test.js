'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const registry = require('../scripts/lib/prompt-text-versions');
const evidence = require('../scripts/lib/prompt-evidence');
const history = require('../scripts/lib/prompt-history');
const deep = require('../scripts/deep-analyzer');
const root = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const first = text => text.match(/^(`{3,}|~{3,})(?:text)?\r?\n([\s\S]*?)\r?\n\1/m)[2];
const variables = block => [...new Set([...block.matchAll(/\{([A-Za-z][A-Za-z0-9_]+)\}/g)].map(m => m[1]))].sort();
for (const [stage, old] of Object.entries(registry.FROZEN_PRE_PLAIN_CHINESE_PROMPT_FILES)) {
    test(`${stage} 中文新版本按原路径身份核验Git旧字节、变量和首围栏`, t => {
        const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-old-bytes-'));
        t.after(() => fs.rmSync(empty, {recursive:true, force:true}));
        const current = registry.PROMPT_FILE_VERSIONS[stage];
        assert.equal(registry.promptFilePathForContract(stage, old.contract), old.path);
        assert.equal(registry.promptFilePathForContract(stage, current.contract), current.path);
        assert.notEqual(old.path, current.path);
        const oldBytes = evidence.readPromptEvidenceBytes(old.path);
        const newBytes = evidence.readPromptEvidenceBytes(current.path);
        const oldBlock = first(oldBytes.toString()), newBlock = first(newBytes.toString());
        assert.ok(variables(oldBlock).length > 0);
        if (stage === 'apiReaderRepair') {
            assert.deepEqual(variables(oldBlock), [
                'arxivId', 'mechanicalContract', 'repairTargets',
                'sourceEvidence', 'title', 'validationFeedback'
            ]);
            assert.deepEqual(variables(newBlock), [
                'arxivId', 'mechanicalContract', 'operationProtocol', 'repairTargets',
                'sourceEvidence', 'title', 'validationFeedback'
            ]);
        } else assert.deepEqual(variables(oldBlock), variables(newBlock));
        const filled = newBlock.replace(/\{([A-Za-z][A-Za-z0-9_]+)\}/g, (_all, key) => `样本${key}`);
        assert.deepEqual(variables(filled), []);
        assert.notEqual(sha(oldBlock), sha(newBlock));
        for (const [file, bytes, contract] of [[old.path, oldBytes, old.contract], [current.path, newBytes, current.contract]]) {
            const expected = sha(JSON.stringify({runtimePrompt:first(bytes.toString()), contractVersion:contract}));
            assert.equal(deep.runtimePromptTemplateSha256(file, contract), expected);
            assert.deepEqual(history.promptBytesForSha256(stage, sha(bytes), empty), bytes);
        }
        assert.throws(() => registry.promptFilePathForContract(stage, 'analysis-prompt-text-v99'), /没有登记/);
    });
}
