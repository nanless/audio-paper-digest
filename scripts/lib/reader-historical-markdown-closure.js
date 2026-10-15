'use strict';
// Only these exact pure declarations from the original Git blob may execute.
// SHA allowlist was measured from cba0e47ae170b52a9dc42f2364297289c8174ec1;
// never use the current analysis-contract exports to impersonate that program.
const crypto = require('node:crypto');
const vm = require('node:vm');
const CONTRACT = 'reader-historical-markdown-pure-closure-v1';
const declarations = Object.freeze({
    TABLE_IDENTIFIER_HEADER_RE: 'd81099dc40d53610a2fdfac94f54cafbc911a6e78f83c0c3a0ae48f6a4394c81',
    TABLE_DIRECTION_MARK_RE: '56bc82045adddf2a970ca72dc76aeb9a3fb9b2cc1fd77f9663e506dad350c599',
    TABLE_DIRECTIONAL_METRIC_RE: 'a8acb0522c0c0d49b8173c2394f3cc600e725e842fdb1e1f1410b939117ee3cc',
    TABLE_GENERIC_METRIC_HEADER_RE: '6525279cb6b38002cf2bf1f40803e969d8bdf611906a2a8113b11c9e3379caab',
    TABLE_STRONG_IDENTITY_HEADER_RE: '20c19ccb323fc3c0a49f313c2e57c6641c7b6c0a2b0523f785ed32dda9893585',
    TABLE_ADDITIONAL_IDENTIFIER_HEADER_RE: '9b856e670c5bf18fcc3d9a39d47843518660f8bfdfb67241b4d0dfde12f5e5c8',
    isTableIdentifierHeader: '26d6ab0c797944ef219454d801d230025cba501bc753d8742fc2924ab4ec1e23',
    splitMarkdownTableRow: '3e8a34180bed8396c7ae793328e950aad3e3c37037403fe480490196c1278bc4',
    isMarkdownTableSeparator: '36f5a358ed88bbe206a60249a4e0f41a90bcff516a8c74d4a2ec64400b62e4a0',
    maskMarkdownCodeSpanParagraph: 'fb6a1eaa5416780079da0a5c2b8853e30d400bb84d565858423543515b7d24f8',
    maskProtectedMarkdownTableRegions: 'f786c54bdfc9e004451b3e1e716095008753c268fba5e33828ff5b16ea1931e2',
    maskInlineMarkdownCodeSpans: '310ef063bd100b36fe321f513ad65bbd0e6588152f1d16e5098dafdb5d6d99b5',
    extractMarkdownTables: '15e1d777b9cd7acd20c162ccceb3521120578f0bc57fdcaf574230c70aeceab0'
});
const exportsList = Object.freeze(['extractMarkdownTables', 'maskProtectedMarkdownTableRegions', 'maskInlineMarkdownCodeSpans']);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function loadHistoricalMarkdownClosure(record) {
    if (record?.path !== 'scripts/analysis-contract.js' || !Buffer.isBuffer(record.bytes)
        || sha(record.bytes) !== record.sha256) return null;
    const source = record.bytes.toString('utf8');
    if (!Buffer.from(source).equals(record.bytes)) return null;
    const parts = [], evidence = [];
    for (const [name, expected] of Object.entries(declarations)) {
        // Top-level boundaries only: nested function/regexp braces are indented.
        // Hashing the entire selected declaration rejects boundary ambiguity,
        // extra statements, altered references, and any new require/import.
        const pattern = name.startsWith('TABLE_')
            ? new RegExp(`^const ${name} = [^\\n]+\\n`, 'gm')
            : new RegExp(`^function ${name}\\([^\\n]*\\{\\n[\\s\\S]*?^}\\n`, 'gm');
        const matches = [...source.matchAll(pattern)];
        if (matches.length !== 1 || sha(matches[0][0]) !== expected) return null;
        const match = matches[0], startByte = Buffer.byteLength(source.slice(0, match.index));
        parts.push(match[0]);
        evidence.push({ name, startByte, endByte: startByte + Buffer.byteLength(match[0]), sha256: expected });
    }
    const code = parts.join('\n');
    // No module loader, process, filesystem or network capability is supplied.
    // This context is defense in depth: the executable bytes are allowlisted.
    const api = vm.runInNewContext(`'use strict';\n${code}\nObject.freeze({${exportsList.join(',')}});`,
        Object.create(null), { filename: 'historical-markdown-pure-closure.js', timeout: 1000,
            contextCodeGeneration: { strings: false, wasm: false } });
    return { api, proof: { contract: CONTRACT, sourceBlobOid: record.blobOid, sourceSha256: record.sha256,
        closureSha256: sha(code), exports: [...exportsList], declarations: evidence } };
}
module.exports = { CONTRACT, loadHistoricalMarkdownClosure };
