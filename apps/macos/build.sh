#!/bin/bash
set -euo pipefail

if [[ -n "${CODEX_SANDBOX:-}" ]]; then
  echo "请在正常本机开发环境构建 Mac 应用。" >&2
  exit 1
fi
app_root="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$app_root/../.." && pwd)"
install_requested=0
for option in "$@"; do
  case "$option" in
    --install) install_requested=1 ;;
    --help) echo "用法：apps/macos/build.sh [--install]（安装到 ~/Applications）"; exit 0 ;;
    *) echo "未知选项：$option" >&2; exit 2 ;;
  esac
done
# Replacing a live bundle can leave the existing process executing old code
# against moved/deleted Web/Runtime resources. Never terminate it implicitly.
assert_app_not_running() {
  local active_pids
  active_pids="$(/usr/bin/pgrep -x PaperDigest || true)"
  if [[ -n "$active_pids" ]]; then
    echo "论文速递仍在运行（PID：$(echo "$active_pids" | tr '\n' ' ')）。请先在应用中保存并正常退出，再安装新版本；原安装未替换。" >&2
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
/usr/bin/python3 - "$repo_root/prototypes/macos-research" <<'PYASSETS'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]);sample=json.loads((root/'sample.json').read_text())
for item in [sample['pdf'],*sample['figures']]:
 file=root/'assets'/item['src']
 if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest()!=item['sha256']:
  raise SystemExit('真实样稿资产缺失或SHA不符：'+item['src']+'；请按 prototypes/macos-research/README.md 准备。')
print('原始 PDF 与全部科学图 SHA 校验通过。')
PYASSETS
build_root="$app_root/.build"
mkdir -p "$build_root"
work="$(mktemp -d "$build_root/package.XXXXXX")"
bundle="$work/论文速递.app"
resources="$bundle/Contents/Resources"
mkdir -p "$bundle/Contents/MacOS" "$resources/Web/vendor/katex" "$resources/Runtime" "$resources/Shared" "$work/Sources"
echo "正在快照本次构建源码并编译原生 Mac 应用…"
for source in "$app_root"/Sources/*.swift; do cp "$source" "$work/Sources/"; done
sources=("$work"/Sources/*.swift)
xcrun swiftc -O -parse-as-library -target "$architecture-apple-macos15.0" "${sources[@]}" -o "$bundle/Contents/MacOS/PaperDigest"

cp "$app_root/Info.plist" "$bundle/Contents/Info.plist"
cp -R "$app_root/Resources/." "$resources/Web/"
cp "$repo_root/prototypes/macos-research/vendor/marked.esm.js" "$resources/Web/vendor/"
cp "$repo_root/prototypes/macos-research/vendor/lucide.min.js" "$resources/Web/vendor/"
cp "$repo_root/prototypes/macos-research/vendor/MARKED-LICENSE.md" "$resources/Web/vendor/"
cp "$repo_root/prototypes/macos-research/vendor/LUCIDE-LICENSE" "$resources/Web/vendor/"
cp -R "$app_root/node_modules/katex/dist/." "$resources/Web/vendor/katex/"
cp "$app_root/node_modules/katex/LICENSE" "$resources/Web/vendor/katex/LICENSE"
mkdir -p "$resources/Seed"
cp "$repo_root/prototypes/macos-research/sample.json" "$resources/Seed/"
cp -R "$repo_root/prototypes/macos-research/assets" "$resources/Seed/"
cp "$node_runtime" "$resources/Runtime/node"
chmod 755 "$resources/Runtime/node"
node_version="$(env -i PATH=/usr/bin:/bin "$node_runtime" --version)"
[[ "$node_version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Node版本无法对应官方许可文件。" >&2; exit 1; }
node_license=""
for candidate in "$(dirname "$node_runtime")/../LICENSE" "$(dirname "$node_runtime")/LICENSE"; do
  if [[ -f "$candidate" ]]; then node_license="$candidate"; break; fi
done
if [[ -z "$node_license" ]]; then
  license_cache="$build_root/licenses"
  mkdir -p "$license_cache"
  node_license="$license_cache/node-$node_version-LICENSE"
  if [[ ! -f "$node_license" ]]; then
    /usr/bin/curl -q --fail --silent --show-error --proto '=https' --max-time 60 --max-filesize 2000000 \
      "https://raw.githubusercontent.com/nodejs/node/$node_version/LICENSE" --output "$node_license.tmp"
    [[ -s "$node_license.tmp" ]] || { echo "官方Node许可文件为空。" >&2; exit 1; }
    mv "$node_license.tmp" "$node_license"
    (cd "$license_cache" && shasum -a 256 "node-$node_version-LICENSE" > "node-$node_version-LICENSE.sha256")
  fi
  [[ -f "$node_license.sha256" ]] || { echo "Node许可缓存缺少SHA记录，请保留旧文件后重新准备。" >&2; exit 1; }
  (cd "$license_cache" && shasum -a 256 -c "node-$node_version-LICENSE.sha256")
fi
cp "$node_license" "$resources/Runtime/NODE-LICENSE"
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
try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
for (name,size) in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),("icon_512x512@2x",1024)] {
 let bitmap=NSBitmapImageRep(bitmapDataPlanes:nil,pixelsWide:size,pixelsHigh:size,bitsPerSample:8,samplesPerPixel:4,hasAlpha:true,isPlanar:false,colorSpaceName:.deviceRGB,bytesPerRow:0,bitsPerPixel:0)!
 NSGraphicsContext.saveGraphicsState();NSGraphicsContext.current=NSGraphicsContext(bitmapImageRep:bitmap)
 NSGraphicsContext.current!.cgContext.scaleBy(x:CGFloat(size)/1024,y:CGFloat(size)/1024)
 NSColor(calibratedRed:0.20,green:0.37,blue:0.74,alpha:1).setFill();NSBezierPath(roundedRect:NSRect(x:64,y:64,width:896,height:896),xRadius:190,yRadius:190).fill()
 NSColor.white.setFill();NSBezierPath(roundedRect:NSRect(x:267,y:196,width:490,height:632),xRadius:45,yRadius:45).fill()
 NSColor(calibratedRed:0.20,green:0.37,blue:0.74,alpha:0.72).setStroke()
 for (y,width) in [(682.0,300.0),(580.0,300.0),(478.0,300.0),(376.0,202.0)] {let line=NSBezierPath();line.lineWidth=29;line.lineCapStyle = .round;line.move(to:NSPoint(x:357,y:y));line.line(to:NSPoint(x:357+width,y:y));line.stroke()}
 NSGraphicsContext.restoreGraphicsState()
 try bitmap.representation(using:.png,properties:[:])!.write(to:directory.appendingPathComponent(name+".png"))
}
SWIFT
xcrun swift "$work/icon.swift" "$work/AppIcon.iconset"
iconutil -c icns "$work/AppIcon.iconset" -o "$resources/AppIcon.icns"
codesign --force --sign - --timestamp=none "$resources/Runtime/node"

/usr/bin/python3 - "$work" "$app_root" "$repo_root" <<'PY'
import hashlib,json,pathlib,subprocess,sys,datetime
work,app,repo=map(pathlib.Path,sys.argv[1:])
bundle=work/'论文速递.app';resources=bundle/'Contents/Resources'
# Check the actual bundled bytes, not only the originals checked before compile.
sample=json.loads((resources/'Seed/sample.json').read_text())
for item in [sample['pdf'],*sample['figures']]:
 file=resources/'Seed/assets'/item['src']
 if not file.is_file() or hashlib.sha256(file.read_bytes()).hexdigest()!=item['sha256']:
  raise SystemExit('已打包样稿资产SHA不符：'+item['src'])
entries=[]
for base,label in [(work/'Sources','Sources'),(resources/'Web','Web'),(resources/'Seed','Seed'),(resources/'Shared','Shared')]:
 for file in sorted(base.rglob('*')):
  if file.is_symlink():raise SystemExit('打包输入不能包含符号链接：'+str(file))
  if file.is_file():entries.append({'path':label+'/'+file.relative_to(base).as_posix(),'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
for relative in ['Contents/Info.plist','Contents/Resources/llm-worker.cjs','Contents/Resources/Runtime/node','Contents/Resources/Runtime/NODE-LICENSE']:
 file=bundle/relative;entries.append({'path':relative,'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
marker={'contract':'paper-digest-mac-build-v1','builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':subprocess.check_output(['git','-C',str(repo),'rev-parse','HEAD'],text=True).strip(),'architecture':subprocess.check_output(['uname','-m'],text=True).strip(),'signing':'ad-hoc; not notarized','files':entries}
(resources/'build-metadata.json').write_text(json.dumps(marker,ensure_ascii=False,indent=2)+'\n')
PY
plutil -lint "$bundle/Contents/Info.plist" > /dev/null
codesign --force --sign - --timestamp=none --identifier com.nanless.PaperDigest "$bundle"
codesign --verify --deep --strict "$bundle"
target="$build_root/论文速递.app"
# A locally launched .build copy also needs its own resources until it exits.
for active_pid in $(/usr/bin/pgrep -x PaperDigest || true); do
  active_executable="$(/bin/ps -p "$active_pid" -o comm= || true)"
  if [[ "$active_executable" == "$target/Contents/MacOS/PaperDigest" ]]; then
    echo "当前构建目录中的论文速递仍在运行（PID：$active_pid）；原构建未替换，新候选保留于：$bundle" >&2
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
  destination="$applications/论文速递.app"
  installation="$(mktemp -d "$applications/.paper-digest-install.XXXXXX")"
  cp -R "$target" "$installation/论文速递.app"
  codesign --verify --deep --strict "$installation/论文速递.app"
  if ! assert_app_not_running; then
    rm -rf "$installation"
    exit 1
  fi
  if [[ -e "$destination" ]]; then mv "$destination" "$installation/previous.app"; fi
  if ! mv "$installation/论文速递.app" "$destination"; then
    if [[ -d "$installation/previous.app" ]]; then mv "$installation/previous.app" "$destination"; fi
    echo "安装未完成，原安装已保留。" >&2; exit 1
  fi
  rm -rf "$installation"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$destination"
  echo "已安装：$destination"
fi
rm -rf "$work"
