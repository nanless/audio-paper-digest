#!/usr/bin/env node
'use strict';

/**
 * Materialize one auditable, cold-start author packet for default Manual v5.
 *
 * The packet is a deny-by-default read allowlist.  It projects exactly one
 * filtered-paper metadata object and binds the current full text, complete
 * ArtifactIndex, repository prompt/editorial contract/blank schema, and an
 * optional official-project evidence file.  Historical prose paths are only
 * declared as forbidden policy strings: this module never opens them.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
if (require.main === module) require('./env-loader.js').requireExternalRuntime('manual-v5-author-packet.js');
const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const {
    AUTHORING_PROMPT_PATH,
    EDITORIAL_CONTRACT_PATH,
    BLANK_SCHEMA_PATH,
    resolveArtifactAuthority,
    stableSha256
} = require('./manual-fresh-authoring-contract.js');
const {
    buildManualPaperSourceIdentity
} = require('./manual-paper-source-identity.js');

const PACKET_VERSION = 1;
const PACKET_CONTRACT = 'manual-v5-author-packet-v1';
const AUTHOR_TASK_INPUT_CONTRACT = 'manual-v5-author-task-input-v2';
const METADATA_MODE = 'manual_v5_single_paper_metadata';
const REQUIRED_INPUT_KINDS = Object.freeze([
    'paper_metadata',
    'source_snapshot',
    'artifact_index',
    'authoring_prompt',
    'editorial_contract',
    'blank_schema'
]);
const OPTIONAL_INPUT_KINDS = Object.freeze(['official_project_evidence']);
const INPUT_AUTHORITIES = Object.freeze({
    paper_metadata: 'filtered_batch_projection',
    source_snapshot: 'manual_full_text_checkpoint',
    artifact_index: 'deterministic_artifact_parser',
    authoring_prompt: 'repository_file',
    editorial_contract: 'repository_file',
    blank_schema: 'repository_file',
    official_project_evidence: 'paper_bound_https_evidence'
});
const FORBIDDEN_INPUT_KINDS = Object.freeze([
    'canonical_analysis',
    'manual_record',
    'historical_analysis',
    'historical_reader_article',
    'historical_article',
    'historical_post',
    'blog_page',
    'filled_quality_packet',
    'historical_review_prose',
    'revision_prose'
]);
const SHA_RE = /^[a-f0-9]{64}$/;

function sha256Bytes(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function assertDate(value) {
    const date = String(value || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date 必须是 YYYY-MM-DD');
    return date;
}

function assertPaperId(value) {
    const paperId = normalizedId(value);
    if (!paperId) throw new Error('--paper 必须是合法 arXiv ID');
    return paperId;
}

function requestedArxivId(paper) {
    const parsed = [paper?.arxivId, paper?.paper_id, paper?.id]
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .map(raw => raw.match(/(?:arxiv:\s*|arxiv\.org\/(?:abs|pdf)\/)?(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/i)?.[1]?.toLowerCase())
        .filter(Boolean);
    if (!parsed.length || new Set(parsed.map(normalizedId)).size !== 1) {
        throw new Error('filtered paper 缺少唯一可验证的 arXiv ID');
    }
    const versioned = [...new Set(parsed.filter(value => /v\d+$/i.test(value)))];
    if (versioned.length > 1) throw new Error('filtered paper 包含冲突 arXiv 版本');
    return versioned[0] || parsed[0];
}

function expectedPaperInput(paper, filteredBatchSha256) {
    const requested = requestedArxivId(paper);
    const paperMetadataSha256 = stableSha256(paper);
    return {
        filteredBatchSha256,
        requestedArxivId: requested,
        paperMetadataSha256,
        paperInputSha256: stableSha256({
            filteredBatchSha256,
            paperMetadataSha256,
            requestedArxivId: requested
        })
    };
}

function isInside(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

function assertExistingDirectoryNoSymlink(directoryPath, label) {
    const declared = path.resolve(String(directoryPath || ''));
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的真实目录且不得为 symlink: ${declared}`);
    }
    // macOS exposes /var as /private/var.  Canonicalize that system alias and
    // enforce all child containment against the canonical root instead of
    // misclassifying the OS alias as an attacker-controlled parent symlink.
    return fs.realpathSync(declared);
}

function assertPlainFile(filePath, label, constraints = {}) {
    const declared = path.resolve(String(filePath || ''));
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`${label} 必须是存在的真实普通文件且不得为 symlink: ${declared}`);
    }
    const real = fs.realpathSync(declared);
    if (constraints.exact && real !== fs.realpathSync(path.resolve(constraints.exact))) {
        throw new Error(`${label} 未绑定当前固定权威路径`);
    }
    if (constraints.inside && !isInside(path.resolve(constraints.inside), real)) {
        throw new Error(`${label} 逃逸受控目录: ${real}`);
    }
    return real;
}

function readJsonPlain(filePath, label, constraints = {}) {
    const resolved = assertPlainFile(filePath, label, constraints);
    const bytes = fs.readFileSync(resolved);
    let value;
    try {
        value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    return { path: resolved, bytes, value };
}

function descriptorFromBytes(kind, filePath, bytes, projectRoot) {
    const resolved = path.resolve(filePath);
    const relativePath = path.relative(projectRoot, resolved);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)) {
        throw new Error(`${kind} 路径必须位于项目根内: ${resolved}`);
    }
    return {
        kind,
        authority: INPUT_AUTHORITIES[kind],
        path: resolved,
        projectRelativePath: relativePath.split(path.sep).join('/'),
        bytes: bytes.length,
        sha256: sha256Bytes(bytes)
    };
}

function descriptorFromFile(kind, filePath, projectRoot, constraints = {}) {
    const resolved = assertPlainFile(filePath, kind, constraints);
    return descriptorFromBytes(kind, resolved, fs.readFileSync(resolved), projectRoot);
}

function defaultAuthorPacketPaths(currentRoot, date, paperId, authorInputRoot) {
    const current = path.resolve(currentRoot);
    const base = path.resolve(authorInputRoot || (
        current === path.resolve(Config.CURRENT_DIR)
            ? Config.FILES.manualV5AuthorInputDir
            : path.join(current, 'manual-v5-author-inputs')
    ));
    const root = path.join(base, assertDate(date), assertPaperId(paperId));
    return {
        root,
        metadataPath: path.join(root, 'paper-metadata.json'),
        packetPath: path.join(root, 'packet.json')
    };
}

function metadataSnapshot(date, paperId, filteredBatchSha256, paper) {
    return {
        version: 1,
        mode: METADATA_MODE,
        date,
        paperId,
        filteredBatchSha256,
        paperMetadataSha256: stableSha256(paper),
        paper
    };
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function forbiddenPolicy(options) {
    const projectRoot = path.resolve(options.projectRoot);
    const currentDir = path.resolve(options.currentDir);
    const blogRepo = path.resolve(options.blogRepo || Config.PUBLISH_CONFIG.blogRepo);
    const date = options.date;
    const paperId = options.paperId;
    const tutorialDraftRoot = path.join(currentDir, 'manual-tutorial-previews', date, paperId, 'draft');
    return {
        contract: 'manual-v5-author-deny-policy-v1',
        defaultAccess: 'deny',
        rule: 'the author may read only allowedInputs; path renaming never changes kind or authority',
        forbiddenKinds: [...FORBIDDEN_INPUT_KINDS],
        forbiddenPaths: [
            { kind: 'canonical_analysis', path: path.join(currentDir, 'deep-analysis-result.json') },
            { kind: 'canonical_analysis', pattern: path.join(projectRoot, 'data', 'archive', '*', 'deep-analysis-result.json') },
            { kind: 'manual_record', pattern: path.join(currentDir, 'manual-analysis-record*.json') },
            { kind: 'historical_analysis', pattern: path.join(currentDir, '**', '*analysis*.json') },
            { kind: 'historical_reader_article', pattern: path.join(currentDir, '**', '*readerArticle*') },
            { kind: 'historical_article', path: path.join(tutorialDraftRoot, 'article.md'), access: 'write_only_target' },
            { kind: 'historical_post', pattern: path.join(currentDir, '**', 'post.md') },
            { kind: 'blog_page', pattern: path.join(blogRepo, 'content', 'posts', '*.md') },
            { kind: 'filled_quality_packet', path: path.join(tutorialDraftRoot, 'quality.json') },
            { kind: 'historical_review_prose', pattern: path.join(currentDir, '**', '*review*.json') }
        ]
    };
}

function normalizedInputForFingerprint(input) {
    return {
        kind: input.kind,
        authority: input.authority,
        projectRelativePath: input.projectRelativePath,
        bytes: input.bytes,
        sha256: input.sha256
    };
}

function buildAuthorTaskInputIdentity(options) {
    const allowedInputs = options.allowedInputs;
    if (!Array.isArray(allowedInputs)) throw new Error('allowedInputs 必须是数组');
    const expectedKinds = [
        ...REQUIRED_INPUT_KINDS,
        ...(options.hasOfficialProjectEvidence ? OPTIONAL_INPUT_KINDS : [])
    ];
    if (allowedInputs.length !== expectedKinds.length) throw new Error('author allowlist 数量不完整或含额外输入');
    const byKind = new Map();
    for (const input of allowedInputs) {
        if (!input || !expectedKinds.includes(input.kind) || byKind.has(input.kind)
            || input.authority !== INPUT_AUTHORITIES[input.kind]
            || !Number.isSafeInteger(input.bytes) || input.bytes < 0
            || !SHA_RE.test(String(input.sha256 || ''))
            || typeof input.projectRelativePath !== 'string' || !input.projectRelativePath) {
            throw new Error('author allowlist kind/authority/path/bytes/SHA 非法、重复或额外');
        }
        byKind.set(input.kind, input);
    }
    for (const kind of expectedKinds) {
        if (!byKind.has(kind)) throw new Error(`author allowlist 缺少 ${kind}`);
    }
    const identity = {
        contract: AUTHOR_TASK_INPUT_CONTRACT,
        date: options.date,
        paperId: options.paperId,
        filteredBatchSha256: options.filteredBatchSha256,
        paperMetadataSha256: options.paperMetadataSha256,
        paperInputSha256: options.paperInputSha256,
        sourceIdentitySha256: options.sourceIdentitySha256,
        paperSourceIdentitySha256: options.paperSourceIdentitySha256,
        allowedInputs: expectedKinds.map(kind => normalizedInputForFingerprint(byKind.get(kind))),
        forbiddenPolicySha256: stableSha256(options.forbidden)
    };
    for (const field of [
        'filteredBatchSha256', 'paperMetadataSha256', 'paperInputSha256',
        'sourceIdentitySha256', 'paperSourceIdentitySha256'
    ]) {
        if (!SHA_RE.test(String(identity[field] || ''))) throw new Error(`author input identity.${field} 非法`);
    }
    return { contract: AUTHOR_TASK_INPUT_CONTRACT, value: identity, sha256: stableSha256(identity) };
}

function buildAuthorPacket(options = {}) {
    const date = assertDate(options.date);
    const paperId = assertPaperId(options.paperId);
    const projectRoot = assertExistingDirectoryNoSymlink(
        options.projectRoot || Config.PROJECT_ROOT, 'projectRoot'
    );
    const declaredCurrentDir = path.resolve(options.currentDir || Config.CURRENT_DIR);
    const currentDir = assertExistingDirectoryNoSymlink(declaredCurrentDir, 'currentDir');
    if (!isInside(projectRoot, currentDir)) throw new Error('currentDir 必须位于 projectRoot 内');
    const filteredPath = options.filteredPath || Config.FILES.filteredPapers;
    const fulltextDir = path.join(currentDir, 'manual-full-text', date);
    const fulltextManifestPath = options.fulltextManifestPath || path.join(fulltextDir, 'manifest.json');
    const artifactManifestPath = options.artifactManifestPath || path.join(fulltextDir, 'artifacts', 'manifest.json');
    const promptPath = options.authoringPromptPath || AUTHORING_PROMPT_PATH;
    const contractPath = options.editorialContractPath || EDITORIAL_CONTRACT_PATH;
    const schemaPath = options.blankSchemaPath || BLANK_SCHEMA_PATH;
    const controlledPacketPaths = defaultAuthorPacketPaths(
        currentDir, date, paperId, options.authorInputRoot
    );
    const requestedPacketPaths = options.packetPaths || controlledPacketPaths;
    const canonicalizeOutputPath = value => {
        const declared = path.resolve(value);
        if (declared === declaredCurrentDir) return currentDir;
        if (isInside(declaredCurrentDir, declared)) {
            return path.join(currentDir, path.relative(declaredCurrentDir, declared));
        }
        return declared;
    };
    const packetPaths = {
        root: canonicalizeOutputPath(requestedPacketPaths.root),
        metadataPath: canonicalizeOutputPath(requestedPacketPaths.metadataPath),
        packetPath: canonicalizeOutputPath(requestedPacketPaths.packetPath)
    };
    for (const field of ['root', 'metadataPath', 'packetPath']) {
        if (packetPaths[field] !== controlledPacketPaths[field]) {
            throw new Error(`author packet ${field} 未绑定日期/论文受控单篇 input 目录`);
        }
    }
    if (!isInside(currentDir, path.resolve(packetPaths.root))) {
        throw new Error('author packet 输出目录必须位于 data/current 内');
    }

    const filteredFile = readJsonPlain(filteredPath, 'filtered-papers', { inside: currentDir });
    const filtered = filteredFile.value;
    if (filtered?.status !== 'complete' || filtered.batchDate !== date || !Array.isArray(filtered.papers)) {
        throw new Error(`filtered-papers 不是 ${date} complete 批次`);
    }
    const matches = filtered.papers.filter(item => normalizedId(item) === paperId);
    if (matches.length !== 1) throw new Error(`${paperId} 在 filtered 中必须且只能出现一次`);
    const paper = matches[0];
    const filteredBatchSha256 = stableSha256(filtered);
    const expectedInput = expectedPaperInput(paper, filteredBatchSha256);

    const fulltextManifestFile = readJsonPlain(fulltextManifestPath, 'manual fulltext manifest', { inside: fulltextDir });
    const fulltextManifest = fulltextManifestFile.value;
    const sourceEntry = fulltextManifest?.papers?.[paperId];
    if (fulltextManifest?.version !== 2 || fulltextManifest.mode !== 'manual_full_text_fetch'
        || fulltextManifest.date !== date || fulltextManifest.filteredBatchSha256 !== filteredBatchSha256
        || fulltextManifest.status !== 'complete' || !sourceEntry || sourceEntry.status !== 'complete') {
        throw new Error(`${paperId} fulltext manifest/entry 不是当前 complete 批次`);
    }
    for (const field of ['filteredBatchSha256', 'paperMetadataSha256', 'paperInputSha256', 'requestedArxivId']) {
        if (sourceEntry[field] !== expectedInput[field]) throw new Error(`${paperId} fulltext entry.${field} identity drift`);
    }
    const sourcePath = assertPlainFile(sourceEntry.path, 'source_snapshot', { inside: fulltextDir });
    const sourceInput = descriptorFromFile('source_snapshot', sourcePath, projectRoot, { inside: fulltextDir });
    if (sourceEntry.sourceSha256 !== sourceInput.sha256 || sourceEntry.bytes !== sourceInput.bytes) {
        throw new Error(`${paperId} fulltext bytes/SHA drift`);
    }

    const artifact = resolveArtifactAuthority(artifactManifestPath, {
        date,
        paperId,
        filteredBatchSha256,
        sourceSha256: sourceEntry.sourceSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        paperInputSha256: sourceEntry.paperInputSha256
    });
    const artifactInput = descriptorFromFile('artifact_index', artifact.path, projectRoot, {
        inside: path.join(fulltextDir, 'artifacts')
    });
    const paperSourceIdentity = buildManualPaperSourceIdentity({
        date, paperId, fullTextEntry: sourceEntry, artifactEntry: artifact.entry
    });

    const metadata = metadataSnapshot(date, paperId, filteredBatchSha256, paper);
    const metadataBytes = jsonBytes(metadata);
    const metadataInput = descriptorFromBytes(
        'paper_metadata', packetPaths.metadataPath, metadataBytes, projectRoot
    );
    const allowedInputs = [
        metadataInput,
        sourceInput,
        artifactInput,
        descriptorFromFile('authoring_prompt', promptPath, projectRoot, { exact: promptPath }),
        descriptorFromFile('editorial_contract', contractPath, projectRoot, { exact: contractPath }),
        descriptorFromFile('blank_schema', schemaPath, projectRoot, { exact: schemaPath })
    ];
    const officialPath = options.officialProjectEvidencePath || path.join(
        fulltextDir, 'external-evidence', `${paperId}-official-project.json`
    );
    const officialStat = fs.lstatSync(officialPath, { throwIfNoEntry: false });
    if (officialStat) {
        const official = readJsonPlain(officialPath, 'official_project_evidence', { inside: fulltextDir });
        if (normalizedId(official.value?.paperId) !== paperId
            || official.value?.kind !== 'official_project_evidence'
            || !/^https:\/\//i.test(String(official.value?.url || ''))) {
            throw new Error('official_project_evidence paperId/kind/HTTPS URL 非法');
        }
        allowedInputs.push(descriptorFromBytes(
            'official_project_evidence', official.path, official.bytes, projectRoot
        ));
    }
    const forbidden = forbiddenPolicy({
        projectRoot, currentDir, blogRepo: options.blogRepo, date, paperId
    });
    const inputIdentity = buildAuthorTaskInputIdentity({
        date,
        paperId,
        filteredBatchSha256,
        paperMetadataSha256: expectedInput.paperMetadataSha256,
        paperInputSha256: expectedInput.paperInputSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        paperSourceIdentitySha256: paperSourceIdentity.sha256,
        allowedInputs,
        hasOfficialProjectEvidence: Boolean(officialStat),
        forbidden
    });
    const packet = {
        version: PACKET_VERSION,
        contract: PACKET_CONTRACT,
        mode: 'fresh_from_evidence',
        date,
        paperId,
        singlePaperOnly: true,
        isolatedContext: true,
        requiredModel: 'gpt-5.6-terra',
        requiredReasoningEffort: 'high',
        inputContract: AUTHOR_TASK_INPUT_CONTRACT,
        inputSha256: inputIdentity.sha256,
        filteredBatchSha256,
        paperMetadataSha256: expectedInput.paperMetadataSha256,
        paperInputSha256: expectedInput.paperInputSha256,
        sourceIdentitySha256: sourceEntry.sourceIdentitySha256,
        paperSourceIdentity,
        sourceEntry,
        artifactEntry: artifact.entry,
        allowedInputs,
        forbidden,
        outputPolicy: {
            packetRoot: path.resolve(packetPaths.root),
            packetPath: path.resolve(packetPaths.packetPath),
            metadataPath: path.resolve(packetPaths.metadataPath),
            allowedDirectoryEntries: ['packet.json', 'paper-metadata.json'],
            writeOnlyTargets: [
                path.join(currentDir, 'manual-tutorial-previews', date, paperId, 'draft', 'article.md'),
                path.join(currentDir, 'manual-tutorial-previews', date, paperId, 'draft', 'quality.json'),
                path.join(currentDir, 'manual-tutorial-previews', date, paperId, 'draft', 'artifact-plan.json')
            ]
        }
    };
    packet.packetSha256 = stableSha256(packet);
    return { packet, metadata, metadataBytes, packetPaths, inputIdentity };
}

function assertExactPacketDirectory(packetPaths, create = false) {
    const root = path.resolve(packetPaths.root);
    const parent = path.dirname(root);
    if (create) fs.mkdirSync(parent, { recursive: true });
    const parentReal = assertExistingDirectoryNoSymlink(parent, 'author packet parent');
    if (!isInside(parentReal, root)) throw new Error('author packet root 逃逸单篇 parent');
    if (create && !fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { recursive: false });
    const realRoot = assertExistingDirectoryNoSymlink(root, 'author packet root');
    const entries = fs.readdirSync(realRoot).sort();
    const allowed = ['packet.json', 'paper-metadata.json'];
    const extra = entries.filter(name => !allowed.includes(name));
    if (extra.length) throw new Error(`author packet 目录含额外输入: ${extra.join(', ')}`);
    return realRoot;
}

function validateAuthorPacket(packet, options = {}) {
    if (!packet || packet.version !== PACKET_VERSION || packet.contract !== PACKET_CONTRACT) {
        throw new Error(`author packet 必须是 ${PACKET_CONTRACT} v${PACKET_VERSION}`);
    }
    const expected = buildAuthorPacket({ ...options, date: packet.date, paperId: packet.paperId });
    if (packet.inputSha256 !== expected.packet.inputSha256
        || packet.packetSha256 !== expected.packet.packetSha256
        || stableSha256(packet) !== stableSha256(expected.packet)) {
        throw new Error('author packet 与当前 exact allowlist/source/input identity 不一致');
    }
    if (options.requireMaterialized) {
        const root = assertExactPacketDirectory(expected.packetPaths, false);
        const metadataPath = assertPlainFile(expected.packetPaths.metadataPath, 'paper-metadata materialized', { inside: root });
        const packetPath = assertPlainFile(expected.packetPaths.packetPath, 'packet materialized', { inside: root });
        if (sha256Bytes(fs.readFileSync(metadataPath)) !== expected.packet.allowedInputs[0].sha256) {
            throw new Error('paper-metadata materialized bytes/SHA drift');
        }
        const materialized = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
        if (stableSha256(materialized) !== stableSha256(expected.packet)) {
            throw new Error('materialized packet bytes/object drift');
        }
    }
    return expected;
}

function materializeAuthorPacket(options = {}) {
    const built = buildAuthorPacket(options);
    assertExactPacketDirectory(built.packetPaths, true);
    writeFileAtomic(built.packetPaths.metadataPath, built.metadataBytes);
    writeFileAtomic(built.packetPaths.packetPath, `${JSON.stringify(built.packet, null, 2)}\n`);
    fs.chmodSync(built.packetPaths.metadataPath, 0o600);
    fs.chmodSync(built.packetPaths.packetPath, 0o600);
    validateAuthorPacket(built.packet, { ...options, requireMaterialized: true });
    return built;
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index];
        if (!['--date', '--paper'].includes(arg)) throw new Error(`未知参数: ${arg}`);
        const value = argv[++index];
        if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
        options[arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = value;
    }
    options.date = assertDate(options.date);
    options.paperId = assertPaperId(options.paper);
    delete options.paper;
    return options;
}

function run(argv = process.argv.slice(2), overrides = {}) {
    const args = parseArgs(argv);
    const built = materializeAuthorPacket({ ...overrides, ...args });
    console.log(JSON.stringify({
        version: PACKET_VERSION,
        contract: PACKET_CONTRACT,
        date: built.packet.date,
        paperId: built.packet.paperId,
        inputSha256: built.packet.inputSha256,
        packetSha256: built.packet.packetSha256,
        packetPath: built.packetPaths.packetPath,
        allowedInputKinds: built.packet.allowedInputs.map(item => item.kind),
        createdAt: getBeijingISOString()
    }, null, 2));
    return built;
}

if (require.main === module) {
    try {
        run();
    } catch (error) {
        console.error(`Manual v5 author packet 失败: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    PACKET_VERSION,
    PACKET_CONTRACT,
    AUTHOR_TASK_INPUT_CONTRACT,
    METADATA_MODE,
    REQUIRED_INPUT_KINDS,
    OPTIONAL_INPUT_KINDS,
    INPUT_AUTHORITIES,
    FORBIDDEN_INPUT_KINDS,
    parseArgs,
    defaultAuthorPacketPaths,
    metadataSnapshot,
    buildAuthorTaskInputIdentity,
    buildAuthorPacket,
    validateAuthorPacket,
    materializeAuthorPacket,
    run
};
