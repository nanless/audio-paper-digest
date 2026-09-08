'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../scripts/lib/arxiv-metadata-source.js');

const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>
<id>http://arxiv.org/abs/2609.03622v1</id><updated>2026-09-04T00:00:00Z</updated>
<published>2026-09-04T00:00:00Z</published><title>Official title</title>
<summary>Official abstract with evidence.</summary><author><name>Author One</name></author>
<category term="cs.SD"/></entry></feed>`;

test('official Atom adapter uses mandatory proxy and returns source-only stable metadata proof', async () => {
    let requested = null;
    const result = await api.fetchOfficialArxivMetadata('2609.03622', {
        detectProxy: () => 'http://127.0.0.1:7897',
        fetchPapers: { hasApiResponseSignature: xml => xml.includes('<entry>'),
            parseArxivXML: () => Object.assign([{ arxivId: '2609.03622v1', title: 'Official title',
                abstract: 'Official abstract with evidence.', authors: ['Author One'], categories: ['cs.SD'],
                published: '2026-09-04T08:00:00+08:00' }], { _meta: { entryCount: 1, legalEntryCount: 1 } }) },
        requestFn: async (...args) => { requested = args; return { status: 200, data: atom }; }
        , now: () => '2026-09-05T00:00:00.000Z'
    });
    assert.match(requested[0], /export\.arxiv\.org\/api\/query\?id_list=2609\.03622/);
    assert.equal(requested[2], 'http://127.0.0.1:7897');
    assert.equal(result.metadata.fetchedAt, '2026-09-04T08:00:00+08:00');
    assert.equal(result.proof.contract, api.CONTRACT);
    assert.equal(result.proof.querySourceId, '2609.03622');
    assert.equal(result.proof.entryVersion, 1);
    assert.equal(result.proof.observedAt, '2026-09-05T00:00:00.000Z');
    assert.doesNotMatch(JSON.stringify(result.metadata), /analysis|apiReader|blog/i);
});

test('official Atom adapter binds an exact version query and rejects ambiguous raw identity fields', async () => {
    const versioned = api.parseOfficialArxivMetadataResponse('2609.03622', atom, {
        querySourceId: '2609.03622v1', hasSignature: () => true,
        parseXml: () => Object.assign([{ arxivId: '2609.03622v1', title: 'Official title',
            abstract: 'Official abstract with evidence.', authors: ['Author One'], categories: ['cs.SD'],
            published: '2026-09-04T00:00:00Z' }], { _meta: { entryCount: 1, legalEntryCount: 1 } })
    });
    assert.equal(versioned.proof.querySourceId, '2609.03622v1');
    assert.match(versioned.proof.sourceName, /id_list=2609\.03622v1/);
    assert.throws(() => api.parseOfficialArxivMetadataResponse('2609.03622', atom, {
        querySourceId: '2609x03622v1'
    }), /query source ID/);
    const duplicateId = atom.replace('</id>', '</id><id>http://arxiv.org/abs/2609.03622v9</id>');
    assert.throws(() => api.parseOfficialArxivMetadataResponse('2609.03622', duplicateId, {
        hasSignature: () => true,
        parseXml: () => Object.assign([{ arxivId: '2609.03622v1', title: 'Official title',
            abstract: 'Official abstract with evidence.', authors: ['Author One'], categories: ['cs.SD'],
            published: '2026-09-04T00:00:00Z' }], { _meta: { entryCount: 1, legalEntryCount: 1 } })
    }), /identity\/version\/timestamps/);
    const duplicateUpdated = atom.replace('</updated>', '</updated><updated>2026-09-05T00:00:00Z</updated>');
    assert.throws(() => api.parseOfficialArxivMetadataResponse('2609.03622', duplicateUpdated, {
        hasSignature: () => true,
        parseXml: () => Object.assign([{ arxivId: '2609.03622v1', title: 'Official title',
            abstract: 'Official abstract with evidence.', authors: ['Author One'], categories: ['cs.SD'],
            published: '2026-09-04T00:00:00Z' }], { _meta: { entryCount: 1, legalEntryCount: 1 } })
    }), /identity\/version\/timestamps/);
});

test('official Atom adapter fails closed without proxy or exact identity coverage', async () => {
    await assert.rejects(api.fetchOfficialArxivMetadata('2609.03622', { detectProxy: () => '' }), /proxy/);
    await assert.rejects(api.fetchOfficialArxivMetadata('2609.03622', {
        detectProxy: () => 'http://127.0.0.1:7897', requestFn: async () => ({ status: 200, data: atom }),
        fetchPapers: { hasApiResponseSignature: () => true,
            parseArxivXML: () => Object.assign([{ arxivId: '2609.99999', title: 'x', abstract: 'y', authors: [], categories: [], published: '2026-09-04T00:00:00Z' }],
                { _meta: { entryCount: 1, legalEntryCount: 1 } }) }
    }), /another paper/);
});

test('production-style Atom scheduling retries explicit 429 through one shared host queue', async () => {
    const statuses = [429, 200]; const hosts = [];
    const result = await api.fetchOfficialArxivMetadata('2609.03622', {
        detectProxy: () => 'http://127.0.0.1:7897',
        requestScheduler: { run: async (host, task) => { hosts.push(host); return task(); } },
        requestFn: async () => ({ status: statuses.shift(), data: atom }),
        fetchPapers: { hasApiResponseSignature: () => true,
            parseArxivXML: () => Object.assign([{ arxivId: '2609.03622v1', title: 'Official title',
                abstract: 'Official abstract with evidence.', authors: ['Author One'], categories: ['cs.SD'],
                published: '2026-09-04T08:00:00+08:00' }], { _meta: { entryCount: 1, legalEntryCount: 1 } }) }
    });
    assert.equal(result.metadata.arxivId, '2609.03622');
    assert.deepEqual(hosts, ['export.arxiv.org', 'export.arxiv.org']);
});

test('official Atom adapter retries bounded transport and 5xx failures before sealing data', async () => {
    const outcomes = [
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        { status: 503, data: 'temporarily unavailable' },
        { status: 200, data: atom }
    ];
    const hosts = [];
    const result = await api.fetchOfficialArxivMetadata('2609.03622', {
        detectProxy: () => 'http://127.0.0.1:7897',
        requestScheduler: { run: async (host, task) => { hosts.push(host); return task(); } },
        requestFn: async () => {
            const outcome = outcomes.shift();
            if (outcome instanceof Error) throw outcome;
            return outcome;
        },
        fetchPapers: { hasApiResponseSignature: () => true,
            parseArxivXML: () => Object.assign([{ arxivId: '2609.03622v1', title: 'Official title',
                abstract: 'Official abstract with evidence.', authors: ['Author One'], categories: ['cs.SD'],
                published: '2026-09-04T08:00:00+08:00' }], { _meta: { entryCount: 1, legalEntryCount: 1 } }) }
    });
    assert.equal(result.metadata.arxivId, '2609.03622');
    assert.deepEqual(hosts, ['export.arxiv.org', 'export.arxiv.org', 'export.arxiv.org']);
});

test('official Atom adapter exposes an exhausted socket failure as a typed retryable outcome', async () => {
    let calls = 0;
    await assert.rejects(api.fetchOfficialArxivMetadata('2609.03622', {
        detectProxy: () => 'http://127.0.0.1:7897',
        requestScheduler: { run: async (_host, task) => task() },
        requestFn: async () => {
            calls += 1;
            throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
    }), error => error.code === 'ARXIV_METADATA_NETWORK_TRANSIENT'
        && error.retryable === true && error.attempts === api.MAX_FETCH_ATTEMPTS);
    assert.equal(calls, 3);
    assert.equal(api.isTransientAtomFetchError(new TypeError('implementation bug')), false);
});
