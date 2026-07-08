#!/usr/bin/env python3
"""
Paper Digest 发布公共模块 (Python)
统一封装：数据加载、评分排序、标签提取、格式化工具
消除 publish-to-blog.py / publish-wechat-full.py / publish-xiaohongshu.py 的重复逻辑
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from utils import parse_analysis

BJ_TZ = timezone(timedelta(hours=8))


class PublishLLMUnavailable(RuntimeError):
    """Raised when a required publish-time LLM review cannot run."""


def detect_publish_api_type(endpoint, model):
    """检测发布脚本使用的 LLM API 协议，与 Node utils.js 保持一致。"""
    ep = (endpoint or '').lower()
    m = (model or '').lower()
    if 'deepseek.com' in ep or 'deepseek' in m:
        return 'openai'
    is_token_plan = 'token-plan' in ep or 'coding' in ep
    is_mimo = 'xiaomimimo.com' in ep or 'mimo' in m
    is_kimi = 'kimi.com' in ep or 'kimi' in m
    if (is_mimo or is_kimi) and is_token_plan:
        return 'anthropic'
    if '/anthropic' in ep:
        return 'anthropic'
    return 'openai'


def build_publish_api_url(api_type, endpoint):
    """根据协议构造最终 LLM 请求 URL。"""
    base = (endpoint or '').rstrip('/')
    if api_type == 'anthropic':
        if 'xiaomimimo.com' in base:
            base = re.sub(r'/v1/?$', '/anthropic', base)
            return f'{base}/v1/messages'
        return f'{base}/messages'
    base = re.sub(r'/anthropic/?$', '/v1', base)
    return f'{base}/chat/completions'


def build_publish_headers(api_type, api_key):
    if api_type == 'anthropic':
        return {
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
            'User-Agent': 'claude-cli/2.1.108 (external, cli)',
            'Content-Type': 'application/json'
        }
    return {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json'
    }


def build_publish_payload(api_type, model, prompt, max_tokens, temperature):
    if api_type == 'anthropic':
        return {
            'model': model,
            'max_tokens': max_tokens,
            'messages': [{'role': 'user', 'content': prompt}]
        }
    return {
        'model': model,
        'max_tokens': max_tokens,
        'temperature': temperature,
        'messages': [{'role': 'user', 'content': prompt}]
    }


def parse_publish_response_text(api_type, data):
    if api_type == 'anthropic':
        if isinstance(data.get('content'), list):
            for block in data['content']:
                if block.get('type') == 'text':
                    return (block.get('text') or '').strip()
        return ''
    return (data.get('choices', [{}])[0].get('message', {}).get('content') or '').strip()


def call_publish_llm_api(prompt, max_tokens=800, temperature=0.1, required=False, context='LLM review', timeout=120, max_retries=5):
    """调用发布阶段 LLM API。required=True 时，缺配置或连续失败会抛错。"""
    api_key = os.environ.get('PAPER_ANALYZER_API_KEY', '')
    endpoint = os.environ.get('PAPER_ANALYZER_ENDPOINT', 'https://api.openai.com/v1')
    model = os.environ.get('PAPER_ANALYZER_MODEL', 'gpt-4o')

    if not api_key:
        message = f'未配置 PAPER_ANALYZER_API_KEY，无法执行 {context}'
        if required:
            raise PublishLLMUnavailable(message)
        print(f'  ⚠️  {message}，跳过')
        return None

    api_type = detect_publish_api_type(endpoint, model)
    api_url = build_publish_api_url(api_type, endpoint)
    headers = build_publish_headers(api_type, api_key)
    payload = build_publish_payload(api_type, model, prompt, max_tokens, temperature)

    last_error = None
    for attempt in range(max_retries):
        try:
            import requests
            session = requests.Session()
            session.trust_env = False
            resp = session.post(api_url, json=payload, headers=headers, timeout=timeout)
            resp.raise_for_status()
            content = parse_publish_response_text(api_type, resp.json())
            if content:
                return content
            last_error = RuntimeError('LLM 返回内容为空')
        except Exception as exc:
            last_error = exc
            print(f'  ⚠️  {context} 调用失败 (尝试 {attempt + 1}/{max_retries}): {exc}')

        if attempt < max_retries - 1:
            time.sleep(2 ** attempt)

    if required:
        raise PublishLLMUnavailable(f'{context} 连续失败: {last_error}')
    return None


def load_papers(data_file=None):
    """从 deep-analysis-result.json 加载论文列表"""
    if data_file is None:
        data_file = os.path.join(
            os.path.dirname(__file__), '..', 'data', 'current', 'deep-analysis-result.json'
        )
    with open(data_file) as f:
        raw = json.load(f)
    papers = raw['papers'] if isinstance(raw, dict) else raw
    print(f"📚 读取 {len(papers)} 篇论文")
    return papers


def get_today_bj(target_date=None):
    """返回北京时间日期字符串 YYYY-MM-DD"""
    return target_date or datetime.now(BJ_TZ).strftime('%Y-%m-%d')


def score_emoji(score):
    """根据评分返回对应 emoji"""
    if score >= 8:
        return '🔥'
    if score >= 6:
        return '✅'
    return '📝'


def format_medal(index):
    """根据排名返回奖牌 emoji 或数字"""
    medals = ['🥇', '🥈', '🥉']
    return medals[index] if index < 3 else f'{index + 1}.'


def fix_latex_delimiters(text):
    r"""将 $...$ 转换为 \(...\)，$$...$$ 转换为 \[...\]。"""
    if not text:
        return text
    text = re.sub(r'(?<!\\)\$\$(.+?)\$\$', r'\\[\1\\]', text, flags=re.DOTALL)
    text = re.sub(r'(?<!\\)\$([^\s\$][^$]*?)\$', r'\\(\1\\)', text)
    text = re.sub(r'`([^`]*?)\$([^`]*?)\$([^`]*?)`', r'`\1\\(\2\\)\3`', text)
    return text


def escape_html_like_tags(text):
    r"""转义论文中可能被 Hugo 解析为 HTML 的标记。"""
    if not text:
        return text
    text = re.sub(r'(?<![a-zA-Z])<(/?)([SEse])>(?![a-zA-Z0-9])', r'`<\1\2>`', text)
    text = re.sub(
        r'(?<![a-zA-Z0-9`])<(/?)(task|perception|comprehension|reasoning|agent|action|state|observation|reward|goal|intent|belief|plan|policy|environment|module|component|feature|input|output|label|class|category|type|mode|phase|stage|step|layer|block|unit|node|edge|graph|tree|path|loop|branch|condition|constraint|rule|fact|evidence|proof|hypothesis|assumption|premise|conclusion|result|finding|insight|implication|contribution|limitation|direction|extension|variant|version|update|fix|issue|error|warning|notice|info|trace|log|record|entry|item|element|object|subject|target|source|reference|cite|quote|note|comment|remark|annotation|caption|title|heading|paragraph|sentence|phrase|word|token|char|symbol|sign|mark|tag|badge|identifier|id|key|code|pin|secret|ticket|voucher|license|permit|certificate|credential|award|medal|prize|gift|bonus|benefit|advantage|edge|lead|margin|gap|difference|distance|range|scope|span|scale|size|length|width|height|depth|volume|area|surface|space|place|spot|location|site|position|point|dot|pixel|fragment|shard|piece|part|portion|section|segment|slice|chunk|block|lump|mass|body|entity|thing|article|product|goods|material|substance|matter|fabric|cloth|garment|clothing|wear|dress|costume|uniform|outfit|suit|wardrobe|closet|cabinet|cupboard|pantry|cellar|basement|attic|loft|tower|spire|dome|vault|arch|beam|column|pillar|post|pole|rod|bar|rail|track|path|way|road|route|course|direction|heading|bearing|azimuth|elevation|altitude|latitude|longitude|coordinate|interrupt|backchannel|response|free|BEsound)(?![a-zA-Z0-9`])>',
        r'`<\1\2>`',
        text,
        flags=re.IGNORECASE
    )
    return text


def fix_image_markdown(text):
    r"""将 LLM 输出的非标准图片引用格式转换为标准 Markdown 图片语法。"""
    if not text:
        return text
    text = re.sub(
        r'(?:^|\n)\s*(?:-\s*)?外部\s*URL:\s*(https?://\S+?)\s*\(alt=([^)]+)\)',
        r'\n![\2](\1)',
        text,
        flags=re.MULTILINE
    )
    text = re.sub(
        r'(?:^|\n)\s*(?:-\s*)?外部\s*URL:\s*(https?://\S+?)\s+alt=(.+?)(?=\n|$)',
        r'\n![\2](\1)',
        text,
        flags=re.MULTILINE
    )
    text = re.sub(r'\(https?://[^)]+\.\.\.\)', '(image_url_truncated)', text)
    text = re.sub(r'!\[([^\]]*)\]\(data:;base64,\)', r'![\1](image_not_available)', text)
    return text


def truncate_base64_datauri(text, max_chars=50000):
    r"""截断过长的 base64 data URI，避免影响页面加载性能。"""
    if not text:
        return text

    def replacer(m):
        data = m.group(1)
        if len(data) > max_chars:
            return f'{m.group(0)[:100]}...[truncated {len(data)} chars]...'
        return m.group(0)

    return re.sub(r'data:image/[^;]+;base64,([A-Za-z0-9+/=]+)', replacer, text)


def fix_yaml_double_commas(text):
    r"""修复 YAML frontmatter 中的双逗号问题。"""
    if not text:
        return text
    parts = text.split('---\n', 2)
    if len(parts) >= 3:
        frontmatter = parts[1]
        frontmatter = re.sub(r',\s*,+', ',', frontmatter)
        frontmatter = re.sub(r'tags:\s*\[([^\]]*?),\s*\]', r'tags: [\1]', frontmatter)
        text = parts[0] + '---\n' + frontmatter + '---\n' + parts[2]
    return text


def strip_raw_inline_html(text):
    r"""去掉裸行内 HTML 样式标签，避免 Hugo/浏览器误渲染。"""
    if not text:
        return text
    return re.sub(
        r'<(s|e|b|i|u)(?:\s+[^>]*)?>(.*?)</\1>',
        lambda m: m.group(2),
        text,
        flags=re.IGNORECASE | re.DOTALL
    )


def fix_empty_markdown_links(text):
    r"""修复空 Markdown 链接/图片。"""
    if not text:
        return text
    text = re.sub(r'!\[([^\]]*)\]\s*\(\s*\)', r'![\1](image_not_available)', text)
    text = re.sub(r'(?<!!)\[([^\]]*)\]\s*\(\s*\)', r'\1', text)
    return text


def dedupe_image_alts(text):
    r"""补齐空图片 alt，并为重复 alt 加序号。"""
    if not text:
        return text
    seen = {}
    index = 0

    def repl(m):
        nonlocal index
        index += 1
        alt = (m.group(1) or '').strip()
        url = m.group(2)
        if not alt:
            alt = f"论文图{index}"
        count = seen.get(alt, 0) + 1
        seen[alt] = count
        if count > 1:
            alt = f"{alt} - 图{count}"
        return f"![{alt}]({url})"

    return re.sub(r'!\[([^\]]*)\]\(([^)\n]+)\)', repl, text)


def fix_yaml_unbalanced_quotes(text):
    r"""修复 frontmatter 中未闭合双引号。"""
    if not text:
        return text
    parts = text.split('---\n', 2)
    if len(parts) < 3:
        return text
    fixed_lines = []
    changed = False
    for line in parts[1].split('\n'):
        if ':' in line and '"' in line and line.count('"') % 2 != 0 and '[' not in line and ']' not in line:
            key, value = line.split(':', 1)
            fixed_lines.append(f"{key}: {json.dumps(value.strip().strip(chr(34)), ensure_ascii=False)}")
            changed = True
        else:
            fixed_lines.append(line)
    if not changed:
        return text
    return parts[0] + '---\n' + '\n'.join(fixed_lines) + '---\n' + parts[2]


def sanitize_markdown_for_publish(text):
    """发布前通用 Markdown 清洗。"""
    text = fix_latex_delimiters(text)
    text = escape_html_like_tags(text)
    text = strip_raw_inline_html(text)
    text = fix_image_markdown(text)
    text = fix_empty_markdown_links(text)
    text = dedupe_image_alts(text)
    text = truncate_base64_datauri(text)
    text = fix_yaml_double_commas(text)
    text = fix_yaml_unbalanced_quotes(text)
    return text


def score_and_sort(papers):
    """
    解析每篇论文的分析结果，按评分降序排列。
    返回 [(score, paper, parsed), ...]，未评分的排在最后。
    优先使用已解析好的 parsed 数据，避免重新解析覆盖手动修正。
    """
    scored = []
    unscored = []
    for p in papers:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if pa and pa.get('score'):
            try:
                scored.append((float(pa['score']), p, pa))
            except (ValueError, TypeError):
                unscored.append(p)
        else:
            unscored.append(p)
    scored.sort(key=lambda x: -x[0])
    return scored, unscored


def extract_top_tags(papers, limit=8):
    """
    从论文列表中提取主任务标签并统计频次。
    返回 [(tag, count), ...]，按数量降序。
    优先使用已解析好的 parsed 数据。
    """
    tag_count = {}
    for p in papers:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if not pa:
            continue
        hot_tag = pa.get('primaryTaskTag') or (pa['tags'][0] if pa.get('tags') else '')
        if hot_tag:
            tag_count[hot_tag] = tag_count.get(hot_tag, 0) + 1
    return sorted(tag_count.items(), key=lambda x: -x[1])[:limit]


def extract_all_tags(papers, limit=10):
    """
    提取所有标签（去重），用于博客标签云。
    返回标签字符串列表（不带 #）。
    优先使用已解析好的 parsed 数据。
    """
    tag_set = set()
    for p in papers:
        pa = p.get('parsed') or parse_analysis(p.get('analysis', ''))
        if not pa:
            continue
        if pa.get('primaryTaskTag'):
            tag_set.add(pa['primaryTaskTag'].replace('#', '').strip())
        for t in pa.get('tags', []):
            clean = t.replace('#', '').strip()
            if clean:
                tag_set.add(clean)
    return sorted(tag_set)[:limit]


def extract_one_liner(pa):
    """从分析结果中提取一句话亮点，优先用创新点或核心贡献，而非截断摘要"""
    text = ''

    # 1. 优先尝试 innovation 第一条
    innovation = pa.get('innovation', '')
    if innovation:
        first = innovation.split('\n')[0].strip()
        first = re.sub(r'^\d+\.\s*', '', first)
        if len(first) > 15:
            text = first

    # 2. 尝试从 summary 中提取核心贡献句（找"提出了"/"解决了"/"旨在"等）
    if not text:
        summary = pa.get('summary', '')
        if summary:
            sentences = re.split(r'[。\n]', summary)
            for s in sentences:
                s = s.strip()
                if not s or len(s) < 15:
                    continue
                # 优先找包含核心动作词的句子
                if re.search(r'提出了|解决了|旨在|针对|引入|设计|构建|发现|证明', s):
                    text = s
                    break
            if not text and sentences:
                text = sentences[0].strip()

    # 3. 回退到 roast
    if not text:
        roast = pa.get('roast', '')
        if roast:
            text = roast.split('。')[0].strip()

    # 清理 Markdown 和废话前缀
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    text = re.sub(r'__(.+?)__', r'\1', text)
    text = re.sub(r'`(.+?)`', r'\1', text)
    text = re.sub(r'^这篇论文旨在\s*', '', text)
    text = re.sub(r'^这篇技术报告全面介绍了\s*', '', text)
    text = re.sub(r'^本文针对\s*', '', text)
    text = re.sub(r'^本文提出了\s*', '', text)
    text = re.sub(r'^解决\s*', '', text)
    text = re.sub(r'^核心贡献：\s*', '', text)
    text = re.sub(r'^本文\s*', '', text)
    text = re.sub(r'^该工作\s*', '', text)
    text = re.sub(r'^本文中\s*', '', text)
    text = text.strip()

    if len(text) > 10:
        return text[:110] + ('...' if len(text) > 110 else '')
    return ''


def build_paper_meta(pa, aurl=''):
    """拼接评分、分档、主任务/主方法等关键信息（Markdown 格式）"""
    if not pa:
        return ''

    bits = []
    score = pa.get('score', '')
    if score:
        try:
            score_val = float(score)
            bits.append(f'{score_emoji(score_val)} **{score}/10**')
        except (ValueError, TypeError):
            pass

    if pa.get('rankBucket'):
        bits.append(pa['rankBucket'])
    if pa.get('primaryTaskTag'):
        bits.append(pa['primaryTaskTag'])
    if pa.get('primaryMethodTag'):
        bits.append(pa['primaryMethodTag'])

    extra_tags = [t for t in pa.get('tags', [])
                  if t not in {pa.get('primaryTaskTag'), pa.get('primaryMethodTag')}]
    if extra_tags:
        bits.append(' '.join(extra_tags[:2]))
    if aurl:
        bits.append(f'[arxiv]({aurl})')

    return ' | '.join(bits)


def parse_cli_args(argv, defaults=None):
    """
    通用命令行参数解析。
    返回 dict，包含 data_file、target_date 及自定义参数。
    """
    defaults = defaults or {}
    args = {
        'data_file': None,
        'target_date': None,
    }
    args.update(defaults)

    i = 1
    while i < len(argv):
        arg = argv[i]
        if arg == '--date' and i + 1 < len(argv):
            args['target_date'] = argv[i + 1]
            i += 1
        elif not arg.startswith('--'):
            args['data_file'] = arg
        i += 1
    return args
