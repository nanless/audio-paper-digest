'use strict';
// Real source excerpt; parser tests alone grant no source or publication authority.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const authors=require('../scripts/lib/reader-author-parser');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');const stable=v=>{const sort=x=>Array.isArray(x)?x.map(sort):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sort(x[k])])):x;return sha(JSON.stringify(sort(v)));};
const source='Dai Gao1, Chen Jiang2, Sizhe Liu3, Peng Zhang4\n1 School of Future Science and Engineering, Soochow University, China\n2 School of Computer Science and Technology, Beijing Jiaotong University, China\n3 Sino-French Institute, Renmin University of China, China\n4 Shandong Computer Science Center (National Supercomputer Center in Jinan), Qilu University of\n                    Technology (Shandong Academy of Sciences), China\n dgaogaod1@stu.suda.edu.cn\n\nAbstract\nPaper text.';
const prefix='Shandong Computer Science Center (National Supercomputer Center in Jinan), Qilu University of';
const complete=prefix+' Technology (Shandong Academy of Sciences), China';
test('v1 author evidence stays unchanged while explicit v2 binds actual adjacent institution continuation',()=>{
 const old=authors.parseConferencePdfAuthors(source),updated=authors.parseConferencePdfAuthorsV2(source);
 assert.equal(old.authors.find(a=>a.name==='Peng Zhang').affiliations[0],prefix);
 assert.equal(updated.authors.find(a=>a.name==='Peng Zhang').affiliations[0],complete);
 assert.equal(updated.sourceTextSha256,sha(source));assert.equal(updated.sourceEvidence,old.sourceEvidence);assert.equal(updated.sourceDomSha256,old.sourceDomSha256);
});
test('saved unversioned identity uses legacy publication replay and only explicit/new saved v2 selects new parser',()=>{
 const details={source:'conference_pdf_text',text:source,structuredArtifacts:{payloadSha256:sha('artifacts')}};
 const paper={authors:['Dai Gao','Chen Jiang','Sizhe Liu','Peng Zhang'],sourceSha256:sha(source),analysisManifest:{sourceAcquisition:{sourceSha256:sha(source),structuredArtifactsSha256:sha('artifacts')},stages:{apiReaderArticle:{structuredArtifactsSha256:sha('artifacts')}}}};
 const save=record=>{paper.apiReaderAuthors=record;paper.analysisManifest.stages.apiReaderArticle.readerAuthorsSha256=stable(record);paper.analysisManifest.stages.apiReaderArticle.readerAuthorIdentitySha256=record.identitySha256;};
 const old=authors.resolveVerifiedReaderAuthors(paper,details);save(old);assert.equal(authors.readerAuthorIdentityMatchesSource(paper,details),true);assert.deepEqual(authors.resolveVerifiedReaderAuthors(paper,details),old);
 const updated=authors.resolveVerifiedReaderAuthors(paper,details,{conferencePdfAuthorParserVersion:2});save(updated);assert.equal(updated.identity.conferencePdfAuthorParser,'conference-pdf-author-lines-v2');assert.equal(authors.readerAuthorIdentityMatchesSource(paper,details),true);assert.deepEqual(authors.resolveVerifiedReaderAuthors(paper,details),updated);
 paper.apiReaderAuthors.identity.conferencePdfAuthorParser='unknown';assert.throws(()=>authors.resolveVerifiedReaderAuthors(paper,details),/Unknown saved/);
});
test('continuation cannot absorb email names abstract ordinary prose or next marked institution',()=>{
 for(const tail of ['Technology Contact mail@example.org','2 University of Another Institution','Abstract','A Person, Another Person','ordinary experiment prose']){
  const parsed=authors.parseConferencePdfAuthorsV2('A Name1\n1 Example University of\n    '+tail+'\n\nAbstract\nPaper.');assert.equal(parsed.authors[0].affiliations[0],'Example University of');
 }
});
