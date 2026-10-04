'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadTagCatalog, resolveLabel, ancestors, pruneAncestors } = require('../scripts/lib/tag-catalog');
const { getDefaultTagRules } = require('../scripts/lib/tag-rules');
const { hashTagSectionAndPrimaryTags } = require('../scripts/analysis-contract');
const { parseAnalysis } = require('../scripts/utils');

test('all shared taxonomy labels, aliases and ancestors agree across Node and Python', () => {
    const tagCatalog=loadTagCatalog();
    const labels=[];
    for(const concept of tagCatalog.concepts) for(const label of [concept.preferredLabel.zh,concept.preferredLabel.en,...concept.aliases]) {
        labels.push(label,`#${label}`,`  ${label}  `,label.replace(/[a-z]/g,c=>c.toUpperCase()));
    }
    labels.push('未说明','not-a-real-topic','#说话人分离','在线','ＬｏＲＡ','参数高效微调','数据增强','说话人识别');
    const faceted=[['#端到端训练','method'],['#端到端','setting'],['E2E learning','method']];
    const input={labels,faceted,ids:tagCatalog.concepts.map(c=>c.id),groups:tagCatalog.concepts.map(c=>[c.id,...ancestors(tagCatalog,c.id)])};
    const expected={version:tagCatalog.version,registrySha256:tagCatalog.registrySha256,
        projectionSha256:getDefaultTagRules().projectionSha256,
        resolved:labels.map(label=>resolveLabel(tagCatalog,label)?.id||null),
        faceted:faceted.map(([label,facet])=>resolveLabel(tagCatalog,label,facet)?.id||null),
        ancestors:input.ids.map(id=>ancestors(tagCatalog,id)),pruned:input.groups.map(ids=>pruneAncestors(tagCatalog,ids))};
    const script=[
        'import json, sys',
        'sys.path.insert(0,"scripts")',
        'from tag_catalog import load_tag_catalog, resolve_label, ancestors, prune_ancestors, tag_prompt_text_sha256',
        't=load_tag_catalog(); p=json.load(sys.stdin)',
        'r={"version":t["version"],"registrySha256":t["registrySha256"],"projectionSha256":tag_prompt_text_sha256(t),',
        '"resolved":[(resolve_label(t,s) or {}).get("id") for s in p["labels"]],',
        '"faceted":[(resolve_label(t,s,f) or {}).get("id") for s,f in p["faceted"]],',
        '"ancestors":[ancestors(t,s) for s in p["ids"]],',
        '"pruned":[prune_ancestors(t,s) for s in p["groups"]]}',
        'print(json.dumps(r,ensure_ascii=False))'
    ].join('\n');
    const result=spawnSync('bash',['scripts/python-runtime.sh','-c',script],{
        cwd:path.resolve(__dirname,'..'),input:JSON.stringify(input),encoding:'utf8',maxBuffer:16*1024*1024,timeout:120000
    });
    const diagnostics=JSON.stringify({errorCode:result.error?.code||null,
        errorMessage:result.error?.message||null,signal:result.signal,status:result.status,stderr:result.stderr});
    assert.equal(result.error,undefined,diagnostics);
    assert.equal(result.status,0,diagnostics);
    assert.deepEqual(JSON.parse(result.stdout),expected);
});

test('current and explicit legacy analysis taxonomy contracts agree across Node and Python', () => {
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
        'keys=("tags","primaryTaskTag","primaryMethodTag","taxonomyValidation")',
        'out=[]',
        'for item in items:',
        '    parsed=parse_analysis(item["text"],legacy_tags=item["legacyTags"])',
        '    out.append({**{key:parsed[key] for key in keys},"taxonomySurfaceSha256":_hash_tag_section_and_primary_tags(item["text"])})',
        'print(json.dumps(out,ensure_ascii=False))'
    ].join('\n');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
        cwd: project, input: JSON.stringify(fixtures), encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024, timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    const python = JSON.parse(result.stdout);
    const keys = ['tags', 'primaryTaskTag', 'primaryMethodTag', 'taxonomyValidation'];
    const node = fixtures.map(item => {
        const parsed = parseAnalysis(item.text, { legacyTags: item.legacyTags });
        return { ...Object.fromEntries(keys.map(key => [key, parsed[key]])),
            taxonomySurfaceSha256: hashTagSectionAndPrimaryTags(item.text) };
    });
    fixtures.forEach((fixture, index) => assert.deepEqual(
        python[index], node[index], fixture.name));
});
