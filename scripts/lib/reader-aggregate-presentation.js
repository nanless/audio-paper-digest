'use strict';

// Display transport only. Callers independently qualify their actual source,
// completion records, membership and page receipts before invoking this bridge.
const path = require('node:path');
const pageApi = require('./publication-file-primitives.js');
const { runPythonJsonPacket } = require('./python-json-packet-bridge.js');

function renderReaderAggregatePresentations(records, dependencies = {}) {
    if (!Array.isArray(records) || !records.length
        || records.some(item => !item || typeof item.paperKey !== 'string' || !item.paperKey)
        || new Set(records.map(item => item.paperKey)).size !== records.length) {
        throw new Error('汇总展示需要非空且身份唯一的完整记录列表。');
    }
    const render = dependencies.render || (packet => pageApi.strictJson(runPythonJsonPacket(packet, {
        script: path.join(__dirname, '..', 'conference-page-render.py'),
        inputFlag: '--packet-file', prefix: 'reader-aggregate-display-', cleanup: 'recursive'
    }), 'aggregate Reader display output'));
    const output = [];
    for (let start = 0; start < records.length;) {
        const batch = [];
        while (start + batch.length < records.length && batch.length < 8) {
            const candidate = [...batch, records[start + batch.length]];
            if (Buffer.byteLength(JSON.stringify({ aggregatePresentationBatch: candidate })) > 64 * 1024 * 1024) {
                if (!batch.length) throw new Error('单篇汇总展示输入超过既有64MiB传输上限。');
                break;
            }
            batch.push(records[start + batch.length]);
        }
        const result = render({ aggregatePresentationBatch: batch });
        if (!result || Object.keys(result).join(',') !== 'readerPresentations'
            || !Array.isArray(result.readerPresentations) || result.readerPresentations.length !== batch.length) {
            throw new Error('汇总展示批次未返回完整且精确的显示结果。');
        }
        for (const [index, item] of result.readerPresentations.entries()) {
            if (!item || Object.keys(item).sort().join(',') !== 'paperKey,resourceBlock,scoreLine,scoringBlock,summary'
                || item.paperKey !== batch[index].paperKey
                || ['summary', 'resourceBlock', 'scoringBlock', 'scoreLine'].some(field =>
                    typeof item[field] !== 'string' || !item[field].trim())) {
                throw new Error('汇总展示的逐篇身份或摘要、资源、评分结果不完整。');
            }
            output.push(item);
        }
        start += batch.length;
    }
    return output;
}

module.exports = { renderReaderAggregatePresentations };
