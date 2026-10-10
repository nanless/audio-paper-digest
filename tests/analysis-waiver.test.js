'use strict';

// 分析豁免允许跳过分析检查，因此这里既检查豁免记录的字段是否对应，
// 也检查读取时是否拒绝各类篡改和保存文件的变化。全部在临时目录里做，不碰 data/current。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT = path.join(__dirname, '..');

const Config = require('../scripts/config.js');
const waiver = require('../scripts/analysis-waiver.js');
const cli = require('../scripts/waive-analysis-failures.js');

const DATE = '2026-09-04';
const PAPER = '2609.00001';
const REASON = '用户在评审记录里确认这批分析失败可以先放行';

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function fixture(paperIds = [PAPER]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'analysis-waiver-'));
    const files = {
        deepAnalysisResult: path.join(directory, 'deep-analysis-result.json'),
        filteredPapers: path.join(directory, 'filtered-papers.json'),
        papers: path.join(directory, 'papers.json'),
        analysisWaiverDir: path.join(directory, 'analysis-waivers')
    };
    const deep = {
        batchDate: DATE,
        papers: paperIds.map((id, index) => ({
            paper_id: id,
            sourceSha256: String(index + 1).repeat(64).slice(0, 64),
            analysis: `analysis-${id}`
        }))
    };
    const filtered = { batchDate: DATE, status: 'complete',
        papers: paperIds.map(id => ({ paper_id: id })) };
    const papers = { papers: Object.fromEntries(paperIds.map(id => [id, {
        digestStatus: { status: 'failed', latestAttemptStatus: 'api_error' } }])) };
    fs.writeFileSync(files.deepAnalysisResult, JSON.stringify(deep));
    fs.writeFileSync(files.filteredPapers, JSON.stringify(filtered));
    fs.writeFileSync(files.papers, JSON.stringify(papers));
    return { directory, files, deep, filtered, papers };
}

function create(f, overrides = {}) {
    return waiver.createAnalysisWaiver({
        date: DATE, paperIds: [PAPER], reason: REASON, files: f.files,
        now: () => '2026-09-04T10:00:00.000+08:00', ...overrides
    });
}

function issueOf(payload, f, expected) {
    const result = waiver.validateAnalysisWaiver(payload, DATE, f.files,
        { deep: f.deep, papers: f.papers });
    assert.equal(result.valid, false, `期望无效，实际通过：${expected}`);
    assert.ok(result.issues.includes(expected),
        `期望 issue ${JSON.stringify(expected)}，实际 ${JSON.stringify(result.issues)}`);
    return result;
}

describe('分析豁免记录的保存与核验', () => {
    it('写出的记录字段齐全、SHA 可复算、并落在批次目录里', () => {
        const f = fixture();
        try {
            const { output, payload } = create(f);

            assert.equal(output, path.join(f.files.analysisWaiverDir, `${DATE}.json`));
            assert.equal(payload.contract, 'daily-analysis-waiver-v1');
            assert.equal(payload.version, 1);
            assert.equal(payload.status, 'waived');
            assert.equal(payload.requestedBy, 'user');
            assert.equal(payload.batchDate, DATE);
            assert.equal(payload.waivedAt, '2026-09-04T10:00:00.000+08:00');
            assert.deepEqual(payload.papers.map(entry => entry.paperId), [PAPER]);
            assert.equal(payload.papers[0].deepPaperSha256, waiver.stableSha256(f.deep.papers[0]));
            assert.equal(payload.papers[0].sourceSha256, '1'.repeat(64));
            assert.equal(payload.papers[0].originalDigestStatus, 'failed');
            assert.equal(payload.papers[0].originalLatestAttemptStatus, 'api_error');
            assert.equal(payload.source.deepAnalysisResultSha256, sha256File(f.files.deepAnalysisResult));
            assert.equal(payload.source.filteredPapersSha256, sha256File(f.files.filteredPapers));
            assert.equal(payload.source.papersDatabaseSha256, sha256File(f.files.papers));

            const body = { ...payload };
            delete body.waiverSha256;
            assert.equal(payload.waiverSha256, waiver.stableSha256(body));
            assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), payload);
            assert.equal(waiver.loadAnalysisWaiver(DATE, f.files).waiverSha256, payload.waiverSha256);
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('多篇论文的豁免记录按 ID 排序保存，读取时核对论文集合', () => {
        const f = fixture(['2609.00002', '2609.00001']);
        try {
            const { payload } = create(f, { paperIds: ['2609.00002', '2609.00001'] });
            assert.deepEqual(payload.papers.map(entry => entry.paperId),
                ['2609.00001', '2609.00002']);

            const result = waiver.validateAnalysisWaiver(payload, DATE, f.files,
                { deep: f.deep, papers: f.papers });
            assert.equal(result.valid, true, result.issues.join('; '));
            assert.deepEqual([...result.paperIds], ['2609.00001', '2609.00002']);
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('乱序豁免即使重算自身 SHA 也不能通过读取校验', () => {
        const f = fixture(['2609.00001', '2609.00002']);
        try {
            const { payload } = create(f, { paperIds: ['2609.00001', '2609.00002'] });
            assert.equal(waiver.validateAnalysisWaiver(payload, DATE, f.files).valid, true);
            payload.papers.reverse();
            delete payload.waiverSha256;
            payload.waiverSha256 = waiver.stableSha256(payload);
            issueOf(payload, f, '豁免记录的论文 ID 必须排序且不能重复');
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('没有豁免记录时视为通过；缺文件时 loadAnalysisWaiver 返回 null', () => {
        const f = fixture();
        try {
            const empty = waiver.validateAnalysisWaiver(null, DATE, f.files);
            assert.equal(empty.valid, true);
            assert.equal(empty.paperIds.size, 0);
            assert.deepEqual(empty.issues, []);
            assert.equal(waiver.validateAnalysisWaiver(undefined, DATE, f.files).valid, true);
            assert.equal(waiver.loadAnalysisWaiver(DATE, f.files), null);
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('日期或目录不合法时连路径都算不出来', () => {
        const f = fixture();
        try {
            assert.throws(() => waiver.waiverPath('2026-9-4', f.files),
                /日期或目录不合法/);
            assert.throws(() => waiver.waiverPath(DATE, { analysisWaiverDir: 'relative' }),
                /日期或目录不合法/);
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('写入前拦下非法日期、空清单、重复 ID、过短理由和不存在的论文', () => {
        const f = fixture();
        try {
            assert.throws(() => create(f, { date: '2026-9-4' }), /日期不合法/);
            assert.throws(() => create(f, { paperIds: [] }), /paperIds 不能为空/);
            assert.throws(() => create(f, { paperIds: [PAPER, PAPER] }),
                /必须是规范化且不重复的论文 ID/);
            assert.throws(() => create(f, { reason: '太短' }), /至少要 10 个字符/);
            assert.throws(() => create(f, { paperIds: ['2609.99999'] }),
                /当前分析结果或论文库中找不到这篇论文/);

            const missingSource = fixture();
            try {
                delete missingSource.deep.papers[0].sourceSha256;
                fs.writeFileSync(missingSource.files.deepAnalysisResult,
                    JSON.stringify(missingSource.deep));
                assert.throws(() => create(missingSource),
                    /缺少可核验的来源 SHA/);
            } finally {
                fs.rmSync(missingSource.directory, { recursive: true, force: true });
            }
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('读取侧逐项拦下字段、状态、时间戳、哈希与来源绑定的篡改', () => {
        const f = fixture();
        try {
            const { payload } = create(f);
            const clone = () => JSON.parse(JSON.stringify(payload));

            const unknownField = clone();
            unknownField.extra = true;
            issueOf(unknownField, f, '分析豁免记录含有未知字段或缺少必需字段');

            const wrongContract = clone();
            wrongContract.contract = 'daily-analysis-waiver-v2';
            issueOf(wrongContract, f, '分析豁免记录的 contract 或 version 不符合要求');

            const wrongVersion = clone();
            wrongVersion.version = 2;
            issueOf(wrongVersion, f, '分析豁免记录的 contract 或 version 不符合要求');

            const wrongDate = clone();
            wrongDate.batchDate = '2026-09-05';
            issueOf(wrongDate, f, '分析豁免记录的 batchDate 格式无效或与目标日期不一致');

            const wrongStatus = clone();
            wrongStatus.status = 'pending';
            issueOf(wrongStatus, f, '分析豁免记录的 status 必须为 waived，requestedBy 必须为 user');

            const wrongRequester = clone();
            wrongRequester.requestedBy = 'agent';
            issueOf(wrongRequester, f, '分析豁免记录的 status 必须为 waived，requestedBy 必须为 user');

            const shortReason = clone();
            shortReason.reason = '太短';
            issueOf(shortReason, f, '分析豁免记录的 reason 必须是去除首尾空白后至少含 10 个字符的字符串');

            const badTimestamp = clone();
            badTimestamp.waivedAt = '不是时间';
            issueOf(badTimestamp, f, '分析豁免记录的 waivedAt 必须是可解析的日期时间字符串');

            const emptyPapers = clone();
            emptyPapers.papers = [];
            issueOf(emptyPapers, f, '分析豁免记录的 papers 必须是至少包含一项的数组');

            const badEntry = clone();
            badEntry.papers[0].extra = 1;
            issueOf(badEntry, f, '豁免的逐论文记录不是对象、是数组，或含有未知字段或缺少必需字段');

            const unnormalized = clone();
            unnormalized.papers[0].paperId = `${PAPER}v2`;
            issueOf(unnormalized, f, '豁免记录的 paperId 不是标准论文 ID 格式');

            const badHash = clone();
            badHash.papers[0].deepPaperSha256 = 'zz';
            issueOf(badHash, f, `豁免记录的 deepPaperSha256 或 sourceSha256 不是 64 位小写十六进制 SHA-256： ${PAPER}`);

            const badDigestStatus = clone();
            badDigestStatus.papers[0].originalDigestStatus = 7;
            issueOf(badDigestStatus, f, `豁免记录的 originalDigestStatus 必须为字符串或 null： ${PAPER}`);

            const badAttemptStatus = clone();
            badAttemptStatus.papers[0].originalLatestAttemptStatus = {};
            issueOf(badAttemptStatus, f, `豁免记录的 originalLatestAttemptStatus 必须为字符串或 null： ${PAPER}`);

            const duplicated = clone();
            duplicated.papers.push(JSON.parse(JSON.stringify(duplicated.papers[0])));
            issueOf(duplicated, f, '豁免记录的论文 ID 必须排序且不能重复');

            const badSource = clone();
            delete badSource.source.filteredPapersSha256;
            issueOf(badSource, f, '豁免记录的 source 必须是只含 deepAnalysisResultSha256、filteredPapersSha256 和 papersDatabaseSha256 的对象，三项均须为 64 位小写十六进制 SHA-256');

            const badSourceHash = clone();
            badSourceHash.source.papersDatabaseSha256 = 'not-a-sha';
            issueOf(badSourceHash, f, '豁免记录的 source 必须是只含 deepAnalysisResultSha256、filteredPapersSha256 和 papersDatabaseSha256 的对象，三项均须为 64 位小写十六进制 SHA-256');

            const badSha = clone();
            badSha.waiverSha256 = 'b'.repeat(64);
            issueOf(badSha, f, '豁免记录的 waiverSha256 格式无效，或与记录内容重新计算的 SHA-256 不一致');
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('读取时核对保存文件与论文记录，内容不一致即拒绝', () => {
        const f = fixture();
        try {
            const { payload } = create(f);

            // 保存文件被改写：文件 SHA 和论文记录内容两项都要报。
            f.deep.papers[0].analysis = '被改写过的正文';
            fs.writeFileSync(f.files.deepAnalysisResult, JSON.stringify(f.deep));
            const result = waiver.validateAnalysisWaiver(payload, DATE, f.files,
                { deep: f.deep, papers: f.papers });
            assert.equal(result.valid, false);
            assert.ok(result.issues.includes('无法确认 deep-analysis-result.json 与豁免记录中的 source.deepAnalysisResultSha256 相符'));
            assert.ok(result.issues.includes(`分析结果中的论文记录与 deepPaperSha256 不一致： ${PAPER}`));
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('读取时核对论文来源 SHA、批次日期和论文库状态', () => {
        const f = fixture();
        try {
            const { payload } = create(f);

            const sourceDrift = JSON.parse(JSON.stringify(payload));
            sourceDrift.papers[0].sourceSha256 = 'c'.repeat(64);
            issueOf(sourceDrift, f, `分析结果中的论文来源 SHA 与 sourceSha256 不一致： ${PAPER}`);

            // 豁免记录仍指向本批次，但分析结果自己写的是别的日期。
            const wrongDate = waiver.validateAnalysisWaiver(payload, DATE, f.files,
                { deep: { ...f.deep, batchDate: '2026-09-05' }, papers: f.papers });
            assert.equal(wrongDate.valid, false);
            assert.ok(wrongDate.issues.includes('分析结果的 batchDate 与目标日期不一致'));

            const digestDrift = JSON.parse(JSON.stringify(payload));
            digestDrift.papers[0].originalDigestStatus = 'complete';
            issueOf(digestDrift, f, `论文库当前的 digestStatus.status 与 originalDigestStatus 不一致： ${PAPER}`);

            const attemptDrift = JSON.parse(JSON.stringify(payload));
            attemptDrift.papers[0].originalLatestAttemptStatus = 'ok';
            issueOf(attemptDrift, f, `论文库当前的 digestStatus.latestAttemptStatus 与 originalLatestAttemptStatus 不一致： ${PAPER}`);

            const missingPaper = JSON.parse(JSON.stringify(payload));
            missingPaper.papers[0].paperId = '2609.00009';
            missingPaper.papers[0].deepPaperSha256 = 'd'.repeat(64);
            const missing = waiver.validateAnalysisWaiver(missingPaper, DATE, f.files,
                { deep: f.deep, papers: f.papers });
            assert.equal(missing.valid, false);
            assert.ok(missing.issues.includes('分析结果中找不到豁免记录指定的论文： 2609.00009'));
        } finally {
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });
});

describe('digest:waive-analysis 入口', () => {
    it('解析重复 --paper-id、--date 与 --reason', () => {
        assert.deepEqual(cli.parseArgs(['--date', DATE, '--paper-id', PAPER,
            '--reason', REASON]), { paperIds: [PAPER], date: DATE, reason: REASON });
        assert.deepEqual(cli.parseArgs(['--date', DATE, '--paper-id', '2609.00001',
            '--paper-id', '2609.00002', '--reason', REASON]),
        { paperIds: ['2609.00001', '2609.00002'], date: DATE, reason: REASON });
    });

    it('未知、重复、缺值、非法日期和过短理由都报同一条用法', () => {
        const usage = /用法: --date YYYY-MM-DD --paper-id ID/;
        assert.throws(() => cli.parseArgs(['--date', DATE, '--reason', REASON]), usage);
        assert.throws(() => cli.parseArgs(['--date', DATE, '--paper-id', PAPER,
            '--reason', '太短']), usage);
        assert.throws(() => cli.parseArgs(['--date', '2026-9-4', '--paper-id', PAPER,
            '--reason', REASON]), usage);
        assert.throws(() => cli.parseArgs(['--date', DATE, '--date', DATE,
            '--paper-id', PAPER, '--reason', REASON]), usage);
        assert.throws(() => cli.parseArgs(['--date', DATE, '--paper-id', PAPER,
            '--reason']), usage);
        assert.throws(() => cli.parseArgs(['--date', DATE, '--paper-id', PAPER,
            '--unknown', 'x', '--reason', REASON]), usage);
        // --paper-id 缺值有自己的报错，说清是哪一个参数缺了值。
        assert.throws(() => cli.parseArgs(['--date', DATE, '--paper-id']),
            /--paper-id 后面要跟一个论文 ID/);
    });

    it('main 把记录写到 Config.FILES 指向的目录并返回 payload', () => {
        const f = fixture();
        const originals = {};
        for (const key of Object.keys(f.files)) {
            originals[key] = Config.FILES[key];
            Config.FILES[key] = f.files[key];
        }
        const logged = [];
        const originalLog = console.log;
        console.log = message => logged.push(message);
        try {
            const payload = cli.main(['--date', DATE, '--paper-id', PAPER, '--reason', REASON]);
            assert.equal(payload.contract, 'daily-analysis-waiver-v1');
            assert.equal(payload.papers[0].paperId, PAPER);
            const output = path.join(f.files.analysisWaiverDir, `${DATE}.json`);
            assert.equal(fs.existsSync(output), true);
            assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), payload);
            assert.ok(logged.some(line => line.includes(output)));
        } finally {
            console.log = originalLog;
            for (const key of Object.keys(f.files)) Config.FILES[key] = originals[key];
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('main 在分析结果或论文库中找不到论文时拒绝，不写不完整记录', () => {
        const f = fixture();
        const originals = {};
        for (const key of Object.keys(f.files)) {
            originals[key] = Config.FILES[key];
            Config.FILES[key] = f.files[key];
        }
        try {
            assert.throws(() => cli.main(['--date', DATE, '--paper-id', '2609.99999',
                '--reason', REASON]), /当前分析结果或论文库中找不到这篇论文/);
            assert.equal(fs.existsSync(path.join(f.files.analysisWaiverDir, `${DATE}.json`)), false);
        } finally {
            for (const key of Object.keys(f.files)) Config.FILES[key] = originals[key];
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });
});

describe('digest:waive-analysis 入口的理由检查与进程结果', () => {
    function useFixtureFiles(f) {
        const originals = {};
        for (const key of Object.keys(f.files)) {
            originals[key] = Config.FILES[key];
            Config.FILES[key] = f.files[key];
        }
        return () => {
            for (const key of Object.keys(f.files)) Config.FILES[key] = originals[key];
        };
    }

    it('理由按 trim 后的长度判定：恰好 10 个字符写入的是 trim 后的文本', () => {
        const f = fixture();
        const restore = useFixtureFiles(f);
        try {
            // 两侧各两个空格，trim 后正好 10 个字符，正落在门槛上。
            const payload = cli.main(['--date', DATE, '--paper-id', PAPER, '--reason', '  1234567890  ']);
            assert.equal(payload.reason, '1234567890');
            const output = path.join(f.files.analysisWaiverDir, `${DATE}.json`);
            const onDisk = JSON.parse(fs.readFileSync(output, 'utf8'));
            assert.equal(onDisk.reason, '1234567890');
            // 存的是 trim 后的理由，所以 SHA 也必须是按 trim 后重算的那个。
            const body = { ...onDisk };
            delete body.waiverSha256;
            assert.equal(onDisk.waiverSha256, waiver.stableSha256(body));

            // 少一个字符（trim 后 9 个）必须在写盘前就被拦下，目录里仍是刚才那一份。
            assert.throws(() => cli.main(['--date', DATE, '--paper-id', PAPER, '--reason', '  123456789  ']),
                /用法: --date YYYY-MM-DD/);
            assert.deepEqual(fs.readdirSync(f.files.analysisWaiverDir), [`${DATE}.json`]);
        } finally {
            restore();
            fs.rmSync(f.directory, { recursive: true, force: true });
        }
    });

    it('参数非法时进程退出码 1、stderr 带入口前缀、不写任何豁免文件', () => {
        const probeDate = '1999-01-01';
        const target = path.join(Config.FILES.analysisWaiverDir, `${probeDate}.json`);
        assert.equal(fs.existsSync(target), false, `测试前置：${target} 不该存在`);
        const env = { ...process.env };
        delete env.CODEX_SANDBOX;
        const result = spawnSync(process.execPath,
            [path.join(PROJECT, 'scripts', 'waive-analysis-failures.js'),
                '--date', probeDate, '--paper-id', PAPER, '--reason', '太短'],
            { cwd: PROJECT, env, encoding: 'utf8' });
        assert.equal(result.status, 1, `期望退出码 1，实际 ${result.status}：${result.stderr}`);
        assert.match(result.stderr, /^\[waive-analysis-failures\] /);
        assert.match(result.stderr, /用法: --date YYYY-MM-DD/);
        assert.equal(result.stdout, '', '失败时 stdout 不该有成功输出');
        assert.equal(fs.existsSync(target), false, '失败时留下了豁免文件');
    });
});
