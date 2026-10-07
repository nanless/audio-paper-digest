#!/usr/bin/env python3
from project_env import load_project_env
load_project_env()

from log_setup import setup_script_logging
setup_script_logging(__file__)

"""
论文速递 → 飞书文档

- 凭据从环境变量 `FEISHU_APP_ID`、`FEISHU_APP_SECRET` 读取
- 使用 urllib.request 调用飞书 REST API
- 数据输入统一读取 deep-analysis-result.json

用法：
    python3 publish-to-feishu.py [data_file]
    python3 publish-to-feishu.py --date YYYY-MM-DD
    python3 publish-to-feishu.py --dry-run [data_file]
"""
import argparse, json, os, sys, re, html

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    PublishDataValidationError, extract_top_tags, get_today_bj, load_papers_for_publication_date,
    paper_batch_date, score_and_sort, select_blog_published_snapshot,
    validate_papers_for_publish,
)
from tag_catalog import load_tag_catalog
from analysis_sections import evaluation_heading_issue
from utils import parse_analysis, read_tag_validation

# ─── 飞书配置 ────────────────────────────────────────────
FEISHU_APP_ID = os.environ.get('FEISHU_APP_ID', '')
FEISHU_APP_SECRET = os.environ.get('FEISHU_APP_SECRET', '')


def feishu_request(url, headers=None, data=None, method='GET'):
    """发送飞书 API 请求"""
    import urllib.request
    req_headers = {'Content-Type': 'application/json'}
    if headers:
        req_headers.update(headers)

    req = urllib.request.Request(
        url,
        data=json.dumps(data).encode('utf-8') if data else None,
        headers=req_headers,
        method=method
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        if result.get('code', 0) != 0:
            raise Exception(f"Feishu API error: {result.get('msg', 'unknown')}")
        return result.get('data', result)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='replace')
        raise Exception(f"HTTP {e.code}: {err_body[:200]}")


def get_tenant_token(app_id, app_secret):
    """获取 tenant_access_token"""
    url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
    data = {'app_id': app_id, 'app_secret': app_secret}
    result = feishu_request(url, data=data, method='POST')
    return result['tenant_access_token']


def create_document(token, title):
    """创建飞书文档"""
    url = 'https://open.feishu.cn/open-apis/docx/v1/documents'
    result = feishu_request(url, headers={'Authorization': f'Bearer {token}'},
                           data={'title': title}, method='POST')
    return result['document']


def get_root_block_id(token, doc_id):
    """获取文档根 block ID"""
    url = f'https://open.feishu.cn/open-apis/docx/v1/documents/{doc_id}/blocks'
    result = feishu_request(url, headers={'Authorization': f'Bearer {token}'})
    return result['items'][0]['block_id']


def create_blocks(token, doc_id, block_id, children, index=0):
    """批量创建内容块"""
    url = (f'https://open.feishu.cn/open-apis/docx/v1/documents/'
           f'{doc_id}/blocks/{block_id}/children')
    result = feishu_request(
        url,
        headers={'Authorization': f'Bearer {token}'},
        data={'children': children, 'index': index},
        method='POST'
    )
    return result


def text_run(content, bold=False):
    """生成 text_run element"""
    tr = {'text_run': {'content': content}}
    if bold:
        tr['text_run']['text_element_style'] = {'bold': True}
    return tr


def md_to_feishu_blocks(md_text):
    """将 Markdown 转换为飞书 block 列表"""
    blocks = []
    lines = md_text.split('\n')
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # 一级标题
        if stripped.startswith('# ') and not stripped.startswith('## '):
            blocks.append({
                'block_type': 3,
                'heading1': {'elements': [text_run(stripped[2:].strip())]}
            })
        # 二级标题
        elif stripped.startswith('## ') and not stripped.startswith('### '):
            blocks.append({
                'block_type': 4,
                'heading2': {'elements': [text_run(stripped[3:].strip())]}
            })
        # 三级标题
        elif stripped.startswith('### '):
            blocks.append({
                'block_type': 5,
                'heading3': {'elements': [text_run(stripped[4:].strip())]}
            })
        # 分隔线
        elif stripped == '---':
            blocks.append({'block_type': 22, 'divider': {}})
        # 无序列表
        elif stripped.startswith('- ') or stripped.startswith('* '):
            content = stripped[2:]
            # 去掉 Markdown 的粗体和斜体标记
            content = re.sub(r'\*\*([^*]+)\*\*', r'\1', content)
            content = re.sub(r'\*([^*]+)\*', r'\1', content)
            blocks.append({
                'block_type': 12,
                'bullet': {'elements': [text_run(content)]}
            })
        # 有序列表
        elif re.match(r'^\d+\.\s', stripped):
            content = re.sub(r'^\d+\.\s', '', stripped)
            content = re.sub(r'\*\*([^*]+)\*\*', r'\1', content)
            blocks.append({
                'block_type': 13,
                'ordered': {'elements': [text_run(content)]}
            })
        # 表格（暂时跳过：飞书表格需要复杂的块结构）
        elif stripped.startswith('|'):
            # 跳过表格各行，只插入一句占位说明
            if i == 0 or not lines[i-1].strip().startswith('|'):
                blocks.append({
                    'block_type': 2,
                    'text': {'elements': [text_run('[表格内容，请手动粘贴或查看原博客]')]}
                })
            # 一直跳到表格结束
            while i < len(lines) and lines[i].strip().startswith('|'):
                i += 1
            continue
        # 普通段落
        else:
            # 去掉 Markdown 的粗体标记
            content = re.sub(r'\*\*([^*]+)\*\*', r'\1', stripped)
            content = re.sub(r'\*([^*]+)\*', r'\1', content)
            # 去掉 Markdown 的链接标记，只留文字
            content = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', content)
            blocks.append({
                'block_type': 2,
                'text': {'elements': [text_run(content)]}
            })

        i += 1

    return blocks


def generate_paper_md(paper, date_str):
    """生成单篇论文的 Markdown 内容"""
    heading_issue = evaluation_heading_issue(paper.get('analysis'))
    if heading_issue:
        raise ValueError(heading_issue)
    parsed_analysis = paper.get('parsed') or parse_analysis(paper.get('analysis', ''))
    title = paper.get('title', 'Unknown')
    aid = paper.get('arxivId', '')
    aurl = f'https://arxiv.org/abs/{aid}' if aid else ''

    md = f'# {title}\n\n'

    if parsed_analysis:
        if parsed_analysis.get('tags'):
            md += f"{' '.join(parsed_analysis['tags'])}\n\n"

        score = float(parsed_analysis.get('score', '0') or '0')
        se = '🔥' if score >= 8 else '✅' if score >= 6 else '📝'
        md += f'{se} **{parsed_analysis.get("score", "N/A")}/10**\n\n'

        metadata = []
        if parsed_analysis.get('documentType'):
            metadata.append(f'文档类型：{parsed_analysis["documentType"]}')
        if parsed_analysis.get('confidence'):
            metadata.append(f'评分置信度：{parsed_analysis["confidence"]}')
        if metadata:
            md += f'{" | ".join(metadata)}\n\n'

        if aurl:
            md += f'[arXiv]({aurl})\n\n'

        sections = [
            ('作者与机构', 'authors'),
            ('论文评价', 'roast'),
            ('核心摘要', 'summary'),
            ('方法概述和架构', 'architecture'),
            ('核心创新点', 'innovation'),
            ('细节详述', 'details'),
            ('实验结果', 'results'),
            ('评分理由', 'scoringReason'),
            ('局限与问题', 'limitations'),
            ('开源详情', 'opensource'),
        ]
        for label, key in sections:
            content = parsed_analysis.get(key, '')
            if content:
                md += f'## {label}\n\n{content}\n\n'

    return md


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


def generate_overview_md(scored, unscored, date_str):
    """生成汇总页 Markdown 内容"""
    for paper in [item[1] for item in scored] + list(unscored):
        heading_issue = evaluation_heading_issue(paper.get('analysis'))
        if heading_issue:
            raise ValueError(heading_issue)
    total = len(scored) + len(unscored)
    overview_papers = [p for _, p, _ in scored] + unscored
    top_tags = extract_top_tags(overview_papers, limit=8)
    has_invalid_tag_metadata = batch_has_invalid_tag_metadata(overview_papers)

    md = f'# 语音/音乐/音频论文速递 {date_str}\n\n'
    md += f'共分析 **{total}** 篇论文\n\n'
    md += '---\n\n'
    md += '## 今日概览\n\n'
    md += f'📥 抓取 {total} 篇 → 🔬 深度分析完成\n\n'

    if has_invalid_tag_metadata:
        # 降级声明必须出现在扁平标签计数之前，而不是静默替换统计口径。
        md += f'{TAG_METADATA_FALLBACK_NOTICE}\n\n'

    if top_tags:
        md += '### 热门方向\n\n'
        for tag, cnt in top_tags:
            bar = '█' * min(cnt, 15)
            md += f'- {tag}: {bar} {cnt}篇\n'
        md += '\n'

    if scored:
        md += f'### 论文评分排行榜（{len(scored)} 篇）\n\n'
        for i, (score, p, parsed_analysis) in enumerate(scored):
            medal = '🥇' if i == 0 else '🥈' if i == 1 else '🥉' if i == 2 else f'{i+1}.'
            title = p.get('title', 'Unknown')[:60]
            document_type = parsed_analysis.get('documentType', '') if parsed_analysis else ''
            type_suffix = f'，{document_type}' if document_type else ''
            md += f'- {medal} {title}（{score}分{type_suffix}）\n'
        md += '\n'

    md += '---\n\n'
    md += '## 论文列表\n\n'

    for i, (score, p, parsed_analysis) in enumerate(scored):
        title = p.get('title', 'Unknown')
        md += f'### {i+1}. {title}\n\n'
        if parsed_analysis:
            if parsed_analysis.get('roast'):
                md += f'💡 {parsed_analysis["roast"]}\n\n'
            if parsed_analysis.get('summary'):
                md += f'📌 {parsed_analysis["summary"]}\n\n'
        md += '---\n\n'

    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        md += f'### {len(scored)+i+1}. {title}\n\n'
        md += '> ⚠️ 该论文分析失败\n\n'
        md += '---\n\n'

    return md


def main():
    parser = argparse.ArgumentParser(prog='publish-to-feishu.py', allow_abbrev=False)
    parser.add_argument('data_file', nargs='?')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--all', action='store_true')
    parser.add_argument('--date')
    parser.add_argument('--ignore-blog-snapshot', action='store_true',
                        help='显式允许在同日博客尚未远端验证时独立发布')
    args = parser.parse_args()
    data_file = args.data_file
    target_date = args.date
    dry_run = args.dry_run
    publish_all = args.all
    ignore_blog_snapshot = args.ignore_blog_snapshot

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

    if dry_run:
        total = len(scored) + len(unscored)
        overview_md = generate_overview_md(scored, unscored, today)
        overview_blocks = md_to_feishu_blocks(overview_md)
        all_papers = [(p, parsed_analysis) for _, p, parsed_analysis in scored] + [(p, None) for p in unscored]
        paper_block_count = 0
        for paper, _ in all_papers:
            paper_block_count += len(md_to_feishu_blocks(generate_paper_md(paper, today)))
        print(f"🧪 dry-run: 将创建飞书文档《📚 语音/音乐/音频论文速递 {today} | {total}篇》")
        print(f"🧪 dry-run: 汇总 {len(overview_blocks)} 个块，论文正文约 {paper_block_count} 个块")
        print("🧪 dry-run: 未获取 Token，未创建飞书文档")
        return

    if not FEISHU_APP_ID or not FEISHU_APP_SECRET:
        print("❌ 错误: 未设置 FEISHU_APP_ID 或 FEISHU_APP_SECRET 环境变量")
        sys.exit(1)

    # 获取 token
    print(f"🔑 飞书凭据: app_id={FEISHU_APP_ID[:10]}...")
    token = get_tenant_token(FEISHU_APP_ID, FEISHU_APP_SECRET)
    print("✅ Token 获取成功")

    # 创建文档
    total = len(scored) + len(unscored)
    doc_title = f"📚 语音/音乐/音频论文速递 {today} | {total}篇"
    print(f"📝 创建飞书文档: {doc_title}")
    doc = create_document(token, doc_title)
    doc_id = doc['document_id']
    print(f"✅ 文档创建成功: {doc_id}")

    # 取根块 ID
    root_block_id = get_root_block_id(token, doc_id)
    print(f"📄 根块 ID: {root_block_id}")

    # 生成汇总部分
    overview_md = generate_overview_md(scored, unscored, today)
    overview_blocks = md_to_feishu_blocks(overview_md)
    print(f"📊 汇总内容: {len(overview_blocks)} 个块")

    doc_url = f"https://feishu.cn/docx/{doc_id}"
    try:
        # 汇总和各批次都按飞书已经接受的块数接着往后写。若改成按每篇论文
        # 算固定偏移，长文档会写乱。
        batch_size = 20
        next_index = 0
        for i in range(0, len(overview_blocks), batch_size):
            batch = overview_blocks[i:i + batch_size]
            create_blocks(token, doc_id, root_block_id, batch, index=next_index)
            next_index += len(batch)
            print(f"  ✅ 写入汇总块 {i+1}-{i+len(batch)}")

        all_papers = [(p, parsed_analysis) for _, p, parsed_analysis in scored] + [(p, None) for p in unscored]
        for idx, (paper, parsed_analysis) in enumerate(all_papers):
            paper_blocks = md_to_feishu_blocks(generate_paper_md(paper, today))
            for i in range(0, len(paper_blocks), batch_size):
                batch = paper_blocks[i:i + batch_size]
                create_blocks(token, doc_id, root_block_id, batch, index=next_index)
                next_index += len(batch)
            title = paper.get('title', 'Unknown')[:40]
            print(f"  ✅ 写入论文 {idx+1}/{len(all_papers)}: {title}")
    except Exception as exc:
        print(f"\n❌ 飞书文档写入未完成，已写入 {next_index} 个块；保留文档供恢复：{doc_url}")
        raise RuntimeError(f'飞书文档写入失败: {exc}') from exc

    print(f"\n🎉 飞书文档发布成功！")
    print(f"📎 文档链接: {doc_url}")
    print(f"📊 共 {total} 篇论文")


if __name__ == '__main__':
    sys.exit(0 if main() is not False else 1)
