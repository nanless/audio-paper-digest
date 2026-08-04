#!/usr/bin/env python3
from project_env import load_project_env
load_project_env()

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
import json, re, sys, os, datetime, concurrent.futures, hashlib
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from publish_common import (
    load_papers, get_today_bj, score_and_sort, extract_top_tags,
    score_emoji, format_medal, extract_one_liner, call_publish_llm_api,
    validate_papers_for_publish, normalize_publish_arxiv_id,
    PublishDataValidationError,
)
from path_config import (
    CURRENT_DIR, atomic_write_text, file_lock, read_json_strict, update_json_file_locked,
    validate_date_component,
    xiaohongshu_markdown_path, xiaohongshu_oneliner_cache_path,
)


_OSS_YES = {'是', 'yes', 'true', '有', '已开源', '已公开'}
_OSS_NO = {'否', 'no', 'false', '无', '未开源', '未公开'}
_ONELINER_CACHE_SCHEMA_VERSION = 1
_ONELINER_TEMPERATURE = 0.7
_ONELINER_RENDER_CONTRACT_VERSION = 1
MAX_TOP_N = 20
BEIJING_TIMESTAMP_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{3})?\+08:00$'
)


def paper_batch_date(paper):
    explicit = paper.get('fetchBatchDate') or paper.get('batchDate')
    if explicit:
        return validate_date_component(explicit)
    fetched_at = paper.get('fetchedAt')
    match = BEIJING_TIMESTAMP_RE.fullmatch(fetched_at) if isinstance(fetched_at, str) else None
    if not match:
        label = paper.get('arxivId') or paper.get('title') or '<unknown>'
        raise PublishDataValidationError(f'{label} fetchedAt 不是严格北京时间戳')
    return validate_date_component(match.group(1))


def select_blog_published_snapshot(
    papers, date_str, manifest_path=None, receipt_path=None,
):
    """若同日博客清单存在，只保留博客实际生成的权威论文快照。"""
    date_str = validate_date_component(date_str)
    path = Path(manifest_path) if manifest_path is not None else (
        CURRENT_DIR / f'blog-generation-manifest-{date_str}.json'
    )
    if not path.is_file():
        return papers
    try:
        manifest = read_json_strict(path)
    except (OSError, RuntimeError) as exc:
        raise PublishDataValidationError(f'博客生成清单无法读取: {path}') from exc
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 3:
        raise PublishDataValidationError(f'博客生成清单不是正式 schema v3: {path}')
    if manifest.get('date') != date_str:
        raise PublishDataValidationError(f'博客生成清单日期不匹配: {path}')

    receipt_target = Path(receipt_path) if receipt_path is not None else (
        CURRENT_DIR / f'blog-review-receipt-{date_str}.json'
    )
    try:
        receipt = read_json_strict(receipt_target)
    except (FileNotFoundError, OSError, RuntimeError) as exc:
        raise PublishDataValidationError(
            f'博客尚无可验证的发布凭证: {receipt_target}'
        ) from exc
    if not isinstance(receipt, dict):
        raise PublishDataValidationError('博客发布凭证顶层不是对象')
    manifest_sha256 = hashlib.sha256(path.read_bytes()).hexdigest()
    publication_commit = str(receipt.get('publicationCommit') or '').lower()
    remote_oid = str(receipt.get('remoteVerifiedOid') or '').lower()
    remote_verified_at = str(receipt.get('remoteVerifiedAt') or '')
    if (
        receipt.get('schemaVersion') != 3
        or receipt.get('date') != date_str
        or receipt.get('strictReview') is not True
        or receipt.get('generationManifestSha256') != manifest_sha256
        or not re.fullmatch(r'[0-9a-f]{40}', publication_commit)
        or remote_oid != publication_commit
        or not re.fullmatch(
            r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+08:00',
            remote_verified_at,
        )
    ):
        raise PublishDataValidationError('博客发布凭证未通过远端发布绑定校验')

    published = manifest.get('publishedPapers')
    if not isinstance(published, list) or not published:
        raise PublishDataValidationError('博客生成清单缺少已发布论文权威快照')

    available = {}
    for paper in papers:
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
        if paper_id in available:
            raise PublishDataValidationError(f'当前批次包含重复 arXiv ID: {paper_id}')
        available[paper_id] = paper

    selected = []
    seen = set()
    for paper in published:
        if not isinstance(paper, dict):
            raise PublishDataValidationError('博客已发布论文权威快照包含非法记录')
        paper_id = normalize_publish_arxiv_id(paper.get('arxivId'))
        if paper_id in seen:
            raise PublishDataValidationError(f'博客已发布论文权威快照包含重复 arXiv ID: {paper_id}')
        seen.add(paper_id)
        if paper_id not in available:
            raise PublishDataValidationError(f'博客已发布论文不在当前日期分析数据中: {paper_id}')
        if paper_batch_date(paper) != date_str:
            raise PublishDataValidationError(f'博客已发布论文快照批次日期不匹配: {paper_id}')
        selected.append(paper)
    print(f"🧾 根据博客发布清单选择: {len(selected)}/{len(papers)} 篇论文")
    return selected


def get_oneliner_concurrency():
    """返回项目 .env 配置的 one-liner 并发度，限制在安全范围内。"""
    raw = os.environ.get('PD_XIAOHONGSHU_ONELINER_CONCURRENCY', '5')
    try:
        value = int(raw)
        return 5 if value < 1 else min(value, 5)
    except (TypeError, ValueError):
        return 5


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
        if i < len(text) and (text[i] in '，、；：,;:' or text[i].isspace()):
            return text[:i]
    return text[:max_len]


def normalize_oss_status(value):
    """把结构化开源字段归一化为 yes/no/unknown。"""
    normalized = str(value or '').strip().lower()
    if normalized in _OSS_YES:
        return 'yes'
    if normalized in _OSS_NO:
        return 'no'
    return 'unknown'


def sanitize_oneliner_claims(text, pa=None):
    """依据结构化开源状态删除 one-liner 中相冲突的开源断言。"""
    pa = pa or {}
    claims = (
        ('hasCode', r'(?:代码|源码)(?:仓库)?'),
        ('hasModel', r'(?:模型权重|模型|权重|checkpoint)'),
        ('hasDataset', r'(?:数据集|数据)'),
    )
    cleaned = str(text or '')
    for field, subject in claims:
        if normalize_oss_status(pa.get(field)) != 'yes':
            cleaned = re.sub(
                rf'[，,；;]?\s*{subject}(?:已经|已|现已|目前)?(?:开源|公开|发布|可下载|可用)[！!。.]?',
                '。',
                cleaned,
                flags=re.IGNORECASE,
            )
    cleaned = re.sub(r'[\r\n\t\x00-\x1f]+', ' ', cleaned)
    cleaned = re.sub(r'^\s*(?:[-*•]+|\d+[.)、])\s*', '', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip(' \"\'`#')
    cleaned = re.sub(r'。{2,}', '。', cleaned)
    cleaned = re.sub(r'\s+([，。！？；：,.!?;:])', r'\1', cleaned)
    return cleaned.strip()


def safe_oneliner(text, pa=None, max_len=65):
    """清洗、校验并截断 one-liner；不可用时返回 None 触发本地回退。"""
    cleaned = sanitize_oneliner_claims(text, pa)
    meaningful = re.findall(r'[\u4e00-\u9fffA-Za-z0-9]', cleaned)
    if len(meaningful) < 10:
        return None
    return smart_truncate(cleaned, max_len=max_len)


def build_oneliner_context(title, abstract, pa=None):
    """构造 one-liner 输入，优先使用深度分析 parsed 字段。"""
    pa = pa or {}
    parts = [
        f"标题：{title}",
    ]
    if pa.get('summary'):
        parts.append(f"核心摘要：{pa.get('summary', '')[:500]}")
    if pa.get('results'):
        parts.append(f"实验结果：{pa.get('results', '')[:450]}")
    if pa.get('limitations'):
        parts.append(f"局限：{pa.get('limitations', '')[:250]}")
    if pa.get('opensource'):
        parts.append(f"开源：{pa.get('opensource', '')[:220]}")
    if len(parts) <= 1 and abstract:
        parts.append(f"摘要：{abstract[:800]}")
    status_labels = {'yes': '已公开', 'no': '未公开', 'unknown': '未说明'}
    parts.append(
        '结构化开源状态：'
        f"代码={status_labels[normalize_oss_status(pa.get('hasCode'))]}；"
        f"模型={status_labels[normalize_oss_status(pa.get('hasModel'))]}；"
        f"数据集={status_labels[normalize_oss_status(pa.get('hasDataset'))]}"
    )
    if pa.get('primaryTaskTag') or pa.get('primaryMethodTag'):
        parts.append(f"标签：{pa.get('primaryTaskTag', '')} {pa.get('primaryMethodTag', '')}".strip())
    return "\n".join(parts)


def build_oneliner_prompt(title, abstract, pa=None):
    """构造稳定的 one-liner prompt，供调用和缓存指纹共同使用。"""
    context = build_oneliner_context(title, abstract, pa)
    return f"""用1-2句话总结下面这篇论文的核心亮点，要口语化、有吸引力，适合发小红书。总字数严格控制在70字以内，必须输出完整内容，不要省略。优先突出任务、方法、实验收益或开源价值，不要只复述标题。开源情况只能依据“结构化开源状态”，不得从其他文字推断：

{context}

只输出介绍文字，不要任何解释、格式标记、emoji或LaTeX公式。"""


def call_llm_for_oneliner(title, abstract, pa=None):
    """调用 LLM 生成一句话论文介绍，自动检测协议。"""
    prompt = build_oneliner_prompt(title, abstract, pa)

    content = call_publish_llm_api(
        prompt,
        max_tokens=500,
        temperature=_ONELINER_TEMPERATURE,
        required=False,
        context="小红书 one-liner",
        timeout=180
    )
    return safe_oneliner((content or '').strip('"\''), pa, max_len=65)


def _sha256_text(value):
    return hashlib.sha256(str(value or '').encode('utf-8')).hexdigest()


def _paper_cache_identity(paper):
    value = paper.get('normalizedArxivId') or paper.get('arxivId') or paper.get('paper_id') or paper.get('id')
    try:
        return normalize_publish_arxiv_id(value)
    except Exception:
        return ''


def build_oneliner_fingerprint(paper, pa):
    title = paper.get('title', '')
    abstract = paper.get('abstract', '') or paper.get('summary', '')
    prompt = build_oneliner_prompt(title, abstract, pa)
    config = {
        'model': os.environ.get('PAPER_ANALYZER_MODEL', ''),
        'endpoint': os.environ.get('PAPER_ANALYZER_ENDPOINT', ''),
        'temperature': _ONELINER_TEMPERATURE,
    }
    return {
        'analysisSha256': _sha256_text(paper.get('analysis', '')),
        'promptSha256': _sha256_text(prompt),
        'configSha256': _sha256_text(json.dumps(config, ensure_ascii=False, sort_keys=True)),
        'model': config['model'],
        'renderContractVersion': _ONELINER_RENDER_CONTRACT_VERSION,
    }


def _load_oneliner_cache(cache_path, date_str):
    cache_path = Path(cache_path)
    try:
        data = read_json_strict(cache_path, allow_missing=True)
    except RuntimeError as exc:
        _quarantine_oneliner_cache(cache_path, exc)
        return {'schemaVersion': _ONELINER_CACHE_SCHEMA_VERSION, 'date': date_str, 'entries': {}}
    if data is None:
        return {'schemaVersion': _ONELINER_CACHE_SCHEMA_VERSION, 'date': date_str, 'entries': {}}
    if not isinstance(data, dict) or data.get('schemaVersion') != _ONELINER_CACHE_SCHEMA_VERSION \
            or data.get('date') != date_str or not isinstance(data.get('entries'), dict):
        _quarantine_oneliner_cache(cache_path, '版本、日期或结构非法')
        return {'schemaVersion': _ONELINER_CACHE_SCHEMA_VERSION, 'date': date_str, 'entries': {}}
    return data


def _quarantine_oneliner_cache(cache_path, reason):
    """Atomically isolate a derived cache; generation may safely rebuild it."""
    cache_path = Path(cache_path)
    if not cache_path.exists():
        return None
    stamp = datetime.datetime.now().strftime('%Y%m%dT%H%M%S%f')
    quarantine = cache_path.with_name(f'{cache_path.name}.corrupt-{stamp}-{os.getpid()}')
    try:
        os.replace(cache_path, quarantine)
    except FileNotFoundError:
        return None
    print(f'⚠️ 小红书 one-liner 缓存已原子隔离并将重建: {quarantine} ({reason})')
    return quarantine


def _save_oneliner_cache_entry(
    cache_path, date_str, paper_id, fingerprint, status, oneliner=None,
    expected_entry=None,
):
    if not paper_id:
        return

    wrote = False

    def update(current):
        nonlocal wrote
        if current is None:
            current = {'schemaVersion': _ONELINER_CACHE_SCHEMA_VERSION, 'date': date_str, 'entries': {}}
        if current.get('schemaVersion') != _ONELINER_CACHE_SCHEMA_VERSION \
                or current.get('date') != date_str or not isinstance(current.get('entries'), dict):
            raise RuntimeError(f'小红书 one-liner 缓存结构非法，拒绝覆盖: {cache_path}')
        next_data = dict(current)
        entries = dict(current['entries'])
        current_entry = entries.get(paper_id)
        # Optimistic checkpoint CAS: a worker based on an older snapshot may
        # never replace a success written after that snapshot.
        if current_entry != expected_entry and isinstance(current_entry, dict) \
                and current_entry.get('status') == 'success':
            return None
        entries[paper_id] = {
            **fingerprint,
            'status': status,
            'oneliner': oneliner if status == 'success' else None,
            'updatedAt': datetime.datetime.now(
                datetime.timezone(datetime.timedelta(hours=8)),
            ).isoformat(),
        }
        next_data['entries'] = entries
        wrote = True
        return next_data

    update_json_file_locked(cache_path, update)
    return wrote


def generate_llm_oneliners(top_papers, date_str=None, cache_path=None):
    """并行生成 one-liner；跨运行复用成功项，只重试缺失或失败项。"""
    if not top_papers:
        return {}

    use_cache = bool(date_str)
    cache_path = cache_path or (xiaohongshu_oneliner_cache_path(date_str) if use_cache else None)
    cache = _load_oneliner_cache(cache_path, date_str) if use_cache else {'entries': {}}
    results = {}
    pending = []
    for idx, item in enumerate(top_papers):
        _score, paper, pa = item
        paper_id = _paper_cache_identity(paper)
        fingerprint = build_oneliner_fingerprint(paper, pa)
        cached = cache['entries'].get(paper_id) if paper_id else None
        reusable = (
            isinstance(cached, dict)
            and cached.get('status') == 'success'
            and isinstance(cached.get('oneliner'), str)
            and all(cached.get(key) == value for key, value in fingerprint.items())
        )
        if reusable:
            sanitized = safe_oneliner(cached['oneliner'], pa, max_len=65)
            if sanitized:
                results[idx] = sanitized
                if sanitized != cached['oneliner']:
                    _save_oneliner_cache_entry(
                        cache_path, date_str, paper_id, fingerprint, 'success', sanitized,
                        expected_entry=cached,
                    )
                continue
        pending.append((idx, item, paper_id, fingerprint, cached))

    if results:
        print(f"♻️ 复用小红书 one-liner 缓存 {len(results)} 篇，仅生成 {len(pending)} 篇")
    if not pending:
        return results

    workers = min(get_oneliner_concurrency(), len(pending))
    print(f"🤖 正在并发生成论文一句话介绍（并发度: {workers}）...")

    def worker(pending_item):
        idx, item, paper_id, fingerprint, expected_entry = pending_item
        score, p, pa = item
        title = p.get('title', '')
        abstract = p.get('abstract', '') or p.get('summary', '')
        result = call_llm_for_oneliner(title, abstract, pa)
        cache_saved = True
        if use_cache:
            try:
                cache_saved = _save_oneliner_cache_entry(
                    cache_path, date_str, paper_id, fingerprint,
                    'success' if result else 'fallback', result,
                    expected_entry=expected_entry,
                )
            except Exception:
                cache_saved = False
        return idx, result, cache_saved

    statuses = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_pending = {executor.submit(worker, item): item for item in pending}
        for future in concurrent.futures.as_completed(future_to_pending):
            idx, _item, paper_id, fingerprint, expected_entry = future_to_pending[future]
            try:
                _returned_idx, result, cache_saved = future.result()
                if result:
                    results[idx] = result
                    statuses[idx] = 'success' if cache_saved else 'success_cache_failed'
                else:
                    statuses[idx] = 'fallback' if cache_saved else 'fallback_cache_failed'
            except Exception:
                statuses[idx] = 'error'
                if use_cache:
                    try:
                        _save_oneliner_cache_entry(
                            cache_path, date_str, paper_id, fingerprint, 'error', None,
                            expected_entry=expected_entry,
                        )
                    except Exception:
                        pass

    for idx, _item, _paper_id, _fingerprint, _expected_entry in pending:
        if statuses.get(idx) == 'success':
            print(f"  ✓ 第 {idx + 1} 名：LLM one-liner 生成成功")
        elif statuses.get(idx) == 'success_cache_failed':
            print(f"  ⚠️  第 {idx + 1} 名：LLM 生成成功但 checkpoint 写入失败，本轮仍使用结果")
        elif statuses.get(idx) == 'error':
            print(f"  ⚠️  第 {idx + 1} 名：调用异常，将使用本地摘要")
        elif statuses.get(idx) == 'fallback_cache_failed':
            print(f"  ⚠️  第 {idx + 1} 名：无可用结果且 checkpoint 写入失败，将使用本地摘要")
        else:
            print(f"  ⚠️  第 {idx + 1} 名：LLM 无可用结果，将使用本地摘要")

    return results


def format_oss_badge(pa):
    """生成开源状态简短标签"""
    if pa is None:
        return ''
    statuses = {
        'code': normalize_oss_status(pa.get('hasCode')),
        'model': normalize_oss_status(pa.get('hasModel')),
        'dataset': normalize_oss_status(pa.get('hasDataset')),
    }

    badges = []
    if statuses['code'] == 'yes':
        badges.append('✅代码')
    if statuses['model'] == 'yes':
        badges.append('✅模型')
    if statuses['dataset'] == 'yes':
        badges.append('✅数据')

    if badges:
        return '📦 开源：' + ' '.join(badges)
    if all(status == 'no' for status in statuses.values()):
        return '📦 开源：❌未开源'
    return '📦 开源：未说明'


def generate_top_n_post(scored, unscored, date_str, top_n=5):
    """生成 TOP N 精选版小红书文案"""
    top = scored[:top_n]

    # 调用 LLM 生成一句话介绍
    llm_oneliners = generate_llm_oneliners(top, date_str=date_str)

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
        liner = llm_oneliners.get(i) or safe_oneliner(extract_one_liner(pa), pa, max_len=80) or ''
        fire = score_emoji(score)
        score_line = f'{fire} {score}/10'
        if pa.get('rankBucket'):
            score_line += f' | {pa["rankBucket"]}'
        if pa.get('documentType'):
            score_line += f' | {pa["documentType"]}'
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
        liner = safe_oneliner(extract_one_liner(pa), pa, max_len=80)
        fire = score_emoji(score)
        extras = [v for v in [pa.get('rankBucket', ''), pa.get('documentType', ''), pa.get('primaryTaskTag', '')] if v]
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
                if not 1 <= top_n <= MAX_TOP_N:
                    raise ValueError
            except ValueError:
                raise PublishDataValidationError(
                    f'--top 必须是 1-{MAX_TOP_N} 之间的整数: {sys.argv[i + 1]!r}'
                )
            i += 1
        elif arg == '--date' and i + 1 < len(sys.argv):
            target_date = sys.argv[i + 1]
            i += 1
        elif not arg.startswith('--'):
            data_file = arg
        i += 1

    today = validate_date_component(get_today_bj(target_date))
    with file_lock(CURRENT_DIR / f'xiaohongshu-{today}.generation', timeout_seconds=30):
        _generate_for_date(data_file, today, mode, top_n)


def _generate_for_date(data_file, today, mode, top_n):
    papers = load_papers(data_file)

    # 优先按不可变 fetchBatchDate 过滤，旧数据才回退严格北京 fetchedAt。
    filtered = []
    for p in papers:
        if paper_batch_date(p) == today:
            filtered.append(p)
    if filtered:
        papers = filtered
        print(f"📅 过滤后: {len(papers)} 篇论文 (fetchBatchDate={today})")
    else:
        print(f"⚠️  没有批次日期为 {today} 的论文，停止生成，避免跨日混入历史论文")
        return

    # 默认数据源应与同日博客实际生成集合严格一致，避免明确排除的失败/无关论文
    # 在小红书预检前再次阻断整个批次。自定义数据文件仍保持独立生成语义。
    if data_file is None:
        papers = select_blog_published_snapshot(papers, today)
    papers = validate_papers_for_publish(papers)
    scored, unscored = score_and_sort(papers)

    if mode == 'all':
        md = generate_all_summary_post(scored, unscored, today)
        suffix = 'all'
    else:
        md = generate_top_n_post(scored, unscored, today, top_n)
        suffix = f'top{top_n}'

    out_path = xiaohongshu_markdown_path(today, suffix)
    atomic_write_text(out_path, md)

    print(f"✅ 小红书文案已生成：{out_path}")
    print(f"   字数：{len(md)} 字符")
    print(f"\n--- 预览 ---\n")
    print(md[:800] + ('...' if len(md) > 800 else ''))


if __name__ == '__main__':
    main()
