const fs=require('fs'), path=require('path');
const workdir='/Users/francis7999/code/github_repos/audio-paper-digest';
const taskRoot=path.join(workdir,'data/current/manual-v6/2026-08-29/task-runner/tasks/2608.26925');
const finalPath=path.join(taskRoot,'draft/final-article.md');
let text=fs.readFileSync(finalPath,'utf8');

// Load payload to get deterministic tables
const payload=JSON.parse(fs.readFileSync(path.join(taskRoot,'draft/revision-record-payload.json'),'utf8'));
const tables=payload.editorial.longformBundle.tables;
function getRendered(id){ const t=tables.find(x=>x.sourceTableId===id); return t ? t.renderedMarkdown : null; }

// For each table, replace Chinese version with deterministic
// B08: TAB0001
const tab1=getRendered('TAB0001');
console.log('TAB0001 deterministic preview', tab1.slice(0,120).replace(/\n/g,'\\n'));
console.log('Searching for Chinese table in final article...');
// Find Chinese table for TAB0001: contains "最小持续 local"
if(text.includes('| 方法 | \\(\\tau\\)')){
  console.log('found Chinese TAB0001');
  // Replace the whole table block (from | 方法 ... to last row)
  const chineseTable=`| 方法 | \\(\\tau\\) | \\(\\gamma\\) | \\(\\theta\\) | 最小持续 local | 最小持续 global | pad_on | pad_off |
|---|---|---|---|---|---|---|---|
| CFA | N/A | 0.7 | 0.6 | 0.2 | 0.2 | 0.0 | 0.1 |
| DFA | 3 | N/A | 0.7 | 0.2 | 0.2 | 0.0 | 0.1 |`;
  if(text.includes(chineseTable)){
    text=text.replace(chineseTable, tab1);
    console.log('replaced TAB0001');
  } else {
    console.log('chineseTable not found verbatim');
    // Try to find via regex
    const re=/\| 方法 \|.*?\| DFA \| 3 \| N\/A.*?\| 0\.1 \|/s;
    const m=text.match(re);
    console.log(m? m[0].slice(0,200): 'no match');
  }
}

// TAB0002 etc are Chinese main results tables - they are more complex, but we can replace the Chinese main results table with deterministic
const tab2=getRendered('TAB0002');
console.log('TAB0002 deterministic start', tab2.slice(0,200).replace(/\n/g,'\\n'));
// Chinese main results table starts with "| 方法 | 挖掘 | 发现"
if(text.includes('| 方法 | 挖掘 | 发现')){
  console.log('found Chinese main results');
  // Need to extract Chinese table block: from "| 方法 | 挖掘" to last row "| CFA | pos vs sem neg | 61.5 | 47.5 |"
  const start=text.indexOf('| 方法 | 挖掘 | 发现');
  const endMarker='| CFA | pos vs sem neg | 61.5 | 47.5 |';
  const end=text.indexOf(endMarker);
  if(start!==-1 && end!==-1){
    const chineseBlock=text.slice(start, end+endMarker.length);
    console.log('chineseBlock len', chineseBlock.length);
    text=text.slice(0,start)+tab2+text.slice(end+endMarker.length);
    console.log('replaced TAB0002');
  }
}

// TAB0004 etc: there are two tables in B10: hyper? Actually diagnostic tables
const tab4=getRendered('TAB0004');
const tab5=getRendered('TAB0005');
console.log('TAB0004', tab4.slice(0,150).replace(/\n/g,'\\n'));
console.log('TAB0005', tab5.slice(0,150).replace(/\n/g,'\\n'));
// In final article, B10 has a table for cross-lingual gap: contains "|  | 设置 | 语音 | 查询 | 发现 | 定位 |"
if(text.includes('|  | 设置 | 语音 | 查询 | 发现 | 定位 |')){
  console.log('found B10 first table');
  const start=text.indexOf('|  | 设置 | 语音 | 查询 | 发现 | 定位 |');
  // Find end of that table: last row is "| 4 | 跨语言 | 印地语 | 英语 | 63.0 | 49.9 |"
  const endMarker2='| 4 | 跨语言 | 印地语 | 英语 | 63.0 | 49.9 |';
  const end=text.indexOf(endMarker2);
  if(end!==-1){
    const block=text.slice(start, end+endMarker2.length);
    console.log('B10 table1 block', block.slice(0,200).replace(/\n/g,'\\n'));
    // Replace with deterministic tab4? But tab4 is TABLE III, tab5 is TABLE IV
    // Our article's B10 actually contains two tables? Let's see: after first table, there is second table for caption alignment: "|  | 预测 | 真值 | 精确率 | 召回率 |"
    // So first table corresponds to TAB0004 (TABLE III), second to TAB0005 (TABLE IV)
    // Replace first
    text=text.slice(0,start)+tab4+text.slice(end+endMarker2.length);
    console.log('replaced first B10 table');
  }
}
if(text.includes('|  | 预测 | 真值 | 精确率 | 召回率 |')){
  console.log('found second B10 table');
  const start=text.indexOf('|  | 预测 | 真值 | 精确率 | 召回率 |');
  const endMarker3='| 3 | 英语标注 | 印地语标注 | 22 | 37 |';
  const end=text.indexOf(endMarker3);
  if(end!==-1){
    text=text.slice(0,start)+tab5+text.slice(end+endMarker3.length);
    console.log('replaced second B10 table');
  }
}

// TAB0006 for B12
const tab6=getRendered('TAB0006');
console.log('TAB0006', tab6.slice(0,200).replace(/\n/g,'\\n'));
if(text.includes('| 架构 | 层 | 预训练语言 | 时长 | 定位 \\(P@10\\) |')){
  console.log('found B12 table');
  const start=text.indexOf('| 架构 | 层 | 预训练语言 | 时长 | 定位');
  const endMarker4='| wav2vec 2.0 Base[43] | 6 | 印地语 | 10k 小时 | 44.4 |';
  const end=text.indexOf(endMarker4);
  if(end!==-1){
    text=text.slice(0,start)+tab6+text.slice(end+endMarker4.length);
    console.log('replaced B12 table');
  }
}

fs.writeFileSync(finalPath, text);
console.log('wrote fixed final article', text.length);
