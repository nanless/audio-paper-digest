'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const crypto = require('node:crypto'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const deep = require('../scripts/deep-analyzer');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
// Actual saved phrases, read-only evidence: additional64-resource-diagnosis /
// actual-cases.json c2f6a175… and niu-historical-resolved-case.json ff2a9571… .
// These isolated fixtures test grammar only, not paper/publication eligibility.
const denied = '来源方面，论文给出代码链接，经核查该链接为第三方可达页面，不能仅据此断定作者资源已正式开源或权重可下载，复现前需自行确认版本与配置。';
const pending = '权重可下载与系统可运行需要另行确认。';
const pendingCheck = '论文给出GitHub链接，第三方检查显示该链接当前可达，但这只证明论文提到该链接，不证明作者已开源全部训练与推理代码，权重可下载与系统可运行需要另行核对。';
const reported = '关于资源可得性，论文正文称统一框架和英文模型检查点已开源，脚注给出地址，但本次核验中第三方镜像链接未能确认可达，来源未确认不代表技术有问题，只是读者在动手前应先自行确认仓库与权重当前是否可下载。';
const ownSource = 'Our unified framework and English model checkpoint are open-sourced.';
const rawPdfSource = 'The proposed Unified ASR framework and the\n'
    + '                                                                   ing datasets. The interaction between unification mechanisms\n'
    + 'English model checkpoint are open-sourced.';
function identity(source) {
    const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha(source), resources: [] };
    return { ...body, identitySha256: deep.stableFingerprint(body) };
}
function issues(text, source = 'No current resource availability was established.') {
    return deep.readerResourceClaimIssues({ sections: [{ kind: 'reproduction', body: text }] }, identity(source), source);
}
test('真实有界推断否定只覆盖受管辖主张，不吞嵌套实物、引述、撤回与独立肯定', () => {
    for (const text of [denied, '不能据此直接断定作者权重已公开或数据集可下载。', '不应仅据此断定本文代码已公开。']) {
        assert.deepEqual(issues(text), [], text);
    }
    for (const text of [
        '不能仅据此断定本文已经公开的代码是当前权重可下载的证据。',
        '不能仅据此断定作者权重已公开，但本文权重已经公开。',
        '并非不能仅据此断定作者权重已公开。',
        '不能否认作者权重已公开。',
        '有人引用“不能仅据此断定作者权重已公开”。',
        '不能仅据此断定作者权重已公开，这一说法是错误的。',
        '不能仅据此断定作者权重已公开，不过上述否定已经被撤销。',
        '不能仅据此断定作者权重已公开；上述否定已经被撤销。'
    ]) assert.ok(issues(text).length, text);
});
test('无计数待确认与正确三回事保持原数量和不同类型校验', () => {
    for (const text of [pending, pendingCheck, '代码开源、权重可下载、系统可运行是三回事，本文只提到演示页链接可用，没有给出代码库可用的证据，因此不要默认能一键运行。',
        '权重可下载和代码可运行仍需分别确认。']) assert.deepEqual(issues(text), [], text);
    for (const text of [
        '权重可下载、代码可运行是三件不同的事，需要分别确认。',
        '权重可下载、代码可运行是三回事，需要分别确认。',
        '权重可下载、模型权重可下载、代码可运行是三回事。',
        '代码开源、权重可下载、系统可运行是三回事；三者均已公开可用。',
        '代码开源、权重可下载、系统可运行是三回事，不过上述区分已经被撤销。',
        '本文提供的权重可下载与系统可运行需要另行确认。',
        pending + '本文权重当前已公开。',
        '权重可下载与系统可运行需要另行确认；它们均已公开可用。',
        '“权重可下载与系统可运行需要另行确认”这一说法不成立。',
        '权重可下载与系统可运行需要另行确认后即可复现。'
    ]) assert.ok(issues(text).length, text);
});
test('待核列表的核对同义仍拒已有实物、独立肯定、引述及撤回', () => {
    for (const text of [
        '本文提供的权重可下载与系统可运行需要另行核对。',
        '权重可下载与系统可运行需要另行核对后即可复现。',
        '权重可下载与系统可运行无需另行核对。',
        '权重可下载与系统可运行需要另行核对，这一说法是错误的。',
        '权重可下载与系统可运行需要另行核对。上述限定已经被撤销。',
        '“权重可下载与系统可运行需要另行核对”这一说法是错误的。',
        '权重可下载与系统可运行需要另行核对；它们均已公开可用。',
        '本文代码已开源，' + pendingCheck,
        pendingCheck + '本文权重已公开。',
        '代码与数据可获取，不等于权重可下载或系统可一键运行，三者要分开确认。'
    ]) assert.ok(issues(text).length, text);
});
test('论文转述仅由同一own checkpoint发布关系及未撤销的当前核验限定支持', () => {
    assert.deepEqual(issues(reported, ownSource), []);
    assert.deepEqual(issues(reported, rawPdfSource), []);
    assert.deepEqual(issues(reported, 'Prior work reports strong results on limited training datasets. ' + rawPdfSource), []);
    assert.deepEqual(issues(reported.replace('统一框架和英文', ''), 'Our model checkpoints are publicly released.'), []);
    for (const source of [
        'Other authors said\n' + ownSource,
        'Other authors reported:\n' + ownSource,
        'The following statement is false:\n' + ownSource,
        'The following statement is false.\n' + ownSource,
        'Other authors reported.\n' + ownSource,
        'The reviewer quotes: "' + ownSource + '"',
        'Our unified framework and English model checkpoint will be open-sourced.',
        'If our unified framework and English model checkpoint are open-sourced, users can reproduce the method.',
        'Our unified framework and English model checkpoint are unlikely to be open-sourced.',
        ownSource.replace('.', ' if the funding is approved.'),
        ownSource + ' This is false.',
        ownSource + ' This claim has been withdrawn.',
        'Our model differs. Another team model checkpoint are open-sourced.',
        'Our model differs. Their English model checkpoint are open-sourced.',
        'Other authors provide their model checkpoint. Our method runs speech recognition. Their English model checkpoint are open-sourced.'
    ]) assert.ok(issues(reported, source).length, source);
    for (const text of [
        reported + '本文模型权重当前已可下载。',
        reported.replace('未能确认可达', '并非未能确认可达'),
        reported.replace('未能确认可达', '未能确认可达这一说法是错误的'),
        reported.replace('未能确认可达', '未能确认可达 **这一说法是错误的**'),
        reported + '上述限定已经被撤销。',
        reported.replace('但本次核验', '但“本次核验').replace('可下载。', '可下载”。'),
        '本文模型权重已经开源，' + reported,
        reported.replace('脚注给出地址，但本次核验中第三方镜像链接未能确认可达，来源未确认不代表技术有问题，只是读者在动手前应先自行确认仓库与权重当前是否可下载', '当前可以下载')
    ]) assert.ok(issues(text, ownSource).length, text);
});
test('Python资源展示经原私有FD桥消费同一规则，不修改身份且拒Source漂移', () => {
    const records = [
        [denied, 'No current release evidence.', true], [pending, 'No current release evidence.', true],
        [reported, rawPdfSource, true], ['权重可下载、代码可运行是三件不同的事，需要分别确认。', 'No current release evidence.', false],
        [reported + '本文权重当前已公开。', ownSource, false]
    ].map(([text, source, allowed]) => ({ allowed, source, paper: {
        id: 'conference:interspeech:2026:conference-paper-id:grammar_fixture', source: 'conference',
        sourceSha256: sha(source), apiReaderResources: identity(source),
        apiReaderPlan: { sections: [{ kind: 'reproduction', heading: '资源与复现' }] },
        apiReaderArticle: '### 资源与复现\n\n' + text
    } }));
    for (const [text, allowed] of [[pendingCheck, true], [pendingCheck + '本文权重已公开。', false]]) records.push({
        allowed, source: 'No current resource availability was established.', paper: {
            id: 'conference:interspeech:2026:conference-paper-id:grammar_fixture', source: 'conference',
            sourceSha256: sha('No current resource availability was established.'),
            apiReaderResources: identity('No current resource availability was established.'),
            apiReaderPlan: { sections: [{ kind: 'reproduction', heading: '资源与复现' }] },
            apiReaderArticle: '### 资源与复现\n\n' + text
        }
    });
    records.push({ ...records[0], source: records[0].source + '\nChanged sealed bytes.', allowed: false });
    const program = `import json,sys\nfrom paper_reader_presentation import replay_resource_presentation\nfor r in json.load(sys.stdin):\n try:\n  resources=replay_resource_presentation(r['paper'],r['source'])\n  assert r['allowed'] and resources == []\n except ValueError:\n  assert not r['allowed']\nprint('shared bridge verified')\n`;
    const result = spawnSync('bash', [path.resolve(__dirname, '../scripts/python-runtime.sh'), '-c', program], {
        input: JSON.stringify(records), encoding: 'utf8', timeout: 30000,
        env: { ...process.env, PYTHONPATH: path.resolve(__dirname, '../scripts') }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /shared bridge verified/);
});
