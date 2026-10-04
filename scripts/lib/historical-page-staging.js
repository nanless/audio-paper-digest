'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crosswalkApi = require('./page-source-crosswalk.js');
const tagAssignmentsApi = require('./historical-tag-assignment.js');
const registryApi = require('./tag-catalog.js');
const fresh = require('./fresh-rewrite-run.js');

const CONTRACT = 'historical-paper-page-staging-v1';
const INTENT_CONTRACT = 'historical-paper-page-staging-intent-v1';
const RENDERER_IMPLEMENTATION_CONTRACT = 'historical-page-renderer-implementation-v1';
const VERSION = 1;
const SHA_RE = /^[a-f0-9]{64}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;
const RENDERER_IMPLEMENTATION_FILES = Object.freeze([
    'scripts/lib/historical-page-staging.js',
    'scripts/lib/historical-direct-page-staging.js',
    'scripts/lib/historical-direct-rewrite-runner.js',
    'scripts/lib/historical-postprocess-scheduler.js',
    'scripts/lib/historical-daily-aggregate.js',
    'scripts/lib/historical-tag-assignment.js',
    'scripts/lib/tag-catalog.js',
    'config/tag-catalog.json',
    'scripts/historical-page-render.py',
    'scripts/blog_entry_loader.py',
    'scripts/publish-to-blog.py',
    'scripts/publish_common.py',
    'scripts/path_config.py',
    'scripts/project_env.py',
    'scripts/utils.py',
    'scripts/analysis_sections.py',
    'manual/scripts/tutorial_payload_verifier.py',
    'scripts/markdown_hugo_gate.py',
    'manual/scripts/sealed_tutorial_preview.py',
    'config/publish-image-exclusions.json'
]);

function rendererImplementationIdentity(dependencies = {}) {
    const projectRoot = path.resolve(__dirname, '..', '..');
    const readImplementationFile = dependencies.readImplementationFile
        || (filename => readRegular(filename, 16 * 1024 * 1024, '历史页面生成器实现文件'));
    const files = RENDERER_IMPLEMENTATION_FILES.map(relativePath => {
        const absolutePath = path.join(projectRoot, ...relativePath.split('/'));
        const loaded = readImplementationFile(absolutePath, relativePath);
        const fileSha256 = Buffer.isBuffer(loaded)
            ? sha256(loaded) : loaded?.fileSha256;
        if (!SHA_RE.test(fileSha256 || '')) {
            throw new Error(`历史页面生成器的实现 SHA 缺失或格式无效：${relativePath}`);
        }
        return { relativePath, fileSha256 };
    });
    const blogBasePath = dependencies.blogBasePath !== undefined
        ? dependencies.blogBasePath
        : process.env.PAPER_DIGEST_BLOG_BASE_PATH || '/audio-paper-digest-blog';
    if (typeof blogBasePath !== 'string' || !blogBasePath.startsWith('/')
        || blogBasePath.includes('\0')) throw new Error('历史页面使用的博客基础路径必须以斜杠开头，且不能含空字符。');
    const body = { contract: RENDERER_IMPLEMENTATION_CONTRACT, version: 1,
        files, outputConfiguration: { blogBasePath } };
    return { ...body, rendererImplementationSha256: stableHash(body) };
}

function currentRendererImplementationSha256(dependencies = {}) {
    const supplied = dependencies.rendererImplementationSha256;
    const value = typeof supplied === 'function' ? supplied() : supplied;
    if (value !== undefined) {
        if (!SHA_RE.test(value || '')) throw new Error('历史页面生成器的实现 SHA 缺失或格式无效。');
        return value;
    }
    return rendererImplementationIdentity(dependencies).rendererImplementationSha256;
}

function strictJson(bytes, label) {
    let source;
    try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error(`${label} 必须使用有效的 UTF-8 编码。`); }
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0]; const top = stack[stack.length - 1];
        if (token === '{') stack.push({ object: true, keys: new Set(), expectKey: true });
        else if (token === '[') stack.push({ object: false });
        else if (token === '}' || token === ']') stack.pop();
        else if (token === ',' && top?.object) top.expectKey = true;
        else if (token.startsWith('"') && top?.object && top.expectKey) {
            const key = JSON.parse(token);
            if (top.keys.has(key)) throw new Error(`${label} 的 JSON 中出现重复字段：${key}`);
            top.keys.add(key); top.expectKey = false;
        }
    }
    try { return JSON.parse(source); } catch { throw new Error(`${label} 的内容不是有效的 JSON。`); }
}

function readRegular(filename, maximum, label) {
    let fd;
    try {
        const before = fs.lstatSync(filename);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw new Error(`${label} 必须是没有符号链接、仅有一个硬链接且大小不超过限制的普通文件。`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
        if (!opened.isFile() || opened.nlink !== 1 || named.isSymbolicLink() || named.nlink !== 1
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size) throw new Error(`${label} 打开后的文件与当前路径不对应，或文件类型、链接数量、大小不符合要求。`);
        const bytes = fs.readFileSync(fd);
        if (bytes.length !== opened.size) throw new Error(`${label} 的读取字节数与打开时记录的文件大小不一致。`);
        return { bytes, fileSha256: sha256(bytes) };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readAssignment(filename) {
    const loaded = readRegular(filename, 16 * 1024 * 1024, '标签分配记录');
    const bytes = loaded.bytes; const value = strictJson(bytes, '标签分配记录');
    const body = { ...value }; delete body.assignmentSha256;
    if (value.contract !== tagAssignmentsApi.CONTRACT || value.version !== tagAssignmentsApi.VERSION
        || !['assigned', 'blocked'].includes(value.status) || !SHA_RE.test(value.assignmentSha256 || '')
        || !SHA_RE.test(value.registrySha256 || '') || value.assignmentSha256 !== stableHash(body)
        || !/^[a-f0-9-]{36}$/i.test(value.analysisRunId || '')) {
        throw new Error(`标签分配记录的格式、哈希或文件名无效：${filename}`);
    }
    const basename = path.basename(filename);
    const currentAssignmentFilename = tagAssignmentsApi.assignmentFilename(
        value.paperId, value.registrySha256, value.assignmentSha256
    );
    const legacyName = tagAssignmentsApi.legacyAssignmentFilename(value.paperId, value.registrySha256);
    if (basename !== currentAssignmentFilename && basename !== legacyName) {
        throw new Error(`标签分配记录的格式、哈希或文件名无效：${filename}`);
    }
    return { value, bytes, fileSha256: sha256(bytes), filename,
        legacyFilename: basename === legacyName };
}

function findAssignment(root, paperId, analysisRunId, registrySha256, expectedAssignment) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || !UUID_RE.test(analysisRunId || '')
        || !SHA_RE.test(registrySha256 || '') || !expectedAssignment
        || expectedAssignment.paperId !== paperId || expectedAssignment.analysisRunId !== analysisRunId
        || expectedAssignment.registrySha256 !== registrySha256
        || !SHA_RE.test(expectedAssignment.assignmentSha256 || '')) {
        throw new Error('查找标签记录所需的绝对目录、运行 ID、词表 SHA 或重新计算的预期记录缺失、格式无效或不一致。');
    }
    if (!fs.existsSync(root)) return null;
    const safeRoot = fresh.assertSafeDirectory(root); const runRoot = path.join(safeRoot, analysisRunId);
    if (!fs.existsSync(runRoot)) return null;
    fresh.assertSafeDirectory(runRoot);
    const currentAssignmentPath = path.join(runRoot, tagAssignmentsApi.assignmentFilename(
        paperId, registrySha256, expectedAssignment.assignmentSha256
    ));
    const legacy = path.join(runRoot, tagAssignmentsApi.legacyAssignmentFilename(paperId, registrySha256));
    const filename = fs.existsSync(currentAssignmentPath) ? currentAssignmentPath : fs.existsSync(legacy) ? legacy : null;
    if (!filename) return null;
    const loaded = readAssignment(filename);
    if (loaded.value.analysisRunId !== analysisRunId || loaded.value.paperId !== paperId
        || loaded.value.registrySha256 !== registrySha256) throw new Error(`论文 ${paperId} 的标签记录与指定论文、分析运行或词表不一致。`);
    if (stableHash(loaded.value) !== stableHash(expectedAssignment)
        || loaded.value.assignmentSha256 !== expectedAssignment.assignmentSha256) {
        if (loaded.legacyFilename) return null;
        throw new Error(`论文 ${paperId} 的标签记录与按当前分析和词表重新计算的记录不一致。`);
    }
    return loaded.value.status === 'assigned' ? loaded : null;
}

function loadPageGenerationInputs({ crosswalkRoot, crosswalkId, analysisRoot, tagAssignmentRoot, tagCatalogPath, analysisRunId } = {}, dependencies = {}) {
    const tagCatalog = (dependencies.loadTagCatalog || registryApi.loadTagCatalog)(tagCatalogPath);
    if (!SHA_RE.test(tagCatalog?.registrySha256 || '')) throw new Error('当前标签词表的 SHA 缺失或格式无效。');
    const state = (dependencies.readCrosswalk || crosswalkApi.readCrosswalk)({ crosswalkRoot, crosswalkId });
    const pages = new Map(state.source.papers.map(page => [page.pageKey, page])); const results = [];
    const handle = (dependencies.loadRun || tagAssignmentsApi.loadCompletedHistoricalAnalysisRun)({
        analysisRoot, runId: analysisRunId }, dependencies.analysisDependencies || {});
    const run = (dependencies.runSnapshot || tagAssignmentsApi.runSnapshot)(handle);
    for (const group of state.identityGroups.filter(item => item.paperId.startsWith('arxiv:'))) {
        const paper = run.papers.find(item => `arxiv:${fresh.paperId(item)}` === group.paperId);
        if (!paper) continue;
        const rebuilt = (dependencies.buildAssignment || tagAssignmentsApi.buildAssignment)({ runHandle: handle, paper, tagCatalog });
        const assignment = (dependencies.findAssignment || findAssignment)(tagAssignmentRoot, group.paperId,
            analysisRunId, tagCatalog.registrySha256, rebuilt);
        if (!assignment) continue;
        if (!paper || assignment.value.analysisFileSha256 !== run.analysisFileSha256
            || assignment.value.registrySha256 !== tagCatalog.registrySha256
            || assignment.value.analysisRecordSha256 !== stableHash(paper)
            || assignment.value.analysisSha256 !== sha256(Buffer.from(paper.analysis, 'utf8'))) {
            throw new Error(`论文 ${group.paperId} 的标签记录与已完成的分析文件、正文或当前词表不一致。`);
        }
        if (stableHash(rebuilt) !== stableHash(assignment.value)
            || rebuilt.assignmentSha256 !== assignment.value.assignmentSha256) {
            throw new Error(`论文 ${group.paperId} 的标签记录与按当前词表重新计算的记录不一致。`);
        }
        const projectedPages = group.pageKeys.map(pageKey => {
            const page = pages.get(pageKey); const verified = state.assignments[pageKey];
            if (!page || verified?.status !== 'verified' || verified.sourceAuthority?.paperId !== group.paperId) {
                throw new Error(`论文 ${group.paperId} 的页面记录缺失、尚未通过对应关系核验，或对应了其他论文。`);
            }
            return { pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
                cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256,
                decisionArtifactSha256: verified.decisionArtifactSha256,
                sourceAuthority: structuredClone(verified.sourceAuthority) };
        });
        results.push({ paperId: group.paperId, identitySha256: group.identitySha256,
            identityRecordSha256: group.identityRecordSha256, paper,
            analysisRunId: assignment.value.analysisRunId, analysisFileSha256: run.analysisFileSha256,
            analysisRecordSha256: assignment.value.analysisRecordSha256,
            analysisSha256: assignment.value.analysisSha256,
            taxonomy: assignment.value, taxonomyFileSha256: assignment.fileSha256, pages: projectedPages });
    }
    return { crosswalk: state, groups: results.sort((a, b) => a.paperId.localeCompare(b.paperId)) };
}

function selectedBindingsFor(groups) {
    return groups.map(group => ({ paperId: group.paperId, identitySha256: group.identitySha256,
        identityRecordSha256: group.identityRecordSha256, pages: group.pages.map(page => ({
            pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
            cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256,
            decisionArtifactSha256: page.decisionArtifactSha256,
            sourceAuthority: structuredClone(page.sourceAuthority)
        })).sort((a, b) => a.pageKey.localeCompare(b.pageKey)) })).sort((a, b) => a.paperId.localeCompare(b.paperId));
}

function replaySelectedBindings(manifest, crosswalk) {
    const currentPages = new Map(crosswalk.source.papers.map(page => [page.pageKey, page]));
    const groups = new Map(crosswalk.identityGroups.map(group => [group.paperId, group]));
    const rebuilt = manifest.selectedBindings.map(binding => {
        const group = groups.get(binding.paperId);
        if (!group || group.identitySha256 !== binding.identitySha256
            || group.identityRecordSha256 !== binding.identityRecordSha256) throw new Error(`论文 ${binding.paperId} 的对应记录缺失，或其记录 SHA 与生成清单不一致。`);
        const pages = binding.pages.map(expected => {
            const page = currentPages.get(expected.pageKey); const assignment = crosswalk.assignments[expected.pageKey];
            if (!page || !group.pageKeys.includes(expected.pageKey) || assignment?.status !== 'verified') throw new Error(`页面 ${expected.pageKey} 不存在、不属于所选论文，或对应记录尚未通过核验。`);
            return { pageKey: expected.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
                cohortDate: page.cohortDate, pageContentSha256: page.pageContentSha256,
                decisionArtifactSha256: assignment.decisionArtifactSha256,
                sourceAuthority: structuredClone(assignment.sourceAuthority) };
        }).sort((a, b) => a.pageKey.localeCompare(b.pageKey));
        return { paperId: binding.paperId, identitySha256: group.identitySha256,
            identityRecordSha256: group.identityRecordSha256, pages };
    }).sort((a, b) => a.paperId.localeCompare(b.paperId));
    if (stableHash(rebuilt) !== manifest.selectedBindingSha256) throw new Error('当前论文与页面的对应记录与生成清单记录的输入不一致。');
    return rebuilt;
}

function pageInputBindings(groups) {
    return groups.flatMap(group => group.pages.map(page => ({ paperId: group.paperId,
        pageKey: page.pageKey, pagePath: page.pagePath, primaryUrl: page.primaryUrl,
        cohortDate: page.cohortDate, sourcePageContentSha256: page.pageContentSha256,
        stagedPath: path.posix.join('pages', page.pagePath), analysisRunId: group.analysisRunId,
        analysisFileSha256: group.analysisFileSha256,
        analysisRecordSha256: group.analysisRecordSha256,
        analysisSha256: group.analysisSha256,
        taxonomyAssignmentSha256: group.taxonomy.assignmentSha256,
        taxonomyFileSha256: group.taxonomyFileSha256 }))).sort((a, b) => a.pagePath.localeCompare(b.pagePath));
}

function normalizeStagingManifest(value) {
    const expected = ['contract', 'version', 'stagingRunId', 'crosswalkId', 'crosswalkStateSha256',
        'identityGroupsSha256', 'rendererImplementationSha256', 'createdAt', 'pages', 'pageSetSha256', 'assets', 'assetSetSha256',
        'selectedBindings', 'selectedBindingSha256', 'manifestSha256'];
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== expected.sort().join('\0')
        || value.contract !== CONTRACT || value.version !== VERSION || !UUID_RE.test(value.stagingRunId || '')
        || !SHA_RE.test(value.rendererImplementationSha256 || '') || !Array.isArray(value.pages)
        || !Array.isArray(value.assets) || !Array.isArray(value.selectedBindings)
        || value.pageSetSha256 !== stableHash(value.pages) || value.assetSetSha256 !== stableHash(value.assets)
        || value.selectedBindingSha256 !== stableHash(value.selectedBindings)) throw new Error('历史页面生成清单的字段、版本或输入哈希无效。');
    const body = { ...value }; delete body.manifestSha256;
    if (!SHA_RE.test(value.manifestSha256 || '') || value.manifestSha256 !== stableHash(body)) throw new Error('历史页面生成清单自身的 SHA 缺失、格式无效或与内容不一致。');
    return structuredClone(value);
}

function stagingIntent(options, loaded, selectedBindings, pageBindings, rendererImplementationSha256) {
    const body = { contract: INTENT_CONTRACT, version: VERSION, stagingRunId: options.stagingRunId,
        crosswalkId: loaded.crosswalk.crosswalkId, rendererImplementationSha256, selectedBindings,
        selectedBindingSha256: stableHash(selectedBindings), pageBindings,
        pageBindingSha256: stableHash(pageBindings) };
    return { ...body, intentSha256: stableHash(body) };
}

function normalizeStagingIntent(value) {
    if (!value || value.contract !== INTENT_CONTRACT || value.version !== VERSION
        || !UUID_RE.test(value.stagingRunId || '') || !Array.isArray(value.selectedBindings)
        || !SHA_RE.test(value.rendererImplementationSha256 || '') || !Array.isArray(value.pageBindings)
        || value.selectedBindingSha256 !== stableHash(value.selectedBindings)
        || value.pageBindingSha256 !== stableHash(value.pageBindings)) throw new Error('历史页面生成输入记录的字段、版本或输入哈希无效。');
    const body = { ...value }; delete body.intentSha256;
    if (!SHA_RE.test(value.intentSha256 || '') || value.intentSha256 !== stableHash(body)) throw new Error('历史页面生成输入记录自身的 SHA 缺失、格式无效或与内容不一致。');
    return structuredClone(value);
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

function writeExact(filename, bytes, dependencies = {}) {
    fresh.assertSafeDirectory(path.dirname(filename), true); const payload = Buffer.from(bytes); const io = dependencies.io || fs;
    let fd; let created = null; let completed = false;
    try {
        fd = io.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        created = fs.fstatSync(fd, { bigint: true }); let offset = 0;
        while (offset < payload.length) {
            const written = io.writeSync(fd, payload, offset, payload.length - offset, offset);
            if (!Number.isSafeInteger(written) || written <= 0 || written > payload.length - offset) throw new Error(`写入返回的字节数无效，无法继续写入页面生成文件：${filename}`);
            offset += written;
        }
        io.fsyncSync(fd); completed = true;
    }
    catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!readRegular(filename, 64 * 1024 * 1024, '已有页面生成文件').bytes.equals(payload)) throw new Error(`已有页面生成文件与待写入内容不同，不能覆盖：${filename}`);
    }
    finally {
        if (fd !== undefined) io.closeSync(fd);
        if (!completed && created) {
            try { const named = fs.lstatSync(filename, { bigint: true });
                if (named.isFile() && !named.isSymbolicLink() && named.nlink === 1n
                    && named.dev === created.dev && named.ino === created.ino) fs.unlinkSync(filename); }
            catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
        }
    }
    if (!readRegular(filename, 64 * 1024 * 1024, '已写入的页面生成文件').bytes.equals(payload)) throw new Error(`页面生成文件的实际内容与写入内容不一致：${filename}`);
    return sha256(payload);
}

function stagedFileInventory(runRoot, maximum = 10000) {
    const files = [];
    const walk = (directory, prefix = '') => {
        for (const name of fs.readdirSync(directory).sort()) {
            const target = path.join(directory, name); const relative = path.posix.join(prefix, name);
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) throw new Error(`历史页面生成目录中不能有符号链接：${relative}`);
            if (stat.isDirectory()) walk(target, relative);
            else if (stat.isFile() && stat.nlink === 1) files.push(relative);
            else throw new Error(`历史页面生成目录中的条目必须是目录或仅有一个硬链接的普通文件：${relative}`);
            if (files.length > maximum) throw new Error('历史页面生成目录中的文件数量超过限制。');
        }
    };
    walk(runRoot); return files.sort();
}

function stageHistoricalPages(options, dependencies = {}) {
    const rendererImplementationSha256 = currentRendererImplementationSha256(dependencies);
    if (options.rendererImplementationSha256 !== undefined
        && options.rendererImplementationSha256 !== rendererImplementationSha256) {
        throw new Error('历史页面生成器的实际实现指纹与预期指纹不一致。');
    }
    const loaded = loadPageGenerationInputs(options, dependencies); const maximum = options.limit === 'pilot' ? 1 : options.limit === null ? loaded.groups.length : options.limit;
    const selected = loaded.groups.slice(0, maximum);
    if (options.expectedAssignment !== undefined) {
        const expected = options.expectedAssignment;
        const group = selected.length === 1 ? selected[0] : null;
        const actual = group && {
            paperId: group.paperId,
            analysisRunId: group.analysisRunId,
            analysisFileSha256: group.analysisFileSha256,
            analysisRecordSha256: group.analysisRecordSha256,
            analysisSha256: group.analysisSha256,
            registrySha256: group.taxonomy.registrySha256,
            assignmentSha256: group.taxonomy.assignmentSha256,
            taxonomyFileSha256: group.taxonomyFileSha256
        };
        if (!expected || typeof expected !== 'object' || Array.isArray(expected)
            || stableHash(actual) !== stableHash(expected)
            || options.expectedStagingRunId !== options.stagingRunId) {
            throw new Error('预期标签记录或页面生成运行 ID 与本次选择不一致。');
        }
    }
    const plan = { status: options.apply ? 'staging' : 'dry-run', rendererImplementationSha256,
        availableIdentities: loaded.groups.length,
        selectedIdentities: selected.length, selectedPages: selected.reduce((sum, group) => sum + group.pages.length, 0),
        identities: selected.map(group => ({ paperId: group.paperId, analysisRunId: group.analysisRunId,
            pageCount: group.pages.length, cohortDates: [...new Set(group.pages.map(page => page.cohortDate))].sort() })) };
    if (!options.apply) return plan;
    if (!selected.length) throw new Error('指定分析运行和当前词表下，没有标签分配已完成且可用于生成页面的论文记录。');
    if (!UUID_RE.test(options.stagingRunId || '')) throw new Error('页面生成运行 ID（stagingRunId）必须是 UUID。');
    const root = fresh.assertSafeDirectory(options.stagingRoot, true);
    const runRoot = fresh.assertSafeDirectory(path.join(root, options.stagingRunId), true);
    const selectedBindings = selectedBindingsFor(selected); const pageBindings = pageInputBindings(selected);
    const intent = stagingIntent(options, loaded, selectedBindings, pageBindings, rendererImplementationSha256);
    const intentFile = path.join(runRoot, 'intent.json'); const manifestFile = path.join(runRoot, 'manifest.json');
    if (fs.existsSync(manifestFile)) {
        const loadedIntent = normalizeStagingIntent(strictJson(
            readRegular(intentFile, 16 * 1024 * 1024, '已有页面生成输入记录').bytes, '已有页面生成输入记录'));
        const loadedManifest = readRegular(manifestFile, 16 * 1024 * 1024, '已有页面生成清单');
        const manifest = normalizeStagingManifest(strictJson(loadedManifest.bytes, '已有页面生成清单'));
        if (manifest.stagingRunId !== options.stagingRunId || manifest.crosswalkId !== loaded.crosswalk.crosswalkId
            || manifest.rendererImplementationSha256 !== rendererImplementationSha256
            || manifest.selectedBindingSha256 !== stableHash(selectedBindings)
            || stableHash(loadedIntent) !== stableHash(intent)) throw new Error('已有页面生成记录与本次选择的论文、页面或生成器实现不一致。');
        replaySelectedBindings(manifest, loaded.crosswalk);
        const recoveredPageBindings = manifest.pages.map(page => { const copy = { ...page }; delete copy.contentSha256; return copy; });
        if (stableHash(recoveredPageBindings) !== stableHash(pageInputBindings(selected))) {
            throw new Error('恢复记录中的分析、标签或页面对应关系与本次输入不一致。');
        }
        for (const page of manifest.pages) {
            const target = path.resolve(runRoot, ...page.stagedPath.split('/'));
            if (!target.startsWith(`${runRoot}${path.sep}`)
                || readRegular(target, 32 * 1024 * 1024, '待恢复页面').fileSha256 !== page.contentSha256) throw new Error('恢复页面的路径越出运行目录，或文件 SHA 与生成清单不一致。');
        }
        for (const asset of manifest.assets) {
            const target = path.resolve(runRoot, 'assets', ...asset.path.split('/'));
            if (!target.startsWith(`${path.join(runRoot, 'assets')}${path.sep}`)) throw new Error('恢复资源的路径越出了当前运行的资源目录。');
            const found = readRegular(target, 64 * 1024 * 1024, '待恢复资源');
            if (found.fileSha256 !== asset.sha256 || found.bytes.length !== asset.size) throw new Error('恢复资源的 SHA 或字节数与生成清单不一致。');
        }
        return { ...plan, status: 'recovered', stagingRunId: options.stagingRunId, stagingRoot: runRoot,
            pageCount: manifest.pages.length, manifestSha256: manifest.manifestSha256,
            manifest: structuredClone(manifest) };
    }
    const priorEntries = fs.readdirSync(runRoot).sort();
    if (priorEntries.some(name => !['intent.json', 'pages', 'assets'].includes(name))) {
        throw new Error('旧运行目录中有无法与输入记录对应的未完成文件；请使用新的运行 ID。');
    }
    for (const name of priorEntries.filter(name => ['pages', 'assets'].includes(name))) {
        fresh.assertSafeDirectory(path.join(runRoot, name));
    }
    writeExact(intentFile, Buffer.from(`${JSON.stringify(intent, null, 2)}\n`));
    const replayedIntent = normalizeStagingIntent(strictJson(
        readRegular(intentFile, 16 * 1024 * 1024, '页面生成输入记录').bytes, '页面生成输入记录'));
    if (stableHash(replayedIntent) !== stableHash(intent)) throw new Error('页面生成输入记录与本次选择的输入不一致。');
    const preparedPages = []; const preparedAssets = new Map();
    for (const group of selected) for (const page of group.pages) {
        const rendered = (dependencies.render || defaultRender)({ paper: group.paper,
            taxonomy: group.taxonomy, cohortDate: page.cohortDate });
        const markdown = typeof rendered === 'string' ? rendered : rendered.markdown;
        for (const asset of typeof rendered === 'string' ? [] : rendered.assets) {
            if (!asset || typeof asset.path !== 'string' || !/^(?:static\/images\/papers|static\/data\/papers)\/[A-Za-z0-9._\/-]+$/.test(asset.path)
                || path.posix.normalize(asset.path) !== asset.path || asset.path.split('/').includes('..')
                || typeof asset.base64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.base64)) throw new Error('页面生成器返回的资源路径或 base64 数据格式无效。');
            const bytes = Buffer.from(asset.base64, 'base64'); const digest = sha256(bytes);
            if (preparedAssets.has(asset.path) && preparedAssets.get(asset.path).record.sha256 !== digest) {
                throw new Error(`页面生成器为同一资源路径返回了不同内容：${asset.path}`);
            }
            preparedAssets.set(asset.path, { bytes,
                record: { path: asset.path, sha256: digest, size: bytes.length } });
        }
        if (typeof markdown !== 'string' || !markdown.trim()
            || !/^content\/posts\/[A-Za-z0-9._/-]+\.md$/.test(page.pagePath)
            || path.posix.normalize(page.pagePath) !== page.pagePath || page.pagePath.split('/').includes('..')) throw new Error('页面正文为空或格式无效，或目标页面路径不符合要求。');
        const relative = path.posix.join('pages', page.pagePath); const target = path.resolve(runRoot, ...relative.split('/'));
        if (!target.startsWith(`${path.join(runRoot, 'pages')}${path.sep}`)) throw new Error('页面路径越出了当前运行的页面目录。');
        const bytes = Buffer.from(markdown, 'utf8');
        preparedPages.push({ relative, target, bytes,
            record: { paperId: group.paperId, pageKey: page.pageKey, pagePath: page.pagePath,
            primaryUrl: page.primaryUrl, cohortDate: page.cohortDate, sourcePageContentSha256: page.pageContentSha256,
            stagedPath: relative, contentSha256: sha256(bytes), analysisRunId: group.analysisRunId,
            analysisFileSha256: group.analysisFileSha256,
            analysisRecordSha256: group.analysisRecordSha256,
            analysisSha256: group.analysisSha256,
            taxonomyAssignmentSha256: group.taxonomy.assignmentSha256,
            taxonomyFileSha256: group.taxonomyFileSha256 } });
    }
    if (currentRendererImplementationSha256(dependencies) !== rendererImplementationSha256) {
        throw new Error('页面生成期间，生成器的实现指纹发生变化。');
    }
    for (const prepared of [...preparedAssets.values()]) {
        const assetRoot = path.join(runRoot, 'assets');
        const target = path.resolve(assetRoot, ...prepared.record.path.split('/'));
        if (!target.startsWith(`${assetRoot}${path.sep}`)) throw new Error('页面生成器返回的资源路径越出了当前运行的资源目录。');
        if (writeExact(target, prepared.bytes) !== prepared.record.sha256) {
            throw new Error(`资源文件写入后的 SHA 与待写入内容不一致：${prepared.record.path}`);
        }
    }
    for (const prepared of preparedPages) {
        if (writeExact(prepared.target, prepared.bytes) !== prepared.record.contentSha256) {
            throw new Error(`页面文件写入后的 SHA 与待写入内容不一致：${prepared.record.pagePath}`);
        }
    }
    const records = preparedPages.map(item => item.record)
        .sort((a, b) => a.pagePath.localeCompare(b.pagePath));
    const assetRecords = [...preparedAssets.values()].map(item => item.record)
        .sort((a, b) => a.path.localeCompare(b.path));
    const expectedFiles = ['intent.json', ...records.map(item => item.stagedPath),
        ...assetRecords.map(item => path.posix.join('assets', item.path))].sort();
    if (stableHash(stagedFileInventory(runRoot)) !== stableHash(expectedFiles)) {
        throw new Error('生成目录中的文件与本次输入和生成结果不完全对应，无法生成清单。');
    }
    const body = { contract: CONTRACT, version: VERSION, stagingRunId: options.stagingRunId,
        crosswalkId: loaded.crosswalk.crosswalkId, crosswalkStateSha256: loaded.crosswalk.stateSha256,
        identityGroupsSha256: loaded.crosswalk.identityGroupsSha256, rendererImplementationSha256,
        createdAt: dependencies.now?.() || new Date().toISOString(),
        pages: records, pageSetSha256: stableHash(records), assets: assetRecords,
        assetSetSha256: stableHash(assetRecords),
        selectedBindings, selectedBindingSha256: stableHash(selectedBindings) };
    const manifest = { ...body, manifestSha256: stableHash(body) };
    writeExact(path.join(runRoot, 'manifest.json'), Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    return { ...plan, status: 'staged', stagingRunId: options.stagingRunId, stagingRoot: runRoot,
        pageCount: records.length, manifestSha256: manifest.manifestSha256,
        manifest: structuredClone(manifest) };
}

module.exports = { CONTRACT, INTENT_CONTRACT, RENDERER_IMPLEMENTATION_CONTRACT, RENDERER_IMPLEMENTATION_FILES,
    VERSION, rendererImplementationIdentity, currentRendererImplementationSha256,
    readAssignment, findAssignment, loadPageGenerationInputs,
    selectedBindingsFor, replaySelectedBindings, pageInputBindings, normalizeStagingManifest,
    stagingIntent, normalizeStagingIntent, strictJson, readRegular, defaultRender, writeExact,
    stagedFileInventory, stageHistoricalPages };
