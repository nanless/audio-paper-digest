#!/usr/bin/env node
'use strict';
// 静态反向依赖图、协议/渲染指纹闭包识别与受影响单测执行器（默认只读；--run-tests 串行跑受影响单测）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { collectWorkflowImplementationFiles } = require('./lib/workflow-implementation-files.js');

const ROOT = path.resolve(__dirname, '..');
const REAL_ROOT = fs.realpathSync(ROOT);

const SKIP_DIRS = new Set([
    'node_modules', '.venv', 'data', 'logs', 'tmp', '.git',
    '__pycache__', '.pytest_cache', 'fixtures', '_understanding', 'output'
]);
const GENERATED_CLIENT_DIRS = new Set([
    'apps/macos/.build', 'apps/macos/.qa',
    'apps/android/.build', 'apps/android/.qa', 'apps/android/.gradle', 'apps/android/.kotlin',
    'apps/android/build', 'apps/android/app/build',
    'apps/android/app/.cxx', 'apps/android/app/.externalNativeBuild'
]);
// 这些模块包含用于索引或参数校验的路径字面量样例，不构成运行时调用边（其真实 require 仍正常解析）。
const NON_EXEC_LITERAL_FILES = new Set([
    'scripts/impact.js', 'tests/impact.test.js', 'scripts/docs-consistency.js',
    'tests/scripts-index.test.js', 'tests/documentation.test.js'
]);

const MAX_WILDCARD_TESTS = 50;
const USAGE = '用法: node scripts/impact.js <file-or-dir>... [--json] [--run-tests]\n'
    + '   或: node scripts/impact.js --git [--json] [--run-tests]';
const VERIFY_REMINDER = '提示：定向测试通过不代替提交前完整 `npm run verify`。';

const MAP = [
    // Reader 库同时服务于日更、会议和历史三条流程；通配入口表示这些流程的
    // 各阶段都可能读取同一套 Reader/表格校验，而不是只有四个主命令。
    { match: /(?:^|\/)scripts\/lib\/reader-|scripts\/deep-analyzer\.js|scripts\/analysis-contract\.js/, entries: ['deep', 'batch', 'reanalyze', 'reanalyze:selected', 'api:reader:refresh', 'digest:prepare', 'digest:api', 'conference:*', 'history:*'], scope: 'Reader/表格校验；历史已签稿需按当前规则重验，相关缓存不可直接复用', tests: ['tests/reader-*', 'tests/deep-analyzer*'] },
    { match: /(?:^|\/)scripts\/(?:publish_common|publish-to-blog|publish_node_replay_client)\.py|scripts\/lib\/publish-node-replay-worker\.js/, entries: ['blog:generate', 'blog:review', 'blog:push', 'conference:publish:*', 'history:publication'], scope: '发布渲染/校验；页面需重新生成并按内容 SHA 重审', tests: ['tests/python/test_publish_*', 'tests/publish-node-replay-worker.test.js', 'tests/documentation.test.js'] },
    { match: /(?:^|\/)scripts\/llm-account-pool\.js|scripts\/llm_account_pool\.py|scripts\/utils\.js/, entries: ['deep', 'batch', 'reanalyze', 'api:reader:refresh', 'blog:review', 'blog:push'], scope: '所有 ND 模型请求；账号池冷却/轮转状态保留，不需重分析', tests: ['tests/llm-account-pool*', 'tests/python/test_llm_account_pool.py'] },
    { match: /(?:^|\/)scripts\/log-setup\.js|scripts\/log_setup\.py|scripts\/lib\/error-guidance/, entries: ['*'], scope: '日志/错误展示；不改变业务数据与已通过结果', tests: ['tests/log-setup*', 'tests/error-guidance*'] },
    { match: /(?:^|\/)scripts\/digest-run-report\.js|scripts\/lib\/digest-live-status\.js|scripts\/lib\/llm-usage-summary\.js/, entries: ['digest:status'], scope: '状态报告/费用汇总；不影响发布资格', tests: ['tests/digest-run-report*', 'tests/llm-usage-summary.test.js'] },
    { match: /(?:^|\/)scripts\/doctor\.js|scripts\/config-check\.js|scripts\/lib\/env-schema\.js/, entries: ['doctor', 'config:check'], scope: '只读体检/配置检查；不触碰数据', tests: ['tests/doctor.test.js', 'tests/config-check.test.js', 'tests/env-schema.test.js'] },
    { match: /(?:^|\/)scripts\/full-fetch\.js|scripts\/source-probe\.js/, entries: ['digest:prepare', 'digest:api', 'fetch', 'source:probe'], scope: '抓取/筛选；失败集合与已发布页去重需按检查点复核', tests: ['tests/full-fetch*', 'tests/source-acquisition-policy.test.js'] },
    { match: /(?:^|\/)scripts\/analysis-engine\.js|scripts\/lib\/daily-fresh-source-plan\.js/, entries: ['deep', 'batch', 'reanalyze', 'api:reader:refresh', 'digest:prepare'], scope: '分析引擎/日更来源计划；断点、失败轮次与费用需按原清单复核', tests: ['tests/analysis-*', 'tests/daily-fresh-source-*', 'tests/full-fetch*'] },
    { match: /(?:^|\/)scripts\/(?:recover|manifest-new|table-check|impact|source-probe|config-check|llm-accounts-report|verify-web|publish-finish|locks|docs-consistency)\.js|scripts\/lib\/(?:error-codes|source-acquisition-policy|env-schema|review-overrides)\.js/, entries: ['recover', 'manifest:new', 'table:check', 'impact', 'source:probe', 'config:check', 'llm:accounts', 'verify:web', 'publish:finish', 'locks', 'docs:check'], scope: '运行辅助工具；只影响诊断/清单/验收命令，不改变正式分析与发布数据', tests: ['tests/*'] }
];

const GRAPH_CACHE = new Map();
const CLOSURE_CACHE = new Map();

function clearCaches() {
    GRAPH_CACHE.clear();
    CLOSURE_CACHE.clear();
}

function resolveBaseRoot(root = ROOT) {
    return fs.realpathSync(path.resolve(root));
}

function isOutsideRelative(relative) {
    return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative);
}

function hasSymlinkOrExcludedSegment(baseRoot, relativePosix) {
    const parts = relativePosix.split('/').filter(Boolean);
    let current = baseRoot;
    let relSoFar = '';
    for (let index = 0; index < parts.length; index += 1) {
        const segment = parts[index];
        if (SKIP_DIRS.has(segment)) return true;
        relSoFar = relSoFar ? `${relSoFar}/${segment}` : segment;
        if (GENERATED_CLIENT_DIRS.has(relSoFar)) return true;
        current = path.join(current, segment);
        let stat;
        try { stat = fs.lstatSync(current); } catch { return false; }
        if (stat.isSymbolicLink()) return true;
    }
    return false;
}

function toProjectRelative(baseRoot, target, rawRoot = baseRoot) {
    const raw = String(target || '').replace(/\\/g, '/');
    if (!raw.trim()) return null;

    if (!path.isAbsolute(raw)) {
        const candidateAbs = path.resolve(baseRoot, raw);
        const relative = path.relative(baseRoot, candidateAbs).split(path.sep).join('/');
        if (isOutsideRelative(relative)) return null;
        if (!relative) return '.';
        const cleaned = relative.replace(/\/+$/, '') || '.';
        if (cleaned !== '.' && hasSymlinkOrExcludedSegment(baseRoot, cleaned)) return null;
        return cleaned;
    }

    const candidateAbs = path.normalize(raw);
    let relative = path.relative(baseRoot, candidateAbs).split(path.sep).join('/');
    if (isOutsideRelative(relative)) {
        // 兼容 macOS /var/folders -> /private/var/folders 系统级根目录别名，同时拒绝外部软链穿透。
        const resolvedRawRoot = path.resolve(rawRoot);
        const relFromRawRoot = path.relative(resolvedRawRoot, candidateAbs).split(path.sep).join('/');
        if (!isOutsideRelative(relFromRawRoot)) {
            relative = relFromRawRoot;
        } else {
            try {
                const candidateStat = fs.lstatSync(candidateAbs);
                if (candidateStat.isSymbolicLink()) return null;
                const realAbs = fs.realpathSync(candidateAbs);
                const realRel = path.relative(baseRoot, realAbs).split(path.sep).join('/');
                if (isOutsideRelative(realRel)) return null;
                const depth = realRel ? realRel.split('/').filter(Boolean).length : 0;
                let cursor = candidateAbs;
                for (let step = 0; step <= depth; step += 1) {
                    if (fs.lstatSync(cursor).isSymbolicLink()) return null;
                    cursor = path.dirname(cursor);
                }
                if (realRel && hasSymlinkOrExcludedSegment(baseRoot, realRel)) return null;
                relative = realRel;
            } catch {
                return null;
            }
        }
    }
    if (!relative) return '.';
    const cleaned = relative.replace(/\/+$/, '') || '.';
    if (cleaned !== '.' && hasSymlinkOrExcludedSegment(baseRoot, cleaned)) return null;
    return cleaned;
}

function expandTargets(target, baseRoot = REAL_ROOT, rawRoot = baseRoot) {
    const raw = String(target || '').replace(/\\/g, '/');
    const relative = toProjectRelative(baseRoot, raw, rawRoot);
    if (!relative) return { inspectStrings: [], relativeFiles: [], blockedBySymlink: false };
    if (relative !== '.' && hasSymlinkOrExcludedSegment(baseRoot, relative)) {
        return { inspectStrings: [], relativeFiles: [], blockedBySymlink: true };
    }
    const absolute = relative === '.' ? baseRoot : path.join(baseRoot, ...relative.split('/'));
    let stat;
    try { stat = fs.lstatSync(absolute); } catch {
        return { inspectStrings: [relative], relativeFiles: [relative], blockedBySymlink: false };
    }
    if (stat.isSymbolicLink()) {
        return { inspectStrings: [], relativeFiles: [], blockedBySymlink: true };
    }
    if (!stat.isDirectory()) {
        return { inspectStrings: [relative], relativeFiles: [relative], blockedBySymlink: false };
    }
    const files = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
            const next = path.join(directory, entry.name);
            const nextRel = path.relative(baseRoot, next).split(path.sep).join('/');
            if (GENERATED_CLIENT_DIRS.has(nextRel)) continue;
            if (entry.isDirectory()) walk(next);
            else if (entry.isFile()) files.push(nextRel);
        }
    };
    walk(absolute);
    files.sort();
    return { inspectStrings: files.length ? files : [relative], relativeFiles: files, blockedBySymlink: false };
}

const JS_IMPORT = /(?:require(?:\.resolve)?\s*\(\s*|import\s*\(\s*|(?:import|export)\s+(?:[^;\n]*?\s+from\s+)?)(['"])(\.[^'"\n]+)\1/g;
const PY_FROM_PAREN_IMPORT = /(?:^|\n)[ \t]*from[ \t]+(\.*[A-Za-z_][\w.]*|\.+)[ \t]+import[ \t]*\(([\s\S]*?)\)/g;
const PY_FROM_LINE_IMPORT = /(?:^|\n)[ \t]*from[ \t]+(\.*[A-Za-z_][\w.]*|\.+)[ \t]+import[ \t]+(?!\()([^\n#]+)/g;
const PY_IMPORT = /(?:^|\n)[ \t]*import[ \t]+([A-Za-z_][\w., \t]*)/g;
const SLASHED_LITERAL = /(['"`])((?:\.\.?\/|(?:scripts|manual\/scripts|config|prompts\/current|apps)\/)[A-Za-z0-9_./-]+\.(?:js|cjs|mjs|py|sh|json|md))\1/g;
const PATH_JOIN_CALL = /(?:path\.(?:join|resolve)|os\.path\.join)\s*\(([^);\n]+)\)/g;
const PATHLIB_CHAIN = /\b(?:ROOT|PROJECT_ROOT|SCRIPTS|SCRIPTS_DIR|SHARED_SCRIPTS_DIR|MANUAL_SCRIPTS|MANUAL_SCRIPTS_DIR|__dirname)\s*(?:\/\s*['"][^'"\n]+['"]\s*)+/g;
const UNQUOTED_SH_REF = /(?:^|\s)((?:scripts|manual\/scripts)\/[A-Za-z0-9_./-]+\.(?:js|cjs|mjs|py|sh)|run-daily-digest\.sh)(?=\s|$)/gm;

function addPythonFromImportEdges(mod, rawNames, dir, files, addEdge, fromFile) {
    const cleanedNames = rawNames
        .replace(/#[^\n]*/g, '')
        .split(',')
        .map(part => part.trim().split(/\s+as\s+/)[0].trim())
        .filter(name => Boolean(name) && name !== '*');

    if (mod.startsWith('.')) {
        const dots = mod.match(/^\.+/)[0].length;
        const rest = mod.slice(dots).replace(/\./g, '/');
        const up = Array(dots - 1).fill('..').join('/');
        const base = path.posix.normalize([dir, up, rest].filter(Boolean).join('/'));
        if (!isOutsideRelative(base) && files.has(`${base}.py`)) addEdge(fromFile, `${base}.py`);
        for (const name of cleanedNames) {
            const sub = path.posix.normalize(base ? `${base}/${name}.py` : `${name}.py`);
            if (!isOutsideRelative(sub) && files.has(sub)) addEdge(fromFile, sub);
        }
    } else {
        const relMod = mod.replace(/\./g, '/');
        for (const prefix of [dir, 'scripts', 'manual/scripts', 'tests/python', 'tests/helpers', 'manual/tests/python', 'manual/tests/helpers', '']) {
            const cand = path.posix.normalize(prefix ? `${prefix}/${relMod}.py` : `${relMod}.py`);
            if (!isOutsideRelative(cand) && files.has(cand)) addEdge(fromFile, cand);
            for (const name of cleanedNames) {
                const sub = path.posix.normalize(prefix ? `${prefix}/${relMod}/${name}.py` : `${relMod}/${name}.py`);
                if (!isOutsideRelative(sub) && files.has(sub)) addEdge(fromFile, sub);
            }
        }
    }
}

function buildDependencyGraph(options = {}) {
    const baseRoot = resolveBaseRoot(options.root || ROOT);
    if (!options.fresh && GRAPH_CACHE.has(baseRoot)) return GRAPH_CACHE.get(baseRoot);

    const files = new Set();
    const walkControlled = (relDir, predicate, recursive = true) => {
        if (hasSymlinkOrExcludedSegment(baseRoot, relDir)) return;
        const absDir = path.join(baseRoot, ...relDir.split('/'));
        let stat;
        try { stat = fs.lstatSync(absDir); } catch { return; }
        if (stat.isSymbolicLink() || !stat.isDirectory()) return;
        const visit = directory => {
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
                const full = path.join(directory, entry.name);
                const rel = path.relative(baseRoot, full).split(path.sep).join('/');
                if (GENERATED_CLIENT_DIRS.has(rel)) continue;
                if (entry.isDirectory()) {
                    if (recursive) visit(full);
                } else if (entry.isFile() && predicate(rel, entry.name)) {
                    files.add(rel);
                }
            }
        };
        visit(absDir);
    };

    walkControlled('scripts', rel => /\.(?:js|cjs|mjs|py|sh|json)$/.test(rel), true);
    walkControlled('manual/scripts', rel => /\.(?:js|cjs|mjs|py|sh|json)$/.test(rel), true);
    walkControlled('config', rel => /\.json$/.test(rel), true);
    walkControlled('prompts/current', rel => /\.md$/.test(rel), true);
    walkControlled('tests', (_rel, name) => /\.(?:js|cjs|mjs)$/.test(name), false);
    walkControlled('tests/helpers', (_rel, name) => /\.(?:js|cjs|mjs|py)$/.test(name), true);
    walkControlled('manual/tests', (_rel, name) => /\.(?:js|cjs|mjs)$/.test(name), false);
    walkControlled('manual/tests/helpers', (_rel, name) => /\.(?:js|cjs|mjs|py)$/.test(name), true);
    walkControlled('tests/python', (_rel, name) => /\.py$/.test(name), false);
    walkControlled('manual/tests/python', (_rel, name) => /\.py$/.test(name), false);

    for (const extra of ['run-daily-digest.sh', 'apps/generate-client-protocols.py', 'apps/public-protocol-api.js']) {
        if (hasSymlinkOrExcludedSegment(baseRoot, extra)) continue;
        const abs = path.join(baseRoot, ...extra.split('/'));
        try {
            const st = fs.lstatSync(abs);
            if (!st.isSymbolicLink() && st.isFile()) files.add(extra);
        } catch { /* optional root entry */ }
    }

    const forward = new Map();
    const reverse = new Map();
    for (const file of files) {
        forward.set(file, new Set());
        reverse.set(file, new Set());
    }

    const addEdge = (from, to) => {
        if (!to || from === to || !files.has(from) || !files.has(to)) return;
        forward.get(from).add(to);
        reverse.get(to).add(from);
    };

    const resolveRelative = (baseDir, specifier) => {
        const joined = path.posix.normalize(baseDir ? `${baseDir}/${specifier}` : specifier);
        if (!joined || isOutsideRelative(joined)) return null;
        for (const suffix of ['', '.js', '.cjs', '.mjs', '.json', '/index.js', '.py']) {
            const candidate = joined + suffix;
            if (files.has(candidate)) return candidate;
        }
        return null;
    };

    for (const file of files) {
        if (file.startsWith('config/') || file.startsWith('prompts/')) continue;
        const absFile = path.join(baseRoot, ...file.split('/'));
        if (file.endsWith('.json')) {
            try { if (fs.lstatSync(absFile).size > 256 * 1024) continue; } catch { continue; }
        }
        let text;
        try { text = fs.readFileSync(absFile, 'utf8'); } catch { continue; }
        const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file);

        if (/\.(?:js|cjs|mjs)$/.test(file)) {
            for (const match of text.matchAll(JS_IMPORT)) {
                const resolved = resolveRelative(dir, match[2]);
                if (resolved) addEdge(file, resolved);
            }
        }
        if (file.endsWith('.py')) {
            for (const match of text.matchAll(PY_FROM_PAREN_IMPORT)) {
                addPythonFromImportEdges(match[1], match[2], dir, files, addEdge, file);
            }
            for (const match of text.matchAll(PY_FROM_LINE_IMPORT)) {
                addPythonFromImportEdges(match[1], match[2], dir, files, addEdge, file);
            }
            for (const match of text.matchAll(PY_IMPORT)) {
                for (const part of match[1].split(',')) {
                    const mod = part.trim().split(/\s+as\s+/)[0].trim();
                    if (!mod || !/^[A-Za-z_][\w.]*$/.test(mod)) continue;
                    const relMod = mod.replace(/\./g, '/');
                    for (const prefix of [dir, 'scripts', 'manual/scripts', 'tests/python', 'tests/helpers', 'manual/tests/python', 'manual/tests/helpers', '']) {
                        const cand = path.posix.normalize(prefix ? `${prefix}/${relMod}.py` : `${relMod}.py`);
                        if (!isOutsideRelative(cand) && files.has(cand)) addEdge(file, cand);
                    }
                }
            }
        }
        if (file.endsWith('.sh')) {
            for (const match of text.matchAll(UNQUOTED_SH_REF)) addEdge(file, match[1]);
        }
        if (!NON_EXEC_LITERAL_FILES.has(file)) {
            for (const match of text.matchAll(SLASHED_LITERAL)) {
                const literal = match[2];
                if (literal.startsWith('./') || literal.startsWith('../')) {
                    const resolved = resolveRelative(dir, literal);
                    if (resolved) addEdge(file, resolved);
                } else if (files.has(literal)) {
                    addEdge(file, literal);
                }
            }
            for (const match of text.matchAll(PATH_JOIN_CALL)) {
                const args = match[1];
                const segments = [...args.matchAll(/(['"])([^'"\n]+)\1/g)].map(item => item[2]);
                if (!segments.length) continue;
                let base = null;
                if (/\b__dirname\b|os\.path\.dirname\s*\(\s*__file__\s*\)/.test(args)) base = dir;
                else if (/\b(?:SCRIPTS|SCRIPTS_DIR|SHARED_SCRIPTS_DIR)\b/.test(args)) base = 'scripts';
                else if (/\b(?:MANUAL_SCRIPTS|MANUAL_SCRIPTS_DIR)\b/.test(args)) base = 'manual/scripts';
                else if (/\b(?:ROOT|PROJECT_ROOT)\b/.test(args)) base = '';
                if (base !== null) {
                    const joined = path.posix.normalize([base, ...segments].filter(Boolean).join('/'));
                    if (!isOutsideRelative(joined)) {
                        const resolved = resolveRelative('', joined);
                        if (resolved) addEdge(file, resolved);
                    }
                }
            }
            for (const match of text.matchAll(PATHLIB_CHAIN)) {
                const chain = match[0];
                const segments = [...chain.matchAll(/(['"])([^'"\n]+)\1/g)].map(item => item[2]);
                let base = '';
                if (/^(?:SCRIPTS|SCRIPTS_DIR|SHARED_SCRIPTS_DIR)\b/.test(chain)) base = 'scripts';
                else if (/^(?:MANUAL_SCRIPTS|MANUAL_SCRIPTS_DIR)\b/.test(chain)) base = 'manual/scripts';
                else if (/^__dirname\b/.test(chain)) base = dir;
                const joined = path.posix.normalize([base, ...segments].filter(Boolean).join('/'));
                if (!isOutsideRelative(joined) && files.has(joined)) addEdge(file, joined);
            }
        }
    }

    const scriptEntries = [];
    const pkgPath = path.join(baseRoot, 'package.json');
    try {
        const stat = fs.lstatSync(pkgPath);
        if (!stat.isSymbolicLink() && stat.isFile()) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            for (const [name, command] of Object.entries(pkg.scripts || {})) {
                const refs = [...String(command).matchAll(UNQUOTED_SH_REF)]
                    .map(match => match[1])
                    .filter(ref => files.has(ref));
                if (refs.length) scriptEntries.push({ name, command: String(command), files: [...new Set(refs)] });
            }
        }
    } catch { /* ignore absent package.json in custom minimal fixtures */ }

    const jsTestFiles = [...files].filter(file => /^(?:tests|manual\/tests)\/[^/]+\.test\.js$/.test(file)).sort();
    const pyTestFiles = [...files].filter(file => /^(?:tests|manual\/tests)\/python\/test_[^/]+\.py$/.test(file)).sort();

    const graph = { root: baseRoot, files, forward, reverse, scriptEntries, jsTestFiles, pyTestFiles };
    GRAPH_CACHE.set(baseRoot, graph);
    return graph;
}

function computeReverseClosure(graph, seeds) {
    const seen = new Set();
    const queue = [];
    for (const seed of seeds) {
        if (graph.files.has(seed) && !seen.has(seed)) {
            seen.add(seed);
            queue.push(seed);
        }
    }
    while (queue.length) {
        const current = queue.shift();
        for (const caller of graph.reverse.get(current) || []) {
            if (!seen.has(caller)) {
                seen.add(caller);
                queue.push(caller);
            }
        }
    }
    return seen;
}

const EXTRA_RENDERER_ENTRIES = Object.freeze([
    'scripts/generate-blog.py',
    'scripts/conference-page-render.py',
    'scripts/lib/conference-postprocess.js',
    'scripts/lib/historical-direct-aggregate.js'
]);

const BLOG_REVIEW_ENTRIES = Object.freeze([
    'scripts/publish-to-blog.py', 'scripts/review-blog.py', 'scripts/generate-blog.py',
    'scripts/publish_common.py', 'scripts/paper_reader_presentation.py',
    'scripts/markdown_hugo_gate.py', 'scripts/lib/workflow-implementation-files-cli.js',
    'manual/scripts/manual-review-blog.py', 'manual/scripts/tutorial_payload_verifier.py',
    'scripts/publish-conference.py', 'scripts/historical-direct-review.py',
    'scripts/lib/historical-direct-publication.js'
]);

const HISTORICAL_REWRITE_ENTRIES = Object.freeze([
    'scripts/historical-direct-rewrite-inputs.js',
    'scripts/historical-conference-page-projections.js',
    'scripts/historical-direct-rewrite-plan.js',
    'scripts/historical-direct-rewrite-scheduler.js',
    'scripts/historical-direct-rewrite-run.js',
    'scripts/historical-arxiv-publication-metadata.js',
    'scripts/historical-direct-aggregate.js',
    'scripts/historical-direct-publication.js',
    'scripts/historical-direct-control.js',
    'scripts/history-resume.js',
    'scripts/historical-direct-review.py',
    'scripts/lib/historical-direct-rewrite-runner.js',
    'scripts/lib/historical-direct-publication.js'
]);

function regularFileExists(baseRoot, rel) {
    if (hasSymlinkOrExcludedSegment(baseRoot, rel)) return false;
    try {
        const st = fs.lstatSync(path.join(baseRoot, ...rel.split('/')));
        return !st.isSymbolicLink() && st.isFile();
    } catch {
        return false;
    }
}

function collectClosureSet(baseRoot, entryFiles, graph) {
    const existing = [...new Set(entryFiles)].filter(entry => regularFileExists(baseRoot, entry));
    if (!existing.length) return new Set();
    if (baseRoot === REAL_ROOT) {
        return new Set(collectWorkflowImplementationFiles({ root: baseRoot, entryFiles: existing }));
    }
    // 针对隔离临时测试目录：若包含完整协议与支撑文件则直接走真实闭包收集器，否则回退至静态正向闭包。
    try {
        return new Set(collectWorkflowImplementationFiles({ root: baseRoot, entryFiles: existing }));
    } catch {
        const visited = new Set(existing);
        const queue = [...existing];
        while (queue.length) {
            const current = queue.shift();
            for (const dep of graph.forward.get(current) || []) {
                if (!visited.has(dep)) {
                    visited.add(dep);
                    queue.push(dep);
                }
            }
        }
        return visited;
    }
}

function collectClientProtocolFiles(baseRoot) {
    const matched = new Set();
    for (const fixed of [
        'apps/generate-client-protocols.py',
        'apps/public-protocol-api.js',
        'scripts/protocol_codec.py',
        'scripts/lib/protocol-codec.js'
    ]) {
        if (regularFileExists(baseRoot, fixed)) matched.add(fixed);
    }
    const protoDir = path.join(baseRoot, 'config', 'protocols');
    try {
        const st = fs.lstatSync(protoDir);
        if (!st.isSymbolicLink() && st.isDirectory()) {
            for (const entry of fs.readdirSync(protoDir, { withFileTypes: true })) {
                if (!entry.isSymbolicLink() && entry.isFile() && /^clients(?:-[a-z0-9-]+)?\.json$/.test(entry.name)) {
                    matched.add(`config/protocols/${entry.name}`);
                }
            }
        }
    } catch { /* optional in custom fixture */ }
    const appsDir = path.join(baseRoot, 'apps');
    try {
        const st = fs.lstatSync(appsDir);
        if (!st.isSymbolicLink() && st.isDirectory()) {
            const walkApps = directory => {
                for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
                    if (entry.isSymbolicLink() || SKIP_DIRS.has(entry.name)) continue;
                    const full = path.join(directory, entry.name);
                    const rel = path.relative(baseRoot, full).split(path.sep).join('/');
                    if (GENERATED_CLIENT_DIRS.has(rel)) continue;
                    if (entry.isDirectory()) walkApps(full);
                    else if (entry.isFile() && /protocol/i.test(entry.name)) matched.add(rel);
                }
            };
            walkApps(appsDir);
        }
    } catch { /* optional in custom fixture */ }
    return matched;
}

function collectFingerprintClosures(options = {}) {
    const baseRoot = resolveBaseRoot(options.root || ROOT);
    if (!options.fresh && CLOSURE_CACHE.has(baseRoot)) return CLOSURE_CACHE.get(baseRoot);

    const graph = buildDependencyGraph(options);
    const rendererEntries = baseRoot === REAL_ROOT
        ? [...require('./lib/paper-page-staging.js').RENDERER_ENTRY_FILES, ...EXTRA_RENDERER_ENTRIES]
        : [
            'scripts/lib/paper-page-staging.js', 'scripts/historical-page-render.py',
            'scripts/publish-to-blog.py', 'scripts/publish_common.py',
            'config/tag-catalog.json', 'config/publish-image-exclusions.json',
            ...EXTRA_RENDERER_ENTRIES
        ];
    const rendererFiles = collectClosureSet(baseRoot, rendererEntries, graph);
    if (regularFileExists(baseRoot, 'config/tag-display-policy.json')) {
        rendererFiles.add('config/tag-display-policy.json');
    }

    let conferenceEntries;
    if (baseRoot === REAL_ROOT) {
        const cp = require('./lib/conference-process.js');
        conferenceEntries = [...cp.currentImplementationFiles(), 'scripts/conference-process.js', 'scripts/migrate-conference-process.js'];
    } else {
        conferenceEntries = ['scripts/conference-process.js', 'scripts/lib/conference-process.js', 'scripts/migrate-conference-process.js'];
    }
    const conferenceClosure = collectClosureSet(baseRoot, conferenceEntries, graph);

    const closures = [
        {
            id: 'paperPageRenderer',
            label: '单篇/汇总页面渲染闭包',
            effect: '改变 rendererImplementationSha256，相关页面需按新渲染指纹重新生成',
            files: rendererFiles
        },
        {
            id: 'blogReviewProtocol',
            label: '博客审查协议闭包',
            effect: '改变 reviewProtocolFingerprint，需重签凭证，未变页面按 SHA 复用',
            files: collectClosureSet(baseRoot, BLOG_REVIEW_ENTRIES, graph)
        },
        {
            id: 'conferenceProcess',
            label: '会议处理闭包',
            effect: '改变会议处理实现指纹（implementationSha256）',
            files: conferenceClosure
        },
        {
            id: 'historicalDirectRewrite',
            label: '历史直改闭包',
            effect: '改变历史直改与历史发布实现闭包',
            files: collectClosureSet(baseRoot, HISTORICAL_REWRITE_ENTRIES, graph)
        },
        {
            id: 'clientProtocols',
            label: '客户端协议闭包',
            effect: '影响客户端与公开协议注册表，需运行 apps/generate-client-protocols.py --check',
            files: collectClientProtocolFiles(baseRoot)
        }
    ];

    CLOSURE_CACHE.set(baseRoot, closures);
    return closures;
}

function matchStemTests(graph, relativeFiles) {
    const jsMatched = new Set();
    const pyMatched = new Set();
    for (const rel of relativeFiles) {
        if (!/^(?:scripts|manual\/scripts|config|prompts\/current|apps)\//.test(rel)) continue;
        if (!graph.files.has(rel)) continue;
        const ext = path.posix.extname(rel);
        const rawStem = path.posix.basename(rel, ext);
        if (!rawStem || rawStem.length < 3 || rawStem === 'index') continue;
        const kebab = rawStem.replace(/_/g, '-');
        const snake = rawStem.replace(/-/g, '_');

        for (const testFile of graph.jsTestFiles) {
            const testStem = path.posix.basename(testFile, '.test.js');
            if (testStem === rawStem || testStem.startsWith(`${rawStem}-`) || testStem.startsWith(`${rawStem}_`)
                || testStem === kebab || testStem.startsWith(`${kebab}-`) || testStem.startsWith(`${kebab}_`)) {
                jsMatched.add(testFile);
            }
        }
        for (const pyFile of graph.pyTestFiles) {
            const pyStem = path.posix.basename(pyFile, '.py');
            if (pyStem === `test_${rawStem}` || pyStem.startsWith(`test_${rawStem}_`)
                || pyStem === `test_${snake}` || pyStem.startsWith(`test_${snake}_`)) {
                pyMatched.add(pyFile);
            }
        }
    }
    return { jsMatched, pyMatched };
}

function impactOfTargets(targets, options = {}) {
    const rawRoot = path.resolve(options.root || ROOT);
    const baseRoot = resolveBaseRoot(rawRoot);
    const graph = buildDependencyGraph({ ...options, root: baseRoot });
    const closures = collectFingerprintClosures({ ...options, root: baseRoot });

    const normalizedTargets = targets.map(item => String(item || '').replace(/\\/g, '/'));
    const inspectAll = [];
    const relativeAll = [];
    for (const item of normalizedTargets) {
        const expanded = expandTargets(item, baseRoot, rawRoot);
        inspectAll.push(...expanded.inspectStrings);
        relativeAll.push(...expanded.relativeFiles);
    }

    const joinedInspect = inspectAll.join('\n');
    const found = joinedInspect ? MAP.filter(rule => rule.match.test(joinedInspect)) : [];

    const uniqueRelFiles = [...new Set(relativeAll)];
    const reverseClosureSet = computeReverseClosure(graph, uniqueRelFiles);
    const reverseClosure = [...reverseClosureSet].sort();

    const exactEntryNames = graph.scriptEntries
        .filter(entry => entry.files.some(file => reverseClosureSet.has(file)))
        .map(entry => entry.name);
    const npmCommands = exactEntryNames.map(name => `npm run ${name}`);

    const stemHits = matchStemTests(graph, uniqueRelFiles);
    const exactJsTests = new Set(stemHits.jsMatched);
    const exactPyTests = new Set(stemHits.pyMatched);
    for (const file of reverseClosureSet) {
        if (/^(?:tests|manual\/tests)\/[^/]+\.test\.js$/.test(file)) exactJsTests.add(file);
        else if (/^(?:tests|manual\/tests)\/python\/test_[^/]+\.py$/.test(file)) exactPyTests.add(file);
    }
    if (uniqueRelFiles.some(rel => closures.find(c => c.id === 'clientProtocols')?.files.has(rel))
        && graph.files.has('tests/python/test_client_protocol_generation.py')) {
        exactPyTests.add('tests/python/test_client_protocol_generation.py');
    }

    const exactTests = {
        js: [...exactJsTests].sort(),
        python: [...exactPyTests].sort()
    };

    const fingerprintImpacts = closures
        .filter(closure => uniqueRelFiles.some(file => closure.files.has(file)))
        .map(({ id, label, effect }) => ({ id, label, effect }));

    const graphMatched = reverseClosure.length > 0
        || fingerprintImpacts.length > 0
        || exactTests.js.length > 0
        || exactTests.python.length > 0;
    const matched = found.length > 0 || graphMatched;

    const targetLabel = normalizedTargets.length === 1 ? normalizedTargets[0] : normalizedTargets.join(', ');
    if (!matched) {
        return {
            target: targetLabel,
            targets: normalizedTargets,
            matched: false,
            entries: [],
            npmCommands: [],
            scope: '未命中静态映射：按通用规则跑定向测试与受影响入口',
            tests: [],
            exactTests,
            fingerprintImpacts: [],
            reverseClosure: []
        };
    }

    const mapEntries = found.flatMap(rule => rule.entries);
    const entries = [...new Set([...mapEntries, ...exactEntryNames])];

    const scopeParts = found.map(rule => rule.scope);
    if (!scopeParts.length) {
        scopeParts.push(`反向依赖图命中（传递影响 ${reverseClosure.length} 个受控文件）`);
    }
    if (fingerprintImpacts.length) {
        scopeParts.push(`指纹闭包：${fingerprintImpacts.map(item => `${item.id}（${item.effect}）`).join('；')}`);
    }
    const scope = scopeParts.join('；');

    const mapTests = [...new Set(found.flatMap(rule => rule.tests))];
    let tests;
    if (!mapTests.length) {
        tests = [...exactTests.js, ...exactTests.python];
    } else if (mapTests.length === 1 && mapTests[0] === 'tests/*' && (exactTests.js.length || exactTests.python.length)) {
        tests = [...new Set([...exactTests.js, ...exactTests.python, ...mapTests])];
    } else {
        tests = mapTests;
    }

    return {
        target: targetLabel,
        targets: normalizedTargets,
        matched: true,
        entries,
        npmCommands,
        scope,
        tests,
        exactTests,
        fingerprintImpacts,
        reverseClosure
    };
}

function impactOf(target, options = {}) {
    return impactOfTargets([target], options);
}

function parseGitPorcelainZPaths(stdout) {
    const paths = [];
    const tokens = String(stdout || '').split('\0');
    for (let index = 0; index < tokens.length; index += 1) {
        const record = tokens[index];
        if (!record) continue;
        if (record.length < 4 || record[2] !== ' ') continue;
        const x = record[0];
        const y = record[1];
        const firstPath = record.slice(3).replace(/\/+$/, '');
        if (firstPath) paths.push(firstPath);
        if (x === 'R' || y === 'R' || x === 'C' || y === 'C') {
            index += 1;
            if (index < tokens.length) {
                const origPath = tokens[index].replace(/\/+$/, '');
                if (origPath) paths.push(origPath);
            }
        }
    }
    return [...new Set(paths)];
}

function impactFromGitStatus(options = {}) {
    const baseRoot = resolveBaseRoot(options.root || ROOT);
    const runner = options.spawnSync || spawnSync;
    const gitEnv = require('./env-loader').buildChildProcessEnv({
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
        ...(options.gitEnv || {})
    });
    const gitResult = runner('git', ['--no-optional-locks', '-C', baseRoot, 'status', '--porcelain=v1', '-z'], {
        cwd: baseRoot,
        env: gitEnv,
        encoding: 'utf8',
        timeout: options.gitTimeoutMs ?? 15000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
        shell: false
    });
    if (gitResult.error || gitResult.signal || gitResult.status !== 0) {
        const detail = gitResult.error?.message || gitResult.signal || String(gitResult.stderr || '').trim() || `退出码 ${gitResult.status}`;
        throw new Error(`无法读取 Git 工作区状态: ${detail}`);
    }
    const modifiedFiles = parseGitPorcelainZPaths(gitResult.stdout);
    if (!modifiedFiles.length) {
        return {
            clean: true,
            gitFiles: [],
            target: '(git clean)',
            targets: [],
            matched: false,
            entries: [],
            npmCommands: [],
            scope: '当前工作区无已修改文件',
            tests: [],
            exactTests: { js: [], python: [] },
            fingerprintImpacts: [],
            reverseClosure: []
        };
    }
    return {
        clean: false,
        gitFiles: modifiedFiles,
        ...impactOfTargets(modifiedFiles, { ...options, root: baseRoot })
    };
}

function expandWildcardTests(graph, patterns) {
    const allTests = [...graph.jsTestFiles, ...graph.pyTestFiles];
    const matched = new Set();
    for (const pattern of patterns) {
        const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
        const regex = new RegExp(`^${escaped}$`);
        for (const candidate of allTests) {
            if (regex.test(candidate)) matched.add(candidate);
        }
    }
    const sorted = [...matched].sort();
    return {
        js: sorted.filter(item => item.endsWith('.test.js')),
        python: sorted.filter(item => item.endsWith('.py')),
        total: sorted.length
    };
}

function groupPythonTestsBySuiteDir(pyTests) {
    const groups = new Map();
    for (const suite of ['tests/python', 'manual/tests/python']) {
        groups.set(suite, []);
    }
    for (const file of pyTests) {
        const suiteDir = path.posix.dirname(file);
        if (!groups.has(suiteDir)) groups.set(suiteDir, []);
        groups.get(suiteDir).push(file);
    }
    return [...groups.entries()]
        .filter(([, files]) => files.length > 0)
        .map(([suiteDir, files]) => ({
            suiteDir,
            files,
            modules: [...new Set(files.map(file => path.posix.basename(file, '.py')))]
        }));
}

function runAffectedTests(impactResult, options = {}) {
    const baseRoot = resolveBaseRoot(options.root || ROOT);
    const graph = buildDependencyGraph({ ...options, root: baseRoot });
    const runner = options.spawnSync || spawnSync;
    const maxWildcard = options.maxWildcardTests ?? MAX_WILDCARD_TESTS;
    const rawBatch = Number(options.jsBatchSize ?? 50);
    const jsBatchSize = Number.isFinite(rawBatch)
        ? (rawBatch < 0 ? 1 : Math.max(1, Math.trunc(rawBatch) || 50))
        : 50;
    const testTimeoutMs = options.testTimeoutMs ?? 300000;
    const maxBufferBytes = 64 * 1024 * 1024;
    const quietStdout = Boolean(options.json);
    const pipeChildOutput = quietStdout || Boolean(options.quiet);

    let jsTests = (impactResult.exactTests?.js || []).filter(file => regularFileExists(baseRoot, file));
    let pyTests = (impactResult.exactTests?.python || []).filter(file => regularFileExists(baseRoot, file));
    let wildcardNotice = null;

    if (!jsTests.length && !pyTests.length && Array.isArray(impactResult.tests) && impactResult.tests.length) {
        const expanded = expandWildcardTests(graph, impactResult.tests);
        if (expanded.total > maxWildcard) {
            wildcardNotice = `通配符展开命中 ${expanded.total} 个测试文件，超过自动执行上限 (${maxWildcard})；请缩小目标范围或直接运行 npm test / npm run verify。`;
        } else {
            jsTests = expanded.js;
            pyTests = expanded.python;
        }
    }

    const logLine = message => {
        if (quietStdout) console.error(message);
        else console.log(message);
    };

    if (wildcardNotice) logLine(`[impact] ${wildcardNotice}`);
    if (!jsTests.length && !pyTests.length) {
        logLine('[impact] 未定位到需要执行的受影响单元测试。');
        logLine(VERIFY_REMINDER);
        return {
            ok: true,
            jsOk: true,
            pyOk: true,
            exitCode: 0,
            jsTests: [],
            pythonTests: [],
            wildcardNotice,
            reminder: VERIFY_REMINDER
        };
    }

    const pycacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-digest-impact-pycache-'));
    const childEnv = {
        ...process.env,
        ...(options.env || {}),
        VERIFY_PROJECT_DISABLE_FILE_LOGS: '1',
        PYTHONPYCACHEPREFIX: pycacheDir
    };
    delete childEnv.NODE_TEST_CONTEXT;
    const pythonRuntime = regularFileExists(baseRoot, 'scripts/python-runtime.sh')
        ? 'scripts/python-runtime.sh'
        : path.join(REAL_ROOT, 'scripts', 'python-runtime.sh');

    let jsOk = true;
    let pyOk = true;
    try {
        if (jsTests.length) {
            logLine(`[impact] 串行执行 JavaScript 受影响单测 (${jsTests.length})...`);
            for (let offset = 0; offset < jsTests.length; offset += jsBatchSize) {
                const batch = jsTests.slice(offset, offset + jsBatchSize);
                const res = runner(process.execPath, ['--test', '--test-concurrency=1', ...batch], {
                    cwd: baseRoot,
                    env: childEnv,
                    stdio: pipeChildOutput ? 'pipe' : 'inherit',
                    encoding: 'utf8',
                    timeout: testTimeoutMs,
                    killSignal: 'SIGKILL',
                    maxBuffer: maxBufferBytes,
                    shell: false
                });
                if (quietStdout && !options.quiet) {
                    if (res.stdout) process.stderr.write(String(res.stdout));
                    if (res.stderr) process.stderr.write(String(res.stderr));
                }
                if (res.error || res.signal || res.status !== 0) jsOk = false;
            }
        }
        if (pyTests.length) {
            logLine(`[impact] 串行执行 Python 受影响单测 (${pyTests.length})...`);
            for (const group of groupPythonTestsBySuiteDir(pyTests)) {
                const absSuiteDir = path.join(baseRoot, ...group.suiteDir.split('/'));
                const existingPyPath = childEnv.PYTHONPATH ? String(childEnv.PYTHONPATH) : '';
                const suiteEnv = {
                    ...childEnv,
                    PYTHONPATH: existingPyPath ? `${absSuiteDir}${path.delimiter}${existingPyPath}` : absSuiteDir
                };
                const pyTimeoutMs = options.testTimeoutMs ?? Math.max(300000, group.modules.length * 15000);
                const res = runner('bash', [pythonRuntime, '-m', 'unittest', ...group.modules], {
                    cwd: baseRoot,
                    env: suiteEnv,
                    stdio: pipeChildOutput ? 'pipe' : 'inherit',
                    encoding: 'utf8',
                    timeout: pyTimeoutMs,
                    killSignal: 'SIGKILL',
                    maxBuffer: maxBufferBytes,
                    shell: false
                });
                if (quietStdout && !options.quiet) {
                    if (res.stdout) process.stderr.write(String(res.stdout));
                    if (res.stderr) process.stderr.write(String(res.stderr));
                }
                if (res.error || res.signal || res.status !== 0) {
                    pyOk = false;
                }
            }
        }
    } finally {
        fs.rmSync(pycacheDir, { recursive: true, force: true });
    }

    const ok = jsOk && pyOk;
    logLine(VERIFY_REMINDER);
    return {
        ok,
        jsOk,
        pyOk,
        exitCode: ok ? 0 : 1,
        jsTests,
        pythonTests: pyTests,
        wildcardNotice,
        reminder: VERIFY_REMINDER
    };
}

function parseCliArgs(argv) {
    const parsed = { help: false, json: false, git: false, runTests: false, targets: [] };
    const seenFlags = new Set();
    for (let index = 0; index < argv.length; index += 1) {
        const arg = String(argv[index] ?? '');
        if (!arg.trim()) {
            throw new Error('目标路径不能为空');
        }
        if (arg === '--help' || arg === '-h') {
            if (seenFlags.has('--help')) throw new Error(`参数不能重复: ${arg}`);
            seenFlags.add('--help');
            parsed.help = true;
        } else if (arg === '--json') {
            if (seenFlags.has('--json')) throw new Error('参数不能重复: --json');
            seenFlags.add('--json');
            parsed.json = true;
        } else if (arg === '--git') {
            if (seenFlags.has('--git')) throw new Error('参数不能重复: --git');
            seenFlags.add('--git');
            parsed.git = true;
        } else if (arg === '--run-tests') {
            if (seenFlags.has('--run-tests')) throw new Error('参数不能重复: --run-tests');
            seenFlags.add('--run-tests');
            parsed.runTests = true;
        } else if (arg.startsWith('-')) {
            throw new Error(`未知参数: ${arg}`);
        } else {
            parsed.targets.push(arg);
        }
    }
    if (parsed.git && parsed.targets.length > 0) {
        throw new Error('参数冲突: --git 不能与显式文件或目录目标同时指定');
    }
    return parsed;
}

function printHumanReport(result) {
    if (result.clean) {
        console.log('影响分析：当前 Git 工作区无已修改文件，无需重跑定向测试。');
        return;
    }
    console.log(`影响分析：${result.target}`);
    console.log(`入口：${result.entries.length ? result.entries.join(', ') : '（未命中）'}`);
    if (result.npmCommands?.length) {
        console.log(`npm 命令：${result.npmCommands.join(', ')}`);
    }
    if (result.fingerprintImpacts?.length) {
        console.log(`指纹闭包：${result.fingerprintImpacts.map(item => `${item.id} -> ${item.effect}`).join('；')}`);
    }
    console.log(`范围：${result.scope}`);
    const exactCount = (result.exactTests?.js.length || 0) + (result.exactTests?.python.length || 0);
    if (exactCount > 0) {
        const allExact = [...result.exactTests.js, ...result.exactTests.python];
        const preview = allExact.length > 20
            ? `${allExact.slice(0, 20).join(', ')} ...（共 ${allExact.length} 个）`
            : allExact.join(', ');
        console.log(`精确测试：${preview}`);
    }
    if (result.tests.length) {
        console.log(`建议测试：${result.tests.join(', ')}`);
    }
}

function main(argv = process.argv.slice(2), options = {}) {
    try { require('./env-loader').requireExternalRuntime('impact.js'); } catch (error) { console.error(`[impact] ${error.message}`); return 1; }

    let cli;
    try {
        cli = parseCliArgs(argv);
    } catch (error) {
        console.error(`[impact] ${error.message}\n${USAGE}`);
        return 2;
    }

    if (cli.help) {
        if (cli.json) {
            console.log(JSON.stringify({ help: true, usage: USAGE }, null, 2));
        } else {
            console.log(USAGE);
        }
        return 0;
    }
    if (!cli.git && !cli.targets.length) {
        console.error(USAGE);
        return 2;
    }

    let result;
    try {
        result = cli.git
            ? impactFromGitStatus(options)
            : impactOfTargets(cli.targets, options);
    } catch (error) {
        console.error(`[impact] ${error.message}`);
        return 2;
    }

    let testRun = null;
    if (cli.runTests) {
        if (result.clean) {
            if (!cli.json) {
                printHumanReport(result);
                console.log(VERIFY_REMINDER);
                return 0;
            }
            testRun = { ok: true, jsOk: true, pyOk: true, exitCode: 0, jsTests: [], pythonTests: [], wildcardNotice: null, reminder: VERIFY_REMINDER };
        } else {
            if (!cli.json) printHumanReport(result);
            testRun = runAffectedTests(result, { ...options, json: cli.json });
        }
    } else if (!cli.json) {
        printHumanReport(result);
    }

    if (cli.json) {
        const payload = testRun ? { ...result, testRun } : result;
        console.log(JSON.stringify(payload, null, 2));
    }
    return testRun ? testRun.exitCode : 0;
}

module.exports = {
    MAP,
    VERIFY_REMINDER,
    clearCaches,
    buildDependencyGraph,
    collectFingerprintClosures,
    impactOf,
    impactOfTargets,
    parseGitPorcelainZPaths,
    impactFromGitStatus,
    runAffectedTests,
    parseCliArgs,
    main
};

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[impact] ${error.message}`); process.exitCode = 2; }
}
