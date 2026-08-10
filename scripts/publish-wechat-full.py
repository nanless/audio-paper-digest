#!/usr/bin/env python3
from project_env import load_project_env
load_project_env()

from log_setup import setup_script_logging
setup_script_logging(__file__)

"""
论文速递 → 微信公众号（含图片上传）
从 arxiv 下载论文图片，上传到微信 CDN，生成完整文章草稿。

用法：
    python3 publish-wechat-full.py [data_file]
    python3 publish-wechat-full.py --dry-run [data_file]  # 只生成本地预览，不调用微信接口
"""
import argparse, urllib.request, json, time, sys, re, datetime, hashlib, os, html, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers_for_publication_date, get_today_bj, score_and_sort, extract_top_tags,
    score_emoji, format_medal, validate_papers_for_publish, PublishDataValidationError,
    paper_batch_date, select_blog_published_snapshot
)
from path_config import atomic_write_json, atomic_write_text, wechat_preview_path
from utils import parse_analysis
from project_env import build_fetch_url_opener

APP_ID = os.environ.get('WECHAT_APP_ID', '')
APP_SECRET = os.environ.get('WECHAT_APP_SECRET', '')

# 封面图素材 ID（永久素材），支持项目 .env 覆写
THUMB_MEDIA_ID = os.environ.get('WECHAT_THUMB_MEDIA_ID', '')

BJ_TZ = datetime.timezone(datetime.timedelta(hours=8))


def get_token():
    url = f'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid={APP_ID}&secret={APP_SECRET}'
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            data = json.loads(resp.read())
        if 'access_token' not in data:
            print(f"❌ 获取 Token 失败: {data.get('errmsg', data)}")
            sys.exit(1)
        return data['access_token']
    except urllib.error.HTTPError as e:
        print(f"❌ 获取 Token HTTP 错误: {e.code} {e.reason}")
        sys.exit(1)
    except Exception as e:
        print(f"❌ 获取 Token 失败: {e}")
        sys.exit(1)


def download_image(url, timeout=15):
    """Download image from URL, return bytes or None"""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with build_fetch_url_opener().open(req, timeout=timeout) as resp:
            data = resp.read()
        if len(data) < 100:
            return None
        return data
    except Exception as e:
        print(f"  ⚠️ 下载失败: {url[:60]}... ({e})")
        return None


def upload_to_wechat(token, img_data, filename='fig.png'):
    """Upload image to WeChat, return CDN URL or None"""
    try:
        boundary = '----FormBoundary' + hashlib.md5(os.urandom(16)).hexdigest()[:16]
        content_type = 'image/png' if filename.endswith('.png') else 'image/jpeg'
        body = f'--{boundary}\r\nContent-Disposition: form-data; name="media"; filename="{filename}"\r\nContent-Type: {content_type}\r\n\r\n'.encode()
        body += img_data
        body += f'\r\n--{boundary}--\r\n'.encode()

        upload_url = f'https://api.weixin.qq.com/cgi-bin/media/uploadimg?access_token={token}'
        req = urllib.request.Request(upload_url, data=body, headers={
            'Content-Type': f'multipart/form-data; boundary={boundary}'
        })
        with urllib.request.urlopen(req, timeout=30) as response:
            resp = json.loads(response.read())
        if 'url' in resp:
            return resp['url']
        else:
            print(f"  ⚠️ 上传失败: {resp}")
            return None
    except Exception as e:
        print(f"  ⚠️ 上传异常: {e}")
        return None


# Image cache to avoid re-uploading same URL
_cache_file = os.path.join(tempfile.gettempdir(), 'wechat-image-cache.json')
_image_cache = {}
if os.path.exists(_cache_file):
    try:
        with open(_cache_file, 'r') as f:
            _image_cache = json.load(f)
    except:
        pass


def get_wechat_image_url(token, arxiv_url):
    """Download arxiv image and upload to WeChat, return CDN URL. Uses cache."""
    if arxiv_url in _image_cache:
        return _image_cache[arxiv_url]

    img_data = download_image(arxiv_url)
    if not img_data:
        return None

    ext = 'png' if arxiv_url.endswith('.png') else 'jpg'
    cdn_url = upload_to_wechat(token, img_data, f'fig.{ext}')

    if cdn_url:
        _image_cache[arxiv_url] = cdn_url
        try:
            atomic_write_json(_cache_file, _image_cache, mode=0o600)
        except Exception as e:
            print(f"  ⚠️ 缓存写入失败: {e}")

    return cdn_url


def main():
    parser = argparse.ArgumentParser(prog='publish-wechat-full.py', allow_abbrev=False)
    parser.add_argument('data_file', nargs='?')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--date')
    parser.add_argument('--ignore-blog-snapshot', action='store_true',
                        help='显式允许在同日博客尚未远端验证时独立发布')
    args = parser.parse_args()
    data_file = args.data_file
    dry_run = args.dry_run
    target_date = args.date
    publish_all = args.all
    ignore_blog_snapshot = args.ignore_blog_snapshot

    if not dry_run and (not APP_ID or not APP_SECRET or not THUMB_MEDIA_ID):
        print("❌ 错误: 非 dry-run 必须设置 WECHAT_APP_ID、WECHAT_APP_SECRET 和 WECHAT_THUMB_MEDIA_ID")
        sys.exit(1)

    today = get_today_bj(target_date)
    try:
        papers = load_papers_for_publication_date(today, data_file)
        if not ignore_blog_snapshot:
            papers = select_blog_published_snapshot(papers, today)
        elif not publish_all:
            papers = [p for p in papers if paper_batch_date(p) == today]
            print(f"📅 独立发布过滤后: {len(papers)} 篇论文 (fetchBatchDate={today})")
        else:
            print("📦 独立发布 --all: 使用输入文件中的全部论文")
        if not papers:
            raise PublishDataValidationError('没有论文需要发布')
        papers = validate_papers_for_publish(papers)
    except PublishDataValidationError as exc:
        print(f"❌ 发布数据预检失败: {exc}")
        return False
    scored, unscored = score_and_sort(papers)

    token = None
    if dry_run:
        print("🧪 dry-run: 跳过微信 Token 获取、图片上传和草稿创建")
    else:
        token = get_token()
        print(f"🔑 Token OK")

    def extract_markdown_image_urls(text):
        if not text:
            return []
        return [m.group(2) for m in re.finditer(r'!\[([^\]]*)\]\(([^)]+)\)', text)]

    all_imgs = set()
    for p in papers:
        for u in (p.get('selectedImageUrls') or []):
            all_imgs.add(u)
        analysis = p.get('analysis') or ''
        for u in extract_markdown_image_urls(analysis):
            all_imgs.add(u)
    all_imgs = list(all_imgs)
    print(f"🖼️ 共 {len(all_imgs)} 张图片需要上传")

    img_map = {}
    success = 0
    fail = 0
    if dry_run:
        img_map = {u: u for u in all_imgs}
        print("🧪 dry-run: 预览 HTML 中保留原始图片 URL")
    else:
        for i, img_url in enumerate(all_imgs):
            cdn_url = get_wechat_image_url(token, img_url)
            if cdn_url:
                img_map[img_url] = cdn_url
                success += 1
            else:
                fail += 1
            if (i + 1) % 10 == 0:
                print(f"  上传进度: {i+1}/{len(all_imgs)} (成功:{success} 失败:{fail})")

        print(f"✅ 图片上传完成: 成功 {success}, 失败 {fail}")

    MAX_CHARS = 48000

    paper_htmls = []
    for paper in papers:
        pa = paper.get('parsed') or parse_analysis(paper.get('analysis',''))
        title = paper.get('title','Unknown')
        aid = paper.get('arxivId','')
        aurl = f'https://arxiv.org/abs/{aid}' if aid else ''

        h = f'<h2>📄 {html.escape(title)}</h2>\n'

        def render_rich_text(text):
            if not text:
                return ''
            out = []
            pos = 0
            for m in re.finditer(r'!\[([^\]]*)\]\(([^)]+)\)', text):
                before = text[pos:m.start()]
                if before.strip():
                    for para in re.split(r'\n\s*\n', before.strip()):
                        if para.strip():
                            out.append(f'<p>{html.escape(para.strip()).replace(chr(10), "<br/>")}</p>')
                alt = m.group(1).strip() or '论文图片'
                raw_url = m.group(2).strip()
                cdn_url = img_map.get(raw_url, raw_url)
                if cdn_url:
                    out.append(f'<p><img src="{html.escape(cdn_url)}" data-src="{html.escape(cdn_url)}" alt="{html.escape(alt)}" /></p>')
                pos = m.end()
            tail = text[pos:]
            if tail.strip():
                for para in re.split(r'\n\s*\n', tail.strip()):
                    if para.strip():
                        out.append(f'<p>{html.escape(para.strip()).replace(chr(10), "<br/>")}</p>')
            return '\n'.join(out) + ('\n' if out else '')

        if pa:
            if pa['tags']:
                h += f'<p style="color:#1a73e8;">{" ".join(pa["tags"])}</p>\n'
            score = float(pa['score'] or '0')
            se = score_emoji(score)
            h += f'<p>{se} 评分：{html.escape(str(pa["score"]))}/10'
            if aurl: h += f' | <a href="{aurl}">arxiv</a>'
            h += '</p>\n'
            meta = []
            if pa.get('rankBucket'):
                meta.append(pa['rankBucket'])
            if pa.get('documentType'):
                meta.append(f'文档类型：{pa["documentType"]}')
            if pa.get('primaryTaskTag'):
                meta.append(pa['primaryTaskTag'])
            if pa.get('primaryMethodTag'):
                meta.append(pa['primaryMethodTag'])
            if meta:
                h += f'<p style="color:#666;">{" | ".join(meta)}</p>\n'
            machine_parts = []
            if pa.get('innovationScore'):
                machine_parts.append(f'创新 {pa["innovationScore"]}/2')
            if pa.get('technicalRigorScore'):
                machine_parts.append(f'严谨 {pa["technicalRigorScore"]}/1.5')
            if pa.get('experimentalSufficiencyScore'):
                machine_parts.append(f'实验 {pa["experimentalSufficiencyScore"]}/1.5')
            if pa.get('clarityScore'):
                machine_parts.append(f'清晰 {pa["clarityScore"]}/1')
            if pa.get('impactScore'):
                machine_parts.append(f'影响 {pa["impactScore"]}/1.5')
            if pa.get('openSourceScore'):
                machine_parts.append(f'开源 {pa["openSourceScore"]}/1.5')
            if pa.get('reproducibilityScore'):
                machine_parts.append(f'复现 {pa["reproducibilityScore"]}/0.5')
            if pa.get('engineeringScore'):
                machine_parts.append(f'工程 {pa["engineeringScore"]}/1.5')
            if pa.get('confidence'):
                machine_parts.append(f'置信度 {pa["confidence"]}')
            if machine_parts:
                h += f'<p style="color:#888;">{" | ".join(machine_parts)}</p>\n'

            if pa.get('authors'):
                h += f'<p><strong>👥 作者与机构</strong></p>\n<p>{html.escape(pa["authors"])}</p>\n'

            sections = [
                ('💡 毒舌点评', 'roast'), ('📌 核心摘要', 'summary'),
                ('🏗️ 方法概述和架构', 'architecture'),
                ('💡 核心创新点', 'innovation'), ('🔬 细节详述', 'details'),
                ('📊 实验结果', 'results'), ('⚖️ 评分理由', 'scoringReason'),
                ('🚨 局限与问题', 'limitations'),
                ('🔗 开源详情', 'opensource'),
            ]
            for label, key in sections:
                if pa.get(key):
                    h += f'<p><strong>{label}</strong></p>\n{render_rich_text(pa[key])}'
        else:
            h += '<p style="color:#999;">⚠️ 该论文分析失败</p>\n'

        rendered_body_has_image = '<img ' in h
        imgs = paper.get('selectedImageUrls') or []
        if imgs and not rendered_body_has_image:
            h += '<p><strong>📸 论文图片</strong></p>\n'
            for img_url in imgs:
                cdn_url = img_map.get(img_url)
                if cdn_url:
                    h += f'<p><img src="{cdn_url}" data-src="{cdn_url}" /></p>\n'

        paper_htmls.append((h, paper))

    top_tags = extract_top_tags(papers, limit=8)
    top_scored = scored[:10]

    overview = '<h2>⚡ 今日概览</h2>\n'
    total = len(scored) + len(unscored)
    overview += f'<p>📥 抓取 {total} 篇 → 🔬 深度分析完成</p>\n'
    if top_tags:
        overview += '<h3>🏷️ 热门方向</h3>\n'
        for tag, cnt in top_tags:
            overview += f'<p>{tag}：{"█" * min(cnt, 15)} {cnt}篇</p>\n'
    if top_scored:
        overview += f'<h3>🏆 高分论文 TOP {len(top_scored)}</h3>\n'
        for i, (score, p, pa) in enumerate(top_scored):
            m = format_medal(i)
            extra = ' | '.join([v for v in [pa.get('rankBucket', ''), pa.get('primaryTaskTag', '')] if v])
            suffix = f' | {extra}' if extra else ''
            overview += f'<p>{m} {html.escape(p.get("title", "")[:60])}（{score}分{suffix}）</p>\n'
    overview += '<hr/>\n'

    footer = '<hr/>\n<p style="text-align:center;color:#aaa;font-size:12px;">由 AI 自动生成 · Paper Digest</p>\n'

    HEADER_OVERHEAD = 300
    SEPARATOR = '<hr/>\n'

    parts = []
    current_part = []
    current_chars = HEADER_OVERHEAD + len(overview) + len(footer)

    for i, (ph, _) in enumerate(paper_htmls):
        paper_chars = len(ph) + len(SEPARATOR)
        if current_part and (current_chars + paper_chars > MAX_CHARS):
            parts.append(current_part)
            current_part = [i]
            current_chars = HEADER_OVERHEAD + len(overview) + len(footer) + paper_chars
        else:
            current_part.append(i)
            current_chars += paper_chars

    if current_part:
        parts.append(current_part)

    total_parts = len(parts)
    print(f"\n📑 分为 {total_parts} 个 part（每篇上限 {MAX_CHARS} 字符）")
    for pi, part_indices in enumerate(parts):
        print(f"  Part {pi+1}: 第 {part_indices[0]+1}-{part_indices[-1]+1} 篇 ({len(part_indices)} 篇)")

    thumb_id = THUMB_MEDIA_ID
    draft_url = f'https://api.weixin.qq.com/cgi-bin/draft/add?access_token={token}'
    created_parts = []
    failed_parts = []

    for pi, part_indices in enumerate(parts):
        part_num = pi + 1
        part_paper_count = len(part_indices)

        if total_parts == 1:
            part_title = f"语音/音乐/音频论文速递 {today} | {total}篇论文"
        else:
            part_title = f"语音/音乐/音频论文速递 {today} | part {part_num} | {part_paper_count}篇论文"

        html = f'<h2 style="text-align:center;">{part_title}</h2>\n'
        if total_parts > 1:
            html += f'<p style="text-align:center;color:#888;">共 {total} 篇，分 {total_parts} 部分发布，当前第 {part_num} 部分</p>\n'
        else:
            html += f'<p style="text-align:center;color:#888;">共分析 {total} 篇论文</p>\n'
        html += '<hr/>\n'

        if part_num == 1:
            html += overview

        for idx in part_indices:
            ph, _ = paper_htmls[idx]
            html += ph + SEPARATOR

        html += footer

        if dry_run:
            print(f"\n🧪 dry-run: 跳过创建草稿 Part {part_num} ({len(html)} chars)")
            continue

        print(f"\n📝 创建草稿 Part {part_num}... ({len(html)} chars)")

        payload = json.dumps({
            "articles": [{
                "title": part_title,
                "author": os.environ.get('PAPER_DIGEST_AUTHOR', ''),
                "digest": html.replace('<','').replace('>','')[:120],
                "content": html,
                "content_source_url": "",
                "thumb_media_id": thumb_id,
                "need_open_comment": 0,
                "only_fans_can_comment": 0
            }]
        }, ensure_ascii=False).encode('utf-8')

        req = urllib.request.Request(draft_url, data=payload, headers={'Content-Type': 'application/json; charset=utf-8'})
        try:
            with urllib.request.urlopen(req, timeout=60) as response:
                resp = json.loads(response.read())

            if 'media_id' in resp:
                print(f"  ✅ Part {part_num} 草稿成功！")
                created_parts.append({'part': part_num, 'media_id': resp['media_id']})
            else:
                print(f"  ❌ Part {part_num} 失败: {json.dumps(resp, ensure_ascii=False)}")
                failed_parts.append({'part': part_num, 'error': json.dumps(resp, ensure_ascii=False)[:500]})
        except urllib.error.HTTPError as e:
            print(f"  ❌ Part {part_num} HTTP 错误: {e.code} {e.reason}")
            failed_parts.append({'part': part_num, 'error': f'HTTP {e.code} {e.reason}'})
            try:
                err_body = e.read().decode('utf-8', errors='replace')
                print(f"     响应: {err_body[:200]}")
            except Exception:
                pass
        except Exception as e:
            print(f"  ❌ Part {part_num} 请求异常: {e}")
            failed_parts.append({'part': part_num, 'error': str(e)})

    preview_path = wechat_preview_path(today)
    first_part_html = f'<h2 style="text-align:center;">语音/音乐/音频论文速递 {today}</h2>\n'
    first_part_html += f'<p style="text-align:center;color:#888;">共 {total} 篇，分 {total_parts} 部分</p>\n<hr/>\n'
    first_part_html += overview
    for ph, _ in paper_htmls:
        first_part_html += ph + SEPARATOR
    first_part_html += footer
    atomic_write_text(preview_path, first_part_html)

    if dry_run:
        print(f"\n🎉 dry-run 完成！本地预览已生成，未创建微信草稿")
        return True
    if failed_parts:
        print(f"\n❌ 微信草稿未完整创建：成功 {len(created_parts)}/{total_parts}，失败 part: {', '.join(str(item['part']) for item in failed_parts)}")
        print(f"   成功 media_id: {', '.join(item['media_id'] for item in created_parts) or '无'}")
        return False
    else:
        print(f"\n🎉 全部完成！共 {total_parts} 个草稿已创建")
        return True


if __name__ == '__main__':
    sys.exit(0 if main() else 1)
