// 提示词版本表有两份：JS 的 scripts/lib/prompt-text-versions.js 是源头，
// scripts/publish-to-blog.py 里有一份手抄副本 _VISUAL_PROMPT_TEXT_FILES，
// 只用于历史 manifest 取证。两份之间原本没有一致性检查，加版本时漏改一边
// 不会有任何测试发现——漂移的表现是「JS 认某个版本、Python 不认」，或者
// 两边指向不同文件，都要等到特定阶段读旧记录时才炸。
//
// 这里断言的是语义一致（同一阶段的 v1 路径、当前契约名、当前路径相同），
// 不是两份文件文本相同——后者会因为排版差异而变脆。数据从两个真实源头读：
// JS 侧直接 require，Python 侧通过解释器读出来，都不在测试里重新手抄。
//
// 一致性要查两个方向。第一条按 Python 表里的阶段逐项比对，管的是「Python 有的
// 阶段两端对不对得上」；它发现不了 Python 漏登记某个阶段。最后一条从 JS 表出发，
// 要求每个阶段要么在 Python 副本里，要么在 JS_STAGES_PYTHON_DOES_NOT_READ 里
// 写明 Python 不读它——JS 新增阶段时那张清单不会自动放行。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
    ANALYSIS_PROMPT_TEXT_V1_CONTRACT,
    ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
    FROZEN_V1_PROMPT_FILES,
    PROMPT_FILE_VERSIONS
} = require('../scripts/lib/prompt-text-versions.js');

const PROJECT = path.join(__dirname, '..');
const PROMPTS_DIR = path.join(PROJECT, 'prompts');

// Python 侧用 kebab-case 的阶段名（manifest 的 kind），JS 侧用 camelCase 键。
function toKebab(name) {
    return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function toCamel(name) {
    const [head, ...rest] = String(name).split('-');
    return head + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function runPython(script) {
    const result = spawnSync('bash', ['scripts/python-runtime.sh', '-c', script], {
        cwd: PROJECT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000
    });
    assert.equal(result.error, undefined, `无法启动 Python：${result.error?.message}`);
    assert.equal(result.status, 0, `Python 检查失败：${result.stderr}`);
    return result.stdout;
}

function pythonRegistry() {
    return JSON.parse(runPython([
        'import json, sys',
        'sys.path.insert(0, "scripts")',
        'from blog_entry_loader import load_publish_to_blog',
        'PUB = load_publish_to_blog()',
        'print(json.dumps({',
        '    "v1Contract": PUB.PROMPT_TEXT_V1_CONTRACT,',
        '    "v2Contract": PUB.PROMPT_TEXT_V2_CONTRACT,',
        '    "promptsDir": str(PUB.PROJECT_ROOT / "prompts"),',
        '    "files": PUB._VISUAL_PROMPT_TEXT_FILES,',
        '}, ensure_ascii=False))',
    ].join('\n')));
}

test('两份提示词版本表对每个阶段给出的 v1 路径、当前契约名与当前路径一致', () => {
    const py = pythonRegistry();

    // 契约名本身先要对上：两边必须叫同一个 v1、同一个 v2。
    assert.equal(py.v1Contract, ANALYSIS_PROMPT_TEXT_V1_CONTRACT,
        `v1 契约名两端不一致：Python 写 ${py.v1Contract}，JS 写 ${ANALYSIS_PROMPT_TEXT_V1_CONTRACT}`);
    assert.equal(py.v2Contract, ANALYSIS_PROMPT_TEXT_V2_CONTRACT,
        `v2 契约名两端不一致：Python 写 ${py.v2Contract}，JS 写 ${ANALYSIS_PROMPT_TEXT_V2_CONTRACT}`);
    assert.equal(fs.realpathSync(py.promptsDir), fs.realpathSync(PROMPTS_DIR),
        `两端读的不是同一个提示词目录：Python 指向 ${py.promptsDir}，仓库里是 ${PROMPTS_DIR}`);

    // 比对范围取自 Python 那份表本身，而不是在测试里再列一份阶段清单：
    // 那份清单也是手抄，Python 新增阶段时同样不会有人记得同步它。
    const stages = Object.keys(py.files).sort();
    assert.ok(stages.length > 0,
        'Python 的 _VISUAL_PROMPT_TEXT_FILES 是空的，登记表被删空或改了名字');

    for (const pythonStage of stages) {
        const stage = toCamel(pythonStage);
        const entry = py.files[pythonStage];
        const pythonContracts = Object.keys(entry).sort().join('、');

        const jsV1 = FROZEN_V1_PROMPT_FILES[stage];
        assert.ok(jsV1,
            `Python 登记了阶段 ${pythonStage}（对应 JS 键 ${stage}），但 JS 的 FROZEN_V1_PROMPT_FILES 里没有它；`
            + `JS 现有阶段是 ${Object.keys(FROZEN_V1_PROMPT_FILES).join('、')}`);
        const jsCurrent = PROMPT_FILE_VERSIONS[stage];
        assert.ok(jsCurrent,
            `Python 登记了阶段 ${pythonStage}（对应 JS 键 ${stage}），但 JS 的 PROMPT_FILE_VERSIONS 里没有它`);

        const pythonV1 = entry[py.v1Contract];
        assert.ok(pythonV1,
            `阶段 ${pythonStage} 的 Python 副本没登记 v1 契约 ${py.v1Contract}，只登记了 ${pythonContracts}`);
        assert.equal(`prompts/${pythonV1}`, jsV1,
            `阶段 ${pythonStage} 的 v1 路径两端不一致：Python 写 prompts/${pythonV1}，JS 写 ${jsV1}`);

        const pythonCurrent = entry[jsCurrent.contract];
        assert.ok(pythonCurrent,
            `阶段 ${pythonStage} 的 Python 副本没登记 JS 当前契约 ${jsCurrent.contract}，只登记了 ${pythonContracts}；`
            + 'JS 升了新版本而 Python 那份没跟上，新记录会被 Python 拒绝');
        assert.equal(`prompts/${pythonCurrent}`, jsCurrent.path,
            `阶段 ${pythonStage} 在契约 ${jsCurrent.contract} 下的路径两端不一致：`
            + `Python 写 prompts/${pythonCurrent}，JS 写 ${jsCurrent.path}`);

        // JS 的 promptFilePathForContract 对每个阶段只接受 v1 和当前版本；Python
        // 副本应当认识同一组契约，多认或少认都会让同一个 manifest 在两端得出不同结论。
        assert.deepEqual(Object.keys(entry).sort(),
            [py.v1Contract, jsCurrent.contract].sort(),
            `阶段 ${pythonStage} 登记的契约集合两端不一致：Python 认 ${pythonContracts}，`
            + `JS 只认 ${[ANALYSIS_PROMPT_TEXT_V1_CONTRACT, jsCurrent.contract].sort().join('、')}`);

        assert.equal(toKebab(stage), pythonStage,
            `阶段名映射不对称：JS 键 ${stage} 换回 kebab 是 ${toKebab(stage)}，Python 用的是 ${pythonStage}`);
    }
});

test('Python 版本表对没登记的契约名报错，不退化成 v1', () => {
    const output = runPython([
        'import sys',
        'sys.path.insert(0, "scripts")',
        'from blog_entry_loader import load_publish_to_blog',
        'PUB = load_publish_to_blog()',
        'try:',
        '    PUB._visual_prompt_path("visual-summary",',
        '        {"promptTextContract": "analysis-prompt-text-v9"})',
        '    print("NO-THROW")',
        'except Exception as error:',
        '    print(type(error).__name__ + ": " + str(error))',
    ].join('\n')).trim();
    assert.notEqual(output, 'NO-THROW',
        '未登记的契约名没有报错，Python 退化成了 v1');
    assert.match(output, /analysis-prompt-text-v9/,
        `报错消息里要带上那个没登记的契约名，实际是 ${output}`);
});

// JS 表里 Python 明确不读的阶段。Python 的副本只服务发布后视觉 manifest，
// 这些阶段的正文由 deep-analyzer、读者阶段和 manual 在 Node 侧打开，Python
// 发布器碰不到。清单写死在测试里、不参与比对范围推导，所以它不会跟着 JS 表
// 自动变长：JS 新增阶段时它既不在 Python 副本里、也不在这张清单里，下面这条
// 测试就会报错，逼作者决定 Python 要不要跟。
const JS_STAGES_PYTHON_DOES_NOT_READ = Object.freeze([
    'primaryAnalysis', 'openSourceScan', 'revision', 'tableRepair', 'methodRepair',
    'coreSummaryRepair', 'structureRepair', 'tagSelection', 'scoringAudit',
    'imageSupplement', 'apiReaderArticle', 'apiReaderRepair'
]);

test('JS 表里的每个阶段都在 Python 副本里，或声明了 Python 不读它', () => {
    const py = pythonRegistry();
    const pythonStages = new Set(Object.keys(py.files).map(toCamel));
    const jsStages = Object.keys(PROMPT_FILE_VERSIONS).sort();

    const unaccounted = jsStages.filter(stage =>
        !pythonStages.has(stage) && !JS_STAGES_PYTHON_DOES_NOT_READ.includes(stage));
    assert.deepEqual(unaccounted, [],
        `JS 的 PROMPT_FILE_VERSIONS 有 Python 副本没登记、也没声明 Python 不读的阶段：${unaccounted.join('、')}。`
        + '要么在 publish-to-blog.py 的 _VISUAL_PROMPT_TEXT_FILES 里补上，'
        + '要么加进本测试的 JS_STAGES_PYTHON_DOES_NOT_READ 并写明 Python 为什么不读');

    // 清单和 Python 副本重叠，或者清单里留着 JS 已经不存在的阶段，都说明它过期了，
    // 会掩盖真实的镜像关系。
    const onBothSides = JS_STAGES_PYTHON_DOES_NOT_READ.filter(stage => pythonStages.has(stage));
    assert.deepEqual(onBothSides, [],
        `这些阶段同时出现在 Python 副本和 JS_STAGES_PYTHON_DOES_NOT_READ 里：${onBothSides.join('、')}`);
    const goneFromJs = JS_STAGES_PYTHON_DOES_NOT_READ.filter(stage => !jsStages.includes(stage));
    assert.deepEqual(goneFromJs, [],
        `JS_STAGES_PYTHON_DOES_NOT_READ 里这些阶段在 JS 的 PROMPT_FILE_VERSIONS 里已经不存在：`
        + `${goneFromJs.join('、')}；阶段改名或删除后要同步这张清单`);
});
