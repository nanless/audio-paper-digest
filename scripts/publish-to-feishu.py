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
import json, os, sys, re, html

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import load_papers, get_today_bj, score_and_sort, extract_top_tags
from utils import parse_analysis

# ─── Feishu Config ────────────────────────────────────────────
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

        # Heading 1
        if stripped.startswith('# ') and not stripped.startswith('## '):
            blocks.append({
                'block_type': 3,
                'heading1': {'elements': [text_run(stripped[2:].strip())]}
            })
        # Heading 2
        elif stripped.startswith('## ') and not stripped.startswith('### '):
            blocks.append({
                'block_type': 4,
                'heading2': {'elements': [text_run(stripped[3:].strip())]}
            })
        # Heading 3
        elif stripped.startswith('### '):
            blocks.append({
                'block_type': 5,
                'heading3': {'elements': [text_run(stripped[4:].strip())]}
            })
        # Divider
        elif stripped == '---':
            blocks.append({'block_type': 22, 'divider': {}})
        # Unordered list
        elif stripped.startswith('- ') or stripped.startswith('* '):
            content = stripped[2:]
            # Strip markdown bold/italic
            content = re.sub(r'\*\*([^*]+)\*\*', r'\1', content)
            content = re.sub(r'\*([^*]+)\*', r'\1', content)
            blocks.append({
                'block_type': 12,
                'bullet': {'elements': [text_run(content)]}
            })
        # Ordered list
        elif re.match(r'^\d+\.\s', stripped):
            content = re.sub(r'^\d+\.\s', '', stripped)
            content = re.sub(r'\*\*([^*]+)\*\*', r'\1', content)
            blocks.append({
                'block_type': 13,
                'ordered': {'elements': [text_run(content)]}
            })
        # Table (skip for now - feishu tables need complex block structure)
        elif stripped.startswith('|'):
            # Skip table rows, add placeholder
            if i == 0 or not lines[i-1].strip().startswith('|'):
                blocks.append({
                    'block_type': 2,
                    'text': {'elements': [text_run('[表格内容，请手动粘贴或查看原博客]')]}
                })
            # Skip until end of table
            while i < len(lines) and lines[i].strip().startswith('|'):
                i += 1
            continue
        # Normal paragraph
        else:
            # Strip markdown bold
            content = re.sub(r'\*\*([^*]+)\*\*', r'\1', stripped)
            content = re.sub(r'\*([^*]+)\*', r'\1', content)
            # Strip markdown links
            content = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', content)
            blocks.append({
                'block_type': 2,
                'text': {'elements': [text_run(content)]}
            })

        i += 1

    return blocks


def generate_paper_md(paper, date_str):
    """生成单篇论文的 Markdown 内容"""
    pa = paper.get('parsed') or parse_analysis(paper.get('analysis', ''))
    title = paper.get('title', 'Unknown')
    aid = paper.get('arxivId', '')
    aurl = f'https://arxiv.org/abs/{aid}' if aid else ''

    md = f'# {title}\n\n'

    if pa:
        if pa.get('tags'):
            md += f"{' '.join(pa['tags'])}\n\n"

        score = float(pa.get('score', '0') or '0')
        se = '🔥' if score >= 8 else '✅' if score >= 6 else '📝'
        md += f'{se} **{pa.get("score", "N/A")}/10**\n\n'

        metadata = []
        if pa.get('documentType'):
            metadata.append(f'文档类型：{pa["documentType"]}')
        if pa.get('confidence'):
            metadata.append(f'评分置信度：{pa["confidence"]}')
        if metadata:
            md += f'{" | ".join(metadata)}\n\n'

        if aurl:
            md += f'[arXiv]({aurl})\n\n'

        sections = [
            ('作者与机构', 'authors'),
            ('毒舌点评', 'roast'),
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
            content = pa.get(key, '')
            if content:
                md += f'## {label}\n\n{content}\n\n'

    return md


def generate_overview_md(scored, unscored, date_str):
    """生成汇总页 Markdown 内容"""
    total = len(scored) + len(unscored)
    top_tags = extract_top_tags([p for _, p, _ in scored] + unscored, limit=8)

    md = f'# 语音/音乐/音频论文速递 {date_str}\n\n'
    md += f'共分析 **{total}** 篇论文\n\n'
    md += '---\n\n'
    md += '## 今日概览\n\n'
    md += f'📥 抓取 {total} 篇 → 🔬 深度分析完成\n\n'

    if top_tags:
        md += '### 热门方向\n\n'
        for tag, cnt in top_tags:
            bar = '█' * min(cnt, 15)
            md += f'- {tag}: {bar} {cnt}篇\n'
        md += '\n'

    if scored:
        md += f'### 论文评分排行榜（{len(scored)} 篇）\n\n'
        for i, (score, p, pa) in enumerate(scored):
            medal = '🥇' if i == 0 else '🥈' if i == 1 else '🥉' if i == 2 else f'{i+1}.'
            title = p.get('title', 'Unknown')[:60]
            document_type = pa.get('documentType', '') if pa else ''
            type_suffix = f'，{document_type}' if document_type else ''
            md += f'- {medal} {title}（{score}分{type_suffix}）\n'
        md += '\n'

    md += '---\n\n'
    md += '## 论文列表\n\n'

    for i, (score, p, pa) in enumerate(scored):
        title = p.get('title', 'Unknown')
        md += f'### {i+1}. {title}\n\n'
        if pa:
            if pa.get('roast'):
                md += f'💡 {pa["roast"]}\n\n'
            if pa.get('summary'):
                md += f'📌 {pa["summary"]}\n\n'
        md += '---\n\n'

    for i, p in enumerate(unscored):
        title = p.get('title', 'Unknown')
        md += f'### {len(scored)+i+1}. {title}\n\n'
        md += '> ⚠️ 该论文分析失败\n\n'
        md += '---\n\n'

    return md


def main():
    data_file = None
    target_date = None
    dry_run = False
    publish_all = False

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--dry-run':
            dry_run = True
        elif arg == '--all':
            publish_all = True
        elif arg == '--date' and i + 1 < len(sys.argv):
            target_date = sys.argv[i + 1]
            i += 1
        elif not arg.startswith('--'):
            data_file = arg
        i += 1

    papers = load_papers(data_file)
    today = get_today_bj(target_date)
    if not publish_all:
        papers = [
            p for p in papers
            if isinstance(p.get('fetchedAt', ''), str) and p.get('fetchedAt', '')[:10] == today
        ]
        print(f"📅 过滤后: {len(papers)} 篇论文 (fetchedAt={today})")
    else:
        print("📦 --all: 跳过 fetchedAt 日期过滤，使用输入文件中的全部论文")

    scored, unscored = score_and_sort(papers)

    if not papers:
        print("⚠️ 没有论文需要发布")
        return

    if dry_run:
        total = len(scored) + len(unscored)
        overview_md = generate_overview_md(scored, unscored, today)
        overview_blocks = md_to_feishu_blocks(overview_md)
        all_papers = [(p, pa) for _, p, pa in scored] + [(p, None) for p in unscored]
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

    # Get token
    print(f"🔑 飞书凭据: app_id={FEISHU_APP_ID[:10]}...")
    token = get_tenant_token(FEISHU_APP_ID, FEISHU_APP_SECRET)
    print("✅ Token 获取成功")

    # Create document
    total = len(scored) + len(unscored)
    doc_title = f"📚 语音/音乐/音频论文速递 {today} | {total}篇"
    print(f"📝 创建飞书文档: {doc_title}")
    doc = create_document(token, doc_title)
    doc_id = doc['document_id']
    print(f"✅ 文档创建成功: {doc_id}")

    # Get root block
    root_block_id = get_root_block_id(token, doc_id)
    print(f"📄 根块 ID: {root_block_id}")

    # Generate overview
    overview_md = generate_overview_md(scored, unscored, today)
    overview_blocks = md_to_feishu_blocks(overview_md)
    print(f"📊 汇总内容: {len(overview_blocks)} 个块")

    # Write overview
    batch_size = 20
    for i in range(0, len(overview_blocks), batch_size):
        batch = overview_blocks[i:i + batch_size]
        create_blocks(token, doc_id, root_block_id, batch, index=i)
        print(f"  ✅ 写入汇总块 {i+1}-{i+len(batch)}")

    # Generate each paper
    all_papers = [(p, pa) for _, p, pa in scored] + [(p, None) for p in unscored]
    for idx, (paper, pa) in enumerate(all_papers):
        paper_md = generate_paper_md(paper, today)
        paper_blocks = md_to_feishu_blocks(paper_md)

        # Write after existing content
        current_index = len(overview_blocks) + idx * 100  # rough offset
        for i in range(0, len(paper_blocks), batch_size):
            batch = paper_blocks[i:i + batch_size]
            create_blocks(token, doc_id, root_block_id, batch, index=current_index + i)

        title = paper.get('title', 'Unknown')[:40]
        print(f"  ✅ 写入论文 {idx+1}/{len(all_papers)}: {title}")

    doc_url = f"https://feishu.cn/docx/{doc_id}"
    print(f"\n🎉 飞书文档发布成功！")
    print(f"📎 文档链接: {doc_url}")
    print(f"📊 共 {total} 篇论文")


if __name__ == '__main__':
    main()
