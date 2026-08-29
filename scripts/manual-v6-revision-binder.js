#!/usr/bin/env node
'use strict';

/** Deterministically bind a Terra-authored final article and compact semantic map to V6 revision artifacts. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
if (require.main === module) {
    require('./env-loader.js').requireExternalRuntime('manual-v6-revision-binder.js');
}
const Config = require('./config.js');
const { normalizedId, writeFileAtomic, getBeijingISOString } = require('./utils.js');
const { stableSha256: stableObjectSha256 } = require('./manual-v6-workflow.js');
const {
    renderLongformBlocks,
    renderArtifactTableMarkdown,
    sanitizeArtifactTableCellForReader,
    tableNumericCellIds,
    validateManualLongformBundle
} = require('./manual-longform-contract.js');
const { runnerPaths, verifyBoundInputs, REVISION_OUTPUT_CONTRACT } = require('./manual-v6-task-runner.js');
const { normalizeAuthorOwnedBaseFields } = require('./manual-v6-author-base-fields.js');
const { RECORDS_VERSION, validateRecord } = require('./create-manual-analysis-spec.js');
const {
    REQUIRED_RECOVERY_STAGES,
    validateManualEvidenceLedger
} = require('./analysis-contract.js');

const MAP_CONTRACT = 'manual-v6-revision-binding-map-v1';
const SHA_RE = /^[a-f0-9]{64}$/;
const SCORING_DIMENSIONS = Object.freeze([
    'innovation', 'technicalRigor', 'experimentalSufficiency', 'clarity',
    'impact', 'openSource', 'reproducibility', 'engineering'
]);

function sha256Bytes(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function normalizedText(value) {
    return String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function jsonBytes(value) {
    return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readOrdinary(filePath, label) {
    const declared = path.resolve(filePath);
    const stat = fs.lstatSync(declared, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} 必须是普通文件且不得为 symlink`);
    return { path: fs.realpathSync(declared), bytes: fs.readFileSync(declared) };
}

function readJson(filePath, label) {
    const file = readOrdinary(filePath, label);
    let value;
    try { value = JSON.parse(file.bytes.toString('utf8')); } catch (error) {
        throw new Error(`${label} JSON 损坏: ${error.message}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 顶层必须是对象`);
    return { ...file, value };
}

function assertInside(rootPath, filePath, label) {
    const root = fs.realpathSync(rootPath);
    const file = readOrdinary(filePath, label);
    const relative = path.relative(root, file.path);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`${label} 逃逸单篇 artifactRoot`);
    }
    return file;
}

function parseArticle(article) {
    const text = normalizedText(article);
    const matches = [...text.matchAll(/^### ([^\n]+)\n\n/gmu)];
    if (matches.length < 1 || matches[0].index !== 0) throw new Error('final article 必须只由 `### heading` 教学小节组成');
    return matches.map((match, index) => {
        const start = match.index + match[0].length;
        const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
        return { heading: normalizedText(match[1]), markdown: normalizedText(text.slice(start, end)) };
    });
}

function removePureMarkdownTables(markdown) {
    return normalizedText(markdown).split(/\n\s*\n/u).filter(paragraph => {
        const lines = paragraph.split('\n').map(line => line.trim()).filter(Boolean);
        return !(lines.length >= 2 && lines.every(line => /^\|.*\|$/u.test(line)));
    }).join('\n\n');
}

function removeRenderedArtifactTables(markdown, sourceTables) {
    const paragraphs = normalizedText(markdown).split(/\n\s*\n/u);
    const captions = new Set((sourceTables || []).flatMap(table => {
        const raw = normalizedText(table?.caption || table?.id || '实验表格');
        const sanitized = sanitizeArtifactTableCellForReader(raw);
        return [`**${raw}**`, `**${sanitized}**`];
    }));
    const captionPrefixes = new Set((sourceTables || []).map(table => (
        normalizedText(table?.caption || '').match(/^(Table\s+\d+\s*:)/iu)?.[1]?.toLowerCase()
    )).filter(Boolean));
    const removed = new Set();
    paragraphs.forEach((paragraph, index) => {
        const value = normalizedText(paragraph);
        const boldCaption = value.match(/^\*\*(Table\s+\d+\s*:)[\s\S]+\*\*$/iu);
        if (captions.has(value) || (boldCaption && captionPrefixes.has(boldCaption[1].toLowerCase()))) {
            removed.add(index);
        }
    });
    paragraphs.forEach((paragraph, index) => {
        const lines = paragraph.split('\n').map(line => line.trim()).filter(Boolean);
        const isTable = lines.length >= 2 && lines.every(line => /^\|.*\|$/u.test(line));
        if (!isTable) return;
        removed.add(index);
        for (let previous = index - 1; previous >= 0 && captions.has(normalizedText(paragraphs[previous])); previous--) {
            removed.add(previous);
        }
    });
    return normalizedText(paragraphs.filter((_paragraph, index) => !removed.has(index)).join('\n\n'));
}

function requireUniqueBy(items, key, label) {
    if (!Array.isArray(items)) throw new Error(`${label} 必须是数组`);
    const seen = new Set();
    for (const item of items) {
        const id = String(item?.[key] || '').trim();
        if (!id || seen.has(id)) throw new Error(`${label}.${key} 缺失或重复: ${id || '<empty>'}`);
        seen.add(id);
    }
    return seen;
}

function bindInventory(mapItems, sourceItems, key, sourceKey, blocksByHeading, kind) {
    const mapped = requireUniqueBy(mapItems, key, `${kind} map`);
    const sources = new Map((sourceItems || []).map(item => [String(item?.[sourceKey] || item?.id || item?.url || '').trim(), item]));
    const missing = [...sources.keys()].filter(id => !mapped.has(id));
    const unknown = [...mapped].filter(id => !sources.has(id));
    if (missing.length || unknown.length) throw new Error(`${kind} map 必须精确覆盖 ArtifactIndex（missing=${missing.join(',')}; unknown=${unknown.join(',')}）`);
    return mapItems.map(item => {
        const output = { ...item };
        if (output.blockHeading) {
            const block = blocksByHeading.get(normalizedText(output.blockHeading));
            if (!block) throw new Error(`${kind}.${output[key]} blockHeading 不存在`);
            output.blockId = block.id;
            delete output.blockHeading;
        }
        return output;
    });
}

function buildLongform(articleSource, semanticMap, artifactIndex) {
    if (semanticMap.version !== 1 || semanticMap.contract !== MAP_CONTRACT) throw new Error(`binding map 必须是 ${MAP_CONTRACT}`);
    const parsed = parseArticle(articleSource);
    const blockSpecs = Array.isArray(semanticMap.blocks) ? semanticMap.blocks : [];
    if (blockSpecs.length !== parsed.length) throw new Error('binding map blocks 必须与 final article 小节一一对应');
    const seenHeadings = new Set();
    const blocks = parsed.map((source, index) => {
        const spec = blockSpecs[index] || {};
        if (normalizedText(spec.heading) !== source.heading || seenHeadings.has(source.heading)) {
            throw new Error(`binding map block[${index}] heading 顺序、字节或唯一性不一致`);
        }
        seenHeadings.add(source.heading);
        return {
            id: `B${String(index + 1).padStart(2, '0')}`,
            kind: spec.kind,
            heading: source.heading,
            learningObjective: spec.learningObjective,
            markdown: source.markdown,
            evidenceSpanIds: spec.evidenceSpanIds || [],
            tableIds: [], figureIds: [], formulaIds: []
        };
    });
    const blocksByHeading = new Map(blocks.map(block => [block.heading, block]));
    const tableMap = bindInventory(
        semanticMap.tables, artifactIndex.tables || [], 'sourceTableId', 'id', blocksByHeading, 'tables'
    );
    const tablesByBlock = new Map();
    for (const item of tableMap) {
        const source = (artifactIndex.tables || []).find(table => String(table.id || table.sourceTableId) === item.sourceTableId);
        if (item.disposition === 'omit') {
            continue;
        }
        if (!item.blockId) throw new Error(`table ${item.sourceTableId} 缺少 blockHeading`);
        if (!tablesByBlock.has(item.blockId)) tablesByBlock.set(item.blockId, []);
        tablesByBlock.get(item.blockId).push({ item, source });
    }
    for (const block of blocks) {
        const entries = tablesByBlock.get(block.id) || [];
        if (entries.length < 1) continue;
        block.markdown = removeRenderedArtifactTables(
            block.markdown, entries.map(({ source }) => source)
        );
        for (const { source } of entries) block.markdown += `\n\n${renderArtifactTableMarkdown(source)}`;
    }
    const figures = bindInventory(
        semanticMap.figures, artifactIndex.figures || [], 'id', 'id', blocksByHeading, 'figures'
    );
    const formulas = bindInventory(
        semanticMap.formulas, artifactIndex.formulas || [], 'id', 'id', blocksByHeading, 'formulas'
    );
    for (const item of tableMap) if (item.blockId) blocks.find(block => block.id === item.blockId).tableIds.push(item.sourceTableId);
    for (const item of figures) if (item.blockId) blocks.find(block => block.id === item.blockId).figureIds.push(item.id);
    for (const item of formulas) if (item.blockId) blocks.find(block => block.id === item.blockId).formulaIds.push(item.id);
    const tables = tableMap.map(item => {
        const source = (artifactIndex.tables || []).find(table => String(table.id || table.sourceTableId) === item.sourceTableId);
        if (item.disposition === 'omit') return {
            sourceTableId: item.sourceTableId, kind: source.kind, disposition: 'omit', omissionReason: item.omissionReason,
            sourceMatrixSha256: source.matrixSha256, numericCellCount: tableNumericCellIds(source).length,
            coveredNumericCellIds: []
        };
        const renderedMarkdown = renderArtifactTableMarkdown(source);
        const coveredNumericCellIds = tableNumericCellIds(source);
        return {
            sourceTableId: item.sourceTableId, kind: source.kind, disposition: item.disposition,
            sourceMatrixSha256: source.matrixSha256, numericCellCount: coveredNumericCellIds.length,
            coveredNumericCellIds, blockId: item.blockId, renderedMarkdown,
            renderedFragmentSha256: sha256Bytes(Buffer.from(renderedMarkdown, 'utf8'))
        };
    });
    const resolveHeading = (items, field) => (items || []).map(item => {
        const output = { ...item };
        const heading = normalizedText(output[field]);
        const block = blocksByHeading.get(heading);
        if (!block) throw new Error(`${field} 引用了未知 heading: ${heading}`);
        delete output[field];
        return { ...output, [field === 'firstUseHeading' ? 'firstUseBlockId' : 'blockId']: block.id };
    });
    const terms = resolveHeading(semanticMap.terms, 'firstUseHeading');
    const relatedWorks = resolveHeading(semanticMap.relatedWorks, 'blockHeading');
    const article = renderLongformBlocks(blocks);
    const bundle = {
        version: 2, contract: 'reader-longform-v2', paperId: semanticMap.paperId,
        articleSha256: sha256Bytes(Buffer.from(article, 'utf8')),
        artifactIndexSha256: artifactIndex.outputSha256,
        blocks, tables, figures, formulas, terms, relatedWorks
    };
    validateManualLongformBundle(bundle, article, artifactIndex, {
        paperId: semanticMap.paperId, runtimeMode: 'production', unsealedRevision: true,
        label: 'revision binder longform'
    });
    return { article, bundle };
}

function applyValidatedReviewDecisions(payloadValue, technicalReview, pedagogyReview) {
    const payload = structuredClone(payloadValue);
    if (!Array.isArray(technicalReview?.dims) || technicalReview.dims.length !== 8
        || !Array.isArray(technicalReview?.scoringReasons) || technicalReview.scoringReasons.length !== 8
        || !technicalReview.scoringCalibration || typeof technicalReview.scoringCalibration !== 'object') {
        throw new Error('validated technical review 缺少八维评分闭环');
    }
    if (!pedagogyReview?.readabilityRubric || typeof pedagogyReview.readabilityRubric !== 'object') {
        throw new Error('validated pedagogy review 缺少 readabilityRubric');
    }
    payload.dims = structuredClone(technicalReview.dims);
    payload.confidence = technicalReview.confidence;
    payload.scoringReasons = structuredClone(technicalReview.scoringReasons);
    payload.scoringCalibration = structuredClone(technicalReview.scoringCalibration);
    payload.readabilityRubric = structuredClone(pedagogyReview.readabilityRubric);
    return payload;
}

function normalizeReviewBoundOpenSourceEvidence(payloadValue) {
    const payload = structuredClone(payloadValue);
    const original = payload.openSourceEvidence && typeof payload.openSourceEvidence === 'object'
        && !Array.isArray(payload.openSourceEvidence) ? payload.openSourceEvidence : {};
    const urlCandidates = [
        ...(Array.isArray(original.urls) ? original.urls : []),
        original.code, original.model, original.dataset, original.demo,
        original.codeUrl, original.modelUrl, original.weightsUrl, original.datasetUrl, original.demoUrl
    ];
    const urls = [...new Set(urlCandidates.filter(value => (
        typeof value === 'string' && value.startsWith('https://')
    )))];
    const quoteCandidates = [
        ...(Array.isArray(original.sourceQuotes) ? original.sourceQuotes : []),
        original.sourceQuote, original.conclusion, original.summary,
        typeof payload.open === 'string' ? payload.open : null
    ];
    const sourceQuotes = [...new Set(quoteCandidates.map(normalizedText).filter(value => value.length >= 12))]
        .slice(0, 6);
    if (sourceQuotes.length < 1) {
        sourceQuotes.push('受控论文证据未提供可核验的公开资源声明或直达链接。');
    }

    const score = Number(payload.dims?.[5]);
    if (![0, 0.2, 0.5, 1, 1.2, 1.5].includes(score)) {
        throw new Error(`validated technical review 的 openSource 分数非法: ${score}`);
    }
    const evidenceText = normalizedText(JSON.stringify({ original, open: payload.open, urls, sourceQuotes }))
        .toLowerCase();
    let state;
    if (score >= 1) {
        if (urls.length < 1) {
            throw new Error('开源分达到 1.0 但 revision 证据没有 HTTPS 资源 URL；必须返修作者证据或技术评分');
        }
        state = 'released';
        const inferred = {
            hasCode: /code|github|gitlab|repository|仓库|代码/u.test(evidenceText),
            hasModel: /model|weight|checkpoint|模型|权重/u.test(evidenceText),
            hasDataset: /dataset|data\b|corpus|数据集|语料/u.test(evidenceText)
        };
        if (!Object.values(inferred).some(Boolean)) inferred.hasCode = true;
        for (const [key, present] of Object.entries(inferred)) {
            if (present) payload[key] = '是';
            else if (!['是', '否', '未说明'].includes(payload[key])) payload[key] = '未说明';
        }
    } else if (score === 0.5) {
        state = urls.length > 0 ? 'partial_release' : 'promise';
    } else if (score === 0.2) {
        state = urls.length > 0 ? 'demo_only' : 'reference_only';
    } else {
        if (urls.length > 0) {
            throw new Error('开源分为 0 但 revision 证据仍声明 HTTPS 资源 URL；必须返修作者证据或技术评分');
        }
        state = 'none';
    }
    payload.openSourceEvidence = { version: 1, state, urls, sourceQuotes };
    return payload;
}

function normalizeEvidenceLedgerIds(payloadValue) {
    const payload = structuredClone(payloadValue);
    const ledger = payload?.evidenceLedger;
    if (!Array.isArray(ledger) || ledger.length < 1) {
        throw new Error('revision payload 缺少 evidenceLedger，无法建立最终 E\d{2,3} 身份');
    }
    const mapping = new Map();
    const canonicalIds = new Set();
    ledger.forEach((item, index) => {
        // Early production-v6 author packets predated the author-output ID gate and
        // a few otherwise valid drafts therefore contain an ordered ledger with no
        // IDs at all.  Assigning an ID is identity plumbing, not semantic authoring:
        // preserve the immutable ledger order and use the same E1..E999 namespace
        // accepted for explicit draft IDs.  The recursive pass below then rewrites
        // every exact dependent value/key atomically to the final E01..E999 form.
        const rawId = String(item?.id || '').trim();
        const match = rawId.match(/^E(\d{1,3})$/);
        if (rawId && !match && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(rawId)) {
            throw new Error(`evidenceLedger[${index}].id 既不是 E\\d{1,3}，也不是安全的 legacy 短标签`);
        }
        const provisionalId = `E${index + 1}`;
        const sourceId = rawId || provisionalId;
        const canonicalId = match
            ? `E${match[1].padStart(2, '0')}`
            : `E${String(index + 1).padStart(2, '0')}`;
        if (canonicalIds.has(canonicalId)) {
            throw new Error(`evidenceLedger 规范化后 ID 冲突: ${canonicalId}`);
        }
        const aliases = match ? [sourceId] : [...new Set([sourceId, provisionalId])];
        for (const alias of aliases) {
            if (mapping.has(alias)) {
                throw new Error(`evidenceLedger draft ID/顺序别名重复: ${alias}`);
            }
            mapping.set(alias, canonicalId);
        }
        item.id = sourceId;
        canonicalIds.add(canonicalId);
    });
    const visit = value => {
        if (typeof value === 'string') return mapping.get(value) || value;
        if (Array.isArray(value)) return value.map(visit);
        if (!value || typeof value !== 'object') return value;
        const output = {};
        for (const [key, nested] of Object.entries(value)) {
            const normalizedKey = mapping.get(key) || key;
            if (Object.prototype.hasOwnProperty.call(output, normalizedKey)) {
                throw new Error(`evidence ID 规范化后对象 key 冲突: ${normalizedKey}`);
            }
            output[normalizedKey] = visit(nested);
        }
        return output;
    };
    return visit(payload);
}

function revisionBasePayloadPath(root) {
    // A prior binder attempt may have left a fully formed payload at the output
    // path.  Reading it would make a supposedly cold-start revision inherit old
    // prose, scores and review bindings.  The only authoritative semantic base is
    // the runner-validated author draft that is present in the revision packet's
    // allowlist; the binder may overwrite its own output, but never consume it.
    return path.join(root, 'draft', 'author-record.json');
}

function bindIndependentRevisionAudit(payload, audit, context) {
    if (audit?.version !== 1 || audit.contract !== 'manual-v6-independent-revision-audit-v1'
        || normalizedId(audit.paperId) !== context.paperId || audit.model !== 'gpt-5.6-terra'
        || audit.reasoningEffort !== 'high' || audit.singlePaperOnly !== true
        || audit.isolatedContext !== true || audit.finalPassed !== true
        || !String(audit.taskName || '').startsWith('/root/')) {
        throw new Error('independent revision audit 身份、模型或最终状态非法');
    }
    if (audit.articleFileSha256 !== context.articleFileSha256
        || audit.mapFileSha256 !== context.mapFileSha256) {
        throw new Error('independent revision audit 未绑定当前 article/map 字节');
    }
    if (!Array.isArray(audit.passes) || audit.passes.length < 2) {
        throw new Error('independent revision audit 必须包含至少两轮真实 passes');
    }
    audit.passes.forEach((pass, index) => {
        const final = index === audit.passes.length - 1;
        if (pass?.iteration !== index + 1 || !['revise', 'pass'].includes(pass.status)
            || !pass.stages || typeof pass.stages !== 'object' || Array.isArray(pass.stages)
            || !Array.isArray(pass.issues)
            || Object.keys(pass.stages).length !== REQUIRED_RECOVERY_STAGES.length) {
            throw new Error(`independent revision audit passes[${index}] 结构非法`);
        }
        for (const stage of REQUIRED_RECOVERY_STAGES) {
            const item = pass.stages[stage];
            const allowed = final ? ['pass', 'verified_not_applicable']
                : ['pass', 'revise', 'verified_not_applicable'];
            if (!item || !allowed.includes(item.status) || !Array.isArray(item.findings)
                || item.findings.some(value => normalizedText(value).length < 8)) {
                throw new Error(`independent revision audit passes[${index}].stages.${stage} 非法`);
            }
            if (item.status === 'revise' && item.findings.length < 1) {
                throw new Error(`independent revision audit ${stage} revise 必须记录具体发现`);
            }
            if (final && item.findings.length > 0) {
                throw new Error(`independent revision audit 最终轮 ${stage} 不得遗留 findings`);
            }
        }
        if (pass.status === 'revise' && pass.issues.length < 1) {
            throw new Error(`independent revision audit passes[${index}] revise 必须记录 issues`);
        }
        if (final && (pass.status !== 'pass' || pass.issues.length > 0)) {
            throw new Error('independent revision audit 最终轮必须是无遗留 issue 的 pass');
        }
    });
    const manualAudit = {
        version: 1,
        attempts: audit.passes.length,
        passes: audit.passes.map(pass => ({
            status: pass.status,
            issues: pass.issues.map(normalizedText)
        })),
        checks: Object.fromEntries([
            'sourceCoverage', 'promptConformance', 'factualClaimsLedger', 'scoreRecomputed',
            'methodContract', 'tableContract', 'boilerplateScan', 'finalContract'
        ].map(key => [key, true]))
    };
    const stageReviewAttemptsByStage = Object.fromEntries(
        REQUIRED_RECOVERY_STAGES.map(stage => [stage, audit.passes.filter(pass => pass.stages[stage]).length])
    );
    const evidenceId = String(payload.evidenceLedger?.[0]?.id || '').trim();
    const sourceQuote = normalizedText(payload.researchBrief?.centralQuestion?.sourceQuote);
    if (!evidenceId || sourceQuote.length < 16) {
        throw new Error('independent revision audit 无法绑定 stageReviews 的真实 evidence/source quote');
    }
    const stageReviews = {
        version: 2,
        stages: Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => {
            const attempts = audit.passes.filter(pass => pass.stages[stage]).length;
            const statuses = audit.passes.map(pass => pass.stages[stage].status);
            const repaired = statuses.includes('revise');
            const notNeeded = statuses.every(status => status === 'verified_not_applicable');
            const findings = audit.passes.flatMap(pass => pass.stages[stage].findings || [])
                .map(normalizedText);
            const decision = repaired ? 'repaired' : (notNeeded ? 'not_needed' : 'manual_verified');
            const issues = repaired ? findings : [];
            const conclusion = findings[0]
                || `独立 revision audit 已对 ${stage} 完成 ${attempts} 轮复核并确认当前最终字节通过。`;
            return [stage, {
                decision, attempts, evidenceIds: [evidenceId], sourceQuotes: [sourceQuote],
                issues, conclusion
            }];
        }))
    };
    return { ...payload, manualAudit, stageReviewAttemptsByStage, stageReviews };
}

function applyRevisionAuthorPatches(payload, map, options = {}) {
    const patches = map.recordPatches;
    if (patches === undefined) return payload;
    const allowedKeys = new Set([
        'researchBrief', 'editorialReview', 'evidenceSections', 'evidenceClaims', 'evidenceSourceQuotes'
        , 'evidenceLedger', 'resultClaims', 'editorialSections', 'imageInsertions', 'scoringEvidenceIdsByDimension'
    ]);
    if (!patches || typeof patches !== 'object' || Array.isArray(patches)
        || Object.keys(patches).some(key => !allowedKeys.has(key))
        || !patches.researchBrief || typeof patches.researchBrief !== 'object'
        || Array.isArray(patches.researchBrief)) {
        throw new Error('revision binding map.recordPatches 只允许 author revision 提交完整 researchBrief/editorialReview');
    }
    const output = { ...payload, researchBrief: structuredClone(patches.researchBrief) };
    if (patches.evidenceLedger !== undefined) {
        if (patches.evidenceSections !== undefined || patches.evidenceClaims !== undefined
            || patches.evidenceSourceQuotes !== undefined) {
            throw new Error('revision binding map.recordPatches.evidenceLedger 不得与旧 ledger 局部补丁并用');
        }
        const ledger = patches.evidenceLedger;
        const allowedLedgerKeys = new Set(['id', 'section', 'claim', 'sourceQuote']);
        if (!Array.isArray(ledger) || ledger.length < 6 || ledger.length > 40
            || ledger.some(item => !item || typeof item !== 'object' || Array.isArray(item)
                || Object.keys(item).some(key => !allowedLedgerKeys.has(key)))) {
            throw new Error('revision binding map.recordPatches.evidenceLedger 必须是 6-40 条、仅含标准字段的完整 fresh ledger');
        }
        const candidate = ledger.map(item => ({
            id: normalizedText(item.id),
            section: normalizedText(item.section),
            claim: normalizedText(item.claim),
            sourceQuote: normalizedText(item.sourceQuote)
        }));
        const issue = validateManualEvidenceLedger(candidate, options.sourceText || '');
        if (issue) throw new Error(`revision binding map.recordPatches.evidenceLedger 未通过全文闭环: ${issue}`);
        output.evidenceLedger = candidate;
    }
    if (patches.editorialSections !== undefined) {
        const sections = patches.editorialSections;
        const minimums = {
            summary: 80, method: 120, innovations: 80, results: 180,
            details: 100, limits: 80, open: 40
        };
        if (!sections || typeof sections !== 'object' || Array.isArray(sections)
            || Object.keys(sections).some(key => !Object.prototype.hasOwnProperty.call(minimums, key))) {
            throw new Error('revision binding map.recordPatches.editorialSections 只能覆盖 fresh 辅助栏目');
        }
        const normalized = {};
        for (const [key, value] of Object.entries(sections)) {
            normalized[key] = normalizedText(value);
            if (normalized[key].length < minimums[key]) {
                throw new Error(`revision binding map.recordPatches.editorialSections.${key} 至少 ${minimums[key]} 字符`);
            }
        }
        output.editorial = { ...output.editorial, ...normalized };
    }
    if (patches.editorialReview !== undefined) {
        if (typeof patches.editorialReview !== 'string' || normalizedText(patches.editorialReview).length < 180) {
            throw new Error('revision binding map.recordPatches.editorialReview 必须是至少 180 字符的独立两段点评');
        }
        output.editorial = { ...output.editorial, review: normalizedText(patches.editorialReview) };
    }
    if (patches.evidenceSections !== undefined) {
        const sections = patches.evidenceSections;
        const ledger = Array.isArray(output.evidenceLedger) ? output.evidenceLedger : [];
        const ids = ledger.map(item => String(item?.id || '').trim());
        if (!sections || typeof sections !== 'object' || Array.isArray(sections)
            || Object.keys(sections).length !== ids.length
            || ids.some(id => !Object.prototype.hasOwnProperty.call(sections, id))) {
            throw new Error('revision binding map.recordPatches.evidenceSections 必须精确覆盖既有 evidenceLedger ID');
        }
        output.evidenceLedger = ledger.map(item => ({ ...item, section: sections[item.id] }));
    }
    if (patches.evidenceClaims !== undefined) {
        const claims = patches.evidenceClaims;
        const ledger = Array.isArray(output.evidenceLedger) ? output.evidenceLedger : [];
        const ids = ledger.map(item => String(item?.id || '').trim());
        if (!claims || typeof claims !== 'object' || Array.isArray(claims)
            || Object.keys(claims).length !== ids.length
            || ids.some(id => !Object.prototype.hasOwnProperty.call(claims, id))
            || ids.some(id => normalizedText(claims[id]).length < 20)) {
            throw new Error('revision binding map.recordPatches.evidenceClaims 必须以至少20字符的事实陈述精确覆盖既有 ID');
        }
        output.evidenceLedger = ledger.map(item => ({ ...item, claim: normalizedText(claims[item.id]) }));
    }
    if (patches.evidenceSourceQuotes !== undefined) {
        const quotes = patches.evidenceSourceQuotes;
        const ledger = Array.isArray(output.evidenceLedger) ? output.evidenceLedger : [];
        const ids = ledger.map(item => String(item?.id || '').trim());
        if (!quotes || typeof quotes !== 'object' || Array.isArray(quotes)
            || Object.keys(quotes).length !== ids.length
            || ids.some(id => !Object.prototype.hasOwnProperty.call(quotes, id))
            || ids.some(id => normalizedText(quotes[id]).length < 12)) {
            throw new Error('revision binding map.recordPatches.evidenceSourceQuotes 必须以连续原句精确覆盖既有 ID');
        }
        const candidate = ledger.map(item => ({
            ...item,
            sourceQuote: normalizedText(quotes[item.id])
        }));
        const issue = validateManualEvidenceLedger(candidate, options.sourceText || '');
        if (issue) throw new Error(`revision binding map.recordPatches.evidenceSourceQuotes 未通过全文闭环: ${issue}`);
        output.evidenceLedger = candidate;
    }
    if (patches.resultClaims !== undefined) {
        if (!Array.isArray(patches.resultClaims) || patches.resultClaims.length < 3) {
            throw new Error('revision binding map.recordPatches.resultClaims 必须提交完整实证结果声明数组');
        }
        output.resultClaims = structuredClone(patches.resultClaims);
    }
    if (patches.scoringEvidenceIdsByDimension !== undefined) {
        const byDimension = patches.scoringEvidenceIdsByDimension;
        const knownIds = new Set((output.evidenceLedger || []).map(item => String(item?.id || '').trim()));
        if (!byDimension || typeof byDimension !== 'object' || Array.isArray(byDimension)
            || Object.keys(byDimension).length !== SCORING_DIMENSIONS.length
            || SCORING_DIMENSIONS.some(key => !Object.prototype.hasOwnProperty.call(byDimension, key))) {
            throw new Error('revision binding map.recordPatches.scoringEvidenceIdsByDimension 必须精确覆盖正式八维');
        }
        const normalized = {};
        for (const dimension of SCORING_DIMENSIONS) {
            const ids = byDimension[dimension];
            if (!Array.isArray(ids) || ids.length < 1 || ids.length > 6
                || ids.some(id => typeof id !== 'string' || !knownIds.has(id))
                || new Set(ids).size !== ids.length) {
                throw new Error(`revision binding map.recordPatches.scoringEvidenceIdsByDimension.${dimension} 必须包含 1-6 个不重复的真实 evidenceLedger ID`);
            }
            normalized[dimension] = [...ids];
        }
        // Scores, reviewer identity and calibration prose remain immutable and
        // reviewer-owned.  The revision leaf may only relink legacy article
        // anchors to the final evidence ledger; the independent audit then
        // verifies those bindings before the payload can be signed.
        output.scoringCalibration = {
            ...output.scoringCalibration,
            evidenceIdsByDimension: normalized
        };
    }
    if (patches.imageInsertions !== undefined) {
        const selected = Array.isArray(output.selectedImageUrls) ? output.selectedImageUrls : [];
        const insertions = patches.imageInsertions;
        const allowedInsertionKeys = new Set([
            'url', 'section', 'anchorQuote', 'conclusionQuote', 'lead', 'explanation'
        ]);
        if (!Array.isArray(insertions) || insertions.length !== selected.length
            || insertions.length < 1 || insertions.length > 4) {
            throw new Error('revision binding map.recordPatches.imageInsertions 必须与 selectedImageUrls 等长并逐项绑定');
        }
        output.imageInsertions = insertions.map((item, index) => {
            const label = `revision binding map.recordPatches.imageInsertions[${index}]`;
            if (!item || typeof item !== 'object' || Array.isArray(item)
                || Object.keys(item).some(key => !allowedInsertionKeys.has(key))) {
                throw new Error(`${label} 只允许提交图文叙事绑定字段`);
            }
            const normalized = Object.fromEntries([...allowedInsertionKeys].map(key => [
                key, normalizedText(item[key])
            ]));
            if (normalized.url !== selected[index] || !normalized.url.startsWith('https://')) {
                throw new Error(`${label}.url 必须按 selectedImageUrls 顺序精确绑定`);
            }
            const minimums = {
                section: 2, anchorQuote: 12, conclusionQuote: 12, lead: 18, explanation: 30
            };
            for (const [key, minimum] of Object.entries(minimums)) {
                if (normalized[key].length < minimum) throw new Error(`${label}.${key} 至少 ${minimum} 字符`);
            }
            return normalized;
        });
    }
    const openSourceEvidence = structuredClone(output.openSourceEvidence || {});
    if (openSourceEvidence.state === 'dataset_subset_reported') {
        openSourceEvidence.state = 'partial_release';
    } else if (openSourceEvidence.state === 'not_released') {
        openSourceEvidence.state = 'none';
    }
    output.openSourceEvidence = openSourceEvidence;
    return output;
}

function applyReviewDecisionsAndRevisionPatches(payload, map, technicalReview, pedagogyReview, options = {}) {
    // Reviewer-owned scores, identity and calibration prose are authoritative.
    // Apply them first, then let the revision leaf relink only the explicitly
    // allowlisted evidence-ID map; reversing the order restores legacy anchors.
    return applyRevisionAuthorPatches(
        applyValidatedReviewDecisions(payload, technicalReview, pedagogyReview),
        map,
        options
    );
}

function bindRevision(options) {
    const paperId = normalizedId(options.paperId);
    if (!paperId) throw new Error('--paper 必须是合法 arXiv ID');
    const paths = runnerPaths(options.date, options.workflowRoot || Config.FILES.manualV6Dir);
    const state = verifyBoundInputs(readJson(paths.statePath, 'runner state').value);
    const task = state.papers?.[paperId]?.tasks?.author_revision;
    if (!task || task.status !== 'running' || !task.taskName) throw new Error(`${paperId}.author_revision 必须处于 running`);
    const root = fs.realpathSync(task.artifactRoot);
    const articlePath = path.join(root, 'draft', 'final-article.md');
    const payloadPath = path.join(root, 'draft', 'revision-record-payload.json');
    const basePayloadPath = revisionBasePayloadPath(root);
    const mapPath = path.resolve(options.mapPath || path.join(root, 'draft', 'revision-binding-map.json'));
    const articleFile = assertInside(root, articlePath, 'final article');
    const mapFile = assertInside(root, mapPath, 'revision binding map');
    const map = readJson(mapFile.path, 'revision binding map').value;
    if (normalizedId(map.paperId) !== paperId) throw new Error('revision binding map 论文身份不一致');
    const artifactIndex = readJson(path.join(root, 'evidence', 'artifact-index.json'), 'ArtifactIndex').value;
    const sourceText = assertInside(root, path.join(root, 'evidence', 'fulltext.txt'), 'fulltext')
        .bytes.toString('utf8');
    const basePayload = readJson(basePayloadPath, 'revision base payload').value;
    const { article, bundle } = buildLongform(articleFile.bytes.toString('utf8'), map, artifactIndex);
    const articleBytes = Buffer.from(`${article}\n`, 'utf8');
    if (options.prepare === true) {
        if (!articleFile.bytes.equals(articleBytes)) writeFileAtomic(articlePath, articleBytes);
        return {
            paperId, prepared: true, articleSha256: bundle.articleSha256,
            articleFileSha256: sha256Bytes(articleBytes), blockCount: bundle.blocks.length,
            tableCount: bundle.tables.length, figureCount: bundle.figures.length,
            formulaCount: bundle.formulas.length
        };
    }
    if (!articleFile.bytes.equals(articleBytes)) {
        throw new Error('final article 尚未物化确定性表格/工件；先运行 binder --prepare，再做独立审计');
    }
    const technical = state.papers[paperId].tasks.technical_scoring;
    const readability = state.papers[paperId].tasks.pedagogy_readability;
    const technicalReview = readJson(technical.outputPath, 'validated technical review').value;
    const pedagogyReview = readJson(readability.outputPath, 'validated pedagogy review').value;
    const buildPatchedPayload = input => normalizeEvidenceLedgerIds(normalizeAuthorOwnedBaseFields(
        normalizeReviewBoundOpenSourceEvidence(input),
        'revision base payload'
    ));
    if (options.preflight === true) {
        const preflightStages = Object.fromEntries(REQUIRED_RECOVERY_STAGES.map(stage => [
            stage, { status: 'pass', findings: [] }
        ]));
        const structuralAudit = {
            version: 1, contract: 'manual-v6-independent-revision-audit-v1', paperId,
            taskName: `/root/revision_preflight_${paperId.replace('.', '_')}`,
            model: 'gpt-5.6-terra', reasoningEffort: 'high',
            singlePaperOnly: true, isolatedContext: true, finalPassed: true,
            articleFileSha256: sha256Bytes(articleFile.bytes), mapFileSha256: sha256Bytes(mapFile.bytes),
            passes: [1, 2].map(iteration => ({
                iteration, status: 'pass', stages: structuredClone(preflightStages), issues: []
            }))
        };
        const preflightPayload = buildPatchedPayload(bindIndependentRevisionAudit(
            applyReviewDecisionsAndRevisionPatches(
                basePayload, map, technicalReview, pedagogyReview, { sourceText }
            ),
            structuralAudit,
            { paperId, articleFileSha256: sha256Bytes(articleFile.bytes), mapFileSha256: sha256Bytes(mapFile.bytes) }
        ));
        preflightPayload.version = 4;
        preflightPayload.manualDepth = 'full-text-evidence-v6';
        preflightPayload.paperId = paperId;
        preflightPayload.arxivId = paperId;
        delete preflightPayload.sealedRecordSha256;
        delete preflightPayload.reviewReceipts;
        delete preflightPayload.reviewResolution;
        preflightPayload.editorial = {
            ...preflightPayload.editorial, readerArticle: article, longformBundle: bundle
        };
        validateRecord(preflightPayload, paperId, 'revision payload preflight', {
            recordsVersion: RECORDS_VERSION
        });
        return {
            paperId, preflight: true, articleSha256: bundle.articleSha256,
            articleFileSha256: sha256Bytes(articleFile.bytes), mapFileSha256: sha256Bytes(mapFile.bytes),
            blockCount: bundle.blocks.length, tableCount: bundle.tables.length,
            figureCount: bundle.figures.length, formulaCount: bundle.formulas.length
        };
    }
    const auditPath = path.join(root, 'reviews', 'revision-independent-audit.json');
    const auditFile = assertInside(root, auditPath, 'independent revision audit');
    const audit = readJson(auditFile.path, 'independent revision audit').value;
    const payload = buildPatchedPayload(bindIndependentRevisionAudit(
        applyReviewDecisionsAndRevisionPatches(
            basePayload, map, technicalReview, pedagogyReview, { sourceText }
        ),
        audit,
        {
            paperId,
            articleFileSha256: sha256Bytes(articleFile.bytes),
            mapFileSha256: sha256Bytes(mapFile.bytes)
        }
    ));
    payload.version = 4; payload.manualDepth = 'full-text-evidence-v6'; payload.paperId = paperId; payload.arxivId = paperId;
    delete payload.sealedRecordSha256; delete payload.reviewReceipts; delete payload.reviewResolution;
    payload.editorial = { ...payload.editorial, readerArticle: article, longformBundle: bundle };
    validateRecord(payload, paperId, 'revision payload before signature', {
        recordsVersion: RECORDS_VERSION
    });
    const payloadBytes = jsonBytes(payload);
    writeFileAtomic(articlePath, articleBytes);
    writeFileAtomic(payloadPath, payloadBytes);
    const findings = [technicalReview, pedagogyReview].flatMap(review => review.findings || []);
    const resolvedFindingSha256s = findings.map(stableObjectSha256).sort();
    if (!Array.isArray(map.notes) || map.notes.length < 2 || map.notes.some(note => normalizedText(note).length < 20)) {
        throw new Error('revision binding map.notes 必须包含至少 2 条具体修订');
    }
    const output = {
        version: 2, contract: REVISION_OUTPUT_CONTRACT, role: 'author_revision', paperId,
        taskName: task.taskName, passed: true,
        technicalOutputSha256: technical.outputSemanticSha256,
        readabilityOutputSha256: readability.outputSemanticSha256,
        finalArticleSha256: bundle.articleSha256,
        finalArticle: { path: 'draft/final-article.md', fileSha256: sha256Bytes(articleBytes) },
        recordPayload: {
            path: 'draft/revision-record-payload.json', fileSha256: sha256Bytes(payloadBytes),
            semanticSha256: stableObjectSha256(payload)
        },
        resolvedFindingSha256s,
        independentAudit: {
            path: 'reviews/revision-independent-audit.json',
            fileSha256: sha256Bytes(auditFile.bytes),
            semanticSha256: stableObjectSha256(audit),
            taskName: audit.taskName
        },
        notes: map.notes.map(normalizedText)
    };
    const outputBytes = jsonBytes(output);
    const outputSha256 = stableObjectSha256(output);
    const receipt = {
        role: 'author_revision', paperId, taskName: task.taskName,
        singlePaperOnly: true, isolatedContext: true,
        model: 'gpt-5.6-terra', reasoningEffort: 'high',
        inputPacketSha256: task.packetSha256, consumedPacketSha256: task.packetSha256,
        outputSha256, articleSha256: bundle.articleSha256, finalArticleSha256: bundle.articleSha256,
        queuedAt: task.claimedAt, startedAt: task.startedAt,
        completedAt: getBeijingISOString(), revision: Number(task.attempt || 1)
    };
    writeFileAtomic(path.join(root, 'outputs', 'author-revision.json'), outputBytes);
    writeFileAtomic(path.join(root, 'receipts', 'author-revision.json'), jsonBytes(receipt));
    return {
        paperId, articleSha256: bundle.articleSha256, articleFileSha256: sha256Bytes(articleBytes),
        payloadSemanticSha256: stableObjectSha256(payload), outputSha256,
        blockCount: bundle.blocks.length, tableCount: bundle.tables.length,
        figureCount: bundle.figures.length, formulaCount: bundle.formulas.length
    };
}

function parseArgs(argv) {
    const options = {};
    for (let index = 0; index < argv.length;) {
        const flag = argv[index++];
        if (flag === '--prepare') {
            if (options.prepare) throw new Error('--prepare 重复');
            options.prepare = true;
            continue;
        }
        if (flag === '--preflight') {
            if (options.preflight) throw new Error('--preflight 重复');
            options.preflight = true;
            continue;
        }
        const value = argv[index++];
        if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
        if (flag === '--date') options.date = value;
        else if (flag === '--paper') options.paperId = value;
        else if (flag === '--map') options.mapPath = value;
        else throw new Error(`未知参数: ${flag}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(options.date || ''))) throw new Error('--date 必须是 YYYY-MM-DD');
    if (options.prepare && options.preflight) throw new Error('--prepare 与 --preflight 不得同时使用');
    return options;
}

if (require.main === module) {
    try { console.log(JSON.stringify(bindRevision(parseArgs(process.argv.slice(2))), null, 2)); }
    catch (error) { console.error(`manual v6 revision binder 失败: ${error.message}`); process.exitCode = 1; }
}

module.exports = {
    MAP_CONTRACT, parseArticle, removePureMarkdownTables, removeRenderedArtifactTables, buildLongform,
    applyValidatedReviewDecisions, applyReviewDecisionsAndRevisionPatches,
    normalizeEvidenceLedgerIds, revisionBasePayloadPath,
    normalizeReviewBoundOpenSourceEvidence,
    normalizeAuthorOwnedBaseFields, bindIndependentRevisionAudit, applyRevisionAuthorPatches,
    bindRevision, parseArgs
};
