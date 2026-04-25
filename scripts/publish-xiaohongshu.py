#!/usr/bin/env python3
from log_setup import setup_script_logging
setup_script_logging(__file__)

"""
论文速递 → 小红书文案生成
生成适合小红书风格的文字稿，支持 TOP N 精选版和完整汇总版。
用法：
    python3 publish-xiaohongshu.py                # 默认 TOP 5 精选版
    python3 publish-xiaohongshu.py --all          # 完整汇总版
    python3 publish-xiaohongshu.py --top 7        # 指定 TOP N
    python3 publish-xiaohongshu.py --date 2026-04-22
"""
import json, re, sys, os, datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    score_emoji, format_medal, extract_one_liner
)


def generate_top_n_post(scored, unscored, date_str, top_n=5):
    """生成 TOP N 精选版小红书文案"""
    top = scored[:top_n]

    hot_tags = extract_top_tags([p for _, p, _ in scored], limit=6)
    hot_tag_names = [t.replace('#', '') for t, _ in hot_tags]

    total = len(scored) + len(unscored)
    md = f"""✅ {date_str} 语音/AI论文速递 | {total}篇精选

今天挖到 {total} 篇语音/音频领域宝藏论文，
精选 TOP {top_n} 速来看👇

"""
    for i, (score, p, pa) in enumerate(top):
        medal = format_medal(i)
        title = p.get('title', 'Unknown')
        aid = p.get('arxivId', '')
        aurl = f'https://arxiv.org/abs/{aid}' if aid else ''
        liner = extract_one_liner(pa)
        fire = score_emoji(score)
        tags = [t for t in pa.get('tags', [])[:3] if t]
        if pa.get('primaryTaskTag') and pa['primaryTaskTag'] not in tags:
            tags.insert(0, pa['primaryTaskTag'])
        display_tags = ' '.join(tags[:3])
        score_line = f'{fire} 评分：{score}/10'
        if pa.get('rankBucket'):
            score_line += f' | {pa["rankBucket"]}'
        if pa.get('primaryMethodTag'):
            score_line += f' | {pa["primaryMethodTag"]}'

        md += f"""{medal} {title}
{score_line}
✨ 亮点：{liner}
🏷️ {display_tags}
{aurl and f'📄 arxiv：{aurl}' or ''}

"""

    md += f"""📈 今日趋势
"""
    if hot_tag_names:
        md += f"• 热门方向：{', '.join(hot_tag_names)}\n"

    md += f"""
📋 全部 {total} 篇已整理到博客
🔗 {os.environ.get('PAPER_DIGEST_BLOG_URL', '[博客地址]')}/{date_str}/

💬 你最想看哪篇的详细解读？
评论区告诉我！

#论文速递 #语音技术 #AI论文 #人工智能 #科研日常 #研究生 #读论文 #arXiv
"""
    return md.strip()


def generate_all_summary_post(scored, unscored, date_str):
    """生成完整汇总版（每篇一行，适合分篇发或自己选择）"""
    total = len(scored) + len(unscored)
    md = f"✅ {date_str} 语音/AI论文速递 | 共{total}篇\n\n"
    for i, (score, p, pa) in enumerate(scored):
        medal = format_medal(i)
        title = p.get('title', '')[:50]
        liner = extract_one_liner(pa)
        fire = score_emoji(score)
        extras = [v for v in [pa.get('rankBucket', ''), pa.get('primaryTaskTag', '')] if v]
        extra_text = f" | {' | '.join(extras)}" if extras else ''
        md += f"{medal} {title} {fire}{score}分{extra_text}\n"
        if liner:
            md += f"   ✨ {liner}\n"
        md += "\n"

    md += f"""📄 全部论文：{os.environ.get('PAPER_DIGEST_BLOG_URL', '[博客地址]')}/{date_str}/

#论文速递 #语音技术 #AI论文 #人工智能 #科研日常 #研究生 #读论文 #arXiv
"""
    return md.strip()


def main():
    data_file = None
    top_n = 5
    mode = 'top'
    target_date = None

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--all':
            mode = 'all'
        elif arg == '--top' and i + 1 < len(sys.argv):
            try:
                top_n = int(sys.argv[i + 1])
                if top_n < 1:
                    top_n = 1
            except ValueError:
                print(f"⚠️  忽略无效 --top 值: {sys.argv[i + 1]}，使用默认 5")
                top_n = 5
            i += 1
        elif arg == '--date' and i + 1 < len(sys.argv):
            target_date = sys.argv[i + 1]
            i += 1
        elif not arg.startswith('--'):
            data_file = arg
        i += 1

    papers = load_papers(data_file)
    scored, unscored = score_and_sort(papers)
    today = get_today_bj(target_date)

    if mode == 'all':
        md = generate_all_summary_post(scored, unscored, today)
        suffix = 'all'
    else:
        md = generate_top_n_post(scored, unscored, today, top_n)
        suffix = f'top{top_n}'

    out_dir = os.path.join(os.path.dirname(__file__), '..', 'data', 'current')
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f'xiaohongshu-{today}-{suffix}.md')
    with open(out_path, 'w') as f:
        f.write(md)

    print(f"✅ 小红书文案已生成：{out_path}")
    print(f"   字数：{len(md)} 字符")
    print(f"\n--- 预览 ---\n")
    print(md[:800] + ('...' if len(md) > 800 else ''))


if __name__ == '__main__':
    main()
