'use strict';

const crypto = require('crypto');
const { normalizedId } = require('./utils.js');

const MANUAL_LONGFORM_CONTRACT_VERSION = 'reader-longform-v2';
const MANUAL_LONGFORM_BUNDLE_VERSION = 2;
const LONGFORM_BLOCK_KINDS = new Set([
    'prerequisites', 'problem', 'related_work', 'signal_path', 'architecture',
    'component', 'training', 'formula', 'experiment_setup', 'result',
    'ablation', 'negative_result', 'reproduction', 'limitation', 'synthesis'
]);
const DISPOSITIONS = new Set(['inline', 'appendix', 'omit']);
const SHA256_RE = /^[a-f0-9]{64}$/;
const BEIJING_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$/;

function stableSha256(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeText(value) {
    return String(value || '').normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

function assertObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    return value;
}

function assertText(value, label, minimum = 1) {
    const text = normalizeText(value);
    if (text.length < minimum) throw new Error(`${label} 必须至少包含 ${minimum} 个字符`);
    return text;
}

function assertSha(value, label) {
    if (!SHA256_RE.test(String(value || ''))) throw new Error(`${label} 必须是 SHA-256`);
    return value;
}

function assertUniqueId(value, seen, label) {
    const id = assertText(value, label, 2);
    if (seen.has(id)) throw new Error(`${label} 重复: ${id}`);
    seen.add(id);
    return id;
}

function inventoryIds(index, field) {
    return new Set((Array.isArray(index?.[field]) ? index[field] : [])
        .map(item => String(item?.id || item?.sourceTableId || item?.url || '').trim())
        .filter(Boolean));
}

function validateReferences(values, allowed, label) {
    if (!Array.isArray(values)) throw new Error(`${label} 必须是数组`);
    const seen = new Set();
    for (const [index, raw] of values.entries()) {
        const id = assertText(raw, `${label}[${index}]`, 2);
        if (seen.has(id)) throw new Error(`${label} 不得重复引用 ${id}`);
        if (!allowed.has(id)) throw new Error(`${label} 引用了 ArtifactIndex 中不存在的 ${id}`);
        seen.add(id);
    }
    return seen;
}

function renderLongformBlocks(blocks) {
    return blocks.map(block => `### ${normalizeText(block.heading)}\n\n${normalizeText(block.markdown)}`).join('\n\n');
}

function isNumericTableCell(value) {
    return /(?:^|[^A-Za-z])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\b)/.test(
        normalizeText(value)
    );
}

function tableNumericCellIds(table) {
    const tableId = String(table?.id || table?.sourceTableId || '').trim();
    const matrix = Array.isArray(table?.matrix) ? table.matrix : [];
    const ids = [];
    matrix.forEach((row, rowIndex) => {
        (Array.isArray(row) ? row : []).forEach((cell, columnIndex) => {
            if (!isNumericTableCell(cell)) return;
            const cellValue = normalizeText(cell);
            const digest = stableSha256(cellValue).slice(0, 12);
            ids.push(`${tableId}:r${rowIndex}:c${columnIndex}:${digest}`);
        });
    });
    return ids;
}

function escapeMarkdownTableCell(value) {
    return normalizeText(value).replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
}

function renderArtifactTableMarkdown(table) {
    const matrix = Array.isArray(table?.matrix) ? table.matrix : [];
    if (matrix.length < 1 || !matrix.every(row => Array.isArray(row) && row.length > 0)) {
        throw new Error(`${table?.id || 'unknown table'} 没有可确定性渲染的矩阵`);
    }
    const width = Math.max(...matrix.map(row => row.length));
    const normalized = matrix.map(row => Array.from({ length: width }, (_, index) => (
        escapeMarkdownTableCell(row[index] ?? '')
    )));
    const header = normalized[0];
    const rows = normalized.slice(1);
    const caption = normalizeText(table.caption || table.id || '实验表格');
    return [
        `**${caption}**`,
        '',
        `| ${header.join(' | ')} |`,
        `| ${header.map(() => '---').join(' | ')} |`,
        ...rows.map(row => `| ${row.join(' | ')} |`)
    ].join('\n');
}

function validateTableCoverage(tables, artifactIndex, blocksById, label) {
    if (!Array.isArray(tables)) throw new Error(`${label}.tables 必须是数组`);
    const sourceTables = new Map((artifactIndex.tables || []).map(item => [
        String(item.id || item.sourceTableId || '').trim(), item
    ]).filter(([id]) => id));
    const seen = new Set();
    for (const [index, raw] of tables.entries()) {
        const itemLabel = `${label}.tables[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.sourceTableId, seen, `${itemLabel}.sourceTableId`);
        const source = sourceTables.get(id);
        if (!source) throw new Error(`${itemLabel} 不属于当前 ArtifactIndex`);
        if (!DISPOSITIONS.has(item.disposition)) throw new Error(`${itemLabel}.disposition 非法`);
        assertSha(item.sourceMatrixSha256, `${itemLabel}.sourceMatrixSha256`);
        if (source.matrixSha256 && item.sourceMatrixSha256 !== source.matrixSha256) {
            throw new Error(`${itemLabel} 的源矩阵 SHA 与 ArtifactIndex 不一致`);
        }
        const sourceNumericCellIds = tableNumericCellIds(source);
        if (item.numericCellCount !== undefined && Number(item.numericCellCount) !== sourceNumericCellIds.length) {
            throw new Error(`${itemLabel}.numericCellCount 必须由 ArtifactIndex 源矩阵计算，禁止自报`);
        }
        if (!Array.isArray(item.coveredNumericCellIds)) {
            throw new Error(`${itemLabel}.coveredNumericCellIds 必须逐格绑定源矩阵`);
        }
        const coveredNumericCellIds = item.coveredNumericCellIds.map((cellId, cellIndex) => (
            assertText(cellId, `${itemLabel}.coveredNumericCellIds[${cellIndex}]`, 8)
        ));
        if (new Set(coveredNumericCellIds).size !== coveredNumericCellIds.length) {
            throw new Error(`${itemLabel}.coveredNumericCellIds 不得重复`);
        }
        const missingCellIds = sourceNumericCellIds.filter(idValue => !coveredNumericCellIds.includes(idValue));
        const unknownCellIds = coveredNumericCellIds.filter(idValue => !sourceNumericCellIds.includes(idValue));
        const resultTable = source.kind === 'result';
        if (resultTable && sourceNumericCellIds.length < 1) {
            throw new Error(`${itemLabel} 是结果表，必须保存可核对的数值单元格矩阵`);
        }
        if (resultTable && item.disposition === 'omit') {
            throw new Error(`${itemLabel} 是结果表，不能从正文和完整数据附录同时省略`);
        }
        if (resultTable && (missingCellIds.length > 0 || unknownCellIds.length > 0)) {
            throw new Error(`${itemLabel} 结果表数值单元格覆盖率必须为 100%（missing=${missingCellIds.length}, unknown=${unknownCellIds.length}）`);
        }
        if (item.disposition === 'omit') assertText(item.omissionReason, `${itemLabel}.omissionReason`, 24);
        if (item.disposition !== 'omit') {
            const blockId = assertText(item.blockId, `${itemLabel}.blockId`, 2);
            const block = blocksById.get(blockId);
            if (!block) throw new Error(`${itemLabel}.blockId 引用了未知 block`);
            const expectedMarkdown = renderArtifactTableMarkdown(source);
            const renderedMarkdown = assertText(item.renderedMarkdown, `${itemLabel}.renderedMarkdown`, 20);
            if (renderedMarkdown !== expectedMarkdown) {
                throw new Error(`${itemLabel}.renderedMarkdown 必须由 ArtifactIndex 确定性生成`);
            }
            if (!normalizeText(block.markdown).includes(renderedMarkdown)) {
                throw new Error(`${itemLabel} 的确定性表格没有实际进入绑定正文 block`);
            }
            if (item.renderedFragmentSha256 !== stableSha256(renderedMarkdown)) {
                throw new Error(`${itemLabel}.renderedFragmentSha256 与实际渲染表格不一致`);
            }
        }
    }
    const missing = [...sourceTables.keys()].filter(id => !seen.has(id));
    if (missing.length) throw new Error(`${label}.tables 未逐项处置 ArtifactIndex 表格: ${missing.join(', ')}`);
}

function validateDispositionInventory(items, sourceItems, options) {
    const { label, sourceLabel, blocksById, minimumReason = 24,
        requireVisibleFacts = false, requireFormulaExplanation = false } = options;
    if (!Array.isArray(items)) throw new Error(`${label} 必须是数组`);
    const sourceIds = new Set(sourceItems.map(item => (
        String(item.id || item.url || '').trim()
    )).filter(Boolean));
    const seen = new Set();
    items.forEach((raw, index) => {
        const itemLabel = `${label}[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.id || item.url, seen, `${itemLabel}.id`);
        if (!sourceIds.has(id)) throw new Error(`${itemLabel} 不属于当前 ${sourceLabel}`);
        if (!DISPOSITIONS.has(item.disposition)) throw new Error(`${itemLabel}.disposition 非法`);
        if (item.disposition === 'omit') assertText(item.omissionReason, `${itemLabel}.omissionReason`, minimumReason);
        if (item.disposition !== 'omit') {
            const blockId = assertText(item.blockId, `${itemLabel}.blockId`, 2);
            const block = blocksById.get(blockId);
            if (!block) throw new Error(`${itemLabel}.blockId 引用了未知 block`);
            const markdown = normalizeText(block.markdown);
            const source = sourceItems.find(sourceItem => String(sourceItem?.id || sourceItem?.url || '').trim() === id);
            if (requireVisibleFacts) {
                const sourceUrl = String(source?.url || '').trim();
                if (!sourceUrl || !markdown.includes(sourceUrl)) {
                    throw new Error(`${itemLabel} 的图片 URL 没有实际进入绑定正文 block`);
                }
            }
            if (requireFormulaExplanation) {
                const explanation = assertText(item.explanation, `${itemLabel}.explanation`, 40);
                if (!markdown.includes(explanation)) {
                    throw new Error(`${itemLabel}.explanation 没有实际进入绑定正文 block`);
                }
                const formulaRaw = normalizeText(source?.raw || source?.latex || source?.text || '');
                if (formulaRaw && !markdown.includes(formulaRaw)) {
                    throw new Error(`${itemLabel} 的公式原文没有实际进入绑定正文 block`);
                }
            }
        }
        if (requireVisibleFacts && item.disposition !== 'omit') {
            if (!Array.isArray(item.visibleFacts) || item.visibleFacts.length < 1) {
                throw new Error(`${itemLabel}.visibleFacts 必须记录至少一个像素可见事实`);
            }
            const block = blocksById.get(item.blockId);
            item.visibleFacts.forEach((fact, factIndex) => {
                const visibleFact = assertText(fact, `${itemLabel}.visibleFacts[${factIndex}]`, 12);
                if (!normalizeText(block.markdown).includes(visibleFact)) {
                    throw new Error(`${itemLabel}.visibleFacts[${factIndex}] 没有实际进入绑定正文 block`);
                }
            });
        }
    });
    const missing = [...sourceIds].filter(id => !seen.has(id));
    if (missing.length) throw new Error(`${label} 未逐项处置 ${sourceLabel}: ${missing.join(', ')}`);
}

function validateTerms(terms, blocksById, artifactIndex, label) {
    if (!Array.isArray(terms)) throw new Error(`${label}.terms 必须是数组`);
    const candidates = inventoryIds(artifactIndex, 'acronyms');
    const seen = new Set();
    terms.forEach((raw, index) => {
        const itemLabel = `${label}.terms[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.id, seen, `${itemLabel}.id`);
        if (candidates.size && !candidates.has(id)) throw new Error(`${itemLabel} 不属于 ArtifactIndex 缩写/术语候选`);
        const term = assertText(item.term, `${itemLabel}.term`, 2);
        const definition = assertText(item.definition, `${itemLabel}.definition`, 16);
        const firstUseBlockId = assertText(item.firstUseBlockId, `${itemLabel}.firstUseBlockId`, 2);
        if (!blocksById.has(firstUseBlockId)) throw new Error(`${itemLabel}.firstUseBlockId 引用了未知 block`);
        const markdown = normalizeText(blocksById.get(firstUseBlockId).markdown);
        if (!markdown.includes(term) || !markdown.includes(definition)) {
            throw new Error(`${itemLabel} 的术语及定义没有实际进入首次使用 block`);
        }
    });
    const missing = [...candidates].filter(id => !seen.has(id));
    if (missing.length) throw new Error(`${label}.terms 未逐项处置 ArtifactIndex 术语: ${missing.join(', ')}`);
}

function validateRelatedWorks(items, blocksById, artifactIndex, label) {
    if (!Array.isArray(items)) throw new Error(`${label}.relatedWorks 必须是数组`);
    const candidates = inventoryIds(artifactIndex, 'citations');
    const seen = new Set();
    items.forEach((raw, index) => {
        const itemLabel = `${label}.relatedWorks[${index}]`;
        const item = assertObject(raw, itemLabel);
        const id = assertUniqueId(item.citationId, seen, `${itemLabel}.citationId`);
        if (candidates.size && !candidates.has(id)) throw new Error(`${itemLabel} 不属于 ArtifactIndex 引用候选`);
        const relationship = assertText(item.relationship, `${itemLabel}.relationship`, 16);
        const difference = assertText(item.difference, `${itemLabel}.difference`, 16);
        const blockId = assertText(item.blockId, `${itemLabel}.blockId`, 2);
        if (!blocksById.has(blockId)) throw new Error(`${itemLabel}.blockId 引用了未知 block`);
        const markdown = normalizeText(blocksById.get(blockId).markdown);
        if (!markdown.includes(relationship) || !markdown.includes(difference)) {
            throw new Error(`${itemLabel} 的关系与差异没有实际进入绑定正文 block`);
        }
    });
    const missing = [...candidates].filter(id => !seen.has(id));
    if (missing.length) throw new Error(`${label}.relatedWorks 未逐项处置 ArtifactIndex 引用: ${missing.join(', ')}`);
}

function validateProgression(blocks, label, options = {}) {
    const positions = new Map();
    blocks.forEach((block, index) => {
        if (!positions.has(block.kind)) positions.set(block.kind, index);
    });
    const methodKinds = ['signal_path', 'architecture', 'component'];
    const resultKinds = ['result', 'ablation', 'negative_result'];
    const problem = positions.get('problem');
    const method = Math.min(...methodKinds.map(kind => positions.get(kind)).filter(Number.isInteger));
    const result = Math.min(...resultKinds.map(kind => positions.get(kind)).filter(Number.isInteger));
    const limitation = positions.get('limitation');
    if (!Number.isInteger(problem) || !Number.isFinite(method) || !Number.isFinite(result)
        || !Number.isInteger(limitation)) {
        throw new Error(`${label}.blocks 必须覆盖 problem、方法/信号路径、result、limitation`);
    }
    if (!(problem < method && method < result && result < limitation)) {
        throw new Error(`${label}.blocks 必须按问题 → 方法/信号路径 → 结果 → 边界递进`);
    }
    const requiredKinds = options.theoretical === true
        ? ['prerequisites', 'problem', 'related_work', 'reproduction', 'limitation']
        : ['prerequisites', 'problem', 'related_work', 'training', 'experiment_setup', 'reproduction', 'limitation'];
    const missing = requiredKinds.filter(kind => !positions.has(kind));
    if (missing.length) throw new Error(`${label}.blocks 缺少研究生教学必要节点: ${missing.join(', ')}`);
}

function validateAuthorReceipt(receipt, paperId, articleSha256, label) {
    const value = assertObject(receipt, `${label}.authorReceipt`);
    if (normalizedId(value.paperId) !== paperId || value.singlePaperOnly !== true
        || value.isolatedContext !== true) {
        throw new Error(`${label}.authorReceipt 必须绑定当前单篇隔离任务`);
    }
    if (value.model !== 'gpt-5.6-terra' || value.reasoningEffort !== 'high') {
        throw new Error(`${label}.authorReceipt 必须绑定 gpt-5.6-terra/high`);
    }
    assertText(value.taskName, `${label}.authorReceipt.taskName`, 4);
    assertSha(value.inputPacketSha256, `${label}.authorReceipt.inputPacketSha256`);
    if (value.articleSha256 !== articleSha256) {
        throw new Error(`${label}.authorReceipt.articleSha256 与最终正文不一致`);
    }
    const timestamps = ['queuedAt', 'startedAt', 'completedAt'].map(field => {
        const timestamp = String(value[field] || '');
        if (!BEIJING_TIMESTAMP_RE.test(timestamp)) {
            throw new Error(`${label}.authorReceipt.${field} 必须是北京时间 ISO 时间戳`);
        }
        return Date.parse(timestamp);
    });
    if (!(timestamps[0] <= timestamps[1] && timestamps[1] <= timestamps[2])) {
        throw new Error(`${label}.authorReceipt 时间必须满足 queuedAt ≤ startedAt ≤ completedAt`);
    }
    if (!Number.isInteger(value.revision) || value.revision < 1) {
        throw new Error(`${label}.authorReceipt.revision 必须是从 1 开始的真实修订序号`);
    }
}

function validateManualLongformBundle(bundle, article, artifactIndex, options = {}) {
    const label = options.label || 'longformBundle';
    const value = assertObject(bundle, label);
    const index = assertObject(artifactIndex, `${label}.artifactIndex`);
    if (value.version !== MANUAL_LONGFORM_BUNDLE_VERSION
        || value.contract !== MANUAL_LONGFORM_CONTRACT_VERSION) {
        throw new Error(`${label} 必须是 ${MANUAL_LONGFORM_CONTRACT_VERSION} version=${MANUAL_LONGFORM_BUNDLE_VERSION}`);
    }
    const paperId = normalizedId(value.paperId);
    if (!paperId || (options.paperId && paperId !== normalizedId(options.paperId))) {
        throw new Error(`${label}.paperId 必须与当前论文一致`);
    }
    assertSha(value.artifactIndexSha256, `${label}.artifactIndexSha256`);
    if (index.outputSha256 && value.artifactIndexSha256 !== index.outputSha256) {
        throw new Error(`${label}.artifactIndexSha256 与 ArtifactIndex 不一致`);
    }
    const sourceSpanIds = inventoryIds(index, 'sourceSpans');
    const tableIds = inventoryIds(index, 'tables');
    const figureIds = inventoryIds(index, 'figures');
    const formulaIds = inventoryIds(index, 'formulas');
    if (!Array.isArray(value.blocks) || value.blocks.length < 6 || value.blocks.length > 32) {
        throw new Error(`${label}.blocks 必须包含 6-32 个教学 block`);
    }
    const blockIds = new Set();
    const blocksById = new Map();
    value.blocks.forEach((raw, indexPosition) => {
        const itemLabel = `${label}.blocks[${indexPosition}]`;
        const block = assertObject(raw, itemLabel);
        const id = assertUniqueId(block.id, blockIds, `${itemLabel}.id`);
        if (!LONGFORM_BLOCK_KINDS.has(block.kind)) throw new Error(`${itemLabel}.kind 非法`);
        assertText(block.heading, `${itemLabel}.heading`, 6);
        assertText(block.learningObjective, `${itemLabel}.learningObjective`, 12);
        const markdown = assertText(block.markdown, `${itemLabel}.markdown`, 100);
        if (markdown.length > 4000) throw new Error(`${itemLabel}.markdown 超过 4000 字符，必须拆分递进节点`);
        const oversizedParagraph = markdown.split(/\n\s*\n/).find(paragraph => normalizeText(paragraph).length > 1200);
        if (oversizedParagraph) throw new Error(`${itemLabel}.markdown 含超过 1200 字符的超长段落`);
        if (/(?:sourceBindings|readerBindings|evidenceLedger|resultClaims|schema|字段串)/i.test(markdown)) {
            throw new Error(`${itemLabel}.markdown 泄露内部 schema/validator 语言`);
        }
        validateReferences(block.evidenceSpanIds || [], sourceSpanIds, `${itemLabel}.evidenceSpanIds`);
        validateReferences(block.tableIds || [], tableIds, `${itemLabel}.tableIds`);
        validateReferences(block.figureIds || [], figureIds, `${itemLabel}.figureIds`);
        validateReferences(block.formulaIds || [], formulaIds, `${itemLabel}.formulaIds`);
        blocksById.set(id, block);
    });
    validateProgression(value.blocks, label, {
        theoretical: options.documentType === '理论研究'
    });
    const rendered = renderLongformBlocks(value.blocks);
    const normalizedArticle = normalizeText(article);
    if (normalizedArticle.length > 24000) throw new Error(`${label} readerArticle 不得超过 24000 字符`);
    if (rendered !== normalizedArticle) {
        throw new Error(`${label}.blocks 必须能够逐字重放最终 readerArticle`);
    }
    assertSha(value.articleSha256, `${label}.articleSha256`);
    if (value.articleSha256 !== stableSha256(normalizedArticle)) {
        throw new Error(`${label}.articleSha256 与最终 readerArticle 不一致`);
    }
    validateAuthorReceipt(value.authorReceipt, paperId, value.articleSha256, label);
    validateTableCoverage(value.tables, index, blocksById, label);
    validateDispositionInventory(value.figures, index.figures || [], {
        label: `${label}.figures`, sourceLabel: 'ArtifactIndex 图片', blocksById, requireVisibleFacts: true
    });
    validateDispositionInventory(value.formulas, index.formulas || [], {
        label: `${label}.formulas`, sourceLabel: 'ArtifactIndex 公式', blocksById,
        requireFormulaExplanation: true
    });
    validateTerms(value.terms, blocksById, index, label);
    validateRelatedWorks(value.relatedWorks, blocksById, index, label);
    return {
        paperId,
        articleSha256: value.articleSha256,
        blockCount: value.blocks.length,
        tableCount: value.tables.length,
        figureCount: value.figures.length,
        formulaCount: value.formulas.length
    };
}

module.exports = {
    MANUAL_LONGFORM_CONTRACT_VERSION,
    MANUAL_LONGFORM_BUNDLE_VERSION,
    LONGFORM_BLOCK_KINDS,
    stableSha256,
    tableNumericCellIds,
    renderArtifactTableMarkdown,
    renderLongformBlocks,
    validateManualLongformBundle
};
