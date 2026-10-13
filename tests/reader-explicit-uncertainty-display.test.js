'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const deep=require('../scripts/deep-analyzer');

test('完整均值误差中的同义±和pm只规范显示，保数值精度',()=>{
 for(const [source,expected] of [
  ['97.0±\\pm1.2','97.0 ± 1.2'],
  ['.21±\\pm.08','.21 ± .08'],
  ['-.115±\\pm.113','-.115 ± .113'],
  ['97.0±1.2','97.0 ± 1.2'],
 ]) assert.equal(deep.normalizeReaderSourceCell(source),expected);
});

test('不匹配的运算符、负误差和未完整的TeX保持原样',()=>{
 for(const text of [
  '97.0±\\mp1.2','97.0±\\pm-1.2','97.0±\\pm1.2_{j}',
  '97.0±\\pm1.2 ^{2}','97.0±\\pm1.2\\unknown','97.0±\\pm1.2 \\beta',
  '97.0±\\pm1.2.3','97.0±\\pm1.2ms','97.0±\\pm1.21.2',
 ]) assert.equal(deep.normalizeReaderSourceCell(text),text.replace(/[*_`]/g,'').replace(/\s+/g,' ').trim());
});

test('不会将不同均值、误差或符号当成原表同值',()=>{
 const original=deep.normalizeReaderSourceCell('.21±\\pm.08');
 for(const text of ['.21 ± .09','.22 ± .08','.08 ± .21','-.21 ± .08','.21 ∓ .08']){
  assert.notEqual(deep.normalizeReaderSourceCell(text),original);
 }
 assert.equal(deep.normalizeReaderSourceCell('3030'),'3030');
});
