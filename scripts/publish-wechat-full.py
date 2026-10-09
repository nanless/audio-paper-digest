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
import argparse, urllib.request, json, time, sys, re, datetime, hashlib, os, html, tempfile, base64
from functools import lru_cache

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers_for_publication_date, get_today_bj, score_and_sort, extract_top_tags,
    score_emoji, format_medal, validate_papers_for_publish, PublishDataValidationError,
    paper_batch_date, select_blog_published_snapshot
)
from path_config import atomic_write_json, atomic_write_text, wechat_preview_path
from tag_catalog import load_tag_catalog
from analysis_sections import evaluation_heading_issue
from utils import parse_analysis, read_tag_validation
from blog_entry_loader import load_publish_to_blog

APP_ID = os.environ.get('WECHAT_APP_ID', '')
APP_SECRET = os.environ.get('WECHAT_APP_SECRET', '')

# 封面图素材 ID（永久素材），支持项目 .env 覆写
THUMB_MEDIA_ID = os.environ.get('WECHAT_THUMB_MEDIA_ID', '')

BJ_TZ = datetime.timezone(datetime.timedelta(hours=8))

TAG_METADATA_FALLBACK_NOTICE = (
    '⚠️ 该批次未携带受控标签元数据，以下为旧式扁平标签计数，'
    '不代表新版任务/方法统计'
)


def batch_has_invalid_tag_metadata(papers):
    """逐篇检查受控标签元数据，任一缺失/失效即返回 True。

    ``publish_common.extract_top_tags`` 是不要求受控标签元数据 的旧式统计入口，
    允许 ``primaryTaskTag`` 缺失时回退到 ``tags[0]`` 并跳过解析失败的论文。
    发布通道不允许这样静默降级：这里显式判定降级条件，由正文写出声明。
    """
    registry = load_tag_catalog()
    papers = list(papers)
    try:
        for paper in papers:
            if isinstance(paper, dict):
                read_tag_validation(paper.get('parsed'))
    except ValueError as error:
        raise PublishDataValidationError(str(error)) from error
    for paper in papers:
        if not isinstance(paper, dict):
            return True
        parsed = paper.get('parsed')
        if not isinstance(parsed, dict):
            parsed = parse_analysis(paper.get('analysis', '')) or {}
        try:
            validation = read_tag_validation(parsed)
        except ValueError as error:
            raise PublishDataValidationError(str(error)) from error
        if not isinstance(validation, dict) or validation.get('valid') is not True \
                or not str(parsed.get('primaryTaskTag') or '').strip() \
                or validation.get('registryVersion') != registry['version'] \
                or validation.get('registrySha256') != registry.get('registrySha256'):
            return True
    return False


def build_overview(scored, unscored):
    """生成今日概览 HTML；标签元数据缺失时显式声明旧式扁平计数。"""
    papers = [p for _, p, _ in scored] + list(unscored)
    top_tags = extract_top_tags(papers, limit=8)
    has_invalid_tag_metadata = batch_has_invalid_tag_metadata(papers)
    top_scored = scored[:10]

    overview = '<h2>⚡ 今日概览</h2>\n'
    total = len(scored) + len(unscored)
    overview += f'<p>📥 抓取 {total} 篇 → 🔬 深度分析完成</p>\n'
    if has_invalid_tag_metadata:
        # 降级声明必须出现在扁平标签计数之前，而不是静默替换统计口径。
        overview += f'<p>{html.escape(TAG_METADATA_FALLBACK_NOTICE)}</p>\n'
    if top_tags:
        overview += '<h3>🏷️ 热门方向</h3>\n'
        for tag, cnt in top_tags:
            overview += f'<p>{tag}：{"█" * min(cnt, 15)} {cnt}篇</p>\n'
    if top_scored:
        overview += f'<h3>🏆 高分论文 TOP {len(top_scored)}</h3>\n'
        for i, (score, p, parsed_analysis) in enumerate(top_scored):
            m = format_medal(i)
            extra = ' | '.join([v for v in [parsed_analysis.get('rankBucket', ''), parsed_analysis.get('primaryTaskTag', '')] if v])
            suffix = f' | {extra}' if extra else ''
            overview += f'<p>{m} {html.escape(p.get("title", "")[:60])}（{score}分{suffix}）</p>\n'
    overview += '<hr/>\n'
    return overview


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


@lru_cache(maxsize=1)
def _image_downloader():
    return load_publish_to_blog()._download_review_image


def download_image(url):
    """复用博客图片的 HTTPS、地址固定、重定向、体积及图片格式校验。"""
    try:
        prepared = _image_downloader()(url)
        data = base64.b64decode(prepared['data'], validate=True)
        if prepared['media_type'] not in {'image/png', 'image/jpeg'}:
            from io import BytesIO
            from PIL import Image
            with Image.open(BytesIO(data)) as source:
                output = BytesIO()
                source.convert('RGB').save(output, format='PNG')
                data = output.getvalue()
        return data
    except Exception as error:
        print(f"  ⚠️ 图片下载或校验失败: {url[:60]}... ({error})")
        return None


def upload_to_wechat(token, img_data, filename='fig.png'):
    """把图片上传到微信，成功返回 CDN 地址，失败返回 None"""
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


# 图片缓存：同一个 URL 不必重复上传
_cache_file = os.path.join(tempfile.gettempdir(), 'wechat-image-cache.json')
_image_cache = {}
if os.path.exists(_cache_file):
    try:
        with open(_cache_file, 'r') as f:
            _image_cache = json.load(f)
    except:
        pass


def get_wechat_image_url(token, arxiv_url):
    """下载 arXiv 图片并上传到微信，成功返回 CDN 地址，失败返回 None；命中缓存就直接用。"""
    if arxiv_url in _image_cache:
        return _image_cache[arxiv_url]

    img_data = download_image(arxiv_url)
    if not img_data:
        return None

    ext = 'png' if img_data.startswith(b'\x89PNG\r\n\x1a\n') else 'jpg'
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
        heading_issue = evaluation_heading_issue(paper.get('analysis'))
        if heading_issue:
            raise ValueError(heading_issue)
        parsed_analysis = paper.get('parsed') or parse_analysis(paper.get('analysis',''))
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

        if parsed_analysis:
            if parsed_analysis['tags']:
                h += f'<p style="color:#1a73e8;">{" ".join(parsed_analysis["tags"])}</p>\n'
            score = float(parsed_analysis['score'] or '0')
            se = score_emoji(score)
            h += f'<p>{se} 评分：{html.escape(str(parsed_analysis["score"]))}/10'
            if aurl: h += f' | <a href="{aurl}">arxiv</a>'
            h += '</p>\n'
            meta = []
            if parsed_analysis.get('rankBucket'):
                meta.append(parsed_analysis['rankBucket'])
            if parsed_analysis.get('documentType'):
                meta.append(f'文档类型：{parsed_analysis["documentType"]}')
            if parsed_analysis.get('primaryTaskTag'):
                meta.append(parsed_analysis['primaryTaskTag'])
            if parsed_analysis.get('primaryMethodTag'):
                meta.append(parsed_analysis['primaryMethodTag'])
            if meta:
                h += f'<p style="color:#666;">{" | ".join(meta)}</p>\n'
            machine_parts = []
            if parsed_analysis.get('innovationScore'):
                machine_parts.append(f'创新 {parsed_analysis["innovationScore"]}/2')
            if parsed_analysis.get('technicalRigorScore'):
                machine_parts.append(f'严谨 {parsed_analysis["technicalRigorScore"]}/1.5')
            if parsed_analysis.get('experimentalSufficiencyScore'):
                machine_parts.append(f'实验 {parsed_analysis["experimentalSufficiencyScore"]}/1.5')
            if parsed_analysis.get('clarityScore'):
                machine_parts.append(f'清晰 {parsed_analysis["clarityScore"]}/1')
            if parsed_analysis.get('impactScore'):
                machine_parts.append(f'影响 {parsed_analysis["impactScore"]}/1.5')
            if parsed_analysis.get('openSourceScore'):
                machine_parts.append(f'开源 {parsed_analysis["openSourceScore"]}/1.5')
            if parsed_analysis.get('reproducibilityScore'):
                machine_parts.append(f'复现 {parsed_analysis["reproducibilityScore"]}/0.5')
            if parsed_analysis.get('engineeringScore'):
                machine_parts.append(f'工程 {parsed_analysis["engineeringScore"]}/1.5')
            if parsed_analysis.get('confidence'):
                machine_parts.append(f'置信度 {parsed_analysis["confidence"]}')
            if machine_parts:
                h += f'<p style="color:#888;">{" | ".join(machine_parts)}</p>\n'

            if parsed_analysis.get('authors'):
                h += f'<p><strong>👥 作者与机构</strong></p>\n<p>{html.escape(parsed_analysis["authors"])}</p>\n'

            sections = [
                ('💡 论文评价', 'roast'), ('📌 核心摘要', 'summary'),
                ('🏗️ 方法概述和架构', 'architecture'),
                ('💡 核心创新点', 'innovation'), ('🔬 细节详述', 'details'),
                ('📊 实验结果', 'results'), ('⚖️ 评分理由', 'scoringReason'),
                ('🚨 局限与问题', 'limitations'),
                ('🔗 开源详情', 'opensource'),
            ]
            for label, key in sections:
                if parsed_analysis.get(key):
                    h += f'<p><strong>{label}</strong></p>\n{render_rich_text(parsed_analysis[key])}'
        else:
            h += '<p style="color:#999;">⚠️ 该论文分析失败</p>\n'

        rendered_body_has_image = '<img ' in h
        imgs = paper.get('selectedImageUrls') or []
        if imgs and not rendered_body_has_image:
            h += '<p><strong>📸 论文图片</strong></p>\n'
            for img_url in imgs:
                cdn_url = img_map.get(img_url)
                if cdn_url:
                    h += f'<p><img src="{html.escape(cdn_url)}" data-src="{html.escape(cdn_url)}" /></p>\n'

        paper_htmls.append((h, paper))

    overview = build_overview(scored, unscored)
    total = len(scored) + len(unscored)

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

        article_html = f'<h2 style="text-align:center;">{part_title}</h2>\n'
        if total_parts > 1:
            article_html += f'<p style="text-align:center;color:#888;">共 {total} 篇，分 {total_parts} 部分发布，当前第 {part_num} 部分</p>\n'
        else:
            article_html += f'<p style="text-align:center;color:#888;">共分析 {total} 篇论文</p>\n'
        article_html += '<hr/>\n'

        if part_num == 1:
            article_html += overview

        for idx in part_indices:
            ph, _ = paper_htmls[idx]
            article_html += ph + SEPARATOR

        article_html += footer

        if dry_run:
            print(f"\n🧪 dry-run: 跳过创建草稿 Part {part_num} ({len(article_html)} chars)")
            continue

        print(f"\n📝 创建草稿 Part {part_num}... ({len(article_html)} chars)")

        payload = json.dumps({
            "articles": [{
                "title": part_title,
                "author": os.environ.get('PAPER_DIGEST_AUTHOR', ''),
                "digest": article_html.replace('<','').replace('>','')[:120],
                "content": article_html,
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
