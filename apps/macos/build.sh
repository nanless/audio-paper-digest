#!/bin/bash
set -euo pipefail

if [[ -n "${CODEX_SANDBOX:-}" ]]; then
  echo "请在正常本机开发环境构建 Mac 应用。" >&2
  exit 1
fi
app_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$app_root/../.." && pwd)"
install_requested=0
channel=release
while [[ $# -gt 0 ]]; do
  case "$1" in
    --install) install_requested=1 ;;
    --channel) shift; [[ $# -gt 0 ]] || { echo "缺少构建通道。" >&2; exit 2; }; channel="$1" ;;
    --help) echo "用法：apps/macos/build.sh [--channel release|private-qa] [--install]；默认无科学样稿正式通道"; exit 0 ;;
    *) echo "未知选项：$1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$channel" == release || "$channel" == private-qa ]] || { echo "构建通道无效。" >&2; exit 2; }
# Replacing a live bundle can leave the existing process executing old code
# against moved/deleted Web/Runtime resources. Never terminate it implicitly.
assert_app_not_running() {
  local active_pids
  active_pids="$(/usr/bin/pgrep -x PaperDigest || true)"
  if [[ -n "$active_pids" ]]; then
    echo "论文速递工作台仍在运行（PID：$(echo "$active_pids" | tr '\n' ' ')）。请先在应用中保存并正常退出，再安装新版本；原安装未替换。" >&2
    return 1
  fi
}
if [[ "$install_requested" == 1 ]]; then assert_app_not_running; fi
architecture="$(uname -m)"
[[ "$architecture" == arm64 || "$architecture" == x86_64 ]] || { echo "不支持此架构：$architecture" >&2; exit 1; }
node_runtime="${PD_MAC_NODE_RUNTIME:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
if [[ ! -x "$node_runtime" ]]; then node_runtime="$(command -v node || true)"; fi
[[ -x "$node_runtime" ]] || { echo "缺少可打包的 Node 运行时，可用 PD_MAC_NODE_RUNTIME 指定本机二进制。" >&2; exit 1; }
node_architectures="$(/usr/bin/lipo -archs "$node_runtime")"
case " $node_architectures " in
  *" $architecture "*) ;;
  *) echo "Node 运行时架构与本次 Mac 构建不一致。" >&2; exit 1 ;;
esac
env -i PATH=/usr/bin:/bin "$node_runtime" -e 'const [major,minor,patch]=process.versions.node.split(".").map(Number);if(!((major===20&&(minor>18||(minor===18&&patch>=1)))||major>22||(major===22&&minor>=3)))process.exit(1)' || { echo "所带 Node 须满足 >=20.18.1 <21 或 >=22.3.0，与公共请求实现一致。" >&2; exit 1; }
/usr/bin/python3 - "$node_runtime" <<'PYNODE'
import re,subprocess,sys
node=sys.argv[1]
dependencies=subprocess.check_output(['/usr/bin/otool','-L',node],text=True)
for line in dependencies.splitlines():
 if '(compatibility version' not in line:continue
 dependency=line.strip().split(' (',1)[0]
 if not dependency.startswith(('/System/Library/','/usr/lib/')):
  raise SystemExit('Node依赖未随包复制的外部动态库：'+dependency+'；请使用独立发行的Node二进制。')
build=subprocess.check_output(['/usr/bin/xcrun','vtool','-show-build',node],text=True)
minimums=re.findall(r'\bminos\s+(\d+(?:\.\d+){0,2})',build)
if not minimums:raise SystemExit('无法核对Node最低macOS版本，未打包。')
for version in minimums:
 parts=tuple(map(int,version.split('.')))+(0,0)
 if parts[:3]>(15,0,0):raise SystemExit('Node最低系统版本'+version+'高于应用声明的macOS15，未打包。')
PYNODE
[[ -f "$app_root/node_modules/katex/dist/katex.min.js" ]] || { echo "请先在 apps/macos 安装锁定的前端依赖。" >&2; exit 1; }
for required in index.html native.js styles.css library-ui.js zotero-ui.js; do
  [[ -f "$app_root/Resources/$required" ]] || { echo "界面源文件尚未准备好：$required" >&2; exit 1; }
done
icon_source="$app_root/Assets/AppIcon.png"
[[ -f "$icon_source" && ! -L "$icon_source" ]] || { echo "缺少可追溯的应用图标 Assets/AppIcon.png。" >&2; exit 1; }
build_root="$app_root/.build"
mkdir -p "$build_root"
work="$(mktemp -d "$build_root/package.XXXXXX")"
bundle="$work/论文速递工作台.app"
resources="$bundle/Contents/Resources"
mkdir -p "$bundle/Contents/MacOS" "$resources/Runtime" "$resources/Shared" "$resources/Assets" "$work/Sources" "$work/Build"
cp "$icon_source" "$resources/Assets/AppIcon.png"
cp "$app_root/build.sh" "$work/Build/build.sh"
cp "$app_root/build_resources.py" "$work/Build/build_resources.py"
echo "正在快照本次构建源码并编译原生 Mac 应用…"
for source in "$app_root"/Sources/*.swift; do cp "$source" "$work/Sources/"; done
sources=("$work"/Sources/*.swift)
xcrun swiftc -O -parse-as-library -target "$architecture-apple-macos15.0" "${sources[@]}" -o "$bundle/Contents/MacOS/PaperDigest"

cp "$app_root/Info.plist" "$bundle/Contents/Info.plist"
cp "$node_runtime" "$resources/Runtime/node"
chmod 755 "$resources/Runtime/node"
node_version="$(env -i PATH=/usr/bin:/bin "$node_runtime" --version)"
[[ "$node_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Node版本无法对应官方许可文件。" >&2; exit 1; }
bash "$repo_root/scripts/python-runtime.sh" "$app_root/build_resources.py" --repo "$repo_root" --app "$app_root" --resources "$resources" --channel "$channel" --node-version "$node_version"
cp "$app_root/llm-worker.cjs" "$resources/"
while IFS= read -r -d '' relative; do
  case "/$relative/" in */.env*/*|*/data/runtime/*) continue ;; esac
  [[ -f "$repo_root/$relative" ]] || continue
  mkdir -p "$resources/Shared/$(dirname "$relative")"
  cp "$repo_root/$relative" "$resources/Shared/$relative"
done < <(git -C "$repo_root" ls-files -z -- scripts config)

cat > "$work/icon.swift" <<'SWIFT'
import AppKit
let directory=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let source=URL(fileURLWithPath:CommandLine.arguments[2])
guard let sourceData=try? Data(contentsOf:source),sourceData.starts(with:Data([137,80,78,71,13,10,26,10])),let decoded=NSBitmapImageRep(data:sourceData),decoded.pixelsWide==1024,decoded.pixelsHigh==1024,decoded.hasAlpha,let image=NSImage(data:sourceData) else { fatalError("应用图标必须是含透明通道的1024×1024 PNG") }
try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
for (name,size) in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)] {
 let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
 NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
 NSGraphicsContext.current!.imageInterpolation = .high
 image.draw(in:NSRect(x:0,y:0,width:size,height:size),from:.zero,operation:.copy,fraction:1,respectFlipped:false,hints:[.interpolation:NSImageInterpolation.high])
 NSGraphicsContext.restoreGraphicsState()
 try bitmap.representation(using:.png,properties:[:])!.write(to:directory.appendingPathComponent(name+".png"))
}
SWIFT
xcrun swift "$work/icon.swift" "$work/AppIcon.iconset" "$resources/Assets/AppIcon.png"
iconutil -c icns "$work/AppIcon.iconset" -o "$resources/AppIcon.icns"
iconutil -c iconset "$resources/AppIcon.icns" -o "$work/ValidatedIcon.iconset"
/usr/bin/python3 - "$work/AppIcon.iconset" "$work/ValidatedIcon.iconset" <<'PYICON'
import pathlib,struct,sys
original,decoded=map(pathlib.Path,sys.argv[1:])
sizes={'icon_16x16':16,'icon_16x16@2x':32,'icon_32x32':32,'icon_32x32@2x':64,'icon_128x128':128,'icon_128x128@2x':256,'icon_256x256':256,'icon_256x256@2x':512,'icon_512x512':512,'icon_512x512@2x':1024}
for name,size in sizes.items():
 for directory in [original,decoded]:
  raw=(directory/(name+'.png')).read_bytes()
  if raw[:8]!=b'\x89PNG\r\n\x1a\n' or struct.unpack('>II',raw[16:24])!=(size,size):
   raise SystemExit('图标层尺寸不完整：'+name)
print('新应用图标10层尺寸回读通过。')
PYICON
cat > "$work/check-icon.swift" <<'SWIFTICON'
import AppKit
func pixels(_ path:String)throws->[UInt8] {
 guard let bitmap=NSBitmapImageRep(data:try Data(contentsOf:URL(fileURLWithPath:path))),let image=bitmap.cgImage,image.width==1024,image.height==1024 else{fatalError("ICNS最高层无法解码")}
 var bytes=[UInt8](repeating:0,count:1024*1024*4)
 bytes.withUnsafeMutableBytes { data in
  let color=CGColorSpace(name:CGColorSpace.sRGB)!
  let format=CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
  guard let context=CGContext(data:data.baseAddress,width:1024,height:1024,bitsPerComponent:8,bytesPerRow:1024*4,space:color,bitmapInfo:format) else{fatalError("无法核对图标像素")}
  context.draw(image,in:CGRect(x:0,y:0,width:1024,height:1024))
 }
 return bytes
}
guard try pixels(CommandLine.arguments[1])==pixels(CommandLine.arguments[2]) else{fatalError("ICNS最高分辨率的RGBA像素与本次图标不一致")}
print("ICNS 1024层逐RGBA像素无损回读通过。")
SWIFTICON
xcrun swift "$work/check-icon.swift" "$work/AppIcon.iconset/icon_512x512@2x.png" "$work/ValidatedIcon.iconset/icon_512x512@2x.png"
codesign --force --sign - --timestamp=none "$resources/Runtime/node"

/usr/bin/python3 - "$work" "$app_root" "$repo_root" "$channel" <<'PY'
import hashlib,json,pathlib,subprocess,sys,datetime
work,app,repo=map(pathlib.Path,sys.argv[1:4]);channel=sys.argv[4]
bundle=work/'论文速递工作台.app';resources=bundle/'Contents/Resources'
# Check actual channel resources before signing; no signed-bundle removal.
sys.path.insert(0,str(app));from build_resources import assert_no_scientific_seed,check_licenses
check_licenses(resources/'Web')
if channel=='release':assert_no_scientific_seed(resources,repo)
else:
 sample=json.loads((resources/'Seed/sample.json').read_text())
 for item in [sample['pdf'],*sample['figures']]:
  file=resources/'Seed/assets'/item['src']
  if not file.is_file()or hashlib.sha256(file.read_bytes()).hexdigest()!=item['sha256']:raise SystemExit('私有验收原件SHA不符')
entries=[]
for base,label in [(work/'Sources','Sources'),(resources/'Web','Web'),(resources/'Seed','Seed'),(resources/'Shared','Shared'),(resources/'Assets','Assets'),(work/'Build','Build')]:
 for file in sorted(base.rglob('*')):
  if file.is_symlink():raise SystemExit('打包输入不能包含符号链接：'+str(file))
  if file.is_file():entries.append({'path':label+'/'+file.relative_to(base).as_posix(),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
for relative in ['Contents/Info.plist','Contents/Resources/AppIcon.icns','Contents/Resources/llm-worker.cjs','Contents/Resources/Runtime/node','Contents/Resources/Runtime/NODE-LICENSE']:
 file=bundle/relative;entries.append({'path':relative,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
marker={'contract':'paper-digest-mac-build-v1','distributionChannel':channel,'builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip(),'architecture':subprocess.check_output(['uname','-m'],text=True).strip(),'signing':'ad-hoc; not notarized','files':entries}
(resources/'build-metadata.json').write_text(json.dumps(marker,ensure_ascii=False,indent=2)+'\n')
PY
plutil -lint "$bundle/Contents/Info.plist" > /dev/null
codesign --force --sign - --timestamp=none --identifier com.nanless.PaperDigest "$bundle"
codesign --verify --deep --strict "$bundle"
target="$build_root/论文速递工作台.app"
# A locally launched .build copy also needs its own resources until it exits.
for active_pid in $(/usr/bin/pgrep -x PaperDigest || true); do
  active_executable="$(/bin/ps -p "$active_pid" -o comm= || true)"
  if [[ "$active_executable" == "$target/Contents/MacOS/PaperDigest" ]]; then
    echo "当前构建目录中的论文速递工作台仍在运行（PID：$active_pid）；原构建未替换，新候选保留于：$bundle" >&2
    exit 1
  fi
done
if [[ -d "$target" ]]; then mv "$target" "$work/previous-build.app"; fi
mv "$bundle" "$target"
# Preserve evidence outside the signed bundle: signing changes the executable bytes.
/usr/bin/python3 - "$target" "$app_root/.qa/builds" <<'PYHISTORY'
import hashlib,json,pathlib,sys
bundle,history=map(pathlib.Path,sys.argv[1:])
metadata=bundle/'Contents/Resources/build-metadata.json'
marker=json.loads(metadata.read_text())
name=marker['builtAt'].replace(':','-').replace('+','_')
destination=history/name
destination.mkdir(parents=True,exist_ok=False)
(destination/'build-metadata.json').write_bytes(metadata.read_bytes())
binary=bundle/'Contents/MacOS/PaperDigest'
record={'contract':'paper-digest-mac-signed-build-v1','builtAt':marker['builtAt'],'bundlePath':str(bundle),'sourceCommit':marker['sourceCommit'],'architecture':marker['architecture'],'signing':marker['signing'],'buildMetadataSHA256':hashlib.sha256(metadata.read_bytes()).hexdigest(),'binary':{'path':'Contents/MacOS/PaperDigest','bytes':binary.stat().st_size,'sha256':hashlib.sha256(binary.read_bytes()).hexdigest()}}
(destination/'signed-build.json').write_text(json.dumps(record,ensure_ascii=False,indent=2)+'\n')
print('本次源码与已签名程序校验记录：'+str(destination))
PYHISTORY
echo "构建与签名检查通过：$target"
echo "这是本机开发签名，尚未经过 Apple 公证。"
if [[ "$install_requested" == 1 ]]; then
  assert_app_not_running
  applications="$HOME/Applications"
  mkdir -p "$applications"
  destination="$applications/论文速递工作台.app"
  installation="$(mktemp -d "$applications/.paper-digest-install.XXXXXX")"
  cp -R "$target" "$installation/论文速递工作台.app"
  codesign --verify --deep --strict "$installation/论文速递工作台.app"
  if ! assert_app_not_running; then
    rm -rf "$installation"
    exit 1
  fi
  if [[ -e "$destination" ]]; then mv "$destination" "$installation/previous.app"; fi
  if ! mv "$installation/论文速递工作台.app" "$destination"; then
    if [[ -d "$installation/previous.app" ]]; then mv "$installation/previous.app" "$destination"; fi
    echo "安装未完成，原安装已保留。" >&2; exit 1
  fi
  rm -rf "$installation"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$destination"
  echo "已安装：$destination"
fi
rm -rf "$work"
