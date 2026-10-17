'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const child = require('node:child_process'), path = require('node:path');
const shared = require('../scripts/lib/filter-decision');
const fetcher = require('../scripts/fetch-papers');
const conference = require('../scripts/lib/conference-filter');
const { renderFilterPrompt } = require('../scripts/lib/filter-prompt');
const utils = require('../scripts/utils');
const { LLM_FILTER_PROMPT_PATH } = require('../scripts/lib/prompt-text-versions');

test('日更兼容export与会议声明共用同一原v3解析契约', () => {
    assert.equal(fetcher.parseFilterDecision, shared.parseFilterDecision);
    assert.equal(fetcher.parseFilterDecisionDetails, shared.parseFilterDecisionDetails);
    assert.equal(shared.FILTER_DECISION_VERSION, 3);
    assert.equal(shared.FILTER_DECISION_CONTRACT, 'filter-decision-contract-v3');
    assert.equal(require('../scripts/config').FILTER_CONFIG.decisionContractVersion, 3);
    assert.equal(conference.DAILY_DECISION_PARSER_VERSION, shared.FILTER_DECISION_CONTRACT);
    for (const [input, related, reason, parseSource] of [
        ['{"Decision":"not_related","reason":"text only"}', false, 'text only', 'json'],
        ['{"related":false,"reason":"仅文本"}', false, '仅文本', 'json'],
        ['{"conclusion":true,"rationale":"speech task"}', true, 'speech task', 'json'],
        ['理由：是否相关仅为问题。\n结论：不相关', false, '是否相关仅为问题。', 'conclusion_line'],
        ['Reason: speech task\nConclusion: related', true, 'speech task', 'conclusion_line'],
        ['只依据明确结论\nno', false, '只依据明确结论 no', 'last_line']
    ]) {
        const result = shared.parseFilterDecisionDetails(input, 'synthetic-filter');
        assert.deepEqual(result, { related, reason, rawResponse: input, parseSource });
        assert.equal(conference.parseLlmDecisionText(input).status, related ? 'included' : 'excluded');
    }
});

test('关键词、空答案与否定推测仍不可升级正式决定，会议旧JSON严格边界保留', () => {
    for (const input of ['', 'This appears related but has no final answer.', '这与音频不相关，但没有结论行。']) {
        const parsed = shared.parseFilterDecisionDetails(input);
        assert.equal(parsed.related, null); assert.equal(parsed.retryable, true); assert.equal(parsed.fallback, true);
        assert.throws(() => conference.parseLlmDecisionText(input));
    }
    assert.deepEqual(conference.parseLlmDecisionText('{"decision":"included","reason":"legacy paid"}'),
        { status: 'included', reason: 'legacy paid', parseSource: 'legacy_conference_json' });
    for (const input of ['{"decision":"included","reason":"x","extra":1}',
        '{"decision":"included","decision":"excluded","reason":"x"}'])
        assert.throws(() => conference.parseLlmDecisionText(input));
});

test('会议和纯parser不再反向加载日更抓取入口', () => {
    const code = `process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
        const Module=require('node:module'),load=Module._load;
        Module._load=function(name,...rest){if(/fetch-papers(?:\\.js)?$/.test(name))throw Error('fetch entry forbidden');return load.call(this,name,...rest)};
        const pure=require('./scripts/lib/filter-decision');
        if(Object.keys(require.cache).some(p=>p.endsWith('/scripts/config.js')))throw Error('pure parser imported config');
        if(pure.parseFilterDecision('结论：相关')!==true)throw Error('parser result');
        const api=require('./scripts/lib/conference-filter');
        if(api.parseLlmDecisionText('结论：不相关').status!=='excluded')throw Error('conference result');`;
    child.execFileSync(process.execPath, ['-e', code], { cwd: path.resolve(__dirname, '..'), timeout: 15000 });
});

test('共享Prompt仅接已准备字段，保留原值转换、单次替换和会议字段适配', () => {
    for (const fields of [
        { title: 'Audio {abstract}', abstract: '保留 {categories}', categories: ['cs.SD', 'eess.AS'] },
        { title: undefined, abstract: '', categories: undefined },
        { title: '标题', abstract: null, categories: 'speech, track' }
    ]) assert.equal(renderFilterPrompt(fields, LLM_FILTER_PROMPT_PATH), utils.loadPrompt(LLM_FILTER_PROMPT_PATH, fields));
    const envelope = { metadataRecord: { title: 'Audio {abstract}', abstract: 'speech',
        track: 'main', categories: ['cs.SD'] }, discovery: { conference: { id: 'interspeech-2026' } } };
    const record = envelope.metadataRecord;
    assert.equal(conference.renderDailyFilterPrompt(envelope), utils.loadPrompt(LLM_FILTER_PROMPT_PATH,
        { title: String(record.title), abstract: String(record.abstract),
            categories: conference.conferencePromptCategories(record, 'interspeech-2026').join(', ') }));
    assert.equal(conference.LLM_FILTER_PROMPT, utils.loadPrompt(LLM_FILTER_PROMPT_PATH,
        { title: '{title}', abstract: '{abstract}', categories: '{categories}' }));
});
