const { describe, it } = require('node:test');
const assert = require('node:assert');

const { validAnalysisText } = require('./valid-analysis-fixture.js');
const { buildImageAnchorCatalog } = require('../scripts/deep-analyzer.js');
const { validateExactFactCoverage } = require('../scripts/manual-research-contract.js');
const { replayManualImageInsertions } = require('../scripts/validate-manual-record.js');

describe('validate-manual-record production insertion replay', () => {
    it('exposes an exact fact introduced only by image neighbor prose to the final gate', () => {
        const analysis = validAnalysisText();
        const anchor = buildImageAnchorCatalog(analysis)
            .find(item => item.section === '方法概述和架构');
        assert.ok(anchor);
        const context = anchor.text.slice(0, 48);
        const url = 'https://example.com/architecture.png';
        const record = {
            selectedImageUrls: [url],
            imageInsertions: [{
                section: anchor.section,
                anchorQuote: anchor.text,
                conclusionQuote: anchor.text,
                lead: `承接“${context}”，下图用于核对组件关系；图旁新增未经全文绑定的耗时 3.20s。`,
                explanation: `图中箭头回扣“${context}”描述的数据流，结论只适用于当前系统。`
            }]
        };
        const imageInfos = [{
            url,
            caption: 'Architecture and signal flow overview'
        }];

        assert.doesNotThrow(() => validateExactFactCoverage(analysis, analysis, {
            label: 'before', externalEvidence: [], derivedFacts: []
        }));
        const finalAnalysis = replayManualImageInsertions(
            analysis, record, imageInfos, 'paper.imageInsertions'
        );
        assert.match(finalAnalysis, /3\.20s/);
        assert.throws(() => validateExactFactCoverage(finalAnalysis, analysis, {
            label: 'after', externalEvidence: [], derivedFacts: []
        }), /3\.20s/);
    });

    it('rejects a hand-written image that would be duplicated by the structured insertion plan', () => {
        const base = validAnalysisText();
        const anchor = buildImageAnchorCatalog(base)
            .find(item => item.section === '方法概述和架构');
        const context = anchor.text.slice(0, 48);
        const url = 'https://example.com/duplicate.png';
        const analysis = base.replace(
            anchor.text,
            `${anchor.text}\n\n![手写重复图](${url})\n\n手写图后说明重复了结构化插图职责。`,
        );
        assert.throws(() => replayManualImageInsertions(analysis, {
            selectedImageUrls: [url],
            imageInsertions: [{
                section: anchor.section,
                anchorQuote: anchor.text,
                conclusionQuote: anchor.text,
                lead: `承接“${context}”，下图用于逐项核对组件输入、变换和输出关系。`,
                explanation: `图中箭头回扣“${context}”描述的数据流，并把结论限定在当前方法与披露条件。`,
            }],
        }, [{ url, caption: 'Duplicate architecture figure' }], 'paper.imageInsertions'),
        /最终正文图片 URL\/数量\/顺序/);
    });
});
