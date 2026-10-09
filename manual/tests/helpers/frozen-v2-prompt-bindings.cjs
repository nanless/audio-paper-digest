const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REQUIRED_RECOVERY_STAGES, manualSha256 } = require('../../../scripts/analysis-contract.js');
const files = {
    primaryAnalysis: 'deep-analysis', openSourceScan: 'opensource-scan', revision: 'gap-fill',
    tableRepair: 'table-fill', methodRepair: 'method-fill', structureRepair: 'structure-repair',
    scoringAudit: 'scoring-audit', imageSupplement: 'image-supplement'
};
function expectedFrozenV2Bindings() {
    return Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
        const source = files[stage] ? `prompts/${files[stage]}-v2.md` : `manual-stage-contract:${stage}:v1`;
        const sha256 = files[stage]
            ? crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '../../..', source))).digest('hex')
            : manualSha256({ contract: 'manual-stage-contract-v1', stage });
        return [stage, { source, sha256 }];
    }));
}
module.exports = { expectedFrozenV2Bindings };
