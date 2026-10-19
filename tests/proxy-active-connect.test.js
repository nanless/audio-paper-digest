'use strict';
// Exact production bodies with synthetic socket/timer queues only.
// No network, model, credentials, paper, source capability or fee qualification.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const scripts=path.join(__dirname,'../scripts');
const text=fs.readFileSync(path.join(scripts,'utils.js'),'utf8');
const body=text.slice(text.indexOf('function normalizeTlsServername('),text.indexOf('\n/**\n * 创建仅用于非 LLM fetch',text.indexOf('function createProxyAgent(')));
const helper=fs.readFileSync(path.join(scripts,'lib/active-time-budget.js'),'utf8');
function setup(proxyScheme='http'){
 let now=0,next=0;const timers=new Map(),immediates=new Map(),tcp=[],tls=[];
 const handle=(map,value)=>{const h={id:++next,unref(){return this;}};map.set(h.id,{...value,h});return h;};
 const set=(fn,ms,interval=false)=>handle(timers,{fn,due:now+ms,interval:interval?ms:0});
 const clock={jump(ms){now+=ms;},due(){let n=0;while(true){const ready=[...timers.values()].filter(t=>t.due<=now).sort((a,b)=>a.due-b.due||a.h.id-b.h.id)[0];if(!ready)break;if(++n>10000)throw Error('timer loop');if(ready.interval)ready.due=now+ready.interval;else timers.delete(ready.h.id);ready.fn();}},
 advance(ms){const end=now+ms;while(true){const due=Math.min(...[...timers.values()].map(t=>t.due));if(due>end)break;now=due;this.due();}now=end;},
 flush(){const batch=[...immediates.values()];immediates.clear();for(const i of batch)i.fn();},pending(){return timers.size+immediates.size;}};
 class Socket extends EventEmitter{constructor(){super();this.destroyed=false;this.destroyCalls=0;this.writes=[];}write(bytes){this.writes.push(bytes);}destroy(error){this.destroyed=true;this.destroyCalls++;if(error)this.emit('error',error);}}
 class Agent{constructor(options){this.options=options;this.baseDestroyCalls=0;}destroy(){this.baseDestroyCalls++;}}
 const context={module:{exports:{}},Date:{now:()=>now},URL,Buffer,Set,Math,
  setTimeout:(fn,ms)=>set(fn,ms),clearTimeout:h=>timers.delete(h?.id),setInterval:(fn,ms)=>set(fn,ms,true),clearInterval:h=>timers.delete(h?.id),
  setImmediate:fn=>handle(immediates,{fn}),clearImmediate:h=>immediates.delete(h?.id),
  buildProxyAuthorizationHeader:p=>p.username?'Basic '+Buffer.from(decodeURIComponent(p.username)+':'+decodeURIComponent(p.password)).toString('base64'):null,
  require:id=>id==='https'?{Agent}:id==='net'?{connect:options=>{const s=new Socket();s.options=options;tcp.push(s);return s;}}:id==='tls'?{connect:(options,callback)=>{const s=new Socket();s.options=options;if(callback)s.once('secureConnect',callback);tls.push(s);return s;}}:(()=>{throw Error('Unexpected dependency '+id);})()};
 vm.createContext(context);vm.runInContext(helper,context);context.createActiveTimeBudget=context.module.exports.createActiveTimeBudget;
 vm.runInContext(body+';module.exports=createProxyAgent;',context);
 const agent=context.module.exports(proxyScheme+'://fixture-user:fixture-password@127.0.0.1:7897','example.invalid',443,'example.invalid'),results=[];
 const open=()=>{agent.createConnection({},(error,socket)=>results.push({error,socket}));return proxyScheme==='https'?tls.at(-1):tcp.at(-1);};
 const tunnel=s=>{s.emit(proxyScheme==='https'?'secureConnect':'connect');s.emit('data',Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));return tls.at(-1);};
 return {clock,agent,tcp,tls,results,open,tunnel,budget:context.createActiveTimeBudget};
}
test('ordinary CONNECT/TLS preserves proxy target/auth/SNI, settles once and cleans every timer',()=>{
 const h=setup(),s=h.open(),t=h.tunnel(s);assert.match(s.writes[0],/^CONNECT example\.invalid:443 HTTP\/1\.1\r\n/);assert.match(s.writes[0],/Proxy-Authorization: Basic /);assert.equal(t.options.servername,'example.invalid');assert.equal(t.options.rejectUnauthorized,true);
 t.emit('secureConnect');assert.equal(h.results.length,1);assert.equal(h.results[0].error,null);assert.equal(h.results[0].socket,t);assert.equal(h.clock.pending(),0);
 h.clock.jump(120000);h.clock.due();h.clock.flush();assert.equal(h.results.length,1);assert.equal(t.destroyed,false);
});
test('long event-loop pause excludes delayed wall time and lets ready CONNECT/TLS finish',()=>{
 const h=setup(),s=h.open();h.clock.advance(1000);h.clock.jump(65000);h.clock.due();assert.equal(h.results.length,0);assert.equal(s.destroyed,false);
 const t=h.tunnel(s);t.emit('secureConnect');h.clock.flush();assert.equal(h.results.length,1);assert.equal(h.results[0].socket,t);assert.equal(t.destroyed,false);assert.equal(h.clock.pending(),0);
});
test('at the effective deadline ready TLS poll callback wins before deferred timeout disposal',()=>{
 const h=setup(),s=h.open(),t=h.tunnel(s);h.clock.advance(59000);h.clock.jump(65000);h.clock.due();assert.equal(h.results.length,0);
 t.emit('secureConnect');h.clock.flush();assert.equal(h.results.length,1);assert.equal(h.results[0].error,null);assert.equal(t.destroyCalls,0);assert.equal(h.clock.pending(),0);
});
test('true sixty active seconds with no response expires once and destroys the pending socket',()=>{
 const h=setup(),s=h.open();h.clock.advance(59999);h.clock.flush();assert.equal(h.results.length,0);h.clock.advance(1);assert.equal(h.results.length,0);h.clock.flush();
 assert.equal(h.results.length,1);assert.equal(h.results[0].error.code,'PROXY_CONNECT_TIMEOUT');assert.equal(s.destroyed,true);assert.equal(s.destroyCalls,1);assert.equal(h.clock.pending(),0);
 h.clock.advance(120000);h.clock.flush();assert.equal(h.results.length,1);
});
test('multiple short stalls remain active time rather than granting a fresh deadline',()=>{
 const h=setup(),s=h.open();for(let i=0;i<12;i++){h.clock.jump(5000);h.clock.due();h.clock.flush();}
 assert.equal(h.results.length,1);assert.equal(h.results[0].error.code,'PROXY_CONNECT_TIMEOUT');assert.equal(s.destroyed,true);assert.equal(h.clock.pending(),0);
});
test('CONNECT rejection and TCP/target-TLS errors keep original failures and clean all deadlines',()=>{
 for(const kind of ['status','tcp','tls']){const h=setup(),s=h.open();
  if(kind==='status'){s.emit('connect');s.emit('data',Buffer.from('HTTP/1.1 502 Bad Gateway\r\n\r\n'));assert.match(h.results[0].error.message,/CONNECT.*502/);}
  else{const error=Object.assign(Error('synthetic '+kind),{code:kind==='tls'?'CERT_HAS_EXPIRED':'ECONNRESET'});(kind==='tls'?h.tunnel(s):s).emit('error',error);assert.equal(h.results[0].error,error);}
  assert.equal(h.results.length,1);assert.equal(h.clock.pending(),0);h.clock.jump(120000);h.clock.due();h.clock.flush();assert.equal(h.results.length,1);
 }
});
test('agent.destroy cancels TCP/TLS/scheduled-final-check timers without a later callback',()=>{
 for(const phase of ['tcp','tls','deadline']){const h=setup(),s=h.open(),t=phase==='tcp'?s:h.tunnel(s);if(phase==='deadline')h.clock.advance(60000);
  h.agent.destroy();assert.equal(t.destroyed,true);assert.equal(h.agent.baseDestroyCalls,1);assert.equal(h.clock.pending(),0);h.clock.jump(120000);h.clock.due();h.clock.flush();assert.equal(h.results.length,0);
 }
});
test('destroyed connections ignore queued TCP, CONNECT data and either TLS completion',()=>{
 for(const scheme of ['http','https']){
  const h=setup(scheme),s=h.open();h.agent.destroy();
  s.emit(scheme==='https'?'secureConnect':'connect');
  s.emit('data',Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
  assert.equal(s.writes.length,0);assert.equal(h.tls.length,scheme==='https'?1:0);
  assert.equal(h.results.length,0);assert.equal(h.clock.pending(),0);
  const ready=setup(scheme),proxy=ready.open(),target=ready.tunnel(proxy);ready.agent.destroy();
  target.emit('secureConnect');proxy.emit('data',Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));
  assert.equal(ready.results.length,0);assert.equal(ready.tls.length,scheme==='https'?2:1);
  assert.equal(target.destroyed,true);assert.equal(ready.clock.pending(),0);
 }
});
test('a failed connection ignores queued CONNECT and TLS success without a duplicate callback',()=>{
 for(const fail of ['tcp','tls','timeout']){
  const h=setup(),proxy=h.open(),target=fail==='tcp'?null:h.tunnel(proxy);
  if(fail==='timeout'){h.clock.advance(60000);h.clock.flush();}
  else (target||proxy).emit('error',Object.assign(Error('synthetic failure'),{code:'ECONNRESET'}));
  const count=h.tls.length;proxy.emit('connect');
  proxy.emit('data',Buffer.from('HTTP/1.1 200 Connection established\r\n\r\n'));target?.emit('secureConnect');
  assert.equal(h.results.length,1);assert.equal(h.tls.length,count);assert.equal(h.clock.pending(),0);
 }
});
test('one completed connection cannot cancel a different pending connection budget',()=>{
 const h=setup(),first=h.open(),second=h.open(),t=h.tunnel(first);h.clock.advance(1000);t.emit('secureConnect');assert.equal(h.results.length,1);assert.ok(h.clock.pending()>0);
 h.clock.advance(59000);h.clock.flush();assert.equal(h.results.length,2);assert.equal(h.results[1].error.code,'PROXY_CONNECT_TIMEOUT');assert.equal(t.destroyed,false);assert.equal(second.destroyed,true);assert.equal(h.clock.pending(),0);
});
test('shared budget retains original injected-clock/export behavior and stop semantics',()=>{
 const h=setup();let now=0;const budget=h.budget(100000,{now:()=>now,tickMs:1000,suspendThresholdMs:30000,autoStart:false});now=10000;assert.equal(budget.elapsedMs(),10000);now+=3600000;assert.equal(budget.elapsedMs(),12000);assert.equal(budget.suspendedMs(),3598000);budget.stop();now+=10000;assert.equal(budget.elapsedMs(),12000);
 const deep=fs.readFileSync(path.join(scripts,'deep-analyzer.js'),'utf8');assert.match(deep,/const \{ createActiveTimeBudget \} = require\('\.\/lib\/active-time-budget'\)/);assert.match(deep,/\n    createActiveTimeBudget,/);assert.doesNotMatch(deep,/function createActiveTimeBudget\(/);
});

test('HTTPS proxy TLS remains authenticated and both TLS layers share one non-resetting active budget',()=>{
 const h=setup('https'),proxy=h.open();assert.equal(proxy.options.rejectUnauthorized,true);assert.equal(proxy.options.servername,'127.0.0.1');
 h.clock.advance(30000);const target=h.tunnel(proxy);assert.equal(target.options.socket,proxy);assert.equal(target.options.rejectUnauthorized,true);h.clock.advance(30000);h.clock.flush();assert.equal(h.results.length,1);assert.equal(h.results[0].error.code,'PROXY_CONNECT_TIMEOUT');assert.equal(target.destroyed,true);assert.equal(h.clock.pending(),0);
 const bad=setup('https'),socket=bad.open(),error=Object.assign(Error('synthetic proxy certificate'),{code:'CERT_HAS_EXPIRED'});socket.emit('error',error);assert.equal(bad.results[0].error,error);assert.equal(bad.clock.pending(),0);
});

test('the exact Reader parser fingerprint changes when only the shared budget bytes change',()=>{
 const crypto=require('node:crypto'),deep=fs.readFileSync(path.join(scripts,'deep-analyzer.js'),'utf8');
 const marker='parserImplementationSha256: ',begin=deep.indexOf(marker),end=deep.indexOf("].join('\\0'))",begin);
 assert.ok(begin>=0&&end>begin);const expression=deep.slice(begin+marker.length,end+"].join('\\0'))".length);
 let repository=__dirname;while(!fs.existsSync(path.join(repository,'package.json'))){const parent=path.dirname(repository);assert.notEqual(parent,repository);repository=parent;}
 const actualScripts=path.join(repository,'scripts'),sharedPath=path.join(scripts,'lib/active-time-budget.js');
 const evaluate=changed=>{const observed=[];const digest=vm.runInNewContext(expression,{__filename:path.join(scripts,'deep-analyzer.js'),__dirname:scripts,path,
  fs:{readFileSync:(filename,encoding)=>{const relative=path.relative(scripts,filename);observed.push(relative);
   const actual=fs.existsSync(filename)?filename:path.join(actualScripts,relative);const value=fs.readFileSync(actual,encoding);
   return relative==='lib/active-time-budget.js'&&changed?value+'\n// synthetic helper-only implementation change\n':value;}},
  repair:{shaText:value=>crypto.createHash('sha256').update(value).digest('hex')}});return{digest,observed};};
 const before=evaluate(false),after=evaluate(true);assert.ok(before.observed.includes('lib/active-time-budget.js'));assert.deepEqual(after.observed,before.observed);assert.notEqual(before.digest,after.digest);
 assert.match(deep,/allowNewImplementationAllowance: false/);
});
