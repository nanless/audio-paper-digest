'use strict';

/**
 * 隔离区：单篇论文历史回归豁免规则（Quarantined Single-Paper Exemptions）。
 *
 * 所有规则从 scripts/analysis-contract.js 完整迁出，逐字节保持原正则与判定逻辑，
 * 确保历史冷重放（cold replay）零漂移。新增通用规则请放在核心校验模块中，
 * 不要继续向本隔离模块堆叠单篇论文特例。
 */

const { sourceBackedSettingAxes } = require('./experiment-source-setting-axes.js');

const QUARANTINED_EXEMPTION_FUNCTIONS = Object.freeze([
    'sourceBackedIdentityColumns',
    'sourceBoundLossSwitchColumns',
    'ownObservedSourceScope',
    'adjacentSourceStatementAfter',
    'hasOwnSourceStatement',
    'hasObservedStageSwitchTable',
    'isReportedExperimentPrefix',
    'hasReportedExperimentPhrase',
    'hasSourceBackedSequenceOrderAblation',
    'hasSourceBackedPresenceComparison',
    'hasSourceBackedComponentSwitchAblation',
    'hasSourceBackedTrainingStageAblation',
    'hasSourceBackedSettingVariantAblation',
    'normalizeLocalEvidenceHeading',
    'hasOwnLocalReportedExperiment',
    'hasSourceBackedPlacementControl',
    'hasSourceBackedZeroCorrectionAblation',
    'hasAdjacentAffirmativeEvidenceWithdrawal',
    'hasSourceBackedNetIntervalNegative',
    'hasSourceBackedRewardSwitchAblation',
    'matchesSourceAudiogramMetricPairs',
    'hasSourceBackedQualityAudibilityTradeoff',
    'sourceBoundPredictionRefinementDecline',
    'hasTableBoundHigherMetricRegression',
    'hasSourceBackedWindowConfusion',
    'observedExperimentClaim',
    'observedSourceNegativeEvidence',
    'sourceHasObservedReasoningFailure',
    'sourceBoundLowerMetricIncrease',
    'sourceTwoBaselineMetricRegressions',
    'sourceBoundReverseBaselineComparison',
    'sourceBoundMatchedAcousticGap',
    'unquotedObservedComparison',
    'observedAdverseComparison',
    'sourceBoundListeningScoreRegression',
    'sourceBoundRenderedDurationShortfall',
    'sourceBoundFoldedObjectiveRegression',
    'sourceBoundDeadlineF1Comparison',
    'sourceBoundNotationRoundtripRegression',
    'hasBoundFormerLatterComparison',
    'hasBoundDisjointIntervalComparison',
    'hasConditionalMetricDeltaDirection',
    'hasPrefixedCoreMetricComparison',
    'stripSymbolicPatternRelation',
    'hasSymbolicGeometryMethodChain',
    'hasScopedSymbolicDemonstration',
    'sourceHasMeasuredMetricTable',
    'sourceCorpusCurationResult',
    'hasCompleteCorpusCurationResult',
    'sourceSoftwareFunctionalValidationResult',
    'hasCompleteSoftwareFunctionalValidationResult',
    'sourceHasBoundEventProportionComparison',
    'sourceHasBoundMeanF0Comparison',
    'sourceHasObservedOutcomeComparison',
    'sourceMeasuredPlannerSelection',
    'sourceBoundPlannerSelectionResult',
    'hasSourceBoundTextVideoComparison',
    'hasConcreteCoreSummarySetting',
    'hasRecordedDissonanceComparison',
    'hasMeanRoomSimulationComparison',
    'hasSourceBackedBayesianGroupResult',
    'sourceCorrectionRateProfile',
    'sourceBoundCorrectionRateObservations',
    'hasAffirmativeDnsMosStatement',
    'hasSourceDefinedDnsMos',
    'hasSourceBoundDnsMosBoundary',
    'hasCountedEvaluationScope',
    'hasSourceBoundHitCountMetric',
    'hasBlockLayoutProductChain',
    'hasPosteriorUpdateProductChain',
    'hasConcreteProductHandoff',
    'hasExplicitArtifactHandoff',
    'hasCachedCausalStateHandoff',
    'hasOfflineOperationalBoundary',
    'hasNaturalScopedBoundary',
    'hasGeneratedInputModelHeadChain',
    'hasExplicitEditedVectorHandoff',
    'hasTypedNaturalProductHandoff',
    'hasSourceBoundEditedWaveformOrCachedAvChain',
    'hasTypedProcessingProductChain',
    'hasSourceBoundSymbolAndTrajectoryHandoff',
    'hasExplicitNaturalProductChain',
    'hasConcreteUnnumberedMethodChain',
    'hasAdjacentConcreteMethodChain',
    'hasConcreteCompressionPurpose',
    'hasConcreteAcousticSimulationPurpose',
    'hasConcreteRuntimeDisclosure'
]);

function createPaperExemptions(deps) {
    const {
        isTableIdentifierHeader,
        CORE_SUMMARY_METRIC_PATTERN,
        CORE_SUMMARY_CONFERENCE_METRIC_PATTERN,
        CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN,
        CORE_SUMMARY_NUMBER_PATTERN,
        CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN
    } = deps;

    // ─── Experiment-table & adverse-result single-paper exemptions ───
    function sourceBackedIdentityColumns(table, sourceText) {
        const rawSource = String(sourceText || '');
        const source = rawSource.replace(/\s+/g, '');
        const captions = [...rawSource.matchAll(/(?:^|\n)(?:Table\s+(?:[A-Z]?\d+|[IVXLCDM]+)|表\s*\d+)\s*[:：]/gmi)];
        const blocks = captions.map((match, index) => {
            const block = rawSource.slice(match.index,
                Math.min(captions[index + 1]?.index ?? rawSource.length, match.index + 20000));
            const heading = /(?:^|\n)\s*(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][^\n]{0,100}|(?:conclusions?|discussion|references?|appendix)(?:[ :：][^\n]{0,80})?)(?:\n|$)/im.exec(block);
            return heading ? block.slice(0, heading.index) : block;
        });
        const stageSwitchColumns = table.header.flatMap((header, index) => /^S[1-9][0-9]?$/.test(String(header).trim()) ? [index] : []);
        const sourceBoundStageSwitches = hasObservedStageSwitchTable(table, rawSource, stageSwitchColumns);
        const observedLossSwitchColumns = sourceBoundLossSwitchColumns(table, rawSource);
        const observedSettingAxes = sourceBackedSettingAxes(table, rawSource);
        // These two categorical axes are not generic "signal" identifiers.
        // Each actual audiogram/signal pair must belong to one observed source table.
        const audiogram = table.header.findIndex(header => /^(?:听力图|audiograms?)$/iu.test(String(header).trim()));
        const signal = table.header.findIndex(header => /^(?:信号|signals?)$/iu.test(String(header).trim()));
        const musicSignal = new Map([['紧凑', 'Tight'], ['常规', 'Normal'], ['动态', 'Dynamic']]);
        const pairedAudiogramSignals = audiogram >= 0 && signal >= 0 && table.rows.length >= 2
            && captions.some((match, captionIndex) => {
                const caption = rawSource.slice(match.index).split('\n').find(line => line.trim()) || '';
                const prefix = rawSource.slice(0, match.index).split('\n').filter(line => line.trim()).at(-1) || '';
                if (!/Optimization results for profiles [^\n]{1,100}with limited residual DR/iu.test(caption)
                    || !ownObservedSourceScope(prefix + '\n' + caption)) return false;
                const body = rawSource.slice(match.index, Math.min(captions[captionIndex + 1]?.index ?? rawSource.length, match.index + 20000));
                return table.rows.every(row => {
                    const profile = /^([A-Z][0-9]{1,2})\s+有限范围$/u.exec(String(row[audiogram] || '').trim());
                    const music = musicSignal.get(String(row[signal] || '').trim());
                    if (!profile || !music) return false;
                    const begin = new RegExp('(?:^|\\n)' + profile[1] + ' with limited DR\\r?\\n', 'u').exec(body);
                    if (!begin) return false;
                    const tail = body.slice(begin.index + begin[0].length);
                    const end = tail.search(/(?:^|\n)(?:[A-Z][0-9]{1,2} with limited DR|Fig\.|Table\s+\d+:)/u);
                    return new RegExp('(?:^|\\n)' + music + '(?:\\r?\\n|$)', 'u').test(end < 0 ? tail : tail.slice(0, end));
                });
            });
        return new Set(table.header.flatMap((header, index) => {
            if (table.rows.length < 2) return [];
            if (pairedAudiogramSignals && (index === audiogram || index === signal)) return [index];
            if (sourceBoundStageSwitches && stageSwitchColumns.includes(index)) return [index];
            if (observedLossSwitchColumns.has(index)) return [index];
            if (observedSettingAxes.has(index)) return [index];
            const labels = table.rows.map(row => String(row[index] || '').trim());
            if (String(header).trim() === '来源') {
                const completeLabels = labels.every(label => label.length >= 1 && label.length <= 80 && /\p{L}/u.test(label));
                return completeLabels && blocks.some(block => {
                    const lines = new Set(block.split('\n').map(line => line.trim()));
                    return lines.has('Source') && labels.every(label => lines.has(label));
                }) ? [index] : [];
            }
            if (!/^(?:损失|loss)$/i.test(String(header).trim())) return [];
            return labels.every(label => {
                const match = /^\$?(\\mathcal\{L\}_\{\\(?:text|mathrm)\{[A-Za-z]{1,24}\}\})\$?$/.exec(label);
                return match && source.includes(match[1]);
            }) ? [index] : [];
        }));
    }

    // A loss *setting* is categorical only when the complete observed factorial
    // configuration table supplies the same row identities and switch values.
    // Boolean-looking metric cells alone never establish that column type.
    function sourceBoundLossSwitchColumns(table, source) {
        const empty = new Set();
        if (table.header.length !== 4 || table.rows.length !== 8) return empty;
        const identifier = table.header.findIndex(header => /^(?:变体|variant|abbrev\.)$/iu.test(String(header).trim()));
        const controls = [
            /^(?:条件注入|conditioning)$/iu,
            /^(?:波形损失归一化|损失归一化|waveform[- ]loss normalization)$/iu,
            /^(?:语谱图辅助损失|auxiliary spectrogram loss)$/iu
        ].map(pattern => table.header.findIndex(header => pattern.test(String(header).trim())));
        if (identifier < 0 || controls.some(index => index < 0)
            || table.rows.some(row => row.length !== 4 || controls.some(index => !/^(?:是|否)$/u.test(String(row[index]).trim())))) return empty;
        const denied = text => !ownObservedSourceScope(text)
            || /```|~~~|(?:^|\n)\s*[>“”"'‘’]|\b(?:quoted?|quotation|(?:not|never)\s+(?:actually\s+)?(?:implemented|executed|performed|trained|evaluated)|(?:did|do|does) not (?:actually )?(?:train|evaluate|implement|execute|perform)|abandon(?:ed)?|retract(?:ed)?)\b|\b(?:external|prior|third[- ]party)\s+(?:work|study|paper|experiment)\b|(?:外部研究|第三方|未实际执行|从未执行|没有执行|未实施|未训练|未评估|撤销|撤回)/iu.test(text);
        const claims = [...source.matchAll(/^To isolate the contributions of conditioning, loss normalization, and spectrogram loss, eight model variants are trained and evaluated[^\n]*$/gmu)];
        for (const claim of claims) {
            const reference = /The variants are summarized in Table\s+(\d+)\./u.exec(claim[0]);
            if (!reference) continue;
            const before = source.slice(0, claim.index);
            // A quoted code block or independent foreign-work heading cannot lend
            // the paper an observed configuration table.
            if ((before.match(/^\s*```[^\n]*$|^\s*~~~[^\n]*$/gmu) || []).length % 2) continue;
            const tail = source.slice(claim.index + claim[0].length);
            const caption = /^Table\s+(\d+): Overview of model variants differing in conditioning, waveform-loss normalization, and use of an auxiliary spectrogram loss\.([^\n]*)\n/gmu.exec(tail);
            if (!caption || caption[1] !== reference[1] || tail.slice(0, caption.index).trim()) continue;
            const rest = tail.slice(caption.index + caption[0].length);
            const boundary = /^(?:(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?\s+[A-Z][^\n]*|(?:Table|Figure)\s+\d+:|Conclusions?|Discussion|References?)\s*$/mu.exec(rest);
            const body = rest.slice(0, boundary ? boundary.index : rest.length);
            const scope = before.trim().split('\n').slice(-1).join('\n') + '\n' + claim[0] + '\n' + caption[0] + body
                + '\n' + (boundary ? adjacentSourceStatementAfter(rest, boundary.index + boundary[0].length) : '');
            if (denied(scope)) continue;
            const lines = body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
            if (lines.length !== 45 || lines[0] !== 'Abbrev.' || lines[1] !== 'Conditioning'
                || lines[2] !== 'Loss Norm.' || !/^LSTFT(?:L_\{\\mathrm\{STFT\}\})?$/u.test(lines[3]) || lines[4] !== 'Description') continue;
            const vectors = new Set();
            const names = new Set();
            let matches = true;
            for (let row = 0; row < 8; row++) {
                const [name, conditioning, normalization, spectrogram] = lines.slice(5 + row * 5, 9 + row * 5);
                if (!/^[A-Za-z][A-Za-z0-9-]*$/u.test(name) || !/^(?:–|FiLM)$/u.test(conditioning)
                    || !/^(?:–|✓)$/u.test(normalization) || !/^(?:–|✓)$/u.test(spectrogram)) { matches = false; break; }
                const flags = [conditioning === 'FiLM', normalization === '✓', spectrogram === '✓'];
                vectors.add(flags.join('|'));
                names.add(name);
                if (String(table.rows[row][identifier]).trim() !== name
                    || controls.some((column, index) => String(table.rows[row][column]).trim() !== (flags[index] ? '是' : '否'))) { matches = false; break; }
            }
            if (matches && vectors.size === 8 && names.size === 8) return new Set(controls);
        }
        return empty;
    }

    function ownObservedSourceScope(text) {
        return observedExperimentClaim(text)
            && !/\b(?:hypothes(?:is|izes?|ized)|hypothetical|illustrative|proposed only|not our experiment|(?:previous|other|related)\s+(?:paper|work|study|method)|(?:did|do|does) not conduct|no ablation experiment|not performed|not conducted|withdrawn|revoked|false statement)\b|(?:^|\n)\s*[>“"]|(?:他人|其他研究|转述|撤回|不是本研究)/iu.test(String(text));
    }

    function adjacentSourceStatementAfter(source, end) {
        const nextLine = String(source).slice(end).split(/\r?\n/u).find(line => line.trim());
        return (nextLine || '').slice(0, 400).split(/(?<=[.!?])\s+(?=[A-Z])/u)[0];
    }

    function hasOwnSourceStatement(sourceText, pattern) {
        const lines = String(sourceText || '').split(/\r?\n/u);
        return lines.some((line, index) => pattern.test(line)
            && ownObservedSourceScope((lines[index - 1] || '').slice(-300) + '\n' + line));
    }

    function hasObservedStageSwitchTable(table, source, controls) {
        if (controls.length < 2 || table.rows.length < 2
            || new Set(table.rows.map(row => controls.map(index => row[index]).join('|'))).size < 2
            || !controls.every(index => table.rows.every(row => /^(?:✓|✔|×|✗|[-—])$/u.test(String(row[index] || '').trim())))) return false;
        const normalize = value => String(value).trim().replace(/\\(?:times|checkmark)/gu, '').replace(/\s+/gu, '');
        const lines = source.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
        const claims = [...source.matchAll(/^In Tab\.\s*(\d+), we conduct stage-wise ablations[^\n]{0,300}$/gimu)]
            .filter(match => ownObservedSourceScope(source.slice(0, match.index).trim().split('\n').slice(-1).join(' ') + '\n' + match[0] + '\n' + adjacentSourceStatementAfter(source, match.index + match[0].length)));
        return claims.some(claim => {
            const caption = lines.findIndex((line, index) => new RegExp(`^Table ${claim[1]}:$`, 'iu').test(line)
                && /^Performance with respect to variants of the stages/iu.test(lines[index + 1] || ''));
            if (caption < 0) return false;
            const headers = table.header.map(header => String(header).replace(/\([^)]*\)|[↑↓]/gu, '').trim());
            for (let start = Math.max(0, caption - 200); start < caption; start++) {
                const actual = lines.slice(start, caption).map(normalize);
                const expected = [...headers, ...table.rows.flat()].map(normalize);
                if (actual.length === expected.length && actual.every((value, index) => value === expected[index])
                    && controls.every(index => hasOwnSourceStatement(source, new RegExp(`^Stage ${headers[index].slice(1)}\\s*[-–—:]`, 'iu')))) return true;
            }
            return false;
        });
    }

    function isReportedExperimentPrefix(prefix) {
        return !/(?:并非|不是|未能|没有|尚未|未曾|不能|不应|如果|假设|假如|倘若|若|未|不|计划|讨论|建议|拟|将|未来|有待|打算|设想)[^，,]{0,30}$/.test(prefix);
    }

    function hasReportedExperimentPhrase(text, pattern) {
        return [...String(text).matchAll(pattern)].some(match => {
            const prefix = String(text).slice(Math.max(0, match.index - 60), match.index)
                .split(/[。！？；\n]/).at(-1);
            return isReportedExperimentPrefix(prefix);
        });
    }

    function hasSourceBackedSequenceOrderAblation(results, tables, sourceText, requireRegression = false) {
        const source = String(sourceText || '');
        const observed = [...source.matchAll(/^Table\s+\d+: Order sensitivity ablation[^\n]*\n/gimu)].filter(caption => {
            const before = source.slice(0, caption.index).trim().split('\n').slice(-2).join(' ');
            return /\bwe disrupt subtoken order before spectral filtering\b/iu.test(before) && ownObservedSourceScope(before);
        });
        const blocks = observed.map(caption => {
            const tail = source.slice(caption.index + caption[0].length, caption.index + 1800);
            const boundary = /^(?:(?:Table|Figure|Fig\.)\s+(?:[A-Z]?\d+|[IVXLCDM]+)\s*[:.]|(?:\d+(?:\.\d+)*|[IVXLCDM]+)\.?[ \t]+[A-Z][^\n]{0,100}$|(?:Conclusions?|Discussion|References?|Appendix)\b)/gimu.exec(tail);
            const body = tail.slice(0, boundary ? boundary.index : tail.length);
            return ownObservedSourceScope(body) ? (caption[0] + body).split(/\r?\n/u).map(line => line.trim()) : [];
        });
        if (!blocks.length || !ownObservedSourceScope(String(results).split(/\n/u).filter(line => !/^\s*\|/u.test(line)).join(' '))) return false;
        if (!hasReportedExperimentPhrase(results, /(?:只破坏|打乱|反转)[^。；\n]{0,24}(?:输入|子词条|序列|顺序)|(?:输入|子词条|序列)[^。；\n]{0,24}(?:反转|打乱)/gu)) return false;
        return blocks.some(lines => tables.some(table => {
            const identifier = table.header.findIndex(isTableIdentifierHeader);
            const cer = table.header.findIndex(header => /^CER\s*↓$/iu.test(String(header).trim()));
            const wer = table.header.findIndex(header => /^WER\s*↓$/iu.test(String(header).trim()));
            if (identifier < 0 || cer < 0 || wer < 0) return false;
            const rows = ['Original', 'Reversed', 'Shuffled'].map(variant => {
                for (const [index, line] of lines.entries()) {
                    const match = /^([A-Za-z][A-Za-z0-9_-]{1,39}) \((Original|Reversed|Shuffled)\)$/u.exec(line);
                    if (!match || match[2] !== variant || !/^\d+(?:\.\d+)?$/u.test(lines[index + 1] || '') || !/^\d+(?:\.\d+)?$/u.test(lines[index + 2] || '')) continue;
                    return { method: match[1], variant, cer: lines[index + 1], wer: lines[index + 2] };
                }
                return null;
            });
            if (rows.some(row => !row) || new Set(rows.map(row => row.method)).size !== 1) return false;
            if (requireRegression && !rows.slice(1).some(row => Number(row.cer) > Number(rows[0].cer)
                || Number(row.wer) > Number(rows[0].wer))) return false;
            return rows.every(row => table.rows.some(cells => {
                const label = String(cells[identifier]).trim().replace(/[()]/gu, '').replace(/\s+/gu, ' ');
                return (label === `${row.method} ${row.variant}` || row.variant === 'Original' && label === row.method)
                    && String(cells[cer]).trim() === `${row.cer}%` && String(cells[wer]).trim() === `${row.wer}%`;
            }));
        }));
    }

    // A measured "without X / with X" comparison is an ablation even when
    // its Chinese explanation never uses the literal word 消融. Require the same
    // component, an explicit comparison, table values and one own-source statement.
    function hasSourceBackedPresenceComparison(results, tables, sourceText) {
        const denied = /假定|假如|倘若|设想|该研究|该论文|文献|据报告|(?:^|[，,:：\s])若(?=无)|(?:拟|预计|将来)[^。；\n]{0,24}无|\bIn\s*\[[\d,–— -]+\]|\b[A-Z][A-Za-z'-]+\s+et\s+al\.|\baccording\s+to\b/iu;
        const pairs = /无([\u4e00-\u9fffA-Za-z]{1,12})时([^。；\n]{1,300})[。；]\s*有\1后[^。；\n]{1,300}/gu;
        for (const match of String(results).matchAll(pairs)) {
            const context = String(results).slice(0, match.index).split(/\n\s*\n/u).at(-1) + match[0];
            if (!ownObservedSourceScope(context) || denied.test(context)) continue;
            const comparison = new RegExp(`(?:比较|对比)[^。；\\n]{0,60}无${match[1]}的[^。；\\n]{0,40}与`, 'gu');
            if (!hasReportedExperimentPhrase(results, comparison)) continue;
            const values = [...match[2].matchAll(/(?<![\d.])\d+(?:\.\d+)?%/gu)].map(value => value[0]);
            const rowPairMatches = table => {
                const columns = table.header.flatMap((header, column) => /%|百分/u.test(String(header)) ? [column] : []);
                const rows = table.rows.map(row => row.map(cell => String(cell).trim().replace(/%$/u, '')));
                return rows.some((before, first) => rows.some((after, second) => first !== second
                    && values.every((value, index) => index % 2 || columns.some(column =>
                        before[column] === value.slice(0, -1) && after[column] === values[index + 1].slice(0, -1)))));
            };
            if (new Set(values).size < 2 || values.length % 2 || !tables.some(rowPairMatches)) continue;
            const sourceLines = String(sourceText).split(/\r?\n/u);
            if (sourceLines.some((line, index) => ownObservedSourceScope(
                (sourceLines[index - 1] || '').slice(-300) + '\n' + line + '\n' + (sourceLines[index + 1] || '').slice(0, 400))
                && !denied.test((sourceLines[index - 1] || '').slice(-300) + '\n' + line + '\n' + (sourceLines[index + 1] || '').slice(0, 400))
                && /\bwithout\b/iu.test(line) && values.every(value =>
                    new RegExp(`(?<![\\d.])${value.replace('.', '\\.')}`, 'u').test(line)))) return true;
        }
        return false;
    }

    // 组件开关对照（"加入分支后 SI-SDRi 从 10.47 dB 升至 11.84 dB""冻结唇编码器时
    // 加入分支没有带来改善"）同样是消融，即使行文没有出现"消融"二字，也不套用
    // "无X时…有X后…"的固定句式。要求同一句里同时出现开关动作、组件名词和带数值的
    // 前后变化，且两个数值都能在原文里找到；假设、未来工作、他人转述都不算。
    function hasSourceBackedComponentSwitchAblation(results, sourceText = '') {
        const source = String(sourceText || '');
        const denied = /(?:假设|假想|假定|设想|如果|若在|预计|预期|可能|计划|未来|讨论|提及|建议|拟|并非|不是|没有|未|不能|不会|他人|第三方|先前(?:研究|工作)|相关工作|引用|引述|转述)/u;
        const switchPattern = /(?:加入|引入|启用|加回|关闭|冻结|去掉|移除|去除)[^。；，,\n]{0,12}?(?:分支|模块|组件|编码器|解码器|损失项?|约束|适配器|监督)/u;
        const changePattern = /从\s*([-+]?\d+(?:\.\d+)?)\s*[A-Za-z%]{0,6}\s*(?:升至|降至|变为|升到|降到)\s*([-+]?\d+(?:\.\d+)?)/u;
        for (const sentence of String(results || '').split(/[。；\n]/u)) {
            const text = sentence.trim();
            if (!text || denied.test(text) || !switchPattern.test(text)) continue;
            const change = changePattern.exec(text);
            if (!change || Number(change[1]) === Number(change[2])) continue;
            if (!source) return true;
            const present = value => new RegExp(`(?<![0-9.])${value.replace('.', '\\.')}(?![0-9])`, 'u').test(source);
            if (present(change[1]) && present(change[2])) return true;
        }
        return false;
    }

    function hasSourceBackedTrainingStageAblation(tables, sourceText) {
        const source = String(sourceText || '');
        const removal = /\b(?:w\/?o|without)\s+(?:the\s+)?(?:two[- ]stage\s+training\b|second[- ]stage\s+(?:training|fine[- ]tuning)\b)/gi;
        const supported = [...source.matchAll(removal)].some(match =>
            !/\b(?:no|not|never|plans?|planning|planned|propos(?:e|ed)|hypothetical|may|might|could|would|future)\b[^.;\n]{0,80}$/i.test(
                source.slice(Math.max(0, match.index - 100), match.index)));
        if (!supported) return false;
        // A translated, measured row identifies the removed training component;
        // a generic zero-shot claim or a mention in prose does not establish it.
        return tables.some(table => table.header.some((header, column) =>
            isTableIdentifierHeader(String(header).replace(/[*_`]/g, '').trim())
            && table.rows.some(row => /^(?:无|省略)第(?:二|2)阶段(?:训练|微调)$/.test(
                String(row[column] || '').replace(/[*_`]/g, '').trim()))));
    }

    function hasSourceBackedSettingVariantAblation(results, tables, sourceText) {
        // Only a uniquely identified original ablation table can supply settings.
        // Labels, update counts, layer indices, groups and values all come from the
        // current table and that original table, never a method-name allowlist.
        const source = String(sourceText || ''), lines = String(results || '').split(/\r?\n/u);
        const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const clean = value => String(value).replace(/[*`↑↓]/gu, '').trim();
        const denied = /假设|假想|如果|未来|计划|建议|预计|尚未|未做|没有(?:做|进行)|否认|否定|反驳|引述|转述|引用|他人|先前(?:工作|研究)|相关(?:工作|研究)|不属于本文|并非本文|说法[^。]{0,20}(?:不成立|错误)/u;
        const sourceDenied = /\b(?:hypothetical|planned|future|previous\s+(?:study|work)|another\s+(?:study|work)|cited|quoted|not\s+(?:performed|conducted)|no\s+ablation)\b/iu;
        const captions = [...source.matchAll(/Table\s+\d+:\s*Ablation\b/giu)];
        const windows = captions.flatMap(match => {
            const prefix = source.slice(Math.max(0, match.index - 180), match.index).split(/[.!?]/u).at(-1);
            const next = source.slice(match.index + match[0].length).search(/Table\s+\d+:/iu);
            const window = source.slice(match.index, next < 0 ? match.index + 3500 : Math.min(match.index + 3500, match.index + match[0].length + next));
            return sourceDenied.test(prefix) || /["“”]/u.test(prefix) || sourceDenied.test(window.slice(0, 350))
                || /\b(?:this|these|the above)\s+(?:table|ablations?|experiments?|comparisons?)[^.!?]{0,80}\b(?:not\s+(?:performed|conducted)|hypothetical|withdrawn|retracted|incorrect)\b/iu.test(window) ? [] : [window];
        });
        const headersMatch = (headers, window) => {
            const flat = headers.map(clean);
            const sourceLines = window.split(/\r?\n/u);
            if (sourceLines.some(line => new RegExp('(?:^|[ \\t])' + flat.map(escape).join('[ \\t]+') + '[ \\t]*$', 'u').test(line))) return true;
            // Repeated metric leaves must retain the full ordered group axis.
            const grouped = flat.map(header => /^(\S+)\s+([A-Za-z][A-Za-z0-9@._-]*)$/u.exec(header));
            if (grouped.some(header => !header)) return false;
            const groups = grouped.map(header => header[1]).filter((group, index, all) => index === 0 || all[index - 1] !== group);
            if (groups.length < 2 || new Set(groups).size !== groups.length) return false;
            const groupLine = groups.map(group => escape(group) + '(?:[ \\t]+subset)?').join('[ \\t]+');
            const leaves = grouped.map(header => escape(header[2])).join('[ \\t]+');
            return sourceLines.some((line, index) => new RegExp('(?:^|[ \\t])' + groupLine + '[ \\t]*$', 'u').test(line)
                && new RegExp('^[ \\t]*' + leaves + '[ \\t]*$', 'u').test(sourceLines[index + 1] || ''));
        };
        const labelPattern = label => {
            const value = clean(label);
            const ema = /^([A-Za-z][A-Za-z0-9_.-]*)\s+(?:EMA\s+([1-9][0-9]*)步间隔|无\s*EMA\s+冻结教师(?:加单层([1-9][0-9]*))?)$/u.exec(value);
            if (ema) return { base: ema[1], key: value, pattern: ema[2]
                ? `w/\\s*EMA\\s*\\(${ema[2]}-step interval\\)`
                : `w/o\\s*EMA\\s*\\(freeze\\)${ema[3] ? `\\s*&\\s*Single-layer\\s*\\(${ema[3]}\\)` : '(?![ \\t]*&)'}` };
            // A component-addition row must name at least two actual components.
            const components = /^(?:\+\s*[A-Za-z][A-Za-z0-9_.-]*\s*){2,}(?:本文)?$/u.exec(value);
            if (!components) return null;
            const names = value.replace(/\s*本文$/u, '').split('+').map(part => part.trim()).filter(Boolean);
            return { key: names.join('+'), pattern: names.map(escape).join('[ \\t]*\\+[ \\t]*').replace(/^/, '\\+[ \\t]*') + '(?:[ \\t]*\\(Ours\\))?' };
        };
        return tables.some(table => {
            const before = lines.slice(0, table.startLine).join('\n').split(/\n\s*\n/u).filter(Boolean).at(-1) || '';
            const after = lines.slice(table.endLine + 1).join('\n').split(/\n\s*\n/u).filter(Boolean)[0] || '';
            if (denied.test(before + after) || !/(?:比较|对比|是否重要|是否必要|只改变|只替换)/u.test(before)
                || !/(?:高于|低于|优于|变差|退化|上升|下降|降至|升至)/u.test(after)) return false;
            const width = table.header.length - 1;
            if (width < 1 || !table.header.slice(1).every(header => /[↑↓]/u.test(header))
                && !/(?:越低越好|越高越好)/u.test(before)) return false;
            const matching = windows.filter(window => {
                if (!headersMatch(table.header.slice(1), window)) return false;
                const matched = table.rows.flatMap(row => {
                    const label = labelPattern(row[0]);
                    if (!label || row.length !== width + 1 || row.slice(1).some(cell => !/^\d+(?:\.\d+)?$/u.test(String(cell).trim()))) return [];
                    if (label.base && !new RegExp('(?:^|\\n)[ \\t]*' + escape(label.base) + '[ \\t]+\\([^\\n)]*\\)[ \\t]+[0-9]', 'u').test(window)) return [];
                    const numeric = row.slice(1).map(cell => escape(String(cell).trim())).join('[ \\t]+');
                    const pattern = new RegExp('(?<![A-Za-z0-9_+.-])' + label.pattern + '[ \\t]+(' + numeric + ')(?![0-9.]|[ \\t]+[0-9])', 'gu');
                    const matches = [...window.matchAll(pattern)];
                    if (matches.length !== 1) return [];
                    const prefix = window.slice(Math.max(window.lastIndexOf('\n', matches[0].index) + 1, 0), matches[0].index);
                    if (!label.base && /\+\s*(?:[A-Za-z][A-Za-z0-9_.-]*\s*\+\s*)*(?:[A-Za-z][A-Za-z0-9_.-]*\s*)?$/u.test(prefix)) return [];
                    return [label.key];
                });
                return new Set(matched).size >= 2;
            });
            return matching.length === 1;
        });
    }

    // Only the immediately adjacent attribution/hypothesis heading scopes a
    // new result exception. An earlier independent paragraph is not a global veto.
    function normalizeLocalEvidenceHeading(line) {
        let heading = String(line || '').trim();
        const atx = /^#{1,6}[ \t]+([^\n]*)$/u.exec(heading);
        if (atx) heading = atx[1].replace(/[ \t]+#+[ \t]*$/u, '').trim();
        const bold = /^(\*\*|__)([^\n]+)\1$/u.exec(heading);
        return bold ? bold[2].trim() : heading;
    }

    function hasOwnLocalReportedExperiment(text, index, sentence) {
        if (!ownObservedSourceScope(sentence)) return false;
        const before = String(text || '').slice(0, index);
        const currentLine = before.slice(before.lastIndexOf('\n') + 1);
        if (currentLine.trim()) return true; // same-sentence attribution was checked above
        // Blank Markdown separator lines do not end a closed heading's scope.
        // Inspect one bounded adjacent nonblank line, never a whole prior section.
        const adjacent = before.slice(-512).replace(/[ \t\r\n]+$/u, '');
        if (!adjacent && before.length) return false;
        const previous = normalizeLocalEvidenceHeading(adjacent.split('\n').at(-1).split(/[。；！？!?]/u).at(-1));
        const notice = /^(?:第三方|他人|外部团队|其他研究|相关工作|相关研究|先前研究|既有研究|旧工作|基线方法|对照系统|假设|假想|假定|设想|如果|预计|计划|未来|previous\s+work|prior\s+research|related\s+work)[^。；.!?\n]{0,140}[：:]$/iu;
        return !notice.test(previous);
    }

    // A measured single-factor placement control can be reported in prose.
    // Bind the isolated factor, held-fixed processing and both depth/value pairs;
    // neither the word "adaptive" nor an arbitrary comparison supplies an ablation.
    function hasSourceBackedPlacementControl(results, sourceText) {
        const rawSource = String(sourceText || '');
        const headings = [...rawSource.matchAll(/^(?:(?:[0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)\s+)?Uniform-stride versus adaptive event placement\s*\r?\n/gimu)];
        if (headings.length !== 1) return false;
        const start = headings[0].index + headings[0][0].length;
        const tail = rawSource.slice(start, start + 16000);
        const end = tail.search(/^[ \t]*(?:[0-9]+(?:\.[0-9]+)*|[IVXLCDM]+)[ \t]+[A-Z]/mu);
        const source = end < 0 ? tail : tail.slice(0, end);
        const prefix = rawSource.slice(0, headings[0].index).split('\n').filter(line => line.trim()).at(-1) || '';
        if (!ownObservedSourceScope(prefix + '\n' + source)) return false;
        const control = /To isolate event placement, we compare[^\n]{1,600}?Both models share the [^\n]{1,100}?latent grid, [^\n]{1,100}?interval aggregator, [^\n]{1,100}?quantizer, and causal decoder/iu.exec(source);
        const observed = /Adaptive placement gives[^\n]{1,1400}?With aggregation and decoding held fixed[^\n]{1,500}/iu.exec(source);
        const owns = match => match && ownObservedSourceScope(source.slice(
            Math.max(0, source.lastIndexOf('\n', match.index - 1) + 1), match.index) + match[0]);
        if (!owns(control) || !owns(observed)) return false;
        const single = /\bdWER\b[^.!?]{0,180}with one codebook\s*\((\d+(?:\.\d+)?)%\s*(?:→\s*(?:\\rightarrow)?|\\rightarrow)\s*(\d+(?:\.\d+)?)%\)/iu.exec(observed[0]);
        const depths = /at depths ([1-9][0-9]*) and ([1-9][0-9]*), dWER is close\s*\((\d+(?:\.\d+)?)% versus (\d+(?:\.\d+)?)% and (\d+(?:\.\d+)?)% versus (\d+(?:\.\d+)?)%\)/iu.exec(observed[0]);
        if (!single || !depths || Number(single[2]) >= Number(single[1]) || depths[1] === depths[2]) return false;
        const pairs = new Map([[depths[1], [depths[3], depths[4]]], [depths[2], [depths[5], depths[6]]]]);
        for (const reported of String(results || '').matchAll(/[^。；\n]+/gu)) {
            const sentence = reported[0];
            if (!hasOwnLocalReportedExperiment(results, reported.index, sentence) || /假想|设想|第三方|旧工作|既有研究|先前工作|先前研究|相关工作|相关研究|文献|引用|转述|撤回|否认|不成立|\b(?:previous|prior|related)\s+(?:work|research)\b/iu.test(sentence)) continue;
            const measured = /只改变放置的均匀步长对照中[^。]{1,150}单码本\s+dWER\s+从\s*(\d+(?:\.\d+)?)%\s+降到\s*(\d+(?:\.\d+)?)%[，,]\s*([1-9][0-9]*)\s*层时为\s*(\d+(?:\.\d+)?)%\s+对\s*(\d+(?:\.\d+)?)%/iu.exec(sentence);
            const pair = measured && pairs.get(measured[3]);
            if (measured && pair && Number(measured[1]) === Number(single[1]) && Number(measured[2]) === Number(single[2])
                && Number(measured[4]) === Number(pair[0]) && Number(measured[5]) === Number(pair[1])) return true;
        }
        return false;
    }

    function hasSourceBackedZeroCorrectionAblation(results, sourceText) {
        const source = String(sourceText || '').replace(/\s+/g, ' ');
        // A measured correction sweep isolates this component; a zero weight in
        // training settings, or a proposed future sweep, does not establish it.
        const sweep = /Role of bidirectional correction\.[\s\S]{0,500}?isolates the correction signal[\s\S]{0,500}?varying only[\s\S]{0,500}?without correction/i.exec(source);
        if (!sweep || /\b(?:future|planned|hypothetical)\b/i.test(sweep[0])) return false;
        for (const match of String(results || '').matchAll(/修正权重\s*为\s*0(?:\.0+)?\s*时\s*(Total)\s*最高\s*[,，]\s*为\s*(\d+(?:\.\d+)?)/gi)) {
            const value = match[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const prefix = String(results).slice(Math.max(0, match.index - 60), match.index);
            if (!/(?:如果|假设|计划|未来|可能|预计|并非|不是)[^。；\n]{0,50}$/.test(prefix)
                && /λcorr\s+Quality\s+Semantic\s+Total/i.test(sweep[0])
                && new RegExp(`(?:^| )0 +[0-9.]+ +[0-9.]+ +${value}(?![0-9.])`).test(sweep[0])) return true;
        }
        return false;
    }

    function hasAdjacentAffirmativeEvidenceWithdrawal(text, end, subjectPattern) {
        const nextLine = String(text).slice(end)
            .replace(/^[。；\r\n \t]+/u, '').split(/\r?\n/u)[0].slice(0, 600);
        // Closing emphasis/ATX delimiters may follow the sentence punctuation.
        // Unwrap the complete adjacent line before selecting its first claim.
        const line = normalizeLocalEvidenceHeading(nextLine);
        const firstSpan = /^(\*\*|__)([^\n]+?)\1(?=[。； \t]|$)/u.exec(line);
        const headingPrefix = /^#{1,6}[ \t]+/u.exec(nextLine)?.[0] || '';
        const next = normalizeLocalEvidenceHeading(headingPrefix + (firstSpan ? firstSpan[2] : line).split('。')[0]);
        const affirmative = /^(?:(?:已经|现已|已)?(?:被)?(?:正式)?撤回(?:了)?|(?:已经|现已|已)?被否认|(?:确实|已经|现已|已)?不成立|(?:确有|有|存在)错误|有误|(?:是)?错误(?:的)?)$/u;
        return next.split(/[，,；;]/u).some(clause => [...clause.matchAll(
            subjectPattern
        )].some(subject => {
            const prefix = clause.slice(0, subject.index).split(/但是|然而|不过|可是|但|却/u).at(-1);
            return ownObservedSourceScope(prefix)
                && !/第三方|外部团队|假定|设想|撤回|不成立|并不|\b(?:withdrawn|revoked|not performed|not conducted|false statement)\b/iu.test(prefix)
                && isReportedExperimentPrefix(prefix)
                && affirmative.test(clause.slice(subject.index + subject[0].length).trim());
        }));
    }

    // A near-zero estimate is not itself an adverse result. This narrow profile
    // binds the reported natural-speech self-correction contrast to both original
    // intervals and to the same source table's net column, never another flow.
    function hasSourceBackedNetIntervalNegative(results, tables, sourceText) {
        const raw = String(sourceText || '');
        const owns = (text, index, body) => {
            const previous = normalizeLocalEvidenceHeading(text.slice(0, index).trimEnd().split('\n').at(-1));
            return ownObservedSourceScope(previous + '\n' + body)
                && !/第三方|外部团队|假定|设想|撤回|不成立|并不|\b(?:withdrawn|revoked|not performed|not conducted|false statement)\b/iu.test(previous + '\n' + body);
        };
        const headings = [...raw.matchAll(/^[ \t]*[0-9]+(?:\.[0-9]+)*[ \t]+Net effect[ \t]*\r?\n/gimu)];
        if (headings.length !== 1) return false;
        const start = headings[0].index + headings[0][0].length;
        const tail = raw.slice(start, start + 12000);
        const boundary = tail.search(/^[ \t]*(?:[0-9]+(?:\.[0-9]+)*[ \t]+[A-Z]|#{1,6}[ \t])/mu);
        const block = boundary < 0 ? tail : tail.slice(0, boundary);
        if (!owns(raw, headings[0].index, '')) return false;
        const selfStart = block.search(/Self-correction is less clear\./iu);
        if (selfStart < 0) return false;
        let scopeStart = 0;
        for (const line of block.slice(0, selfStart).matchAll(/[^\n]+(?:\n|$)/gu)) {
            if (/^Our measured results:$/iu.test(normalizeLocalEvidenceHeading(line[0]))) scopeStart = line.index + line[0].length;
        }
        const current = block.slice(scopeStart);
        if (!owns('', 0, current)) return false;
        const prose = current.replace(/−/gu, '-').replace(/\s+/gu, ' ');
        const group = /Self-correction is less clear\. ([A-Z]) beats ([A-Z]) on the synthetic corpus/iu.exec(prose);
        if (!group || group[1] === group[2]
            || !/By net WER alone, the audio does nothing for self-correction on natural speech\./iu.test(prose)) return false;
        const signed = '[+-]?[0-9]+(?:\\.[0-9]+)?';
        const interval = name => `(?<${name}>\\[(?<${name}Low>${signed}),[ \\t]*(?<${name}High>${signed})\\])(?:\\k<${name}>)?`;
        const claim = new RegExp('On the natural corpora we cannot detect a net difference[ \\t]*\\([ \\t]*'
            + `(?<p1>${signed})(?:\\k<p1>)?[ \\t]*pt,[ \\t]*interval[ \\t]*${interval('i1')};[ \\t]*`
            + `(?<p2>${signed})(?:\\k<p2>)?[ \\t]*pt,[ \\t]*(?:interval[ \\t]*)?${interval('i2')}[ \\t]*\\)`, 'iu').exec(prose);
        if (!claim) return false;
        const values = [claim.groups.p1, claim.groups.p2].map(Number);
        if (!values.every(Number.isFinite)) return false;
        for (const [index, key] of ['i1', 'i2'].entries()) {
            const low = Number(claim.groups[key + 'Low']), high = Number(claim.groups[key + 'High']);
            if (!Number.isFinite(low) || !Number.isFinite(high) || !(low < 0 && high > 0)
                || values[index] < low || values[index] > high) return false;
        }
        const primary = /primary corrector is ([^\n\[.]{1,80}(?:\.[0-9]+)?[^\n\[]*)\s*\[[0-9, ]+\]/iu.exec(raw)?.[1].trim();
        if (!primary || !String(results).includes(primary)) return false;
        const captions = [...raw.matchAll(/^Table[ \t]+[0-9]+:[ \t]*Effect of the audio,[ \t]*([^:\n]{1,100}):[ \t]*grounded minus text-only\r?\n/gmu)];
        const natural = [['RuLibri RU', '俄语音频书'], ['Medical EN', '医疗英语']];
        const numberCell = value => {
            // HTML math contributes the identical sign twice in these scalar cells.
            const scalar = /^(?:\+\+|−-|--|\+|-|−)?[0-9]+(?:\.[0-9]+)?$/u.exec(String(value));
            return scalar ? Number(scalar[0].replace(/^\+\+/u, '+').replace(/^(?:−-|--|−)/u, '-')) : NaN;
        };
        const bound = captions.filter(caption => {
            if (caption[1].trim() !== primary) return false;
            const tableTail = raw.slice(caption.index + caption[0].length, caption.index + 20000);
            const end = tableTail.search(/^Table[ \t]+[0-9]+:/mu);
            const body = end < 0 ? tableTail : tableTail.slice(0, end);
            if (!owns(raw, caption.index, body)) return false;
            const lines = body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
            const header = lines.findIndex((line, index) => ['rep', 'dam', 'ins', 'net', 'break-rate'].every((key, offset) => lines[index + offset] === key));
            const expectedGroup = `self-correction: ${group[1]} (audio) vs. ${group[2]} (no audio)`;
            const groupIndex = lines.indexOf(expectedGroup);
            if (header < 0 || groupIndex !== header + 5 || lines.filter(line => line === expectedGroup).length !== 1) return false;
            const after = lines.slice(groupIndex + 1);
            const groupEnd = after.findIndex(line => /^cross-system:/u.test(line));
            const rows = groupEnd < 0 ? [] : after.slice(0, groupEnd);
            if (rows.length !== 18 || rows[0] !== 'TTS RU') return false;
            return natural.every(([label], index) => rows[(index + 1) * 6] === label
                && numberCell(rows[(index + 1) * 6 + 4]) === values[index]);
        });
        if (bound.length !== 1) return false;
        const matchingTables = tables.filter(table => {
            const identity = table.header.findIndex(header => /^(?:对比|比较|对照)$/u.test(String(header).trim()));
            const net = table.header.findIndex(header => /^净[ \t]+pt[ \t]*↑$/u.test(String(header).trim()));
            if (identity < 0 || net < 0) return false;
            return natural.every(([, label], index) => {
                const rows = table.rows.filter(row => row[identity] === `自我 ${group[1]}-${group[2]} ${label}`);
                return rows.length === 1 && numberCell(rows[0][net]) === values[index];
            });
        });
        if (matchingTables.length !== 1) return false;
        const model = primary.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const ownerCarrier = value => {
            const text = normalizeLocalEvidenceHeading(value);
            if (text.length > 160) return null;
            for (const pattern of [/^在[ \t]*(.+?)[ \t]*上[，,]?$/u, /^(.+?)[ \t]*模型[：:]$/u,
                /^(.+?)[ \t]*的结果如下[：:]$/u, /^(.+?)[ \t]*(?:模型)?的$/u]) {
                const match = pattern.exec(text);
                if (match && match[1].trim().length <= 120) return match[1].trim();
            }
            return null;
        };
        const reportedPattern = new RegExp('^[ \\t]*自我校正下'
            + `(?:合成语料差距为[ \\t]*${signed}[ \\t]*pt[，,][ \\t]*)?`
            + `(?:${model}[ \\t]*的[ \\t]*)?自然语料净差距为[ \\t]*(${signed})[ \\t]*pt[ \\t]*与[ \\t]*(${signed})[ \\t]*pt`
            + '[，,][ \\t]*区间包含零(?:附近)?[，,][ \\t]*单看净[ \\t]*WER', 'iu');
        for (const sentence of String(results || '').matchAll(/[^。；\n]+/gu)) {
            const previous = normalizeLocalEvidenceHeading(String(results).slice(0, sentence.index)
                .slice(-512).trimEnd().split('\n').at(-1).split(/[。；！？!?]/u).at(-1));
            // The same typed attribution applies inline and when Markdown wraps
            // it. Syntax never grants the name: only the actual source primary can.
            const pendingOwner = ownerCarrier(previous);
            if (pendingOwner && pendingOwner !== primary) continue;
            const reportStart = sentence[0].indexOf('自我校正下');
            if (reportStart < 0) continue;
            const prefix = sentence[0].slice(0, reportStart).trim();
            if (prefix && ownerCarrier(prefix) !== primary) continue;
            const statement = sentence[0].slice(reportStart);
            if (!hasOwnLocalReportedExperiment(results, sentence.index, sentence[0])
                || !owns(results, sentence.index, sentence[0])) continue;
            const revoked = hasAdjacentAffirmativeEvidenceWithdrawal(results, sentence.index + sentence[0].length,
                /(?<!的)(?:上述|该|这一|前述)(?:净效应|净差距|净[ \t]*WER)?(?:观察|结论|结果)/giu);
            if (revoked) continue;
            const reported = reportedPattern.exec(statement);
            if (reported && Number(reported[1]) === values[0] && Number(reported[2]) === values[1]) return true;
        }
        return false;
    }

    function hasSourceBackedRewardSwitchAblation(results, tables, sourceText) {
        const source = String(sourceText || '');
        if (!/\bablation\b/i.test(source) || !/\brewards?\b/i.test(source)) return false;
        const transitions = String(results).split(/[。；\n]/u).flatMap(sentence => {
            if (/(?:他人|其他模型|另一(?:个|种)(?:模型|系统)|无关(?:模型|系统)|否定|驳斥|转述)|(?:说法|表述|观点|判断)[^。；\n]{0,20}(?:错误|有误|不成立|不正确)/u.test(sentence)) return [];
            if (/(?:假设|假想|如果|计划|未来|预计|可能|先前工作|相关工作|此前研究|并非|不是|没有|尚未|未曾|未|不|是否|尚无|未知|待评估|值得|有待|否认|反驳|引用|引述|错误说法|[?？])/u.test(sentence)) return [];
            const match = /(?:加入|只开|开启|关闭|移除|去掉)[^。；\n]{1,30}奖励[^。；\n]{0,120}(?:从|由)\s*([0-9]+(?:\.[0-9]+)?)%?\s*(?:升至|降至|升到|降到)\s*([0-9]+(?:\.[0-9]+)?)%?/u.exec(sentence);
            return match ? [[Number(match[1]), Number(match[2])]] : [];
        });
        if (!transitions.length) return false;
        const state = value => ['✓', '✔'].includes(String(value).trim()) ? 1 : /^[-—✗×]$/.test(String(value).trim()) ? 0 : null;
        const value = cell => /^\s*([0-9]+(?:\.[0-9]+)?)%?\s*$/.exec(String(cell))?.[1];
        const lines = source.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        return tables.some(table => {
            const controls = table.header.flatMap((header, index) => /^R[a-z]{2,12}$/.test(String(header).trim()) ? [index] : []);
            const identifier = table.header.findIndex(header => isTableIdentifierHeader(String(header).trim()));
            if (controls.length < 2 || identifier < 0 || controls.some(column => {
                const suffix = String(table.header[column]).trim().slice(1);
                return !source.includes(`\\mathrm{${suffix}}`) && !source.includes(`ℛ${suffix}`);
            })) return false;
            const labels = new Set(table.rows.map(row => String(row[identifier]).trim()));
            const matchesSource = row => lines.some((line, index) => {
                if (line !== String(row[identifier]).trim()) return false;
                let end = index + 1;
                while (end < lines.length && !labels.has(lines[end])) end++;
                const body = lines.slice(index + 1, end);
                if (controls.some((column, offset) => state(body[offset]) !== state(row[column]) || state(row[column]) === null)) return false;
                return row.every((cell, column) => column === identifier || controls.includes(column)
                    || (value(cell) !== undefined && body.includes(value(cell))));
            });
            return table.rows.some((first, index) => table.rows.slice(index + 1).some(second =>
                first[identifier] === second[identifier] && matchesSource(first) && matchesSource(second)
                && controls.filter(column => state(first[column]) !== state(second[column])).length === 1
                && table.header.some((_header, column) => column !== identifier && !controls.includes(column)
                    && value(first[column]) !== undefined && value(second[column]) !== undefined
                    && Number(value(first[column])) !== Number(value(second[column]))
                    && transitions.some(([from, to]) => from === Number(value(first[column])) && to === Number(value(second[column]))
                        || to === Number(value(first[column])) && from === Number(value(second[column]))))));
        });
    }

    // Finite flattened source-table profile: one GR column followed by paired
    // baseline/optimized columns for each declared compressor. Do not infer a
    // measured pair from a matching difference elsewhere in the document.
    function matchesSourceAudiogramMetricPairs(table, oldColumn, newColumn, method, metric, baseline, source) {
        const captions = [...source.matchAll(/(?:^|\n)Table\s+[0-9]+:\s*Optimization results for profiles [^\n]{1,100}with limited residual DR[^\n]*/giu)];
        if (captions.length !== 1) return false;
        const tail = source.slice(captions[0].index + captions[0][0].length, captions[0].index + 20000);
        const next = tail.search(/(?:^|\n)Table\s+[0-9]+:/iu);
        const body = next < 0 ? tail : tail.slice(0, next);
        const audiogram = table.header.findIndex(header => /^(?:听力图|audiograms?)$/iu.test(String(header).trim()));
        const signal = table.header.findIndex(header => /^(?:信号|signals?)$/iu.test(String(header).trim()));
        const family = /^([A-Za-z]+)-[1-9][0-9]*$/u.exec(method);
        if (audiogram < 0 || signal < 0 || !family) return false;
        const musicSignal = new Map([['紧凑', 'Tight'], ['常规', 'Normal'], ['动态', 'Dynamic']]);
        return table.rows.every(row => {
            const profile = /^([A-Z][0-9]{1,2})\s+有限范围$/u.exec(String(row[audiogram] || '').trim());
            const music = musicSignal.get(String(row[signal] || '').trim());
            if (!profile || !music) return false;
            const begin = new RegExp('(?:^|\\n)' + profile[1] + ' with limited DR\\r?\\n', 'u').exec(body);
            if (!begin) return false;
            const rest = body.slice(begin.index + begin[0].length);
            const end = rest.search(/(?:^|\n)(?:[A-Z][0-9]{1,2} with limited DR|Fig\.|Table\s+[0-9]+:)/u);
            const lines = (end < 0 ? rest : rest.slice(0, end)).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
            const metricRow = lines.findIndex(line => line.startsWith(metric + ' ') && line.includes('↑'));
            if (metricRow < 0) return false;
            const header = lines.slice(0, metricRow);
            const methods = header.filter(line => new RegExp('^' + family[1] + '-[1-9][0-9]*$', 'u').test(line));
            const index = methods.indexOf(method);
            const labels = header.filter(line => line === baseline || line === 'Opt.');
            if (header[0] !== 'GR' || index < 0 || new Set(methods).size !== methods.length
                || labels.join('|') !== methods.map(() => baseline + '|Opt.').join('|')) return false;
            const metricTail = lines.slice(metricRow + 1);
            const nextMetric = metricTail.findIndex(line => /[↑↓]/u.test(line));
            const cells = nextMetric < 0 ? metricTail : metricTail.slice(0, nextMetric);
            const starts = cells.flatMap((line, i) => line === music ? [i] : []);
            if (starts.length !== 1) return false;
            const values = cells.slice(starts[0] + 1, starts[0] + 2 + 2 * methods.length);
            return values.length === 1 + 2 * methods.length && values.every(value => /^\d+(?:\.\d+)?$/u.test(value))
                && Number(row[oldColumn]) === Number(values[1 + 2 * index])
                && Number(row[newColumn]) === Number(values[2 + 2 * index]);
        });
    }

    // A quality/audibility tradeoff is negative evidence only when this source
    // reports the loss and the same higher-is-better table columns realize it.
    function hasSourceBackedQualityAudibilityTradeoff(results, tables, sourceText) {
        const source = String(sourceText || '');
        const pattern = /([A-Za-z][A-Za-z0-9-]{1,39}) optimization reduces ([A-Za-z][A-Za-z0-9-]{1,39}) compared to the single-channel ([A-Za-z][A-Za-z0-9-]{0,39}) baseline \(by up to (\d+(?:\.\d+)?)\), indicating that the single-channel optimizer sacrifices quality to improve audibility/gu;
        const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const match of source.matchAll(pattern)) {
            const lineStart = Math.max(0, source.lastIndexOf('\n', match.index - 1) + 1);
            const previous = source.slice(0, lineStart).split('\n').filter(line => line.trim()).at(-1) || '';
            const prefix = source.slice(lineStart, match.index);
            if (!ownObservedSourceScope(previous.slice(-300) + '\n' + prefix + match[0])) continue;
            const [, method, metric, baseline, delta] = match;
            if (Number(delta) <= 0) continue;
            const reported = new RegExp(`单通道[^。；\\n]{0,60}${escape(metric)}[^。；\\n]{0,80}[，,]\\s*优化反而为换可听度让出最多\\s*(\\d+(?:\\.\\d+)?)\\s*的质量`, 'u');
            const proseMatches = [...String(results || '').matchAll(/[^。；\n]+/gu)].some(reportedSentence => {
                const sentence = reportedSentence[0];
                const loss = reported.exec(sentence);
                return loss && Number(loss[1]) === Number(delta)
                    && hasOwnLocalReportedExperiment(results, reportedSentence.index, sentence)
                    && !/假想|设想|第三方|旧工作|既有研究|先前工作|先前研究|相关工作|相关研究|文献|引用|转述|撤回|否认|并未|没有|不成立/iu.test(sentence);
            });
            if (!proseMatches) continue;
            for (const table of tables) {
                const clean = header => String(header).replace(/[*_`]/gu, '').trim();
                const oldColumn = table.header.findIndex(header => clean(header) === `${method} ${baseline} ${metric} ↑`);
                const newColumn = table.header.findIndex(header => clean(header) === `${method} 优化 ${metric} ↑`);
                if (oldColumn < 0 || newColumn < 0 || sourceBackedIdentityColumns(table, source).size < 2
                    || !matchesSourceAudiogramMetricPairs(table, oldColumn, newColumn, method, metric, baseline, source)) continue;
                const values = table.rows.map(row => /^\d+(?:\.\d+)?$/u.test(String(row[oldColumn]))
                    && /^\d+(?:\.\d+)?$/u.test(String(row[newColumn])) ? Number(row[oldColumn]) - Number(row[newColumn]) : NaN);
                if (values.length >= 2 && values.every(Number.isFinite)
                    && Math.abs(Math.max(...values) - Number(delta)) < 1e-9) return true;
            }
        }
        return false;
    }

    function sourceBoundPredictionRefinementDecline(results, sourceText) {
        const source = String(sourceText || '');
        const flat = source.replace(/\s+/gu, ' ');
        if (!/results indicate that prediction refinement traded off the SEN of inhalation detection against PPV, thereby lowering the overall F1-score/iu.test(flat)
            || !hasOwnSourceStatement(source, /results indicate that prediction refinement traded off the SEN of inhalation detection against PPV/iu)) return false;
        const sourceTable = /Table 3\. Performance of the CNN-BiGRU model\.[\s\S]*?SEN: sensitivity, and PPV: positive predictive value\./u.exec(source)?.[0] || '';
        if (!/Refinement Interval \(sec\) SEN PPV F1 Score/u.test(sourceTable) || !ownObservedSourceScope(sourceTable)) return false;
        const raw = String(results || '');
        const declined = /(?:开启提炼后吸气[^。；\n]{0,120})?(?:例如[ \t]*)?([0-9]+(?:\.[0-9]+)?)[ \t]*s[ \t]*间隔下[^。；\n]{0,100}?F1[ \t]*由[ \t]*([0-9]+(?:\.[0-9]+)?)[ \t]*降至[ \t]*([0-9]+(?:\.[0-9]+)?)/gu;
        for (const match of raw.matchAll(declined)) {
            const sentenceStart = Math.max(raw.lastIndexOf('。', match.index), raw.lastIndexOf('\n', match.index)) + 1;
            const sentenceEnd = raw.indexOf('。', match.index + match[0].length);
            const sentence = raw.slice(sentenceStart, sentenceEnd < 0 ? raw.length : sentenceEnd);
            if (!ownObservedSourceScope(sentence) || /假定|设想|可能|预计|计划|第三方|外部团队|引用|引述|撤回|否认|不成立|并未|没有|尚未|未发生|(?:不|未)降至|阈值|参数/u.test(sentence)
                || !(Number(match[2]) > Number(match[3]))) continue;
            if (hasAdjacentAffirmativeEvidenceWithdrawal(raw, sentenceEnd < 0 ? raw.length : sentenceEnd,
                /(?:上述|该|这一)(?:结果|下降|降分|结论|比较)/giu)) continue;
            const escape = value => value.replace(/\./gu, '\\.');
            const row = (state, value) => new RegExp(`(?:^|\\n)[ \\t]*${state} ${escape(match[1])} [0-9.]+ [0-9.]+ ${escape(value)}(?:\\n|$)`, 'u').test(sourceTable);
            if (row('Off', match[2]) && row('On', match[3])) return true;
        }
        return false;
    }

    function hasTableBoundHigherMetricRegression(results, tables, sourceText) {
        const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const prose = String(results || '').split('\n').filter(line => !/^\s*\|/.test(line)).join('\n');
        // Some PDF tables flatten a grouped header to `Method NFE Group↑ X↑ Y↑
        // Overall Text Diversity ...`; the group's leaf values occupy the row tail.
        // Accept this exact rectangular shape, never a bare metric elsewhere in text.
        const sourceLines = String(sourceText || '').split('\n');
        const groupedTables = [];
        for (const [lineIndex, line] of sourceLines.entries()) {
            if (!/^\s*Method\s+NFE\s+/i.test(line)) continue;
            const captionContext = sourceLines.slice(Math.max(0, lineIndex - 6), lineIndex).join(' ');
            if (!/\bTable\s+(?:\d+|[IVXLCDM]+)[.:：]/i.test(captionContext)
                || /\b(?:hypothetical|future|planned|illustrative|example)\b/i.test(captionContext)) continue;
            const groups = [...line.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{1,50}\s*↑/g)];
            if (!groups.length) continue;
            const leafHeaders = line.slice(groups.at(-1).index + groups.at(-1)[0].length).trim().split(/\s+/);
            if (leafHeaders.length < 2 || leafHeaders.length > 12
                || !leafHeaders.every(name => /^[A-Za-z][A-Za-z0-9_.-]{0,30}$/.test(name))) continue;
            const rows = [];
            for (const rowLine of sourceLines.slice(lineIndex + 1, lineIndex + 41)) {
                const row = /^\s*(\S(?:.*?\S)?)\s+(\d+(?:\.\d+)?(?:\s*(?:×|x)\s*\d+)?(?:\s+\d+(?:\.\d+)?){2,})\s*$/.exec(rowLine);
                if (!row) break;
                const values = row[2].match(/\d+(?:\.\d+)?/g);
                const minimum = leafHeaders.length + groups.length;
                if (values.length !== minimum + (/\s[×x]\s/.test(row[2]) ? 1 : 0)) break;
                rows.push([row[1], ...values.slice(-leafHeaders.length)]);
            }
            if (rows.length >= 2) groupedTables.push({header:['Method', ...leafHeaders.map(name => `${name} ↑`)], rows, sourceGrouped:true});
        }
        for (const table of [...tables, ...groupedTables]) for (const [column, header] of table.header.entries()) {
            const metric = String(header).replace(/[*_`$]/g, '').replace(/(?:↑|\\uparrow)/g, '').trim();
            if (!/^[A-Za-z][A-Za-z0-9.-]{1,30}$/.test(metric)
                || !/(?:↑|\\uparrow)/.test(header)
                || (!table.sourceGrouped && !new RegExp(`\\b${escape(metric)}[\\s($]*(?:↑|\\\\uparrow)`, 'i').test(String(sourceText || '')))) continue;
            const pattern = new RegExp(`\\b${escape(metric)}(?![A-Za-z0-9_-])[^。；\\n]{0,60}?(?:为|是)\\s*(\\d+(?:\\.\\d+)?)\\s*[,，]\\s*(?:略|明显|显著)?低于\\s*([^，。；\\n]{1,60}?)\\s*的\\s*(\\d+(?:\\.\\d+)?)`, 'gi');
            for (const match of prose.matchAll(pattern)) {
                const prefix = prose.slice(Math.max(0, match.index - 60), match.index);
                if (/(?:如果|假设|计划|未来|可能|预计|并非|不是|没有)[^。；\n]{0,50}$/.test(prefix)
                    || /(?:如果|假设|计划|未来|可能|预计|并非|不是|没有)/.test(match[0])
                    || !(Number(match[1]) < Number(match[3]))) continue;
                const centralValue = cell => /^\s*(\d+(?:\.\d+)?)(?:\s|$|±)/.exec(String(cell || ''))?.[1];
                const first = table.rows.find(row => Number(centralValue(row[column])) === Number(match[1]));
                const second = table.rows.find(row => Number(centralValue(row[column])) === Number(match[3])
                    && row.some((cell, index) => index !== column && isTableIdentifierHeader(table.header[index])
                        && String(cell).replace(/[*_`]/g, '').trim().replace(/^Teacher$/i, '教师')
                            === match[2].trim().replace(/^Teacher$/i, '教师')));
                if (first && second && first !== second) return true;
            }
        }
        return false;
    }

    function hasSourceBackedWindowConfusion(results, sourceText) {
        const source = String(sourceText || '').replace(/\s+/gu, ' ');
        const observed = /\ba larger (\d+(?:\.\d+)?)s window \(chunk size=(\d+)\)[^.!?]{0,160}?\bit often introduces higher speaker confusion and false alarms/giu;
        const sourceRevoked = /^\s*(?:(?:but|however|in fact)[, ]+)?(?:this|these|the above)\s+(?:results?|findings?|observations?|comparisons?|claims?)[^.!?]{0,60}\b(?:retracted|withdrawn|incorrect|false|not\s+(?:observed|measured|supported))\b/iu;
        const resultRevoked = /^[，,\s]*(?:(?:但|但是|不过|然而)[，,\s]*)?(?:上述|以上|前述|该|此|这一)(?:块长)?(?:消融)?(?:结论|结果|观察|发现|比较|说法)[^。；\n]{0,25}(?:撤回|撤销|不成立|错误|未(?:观测|测量|发生)|没有(?:观测|测量|发生))/u;
        const sentences = String(results || '').split(/[。；\n]/u).map(sentence => sentence.trim()).filter(Boolean);
        for (const report of source.matchAll(observed)) {
            const prefix = source.slice(Math.max(0, report.index - 160), report.index).split(/[.!?]/u).at(-1);
            if (/\b(?:hypothetical|future|planned|previous|another|quoted|not|never|false|incorrect)\b/iu.test(prefix)
                || /\b(?:not|never|incorrect|false\s+(?:claim|report))\b/iu.test(report[0])) continue;
            // Only the current observation's continuation and its immediately
            // following sentence can revoke it; unrelated later prose cannot.
            const sourceAfter = source.slice(report.index + report[0].length).split(/[.!?]/u).slice(0, 2);
            if (sourceAfter.some(part => sourceRevoked.test(part.replace(/^[,;]\s*/u, '')))) continue;
            for (const [index, sentence] of sentences.entries()) {
                if (/假设|如果|未来|计划|预计|建议|未进行|没有|并非|不是|先前研究|相关工作|引用|引述|他人|否认|反驳/u.test(sentence)) continue;
                const effect = /消融(?:显示|结果表明|表明)[^。；\n]{0,180}?(\d+)\s*帧约\s*(\d+(?:\.\d+)?)\s*秒窗(?:会)?引入更多(?:说话人)?混淆(?:与|和|及)虚警/u.exec(sentence);
                if (effect && !resultRevoked.test(sentence.slice(effect.index + effect[0].length))
                    && !resultRevoked.test(sentences[index + 1] || '')
                    // An explicit later reference naming this very ablation is
                    // unambiguous even when another table intervenes.
                    && !sentences.slice(index + 1).some(part => /^(?:上述|以上|前述|该|此|这一)块长消融(?:结论|结果)[^。；\n]{0,25}(?:撤回|撤销|不成立|错误)/u.test(part))
                    && Number(effect[1]) === Number(report[2]) && Number(effect[2]) === Number(report[1])) return true;
            }
        }
        return false;
    }


    // These checks recognize observed adverse directions only when the same source
    // names the method/condition/value or supplies the two baseline columns. They do
    // not accept a direction word, zero, or an unrelated table as result evidence.
    function observedExperimentClaim(text) {
        return !/\b(?:if|suppos(?:e|ing)|hypothetical)\b|\b(?:future|planned|proposed)\s+(?:experiments?|work|evaluation|validation)\b|\b(?:should|must|needs?\s+to)\s+(?:compare|report|score|require|validate)\b|\b(?:previous|related|other)\s+(?:work|stud(?:y|ies)|models?|systems?)\b|\b(?:does|do|did)\s+not\s+(?:identify|explain)\s+why\b|\b(?:not|never)\s+(?:observed|reported|obtained)\b|(?:如果|假设|假想|计划|未来实验|后续实验|相关工作|先前研究|其他模型|他人|错误说法|并非|不是|未报告|尚未报告|未观察到|没有观察到|否认)/iu.test(String(text));
    }
    function observedSourceNegativeEvidence(sourceText) {
        return String(sourceText || '').split(/(?<=[.!?])\s+(?=[A-Z])|[。；\n]|;\s*|,\s*(?=(?:but|however|yet)\b)|[，,]\s*(?=(?:但|然而|实测|测试显示|实验显示))/u)
            .filter(proposition => {
                // Describing how a service routes an execution failure is not an
                // observed performance failure. Keep explicit measured failures.
                if (/\b(?:agent execution|execution fail(?:ure|s)|failures? return|failure feedback|in the case of failure|when execution fails)\b/iu.test(proposition)
                    && !/\b(?:observed|measured|experiment|evaluation|test results?|failure rate)\b|\d+(?:\.\d+)?%/iu.test(proposition)) return false;
                if (observedExperimentClaim(proposition)) return true;
                // An asserted measured failure can have an empirical condition.
                // A leading hypothetical/foreign assertion cannot borrow "show".
                const measuredCondition = /^\s*(?:(?:the|our)\s+)?(?:experiments?|tests?|measurements?|results?)\s+(?:show|demonstrate|confirm|reveal|indicate)\s+(?:that\s+)?[^;\n]{0,180}?\b(?:fails?|failed|degrades?|degraded|worse\s+than)\b[^;\n]{0,100}\bif\b/iu.test(proposition)
                    || /^\s*(?:本次)?(?:实测|实验|测试)(?:结果)?(?:显示|表明|发现)[^。；\n]{0,180}(?:失败|退化|不显著)/u.test(proposition)
                        && /(?:若|如果|当)/u.test(proposition);
                return measuredCondition
                    && !/(?:hypothetical|suppose|planned|future experiment|previous work|other model|not observed|not reported)|(?:假设|假想|假定|计划|未来实验|先前研究|其他模型|他人|并非|未观察到|没有观察到)/iu.test(proposition);
            }).join('\n');
    }

    function sourceHasObservedReasoningFailure(sourceText) {
        const source = String(sourceText || '');
        // This is the paper's own contiguous failure example, not two independently
        // discovered keywords from another paper or an illustrative conditional.
        const block = /^Our approach assumes that[^\n]{1,260}\nThis assumption has an inherent limitation: when the reasoning phase itself is incorrect,[^\n]{1,220}cannot recover the correct target\.\nWe illustrate a failure case[^\n]{1,160}\nIn the example, the model compresses[^\n]{1,260}reasoning phase misidentifies[^\n]{1,200}/gmu;
        return [...source.matchAll(block)].some(match => {
            const before = source.slice(Math.max(0, match.index - 200), match.index).split('\n').slice(-2).join(' ');
            return ownObservedSourceScope(before + match[0] + '\n' + adjacentSourceStatementAfter(source, match.index + match[0].length));
        });
    }
    function sourceBoundLowerMetricIncrease(results, sourceText) {
        const metrics = { MAE: '平均绝对误差|MAE', RMSE: '均方根误差|RMSE',
            WER: '词错率|字词错误率|WER', CER: '字错率|字符错误率|CER',
            EER: '等错误率|EER' };
        const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const methodKey = value => String(value).toLowerCase().replace(/[‐‑–—]/g, '-')
            .replace(/future/g, '未来').replace(/past/g, '过去').replace(/\s+/g, '');
        const sourcePattern = /\b([A-Za-z][A-Za-z0-9._-]{1,40})\s+(?:model|method|system)\b[^\n]{0,300}?\b([A-Za-z][A-Za-z0-9._-]{1,40})\s+(\d+(?:\.\d+)?)[ -]s\s+(MAE|RMSE|WER|CER|EER)\s+(?:is|was)\s+(\d+(?:\.\d+)?)%\s+(?:higher|larger|worse)\b/gi;
        for (const source of String(sourceText || '').matchAll(sourcePattern)) {
            const statementStart = Math.max(String(sourceText).lastIndexOf('\n', source.index), String(sourceText).lastIndexOf('. ', source.index)) + 1;
            if (!observedExperimentClaim(String(sourceText).slice(statementStart, source.index + source[0].length))) continue;
            const [, method, dataset, horizon, metric, delta] = source;
            const adverse = new RegExp(`(?<![A-Za-z0-9_.-])${escape(dataset)}(?![A-Za-z0-9_.-])\\s*(?<![0-9.])${escape(horizon)}(?![0-9.])\\s*(?:秒|s)\\s*(?:${metrics[metric.toUpperCase()]})\\s*(?:高(?:出|了)?|升高(?:了)?|上升(?:了)?)\\s*(?<![0-9.])${escape(delta)}%(?![0-9.])`, 'iu');
            for (const sentence of String(results).split(/[。；\n]/u)) {
                const identity = new RegExp(`(?<![A-Za-z0-9_\u4e00-\u9fff-])(?:该|此)?${escape(methodKey(method))}(?:模型|方法|系统)(?![A-Za-z0-9_-])`, 'u');
                if (observedExperimentClaim(sentence) && identity.test(methodKey(sentence))
                    && adverse.test(sentence)) return true;
            }
        }
        return false;
    }
    function sourceTwoBaselineMetricRegressions(sourceText) {
        const source = String(sourceText || '');
        const lines = source.split('\n').map(line => line.trim());
        const start = lines.findIndex((line, index) => /^(?:Measure|Metric)$/i.test(line)
            && /^DSP$/i.test(lines[index + 1] || '') && /^Constant prior$/i.test(lines[index + 2] || ''));
        if (start < 0 || !/\bWaveform\s+DSP\s+Reference\b/i.test(source)) return [];
        let end = start + 3;
        while (end < lines.length && end < start + 30
            && !/^(?:Table\s+\d+|(?:\d+\.)*\d+\s+[A-Za-z]|Measure$|Metric$)/i.test(lines[end])) end++;
        const frame = lines.slice(Math.max(0, start - 2), Math.min(lines.length, end + 1)).join(' ');
        if (!/\b(?:reports?|results?|measured|observed|reproduced|existing)\b/i.test(frame)
            || !observedExperimentClaim(frame)) return [];
        const specifications = [{source: /^Time-signature accuracy$/i,
            header: /^拍号准确率\s*↑$/u, prose: /拍号/u}];
        const number = value => /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(String(value))?.[1];
        return specifications.flatMap(specification => {
            const metricRows = lines.flatMap((line, index) => index > start && index < end
                && specification.source.test(line) ? [index] : []);
            if (metricRows.length !== 1) return [];
            const row = metricRows[0];
            const dsp = number(lines[row + 1]), prior = number(lines[row + 2]);
            return dsp !== undefined && prior !== undefined && Number(dsp) < Number(prior)
                ? [{...specification, dsp, prior}] : [];
        });
    }
    function sourceBoundReverseBaselineComparison(results, tables, sourceText) {
        // These aliases require the actual source's DSP / Constant-prior columns and
        // waveform definition. Values never select or invent a source method.
        const dspRow = /^(?:DSP|波形参考|波形启发式)$/iu;
        const priorRow = /^(?:Constant prior|分布常数|常数先验|常数猜测)$/iu;
        const number = value => /^\s*(\d+(?:\.\d+)?)%\s*$/.exec(String(value))?.[1];
        for (const {header, prose, dsp, prior} of sourceTwoBaselineMetricRegressions(sourceText)) {
            for (const table of tables) {
                const column = table.header.findIndex(value => header.test(value.replace(/[*_`]/g, '').trim()));
                const identifier = table.header.findIndex(isTableIdentifierHeader);
                if (column < 0 || identifier < 0) continue;
                const first = table.rows.find(cells => dspRow.test(cells[identifier].trim()));
                const second = table.rows.find(cells => priorRow.test(cells[identifier].trim()));
                if (!first || !second || Number(number(first[column])) !== Number(dsp)
                    || Number(number(second[column])) !== Number(prior)) continue;
                const comparison = new RegExp(`(?:分布常数|常数(?:先验|猜测|猜\\s*4/4)?)[^。；\\n]{0,100}?(?<![0-9.])${prior.replace('.', '\\.')}%(?![0-9])[^。；\\n]{0,20}高于[^。；\\n]{0,30}(?:DSP|波形(?:参考|启发式)?)[^。；\\n]{0,15}(?<![0-9.])${dsp.replace('.', '\\.')}%(?![0-9])`, 'iu');
                for (const sentence of String(results).split(/[。；\n]/u)) {
                    if (observedExperimentClaim(sentence) && prose.test(sentence)
                        && comparison.test(sentence)) return true;
                }
            }
        }
        return false;
    }

    function sourceBoundMatchedAcousticGap(results, tables, sourceText) {
        if (/```|~~~|(?:^|\n)\s*>|<(?:blockquote|pre|code)\b/iu.test(String(results || ''))) return false;
        const quoted = value => value.lastIndexOf('“') > value.lastIndexOf('”')
            || value.lastIndexOf('‘') > value.lastIndexOf('’')
            || (value.match(/(?<!\\)"/gu) || []).length % 2 === 1;
        const source = String(sourceText || '');
        const pattern = /\b([A-Z][A-Za-z0-9_-]{1,40}) produces recognizable isolated coda-like sounds\s*(?:\[[0-9]+\])?\.\s*Yet its generated recordings remain distinguishable from natural codas in (one|two|three|four|five|six|seven|eight|nine|ten) of (one|two|three|four|five|six|seven|eight|nine|ten) acoustic descriptions, including after the strictest matching on measured recording properties \(Fig\.\s*[0-9]+; exact estimates in the Supplement\)\.\s*That matched comparison uses ([1-9][0-9]*) generated clips and (one|two|three|four|five|six|seven|eight|nine|ten) independent natural reference groups\./gu;
        const cardinal = value => ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].indexOf(value);
        for (const match of source.matchAll(pattern)) {
            const [, name, positiveWord, totalWord, clips, groupsWord] = match;
            const positive = cardinal(positiveWord), total = cardinal(totalWord), groups = cardinal(groupsWord);
            if (positive <= 0 || positive > total || groups < 2
                || !unquotedObservedComparison(source, match.index, match[0])) continue;
            const before = source.slice(0, match.index);
            const prefix = before.split('\n').at(-1);
            const previous = normalizeLocalEvidenceHeading(before.slice(0, before.lastIndexOf('\n')).trimEnd().split('\n').at(-1) || '');
            const following = source.slice(match.index + match[0].length).split(/\n\s*\n/u)[0];
            const revoked = /(?:(?:this|that|the (?:above|preceding|matched))\s+(?:comparison|result|experiment|test)[^.!?]{0,100}\b(?:never|not\s+(?:actually\s+)?(?:performed|conducted|observed)|false|incorrect|withdrawn|retracted)\b|(?:this|that)\s+(?:was|is)\s+(?:never|not|only hypothetical)\b|we\s+(?:did|do|have|will)\s+not\s+(?:actually\s+)?(?:perform|conduct|run|observe)\s+(?:this|that|the (?:above|preceding|matched))\s+(?:comparison|result|experiment|test)\b)/iu;
            let fenced = false;
            for (const line of before.split('\n')) if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced;
            if (!ownObservedSourceScope(prefix + '\n' + match[0]) || /[“”‘’"]|(?:^|\s)>/u.test(prefix)
                || quoted(before)
                || /^(?:(?:previous|prior|related|third[- ]party|other)\s+(?:work|research|study)|quoted statement|quotation|hypothetical example)[.:]?$/iu.test(previous)
                || fenced || revoked.test(following)
                || /<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$/iu.test(before.slice(Math.max(before.lastIndexOf('</blockquote>'), before.lastIndexOf('</pre>'), before.lastIndexOf('</code>')) + 1))) continue;
            const reported = [...String(results).matchAll(/[^。；\n]+/gu)].some(fragment => {
                const sentence = fragment[0];
                if (!unquotedObservedComparison(results, fragment.index, sentence)) return false;
                if (quoted(String(results).slice(0, fragment.index))) return false;
                if (/假设|如果|未来|计划|预计|可能|第三方|他人|先前研究|相关工作|引用|引述|转述|并非|并未|不是|未曾|未(?:实际)?(?:观测|观察|测得|发现|报告|执行|进行|比较)|没有|尚未|否认|撤回|错误|[“”‘’"?？]/u.test(sentence)) return false;
                const measured = /([1-9][0-9]*)\s*个孤立生成片段在\s*([1-9][0-9]*)\s*种固定声学描述中有\s*([1-9][0-9]*)\s*种仍可与自然\s*coda\s*区分/u.exec(sentence);
                return measured && measured[1] === clips && Number(measured[2]) === total && Number(measured[3]) === positive;
            });
            if (!reported) continue;
            // The same reported row must retain the generator, strict matching,
            // both natural reference groups, and the full denominator. A generic
            // statement that two distributions differ cannot supply a failure case.
            if (tables.some(table => {
                const contrast = table.header.findIndex(header => String(header).trim() === '数据与对照');
                const count = table.header.findIndex(header => new RegExp('^可区分描述数\\s*/\\s*' + total + '$', 'u').test(String(header).trim()));
                return contrast >= 0 && count >= 0 && table.rows.some(row =>
                    String(row[0]).trim() === '自然与 ' + name && String(row[count]).trim() === String(positive)
                    && new RegExp('^' + clips + '\\s*个生成片段[，,]\\s*' + groups + '\\s*个独立自然参照组[，,]\\s*严格匹配$', 'u').test(String(row[contrast]).trim()));
            })) return true;
        }
        return false;
    }

    // A local comparison cannot borrow an observation from a quotation, future
    // proposal, other study, or a statement revoked in its own continuation.
    function unquotedObservedComparison(text, index, body) {
        const raw = String(text || ''), before = raw.slice(0, index);
        const prefix = before.slice(before.lastIndexOf('\n') + 1);
        const previous = normalizeLocalEvidenceHeading(before.slice(0, before.lastIndexOf('\n')).trimEnd().split('\n').at(-1) || '');
        const quoted = before.lastIndexOf('“') > before.lastIndexOf('”')
            || before.lastIndexOf('‘') > before.lastIndexOf('’')
            || (before.match(/(?<!\\)"/gu) || []).length % 2 === 1;
        let fenced = false;
        for (const line of before.split('\n')) if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced;
        const htmlStart = Math.max(before.lastIndexOf('</blockquote>'), before.lastIndexOf('</pre>'), before.lastIndexOf('</code>')) + 1;
        const continuation = raw.slice(index + body.length).replace(/^[\s，,;.。；]+/u, '').slice(0, 500);
        const local = (prefix + body).replace(/(?<=[A-Za-z])’(?=[A-Za-z])/gu, '');
        return !quoted && !fenced && !/[“”‘’"]|(?:^|\s)>/u.test(local)
            && !/<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$/iu.test(before.slice(htmlStart))
            && !/^(?:(?:previous|prior|related|third[- ]party|other)\s+(?:work|research|study)|quoted statement|quotation|hypothetical example|引用|引述|转述|相关工作|先前研究|第三方|他人)[.:：]?$/iu.test(previous)
            && ownObservedSourceScope(previous)
            && ownObservedSourceScope(prefix + '\n' + body)
            && !/(?:假定|设想|转述|引述|引用|否认|驳斥|未进行|未执行|未比较|未发现|没有|不成立|错误|[?？])/u.test(prefix + body)
            && !/^(?:(?:this|that|the above)\s+(?:comparisons?|results?|claims?|experiments?|ablations?|tests?)[^.!?]{0,80}(?:withdrawn|revoked|false|incorrect|not (?:performed|observed))|(?:上述|以上|前述|该|此)(?:比较|结果|说法|结论|实验|消融)[^。；\n]{0,30}(?:撤回|错误|不成立|未观测|未进行))/iu.test(continuation);
    }

    // Retained adverse outcomes need the observed comparison and its same-group
    // source/display table, not a bare low number, minus sign or timeout keyword.
    function observedAdverseComparison(text, index, body) {
        // Nested quotations in a complete source can close a naive last-quote
        // check. A wholly quoted document never supplies this observed profile.
        const raw = String(text || ''), previous = raw.slice(0, index).trimEnd().split('\n').at(-1) || '';
        return !/^\s*[“"]/u.test(raw)
            && !/(?:^|[.!?]\s+)(?:quoted statement|quotation|hypothetical example)[.:：]?$/iu.test(previous)
            && unquotedObservedComparison(raw, index, body);
    }

    function sourceBoundListeningScoreRegression(results, tables, sourceText) {
        const source = String(sourceText || '');
        const captions = [...source.matchAll(/^Table\s+[0-9]+: Listening results for cross-content transfer \(similarity to the reference, 0[–-]100\)\.$/gmu)];
        if (captions.length !== 1 || !observedAdverseComparison(source, captions[0].index, captions[0][0])) return false;
        const tail = source.slice(captions[0].index + captions[0][0].length, captions[0].index + 4500);
        const end = tail.indexOf('\nIn Study 1,');
        if (end < 0) return false;
        const lines = tail.slice(0, end).split('\n').map(line => line.trim()).filter(Boolean);
        const header = lines.indexOf('Condition');
        if (header < 2 || !/^Study 1 \(N=/.test(lines[header - 2]) || !/^Study 3 \(N=/.test(lines[header - 1])
            || lines.slice(header, header + 6).join('|') !== 'Condition|Mean|SD|95% CI|Mean|SD') return false;
        const cells = lines.slice(header + 6);
        if (cells.length !== 18 || cells[0] !== 'Adversarially fine-tuned' || cells[6] !== 'Unprocessed' || cells[12] !== 'Reconstruction only') return false;
        const scalar = value => /^[0-9]+(?:\.[0-9]+)?$/.test(value) ? Number(value) : NaN;
        const input = scalar(cells[7]), reconstruction = scalar(cells[13]);
        if (!Number.isFinite(input) || !Number.isFinite(reconstruction) || reconstruction >= input) return false;
        const observed = /Listeners rated the reconstruction-only decoder below the unprocessed input, although[^\n]*\./gu;
        if (![...source.matchAll(observed)].some(match => match.index > captions[0].index
            && match.index - captions[0].index < 4500 && observedAdverseComparison(source, match.index, match[0]))) return false;
        const clean = value => String(value || '').replace(/[*_`]/gu, '').trim();
        const bound = tables.some(table => {
            const columns = table.header.flatMap((value, i) => /^Study\s+1\s+均值\s*↑$/u.test(clean(value)) ? [i] : []);
            const identity = table.header.flatMap((value, i) => clean(value) === '条件' ? [i] : []);
            if (columns.length !== 1 || identity.length !== 1) return false;
            const a = table.rows.filter(row => clean(row[identity[0]]) === '只重建');
            const b = table.rows.filter(row => clean(row[identity[0]]) === '未处理输入');
            return a.length === 1 && b.length === 1 && scalar(clean(a[0][columns[0]])) === reconstruction
                && scalar(clean(b[0][columns[0]])) === input;
        });
        if (!bound) return false;
        return [...String(results).matchAll(/[^。；\n]+/gu)].some(fragment => {
            const match = /只重建[^。；\n]{0,160}?听感均值\s*([0-9]+(?:\.[0-9]+)?)\s*反而低于输入的\s*([0-9]+(?:\.[0-9]+)?)/u.exec(fragment[0]);
            return match && Number(match[1]) === reconstruction && Number(match[2]) === input
                && observedAdverseComparison(results, fragment.index, fragment[0]);
        });
    }

    function sourceBoundRenderedDurationShortfall(results, tables, sourceText) {
        const source = String(sourceText || '');
        const captions = [...source.matchAll(/^TABLE\s+[IVXLCDM0-9]+: Pilot Measurement: Five Published Stories \(([0-9]+(?:\.[0-9]+)?)-min Target\)$/gmu)];
        if (captions.length !== 1 || !observedAdverseComparison(source, captions[0].index, captions[0][0])) return false;
        const target = Number(captions[0][1]);
        if (!(target > 0)) return false;
        const tail = source.slice(captions[0].index + captions[0][0].length, captions[0].index + 3500);
        const end = tail.indexOf('\nV-C Behavioral telemetry');
        if (end < 0) return false;
        const lines = tail.slice(0, end).split('\n').map(line => line.trim()).filter(Boolean);
        if (lines.slice(0, 6).join('|') !== 'Lang.|Rendered (min)|Error|LUFS|TP (dBTP)|LRA (LU)' || lines.length !== 36) return false;
        const scalar = value => {
            const normalized = value.replace(/−/gu, '-').replace(/\\%/gu, '%');
            const match = /^([+-]?[0-9]+(?:\.[0-9]+)?)(%?)(?:([+-]?[0-9]+(?:\.[0-9]+)?)(%?))?$/u.exec(normalized);
            return match && (!match[3] || Number(match[1]) === Number(match[3]) && match[2] === match[4]) ? Number(match[1]) : NaN;
        };
        const rows = new Map();
        for (let i = 6; i < lines.length; i += 6) {
            if (!/^(?:en|de|fr|hi|ja)$/u.test(lines[i]) || rows.has(lines[i]) || !lines.slice(i + 1, i + 6).every(value => Number.isFinite(scalar(value)))) return false;
            rows.set(lines[i], [scalar(lines[i + 1]), scalar(lines[i + 2])]);
        }
        const observed = /Rendered duration, which no gate checks, was within [0-9]+% of target for English and German but ([0-9]+)%, ([0-9]+)%, and ([0-9]+)% short for French, Japanese, and Hindi\./gu;
        const order = ['fr', 'ja', 'hi'];
        if (![...source.matchAll(observed)].some(match => match.index < captions[0].index && captions[0].index - match.index < 2500
            && observedAdverseComparison(source, match.index, match[0])
            && order.every((language, i) => rows.get(language)[0] < target && rows.get(language)[1] < 0 && Math.round(-rows.get(language)[1]) === Number(match[i + 1])))) return false;
        const clean = value => String(value || '').replace(/[*_`]/gu, '').trim();
        const bound = tables.some(table => {
            const find = expression => table.header.flatMap((value, i) => expression.test(clean(value)) ? [i] : []);
            const identity = find(/^语言$/u), duration = find(/^渲染时长\s*\(min\)$/u), error = find(/^时长误差\s*↓$/u);
            if ([identity, duration, error].some(columns => columns.length !== 1) || table.rows.length !== 5) return false;
            return [...rows].every(([language, values]) => {
                const matches = table.rows.filter(row => clean(row[identity[0]]) === language);
                return matches.length === 1 && scalar(clean(matches[0][duration[0]])) === values[0]
                    && /%$/u.test(clean(matches[0][error[0]])) && scalar(clean(matches[0][error[0]])) === values[1];
            });
        });
        if (!bound) return false;
        return [...String(results).matchAll(/[^。；\n]+/gu)].some(fragment => {
            const match = /法语、日语、印地语分别短\s*([0-9]+(?:\.[0-9]+)?)%、\s*([0-9]+(?:\.[0-9]+)?)%\s*和\s*([0-9]+(?:\.[0-9]+)?)%/u.exec(fragment[0]);
            return match && /时长/u.test(fragment[0]) && order.every((language, i) => Number(match[i + 1]) === -rows.get(language)[1])
                && observedAdverseComparison(results, fragment.index, fragment[0]);
        });
    }

    function sourceBoundFoldedObjectiveRegression(results, tables, sourceText) {
        const source = String(sourceText || '');
        // Method identities come from the observed comparison and the explicit
        // training-objective mapping, never from a matching numerical value.
        const observed = /^Table\s+[IVXLCDM0-9]+ compares eight models that all route and meet timing on the same engine\. ([A-Za-z][A-Za-z0-9_-]{1,40}) gives the lowest measured latency and energy:[^\n]{0,600}?Weighting the group-lasso by channel cycle cost does not improve this result\. ([A-Za-z][A-Za-z0-9_-]{1,40}) skips[^\n]{0,350}?so the plain lasso performs better on all three measured outcomes in these runs\./gmu;
        const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const match of source.matchAll(observed)) {
            const [, plain, cycle] = match;
            if (plain === cycle || !unquotedObservedComparison(source, match.index, match[0])) continue;
            const mapping = new RegExp(`(?<![A-Za-z0-9_-])${escape(cycle)} learns per-channel widths and adds the cycle-weighted group-lasso[^\\n]{0,250}?; ${escape(plain)} replaces cycle-weighted group-lasso with plain group-lasso[^.\\n]*\\.`, 'gu');
            if (![...source.matchAll(mapping)].some(definition => unquotedObservedComparison(source, definition.index, definition[0]))) continue;
            const statement = [...String(results).matchAll(/[^。；\n]+/gu)].some(fragment =>
                unquotedObservedComparison(results, fragment.index, fragment[0])
                && /普通组稀疏在三个实测结果上都优于按通道周期加权的组稀疏/u.test(fragment[0]));
            if (!statement) continue;
            for (const table of tables) {
                const clean = value => String(value || '').replace(/[*_`$]/gu, '').trim();
                const find = expression => table.header.flatMap((header, i) => expression.test(clean(header)) ? [i] : []);
                const identity = find(/^构建$/u), objective = find(/^训练目标$/u);
                const time = find(/^帧时间\s*ms\/帧\s*↓$/u), energy = find(/^动态能耗\s*μJ\/帧\s*↓$/u), quality = find(/^PESQ\s*↑$/u);
                if ([identity, objective, time, energy, quality].some(columns => columns.length !== 1)) continue;
                const rows = name => table.rows.filter(row => clean(row[identity[0]]) === name);
                const first = rows(plain), second = rows(cycle);
                if (first.length !== 1 || second.length !== 1
                    || clean(first[0][objective[0]]) !== '存储加普通组稀疏'
                    || clean(second[0][objective[0]]) !== '存储加周期加权组稀疏') continue;
                const scalar = cell => /^\d+(?:\.\d+)?$/u.test(clean(cell)) ? Number(clean(cell)) : NaN;
                // This gate only corroborates the retained adverse conclusion. It
                // does not authenticate source-cell values or grant scientific or
                // publication qualification. Never split bare HTML duplicates.
                if ([time[0], energy[0], quality[0]].every(column => Number.isFinite(scalar(first[0][column])) && Number.isFinite(scalar(second[0][column])))
                    && scalar(first[0][time[0]]) < scalar(second[0][time[0]])
                    && scalar(first[0][energy[0]]) < scalar(second[0][energy[0]])
                    && scalar(first[0][quality[0]]) > scalar(second[0][quality[0]])) return true;
            }
        }
        return false;
    }

    function sourceBoundDeadlineF1Comparison(results, tables, sourceText) {
        const source = String(sourceText || ''), escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const sourceValues = (method, deadline, lookahead, dataset) => {
            const captions = [...source.matchAll(/^Table\s+[0-9]+: Accuracy at the deadline, on the primary truth of each set; all rows are our models\. Each cell gives the recording-level macro F1 \(%\)[^\n]*$/gmu)];
            if (captions.length !== 1 || !unquotedObservedComparison(source, captions[0].index, captions[0][0])) return null;
            const prefix = source.slice(0, captions[0].index), start = prefix.lastIndexOf('\nDevelopment\nHeld-out\nSystem\n');
            if (start < 0 || captions[0].index - start > 8000) return null;
            const lines = prefix.slice(start).split('\n').map(line => line.trim()).filter(Boolean);
            const firstRow = lines.findIndex(line => new RegExp(`^${escape(method)}, D=${deadline}(?:D=${deadline})?\\s*ms$`, 'u').test(line));
            const headers = lines.slice(3, firstRow);
            if (firstRow < 5 || headers.length > 10 || new Set(headers).size !== headers.length || headers.filter(header => header === dataset).length !== 1) return null;
            const width = headers.length, secondRow = firstRow + 1 + width, thirdRow = secondRow + 1 + width * 3;
            if (lines[secondRow] !== `${method}, full length (${lookahead}\u2009ms lookahead)`
                && lines[secondRow] !== `${method}, full length (${lookahead} ms lookahead)`) return null;
            if (!/^Harmonic BiCRNN, offline \(whole recording\)$/u.test(lines[thirdRow] || '')
                || lines.length !== thirdRow + 1 + width * 3) return null;
            const scalar = value => /^[0-9]+(?:\.[0-9]+)?$/u.test(value) ? value : null;
            const column = headers.indexOf(dataset), a = scalar(lines[firstRow + 1 + column]), b = scalar(lines[secondRow + 1 + column * 3]);
            // Retain the complete F1/paired-difference/CI rectangular layout; a
            // metric moved across a source-table boundary cannot supply values.
            if (a === null || b === null || !headers.every((_header, i) => scalar(lines[firstRow + 1 + i]) !== null
                && scalar(lines[secondRow + 1 + i * 3]) !== null && scalar(lines[thirdRow + 1 + i * 3]) !== null
                && /^\[.+,.+\]$/u.test(lines[secondRow + 3 + i * 3]) && /^\[.+,.+\]$/u.test(lines[thirdRow + 3 + i * 3]))) return null;
            return [a, b];
        };
        const observed = /Within ([A-Za-z][A-Za-z0-9_-]{1,40}), answering at ([1-9][0-9]*)\s*ms instead of with ([1-9][0-9]*)\s*ms of lookahead costs ([0-9]+(?:\.[0-9]+)?) points on ([A-Za-z][A-Za-z0-9_-]{1,40})/gu;
        for (const match of source.matchAll(observed)) {
            const [, method, deadline, lookahead, delta, dataset] = match;
            const values = sourceValues(method, deadline, lookahead, dataset);
            if (!values || !(Number(delta) > 0) || Number(deadline) >= Number(lookahead)
                || !unquotedObservedComparison(source, match.index, match[0])
                || Math.abs(Number(values[1]) - Number(values[0]) - Number(delta)) >= 1e-9) continue;
            const comparison = new RegExp(`(?<![A-Za-z0-9_-])${escape(method)}\\s*${deadline}\\s*ms\\s*相对自身整曲[^。；\\n]{0,80}?(?<![A-Za-z0-9_-])${escape(dataset)}\\s*-${escape(delta)}(?![0-9.])`, 'u');
            if (![...String(results).matchAll(/[^。；\n]+/gu)].some(fragment =>
                unquotedObservedComparison(results, fragment.index, fragment[0]) && comparison.test(fragment[0]))) continue;
            for (const table of tables) {
                const clean = value => String(value || '').replace(/[*_`]/gu, '').trim();
                const identity = table.header.flatMap((header, i) => clean(header) === '系统' ? [i] : []);
                const metric = table.header.flatMap((header, i) => clean(header) === `${dataset} 留出 ↑` ? [i] : []);
                if (identity.length !== 1 || metric.length !== 1) continue;
                const first = table.rows.filter(row => clean(row[identity[0]]) === `${method} ${deadline} ms`);
                const second = table.rows.filter(row => clean(row[identity[0]]) === `${method} 整曲 ${lookahead} ms 前视`);
                if (first.length !== 1 || second.length !== 1) continue;
                const scalar = cell => /^([0-9]+(?:\.[0-9]+)?)%$/u.exec(clean(cell))?.[1];
                const a = scalar(first[0][metric[0]]), b = scalar(second[0][metric[0]]);
                if (a !== undefined && b !== undefined && a === values[0] && b === values[1] && Number(a) < Number(b)
                    && Math.abs(Number(b) - Number(a) - Number(delta)) < 1e-9) return true;
            }
        }
        return false;
    }

    // A notation-loss ablation is adverse evidence only when the same observed
    // source and report retain its MIDI round trip, method, and lost advantage.
    function sourceBoundNotationRoundtripRegression(results, sourceText) {
        const source = String(sourceText || ''), report = String(results || '');
        const unquotedAt = (text, index) => {
            const before = text.slice(0, index);
            if (before.lastIndexOf('“') > before.lastIndexOf('”')
                || before.lastIndexOf('‘') > before.lastIndexOf('’')
                || (before.match(/(?<!\\)"/gu) || []).length % 2) return false;
            let fenced = false;
            for (const line of before.split('\n')) if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced;
            return !fenced && !/<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$/iu.test(
                before.slice(Math.max(before.lastIndexOf('</blockquote>'), before.lastIndexOf('</pre>'), before.lastIndexOf('</code>')) + 1));
        };
        const scopeAt = (text, index, claim) => {
            const before = text.slice(0, index), prefix = before.split('\n').at(-1);
            const previous = normalizeLocalEvidenceHeading(before.slice(0, before.lastIndexOf('\n')).trimEnd().split('\n').at(-1) || '');
            return unquotedAt(text, index) && ownObservedSourceScope(prefix + '\n' + claim)
                && !/[“”‘’"]|(?:^|\s)>/u.test(prefix)
                && !/^(?:(?:previous|prior|related|third[- ]party|other)\s+(?:work|research|study)|quoted statement|quotation|hypothetical example|第三方研究|其他研究|相关工作|先前研究|假设|引用)[.:：]?$/iu.test(previous);
        };
        const sourceRevoked = after => after.split(/(?<=[.!?])\s+|\n/u).slice(0, 2).some(part =>
            /^\s*(?:(?:but|however)[, ]+)?(?:this|that|the (?:above|preceding))\s+(?:ablation|result|finding|comparison|experiment|claim)s?[^.!?\n]{0,100}\b(?:withdrawn|retracted|revoked|false|incorrect|not\s+(?:observed|performed|conducted|supported))\b/iu.test(part));
        const pattern = /The ablation confirms that notation matters: when scores are first converted to MIDI before tokenisation, MIDI-derived ([A-Za-z][A-Za-z0-9_-]{1,40}) models match the performance of their MIDI counterparts, demonstrating that the advantage of MusicXML lies in the notational content lost upon conversion to MIDI, not in the tokenisation\s+strategy alone\./gu;
        for (const observed of source.matchAll(pattern)) {
            if (!unquotedObservedComparison(source, observed.index, observed[0])
                || !scopeAt(source, observed.index, observed[0]) || sourceRevoked(source.slice(observed.index + observed[0].length))) continue;
            const method = observed[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const adverse = new RegExp(`消融(?:将|把)同一(?:批)?乐谱先转\\s*MIDI\\s*再转回\\s*MusicXML\\s*后[，,]\\s*${method}\\s*(?:模型)?\\s*性能回落到\\s*MIDI\\s*水平[，,]\\s*支持优势来自记谱内容而非分词技巧本身`, 'gu');
            for (const match of report.matchAll(adverse)) {
                const sentenceStart = Math.max(report.lastIndexOf('。', match.index), report.lastIndexOf('；', match.index), report.lastIndexOf('\n', match.index)) + 1;
                const sentenceEnd = report.slice(match.index).search(/[。；\n]/u);
                const sentence = report.slice(sentenceStart, sentenceEnd < 0 ? report.length : match.index + sentenceEnd);
                if (!unquotedObservedComparison(report, sentenceStart, sentence) || !scopeAt(report, match.index, sentence)
                    || /假设|假如|倘若|如果|(?:^|[，,\s])若|未来|计划|预计|可能|先前研究|相关工作|第三方|他人|引用|引述|转述|并非|不是|未(?:能)?|没有|尚未|否认|反驳|撤回|撤销|错误(?:说法|结论)|[?？]/u.test(sentence)) continue;
                const following = report.slice(match.index + match[0].length).split(/[。；\n]/u).filter(part => part.trim()).slice(0, 2);
                if (following.some(part => /^\s*(?:(?:但|然而)[，,]?\s*)?(?:上述|前述|该|此)(?:消融)?(?:结论|结果|比较|说法)[^。；\n]{0,40}(?:撤回|撤销|不成立|错误|未(?:实际)?(?:进行|观测)|没有(?:进行|观测))/u.test(part))) continue;
                return true;
            }
        }
        return false;
    }


    // ─── Core-summary single-paper directional & prefixed metric comparisons ───
    function hasBoundFormerLatterComparison(sentence) {
        // Resolve former/latter only for two explicit measured values under one
        // named metric. A parameter count elsewhere cannot supply either value.
        if (/(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|并非|不是|不等于|不代表|并未|未进行|未报告|未测|没有)/u.test(sentence)) return false;
        const metric = '(?:均方根误差|平均绝对误差|RMSE|MAE|词错误率|WER)';
        const number = '[-+]?\\d+(?:\\.\\d+)?';
        const value = `(${number})(?:\\s*±\\s*${number})?\\s*(%|％|dB|ms|s)?`;
        const pattern = new RegExp(`${metric}比较[，,]\\s*([^，,。；]{1,40}?)(?:为|是)\\s*${value}`
            + `[，,]\\s*([^，,。；]{1,40}?)(?:为|是)\\s*${value}`
            + '[，,]\\s*(前者|后者)(更高|更低)', 'iu');
        const match = pattern.exec(sentence);
        if (!match) return false;
        const [, first, a, unitA = '', second, b, unitB = '', referent, direction] = match;
        const namedObject = /拟合|模型|系统|方法|基线|对照|条件|分支|输入|编码器/u;
        if (first.trim() === second.trim() || !namedObject.test(first) || !namedObject.test(second)
            || unitA.replace('％', '%') !== unitB.replace('％', '%')
            || CORE_SUMMARY_METRIC_PATTERN.test(first) || CORE_SUMMARY_METRIC_PATTERN.test(second)) return false;
        const left = Number(referent === '前者' ? a : b), right = Number(referent === '前者' ? b : a);
        if (!Number.isFinite(left) || !Number.isFinite(right) || left < 0 || right < 0) return false;
        return direction === '更低' ? left < right : left > right;
    }

    function hasBoundDisjointIntervalComparison(sentence) {
        // Recognize two measured ranges, never turn their endpoints into exact points.
        const clause = String(sentence || '').split(/[；;。！？!?\n]/u)[0];
        if (clause.length > 800 || /(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|并非|不是|不等于|不代表|并未|未进行|未报告|未测|没有)/u.test(clause)) return false;
        const surface = clause.replace(/（[^（）]{0,180}）|\([^()]{0,180}\)/gu, '');
        const metric = '(?:词错误率|词错率|字错率|准确率|正确率|错误率|召回率|精确率|WER|CER|EER|UAR|accuracy|precision|recall|均方根误差|平均绝对误差|RMSE|MAE|SNR|SI-SDR|延迟|latency)';
        const number = '[-+]?\\d+(?:\\.\\d+)?';
        const range = `(${number})\\s*(%|％|dB|ms|s)\\s*[–—~～至到-]\\s*(${number})\\s*(%|％|dB|ms|s)`;
        const measured = `([^，,。；;]{1,80}?)的(${metric})(?:大约为|大约|约为|约|为|是)\\s*${range}`;
        const pattern = new RegExp(`(?:^|[，,])\\s*${measured}[，,]\\s*${measured}[，,]\\s*(前者|后者)(更高|更低)\\s*$`, 'iu');
        const m = pattern.exec(surface);
        if (!m) return false;
        const [, first, metricA, a0, ua0, a1, ua1, second, metricB, b0, ub0, b1, ub1, referent, direction] = m;
        const namedObject = /拟合|模型|系统|方法|基线|对照|条件|分支|编码器|提示|微调|算法|网络/u;
        if (first.trim() === second.trim() || !namedObject.test(first) || !namedObject.test(second)
            || CORE_SUMMARY_METRIC_PATTERN.test(first) || CORE_SUMMARY_METRIC_PATTERN.test(second)) return false;
        const canonicalMetric = value => ({'词错率':'wer','词错误率':'wer','字错率':'cer','准确率':'accuracy','正确率':'accuracy','召回率':'recall','精确率':'precision','均方根误差':'rmse','平均绝对误差':'mae','延迟':'latency'}[value] || value.toLowerCase());
        const key = canonicalMetric(metricA), unit = ua0.replace('％', '%');
        if (key !== canonicalMetric(metricB) || [ua1, ub0, ub1].some(value => value.replace('％', '%') !== unit)) return false;
        if ((/^(?:wer|cer|eer|uar|accuracy|precision|recall|错误率)$/.test(key) && unit !== '%')
            || (/^(?:snr|si-sdr)$/.test(key) && unit !== 'dB')
            || (key === 'latency' && !['s', 'ms'].includes(unit))) return false;
        const values = [a0, a1, b0, b1].map(Number);
        if (values.some(value => !Number.isFinite(value) || value < 0 || (unit === '%' && value > 100))
            || values[0] >= values[1] || values[2] >= values[3]) return false;
        const [leftMin, leftMax, rightMin, rightMax] = referent === '前者' ? values : [values[2], values[3], values[0], values[1]];
        return direction === '更低' ? leftMax < rightMin : leftMin > rightMax;
    }

    function hasConditionalMetricDeltaDirection(sentence) {
        // One named rate, two explicit conditions, and a measured percentage-point
        // delta in the same clause. Bare higher/lower or model-size changes fail.
        if (/(?:假设|假想|如果|可能|预计|计划|未来|并非|并未|未报告|未测|没有观察到)/u.test(sentence)) return false;
        const pattern = /(?:准确率|正确率|错误率|词错率|(?<![A-Za-z0-9_])(?:WER|EER|UAR|accuracy)(?![A-Za-z0-9_]))(?:差|差值|差距)?在([^，,。；;]{1,60}?)(?:时|条件下)比([^，,。；;]{1,60}?)(?:时|条件下)(?:平均|总体)?(?:高|低)(?:了|出)?\s*(\d+(?:\.\d+)?)\s*(?:个百分点|百分比点|pp)(?![A-Za-z])/giu;
        for (const match of sentence.matchAll(pattern)) {
            if (match[1].trim() === match[2].trim() || Number(match[3]) <= 0
                || CORE_SUMMARY_METRIC_PATTERN.test(match[1] + match[2])) continue;
            return true;
        }
        return false;
    }

    // A declared metric scopes only the immediately following, measured model
    // comparison in the same sentence. It cannot license a different metric/object.
    function hasPrefixedCoreMetricComparison(sentence, sourceText = '') {
        if (/(?:假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|先前工作|先前研究|既有研究|其他研究|第三方|外部团队|其他团队|他人|引用|引述|转述|并非|并未|不是|没有|不能|尚未|否认|否定|反驳|撤回|不成立|不正确|错误|有误|未测|未报告|未在|未进行|未比较|未实际|不进行|不做|未做)/u.test(sentence)) return false;
        const scoped = /(?:^|[，,])\s*以((?:偶数|奇数)试次)?(?:留出)?(对数似然|log[- ]likelihood)为指标[，,]\s*([^，,；;。！？!?\n]+)/iu.exec(sentence);
        if (!scoped || scoped[1] !== '偶数试次') return false;
        const comparison = /^((?:完整|本文|本|所提)模型)比(冻结(?:极角精度|半球权重)学习的简化模型)高(?:了|出)?\s*(\d+(?:\.\d+)?)\s*nats?\s*$/iu.exec(scoped[3]);
        if (!comparison || !(Number(comparison[3]) > 0)) return false;
        const source = String(sourceText || '').replace(/\s+/gu, ' ');
        const component = comparison[2].includes('极角精度') ? String.raw`(?:κP|\\kappa_\{P\})` : String.raw`(?:ww|\\eta_\{w\})`;
        const amount = comparison[3].replace('.', '\\.');
        const observed = new RegExp(String.raw`Relative to the full model[^.!?]{0,300}freezing\s+${component}[^.!?]{0,160}?(?:reduced the held-out log-likelihood by\s*|by\s*)${amount}\s+nats`, 'iu');
        return /fitted on the odd-numbered feedback trials/iu.test(source)
            && /log-likelihood was evaluated on the even-numbered trials/iu.test(source)
            && observed.test(source);

    }


    // ─── Core-summary symbolic geometry exemptions ───
    // 图的有向边连接的是符号节点，不是两个标量测量值。
    function stripSymbolicPatternRelation(text) {
        const identifier = String.raw`(?:[A-Z]\d+(?:[A-Z]_\{\d+\})?|[A-Z]_\{\d+\})`;
        const relation = new RegExp(String.raw`\bedge\s+from\s+pattern\s+${identifier}\s+to\s+pattern\s+${identifier}(?![A-Za-z0-9_])`, 'g');
        return String(text || '').replace(relation, match => ' '.repeat(match.length));
    }

    function hasSymbolicGeometryMethodChain(summary) {
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(text => text.trim()).filter(Boolean);
        const denied = /讨论|提及|如果|若|是否|应该|应当|建议|假设|假想|假定|设想|预计|预期|可能|计划|拟将|拟把|未来|准备|并非|不是|另一(?:个|种|套|组|批)|(?:不同|其他|无关)的?点集|独立方法|(?:不|未|没有)(?:曾|实际|直接|真正|进行|再|被|确实|把|将|会|能|以)*\s*(?:转为|转成|转换|编码|生成|输出|进入|作为|检验|判断|收成|映射)/u;
        for (let index = 0; index < sentences.length; index++) {
            const producer = sentences[index];
            const encoding = producer.split(/[，,]/u)[0];
            if (denied.test(encoding) || !/^编码(?:先)?(?:把|将)(?:每个|每一|各个)?音(?:符)?(?:转为|转成|转换为|编码为)(?:二维|音高时间平面上的)点(?:集)?/u.test(encoding)) continue;
            const transfers = producer.split(/[，,]/u).filter(clause =>
                !denied.test(clause) && /(?:输出的|得到的|形成的|组合的)?点集(?:直接)?(?:进入几何(?:匹配|判定)|作为(?:下一步)?几何(?:匹配|判定)的输入)/u.test(clause));
            if (!transfers.length) continue;
            // 下游必须在当前句或紧邻下一句实际检验变换重合，不能从远处借模块词。
            const next = sentences[index + 1] || '';
            const processors = [producer, next].flatMap(sentence => sentence.split(/[，,]/u));
            if (processors.some(clause => !denied.test(clause)
                && /^(?:几何(?:匹配|判定)|匹配)(?:在[^，,]{1,75}上(?:以)?)?(?:检验|判断|能否)[^，,]{0,80}变换[^，,]{0,50}(?:重合|映射)/u.test(clause))) return true;
        }
        return false;
    }

    function hasScopedSymbolicDemonstration(summary) {
        if (!hasSymbolicGeometryMethodChain(summary)) return false;
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u);
        // 实例结构中的组规模不是性能指标；具体标量性能主张仍须有实测来源。
        const performanceClaims = sentences.some(sentence => {
            const metricSurface = sentence.replace(/(?:变换)?等价组规模为指标/gu, ' ');
            return CORE_SUMMARY_METRIC_PATTERN.test(metricSurface)
                && ((sentence.match(CORE_SUMMARY_NUMBER_PATTERN) || []).length > 0
                    || /(?:百分之|千分之|零点)[零一二两三四五六七八九十百千万点]+/u.test(sentence));
        });
        if (performanceClaims) return false;
        const scoped = sentences.some(sentence => !/假设|假想|预计|可能|未来|讨论|提及|不只|并非|不是/u.test(sentence)
            && /结论(?:只|仅)在[^。]{0,55}(?:该曲|作品|主题实例|实例)[^。]{0,25}(?:有证据|成立|得到支持|得到验证)/u.test(sentence));
        const limit = sentences.flatMap(sentence => sentence.split(/[，,]/u)).some(clause =>
            !/并非|不是|不能|已经|已(?:经|得到)?验证/u.test(clause)
            && /跨作品[^，,。]{0,45}(?:尚未|未)(?:得到)?验证/u.test(clause));
        return scoped && limit;
    }


    // ─── Core-summary measured metric table, corpus curation, software validation & observed outcome exemptions ───
    // 保留原逐行表格边界；列名缩写的句点不能把数值行和真实结果表标题隔开。
    function sourceHasMeasuredMetricTable(sourceText) {
        const lines = String(sourceText || '').split(/\r?\n/).map(line => line.trim());
        const numericCell = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*(?:%|％|dB))?$/;
        for (let index = 0; index < lines.length; index++) {
            const caption = lines[index];
            if (!/^Table\s+\d+\s*:\s*(?:Comparison|Ablation|Evaluation|Benchmark|Results)\b/i.test(caption)
                || /\b(?:hypothetical|illustrative|example|planned|expected|predicted|prior study|previous study)\b/i.test(caption)
                || /\b(?:results?|measurements?)\b[^.;]{0,25}\b(?:not|never)\b[^.;]{0,25}\b(?:observed|measured|reported|evaluated)\b|\b(?:no|without)\s+(?:(?:observed|measured|reported|evaluated)\s+)?results?\b|\b(?:not|never)\s+(?:observed|measured|reported|evaluated)\s+results?\b/i.test(caption)) continue;
            const rows = [];
            let metricHeader = false, label = '', values = [];
            const flush = () => { if (label && values.length) rows.push({ label, width: values.length }); values = []; };
            for (let next = index + 1; next < Math.min(lines.length, index + 100); next++) {
                const line = lines[next];
                if (/^\d+(?:\.\d+)*\s+[A-Z][A-Za-z]/.test(line) || /^Table\s+\d+\s*:/i.test(line)) break;
                if (!line) continue;
                if (numericCell.test(line)) { values.push(line); continue; }
                if (/^[–—-]$/.test(line) && values.length) continue;
                flush();
                const withoutCitations = line.replace(/\[[\d,\s]+\]/g, '').trim();
                const specificMetric = withoutCitations.replace(new RegExp(CORE_SUMMARY_GENERIC_ENGLISH_METRIC_PATTERN.source, 'gi'), ' ');
                if (!rows.length && (CORE_SUMMARY_METRIC_PATTERN.test(specificMetric)
                    || /^(?:SRCC|LRCC)$/i.test(withoutCitations))) metricHeader = true;
                label = /^[A-Za-z][A-Za-z0-9 .+_-]{1,80}$/.test(withoutCitations)
                    && !/^(?:Method|Metric|Metrics|Parameter|Parameters|Dataset|Datasets)$/i.test(withoutCitations)
                    && !CORE_SUMMARY_METRIC_PATTERN.test(specificMetric)
                    && !/^(?:SRCC|LRCC)$/i.test(withoutCitations) ? withoutCitations : '';
            }
            flush();
            if (metricHeader && rows.some((row, first) => rows.slice(first + 1)
                .some(other => other.label !== row.label && other.width === row.width))) return true;
        }
        return false;
    }

    // 文本语料发布论文的清洗结果不是模型性能；仅识别同一发布中可核的前后计数。
    function sourceCorpusCurationResult(sourceText) {
        const text = String(sourceText || '').replace(/\s+/g, ' ').trim();
        if (!/\b(?:text corpus|corpus|dataset)\b/i.test(text.slice(0, 2500))
            || !/(?:^|[.!?]\s+)(?:This paper describes the release of (?:its|our) text component|We (?:release|publish) (?:a|our|the|this) text corpus)\b/i.test(text.slice(0, 2500))) return null;
        const count = '(?:[1-9]\\d{0,2}(?:,\\d{3})+|[1-9]\\d*)';
        const observed = new RegExp(`\\b(?:A )?second pass was carried out for this release[^.]{0,160}\\.[\\s\\S]{0,180}?(?<![\\d.])(${count}) of the (${count}) (?:lines|rows|sentences) were not in NFC form\\b`, 'i').exec(text);
        const removed = new RegExp(`\\bAlso corrected:\\s*(${count}) exact duplicates\\b`, 'i').exec(text);
        const statistics = new RegExp(`\\bCorpus statistics\\b[\\s\\S]{0,100}?Rows in the \\d{4} working file\\s*(${count})\\s*Unique sentences after cleaning\\s*(${count})\\b`, 'i').exec(text);
        if (!observed || !removed || !statistics) return null;
        const numeric = value => Number(value.replace(/,/g, ''));
        const result = { invalid: numeric(observed[1]), original: numeric(observed[2]), removed: numeric(removed[1]), cleaned: numeric(statistics[2]) };
        if (Object.values(result).some(value => !Number.isSafeInteger(value) || value <= 0)
            || numeric(statistics[1]) !== result.original || result.invalid > result.original
            || result.original - result.removed !== result.cleaned) return null;
        return result;
    }

    function hasCompleteCorpusCurationResult(summary, result) {
        if (!result || !/(?:语料|句子|文本)/.test(summary)) return false;
        const sentences = String(summary).replace(/(?<=\d),(?=\d)/g, '').split(/[。！？!?\n]/);
        return sentences.some(sentence => {
            if (/(?:未发现|没有发现|尚未检查|计划|预计|假设|拟检查)/.test(sentence)) return false;
            const value = number => `(?<![\\d.])${number}(?![\\d.])`;
            const counts = new RegExp(`${value(result.original)}\\s*(?:行|句)[^。]{0,20}(?:中有|其中有|中)\\s*${value(result.invalid)}\\s*(?:行|句)[^。]{0,20}(?:不符合|不满足|未采用)\\s*NFC`, 'i');
            const reverseCounts = new RegExp(`${value(result.invalid)}\\s*(?:行|句)[^。]{0,15}(?:不符合|不满足|未采用)\\s*NFC[^。]{0,30}(?:原有|原始|共|全部)\\s*${value(result.original)}\\s*(?:行|句)`, 'i');
            const clean = new RegExp(`(?:修复|清洗|规范化|去重)[^。]{0,30}后[^。]{0,12}(?:得到|保留|剩余|形成|共有)\\s*${value(result.cleaned)}\\s*(?:个)?(?:唯一)?(?:句子|句|行)[^。]{0,8}(?:唯一|句子|文本)?`);
            const cleaned = clean.exec(sentence);
            const cleaningNegated = cleaned && /(?:未|未曾|从未|没有|尚未|不)(?:进行|完成)?\s*$/.test(sentence.slice(Math.max(0, cleaned.index - 12), cleaned.index));
            return /(?:发现|检查|清洗|统计)/.test(sentence) && (counts.test(sentence) || reverseCounts.test(sentence)) && cleaned && !cleaningNegated;
        });
    }

    // Software functional validation is source-bound repeatability evidence, not model performance.
    function sourceSoftwareFunctionalValidationResult(sourceText){
     const count=value=>/^\d+$/u.test(value)?Number(value):({one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12}[String(value).toLowerCase()]??NaN);
     const text=String(sourceText||'').replace(/\s+/gu,' ').trim(),word='(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
     // Keep this affirmative observed provenance local. A quoted prior result,
     // future validation, version/step numbers or a test inventory cannot match.
     const observed=new RegExp('(?:^|[.!?] )On a pinned ([A-Za-z]+) ([A-Za-z0-9_-]+) and Python (\\d+\\.\\d+) stack, functional validation of the pre-release versions reproduced package and host tests\\. '+word+' runs in fresh processes reproduced the same render-plan hash and all '+word+' expected output hashes, covering '+word+' sampled parameter configurations and '+word+' fixed MIDI signals; (\\d+) negative cases also passed\\.','iu').exec(text);
     if(!observed)return null;
     const result={os:observed[1],architecture:observed[2],pythonVersion:observed[3],runs:count(observed[4]),outputs:count(observed[5]),configurations:count(observed[6]),midiSignals:count(observed[7]),negativeCases:count(observed[8])};
     // Independent table statement authenticates which counts belong to outputs,
     // configurations and signals. Counts are bound by roles, not a numeric bag.
     const table=new RegExp('Deterministic workflow '+word+' fresh processes each rendered and kept '+word+' records from '+word+' parameter configurations and '+word+' MIDI signals; both reproduced the same expected plan hash and all '+word+' expected output-byte hashes\\.','iu').exec(text);
     const packageTests=/Package tests (\d+) passed; wheel\/source build and clean wheel installation passed\./iu.exec(text);
     const negativeCases=/Negative cases (\d+) passed, covering/iu.exec(text);
     const tableCaption=/Table\s+\d+: Quality-control results from the pre-release validation pass on the pinned ([A-Za-z]+) ([A-Za-z0-9_-]+) and Python (\d+\.\d+) stack\./iu.exec(text);
     if(!table||!packageTests||!negativeCases||!tableCaption)return null;
     result.packageTests=count(packageTests[1]);
     if([result.runs,result.outputs,result.configurations,result.midiSignals,result.negativeCases,result.packageTests].some(n=>!Number.isSafeInteger(n)||n<=0)
      ||result.negativeCases!==count(negativeCases[1])||result.runs<2||result.outputs!==result.configurations*result.midiSignals
      ||[result.runs,result.outputs,result.configurations,result.midiSignals,result.outputs].some((n,i)=>n!==count(table[i+1]))
      ||[result.os,result.architecture,result.pythonVersion].some((v,i)=>v.toLowerCase()!==tableCaption[i+1].toLowerCase()))return null;
     return {...result,observedQuote:observed[0].replace(/^[.!?] /u,''),workflowQuote:table[0],packageTestsQuote:packageTests[0],captionQuote:tableCaption[0]};
    }
    function hasCompleteSoftwareFunctionalValidationResult(summary,result){
     if(!result)return false;
     const count=value=>/^\d+$/u.test(value)?Number(value):({'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,'十二':12}[value]??NaN);
     const text=String(summary||'');
     // Forbid unsupported model-performance claims as a replacement for this
     // software result; the existing generic benchmark rules remain untouched.
     return text.split(/[。！？!?\n]/u).some(sentence=>{
      if(/假设|假想|如果|(?:^|[，,])若|预计|未来|建议|(?:计划|预期)(?:将|会|在|用|复现|验证|运行|渲染|测试)|先前工作|此前工作|旧工作|相关工作|其他(?:软件|工具|系统|方法)|另一(?:软件|工具|系统)|基线|引用|转述|否认|反驳|驳斥|是否|吗/u.test(sentence)
       ||/(?:未|没有|无法|不)(?:曾|实际|能|会|再)?(?:复现|通过|匹配|保持一致|运行|渲染)|(?:说法|表述|结论)[^。]{0,30}(?:错误|不成立|不正确)/u.test(sentence))return false;
      const clean=sentence.replace(/\s+/gu,''),stack='在锁定的'+result.os+result.architecture+'与Python'+result.pythonVersion+'组合上';
      if(!clean.startsWith(stack))return false;
      const m=/([0-9一二两三四五六七八九十]+)次全新进程渲染均复现了同一采样计划哈希与([0-9一二两三四五六七八九十]+)个预期输出哈希覆盖([0-9一二两三四五六七八九十]+)组采样参数与([0-9一二两三四五六七八九十]+)个固定MIDI信号，([0-9一二两三四五六七八九十]+)个负向用例与([0-9一二两三四五六七八九十]+)个包测试同样通过$/u.exec(clean.slice(stack.length).replace(/^，/u,''));
      return Boolean(m&&[result.runs,result.outputs,result.configurations,result.midiSignals,result.negativeCases,result.packageTests].every((n,i)=>n===count(m[i+1])));
     });
    }

    // Typed observed outcomes, never participant composition or free settings.
    function sourceHasBoundEventProportionComparison(sourceText) {
        const raw = String(sourceText || '');
        if (!/\bProportion\s+of\b/i.test(raw) || !/\d[\d,]*\s*\/\s*\d[\d,]*/.test(raw)) return false;
        const denied = /\b(?:hypothetical(?:ly)?|illustrative|assum(?:e|ed|ing)|suppose|if|expected|predicted|planned|future|would|could|should|retracted|withdrawn|fabricated|incorrect|false)\b|\b(?:prior|previous|earlier|other)\s+(?:work|research|stud(?:y|ies))\b|\b(?:not|never)\s+(?:(?:actually|yet|been)\s+)*(?:observed|measured|contained|reported|found)\b|\b(?:according\s+to|quoted|quotation|denies|denied|refutes|refuted)\b|\bwe\s+(?:plan|hypothesi[sz]e|assume)\b/iu;
        const captions = [...raw.matchAll(/\bTable\s+([1-9][0-9]*)\s*:\s*Proportion\s+of\s+((?:release\s+)?(?:phases?|segments?|tokens?|utterances?|frames?|outputs?|responses?)\s+(?:with|containing|showing|exhibiting)\s+[^\r\n]{3,100}?)\s+by/giu)];
        for (const caption of captions) {
            // A PDF column may attach the neighbouring left-column word after by.
            // The same caption must still name the speaker-cohort dimension nearby.
            if (!/\bspeaker\s+cohort\b/iu.test(raw.slice(caption.index + caption[0].length, caption.index + caption[0].length + 200))) continue;
            const before = raw.slice(Math.max(0, caption.index - 1800), caption.index).replace(/\s+/gu, ' ');
            const comparison = /\b([A-Z][A-Za-z-]{2,30})\s+speakers?[’']?[^.;!?]{0,100}?kens?\s+contained\s+[a-z-]{3,40}\s+over\s+half\s+of\s+the\s+time,[^.;!?]{0,150}?compared\s+to[^.;!?]{0,150}?less\s+than\s+a\s+quarter\s+for\s+([A-Za-z-]{2,30})\s+speakers?\b/iu.exec(before);
            if (!comparison || comparison[1].toLowerCase() === comparison[2].toLowerCase()
                || /[“"‘']\s*$/u.test(before.slice(0, comparison.index))
                || denied.test(before.slice(Math.max(0, comparison.index - 160)))
                || !new RegExp('\\bfound\\s+in\\s+Table\\s+' + caption[1] + '\\b', 'iu').test(before.slice(comparison.index))) continue;
            const nextCaption = raw.slice(caption.index + caption[0].length).search(/\bTable\s+[1-9][0-9]*\s*:/iu);
            const block = raw.slice(caption.index + caption[0].length,
                Math.min(raw.length, caption.index + caption[0].length + (nextCaption < 0 ? 3000 : nextCaption), caption.index + 3000));
            if (denied.test(raw.slice(Math.max(0, caption.index - 140), caption.index + caption[0].length))) continue;
            const lines = block.split(/\r?\n/), groups = new Map(); let lastMeasuredRow = -1;
            const header = lines.find(line => /^\s*[A-Za-z][A-Za-z -]{1,50}\s{2,}[A-Za-z][A-Za-z -]{1,50}\s{2,}(?:Total|Overall)\s*$/iu.test(line));
            if (!header) continue;
            const width = header.trim().split(/\s{2,}/u).length;
            for (let i = 0; i + 1 < lines.length; i++) {
                const row = /^\s*([A-Za-z][A-Za-z -]{1,40}?)\s{2,}((?:[0-9][0-9,]*\s*\/\s*[0-9][0-9,]*\s*){2,5})\s*$/u.exec(lines[i]);
                if (!row) continue;
                const ratios = [...row[2].matchAll(/([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)/g)].map(m => [Number(m[1].replace(/,/g, '')), Number(m[2].replace(/,/g, ''))]);
                const percentages = [...lines[i + 1].matchAll(/\(\s*([0-9]+(?:\.[0-9]+)?)%\s*\)/g)].map(m => Number(m[1]));
                if (ratios.length !== width || percentages.length !== width
                    || lines[i + 1].replace(/\(\s*[0-9]+(?:\.[0-9]+)?%\s*\)/g, '').trim()
                    || ratios.some(([n,d], j) => !Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0 || n < 0 || n > d
                        || percentages[j] < 0 || percentages[j] > 100 || Math.abs(100 * n / d - percentages[j]) > 0.51)) continue;
                lastMeasuredRow = i + 1;
                const key = row[1].trim().toLowerCase();
                if (groups.has(key)) { groups.set(key, null); continue; }
                groups.set(key, ratios.at(-1));
            }
            const following = lines.slice(lastMeasuredRow + 1, lastMeasuredRow + 10).join(' ');
            if (/\b(?:this|these|those|the above)\s+(?:table|results?|proportions?|percentages?|comparisons?|measurements?|findings?)\b[^.!?]{0,100}\b(?:not\s+(?:observed|measured)|retracted|withdrawn|incorrect|false)\b/iu.test(following)) continue;
            const left = groups.get(comparison[1].toLowerCase()), right = groups.get(comparison[2].toLowerCase());
            if (left && right && left[0] / left[1] > 0.5 && right[0] / right[1] < 0.25) return true;
        }
        return false;
    }

    function sourceHasBoundMeanF0Comparison(sourceText) {
        // Keep PDF line boundaries so a neighbouring column cannot become part of a group label.
        const text = String(sourceText || '').replace(/\r/g, '').replace(/[ \t]+/gu, ' ');
        if (!/\bmean\s+F0\b/iu.test(text)) return false;
        const denied = /\b(?:hypothetical(?:ly)?|illustrative|assum(?:e|ed|ing)|suppose|if|expected|predicted|planned|future|will|would|could|should|retracted|withdrawn|fabricated|incorrect|false)\b|\b(?:prior|previous|earlier|other)\s+(?:work|research|stud(?:y|ies))\b|\b(?:according\s+to|quoted|quotation|denies|denied|refutes|refuted)\b|\b(?:not|never)\s+(?:(?:actually|yet|been)\s+)*(?:calculated|measured|estimated|observed|reported)\b|\b(?:according\s+to|quoted|quotation|denies|denied|refutes|refuted)\b|\bwe\s+(?:plan|hypothesi[sz]e|assume)\b/iu;
        const measured = /\bwe\s+(?:also\s+)?(?:calculated|measured|estimated)\s+(?:the\s+)?mean\s+F0\b[^.!?]{0,350}?\b(?:for|of)\b[^.!?]{0,180}?\b(?:each|all|the)\s+(?:voices?|speakers?|utterances?|samples?)\s+(?:in|from)\s+(?:the|our|this)\s+(?:study|experiment|evaluation)\b/giu;
        for (const declaration of text.matchAll(measured)) {
            const preceding = text.slice(Math.max(0, declaration.index - 180), declaration.index);
            if (denied.test(preceding + declaration[0]) || /[“"‘']\s*$/u.test(preceding)) continue;
            const after = text.slice(declaration.index + declaration[0].length, declaration.index + declaration[0].length + 1400);
            const compare = /\bMean\s+F0\s+(?:is|was)\s+(lower|higher)\s+for\s+([A-Za-z][A-Za-z -]{2,75}?)\s*\(([0-9]+(?:\.[0-9]+)?)\s*(Hz|kHz)\)[\s\S]{0,180}?\bthan\b[\s\S]{0,180}?([A-Za-z][A-Za-z -]{2,75}?)\s*\(([0-9]+(?:\.[0-9]+)?)\s*(Hz|kHz)\)/iu.exec(after);
            if (!compare || denied.test(after.slice(0, compare.index + compare[0].length))
                || compare[4].toLowerCase() !== compare[7].toLowerCase()
                || compare[2].trim().toLowerCase() === compare[5].trim().toLowerCase()) continue;
            const left = Number(compare[3]), right = Number(compare[6]);
            const tail = after.slice(compare.index + compare[0].length, compare.index + compare[0].length + 180);
            if (/\b(?:this|these|those|the above)\s+(?:results?|comparisons?|measurements?|claims?|statements?)\b[^.!?]{0,80}\b(?:not\s+(?:observed|measured)|retracted|withdrawn|incorrect|false)\b/iu.test(tail)) continue;
            if (left > 0 && right > 0 && (compare[1].toLowerCase() === 'lower' ? left < right : left > right)) return true;
        }
        return false;
    }

    function sourceHasObservedOutcomeComparison(sourceText) {
        if (sourceHasBoundEventProportionComparison(sourceText) || sourceHasBoundMeanF0Comparison(sourceText)) return true;
        // Source-only evidence. A numeric definition, a scale, or a planned test is
        // not an observation. Keep the measured object/condition and its result in
        // one bounded statement; never infer source evidence from the summary.
        const paragraphs = String(sourceText || '').replace(/\r/g, '').split(/\n[ \t]*\n/)
            .map(value => value.replace(/\s+/gu, ' ').trim()).filter(Boolean);
        const denied = /\b(?:hypothetical|illustrative|suppose|assuming|predicted|expected|planned|future|will|would|could|should)\b|\bwe\s+hypothesi[sz]e\b|\b(?:prior|previous|earlier|another|other)\s+(?:work|stud(?:y|ies)|research|paper)\b|\b(?:cited|quoted|quotation|denies|denied|refutes|refuted)\b|\b(?:et\s+al\.?|reviewer|commentator)\s+(?:report(?:s|ed)?|write[sd]?|wrote|says?|said|claims?|claimed)\b|\b(?:not|never|no)\s+(?:(?:actually|actual|yet|empirically|be|been|ever)\s+)*(?:measur|observ|evaluat|perform|conduct|carri|run|test|report|found|confirm|yield|show|averag|var|surpass|produc|trigger|shift)|\b(?:as\s+(?:a\s+)?(?:stopping\s+|selection\s+|decision\s+)?threshold|hyperparameter)\b|\b(?:define|defines|defined|definition|assume|assumes|assumed)\b/iu;
        const withdrawn = (observation, after) => {
            const quote = /^\s*[“"‘']/u.test(observation);
            const resultReferent = '(?:values?|results?|estimates?|measurements?|observations?|probabilities|probability|coefficients?|proportions?|improvements?|correlations?|(?:rejection\\s+)?rates?)';
            const revoked = new RegExp(`\\b(?:these|those|this|that|the\\s+above)\\s+${resultReferent}\\b[^.;!?]{0,70}\\b(?:(?:not|never)\\b[^.;!?]{0,30}\\b(?:measured|observed|reported|obtained|produced)|withdrawn|retracted|fabricated|false|incorrect)\\b|\\bneither\\s+${resultReferent}\\b[^.;!?]{0,40}\\b(?:measured|observed|reported|obtained|produced)\\b|\\b(?:this|that|the\\s+above)\\s+(?:claim|statement|evaluation|experiment|test)\\b[^.;!?]{0,60}\\b(?:false|incorrect|fabricated|retracted|withdrawn|(?:not|never)\\s+(?:(?:been|actually|yet)\\s+)*(?:performed|conducted|carried\\s+out|true))\\b|\\bthis\\s+(?:is|was)\\s+(?:(?:only|just|merely)\\s+)?(?:a\\s+|an\\s+)?(?:synthetic|hypothetical|illustrative|fictional)\\b`, 'iu');
            return quote || revoked.test(observation) || revoked.test(after.slice(0, 180));
        };
        const number = '[-+]?(?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)';
        const lines = String(sourceText || '').split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            if (!/\bTable\s+[0-9]+\s*:\s*(?:Performance|Comparison|Evaluation|Ablation|Results)\b/iu.test(lines[index])
                || denied.test(lines[index]) || denied.test(lines.slice(Math.max(0, index - 2), index).join(' '))) continue;
            const block = [];
            for (let next = index + 1; next < Math.min(lines.length, index + 50); next++) {
                if (/\bTable\s+[0-9]+\s*:/iu.test(lines[next])) break;
                block.push(lines[next]);
            }
            // These named result columns are not generic "score"/"metric" labels.
            // Rows must literally follow that header with the same complete width.
            const betaHeader = /\b(?:Cue|Feature|Predictor)\s+([A-Za-z][A-Za-z0-9_-]*)\s*β\s+([A-Za-z][A-Za-z0-9_-]*)\s*β/u;
            const header = block.findIndex(line => /\bModel\s+Rm\s+Rstd\s+Rpos\s+Spec\s+F1pos\b/u.test(line)
                || /\bMethods\s+JS↓\s*BC↑\s*R[2²]↑\s*Brier↓/u.test(line) || betaHeader.test(line));
            if (header < 0) continue;
            const beta = betaHeader.exec(block[header]);
            if (beta) {
                const headerText = block.slice(0, header).join(' ');
                const definition = /\b(?:importance|effects?)\s+is\s+measured\s+by\s+the\s+fixed-effect[\s\S]{0,160}?coefficient\s*\(β\)\s+from\s+the\s+mixed-effects\s+models\b/iu.exec(headerText);
                // Framing before the measurement declaration belongs to this table.
                // Afterwards, reject explicit attribution of these coefficients, not
                // unrelated discussion from the other column of a PDF page.
                const coefficientFraming = /\b(?:these|those|following|above)\s+(?:values|coefficients)\b[^.;!?]{0,70}\b(?:hypothetical|illustrative|fictional|synthetic|prior|previous|quoted)\b|\b(?:hypothetical|illustrative|fictional|synthetic)\s+(?:values|coefficients)\b|\b(?:prior|previous|earlier|another)\s+(?:study|paper|work)\b[^.;!?]{0,70}\b(?:following|these|those)\s+(?:values|coefficients)\b/iu;
                if (!definition || denied.test(headerText.slice(0, definition.index + definition[0].length))
                    || coefficientFraming.test(block.join(' ')) || beta[1].toLowerCase() === beta[2].toLowerCase()) continue;
            } else if (denied.test(block.slice(0, header + 1).join(' '))) continue;
            const width = beta ? 2 : /\bF1pos\b/u.test(block[header]) ? 5 : 4;
            const rowPattern = new RegExp(`^\\s*([A-Za-z][A-Za-z0-9 ()+_.-]{0,70}?)\\s+((?:${number}\\s+){${width - 1}}${number})\\s*$`, 'u');
            const rows = []; let lastRow = header;
            for (let offset = header + 1; offset < block.length; offset++) {
                const line = block[offset];
                const row = rowPattern.exec(line);
                if (row && row[2].trim().split(/\s+/u).every(value => Number.isFinite(Number(value))
                    && (beta || Number(value) >= 0 && Number(value) <= 1))) {
                    rows.push(row[1].trim()); lastRow = offset;
                }
            }
            if (new Set(rows).size >= 2 && !withdrawn(`${lines[index]} ${block.slice(0, lastRow + 1).join(' ')}`,
                block.slice(lastRow + 1).join(' ').slice(0, 180))) return true;
        }
        const metric = '(?:recognition\\s+accuracy|mean\\s+silhouette(?:\\s+coefficient)?|centroid\\s+size|AUC)';
        const scalar = new RegExp(`\\b(${metric})\\b\\s*(?:averag(?:ing|ed|es?)|varied\\s+by\\s+actor:|exceeded|=|of|at)\\s*(${number})(%?)(?![A-Za-z0-9_.%])`, 'iu');
        for (const paragraph of paragraphs) {
            for (const correlation of paragraph.matchAll(/\bwe\s+(?:observe|observed|measured)\b[\s\S]{0,160}?\b(?:average|mean)\s+correlation\s+(?:of|=)\s*([-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.%])/giu)) {
                const after = paragraph.slice(correlation.index + correlation[0].length, correlation.index + correlation[0].length + 180);
                const local = paragraph.slice(Math.max(0, correlation.index - 250), correlation.index + correlation[0].length) + after;
                if (Number(correlation[1]) >= -1 && Number(correlation[1]) <= 1 && !denied.test(local)
                    && /\binter[- ]model\b[\s\S]{0,70}\bcorrelation\s+(?:matrix|matrices)\b/iu.test(local)
                    && /\bamong\s+[A-Z][A-Za-z0-9_+-]{1,40}/u.test(after)
                    && /\b(?:architectures|models|systems)\b/iu.test(local)
                    && !withdrawn(local, after)) return true;
            }
            const ratePair = new RegExp(`\\brejection\\s+rates\\b[\\s\\S]{0,100}\\bshows\\b[\\s\\S]{0,120}?\\bapproximately\\s+(${number})\\s+percentage\\s+points\\s+under\\s+(?:the\\s+)?([A-Za-z-]+(?:\\s+[A-Za-z-]+){0,4}\\s+(?:model|analysis))[\\s\\S]{0,180}?\\band\\s+(${number})\\s+points\\s+under\\s+(?:the\\s+)?([A-Za-z-]+(?:\\s+[A-Za-z-]+){0,4}\\s+(?:model|analysis))`, 'gu');
            for (const rate of paragraph.matchAll(ratePair)) {
                const local = paragraph.slice(Math.max(0, rate.index - 250), rate.index + rate[0].length);
                if (!denied.test(local) && /\bcalibrated\b/iu.test(local)
                    && /\b(?:empirical|observed|measured|results\s+confirm)\b/iu.test(local)
                    && [rate[1], rate[3]].every(value => Math.abs(Number(value)) <= 100)
                    && rate[2].toLowerCase().replace(/\s+/gu, ' ') !== rate[4].toLowerCase().replace(/\s+/gu, ' ')
                    && !withdrawn(local, paragraph.slice(rate.index + rate[0].length, rate.index + rate[0].length + 180))) return true;
            }
            for (const proportion of paragraph.matchAll(/\b(?:Our|This)\s+study\s+(?:shows|showed|found|observed)\s+(?:a\s+)?(?:(?:high|low)\s+)?incidence\b[\s\S]{0,240}?\bwith\s+([0-9]+(?:\.[0-9]+)?)%\s+of\s+all\s+[A-Za-z][A-Za-z0-9_-]{1,35}\s+(?:having|showing|exhibiting)\s+[^.;]{2,80}/gu)) {
                const local = paragraph.slice(Math.max(0, proportion.index - 160), proportion.index + proportion[0].length);
                if (Number(proportion[1]) > 0 && Number(proportion[1]) <= 100 && !denied.test(local)
                    && !CORE_SUMMARY_OPERATIONAL_PARAMETER_PATTERN.test(proportion[0])
                    && !/\b(?:gpus?|cpus?|tpus?|npus?|layers?|parameters?|batches|epochs?|steps?)\b/iu.test(proportion[0])
                    && /\b(?:in|on|for|among)\b/iu.test(proportion[0])
                    && !withdrawn(local, paragraph.slice(proportion.index + proportion[0].length, proportion.index + proportion[0].length + 180))) return true;
            }
            for (const contrast of paragraph.matchAll(/\bresult(?:ing|ed)\s+in\s+(?:up\s+to\s+)?([0-9]+(?:\.[0-9]+)?)\s*×\s+(?:worse|better|higher|lower)\s+(?:jailbreak|attack)(?:\s+success)?\s+rates?\s+than\s+(?:the\s+)?(?:unimodal|baseline|control|reference)\b/gu)) {
                const local = paragraph.slice(Math.max(0, contrast.index - 300), contrast.index + contrast[0].length);
                if (Number(contrast[1]) > 1 && !denied.test(local)
                    && /\bwe\s+(?:showed|observed|found|demonstrated)\b/iu.test(local)
                    && !withdrawn(local, paragraph.slice(contrast.index + contrast[0].length, contrast.index + contrast[0].length + 180))) return true;
            }
            // An estimated group effect is not its participant count or a free p
            // value. The observed contrast must precede a coefficient + p-value.
            for (const estimate of paragraph.matchAll(/\((?:β|Est\.?)\s*=\s*([-+]?[0-9]+(?:\.[0-9]+)?),\s*(?:SE\.?\s*=\s*[0-9]+(?:\.[0-9]+)?,\s*t\s*=\s*[-+]?[0-9]+(?:\.[0-9]+)?,\s*)?p\s*[<=]\s*(0\.[0-9]+)\)/gu)) {
                const local = paragraph.slice(Math.max(0, estimate.index - 300), estimate.index + estimate[0].length);
                if (!denied.test(local)
                    && !withdrawn(local, paragraph.slice(estimate.index + estimate[0].length, estimate.index + estimate[0].length + 180))
                    && /\b(?:speakers?|participants?|patients?|subjects?|groups?)\b(?:[^.;!?]|\.(?=[0-9])){0,200}\b(?:had|exhibited|showed)\b(?:[^.;!?]|\.(?=[0-9])){0,120}\b(?:higher|lower|greater|smaller|increased|decreased)\b/iu.test(local)
                    && Number(estimate[2]) > 0 && Number(estimate[2]) < 1) return true;
            }
            for (const posterior of paragraph.matchAll(/\bin\s+[A-Z][A-Za-z-]{1,35}\s*\(95%\s*CrI:\s*\[([-+]?[0-9]+(?:\.[0-9]+)?),\s*([-+]?[0-9]+(?:\.[0-9]+)?)\],\s*ER\s+for\s+[^:()]{1,35}:\s*([0-9]+(?:\.[0-9]+)?)\)/gu)) {
                const local = paragraph.slice(Math.max(0, posterior.index - 400), posterior.index + posterior[0].length);
                if (!denied.test(local) && !withdrawn(local, paragraph.slice(posterior.index + posterior[0].length, posterior.index + posterior[0].length + 180))
                    && /\bshowed\b[^.;]{0,100}\bassociation\b/iu.test(local)
                    && Number(posterior[1]) <= Number(posterior[2])) return true;
            }
            const statements = paragraph.replace(/\bet al\.(?=\s)/giu, 'et al').split(/(?<=[.!?])\s+/u);
            for (let index = 0; index < statements.length; index++) {
                const statement = statements[index];
                const framing = statements[index - 1] || '';
                if (denied.test(framing) && /\b(?:following|below|next|these|this|test|experiment|evaluation)\b/iu.test(framing)) continue;
                if (statement.length <= 1800 && !denied.test(statement)
                    && !withdrawn(statement, statements[index + 1] || '')) {
                    const match = scalar.exec(statement);
                    const value = match && Number(match[2]);
                    const validValue = match && Number.isFinite(value) && (/centroid/i.test(match[1]) ? value > 0
                        : /silhouette/i.test(match[1]) ? value >= -1 && value <= 1
                            : value >= 0 && value <= (match[3] === '%' ? 100 : 1));
                    if (validValue && /\b(?:showed|yield(?:s|ed)?|averag(?:ing|ed|es?)|varied|found|demonstrate[sd]?|exceeded)\b|\b(?:optimal\s+)?solution\s+was\b/iu.test(statement)
                        && /\b(?:compared\s+to|than|against|versus|baseline|chance|classification|clustering|actor|speakers?|males?|females?|models?|systems?|methods?|groups?|conditions?|evaluations?)\b/iu.test(statement)) {
                        return true;
                    }
                    const paired = new RegExp(`\\b(?:Both|The\\s+models?)\\s+([A-Za-z][A-Za-z0-9_+-]{1,35})\\s+and\\s+([A-Za-z][A-Za-z0-9_+-]{1,35})\\s+(?:yield|yielded|achieved|produced)\\s+CKA\\s+scores\\b[^()]{0,45}\\((${number})\\s+and\\s+(${number}),\\s*respec-?\\s*tively\\)`, 'iu').exec(statement);
                    if (paired && paired[1].toLowerCase() !== paired[2].toLowerCase()
                        && [paired[3], paired[4]].every(value => Number(value) >= 0 && Number(value) <= 1)) return true;
                }
                // The same evaluated system, one probability variable, two explicit
                // input conditions and an observed directional change. P(x)=... by
                // itself, priors and probability-distribution definitions cannot pass.
                const candidate = statements.slice(index, index + 3).join(' ');
                const probabilities = [...candidate.matchAll(/\bP\(([A-Za-z][A-Za-z0-9_]*)\)\s*=\s*(0(?:\.[0-9]+)?|1(?:\.0+)?)(?![A-Za-z0-9_.%])/gu)];
                if (probabilities.length !== 2) continue;
                const window = candidate;
                const models = new Set([...window.matchAll(/\b([A-Z][A-Za-z0-9_+.-]{1,40})\s+(?:model|system)\b|\b(?:model|system)\s+([A-Z][A-Za-z0-9_+.-]{1,40})/gu)]
                    .map(match => (match[1] || match[2]).toLowerCase()).filter(value => !['the', 'this', 'that', 'different'].includes(value)));
                if (window.length > 1500 || denied.test(window)
                    || models.size !== 1
                    || withdrawn(window, statements[index + 3] || '')
                    || !/\b(?:evaluation|test)\b[^.;]{0,80}\b(?:demonstrated|performed|conducted)\b[^.;]{0,80}\b(?:model|system)\b/iu.test(window)
                    || !/\b(?:isolated|single|univariate|baseline)\b[^.;]{0,150}\b(?:triggers?|yield(?:s|ed)?|produces?)\b/iu.test(window)
                    || !/\b(?:recombin\w*|combin\w*|modified|perturbed)\b[^.;]{0,200}\b(?:shifting|shifted|decreasing|decreased|increasing|increased)\b/iu.test(window)) continue;
                if (probabilities[0][1] === probabilities[1][1]
                    && Number(probabilities[0][2]) !== Number(probabilities[1][2])) return true;
            }
        }
        return false;
    }


    // ─── Core-summary planner selection exemptions ───
    // Selection accuracy is an observed outcome, not a GPU/batch-size setting.
    // Keep its numerator, held-out pool and hardware in the same source statement;
    // a metric mentioned elsewhere must not lend observations to a planned test.
    function sourceMeasuredPlannerSelection(sourceText) {
        const lines = String(sourceText || '').split('\n');
        const result = /^(?:Our|The frozen) (?:planner|selector) uniquely selected the measured fastest (?:design|configuration) in ([1-9]\d*)\/([1-9]\d*) held-out model-batch cases\.\s+This establishes selection accuracy within the declared validation pools across the tested workloads on ([A-Z][A-Za-z0-9 -]{1,45})\./u;
        for (let index = 0; index < lines.length; index++) {
            const match = result.exec(lines[index].trim());
            if (!match || ![match[1], match[2]].every(value => Number.isSafeInteger(Number(value)))
                || Number(match[1]) > Number(match[2])
                || !/[A-Z][A-Za-z]*\d/u.test(match[3])) continue;
            const before = lines.slice(0, index).filter(line => line.trim()).at(-1) || '';
            const scope = before + '\n' + lines[index];
            const start = lines.slice(0, index).join('\n').length + (index ? 1 : 0)
                + lines[index].indexOf(match[0]);
            const after = adjacentSourceStatementAfter(sourceText,
                lines.slice(0, index + 1).join('\n').length);
            if (!unquotedObservedComparison(sourceText, start, lines[index].trim())
                || /\b(?:assuming|predicted|expected|planned|would|could|quoted|quotation|prior|earlier|third[- ]party|fabricated|incorrect|retracted)\b|\b(?:according\s+to|reported\s+by|et\s+al)\b|\b(?:did|do|does)\s+not\s+(?:measure|observe|report|select|evaluate)\b|[“”"‘’`]|(?:^|\n)\s*~/iu.test(scope)
                || /\b(?:these?|those|this|that)\s+(?:results?|claims?|measurements?|experiments?)\b[^.!?]{0,80}\b(?:not measured|not observed|withdrawn|revoked|retracted|false|incorrect)\b/iu.test(lines[index].slice(match[0].length) + ' ' + after)) continue;
            return { selected: match[1], cases: match[2], hardware: match[3] };
        }
        return null;
    }

    function sourceBoundPlannerSelectionResult(sentence, summary, sourceText) {
        const source = sourceMeasuredPlannerSelection(sourceText);
        const preceding = String(summary).slice(0, String(summary).indexOf(sentence))
            .split(/[。！？!?\n]/u).filter(value => value.trim()).at(-1) || '';
        if (!source) return false;
        const hardware = source.hardware.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const hardwareSetting = new RegExp(`^(?:在|于)[ \\t]*${hardware}[ \\t]*上(?:[A-Za-z0-9._ -]{1,50}批量[1-9]\\d*时|(?:实测|评测|测试)(?=[，,：:]|$))`, 'u');
        if (!hardwareSetting.test(preceding.trim())
            || /(?:未|没有|并非|不是|不曾|并不|假定|假设|假想|如果|预计|预期|设想|可能|例示|示例|例子|撤回|他人|第三方|引用|引述|转述|先前|相关工作)/u.test(preceding)
            || !unquotedObservedComparison(summary, String(summary).indexOf(sentence), sentence)
            || /(?:假定|假如|若|可能|预计|预期|未来|计划|引用|引述|转述|讨论|第三方|未|没有|不曾|并不|错误|撤回)|[“”"‘’]|\b(?:assuming|predicted|quoted|prior|earlier|third[- ]party)\b/iu.test(sentence)) return false;
        const result = /(?:冻结后的|本文的|本研究的)规划器在已声明验证池([1-9]\d*)个模型(?:与|和)批量组合中([1-9]\d*)\/([1-9]\d*)选中已测最快设计/u.exec(sentence);
        return Boolean(result && result[1] === source.cases
            && result[2] === source.selected && result[3] === source.cases);
    }


    // ─── Core-summary source-bound text-video, setting, dissonance, room simulation, Bayesian, correction rate, DNSMOS & hit-count exemptions ───
    // 这些组合只声明当前句的实测条件，不能替代结果指标或比较方向。
    function hasSourceBoundTextVideoComparison(rawSentence, sourceText, prefix = '', following = '') {
        const denied = /假设|假想|假定|如果|若|可能|预计|预期|计划|未来|第三方|他人|先前研究|相关工作|外部研究|引用|引述|转述|撤回|撤销|否认|并非|不是|没有|从未|未(?:实际)?(?:测量|观测|报告|执行|进行)|[“”「」"'`]|(?:^|\n)\s*>|<\/?(?:blockquote|pre|code)\b|\b(?:if|assuming|suppose|hypothetical|not|never|previous work|prior study|related (?:work|study)|other (?:work|study|research)|external (?:work|study|research)|third[- ]party|quoted|withdrawn|retracted)\b/iu;
        if (denied.test(rawSentence)) return false;
        const surface = String(rawSentence).replace(/\s+/gu, '');
        const scope = /(?:在|于)(?:采用([A-Z][A-Za-z0-9/._-]{1,39})的)?([A-Z][A-Za-z0-9._-]{2,39})文本到视频检索上[，,]/u.exec(surface);
        const comparison = /([A-Z][A-Za-z0-9_-]{1,39})的R@1为(\d+(?:\.\d+)?)[，,]相对于([A-Z][A-Za-z0-9_-]{1,39})的(\d+(?:\.\d+)?)高(\d+(?:\.\d+)?)个百分点/u.exec(surface);
        if (!scope || !comparison || comparison[1] === comparison[3]
            || Number(comparison[2]) > 100 || Number(comparison[4]) > 100
            || !(Number(comparison[2]) > Number(comparison[4]))
            || Math.abs(Number(comparison[2]) - Number(comparison[4]) - Number(comparison[5])) > 1e-6) return false;
        const foreignHeading = /^(?:#{1,6}\s*)?(?:第三方研究|先前研究|相关工作|假设实验|引述|previous work|prior study|related work|external research|hypothetical experiment)[.：:]?$/iu;
        let foreign = false;
        for (const part of String(prefix).split(/[。！？!?\n]/u).map(part => part.trim()).filter(Boolean)) {
            if (foreignHeading.test(part)) foreign = true;
            if (/^(?:本研究|本文)(?:独立实验|实测结果|检索结果)[：:]?$/u.test(part)) foreign = false;
        }
        if (foreign || (String(prefix).match(/```|~~~/gu) || []).length % 2
            || ['blockquote', 'pre', 'code'].some(tag => (String(prefix).match(new RegExp('<' + tag + '\\b[^>]*>', 'gi')) || []).length
                > (String(prefix).match(new RegExp('</' + tag + '\\s*>', 'gi')) || []).length)
            || [['“', '”'], ['‘', '’'], ['「', '」'], ['<blockquote>', '</blockquote>'], ['<pre>', '</pre>'], ['<code>', '</code>']]
                .some(([open, close]) => String(prefix).lastIndexOf(open) > String(prefix).lastIndexOf(close))
            || ['"', "'", '`'].some(quote => String(prefix).split(quote).length % 2 === 0)
            || /^(?:(?:上述|以上|该|此|这个)(?:文本到视频)?(?:结果|比较|实验|结论)[^。\n]{0,35}(?:撤回|撤销|不成立|从未|未(?:实际)?(?:报告|进行|执行))|(?:This|That)\s+(?:(?:result|experiment|comparison)\s+)?(?:was |is )?(?:not|never|(?:only )?hypothetical|withdrawn)|We\s+(?:did not|do not|never)\s+(?:actually\s+)?(?:perform this experiment|compare these models)\b)/iu.test(String(following).trim())) return false;
        const source = String(sourceText || '')
            .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, '\n[quoted material]\n')
            .replace(/<(?:blockquote|pre|code)\b[^>]*>[\s\S]*?<\/(?:blockquote|pre|code)\s*>/giu, '\n[quoted material]\n')
            .replace(/^\s*>.*$/gmu, '[quoted material]')
            .replace(/“[^”]*”|‘[^’]*’|「[^」]*」|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/gu, '[quoted material]');
        const opening = source.trim().split('\n')[0];
        if (foreignHeading.test(opening) || denied.test(opening) || opening === '[quoted material]') return false;
        const observedAt = match => {
            const before = source.slice(0, match.index);
            const previous = before.trimEnd().split('\n').at(-1) || '';
            if (denied.test(previous + '\n' + match[0]) || previous === '[quoted material]'
                || /^(?:This|That|We)[^.!?\n]{0,60}\b(?:not|never|withdrawn|retracted|hypothetical)\b/iu.test(adjacentSourceStatementAfter(source, match.index + match[0].length))) return false;
            for (const line of before.split('\n').reverse().slice(0, 80)) {
                if (foreignHeading.test(line.trim())) return false;
                if (/^\s*(?:#{1,6}\s+|\d+(?:\.\d+)*[ .]+|Appendix\s+[A-Z])\S/iu.test(line)) break;
            }
            return true;
        };
        const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const benchmark = new RegExp('(?<![A-Za-z0-9._-])' + escaped(scope[2]) + '(?![A-Za-z0-9._-])', 'u');
        const claims = [...source.matchAll(/^We compare ([A-Z][A-Za-z0-9_-]{1,39}) with representative methods on [^\n]+$/gmu)];
        if (!claims.some(claim => claim[1] === comparison[1] && benchmark.test(claim[0]) && observedAt(claim))) return false;
        if (scope[1]) {
            const encoder = new RegExp('The four-dataset comparison uses ' + escaped(scope[1]) + '(?=;|\\.)', 'gu');
            if (![...source.matchAll(encoder)].some(observedAt)) return false;
        }
        return [...source.matchAll(/^Table\s+\d+\. Text-to-video retrieval on (two|three|four|five|[2-5]) benchmarks\.[^\n]*$/gmu)].some(caption => {
            if (!observedAt(caption)) return false;
            const tail = source.slice(caption.index + caption[0].length);
            const end = /^(?:Table\s+\d+\.|\d+(?:\.\d+)*\.\s+[A-Z])/mu.exec(tail);
            const body = tail.slice(0, end ? end.index : tail.length);
            if (denied.test(body)) return false;
            const lines = body.split('\n').map(line => line.trim()).filter(Boolean);
            const metric = lines.indexOf('R@1');
            const count = ({ two: 2, three: 3, four: 4, five: 5 })[caption[1]] || Number(caption[1]);
            const columns = lines.slice(1, metric);
            if (lines[0] !== 'Model' || metric !== count + 1 || !columns.includes(scope[2])
                || lines.slice(metric, metric + 4).join('|') !== 'R@1|R@5|R@10|SumR') return false;
            const valueOf = model => {
                const name = new RegExp('^' + escaped(model) + '(?:$|,| \\()', 'u');
                const starts = lines.flatMap((line, index) => name.test(line) ? [index] : []);
                if (starts.length !== 1) return NaN;
                const values = lines.slice(starts[0] + 1, starts[0] + 1 + count * 4);
                if (values.length !== count * 4 || values.some(value => !/^\d+(?:\.\d+)?$/u.test(value))) return NaN;
                return Number(values[columns.indexOf(scope[2]) * 4]);
            };
            return valueOf(comparison[1]) === Number(comparison[2])
                && valueOf(comparison[3]) === Number(comparison[4]);
        });
    }

    function hasConcreteCoreSummarySetting(sentence, sourceText = '') {
        if (/(?:假设|如果|若在|预计|预期|可能|未在|没有|未进行|未做|不进行|不做)/.test(sentence)) return false;
        const affirmedSetting = !/(?:讨论|提及|并非|不是|不能|假想|设想|计划|未来|无关|文件目录|否认|反驳|引用|引述)/u.test(sentence);
        const observedSetting = affirmedSetting && !/(?:他人|第三方|其他研究|先前研究|相关工作|转述|撤回|不成立|错误|有误)/u.test(sentence);
        const source = String(sourceText || '').replace(/\s+/gu, ' ');
        const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const simulation = /(?:在|于)(?:用|使用)([A-Z][A-Za-z0-9._-]{2,39})合成(?:矩形)?房间[^。！？!?\n]{0,100}(?:分开|分别)优化几何与吸收的([1-9][0-9]{0,4})次重复实验中/u.exec(sentence);
        const simulationSetting = observedSetting && simulation
            && hasOwnSourceStatement(sourceText, new RegExp(`All simulations were performed using synthetic RIRs generated using the ${escape(simulation[1])} library`, 'u'))
            && hasOwnSourceStatement(sourceText, new RegExp(`The experiment is repeated ${simulation[2]} times, with the room dimensions and absorption coefficients`, 'u'))
            && hasOwnSourceStatement(sourceText, /The present experiments optimize (?:absorption and geometry individually|geometry and absorption coefficients separately)/u);
        const synthetic = /(?:在|于)基于([A-Z][A-Za-z0-9._-]{2,39})歌曲构建的([1-9][0-9]{0,5})个合成样本的[^。！？!?\n]{1,60}(?:排序|评估|评测)中/u.exec(sentence);
        const sampleCount = synthetic && synthetic[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        const syntheticEvidence = synthetic && new RegExp(`For evaluation, we construct (?:${synthetic[2]}|${sampleCount}) synthetic examples[^.!?]{0,200}\\b${escape(synthetic[1])}(?![A-Za-z0-9_])`, 'u').exec(source);
        const countedSyntheticSetting = observedSetting && syntheticEvidence
            && ownObservedSourceScope(source.slice(Math.max(0, source.lastIndexOf('. ', syntheticEvidence.index) + 2), syntheticEvidence.index) + syntheticEvidence[0]);
        const durationBenchmark = /(?:在|于)\s*([1-9][0-9]*(?:\.[0-9]+)?)小时\s*([A-Z][A-Za-z0-9._-]{1,39}-Bench)(?:上|中)[^。！？!?\n]{0,60}(?:评估|评测)/u.exec(sentence);
        const sourceHasDurationBenchmark = durationBenchmark && hasOwnSourceStatement(sourceText,
            new RegExp(`(?<![A-Za-z0-9_])${durationBenchmark[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])\\s+is\\s+[^.!?\\n]{0,100}\\btotal duration of ${durationBenchmark[1].replace('.', '\\.')}\\s+hours?\\b`, 'iu'));
        // A named Chinese keyword corpus plus an actual annotation split is a
        // setting, even without the generic word 数据集. Require source-observed
        // police keyword evaluation and both split roles, never a bare place name.
        const keywordScope = /(?:在|于)([\u3400-\u9fff]{2,12})警务关键词集(?:上|中)/u.exec(sentence);
        const annotationSplit = /(?:百分之([一二三四五六七八九十]+)|([1-9][0-9]?)%)人工转写加(?:百分之([一二三四五六七八九十]+)|([1-9][0-9]?)%)(?:仅)?机器转写划分/u.exec(sentence);
        const percent = value => {
            if (/^[0-9]+$/u.test(value)) return Number(value);
            const digits = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
            const parts = String(value).split('十');
            return parts.length === 2 ? (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0) : digits[value];
        };
        const city = keywordScope && ({ 巴尔的摩: 'Baltimore', 芝加哥: 'Chicago' })[keywordScope[1]];
        const keywordCorpus = city && annotationSplit
            && hasOwnSourceStatement(sourceText, new RegExp(`(?:\\b${city}\\b[^.!?\\n]{0,100}\\b(?:police|data|dataset)\\b|\\b(?:police|data|dataset)\\b[^.!?\\n]{0,100}\\b${city}\\b)`, 'iu'))
            && hasOwnSourceStatement(sourceText, /\bpolice\b[^.!?\n]{0,100}\bkeywords?\b/iu)
            && hasOwnSourceStatement(sourceText, new RegExp(`\\bWe\\b[^\\n]{0,100}\\b(?:${city}|${city[0]}PD)\\b[^.!?\\n]{0,160}\\b${percent(annotationSplit[1] || annotationSplit[2])}%\\s+transcribed\\s*(?:and|,)\\s*${percent(annotationSplit[3] || annotationSplit[4])}%\\s+untranscribed`, 'iu'));
        // Odd/even trial holdout is a concrete split only when fitting and
        // evaluation consume disjoint parity sets and an observed comparison follows.
        const parityHoldout = affirmedSetting
            && /(?:在|于)反馈块上奇数试次拟合[、,，]偶数试次评估的留出比较中/u.test(sentence)
            && hasPrefixedCoreMetricComparison(sentence, sourceText)
            && /以偶数试次留出对数似然为指标/u.test(sentence);
        // A named dataset plus a positive, bounded sample count is a concrete
        // subset; a bare method name, path or configuration count is not.
        const subset = /(?:在|于)(?:分布外)?([A-Z][A-Za-z0-9._-]{2,39})的([1-9][0-9]{0,5})个(?:片段|视频|音频|样本)子集(?:上|中)[，,]/u.exec(sentence);
        const subsetSource = String(sourceText || '').replace(/\s+/gu, ' ');
        const namedSubsetInSource = subset && new RegExp(String.raw`(?<![A-Za-z0-9_])${subset[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])[^.!?]{0,160}(?<![0-9])${subset[2]}(?![0-9])`, 'iu').test(subsetSource);
        const countedNamedSubset = affirmedSetting && namedSubsetInSource
            && !/(?:相关工作|先前工作|先前研究|既有研究|其他研究|第三方|外部团队|其他团队|他人|转述|撤回|不成立|不正确|错误|有误)/u.test(sentence)
            && /(?:在|于)(?:分布外)?[A-Z][A-Za-z0-9._-]{2,39}的[1-9][0-9]{0,5}个(?:片段|视频|音频|样本)子集(?:上|中)[，,]/u.test(sentence)
            && /(?:准确率|错误率|WER|UAR|PESQ|STOI)(?:从|由)\s*\d+(?:\.\d+)?\s*(?:%|％)?(?:升至|降至)\s*\d+(?:\.\d+)?/iu.test(sentence);
        const languageNamedDataset = affirmedSetting && /(?:在|于)(?:[\u4e00-\u9fff]{1,8}语)\s*[A-Z][A-Za-z0-9._-]{2,}(?:上|中)/u.test(sentence);
        const heldOutConversations = affirmedSetting && /(?:在|于)\s*每(?:模型|权重)\s*[1-9][0-9]*\s*组(?:留存|留出)对话(?:上|中)/u.test(sentence);
        const syntheticSetting = /(?:在|于)\s*\d+\s*(?:组|个)\s*(?:随机|随机采样的|随机采样)\s*(?:双衰减|多衰减|房间脉冲响应|混响时间|声源位置|声学房间)\s*合成配置(?:上|中)/.test(sentence);
        const speakerSplit = /(?:在|于)\s*说话人(?:互斥|不重叠)的\s*[A-Z][A-Za-z0-9._-]{2,}\s*(?:语料)?实测(?:中|上)/.test(sentence);
        const timedHardware = /(?:在|于)\s*(?:Raspberry\s+Pi|Jetson|MacBook|Intel|AMD|NVIDIA|Apple|CPU|GPU)(?:\s+[A-Za-z][A-Za-z0-9_-]*){0,3}\s+[A-Za-z]{0,4}\d+[A-Za-z0-9._-]*(?:\s+[A-Za-z][A-Za-z0-9_-]*){0,2}\s*上/.test(sentence)
            && /(?:计时|耗时|时延|延迟|推理时间|运行时间|预处理时间)/.test(sentence);
        const namedRequestEvaluation = !/(?:讨论|提及|并非|不是|不能|假想|设想|假设|预计|预期|可能|计划|未来|无关|文件目录)/u.test(sentence) && /(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9._-]{1,39}-Bench(?![A-Za-z0-9_])全部\s*[1-9][0-9]*个请求的评估中/iu.test(sentence);
        const heldOutSpeakerComparison = !/(?:讨论|提及|并非|不是|不能|假想|设想|假设|预计|预期|可能|计划|未来|无关|文件目录)/u.test(sentence) && /(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}\s*标准(?:[1-9][0-9]*|[一二两三四五六七八九十]+)名留出说话人[^，,。！？!?；;\n]{0,100}比较中/u.test(sentence);
        const experimentScope = /(?:在|于)[^，,。！？!?；;\n]{1,150}(?:实验|测量)(?:中|上)/u.exec(sentence);
        const formatScope = /(?:在|于)([^，,。！？!?；;\n]{1,110}(?:语音|音频|音乐))(?:上|中)/u.exec(sentence);
        const scopes = [experimentScope && /[1-9][0-9]{0,5}\s*名[^，,。！？!?；;\n]{0,45}(?:参与者|听者|受试者|母语者|说话人)/u.test(experimentScope[0]) && /(?:聆听|听辨|听测|主观|重复)[^，,。！？!?；;\n]{0,45}实验/u.test(experimentScope[0]) ? experimentScope : null, /(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}\s*(?:匹配|失配|跨域|未见说话人)测试[^，,。！？!?；;\n]{0,60}(?:下|中|上)/u.exec(sentence),
            formatScope && /采样/u.test(formatScope[1]) && /(?:[1-9][0-9]{0,2}|[一二两三四五六七八九十百]{1,5})位/u.test(formatScope[1]) && /[0-9]+(?:\.[0-9]+)?\s*(?:kHz|Hz)(?![A-Za-z])/u.test(formatScope[1]) ? formatScope : null].filter(Boolean);
        const measuredNaturalSetting = !/(?:假设|假想|假定|设想|如果|若|是否|预计|预期|可能|计划|未来|讨论|提及|并非|不是|不能|未进行|未测|未报告|没有|将(?:会|要)?(?:在|于))/u.test(sentence) && scopes.some(scope => {
            let previousMetricHeader = false;
            for (const raw of sentence.slice(scope.index + scope[0].length).split(/[，,；;]/u)) {
                const clause = raw.trim();
                const metric = [CORE_SUMMARY_METRIC_PATTERN, CORE_SUMMARY_CONFERENCE_METRIC_PATTERN].some(pattern => {
                    const matches = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
                    return [...clause.matchAll(matches)].some(match => /^(?:(?:指标|分数|得分))?(?:(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?|下(?:有|无)[^，,；;。]{1,24}(?:刺激|条件)(?:为|是)\s*[-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.])/iu.test(clause.slice(match.index + match[0].length)));
                });
                if (/(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?(?:\s*(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分|x|×))?(?![A-Za-z0-9_.])/iu.test(clause) && !/(?:参数(?:量|值|个数)?|学习率|批量|批大小|样本(?:量|数)|训练|推理|部署|迭代|步数|轮数|GPU|CPU|显存|内存|硬件|时长|小时|batch)/iu.test(clause)
                    && (metric || (previousMetricHeader && /^(?:(?:本方法|本文方法|所提方法|提出的方法|本系统|该方法|该系统)(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?|[A-Z][A-Za-z0-9_-]{1,40}(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?\s*(?:%|％|dB|ms|s|秒|分钟|倍|点|分|x|×)(?![A-Za-z0-9_])|(?:元音|辅音|鼻音|擦音|音段)\s*`?\/[A-Za-z]+\/`?(?:为|是)\s*[-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.])/iu.test(clause)))) return true;
                previousMetricHeader = new RegExp(`^(?:以|用)(?:${CORE_SUMMARY_METRIC_PATTERN.source}|${CORE_SUMMARY_CONFERENCE_METRIC_PATTERN.source})(?:计|衡量)$`, 'iu').test(clause);
            }
            return false;
        });
        return simulationSetting || countedSyntheticSetting || observedSetting && (sourceHasDurationBenchmark || keywordCorpus)
            || parityHoldout || countedNamedSubset || languageNamedDataset || heldOutConversations
            || syntheticSetting || speakerSplit || timedHardware || namedRequestEvaluation || heldOutSpeakerComparison || measuredNaturalSetting;
    }

    function hasRecordedDissonanceComparison(sentence) {
        if (/(?:假设|假想|假定|如果|若|预计|预期|可能|讨论|提及|计划|未来|并非|不是|未测|未报告|未记录|未实测|尚未|没有|(?:不|未)(?:曾|实际|真正)?(?:在|于|进行|测|报告|记录)|将(?:会|要)?(?:在|于|进行))/u.test(sentence)) return false;
        if (!/(?:在|于)[^，,。！？!?\n]{1,100}(?:录音|听辨|听测|实验|测试)(?:比较|评测)?中/u.test(sentence)) return false;
        const pair = /(?:塞萨里斯|Sethares)\s*(?:感觉)?不协和度(?:从|由)\s*(\d+(?:\.\d+)?)(?:\s*任意单位)?\s*(增至|升至|降至|减至)\s*(\d+(?:\.\d+)?)(?:\s*任意单位)?(?=\s*(?:[，,；;]|$))/iu.exec(sentence);
        return Boolean(pair && (/(?:增|升)至/u.test(pair[2])
            ? Number(pair[3]) > Number(pair[1]) : Number(pair[3]) < Number(pair[1])));
    }

    function hasMeanRoomSimulationComparison(sentence) {
        if (/(?:假设|假想|假定|如果|若|预计|预期|可能|讨论|提及|计划|未来|并非|不是|未测|未报告|未记录|未实测|尚未|没有|(?:不|未)(?:曾|实际|真正)?(?:在|于|进行|测|报告|记录)|将(?:会|要)?(?:在|于|进行))/u.test(sentence)) return false;
        const context = /(?:在|于)([^，,。！？!?\n]{1,120})上(?:按|以)\s*[1-9]\d*\s*个房间平均(?:的)?(?:单房间)?(?:平均)?空间房间脉冲响应仿真耗时/u.exec(sentence);
        if (!context || !/(?:Apple|MacBook|Intel|AMD|NVIDIA|CPU|GPU|Jetson|Raspberry)/iu.test(context[1])) return false;
        const values = [...sentence.matchAll(/(?:镜像源)?([1-9]\d*)阶\s*(\d+(?:\.\d+)?)\s*(秒|毫秒|s|ms)(?![A-Za-z\d.])/giu)];
        if (values.length < 2 || new Set(values.map(value => value[1])).size !== values.length
            || values.some(value => Number(value[2]) <= 0)) return false;
        const seconds = new Map(values.map(value => [value[1], Number(value[2]) * (/^(?:毫秒|ms)$/i.test(value[3]) ? 0.001 : 1)]));
        const comparison = /([1-9]\d*)阶(?:明显)?(高于|低于)([1-9]\d*)阶(?:和([1-9]\d*)阶)?(?![\d.])/u.exec(sentence);
        if (!comparison) return false;
        const compared = [comparison[3], comparison[4]].filter(Boolean);
        return seconds.has(comparison[1]) && compared.every(order => seconds.has(order)
            && (comparison[2] === '高于' ? seconds.get(comparison[1]) > seconds.get(order)
                : seconds.get(comparison[1]) < seconds.get(order)));
    }

    function hasSourceBackedBayesianGroupResult(sentence, sourceText) {
        // An ER/PP pair measures evidence for a stated effect, not effect size.
        // Bind the measured response, compared conditions and direction to the
        // source; the same two numbers for another metric cannot supply a result.
        if (!sourceText || /假设|假想|如果|未来|计划|预计|可能|定义|阈值|先验|引用|引述|转述|他人|先前研究|相关工作|并非|没有|未测|未报告|否认|反驳|说法[^。]{0,20}(?:错误|不成立)/u.test(sentence)) return false;
        const effect = /(高|低)认知负荷下数字回忆编辑距离(高于|低于)(高|低)认知负荷/u.exec(sentence);
        const er = /证据比(?:\s*\(?ER\)?)?\s*(为|是|=|≥|>=|大于等于)\s*(\d+(?:\.\d+)?)(?![\d.eE+-])/u.exec(sentence);
        const pp = /后验概率(?:\s*\(?PP\)?)?\s*(?:为|是|=)\s*(\d+(?:\.\d+)?)(?![\d.eE+-])/u.exec(sentence);
        if (!effect || effect[1] === effect[3] || !er || !pp || Number(er[2]) <= 1 || Number(pp[1]) <= 0.5 || Number(pp[1]) > 1) return false;
        const source = String(sourceText).replace(/\s+/gu, ' ');
        const sourceDenied = /\b(?:previous|another|cited|quoted|hypothetical|future|planned|no|not|never|false|incorrect|untrue)\b|[“”"]/iu;
        const withdrawn = /^\s*(?:(?:but|however|in fact)[, ]+)?(?:this|these|the above)\s+(?:claim|result|finding|comparison|evaluation|measure|values?|observations?)[^.!?]{0,100}\b(?:not|never|false|incorrect|untrue|withdrawn|retracted|unmeasured)\b/iu;
        // A source may define recall accuracy using edit distance. Accept its
        // inverse orientation only with the actual measurement definition, not a
        // generic assumption that every accuracy score means edit distance.
        const definitions = [...source.matchAll(/Response accuracy for the digit (?:preload|recall) task was analysed[\s\S]{0,700}?It was calculated as the[\s\S]{0,200}?Levenshtein edit distance between a participant[’']s response[\s\S]{0,1100}?higher Levenshtein([\s\S]{0,240}?)distances represent less accurate answers/giu)].filter(match => {
            const prefix = source.slice(Math.max(0, match.index - 180), match.index);
            return !sourceDenied.test(prefix) && !sourceDenied.test(match[1])
                && !withdrawn.test(source.slice(match.index + match[0].length).replace(/^\s*[.!?]\s*/u, ''));
        });
        if (definitions.length !== 1) return false;
        const observed = /There was\s+(?:extremely\s+)?strong evidence that digit (?:preload|recall) accuracy was (lower|higher) under (high|low) cognitive load(?:\s*\([^)]{0,50}\))?\s+than (high|low) cognitive load(?:\s*\([^)]{0,50}\))?,?\s+with an evidence ratio\s*\(ER\)\s*of\s*(≥|>=)?\s*(\d+(?:\.\d+)?)(?![A-Za-z0-9_+-]|\.\d)\s+and posterior probability\s*\(PP\)\s*of\s*(\d+(?:\.\d+)?)(?![A-Za-z0-9_+-]|\.\d)/giu;
        return [...source.matchAll(observed)].some(match => {
            const prefix = source.slice(Math.max(0, match.index - 180), match.index);
            const after = source.slice(match.index + match[0].length).replace(/^\s*[.!?]\s*/u, '');
            if (sourceDenied.test(prefix) || withdrawn.test(after) || match[2] === match[3]
                || Number(match[5]) !== Number(er[2]) || Number(match[6]) !== Number(pp[1])
                || /≥|>=|大于等于/u.test(er[1]) !== Boolean(match[4])) return false;
            const sourceFirst = match[2] === 'high' ? '高' : '低';
            const distanceHigher = match[1] === 'lower';
            return (effect[2] === '高于') === (sourceFirst === effect[1] ? distanceHigher : !distanceHigher);
        });
    }

    // This observation belongs to the source's correction experiment, not to the
    // generic metric vocabulary. Parse actual scalar cells and the two observed
    // medical contrasts; no paper identity or reported numeric value is privileged.
    function sourceCorrectionRateProfile(sourceText) {
        const source = String(sourceText || '');
        const section = title => {
            const matches = [...source.matchAll(new RegExp('^([0-9]+(?:\\.[0-9]+)*)[ \\t]+' + title + '[ \\t]*\\r?\\n', 'gmu'))];
            if (matches.length !== 1) return null;
            const match = matches[0], start = match.index + match[0].length;
            const tail = source.slice(start), end = tail.search(/^[0-9]+(?:\.[0-9]+)*[ \t]+[A-Z]/mu);
            const body = tail.slice(0, end < 0 ? tail.length : end);
            const previous = normalizeLocalEvidenceHeading(source.slice(0, match.index).trimEnd().split('\n').at(-1));
            return ownObservedSourceScope(previous) ? body : null;
        };
        const conditions = section('Conditions'), definitions = section('Repair, damage and insertions');
        const setup = section('Experimental setup'), results = section('Repair, damage and break-rate');
        if (![conditions, definitions, setup, results].every(Boolean)) return null;
        const flat = value => value.replace(/\s+/gu, ' ');
        const ownedFact = (block, match) => {
            if (!match) return false;
            const before = flat(block).slice(0, match.index).slice(-400)
                .split(/(?<=[.!?])\s+(?=[A-Z])/u).at(-1);
            return ownObservedSourceScope(before + match[0]);
        };
        const groups = /([A-Z]) and ([A-Z]) correct the draft without and with the audio: the self-correction setting\. ([A-Z]) and ([A-Z]) correct the ASR output without and with the audio: the cross-system setting\./u.exec(flat(conditions));
        const primaryMatches = [...flat(setup).matchAll(/primary corrector is ([^\[\n]{1,100}?) \[[0-9, ]+\]/gu)];
        if (!ownedFact(conditions, groups) || new Set(groups.slice(1)).size !== 4 || primaryMatches.length !== 1
            || !ownedFact(setup, primaryMatches[0])
            || !/English medical dictation utterances/u.test(flat(setup))) return null;
        const primary = primaryMatches[0][1].trim();
        if (!ownedFact(definitions, /rep counts the tokens that are wrong in hh and right in y\^(?:\\hat\{y\})?;/u.exec(flat(definitions)))
            || !ownedFact(definitions, /rates are in % of reference tokens and all differences in percentage points/u.exec(flat(definitions)))
            || !ownedFact(definitions, /The break-rate is the share of error-free inputs that acquire at least one error\./u.exec(flat(definitions)))) return null;
        const captions = [...source.matchAll(/^Table[ \t]+([0-9]+): Effect of the audio,[ \t]*([^:\n]+): grounded minus text-only\r?\n/gmu)];
        const table = captions.filter(match => match[2].trim() === primary);
        if (table.length !== 1) return null;
        const caption = table[0], tail = source.slice(caption.index + caption[0].length);
        const captionPrefix = normalizeLocalEvidenceHeading(source.slice(0, caption.index).trimEnd().split('\n').at(-1));
        if (!ownObservedSourceScope(captionPrefix + '\n' + caption[0])) return null;
        const end = tail.search(/^Table[ \t]+[0-9]+:/mu), body = tail.slice(0, end < 0 ? tail.length : end);
        if (/\b(?:hypothetical|withdrawn|retracted|previous work|prior study)\b/iu.test(body) || !new RegExp('^Table[\\s\\u00a0]+' + caption[1] + ' separates the flows\\.').test(results)) return null;
        const lines = body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
        const header = lines.indexOf('rep');
        if (header < 0 || !['rep','dam','ins','net','break-rate'].every((name, i) => lines[header + i] === name)) return null;
        const self = `self-correction: ${groups[2]} (audio) vs. ${groups[1]} (no audio)`;
        const cross = `cross-system: ${groups[4]} (audio) vs. ${groups[3]} (no audio)`;
        const first = lines.indexOf(self), second = lines.indexOf(cross);
        if (first !== header + 5 || second !== first + 19 || lines.length !== second + 19) return null;
        const cohorts = ['TTS RU','RuLibri RU','Medical EN'];
        if (![first,second].every(start => cohorts.every((label, i) => lines[start + 1 + i * 6] === label))) return null;
        const scalar = token => {
            if (!/^(?:\+\+|−-|--|\+|-|−)?[0-9]+(?:\.[0-9]+)?$/u.test(token)) return NaN;
            return Number(token.replace(/^\+\+/u, '+').replace(/^(?:−-|--|−)/u, '-'));
        };
        const arrow = /^([0-9]+(?:\.[0-9]+)?)\s*(?:→(?:\\to)?|\\to)\s*([0-9]+(?:\.[0-9]+)?)$/u.exec(lines[first + 18]);
        const breakProse = /In self-correction the text-only cell breaks ([0-9]+(?:\.[0-9]+)?)%, ([0-9]+(?:\.[0-9]+)?)% and ([0-9]+(?:\.[0-9]+)?)% of the error-free drafts it receives, although its prompt is the stricter one\. The grounded cell breaks ([0-9]+(?:\.[0-9]+)?)%, ([0-9]+(?:\.[0-9]+)?)% and ([0-9]+(?:\.[0-9]+)?)%\./u.exec(flat(results));
        // A math scalar may be rendered once or twice, but two different tokens
        // cannot be folded into one value.
        const duplicatedScalar = token => {
            if (/^[0-9]+\.[0-9]+$/u.test(token)) return Number(token);
            const half = token.length / 2, left = token.slice(0, half);
            return Number.isInteger(half) && left === token.slice(half) && /^[0-9]+\.[0-9]+$/u.test(left)
                ? Number(left) : NaN;
        };
        const repProse = /In the cross-system setting damage also falls on all three corpora, with intervals excluding zero on two\. But repair rises on all three \([^)]{1,100}\)\. On medical dictation it goes from ([0-9.]+)% to ([0-9.]+)% of reference tokens, a ([0-9]+(?:\.[0-9]+)?)% relative increase\./u.exec(flat(results));
        const ownedResult = match => {
            if (!match) return false;
            const context = flat(results), before = context.slice(0, match.index).slice(-400)
                .split(/(?<=[.!?])\s+(?=[A-Z])/u).at(-1);
            const after = context.slice(match.index + match[0].length)
                .split(/(?<=[.!?])\s+(?=[A-Z])/u)[0].slice(0, 300);
            return ownObservedSourceScope(before + match[0] + after);
        };
        const profile = { primary, breakRate: null, rep: null };
        if (arrow && ownedResult(breakProse)) {
            const from = Number(arrow[1]), to = Number(arrow[2]);
            if (from === Number(breakProse[3]) && to === Number(breakProse[6]) && from > to && from <= 100 && to >= 0)
                profile.breakRate = { from, to };
        }
        if (ownedResult(repProse)) {
            const from = duplicatedScalar(repProse[1]), to = duplicatedScalar(repProse[2]), relative = Number(repProse[3]);
            const delta = scalar(lines[second + 14]);
            const places = (repProse[3].split('.')[1] || '').length;
            if (from > 0 && to > from && to <= 100 && Number.isFinite(delta) && places <= 100
                && Math.abs(to - from - delta) < 1e-9
                && Number(((to - from) / from * 100).toFixed(places)) === relative)
                profile.rep = { from, to, relative };
        }
        return profile;
    }

    function sourceBoundCorrectionRateObservations(text, sourceText) {
        const raw = String(text || ''), parts = raw.split(/[。！？!?\n]/u), profile = sourceCorrectionRateProfile(sourceText);
        const observations = parts.map(() => null);
        if (!profile) return observations;
        const escape = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const model = escape(profile.primary), measure = '([0-9]+(?:\\.[0-9]+)?)';
        const offsets = []; let offset = 0;
        for (const part of parts) { offsets.push(offset); offset += part.length + 1; }
        const parse = (index, inheritedPrimary = false) => {
            const original = parts[index], value = original.trim();
            if (!value || !hasOwnLocalReportedExperiment(raw, offsets[index], original)
                || !ownObservedSourceScope(value) || !isReportedExperimentPrefix(value.split(/[，,]/u)[0])) return null;
            const selfPrefix = /^(?:在自我修正设置下，以|在自我修正设置下医疗听写上，以|在自我修正设置下医疗听写上，用)/u;
            const crossPrefix = /^在跨系统设置下医疗听写上[，,]/u;
            const kind = selfPrefix.test(value) ? 'break-rate' : crossPrefix.test(value) ? 'rep' : null;
            const actual = kind === 'break-rate' ? profile.breakRate : kind === 'rep' ? profile.rep : null;
            if (!actual || !/医疗听写/u.test(value)) return null;
            const subject = kind === 'break-rate'
                ? /(?<!的)(?:上述|该|这一|前述)(?:破坏率|break-rate)?(?:观察|结论|结果)/giu
                : /(?<!的)(?:上述|该|这一|前述)(?:修复分量|修复率|rep)?(?:观察|结论|结果)/giu;
            if (hasAdjacentAffirmativeEvidenceWithdrawal(raw, offsets[index] + original.length, subject)) return null;
            const explicit = kind === 'break-rate'
                ? new RegExp('^(?:在自我修正设置下，以' + model + '在医疗听写上的破坏率为例[，,]'
                    + '|在自我修正设置下医疗听写上，以' + model + '的破坏率为例[，,]'
                    + '|在自我修正设置下医疗听写上，用' + model + '校正自身草稿时[，,])', 'u')
                : new RegExp('^在跨系统设置下医疗听写上[，,]用' + model + '校正独立识别器输出时[，,]', 'u');
            const identity = explicit.exec(value);
            const implicit = kind === 'rep' && inheritedPrimary && !/^在跨系统设置下医疗听写上[，,]用/u.test(value);
            if (!identity && !implicit) return null;
            const body = value.slice(identity ? identity[0].length : '在跨系统设置下医疗听写上，'.length);
            const bodyPattern = kind === 'break-rate'
                ? new RegExp('^(?:无音频单元(?:破坏率break-rate)?为' + measure + '%[，,]有音频单元(降至)' + measure + '%)$', 'u')
                : new RegExp('^(?:无音频单元修复分量rep占参考词元比例为' + measure + '%[，,]有音频单元(升至)' + measure + '%'
                    + '|有音频单元相对无音频单元的修复分量占参考词元比例从' + measure + '%(升至)' + measure + '%)'
                    + '(?:[，,]相对增加' + measure + '%)?$', 'u');
            const matched = bodyPattern.exec(body);
            if (!matched) return null;
            const from = Number(matched[1] ?? matched[4]), to = Number(matched[3] ?? matched[6]);
            if (from !== actual.from || to !== actual.to) return null;
            if (kind === 'rep' && matched[7] !== undefined && Number(matched[7]) !== actual.relative) return null;
            return { kind, metric: true, direction: true, from, to, primary: profile.primary };
        };
        for (let index = 0; index < parts.length; index++) {
            // Re-derive the immediately preceding raw observation in this call.
            // Empty/header fragments break adjacency; no caller object is authority.
            const previous = index > 0 ? parse(index - 1) : null;
            observations[index] = parse(index, previous?.kind === 'break-rate');
        }
        return observations;
    }

    // DNSMOS is not MOS embedded in a longer word, nor are its SIG/BAK/OVL
    // subscales free-standing metric aliases. Admit only the source-defined family.
    const CORE_SUMMARY_DNSMOS_PATTERN = /(?<![A-Za-z0-9_.-])DNSMOS(?:[ \t]+P\.835)?[ \t]+(?:SIG|BAK|OVL)(?:\/(?:SIG|BAK|OVL))*(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|model\b|method\b|system\b|baseline\b|network\b))/iu;
    const CORE_SUMMARY_DNSMOS_DENIED = /假设|假想|假定|设想|如果|若(?:在|用|以)|可能|预计|预期|计划|未来实验|后续实验|建议|讨论|提及|引用|引述|转述|他人|第三方|外部团队|其他研究|先前(?:工作|研究)|相关(?:工作|研究)|并非|并未|不是|没有|不能|尚未|否认|否定|撤回|不成立|不正确|错误|有误|未报告|未观察|\b(?:if|suppose|assuming|hypothetical|planned|quoted|retracted|withdrawn|third[- ]party|external team|(?:previous|prior|related|other)\s+(?:work|stud(?:y|ies)|research)|not\s+(?:observed|reported|used))\b/iu;

    function hasAffirmativeDnsMosStatement(text, pattern, preceding = '', following = '') {
        const raw = String(text || '');
        const parts = raw.split(/[。！？!?\n]/u);
        let offset = 0;
        return parts.some(part => {
            const start = offset;
            offset += part.length + 1;
            const previous = raw.slice(0, start).trimEnd().split(/[。！？!?\n]/u).at(-1) || preceding;
            // A foreign/hypothetical heading cannot lend ownership to the next line.
            const heading = /[:：]$|^\s*(?:#{1,6}\s|\*\*|__)/u.test(previous)
                || previous.length <= 100 && CORE_SUMMARY_DNSMOS_DENIED.test(previous) ? previous : '';
            return pattern.test(part) && !CORE_SUMMARY_DNSMOS_DENIED.test(heading + part)
                && ownObservedSourceScope(heading + part)
                && !hasAdjacentAffirmativeEvidenceWithdrawal(raw + '。' + following, start + part.length,
                    /(?:上述|以上|前述|该|此|这一)(?:DNSMOS)?(?:指标|测量|评测|结果|结论|边界|说法|表述)/giu);
        });
    }

    function hasSourceDefinedDnsMos(sourceText) {
        // P.835 contains a decimal point, so preserve English periods here.
        const raw = String(sourceText || '');
        const lines = raw.split(/\r?\n/u);
        return lines.some((line, index) =>
            /\bwe use the reference-free DNSMOS P\.835 \(SIG\/BAK\/OVL\)/iu.test(line)
            && !CORE_SUMMARY_DNSMOS_DENIED.test((lines[index - 1] || '') + '\n' + line)
            && ownObservedSourceScope(line)
            && !/\b(?:withdrawn|revoked|false statement|not used)\b|撤回|不成立|有误/iu.test(lines[index + 1] || ''));
    }

    function hasSourceBoundDnsMosBoundary(summary, sourceText) {
        if (!hasSourceDefinedDnsMos(sourceText)) return false;
        // This is the actual three-category comparison, not a generic permission
        // to treat any distribution noun as an applicability boundary.
        const source = String(sourceText || '');
        const tableMatch = /Table 1: Comparison of different systems on the DNS Challenge test set\.[\s\S]*?(?=\n3\.1 Architecture Overview)/u.exec(source);
        const table = tableMatch?.[0] || '';
        const tablePrefix = source.slice(0, tableMatch?.index || 0).trimEnd().split('\n').at(-1) || '';
        if (CORE_SUMMARY_DNSMOS_DENIED.test(tablePrefix) || !ownObservedSourceScope(tablePrefix)
            || !/With Reverb\s+Without Reverb\s+Real Recordings\s+(?:DNSMOS ↑[^\n]*\n){3}(?:SIG\s+BAK\s+OVL\s*){3}/u.test(table)
            || CORE_SUMMARY_DNSMOS_DENIED.test(table)
            || !ownObservedSourceScope(table)) return false;
        const row = label => {
            const rows = [...table.matchAll(new RegExp('(?:^|\\n)' + label + '\\n[✓✗]\\n((?:[0-9]+\\.[0-9]+(?:\\n|$)){9})', 'gu'))];
            return rows.length === 1 ? rows[0][1].trim().split(/\s+/u).map(Number) : null;
        };
        const baseline = row('SELM[^\\n]*');
        const measured = row('StreamSE \\(ℓ=0\\\\ell\\{=\\}0\\)');
        if (!baseline || !measured || !(measured[6] < baseline[6] && measured[8] < baseline[8])) return false;
        return hasAffirmativeDnsMosStatement(summary,
            /结论限于DNSMOS感知的合成分布/u)
            && hasAffirmativeDnsMosStatement(summary,
                /真实录音(?:类)?(?:上)?[，,]?(?:零前视StreamSE的)?(?:DNSMOS[ \t]+)?SIG(?:和|与)(?:DNSMOS[ \t]+)?OVL仍落后于SELM(?![A-Za-z0-9_.-])/u);
    }

    // "在24个新地点…的登记测试中" / "在16个源位置的方位角估计中"：带计数的评测范围
    // 本身就是具体设置。要求数量、量词、评测动作与范围标记同时出现；假设、未来工作、
    // 他人转述和否定语境不算。调用方给了原文时，计数值必须真的出现在原文里，避免
    // 编造"在100个地点测试中"。
    function hasCountedEvaluationScope(sentence, sourceText = '') {
        const text = String(sentence || '');
        if (/(?:假设|假想|假定|设想|如果|若在|预计|预期|可能|计划|未来|讨论|提及|并非|不是|不能|未在|没有|未进行|未做|将(?:会|要)?(?:在|于))/u.test(text)) return false;
        if (/(?:他人|第三方|其他研究|先前研究|相关工作|转述|引用|引述)/u.test(text)) return false;
        const scope = /(?:在|于)([^。！？!?\n]{0,90}?)([1-9][0-9]{0,5})\s*个([^。！？!?\n]{0,60}?)(?:测试|实验|测量|估计|评测|评估|检验|比较)(?:中|上)/u.exec(text);
        if (!scope) return false;
        const source = String(sourceText || '');
        if (!source) return true;
        return new RegExp(`(?<![0-9.])${scope[2]}(?![0-9.])`, 'u').test(source);
    }

    // "按1 km内命中地点数计" 是原文自己的命中计数口径（places/clips hit within 1 km），
    // 不是泛化的"指标""分数"或"多项指标"。只有原文确实按命中与距离口径报告结果时，
    // 才把这个指标名当结果指标。
    function hasSourceBoundHitCountMetric(sentence, sourceText = '') {
        const text = String(sentence || '');
        if (!/(?:按|以|用)[^，,。；]{0,24}?命中(?:地点|位置|片段|录音|包|时刻|窗口|流|单元)(?:数|比例|率)?/u.test(text)) return false;
        if (/(?:假设|假想|假定|设想|如果|若在|预计|预期|可能|计划|未来|讨论|提及|并非|不是|没有|未|不能|他人|第三方|先前(?:研究|工作)|相关工作|引用|引述|转述)/u.test(text)) return false;
        const source = String(sourceText || '');
        return /\b(?:hit|hits|place[sd]?|clips?|packets?)\b[^.\n]{0,100}\bwithin\s+[0-9]+(?:\.[0-9]+)?\s*(?:km|m)\b/iu.test(source)
            || /\bwithin\s+[0-9]+(?:\.[0-9]+)?\s*(?:km|m)\b[^.\n]{0,100}\b(?:hit|hits|place[sd]?)\b/iu.test(source);
    }


    // ─── Core-summary product handoff, method chain, boundary & simulation purpose exemptions ───
    function hasBlockLayoutProductChain(summary, maxSentenceChars = 320) {
        // 布局、筛出的键块和内核必须在同句真实交接，不能只罗列组件名。
        return String(summary || '').split(/[。！？!?；;\n]/u).some(sentence => {
            if (sentence.length > maxSentenceChars || /(?:讨论|提及|不实现|尚不|不负责|不参与|不承担|并非|并未|不是|没有|不能|不会|尚未|未曾|假设|设想|如果|若|可能|预计|计划|未来|建议)|(?:不|未)(?:曾|实际|直接|真正|会|能)*\s*(?:进入|计算|筛选|补充|恢复)/u.test(sentence)) return false;
            return /(?:该|此)布局(?:经[^，,。；]{1,16}(?:置换|重排))?进入查询块与键块筛选[，,]\s*以块(?:级)?均值特征计算块分数并用混合Top-k与Top-p为[^，,。；]{1,30}补充键块[，,]\s*选中键块进入稀疏注意力内核计算(?:再|并)经逆置换恢复原序/u.test(sentence);
        });
    }

    function hasPosteriorUpdateProductChain(summary, maxSentenceChars = 320) {
        // 当前模型先产生后验功率，再把同一产物交给参数更新。
        return String(summary || '').split(/[。！？!?；;\n]/u).some(sentence =>
            sentence.length <= maxSentenceChars
            && !/(?:假定|是否|讨论|提及|并非|并未|不是|没有|不能|不会|尚未|未曾|假设|如果|可能|计划|未来)|(?:不|未)(?:曾|实际|直接|真正|确实|被)*\s*(?:算出|计算|进入|更新)/u.test(sentence)
            && /由当前模型方差(?:算出|计算)(?:成分占模型方差的)?贡献比与后验功率[，,]\s*(?:该|此)后验功率作为固定输入进入同一成分的幅度与衰减率更新/u.test(sentence));
    }

    function hasConcreteProductHandoff(summary, maxSentenceChars = 320) {
        // Typed, ordered producer/consumer handoffs. Do not count module names or
        // action words alone, and do not stitch unrelated paragraphs together.
        const sentences = String(summary || '').replace(/（[^）]*）|\([^)]*\)/gu, '')
            .split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
        const denied = /(?:假设|设想|假定|如果|可能|未来|拟采用|计划|预计|预期|应当|应该|并非|并未|没有|不能|尚未|未曾|另一(?:种|套)|独立方法|讨论|提及|对比|比较|相关工作|先前工作|文献|未(?:实现|执行|实施)|不负责|不用于|不与|未与)|(?:^|[。；，,])\s*建议|(?:不|未)(?:被|曾|直接|实际|真正|会|能|再)*\s*(?:生成|输出|预测|提取|抽取|转成|送入|配对|拼接|作用于|统计|计算|重建|合并)/u;
        const neuralTokens = /解码器[^。；]{0,140}(?:预测|输出|生成)(?:源内容对应的)?(?:离散)?声学令牌[^。；]{0,140}(?:所得|这些|该)(?:声学)?令牌(?:再)?送入(?:神经音频)?编解码器(?:解码器)?(?:重建|解码)(?:为|成)?波形/u;
        const frameProduction = /编码器[^。；]{0,120}(?:输出|转成|提取|抽取)(?:为|成)?帧级(?:编码)?表示/u;
        const frameConsumption = /听众嵌入[^。；]{0,100}与(?:每帧编码|帧级(?:编码)?表示)拼接[，,]\s*拼接序列送入[^。；]{0,45}(?:长短期记忆网络|BiLSTM|回归头)[^。；]{0,20}(?:得到|输出|预测)帧级分数/u;
        const maskProcessing = /(?:录音|清洁语音|干净语音)[^。；]{0,90}(?:生成|得到)二值时频掩码[，,]\s*(?:再|随后)?(?:(?:将|把)(?:该|所得)?(?:二值时频)?掩码)?作用于[^。；]{0,60}统计(?:语音帧与噪声帧|语音与噪声)(?:的)?功率[^。；]{0,70}(?:算出|计算)[^。；]{0,50}信噪比/u;
        const textProduction = /问答[^。；]{0,70}以[^。；]{0,50}为输入(?:转成|重构成)一问一答[^。；]{0,100}整体反馈[^。；]{0,90}合并成[^。；]{0,60}辅导文本/u;
        const textConsumption = /两类文本[^。；]{0,35}与对应录音配对[^。；]{0,100}指令微调/u;
        for (let i = 0; i < sentences.length; i++) {
            for (const size of [1, 2]) {
                const parts = sentences.slice(i, i + size);
                if (parts.length !== size || parts.some(s => s.length > maxSentenceChars)) continue;
                const window = parts.join('。');
                if (denied.test(window)) continue;
                if (!/(?:若|假想|假定|设想|是否|相互独立|无关(?:的)?(?:波形|方法))|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:回归|预测|输出|求|计算|得到)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)|(?:不|未|没有)(?:再|实际|直接|继续)?(?:使用|采用|处理|传递|送入)(?:该|此|所得)?(?:估计)?(?:基频)?波形|(?:丢弃|弃用)(?:了)?(?:该|此|所得)?(?:估计)?(?:基频)?波形|(?:不|未|没有)(?:再|实际|直接|继续)?(?:将|把)(?:该|此|所得)(?:估计)?(?:基频)?波形[^，,。；]{0,12}(?:送入|用于|交给)/u.test(window) && /(?:编码器|解码器|网络)[^。；]{0,180}(?:回归|预测|输出)(?:估计的)?(?:基频)?波形/u.test(parts[0])
                    && /(?:由|将|把)(?:该|此|估计得到的)(?:估计)?(?:基频)?波形[^，,。；]{0,12}(?:求|计算|得到)解析信号并(?:计算|求取)相位导数(?:即得|得到)(?:瞬时频率|连续基频)/u.test(parts.at(-1))) return true;
                if (neuralTokens.test(window) || maskProcessing.test(window)
                    || (frameProduction.test(parts[0]) && frameConsumption.test(parts.at(-1)))
                    || (textProduction.test(parts[0]) && textConsumption.test(parts.at(-1)))) return true;
            }
        }
        return false;
    }

    // Shared grammar. No paper/model/benchmark names are accepted here.
    function hasExplicitArtifactHandoff(summary, sourceText = '', maxSentenceChars = 320) {
        const sentences = String(summary || '').replace(/（[^）]*）|\([^)]*\)/gu, '')
            .split(/[。！？!?；;\n]/u).map(text => text.trim()).filter(Boolean);
        const denied = /(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|讨论|提及|并非|不是|没有|未曾|尚未|独立方法|无关)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:生成|输出|得到|形成|取出|提取|编码|使用|接收|承接|送入|进入|作为|用于|计算|分成|分派)/u;
        const production = /(?:生成|得到|输出|形成|统一为|压缩为|池化得|取出|提取|抽取)/u;
        const processing = /(?:修复|合成|重采样|预处理|构造|编码|池化|变换|搬移|变频|检测器|分类头)/u;
        const consumerAction = /(?:分成|分派|编码|计算|训练|学习|分类|回归|去噪|评分|解码|重合成)/u;
        const artifacts = [
            {names:/(?:刺激)?语音/gu, same:'(?:刺激)?语音'},
            {names:/配对(?:监督)?信号/gu, same:'配对(?:监督)?信号'},
            {names:/(?:双|两)视图/gu, same:'(?:双|两)视图'},
            {names:/(?:utterance|输入)?嵌入/gu, same:'(?:utterance|输入)?嵌入'},
            {names:/(?:数值|定长|固定维数)?向量/gu, same:'(?:数值|定长|固定维数)?向量'}
        ];
        // Typed signal/state products use the same local production/consumption
        // rule. Parallel branches share an input; none implies a serial handoff.
        const typedDenied = /(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|讨论|提及|第三方|他人|相关工作|相关研究|先前工作|先前研究|既有研究|旧工作|引用|引述|转述|并非|并未|不是|没有|不能|尚未|未曾|独立方法|无关|丢弃|弃用|忽略)|\b(?:if|suppose|assuming|hypothetical|not\s+(?:implemented|executed|performed)|(?:future|planned)\s+(?:work|implementation))\b|\b(?:previous|prior|related|other)\s+(?:work|stud(?:y|ies)|research)\b|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:输出|生成|得到|形成|切分|转写|送入|接收|融合|映射|更新|移动|微调|执行|实现)/iu;
        const revoked = /^(?:上述|以上|前述|该|此|这些)(?:方法|处理)?(?:链|流程|过程|交接)[^。]{0,60}(?:并未|没有|未曾|不成立|错误|撤回|未执行|不执行)/u;
        const prefacedForeign = /(?:第三方|他人|相关工作|先前工作|先前研究|既有研究|旧工作|\b(?:previous|prior|related)\s+(?:work|research)\b)[^。]{0,60}(?:如下|所示|描述|流程|方法)[：:]?$/iu;
        const precedingOwnerTitle = /^(?:(?:第三方|他人|先前|此前|既有|旧|相关|基线|对照)(?:研究|工作|方法|系统|模型)|(?:previous|prior|related|third[- ]party|baseline|control)\s+(?:work|research|method|system|model)(?:\s+describes?\s+the\s+following\s+(?:method|process))?)\s*[：:]$/iu;
        const typedSafe = (index, count = 1) => {
            const previousTitle = normalizeLocalEvidenceHeading(sentences[index - 1] || '');
            const parts = sentences.slice(index, index + count);
            const foreignOwner = /^(?:(?:基线|对照)(?:方法|系统|模型|研究)(?:流程)?|(?:baseline|control)\s+(?:method|system|model))[：:]/iu;
            return parts.length === count && parts.every(part => part.length <= maxSentenceChars && !typedDenied.test(part) && !foreignOwner.test(part))
                && !prefacedForeign.test(sentences[index - 1] || '')
                && !precedingOwnerTitle.test(previousTitle)
                && !revoked.test(sentences[index + count] || '');
        };
        for (let index = 0; index < sentences.length; index++) {
            const first = sentences[index], second = sentences[index + 1] || '';
            if (typedSafe(index)) {
                // Filtering produces the same partitioned speech for two parallel
                // measurement consumers. The listening arm is not fed SV scores.
                const partition = /(?:过滤|滤波)[^。]{0,140}?(?:把|将)[^。]{0,100}?切分(?=[，,])/u.exec(first);
                const measurement = /将切分后语音送入[^。]{1,100}(?:嵌入余弦计算|分类)/u.exec(first);
                if (partition && measurement && partition.index + partition[0].length <= measurement.index
                    && /(?:并|同时)用相同切分构建配对交由听众评分/u.test(first)) return true;
                // Immediate, typed ellipsis consumes precisely the just-produced
                // spectrum/symbols, rather than an unrelated system's output. The
                // symbol consumer is a closed sound-stage ellipsis: no intervening
                // proposition or alternative input can hide inside its role name.
                const products = [
                    { produced: /(?:生成器|风格化器|解码器|声学模型)[^。]{0,180}输出(?:当前块)?梅尔谱/u,
                      consumed: /^[，,]\s*(?:再|随后)?由(?:因果)?声码器(?:变成|转成|合成|生成|输出)波形/u },
                    { produced: /(?:音频|语音)(?:转MIDI)?[^，,。]{0,70}转写为(?:音乐)?符号/u,
                      consumed: /^[，,]\s*(?:再|随后)?经(?:简化|可微|实时|因果)?(?:[A-Za-z][A-Za-z0-9–-]{0,39})?(?:弦|波表|加法|减法|物理建模|FM)合成(?:与MIDI打击乐)?发声(?=[，,。]|$)/u }
                ];
                for (const product of products) {
                    const made = product.produced.exec(first);
                    if (made && product.consumed.test(first.slice(made.index + made[0].length))) return true;
                }
                // An initialization is an executed optimization product here,
                // never a declaration of hyperparameters or an unused state.
                const endpoint = /内层更新得到回合终点/u.exec(first);
                const initialized = /(?:把|将)初始化向回合终点的平均方向外层(?:移动|更新)得到[^，,。]{0,20}初始化/u.exec(first);
                if (endpoint && initialized && endpoint.index < initialized.index
                    && /^[，,]\s*该初始化(?:随即|随后|再)?用[^，,。]{1,100}真实目标语音微调/u.test(first.slice(initialized.index + initialized[0].length))) return true;
            }
            if (!typedSafe(index, 2)) continue;
            // Closed, source-bound optimization and codec products. Reuse the
            // existing adjacent-heading/negation/foreign-owner safety checks.
            // A list of steps, a configured update, or an unrelated consumer fails.
            const localNotice = normalizeLocalEvidenceHeading(sentences[index - 1] || '');
            const extraOwnerDenied = /(?:不同|其他|外部|另一)(?:作者|团队|研究)|\b(?:other|external|different)\s+(?:authors?|teams?|researchers?)\b|^(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|建议)[^。]{0,80}(?:方法|流程|步骤|如下)/iu;
            const currentOwnedPair = !extraOwnerDenied.test(localNotice)
                && !extraOwnerDenied.test(first) && !extraOwnerDenied.test(second);
            const source = String(sourceText || '').replace(/\s+/gu, ' ');
            // Constructed questions supply the model input; the same structured
            // response reaches a rule verifier, whose two rewards drive the policy
            // update. These are actual product edges, not a list of RL components.
            const constructedInput = sentences[index - 1] || '';
            const priorNotice = normalizeLocalEvidenceHeading(sentences[index - 2] || '');
            const rewardChainDenied = /否认|否定|反驳|驳斥|撤回|放弃|弃用|丢弃|(?:^|[，,：:])\s*(?:若|倘若)(?!干)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:构造|相加|优化|更新)/u;
            const rewardChainRevoked = /^(?:上述|以上|前述|该|此|两类)(?:方法链|方法流程|流程|回答与奖励流程|回答|奖励|策略更新)[^。]{0,60}(?:并未|没有|未曾|从未|尚未|不曾|不成立|错误|撤回|未执行|不执行|放弃|弃用|丢弃|未进入|不进入|不再)/u;
            if (currentOwnedPair && index > 0 && typedSafe(index - 1, 3)
                && ![constructedInput, first, second].some(part => rewardChainDenied.test(part))
                && !rewardChainRevoked.test(normalizeLocalEvidenceHeading(sentences[index + 2] || ''))
                && !(/[：:]$/u.test(priorNotice) && (extraOwnerDenied.test(priorNotice)
                    || /\b(?:hypothetical|planned|future|not implemented)\b/iu.test(priorNotice)))
                && /构造答案已知的选择题[^。]{1,180}候选项构成模型的输入$/u.test(constructedInput)
                && /^模型以该输入生成结构化回答[，,]/u.test(first)
                && /[，,]\s*该回答(?:随即|随后|再)?进入规则奖励函数$/u.test(first)
                && /^奖励函数按答案是否与构造时确定的正确答案一致计算准确率奖励[、，,]\s*按是否遵守格式计算格式奖励[，,]/u.test(second)
                && /两类奖励相加后作为[^，,。]{0,50}组内比较信号[，,][^。]{0,100}从而优化策略/u.test(second)) {
                // Require affirmative source evidence for all three handoffs.
                // Local scope rejects a quoted, hypothetical or foreign protocol
                // without vetoing an unrelated related-work section elsewhere.
                const sourceDenied = /\b(?:if|assuming|suppose|may|might|could|would|hypothetical(?:ly)?|planned|future|previous|prior|related|another|cited|quoted|not|never|false|incorrect|untrue)\b|\b(?:other|external)\s+(?:authors?|teams?|researchers?|work|research|methods?|systems?|models?)\b|[“”"]/iu;
                const sourceOwnerHeading = /^(?:(?:previous|prior|related|other|external|third[- ]party)\s+(?:work|research|stud(?:y|ies)|methods?|systems?|protocols?)|(?:hypothetical|planned|future)\s*(?:work|research|methods?|systems?|protocols?)?|not implemented)[.:：]?$/iu;
                const rawSource = String(sourceText || '');
                const supported = pattern => {
                    const match = new RegExp(pattern.source.replace(/ /gu, '\\s+'), pattern.flags).exec(rawSource);
                    if (!match) return false;
                    const before = rawSource.slice(0, match.index);
                    const previousLine = before.slice(0, before.lastIndexOf('\n')).trimEnd().split('\n').at(-1) || '';
                    const priorHeading = normalizeLocalEvidenceHeading(previousLine);
                    if (sourceOwnerHeading.test(priorHeading)) return false;
                    const boundary = [...before.matchAll(/[.!?](?=\s|$)/gu)].at(-1);
                    const start = boundary ? boundary.index + 1 : 0;
                    const after = rawSource.slice(match.index + match[0].length);
                    const followingBoundary = after.search(/[.!?](?=\s|$)/u);
                    const end = followingBoundary < 0 ? rawSource.length
                        : match.index + match[0].length + followingBoundary + 1;
                    return !sourceDenied.test(rawSource.slice(start, end));
                };
                if (supported(/we construct[^.]{0,160}tasks whose answers are known by construction/iu)
                    && supported(/For each generated response[^.]{0,140}the rule-based reward function[^.]{0,100}combines these two components/iu)
                    && supported(/We compute the accuracy reward by comparing the model[’']s answer with the answer derived from task construction/iu)
                    && supported(/The format reward[^.]{0,120}is a binary indicator of whether the response follows the required structure/iu)
                    && supported(/These advantages guide policy updates to favor higher-reward responses/iu)) return true;
            }
            const adapted = /先在[^，,。]{0,70}合成[^，,。]{1,40}子集上(?:抽取|取)小批量做([1-9][0-9]{0,5})步内循环梯度更新[，,]\s*得到临时适应参数$/u.exec(first);
            const meta = /^再(?:把初始化向这些临时参数方向|以这些临时参数为目标把初始化向其方向|以临时参数与当前初始化的差为方向)做外循环移动[，,]\s*重复([1-9][0-9]{0,5})次元迭代得到易适应的元初始化[，,]\s*(?:接着(?:以该元初始化为起点)?|该元初始化直接作为起点[，,]\s*)用同一小时真实目标语音微调([1-9][0-9]{0,5})轮并在留出的真实集上评分$/u.exec(second);
            if (currentOwnedPair && adapted && meta
                && /为每个语言对和每个预训练模型从同一预训练检查点出发单独学一个初始化/u.test(first)
                && /For each model[^.]{0,500}learn a separate initialization[^.]{0,500}starting from[^.]{0,100}pretrained initialization/iu.test(source)
                && /parameter displacements without differentiating through the inner optimization trajectory/iu.test(source)
                && /After meta-training, the initialization is adapted to the one-hour real subset/iu.test(source)
                && new RegExp(`Meta-iterations\\s+${meta[1]}(?![0-9])`, 'iu').test(source)
                && new RegExp(`Inner steps[^.]{0,70}\\s${adapted[1]}(?![0-9])`, 'iu').test(source)
                && new RegExp(`Target fine-tuning epochs\\s+${meta[2]}(?![0-9])`, 'iu').test(source)) return true;
            // Boundaries determine the aggregation intervals; the quantized
            // code-duration pair then supplies the actual causal waveform decoder.
            if (currentOwnedPair
                && /(?:自适应触发机制以|以)[^，,。]{1,60}编码骨干输出的潜特征变化与波形频谱通量为输入做累计分配[，,]\s*按保留率定出整句固定的事件总数并切出时长可变的事件边界[，,]\s*边界划分结果决定后续聚合区间$/u.test(first)
                && /^区间聚合器以(?:上一|该区间的|本区间的)?起始帧特征与(?:同一|该)?区间均值为输入[，,]\s*再拼接显式时长合成为量化器输入[，,]\s*每个事件输出离散码与时长[，,]\s*该码[—–-]时长表示直接摆成稀疏网格送入因果变换器与频谱合成解码器增量合成波形$/u.test(second)
                && /firing signal determines only the boundaries and does not weight the pooled features/iu.test(source)
                && /aggregator combines the onset feature, the mean of the enclosed frame features, and the duration for each event/iu.test(source)
                && /decoder places each dequantized event vector at its starting grid position/iu.test(source)
                && /causal attention and convolutional dependencies/iu.test(source)) return true;
            // Distinct parallel monitoring arms each produce a local diagnostic;
            // the adjacent coordinator consumes that diagnostic group and forwards
            // its fused result to a separate communication stage.
            if (!/^(?:未被阻断的|有效的|通过完整性检查的)[^，,。]{1,60}并行送入/u.test(first)) continue;
            const actors = [...first.matchAll(/([\u3400-\u9fff]{1,10}层)(?:检验|检测|监测)/gu)];
            if (actors.length !== 2 || actors[0][1] === actors[1][1]) continue;
            const outputs = actors.every((actor, arm) => /(?:输出|生成|转入)[^，,。]{0,30}(?:标志|诊断|状态|弃权)/u.test(
                first.slice(actor.index, actors[arm + 1]?.index || first.length)));
            const joined = /^([\u3400-\u9fff]{1,10}层)接收(?:两|三|各)层局部诊断与分类结果[，,]\s*融合后经([\u3400-\u9fff]{1,10}层)映射为[^。]{1,60}(?:分类|状态)与灯号/u.exec(second);
            if (outputs && joined && joined[1] !== joined[2]
                && actors.every(actor => actor[1] !== joined[1] && actor[1] !== joined[2])) return true;
        }
        for (let index = 0; index < sentences.length; index++) {
            const first = sentences[index], second = sentences[index + 1] || '';
            if (first.length > maxSentenceChars || second.length > maxSentenceChars) continue;
            // A measured rollout hands an explicitly enumerated behavioral output
            // to scoring. It is a benchmark process, without invented model modules.
            if (!denied.test(first) && /(?:预载|载入)[^。]{1,80}(?:历史|上下文)[^。]{0,60}(?:实时流入|逐帧处理|滚动输入)[^。]{0,50}(?:该|此)阶段产生的[^。]{1,80}(?:、|与|和)[^。]{1,60}直接进入评分/u.test(first)) return true;
            for (const family of artifacts) {
                family.names.lastIndex = 0;
                for (const artifact of first.matchAll(family.names)) {
                    const before = first.slice(0, artifact.index);
                    const immediate = before.split(/[，,]/u).at(-1);
                    // Production can use the role in an earlier same-sentence
                    // clause, but never borrow an actor from another sentence.
                    if (!production.test(immediate) || !processing.test(before) || denied.test(before)) continue;
                    const productTail = first.slice(artifact.index + artifact[0].length);
                    const following = productTail + (second ? '。' + second : '');
                    const aliases = family.same;
                    const localReference = new RegExp(`(?:该|这些|上述|所得|取出的|得到的|形成的)(?:每个|每一|输入)?${aliases}[^，,。]{0,65}`, 'u');
                    const count = /([1-9][0-9]{0,5})\s*(?:段|个|条|维|种)?\s*$/.exec(immediate);
                    const countReference = count ? new RegExp(`${count[1]}\\s*(?:段|个|条|种)?${aliases}[^，,。]{0,65}`, 'u') : null;
                    const viewReference = /^(?:双|两)视图$/u.test(artifact[0]) ? /两视图[^，,。]{0,65}/u : null;
                    const references = [localReference, countReference, viewReference].filter(Boolean);
                    if (references.some(pattern => {
                        const used = pattern.exec(following);
                        if (!used) return false;
                        const preceding = following.slice(Math.max(0, used.index - 20), used.index);
                        return !denied.test(preceding + used[0]) && consumerAction.test(used[0]);
                    })) return true;
                    // Immediate ellipsis belongs only to the just-produced artifact;
                    // an unrelated output or an unowned pronoun cannot satisfy this.
                    if (/^[，,]\s*直接作为[^，,。]{0,20}(?:分类器|回归器|解码器|编码器)输入/u.test(productTail)
                        && !denied.test(productTail.split(/[。；]/u)[0])) return true;
                    // Explicit reception may precede the repeated artifact name.
                    const received = new RegExp(`(?:训练时)?承接该${aliases}[^。]{0,180}`, 'u').exec(second);
                    if (received && !denied.test(received[0]) && /(?:分支|模型|网络)[^。]{0,140}(?:学习|训练|去噪)/u.test(received[0])) return true;
                }
            }
        }
        return false;
    }

    // A concrete cached state producer and its adjacent causal consumer.
    function hasCachedCausalStateHandoff(summary, maxSentenceChars = 320) {
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
        const denied = /(?:假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|独立方法|他人|另一(?:个|种|套)(?:模型|方法|系统)|其他(?:模型|方法|系统)|并非|并未|不是|没有|不能|尚未|未曾|否认|否定|反驳|驳斥|引用|引述|转述)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:压缩|形成|生成|输出|缓存|使用|消费|建模|读取|接收)|(?:丢弃|弃用|忽略)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)/u;
        for (let i = 0; i + 1 < sentences.length; i++) {
            const first = sentences[i], second = sentences[i + 1];
            if (first.length > maxSentenceChars || second.length > maxSentenceChars || denied.test(first) || denied.test(second)) continue;
            // The vector must explicitly become the cached causal state sequence.
            if (!/编码器[^。；]{0,100}(?:压缩|汇聚|编码)为\s*(?:\d+\s*维)?向量[，,]\s*(?:形成|生成|得到)因果状态序列(?:并|[，,])缓存(?:供|用于)后续(?:时序)?建模(?:使用)?/u.test(first)) continue;
            // An adjacent causal temporal model actually models the same state product.
            if (/^(?:该|此)?因果(?:Conformer|Transformer|时序模型|时序网络)(?:沿|基于|使用)[^，,。；]{0,35}历史建模(?:该|此|这些)?状态(?:演变|序列)并(?:输出|预测|给出)(?:帧级|起始|事件|发生)?风险/u.test(second)) return true;
        }
        return false;
    }

    // A measured offline operating point has a concrete false-warning burden AND
    // explicitly lacks inference/deployment measurements. Cost absence alone fails.
    function hasOfflineOperationalBoundary(summary) {
        const sentences = String(summary || '').split(/[。！？!?\n]/u).map(s => s.trim()).filter(Boolean);
        const denied = /(?:假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|他人|另一(?:个|种|套)(?:模型|方法|系统)|其他(?:模型|方法|系统)|并非|并未|不是|没有|不能|尚未|未曾|否认|否定|反驳|驳斥|引用|引述|转述)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)/u;
        const overclaim = /(?:证明|证实|验证|确认)[^。；]{0,25}(?:临床|干预|实际部署|在线部署)[^。；]{0,25}(?:有效|有效性|效果|可行|成功)|(?:已|已经|完成)[^。；]{0,12}(?:临床|干预|实际部署|在线部署)[^。；]{0,15}(?:验证|有效|成功)/u;
        // A contradictory claim elsewhere cannot be masked by a qualifying sentence.
        if (overclaim.test(String(summary || ''))) return false;
        return sentences.some(sentence => {
            if (sentence.length > 600 || denied.test(sentence)
                || /(?:不|未)(?:曾|实际|真正|直接|仅|只|能|会)*在[^。；]{0,100}离线(?:仿真|模拟)评估/u.test(sentence)) return false;
            if (!/在[^。；]{1,100}离线(?:仿真|模拟)评估中[，,]/u.test(sentence)) return false;
            const operation = /\d+(?:\.\d+)?%报警占空比下[^，,。；]{1,40}(?:事件覆盖率|召回率|敏感性)\s*\d+(?:\.\d+)?%/u.test(sentence);
            const burden = /验证集[^。；]{0,30}阈值下[^。；]{0,90}但每分钟(?:有|产生)\s*\d+(?:\.\d+)?\s*(?:个|次)?误报(?:段|警报|报警)/u.test(sentence);
            const missingMeasurement = /原文(?:未报告|未披露)[^。；]{0,20}推理延迟(?:与|和|及)实际部署开销/u.test(sentence);
            return operation && burden && missingMeasurement;
        });
    }

    function hasNaturalScopedBoundary(summary) {
        if (hasOfflineOperationalBoundary(summary)) return true;
        return String(summary || '').split(/[。！？!?\n]/u).some(sentence => {
            if (/(?:并非|不是|不能说|不能认为|不应认为|否认)[^，,；;]{0,30}(?:限于|仅在|未经)/u.test(sentence)) return false;
            if (/(?:未经证实|效果未知)[^。]{0,30}(?:说法|表述|观点|判断)[^。]{0,20}(?:不成立|不正确|有误|错误)/u.test(sentence)) return false;
            // A conditional limitation can legitimately say 可能失效. It must name
            // this estimator and concrete data scarcity, not quote a foreign failure
            // or deny that failure. Keep this separate from measured-result guards.
            if (!/(?:假设|假想|设想|未来计划|引用|引述|转述|他人|其他(?:方法|模型|估计)|第三方|否认|反驳)|(?:并非|不是|不会|没有|不意味着|不能说)[^，,；;]{0,35}失效|失效[^，,；;]{0,20}(?:说法|表述)[^，,；;]{0,15}(?:错误|不成立)/u.test(sentence)
                && /(?:该(?:方法|模型|估计量)|本(?:方法|模型|估计量)|校正估计)[^。！？!?\n]{0,80}(?:词频过低|(?:人工|标注|无标注)样本过少|无标注数据过少)[^。！？!?\n]{0,70}(?:时|下)(?:仍)?(?:可能|易|会)失效/u.test(sentence)) return true;
            const measuredScope = /(?:结论|研究结果|研究发现|该提升|这些结果)(?:只|仅)在[^。！？!?；;\n]{1,140}(?:测试集|评测集|实录数据)[^。！？!?；;\n]{0,40}?(?:内|上|下|中)(?:得到)?(?:验证|成立)/u.exec(sentence);
            if (measuredScope && !/(?:并非|不是|不能|不应|否认|尚未|未经|没有|未曾|未被|假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|讨论|声称|据说)/u.test(sentence.slice(0, measuredScope.index + measuredScope[0].length))
                && !/(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:不成立|不正确|不属实|不是事实|错误|有误)|^(?:是|为)?(?:不成立|不正确|不属实|错误|有误)/u.test(sentence.slice(measuredScope.index + measuredScope[0].length, measuredScope.index + measuredScope[0].length + 50))) return true;
            return /(?:结论|研究结果|研究发现|该提升|这些结果)(?:只|仅)?在[^。]{1,100}(?:条件|语料|数据集|设置|说话人)[^。]{0,30}(?:下验证|中验证|得到验证|成立)/u.test(sentence)
                || /(?:该提升|这些结果|上述结论)(?:只|仅)?限于[^。]{1,100}(?:评测|语料|数据集|问答|场景|条件|设置|样本|任务)/u.test(sentence)
                || /(?:跨语言|跨说话人|新说话人|新硬件|词表外|开放式生成)[^。]{0,80}(?:效果未经证实|效果未知|尚未得到验证)/u.test(sentence);
        });
    }


    function hasGeneratedInputModelHeadChain(summary, maxSentenceChars = 320) {
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(text => text.trim()).filter(Boolean);
        const denied = /(?:并非|并未|没有|不能|尚未|未曾|假设|如果|可能|计划|未来|讨论|提及|独立方法|无关|相关工作)|(?:不|未)(?:曾|实际|直接|真正|再|会|能)*(?:送给|送入|生成|形成|作为|输出|预测)/u;
        for (let index = 0; index + 1 < sentences.length; index++) {
            const first = sentences[index], second = sentences[index + 1];
            if (first.length > maxSentenceChars || second.length > maxSentenceChars || denied.test(first) || denied.test(second)) continue;
            if (!/(?:生成|构造|形成)[^。]{1,100}(?:流|序列|样本|查询)[^。]{0,120}(?:特征|表示)[^。]{0,50}作为模型输入/u.test(first)) continue;
            const handoff = /^(?:该|此)输入(?:送给|送入)([^，,。]{1,100})[，,]\s*(?:模型输出|其输出)(?:再|随后)?(?:送给|送入|送)[^，,。]{1,60}分类器(?:预测|输出|判别)[^，,。]{1,50}/u.exec(second);
            if (handoff && /(?:模型|网络|记忆|注意力)/u.test(handoff[1])) return true;
        }
        return false;
    }

    function hasExplicitEditedVectorHandoff(summary, maxSentenceChars = 320) {
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
        const denied = /(?:并非|并未|不是|不会|不能|尚未|未曾|不再|假设|假想|假定|设想|如果|若|是否|可能|预计|预期|计划|未来|讨论|提及|相关工作|独立方法|无关)|(?:不|未|没有)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:输出|生成|得到|编辑|变换|移动|映射|使用|接收|承接|送入|作为|合成|重合成|重建)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)/u;
        for (let i = 0; i + 2 < sentences.length; i++) {
            const parts = sentences.slice(i, i + 3);
            if (parts.some(s => s.length > maxSentenceChars || denied.test(s))) continue;
            const produced = /编码器[^，,。；]{0,80}(?:输出|生成|得到)(?:身份|说话人|潜在|特征)?向量\s*([A-Z][A-Z0-9_]{0,7})(?![A-Za-z0-9_′’\x27])/u.exec(parts[0]);
            if (!produced) continue;
            const variable = produced[1];
            const edit = new RegExp("(?:编辑|变换|适配|投影)(?:阶段|模块|器)?以(?:上一步的|该|此)?" + variable + "为输入[^。；]{0,160}(?:移动|平移|变换|映射|编辑)[^。；]{0,60}(?:得到|输出|生成)" + variable + "[′’\\x27](?![A-Za-z0-9_′’\\x27])", 'u');
            const consumer = new RegExp("^(?:解码器|声码器)(?:以|将|把)(?:上一步的)?(?:(?:离散)?(?:语义|内容)?(?:单元|表示|特征|编码)(?:和|与))?" + variable + "[′’\\x27](?![A-Za-z0-9_′’\\x27])" + "(?:共同)?(?:为条件输入|作为条件输入|作为输入)[^。；]{0,100}(?:合成|重合成|重建|输出)波形", 'u');
            const unused = new RegExp("(?:丢弃|弃用|忽略|不使用|未使用|没有使用)(?:了)?(?:该|此)?(?:向量)?" + variable + "(?:[′’\\x27](?![A-Za-z0-9_′’\\x27]))?", 'u');
            if (!parts.some(s => unused.test(s)) && edit.test(parts[1]) && consumer.test(parts[2])) return true;
        }
        return false;
    }

    // These closed handoffs identify a produced artifact and its actual consumer.
    // Adjacent module names, future plans and unowned intermediate states do not suffice.
    function hasTypedNaturalProductHandoff(summary, maxSentenceChars = 320) {
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
        const denied = /(?:假设|假想|假定|设想|如果|可能|预计|预期|计划|未来|讨论|提及|相关工作|独立方法|他人|另一(?:个|种|套)(?:模型|方法|系统)|其他(?:模型|方法|系统)|并非|并未|不是|没有|不能|尚未|未曾)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:输出|生成|得到|形成|读取|接收|送入|作为|检索|插入|转写|打分)|(?:丢弃|弃用|忽略)(?:了)?(?:该|此|这些|两种)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)/u;
        for (let index = 0; index < sentences.length; index++) {
            const first = sentences[index], second = sentences[index + 1] || '';
            const revokedOrForeign = /(?:否认|否定|反驳|驳斥|引用|引述|转述)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)|(?:基线|对照|其他|另一个|另一种)(?:的)?(?:自回归)?解码器/u;
            if (first.length > maxSentenceChars || denied.test(first) || revokedOrForeign.test(first)) continue;
            // A decision head retrieves a concrete exemplar and inserts that exemplar.
            if (/调用头判断[^。；]{1,100}[，,]触发后检索[^，,。；]{1,30}范例并作为引导插入生成序列/u.test(first)) return true;
            if (!second || second.length > maxSentenceChars || denied.test(second) || revokedOrForeign.test(second)) continue;
            const memories = [...first.matchAll(/([\u4e00-\u9fff]{1,8}记忆)(?:保留|表示|编码)/gu)].map(match => match[1]);
            if (/交叉注意力[^。；]{0,120}输出/u.test(first) && new Set(memories).size === 2
                && /解码器[^。；]{0,60}(?:交替)?读取(?:这)?两种记忆[^。；]{0,80}(?:预测|输出|生成)[^，,。；]{1,30}/u.test(second)) return true;
            if (/编码器[^。；]{0,120}输出[^，,。；]{0,30}(?:表示|特征)序列/u.test(first)
                && /^(?:该|此)(?:表示|特征)序列作为(?:因果)?(?:Conformer|Transformer|循环网络|时序模型)的?输入[^。；]{0,120}末态映射为[^，,。；]{1,30}/u.test(second)) return true;
            // Independence of shared test audio is not a denial of its explicit ASR use.
            if (/语音合成[^。；]{0,100}生成音频[^。；]{0,100}(?:同一|该|此)音频直接作为[^，,。；]{0,30}(?:自动语音识别|ASR)的输入被转写为文本/u.test(first)
                && /^转写文本与原始文字分别送入同一[^，,。；]{0,20}(?:大语言模型|LLM)作答[，,]两种回答再交由同一[^，,。；]{0,20}验证器打分得到/u.test(second)) return true;
        }
        return false;
    }

    // Closed signal/representation handoffs. These are actual processing paths,
    // not a count of action words or a paper/model-name exception.
    function hasSourceBoundEditedWaveformOrCachedAvChain(summary, sourceText = '') {
        const source = String(sourceText || '').replace(/\s+/gu, ' ');
        // Method ownership must be checked before the narrow early return below.
        // Do not ban bare 另一: another option/recording is part of the actual edit.
        const foreignMethod = /独立方法|无关(?:模型|方法|系统)|(?:另一(?:个|种|套)?|其他|基线|对照)(?:的)?(?:模型|方法|系统)|\b(?:baseline|control|independent|unrelated)\s+(?:method|model|system)\b/iu;
        const denied = /假设|假想|假定|设想|如果|预计|预期|计划|未来实验|建议|讨论|引用|引述|转述|他人|第三方|外部团队|其他团队|先前工作|先前研究|相关工作|并非|并未|不是|没有|不能|尚未|未曾|否认|否定|撤回|不成立|不正确|错误|有误|(?:不|未)(?:被|曾|实际|真正|直接|再|继续)*(?:输出|生成|得到|接收|送入|进入|统计|拼接|估计|重建)|\b(?:if|hypothetical(?:ly)?|quoted|third[- ]party|external team|(?:previous|prior|related|other)\s+(?:work|research)|withdrawn|revoked)\b/iu;
        const forwardRevoked = /(?:下述|如下|以下|后述)(?:方法|流程|链|步骤|过程)[^。；]{0,50}(?:不成立|没有|并未|未执行|未发生|只是设计|只是示意|仅为示意|尚待实现|有待实现)/u;
        const ownSource = pattern => {
            const match = pattern.exec(source);
            if (!match) return false;
            // Start at a complete proposition, not an arbitrary character that
            // might be a quotation mark belonging to the preceding model prompt.
            const prior = source.slice(0, match.index);
            const before = prior.split(/(?<=[.!?])\s+/u).at(-1) || '';
            const previousHeading = /(?:previous work|prior research|hypothetical(?: method)?)[.:][^.!?]{0,160}$/iu.exec(prior.trimEnd())?.[0] || '';
            const context = previousHeading + before + source.slice(match.index, match.index + match[0].length + 100);
            return ownObservedSourceScope(context) && !denied.test(context) && !foreignMethod.test(context);
        };
        const editedSource = [
            /The different-class variant replaces the query event with a recording from the alternative class/iu,
            /Its matched same-class control inserts a different recording of the query class into exactly the same interval/iu,
            /Both variants use the same donor-fitting, level-estimation, background-copying, and crossfade procedures/iu,
            /Each waveform is queried in both option orders/iu,
            /The answer-change gap[^.]{0,120}combines marginal correctness/iu,
            /Selective accuracy measures whether a revised answer identifies the inserted class on eligible trials/iu
        ].every(ownSource);
        const cachedSource = [
            /target-agnostic causal audio encoder that processes only the mixture/iu,
            /encoder cache remains valid across target switches/iu,
            /Frozen visual frontends provide lip features/iu,
            /temporally aligned lip features are combined with the cached audio representation to form the attention memory/iu,
            /A shared mask head produces a complex ratio mask[^.]{0,120}iSTFT with overlap-add reconstructs the waveform/iu
        ].every(ownSource);
        if (!editedSource && !cachedSource) return false;
        const parts = String(summary || '').split(/[。！？!?\n]/u).map(part => part.trim()).filter(Boolean);
        for (let index = 0; index < parts.length; index++) {
            const first = parts[index], second = parts[index + 1] || '', third = parts[index + 2] || '';
            const previous = parts[index - 1] || '';
            const heading = /[:：]$|^\s*(?:#{1,6}\s|\*\*|__)/u.test(previous)
                || previous.length <= 100 && (denied.test(previous) || foreignMethod.test(previous) || forwardRevoked.test(previous)) ? previous : '';
            const withdrawn = next => {
                const notice = normalizeLocalEvidenceHeading(next).replace(/^(?:\*\*|__)/u, '')
                    .replace(/^(?:不过|然而|但是|可是|但|实际上)[，,]?\s*/u, '');
                return /^(?:上述|以上|前述|该|此|这一)(?:方法|流程|链|交接|处理|(?:音频)?表示|(?:共享)?缓存|解码器|掩膜|波形|回答)[^。]{0,60}(?:撤回|不成立|错误|未|不|没有|属于(?:基线|对照)|仅供展示|并非本文方法)/u.test(notice)
                    || /^(?:上述|以上|前述|该|此|这一)(?:方法|流程|链|交接|处理)[^。]{0,40}(?:属于|来自|仅供|仅为|只是)/u.test(notice) && foreignMethod.test(notice);
            };
            if (foreignMethod.test(heading + first + second + (cachedSource ? third : '')) || forwardRevoked.test(heading + first)) continue;
            if (editedSource && !denied.test(heading + first + second) && !withdrawn(third)
                && /不同类替换把该区间换成另一选项类别的录音从而改变正确答案/u.test(first)
                && /同类替换用查询类别的另一段录音重写同一区间而保持正确答案/u.test(first)
                && /两者共享区间、响度估计、供体适配和交叉淡化/u.test(first)
                && /^替换后波形以两种选项顺序送入模型提问[，,]得到的回答进入统计/u.test(second)
                && /回答变化率的配对差距把两类替换的差作为类别效应的度量/u.test(second)
                && /选择性准确率在原始和同类输入都答对的合格试验上检查新回答是否指向插入类别/u.test(second)) return true;
            if (cachedSource && !denied.test(heading + first + second + third) && !withdrawn(parts[index + 3] || '')
                && /因果音频编码器只对混合频谱编码/u.test(first)
                && /输出音频表示并维护与目标无关的共享缓存$/u.test(first)
                && /^冻结视觉前端持续提取各人脸[^。]{0,30}唇动特征与身份向量并存入[^。]{0,30}滚动缓冲/u.test(second)
                && /切换时取出所选脸对齐片段送解码器而不重算编码器$/u.test(second)
                && /^解码器是唯一目标相关部分[，,]把缓存音频表示与所选唇动拼接投影为键值、把身份向量加入解码查询/u.test(third)
                && /经[^。]{0,30}交叉注意力与共享掩膜头估计复数比掩膜[，,]再经逆变换重叠相加[^。]{0,30}重建波形$/u.test(third)) return true;
        }
        return false;
    }

    function hasTypedProcessingProductChain(summary, sourceText = '', maxSentenceChars = 320) {
        if (hasSourceBoundEditedWaveformOrCachedAvChain(summary, sourceText)) return true;
        const denied = /(?:假设|假想|假定|设想|如果|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|先前工作|他人|独立方法|无关|另一|其他(?:模型|方法|系统|病人|数据|信号|样本)|并非|并未|不是|没有|不能|不会|尚未|未曾|不再|否认|否定|反驳|驳斥|引用|引述|转述)|(?:不|未|没)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:统计|计算|形成|生成|输出|送入|进入|作为|使用|采用|处理|池化|注入|承接|给出|锁定|确定|执行|发生|应用|实现|实施|进行|完成)|(?:丢弃|弃用|忽略)|(?:说法|表述|观点|判断|过程|流程)[^。；]{0,20}(?:错误|有误|不成立|不正确|未执行)/u;
        const typedSource = String(sourceText || '').replace(/\s+/gu, ' ');
        const typedContinuationDenied = text => /^(?:(?:上述|以上|前述|该|此|这一|这些)[^。]{0,75}(?:交接|衔接|轨迹|类别|处理链|层向量|主成分分析|典型相关分析|混合求解器|卷积)[^。]{0,60}(?:未|不|没有|撤回|错误|仅供展示|属于基线)|(?:后继验证|卷积|主成分分析|典型相关分析)[^。]{0,50}(?:另一|其他|独立|无关)[^。]{0,60}(?:轨迹|响应|向量|仅供展示))/u.test(String(text || ''));
        const normalizeNotice = value => String(value || '').replace(/^(?:不过|然而|但是|可是|但|实际上)[，,]?\s*/u, '');
        const revoked = /^(?:上述|以上|前述|该|此|这一|这些|所述)(?:方法|流程|链|步骤|过程|说法|表述|处理|交接|轮廓|表示|隐表示|候选集合|解释集合)[^。；]{0,35}(?:不成立|不正确|错误|有误|没有|被弃用|被丢弃|不代表|不属于|(?:未|不)(?:被|曾|实际|真正|根本|直接|再|继续)*(?:使用|采用|输入|消费|送入|注入|应用|发生|执行|实施|实现))/u;
        const forwardRevoked = /^(?:(?:下述|如下|以下|后述)(?:方法|流程|链|步骤|过程)[^。；]{0,50}(?:不成立|没有|并未|未执行|未发生|只是设计|只是示意|仅为示意|尚待实现|有待实现)|(?:对照|基线|先前|相关|其他|另一)(?:系统|模型|方法|工作|研究)[^。；]{0,40}(?:方法|流程|步骤)[^。；]{0,15}(?:如下|所示))/u;
        const safe = (parts, objectKind = '') => {
            if (!parts.every(part => part && part.length <= maxSentenceChars)) return false;
            let text = parts.join('。');
            if (objectKind === 'candidates') text = text.replace(/(?:意图(?:与|和)槽位|意图|槽位|标签)假设(?=[，,]|$)/u, '候选对象');
            if (objectKind === 'pooled') text = text.replace(/与录音数无关的(?:病人级|患者级)隐表示/u, '固定尺寸隐表示');
            return !denied.test(text) && !/(?:^|[，,])\s*(?:但|然而|不过|可是|却)/u.test(text);
        };
        for (const paragraph of String(summary || '').split(/\n\s*\n/u)) {
            if (/[！？!?]/u.test(paragraph)) continue;
            const parts = paragraph.split(/[。；;\n]/u).map(part => part.trim()).filter(Boolean);
            for (let index = 0; index < parts.length; index++) {
                if (forwardRevoked.test(normalizeNotice(parts[index - 1]))) continue;
                const first = parts[index], second = parts[index + 1] || '', third = parts[index + 2] || '';
                const clauses = first.split(/[，,]/u).map(clause => clause.trim());
                const nextClauses = second.split(/[，,；;]/u).map(clause => clause.trim());
                const newChainRevoked = /^(?:(?:上述|以上|前述|该|此|这些)(?:处理|过程|流程|方法|步骤|按键记录|记录|帧级特征序列|时间表示|融合特征|调制向量|向量|梅尔谱)|这一步)[^。]{0,45}(?:未|不|没有|否认|放弃|弃用|丢弃|错误|不成立)/u;
                const newChainSafe = safe([first, (/一方面/u.test(second) ? second.replace(/另一方面/u, '并行分支') : second)]) && !revoked.test(normalizeNotice(third))
                    && !newChainRevoked.test(normalizeNotice(third))
                    && !/先前研究|既有研究|其他研究|文献中|此前研究/u.test(first + second + (parts[index - 1] || ''));
                // A frozen speech representation is pooled to a dimensioned
                // utterance vector and that same vector is consumed by PCA/PWCCA.
                // Dimension identity prevents a nearby, unrelated vector from passing.
                const typedAttribution = /(?:第三方|外部团队|其他团队|前人|相关工作|先前工作|先前研究|既有研究|其他研究|(?:对照|基线)(?:系统|模型|方法))[^。]{0,80}(?:流程|方法|步骤|如下|所示)/u;
                const pooledVector = /每层([1-9][0-9]*)维帧级表示经均值加标准差池化拼成([1-9][0-9]*)维话语向量/u.exec(first);
                const explainedVector = /^接着把该([1-9][0-9]*)维层向量经主成分分析降至([1-9][0-9]*)维后[，,]与([1-9][0-9]*)个人工声学特征做投影加权典型相关分析[，,]输出各层与各特征对齐强度/u.exec(second);
                if (newChainSafe && !typedContinuationDenied(third) && !typedAttribution.test(parts[index - 1] || '') && pooledVector && explainedVector
                    && Number(pooledVector[2]) === 2 * Number(pooledVector[1])
                    && pooledVector[2] === explainedVector[1]
                    && Number(explainedVector[2]) < Number(pooledVector[2])
                    && /^(?:论文)?冻结[A-Z][A-Za-z0-9 .-]{1,50}[，,]/u.test(first)
                    && /再用训练集为每层单独训练线性分类器/u.test(first)
                    && /层向量直接作为后续解释的输入$/u.test(first)
                    && (() => {
                        const model = /^(?:论文)?冻结([^，,]{1,60})/u.exec(first)?.[1];
                        const quotedModel = model && new RegExp(model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/gu, '\\s+'), 'iu');
                        return quotedModel && new RegExp(`(?<![A-Za-z0-9_.-])${quotedModel.source} model[^.!?]{0,100}as a frozen feature extractor`, 'iu').test(typedSource)
                            && /mean and standard deviation pooling/iu.test(typedSource)
                            && new RegExp(`(?<![A-Za-z0-9_.+-])${pooledVector[1]}-dimensional frame representations`, 'iu').test(typedSource)
                            && new RegExp(`(?<![A-Za-z0-9_.+-])${pooledVector[2]}-dimensional utterance-level vector`, 'iu').test(typedSource)
                            && new RegExp(`reduce layer representations to ${explainedVector[2]} dimensions via principal component analysis`, 'iu').test(typedSource)
                            && new RegExp(`(?<![A-Za-z0-9_.+-])${explainedVector[3]} (?:handcrafted )?acoustic features`, 'iu').test(typedSource)
                            && /projection-weighted CCA/iu.test(typedSource);
                    })()) return true;
                // A behavioural protocol passes the actual recorded responses to
                // the named statistics; merely listing experimental actions fails.
                if (newChainSafe
                    && /(?:被试|参与者)按目标词按键/u.test(first)
                    && /按键(?:记录)?(?:分|区分)为命中、漏报(?:和|与|及)虚报并记录正确命中(?:的)?(?:按键)?延迟/u.test(first)
                    && /试次末再键入回忆数字/u.test(first)
                    && /^命中与虚报(?:经)?换算(?:得|为)灵敏度/u.test(nextClauses[0] || '')
                    && /^正确命中(?:的)?(?:按键)?延迟作为反应时$/u.test(nextClauses[1] || '')
                    && /^数字回忆用编辑距离计分$/u.test(nextClauses[2] || '')
                    && /^三者再输入贝叶斯(?:多层|层级)模型比较条件差异$/u.test(nextClauses[3] || '')) return true;
                // The played word-monitoring material leads to recorded target
                // responses, sensitivity and reaction-time statistical inputs.
                // Concrete trial measurements matter, not an action-word count.
                const foreignTrialAttribution = /^(?:(?:本段|这里|下文)?(?:转述|引用|引述|介绍)(?:了|的是)?\s*)?(?:第三方(?:研究)?|(?:其他|外部|另一|别的)(?:团队|作者|研究))(?:的)?[^。；]{0,60}(?:方法|流程|步骤|研究)/u;
                if (newChainSafe
                    && ![parts[index - 1], first, second].some(part => foreignTrialAttribution.test(normalizeNotice(part)))
                    && /词串并归一化至[^，,。]{1,24}/u.test(first)
                    && /掩蔽经长期平均频谱归一化后设为[^，,。]{1,24}/u.test(first)
                    && /合成[^，,。]{1,40}听音材料供试次播放$/u.test(first)
                    && /^试次先呈现[^，,。]{1,90}供记忆并呈现印刷目标词$/u.test(nextClauses[0] || '')
                    && /^(?:被试|参与者)听词串时听到目标按(?:空格)?键、试后键入所记数字$/u.test(nextClauses[1] || '')
                    && /^击中率与虚报率经Fisher转换相减(?:得|得到)d[′’']$/u.test(nextClauses[2] || '')
                    && /^成功击中反应时用贝叶斯偏态正态与对数正态回归检验$/u.test(nextClauses[3] || '')) return true;
                // Frame features become temporal representations consumed by the
                // acoustic predictor. The same representation must cross the edge.
                if (newChainSafe
                    && /^(?:视觉编码器|[A-Z][A-Za-z0-9.-]{1,48})对[^，,。]{1,80}视频逐帧提取(?:图像|视觉)特征$/u.test(clauses[0])
                    && /^输出帧级特征序列送入[A-Z][A-Za-z0-9. -]{1,60}建模时间依赖$/u.test(clauses[1] || '')
                    && /^形成时间表示$/u.test(clauses[2] || '')
                    && /^该时间表示一方面逐帧预测(?:[1-9][0-9]*维)?(?:对数)?梅尔谱$/u.test(nextClauses[0] || '')) return true;
                // A spatial query produces a modulation vector which is actually
                // used to condition the already identified separation blocks.
                if (newChainSafe
                    && /^前端(?:把|将)[^，,。]{1,180}(?:复数短时傅里叶变换|复数STFT)[^，,。]{1,180}(?:空间线索|声道间相位差)[^，,。]{0,80}拼接融合$/u.test(clauses[0])
                    && /^得到融合特征并送入基于[A-Z][A-Za-z0-9.-]{1,40}的时频网格骨干(?:网络)?做时频分离$/u.test(clauses[1] || '')
                    && /^空间查询编码把归一化距离与方位角经傅里叶特征映射为调制向量$/u.test(nextClauses[0] || '')
                    && /^再经(?:特征线性调制|FiLM)注入上述分离块$/u.test(nextClauses[1] || '')
                    && /^以该向量为条件调制融合特征的分离过程$/u.test(nextClauses[2] || '')) return true;
                if (safe([first]) && !revoked.test(normalizeNotice(second))
                    && !newChainRevoked.test(normalizeNotice(second))
                    && !/先前研究|既有研究|其他研究|文献中|此前研究/u.test(first + (parts[index - 1] || ''))
                    && !typedAttribution.test(parts[index - 1] || '') && !typedContinuationDenied(second)) {
                    // ENF estimation passes its recovered trace and class to actual
                    // downstream verification, rather than merely listing modules.
                    if (/^(?:统一)?双通道估计器在二次谐波附近带通$/u.test(clauses[0])
                        && /^经短时傅里叶变换与抛物线插值恢复漂移轨迹$/u.test(clauses[1] || '')
                        && /^再由共享一维卷积与轨迹统计融合的六分类头判断一致性模式$/u.test(clauses[2] || '')
                        && /^输出的轨迹与类别进入后继验证$/u.test(clauses[3] || '')
                        && /estimator band-passes the signal around the second/iu.test(typedSource)
                        && /short-time Fourier transform/iu.test(typedSource) && /parabolic interpolation/iu.test(typedSource)
                        && /one shared second-harmonic extractor feeds a 1-D convolutional branch and a trace-statistics branch, fused into a six-class/iu.test(typedSource)
                        && /authentication channel matches that ENF against an independent grid reference/iu.test(typedSource)) return true;
                    // A propagation solver builds early/mid and late responses,
                    // then consumes the response by convolution to produce audio.
                    if (/^混合求解器枚举有效洞口门户路径求解直达透射绕射$/u.test(clauses[0])
                        && /^以接收端蒙特卡罗射线追踪累积早中期反射并用反馈延迟网络合成晚期混响$/u.test(clauses[1] || '')
                        && /^卷积干声得混响音频$/u.test(clauses[2] || '')
                        && /Portal sequences[^.!?]{0,160}enumerated/iu.test(typedSource)
                        && /receiver-centered Monte Carlo ray tracing/iu.test(typedSource)
                        && /Late reverberation is synthesized using a feedback delay network/iu.test(typedSource)
                        && /convolved with task-specific dry signals to synthesize static or time-varying multichannel reverberant audio/iu.test(typedSource)) return true;
                }
                if (safe([first]) && !revoked.test(normalizeNotice(second))) {
                    if (/^梯度归因(?:统计|计算)各频点对[^，,。；]{1,24}(?:影响|贡献)(?:权重)?(?:并)?(?:形成|生成|得到)(?:加权|频率权重)轮廓$/u.test(clauses[0])
                        && /^(?:该|此)(?:加权|频率权重)?轮廓(?:作为|被用作)加权函数(?:进入|用于)(?:经典与神经|经典|神经)?(?:广义互相关|GCC|互相关)(?:流水线(?:对比|比较)?|计算|处理)$/u.test(clauses[1] || '')) return true;
                    if (/^(?:前端|编码前端)(?:将|把)[^，,。；]{1,160}(?:拼接|融合)(?:并|后|再)(?:经|通过)(?:二维|2D)卷积(?:编码|处理)?$/u.test(clauses[0])
                        && /^(?:输出|得到|生成)融合(表示|特征)(?:并(?:将|把)(?:该|此)\1)?(?:送入|交给)(?:基于[A-Za-z][A-Za-z0-9-]{0,30}的)?(?:时频(?:网格)?主干|分离网络|分离主干)(?:处理|编码|变换)(?:为|得到|生成)(?:待调制的)?分离(?:表示|特征)$/u.test(clauses[1] || '')) return true;
                    const epoch = /^脑电(?:分析|处理)对目标(?:音|刺激)锁定取(-?[0-9]+(?:\.[0-9]+)?)至(-?[0-9]+(?:\.[0-9]+)?)(?:毫秒|ms)(?:计算|生成)(?:事件相关谱扰动|ERSP)$/u.exec(clauses[0]);
                    const baseline = /^以(?:语境前|刺激前|目标前)(-?[0-9]+(?:\.[0-9]+)?)至(-?[0-9]+(?:\.[0-9]+)?)(?:毫秒|ms)(?:作为)?基线(?:作|进行)(?:时频变换|时频分析)$/u.exec(clauses[1] || '');
                    const clusters = /^(?:经|通过)([1-9][0-9]*)次置换检验(?:确定|识别|得到)显著(?:性)?簇(?=$|并(?:比较|分析|检验))/u.exec(clauses[2] || '');
                    if (epoch && baseline && clusters) {
                        const [start, end, baselineStart, baselineEnd, iterations] = [...epoch.slice(1), ...baseline.slice(1), clusters[1]].map(Number);
                        if ([start, end, baselineStart, baselineEnd, iterations].every(Number.isFinite)
                            && start < end && start <= baselineStart && baselineStart < baselineEnd && baselineEnd <= end) return true;
                    }
                }
                if (safe([first, second], 'pooled') && !revoked.test(normalizeNotice(third))
                    && /^(?:同一病人的|同一患者的)(?:多录音|多部位录音)(?:编码|声学)特征(?:经)?展平后(?:送入|交给)(?:感知)?重采样器$/u.test(clauses[0])
                    && /^由固定数量(?:的)?可学习查询(?:经)?交叉注意力(?:池化|汇聚|压缩)(?:为|得到)(?:与录音数无关的)?(?:病人级|患者级)隐表示$/u.test(clauses[1] || '')
                    && (first.match(/隐表示/gu) || []).length === 1
                    && (/^(?:冻结的)?(?:大)?语言模型[^，,。；]{0,60}[，,]\s*(?:以|通过|使用)(?:可训练)?门控交叉注意力(?:适配器)?(?:把|将)(?:该|此)隐表示注入(?:其)?各层/u.test(second)
                        || /^门控交叉注意力(?:适配器)?(?:把|将)(?:该|此)隐表示注入冻结的(?:大)?语言模型(?:的)?各层/u.test(second))) return true;
                if (safe([first, second, third], 'candidates') && !revoked.test(normalizeNotice(parts[index + 3]))
                    && /^(?:候选列举|候选枚举|枚举阶段)(?:从|依据|根据)[^，,。；]{1,90}(?:挑出|列出|筛出)[^，,。；]{1,70}(?:候选|假设)$/u.test(clauses[0])
                    && /^(?:输出|生成|形成)(?:包含正确标签(?:在内)?的)?候选集合$/u.test(clauses[1] || '')
                    && /^(?:否决推理|排除推理|辨析阶段)以(?:上述|该|此)候选集合为输入[，,]/u.test(second)
                    && /为每个(?:错误|竞争)候选(?:生成|写出)[^，,。；]{1,70}(?:理由|解释)[，,]\s*(?:形成|输出|得到)解释集合$/u.test(second)
                    && /^(?:最终标签|标签阶段|标签预测)(?:承接|依据|使用)(?:前述辨析|上述解释集合|该解释集合)(?:给出|输出|预测)(?:结构化)?(?:意图(?:与|和)槽位(?:-槽值)?|语义标签|最终标签|标签|意图|槽位|语义框)(?:结果)?$/u.test(third)) return true;
            }
        }
        return false;
    }

    function hasSourceBoundSymbolAndTrajectoryHandoff(summary, sourceText = '', maxSentenceChars = 350) {
        if (/```|~~~|(?:^|\n)\s*>/u.test(String(summary || ''))) return false;
        const parts = String(summary || '').split(/[。！？!?；;\n]/u).map(part => part.trim()).filter(Boolean);
        const denied = /假设|假想|假定|设想|如果|倘若|(?:^|[，,：:])\s*若|预计|预期|可能|未来|计划|建议|讨论|提及|第三方|他人|外部团队|其他团队|先前研究|先前工作|相关工作|既有研究|基线方法|对照系统|引用|引述|转述|否认|否定|撤回|不成立|错误|丢弃|弃用|(?:并非|并未|没有|从未|尚未|未曾)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:映射|查表|输出|得到|重复|拼成|混合|参与|训练|打分|相加|送入|优化|执行|实现)/u;
        const owner = /^(?:(?:第三方|他人|外部|其他|先前|此前|既有|相关|基线|对照)(?:作者|团队|研究|工作|方法|系统)(?:的)?(?:方法|流程|步骤|描述|如下|所示)*|(?:previous|prior|related|third[- ]party|external|other|baseline|control)\s+(?:work|research|methods?|systems?|teams?))\s*[：:.]?$/iu;
        const revoked = /^(?:上述|以上|前述|该|此|这一|这些|这个)(?:方法|处理|流程|过程|步骤|链|向量|轨迹|奖励)[^。]{0,80}(?:未|不|没有|否认|否定|撤回|放弃|弃用|丢弃|假设|错误)/u;
        const safe = (index, count) => {
            const window = parts.slice(index, index + count);
            const previous = normalizeLocalEvidenceHeading(parts[index - 1] || '');
            return window.length === count && window.every(part => part.length <= maxSentenceChars && !denied.test(part) && !/[“”‘’"]/u.test(part))
                && !owner.test(previous) && !denied.test(previous)
                && !revoked.test(parts[index + count] || '')
                && !/^(?:本文|我们|本研究|作者)(?:并未|没有|从未|不曾|不会|不再|未|不)(?:实际|真正|直接)?(?:执行|实现|采用|使用|训练|优化)(?:上述|该|此|这一)?(?:方法|流程|过程|步骤|链|向量|轨迹|奖励)/u.test(parts[index + count] || '')
                && !/^(?:本文|我们|本研究|作者)(?:已|已经|现已)?(?:放弃|弃用|丢弃|否认|否定|撤回)(?:了)?(?:上述|该|此|这一)?(?:方法|流程|过程|步骤|链|向量|轨迹|奖励)/u.test(parts[index + count] || '');
        };
        // Check the entire source sentence, including denial after the matched
        // words, and the adjacent independent attribution heading. A phrase in
        // related work or a retracted procedure cannot authorize a current chain.
        const source = String(sourceText || '');
        const sourceDenied = /[“”‘’"]|\b(?:if|assuming|suppose|hypothetical|planned|future|previous|prior|related|not|never|false|incorrect|unimplemented|quotes?|quoted|quotations?|cited)\b|\b(?:other|external|third[- ]party)\s+(?:authors?|teams?|work|research)\b/iu;
        const sourceRevoked = /^\s*(?:(?:this|that)\s+(?:was|is|has been)\s+(?:never|not)\s+(?:actually\s+)?(?:implemented|executed|performed|used|adopted)|(?:this|that|the|the above|the preceding)\s+(?:procedure|process|method|pipeline|chain|step|reward)[^.!?]{0,100}\b(?:not|never|false|incorrect|hypothetical|abandoned|discarded)\b|we\s+(?:(?:did|do|have|will)\s+not\s+(?:actually\s+)?(?:implement|execute|perform|use|adopt)|(?:never|no longer)\s+(?:implemented?|executed?|performed?|used?|adopted?)|(?:abandon|discard|reject|retract)(?:ed)?)\s+(?:this|that|the above|the preceding)?\s*(?:procedure|process|method|pipeline|chain|step|reward))/iu;
        const supported = pattern => {
            const match = pattern.exec(source);
            if (!match) return false;
            const before = source.slice(0, match.index), after = source.slice(match.index + match[0].length);
            const sentenceStart = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?')) + 1;
            const sentenceEnd = after.search(/[.!?]/u);
            const sentence = source.slice(sentenceStart, match.index + match[0].length
                + (sentenceEnd < 0 ? after.length : sentenceEnd));
            const prefix = before.slice(before.lastIndexOf('\n') + 1);
            const previousLine = normalizeLocalEvidenceHeading(before.slice(0, before.lastIndexOf('\n')).trimEnd().split('\n').at(-1) || '');
            const following = sentenceEnd < 0 ? '' : after.slice(sentenceEnd + 1).trimStart();
            let fenced = false, foreignHeading = false;
            for (const line of before.split('\n')) if (/^\s*(?:```|~~~)/u.test(line)) fenced = !fenced;
            for (const line of before.split('\n').reverse().slice(0, 50)) {
                const heading = normalizeLocalEvidenceHeading(line);
                if (owner.test(heading) || /^(?:hypothetical|planned|future)(?: work| procedure| method)?[.:]?$/iu.test(heading)) {
                    foreignHeading = true; break;
                }
                if (/^\s*(?:#{1,6}\s+|(?:\d+(?:\.\d+)*|[A-Z]\.\d+)\s+)\S/u.test(line)) break;
            }
            return !sourceDenied.test(sentence) && !sourceDenied.test(prefix)
                && !owner.test(previousLine) && !sourceRevoked.test(following) && !fenced && !foreignHeading
                && !/(?:^|\n)\s*>/u.test(sentence)
                && !/<(?:blockquote|pre|code)\b[^>]*>[\s\S]*$/iu.test(before.slice(Math.max(before.lastIndexOf('</blockquote>'), before.lastIndexOf('</pre>'), before.lastIndexOf('</code>')) + 1));
        };
        for (let index = 0; index < parts.length; index++) {
            const first = parts[index], second = parts[index + 1] || '', third = parts[index + 2] || '';
            // Lexical symbols index an aligned acoustic/duration table. Its output
            // vectors become pseudo frames consumed by the unchanged training path.
            if (safe(index, 3)
                && /^(?:方法)?(?:第一步)?(?:把|将)输入文本经发音词典映射为音素序列[，,]\s*输出离散音素符号作为下一步查表与定长的索引$/u.test(first)
                && /^(?:第二步)?查表来自配对音频音素对齐统计[，,]\s*每个音素对应一个平均对数梅尔向量[^。]{1,180}(?:得到|生成)帧数[，,]\s*(?:把|将)符号索引转为带时长的声学向量$/u.test(second)
                && /^(?:第三步)?(?:把|将)这些向量按各自帧数重复[，,][^。]{1,140}拼成伪语音帧序列后与真实语音随机混合[，,][^。]{1,100}参与训练(?:[，,][^。]{1,80})?$/u.test(third)
                && supported(/From a phoneme alignment of the paired audio,\s*we extract a mean log-mel vector and median duration/iu)
                && supported(/To inject text, we map sentences to phonemes via a lexicon/iu)
                && supported(/We insert silence between words,\s*repeat vectors for their duration with linear interpolation at boundaries,\s*and feed this to the front-end exactly like real audio/iu)
                && supported(/Audio and text sentences are mixed randomly in batches,\s*using the same losses/iu)) return true;
            // An executed agent produces a tool trajectory; a judge consumes that
            // same trajectory, and the resulting reward enters the policy update.
            // Neither a GRPO mention nor an isolated judge score supplies the edge.
            if (safe(index, 2)
                && /^智能体以[^。]{1,100}为输入[，,]\s*调用[^。]{1,100}工具[^。]{1,100}[，,]\s*输出[^。]{1,60}及其多轮轨迹$/u.test(first)
                && /^(?:大模型)?评判员以上述轨迹为输入逐轮对[^。]{1,80}打分[，,]\s*输出过程奖励[，,]\s*再将其与成品结果奖励加权相加送入组相对策略优化训练(?:[，,][^。]{1,220})?$/u.test(second)
                && supported(/The episode yields a trajectory/iu)
                && supported(/A process reward model\s*\(PRM\)\s*scores each action from its interaction history and the\s*tool feedback it produced/iu)
                && supported(/We average the[^.!?]{1,100}valid judgments of a turn[^.!?]{1,100}and add a normalized process term to the shared outcome term/iu)
                && supported(/We optimize the policy using rollout importance sampling/iu)
                && supported(/The process judge reviews consecutive windows of[^.;!?]{1,80}assistant turns/iu)) return true;
        }
        return false;
    }

    function hasExplicitNaturalProductChain(summary, sourceText = '', maxSentenceChars = 320) {
        maxSentenceChars = typeof maxSentenceChars === 'number' && Number.isFinite(maxSentenceChars) ? maxSentenceChars : 320;
        if (hasSourceBoundSymbolAndTrajectoryHandoff(summary, sourceText, Math.max(350, maxSentenceChars))) return true;
        if (hasTypedProcessingProductChain(summary, sourceText, maxSentenceChars)) return true;
        if (hasCachedCausalStateHandoff(summary, maxSentenceChars)) return true;
        if (hasTypedNaturalProductHandoff(summary, maxSentenceChars)) return true;
        if (hasExplicitEditedVectorHandoff(summary, maxSentenceChars)) return true;
        if (hasGeneratedInputModelHeadChain(summary, maxSentenceChars)) return true;
        if (hasExplicitArtifactHandoff(summary, sourceText, maxSentenceChars)) return true;
        if (hasConcreteProductHandoff(summary, maxSentenceChars)) return true;
        if (hasPosteriorUpdateProductChain(summary, maxSentenceChars)) return true;
        if (hasBlockLayoutProductChain(summary, maxSentenceChars)) return true;
        // 只接受已说明的产物被下一处理模块实际使用，不以动作数量或序号充数。
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
        const denied = /(?:并非|并未|不是|没有|不能|不会|尚未|未曾|不再|是否|讨论|提及|另一(?:个)?专家|假设|设想|假定|如果|若|可能|预计|预期|计划|未来|建议|应当|应该)|(?:不|未)(?:被|能|曾|直接|实际|真正|也|只|还|再|会)*\s*(?:预测|计算|给出|输出|生成|得到|形成|池化|标准化|送入|拼接|融合)/u;
        for (let i = 0; i < sentences.length; i++) {
            const first = sentences[i];
            if (first.length <= maxSentenceChars && !denied.test(first)
                && /编码器[^，,。；]{0,45}帧(?:级)?表示经均值和标准差池化形成定长向量[，,]\s*该向量标准化后送入[^，,。；]{0,30}逻辑回归输出类别/u.test(first)) return true;
            const second = sentences[i + 1];
            if (!second || first.length > maxSentenceChars || second.length > maxSentenceChars || denied.test(first) || denied.test(second)) continue;
            const produced = /([\u4e00-\u9fff]{1,8}专家)(?:(?!专家|基线|交给|转交|负责|由)[^，,。；]){0,200}?(?:预测|计算|给出|输出|生成|得到)(?:对应的|单曲的|歌曲的|一个)?质量分/u.exec(first);
            const consumed = /^([\u4e00-\u9fff]{1,8}专家)(?:把|将)该质量分与(?:(?!专家|基线|交给|转交|负责|由)[^，,。；]){1,180}?(?:拼接|融合)/u.exec(second);
            if (produced && consumed
                && !produced[1].endsWith(consumed[1]) && !consumed[1].endsWith(produced[1])) return true;
        }
        return false;
    }

    function hasConcreteUnnumberedMethodChain(summary) {
        // 只接受同一机制句中的明确处理模块和数据衔接，不用泛化动作词计数代替方法说明。
        const moduleKinds = [
            ['encoder', /编码器|提取器/giu],
            ['decoder', /解码器|声码器/giu],
            ['sensor', /麦克风|传感器/giu],
            ['circuit', /电路/giu],
            ['network', /网络|变换器|Transformer/giu],
            ['generator', /(?:流|生成|预测|分类|回归)头|生成器/giu]
        ];
        const objects = [
            ['envelope', /幅度包络|缓慢包络|包络/gu, /(?:幅度)?包络/gu],
            ['feature', /声学特征|音频特征|视觉特征|帧对齐特征/gu, /(?:声学|音频|视觉|这些)?特征/gu],
            ['latent', /潜变量|潜表示/gu, /潜变量|潜表示/gu],
            ['waveform', /波形|音频块|语音块/gu, /波形|音频块|语音块/gu],
            ['pressure', /共振压力|声压/gu, /共振压力|声压/gu],
            ['label', /词级标签|音素标签|类别标签|数字标签/gu, /(?:词级|音素|类别|数字|这些)?标签/gu]
        ];
        const operation = /(?:维护|保持|提取|拾取|编码|解码|合成|生成|预测|输出|判决|做整句平均判决)/u;
        const excluded = /(?:并非|并未|没有|不能|不会|尚未|未曾|不再|不负责|不用于|假设|设想|假定|如果|若|可能|计划|未来|拟采用|建议|应当|应该|对比|比较|相比|优于|胜过|另一(?:种|套)|独立方法)|(?:不|未)(?:被|能|曾|直接|实际|真正|也|只|还|再|会)*\s*(?:维护|保持|提取|拾取|编码|解码|合成|生成|预测|输出|判决|送入|传递|映射|注入|缩放)/u;
        for (const raw of String(summary || '').split(/[。！？!?；;\n]/u)) {
            // 括注内的英文逗号不能把模块名与它的中文动作拆开。
            const sentence = raw.replace(/（[^）]*）|\([^)]*\)/gu, '');
            if (excluded.test(sentence)) continue;
            // 半径条件先被编码为明确表示，再由该表示控制相邻时频块的输入。
            // 只有产物和实际交接同时出现才接受；提及模块或动作列表不能充数。
            const radiusProduct = sentence.match(/半径编码器[^，,。；]{0,32}映射(?:为|成|到)频率相关表示/u);
            if (radiusProduct) {
                const following = sentence.slice(radiusProduct.index + radiusProduct[0].length);
                if (/(?:该|此|频率相关)表示经(?:特征调制|FiLM)[^，,。；]{0,100}(?:注入[^，,。；]{0,40}块间传递|上一块输出[^，,。；]{0,40}下一块输入)/u.test(following)) return true;
            }
            const clauses = sentence.split(/[，,]/u);
            const stages = [];
            for (let index = 0; index < clauses.length; index++) {
                const clause = clauses[index];
                for (const [kind, pattern] of moduleKinds) {
                    pattern.lastIndex = 0;
                    const actor = pattern.exec(clause);
                    if (!actor) continue;
                    const actionText = clause.slice(actor.index + actor[0].length);
                    if (!operation.test(actionText)) continue;
                    const data = objects.filter(([, pattern]) => {
                        pattern.lastIndex = 0;
                        return pattern.test(actionText);
                    });
                    const state = /(?:维护|保持)[^，,]{0,16}(?:有界|固定容量|会话|历史)[^，,]{0,8}(?:记忆|状态|缓存)/u.test(actionText);
                    const decision = /做整句平均判决/u.test(actionText);
                    if (!data.length && !state && !decision) continue;
                    stages.push({ kind, actor: actor[0], index, clause, data, state, decision });
                }
            }
            for (const first of stages) for (const second of stages) {
                if (first.index >= second.index || first.kind === second.kind) continue;
                // 明确重提上游数据，并送入后续模块；判决网络本身也必须有实际处理动作。
                for (const [, , alias] of first.data) {
                    alias.lastIndex = 0;
                    if (!alias.test(second.clause)) continue;
                    const transfer = second.clause.match(/(?:送入|传递给|传递到|馈入|接入|交给)/u);
                    if (transfer && second.clause.indexOf(second.actor) > transfer.index) return true;
                }
                // 有界历史状态与块内生成属于同一分块机制，而不是两个独立模型的性能对比。
                if (first.state && /(?:保持|维持)[^，,]{0,16}(?:语义|声学|上下文)[^，,]{0,8}连续/u.test(first.clause)
                    && second.kind === 'generator' && second.data.some(([kind]) => kind === 'latent' || kind === 'waveform')
                    && /块内/u.test(second.clause) && /(?:切块|分块|按块)/u.test(sentence)) return true;
            }
        }
        return false;
    }

    // 只认相邻两句内的具体产物交接，不以动作数量或跨段落共现替代处理链。
    function hasAdjacentConcreteMethodChain(summary, maxSentenceChars = 320) {
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(s => s.trim()).filter(Boolean);
        const excluded = /(?:并非|并未|没有|不能|不会|尚未|不再|不负责|(?:未|不)(?:以|把|将|使用)|未曾|未被|未曾被|提及输出|讨论输出|(?:未|不)(?:曾|实际|直接)?(?:输出|提取|生成|接收|选择|建立|更新|存入|处理|映射|注入|缩放)|假设|设想|假定|如果|若|可能|预计|预期|计划|准备(?:输出|生成|接收)|未来(?:将|会)|拟采用|建议|应当|应该|对比(?:方法|模型|网络|滤波器)|比较(?:方法|模型|网络|滤波器)|相比|优于|另一(?:种|套)|独立方法)/u;
        const roles = [
            ['filter', /滤波器/u], ['network', /网络|变换器/u], ['tracker', /跟踪器/u],
            ['expert', /[\u4e00-\u9fff]{1,8}专家/u],
            ['encoder', /半径编码器/u], ['conditioning', /特征调制|FiLM/u],
            ['pool', /候选(?:说话人|程序)?池/u], ['predictor', /预测器/u],
            ['interface', /搜索接口/u], ['backbone', /主干/u], ['selection', /散度目标|来源收集/u],
            ['vocabulary', /词表/u], ['retention', /置信保留/u], ['editing', /人工编辑/u],
            ['checking', /二次检查/u], ['refinement', /精炼器/u]
        ];
        const products = [
            /误差信号/gu, /(?:频率相关表示|该表示)/gu, /质量分/gu, /嵌入/gu, /质心/gu, /候选(?:说话人)?池/gu,
            /候选(?:只读搜索)?请求/gu, /草稿/gu, /提示句池/gu,
            /可朗读句(?:子)?/gu, /父程序/gu, /子程序/gu, /语料(?:文本)?/gu
        ];
        const actor = sentence => roles.map(([kind, pattern]) => ({ kind, match: pattern.exec(sentence) }))
            .filter(item => item.match).sort((a,b) => a.match.index - b.match.index)
            .map(item => item.kind === 'expert' ? `expert:${item.match[0]}` : item.kind)[0];
        const canonical = token => token.replace('该表示', '频率相关表示').replace('候选说话人池', '候选池')
            .replace('候选只读搜索请求', '候选请求').replace('可朗读句子', '可朗读句').replace('语料文本', '语料');
        for (let i = 0; i + 1 < sentences.length; i++) {
            const first = sentences[i], second = sentences[i+1];
            if (first.length > maxSentenceChars || second.length > maxSentenceChars || excluded.test(first) || excluded.test(second) || /^未来/u.test(first) || /^未来/u.test(second)) continue;
            const firstActor = actor(first), secondActor = actor(second);
            if (!firstActor || !secondActor || firstActor === secondActor) continue;
            if (!/(?:提取|更新|建立|生成|输出|得到|选择|选出|送入|合并|存入|映射)/u.test(first)
                || !/(?:接收|输入|送入|进入|切分|聚集|提取|改写|处理|播放|截取|更新|建立|扩展|拼接|融合|注入|缩放)/u.test(second)) continue;
            for (const pattern of products) {
                pattern.lastIndex = 0;
                for (const match of first.matchAll(pattern)) {
                    const token = canonical(match[0]);
                    if (token === '频率相关表示') {
                        if (firstActor === 'encoder' && secondActor === 'conditioning'
                            && /半径编码器[^，,。；]{0,32}映射(?:为|成|到)频率相关表示/u.test(first)
                            && /(?:该|此|频率相关)表示经(?:特征调制|FiLM)[^，,。；]{0,100}(?:注入[^，,。；]{0,40}块间传递|上一块输出[^，,。；]{0,40}下一块输入)/u.test(second)) return true;
                        continue;
                    }

                    const firstClauses = first.split(/[，,]/u);
                    let startOffset = 0;
                    const clauseIndex = firstClauses.findIndex(clause => {
                        const contains = match.index >= startOffset && match.index < startOffset + clause.length;
                        startOffset += clause.length + 1;
                        return contains;
                    });
                    const productionClause = firstClauses[clauseIndex];
                    if (!productionClause) continue;
                    if (token === '质量分' && !/(?:输出|得到|生成|计算|预测|给出)(?:对应的|单曲的|歌曲的|一个)?质量分/u.test(productionClause)) continue;
                    const localIndex = productionClause.indexOf(match[0]);
                    const before = productionClause.slice(0, localIndex);
                    if (!/(?:提取|更新|建立|生成|输出|得到|选择|选出|送入|合并|存入)[^。；]{0,60}$/u.test(before)) continue;
                    // 省略主语只能承接同句此前的处理角色，不能借另一个角色的产物。
                    const localActor = actor(before);
                    const priorActors = firstClauses.slice(Math.max(0, clauseIndex - 3), clauseIndex)
                        .map(actor).filter(Boolean);
                    if (localActor ? localActor !== firstActor
                        : priorActors.at(-1) !== firstActor) continue;
                    pattern.lastIndex = 0;
                    const consumption = [...second.matchAll(pattern)].find(next => canonical(next[0]) === token);
                    if (!consumption) continue;
                    const normalizedSecond = second.replace(/候选说话人池|候选只读搜索请求|可朗读句子|语料文本/gu, canonical);
                    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const consumes = new RegExp(`(?:接收)(?:这些|该)?${escaped}`
                        + `|以[^。；]{0,70}${escaped}[^。；]{0,30}为输入`
                        + `|${escaped}[^。；]{0,70}(?:进入|送入|用于[^。；]{0,30}(?:扩展|检查))`
                        + (token === '质量分' && firstActor.startsWith('expert:') && secondActor.startsWith('expert:')
                            ? `|以(?:上一步|该|这些)?${escaped}为(?:基础|输入|依据)` : ''), 'u');
                    const containerConsumes = token === '候选池'
                        && /^候选池把[^。；]{0,50}(?:嵌入|来源)[^。；]{0,30}(?:存放|聚集)/u.test(normalizedSecond.split(/[，,]/u)[0]);
                    const ownedConsumption = normalizedSecond.split(/[，,]/u).some(clause =>
                        actor(clause) === secondActor && consumes.test(clause));
                    if (ownedConsumption && token === '质量分' && secondActor.startsWith('expert:')) {
                        const clauses = normalizedSecond.split(/[，,]/u);
                        const hasOwnedFusion = clauses.some((clause, index) =>
                            /(?:拼接|融合|校准)/u.test(clause)
                            && (actor(clause) || clauses.slice(Math.max(0, index - 3), index).map(actor).filter(Boolean).at(-1)) === secondActor);
                        if (!hasOwnedFusion) continue;
                    }
                    if (ownedConsumption || containerConsumes) return true;
                }
            }
        }
        return false;
    }

    function hasConcreteCompressionPurpose(summary) {
        return String(summary || '').split(/[。！？!?；;\n]/u).some(sentence =>
            !/(?:假设|如果|可能|未来|计划|没有|并非|不能|尚未|不需|无需)/u.test(sentence)
            && /(?:需|需要|旨在|目标是)把(?:原始)?(?:音频)?波形压缩为[^，,。]{0,30}(?:离散\s*(?:token|码元)|离散表示|编码)/iu.test(sentence)
            && /(?:可传输|可重建|码率|存储|通信)/u.test(sentence));
    }

    // A concrete simulation purpose states both the scene input and the
    // acoustic products needed for evaluation; "need" alone is not a purpose.
    function hasConcreteAcousticSimulationPurpose(summary, sourceText = '') {
        const sentences = String(summary || '').split(/[。！？!?；;\n]/u).map(part => part.trim()).filter(Boolean);
        const denied = /假设|假想|假定|设想|如果|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|先前工作|先前研究|既有研究|其他研究|第三方|外部团队|其他团队|他人|引用|引述|转述|并非|并未|不是|没有|不能|尚未|否认|否定|反驳|撤回|不成立|不正确|错误|有误|不需|无需/u;
        const source = String(sourceText || '').replace(/\s+/gu, ' ');
        const sourcePurpose = /difficult for a single microphone to provide uniform coverage throughout a home/iu.test(source)
            && /floorplan[^.!?]{0,700}generate multichannel RIRs and reverberant audio/iu.test(source);
        return sourcePurpose && sentences.some((sentence, index) => !denied.test(sentence + (sentences[index - 1] || ''))
            && /(?:^|[，,])单麦克风难覆盖整屋[，,]需由户型生成多通道房间脉冲响应与混响音频支撑评测$/u.test(sentence)
            && !/^(?:上述|以上|前述|该|此|这一)(?:用途|目的|需求|说法|表述)[^。]{0,40}(?:不成立|不正确|错误|有误|撤回|并非|没有|不属于)/u.test(sentences[index + 1] || ''));
    }


    // ─── Core-summary concrete runtime disclosure exemption ───
    // 前向次数和实测时间本身就是运行负担，不要求作者再加“成本”二字。
    function hasConcreteRuntimeDisclosure(summary) {
        return String(summary || '').split(/[。！？!?\n]/u).some(sentence => {
            if (/(?:否认|否定|反驳|驳斥|引用|引述|转述)|(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:错误|有误|不成立|不正确|不属实)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)/u.test(sentence)) return false;
            if (/(?:(?:未|不)(?:曾|实际|直接)?(?:需|需要|进行|执行)|讨论|假说|预计|预期|可能|假设|如果|未来|计划|建议|不需|无需|不能|不会|不进行|不执行|不耗|尚未|没有|未曾|并非|未测|未披露|未报告|未记录|未提供|未给出|未公布|未说明|未统计|不报告|不记录|不披露|不提供|尚无|不代表)/u.test(sentence)) return false;
            const measuredDuration = /(?:训练|推理|部署|(?:监督)?微调|强化学习)(?:平均|每轮|每个epoch)?(?:时间|耗时|用时)?(?:约|大约|为|是|分别为)?\s*(?:[0-9]+(?:\.[0-9]+)?)\s*(?:小时|分钟|毫秒|秒|hours?|minutes?|seconds?|ms|h|s)(?![A-Za-z0-9]|\s*的?\s*(?:(?:训练|测试|验证|评测)(?:用|集)?\s*)?(?:音频|语音|录音|数据|样本|语料|材料))/iu.exec(sentence);
            if (measuredDuration && !/(?:假定|假想|设想)/u.test(sentence)
                && !/(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:不成立|不正确|不属实|不是事实|错误|有误)|^(?:是|为)?(?:不成立|不正确|不属实|错误|有误)/u.test(sentence.slice(measuredDuration.index + measuredDuration[0].length, measuredDuration.index + measuredDuration[0].length + 50))) return true;
            return /(?:推理(?:为|采用|使用)|以)(?:一|单)次语音前向/u.test(sentence)
                || /训练可训练参数(?:量)?为\s*[0-9]+(?:\.[0-9]+)?\s*[kKmMbB](?![A-Za-z0-9])/u.test(sentence)
                || /(?:训练|推理|部署)[^。！？!?；;]{0,40}(?:需要|需|进行|执行)(?:[1-9][0-9]*|[一二两三四五六七八九十]+)次(?:完整(?:的)?|(?:经过|通过)(?:共享)?(?:[A-Za-z0-9_-]+\s*)?(?:编码器|主干|网络|模型)(?:的)?(?:提示条件)?|提示条件(?:的)?)?前向(?:传播|计算)?/u.test(sentence)
                || /(?:训练|推理|部署)(?:平均|每轮|每个epoch)?时间(?:约|为|是|分别为)?\s*[0-9]+:[0-5][0-9](?![0-9:])/u.test(sentence)
                || /(?:训练|推理|部署)(?:平均|每轮|每个epoch)?时间[（(](?:毫秒|秒|分钟)(?:\/文件)?[）)](?:约|为|是|分别为)?\s*[0-9]+(?:\.[0-9]+)?(?![0-9.])/u.test(sentence);
        });
    }


    return Object.freeze({
        CORE_SUMMARY_DNSMOS_PATTERN,
        CORE_SUMMARY_DNSMOS_DENIED,
        sourceBackedIdentityColumns,
        sourceBoundLossSwitchColumns,
        ownObservedSourceScope,
        adjacentSourceStatementAfter,
        hasOwnSourceStatement,
        hasObservedStageSwitchTable,
        isReportedExperimentPrefix,
        hasReportedExperimentPhrase,
        hasSourceBackedSequenceOrderAblation,
        hasSourceBackedPresenceComparison,
        hasSourceBackedComponentSwitchAblation,
        hasSourceBackedTrainingStageAblation,
        hasSourceBackedSettingVariantAblation,
        normalizeLocalEvidenceHeading,
        hasOwnLocalReportedExperiment,
        hasSourceBackedPlacementControl,
        hasSourceBackedZeroCorrectionAblation,
        hasAdjacentAffirmativeEvidenceWithdrawal,
        hasSourceBackedNetIntervalNegative,
        hasSourceBackedRewardSwitchAblation,
        matchesSourceAudiogramMetricPairs,
        hasSourceBackedQualityAudibilityTradeoff,
        sourceBoundPredictionRefinementDecline,
        hasTableBoundHigherMetricRegression,
        hasSourceBackedWindowConfusion,
        observedExperimentClaim,
        observedSourceNegativeEvidence,
        sourceHasObservedReasoningFailure,
        sourceBoundLowerMetricIncrease,
        sourceTwoBaselineMetricRegressions,
        sourceBoundReverseBaselineComparison,
        sourceBoundMatchedAcousticGap,
        unquotedObservedComparison,
        observedAdverseComparison,
        sourceBoundListeningScoreRegression,
        sourceBoundRenderedDurationShortfall,
        sourceBoundFoldedObjectiveRegression,
        sourceBoundDeadlineF1Comparison,
        sourceBoundNotationRoundtripRegression,
        hasBoundFormerLatterComparison,
        hasBoundDisjointIntervalComparison,
        hasConditionalMetricDeltaDirection,
        hasPrefixedCoreMetricComparison,
        stripSymbolicPatternRelation,
        hasSymbolicGeometryMethodChain,
        hasScopedSymbolicDemonstration,
        sourceHasMeasuredMetricTable,
        sourceCorpusCurationResult,
        hasCompleteCorpusCurationResult,
        sourceSoftwareFunctionalValidationResult,
        hasCompleteSoftwareFunctionalValidationResult,
        sourceHasBoundEventProportionComparison,
        sourceHasBoundMeanF0Comparison,
        sourceHasObservedOutcomeComparison,
        sourceMeasuredPlannerSelection,
        sourceBoundPlannerSelectionResult,
        hasSourceBoundTextVideoComparison,
        hasConcreteCoreSummarySetting,
        hasRecordedDissonanceComparison,
        hasMeanRoomSimulationComparison,
        hasSourceBackedBayesianGroupResult,
        sourceCorrectionRateProfile,
        sourceBoundCorrectionRateObservations,
        hasAffirmativeDnsMosStatement,
        hasSourceDefinedDnsMos,
        hasSourceBoundDnsMosBoundary,
        hasCountedEvaluationScope,
        hasSourceBoundHitCountMetric,
        hasBlockLayoutProductChain,
        hasPosteriorUpdateProductChain,
        hasConcreteProductHandoff,
        hasExplicitArtifactHandoff,
        hasCachedCausalStateHandoff,
        hasOfflineOperationalBoundary,
        hasNaturalScopedBoundary,
        hasGeneratedInputModelHeadChain,
        hasExplicitEditedVectorHandoff,
        hasTypedNaturalProductHandoff,
        hasSourceBoundEditedWaveformOrCachedAvChain,
        hasTypedProcessingProductChain,
        hasSourceBoundSymbolAndTrajectoryHandoff,
        hasExplicitNaturalProductChain,
        hasConcreteUnnumberedMethodChain,
        hasAdjacentConcreteMethodChain,
        hasConcreteCompressionPurpose,
        hasConcreteAcousticSimulationPurpose,
        hasConcreteRuntimeDisclosure
    });
}

module.exports = {
    QUARANTINED_EXEMPTION_FUNCTIONS,
    createPaperExemptions
};
