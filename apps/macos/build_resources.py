"""Unsigned resource staging for release/private QA. Never edits an existing signed app."""
import argparse,base64,hashlib,html,json,os,pathlib,re,shutil,stat,sys
CHANNELS={'release','private-qa'}
REQUIRED_LICENSES={'paper-digest','marked','lucide','katex','katex-fonts','font-ofl','node'}
def require(ok,message):
 if not ok:raise ValueError(message)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def relative(raw):
 require(isinstance(raw,str)and raw and '\\'not in raw,'资源路径无效');p=pathlib.PurePosixPath(raw);require(not p.is_absolute()and all(x not in ('','.','..')for x in raw.split('/')),'资源路径越界');return p
def regular(file):
 require(file.is_file()and not file.is_symlink(),'资源缺失或含链接');return file.read_bytes()
def copy_file(source,destination):
 raw=regular(source);destination.parent.mkdir(parents=True,exist_ok=True);require(not destination.exists()and not destination.is_symlink(),'拒绝覆盖已暂存资源');destination.write_bytes(raw)
def check_licenses(web,node_version=None):
 root=web/'licenses';manifest=json.loads(regular(root/'manifest.json'));require(manifest.get('contract')=='paper-digest-offline-licenses-v1','离线许可清单无效');rows=manifest.get('components');require(isinstance(rows,list)and {r.get('id')for r in rows}==REQUIRED_LICENSES and len(rows)==len(REQUIRED_LICENSES),'离线许可组件不完整或重复');allowed={'manifest.json'}
 for row in rows:
  p=relative(row['path']);require(len(p.parts)==1,'许可文件必须在固定目录');raw=regular(root/p);require(type(row.get('bytes'))is int and len(raw)==row['bytes']and sha(raw)==row['sha256'],'离线许可原文与清单不符');require(raw.decode('utf-8').strip(),'许可全文为空');allowed.add(str(p))
 require({p.name for p in root.iterdir()}==allowed,'离线许可目录有未登记文件')
 page=regular(web/'third-party-notices.html').decode('utf-8');require('Content-Security-Policy'in page and "default-src 'none'"in page,'离线许可页面缺少固定安全策略')
 for row in rows:require('<pre>'+html.escape(regular(root/row['path']).decode('utf-8'))+'</pre>'in page,'离线许可页面未完整嵌入原文')
 require(not re.search(r'(?:src|href)\s*=\s*["\'](?:https?:|//|file:|data:)',page,re.I),'许可页不得请求远端或其他本机资源')
 if node_version is not None:require(manifest.get('nodeVersion')==node_version,'当前Node版本缺少已固定的完整离线许可')
 return manifest

def scientific_rules(repo):
 sample_raw=regular(repo/'prototypes/macos-research/sample.json');sample=json.loads(sample_raw);hashes={sha(sample_raw)};fragments=[]
 for item in [sample['pdf'],*sample['figures']]:require(re.fullmatch('[a-f0-9]{64}',item.get('sha256','')),'样稿原件固定SHA无效');hashes.add(item['sha256'])
 for text in [sample.get('articleMarkdown'),sample.get('paper',{}).get('abstract')]:
  if isinstance(text,str)and len(text)>=256:fragments.extend([text.encode(),json.dumps(text,ensure_ascii=False)[1:-1].encode()])
 return hashes,fragments

def assert_no_scientific_seed(bundle_resources,repo):
 hashes,fragments=scientific_rules(repo);require(not (bundle_resources/'Seed').exists(),'正式包不得包含Seed目录')
 for p in bundle_resources.rglob('*'):
  require(not p.is_symlink(),'正式资源包含链接')
  if not p.is_file():continue
  raw=p.read_bytes();require(sha(raw)not in hashes and not raw.startswith(b'%PDF-'),'正式包包含论文样稿或重命名PDF')
  require(not any(fragment in raw for fragment in fragments),'正式包包含样稿正文或摘要')
  for m in re.finditer(rb'''(?<![A-Za-z0-9+.-])data:([^,"'<>]*),([^"'<>) ]*(?:[ \t\r\n][^"'<>)]*)?)''',raw,re.I):
   try:
    from urllib.parse import unquote_to_bytes
    payload=unquote_to_bytes(m.group(2))
    decoded=base64.b64decode(re.sub(rb'\s+',b'',payload),validate=True) if re.search(rb';\s*base64\s*$',m.group(1),re.I) else payload
   except ValueError:continue
   require(sha(decoded)not in hashes,'正式包包含内嵌科学样稿原图')
 return True

def stage(repo,app,resources,channel,node_version):
 require(channel in CHANNELS,'构建通道无效');require(resources.is_dir()and not resources.is_symlink(),'资源暂存不是普通目录');require(not (resources.parent.parent/'Contents/_CodeSignature').exists(),'不得修改已签名程序')
 web=resources/'Web';require(not web.exists(),'Web资源必须为全新暂存，不复用上个通道');web.mkdir()
 for source in sorted((app/'Resources').rglob('*')):
  require(not source.is_symlink(),'界面资源不能包含链接')
  if source.is_file():copy_file(source,web/source.relative_to(app/'Resources'))
 for name in ['marked.esm.js','lucide.min.js','MARKED-LICENSE.md','LUCIDE-LICENSE']:copy_file(repo/'prototypes/macos-research/vendor'/name,web/'vendor'/name)
 for source in sorted((app/'node_modules/katex/dist').rglob('*')):
  require(not source.is_symlink(),'KaTeX资源不能包含链接')
  if source.is_file():copy_file(source,web/'vendor/katex'/source.relative_to(app/'node_modules/katex/dist'))
 copy_file(app/'node_modules/katex/LICENSE',web/'vendor/katex/LICENSE');manifest=check_licenses(web,node_version)
 node=next(c for c in manifest['components']if c['id']=='node');copy_file(web/'licenses'/node['path'],resources/'Runtime/NODE-LICENSE')
 if channel=='private-qa':
  seed=resources/'Seed';sample_raw=regular(repo/'prototypes/macos-research/sample.json');sample=json.loads(sample_raw);seed.mkdir();(seed/'sample.json').write_bytes(sample_raw)
  for item in [sample['pdf'],*sample['figures']]:
   p=relative(item['src']);require(sha(regular(repo/'prototypes/macos-research/assets'/p))==item['sha256'],'私有验收原件SHA不符');copy_file(repo/'prototypes/macos-research/assets'/p,seed/'assets'/p)
  readme=repo/'prototypes/macos-research/assets/README.md'
  if readme.is_file():copy_file(readme,seed/'assets/README.md')
 else:assert_no_scientific_seed(resources,repo)
 return {'distributionChannel':channel,'licenseComponentCount':len(manifest['components']),'scientificSeedBundled':channel=='private-qa','nodeVersion':node_version}

def main():
 require(not os.environ.get('CODEX_SANDBOX'),'请在本机正常开发环境构建')
 p=argparse.ArgumentParser();p.add_argument('--repo',type=pathlib.Path,required=True);p.add_argument('--app',type=pathlib.Path,required=True);p.add_argument('--resources',type=pathlib.Path,required=True);p.add_argument('--channel',choices=sorted(CHANNELS),required=True);p.add_argument('--node-version',required=True);a=p.parse_args();print(json.dumps(stage(a.repo.resolve(),a.app.resolve(),a.resources,a.channel,a.node_version)))
if __name__=='__main__':main()
