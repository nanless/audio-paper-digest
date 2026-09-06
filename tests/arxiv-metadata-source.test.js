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
    });
    assert.match(requested[0], /export\.arxiv\.org\/api\/query\?id_list=2609\.03622/);
    assert.equal(requested[2], 'http://127.0.0.1:7897');
    assert.equal(result.metadata.fetchedAt, '2026-09-04T08:00:00+08:00');
    assert.equal(result.proof.contract, api.CONTRACT);
    assert.doesNotMatch(JSON.stringify(result.metadata), /analysis|apiReader|blog/i);
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
