"""Refresh only our offline notice branding from Info.plist; no network or app build.
Existing license text, source URLs and hashes must validate before generation.
"""
import html
import json
import os
from pathlib import Path
import plistlib

from build_resources import check_licenses, require


def refresh(app):
    web = app / 'Resources'
    manifest = check_licenses(web)
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    title = info['CFBundleDisplayName']
    require(title == info['CFBundleName'], '应用显示名不一致')
    own = next(row for row in manifest['components'] if row['id'] == 'paper-digest')
    old_title = own['title']
    own.update(title=title, version=info['CFBundleShortVersionString'])
    # Keep the existing local presentation and introduction; generate navigation
    # and all component sections from the manifest and exact license originals.
    page = (web / 'third-party-notices.html').read_text(encoding='utf-8')
    header, separator, _ = page.partition('<nav>')
    require(separator and header.count('<title>') == 1, '许可页面模板无效')
    header = header.replace(html.escape(old_title), html.escape(title))
    rows = manifest['components']
    nav = '<nav>' + ''.join('<a href="#' + html.escape(row['id'], quote=True) + '">' + html.escape(row['title']) + '</a>' for row in rows) + '</nav></header>'
    sections = ''.join('<section id="' + html.escape(row['id'], quote=True) + '"><h2>' + html.escape(row['title']) + '</h2><p class="version">' + html.escape(row['version']) + '</p><p class="source">来源：' + html.escape(row['sourceURL']) + '</p><pre>' + html.escape((web / 'licenses' / row['path']).read_bytes().decode('utf-8')) + '</pre></section>' for row in rows)
    (web / 'licenses/manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (web / 'third-party-notices.html').write_text(header + nav + sections + '</body></html>\n', encoding='utf-8')
    check_licenses(web)


if __name__ == '__main__':
    require(not os.environ.get('CODEX_SANDBOX'), '请在本机正常开发环境更新许可元数据')
    refresh(Path(__file__).resolve().parent)
