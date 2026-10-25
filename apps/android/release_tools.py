#!/usr/bin/env python3
"""Local Android release preparation/verification. Never creates keys/tags or installs/uploads."""
import argparse, contextlib, datetime, getpass, hashlib, importlib.util, json, os, pathlib, re, shutil, stat, struct, subprocess, sys, tempfile, xml.etree.ElementTree as ET, zipfile
if os.environ.get('CODEX_SANDBOX'): raise SystemExit('normal_environment_required')
P=pathlib.Path
APP='com.nanless.paperdigest'
ICON_SHA='18b7f280a530e6a881bc7017a1f78d6ba2c1a65741dea6a04116782433e3fbfb'
ANDROID='{http://schemas.android.com/apk/res/android}'
FIELDS=['group','module','version','classifier','type','extension','fileName','bytes','sha256']
SCIENTIFIC_SHAS={'01eea46037406eeb43c63141637968503eb2d6559eb3e399c198090e3864153c','60acc8f1d621516fa24c6594b7cda414860e4654a5b93ed040d02f8d65e95620','710ffddb9dfcfc1870ade398b5b8c44c9fb498ac5579753b02c7b664c70aaffc','49bdbf0a6534bccb8c8933030b1a8c0017471d6db5383412ee2ba425bc8a08a4'}
ABI={'arm64-v8a':(2,183),'armeabi-v7a':(1,40),'x86':(1,3),'x86_64':(2,62)}
PERMISSIONS={f'android.permission.{n}' for n in ['INTERNET','ACCESS_NETWORK_STATE','POST_NOTIFICATIONS','FOREGROUND_SERVICE','FOREGROUND_SERVICE_DATA_SYNC','WAKE_LOCK','RECEIVE_BOOT_COMPLETED']}|{APP+'.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION'}
COMPONENTS={'activity':{APP+'.MainActivity'},'provider':{'androidx.core.content.FileProvider',APP+'.pdf.PdfOriginalFileProvider','androidx.startup.InitializationProvider'},'service':{'androidx.work.impl.foreground.SystemForegroundService','androidx.pdf.service.PdfDocumentServiceImpl','androidx.work.impl.background.systemjob.SystemJobService','androidx.room.MultiInstanceInvalidationService'},'receiver':{'androidx.work.impl.utils.ForceStopRunnable$BroadcastReceiver','androidx.work.impl.background.systemalarm.RescheduleReceiver','androidx.work.impl.diagnostics.DiagnosticsReceiver','androidx.profileinstaller.ProfileInstallReceiver'}}
class ReleaseError(Exception): pass
class SafeParser(argparse.ArgumentParser):
 def error(self,message):raise ReleaseError('invalid_arguments')
def require(ok,code):
 if not ok: raise ReleaseError(code)
def sha(data): return hashlib.sha256(data).hexdigest()
def file_sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(65536),b''): h.update(b)
 return h.hexdigest()
def canonical(o): return json.dumps(o,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()
def load(p):
 def unique(pairs):
  o={}
  for key,value in pairs:require(key not in o,'duplicate_json_key');o[key]=value
  return o
 with open(p,'rb') as f:data=f.read(8*1024*1024+1)
 require(len(data)<=8*1024*1024,'record_size_limit');return json.loads(data.decode('utf-8','strict'),object_pairs_hook=unique,parse_constant=lambda _:require(False,'nonfinite_json'))
def write(p,o):
 with open(p,'xb') as f:f.write(canonical(o)+b'\n');f.flush();os.fsync(f.fileno())
def regular(p):
 p=P(p).absolute()
 for a in [*reversed(p.parents),p]: require(not a.is_symlink(),'symlink_path')
 require(p.is_file(),'missing_regular_file');return p

def run(argv,code,env=None):
 try:r=subprocess.run(list(map(str,argv)),stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,timeout=1200)
 except (OSError,subprocess.TimeoutExpired):raise ReleaseError(code) from None
 require(r.returncode==0,code);return r.stdout.decode('utf-8','strict')
def source_state(repo):
 repo=repo.resolve();require(not run(['git','-C',repo,'status','--porcelain=v1','--untracked-files=all'],'git_status').strip(),'source_dirty')
 oid=run(['git','-C',repo,'rev-parse','HEAD'],'git_head').strip();require(re.fullmatch('[0-9a-f]{40}',oid),'source_oid')
 paths=run(['git','-C',repo,'ls-files','-z','apps/android'],'git_inputs').split('\0');rows=[]
 for name in filter(None,paths):
  require(not P(name).name.lower().startswith('.env') and P(name).name.lower() not in {'local.properties','signing.properties','key.properties','keystore.properties'} and P(name).suffix.lower() not in {'.key','.jks','.keystore','.p12','.pfx','.pem'} and not any(x in {'.qa','.gradle','build'} for x in P(name).parts),'private_source_input')
  p=regular(repo/name);rows.append({'path':name,'bytes':p.stat().st_size,'sha256':file_sha(p)})
 require(rows,'source_inputs_missing');return {'sourceCommit':oid,'files':rows}
def check_source(repo,record): require(canonical(source_state(repo))==canonical(record),'source_changed')

class SDK:
 def __init__(self,root):
  self.root=P(root).resolve();self.bin=self.root/'build-tools/36.0.0';self.analyzer=self.root/'cmdline-tools/latest/bin/apkanalyzer'
  self.env=os.environ.copy();self.env.setdefault('JAVA_HOME','/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home')
  for p in [self.bin/'zipalign',self.bin/'apksigner',self.bin/'aapt2',self.analyzer]:regular(p)
 def call(self,name,*args):return run([self.analyzer if name=='apkanalyzer' else self.bin/name,*args],name+'_failed',self.env)
 def identities(self):
  return {'buildTools':'36.0.0','aapt2':self.call('aapt2','version').strip(),'apksigner':self.call('apksigner','version').strip(),'tools':{n:file_sha(p) for n,p in [('apksigner',self.bin/'apksigner'),('zipalign',self.bin/'zipalign'),('aapt2',self.bin/'aapt2'),('apkanalyzer',self.analyzer)]}}

def manifest_facts(text,version,code):
 root=ET.fromstring(text);app=root.find('application');sdk=root.find('uses-sdk')
 require(app is not None and sdk is not None,'manifest_structure')
 require(root.get('package')==APP and root.get(ANDROID+'versionName')==version and root.get(ANDROID+'versionCode')==str(code),'apk_identity')
 require(sdk.get(ANDROID+'minSdkVersion')=='28' and sdk.get(ANDROID+'targetSdkVersion')=='37','apk_sdk')
 require(app.get(ANDROID+'debuggable','false')=='false' and app.get(ANDROID+'testOnly','false')=='false','debug_or_test_apk')
 require(app.get(ANDROID+'allowBackup')=='false' and app.get(ANDROID+'usesCleartextTraffic')=='false','application_security')
 require(app.get(ANDROID+'name')==APP+'.PaperDigestApplication','application_class')
 permission_nodes=[e for e in root if e.tag.startswith('uses-permission')];require(all(e.tag in {'uses-permission','uses-permission-sdk-23','uses-permission-sdk-m'} for e in permission_nodes),'unknown_permission_declaration')
 permissions={x.get(ANDROID+'name') for x in permission_nodes};require(permissions==PERMISSIONS and len(permission_nodes)==len(permissions),'permission_set_changed')
 facts=[]
 for e in app:
  require(e.tag!='activity-alias','unexpected_component')
  if e.tag not in COMPONENTS:continue
  n=e.get(ANDROID+'name');require(n in COMPONENTS[e.tag],'unexpected_component')
  if n==APP+'.MainActivity':
   require(e.get(ANDROID+'icon',app.get(ANDROID+'icon'))==app.get(ANDROID+'icon'),'launcher_icon_override')
   require(e.get(ANDROID+'enabled','true')=='true' and app.get(ANDROID+'enabled','true')=='true','launcher_disabled')
   require(any(any(x.get(ANDROID+'name')=='android.intent.action.MAIN' for x in f.findall('action')) and any(x.get(ANDROID+'name')=='android.intent.category.LAUNCHER' for x in f.findall('category')) for f in e.findall('intent-filter')),'launcher_intent_missing')
  exported=e.get(ANDROID+'exported','false');permission=e.get(ANDROID+'permission')
  if exported=='true':require(n==APP+'.MainActivity' or permission in {'android.permission.DUMP','android.permission.BIND_JOB_SERVICE'},'unprotected_exported_component')
  if e.tag=='provider':require(exported=='false','exported_provider')
  facts.append({'kind':e.tag,'name':n,'exported':exported=='true','permission':permission})
 require(any(x['name']==APP+'.MainActivity' and x['exported'] for x in facts),'launcher_missing')
 return {'applicationId':APP,'versionName':version,'versionCode':code,'minSdk':28,'targetSdk':37,'debuggable':False,'testOnly':False,'permissions':sorted(permissions),'components':facts,'iconRef':app.get(ANDROID+'icon'),'roundIconRef':app.get(ANDROID+'roundIcon')}

def safe_members(z,require_apk=True):
 rows=z.infolist();seen=set();total=0
 for row in rows:
  n=row.filename;p=P(n);mode=row.external_attr>>16
  require(n and not n.startswith('/') and not n.endswith('//') and '\\'not in n and not any(x in ('','..','.') for x in n.rstrip('/').split('/')) and '\0' not in n,'unsafe_zip_path')
  require(n not in seen,'duplicate_zip_entry');seen.add(n)
  require(not row.flag_bits&1 and (stat.S_IFMT(mode) in (0,stat.S_IFREG,stat.S_IFDIR)),'zip_link_or_encryption')
  require(stat.S_IFMT(mode) in (0,stat.S_IFDIR if row.is_dir() else stat.S_IFREG),'zip_type_mismatch')
  lower=n.lower();parts=lower.split('/')
  require(not any(x in {'.env','.git','.qa','paperdigest','modelusage','runtime','vault','secrets'} for x in parts) and not P(lower).name.startswith('.env') and P(lower).name not in {'local.properties','signing.properties','key.properties','keystore.properties'} and not lower.endswith(('.jks','.keystore','.key','.p12','.pfx','.pem')),'private_payload_path')
  total+=row.file_size;require(row.file_size<=128*1024*1024 and total<=512*1024*1024,'zip_size_limit')
 if require_apk:require('AndroidManifest.xml' in seen and 'resources.arsc' in seen,'apk_structure')
 return rows

def payload_inventory(apk):
 rows=[]
 with zipfile.ZipFile(regular(apk)) as z:
  for item in safe_members(z,require_apk=False):
   digest=hashlib.sha256()
   with z.open(item) as source:
    for block in iter(lambda:source.read(65536),b''):digest.update(block)
   rows.append({'path':item.filename,'type':'directory' if item.is_dir() else 'file','bytes':item.file_size,'sha256':digest.hexdigest()})
 return sorted(rows,key=lambda item:item['path'])

def elf_facts(data,abi):
 require(len(data)>=64 and data[:4]==b'\x7fELF' and data[5]==1,'elf_header')
 cls=data[4];machine=struct.unpack_from('<H',data,18)[0];require((cls,machine)==ABI.get(abi),'elf_abi_mismatch')
 if cls==2:offset=struct.unpack_from('<Q',data,32)[0];size,count=struct.unpack_from('<HH',data,54);alignment=lambda at:struct.unpack_from('<Q',data,at+48)[0]
 else:offset=struct.unpack_from('<I',data,28)[0];size,count=struct.unpack_from('<HH',data,42);alignment=lambda at:struct.unpack_from('<I',data,at+28)[0]
 require(size>0 and count<1000 and offset+size*count<=len(data),'elf_program_headers');loads=[]
 for i in range(count):
  at=offset+size*i
  if struct.unpack_from('<I',data,at)[0]==1:loads.append(alignment(at))
 require(loads,'elf_no_load');return {'abi':abi,'loadAlignments':loads,'loadAlignmentAtLeast16KiB':all(x>=16384 for x in loads)}

def compiled_icon(apk,sdk,facts):
 table=sdk.call('aapt2','dump','resources',apk);entries={}
 for m in re.finditer(r'^\s*resource (0x[0-9a-f]+) ([^\s]+)\n(.*?)(?=^\s*(?:resource |type |Package)|\Z)',table,re.M|re.S):entries[m[2]]=(m[1],m[3])
 names=['mipmap/ic_launcher','drawable/icon_foreground','drawable/pd_icon','color/icon_background'];require(all(n in entries for n in names),'icon_resource_missing')
 refs={n:'@ref/'+entries[n][0] for n in names};paths={}
 for n in names[:3]:
  values=re.findall(r'\(file\) ([^\s]+) type=',entries[n][1]);require(len(values)==1,'icon_config_override');paths[n]=values[0]
 require(facts['iconRef']==refs['mipmap/ic_launcher'] and facts['roundIconRef']==refs['mipmap/ic_launcher'],'launcher_icon_reference')
 require(entries['color/icon_background'][1].strip()=='() #ff24282d','icon_background_changed')
 adaptive=ET.fromstring(sdk.call('apkanalyzer','resources','xml','--file','/'+paths['mipmap/ic_launcher'],apk))
 foreground=ET.fromstring(sdk.call('apkanalyzer','resources','xml','--file','/'+paths['drawable/icon_foreground'],apk))
 require(adaptive.tag=='adaptive-icon' and adaptive.find('background').get(ANDROID+'drawable')==refs['color/icon_background'] and adaptive.find('foreground').get(ANDROID+'drawable')==refs['drawable/icon_foreground'],'adaptive_icon_reference')
 require(foreground.tag=='inset' and foreground.get(ANDROID+'drawable')==refs['drawable/pd_icon'] and abs(float(foreground.get(ANDROID+'inset','').rstrip('%'))-16)<0.001,'adaptive_icon_foreground')
 return {'pngPath':paths['drawable/pd_icon'],'adaptiveReferenceVerified':True,'insetPercent':16,'background':'#ff24282d'}

NODE_AUDIT="""import {pathToFileURL} from 'node:url';import fs from 'node:fs/promises';
const [helper,assets,materials]=process.argv.slice(2),m=await import(pathToFileURL(helper));
const runtime=m.verifyRuntimeMaterials(JSON.parse(await fs.readFile(materials,'utf8'))),resources=await m.auditGeneratedAssets(assets,'release');
const licenses=JSON.parse(await fs.readFile(assets+'/licenses/manifest.json','utf8'));
console.log(JSON.stringify({runtime,resources,licenseRecords:licenses.resolvedRecordCount,licenseArtifacts:licenses.uniqueArtifactCount,licenseFiles:632,pendingArtifacts:licenses.pendingArtifacts}));"""
def inspect(apk,repo,sdk,version,code,materials,certificate=None):
 apk=regular(apk);before=file_sha(apk);facts=manifest_facts(sdk.call('apkanalyzer','manifest','print',apk),version,code);sdk.call('zipalign','-c','-P','16','4',apk)
 icon_binding=compiled_icon(apk,sdk,facts)
 with zipfile.ZipFile(apk) as z,tempfile.TemporaryDirectory(prefix='paperdigest-apk-audit-') as tmp:
  rows=safe_members(z);assets=P(tmp)/'assets';assets.mkdir();natives=[];icon=[]
  for row in rows:
   n=row.filename
   if row.is_dir():continue
   data=None
   h=hashlib.sha256()
   with z.open(row) as source:
    first=True
    for block in iter(lambda:source.read(65536),b''):
     if first:require(not block.startswith(b'%PDF-'),'embedded_pdf_in_apk');first=False
     h.update(block)
   require(h.hexdigest() not in SCIENTIFIC_SHAS,'scientific_original_in_apk')
   if n.startswith('assets/'):
    target=assets/n[len('assets/'):];target.parent.mkdir(parents=True,exist_ok=True)
    with z.open(row) as source,open(target,'xb') as dest:shutil.copyfileobj(source,dest,65536)
   if n.startswith('lib/'):
    parts=n.split('/');require(len(parts)==3 and parts[1] in ABI and n.endswith('.so'),'native_layout');data=z.read(row);natives.append({'path':n,'bytes':len(data),'sha256':sha(data),**elf_facts(data,parts[1])})
   if n.startswith('res/') and n.endswith('/pd_icon.png'):data=z.read(row);icon.append({'path':n,'sha256':sha(data)})
  require(len(icon)==1 and icon[0]['sha256']==ICON_SHA and icon[0]['path']==icon_binding['pngPath'],'c_icon_changed')
  require({x['abi'] for x in natives}==set(ABI),'universal_abi_set_changed')
  asset_info=json.loads(run(['node','--input-type=module','-e',NODE_AUDIT,'paperdigest-release-audit',repo/'apps/android/prepare-assets.mjs',assets,materials],'release_assets_failed'))
 signature=None
 if certificate:
  require(re.fullmatch('[0-9a-f]{64}',certificate),'certificate_pin_format')
  output=sdk.call('apksigner','verify','--verbose','--print-certs','--min-sdk-version','28','--max-sdk-version','37',apk)
  certs=re.findall(r'^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)$',output,re.M)
  require([value.lower() for value in certs]==[certificate] and 'CN=Android Debug' not in output,'release_certificate_mismatch')
  require('Verified using v2 scheme (APK Signature Scheme v2): true' in output and 'Verified using v3 scheme (APK Signature Scheme v3): true' in output,'signature_schemes')
  signature={'certificateSHA256':certificate,'v2':True,'v3':True,'verifiedMinSDK':28,'verifiedMaxSDK':37}
 require(file_sha(apk)==before,'audit_changed_apk')
 return {'sha256':before,'bytes':apk.stat().st_size,'manifest':facts,'assets':asset_info,'icon':{**icon[0],**icon_binding},'nativeLibraries':natives,'signature':signature,'formalDeviceTested':False,'publicationEligible':False}

def prepare(args):
 repo=args.repo.resolve();require(not args.output.exists(),'output_exists');require(re.fullmatch(r'[0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.-]+)?',args.version),'version_format')
 require(file_sha(regular(repo/'apps/android/release_tools.py'))==file_sha(regular(__file__)),'release_tool_not_promoted')
 before=source_state(repo);sdk=SDK(args.sdk);run([repo/'apps/android/build.sh',':app:assembleRelease'],'gradle_release_failed',sdk.env);check_source(repo,before)
 original=regular(repo/'apps/android/app/build/outputs/apk/release/app-release-unsigned.apk');materials=load(repo/'apps/android/app/build/intermediates/paperdigest/runtime-materials-release.json')
 projected={'contract':'android-runtime-build-materials-v1','artifacts':[{k:item[k] for k in FIELDS} for item in materials['artifacts']]}
 args.output.mkdir(mode=0o700,parents=False)
 try:
  write(args.output/'android-runtime-materials.json',projected);write(args.output/'android-source-inputs.json',before)
  # Align a new unsigned copy before signing. Never modify a signed APK.
  sdk.call('zipalign','-P','16','4',original,args.output/'unsigned.apk')
  audited=inspect(args.output/'unsigned.apk',repo,sdk,args.version,args.code,args.output/'android-runtime-materials.json')
  check_source(repo,before)
  info={'contract':'paperdigest-android-unsigned-v1','builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':before['sourceCommit'],'versionName':args.version,'versionCode':args.code,'compileSdk':37,'tools':sdk.identities(),'unsigned':audited,'sourceInputsSHA256':file_sha(args.output/'android-source-inputs.json'),'runtimeMaterialsSHA256':file_sha(args.output/'android-runtime-materials.json'),'sourceOIDEmbeddedInAPK':False}
  write(args.output/'android-build-info.json',info);return {'prepared':True,'signed':False,'publicationEligible':False,'sourceCommit':before['sourceCommit']}
 except BaseException:raise # Failed output is diagnostic, never silently reused.

def private_keystore(path,repo):
 path=regular(path).resolve(strict=True);require(not path.is_relative_to(repo.resolve()),'keystore_inside_repository')
 require(stat.S_IMODE(path.stat().st_mode)==0o600 and stat.S_IMODE(path.parent.stat().st_mode)==0o700 and path.stat().st_uid==os.geteuid() and path.parent.stat().st_uid==os.geteuid() and path.stat().st_nlink==1,'keystore_permissions');return path

def key_identity(path):
 value=path.stat();return (value.st_dev,value.st_ino,value.st_uid,value.st_mode,value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)

def sign(args):
 repo=args.repo.resolve();require(re.fullmatch('[0-9a-f]{64}',args.certificate),'certificate_pin_format');require(args.alias and not any(ord(c)<32 for c in args.alias),'signing_alias');source=args.prepared.resolve();info=load(source/'android-build-info.json');require(info['contract']=='paperdigest-android-unsigned-v1','unsigned_record')
 require(file_sha(source/'android-source-inputs.json')==info['sourceInputsSHA256'] and file_sha(source/'android-runtime-materials.json')==info['runtimeMaterialsSHA256'],'build_record_changed')
 inputs=load(source/'android-source-inputs.json');check_source(repo,inputs);require(inputs['sourceCommit']==info['sourceCommit'],'source_record_oid')
 require(file_sha(source/'unsigned.apk')==info['unsigned']['sha256'],'unsigned_changed');require(not args.output.exists(),'output_exists')
 unsigned_payload=payload_inventory(source/'unsigned.apk')
 key=private_keystore(args.keystore,repo);key_before=key_identity(key);require(sys.stdin.isatty(),'password_requires_tty')
 sdk=SDK(args.sdk);before=inspect(source/'unsigned.apk',repo,sdk,info['versionName'],info['versionCode'],source/'android-runtime-materials.json');require(before==info['unsigned'],'unsigned_audit_changed')
 args.output.mkdir(mode=0o700);apkname=f"paperdigest-android-{info['versionName']}-{info['versionCode']}-universal.apk";target=args.output/apkname
 env=sdk.env.copy()
 try:
  env['PD_RELEASE_STORE_PASSWORD']=getpass.getpass('本项目正式签名库密码：');env['PD_RELEASE_KEY_PASSWORD']=getpass.getpass('本项目正式签名密钥密码：')
  require(env['PD_RELEASE_STORE_PASSWORD'] and env['PD_RELEASE_KEY_PASSWORD'],'empty_signing_password')
  require(private_keystore(args.keystore,repo)==key and key_identity(key)==key_before,'keystore_changed')
  run([sdk.bin/'apksigner','sign','--ks',key,'--ks-key-alias',args.alias,'--ks-pass','env:PD_RELEASE_STORE_PASSWORD','--key-pass','env:PD_RELEASE_KEY_PASSWORD','--v1-signing-enabled','false','--v2-signing-enabled','true','--v3-signing-enabled','true','--v4-signing-enabled','false','--alignment-preserved','true','--debuggable-apk-permitted','false','--out',target,source/'unsigned.apk'],'signing_failed',env)
 finally:
  env.pop('PD_RELEASE_STORE_PASSWORD',None);env.pop('PD_RELEASE_KEY_PASSWORD',None)
 require(private_keystore(args.keystore,repo)==key and key_identity(key)==key_before,'keystore_changed')
 require(canonical(payload_inventory(target))==canonical(unsigned_payload),'signer_payload_changed')
 require(file_sha(source/'unsigned.apk')==info['unsigned']['sha256'],'unsigned_changed')
 audited=inspect(target,repo,sdk,info['versionName'],info['versionCode'],source/'android-runtime-materials.json',args.certificate);check_source(repo,inputs)
 for name in ['android-source-inputs.json','android-runtime-materials.json']:shutil.copyfile(source/name,args.output/name)
 signed={**info,'contract':'paperdigest-android-signed-v1','signed':audited,'unsignedPayload':unsigned_payload,'unsignedPayloadInventorySHA256':sha(canonical(unsigned_payload)),'signingTools':sdk.identities()};write(args.output/'android-build-info.json',signed)
 names=[apkname,'android-build-info.json','android-source-inputs.json','android-runtime-materials.json'];assets={n:{'sha256':file_sha(args.output/n),'bytes':(args.output/n).stat().st_size} for n in names}
 write(args.output/'android-release-manifest.json',{'contract':'paperdigest-android-release-v1','publicationEligible':False,'assets':assets})
 with open(args.output/'ANDROID-SHA256SUMS','x') as f:f.write(''.join(f"{item['sha256']}  {name}\n" for name,item in sorted(assets.items())))
 return verify(args.output,repo,sdk,args.certificate)

def verify(folder,repo,sdk,certificate):
 folder=P(folder).resolve();manifest=load(regular(folder/'android-release-manifest.json'));require(manifest['contract']=='paperdigest-android-release-v1','release_record');assets=manifest['assets']
 require(set(p.name for p in folder.iterdir())==set(assets)|{'android-release-manifest.json','ANDROID-SHA256SUMS'},'asset_set')
 for name,item in assets.items():
  require(P(name).name==name and name not in ('.','..'),'asset_name');p=regular(folder/name);require(p.stat().st_size==item['bytes'] and file_sha(p)==item['sha256'],'asset_changed')
 expected=''.join(f"{item['sha256']}  {name}\n" for name,item in sorted(assets.items()));require((folder/'ANDROID-SHA256SUMS').read_text()==expected,'checksum_file_changed')
 info=load(folder/'android-build-info.json');require(info['contract']=='paperdigest-android-signed-v1','signed_record');inputs=load(folder/'android-source-inputs.json');check_source(repo,inputs)
 require(inputs['sourceCommit']==info['sourceCommit'] and file_sha(folder/'android-source-inputs.json')==info['sourceInputsSHA256'] and file_sha(folder/'android-runtime-materials.json')==info['runtimeMaterialsSHA256'],'source_record')
 apks=[n for n in assets if n.endswith('.apk')];require(apks==[f"paperdigest-android-{info['versionName']}-{info['versionCode']}-universal.apk"],'apk_name_or_count');require(sha(canonical(info['unsignedPayload']))==info['unsignedPayloadInventorySHA256'] and canonical(payload_inventory(folder/apks[0]))==canonical(info['unsignedPayload']),'signed_payload_changed');actual=inspect(folder/apks[0],repo,sdk,info['versionName'],info['versionCode'],folder/'android-runtime-materials.json',certificate);require(actual==info['signed'],'signed_audit_changed')
 return {'verified':True,'sourceCommit':info['sourceCommit'],'version':info['versionName'],'versionCode':info['versionCode'],'apk':apks[0],'apkSHA256':actual['sha256'],'certificateSHA256':certificate,'publicationEligible':False}

def android_acceptance(path,expected):
 text=path.read_text();rows=re.findall(r'^\| (A-[A-Z]+-\d+) \|[^\n]*\| ([^|]+) \|$',text,re.M)
 # Reuse the existing Mac 69+17 IDs, mapped with A-; do not invent another inventory.
 require(len(rows)==86 and len(expected)==86 and {k for k,_ in rows}==expected and all(v.strip()=='通过' for _,v in rows),'android_acceptance_incomplete')

def mac_module(repo):
 spec=importlib.util.spec_from_file_location('paperdigest_mac_release',repo/'apps/macos/release_tools.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def joint_plan(args):
 android=verify(args.prepared,args.repo,SDK(args.sdk),args.certificate)
 mac=mac_module(args.repo);android_acceptance(args.android_acceptance,{'A-'+item for item in mac.IDS|mac.CLOUD_IDS});ns=argparse.Namespace(prepared=args.mac,repo=args.repo,acceptance_status=args.mac_acceptance,cloud_acceptance=args.mac_cloud,repository='nanless/audio-paper-digest',prerelease=False);plan=mac.publish_plan(ns)
 mac_info=load(args.mac/'build-info.json');require(android['sourceCommit']==mac_info['releaseHead'] and android['version']==mac_info['version'],'joint_release_identity')
 names=list(load(args.prepared/'android-release-manifest.json')['assets'])+['android-release-manifest.json','ANDROID-SHA256SUMS'];mac_names=list(load(args.mac/'release-manifest.json')['assets'])+['release-manifest.json','SHA256SUMS'];require(not set(names)&set(mac_names),'joint_asset_collision')
 argv=plan['argv'];at=argv.index('--repo');argv[at:at]=[str(args.prepared/n) for n in sorted(names)]
 return {**plan,'argv':argv,'androidSourceCommit':android['sourceCommit'],'macRuntimeSourceCommit':mac_info['sourceCommit'],'downloadVerificationRequired':True,'remoteTagOIDChecked':False,'formalQAInstallAndSameCertificateUpgrade':'must have separate actual evidence; never overwrite/wipe the two debug AVDs'}

def verify_downloaded(args):
 # Caller downloads with gh into a fresh directory. This function performs no network request.
 groups=[(args.prepared,'android-release-manifest.json'),(args.mac,'release-manifest.json')];expected={}
 for folder,manifest in groups:
  names=list(load(folder/manifest)['assets'])+[manifest,'ANDROID-SHA256SUMS' if manifest.startswith('android') else 'SHA256SUMS']
  for name in names:require(name not in expected,'joint_asset_collision');expected[name]=folder/name
 require(set(p.name for p in args.downloaded.iterdir())==set(expected),'download_asset_set')
 for name,original in expected.items():require(file_sha(regular(args.downloaded/name))==file_sha(regular(original)),'download_sha_mismatch')
 with tempfile.TemporaryDirectory(prefix='paperdigest-release-download-check-') as tmp:
  a=P(tmp)/'android';m=P(tmp)/'mac';a.mkdir();m.mkdir()
  for folder,manifest in groups:
   target=a if manifest.startswith('android') else m
   for name in list(load(folder/manifest)['assets'])+[manifest,'ANDROID-SHA256SUMS' if target==a else 'SHA256SUMS']:shutil.copyfile(args.downloaded/name,target/name)
  result=verify(a,args.repo,SDK(args.sdk),args.certificate);mac_module(args.repo).verify(m,args.repo)
 return {'downloadedAssetsSHAExact':True,'androidAPKReverified':True,'macArtifactsReverified':True,'assets':len(expected),'publicationEligible':False,'remoteTagOIDChecked':False,'apkSHA256':result['apkSHA256']}

def main():
 require(not os.environ.get('CODEX_SANDBOX'),'normal_environment_required')
 parser=SafeParser(description=__doc__);parser.add_argument('--repo',type=P,required=True);parser.add_argument('--sdk',type=P,default=P('/opt/homebrew/share/android-commandlinetools'));sub=parser.add_subparsers(dest='command',required=True)
 p=sub.add_parser('prepare');p.add_argument('--output',type=P,required=True);p.add_argument('--version',required=True);p.add_argument('--code',type=int,required=True)
 p=sub.add_parser('sign');p.add_argument('--prepared',type=P,required=True);p.add_argument('--output',type=P,required=True);p.add_argument('--keystore',type=P,required=True);p.add_argument('--alias',required=True);p.add_argument('--certificate',required=True)
 for name in ['verify','joint-plan','verify-downloaded']:
  p=sub.add_parser(name);p.add_argument('--prepared',type=P,required=True);p.add_argument('--certificate',required=True)
  if name!='verify':p.add_argument('--mac',type=P,required=True)
  if name=='joint-plan':
   for flag in ['android-acceptance','mac-acceptance','mac-cloud']:p.add_argument('--'+flag,type=P,required=True)
  if name=='verify-downloaded':p.add_argument('--downloaded',type=P,required=True)
 args=parser.parse_args();args.repo=args.repo.resolve()
 if args.command=='prepare':result=prepare(args)
 elif args.command=='sign':result=sign(args)
 elif args.command=='verify':result=verify(args.prepared,args.repo,SDK(args.sdk),args.certificate)
 elif args.command=='joint-plan':result=joint_plan(args)
 else:result=verify_downloaded(args)
 print(json.dumps(result,ensure_ascii=False,sort_keys=True))
if __name__=='__main__':
 try:main()
 except KeyboardInterrupt:print(json.dumps({'ok':False,'error':'cancelled'},ensure_ascii=False));sys.exit(130)
 except ReleaseError as error:print(json.dumps({'ok':False,'error':str(error)},ensure_ascii=False));sys.exit(1)
 except Exception:print(json.dumps({'ok':False,'error':'release_check_failed'},ensure_ascii=False));sys.exit(1)
