"""Local release preparation. Never pushes tags or performs a GitHub mutation."""
import argparse, base64, ctypes, datetime, hashlib, json, os, pathlib, plistlib, re, shutil, stat, tarfile
import subprocess, sys, tempfile

sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from build_resources import check_licenses, assert_no_scientific_seed
CONTRACT = 'paper-digest-mac-release-v1'
REPO = pathlib.Path(__file__).resolve().parents[2]
FORBIDDEN = {'.git', '.env', '.qa', 'ModelUsage', 'personal.json', 'zotero-archives', 'backups'}
IDS = {f'{prefix}-{n:02d}' for prefix, count in [('APP', 9), ('DATA', 13), ('READ', 9), ('LIB', 3), ('NOTE', 3), ('EXP', 3), ('LLM', 10), ('JOB', 5), ('ZOT', 14)] for n in range(1, count + 1)}
CLOUD_IDS={f'{prefix}-{n:02d}' for prefix,count in [('CLOUD',12),('REL',5)] for n in range(1,count+1)}

class Rejected(Exception):
    pass

def require(condition, message):
    if not condition:
        raise Rejected(message)

def run(args, cwd=None):
    result = subprocess.run([str(x) for x in args], cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    require(result.returncode == 0, '工具检查失败：' + str(args[0]) + ' ' + result.stderr.decode(errors='replace')[:500])
    return result.stdout

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()

def load(path):
    return json.loads(path.read_bytes())

def extended_attributes(path):
    # Apple's bundled Python omits os.listxattr; use the documented Darwin libc
    # signatures. XATTR_NOFOLLOW also prevents an attribute read following a link.
    libc=ctypes.CDLL(None,use_errno=True)
    names=libc.listxattr;names.argtypes=[ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int];names.restype=ctypes.c_ssize_t
    read=libc.getxattr;read.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_uint32,ctypes.c_int];read.restype=ctypes.c_ssize_t
    raw_path=os.fsencode(path);size=names(raw_path,None,0,1);require(size>=0,'无法读取文件扩展属性')
    buffer=ctypes.create_string_buffer(size);actual=names(raw_path,buffer,size,1);require(actual>=0,'文件扩展属性在核验时变化')
    attrs=[x.decode() for x in buffer.raw[:actual].split(b'\0') if x]
    allowed={'com.apple.ResourceFork','com.apple.FinderInfo','com.apple.provenance','com.apple.quarantine'}
    require(set(attrs).issubset(allowed),'应用文件或目录含私人下载位置、注释或未知扩展属性')
    values={}
    for name in attrs:
        size=read(raw_path,name.encode(),None,0,0,1);require(0<=size<=16*1024*1024,'无法读取或超限的扩展属性')
        buffer=ctypes.create_string_buffer(size);actual=read(raw_path,name.encode(),buffer,size,0,1);require(actual>=0,'扩展属性在核验时变化');values[name]=digest(buffer.raw[:actual])
    return values

def safe_relative(value):
    require(isinstance(value, str) and value and '\\' not in value and '\x00' not in value, '清单路径无效')
    p = pathlib.PurePosixPath(value)
    require(not p.is_absolute() and all(x not in ('', '.', '..') for x in value.split('/')), '清单路径越界')
    require(not any(x in FORBIDDEN or x.startswith('.env.') for x in p.parts), '产物包含私人或运行目录')
    require(not (len(p.parts) >= 2 and p.parts[:2] == ('data', 'runtime')), '产物包含生产运行数据')
    return p

def inventory(app):
    require(app.is_dir() and not app.is_symlink() and app.suffix == '.app', '必须指定实际且非符号链接的.app')
    rows = [{'path':'','kind':'directory','mode':stat.S_IMODE(app.stat().st_mode),'attributes':extended_attributes(app)}]
    for root, directories, files in os.walk(app, followlinks=False):
        for name in sorted(directories + files):
            path = pathlib.Path(root) / name
            relative = path.relative_to(app).as_posix()
            safe_relative(relative)
            require(not path.is_symlink(), '应用包不能包含符号链接')
            info = path.stat()
            require(stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode), '应用包包含特殊文件')
            item={'path':relative,'kind':'file' if path.is_file() else 'directory','mode':stat.S_IMODE(info.st_mode),'attributes':extended_attributes(path)}
            if path.is_file():item.update(bytes=info.st_size,sha256=digest(path.read_bytes()))
            rows.append(item)
    return sorted(rows, key=lambda x: x['path'])

def git(repo, *args):
    return run(['git', '-C', repo, *args])

def docs_only(paths):
    return all(p.startswith('docs/') and p.endswith('.md') for p in paths)

def outside_mac_runtime(paths):
    # Android has an independent build. The two verifier files are not bundled
    # inputs; audit_app still compares every mapped Mac input with its old Git
    # byte and the current checkout, and rejects any extra bundle file.
    verification = {'apps/macos/release_tools.py', 'apps/macos/Tests/ReleasePackaging.test.py'}
    return all(docs_only([p]) or p.startswith('apps/android/') or p in verification for p in paths)

def source_state(repo, source_commit):
    require(re.fullmatch(r'[a-f0-9]{40}', source_commit or ''), '构建来源提交无效')
    require(git(repo, 'rev-parse', '--show-toplevel').decode().strip() == str(repo), '仓库根目录不匹配')
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    git(repo, 'merge-base', '--is-ancestor', source_commit, head)
    changed = git(repo, 'diff', '--name-only', '-z', source_commit, head).decode().strip('\0').split('\0')
    changed = [x for x in changed if x]
    require(outside_mac_runtime(changed), '当前HEAD与构建提交存在影响Mac来源的非文档变更；必须重新构建并验收')
    dirty = git(repo, 'status', '--porcelain=v1', '-z', '--untracked-files=all').decode().split('\0')
    # Reject all dirt, including documentation: qualification must bind a saved commit.
    require(not any(dirty), '工作区尚有未提交修改或未忽略文件，未准备发行产物')
    return head, changed

def source_path(relative):
    if relative.startswith('Seed/assets/') and relative!='Seed/assets/README.md':return None
    mapping = {'Sources/': 'apps/macos/Sources/', 'Build/': 'apps/macos/', 'Seed/': 'prototypes/macos-research/', 'Shared/': '', 'Assets/': 'apps/macos/Assets/'}
    for prefix, target in mapping.items():
        if relative.startswith(prefix):
            return target + relative[len(prefix):]
    if relative.startswith('Web/vendor/katex/'):
        return None
    if relative.startswith('Web/vendor/'):
        return 'prototypes/macos-research/vendor/' + relative[len('Web/vendor/'):]
    if relative.startswith('Web/'):
        return 'apps/macos/Resources/' + relative[len('Web/'):]
    return {'Contents/Info.plist': 'apps/macos/Info.plist', 'Contents/Resources/llm-worker.cjs': 'apps/macos/llm-worker.cjs'}.get(relative)

def physical_path(relative):
    if relative.startswith(('Sources/', 'Build/')):
        return None
    if relative.startswith('Contents/'):
        return relative
    return 'Contents/Resources/' + relative

def check_app_branding(plist, filename):
    # Only the exact shipped version/build pair uses the original branding.
    # Callers supply the actual bundle plist, never sidecar legacy assertions.
    legacy = plist.get('CFBundleShortVersionString') == '1.0.0' and plist.get('CFBundleVersion') == '1'
    expected = '论文速递' if legacy else '论文速递工作台'
    require(plist.get('CFBundleDisplayName') == plist.get('CFBundleName') == expected, '实际包内应用显示名不匹配')
    require(filename == expected + '.app', '实际应用文件名不匹配')

def audit_app(app, repo, record, version=None):
    rows = inventory(app)
    by_path = {row['path']: row for row in rows if row['kind']=='file'}
    metadata_path = app / 'Contents/Resources/build-metadata.json'
    metadata_raw = metadata_path.read_bytes(); metadata = json.loads(metadata_raw)
    require(metadata.get('contract') == 'paper-digest-mac-build-v1', '不支持的构建清单')
    require(isinstance(metadata.get('builtAt'), str), '构建时间无效')
    datetime.datetime.fromisoformat(metadata['builtAt'].replace('Z', '+00:00'))
    head, source_changes = source_state(repo, metadata.get('sourceCommit'))
    require(record.get('contract') == 'paper-digest-mac-signed-build-v1' and record.get('sourceCommit') == metadata['sourceCommit'] and record.get('builtAt') == metadata.get('builtAt'), '签名构建记录不是同一次候选')
    require(record.get('buildMetadataSHA256') == digest(metadata_raw), '构建清单SHA与审定记录不符')
    binary_record = record.get('binary') or {}
    require(set(binary_record) == {'path', 'bytes', 'sha256'}, '主程序记录含未知字段')
    require(binary_record.get('path') == 'Contents/MacOS/PaperDigest', '主程序记录无效')
    binary = by_path.get(binary_record['path']) or {}
    require(binary.get('sha256') == binary_record.get('sha256') and binary.get('bytes') == binary_record.get('bytes'), '已签名程序字节不属于审定候选')
    plist = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
    require(plist.get('CFBundleIdentifier') == 'com.nanless.PaperDigest' and plist.get('CFBundleExecutable') == 'PaperDigest', '应用身份不匹配')
    actual_version = plist.get('CFBundleShortVersionString', '')
    require(re.fullmatch(r'\d+\.\d+\.\d+', actual_version) and (version is None or version == actual_version), '请求版本与包内版本不一致')
    require(isinstance(plist.get('CFBundleVersion'), str) and re.fullmatch(r'\d+(?:\.\d+){0,2}', plist['CFBundleVersion']), '包内构建版本无效')
    check_app_branding(plist, app.name)
    arch = metadata.get('architecture'); require(arch in ['arm64', 'x86_64'], '构建架构无效')
    require(record.get('architecture') == arch and metadata.get('signing') == record.get('signing') == 'ad-hoc; not notarized', '当前机制仅处理如实声明的本机ad-hoc未公证包')
    require(plist.get('LSMinimumSystemVersion') == '15.0', '最低系统声明发生变化，需更新发行核验规则')
    for executable in [app / 'Contents/MacOS/PaperDigest', app / 'Contents/Resources/Runtime/node']:
        run(['/usr/bin/codesign', '--verify', '--strict', executable])
        signature = subprocess.run(['/usr/bin/codesign', '-dv', '--verbose=4', str(executable)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        require(signature.returncode == 0 and b'Signature=adhoc' in signature.stderr and b'TeamIdentifier=not set' in signature.stderr, '实际签名与ad-hoc声明不同')
        architectures = run(['/usr/bin/lipo', '-archs', executable]).decode().strip().split()
        require(architectures == [arch], '实际可执行文件架构与构建声明不一致')
        build = run(['/usr/bin/xcrun', 'vtool', '-show-build', executable]).decode()
        minimums = re.findall(r'\bminos\s+(\d+(?:\.\d+){0,2})', build)
        require(minimums and all((tuple(map(int, x.split('.'))) + (0, 0))[:3] <= (15, 0, 0) for x in minimums), '可执行文件最低系统高于macOS15')
    run(['/usr/bin/codesign', '--verify', '--deep', '--strict', app])
    entries = metadata.get('files'); require(isinstance(entries, list) and entries, '构建输入为空')
    channel=metadata.get('distributionChannel','legacy-private-qa')
    require(channel in ['release','private-qa','legacy-private-qa'] and (channel!='legacy-private-qa' or 'distributionChannel'not in metadata),'构建通道字段无效')
    fixed_inputs=fixed_public_inputs(repo,metadata['sourceCommit'],channel)
    seen = set(); physical = set(); source_files = set()
    for entry in entries:
        relative = entry.get('path'); safe_relative(relative)
        require(relative not in seen, '构建清单含重复路径'); seen.add(relative)
        require(re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', '')) and type(entry.get('bytes')) is int and entry['bytes'] >= 0, '构建输入摘要格式无效')
        destination = physical_path(relative)
        if destination:
            require(destination in by_path, '构建清单对应实物缺失')
            require(by_path[destination]['sha256'] == entry['sha256'] and by_path[destination]['bytes'] == entry['bytes'], '打包输入与实际文件字节不同')
            physical.add(destination)
        mapped = source_path(relative)
        if mapped:
            safe_relative(mapped); raw = git(repo, 'show', metadata['sourceCommit'] + ':' + mapped)
            require(digest(raw) == entry['sha256'] and len(raw) == entry['bytes'], '构建源码与来源Git字节不匹配')
            require((repo / mapped).read_bytes() == raw, '当前源码输入已变化')
            source_files.add(mapped)
        elif relative in fixed_inputs:
            require(entry['sha256']==fixed_inputs[relative]['sha256'] and (fixed_inputs[relative].get('bytes') is None or entry['bytes']==fixed_inputs[relative]['bytes']),'固定公开资产与来源锁定字节不符')
        else:
            require(relative in ['Contents/Resources/AppIcon.icns', 'Contents/Resources/Runtime/node', 'Contents/Resources/Runtime/NODE-LICENSE'], '未知非Git构建输入')
    require(set(fixed_inputs).issubset(seen),'构建清单遗漏锁定的公开资产')
    tracked_sources = {x for x in git(repo, 'ls-tree', '-r', '--name-only', metadata['sourceCommit'], 'apps/macos/Sources').decode().splitlines() if x.endswith('.swift')}
    require(tracked_sources and tracked_sources.issubset(source_files), '构建清单遗漏原生源码')
    tracked_build = {'apps/macos/build.sh', 'apps/macos/Info.plist', 'apps/macos/llm-worker.cjs'}
    if channel!='legacy-private-qa':tracked_build.add('apps/macos/build_resources.py')
    require(tracked_build.issubset(source_files), '构建清单遗漏构建、配置或模型组件')
    permitted = physical | {'Contents/MacOS/PaperDigest', 'Contents/Resources/build-metadata.json', 'Contents/_CodeSignature/CodeResources'}
    require(set(by_path) == permitted, '应用包含未列明的额外文件或缺少签名文件')
    require('Contents/Resources/Runtime/NODE-LICENSE' in by_path, '未包含Node许可')
    if channel!='legacy-private-qa':
        license_manifest=check_licenses(app/'Contents/Resources/Web')
        node_version=run(['/usr/bin/env','-i','PATH=/usr/bin:/bin',app/'Contents/Resources/Runtime/node','--version']).decode('ascii').strip()
        require(node_version==license_manifest.get('nodeVersion'),'Node实际版本没有绑定离线许可')
        node_notice=next(x for x in license_manifest['components']if x['id']=='node')
        require((app/'Contents/Resources/Runtime/NODE-LICENSE').read_bytes()==(app/'Contents/Resources/Web/licenses'/node_notice['path']).read_bytes(),'Node运行组件许可与固定全文不一致')
    if channel=='release':assert_no_scientific_seed(app/'Contents/Resources',repo)

    return {'distributionChannel':channel,'sourceCommit': metadata['sourceCommit'], 'releaseHead': head, 'documentationOnlyChanges': [p for p in source_changes if docs_only([p])], 'otherNonRuntimeChanges': [p for p in source_changes if not docs_only([p])], 'builtAt': metadata['builtAt'], 'version': actual_version, 'bundleVersion': plist['CFBundleVersion'], 'architecture': arch, 'minimumMacOS': '15.0', 'signing': 'ad-hoc; not notarized', 'metadataSHA256': digest(metadata_raw), 'binary': binary_record, 'bundleInventorySHA256': digest(canonical(rows)), 'fileCount': len(by_path), 'record': {k: record[k] for k in ['contract', 'builtAt', 'sourceCommit', 'architecture', 'signing', 'buildMetadataSHA256', 'binary']}}

def fixed_public_inputs(repo,commit,channel="private-qa"):
    result={}
    if channel in ['private-qa','legacy-private-qa']:
        sample=json.loads(git(repo,'show',commit+':prototypes/macos-research/sample.json'))
        require(isinstance(sample.get('pdf'),dict) and isinstance(sample.get('figures'),list),'公开样稿缺少固定PDF/图片清单')
        for asset in [sample['pdf'],*sample['figures']]:
            src=asset.get('src');safe_relative(src)
            require(re.fullmatch(r'[a-f0-9]{64}',asset.get('sha256','')) is not None,'公开样稿资产SHA无效')
            relative='Seed/assets/'+src;require(relative not in result,'公开样稿资产路径重复')
            result[relative]={'sha256':asset['sha256']}
    package=json.loads(git(repo,'show',commit+':apps/macos/package.json'))
    lock=json.loads(git(repo,'show',commit+':apps/macos/package-lock.json'))
    pinned=lock.get('packages',{}).get('node_modules/katex',{});version=pinned.get('version','')
    require(re.fullmatch(r'\d+\.\d+\.\d+',version) is not None and package.get('dependencies',{}).get('katex')==version,'KaTeX版本没有按Git精确锁定')
    require(pinned.get('resolved')=='https://registry.npmjs.org/katex/-/katex-'+version+'.tgz','KaTeX锁定来源不是官方npm归档')
    integrity=pinned.get('integrity','');require(integrity.startswith('sha512-'),'KaTeX归档缺少SHA512完整性绑定')
    expected=base64.b64decode(integrity[7:],validate=True);require(len(expected)==64,'KaTeX归档完整性格式无效')
    key=expected.hex();cache=pathlib.Path(os.environ.get('PD_RELEASE_NPM_CACHE',str(pathlib.Path.home()/'.npm')))
    archive=cache/'_cacache/content-v2/sha512'/key[:2]/key[2:4]/key[4:]
    require(archive.is_file() and not archive.is_symlink() and archive.stat().st_size<=8*1024*1024,'缺少锁定KaTeX的只读npm内容缓存，请先正常安装锁定依赖')
    raw=archive.read_bytes();require(hashlib.sha512(raw).digest()==expected,'npm缓存KaTeX归档SHA512不符')
    import io
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as tar:
        count=0;total=0;names=set();package_version=None
        for member in tar:
            safe_relative(member.name.rstrip('/'));require(not member.issym() and not member.islnk(),'锁定KaTeX归档含链接')
            require(member.name not in names,'KaTeX归档含重复路径');names.add(member.name)
            if not member.isfile():continue
            if member.name=='package/package.json':package_version=json.loads(tar.extractfile(member).read()).get('version')
            if not (member.name.startswith('package/dist/') or member.name=='package/LICENSE'):continue
            count+=1;total+=member.size;require(count<=1000 and total<=32*1024*1024,'KaTeX分发归档超限')
            data=tar.extractfile(member).read()
            tail='LICENSE' if member.name=='package/LICENSE' else member.name[len('package/dist/'):]
            result['Web/vendor/katex/'+tail]={'bytes':len(data),'sha256':digest(data)}
        require(package_version==version and count>1,'KaTeX归档版本或分发文件不符')
    return result

def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def prepare(args):
    require(not args.app.is_symlink(),'应用根不能是符号链接')
    app=args.app.resolve(); repo=args.repo.resolve(); output=args.output.resolve()
    require(not output.exists(), '输出目录已存在；不会覆盖任何既有产物')
    require(output != app and app not in output.parents, '输出目录不能位于应用包内')
    info=audit_app(app, repo, load(args.build_record), args.version)
    require(info['distributionChannel']!='legacy-private-qa','历史缺通道构建仅可inspect，不能准备新发行产物')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary=pathlib.Path(tempfile.mkdtemp(prefix='.release-prepare-', dir=output.parent))
    try:
        with tempfile.TemporaryDirectory(prefix='paperdigest-release-stage-') as tmp:
            stage=pathlib.Path(tmp); copy=stage/app.name
            run(['/usr/bin/ditto', app, copy]); require(inventory(copy)==inventory(app), '打包副本改变了原应用字节、模式或资源fork')
            run(['/usr/bin/codesign', '--verify', '--deep', '--strict', copy])
            prefix=f'PaperDigest-'+('private-qa-' if info['distributionChannel']=='private-qa' else '')+f'macOS-{info["version"]}-{info["architecture"]}'
            archive=temporary/(prefix+'.zip')
            run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', copy, archive])
            if args.dmg:
                os.symlink('/Applications', stage/'Applications')
                run(['/usr/bin/hdiutil', 'create', '-volname', '论文速递工作台 '+info['version'], '-srcfolder', stage, '-format', 'UDZO', '-ov', temporary/(prefix+'.dmg')])
        # Decode the produced ZIP and verify its exact bundle, not merely its archive listing.
        verify_zip(archive, repo, info, app.name)
        build_info={'contract': CONTRACT, 'preparedAtUTC': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'publicationEligible': False, 'publicationState': 'local-candidate-only', 'bundleName': app.name, **info}
        write_json(temporary/'build-info.json', build_info)
        notes=f'''# 论文速递工作台 {info['version']} · 可校验安装包

本地准备工具不会创建或推送版本标签，也不会上传或公开 GitHub Release。是否已交付以远端实际状态及对应验收记录为准；打包成功不能替代完整验收。

- 架构：{info['architecture']}；最低 macOS 15。
- 包内版本：{info['version']}，构建号 {info['bundleVersion']}。
- 运行源码提交：{info['sourceCommit']}。
- 发行候选对应提交：{info['releaseHead']}；允许的来源差异按核验记录分类，包括已提交文档、独立Android树与两份Mac发行验证文件；所有映射Mac输入仍须逐字一致。
- 签名：本机 ad-hoc 开发签名，未 Apple 公证；没有宣称其他 Mac 可无阻碍安装。
- ZIP 保留应用资源与签名；若包含 DMG，可将应用拖到 Applications。
- 现有网站成果由客户端直接读取；个人资料与密钥不放入发行包。包内自带运行组件及许可。
- 使用 SHA256SUMS 核对文件完整性；校验和不能替代 Apple 身份签名、完整验收或独立审查。

## 同一 Release 附带 Android APK 时

- Android 安装资产须为独立 release 签名 APK，非 debug 包。实际版本、versionCode、签名证书 SHA-256、最低/目标 SDK 和 ABI，以同次 android-build-info.json 及真实 APK 核验记录为准；本 Mac 打包工具不会替 Android 资产签发验收。
- 模拟器验收不等于实体机或 Google Play 发布验证；仅声明本次实际覆盖的设备、系统与功能范围。Zotero、HTML 导出及外部附件的支持边界以对应验收记录为准，不承诺任意 HTML 或所有第三方客户端都兼容。
- 升级须核对相同应用标识、签名连续和递增 versionCode，按本次验证的升级路径保留本机资料；不要通过卸载或清空资料代替升级。跨端功能和数据边界分别按各端记录核对。调试包或不同签名的旧包不能据此认定可直接覆盖；先在旧版完成并核验完整备份，未确认可恢复前不要卸载或清空资料，设备凭据须本机重新配置。
- 模型、网盘和 Zotero 凭据由用户在自己的设备本机配置；安装包与 Release 附件不内置账号、口令、私钥、生产配置或私人研究材料。

公开前须核对最终说明、全部适用验收、同一远端草稿及下载实包。本文只说明固定安装资产及签名范围，不提前宣告未完成条件通过。
'''
        (temporary/'RELEASE_NOTES.md').write_text(notes)
        assets={p.name:{'bytes':p.stat().st_size,'sha256':digest(p.read_bytes())} for p in sorted(temporary.iterdir()) if p.is_file()}
        write_json(temporary/'release-manifest.json', {'contract': CONTRACT, 'publicationEligible': False, 'assets': assets})
        (temporary/'SHA256SUMS').write_text(''.join(digest(p.read_bytes())+'  '+p.name+'\n' for p in sorted(temporary.iterdir()) if p.is_file()))
        verify(temporary, repo)
        os.rename(temporary, output)
        return {'output':str(output),'version':info['version'],'architecture':info['architecture'],'publicationEligible':False,'artifacts':sorted(p.name for p in output.iterdir())}
    except BaseException:
        shutil.rmtree(temporary, ignore_errors=True)
        raise

def verify_zip(archive, repo, info, name):
    import zipfile
    require(isinstance(name,str) and len(safe_relative(name).parts)==1 and name.endswith('.app'),'归档应用名无效')
    with zipfile.ZipFile(archive) as z:
        seen=set()
        for entry in z.infolist():
            # ditto writes UTF-8 names without ZIP's UTF-8 flag; zipfile otherwise
            # exposes those bytes as CP437. Validate the names ditto will extract.
            name_text=entry.filename if entry.flag_bits&0x800 else entry.filename.encode('cp437').decode('utf-8')
            p=pathlib.PurePosixPath(name_text.rstrip('/'))
            require(not p.is_absolute() and '..' not in p.parts and '\\' not in name_text, 'ZIP含越界路径')
            require(name_text not in seen,'ZIP含重复条目');seen.add(name_text)
            require(not stat.S_ISLNK(entry.external_attr>>16),'ZIP不能含符号链接')
            require(p.parts and p.parts[0] in [name, '__MACOSX'], 'ZIP含应用之外的内容')
            if p.parts[0]=='__MACOSX':
                require(len(p.parts)==1 or p.parts[1] in [name,'._'+name],'ZIP资源fork目录不属于本应用')
                require(entry.is_dir() or p.name.startswith('._'),'ZIP资源fork目录含其他文件')
    with tempfile.TemporaryDirectory(prefix='paperdigest-release-readback-') as tmp:
        run(['/usr/bin/ditto', '-x', '-k', archive, tmp])
        copied=pathlib.Path(tmp)/name
        checked=audit_app(copied, repo, info['record'], info['version'])
        require(checked['bundleInventorySHA256']==info['bundleInventorySHA256'], 'ZIP回读与原审定应用不一致')
        require(checked['distributionChannel']==info.get('distributionChannel'),'外层通道声明与签名包不一致')
        require(all(checked[k]==info.get(k) for k in ['sourceCommit','metadataSHA256','version','bundleVersion','architecture','minimumMacOS','signing','binary']),'外层发行身份与签名包不一致')

def verify(output, repo):
    require(output.is_dir() and not output.is_symlink(), '产物目录无效')
    info=load(output/'build-info.json'); manifest=load(output/'release-manifest.json')
    require(info.get('contract')==manifest.get('contract')==CONTRACT and info.get('publicationEligible') is False and manifest.get('publicationEligible') is False, '候选状态被错误改成正式发布')
    require(isinstance(manifest.get('assets'),dict), '资产清单无效')
    expected=set(manifest['assets'])|{'release-manifest.json','SHA256SUMS'}
    require({p.name for p in output.iterdir()}==expected, '产物目录有额外或缺少文件')
    sums={}
    for line in (output/'SHA256SUMS').read_text().splitlines():
        match=re.fullmatch(r'([a-f0-9]{64})  ([^/\\]+)',line); require(match is not None,'校验和格式无效')
        require(match[2] not in sums,'校验和文件名重复');sums[match[2]]=match[1]
    require(set(sums)==expected-{'SHA256SUMS'},'校验和没有覆盖全部产物')
    for name in expected-{'SHA256SUMS'}:
        safe_relative(name); p=output/name; require(p.is_file() and not p.is_symlink(),'资产不能是符号链接或目录')
        require(digest(p.read_bytes())==sums[name], '产物SHA不符')
    for name, expected_file in manifest['assets'].items():
        p=output/name;require(p.stat().st_size==expected_file.get('bytes') and digest(p.read_bytes())==expected_file.get('sha256'),'产物与资产清单不符')
    archives=[output/name for name in manifest['assets'] if name.endswith('.zip')];require(len(archives)==1,'必须恰有一个应用ZIP')
    source_state(repo,info['sourceCommit'])
    verify_zip(archives[0],repo,info,info['bundleName'])
    for name in manifest['assets']:
        if name.endswith('.dmg'):verify_dmg(output/name,repo,info)
    return {'verified':True,'publicationEligible':False,'sourceCommit':info['sourceCommit'],'version':info['version']}

def verify_dmg(image, repo, info):
    import time
    run(['/usr/bin/hdiutil','verify',image])
    temporary=pathlib.Path(tempfile.mkdtemp(prefix='paperdigest-dmg-readback-'))
    mount=temporary/'mounted';mount.mkdir()
    failures=[]
    def require_own_mount():
        require(os.path.ismount(mount),'DMG实际挂载未确认；未读取挂载内容')
        images=plistlib.loads(run(['/usr/bin/hdiutil','info','-plist'])).get('images',[])
        owners=[item for item in images for entity in item.get('system-entities',[])
                if os.path.realpath(entity.get('mount-point',''))==os.path.realpath(mount)]
        require(len(owners)==1 and os.path.realpath(owners[0].get('image-path',''))==os.path.realpath(image),'DMG挂载归属未确认；保留临时目录，未读取、卸载或删除')
    try:
        run(['/usr/bin/hdiutil','attach','-readonly','-nobrowse','-noautoopen','-mountpoint',mount,image])
        require_own_mount()
        names={p.name for p in mount.iterdir()}
        require(names.issuperset({info['bundleName'],'Applications'}) and names.issubset({info['bundleName'],'Applications','.fseventsd','.Trashes','.DS_Store','.VolumeIcon.icns'}),'DMG含未知内容或缺少拖入目标')
        link=mount/'Applications'
        require(link.is_symlink() and os.readlink(link)=='/Applications','DMG拖入目标不是系统Applications')
        checked=audit_app(mount/info['bundleName'],repo,info['record'],info['version'])
        require(checked['bundleInventorySHA256']==info['bundleInventorySHA256'],'DMG内实际应用与ZIP审定应用不同')
    except BaseException as error:
        failures.append(('DMG核验',error))
    try:
        # An attach error can still leave a real mount. Detach only this image's
        # exact private mountpoint; never walk/delete a live or unrelated volume.
        if os.path.ismount(mount):
            for attempt in range(3):
                if not os.path.ismount(mount):break
                require_own_mount() # Fresh ownership before every normal detach.
                try:
                    run(['/usr/bin/hdiutil','detach',mount])
                    break
                except Rejected as error:
                    if attempt==2 or not re.search(r'(?:[Rr]esource busy|资源忙)',str(error)):
                        raise
                    print('DMG正常卸载暂时忙，短暂等待后重试（'+str(attempt+1)+'/3）：'+str(error),file=sys.stderr)
                    time.sleep(0.25)
            require(not os.path.ismount(mount),'DMG挂载未释放；保留临时目录，未删除')
    except BaseException as error:
        failures.append(('DMG卸载',error))
    try:
        if not os.path.ismount(mount):
            # rmdir can only remove empty directories, including during a race.
            mount.rmdir();temporary.rmdir()
    except BaseException as error:
        failures.append(('DMG临时目录清理',error))
    if len(failures)==1:
        raise failures[0][1]
    if failures:
        raise Rejected('；'.join(phase+'：'+str(error) for phase,error in failures)) from failures[0][1]

def verified_remote_tag(tag, head):
    # Fixed repository, exact tag and optional peeled annotated-tag commit. Read only.
    ref='refs/tags/'+tag
    raw=run(['git','ls-remote','--tags','https://github.com/nanless/audio-paper-digest.git',ref,ref+'^{}']).decode('ascii')
    rows=[line.split('\t') for line in raw.splitlines()]
    require(rows and all(len(row)==2 and re.fullmatch('[a-f0-9]{40}',row[0]) and row[1] in {ref,ref+'^{}'} for row in rows),'远端标签记录无效')
    refs={name:oid for oid,name in rows}
    require(len(refs)==len(rows) and ref in refs and refs.get(ref+'^{}',refs[ref])==head,'远端版本标签未指向固定发行提交')
    return {'tag':tag,'commitOID':head,'annotated':ref+'^{}' in refs}

def publish_plan(args, private_draft=False):
    verify(args.prepared.resolve(),args.repo.resolve())
    text=args.acceptance_status.read_text(); rows=re.findall(r'^\| ((?:APP|DATA|READ|LIB|NOTE|EXP|LLM|JOB|ZOT)-\d+) \| ([^|]+) \|',text,re.M)
    require(len(rows)==69 and {row[0] for row in rows}==IDS and all(row[1].strip()=='通过' for row in rows),'69项适用必测验收尚未全部通过；不能生成公开发行命令')
    cloud_file=args.cloud_acceptance or args.repo/'docs/mac-app-cloud.md'
    extra=re.findall(r'^\| ((?:CLOUD|REL)-\d+) \| ([^|]+) \|',cloud_file.read_text(),re.M)
    require(len(extra)==17 and {row[0] for row in extra}==CLOUD_IDS and all(row[1].strip() in ({'通过','待验'} if private_draft and row[0] in {'REL-03','REL-04'} else {'通过'}) for row in extra),'新增云端与发行17项尚未全部通过；不能生成公开发行命令')
    info=load(args.prepared/'build-info.json')
    require(info.get('distributionChannel')=='release','私有QA或历史构建不能用于正式发行')
    head,_=source_state(args.repo.resolve(),info['sourceCommit'])
    require(head==info['releaseHead'],'HEAD已变化，需基于最终提交重新准备产物')
    require(args.repository=='nanless/audio-paper-digest','必须明确使用当前仓库')
    tag=verified_remote_tag('v'+info['version'],head) if private_draft else None
    assets=[str(args.prepared.resolve()/name) for name in sorted(load(args.prepared/'release-manifest.json')['assets'])]+[str(args.prepared.resolve()/'release-manifest.json'),str(args.prepared.resolve()/'SHA256SUMS')]
    command=['gh','release','create','v'+info['version'],*assets,'--repo',args.repository,'--verify-tag','--target',head,'--title','论文速递工作台 '+info['version'],'--notes-file',str(args.prepared.resolve()/'RELEASE_NOTES.md'),'--draft']
    if private_draft:command[command.index('--repo')+1]='github.com/nanless/audio-paper-digest'
    if args.prerelease:command.append('--prerelease')
    return {'stage':'private-draft' if private_draft else 'fully-qualified-draft','remoteTag':tag,'executed':False,'automaticTagCreation':False,'publicPublication':False,'qualification':('84项前置验收通过，REL-03/04仅可通过或待验；只准创建私有草稿，不能公开' if private_draft else '原69项及新增云端与发行17项通过只是本地门，维护者仍须复核对应包的实际证据；命令仅创建草稿'),'requiresExistingRemoteTag':'v'+info['version'],'argv':command}

def main():
    require(not os.environ.get('CODEX_SANDBOX'),'请在本机正常开发环境准备发行产物')
    require(sys.platform=='darwin','发行产物检查需要真实macOS工具，未模拟通过')
    parser=argparse.ArgumentParser(description='只读检查或本地打包；不推tag、不上传、不创建远端Release')
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ['inspect','prepare']:
        p=sub.add_parser(name);p.add_argument('--app',type=pathlib.Path,required=True);p.add_argument('--repo',type=pathlib.Path,default=REPO);p.add_argument('--build-record',type=pathlib.Path,required=True);p.add_argument('--version')
        if name=='prepare':p.add_argument('--output',type=pathlib.Path,required=True);p.add_argument('--dmg',action='store_true')
    for name in ['verify','publish-plan','private-draft-plan']:
        p=sub.add_parser(name);p.add_argument('--prepared',type=pathlib.Path,required=True);p.add_argument('--repo',type=pathlib.Path,default=REPO)
        if name in {'publish-plan','private-draft-plan'}:p.add_argument('--acceptance-status',type=pathlib.Path,required=True);p.add_argument('--cloud-acceptance',type=pathlib.Path);p.add_argument('--repository',default='nanless/audio-paper-digest');p.add_argument('--prerelease',action='store_true')
    args=parser.parse_args()
    if hasattr(args,'app'):require(not args.app.is_symlink(),'应用根不能是符号链接')
    if hasattr(args,'prepared'):require(not args.prepared.is_symlink(),'产物目录不能是符号链接')
    if args.command=='inspect':result=audit_app(args.app.resolve(),args.repo.resolve(),load(args.build_record),args.version);result.pop('record');result['publicationEligible']=False
    elif args.command=='prepare':result=prepare(args)
    elif args.command=='verify':result=verify(args.prepared.resolve(),args.repo.resolve())
    else:result=publish_plan(args,private_draft=args.command=='private-draft-plan')
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':
    try:main()
    except (Rejected,OSError,ValueError,KeyError,TypeError) as error:
        print('发行准备未完成：'+str(error),file=sys.stderr);sys.exit(1)
