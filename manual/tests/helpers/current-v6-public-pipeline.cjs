'use strict';
// 已退作者流水线留下的原始测试输出，只读解压并核验固定字节 SHA。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const FIXTURE_LIMIT = 200000;
const RAW_SHA = {
    canonical: '979461621e0c8d26ce0669454842c24776b582f38244174ec4a9d0d2bb125bb4',
    authorDraft: 'd1559150178e4a00ca7f4de9ecb5def0fe76683f8a85ad292da4b9a0294d901e',
    fulltext: 'ca7064b133f003e4c9ed673df2267d12e14efe979792c99a06c8532607daae36'
};
function bytesSha(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function savedBytes(name) {
    const fixturePath = path.join(__dirname, '..', 'fixtures', 'native-v6-current-public-control.json');
    const envelope = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    assert.equal(envelope.encoding, 'gzip-base64');
    const entry = envelope.files[name];
    assert.equal(entry.rawSha256, RAW_SHA[name], '原始公开输出的固定 SHA 不符');
    const compressed = Buffer.from(entry.gzipBase64, 'base64');
    assert.ok(compressed.length < 30000, '压缩资料大小超过测试限制');
    assert.ok(entry.rawBytes <= FIXTURE_LIMIT, '解压后资料大小超过测试限制');
    const bytes = zlib.gunzipSync(compressed, {
        maxOutputLength: FIXTURE_LIMIT
    });
    assert.equal(bytes.length, entry.rawBytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.rawSha256);
    return bytes;
}

module.exports = { savedBytes };
