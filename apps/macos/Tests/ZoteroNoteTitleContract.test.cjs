// Actual installed noteToTitle + unescapeHTML, exercised with notes emitted by
// the real Swift service through its isolated mock. Never accesses a user library.
'use strict';
const assert=require('node:assert/strict'),{execFileSync}=require('node:child_process'),crypto=require('node:crypto');
const {chromium}=require('playwright');
const source=name=>execFileSync('/usr/bin/python3',['-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]);sys.stdout.buffer.write(z.read(sys.argv[2]))','/Applications/Zotero.app/Contents/Resources/app/omni.ja','chrome/content/zotero/xpcom/utilities/'+name],{encoding:'utf8',maxBuffer:4*1024*1024});
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{input+=c;if(input.length>4*1024*1024)throw Error('fixture size')});process.stdin.on('end',async()=>{let browser;try{
 const fixtures=JSON.parse(input);assert.ok(fixtures.length>=4);
 const item=source('utilities_item.js'),utilities=source('utilities.js');
 const start=item.indexOf('noteToTitle: function');assert.ok(start>=0);const end=item.indexOf('\n    },',start);assert.ok(end>start);const titleFunction=item.slice(start+'noteToTitle: '.length,end+'\n    }'.length);
 const us=utilities.indexOf('"unescapeHTML": new function () {');assert.ok(us>=0);const ue=utilities.indexOf('\n    }(),',us);assert.ok(ue>us);const unescapeExpression=utilities.slice(us+'"unescapeHTML": '.length,ue+'\n    }()'.length);
 browser=await chromium.launch({headless:true,executablePath:process.env.PD_MAC_BROWSER||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});const page=await browser.newPage();
 const actual=await page.evaluate(({fixtures,titleFunction,unescapeExpression})=>{window.Zotero={isFx:true,isBookmarklet:false,Utilities:{Internal:{getDOMDocument:()=>document}}};window.Utilities=Zotero.Utilities;Zotero.Utilities.unescapeHTML=(0,eval)('('+unescapeExpression+')');const noteToTitle=(0,eval)('('+titleFunction+')');return fixtures.map(f=>({title:noteToTitle(f.note),scripts:(new DOMParser()).parseFromString(f.note,'text/html').querySelectorAll('script').length}));},{fixtures,titleFunction,unescapeExpression});
 for(let i=0;i<fixtures.length;i++){const f=fixtures[i],a=actual[i];assert.equal(a.title,f.expectedTitle.slice(0,120),f.name);assert.ok(f.note.includes(f.originalHTML),f.name+' exact original HTML');assert.ok(f.note.includes(f.marker),f.name+' original marker');assert.equal(a.scripts,0,f.name+' title escape');if(!f.legacy)assert.ok(!a.title.startsWith('PaperDigest-Note:'),f.name);}
 console.log('Installed Zotero noteToTitle/unescapeHTML: '+fixtures.length+' actual-service fixtures passed. Primary utilities_item.js SHA256 '+crypto.createHash('sha256').update(item).digest('hex')+'. No user library/API/credentials.');
 }catch(e){console.error(e);process.exitCode=1;}finally{if(browser)await browser.close();}});
