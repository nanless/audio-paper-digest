#!/usr/bin/env node
'use strict';
// 检查文档里的 npm 命令、客户端版本声明、链接与锚点、双语索引、废弃写法、环境变量、env.example 同步及 AGENTS.md 体积。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROOT_DOCS = [
    'README.md', 'README.en.md', 'AGENTS.md', 'SKILL.md',
    'scripts/README.md', 'scripts/README.en.md', 'scripts/INDEX.md',
    'manual/README.md', 'manual/README.en.md',
    'apps/macos/README.md', 'apps/macos/README.en.md',
    'apps/android/README.md', 'apps/android/README.en.md',
    'prompts/README.md'
];
const MARKDOWN_DIRS = ['docs', 'skills'];
const COMMAND = /npm run ([a-z][a-z0-9:_-]*)/g;
const VERSION_CLAIMS = [
    /(\d+\.\d+\.\d+)（构建号\s*(\d+)[^）\n]*）/g,
    /(\d+\.\d+\.\d+)\s*是当前[^。\n（(]{0,24}[（(]构建号\s*(\d+)[^）)\n]*[）)]/g,
    /(\d+\.\d+\.\d+)[、,，]\s*构建号\s*(\d+)/g,
    /(\d+\.\d+\.\d+)\s+构建号\s*(\d+)/g,
    /(\d+\.\d+\.\d+)\s*\(build\s*(\d+)[^)\n]*\)/gi,
    /(\d+\.\d+\.\d+),\s*build\s*(\d+)/gi
];
// 只写构建号、版本在同句省略的写法，例如「当前构建号为 19」。
const BUILD_ONLY = /(?:构建号为|build\s+is)\s*(\d+)/i;
const CURRENT_MARKER = /当前|目前|现在|\b(?:current|currently|now)\b/i;
const UNPUBLISHED_CLAIM = /尚未公开发布|未公开发布|\bnot\s+yet\s+published\b/i;
const PUBLISHED_CURRENT_MARKER = /(?:当前(?:公开)?发行版本|当前公开版本|current\s+published\s+release|已于\s*\d{4}-\d{2}-\d{2}[^。\n]{0,24}公开发布)/i;
const HISTORICAL_REVIEW_FILE = /^docs\/(?:workbench|android)-[\d.]+-review\.md$/;
const VERSION_DOCS = ['docs/README.md', 'docs/README.en.md'];
const VERSION_LIST = /工作台版本|Workbench versions/;
const PLIST = 'apps/macos/Info.plist';
const GRADLE = 'apps/android/app/build.gradle.kts';
const MAX_AGENTS_BYTES = 20 * 1024;

function markdownFiles(root = ROOT) {
    const files = ROOT_DOCS.filter(name => fs.existsSync(path.join(root, name)));
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(target); }
            else if (entry.name.endsWith('.md')) files.push(path.relative(root, target));
        }
    };
    for (const directory of MARKDOWN_DIRS) {
        if (fs.existsSync(path.join(root, directory))) walk(path.join(root, directory));
    }
    return files;
}

function resolveNearestPackageScripts(absFile, fallbackScripts, root = ROOT) {
    const resolvedRoot = path.resolve(root);
    let directory = path.dirname(path.resolve(absFile));
    if (directory !== resolvedRoot && !directory.startsWith(resolvedRoot + path.sep)) {
        return fallbackScripts || {};
    }
    while (true) {
        const manifest = path.join(directory, 'package.json');
        if (fs.existsSync(manifest)) {
            if (directory === resolvedRoot) return fallbackScripts || {};
            return JSON.parse(fs.readFileSync(manifest, 'utf8')).scripts || {};
        }
        if (directory === resolvedRoot) return fallbackScripts || {};
        directory = path.dirname(directory);
    }
}

function checkDocs(files, scripts, root = ROOT) {
    const missing = [];
    const scriptsCache = new Map();
    for (const file of files) {
        const absFile = path.resolve(root, file);
        if (!fs.existsSync(absFile)) throw new Error(`文档不存在：${file}`);
        const dir = path.dirname(absFile);
        if (!scriptsCache.has(dir)) {
            scriptsCache.set(dir, new Set(Object.keys(resolveNearestPackageScripts(absFile, scripts, root))));
        }
        const known = scriptsCache.get(dir);
        const text = fs.readFileSync(absFile, 'utf8');
        for (const match of text.matchAll(COMMAND)) {
            if (!known.has(match[1])) missing.push({ file, command: match[1] });
        }
    }
    return missing;
}

function readVersionSources() {
    const plist = fs.readFileSync(path.resolve(ROOT, PLIST), 'utf8');
    const gradle = fs.readFileSync(path.resolve(ROOT, GRADLE), 'utf8');
    const plistVersion = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    const plistBuild = plist.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
    const gradleVersion = gradle.match(/versionName\s*=\s*"([^"]+)"/);
    const gradleBuild = gradle.match(/versionCode\s*=\s*(\d+)/);
    if (!plistVersion || !plistBuild || !gradleVersion || !gradleBuild) {
        throw new Error('无法从 Info.plist 或 build.gradle.kts 读取版本号与构建号');
    }
    return {
        mac: { version: plistVersion[1].trim(), build: plistBuild[1].trim() },
        android: { version: gradleVersion[1], build: gradleBuild[1] }
    };
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCurrentVersionPublished(files, current, versions) {
    if (versions && typeof versions.published === 'boolean') return versions.published;
    const versionPattern = new RegExp(`(?<![\\d.])${escapeRegExp(current.version)}(?![\\d.])`);
    for (const file of files) {
        const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
        for (const rawLine of text.split('\n')) {
            if (!versionPattern.test(rawLine)) continue;
            if (UNPUBLISHED_CLAIM.test(rawLine)) continue;
            if (PUBLISHED_CURRENT_MARKER.test(rawLine)) return true;
        }
    }
    return false;
}

// 历史评审记录保留当时的版本和结论，不参与核对。当前发行线内的“版本（构建号）”
// 写法，以及同一行明说“当前/目前/现在/current/currently/now”的旧版本写法，按当前实际值核对。
function checkVersionClaims(files, versions) {
    const issues = [];
    const current = versions.mac;
    const line = current.version.split('.').slice(0, 2).join('.');
    const currentPublished = isCurrentVersionPublished(files, current, versions);
    const currentVersionPattern = new RegExp(`(?<![\\d.])${escapeRegExp(current.version)}(?![\\d.])`);
    const staleLatestPublishedPattern = /最近(?:已)?公开发行版本为\s*(\d+\.\d+\.\d+)/;
    if (current.version !== versions.android.version || current.build !== versions.android.build) {
        issues.push({
            file: `${PLIST} / ${GRADLE}`,
            message: `两端版本不一致：macOS ${current.version}（构建号 ${current.build}），Android ${versions.android.version}（构建号 ${versions.android.build}）`
        });
    }
    for (const file of files) {
        const normalizedFile = String(file).split(path.sep).join('/');
        if (HISTORICAL_REVIEW_FILE.test(normalizedFile)) continue;
        const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
        const lines = text.split('\n');
        for (let index = 0; index < lines.length; index += 1) {
            const rawLine = lines[index];
            const claims = VERSION_CLAIMS.flatMap(pattern => [...rawLine.matchAll(pattern)]);
            const currentState = CURRENT_MARKER.test(rawLine);
            if (currentPublished && currentVersionPattern.test(rawLine)) {
                const clauses = rawLine.split(/[。；;]/);
                const claimsCurrentUnpublished = clauses.some(
                    clause => currentVersionPattern.test(clause) && UNPUBLISHED_CLAIM.test(clause)
                );
                if (claimsCurrentUnpublished) {
                    issues.push({
                        file,
                        line: index + 1,
                        message: `将已公开发布的 ${current.version}（构建号 ${current.build}）写成了未公开发布`
                    });
                }
                const staleLatest = staleLatestPublishedPattern.exec(rawLine);
                if (staleLatest && staleLatest[1] !== current.version) {
                    issues.push({
                        file,
                        line: index + 1,
                        message: `将最近公开发行版本写成 ${staleLatest[1]}，但 ${current.version}（构建号 ${current.build}）已公开发布`
                    });
                }
            }
            if (!claims.length) {
                const buildOnly = BUILD_ONLY.exec(rawLine);
                if (buildOnly && currentState && buildOnly[1] !== current.build) {
                    issues.push({ file, line: index + 1, message: `写的是构建号 ${buildOnly[1]}，实际为 ${current.build}` });
                }
                continue;
            }
            // 同行明确同时列出当前版和上一公开发行版时，只校验本行最高声明或与当前发行线同线的声明。
            const lineHasCurrent = claims.some(c => c[1] === current.version && c[2] === current.build);
            for (const claim of claims) {
                const sameLine = claim[1].split('.').slice(0, 2).join('.') === line;
                if (!sameLine && (!currentState || lineHasCurrent)) continue;
                if (claim[1] === current.version && claim[2] === current.build) continue;
                issues.push({
                    file,
                    line: index + 1,
                    message: `写的是 ${claim[1]}（构建号 ${claim[2]}），实际为 ${current.version}（构建号 ${current.build}）`
                });
            }
        }
    }
    return issues;
}

function checkVersionLists(versions) {
    const issues = [];
    for (const file of VERSION_DOCS) {
        const text = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
        const list = text.split('\n').find(item => VERSION_LIST.test(item)) || '';
        if (!list.includes(`workbench-${versions.mac.version}-review.md`)) {
            issues.push({ file, message: `工作台版本列表缺少当前版本 ${versions.mac.version}` });
        }
    }
    return issues;
}

function githubSlug(headingText) {
    return String(headingText || '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[`*_~]/g, '')
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s/g, '-');
}

function extractAnchors(markdownText) {
    const anchors = new Set();
    const slugCounts = new Map();
    let inFence = null;
    for (const rawLine of String(markdownText || '').split(/\r?\n/)) {
        const fence = rawLine.match(/^\s*(`{3,}|~{3,})/);
        if (fence) {
            if (!inFence) inFence = fence[1][0];
            else if (fence[1][0] === inFence) inFence = null;
            continue;
        }
        if (inFence) continue;
        for (const match of rawLine.matchAll(/<(?:a|h[1-6]|div|span|section)\b[^>]*\b(?:id|name)=["']([^"']+)["']/gi)) {
            anchors.add(match[1].trim().toLowerCase());
        }
        const heading = rawLine.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/);
        if (heading) {
            const base = githubSlug(heading[1]);
            if (!base) continue;
            const seen = slugCounts.get(base) || 0;
            slugCounts.set(base, seen + 1);
            anchors.add(seen === 0 ? base : `${base}-${seen}`);
        }
    }
    return anchors;
}

// 文档里的相对链接必须指向真实文件，带 #锚点 时同步校验目标 Markdown 的标题或 HTML id 锚点。
const LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function checkLinks(files, root = ROOT) {
    const issues = [];
    const anchorCache = new Map();
    const getAnchors = absPath => {
        if (!anchorCache.has(absPath)) {
            anchorCache.set(absPath, extractAnchors(fs.readFileSync(absPath, 'utf8')));
        }
        return anchorCache.get(absPath);
    };

    for (const file of files) {
        const absFile = path.resolve(root, file);
        const text = fs.readFileSync(absFile, 'utf8');
        let inFence = null;
        text.split('\n').forEach((line, index) => {
            const fence = line.match(/^\s*(`{3,}|~{3,})/);
            if (fence) {
                if (!inFence) inFence = fence[1][0];
                else if (fence[1][0] === inFence) inFence = null;
                return;
            }
            if (inFence) return;
            for (const match of line.matchAll(LINK)) {
                const raw = match[1].replace(/^<|>$/g, '');
                if (/^(https?:|mailto:|tel:|data:)/i.test(raw)) continue;
                const hashIdx = raw.indexOf('#');
                const targetWithQuery = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
                const fragment = hashIdx >= 0 ? raw.slice(hashIdx + 1) : '';
                const target = targetWithQuery.split('?')[0];
                const resolved = !target
                    ? absFile
                    : (target.startsWith('/') ? path.join(root, target) : path.resolve(root, path.dirname(file), target));
                if (!fs.existsSync(resolved)) {
                    issues.push({ file, line: index + 1, message: `链接目标不存在：${match[1]}` });
                    continue;
                }
                if (fragment && resolved.endsWith('.md') && fs.statSync(resolved).isFile()) {
                    let decoded = fragment;
                    try { decoded = decodeURIComponent(fragment); } catch (_) { /* keep raw */ }
                    const anchors = getAnchors(resolved);
                    if (!anchors.has(decoded.toLowerCase())) {
                        issues.push({ file, line: index + 1, message: `锚点不存在：${match[1]}` });
                    }
                }
            }
        });
    }
    return issues;
}

// docs/ 下每篇文章都必须在中文与英文两份索引（docs/README.md 与 docs/README.en.md）中分别登记。
function checkRegistration(root = ROOT) {
    const docsDir = path.join(root, 'docs');
    if (!fs.existsSync(docsDir)) return [];
    const indexFiles = ['docs/README.md', 'docs/README.en.md']
        .filter(name => fs.existsSync(path.join(root, name)))
        .map(name => ({ name, text: fs.readFileSync(path.join(root, name), 'utf8') }));
    const entries = [];
    const walk = (directory, prefix) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { walk(path.join(directory, entry.name), relative); continue; }
            if (entry.name.endsWith('.md')) entries.push(relative);
        }
    };
    walk(docsDir, '');
    const issues = [];
    for (const entry of entries) {
        if (entry === 'README.md' || entry === 'README.en.md') continue;
        for (const idx of indexFiles) {
            if (!idx.text.includes(entry)) {
                issues.push({ file: idx.name, message: `docs/${entry} 未在 ${idx.name} 中登记` });
            }
        }
    }
    return issues;
}

// 已废弃写法：带版本号后缀的协议名、旧工作区路径。
const FORBIDDEN = [
    { pattern: /协议[^\n]{0,12}?-[vV]\d+\b/, message: '协议名带 -vN 版本后缀，应改为稳定名称 + 结构指纹' },
    {
        pattern: /audio-paper-digest-rewrite-all/,
        message: '引用了已废弃的旧工作区，当前工作区是 audio-research-workbench',
        unless: /废弃|不再|旧工作区/
    }
];

function checkForbidden(files, root = ROOT) {
    const issues = [];
    for (const file of files) {
        const text = fs.readFileSync(path.resolve(root, file), 'utf8');
        text.split('\n').forEach((line, index) => {
            for (const rule of FORBIDDEN) {
                if (!rule.pattern.test(line)) continue;
                if (rule.unless && rule.unless.test(line)) continue;
                issues.push({ file, line: index + 1, message: rule.message });
            }
        });
    }
    return issues;
}

// 文档提到的 PD_* 环境变量必须真的被生产代码读取（不含 tests/，避免仅测试残留掩盖已删变量）；
// 仅面向人工测试验收的清单或明确说明 tests/ 命令的行允许引用 tests/ 中的真实样例夹具变量。
const ENV_NAME = /\bPD_[A-Z0-9_]+\b/g;
const ENV_DIRS = ['scripts', 'apps/macos', 'apps/android'];
const ENV_ROOT_FILES = ['run-daily-digest.sh'];
const ENV_EXCLUDED_FILES = new Set(['scripts/lib/env-schema.js']);
const ENV_EXCLUDED_TEST_PATH = /^apps\/[^/]+\/Tests(?:\/|$)/;
const TEST_ENV_DOC_ALLOWLIST = new Set(['docs/manual-acceptance-checklist.md']);
// 临时/内部或小写别名变量有意不在 env.example 示例中展示。
const ENV_EXAMPLE_OMIT_ALLOWLIST = new Set([
    'PD_ALLOW_EMPTY_DAILY',
    'https_proxy',
    'http_proxy'
]);

function collectEnvNamesFromDirs(root, dirs, options = {}) {
    const names = new Set();
    const excludeProdOnly = options.excludeSchemaAndClientTests !== false;
    const scanFile = target => {
        const rel = path.relative(root, target).split(path.sep).join('/');
        if (excludeProdOnly && (ENV_EXCLUDED_FILES.has(rel) || ENV_EXCLUDED_TEST_PATH.test(rel))) return;
        const text = fs.readFileSync(target, 'utf8');
        for (const match of text.matchAll(ENV_NAME)) names.add(match[0]);
        // scripts/publish-conference.py 动态拼接 f'PD_GIT_{kind}_TIMEOUT_SECONDS'（含 ARCHIVE）。
        if (/\bPD_GIT_\{kind\}_TIMEOUT_SECONDS\b/.test(text)) names.add('PD_GIT_ARCHIVE_TIMEOUT_SECONDS');
    };
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
            const target = path.join(directory, entry.name);
            const rel = path.relative(root, target).split(path.sep).join('/');
            if (entry.isDirectory()) {
                if (excludeProdOnly && ENV_EXCLUDED_TEST_PATH.test(rel)) continue;
                walk(target);
                continue;
            }
            if (!/\.(js|mjs|cjs|py|sh|ts|kt|swift)$/.test(entry.name)) continue;
            scanFile(target);
        }
    };
    for (const directory of dirs) {
        const target = path.join(root, directory);
        if (fs.existsSync(target)) {
            if (fs.statSync(target).isFile()) scanFile(target);
            else walk(target);
        }
    }
    return names;
}

function collectEnvNames(root = ROOT) {
    return collectEnvNamesFromDirs(root, [...ENV_DIRS, ...ENV_ROOT_FILES]);
}

function checkEnvNames(files, root = ROOT, known = collectEnvNames(root), testKnown = null) {
    const issues = [];
    let resolvedTestKnown = testKnown;
    const clientTestKnownCache = new Map();
    const getTestKnown = () => {
        if (resolvedTestKnown === null) {
            resolvedTestKnown = collectEnvNamesFromDirs(
                root,
                ['tests', 'apps/macos/Tests', 'apps/android/Tests'],
                { excludeSchemaAndClientTests: false }
            );
        }
        return resolvedTestKnown;
    };
    const getClientTestKnown = clientDir => {
        if (!clientTestKnownCache.has(clientDir)) {
            clientTestKnownCache.set(
                clientDir,
                collectEnvNamesFromDirs(
                    root,
                    [`${clientDir}/Tests`],
                    { excludeSchemaAndClientTests: false }
                )
            );
        }
        return clientTestKnownCache.get(clientDir);
    };
    for (const file of files) {
        const normalizedFile = String(file).split(path.sep).join('/');
        const isTestChecklist = TEST_ENV_DOC_ALLOWLIST.has(normalizedFile);
        const isClientReadme = /^apps\/[^/]+\/README(?:\.en)?\.md$/.test(normalizedFile);
        const clientDir = isClientReadme ? normalizedFile.replace(/\/README(?:\.en)?\.md$/, '') : null;
        const text = fs.readFileSync(path.resolve(root, file), 'utf8');
        text.split('\n').forEach((line, index) => {
            const allowTestVars = isTestChecklist
                || /\b(?:tests|apps\/[^/\s]+\/Tests)\/[A-Za-z0-9_./-]+\.(?:test\.)?(?:c?js|mjs|py|swift|kt)\b/.test(line)
                || (isClientReadme && /(?:测试|\btests?\b)/i.test(line));
            const scopedTestKnown = allowTestVars
                ? (isClientReadme ? getClientTestKnown(clientDir) : getTestKnown())
                : null;
            for (const match of line.matchAll(ENV_NAME)) {
                if (match[0].endsWith('_')) continue;
                if (known.has(match[0])) continue;
                if (scopedTestKnown && scopedTestKnown.has(match[0])) continue;
                issues.push({ file, line: index + 1, message: `环境变量 ${match[0]} 在生产代码里不存在` });
            }
        });
    }
    return issues;
}

// env.example 与 scripts/lib/env-schema.js 双向同步：
// 1. env.example 里展示的配置项必须在 env-schema.js 登记；
// 2. env-schema.js 里未废弃且非临时白名单的正式配置项必须在 env.example 展示。
function checkEnvExampleSync(root = ROOT, options = {}) {
    const examplePath = path.join(root, 'env.example');
    if (!fs.existsSync(examplePath)) return [];
    const { SCHEMA, KNOWN_NAMES } = require('./lib/env-schema.js');
    const schemaItems = Array.isArray(options.schema) ? options.schema : SCHEMA;
    const known = new Set(Array.isArray(options.schema) ? schemaItems.map(item => item.name) : KNOWN_NAMES);
    const issues = [];
    const shown = new Set();
    const lines = fs.readFileSync(examplePath, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
        const match = line.match(/^#?\s*([A-Z][A-Z0-9_]{2,})=/);
        if (!match) return;
        const key = match[1];
        shown.add(key);
        if (!known.has(key)) {
            issues.push({ file: 'env.example', line: index + 1, message: `env.example 中的 ${key} 未在 scripts/lib/env-schema.js 登记` });
        }
    });
    if (options.checkMissing !== false) {
        for (const item of schemaItems) {
            if (item.deprecated) continue;
            if (ENV_EXAMPLE_OMIT_ALLOWLIST.has(item.name)) continue;
            if (!shown.has(item.name)) {
                issues.push({
                    file: 'env.example',
                    message: `scripts/lib/env-schema.js 中的正式配置项 ${item.name} 未在 env.example 展示`
                });
            }
        }
    }
    return issues;
}

// AGENTS.md 须保持精炼（<= 20 KiB），避免被运行时提示词截断而丢失后半段规则。
function checkAgentsSize(root = ROOT, maxBytes = MAX_AGENTS_BYTES) {
    const agentsPath = path.join(root, 'AGENTS.md');
    if (!fs.existsSync(agentsPath)) return [];
    const size = fs.statSync(agentsPath).size;
    if (size > maxBytes) {
        return [{
            file: 'AGENTS.md',
            message: `AGENTS.md 体积为 ${size} bytes，超过上限 ${maxBytes} bytes（20 KiB）；请将低层细则归口到专项文档`
        }];
    }
    return [];
}

function main(argv = process.argv.slice(2)) {
    try { require('./env-loader').requireExternalRuntime('docs-consistency.js'); } catch (error) { console.error(`[docs-consistency] ${error.message}`); return 1; }

    const json = argv.includes('--json');
    const scripts = require('../package.json').scripts || {};
    const files = markdownFiles();
    const missing = checkDocs(files, scripts);
    const versions = readVersionSources();
    const versionIssues = checkVersionClaims(files, versions).concat(checkVersionLists(versions));
    const linkIssues = checkLinks(files);
    const registrationIssues = checkRegistration();
    const forbiddenIssues = checkForbidden(files);
    const envIssues = checkEnvNames(files);
    const envExampleIssues = checkEnvExampleSync();
    const agentsSizeIssues = checkAgentsSize();
    const total = missing.length + versionIssues.length + linkIssues.length
        + registrationIssues.length + forbiddenIssues.length + envIssues.length
        + envExampleIssues.length + agentsSizeIssues.length;
    if (json) {
        console.log(JSON.stringify({
            missing, versionIssues, linkIssues, registrationIssues,
            forbiddenIssues, envIssues, envExampleIssues, agentsSizeIssues
        }, null, 2));
    } else if (!total) {
        console.log('文档命令、版本、链接与锚点、双语索引、废弃写法、环境变量、env.example 同步与 AGENTS.md 体积检查通过。');
    } else {
        for (const item of missing) console.log(`❌ ${item.file} 引用了不存在的命令：npm run ${item.command}`);
        for (const item of versionIssues) console.log(`❌ ${item.file}${item.line ? `:${item.line}` : ''} ${item.message}`);
        for (const item of linkIssues) console.log(`❌ ${item.file}:${item.line} ${item.message}`);
        for (const item of registrationIssues) console.log(`❌ ${item.file} ${item.message}`);
        for (const item of forbiddenIssues) console.log(`❌ ${item.file}:${item.line} ${item.message}`);
        for (const item of envIssues) console.log(`❌ ${item.file}:${item.line} ${item.message}`);
        for (const item of envExampleIssues) console.log(`❌ ${item.file}:${item.line} ${item.message}`);
        for (const item of agentsSizeIssues) console.log(`❌ ${item.file} ${item.message}`);
    }
    return total ? 1 : 0;
}

module.exports = {
    MAX_AGENTS_BYTES,
    ROOT_DOCS,
    checkDocs, checkVersionClaims, checkVersionLists, main, markdownFiles, readVersionSources,
    githubSlug, extractAnchors,
    checkLinks, checkRegistration, checkForbidden, checkEnvNames, collectEnvNames,
    checkEnvExampleSync, checkAgentsSize
};

if (require.main === module) {
    try { process.exitCode = main(); } catch (error) { console.error(`[docs-consistency] ${error.message}`); process.exitCode = 2; }
}
