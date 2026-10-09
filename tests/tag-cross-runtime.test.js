'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadTagCatalog, resolveLabel, ancestors, pruneAncestors } = require('../scripts/lib/tag-catalog');
const { getDefaultTagRules, buildTagPromptText, TAG_PROMPT_TEXT_CONTRACT,
    LEGACY_TAG_PROMPT_TEXT_CONTRACT, TAG_SELECTION_CONTRACT,
    LEGACY_TAG_SELECTION_CONTRACT } = require('../scripts/lib/tag-rules');
const crypto = require('node:crypto');
const { hashTagSectionAndPrimaryTags } = require('../scripts/analysis-contract');
const { parseAnalysis } = require('../scripts/utils');

// 用普通文件提供确定的 EOF；保留原 JSON 字节、Python 读取方式和各用例超时。
function runPythonWithJson(script, input, options) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tag-cross-runtime-input-'));
    const filename = path.join(directory, 'input.json');
    let inputFd;
    try {
        fs.writeFileSync(filename, input, { mode: 0o600, flag: 'wx' });
        inputFd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        return spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
            ...options,
            stdio: [inputFd, 'pipe', 'pipe']
        });
    } finally {
        try {
            if (inputFd !== undefined) fs.closeSync(inputFd);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    }
}

test('两端共用的词表标签、别名和祖先链在 Node 与 Python 下一致', () => {
    const tagCatalog=loadTagCatalog();
    const labels=[];
    for(const concept of tagCatalog.concepts) for(const label of [concept.preferredLabel.zh,concept.preferredLabel.en,...concept.aliases]) {
        labels.push(label,`#${label}`,`  ${label}  `,label.replace(/[a-z]/g,c=>c.toUpperCase()));
    }
    labels.push('未说明','not-a-real-topic','#说话人分离','在线','ＬｏＲＡ','参数高效微调','数据增强','说话人识别');
    const faceted=[['#端到端训练','method'],['#端到端','setting'],['E2E learning','method']];
    const input={labels,faceted,ids:tagCatalog.concepts.map(c=>c.id),groups:tagCatalog.concepts.map(c=>[c.id,...ancestors(tagCatalog,c.id)])};
    const promptTexts = [LEGACY_TAG_PROMPT_TEXT_CONTRACT, TAG_PROMPT_TEXT_CONTRACT]
        .map(projectionContract => {
            const text = buildTagPromptText(tagCatalog, projectionContract);
            return { projectionContract, text,
                sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex') };
        });
    const legacyCatalog = loadTagCatalog(path.resolve(__dirname,
        '../config/tag-catalog-history/a3b75a149852076933ec2895de77c09c73667c8334bff046dde3b20b69ded03d.json'));
    assert.equal(crypto.createHash('sha256').update(
        buildTagPromptText(legacyCatalog, LEGACY_TAG_PROMPT_TEXT_CONTRACT), 'utf8').digest('hex'),
        '96813f030122a5d6b3b5b51da583b40002411355c3bbdfabed3a4b0b6b101b27',
        '显式旧快照与旧提示格式的完整字节保持原 SHA');
    const expected={version:tagCatalog.version,registrySha256:tagCatalog.registrySha256,
        projectionSha256:getDefaultTagRules().projectionSha256,
        selectionContract:TAG_SELECTION_CONTRACT,legacySelectionContract:LEGACY_TAG_SELECTION_CONTRACT,
        promptTexts,
        resolved:labels.map(label=>resolveLabel(tagCatalog,label)?.id||null),
        faceted:faceted.map(([label,facet])=>resolveLabel(tagCatalog,label,facet)?.id||null),
        ancestors:input.ids.map(id=>ancestors(tagCatalog,id)),pruned:input.groups.map(ids=>pruneAncestors(tagCatalog,ids))};
    const script=[
        'import json, sys, faulthandler',
        'faulthandler.dump_traceback_later(30)',
        'sys.path.insert(0,"scripts")',
        'from tag_catalog import load_tag_catalog, resolve_label, ancestors, prune_ancestors, tag_prompt_text_sha256, build_tag_prompt_text, TAG_SELECTION_CONTRACT, LEGACY_TAG_SELECTION_CONTRACT',
        't=load_tag_catalog(); p=json.load(sys.stdin)',
        'prompt_texts=[{"projectionContract":v,"text":build_tag_prompt_text(t,v),"sha256":tag_prompt_text_sha256(t,v)} for v in ["paper-taxonomy-prompt-projection-v1","paper-tag-prompt-text-v2"]]',
        'r={"version":t["version"],"registrySha256":t["registrySha256"],"projectionSha256":tag_prompt_text_sha256(t),',
        '"selectionContract":TAG_SELECTION_CONTRACT,"legacySelectionContract":LEGACY_TAG_SELECTION_CONTRACT,',
        '"promptTexts":prompt_texts,"resolved":[(resolve_label(t,s) or {}).get("id") for s in p["labels"]],',
        '"faceted":[(resolve_label(t,s,f) or {}).get("id") for s,f in p["faceted"]],',
        '"ancestors":[ancestors(t,s) for s in p["ids"]],',
        '"pruned":[prune_ancestors(t,s) for s in p["groups"]]}',
        'print(json.dumps(r,ensure_ascii=False))',
        'faulthandler.cancel_dump_traceback_later()'
    ].join('\n');
    const result=runPythonWithJson(script, JSON.stringify(input), {
        cwd:path.resolve(__dirname,'..'),encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000
    });
    const diagnostics=JSON.stringify({errorCode:result.error?.code||null,
        errorMessage:result.error?.message||null,signal:result.signal,status:result.status,stderr:result.stderr});
    assert.equal(result.error,undefined,diagnostics);
    assert.equal(result.status,0,diagnostics);
    assert.deepEqual(JSON.parse(result.stdout),expected);
});

test('当前词表和显式旧版词表的分析约定在 Node 与 Python 下一致', () => {
    const document = ({ tags, task, method, summaryTask = task, summaryMethod = method }) => `## 评分
6.0/10

## 机器摘要
primary_task_tag: ${summaryTask || ''}
primary_method_tag: ${summaryMethod || ''}

## 标签
${tags}
${task === undefined ? '' : `主任务标签: ${task}`}
${method === undefined ? '' : `主方法标签: ${method}`}
`;
    const fixtures = [
        { name: 'current-valid', legacyTags: false, text: document({
            tags: '#语音识别 #Transformer #低资源', task: '#语音识别', method: '#Transformer'
        }) },
        { name: 'current-no-positional-fallback', legacyTags: false, text: document({
            tags: '#语音识别 #Transformer #低资源', task: undefined, method: undefined
        }) },
        { name: 'current-alias-rejected', legacyTags: false, text: document({
            tags: '#ASR #TTA #低资源', task: '#ASR', method: '#TTA'
        }) },
        { name: 'current-requires-hash-and-exact-preferred-label', legacyTags: false, text: document({
            tags: '语音识别 Transformer 低资源', task: '语音识别', method: 'Transformer'
        }) },
        { name: 'legacy-alias-explicit', legacyTags: true, text: document({
            tags: '#ASR #TTA #低资源', task: '#ASR', method: '#TTA'
        }) },
        { name: 'legacy-ambiguous-end-to-end-is-disambiguated-only-by-method-role', legacyTags: true, text: document({
            tags: '#语音识别 #端到端 #鲁棒性', task: '#语音识别', method: '#端到端'
        }) },
        { name: 'current-old-end-to-end-method-alias-rejected', legacyTags: false, text: document({
            tags: '#语音识别 #端到端 #鲁棒性', task: '#语音识别', method: '#端到端'
        }) },
        { name: 'legacy-ambiguous-supplemental-not-guessed', legacyTags: true, text: document({
            tags: '#语音识别 #Transformer #端到端', task: '#语音识别', method: '#Transformer'
        }) },
        { name: 'model-family-is-not-method', legacyTags: false, text: document({
            tags: '#音频理解 #统一音频模型 #低资源', task: '#音频理解', method: '#统一音频模型'
        }) },
        { name: 'ancestor-selection-rejected', legacyTags: false, text: document({
            tags: '#语音识别 #音视频语音识别 #Transformer', task: '#语音识别', method: '#Transformer'
        }) },
        { name: 'duplicate-selection-rejected', legacyTags: false, text: document({
            tags: '#语音识别 #语音识别 #Transformer', task: '#语音识别', method: '#Transformer'
        }) },
        { name: 'four-task-facet-selection-rejected', legacyTags: false, text: document({
            tags: '#语音合成 #语音克隆 #音视频生成 #音频理解 #Transformer',
            task: '#语音合成', method: '#Transformer'
        }) },
        { name: 'three-task-facet-selection-accepted-with-specificity-warning', legacyTags: false,
            text: document({
                tags: '#语音合成 #语音克隆 #语音转换 #Transformer',
                task: '#语音合成', method: '#Transformer'
            }) },
        { name: 'non-leaf-primary-task-warns-but-stays-valid', legacyTags: false, text: document({
            tags: '#语音识别 #低资源 #Transformer', task: '#语音识别', method: '#Transformer'
        }) },
        { name: 'missing-tag-section-rejected', legacyTags: false,
            text: '## 评分\n6.0/10\n\n## 机器摘要\nprimary_task_tag: #语音识别\nprimary_method_tag: #Transformer\n' },
    ];
    const project = path.resolve(__dirname, '..');
    const script = [
        'import json, sys',
        'sys.path.insert(0,"scripts")',
        'from utils import parse_analysis',
        'from publish_common import _hash_tag_section_and_primary_tags',
        'items=json.load(sys.stdin)',
        'keys=("tags","primaryTaskTag","primaryMethodTag","tagValidation")',
        'out=[]',
        'for item in items:',
        '    parsed=parse_analysis(item["text"],legacy_tags=item["legacyTags"])',
        '    out.append({**{key:parsed[key] for key in keys},"taxonomySurfaceSha256":_hash_tag_section_and_primary_tags(item["text"])})',
        'print(json.dumps(out,ensure_ascii=False))'
    ].join('\n');
    const result = runPythonWithJson(script, JSON.stringify(fixtures), {
        cwd: project, encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024, timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    const python = JSON.parse(result.stdout);
    const keys = ['tags', 'primaryTaskTag', 'primaryMethodTag', 'tagValidation'];
    const node = fixtures.map(item => {
        const parsed = parseAnalysis(item.text, { legacyTags: item.legacyTags });
        return { ...Object.fromEntries(keys.map(key => [key, parsed[key]])),
            taxonomySurfaceSha256: hashTagSectionAndPrimaryTags(item.text) };
    });
    fixtures.forEach((fixture, index) => assert.deepEqual(
        python[index], node[index], fixture.name));
});


test('评价标题的围栏、Unicode 空白、CRLF 和重复判别在两端一致', () => {
    const rules = require('../scripts/lib/analysis-section-titles.js');
    const inputs = [
        '## 毒舌点评\n旧评价。\n## 核心摘要\n摘要。',
        '## 论文评价\n新评价。\n## 核心摘要\n摘要。',
        '## 毒舌点评\n\n## 论文评价\n',
        '## 论文评价\n相同。\n## 论文评价\n相同。',
        '## 毒舌点评\n相同。\n## 毒舌点评\n相同。',
        '普通句讨论论文评价。\n### 论文评价\n小标题。\n## 核心摘要\n摘要。',
        '```text\n## 毒舌点评\n```\n## 论文评价\n真实评价。',
        '~~~text\n## 论文评价\n~~~\n## 毒舌点评\n真实评价。',
        '## 论文评价：：\n无效标题。\n## 毒舌点评\n真实评价。'
    ];
    for (const whitespace of [' ', '\t', '\u3000', '\u00a0', '']) {
        for (const newline of ['\n', '\r\n']) {
            inputs.push(`##${whitespace}论文评价${whitespace}：${whitespace}${newline}真实评价。${newline}## 核心摘要${newline}摘要。`);
            inputs.push(`##${whitespace}毒舌点评${whitespace}${newline}旧评价。${newline}##${whitespace}论文评价${whitespace}${newline}新评价。`);
        }
    }
    const expected = inputs.map(text => ({
        headings: rules.analysisSectionHeadings(text).map(heading => heading.title),
        duplicate: Boolean(rules.getPaperEvaluationHeadingIssue(text)),
        evaluation: rules.extractAnalysisSection(text, '论文评价')
    }));
    const script = [
        'import json,sys',
        'sys.path.insert(0,"scripts")',
        'from analysis_sections import analysis_heading_titles,evaluation_heading_issue,extract_evaluation_section',
        'inputs=json.load(sys.stdin)',
        'print(json.dumps([{"headings":analysis_heading_titles(text),"duplicate":bool(evaluation_heading_issue(text)),"evaluation":extract_evaluation_section(text)} for text in inputs],ensure_ascii=False))'
    ].join('\n');
    const result = runPythonWithJson(script, JSON.stringify(inputs), {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', timeout: 120000
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
});

test('新旧标签缓存的字段冲突和缺失读取在两端一致', () => {
    const { readTagValidation } = require('../scripts/utils.js');
    const value = { valid: true, errors: [], registryVersion: 'paper-taxonomy-v1',
        registrySha256: 'a'.repeat(64), primaryTaskId: 'task.asr',
        primaryMethodId: 'method.transformer', conceptIds: ['task.asr', 'method.transformer'],
        specificityWarning: null };
    const inputs = [null, [], {}, { tagValidation: value }, { taxonomyValidation: value },
        { tagValidation: null }, { taxonomyValidation: [] }, { tagValidation: 'invalid' },
        { tagValidation: {}, taxonomyValidation: {} }, { tagValidation: null, taxonomyValidation: null },
        { tagValidation: value, taxonomyValidation: value },
        { tagValidation: value, taxonomyValidation: { valid: false } }];
    const expected = inputs.map(input => {
        try { return { value: readTagValidation(input), error: null }; }
        catch (error) { return { value: null, error: error.message }; }
    });
    const script = [
        'import json,sys',
        'sys.path.insert(0,"scripts")',
        'from utils import read_tag_validation',
        'out=[]',
        'for item in json.load(sys.stdin):',
        '    try: out.append({"value":read_tag_validation(item),"error":None})',
        '    except ValueError as error: out.append({"value":None,"error":str(error)})',
        'print(json.dumps(out,ensure_ascii=False))'
    ].join('\n');
    const result = runPythonWithJson(script, JSON.stringify(inputs), {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024, timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
});

test('标签阶段的旧新完整绑定、只读结果和拒绝边界在两端一致', () => {
    const records = require('../scripts/lib/tag-stage-record.js');
    const contract = require('../scripts/analysis-contract.js');
    const { validAnalysisPaper } = require('./valid-analysis-fixture.js');
    const legacy = validAnalysisPaper('2608.12345');
    const current = structuredClone(legacy);
    const oldStage = current.analysisManifest.stages.taxonomySeal;
    const newStage = Object.fromEntries(Object.entries(oldStage).map(([key, value]) =>
        key === 'taxonomySurfaceSha256' ? ['tagSectionAndPrimaryTagsSha256', value] : [key, value]));
    newStage.bindingSha256 = contract.manualSha256(Object.fromEntries(
        records.TAG_STAGE_BINDING_FIELDS.map(key => [key, newStage[key]])));
    delete current.analysisManifest.stages.taxonomySeal;
    current.analysisManifest.stages.tagSelection = newStage;
    delete current.analysisManifest.contracts.taxonomy;
    current.analysisManifest.contracts.tagSelectionRecord = records.TAG_STAGE_RECORD_CONTRACT;
    current.analysisStageCheckpoints.tagSelection = current.analysisStageCheckpoints.taxonomySeal;
    delete current.analysisStageCheckpoints.taxonomySeal;
    const fixtures = [];
    for (const [name, paper, stageKey, checkpointKey] of [
        ['旧', legacy, 'taxonomySeal', 'taxonomySeal'],
        ['新', current, 'tagSelection', 'tagSelection']
    ]) {
        for (const status of ['complete', 'not_needed']) {
            const value = structuredClone(paper);
            value.analysisManifest.stages[stageKey].status = status;
            if (status === 'complete') value.analysisStageCheckpoints.structureRepair = value.analysisStageCheckpoints[checkpointKey];
            fixtures.push({ name: `${name}格式-${status}`, paper: value, valid: true });
        }
    }
    for (const [name, paper] of [['旧', legacy], ['新', current]]) {
        const value = structuredClone(paper);
        const record = records.readTagStageRecord(value.analysisManifest, value.analysisStageCheckpoints);
        record.stage.selectionContract = 'paper-tag-selection-v2';
        if (record.format === 'legacy') value.analysisManifest.contracts.taxonomy = record.stage.selectionContract;
        record.stage.bindingSha256 = contract.manualSha256(Object.fromEntries(
            record.bindingFields.map(key => [key, record.stage[key]])));
        fixtures.push({ name: `${name}格式-新选择协议`, paper: value, valid: true });
    }
    const addInvalid = (name, mutate) => {
        const paper = structuredClone(current);
        mutate(paper);
        fixtures.push({ name, paper, valid: false });
    };
    addInvalid('复制旧签名到新记录', p => { p.analysisManifest.stages.tagSelection.bindingSha256 = oldStage.bindingSha256; });
    addInvalid('双阶段同值', p => { p.analysisManifest.stages.taxonomySeal = p.analysisManifest.stages.tagSelection; });
    addInvalid('双阶段空值', p => { p.analysisManifest.stages.taxonomySeal = null; });
    addInvalid('双合同空值', p => { p.analysisManifest.contracts.taxonomy = null; });
    addInvalid('双检查点同值', p => { p.analysisStageCheckpoints.taxonomySeal = p.analysisStageCheckpoints.tagSelection; });
    addInvalid('跨格式检查点', p => {
        p.analysisStageCheckpoints.taxonomySeal = p.analysisStageCheckpoints.tagSelection;
        delete p.analysisStageCheckpoints.tagSelection;
    });
    addInvalid('双内容哈希同值', p => {
        p.analysisManifest.stages.tagSelection.taxonomySurfaceSha256 = p.analysisManifest.stages.tagSelection.tagSectionAndPrimaryTagsSha256;
    });
    addInvalid('未知保存版本', p => { p.analysisManifest.contracts.tagSelectionRecord = 'unknown'; });
    addInvalid('未知选择协议但绑定有效', p => {
        const stage = p.analysisManifest.stages.tagSelection;
        stage.selectionContract = 'unknown';
        stage.bindingSha256 = contract.manualSha256(Object.fromEntries(
            records.TAG_STAGE_BINDING_FIELDS.map(key => [key, stage[key]])));
    });
    const mismatchedLegacy = structuredClone(legacy);
    mismatchedLegacy.analysisManifest.contracts.taxonomy = 'paper-tag-selection-v2';
    fixtures.push({ name: '旧格式合同与选择协议错配', paper: mismatchedLegacy, valid: false });
    addInvalid('检查点正文改变', p => { p.analysisStageCheckpoints.tagSelection += '\n检查点变化'; });
    addInvalid('摘要输入改变', p => { p.analysisManifest.stages.coreSummaryRepair.inputAnalysisSha256 = '0'.repeat(64); });
    fixtures.push({ name: '尚未完成的新阶段', valid: false,
        paper: { analysisManifest: { stages: { tagSelection: { status: 'transient_failure', error: '原错误' } } } } });
    const original = JSON.stringify(fixtures);
    const expected = fixtures.map(({ name, paper, valid }) => {
        let record, error = null;
        try { record = records.readTagStageRecord(paper.analysisManifest, paper.analysisStageCheckpoints); }
        catch (issue) { error = issue.message; }
        const accepted = contract.validateTagStageProof(paper, { parsed: parseAnalysis(paper.analysis) }) === null;
        assert.equal(accepted, valid, name);
        if (!record) return { record: null, error, accepted };
        const binding = record.stage?.bindingSha256
            ? Object.fromEntries(record.bindingFields.map(key => [key, record.stage[key]])) : null;
        return { record: { ...record, stage: record.stage ?? null, checkpoint: record.checkpoint ?? null },
            binding, bindingSha256: binding ? contract.manualSha256(binding) : null, error, accepted };
    });
    const script = [
        'import json,sys',
        'sys.path.insert(0,"scripts")',
        'from tag_stage_record import read_tag_stage_record',
        'from publish_common import _validate_tag_stage_record, _manual_hash, PublishDataValidationError',
        'out=[]',
        'for item in json.load(sys.stdin):',
        '    paper=item["paper"]; record=None; error=None',
        '    try: record=read_tag_stage_record(paper.get("analysisManifest"),paper.get("analysisStageCheckpoints"))',
        '    except ValueError as issue: error=str(issue)',
        '    try: _validate_tag_stage_record(paper,paper.get("analysisManifest"),"论文"); accepted=True',
        '    except PublishDataValidationError: accepted=False',
        '    if record is None: out.append({"record":None,"error":error,"accepted":accepted}); continue',
        '    stage=record["stage"]',
        '    binding={key:stage.get(key) for key in record["bindingFields"]} if isinstance(stage,dict) and stage.get("bindingSha256") else None',
        '    out.append({"record":record,"binding":binding,"bindingSha256":_manual_hash(binding) if binding is not None else None,"error":error,"accepted":accepted})',
        'print(json.dumps(out,ensure_ascii=False))'
    ].join('\n');
    const result = runPythonWithJson(script, JSON.stringify(fixtures), {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024, timeout: 30000
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), expected);
    assert.equal(JSON.stringify(fixtures), original, '两端读取和验证不能改写原记录');
});
