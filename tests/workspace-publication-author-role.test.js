'use strict';
// Actual role wrappers on private synthetic workspaces, not an author proof.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),child=require('node:child_process');
const root=process.cwd(),role=require(path.join(root,'scripts/workspace-role.js'));
test('author出版helper只在显式new-conference daily映射，旧history/无mode/未知helper和真实反向拒保留',t=>{
 const temp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'author-role-fixture-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const scripts=path.join(temp,'scripts');fs.mkdirSync(scripts);fs.copyFileSync(path.join(root,'scripts/workspace-role.js'),path.join(scripts,'workspace-role.js'));fs.copyFileSync(path.join(root,'scripts/env-loader.js'),path.join(scripts,'env-loader.js'));
 const helper='conference-publication-author-replay-cli.js';role.writeWorkspaceRole('daily',{root:temp});
 const invoke=(name,mode,wrapper)=>{
  const env={...process.env};delete env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE;delete env.AUDIO_PAPER_DIGEST_EXPECTED_WORKSPACE_ROLE;delete env.PD_WORKSPACE_ALLOW_CROSS_ROLE;if(mode!==undefined)env.AUDIO_PAPER_DIGEST_NEW_CONFERENCE_MODE=mode;
  const code='require('+JSON.stringify(path.join(scripts,'env-loader.js'))+').requireExternalRuntime('+JSON.stringify(name)+');process.stdout.write("runtime-role-ok")';
  return child.spawnSync(process.execPath,[path.join(scripts,'workspace-role.js'),'exec',wrapper,'--',process.execPath,'-e',code],{cwd:temp,env,encoding:'utf8',timeout:5000});
 };
 for(const name of [helper,'conference-reader-publication-evidence.js']){
  const current=invoke(name,'1','daily');assert.equal(current.status,0,current.stderr);assert.equal(current.stdout,'runtime-role-ok');
  for(const mode of [undefined,'0']){const denied=invoke(name,mode,'daily');assert.notEqual(denied.status,0);assert.match(denied.stderr,/role=history.*wrapper=daily/);}
 }
 for(const name of ['conference-publication-author-replay-cli','conference-unknown-internal.js']){const denied=invoke(name,'1','daily');assert.notEqual(denied.status,0);assert.match(denied.stderr,/role=history.*wrapper=daily/);}
 role.writeWorkspaceRole('history',{root:temp,force:true});const denied=invoke(helper,'1','daily');assert.notEqual(denied.status,0);assert.match(denied.stderr,/只允许 role=daily/);
 for(const mode of [undefined,'0','1']){const legacy=invoke(helper,mode,'history');assert.equal(legacy.status,0,legacy.stderr);assert.equal(legacy.stdout,'runtime-role-ok');}
});
