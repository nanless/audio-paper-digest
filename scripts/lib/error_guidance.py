"""错误指引纯函数库：把运行错误翻译成"下一步该做什么"。

只读 error 的 code/message/cause 链与少量状态字段，不联网、不读写文件、
不打印原始错误文本中的密钥。调用方先打印原始错误/traceback，再调用
print_error_guidance() 追加 `[下一步] ...`，不得改变原退出码或吞掉堆栈。

输入可以是 Exception，也可以是带 snake_case 键的字典
（如 {'code': ..., 'message': ..., 'cause': {...}, 'status_code': 429}）。
输出字典固定使用 snake_case 键：cause / next_steps / commands / doc_ref。
"""

import logging
import re
import sys
from datetime import date as _date

_DOC_TROUBLESHOOTING = 'docs/troubleshooting.md'
_DOC_FETCH_BOUNDARY = 'docs/daily-fetch-boundary.md'
_DOC_READER_RETRY = 'docs/reader-explicit-retry.md'
_DOC_READER_WRITING = 'docs/reader-writing.md'
_DOC_LOCKED_SOURCE = 'docs/locked-source-validation.md'
_DOC_DATA_FORMAT = 'docs/data-format.md'
_DOC_THREE_WORKFLOWS = 'docs/three-workflows.md'

_FALLBACK_DATE = 'YYYY-MM-DD'
_MAX_CHAIN_DEPTH = 8

_SECRET_PATTERNS = (
    re.compile(r'\bsk-[A-Za-z0-9_-]{6,}\b'),
    re.compile(r'\bBearer\s+[A-Za-z0-9._~+/=-]{8,}', re.IGNORECASE),
    re.compile(
        r'\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|'
        r'authorization|secret|password)\b\s*[:=]\s*[^\s,;]+',
        re.IGNORECASE,
    ),
    re.compile(r'//[^/\s:@]+:[^/\s@]+@'),
)

_DATE_RE = re.compile(r'^(?:\d{4})-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$')
_DATE_ANY_RE = re.compile(r'(20\d{2}-\d{2}-\d{2})')
_ARXIV_ID_RE = re.compile(r'^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$')
_ARXIV_ID_ANY_RE = re.compile(r'\b(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)\b')


def redact_sensitive(value):
    """抹掉可能混进指引动态文本中的密钥；不用于已写死的命令字符串。"""
    text = '' if value is None else str(value)
    for pattern in _SECRET_PATTERNS:
        text = pattern.sub('[已隐藏敏感信息]', text)
    return text


def _normalize_date(value):
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not _DATE_RE.match(text):
        return None
    try:
        _date.fromisoformat(text)
    except ValueError:
        return None
    return text


def _normalize_arxiv_id(value):
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if _ARXIV_ID_RE.match(text) else None


def _error_chain(error):
    """收集 error 自身、cause、errors 构成的有限错误链。"""
    chain = []
    queue = [error]
    seen = set()
    while queue and len(chain) < _MAX_CHAIN_DEPTH:
        current = queue.pop(0)
        if current is None or isinstance(current, (bool, int, float)):
            continue
        if not isinstance(current, (str, bytes, dict, BaseException)):
            continue
        try:
            if current in seen:
                continue
            seen.add(current)
        except TypeError:
            pass
        chain.append(current)
        if isinstance(current, BaseException):
            for attribute in ('__cause__', '__context__'):
                nested = getattr(current, attribute, None)
                if nested is not None and nested is not current:
                    queue.append(nested)
            nested_errors = getattr(current, 'errors', None)
            if isinstance(nested_errors, (list, tuple)):
                queue.extend(nested_errors)
            arguments = getattr(current, 'args', ())
            if arguments and isinstance(arguments[0], (dict, BaseException)):
                queue.append(arguments[0])
        elif isinstance(current, dict):
            for key in ('cause', 'errors'):
                nested = current.get(key)
                if isinstance(nested, (list, tuple)):
                    queue.extend(nested)
                elif nested is not None:
                    queue.append(nested)
            detail = current.get('error')
            if isinstance(detail, (dict, BaseException)):
                queue.append(detail)
    return chain


def _text_of(chain):
    parts = []
    for item in chain:
        if isinstance(item, bytes):
            parts.append(item.decode('utf-8', 'replace'))
            continue
        if isinstance(item, str):
            parts.append(item)
            continue
        if isinstance(item, BaseException):
            text = str(item)
            if text.strip():
                parts.append(text)
            name = type(item).__name__
            if name:
                parts.append(name)
            for key in ('code', 'errno', 'reason', 'detail'):
                value = getattr(item, key, None)
                if isinstance(value, str) and value.strip():
                    parts.append(value)
            continue
        if isinstance(item, dict):
            for key in ('message', 'name', 'reason', 'detail', 'code'):
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    parts.append(value)
    return '\n'.join(parts)


def _codes_of(chain):
    codes = []
    for item in chain:
        if isinstance(item, BaseException):
            for key in ('code', 'errno'):
                value = getattr(item, key, None)
                if isinstance(value, (str, int)) and value not in codes:
                    codes.append(str(value).upper())
            name = type(item).__name__
            if isinstance(name, str) and name not in codes:
                codes.append(name.upper())
        elif isinstance(item, dict):
            for key in ('code', 'errno', 'name'):
                value = item.get(key)
                if isinstance(value, (str, int)) and value not in codes:
                    codes.append(str(value).upper())
    return codes


def _status_of(chain):
    for item in chain:
        values = item.items() if isinstance(item, dict) else (
            (key, getattr(item, key, None)) for key in ('status', 'status_code', 'http_status')
        )
        for key, value in values:
            if key in ('status', 'status_code', 'http_status') and isinstance(value, int) and not isinstance(value, bool):
                return value
    return None


def _field_of(chain, keys):
    for item in chain:
        if isinstance(item, dict):
            for key in keys:
                value = item.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        elif isinstance(item, BaseException):
            for key in keys:
                value = getattr(item, key, None)
                if isinstance(value, str) and value.strip():
                    return value.strip()
    return None


def _build_context(error, stage):
    chain = _error_chain(error)
    text = _text_of(chain)
    date = _normalize_date(_field_of(chain, ('date', 'batch_date', 'publish_date', 'target_date')))
    if not date:
        match = _DATE_ANY_RE.search(text)
        date = _normalize_date(match.group(1)) if match else None
    arxiv_id = _normalize_arxiv_id(_field_of(chain, ('arxiv_id', 'paper_id', 'normalized_id', 'id')))
    if not arxiv_id:
        match = _ARXIV_ID_ANY_RE.search(text)
        arxiv_id = _normalize_arxiv_id(match.group(1)) if match else None
    return {
        'chain': chain,
        'text': text,
        'codes': _codes_of(chain),
        'status': _status_of(chain),
        'stage': stage.strip() if isinstance(stage, str) and stage.strip() else None,
        'date': date or _FALLBACK_DATE,
        'arxiv_id': arxiv_id,
    }


def _fetch_command(date):
    return f'npm run fetch -- --date {date}'


def _deep_command(date):
    return f'npm run deep -- --date {date}'


def _batch_command():
    return 'npm run batch'


def _reanalyze_command():
    return 'npm run reanalyze -- --concurrency 3'


def _reader_command(date):
    return f'npm run api:reader:refresh -- --all --date {date} --concurrency 5 --scoring-and-reader'


def _generate_command(date):
    return f'npm run blog:generate -- --date {date}'


def _review_command(date):
    return f'npm run blog:review -- --date {date}'


def _push_command(date):
    return f'npm run blog:push -- --date {date}'


def _digest_status_command(date):
    return f'npm run digest:status -- --date {date}'


def _resume_command(context):
    stage = context['stage']
    date = context['date']
    if stage == 'fetch':
        return _fetch_command(date)
    if stage == 'deep-analysis':
        return _deep_command(date)
    if stage == 'batch-analyze':
        return _batch_command()
    if stage == 'reanalyze':
        return _reanalyze_command()
    if stage == 'api-reader':
        return _reader_command(date)
    return f'npm run digest:prepare -- {date}'


def _blog_stage_command(context):
    stage = context['stage']
    date = context['date']
    if isinstance(stage, str) and 'push' in stage:
        return _push_command(date)
    if isinstance(stage, str) and 'review' in stage:
        return _review_command(date)
    return _generate_command(date)


def _match_llm_account_pool(context):
    text = context['text']
    return (
        'INSUFFICIENT_BALANCE' in context['codes']
        or re.search(
            r'gousagelimiterror|insufficient[_\s-]?balance|insufficient[_\s-]?quota|账号池|'
            r'account[_\s-]?pool|incorrect api key|invalid api key|认证失败|鉴权失败|余额不足',
            text,
            re.IGNORECASE,
        )
        or (
            context['status'] == 401
            and re.search(r'api|llm|model|token|auth|key|密钥', text, re.IGNORECASE)
        )
    )


def _match_oai_rss_stale(context):
    return re.search(
        r'oai responseDate is stale|announcement.*(?:stale|future)|stale/future announcement|'
        r'官方.*(?:oai|rss).*(?:过期|陈旧|stale)|(?:oai|rss).*(?:边界|boundary).*(?:不一致|stale|过期)',
        context['text'],
        re.IGNORECASE,
    )


def _match_arxiv_rate_limit(context):
    text = context['text']
    limited = (
        context['status'] == 429
        or re.search(r'\b429\b|too many requests|rate[_\s-]?limit|限流', text, re.IGNORECASE)
        or any('RATE_LIMIT' in code for code in context['codes'])
    )
    external = (
        re.search(r'arxiv|arxiv\.org|抓取|拉取|fetch|下载|html|pdf|来源|download', text, re.IGNORECASE)
        or any(re.search(r'ARXIV|FETCH|RATE_LIMIT', code) for code in context['codes'])
    )
    return bool(limited and external)


def _match_reader_repair_no_progress(context):
    exhausted = {'READER_REPAIR_NO_PROGRESS', 'READER_REPAIR_ATTEMPTS_EXHAUSTED', 'READER_FULL_ATTEMPTS_EXHAUSTED'}
    return bool(
        exhausted.intersection(context['codes'])
        or re.search(r'no[_\s-]?progress|无进展|修复.*没有再?进展', context['text'], re.IGNORECASE)
    )


def _match_reader_operator_correction_rejected(context):
    return (
        'READER_OPERATOR_CORRECTION_REJECTED' in context['codes']
        or re.search(r'operator correction|人工修正.*(?:被拒|拒绝)|受控修正.*(?:无效|拒绝)', context['text'], re.IGNORECASE)
    )


def _match_table_adhesion(context):
    text = context['text']
    return bool(
        re.search(r'粘连复写|粘连|glued|duplicate(?:d)?\s+(?:cell|value)', text, re.IGNORECASE)
        and re.search(r'表格|单元格|table|cell|列头|行', text, re.IGNORECASE)
    )


def _match_table_header_units(context):
    return re.search(r'列头单位缺少|列头.*单位|表头.*单位|header.*unit', context['text'], re.IGNORECASE)


def _match_table_ablation_missing(context):
    return re.search(
        r'消融.*(?:缺少|没有保留|缺失|未保留)|缺少.*消融|ablation.*(?:missing|absent)',
        context['text'],
        re.IGNORECASE,
    )


def _match_blog_repository_dirty(context):
    return re.search(
        r'未提交改动|未提交|工作区.*(?:不干净|脏|污染|漂移)|工作树.*漂移|dirty\s+(?:worktree|repo)|'
        r'not\s+clean|uncommitted|相对当前 HEAD.*漂移|没有未提交改动',
        context['text'],
        re.IGNORECASE,
    )


def _match_blog_lock_busy(context):
    return re.search(
        r'博客仓库或同日期事务正在运行|等待共享博客仓库锁超时|等待共享博客仓库回收锁超时|'
        r'blog[_\s-]?lock.*(?:timeout|held|busy)',
        context['text'],
        re.IGNORECASE,
    )


def _match_paper_lock_busy(context):
    return re.search(
        r'等待文件锁超时|文件锁.*超时|论文锁|paper[_\s-]?lock|锁.*被占用|锁.*占用|规范.*锁|'
        r'lock.*(?:held|busy|timeout)',
        context['text'],
        re.IGNORECASE,
    )


def _match_source_sha_mismatch(context):
    return re.search(
        r'来源\s*SHA|source[_\s-]?sha|来源清单\s*SHA|sha-?256.*(?:不一致|不符|mismatch)|'
        r'(?:不一致|不符|mismatch).*sha-?256|来源.*SHA.*不一致',
        context['text'],
        re.IGNORECASE,
    )


def _match_generation_snapshot_stale(context):
    return re.search(
        r'生成快照.*(?:未刷新|过期|stale|不一致)|快照未刷新|'
        r'generation.*(?:snapshot|manifest).*(?:stale|outdated|mismatch)|'
        r'(?:stale|outdated).*(?:generation|manifest|snapshot)|'
        r'生成清单.*(?:无法读取|不是正式|日期不匹配|过期|不一致)|schema v3.*(?:不匹配|invalid)',
        context['text'],
        re.IGNORECASE,
    )


def _match_blog_review_receipt_missing(context):
    return re.search(r'审查凭证|review[_\s-]?receipt|未审查|尚未审查|没有.*审查通过', context['text'], re.IGNORECASE)


def _match_upstream_rate_limit(context):
    return bool(
        context['status'] == 429
        or re.search(r'\b429\b|too many requests|rate[_\s-]?limit|限流', context['text'], re.IGNORECASE)
        or any('RATE_LIMIT' in code for code in context['codes'])
    )


_RULES = (
    {
        'id': 'llm-account-pool',
        'doc_ref': _DOC_TROUBLESHOOTING,
        'match': _match_llm_account_pool,
        'cause': '模型账号池不可用：额度耗尽或鉴权失败，本次运行已停止派发新请求。',
        'next_steps': (
            '先核对项目根 .env 的同一账号池（PAPER_ANALYZER_API_KEY、PAPER_ANALYZER_FALLBACK_API_KEYS 等）和模型配置，不要在论文请求里循环重试。',
            '只有 HTTP 429 GoUsageLimitError 或 HTTP 401 Insufficient balance 才允许在同一逻辑请求内按等权轮转切换账号（每个账号至多一次）；普通 401、5xx、网络错误和输出截断都不切换。',
            '修复或确认账号后，从失败记录/检查点继续当前批次，已成功的论文不重跑。',
            '密钥、认证头和凭据指纹只做本地核对，不要写进日志或提交。',
        ),
        'commands': lambda context: [
            "grep -c '^PAPER_ANALYZER_API_KEY=' .env",
            'npm run workspace:role -- status',
            _digest_status_command(context['date']),
        ],
    },
    {
        'id': 'official-oai-rss-stale',
        'doc_ref': _DOC_FETCH_BOUNDARY,
        'match': _match_oai_rss_stale,
        'cause': '官方 OAI/RSS 元数据与固定批次边界不一致：来源可能尚未刷新或已过期。',
        'next_steps': (
            '保留当前检查点、来源计数和原始响应，不要手改来源数量或凭证。',
            '核对网络与代理是否真正连到官方来源，确认批次日期边界和本次补抓窗口。',
            '只有北京时间当天且检查点确实过期时才重新抓取；历史日期保留失败记录，按历史维护流程处理。',
        ),
        'commands': lambda context: [
            _fetch_command(context['date']),
            _fetch_command(context['date']) + ' --require-previously-fetched',
            'npm run validate:data',
        ],
    },
    {
        'id': 'arxiv-rate-limit',
        'doc_ref': _DOC_FETCH_BOUNDARY,
        'match': _match_arxiv_rate_limit,
        'cause': 'arXiv 或外部来源限流（HTTP 429），请求被拒绝且当前批次已暂停。',
        'next_steps': (
            '先等待冷却（抓取失败通常需要数十秒到数分钟退避），不要立刻整批重启。',
            '确认 HTTPS_PROXY/HTTP_PROXY 是项目 .env 里的 HTTP CONNECT 地址，且代理没有额外限流。',
            '恢复时只重跑同一来源和同一批次，已抓到的页与已成功论文不重抓。',
            '不要通过并发数、分页大小或直连来绕过限流。',
        ),
        'commands': lambda context: ['sleep 60', _fetch_command(context['date'])],
    },
    {
        'id': 'reader-repair-no-progress',
        'doc_ref': _DOC_READER_RETRY,
        'match': _match_reader_repair_no_progress,
        'cause': 'Reader 修复多轮没有进展（同类问题反复出现），重试已按规则停止。',
        'next_steps': (
            '保留原稿、检查点、失败记录和费用，不要手填通过或删除失败标记。',
            '按错误明细区分可定位问题（表格、列头单位、消融表等），先修来源或表格证据，再走正常 Reader 入口。',
            '整批首轮结束后只对真实可重试失败集合重跑 Reader，已通过论文复用原结果。',
            '多轮仍顽固时走受控人工/签名修正，并绑定原来源、失败稿 SHA 与修改范围。',
        ),
        'commands': lambda context: [_reader_command(context['date']), _digest_status_command(context['date'])],
    },
    {
        'id': 'reader-operator-correction-rejected',
        'doc_ref': _DOC_READER_RETRY,
        'match': _match_reader_operator_correction_rejected,
        'cause': '受控人工修正被拒：修改范围或来源证据没有通过校验，原稿未被替换。',
        'next_steps': (
            '先看拒稿明细里的 readerIssues，定位是节点范围、逐字来源还是表格绑定不成立。',
            '修正只允许 1–8 个既有节点，且每个改动都要有真实逐字来源；不要新增节点或手写数值。',
            '重新走正常 Reader 入口并通过整篇资格与来源检查，不能跳过校验、手填成功或删失败记录。',
        ),
        'commands': lambda context: [_reader_command(context['date']), _digest_status_command(context['date'])],
    },
    {
        'id': 'reader-table-adhesion',
        'doc_ref': _DOC_READER_WRITING,
        'match': _match_table_adhesion,
        'cause': '表格单元格出现粘连复写：提取时数字重复或列数据串位，当前内容不能直接采用。',
        'next_steps': (
            '核对完整原表 DOM/PDF 坐标，确认原值与列位置；不要按重复形状删数字。',
            '优先用完整原表或逐字引文重建该表，保留原条件、单位和数值列。',
            '重跑 Reader 后仍需通过来源、数字和整篇资格检查，再重新生成与审查博客。',
        ),
        'commands': lambda context: [_reader_command(context['date']), _generate_command(context['date'])],
    },
    {
        'id': 'reader-table-header-units',
        'doc_ref': _DOC_READER_WRITING,
        'match': _match_table_header_units,
        'cause': '表格列头或单位缺少原文证据，当前数字的含义无法确认。',
        'next_steps': (
            '回到同篇真实来源补齐列头或单位，不接受用共享列头单位给任意裸值作证。',
            '不改数字、不造伪列、不把别处指标单位搬到本表。',
            '重跑 Reader 后重新执行页面审查，确认表格条件、指标和单位一致。',
        ),
        'commands': lambda context: [_reader_command(context['date']), _review_command(context['date'])],
    },
    {
        'id': 'reader-table-ablation-missing',
        'doc_ref': _DOC_READER_WRITING,
        'match': _match_table_ablation_missing,
        'cause': '全文包含消融实验，但成稿没有保留关键消融或组件对照。',
        'next_steps': (
            '在结果/消融位置补一张来源明确、逐格可核验的对照表，并说明比较条件。',
            '只从本篇原表或逐字引文取数，不搬入数据、配置或成本表，保持原表数与绑定。',
            '重跑 Reader 并通过整篇资格后，再重新生成、审查和推送博客。',
        ),
        'commands': lambda context: [_reader_command(context['date']), _generate_command(context['date'])],
    },
    {
        'id': 'blog-repository-dirty',
        'doc_ref': _DOC_TROUBLESHOOTING,
        'match': _match_blog_repository_dirty,
        'cause': '博客仓库工作区不干净或停在非基线提交，发布器拒绝继续。',
        'next_steps': (
            '先在博客仓库查看改动，确认哪些是本次发布需要的、哪些是无关或人工修改。',
            '提交或恢复无关改动后回到基线；不要手删发布凭证、锁目录或强推远端。',
            '确认没有其他生成/审查/推送任务在跑，再按 generate→review→push 顺序重跑当前阶段。',
        ),
        'commands': lambda context: [
            'git -C "$PAPER_DIGEST_BLOG_REPO" status --short',
            _blog_stage_command(context),
        ],
    },
    {
        'id': 'blog-lock-busy',
        'doc_ref': _DOC_TROUBLESHOOTING,
        'match': _match_blog_lock_busy,
        'cause': '博客仓库或同日期发布事务正被其他任务持有，本次阶段已等待超时。',
        'next_steps': (
            '先确认是否有其他生成、审查或推送进程仍在运行，等它结束或自然释放。',
            '不要手删锁目录、发布凭证或强推；共享锁用于防止并发改博客。',
            '释放后按 generate→review→push 的顺序继续，审查凭证仍须匹配当前页面字节。',
        ),
        'commands': lambda context: [
            "ps -eo pid,etime,command | grep -E 'generate-blog|review-blog|push-blog|publish-to-blog' | grep -v grep",
            _blog_stage_command(context),
        ],
    },
    {
        'id': 'paper-lock-busy',
        'doc_ref': _DOC_TROUBLESHOOTING,
        'match': _match_paper_lock_busy,
        'cause': '论文/文件锁被其他进程持有，或锁等待超时，本篇暂时无法继续。',
        'next_steps': (
            '先确认是否还有分析、Reader 刷新或发布进程在跑，不要同时改同一篇论文。',
            '不要手删锁目录或伪造锁记录；等待持锁进程结束，或按锁超时回收规则处理。',
            '锁释放后从原检查点继续同一篇，已成功的阶段与费用不清零。',
        ),
        'commands': lambda context: [
            "ps -eo pid,etime,command | grep -E 'deep-analysis-only|batch-analyze|reanalyze|refresh-api-reader|full-fetch' | grep -v grep",
            _digest_status_command(context['date']),
        ],
    },
    {
        'id': 'source-sha-mismatch',
        'doc_ref': _DOC_LOCKED_SOURCE,
        'match': _match_source_sha_mismatch,
        'cause': '来源文件 SHA 与分析记录不一致：封存来源被替换、缺失或没有刷新。',
        'next_steps': (
            '不要手改 SHA、补建来源文件或用旧文本/缓存顶替封存来源。',
            '核对 data/runtime 下本次批次的来源目录与清单是否完整，确认论文身份、日期与 SHA 对应。',
            '北京时间当天批次重新 prepare 生成新封存来源后再分析；历史日期保留失败记录，按历史维护流程处理。',
        ),
        'commands': lambda context: [
            'npm run validate:data',
            f"npm run digest:prepare -- {context['date']}",
        ],
    },
    {
        'id': 'generation-snapshot-stale',
        'doc_ref': _DOC_DATA_FORMAT,
        'match': _match_generation_snapshot_stale,
        'cause': '生成快照/页面清单未刷新或已过期，审查和推送不能基于旧快照继续。',
        'next_steps': (
            '先重新生成页面与 schema v3 生成清单，不要手改清单或跳过生成阶段。',
            '生成后必须重新 review，审查凭证要匹配当前页面内容 SHA。',
            '只有 review 通过后才能 push；远端推送后还要核对部署与页面 HTTP 200。',
        ),
        'commands': lambda context: [
            _generate_command(context['date']),
            _review_command(context['date']),
            _push_command(context['date']),
        ],
    },
    {
        'id': 'blog-review-receipt-missing',
        'doc_ref': _DOC_THREE_WORKFLOWS,
        'match': _match_blog_review_receipt_missing,
        'cause': '缺少与当前页面字节匹配的审查凭证，推送被拒绝。',
        'next_steps': (
            '先运行 review 生成审查凭证；页面内容 SHA 变化时必须重新审查。',
            '不要手填、复制或复用旧凭证，也不要跳过审查直接推送。',
            'review 通过后再 push，并核对远端 main OID 与部署结果。',
        ),
        'commands': lambda context: [_review_command(context['date']), _push_command(context['date'])],
    },
    {
        'id': 'upstream-rate-limit',
        'doc_ref': _DOC_TROUBLESHOOTING,
        'match': _match_upstream_rate_limit,
        'cause': '上游服务限流（HTTP 429），请求被拒绝，当前阶段已暂停。',
        'next_steps': (
            '先等待冷却再重试，不要在已知限流条件下立刻循环请求。',
            '确认代理、账号和端点配置没有被额外限流，认证类错误不要按限流处理。',
            '恢复时只续当前阶段和失败集合，已成功结果不重跑。',
        ),
        'commands': lambda context: ['sleep 60', _resume_command(context)],
    },
)

_FALLBACK = {
    'id': 'generic-fallback',
    'doc_ref': _DOC_TROUBLESHOOTING,
    'cause': '运行失败，且没有匹配到已知错误类型；请先保留完整错误输出与堆栈再处理。',
    'next_steps': (
        '保存本次完整 stdout/stderr 与日志文件，确认失败阶段和退出码没有被改写。',
        '核对工作区角色、.env、代理和依赖是否满足运行前检查，不要绕过运行守卫。',
        '用 digest:status 查看当前批次断点，修复后只续失败集合，不重跑已成功论文。',
        '把完整错误交给维护者时先删除密钥、认证头和个人路径。',
    ),
    'commands': lambda context: ['npm run workspace:role -- status', 'npm run validate:data', _digest_status_command(context['date'])],
}


def _result_from_rule(rule, context):
    # 命令全部是写死的 npm/git/ps 模板，只插入已校验的日期；不经过密钥抹除，
    # 以免把 `PAPER_ANALYZER_API_KEY=` 这类安全的环境变量名误伤成不可执行的命令。
    return {
        'cause': rule['cause'],
        'next_steps': list(rule['next_steps']),
        'commands': [str(command) for command in rule['commands'](context)],
        'doc_ref': rule['doc_ref'],
    }


def guidance_for(error, stage=None):
    """匹配 error 链并返回 {cause, next_steps, commands, doc_ref}。

    未匹配时给通用兜底；不会修改 error，也不会抛出异常。
    """
    try:
        context = _build_context(error, stage)
    except Exception:
        context = {
            'chain': [], 'text': '', 'codes': [], 'status': None,
            'stage': stage if isinstance(stage, str) and stage.strip() else None,
            'date': _FALLBACK_DATE, 'arxiv_id': None,
        }
    for rule in _RULES:
        try:
            matched = bool(rule['match'](context))
        except Exception:
            matched = False
        if matched:
            return _result_from_rule(rule, context)
    return _result_from_rule(_FALLBACK, context)


def format_guidance_lines(guidance):
    lines = [f"[下一步] 原因：{guidance['cause']}"]
    for index, step in enumerate(guidance['next_steps'], start=1):
        lines.append(f'[下一步] {index}. {step}')
    for command in guidance['commands']:
        lines.append(f'[下一步] 可复制命令：{command}')
    if guidance.get('doc_ref'):
        lines.append(f"[下一步] 参考：{guidance['doc_ref']}")
    return lines


def print_error_guidance(error, stage=None, logger=None):
    """在调用方已打印原始错误/traceback 之后追加 `[下一步] ...`。

    默认写 stderr；传入 logger 时同时写入该 logger（不吞掉、不替换原错误）。
    """
    try:
        guidance = guidance_for(error, stage)
    except Exception:
        guidance = {
            'cause': _FALLBACK['cause'],
            'next_steps': [_FALLBACK['next_steps'][0]],
            'commands': [],
            'doc_ref': _DOC_TROUBLESHOOTING,
        }
    for line in format_guidance_lines(guidance):
        try:
            print(line, file=sys.stderr)
            if logger is not None and hasattr(logger, 'error'):
                logger.error(line)
        except Exception:
            # 打印指引绝不能掩盖原始错误。
            pass
    return guidance
