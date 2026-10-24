// Explicit native bridge for the unmodified production leaf document. Never
// accesses AppKit, user data, credentials, a public service, or a model.
const {server,fixture,primary,repo}=require('./DesktopUI.test.cjs');
async function leaf(browser,kind='help',options={}){
 const p=await browser.newPage({viewport:{width:820,height:700}});p.setDefaultTimeout(7000);
 await p.addInitScript(({kind,primary,options})=>{
  if(window.top!==window)return;
  window.leafFixture={kind,calls:[],id:'native-fixture-owner',closed:false,pending:[],...options};
  const f=leafFixture;
  window.webkit={messageHandlers:{desktop:{postMessage:async({command,payload={}})=>{
   f.calls.push({command,payload:structuredClone(payload)});
   if(command==='details.bootstrap')return {presentationID:f.id,kind,title:{help:'使用说明',export:'导出当前研究',zotero:'存入 Zotero',storage:'本机资料'}[kind],appearance:f.appearance||'light',paper:primary,context:{title:primary.title,paperID:primary.id,revision:'a'.repeat(64)}};
   if(payload.presentationID!==f.id)throw Error('Explicit native fixture session mismatch');
   if(command==='details.close'){f.closed=true;dispatchEvent(new Event('details.closed'));return {closed:true};}
   if(f.hold===command)await new Promise((resolve,reject)=>f.pending.push({resolve,reject}));
   if(command==='app.export'||command==='app.backup'||command==='app.diagnostics')return f.response||{saved:true};
   if(command==='app.restore')return f.response||{restored:true};
   if(command==='archive.materials')return {identity:'arxiv:2610.27491v1',bibliography:{title:primary.title,creators:[]},pdfPath:'/explicit-fixture-only.pdf',guideHTMLPath:'/explicit-fixture-only.html'};
   if(command==='zotero.status')return {running:true,version:'10.0.6',writesSupported:true,authorized:false,archives:f.archives||[]};
   if(command==='zotero.resume')return {status:'complete',archiveID:payload.resumeID,title:'原归档 A',identity:'arxiv:2601.00001v1',steps:[{role:'bibliography',verified:true}],parentKey:'ABCD1234'};
   if(command==='zotero.collections')return {collections:[]};
   if(command==='storage.status')return {totalBytes:0,files:0,categories:[]};
   if(command==='storage.packages')return {packages:[]};
   throw Error('Unexpected explicit leaf fixture operation '+command);
  }}}};
 },{kind,primary,options});
 const errors=[];p.on('pageerror',e=>errors.push(e.message));p.leafErrors=errors;
 await p.goto('http://127.0.0.1:'+server.address().port+'/details.html');
 await p.waitForFunction(kind=>document.querySelector('#details-title').textContent.includes({help:'使用说明',export:'导出当前研究',zotero:'存入 Zotero',storage:'本机资料'}[kind]),kind);
 await p.waitForSelector('#detail-content h1,#detail-content h2');return p;
}
module.exports={server,leaf,fixture,primary,repo};
