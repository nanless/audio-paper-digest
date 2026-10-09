'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { formatErrorSummary } = require('../scripts/log-setup.js');

const root = path.resolve(__dirname, '..');

test('真实元数据 CLI 同时报告并发故障及各自原因，并遮住无标签密钥', t => {
    const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'metadata-diagnostics-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const project = path.join(directory, 'project');
    const modules = [
        'scripts/historical-arxiv-publication-metadata.js', 'scripts/log-setup.js',
        'scripts/env-loader.js', 'scripts/workspace-role.js', 'scripts/config.js',
        'scripts/lib/historical-conference-page-projections.js',
        'scripts/lib/historical-direct-rewrite-plan.js',
        'scripts/lib/historical-arxiv-publication-metadata.js',
        'scripts/lib/arxiv-metadata-source.js'
    ];
    for (const relative of modules) {
        const target = path.join(project, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(root, relative), target);
    }
    require('../scripts/workspace-role.js').writeWorkspaceRole('history', { root: project });
    const preload = path.join(directory, 'preload.cjs');
    const fakeSecret = 'fake_unlabelled_metadata_secret_123456';
    const source = `
        const path = require('node:path');
        const root = ${JSON.stringify(project)};
        const directory = ${JSON.stringify(directory)};
        function substitute(relative, exports) {
            const filename = require.resolve(path.join(root, relative));
            require.cache[filename] = { id: filename, filename, loaded: true, exports };
        }
        const ids = ['2601.00001', '2601.00002'];
        substitute('scripts/config.js', { FILES: {
            historicalArxivPublicationMetadataDir: directory,
            freshArxivFetchedSourcesDir: directory,
            freshRewriteRunsDir: directory
        } });
        substitute('scripts/lib/historical-conference-page-projections.js', {
            readStableJson: () => ({ value: { queue: ids.map(arxivId => ({
                route: { kind: 'arxiv-fresh-fetch', arxivId }
            })) } })
        });
        substitute('scripts/lib/historical-direct-rewrite-plan.js', { normalizePlan: value => value });
        substitute('scripts/lib/historical-arxiv-publication-metadata.js', {
            sidecarDirectory: (_, id) => path.join(directory, id),
            reusableOfficialAtomIndex: () => new Map(),
            querySourceIdForSource: options => options.arxivId
        });
        substitute('scripts/lib/arxiv-metadata-source.js', {
            fetchOfficialArxivMetadata: async id => {
                await new Promise(resolve => setImmediate(resolve));
                const cause = new Error(id === ids[0]
                    ? '第一个底层原因 ' + process.env.METADATA_TEST_API_KEY
                    : '第二个底层原因 Authorization: Bearer fake_header_secret_789');
                throw new Error(id === ids[0] ? '第一个封存故障' : '第二个封存故障', { cause });
            }
        });
    `;
    fs.writeFileSync(preload, source, { mode: 0o600 });
    const result = spawnSync(process.execPath, ['-r', preload,
        path.join(project, 'scripts/historical-arxiv-publication-metadata.js'),
        '--apply', '--plan', path.join(directory, 'plan.json'), '--generation', '1', '--concurrency', '2'], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, METADATA_TEST_API_KEY: fakeSecret, PD_DISABLE_FILE_LOGS: '1' }
    });
    assert.equal(result.status, 1, result.stderr);
    for (const text of ['第一个封存故障', '第二个封存故障', '第一个底层原因', '第二个底层原因']) {
        assert.ok(result.stderr.includes(text), result.stderr);
    }
    assert.ok(result.stderr.includes('[REDACTED]'));
    assert.equal(result.stderr.includes(fakeSecret), false);
    assert.equal(result.stderr.includes('fake_header_secret_789'), false);
});

test('错误摘要限制循环和过长内容，先脱敏再截断', () => {
    const secret = 'fake_diagnostic_secret_0123456789';
    const previous = process.env.DIAGNOSTIC_TEST_API_KEY;
    process.env.DIAGNOSTIC_TEST_API_KEY = secret;
    try {
        const originalCause = new Error('原始底层原因');
        const first = new Error('a'.repeat(4085) + secret, { cause: originalCause });
        const failure = new AggregateError([first, new Error('另一个故障')], '汇总故障', { cause: first });
        originalCause.cause = failure;
        const summary = formatErrorSummary(failure);
        assert.equal(summary.includes(secret), false);
        assert.equal(summary.includes('fake_diagnostic'), false);
        assert.ok(summary.includes('原始底层原因'));
        assert.ok(summary.includes('另一个故障'));
        assert.equal(failure.cause, first);
        assert.equal(first.cause, originalCause);
        assert.ok(summary.length <= 16384);
        assert.ok(formatErrorSummary(new AggregateError(
            Array.from({ length: 100 }, () => new Error('长'.repeat(5000))), '多个故障'
        )).length <= 16384);
    } finally {
        if (previous === undefined) delete process.env.DIAGNOSTIC_TEST_API_KEY;
        else process.env.DIAGNOSTIC_TEST_API_KEY = previous;
    }
});
