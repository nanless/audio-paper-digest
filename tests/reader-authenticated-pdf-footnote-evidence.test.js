'use strict';
process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), child = require('node:child_process');
const api = require('../scripts/lib/reader-authenticated-pdf-footnote-evidence');
const sourceApi = require('../scripts/lib/conference-source-context');
const deep = require('../scripts/deep-analyzer');
const { stableHash } = require('../scripts/lib/conference-analysis-adapter');
const sha256 = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
const URL = 'https://github.com/example/release';
const program = path.resolve(__dirname, '../scripts/reader_authenticated_pdf_footnote_evidence.py');

function python(code, args = []) {
    return child.execFileSync('bash', ['scripts/python-runtime.sh', '-c', code, ...args],
        { cwd: path.resolve(__dirname, '..'), maxBuffer: 16 * 1024 * 1024 });
}
function fixture(t) {
    const extraction = require('./helpers/conference-extraction-fixture');
    const original = extraction.buildPdf;
    const pdf = python(`import fitz,sys
d=fitz.open();p=d.new_page(width=596,height=842)
p.insert_text((30,25),'Paper 100',fontsize=12)
for i in range(55): p.insert_text((30,45+i*9),'Fixture methods and controlled experiments preserve the full authenticated source. '+'x'*50,fontsize=7)
text='Our code and data are publicly available'
p.insert_text((60,650),text,fontname='Times-Roman',fontsize=9)
x=60+fitz.get_text_length(text,fontname='Times-Roman',fontsize=9)
p.insert_text((x,646),'1',fontname='Times-Roman',fontsize=6)
p.insert_text((65,757),'1',fontname='Times-Roman',fontsize=6)
p.insert_text((69,760),sys.argv[1],fontname='Times-Roman',fontsize=8)
sys.stdout.buffer.write(d.tobytes());d.close()`, [URL]);
    extraction.buildPdf = () => pdf;
    let f;
    try { f = require('./helpers/conference-production-plan-fixture').productionPlanFixture(t); }
    finally { extraction.buildPdf = original; }
    const handle = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    return { ...f, handle, source: sourceApi.readerPdfSourceForContext(handle) };
}

test('真实PDF上标/同号脚注正常导出并用全新认证句柄冷重放，离开范围不能借用', t => {
    const f = fixture(t); let resources;
    api.withVerifiedSource(f.handle, () => {
        const candidates = api.deriveCandidates(f.source.sourceText);
        assert.deepEqual(candidates.map(value => value.type), ['code', 'dataset']);
        resources = candidates.map(candidate => ({ type: candidate.type, origin: 'paper_source', originalUrl: candidate.url,
            sourceQuote: candidate.line, sourceQuoteSha256: sha256(candidate.line),
            authenticatedPdfFootnoteEvidence: candidate.authenticatedPdfFootnoteEvidence }));
        for (const resource of resources) assert.equal(api.assertEvidence(resource, f.source.sourceText), true);
        assert.ok(resources[0].authenticatedPdfFootnoteEvidence.pdfFootnote.statementLines.some(line => line.words.length));
        api.withoutVerifiedSource(() => assert.throws(() => api.assertEvidence(resources[0]), /来源作用域/));
    });
    assert.deepEqual(api.deriveCandidates(), []);
    assert.throws(() => api.withVerifiedSource({ ...f.handle }, () => {}), /真实认证/);
    const cold = sourceApi.buildConferenceSourceContext({ planHandle: f.planHandle, paperId: f.paperId, sourceRoot: f.sourceRoot });
    api.withVerifiedSource(cold, () => {
        for (const resource of resources) assert.equal(api.assertEvidence(resource), true);
        for (const mutate of [r => { r.type = 'model'; }, r => { r.originalUrl += '-other'; },
            r => { r.sourceQuote = 'wrong quote'; },
            r => { r.authenticatedPdfFootnoteEvidence.pdfFootnote.marker = '2'; },
            r => { r.authenticatedPdfFootnoteEvidence.pdfFootnote.statementMarker.bbox[0]++; },
            r => { r.authenticatedPdfFootnoteEvidence.pdfSha256 = '0'.repeat(64); }]) {
            const changed = structuredClone(resources[0]); mutate(changed);
            assert.throws(() => api.assertEvidence(changed), /不一致|变化/);
        }
        const file = path.join(f.sourceRoot, f.member.pdfFile), before = fs.readFileSync(file);
        try { fs.appendFileSync(file, '\nchanged source'); assert.throws(() => api.deriveCandidates(), /SHA|变化|不一致/); }
        finally { fs.writeFileSync(file, before); }
    });
});

test('新生成资源经来源证明绑定多个facet，可达性仍独立核验；旧identity不静默改写', async t => {
    const f = fixture(t); let requests = 0;
    const options = { validateUrlImpl: async value => new globalThis.URL(value), requestImpl: async () => { requests++; return { status: 200, headers: {} }; } };
    await api.withVerifiedSource(f.handle, async () => {
        const identity = await deep.buildApiReaderResourceIdentity('', f.source.sourceText, {}, options);
        assert.deepEqual(identity.resources.map(resource => resource.type), ['code', 'dataset']);
        assert.equal(requests, 1, 'two facets share the actual URL reachability request');
        assert.equal(deep.replayVerifiedReaderResourceIdentity(identity, f.source.sourceText), identity);
        assert.equal(require('../scripts/lib/reader-resource-binding').paperSourceQuoteBindsOriginalUrl(identity.resources[0]), true);
        const oldGeneratedLine = `- 其他资源链接：<${URL}>（已验证可访问，HTTP 200）（未据此确认作者已开放资源）`;
        const projected = deep.applyApiReaderResourceAvailability('## 开源详情\n' + oldGeneratedLine, identity);
        assert.equal(projected.includes(oldGeneratedLine), false, 'a real typed proof removes the old generated third-party view without probing a forged type or quote fragment');
        const { identitySha256: _identitySha, ...datasetBody } = identity;
        datasetBody.resources = identity.resources.filter(resource => resource.type === 'dataset');
        const datasetIdentity = { ...datasetBody, identitySha256: stableHash(datasetBody) };
        const datasetProjected = deep.applyApiReaderResourceAvailability('## 开源详情\n' + oldGeneratedLine, datasetIdentity);
        assert.equal(datasetProjected.includes(oldGeneratedLine), false, 'typed dataset evidence does not depend on a code facet to remove the obsolete third-party line');
        const proofBefore = JSON.stringify(identity);
        const originalResource = { type: 'third_party', origin: 'paper_source', originalUrl: URL, finalUrl: URL,
            redirects: [], status: 404, availability: 'unavailable', retryable: false,
            sourceQuote: identity.resources[0].sourceQuote, sourceQuoteSha256: identity.resources[0].sourceQuoteSha256 };
        const body = { contract: 'api-reader-resource-identity-v1', sourceTextSha256: sha256(f.source.sourceText), resources: [originalResource] };
        const original = { ...body, identitySha256: stableHash(body) }, before = JSON.stringify(original);
        const proposal = api.deriveCorrectedIdentity(original, f.source.sourceText);
        assert.equal(proposal.originalIdentitySha256, original.identitySha256);
        assert.deepEqual(proposal.identity.resources.map(resource => [resource.type, resource.availability, resource.status]),
            [['code', 'unavailable', 404], ['dataset', 'unavailable', 404]]);
        assert.equal(proposal.networkRequests, 0); assert.equal(proposal.modelRequests, 0);
        assert.equal(JSON.stringify(original), before); assert.equal(JSON.stringify(identity), proofBefore);
        assert.equal(requests, 1, 'source correction performs no reachability or model request');
        assert.equal(deep.replayVerifiedReaderResourceIdentity(proposal.identity, f.source.sourceText), proposal.identity);
        assert.equal(original.resources[0].type, 'third_party');
        assert.equal(Object.hasOwn(original.resources[0], 'authenticatedPdfFootnoteEvidence'), false);
        const conflict = structuredClone(original); conflict.resources.push({ ...originalResource, status: 200, availability: 'available' });
        const { identitySha256: _old, ...conflictBody } = conflict; conflict.identitySha256 = stableHash(conflictBody);
        assert.throws(() => api.deriveCorrectedIdentity(conflict, f.source.sourceText), /状态记录不唯一/);
    });
});

test('真实PDF负例拒否定、将来、他人、引述、撤销、错号、重号、跨栏、跨页及非上标', () => {
    const result = JSON.parse(python(`import fitz,importlib.util,json,sys
s=importlib.util.spec_from_file_location('foot',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
def build(kind):
 d=fitz.open();p=d.new_page(width=596,height=842)
 text={'negative':'Our code is not publicly available','future':'Our code will be released as open source','external':'The baseline code is publicly available','external_of':'The code of Acme is available','external_from':'The code from Acme is available','external_by':'The code by Acme is available'}.get(kind,'Our code is publicly available')
 if kind=='quoted':p.insert_text((60,287),'Other authors state:',fontname='Times-Roman',fontsize=9)
 p.insert_text((60,300),text,fontname='Times-Roman',fontsize=9);x=60+fitz.get_text_length(text,fontname='Times-Roman',fontsize=9)
 p.insert_text((x+(40 if kind=='detached' else 0),300 if kind=='not_superscript' else 296),'1',fontname='Times-Roman',fontsize=9 if kind=='not_superscript' else 6)
 if kind=='retracted':p.insert_text((60,314),'Our code is not publicly available now.',fontname='Times-Roman',fontsize=9)
 if kind=='retracted_statement':p.insert_text((60,314),'However, this release statement was retracted.',fontname='Times-Roman',fontsize=9)
 if kind=='inaccurate_statement':p.insert_text((60,314),'This statement is not accurate.',fontname='Times-Roman',fontsize=9)
 if kind=='unrelated_result':p.insert_text((60,314),'This result was retracted.',fontname='Times-Roman',fontsize=9)
 if kind=='duplicate_call':
  p.insert_text((60,330),text,fontname='Times-Roman',fontsize=9);p.insert_text((x,326),'1',fontname='Times-Roman',fontsize=6)
 if kind=='cross_page':p=d.new_page(width=596,height=842)
 nx=330 if kind=='cross_column' else 65
 p.insert_text((nx,757),'2' if kind=='wrong_number' else '1',fontname='Times-Roman',fontsize=6)
 p.insert_text((nx+4,760),'https://github.com/example/release',fontname='Times-Roman',fontsize=8)
 if kind=='duplicate_note':
  p.insert_text((nx,777),'1',fontname='Times-Roman',fontsize=6);p.insert_text((nx+4,780),'https://github.com/example/other',fontname='Times-Roman',fontsize=8)
 out=m.extract(d.tobytes());d.close();return {'accepted':len(out['candidates']),'reasons':[x['reason'] for x in out['rejected']]}
print(json.dumps({kind:build(kind) for kind in ['positive','unrelated_result','negative','future','external','external_of','external_from','external_by','quoted','retracted','retracted_statement','inaccurate_statement','wrong_number','duplicate_note','duplicate_call','cross_column','cross_page','detached','not_superscript']}))`, [program]));
    assert.equal(result.positive.accepted, 1);
    assert.equal(result.unrelated_result.accepted, 1);
    for (const [kind, value] of Object.entries(result)) if (!['positive', 'unrelated_result'].includes(kind)) assert.equal(value.accepted, 0, kind);
});
