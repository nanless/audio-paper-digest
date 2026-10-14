'use strict';

// 日更发布器的历史路径适配：只接收已经核验的当前分析，不加载旧 crosswalk/标签/调度流程。
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const publicationFiles = require('./publication-file-primitives.js');
const stableHash = require('./fresh-rewrite-run.js').stableHash;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const RENDERER_IMPLEMENTATION_CONTRACT = 'historical-page-renderer-implementation-v1';
const RENDERER_ENTRY_FILES = Object.freeze([
    'scripts/lib/paper-page-staging.js', 'scripts/lib/publication-file-primitives.js',
    'scripts/lib/historical-direct-page-staging.js', 'scripts/lib/historical-direct-rewrite-runner.js',
    'scripts/historical-page-render.py', 'scripts/blog_entry_loader.py', 'scripts/publish-to-blog.py',
    'scripts/publish_common.py', 'scripts/path_config.py', 'scripts/project_env.py',
    'scripts/utils.py', 'scripts/analysis_sections.py', 'scripts/tag_stage_record.py',
    'manual/scripts/tutorial_payload_verifier.py', 'scripts/markdown_hugo_gate.py',
    'manual/scripts/sealed_tutorial_preview.py', 'config/tag-catalog.json',
    'config/publish-image-exclusions.json'
]);
function rendererImplementationFiles() {
    return require('./workflow-implementation-files.js').collectWorkflowImplementationFiles({
        root: path.resolve(__dirname, '../..'), entryFiles: RENDERER_ENTRY_FILES
    });
}
function rendererImplementationIdentity(dependencies = {}) {
    const projectRoot = path.resolve(__dirname, '../..');
    const read = dependencies.readImplementationFile || (filename => publicationFiles.readRegular(filename, 16 * 1024 * 1024));
    const files = rendererImplementationFiles().map(relativePath => {
        const loaded = read(path.join(projectRoot, ...relativePath.split('/')), relativePath);
        const fileSha256 = Buffer.isBuffer(loaded) ? sha256(loaded) : loaded?.fileSha256 || loaded?.sha256;
        if (!/^[a-f0-9]{64}$/.test(fileSha256 || '')) throw new Error(`页面生成器实现 SHA 无效：${relativePath}`);
        return { relativePath, fileSha256 };
    });
    const blogBasePath = dependencies.blogBasePath !== undefined
        ? dependencies.blogBasePath : process.env.PAPER_DIGEST_BLOG_BASE_PATH || '/audio-paper-digest-blog';
    if (typeof blogBasePath !== 'string' || !blogBasePath.startsWith('/') || blogBasePath.includes('\0')) {
        throw new Error('历史页面使用的博客基础路径必须以斜杠开头，且不能含空字符。');
    }
    const body = { contract: RENDERER_IMPLEMENTATION_CONTRACT, version: 1, files, outputConfiguration: { blogBasePath } };
    return { ...body, rendererImplementationSha256: stableHash(body) };
}
function currentRendererImplementationSha256(dependencies = {}) {
    const supplied = dependencies.rendererImplementationSha256;
    const value = typeof supplied === 'function' ? supplied() : supplied;
    if (value !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('页面生成器实现 SHA 无效。');
        return value;
    }
    return rendererImplementationIdentity(dependencies).rendererImplementationSha256;
}
function defaultRender(packet, dependencies = {}) {
    const script = path.join(__dirname, '..', 'historical-page-render.py');
    const runtime = path.join(__dirname, '..', 'python-runtime.sh');
    const io = dependencies.io || fs;
    const execute = dependencies.execFileSync || execFileSync;
    const temporaryRoot = dependencies.tmpdir?.() || fs.realpathSync(os.tmpdir());
    const temporary = io.mkdtempSync(path.join(temporaryRoot, 'historical-page-render-input-'));
    const inputFile = path.join(temporary, 'packet.json');
    try {
        io.writeFileSync(inputFile, JSON.stringify(packet), {
            encoding: 'utf8', flag: 'wx', mode: 0o600
        });
        const output = execute('bash', [runtime, script, '--input-file', inputFile], {
            maxBuffer: 64 * 1024 * 1024,
            timeout: 60 * 1000,
            killSignal: 'SIGKILL'
        });
        const parsed = JSON.parse(output.toString('utf8'));
        if (typeof parsed.markdown !== 'string' || !parsed.markdown.trim() || !Array.isArray(parsed.assets)) throw new Error('历史页面生成器必须返回非空 Markdown 正文和资源数组。');
        return parsed;
    }
    finally {
        try { io.unlinkSync(inputFile); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        io.rmdirSync(temporary);
    }
}

function writeExact(filename, bytes) {
    if (Buffer.byteLength(bytes) > 64 * 1024 * 1024) throw new Error(`页面生成文件超过允许的大小：${filename}`);
    return publicationFiles.writeExact(filename, bytes);
}

module.exports = { RENDERER_IMPLEMENTATION_CONTRACT, RENDERER_ENTRY_FILES, rendererImplementationFiles, rendererImplementationIdentity, currentRendererImplementationSha256, defaultRender, writeExact };
