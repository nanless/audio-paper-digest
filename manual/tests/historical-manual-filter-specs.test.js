const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const archivePath = path.join(__dirname, 'fixtures', 'historical-manual-filter-specs.json');
const archive = JSON.parse(fs.readFileSync(archivePath, 'utf8'));

// This immutable fixture replaces the former date-specific generators for
// 2026-08-20, 2026-08-25, and 2026-08-27. Keep replaying every candidate and
// the exact original spec bytes; never restore hard-coded production scripts.

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function negativeReason(kind, title) {
    if (kind === 'legacy-object-task-v1') {
        return `人工逐篇核对《${title}》的标题、摘要、类别和来源；研究对象/任务不属于本期音频、语音、音乐、声学、听觉或音频多模态主题，故 related=false。`;
    }
    if (kind === 'explicit-core-task-v1') {
        return `人工逐篇核对《${title}》的标题、摘要、类别和来源；其研究对象或核心任务不属于本期音频、语音、音乐、声学、听觉或音频多模态主题，故 related=false。`;
    }
    throw new Error(`未知 negativeReasonKind: ${kind}`);
}

function reconstructSpec(entry) {
    const decisions = {};
    for (const [id, title] of entry.candidates) {
        const related = Object.prototype.hasOwnProperty.call(entry.selectedReasons, id);
        decisions[id] = {
            related,
            reason: related
                ? entry.selectedReasons[id]
                : negativeReason(entry.negativeReasonKind, title),
            reviewedFields: archive.reviewedFields
        };
    }
    return {
        version: 1,
        mode: 'manual_offline',
        date: entry.date,
        reviewer: entry.reviewer,
        reviewedAt: entry.reviewedAt,
        reviewProtocol: entry.reviewProtocol,
        candidateCount: entry.candidateCount,
        curatedRelatedIds: Object.keys(entry.selectedReasons),
        decisions
    };
}

describe('immutable historical Manual filter archives', () => {
    it('reconstructs every candidate decision and the exact original spec bytes', () => {
        assert.equal(archive.version, 1);
        assert.equal(archive.contract, 'historical-manual-filter-spec-archive-v1');
        assert.deepEqual(archive.reviewedFields, ['title', 'abstract', 'categories', 'sources']);
        assert.deepEqual(archive.entries.map(entry => entry.date), [
            '2026-08-20',
            '2026-08-25',
            '2026-08-27'
        ]);

        for (const entry of archive.entries) {
            const ids = entry.candidates.map(([id]) => id);
            assert.equal(ids.length, entry.candidateCount, `${entry.date} candidateCount`);
            assert.equal(new Set(ids).size, ids.length, `${entry.date} candidate IDs must be unique`);
            assert.equal(
                sha256(JSON.stringify(ids)),
                entry.sourceEvidence.candidateIdsSha256,
                `${entry.date} candidate ID projection`
            );

            const selectedIds = Object.keys(entry.selectedReasons);
            assert.ok(selectedIds.length > 0, `${entry.date} must retain positive reasons`);
            assert.deepEqual(
                selectedIds.filter(id => !ids.includes(id)),
                [],
                `${entry.date} selected IDs must belong to the candidate set`
            );

            const spec = reconstructSpec(entry);
            assert.equal(Object.keys(spec.decisions).length, entry.candidateCount);
            assert.deepEqual(
                Object.entries(spec.decisions)
                    .filter(([, decision]) => decision.related)
                    .map(([id]) => id)
                    .sort(),
                [...selectedIds].sort(),
                `${entry.date} related set`
            );

            for (const [id, decision] of Object.entries(spec.decisions)) {
                assert.equal(typeof decision.related, 'boolean', `${entry.date}/${id} related`);
                assert.ok(decision.reason.length >= 20, `${entry.date}/${id} reason`);
                assert.deepEqual(
                    decision.reviewedFields,
                    ['title', 'abstract', 'categories', 'sources'],
                    `${entry.date}/${id} reviewedFields`
                );
            }

            const projection = Object.entries(spec.decisions).map(([id, decision]) => [
                id,
                decision.related,
                decision.reason,
                decision.reviewedFields
            ]);
            assert.equal(
                sha256(JSON.stringify(projection)),
                entry.sourceEvidence.decisionProjectionSha256,
                `${entry.date} complete decision projection`
            );
            assert.equal(
                sha256(JSON.stringify(spec, null, 2)),
                entry.sourceEvidence.manualFilterSpecSha256,
                `${entry.date} exact original manual_offline spec`
            );
            for (const [key, value] of Object.entries(entry.sourceEvidence)) {
                assert.match(value, /^[a-f0-9]{64}$/, `${entry.date}/${key}`);
            }
        }
    });

    it('does not retain executable date-specific production generators', () => {
        for (const entry of archive.entries) {
            const fileName = `create-${entry.date}-manual-filter-spec.js`;
            const generators = [
                path.join(__dirname, '..', 'scripts', fileName),
                path.join(__dirname, '..', '..', 'scripts', fileName)
            ];
            for (const generator of generators) {
                assert.equal(fs.existsSync(generator), false, generator);
            }
        }
    });

    it('matches retained local runtime source snapshots when they are available', (t) => {
        const repositoryRoot = path.join(__dirname, '..', '..');
        let verified = 0;
        for (const entry of archive.entries) {
            const archiveRoot = path.join(repositoryRoot, 'data', 'archive', entry.date);
            const currentRoot = path.join(repositoryRoot, 'data', 'current');
            const roots = [archiveRoot, currentRoot];
            const sourceRoot = roots.find(root => {
                const rawPath = path.join(root, 'raw-candidates.json');
                const filterPath = path.join(root, 'filter-decisions.json');
                if (!fs.existsSync(rawPath) || !fs.existsSync(filterPath)) return false;
                try {
                    return JSON.parse(fs.readFileSync(rawPath, 'utf8')).batchDate === entry.date;
                } catch {
                    return false;
                }
            });
            const specPath = path.join(currentRoot, `manual-filter-spec-${entry.date}.json`);
            if (!sourceRoot || !fs.existsSync(specPath)) continue;

            const rawBytes = fs.readFileSync(path.join(sourceRoot, 'raw-candidates.json'));
            const filterBytes = fs.readFileSync(path.join(sourceRoot, 'filter-decisions.json'));
            const specBytes = fs.readFileSync(specPath);
            assert.equal(sha256(rawBytes), entry.sourceEvidence.rawCandidatesSha256, `${entry.date} raw source`);
            assert.equal(sha256(filterBytes), entry.sourceEvidence.filterDecisionsSha256, `${entry.date} filter source`);
            assert.equal(sha256(specBytes), entry.sourceEvidence.manualFilterSpecSha256, `${entry.date} spec source`);

            const runtimeDecisions = JSON.parse(filterBytes).decisions;
            const reconstructed = reconstructSpec(entry);
            for (const [id, decision] of Object.entries(reconstructed.decisions)) {
                assert.equal(runtimeDecisions[id]?.related, decision.related, `${entry.date}/${id} runtime related`);
                assert.equal(runtimeDecisions[id]?.reason, decision.reason, `${entry.date}/${id} runtime reason`);
                assert.deepEqual(
                    runtimeDecisions[id]?.reviewedFields,
                    decision.reviewedFields,
                    `${entry.date}/${id} runtime reviewedFields`
                );
            }
            verified += 1;
        }
        if (verified === 0) t.skip('gitignored runtime snapshots are not present in this checkout');
    });
});
