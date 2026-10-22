#!/usr/bin/env node
'use strict';
// push 成功后的收尾清单：提示视觉准备/QA/豁免检查与 digest:status；不调用图像 API、不自动登记豁免。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CURRENT = path.join(ROOT, 'data', 'current');

function main(argv = process.argv.slice(2)) {
    const date = argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : null;
    if (!date) { console.log('用法: node scripts/publish-finish.js --date YYYY-MM-DD'); return 2; }
    const waiver = path.join(CURRENT, 'post-publish-visual-waivers', `${date}.json`);
    const visualManifest = path.join(CURRENT, 'visual-summary-manifests', `${date}.json`);
    console.log(`发布收尾清单（${date}）：`);
    console.log('1) digest:status：npm run digest:status -- --date ' + date);
    console.log('2) 网页核验：npm run verify:web -- --date ' + date + ' --deploy <OID>');
    if (fs.existsSync(waiver)) console.log(`3) 视觉：已登记豁免（${waiver}）；不要再执行视觉:prepare 或生图。`);
    else {
        console.log('3) 视觉：先运行 npm run visual:prepare -- --date ' + date + '，把输出的绝对 referencedImagePaths 交给生图工具；逐图 QA 后 record --qa-attested true。');
        if (fs.existsSync(visualManifest)) console.log(`   已有视觉清单：${visualManifest}`);
    }
    console.log('4) 完成后重新运行 digest:status，并以部署/网页核验结果作为最终验收。');
    return 0;
}

module.exports = { main };

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[publish-finish] ${error.message}`); process.exitCode = 1; }
}
