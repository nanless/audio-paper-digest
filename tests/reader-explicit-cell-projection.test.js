'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const cases = require('./fixtures/reader-explicit-cell-projection-cases.json');
const { normalizeReaderSourceDisplayArtifacts: normalize } = require('../scripts/lib/reader-source-display');
const deep = require('../scripts/deep-analyzer');

test('完整源格的显式分数和脚注投影保留数字、精度、脚注与百分比', () => {
    for (const { raw, expected } of cases) {
        assert.equal(normalize(raw), expected, raw);
        assert.equal(normalize(normalize(raw)), expected, `fixed point: ${raw}`);
        assert.equal(deep.normalizeReaderSourceCell(raw), deep.normalizeReaderSourceCell(expected), raw);
    }
});

test('发布显示与源格绑定镜像同一严格投影，错值和数学续尾不能借局部匹配清理', () => {
    const filename = path.resolve(__dirname, '../scripts/publish-to-blog.py');
    const code = `import ast,json,re,unicodedata,sys\nsource=ast.parse(open(sys.argv[1]).read())\nkeep={'_normalize_api_reader_explicit_symbol_projection','_normalize_api_reader_display_artifacts','_normalize_api_reader_source_cell'}\nexec(compile(ast.Module(body=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in keep],type_ignores=[]),sys.argv[1],'exec'))\nprint(json.dumps([[_normalize_api_reader_display_artifacts(v),_normalize_api_reader_source_cell(v)] for v in json.loads(sys.stdin.read())],ensure_ascii=False))`;
    const result = execFileSync('bash', [path.resolve(__dirname, '../scripts/python-runtime.sh'), '-c', code, filename], {
        input: JSON.stringify(cases.map(row => row.raw)), encoding: 'utf8'
    });
    assert.deepEqual(JSON.parse(result), cases.map(row => [row.expected, deep.normalizeReaderSourceCell(row.raw)]));
});
