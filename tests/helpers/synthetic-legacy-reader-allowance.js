'use strict';
// Historical-format fixture only. Never invokes the retired production grant
// API, installs authorization, or raises a runtime model-request limit.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const repair=require('../../scripts/lib/reader-repair');

function saveSyntheticLegacyAllowance({directory,fromIdentity,toIdentity,payload,runId,scope='fresh-run'}) {
    const temporaryRoot=fs.realpathSync(os.tmpdir());
    const relative=path.relative(temporaryRoot,path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Synthetic legacy allowance requires a test temporary directory');
    const oldFile=repair.saveFailedCandidate(directory,fromIdentity,payload),bytes=fs.readFileSync(oldFile);
    const envelope=JSON.parse(bytes),changedFields=[...new Set([...Object.keys(fromIdentity),...Object.keys(toIdentity)])]
        .filter(key=>repair.hashDraft(fromIdentity[key]??null)!==repair.hashDraft(toIdentity[key]??null)).sort();
    const implementationFields=new Set(['repairImplementationSha256','draftOrderImplementationSha256','sourceDiagnosticsImplementationSha256',
        'parserImplementationSha256','editorialImplementationSha256','mechanicalContractSha256','tableCompilerSha256','readerRecoveryEpochSha256']);
    const audit={contract:'reader-recovery-diagnostics-revision-v1',revisedAt:'2026-01-01T00:00:00.000Z',scope,
        runId:runId||toIdentity.freshAnalysis?.runId,paperId:toIdentity.paperId,
        fromIdentitySha256:repair.hashDraft(fromIdentity),toIdentitySha256:repair.hashDraft(toIdentity),changedFields,
        archivedName:repair.hashDraft(fromIdentity)+'.migrated-'+crypto.randomUUID()+'.json',
        oldPayloadSha256:envelope.payloadSha256,oldEnvelopeSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
        oldNoProgress:payload.noProgress,oldFailureSignature:payload.failureSignature,clearedNoProgress:false,
        attempts:payload.attempts,fullAttempts:payload.fullAttempts,transportFailures:payload.transportFailures??0,
        inputDraftSha256:repair.hashDraft(payload.draft),outputDraftSha256:repair.hashDraft(payload.draft)};
    const body={contract:repair.IMPLEMENTATION_ALLOWANCE_CONTRACT,fromIdentitySha256:audit.fromIdentitySha256,
        toIdentitySha256:audit.toIdentitySha256,oldPayloadSha256:audit.oldPayloadSha256,
        revisionAuditSha256:repair.hashDraft(audit),changedFields:changedFields.filter(k=>implementationFields.has(k))};
    if (!body.changedFields.length) throw new Error('Synthetic fixture needs a historical implementation change');
    fs.renameSync(oldFile,path.join(directory,audit.archivedName));
    const stored={...structuredClone(payload),readerRecoveryRevisions:[...(payload.readerRecoveryRevisions||[]),audit],
        implementationRepairAllowanceLineage:'reader-implementation-repair-lineage-v1',
        implementationRepairAllowanceProof:{...body,allowanceSha256:repair.hashDraft(body)}};
    repair.saveFailedCandidate(directory,toIdentity,stored);
    return {payload:repair.loadFailedCandidate(directory,toIdentity),testOnlySyntheticHistoricalFormat:true};
}
module.exports={saveSyntheticLegacyAllowance};
