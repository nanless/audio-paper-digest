'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const fresh = require('./fresh-rewrite-run.js');
const dailyApi = require('./historical-daily-aggregate.js');
const pageApi = require('./historical-page-staging.js');
const { writeImmutableFile } = require('./immutable-file.js');

const PLAN_CONTRACT = 'historical-publication-plan-v2';
const LEGACY_PLAN_CONTRACT = 'historical-publication-plan-v1';
const PLAN_VERSION = 2;
const LEGACY_PRODUCER_CONTRACTS = ['historical-paper-page-staging-v1', 'historical-daily-aggregate-staging-v1'];
const PRODUCER_CONTRACTS = [...LEGACY_PRODUCER_CONTRACTS, 'historical-paper-page-staging-v2', 'historical-daily-aggregate-staging-v2'];
const GENERATION_CONTRACT = 'historical-publication-generation-v1';
const INTENT_CONTRACT = 'historical-publication-generation-intent-v1';
const VERSION = 1;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA_RE = /^[a-f0-9]{64}$/;
const PAGE_KEY_RE = /^page:[a-f0-9]{64}$/;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const stableHash = fresh.stableHash;
const clone = value => JSON.parse(JSON.stringify(value));
function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function fail(message) { const error = new Error(`历史发布检查未通过：${message}`); error.code = 'HISTORICAL_PUBLICATION_INTEGRITY'; throw error; }
function exactKeys(value, keys, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).sort().join('\0') !== keys.slice().sort().join('\0')) fail(`${label} 必须是对象，且字段集合必须符合要求。`);
}
function strictJson(bytes, label) {
    try { return dailyApi.strictJson(bytes, label); }
    catch (error) { fail(`${label} 不是符合读取要求的 JSON：${error.message}`); }
}
function safePath(value) {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\\')
        || path.posix.normalize(value) !== value || value.split('/').some(part => !part || part === '.' || part === '..')
        || !/^(?:content\/posts\/[A-Za-z0-9._/-]+\.md|static\/(?:images|data)\/papers\/[A-Za-z0-9._/-]+)$/.test(value)) fail(`发布路径不安全：必须是允许范围内的规范相对路径，不能含有越界或空目录项：${value}`);
    return value;
}
function directoryIdentity(directory) {
    // Node 可用 O_NOFOLLOW 拒绝末级符号链接，但没有可移植的逐级 openat(2) 接口。
    // 因此先检查父目录路径，再在文件读写前后比较父目录的设备号和 inode；
    // 检测到替换就拒绝继续。这不能发现特权进程在两次检查之间替换又恢复整条路径，
    // 该限制属于操作系统边界，不能据此声称本模块核验了这种变化。
    const absolute = fresh.assertSafeDirectory(directory); const stat = fs.lstatSync(absolute, { bigint: true });
    return { absolute, dev: stat.dev, ino: stat.ino };
}
function sameDirectory(left, right) { return left.absolute === right.absolute && left.dev === right.dev && left.ino === right.ino; }
function readRegular(filename, maximum = 128 * 1024 * 1024, dependencies = {}) {
    let fd; const parentBefore = directoryIdentity(path.dirname(filename));
    try { const before = fs.lstatSync(filename, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || (before.nlink !== 1n && !(dependencies.allowPendingLink && before.nlink === 2n)) || before.size > BigInt(maximum)) fail(`来源文件不安全：类型、链接数或大小不符合要求：${filename}`);
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); const opened = fs.fstatSync(fd, { bigint: true });
        if (!opened.isFile() || opened.nlink !== before.nlink || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > BigInt(maximum)) fail(`打开后来源文件不安全：类型、链接数、大小或身份不符合要求：${filename}`);
        dependencies.afterOpen?.(filename);
        const named = fs.lstatSync(filename, { bigint: true });
        if (!opened.isFile() || opened.nlink !== before.nlink || named.isSymbolicLink() || named.nlink !== before.nlink
            || opened.dev !== named.dev || opened.ino !== named.ino || opened.size !== named.size
            || opened.size > BigInt(maximum)) fail(`打开后来源文件不安全：类型、链接数、大小或身份不符合要求：${filename}`);
        const bytes = fs.readFileSync(fd);
        const after = fs.fstatSync(fd, { bigint: true }); const namedAfter = fs.lstatSync(filename, { bigint: true });
        if (BigInt(bytes.length) !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.nlink !== opened.nlink || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs
            || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino || namedAfter.nlink !== opened.nlink || namedAfter.size !== opened.size
            || namedAfter.mtimeNs !== opened.mtimeNs || namedAfter.ctimeNs !== opened.ctimeNs
            || !sameDirectory(parentBefore, directoryIdentity(path.dirname(filename)))) fail(`读取时文件的身份、大小、修改时间或父目录发生变化，或读取字节数与记录不一致：${filename}`);
        return { bytes, sha256: sha256(bytes) }; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeExact(filename, bytes) {
    const payload = Buffer.from(bytes);
    if (payload.length > 128 * 1024 * 1024) fail(`不可变发布文件超过大小限制：${filename}`);
    fresh.assertSafeDirectory(path.dirname(filename), true);
    writeImmutableFile(filename, payload, (message, details) => {
        if (details?.code === 'IMMUTABLE_FILE_CONTENT_CONFLICT') {
            const error = new Error(`历史发布检查未通过：${message}：${filename}`);
            error.code = details.code;
            throw error;
        }
        fail(`${message}：${filename}`);
    });
    const verified = readRegular(filename);
    if (!verified.bytes.equals(payload)) fail(`写入后的文件内容与待写入字节不一致：${filename}`);
    return verified.sha256;
}
const canonicalBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function sealed(body, field) { return { ...body, [field]: stableHash(body) }; }

function loadDailyAggregate({ aggregateRoot, aggregateRunId, date }) {
    if (!UUID_RE.test(aggregateRunId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) fail('每日汇总运行 ID 或日期格式无效。');
    const root = fresh.assertSafeDirectory(aggregateRoot); const runRoot = fresh.assertSafeDirectory(path.join(root, aggregateRunId));
    const filename = path.join(runRoot, `daily-${date}.json`); const loaded = readRegular(filename, 64 * 1024 * 1024);
    const value = strictJson(loaded.bytes, '每日汇总清单');
    const body = clone(value); delete body.manifestSha256;
    if (value.status !== 'complete'
        || value.date !== date || value.manifestSha256 !== stableHash(body)
        || !loaded.bytes.equals(canonicalBytes(value))
        || value.markdownSha256 !== sha256(Buffer.from(value.markdown || '', 'utf8'))
        || !Array.isArray(value.members) || !value.members.length
        || value.memberSetSha256 !== stableHash(value.members)
        || new Set(value.members.map(item => item.pageKey)).size !== value.members.length
        || new Set(value.members.map(item => item.pagePath)).size !== value.members.length
        || !SHA_RE.test(value.outputPage?.previousContentSha256 || '') || !safePath(value.outputPage?.path || '')) fail('每日汇总清单的状态、日期、原文件编码、页面成员或内容哈希不符合要求。');
    dailyApi.normalizeDailyAggregate(value);
    return { runRoot, filename, fileSha256: loaded.sha256, manifest: value };
}

function replayAnalysisSources(inputs, analysisRoot) {
    const contextApi = require('./fresh-analysis-context.js'); const byRun = new Map(); const proofs = [];
    for (const staged of inputs.stagedRuns) for (const page of staged.manifest.pages) {
        let loaded = byRun.get(page.analysisRunId);
        if (!loaded) { loaded = fresh.loadRun(page.analysisRunId, { rootDir: path.resolve(analysisRoot) }); byRun.set(page.analysisRunId, loaded); }
        const arxivId = page.paperId.slice('arxiv:'.length);
        const paper = loaded.analysis.papers.find(item => fresh.paperId(item) === arxivId);
        const authority = inputs.topology.state.assignments[page.pageKey]?.sourceAuthority;
        const expected = loaded.run.sourceExpectations?.[arxivId]; const baseline = loaded.run.baseline;
        if (!paper || !authority || loaded.run.status !== 'complete' || loaded.analysis.status !== 'complete'
            || loaded.run.baseline?.contract !== 'historical-arxiv-authority-baseline-v1'
            || loaded.run.analysisSha256 !== page.analysisFileSha256
            || baseline?.paperId !== page.paperId || authority.paperId !== page.paperId
            || baseline.authorityName !== authority.authorityName
            || baseline.authorityFileSha256 !== authority.authorityFileSha256
            || baseline.authoritySha256 !== authority.authoritySha256
            || baseline.authoritySourceSnapshotSha256 !== authority.sourceSnapshotSha256
            || baseline.fulltextSha256 !== authority.fulltextSha256
            || expected?.authorityFileSha256 !== authority.authorityFileSha256
            || expected?.authoritySha256 !== authority.authoritySha256
            || expected?.authoritySourceSnapshotSha256 !== authority.sourceSnapshotSha256
            || expected?.sourceSha256 !== baseline.fulltextSha256) {
            fail(`论文 ${page.paperId} 的已保存分析来源与已核验的页面来源对应记录不一致。`);
        }
        const details = contextApi.readFreshSource(loaded.runDir, paper, loaded.run);
        if (!details || sha256(Buffer.from(details.text, 'utf8')) !== expected.sourceSha256
            || details.structuredArtifacts?.payloadSha256 !== expected.structuredArtifactsSha256) {
            fail(`无法根据论文 ${page.paperId} 的已保存分析来源重建对应记录。`);
        }
        proofs.push({ paperId: page.paperId, pageKey: page.pageKey, analysisRunId: page.analysisRunId,
            analysisFileSha256: page.analysisFileSha256, authorityName: authority.authorityName,
            authorityFileSha256: authority.authorityFileSha256, authoritySha256: authority.authoritySha256,
            sourceSnapshotSha256: authority.sourceSnapshotSha256, fulltextSha256: authority.fulltextSha256,
            sourceSha256: expected.sourceSha256, structuredArtifactsSha256: expected.structuredArtifactsSha256 });
    }
    return proofs.sort((a, b) => a.pageKey.localeCompare(b.pageKey));
}

function producerContractsFor(replay) {
    if (!Array.isArray(replay.staged) || !Array.isArray(replay.aggregates)) fail('发布重放缺少实际页面或每日汇总记录。');
    const contracts = [];
    for (const item of replay.staged) {
        const manifest = item.manifest;
        if (!manifest || !((manifest.contract === 'historical-paper-page-staging-v1' && manifest.version === 1)
            || (manifest.contract === 'historical-paper-page-staging-v2' && manifest.version === 2))) {
            fail('发布所用页面清单的格式版本无效。');
        }
        for (const page of manifest.pages || []) pageApi.tagAssignmentProofFor(manifest, page);
        contracts.push(manifest.contract);
    }
    for (const item of replay.aggregates) {
        dailyApi.normalizeDailyAggregate(item.manifest);
        contracts.push(item.manifest.contract);
    }
    return [...new Set(contracts)].sort();
}
function assertPlanProducerContracts(plan, replay) {
    const actual = producerContractsFor(replay);
    const expected = plan.contract === LEGACY_PLAN_CONTRACT ? LEGACY_PRODUCER_CONTRACTS.slice().sort() : plan.producerContracts;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('发布计划声明的生产格式与实际已核验的页面和每日汇总不一致。');
}

function producerProofFor(inputs, staged, aggregates, analysisSources, savedPlan) {
    const legacy = savedPlan?.contract === LEGACY_PLAN_CONTRACT;
    const pageStagingRuns = staged.map(item => ({ stagingRunId: item.manifest.stagingRunId,
        manifestSha256: item.manifest.manifestSha256, manifestFileSha256: item.manifestFileSha256,
        rendererImplementationSha256: item.manifest.rendererImplementationSha256,
        crosswalkId: item.manifest.crosswalkId, selectedBindingSha256: item.manifest.selectedBindingSha256,
        pageSetSha256: item.manifest.pageSetSha256, assetSetSha256: item.manifest.assetSetSha256,
        analysisBindingsSha256: stableHash(item.manifest.pages.map(page => {
            const tagProof = pageApi.tagAssignmentProofFor(item.manifest, page);
            return { paperId: page.paperId, pageKey: page.pageKey,
                analysisRunId: page.analysisRunId, analysisFileSha256: page.analysisFileSha256,
                ...(legacy ? { taxonomyAssignmentSha256: tagProof.assignmentSha256,
                    taxonomyFileSha256: tagProof.fileSha256 }
                    : { tagAssignmentSha256: tagProof.assignmentSha256,
                        tagAssignmentFileSha256: tagProof.fileSha256 }) };
        }).sort((a, b) => a.pageKey.localeCompare(b.pageKey)))
    })).sort((a, b) => a.stagingRunId.localeCompare(b.stagingRunId));
    const dailyRuns = aggregates.map(item => ({ aggregateRunId: path.basename(item.runRoot), date: item.manifest.date,
        manifestSha256: item.manifest.manifestSha256, manifestFileSha256: item.fileSha256,
        stagingSetSha256: item.manifest.source.stagingSetSha256,
        rendererImplementationSha256: item.manifest.source.rendererImplementationSha256,
        memberSetSha256: item.manifest.memberSetSha256, markdownSha256: item.manifest.markdownSha256
    })).sort((a, b) => `${a.date}\0${a.aggregateRunId}`.localeCompare(`${b.date}\0${b.aggregateRunId}`));
    const proof = { crosswalkId: inputs.topology.state.crosswalkId,
        crosswalkStateSha256: inputs.topology.state.stateSha256,
        identityGroupsSha256: inputs.topology.state.identityGroupsSha256,
        inventoryLedgerSha256: inputs.topology.inventory.ledger.ledgerSha256,
        inventoryPageSetSha256: inputs.topology.inventory.ledger.pageSetSha256,
        inventorySourceSha256: stableHash(inputs.topology.inventory.ledger.source),
        inventoryHugoConfig: clone(inputs.topology.inventory.ledger.source.hugoConfig),
        inventoryHead: inputs.topology.inventory.ledger.source.head,
        inventoryContentTreeOid: inputs.topology.inventory.ledger.source.contentTreeOid,
        inventoryRemoteName: inputs.topology.inventory.ledger.source.remoteName,
        inventoryRemoteIdentitySha256: inputs.topology.inventory.ledger.source.remoteIdentitySha256,
        inventoryRemoteMain: clone(inputs.topology.inventory.ledger.source.remoteMain),
        rendererImplementationSha256: inputs.rendererImplementationSha256,
        pageStagingRuns, pageStagingSetSha256: stableHash(pageStagingRuns),
        dailyRuns, dailyRunSetSha256: stableHash(dailyRuns), analysisSources,
        analysisSourceSetSha256: stableHash(analysisSources) };
    return { ...proof, proofSha256: stableHash(proof) };
}

function replayProducerSet(options = {}, dependencies = {}) {
    return replayProducerSetForPlan(options, dependencies);
}

// 只有已读取并核验的原发布计划可以选择旧证明字段；普通重放生成新版证明。
function replayProducerSetForPlan({ pageStagingRunIds, dailyAggregates, stagingRoot, aggregateRoot,
    crosswalkRoot, inventoryRoot, analysisRoot, tagAssignmentRoot, tagCatalogPath } = {}, dependencies = {}, savedPlan) {
    if (savedPlan) validatePlan(savedPlan, savedPlan.planId);
    const expectedRunId = dailyApi.aggregateRunIdFor(pageStagingRunIds);
    if (dailyAggregates.some(ref => ref.aggregateRunId !== expectedRunId)) {
        fail(`每日汇总运行 ID 必须与页面暂存集合计算出的 ID 一致：${expectedRunId}`);
    }
    const inputs = (dependencies.loadAggregateInputs || dailyApi.loadAggregateInputs)({ stagingRunIds: pageStagingRunIds,
        stagingRoot, crosswalkRoot, inventoryRoot, analysisRoot, tagAssignmentRoot, tagCatalogPath },
    dependencies.aggregateInputDependencies || {});
    const actualRunIds = inputs.stagedRuns.map(item => item.manifest.stagingRunId).sort();
    if (stableHash(actualRunIds) !== stableHash(pageStagingRunIds.slice().sort())) fail('重放得到的页面暂存运行集合与发布请求不一致。');
    const analysisSources = (dependencies.replayAnalysisSources || replayAnalysisSources)(inputs, analysisRoot);
    const aggregates = dailyAggregates.slice().sort((a, b) => `${a.date}\0${a.aggregateRunId}`.localeCompare(`${b.date}\0${b.aggregateRunId}`)).map(ref => {
        const loaded = (dependencies.loadDailyAggregate || loadDailyAggregate)({ aggregateRoot, ...ref });
        const rebuilt = (dependencies.replayDailyAggregate || dailyApi.replayDailyAggregate)({ inputs, originalAggregate: loaded.manifest });
        if (stableHash(rebuilt) !== stableHash(loaded.manifest)) {
            fail(`日期 ${ref.date} 的每日汇总与其页面暂存、来源对应、分析及标签输入重新生成的结果不一致。`);
        }
        const expectedStaging = inputs.stagedRuns.map(item => ({ stagingRunId: item.manifest.stagingRunId,
            stagingManifestSha256: item.manifest.manifestSha256,
            stagingManifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.stagingRunId.localeCompare(b.stagingRunId));
        if (stableHash(loaded.manifest.source.stagingRuns) !== stableHash(expectedStaging)
            || loaded.manifest.source.stagingSetSha256 !== stableHash(expectedStaging)
            || loaded.manifest.source.rendererImplementationSha256 !== inputs.rendererImplementationSha256) {
            fail(`日期 ${ref.date} 的每日汇总所绑定的页面暂存记录或实现指纹不一致。`);
        }
        return loaded;
    });
    return { staged: inputs.stagedRuns, aggregates, inputs,
        proof: producerProofFor(inputs, inputs.stagedRuns, aggregates, analysisSources, savedPlan) };
}

function artifact(pathname, bytesSha256, baselineSha256, source, producer, metadata = {}) {
    safePath(pathname);
    if (!SHA_RE.test(bytesSha256 || '') || baselineSha256 !== null && !SHA_RE.test(baselineSha256 || '')) fail('待发布文件的新内容哈希或原基线哈希格式无效。');
    return { path: pathname, newSha256: bytesSha256, expectedBaselineSha256: baselineSha256,
        source, producer, ...metadata };
}
function batchesFor(artifacts, dates) {
    const pages = artifacts.filter(item => item.source.kind === 'page-staging-file' && item.path.startsWith('content/posts/'));
    const batches = dates.map((date, index) => {
        const paths = artifacts.filter(item => item.cohortDate === date
            || !item.cohortDate && (item.path.startsWith(`static/data/papers/${date}/`)
                || index === dates.findIndex(candidate => pages.some(page => page.cohortDate === candidate))))
            .map(item => item.path).sort();
        return { batchId: `daily-${date}`, kind: 'daily-cohort', date, paths,
            predecessorBatchIds: index ? [`daily-${dates[index - 1]}`] : [], pathSetSha256: stableHash(paths) };
    });
    const assigned = new Set(batches.flatMap(batch => batch.paths));
    for (const item of artifacts) if (!assigned.has(item.path)) batches[0].paths.push(item.path);
    batches[0].paths.sort(); batches[0].pathSetSha256 = stableHash(batches[0].paths);
    return batches;
}

function buildPlan({ planId, pageStagingRunIds, dailyAggregates, conferenceRefs = [], blogRepo,
    remoteName = 'origin', stagingRoot, aggregateRoot, crosswalkRoot, inventoryRoot, analysisRoot,
    tagAssignmentRoot, tagCatalogPath } = {}, dependencies = {}) {
    if (!UUID_RE.test(planId || '') || !Array.isArray(pageStagingRunIds) || !pageStagingRunIds.length
        || new Set(pageStagingRunIds).size !== pageStagingRunIds.length || pageStagingRunIds.some(id => !UUID_RE.test(id))
        || !Array.isArray(dailyAggregates) || !dailyAggregates.length
        || dailyAggregates.some(ref => !UUID_RE.test(ref?.aggregateRunId || '') || !validDate(ref?.date))
        || new Set(dailyAggregates.map(ref => ref.date)).size !== dailyAggregates.length) fail('发布计划 ID 必须有效，页面运行及每日汇总引用必须非空、有效且不能重复。');
    if (!Array.isArray(conferenceRefs) || conferenceRefs.length) fail('暂不支持在此发布计划中引用会议汇总；会议引用必须为空。');
    const replay = (dependencies.replayProducerSet || replayProducerSet)({ pageStagingRunIds, dailyAggregates,
        stagingRoot, aggregateRoot, crosswalkRoot, inventoryRoot, analysisRoot, tagAssignmentRoot, tagCatalogPath }, dependencies);
    if (!replay?.proof) fail('缺少重新核验页面与汇总所得到的生产证明。');
    validateProducerReplay(replay.proof);
    const staged = replay.staged;
    const aggregates = replay.aggregates;
    const producers = []; const byPath = new Map(); const pageByPath = new Map();
    const absorb = record => {
        const prior = byPath.get(record.path);
        if (prior) fail(`同一发布路径被多个生成记录占用：${record.path}`);
        byPath.set(record.path, record);
    };
    for (const item of staged) {
        const manifest = item.manifest; const producer = { kind: 'page-staging', runId: manifest.stagingRunId,
            manifestSha256: manifest.manifestSha256, manifestFileSha256: item.manifestFileSha256 };
        producers.push(producer);
        for (const page of manifest.pages) {
            const record = artifact(page.pagePath, page.contentSha256, page.sourcePageContentSha256,
                { kind: 'page-staging-file', runId: manifest.stagingRunId, relativePath: page.stagedPath }, producer,
                { cohortDate: page.cohortDate, paperId: page.paperId, pageKey: page.pageKey });
            absorb(record); pageByPath.set(record.path, record);
        }
        for (const asset of manifest.assets) absorb(artifact(asset.path, asset.sha256, null,
            { kind: 'page-staging-file', runId: manifest.stagingRunId, relativePath: path.posix.join('assets', asset.path) }, producer));
    }
    const aggregateDates = new Set();
    for (const item of aggregates) {
        const value = item.manifest; if (aggregateDates.has(value.date)) fail(`每日汇总的日期重复：${value.date}`); aggregateDates.add(value.date);
        const producer = { kind: 'daily-aggregate', runId: path.basename(item.runRoot), date: value.date,
            manifestSha256: value.manifestSha256, manifestFileSha256: item.fileSha256 };
        producers.push(producer); absorb(artifact(value.outputPage.path, value.markdownSha256,
            value.outputPage.previousContentSha256, { kind: 'daily-aggregate-markdown', runId: producer.runId, date: value.date }, producer,
            { cohortDate: value.date, pageKey: value.outputPage.pageKey, aggregate: true }));
        const memberPaths = new Set(value.members.map(member => member.pagePath));
        const actual = [...pageByPath.values()].filter(page => page.cohortDate === value.date).map(page => page.path);
        if (actual.length !== memberPaths.size || actual.some(page => !memberPaths.has(page))) fail(`日期 ${value.date} 的每日汇总成员与该日期的全部暂存论文页不完全一致。`);
        for (const member of value.members) {
            const page = pageByPath.get(member.pagePath);
            if (!page || page.newSha256 !== member.singlePageContentSha256) fail(`日期 ${value.date} 的每日汇总成员所记录的论文页哈希与待发布页面不一致。`);
        }
    }
    if ([...pageByPath.values()].some(page => !aggregateDates.has(page.cohortDate))) fail('每篇待发布的日更论文页都必须对应同日期的每日汇总。');
    const artifacts = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    const dates = [...aggregateDates].sort(); const batches = batchesFor(artifacts, dates);
    if (new Set(artifacts.map(item => item.path)).size !== artifacts.length) fail('每个发布路径必须且只能由一个生成记录提供。');
    const before = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), '制定发布计划前的博客状态');
    if (replay.proof.inventoryHugoConfig && stableHash(replay.proof.inventoryHugoConfig) !== stableHash(before.hugoConfig)) {
        fail('当前 Hugo 配置文件或内容哈希与页面盘点时的基线不一致。');
    }
    if (replay.proof.inventoryHead !== before.head || replay.proof.inventoryContentTreeOid !== before.contentTreeOid
        || replay.proof.inventoryRemoteName !== before.remoteName
        || replay.proof.inventoryRemoteIdentitySha256 !== before.remoteIdentitySha256
        || replay.proof.inventoryRemoteMain.availability !== 'available'
        || replay.proof.inventoryRemoteMain.oid !== before.remoteOid) fail('当前博客提交、内容树、远端身份或远端提交与页面盘点时的基线不一致。');
    for (const item of artifacts) {
        const baseline = (dependencies.gitBlob || defaultGitBlob)(blogRepo, before.head, item.path);
        const baselineSha256 = baseline === null ? null : sha256(baseline); const target = blogTarget(blogRepo, item.path);
        const worktreeSha256 = fs.existsSync(target) ? readRegular(target).sha256 : null;
        if (worktreeSha256 !== baselineSha256) fail(`制定发布计划时，工作区文件与基线提交中的内容不一致：${item.path}`);
        if (item.expectedBaselineSha256 === null) {
            if (baselineSha256 !== null && baselineSha256 !== item.newSha256) fail(`待新建的资源文件已存在，且内容与本次生成结果不同：${item.path}`);
        } else if (baselineSha256 !== item.expectedBaselineSha256) fail(`基线提交中的文件内容与页面盘点记录的哈希不一致：${item.path}`);
        item.baselineSha256 = baselineSha256;
        item.plannedOperation = baselineSha256 === null ? 'create' : baselineSha256 === item.newSha256 ? 'unchanged' : 'replace';
    }
    const after = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), '制定发布计划后的博客状态');
    if (stableHash(after) !== stableHash(before)) fail('制定发布计划期间，博客仓库的状态发生变化。');
    const body = { contract: PLAN_CONTRACT, version: PLAN_VERSION, planId, createdAt: dependencies.now?.() || new Date().toISOString(),
        oldGeneratedTextIncluded: false, producerContracts: producerContractsFor(replay),
        conferenceRefs: [], producers: producers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        producerReplay: replay.proof, producerReplaySha256: replay.proof.proofSha256,
        blogBaseline: before, blogBaselineSha256: stableHash(before),
        artifacts, artifactSetSha256: stableHash(artifacts), batches, batchSetSha256: stableHash(batches) };
    return sealed(body, 'planSha256');
}

function outputDirectory(outputRoot, planId, create = false) {
    if (!UUID_RE.test(planId || '')) fail('发布计划 ID 必须是有效的 UUID。');
    const root = fresh.assertSafeDirectory(outputRoot, create); const target = path.resolve(root, planId);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) fail('发布计划目录超出指定的根目录。');
    return fresh.assertSafeDirectory(target, create);
}
function comparablePlan(plan) { const value = clone(plan); delete value.createdAt; delete value.planSha256; return value; }
function writePlan({ outputRoot, plan }) {
    validatePlan(plan, plan?.planId); const dir = outputDirectory(outputRoot, plan.planId, true); const filename = path.join(dir, 'plan.json');
    const reuse = () => { const existing = loadPlanForWrite({ outputRoot, planId: plan.planId });
        if (stableHash(comparablePlan(existing.plan)) !== stableHash(comparablePlan(plan))) fail('同一发布计划 ID 已对应其他发布输入，不能覆盖。');
        writeExact(filename, existing.bytes);
        return { dir, plan: existing.plan, reused: true }; };
    if (fs.existsSync(filename)) return reuse();
    if (plan.contract !== PLAN_CONTRACT || plan.version !== PLAN_VERSION) fail('新写入的发布计划必须使用当前格式。');
    try { writeExact(filename, canonicalBytes(plan)); }
    catch (error) { if (error.code === 'IMMUTABLE_FILE_CONTENT_CONFLICT') return reuse(); throw error; }
    return { dir, plan, reused: false };
}
function validateProducer(producer, label) {
    if (producer?.kind === 'page-staging') {
        exactKeys(producer, ['kind', 'runId', 'manifestSha256', 'manifestFileSha256'], label);
        if (!UUID_RE.test(producer.runId || '') || !SHA_RE.test(producer.manifestSha256 || '')
            || !SHA_RE.test(producer.manifestFileSha256 || '')) fail(`${label} 的运行标识或内容哈希格式无效。`);
        return;
    }
    if (producer?.kind === 'daily-aggregate') {
        exactKeys(producer, ['kind', 'runId', 'date', 'manifestSha256', 'manifestFileSha256'], label);
        if (!UUID_RE.test(producer.runId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(producer.date || '')
            || !SHA_RE.test(producer.manifestSha256 || '') || !SHA_RE.test(producer.manifestFileSha256 || '')) fail(`${label} 的运行标识、日期或内容哈希格式无效。`);
        return;
    }
    fail(`${label} 的生成记录类型不受支持。`);
}
function validateArtifact(item, index) {
    const label = `artifacts[${index}]`; safePath(item?.path);
    if (!SHA_RE.test(item?.newSha256 || '') || item.expectedBaselineSha256 !== null
        && !SHA_RE.test(item.expectedBaselineSha256 || '') || item.oldGeneratedTextIncluded !== undefined) fail(`${label} 的内容哈希、基线哈希或字段格式无效。`);
    validateProducer(item.producer, `${label}.producer`);
    if (item.source?.kind === 'page-staging-file') {
        const optional = item.path.startsWith('content/posts/')
            ? ['cohortDate', 'paperId', 'pageKey'] : [];
        exactKeys(item, ['path', 'newSha256', 'expectedBaselineSha256', 'baselineSha256', 'plannedOperation',
            'source', 'producer', ...optional], label);
        exactKeys(item.source, ['kind', 'runId', 'relativePath'], `${label}.source`);
        const expectedRelative = `${item.path.startsWith('content/posts/') ? 'pages' : 'assets'}/${item.path}`;
        if (!UUID_RE.test(item.source.runId || '') || item.source.relativePath !== expectedRelative
            || item.producer.kind !== 'page-staging' || item.producer.runId !== item.source.runId) fail(`${label} 的来源类型、运行标识、相对路径或生成记录对应关系不符合要求。`);
        if (optional.length && (!validDate(item.cohortDate) || !/^arxiv:\d{4}\.\d{4,5}$/.test(item.paperId || '')
            || !PAGE_KEY_RE.test(item.pageKey || ''))) fail(`${label} 的日期、论文标识或页面标识格式无效。`);
        if (optional.length && item.expectedBaselineSha256 === null || !optional.length && item.expectedBaselineSha256 !== null) fail(`${label} 是否应有原文件基线的记录与文件类型不一致。`);
        if (item.baselineSha256 !== null && !SHA_RE.test(item.baselineSha256 || '')
            || !['create', 'replace', 'unchanged'].includes(item.plannedOperation)
            || item.plannedOperation !== (item.baselineSha256 === null ? 'create' : item.baselineSha256 === item.newSha256 ? 'unchanged' : 'replace')
            || !optional.length && item.baselineSha256 !== null && item.baselineSha256 !== item.newSha256) fail(`${label} 的原文件哈希、计划操作或新旧内容对应关系不符合要求。`);
        return;
    }
    if (item.source?.kind === 'daily-aggregate-markdown') {
        exactKeys(item, ['path', 'newSha256', 'expectedBaselineSha256', 'baselineSha256', 'plannedOperation', 'source', 'producer',
            'cohortDate', 'pageKey', 'aggregate'], label);
        exactKeys(item.source, ['kind', 'runId', 'date'], `${label}.source`);
        if (!UUID_RE.test(item.source.runId || '') || !validDate(item.source.date)
            || item.producer.kind !== 'daily-aggregate' || item.producer.runId !== item.source.runId
            || item.producer.date !== item.source.date || item.cohortDate !== item.source.date || item.aggregate !== true
            || !PAGE_KEY_RE.test(item.pageKey || '') || item.expectedBaselineSha256 === null
            || !SHA_RE.test(item.baselineSha256 || '') || item.baselineSha256 !== item.expectedBaselineSha256
            || item.plannedOperation !== (item.baselineSha256 === item.newSha256 ? 'unchanged' : 'replace')) fail(`${label} 的每日汇总来源、日期、基线哈希或计划操作不符合要求。`);
        return;
    }
    fail(`${label} 的文件来源类型不受支持。`);
}
function validateProducerReplay(proof) {
    exactKeys(proof, ['crosswalkId', 'crosswalkStateSha256', 'identityGroupsSha256', 'inventoryLedgerSha256',
        'inventoryPageSetSha256', 'inventorySourceSha256', 'inventoryHugoConfig', 'inventoryHead',
        'inventoryContentTreeOid', 'inventoryRemoteName', 'inventoryRemoteIdentitySha256', 'inventoryRemoteMain',
        'rendererImplementationSha256', 'pageStagingRuns', 'pageStagingSetSha256', 'dailyRuns',
        'dailyRunSetSha256', 'analysisSources', 'analysisSourceSetSha256', 'proofSha256'], '生产重放证明');
    exactKeys(proof.inventoryHugoConfig, ['path', 'sha256'], '生产重放证明中的 Hugo 配置');
    exactKeys(proof.inventoryRemoteMain, ['availability', 'oid', 'ref'], '生产重放证明中的远端 main 记录');
    for (const field of ['crosswalkStateSha256', 'identityGroupsSha256', 'inventoryLedgerSha256', 'inventoryPageSetSha256',
        'inventorySourceSha256', 'inventoryRemoteIdentitySha256', 'pageStagingSetSha256', 'dailyRunSetSha256',
        'analysisSourceSetSha256', 'rendererImplementationSha256', 'proofSha256']) if (!SHA_RE.test(proof[field] || '')) fail(`生产重放证明中的 ${field} 不是有效的内容哈希。`);
    if (!UUID_RE.test(proof.crosswalkId || '') || !/^[a-f0-9]{40,64}$/.test(proof.inventoryHead || '')
        || !/^[a-f0-9]{40,64}$/.test(proof.inventoryContentTreeOid || '')
        || proof.inventoryContentTreeOid.length !== proof.inventoryHead.length
        || typeof proof.inventoryRemoteName !== 'string' || !proof.inventoryRemoteName
        || proof.inventoryRemoteMain.availability !== 'available'
        || !/^[a-f0-9]{40,64}$/.test(proof.inventoryRemoteMain.oid || '')
        || proof.inventoryRemoteMain.oid.length !== proof.inventoryHead.length
        || proof.inventoryRemoteMain.ref !== `refs/remotes/${proof.inventoryRemoteName}/main`
        || !['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].includes(proof.inventoryHugoConfig.path)
        || !SHA_RE.test(proof.inventoryHugoConfig.sha256 || '') || !Array.isArray(proof.pageStagingRuns)
        || !proof.pageStagingRuns.length || !Array.isArray(proof.dailyRuns) || !proof.dailyRuns.length
        || !Array.isArray(proof.analysisSources) || !proof.analysisSources.length) fail('生产重放证明的来源身份、博客基线或页面、汇总及分析集合格式不符合要求。');
    proof.pageStagingRuns.forEach((item, index) => {
        exactKeys(item, ['stagingRunId', 'manifestSha256', 'manifestFileSha256', 'crosswalkId',
            'rendererImplementationSha256', 'selectedBindingSha256', 'pageSetSha256', 'assetSetSha256',
            'analysisBindingsSha256'], `生产重放证明中的页面暂存项 staging[${index}]`);
        if (!UUID_RE.test(item.stagingRunId || '') || item.crosswalkId !== proof.crosswalkId
            || Object.entries(item).filter(([key]) => key.endsWith('Sha256')).some(([, value]) => !SHA_RE.test(value || ''))) fail(`生产重放证明的页面暂存项 staging[${index}] 的标识或内容哈希无效。`);
    });
    proof.dailyRuns.forEach((item, index) => {
        exactKeys(item, ['aggregateRunId', 'date', 'manifestSha256', 'manifestFileSha256', 'stagingSetSha256',
            'rendererImplementationSha256', 'memberSetSha256', 'markdownSha256'], `生产重放证明中的每日汇总项 daily[${index}]`);
        if (!UUID_RE.test(item.aggregateRunId || '') || !validDate(item.date)
            || Object.entries(item).filter(([key]) => key.endsWith('Sha256')).some(([, value]) => !SHA_RE.test(value || ''))) fail(`生产重放证明的每日汇总项 daily[${index}] 的运行标识、日期或内容哈希无效。`);
    });
    proof.analysisSources.forEach((item, index) => {
        exactKeys(item, ['paperId', 'pageKey', 'analysisRunId', 'analysisFileSha256', 'authorityName', 'authorityFileSha256',
            'authoritySha256', 'sourceSnapshotSha256', 'fulltextSha256', 'sourceSha256', 'structuredArtifactsSha256'], `生产重放证明中的分析项 analysis[${index}]`);
        if (!/^arxiv:\d{4}\.\d{4,5}$/.test(item.paperId || '') || !PAGE_KEY_RE.test(item.pageKey || '')
            || !UUID_RE.test(item.analysisRunId || '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.json$/.test(item.authorityName || '')
            || Object.entries(item).filter(([key]) => key.endsWith('Sha256')).some(([, value]) => !SHA_RE.test(value || ''))) fail(`生产重放证明的分析项 analysis[${index}] 的论文标识、运行标识、来源文件名或内容哈希无效。`);
    });
    if (new Set(proof.pageStagingRuns.map(item => item.stagingRunId)).size !== proof.pageStagingRuns.length
        || proof.pageStagingRuns.some(item => item.rendererImplementationSha256 !== proof.rendererImplementationSha256)
        || proof.pageStagingRuns.some((item, index) => index && proof.pageStagingRuns[index - 1].stagingRunId.localeCompare(item.stagingRunId) >= 0)
        || new Set(proof.dailyRuns.map(item => item.date)).size !== proof.dailyRuns.length
        || proof.dailyRuns.some(item => item.rendererImplementationSha256 !== proof.rendererImplementationSha256)
        || proof.dailyRuns.some((item, index) => index && `${proof.dailyRuns[index - 1].date}\0${proof.dailyRuns[index - 1].aggregateRunId}`.localeCompare(`${item.date}\0${item.aggregateRunId}`) >= 0)
        || new Set(proof.analysisSources.map(item => item.pageKey)).size !== proof.analysisSources.length
        || proof.analysisSources.some((item, index) => index && proof.analysisSources[index - 1].pageKey.localeCompare(item.pageKey) >= 0)) {
        fail('生产重放证明中的页面、汇总或分析集合存在重复项，或未按要求排序。');
    }
    const body = clone(proof); delete body.proofSha256;
    if (proof.pageStagingSetSha256 !== stableHash(proof.pageStagingRuns)
        || proof.dailyRunSetSha256 !== stableHash(proof.dailyRuns)
        || proof.analysisSourceSetSha256 !== stableHash(proof.analysisSources)
        || proof.proofSha256 !== stableHash(body)) fail('生产重放证明的集合哈希或自身内容哈希与实际记录不一致。');
    return proof;
}
function validatePlan(plan, planId) {
    exactKeys(plan, ['contract', 'version', 'planId', 'createdAt', 'oldGeneratedTextIncluded', 'producerContracts',
        'conferenceRefs', 'producers', 'producerReplay', 'producerReplaySha256', 'blogBaseline', 'blogBaselineSha256',
        'artifacts', 'artifactSetSha256', 'batches', 'batchSetSha256', 'planSha256'], '发布计划');
    const body = clone(plan); delete body.planSha256;
    if (plan.planSha256 !== stableHash(body)) fail('发布计划的内容哈希与原对象不一致。');
    const legacy = plan.contract === LEGACY_PLAN_CONTRACT && plan.version === 1;
    const current = plan.contract === PLAN_CONTRACT && plan.version === PLAN_VERSION;
    const validContracts = Array.isArray(plan.producerContracts) && (legacy
        ? JSON.stringify(plan.producerContracts) === JSON.stringify(LEGACY_PRODUCER_CONTRACTS)
        : plan.producerContracts.length > 0 && plan.producerContracts.every(value => PRODUCER_CONTRACTS.includes(value))
            && JSON.stringify(plan.producerContracts) === JSON.stringify([...new Set(plan.producerContracts)].sort()));
    if ((!legacy && !current) || plan.planId !== planId || plan.oldGeneratedTextIncluded !== false
        || !UUID_RE.test(plan.planId || '') || Number.isNaN(Date.parse(plan.createdAt || ''))
        || new Date(plan.createdAt).toISOString() !== plan.createdAt
        || plan.planSha256 !== stableHash(body) || !Array.isArray(plan.artifacts) || !plan.artifacts.length
        || plan.artifactSetSha256 !== stableHash(plan.artifacts) || !Array.isArray(plan.batches) || !plan.batches.length
        || plan.batchSetSha256 !== stableHash(plan.batches) || !Array.isArray(plan.conferenceRefs) || plan.conferenceRefs.length
        || plan.producerReplaySha256 !== validateProducerReplay(plan.producerReplay).proofSha256
        || plan.blogBaselineSha256 !== stableHash(validateBlogState(plan.blogBaseline, '发布计划中的博客基线'))
        || !validContracts
        || !Array.isArray(plan.producers) || !plan.producers.length) fail('发布计划的格式、生产记录、基线或内容哈希不符合要求。');
    plan.producers.forEach((producer, index) => validateProducer(producer, `producers[${index}]`));
    const producerKeys = plan.producers.map(producer => stableHash(producer)); const producerKeySet = new Set(producerKeys);
    if (producerKeySet.size !== producerKeys.length
        || plan.producers.some((item, index) => index && JSON.stringify(plan.producers[index - 1]).localeCompare(JSON.stringify(item)) >= 0)) fail('发布计划的生成记录存在重复项，或未按要求排序。');
    const stagingProducers = plan.producers.filter(item => item.kind === 'page-staging').map(item => ({ runId: item.runId,
        manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.runId.localeCompare(b.runId));
    const stagingProofs = plan.producerReplay.pageStagingRuns.map(item => ({ runId: item.stagingRunId,
        manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 })).sort((a, b) => a.runId.localeCompare(b.runId));
    const dailyProducers = plan.producers.filter(item => item.kind === 'daily-aggregate').map(item => ({ runId: item.runId,
        date: item.date, manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 }))
        .sort((a, b) => `${a.date}\0${a.runId}`.localeCompare(`${b.date}\0${b.runId}`));
    const dailyProofs = plan.producerReplay.dailyRuns.map(item => ({ runId: item.aggregateRunId, date: item.date,
        manifestSha256: item.manifestSha256, manifestFileSha256: item.manifestFileSha256 }))
        .sort((a, b) => `${a.date}\0${a.runId}`.localeCompare(`${b.date}\0${b.runId}`));
    if (stableHash(stagingProducers) !== stableHash(stagingProofs) || stableHash(dailyProducers) !== stableHash(dailyProofs)) {
        fail('发布计划的生成记录列表与生产重放证明不一致。');
    }
    plan.artifacts.forEach(validateArtifact);
    const paths = plan.artifacts.map(item => item.path);
    if (new Set(paths).size !== paths.length || paths.some((item, index) => index && paths[index - 1].localeCompare(item) >= 0)
        || plan.artifacts.some(item => !producerKeySet.has(stableHash(item.producer)))) fail('发布计划的文件路径存在重复、未按要求排序，或对应的生成记录不在计划中。');
    const owned = [];
    plan.batches.forEach((batch, index) => {
        exactKeys(batch, ['batchId', 'kind', 'date', 'paths', 'predecessorBatchIds', 'pathSetSha256'], `batches[${index}]`);
        const expectedPredecessors = index ? [plan.batches[index - 1].batchId] : [];
        const invalidPaths = !Array.isArray(batch.paths) || !batch.paths.length || new Set(batch.paths).size !== batch.paths.length
            || batch.paths.some((item, pathIndex) => { safePath(item); return pathIndex > 0 && batch.paths[pathIndex - 1].localeCompare(item) >= 0; });
        if (batch.batchId !== `daily-${batch.date}` || batch.kind !== 'daily-cohort'
            || !validDate(batch.date) || !Array.isArray(batch.paths) || !batch.paths.length
            || invalidPaths
            || stableHash(batch.paths) !== batch.pathSetSha256
            || JSON.stringify(batch.predecessorBatchIds) !== JSON.stringify(expectedPredecessors)
            || index && plan.batches[index - 1].date.localeCompare(batch.date) >= 0) fail(`发布批次 batches[${index}] 的日期、路径集合、依赖关系或排序不符合要求。`);
        owned.push(...batch.paths);
    });
    if (owned.length !== paths.length || new Set(owned).size !== owned.length
        || owned.some(item => !paths.includes(item))) fail('发布批次未将待发布文件完整且不重复地分配到各批次。');
    const aggregateDates = plan.artifacts.filter(item => item.aggregate === true).map(item => item.cohortDate).sort();
    if (new Set(aggregateDates).size !== aggregateDates.length) fail('发布计划中的每日汇总日期重复。');
    const expectedBatches = batchesFor(plan.artifacts, aggregateDates);
    if (stableHash(expectedBatches) !== stableHash(plan.batches)) fail('发布批次及其依赖关系与按待发布文件和日期计算的结果不一致。');
}
function loadPlanRecord({ outputRoot, planId }, allowPendingLink) {
    const dir = outputDirectory(outputRoot, planId);
    const loaded = readRegular(path.join(dir, 'plan.json'), 64 * 1024 * 1024, { allowPendingLink });
    const plan = strictJson(loaded.bytes, '发布计划');
    validatePlan(plan, planId);
    return { dir, plan, fileSha256: loaded.sha256, bytes: loaded.bytes };
}
function loadPlan(options) {
    const { bytes, ...loaded } = loadPlanRecord(options, false);
    return loaded;
}
function loadPlanForWrite(options) { return loadPlanRecord(options, true); }

function runGit(blogRepo, args, { text = true, maximum = 128 * 1024 * 1024 } = {}) {
    const result = spawnSync('git', ['-C', blogRepo, ...args], { encoding: text ? 'utf8' : null,
        env: { ...process.env, LANG: 'C', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: maximum });
    if (result.error || result.signal || result.status !== 0) fail(`Git 命令 ${args[0]} 执行失败（${result.error?.message || result.signal || result.status}）。`);
    return text ? result.stdout.trim() : Buffer.from(result.stdout);
}
function defaultBlogState(blogRepo, remoteName = 'origin') {
    const repo = fresh.assertSafeDirectory(blogRepo);
    const run = (args, text = true) => runGit(repo, args, { text });
    const head = run(['rev-parse', '--verify', 'HEAD']); const treeOid = run(['rev-parse', '--verify', 'HEAD^{tree}']);
    const contentTreeOid = run(['rev-parse', '--verify', 'HEAD:content/posts']);
    const branch = run(['branch', '--show-current']); const clean = run(['status', '--porcelain=v1', '--untracked-files=all']) === '';
    const pushUrl = run(['remote', 'get-url', '--push', remoteName]); const remoteIdentitySha256 = stableHash({ remote: remoteName, pushUrl });
    const remoteLine = run(['ls-remote', '--exit-code', remoteName, 'refs/heads/main']).split(/\r?\n/)[0] || '';
    const remoteOid = remoteLine.split(/\s+/)[0].toLowerCase();
    const hugoPath = ['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].find(name => fs.existsSync(path.join(repo, name)));
    if (!hugoPath) fail('博客仓库中缺少 Hugo 配置文件。');
    const hugo = readRegular(path.join(repo, hugoPath), 4 * 1024 * 1024);
    return { head: head.toLowerCase(), treeOid: treeOid.toLowerCase(), contentTreeOid: contentTreeOid.toLowerCase(), branch, clean, remoteName,
        remoteIdentitySha256, remoteOid, hugoConfig: { path: hugoPath, sha256: hugo.sha256 } };
}
function defaultGitBlob(blogRepo, head, relative) {
    const listing = runGit(blogRepo, ['ls-tree', '-z', '--full-tree', head, '--', relative], { text: false });
    if (!listing.length) return null;
    const match = listing.toString('utf8').match(/^(100644|100755) blob ([a-f0-9]{40,64})\t([^\0]+)\0$/);
    if (!match || match[3] !== relative) fail(`Git 树中的目标不是唯一的普通文件记录，或路径不一致：${relative}`);
    return runGit(blogRepo, ['cat-file', 'blob', match[2]], { text: false });
}
function validateBlogState(state, label = '博客状态') {
    exactKeys(state, ['head', 'treeOid', 'contentTreeOid', 'branch', 'clean', 'remoteName', 'remoteIdentitySha256', 'remoteOid', 'hugoConfig'], label);
    exactKeys(state.hugoConfig, ['path', 'sha256'], `${label}.hugoConfig`);
    if (state.branch !== 'main' || state.clean !== true || !/^[a-f0-9]{40,64}$/.test(state.head || '')
        || !/^[a-f0-9]{40,64}$/.test(state.treeOid || '') || state.treeOid.length !== state.head.length
        || !/^[a-f0-9]{40,64}$/.test(state.contentTreeOid || '') || state.contentTreeOid.length !== state.head.length
        || state.remoteOid !== state.head
        || typeof state.remoteName !== 'string' || !state.remoteName || !SHA_RE.test(state.remoteIdentitySha256 || '')
        || !['hugo.yaml', 'hugo.yml', 'hugo.toml', 'hugo.json'].includes(state.hugoConfig.path)
        || !SHA_RE.test(state.hugoConfig.sha256 || '')) fail(`${label} 必须是干净的 main 分支，与已核验远端提交一致，并包含有效的 Hugo 配置基线。`);
    return clone(state);
}
function blogTarget(blogRepo, relative) {
    const root = fresh.assertSafeDirectory(blogRepo); let cursor = root;
    for (const part of relative.split('/')) {
        cursor = path.join(cursor, part);
        try { const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink()) fail(`博客目标路径包含符号链接：${relative}`); }
        catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    const target = path.resolve(root, ...relative.split('/'));
    if (!target.startsWith(`${root}${path.sep}`)) fail('博客目标路径超出仓库目录。');
    return target;
}
function sourceBytes(item, roots) {
    if (item.source.kind === 'page-staging-file') {
        const stagingRoot = fresh.assertSafeDirectory(roots.stagingRoot);
        const root = fresh.assertSafeDirectory(path.join(stagingRoot, item.source.runId));
        const filename = path.resolve(root, ...item.source.relativePath.split('/'));
        if (!filename.startsWith(`${path.resolve(root)}${path.sep}`)) fail('页面暂存来源路径超出其运行目录。');
        fresh.assertSafeDirectory(path.dirname(filename)); return readRegular(filename).bytes;
    }
    if (item.source.kind === 'daily-aggregate-markdown') return Buffer.from(loadDailyAggregate({ aggregateRoot: roots.aggregateRoot,
        aggregateRunId: item.source.runId, date: item.source.date }).manifest.markdown, 'utf8');
    fail('待发布文件的来源类型不受支持。');
}

function listBundleFiles(bundleRoot, allowAbsent = false, allowedPaths = null) {
    if (!fs.existsSync(bundleRoot)) { if (allowAbsent) return []; fail('缺少待发布文件目录。'); }
    const root = fresh.assertSafeDirectory(bundleRoot); const found = [];
    const visit = (directory, prefix) => {
        for (const name of fs.readdirSync(directory).sort()) {
            const filename = path.join(directory, name); const relative = prefix ? `${prefix}/${name}` : name;
            const stat = fs.lstatSync(filename);
            if (stat.isSymbolicLink()) fail(`待发布文件目录中包含符号链接：${relative}`);
            if (stat.isDirectory()) {
                if (allowedPaths && !allowedPaths.some(item => item.startsWith(`${relative}/`))) fail(`待发布文件目录中存在计划未允许的目录：${relative}`);
                fresh.assertSafeDirectory(filename); visit(filename, relative); continue;
            }
            if (!stat.isFile() || stat.nlink !== 1) fail(`待发布文件目录中存在非普通文件或硬链接数量不为 1 的条目：${relative}`);
            safePath(relative); const loaded = readRegular(filename); found.push({ path: relative, sha256: loaded.sha256 });
        }
    };
    visit(root, ''); return found;
}
function assertGenerationRoot(generationRoot, { complete }) {
    const allowed = new Set(['intent.json', 'bundle', ...(complete ? ['manifest.json'] : [])]);
    for (const name of fs.readdirSync(generationRoot)) if (!allowed.has(name)) fail(`生成记录目录中存在不允许的条目：${name}`);
}
function assertBundle(bundleRoot, files, allowPartial = false) {
    const expected = files.map(item => ({ path: item.path, sha256: item.newSha256 })).sort((a, b) => a.path.localeCompare(b.path));
    const actual = listBundleFiles(bundleRoot, allowPartial, expected.map(item => item.path));
    if (actual.some(item => !expected.some(wanted => wanted.path === item.path && wanted.sha256 === item.sha256))
        || !allowPartial && stableHash(actual) !== stableHash(expected)) fail('待发布文件的路径或内容哈希与生成记录不一致，或存在额外条目。');
    return { files: actual, bundleSetSha256: stableHash(expected) };
}
function normalizeGeneration(value, plan, batch) {
    exactKeys(value, ['contract', 'version', 'generationId', 'planId', 'planFileSha256', 'planSha256', 'batchId',
        'batchPathSetSha256', 'predecessorBatchIds', 'predecessorProofs', 'producerReplaySha256', 'baseHead',
        'baseTreeOid', 'remoteName', 'remoteIdentitySha256', 'remoteMainOid', 'hugoConfig', 'oldGeneratedTextIncluded',
        'files', 'fileSetSha256', 'bundleSetSha256', 'exactDelta', 'exactDeltaSha256', 'generationSha256'], '生成清单');
    const body = clone(value); delete body.generationSha256; const baseline = plan.blogBaseline;
    if (value.contract !== GENERATION_CONTRACT || value.version !== VERSION || !/^[a-f0-9]{32}$/.test(value.generationId || '')
        || value.planId !== plan.planId || value.planSha256 !== plan.planSha256 || value.batchId !== batch.batchId
        || value.batchPathSetSha256 !== batch.pathSetSha256 || value.producerReplaySha256 !== plan.producerReplaySha256
        || value.oldGeneratedTextIncluded !== false || value.generationSha256 !== stableHash(body)
        || value.fileSetSha256 !== stableHash(value.files) || value.exactDeltaSha256 !== stableHash(value.exactDelta)
        || value.baseHead !== baseline.head || value.baseTreeOid !== baseline.treeOid || value.remoteName !== baseline.remoteName
        || value.remoteIdentitySha256 !== baseline.remoteIdentitySha256 || value.remoteMainOid !== baseline.remoteOid
        || stableHash(value.hugoConfig) !== stableHash(baseline.hugoConfig)
        || JSON.stringify(value.predecessorBatchIds) !== JSON.stringify(batch.predecessorBatchIds)
        || !Array.isArray(value.predecessorProofs) || value.predecessorProofs.length !== batch.predecessorBatchIds.length) fail('生成清单的格式、内容哈希或与发布计划和博客基线的对应关系不符合要求。');
    const planned = new Map(plan.artifacts.map(item => [item.path, item]));
    if (!Array.isArray(value.files) || value.files.length !== batch.paths.length) fail('生成清单中的文件数量与发布批次不一致。');
    value.files.forEach((record, index) => {
        exactKeys(record, ['path', 'operation', 'baselineSha256', 'newSha256', 'producer', 'source',
            'oldGeneratedTextIncluded'], `generation files[${index}]`);
        const item = planned.get(record.path);
        if (!item || !batch.paths.includes(record.path) || record.operation !== item.plannedOperation
            || record.baselineSha256 !== item.baselineSha256 || record.newSha256 !== item.newSha256
            || record.oldGeneratedTextIncluded !== false || stableHash(record.producer) !== stableHash(item.producer)
            || stableHash(record.source) !== stableHash(item.source)) fail(`生成清单中的文件项 files[${index}] 与发布计划不一致。`);
    });
    if (new Set(value.files.map(item => item.path)).size !== value.files.length
        || value.files.some((item, index) => index && value.files[index - 1].path.localeCompare(item.path) >= 0)) fail('生成清单中的文件重复，或未按路径排序。');
    const expectedDelta = value.files.filter(item => item.operation !== 'unchanged').map(item => ({ path: item.path,
        operation: item.operation, baselineSha256: item.baselineSha256, newSha256: item.newSha256 }));
    const expectedBundleSetSha256 = stableHash(value.files.map(item => ({ path: item.path, sha256: item.newSha256 }))
        .sort((a, b) => a.path.localeCompare(b.path)));
    if (stableHash(value.exactDelta) !== stableHash(expectedDelta) || value.bundleSetSha256 !== expectedBundleSetSha256
        || value.generationId !== stableHash({ planId: plan.planId, batchId: batch.batchId,
            baseHead: value.baseHead, records: value.files }).slice(0, 32)) fail('生成清单的文件集合、变更集合或生成 ID 与实际记录不一致。');
    value.predecessorProofs.forEach((proof, index) => {
        exactKeys(proof, ['batchId', 'generationId', 'generationSha256', 'manifestFileSha256', 'bundleSetSha256'], `predecessorProofs[${index}]`);
        if (proof.batchId !== batch.predecessorBatchIds[index] || !/^[a-f0-9]{32}$/.test(proof.generationId || '')
            || ['generationSha256', 'manifestFileSha256', 'bundleSetSha256'].some(field => !SHA_RE.test(proof[field] || ''))) fail(`前置批次证明 predecessorProofs[${index}] 的批次标识、生成标识或内容哈希无效。`);
    });
    return value;
}
function loadGenerationProof({ loadedPlan, batchId }) {
    const batch = loadedPlan.plan.batches.find(item => item.batchId === batchId);
    if (!batch) fail(`发布计划中缺少前置批次：${batchId}`);
    let root;
    try { root = fresh.assertSafeDirectory(path.join(loadedPlan.dir, 'generations', batchId)); }
    catch (error) { if (error.code === 'ENOENT') fail(`缺少前置批次的生成记录目录：${batchId}`); throw error; }
    assertGenerationRoot(root, { complete: true });
    const file = readRegular(path.join(root, 'manifest.json'), 64 * 1024 * 1024);
    const manifest = normalizeGeneration(strictJson(file.bytes, `批次 ${batchId} 的生成记录`), loadedPlan.plan, batch);
    if (manifest.planFileSha256 !== loadedPlan.fileSha256 || !file.bytes.equals(canonicalBytes(manifest))) fail(`批次 ${batchId} 的生成清单文件字节或与原发布计划文件的哈希对应关系不一致。`);
    const bundle = assertBundle(path.join(root, 'bundle'), manifest.files);
    if (bundle.bundleSetSha256 !== manifest.bundleSetSha256) fail(`批次 ${batchId} 的待发布文件集合哈希与生成清单不一致。`);
    return { batchId, generationId: manifest.generationId, generationSha256: manifest.generationSha256,
        manifestFileSha256: file.sha256, bundleSetSha256: bundle.bundleSetSha256 };
}

function generateBundle({ outputRoot, planId, batchId, blogRepo, stagingRoot, aggregateRoot, crosswalkRoot,
    inventoryRoot, analysisRoot, tagAssignmentRoot, tagCatalogPath, apply = false, remoteName = 'origin' } = {}, dependencies = {}) {
    const loaded = apply ? loadPlanForWrite({ outputRoot, planId }) : loadPlan({ outputRoot, planId }); const batch = loaded.plan.batches.find(item => item.batchId === batchId);
    if (!batch) fail('发布计划中没有指定批次。');
    const refs = { pageStagingRunIds: loaded.plan.producers.filter(item => item.kind === 'page-staging').map(item => item.runId),
        dailyAggregates: loaded.plan.producers.filter(item => item.kind === 'daily-aggregate').map(item => ({ aggregateRunId: item.runId, date: item.date })),
        stagingRoot, aggregateRoot, crosswalkRoot, inventoryRoot, analysisRoot, tagAssignmentRoot, tagCatalogPath };
    const replay = dependencies.replayProducerSet
        ? dependencies.replayProducerSet(refs, dependencies, loaded.plan)
        : replayProducerSetForPlan(refs, dependencies, loaded.plan);
    if (!replay?.proof || stableHash(replay.proof) !== stableHash(loaded.plan.producerReplay)) fail('生成时重新核验的生产记录与原发布计划不一致。');
    assertPlanProducerContracts(loaded.plan, replay);
    const state = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), '生成待发布文件前的博客状态');
    if (stableHash(state) !== loaded.plan.blogBaselineSha256) fail('博客仓库状态与原发布计划的基线不一致。');
    const predecessorProofs = batch.predecessorBatchIds.map(predecessor => loadGenerationProof({ loadedPlan: loaded, batchId: predecessor }));
    const records = []; const payloads = new Map(); const planned = new Map(loaded.plan.artifacts.map(item => [item.path, item]));
    for (const relative of batch.paths) {
        const item = planned.get(relative); if (!item) fail('指定批次的文件路径不在发布计划的文件清单中。');
        const bytes = Buffer.from((dependencies.sourceBytes || sourceBytes)(item, { stagingRoot, aggregateRoot }));
        if (sha256(bytes) !== item.newSha256) fail(`生成来源文件的实际字节与发布计划中的内容哈希不一致：${relative}`);
        payloads.set(relative, bytes);
        const baseline = (dependencies.gitBlob || defaultGitBlob)(blogRepo, state.head, relative);
        const baselineSha256 = baseline === null ? null : sha256(baseline);
        const worktree = blogTarget(blogRepo, relative);
        let working = null;
        if (fs.existsSync(worktree)) { const found = readRegular(worktree); working = found.sha256; }
        if (working !== baselineSha256) fail(`工作区文件与基线提交中的内容不一致：${relative}`);
        if (baselineSha256 !== item.baselineSha256) fail(`基线提交中的内容哈希与原发布计划不一致：${relative}`);
        if (item.expectedBaselineSha256 === null && baselineSha256 !== null && baselineSha256 !== item.newSha256) fail(`待新建的资源文件已存在，且内容与本次生成结果不同：${relative}`);
        if (item.expectedBaselineSha256 !== null && baselineSha256 !== item.expectedBaselineSha256) fail(`基线提交中的文件内容与页面盘点记录的哈希不一致：${relative}`);
        const operation = baselineSha256 === null ? 'create' : baselineSha256 === item.newSha256 ? 'unchanged' : 'replace';
        if (operation !== item.plannedOperation) fail(`当前文件需要执行的操作与发布计划不一致：${relative}`);
        records.push({ path: relative, operation, baselineSha256, newSha256: item.newSha256,
            producer: item.producer, source: item.source, oldGeneratedTextIncluded: false });
    }
    records.sort((a, b) => a.path.localeCompare(b.path));
    const delta = records.filter(item => item.operation !== 'unchanged').map(item => ({ path: item.path,
        operation: item.operation, baselineSha256: item.baselineSha256, newSha256: item.newSha256 }));
    const generationId = stableHash({ planId, batchId, baseHead: state.head, records }).slice(0, 32);
    const body = { contract: GENERATION_CONTRACT, version: VERSION, generationId, planId, planFileSha256: loaded.fileSha256,
        planSha256: loaded.plan.planSha256, batchId, batchPathSetSha256: batch.pathSetSha256,
        predecessorBatchIds: batch.predecessorBatchIds, predecessorProofs,
        producerReplaySha256: loaded.plan.producerReplaySha256,
        baseHead: state.head, baseTreeOid: state.treeOid, remoteName: state.remoteName,
        remoteIdentitySha256: state.remoteIdentitySha256, remoteMainOid: state.remoteOid,
        hugoConfig: state.hugoConfig, oldGeneratedTextIncluded: false, files: records,
        fileSetSha256: stableHash(records), bundleSetSha256: stableHash(records.map(item => ({ path: item.path,
            sha256: item.newSha256 })).sort((a, b) => a.path.localeCompare(b.path))),
        exactDelta: delta, exactDeltaSha256: stableHash(delta) };
    const manifest = sealed(body, 'generationSha256');
    if (!apply) return { status: 'dry-run', manifest };
    const generationRoot = path.join(loaded.dir, 'generations', batchId); fresh.assertSafeDirectory(generationRoot, true);
    const intent = sealed({ contract: INTENT_CONTRACT, version: VERSION, generationId, planId,
        planFileSha256: loaded.fileSha256, planSha256: loaded.plan.planSha256, batchId,
        batchPathSetSha256: batch.pathSetSha256, predecessorProofs,
        producerReplaySha256: loaded.plan.producerReplaySha256,
        baseHead: state.head, baseTreeOid: state.treeOid, remoteName: state.remoteName,
        remoteIdentitySha256: state.remoteIdentitySha256, remoteMainOid: state.remoteOid,
        hugoConfig: state.hugoConfig, fileSetSha256: manifest.fileSetSha256,
        bundleSetSha256: manifest.bundleSetSha256, exactDeltaSha256: manifest.exactDeltaSha256,
        generationSha256: manifest.generationSha256 }, 'intentSha256');
    // 先核对计划、真实来源和博客基线，再恢复本次已知文件；只读入口不清理链接。
    const recoverKnown = (filename, bytes) => {
        let stat;
        try { stat = fs.lstatSync(filename); }
        catch (error) { if (error.code === 'ENOENT') return; throw error; }
        if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 2) writeExact(filename, bytes);
    };
    recoverKnown(path.join(loaded.dir, 'plan.json'), loaded.bytes);
    recoverKnown(path.join(generationRoot, 'intent.json'), canonicalBytes(intent));
    recoverKnown(path.join(generationRoot, 'manifest.json'), canonicalBytes(manifest));
    for (const record of records) {
        recoverKnown(path.join(generationRoot, 'bundle', ...record.path.split('/')), payloads.get(record.path));
    }
    assertGenerationRoot(generationRoot, { complete: fs.existsSync(path.join(generationRoot, 'manifest.json')) });
    assertBundle(path.join(generationRoot, 'bundle'), records, true);
    writeExact(path.join(generationRoot, 'intent.json'), canonicalBytes(intent));
    let copied = 0;
    for (const record of records) {
        writeExact(path.join(generationRoot, 'bundle', ...record.path.split('/')), payloads.get(record.path)); copied++;
        dependencies.afterCopy?.(record, copied);
    }
    const completedBundle = assertBundle(path.join(generationRoot, 'bundle'), records);
    if (completedBundle.bundleSetSha256 !== manifest.bundleSetSha256) fail('写入完成后的待发布文件集合哈希与生成清单不一致。');
    const closing = validateBlogState((dependencies.blogState || defaultBlogState)(blogRepo, remoteName), '生成待发布文件后的博客状态');
    if (stableHash(closing) !== stableHash(state)) fail('生成待发布文件期间，博客仓库状态发生变化。');
    for (const record of records) {
        const target = blogTarget(blogRepo, record.path); const current = fs.existsSync(target) ? readRegular(target).sha256 : null;
        if (current !== record.baselineSha256) fail(`生成结束时，工作区文件与原基线内容不一致：${record.path}`);
    }
    writeExact(path.join(generationRoot, 'manifest.json'), canonicalBytes(manifest));
    return { status: 'generated', generationRoot, manifest };
}

module.exports = { PLAN_CONTRACT, LEGACY_PLAN_CONTRACT, PLAN_VERSION, GENERATION_CONTRACT, INTENT_CONTRACT, VERSION, UUID_RE,
    stableHash, safePath, readRegular, writeExact, loadDailyAggregate, replayAnalysisSources, replayProducerSet,
    buildPlan, writePlan, loadPlan, defaultBlogState, defaultGitBlob, blogTarget, sourceBytes,
    listBundleFiles, loadGenerationProof, generateBundle };
