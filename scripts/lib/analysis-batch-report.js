'use strict';

const path = require('node:path');
const Config = require('../config.js');
const { writeFileAtomic } = require('../utils.js');

// Operational diagnostics cannot certify content, release budget or authorize push.
function writeAnalysisBatchReport(report) {
    if (!/^[a-f0-9-]{36}$/.test(report.runId || '') || report.flow !== 'reader-refresh') {
        throw new TypeError('Invalid analysis batch diagnostic identity');
    }
    const filePath = path.join(Config.FILES.analysisBatchReportsDir, `${report.runId}.json`);
    writeFileAtomic(filePath, JSON.stringify({ ...report,
        contract: 'analysis-batch-diagnostics-v1', diagnosticOnly: true,
        newApiRequestsAuthorized: false, updatedAt: new Date().toISOString()
    }, null, 2), { mode: 0o600 });
    return filePath;
}

module.exports = { writeAnalysisBatchReport };
