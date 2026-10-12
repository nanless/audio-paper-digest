'use strict';

// 原渲染器只在独立进程内解析旧响应，不继承生产账号，不调用模型。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const verify = () => { for (const file of input.files) {
    if (!fs.lstatSync(file.filename).isFile() || sha(fs.readFileSync(file.filename)) !== file.sha256) {
        throw new Error('原渲染重放期间 Git 代码发生变化');
    }
} };
verify();
console.log = () => {};
console.warn = () => {};
let networkRequests = 0;
const rejectNetwork = () => { networkRequests++; throw new Error('原付费重放禁止网络请求'); };
for (const name of ['node:http', 'node:https']) {
    const module = require(name); module.request = rejectNetwork; module.get = rejectNetwork;
}
const net = require('node:net'); net.connect = rejectNetwork; net.createConnection = rejectNetwork;
require('node:tls').connect = rejectNetwork;
globalThis.fetch = rejectNetwork;
const directory = process.argv[2];
const environment = fs.readFileSync(path.join(directory, '.env'), 'utf8').trim();
if (environment !== 'PAPER_ANALYZER_ENDPOINT=https://invalid.example/v1\nPAPER_ANALYZER_API_KEY=unused-no-api\nPAPER_ANALYZER_MODEL=muse-spark-1.3-contributor') {
    throw new Error('旧渲染重放只接受临时无效账号配置，不读取生产密钥');
}
const utils = require(path.join(directory, 'scripts/utils'));
let modelRequests = 0;
utils.requestLlmJson = async () => { modelRequests++; throw new Error('原付费重放禁止任何新模型请求'); };
const renderer = require(path.join(directory, 'scripts/deep-analyzer'));
const parsed = renderer.parseApiReaderArticleResult(input.rawDraft, input.parseOptions);
const injected = renderer.injectApiReaderFigures(parsed, input.source.structuredArtifacts, input.paper.arxivId);
const article = renderer.normalizeApiReaderFigureMarkdown(injected.article, input.paper.apiReaderFigures);
verify();
if (modelRequests !== 0 || networkRequests !== 0) throw new Error('原渲染器发生了不允许的请求');
process.stdout.write('PAID_REPLAY_RESULT=' + JSON.stringify({ articleSha256: sha(article), planSha256: renderer.stableFingerprint(injected.plan), modelRequests, networkRequests }));
