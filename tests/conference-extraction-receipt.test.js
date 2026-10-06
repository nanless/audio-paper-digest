'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const receipt = require('../scripts/lib/conference-extraction-receipt.js');

const PROJECT = path.resolve(__dirname, '..');

// 这两项断言守的是同一件事：Python 抽取器和 Node 检查器各自算一遍 receipt 与
// artifact 的 SHA，只有两边把同一份数据序列化成同一串字节才算通过。Python 的
// json.dumps 和 JS 的 JSON.stringify 在两处会写出不同的字节——小于 1e-4 或大于
// 等于 1e17 的浮点（`1e-05` 对 `0.00001`、`1e+17` 对 `100000000000000000`），以及
// 整数取值的浮点（`1.0` 对 `1`）。现在之所以没事，靠的是两个隐含前提：
// `_bbox` 把坐标归一化掉了，以及所有被哈希的 map 键都是 ASCII 字面量。前提一旦
// 失效不会报错，只会让两端哈希静默分歧。下面把它变成可执行的约束。
//
// 抽取脚本跑一次真实抽取（合成 PDF，全程只写 Python 自己的临时目录），把
// receipt、artifact、`_bbox` 边界输入的输出、以及遍历结果交回 Node 断言。
function syntheticExtraction() {
    const script = [
        'import json,runpy,sys',
        'from pathlib import Path',
        'root=Path(sys.argv[1]); sys.path.insert(0,str(root/"scripts"))',
        'tests=runpy.run_path(str(root/"tests/python/test_conference_extractor.py"))',
        'from conference_extractor import _bbox, _page_ranges, VISUAL_RENDER_DPI, run_extraction',
        'case=tests["ConferenceExtractorTest"]()',
        'case.setUp()',
        'try:',
        '    pages=[[f"line-{i:03d}-"+"a"*48 for i in range(65)] for _ in range(2)]',
        '    manifest,_=case.write_request(tests["build_pdf"](pages))',
        '    result=run_extraction(manifest,apply=True,source_root=case.root)',
        '    artifact=json.loads((case.root/"paper.artifacts.json").read_text(encoding="utf-8"))',
        '    receipt=json.loads((case.root/"paper.receipt.json").read_text(encoding="utf-8"))',
        '    def kind(value):',
        '        if isinstance(value,bool): return "bool"',
        '        if isinstance(value,int): return "int"',
        '        if isinstance(value,float): return "float"',
        '        return type(value).__name__',
        '    def floats(value,path="root",found=None):',
        '        found=[] if found is None else found',
        '        if isinstance(value,bool): return found',
        '        if isinstance(value,float):',
        '            if value!=0 and abs(value)<1e-3: found.append([path,"small",value])',
        '            if abs(value)>=1e17: found.append([path,"huge",value])',
        '            return found',
        '        if isinstance(value,dict):',
        '            for key,item in value.items(): floats(item,path+"/"+str(key),found)',
        '        elif isinstance(value,list):',
        '            for index,item in enumerate(value): floats(item,path+f"[{index}]",found)',
        '        return found',
        '    def keys(value,path="root",found=None):',
        '        found=[] if found is None else found',
        '        if isinstance(value,dict):',
        '            for key,item in value.items():',
        '                text=str(key)',
        '                if any(ord(character)>0xffff for character in text):',
        '                    found.append([path+"/"+text,"nonBMP"])',
        '                elif any(ord(character)>0x7e or ord(character)<0x20 for character in text):',
        '                    found.append([path+"/"+text,"nonASCII"])',
        '                keys(item,path+"/"+text,found)',
        '        elif isinstance(value,list):',
        '            for index,item in enumerate(value): keys(item,path+f"[{index}]",found)',
        '        return found',
        '    def texts(value,found=None):',
        '        found=[] if found is None else found',
        '        if isinstance(value,str):',
        '            if any(ord(character)>0x7f for character in value): found.append(value[:24])',
        '        elif isinstance(value,dict):',
        '            for item in value.values(): texts(item,found)',
        '        elif isinstance(value,list):',
        '            for item in value: texts(item,found)',
        '        return found',
        '    bbox_input=[0.0004,-0.0009,1e-05,-1e-05,1e-07,1e17,-1.5e17,1e18,1e-3,-1e-3,0.5,-0.0,2**53+1.0]',
        '    bbox=_bbox(bbox_input)',
        '    scalars={"renderDpi":VISUAL_RENDER_DPI}',
        '    visual=artifact["visualAudit"]',
        '    scalars["visualAudit.renderDpi"]=visual["renderDpi"]',
        '    scalars["visualAudit.visualBytes"]=visual["visualBytes"]',
        '    scalars["receipt.pageCount"]=receipt["pageCount"]',
        '    scalars["receipt.text.utf8Bytes"]=receipt["text"]["utf8Bytes"]',
        '    scalars["receipt.text.nonWhitespaceCharacters"]=receipt["text"]["nonWhitespaceCharacters"]',
        '    for index,page in enumerate(artifact["pages"]):',
        '        scalars[f"artifact.pages[{index}].textStart"]=page["textStart"]',
        '        scalars[f"artifact.pages[{index}].textEnd"]=page["textEnd"]',
        '    for index,page in enumerate(visual["pages"]):',
        '        scalars[f"visualAudit.pages[{index}].width"]=page["width"]',
        '        scalars[f"visualAudit.pages[{index}].height"]=page["height"]',
        '    for index,candidate in enumerate(visual["tableCandidates"]):',
        '        scalars[f"visualAudit.tableCandidates[{index}].rows"]=candidate["rows"]',
        '    print(json.dumps({"status":result["status"],',
        '        "bbox":bbox,"bboxTypes":[kind(item) for item in bbox],',
        '        "bboxIntegralTypes":[kind(item) for item in _bbox([1e17,-1.5e17,0.0,-0.0,7.0,-3.0])],',
        '        "rangeTypes":[kind(_page_ranges(["a","b"])[1][0]["textStart"]),kind(_page_ranges(["a","b"])[1][1]["textEnd"])],',
        '        "pythonJson":[json.dumps(1e-05),json.dumps(1e17),json.dumps(7.0)],',
        '        "scalarTypes":{key:kind(item) for key,item in scalars.items()},',
        '        "scalarCount":len(scalars),',
        '        "floatViolations":floats(artifact)+floats(receipt),',
        '        "keyViolations":keys(artifact)+keys(receipt),',
        '        "nonAsciiValueCount":len(texts(artifact))+len(texts(receipt)),',
        '        "selfTest":{"floats":floats({"tiny":1e-5,"huge":[2e17]}),',
        '            "keys":keys({chr(0x1F600):1,"ok":{chr(0x1F642):2}})}},ensure_ascii=False))',
        'finally:',
        '    case.tearDown()',
    ].join('\n');
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script, PROJECT], {
        cwd: PROJECT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000
    });
    assert.equal(result.error, undefined, `无法启动 Python：${result.error?.message}`);
    assert.equal(result.status, 0, `合成抽取失败：${result.stderr}`);
    return JSON.parse(result.stdout);
}

test('针对 UAI U+001E 提取固定数据，Node 复现 Python 的 isspace 行为', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'conference-extraction',
        'uai-2026-python-whitespace.json'), 'utf8'));
    assert.equal([...fixture.sample].filter(character => character.codePointAt(0) === 0x1e).length,
        fixture.observedOccurrences);
    assert.equal(receipt.pythonNonWhitespaceCharacters(fixture.sample),
        fixture.expectedPythonNonWhitespaceCharacters);
    assert.equal([...fixture.sample].filter(character => !/\s/u.test(character)).length,
        fixture.expectedPythonNonWhitespaceCharacters + fixture.observedOccurrences,
        'the former ECMAScript count demonstrates the original one-character drift');
});

test('与 Python 兼容的空白不含 BOM，但包含 Unicode White_Space', () => {
    assert.equal(receipt.pythonNonWhitespaceCharacters(`a\ufeffb`), 3);
    assert.equal(receipt.pythonNonWhitespaceCharacters('a\u0085b\u001cb\u001db\u001eb\u001fb'), 6);
    assert.equal(receipt.pythonNonWhitespaceCharacters('a\u2003b\u2028c'), 3);
});

test('会议抽取的浮点前提：_bbox 归一化后不产生会让两端序列化分歧的浮点', () => {
    const bundle = syntheticExtraction();
    assert.equal(bundle.status, 'ready', '合成 PDF 必须先抽出一份 ready receipt，否则这条断言测不到真实产物');
    // 遍历器本身要先证明有判别力，否则「没找到违规浮点」可能只是没看进去。
    assert.deepEqual(bundle.selfTest.floats.map(item => item[1]).sort(), ['huge', 'small'],
        '浮点遍历器必须能认出注入的 1e-05 与 2e17；认不出就说明这条断言是空的');

    // 前提一：round(x, 3) 之后不可能留下 0 < |x| < 1e-3 的浮点，整数取值的浮点
    // 也已转成 int。破坏它的后果是 Python 写 `1e-05`/`1e+17`/`1.0`，JS 写
    // `0.00001`/`100000000000000000`/`1`，两端算出的 receiptSha256 与
    // auditSha256 从此不同，会议抽取在 Node 校验阶段被判为 receipt self-SHA
    // drifted，而 Python 侧一直认为自己是对的。
    assert.deepEqual(bundle.pythonJson, ['1e-05', '1e+17', '7.0'],
        'Python json.dumps 在分歧区间写出指数形式与 .0；这条用来确认下面的断言测的是真实分歧');
    assert.deepEqual([JSON.stringify(1e-5), JSON.stringify(1e17), JSON.stringify(7.0)],
        ['0.00001', '100000000000000000', '7'], 'JS 在同一组值上写出十进制与裸整数');
    assert.deepEqual(bundle.bboxIntegralTypes, ['int', 'int', 'int', 'int', 'int', 'int'],
        `_bbox 对 1e17/-1.5e17/0.0/-0.0/7.0/-3.0 必须返回 int，实际 ${JSON.stringify(bundle.bboxIntegralTypes)}`);
    assert.deepEqual(bundle.bboxTypes,
        ['int', 'float', 'int', 'int', 'int', 'int', 'int', 'int', 'float', 'float', 'float', 'int', 'int'],
        `_bbox 的归一化结果变了：实际 ${JSON.stringify(bundle.bboxTypes)}；`
        + '0.0004/-0.0009 这类值只能落在 0 或 ±0.001，整数取值的坐标必须落成 int');
    assert.deepEqual(bundle.rangeTypes, ['int', 'int'], '页码区间的 textStart/textEnd 必须是 int');
    assert.deepEqual(bundle.floatViolations, [],
        `_bbox 的归一化前提被破坏：artifact/receipt 里出现了 ${JSON.stringify(bundle.floatViolations)}；`
        + '这些值在 Python 的 json.dumps 与 JS 的 JSON.stringify 下字节不同，跨语言哈希会分歧');

    // 前提二：receipt 里那些计数与尺寸字段都是 int，不是浮点。
    const wrong = Object.entries(bundle.scalarTypes).filter(([, kind]) => kind !== 'int');
    assert.deepEqual(wrong, [],
        `这些 receipt/artifact 标量不再是 int：${JSON.stringify(wrong)}；`
        + 'Python 会把整数取值的浮点写成 1.0，JS 写 1，两端哈希随之分歧');
    assert.ok(bundle.scalarCount >= 6, `标量类型检查只覆盖了 ${bundle.scalarCount} 个字段，太少，构不成断言`);
});

test('被哈希的 receipt/artifact 键全部是 ASCII，非 ASCII 只出现在值里', () => {
    const bundle = syntheticExtraction();
    assert.equal(bundle.status, 'ready');
    assert.deepEqual(bundle.selfTest.keys.map(item => item[1]).sort(), ['nonBMP', 'nonBMP'],
        '键遍历器必须能认出注入的 emoji 键；认不出就说明这条断言是空的');
    // 前提：receipt 与 artifact 里所有被哈希的 map，键都是固定 ASCII 字面量。
    // 键一旦出现非 BMP 字符，JS 的 UTF-16 码元排序与 Python 的码点排序就会给出
    // 不同顺序（U+1F600 的代理对首元 D83D 小于 U+FFFD），被排序后的键进哈希，
    // 两端 SHA 分歧。值里的 emoji 不受影响，因为值不参与排序。
    assert.deepEqual(bundle.keyViolations, [],
        `被哈希的键集合里出现了非 ASCII 键：${JSON.stringify(bundle.keyViolations)}；`
        + '非 BMP 键会让 JS 的码元序与 Python 的码点序分歧，跨语言哈希不再一致');
    assert.ok(bundle.nonAsciiValueCount > 0,
        'artifact 的值里应当有中文（limitations），这条用来确认断言区分的是键而不是值');
});
