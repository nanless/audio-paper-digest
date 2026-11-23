'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const child = require('node:child_process'), path = require('node:path');
const shared = require('../scripts/lib/filter-decision');
const fetcher = require('../scripts/fetch-papers');
const conference = require('../scripts/lib/conference-filter');
const { renderFilterPrompt } = require('../scripts/lib/filter-prompt');
const utils = require('../scripts/utils');
const { LLM_FILTER_PROMPT_PATH } = require('../scripts/lib/prompt-contracts');

test('日更兼容export与会议声明共用稳定解析身份并保留原决定语义', () => {
    assert.equal(fetcher.parseFilterDecision, shared.parseFilterDecision);
    assert.equal(fetcher.parseFilterDecisionDetails, shared.parseFilterDecisionDetails);
    assert.equal(require('../scripts/lib/protocol-codec').isCurrentHeader(shared.FILTER_DECISION_PROFILE, 'filter-decision'), true);
    assert.deepEqual(require('../scripts/config').FILTER_CONFIG.decisionContractProfile, shared.FILTER_DECISION_PROFILE);
    assert.equal(conference.DAILY_DECISION_PARSER_CONTRACT, shared.FILTER_DECISION_CONTRACT);
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

test('筛选解析处理多空白否定、拒绝 Unrelated/Not related 标签反转，并抵抗土耳其 İ 索引漂移', () => {
    const turkishJson = 'İİİ {"related": false, "reason": "pure vision"}';
    const parsedTurkish = shared.parseFilterDecisionDetails(turkishJson, 'p-turkish');
    assert.equal(parsedTurkish.related, false);
    assert.equal(parsedTurkish.parseSource, 'json');

    for (const multiSpace of [
        'Conclusion: not  related',
        'Conclusion: not\trelated',
        'Conclusion: not-related',
        'Conclusion: non-related',
        'Conclusion: un related',
        'Conclusion: un_related',
        '{"decision": "not  related", "reason": "off topic"}',
        '{"decision": "not-related", "reason": "off topic"}',
        '{"decision": "unrelated", "reason": "off topic"}',
        'Reason: text only\nnot  related',
        'Reason: text only\nnot-related'
    ]) {
        const res = shared.parseFilterDecisionDetails(multiSpace, 'p-ws');
        assert.equal(res.related, false, multiSpace);
    }

    for (const tricky of [
        'Unrelated: yes',
        'Not related: yes',
        'not-related: yes',
        'Not-Related: yes',
        'Non-related: yes',
        'non related: yes',
        'un-related: yes',
        'un related: yes',
        'no related: yes',
        '不相关结论: 是',
        '非相关判断: 是',
        '无关判断: 是',
        '无关结论: 是',
        '不相关的结论: 是',
        '无关的判断: 是'
    ]) {
        const res = shared.parseFilterDecisionDetails(tricky, 'p-tricky');
        assert.notEqual(res.related, true, tricky);
    }

    for (const multiSpaceNeg of ['Not  related: yes', 'Not\trelated: yes', 'Un  related: yes']) {
        const res = shared.parseFilterDecisionDetails(multiSpaceNeg, 'p-neg');
        assert.equal(res.related, null, multiSpaceNeg);
        assert.equal(res.parseSource, 'keyword_negative_retryable', multiSpaceNeg);
        assert.equal(res.suggestedRelated, false, multiSpaceNeg);
    }

    // 否定 lookbehind 不得跨行吞掉上一行末尾的 not/no 导致下一行正常 Conclusion 失效；同时保留冒号后换行的合法多行结论与跨行负值
    const crossLinePos = shared.parseFilterDecisionDetails('Reason: whether audio-related or not\nConclusion: related', 'p-nl-pos');
    assert.equal(crossLinePos.related, true);
    assert.equal(crossLinePos.parseSource, 'conclusion_line');
    const crossLineNeg = shared.parseFilterDecisionDetails('Reason: yes or no\nConclusion: not related', 'p-nl-neg');
    assert.equal(crossLineNeg.related, false);
    assert.equal(crossLineNeg.parseSource, 'conclusion_line');
    const wrappedNeg = shared.parseFilterDecisionDetails('Conclusion: not\nrelated', 'p-wrap-neg');
    assert.equal(wrappedNeg.related, false);
    assert.equal(wrappedNeg.parseSource, 'conclusion_line');
    const multilinePos = shared.parseFilterDecisionDetails('Conclusion:\nrelated\nReason: speech', 'p-ml-pos');
    assert.equal(multilinePos.related, true);
    assert.equal(multilinePos.parseSource, 'conclusion_line');
    const multilineZh = shared.parseFilterDecisionDetails('结论：\n相关。', 'p-ml-zh');
    assert.equal(multilineZh.related, true);
    assert.equal(multilineZh.parseSource, 'conclusion_line');
    const standaloneNegLine = shared.parseFilterDecisionDetails('Not\nrelated: yes', 'p-standalone-neg');
    assert.notEqual(standaloneNegLine.related, true);
});
