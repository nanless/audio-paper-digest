'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { loadTaxonomy, resolveLabel, ancestors, pruneAncestors } = require('../scripts/lib/paper-taxonomy');

test('all shared taxonomy labels, aliases and ancestors agree across Node and Python', () => {
    const taxonomy=loadTaxonomy();
    const labels=[];
    for(const concept of taxonomy.concepts) for(const label of [concept.preferredLabel.zh,concept.preferredLabel.en,...concept.aliases]) {
        labels.push(label,`#${label}`,`  ${label}  `,label.replace(/[a-z]/g,c=>c.toUpperCase()));
    }
    labels.push('未说明','not-a-real-topic','#说话人分离','在线','ＬｏＲＡ','参数高效微调','数据增强','说话人识别');
    const input={labels,ids:taxonomy.concepts.map(c=>c.id),groups:taxonomy.concepts.map(c=>[c.id,...ancestors(taxonomy,c.id)])};
    const expected={version:taxonomy.version,registrySha256:taxonomy.registrySha256,
        resolved:labels.map(label=>resolveLabel(taxonomy,label)?.id||null),
        ancestors:input.ids.map(id=>ancestors(taxonomy,id)),pruned:input.groups.map(ids=>pruneAncestors(taxonomy,ids))};
    const script=[
        'import json, sys',
        'sys.path.insert(0,"scripts")',
        'from paper_taxonomy import load_taxonomy, resolve_label, ancestors, prune_ancestors',
        't=load_taxonomy(); p=json.load(sys.stdin)',
        'r={"version":t["version"],"registrySha256":t["registrySha256"],',
        '"resolved":[(resolve_label(t,s) or {}).get("id") for s in p["labels"]],',
        '"ancestors":[ancestors(t,s) for s in p["ids"]],',
        '"pruned":[prune_ancestors(t,s) for s in p["groups"]]}',
        'print(json.dumps(r,ensure_ascii=False))'
    ].join('\n');
    const result=spawnSync('bash',['scripts/python-runtime.sh','-c',script],{
        cwd:path.resolve(__dirname,'..'),input:JSON.stringify(input),encoding:'utf8',maxBuffer:16*1024*1024,timeout:30000
    });
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),expected);
});
