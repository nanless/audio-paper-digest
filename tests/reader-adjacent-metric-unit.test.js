'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS='1';
const test=require('node:test'),assert=require('node:assert/strict');
const deep=require('../scripts/deep-analyzer'),fixtures=require('./fixtures/reader-adjacent-metric-unit-cases.json');
test('同quote精确相邻metric/value/unit可支持裸表格值；34正反边界不转换单位',()=>{
 for(const row of fixtures.cases){const table={header:['Method',row.header],rows:[['A',row.value]]},before=JSON.stringify(table);
  assert.equal(deep.readerTableHeaderUnitEvidenceFailures(table,[row.quote]).length===0,row.expected,JSON.stringify(row));assert.equal(JSON.stringify(table),before);
 }
});
test('18587真实原引文/表格消除6个误报；其余DOM继承在无验证能力时仍拒绝',()=>{
 for(const row of fixtures.real){const before=JSON.stringify(row);assert.equal(deep.readerTableHeaderUnitEvidenceFailures(row.table,row.quotes).length===0,row.quoteOnlyResolved,row.id);assert.equal(JSON.stringify(row),before);}
});
