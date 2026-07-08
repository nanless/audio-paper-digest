#!/usr/bin/env python3
from dotenv import load_dotenv
load_dotenv(override=False)  # shell 环境优先，.env 只补齐缺失配置

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
import json, re, sys, os, datetime, concurrent.futures

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    score_emoji, format_medal, extract_one_liner
)


def smart_truncate(text, max_len=65):
    """在句子边界智能截断文本，确保不超过 max_len 字符。"""
    if len(text) <= max_len:
        return text
    # 在 max_len 范围内找最后一个句子结束符
    for i in range(max_len, max_len // 2, -1):
        if i < len(text) and text[i] in '。！？.!?':
            return text[:i+1]
    #  fallback：在词语边界截断，避免截断到汉字中间
    for i in range(max_len, max_len // 2, -1):
        if i < len(text) and text[i] in '，、；：,;:\s':
            return text[:i]
    return text[:max_len]


def call_llm_for_oneliner(title, abstract):
    """调用 LLM 生成一句话论文介绍，自动检测协议。"""
    api_key = os.environ.get('PAPER_ANALYZER_API_KEY', '')
    endpoint = os.environ.get('PAPER_ANALYZER_ENDPOINT', 'https://api.openai.com/v1')
    model = os.environ.get('PAPER_ANALYZER_MODEL', 'gpt-4o')

    if not api_key:
        return None

    prompt = f"""用1-2句话总结下面这篇论文的核心亮点，要口语化、有吸引力，适合发小红书。总字数严格控制在70字以内，必须输出完整内容，不要省略：

标题：{title}
摘要：{abstract[:800]}

只输出介绍文字，不要任何解释、格式标记、emoji或LaTeX公式。"""

    # 自动检测协议（与 Node.js detectApiType 一致）
    ep_lower = endpoint.lower()
    model_lower = model.lower()
    is_token_plan = 'token-plan' in ep_lower or 'coding' in ep_lower
    is_mimo = 'xiaomimimo.com' in ep_lower or 'mimo' in model_lower
    is_kimi = 'kimi.com' in ep_lower or 'kimi' in model_lower

    if 'deepseek.com' in ep_lower or 'deepseek' in model_lower:
        api_type = 'openai'
    elif (is_mimo or is_kimi) and is_token_plan:
        api_type = 'anthropic'
    elif '/anthropic' in ep_lower:
        api_type = 'anthropic'
    else:
        api_type = 'openai'

    base = endpoint.rstrip('/')

    if api_type == 'anthropic':
        if 'xiaomimimo.com' in base:
            base = base.replace('/v1', '/anthropic')
            api_url = f"{base}/v1/messages"
        elif 'kimi.com' in base:
            api_url = f"{base}/messages"
        else:
            api_url = f"{base}/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "User-Agent": "claude-cli/2.1.108 (external, cli)",
            "Content-Type": "application/json"
        }
        payload = {"model": model, "max_tokens": 500, "messages": [{"role": "user", "content": prompt}]}
    else:
        base = base.replace('/anthropic', '/v1')
        api_url = f"{base}/chat/completions"
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json"
        }
        payload = {"model": model, "max_tokens": 500, "temperature": 0.7, "messages": [{"role": "user", "content": prompt}]}

    for attempt in range(5):
        try:
            import requests
            session = requests.Session()
            session.trust_env = False
            resp = session.post(api_url, json=payload, headers=headers, timeout=180)
            resp.raise_for_status()
            data = resp.json()
            content = ""
            if api_type == 'anthropic':
                if data.get("content") and isinstance(data["content"], list):
                    for block in data["content"]:
                        if block.get("type") == "text":
                            content = block.get("text", "").strip()
                            break
            else:
                content = data.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
            content = content.strip('"\'').strip()
            if len(content) > 10:
                return smart_truncate(content, max_len=65)
            if attempt < 4:
                import time
                time.sleep(3)
        except Exception as e:
            print(f"  ⚠️  LLM one-liner 失败 (尝试 {attempt+1}/5): {e}")
            if attempt < 4:
                import time
                time.sleep(3)

    return None


def generate_llm_oneliners(top_papers):
    """为 TOP N 论文并行生成 LLM one-liner"""
    print("🤖 正在调用 LLM 生成论文一句话介绍...")

    def worker(item):
        score, p, pa = item
        title = p.get('title', '')
        abstract = p.get('abstract', '') or p.get('summary', '')
        result = call_llm_for_oneliner(title, abstract)
        if result:
            print(f"  ✓ {title[:40]}... → {result[:50]}...")
            return result
        return None

    results = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        future_to_idx = {executor.submit(worker, item): i for i, item in enumerate(top_papers)}
        for future in concurrent.futures.as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                result = future.result()
                if result:
                    results[idx] = result
            except Exception as e:
                print(f"  ⚠️  并行任务异常: {e}")

    return results


def format_oss_badge(pa):
    """生成开源状态简短标签"""
    if not pa:
        return ''
    code = pa.get('hasCode', '')
    model = pa.get('hasModel', '')
    dataset = pa.get('hasDataset', '')

    badges = []
    if code and str(code).lower() in ('是', 'yes', 'true', '有'):
        badges.append('✅代码')
    if model and str(model).lower() in ('是', 'yes', 'true', '有'):
        badges.append('✅模型')
    if dataset and str(dataset).lower() in ('是', 'yes', 'true', '有'):
        badges.append('✅数据')

    if badges:
        return '📦 开源：' + ' '.join(badges)
    # 明确标记未开源，避免信息缺失感
    return '📦 开源：❌未开源'


def generate_top_n_post(scored, unscored, date_str, top_n=5):
    """生成 TOP N 精选版小红书文案"""
    top = scored[:top_n]

    # 调用 LLM 生成一句话介绍
    llm_oneliners = generate_llm_oneliners(top)

    total = len(scored) + len(unscored)
    repo_url = os.environ.get('PAPER_DIGEST_REPO_URL', 'github.com/nanless/audio-paper-digest')
    blog_url = os.environ.get('PAPER_DIGEST_BLOG_URL', 'https://nanless.github.io/audio-paper-digest-blog/posts')
    md = f"""✅ {date_str} 语音/音乐/音频论文速递 | {total}篇

TOP {top_n} 👇

"""
    for i, (score, p, pa) in enumerate(top):
        medal = format_medal(i)
        title = p.get('title', 'Unknown')
        if len(title) > 45:
            title = title[:42] + '...'
        liner = llm_oneliners.get(i) or smart_truncate(extract_one_liner(pa) or '', max_len=80)
        fire = score_emoji(score)
        score_line = f'{fire} {score}/10'
        if pa.get('rankBucket'):
            score_line += f' | {pa["rankBucket"]}'
        if pa.get('primaryMethodTag'):
            score_line += f' | {pa["primaryMethodTag"]}'

        oss_line = format_oss_badge(pa)
        oss_str = f"{oss_line}\n" if oss_line else ""
        md += f"""{medal} {title}
{score_line}
✨ {liner}
{oss_str}
"""

    md += f"""📋 {total}篇：{blog_url}/{date_str}/
🛠️ {repo_url}

💬 想看哪篇解读？告诉我！"""
    return md.strip()


def generate_all_summary_post(scored, unscored, date_str):
    """生成完整汇总版（每篇一行，适合分篇发或自己选择）"""
    total = len(scored) + len(unscored)
    repo_url = os.environ.get('PAPER_DIGEST_REPO_URL', 'github.com/nanless/audio-paper-digest')
    md = f"✅ {date_str} 语音/音乐/音频论文速递 | 共{total}篇\n\n🛠️ 筛选+分析流水线开源：{repo_url}\n\n"
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
        oss_line = format_oss_badge(pa)
        if oss_line:
            md += f"   {oss_line}\n"
        md += "\n"

    blog_url = os.environ.get('PAPER_DIGEST_BLOG_URL', 'https://nanless.github.io/audio-paper-digest-blog/posts')
    repo_url = os.environ.get('PAPER_DIGEST_REPO_URL', 'github.com/nanless/audio-paper-digest')
    md += f"""📄 全部论文：{blog_url}/{date_str}/
🛠️ 筛选+分析流水线开源：{repo_url}
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

    # 按 fetchedAt 日期过滤，只保留目标日期的论文
    today = get_today_bj(target_date)
    filtered = []
    for p in papers:
        fa = p.get('fetchedAt', '')
        if fa and isinstance(fa, str) and fa[:10] == today:
            filtered.append(p)
    if filtered:
        papers = filtered
        print(f"📅 过滤后: {len(papers)} 篇论文 (fetchedAt={today})")
    else:
        print(f"⚠️  没有 fetchedAt={today} 的论文，停止生成，避免跨日混入历史论文")
        return

    scored, unscored = score_and_sort(papers)

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
