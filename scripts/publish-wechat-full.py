#!/usr/bin/env python3
from log_setup import setup_script_logging
setup_script_logging(__file__)

"""
论文速递 → 微信公众号（含图片上传）
从 arxiv 下载论文图片，上传到微信 CDN，生成完整文章草稿。
"""
import urllib.request, json, time, sys, re, datetime, hashlib, os, html, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    score_emoji, format_medal
)
from utils import parse_analysis


def _paper_id(paper):
    """获取论文 ID（兼容 arXiv 和 ICML 格式）"""
    return paper.get('arxivId') or paper.get('id', '')


def _paper_url(paper):
    """获取论文链接（兼容 arXiv 和 ICML 格式）"""
    if paper.get('arxivId'):
        return f"https://arxiv.org/abs/{paper['arxivId']}"
    return paper.get('url', '')


APP_ID = os.environ.get('WECHAT_APP_ID', '')
APP_SECRET = os.environ.get('WECHAT_APP_SECRET', '')

if not APP_ID or not APP_SECRET:
    print("❌ 错误: 未设置 WECHAT_APP_ID 或 WECHAT_APP_SECRET 环境变量")
    sys.exit(1)

# 封面图素材 ID（永久素材），支持环境变量覆写
THUMB_MEDIA_ID = os.environ.get('WECHAT_THUMB_MEDIA_ID', '')
if not THUMB_MEDIA_ID:
    # 兜底默认值（硬编码素材 ID，若过期请设置 WECHAT_THUMB_MEDIA_ID 环境变量）
    THUMB_MEDIA_ID = "rOjE_rkui9ky0SAz7IMNE1l3FFjYGxFZ80cR0nTGBGqNCJBM_w0S3EBP7DbJR9yd"
    print("⚠️ 警告: 未设置 WECHAT_THUMB_MEDIA_ID，使用默认素材 ID。若上传失败请检查素材是否过期。")

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
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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
            with open(_cache_file, 'w') as f:
                json.dump(_image_cache, f)
        except Exception as e:
            print(f"  ⚠️ 缓存写入失败: {e}")

    return cdn_url


def main():
    data_file = sys.argv[1] if len(sys.argv) > 1 else None

    papers = load_papers(data_file)
    scored, unscored = score_and_sort(papers)

    token = get_token()
    print(f"🔑 Token OK")

    today = get_today_bj()

    all_imgs = set()
    for p in papers:
        for u in (p.get('imageUrls') or []) + (p.get('allImageUrls') or []):
            all_imgs.add(u)
    all_imgs = list(all_imgs)
    print(f"🖼️ 共 {len(all_imgs)} 张图片需要上传")

    img_map = {}
    success = 0
    fail = 0
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
        pa = parse_analysis(paper.get('analysis',''))
        title = paper.get('title','Unknown')
        aurl = _paper_url(paper)

        h = f'<h2>📄 {html.escape(title)}</h2>\n'
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
            if pa.get('primaryTaskTag'):
                meta.append(pa['primaryTaskTag'])
            if pa.get('primaryMethodTag'):
                meta.append(pa['primaryMethodTag'])
            if meta:
                h += f'<p style="color:#666;">{" | ".join(meta)}</p>\n'
            machine_parts = []
            if pa.get('qualityScore'):
                machine_parts.append(f'学术质量 {pa["qualityScore"]}/7')
            if pa.get('valueScore'):
                machine_parts.append(f'影响力 {pa["valueScore"]}/2')
            if pa.get('reproducibilityBonus'):
                machine_parts.append(f'可复现性 {pa["reproducibilityBonus"]}/2')
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
                    h += f'<p><strong>{label}</strong></p>\n<p>{html.escape(pa[key])}</p>\n'
        else:
            h += '<p style="color:#999;">⚠️ 该论文分析失败</p>\n'

        imgs = paper.get('imageUrls') or paper.get('allImageUrls') or []
        if imgs:
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
            else:
                print(f"  ❌ Part {part_num} 失败: {json.dumps(resp, ensure_ascii=False)}")
        except urllib.error.HTTPError as e:
            print(f"  ❌ Part {part_num} HTTP 错误: {e.code} {e.reason}")
            try:
                err_body = e.read().decode('utf-8', errors='replace')
                print(f"     响应: {err_body[:200]}")
            except Exception:
                pass
        except Exception as e:
            print(f"  ❌ Part {part_num} 请求异常: {e}")

    preview_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'current', f'wechat-preview-{today}.html')
    first_part_html = f'<h2 style="text-align:center;">语音/音乐/音频论文速递 {today}</h2>\n'
    first_part_html += f'<p style="text-align:center;color:#888;">共 {total} 篇，分 {total_parts} 部分</p>\n<hr/>\n'
    first_part_html += overview
    for ph, _ in paper_htmls:
        first_part_html += ph + SEPARATOR
    first_part_html += footer
    with open(preview_path, 'w') as f:
        f.write(first_part_html)

    print(f"\n🎉 全部完成！共 {total_parts} 个草稿已创建")


if __name__ == '__main__':
    main()
