/**
 * 纯函数错误指引库：把运行错误翻译成"下一步该做什么"。
 *
 * 只读 error 的 code/message/cause 链与少量状态字段，不联网、不读写文件、
 * 不打印任何原始错误文本中的密钥；调用方先打印原始错误/堆栈，再调用
 * printErrorGuidance() 追加 `[下一步] ...`，不得改变原错误码或退出码。
 */

const DOC_TROUBLESHOOTING = 'docs/troubleshooting.md';
const DOC_FETCH_BOUNDARY = 'docs/daily-fetch-boundary.md';
const DOC_READER_RETRY = 'docs/reader-explicit-retry.md';
const DOC_READER_WRITING = 'docs/reader-writing.md';
const DOC_LOCKED_SOURCE = 'docs/locked-source-validation.md';
const DOC_DATA_FORMAT = 'docs/data-format.md';
const DOC_THREE_WORKFLOWS = 'docs/three-workflows.md';

const FALLBACK_DATE = 'YYYY-MM-DD';
const MAX_CHAIN_DEPTH = 8;

const SECRET_PATTERNS = [
    /\bsk-[A-Za-z0-9_-]{6,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|authorization|secret|password)\b\s*[:=]\s*[^\s,;]+/gi,
    /\/\/[^/\s:@]+:[^/\s@]+@/g
];

/** 抹掉可能混进指引的动态文本中的密钥；不用于已写死的命令字符串。 */
function redactSensitive(value) {
    let text = String(value === undefined || value === null ? '' : value);
    for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[已隐藏敏感信息]');
    return text;
}

function normalizeDate(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const parsed = Date.parse(`${text}T00:00:00Z`);
    if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== text) return null;
    return text;
}

function normalizeArxivId(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return /^\d{4}\.\d{4,5}(?:v[1-9]\d*)?$/.test(text) ? text : null;
}

/** 收集 error 自身、cause、AggregateError.errors 构成的有限错误链。 */
function collectErrorChain(error) {
    const chain = [];
    const queue = [error];
    const seen = new Set();
    while (queue.length > 0 && chain.length < MAX_CHAIN_DEPTH) {
        const current = queue.shift();
        if (current === undefined || current === null || seen.has(current)) continue;
        if (typeof current !== 'object' && typeof current !== 'string') continue;
        seen.add(current);
        chain.push(current);
        if (typeof current === 'object') {
            if (current.cause !== undefined && current.cause !== null) queue.push(current.cause);
            if (Array.isArray(current.errors)) queue.push(...current.errors);
        }
    }
    return chain;
}

function collectText(chain) {
    const parts = [];
    for (const item of chain) {
        if (typeof item === 'string') { parts.push(item); continue; }
        if (typeof item !== 'object') continue;
        for (const key of ['message', 'name', 'reason', 'detail']) {
            if (typeof item[key] === 'string' && item[key].trim()) parts.push(item[key]);
        }
        if (typeof item.code === 'string' || typeof item.code === 'number') parts.push(String(item.code));
        if (typeof item.stack === 'string' && item.stack.trim()) parts.push(item.stack);
    }
    return parts.join('\n');
}

function collectCodes(chain) {
    const codes = new Set();
    for (const item of chain) {
        if (typeof item !== 'object' || item === null) continue;
        for (const key of ['code', 'errno', 'name']) {
            const value = item[key];
            if (typeof value === 'string' || typeof value === 'number') codes.add(String(value).toUpperCase());
        }
    }
    return [...codes];
}

function collectStatus(chain) {
    for (const item of chain) {
        if (typeof item !== 'object' || item === null) continue;
        for (const key of ['status', 'statusCode', 'httpStatus']) {
            const value = item[key];
            if (Number.isInteger(value)) return value;
        }
    }
    return null;
}

function collectField(chain, keys) {
    for (const item of chain) {
        if (typeof item !== 'object' || item === null) continue;
        for (const key of keys) {
            const value = item[key];
            if (typeof value === 'string' && value.trim()) return value.trim();
        }
    }
    return null;
}

function collectDate(chain, text) {
    const field = normalizeDate(collectField(chain, ['date', 'batchDate', 'publishDate', 'targetDate']));
    if (field) return field;
    const match = /(20\d{2}-\d{2}-\d{2})/.exec(text);
    return match ? normalizeDate(match[1]) : null;
}

function collectArxivId(chain, text) {
    const field = normalizeArxivId(collectField(chain, ['arxivId', 'paperId', 'normalizedId', 'id']));
    if (field) return field;
    const match = /\b(\d{4}\.\d{4,5}(?:v[1-9]\d*)?)\b/.exec(text);
    return match ? normalizeArxivId(match[1]) : null;
}

function buildContext(error, stage) {
    const chain = collectErrorChain(error);
    const text = collectText(chain);
    return {
        chain,
        text,
        codes: collectCodes(chain),
        status: collectStatus(chain),
        stage: typeof stage === 'string' && stage.trim() ? stage.trim() : null,
        date: collectDate(chain, text) || FALLBACK_DATE,
        arxivId: collectArxivId(chain, text)
    };
}

const FETCH_COMMAND = date => `npm run fetch -- --date ${date}`;
const DEEP_COMMAND = date => `npm run deep -- --date ${date}`;
const BATCH_COMMAND = () => 'npm run batch';
const REANALYZE_COMMAND = () => 'npm run reanalyze -- --concurrency 3';
const READER_COMMAND = date => `npm run api:reader:refresh -- --all --date ${date} --concurrency 5 --scoring-and-reader`;
const GENERATE_COMMAND = date => `npm run blog:generate -- --date ${date}`;
const REVIEW_COMMAND = date => `npm run blog:review -- --date ${date}`;
const PUSH_COMMAND = date => `npm run blog:push -- --date ${date}`;
const DIGEST_STATUS_COMMAND = date => `npm run digest:status -- --date ${date}`;

/** 按当前阶段给出"从该阶段继续"的恢复命令。 */
function resumeCommand(context) {
    const { stage, date } = context;
    if (stage === 'fetch') return FETCH_COMMAND(date);
    if (stage === 'deep-analysis') return DEEP_COMMAND(date);
    if (stage === 'batch-analyze') return BATCH_COMMAND();
    if (stage === 'reanalyze') return REANALYZE_COMMAND();
    if (stage === 'api-reader') return READER_COMMAND(date);
    return `npm run digest:prepare -- ${date}`;
}

/** 博客阶段命令：generate/review/push 各自只恢复自己的阶段。 */
function blogStageCommand(context) {
    const { stage, date } = context;
    if (typeof stage === 'string' && /push/.test(stage)) return PUSH_COMMAND(date);
    if (typeof stage === 'string' && /review/.test(stage)) return REVIEW_COMMAND(date);
    return GENERATE_COMMAND(date);
}

const RULES = [
    {
        id: 'llm-account-pool',
        docRef: DOC_TROUBLESHOOTING,
        match: ({ text, codes, status }) => codes.includes('INSUFFICIENT_BALANCE')
            || /gousagelimiterror|insufficient[_\s-]?balance|insufficient[_\s-]?quota|账号池|account[_\s-]?pool|incorrect api key|invalid api key|认证失败|鉴权失败|余额不足/i.test(text)
            || (status === 401 && /api|llm|model|token|auth|key|密钥/i.test(text)),
        cause: '模型账号池不可用：额度耗尽或鉴权失败，本次运行已停止派发新请求。',
        nextSteps: [
            '先核对项目根 .env 的同一账号池（PAPER_ANALYZER_API_KEY、PAPER_ANALYZER_FALLBACK_API_KEYS 等）和模型配置，不要在论文请求里循环重试。',
            '只有 HTTP 429 GoUsageLimitError 或 HTTP 401 Insufficient balance 才允许在同一逻辑请求内按等权轮转切换账号（每个账号至多一次）；普通 401、5xx、网络错误和输出截断都不切换。',
            '修复或确认账号后，从失败记录/检查点继续当前批次，已成功的论文不重跑。',
            '密钥、认证头和凭据指纹只做本地核对，不要写进日志或提交。'
        ],
        commands: context => [
            `grep -c '^PAPER_ANALYZER_API_KEY=' .env`,
            'npm run workspace:role -- status',
            DIGEST_STATUS_COMMAND(context.date)
        ]
    },
    {
        id: 'official-oai-rss-stale',
        docRef: DOC_FETCH_BOUNDARY,
        match: ({ text }) => /oai responseDate is stale|announcement.*(?:stale|future)|stale\/future announcement|官方.*(?:oai|rss).*(?:过期|陈旧|stale)|(?:oai|rss).*(?:边界|boundary).*(?:不一致|stale|过期)/i.test(text),
        cause: '官方 OAI/RSS 元数据与固定批次边界不一致：来源可能尚未刷新或已过期。',
        nextSteps: [
            '保留当前检查点、来源计数和原始响应，不要手改来源数量或凭证。',
            '核对网络与代理是否真正连到官方来源，确认批次日期边界和本次补抓窗口。',
            '只有北京时间当天且检查点确实过期时才重新抓取；历史日期保留失败记录，按历史维护流程处理。'
        ],
        commands: context => [
            FETCH_COMMAND(context.date),
            FETCH_COMMAND(context.date) + ' --require-previously-fetched',
            'npm run validate:data'
        ]
    },
    {
        id: 'arxiv-rate-limit',
        docRef: DOC_FETCH_BOUNDARY,
        match: ({ text, codes, status }) => {
            const limited = status === 429 || /\b429\b|too many requests|rate[_\s-]?limit|限流/i.test(text)
                || codes.some(code => /RATE_LIMIT/.test(code));
            const external = /arxiv|arxiv\.org|抓取|拉取|fetch|下载|html|pdf|来源|download/i.test(text)
                || codes.some(code => /ARXIV|FETCH|RATE_LIMIT/.test(code));
            return limited && external;
        },
        cause: 'arXiv 或外部来源限流（HTTP 429），请求被拒绝且当前批次已暂停。',
        nextSteps: [
            '先等待冷却（抓取失败通常需要数十秒到数分钟退避），不要立刻整批重启。',
            '确认 HTTPS_PROXY/HTTP_PROXY 是项目 .env 里的 HTTP CONNECT 地址，且代理没有额外限流。',
            '恢复时只重跑同一来源和同一批次，已抓到的页与已成功论文不重抓。',
            '不要通过并发数、分页大小或直连来绕过限流。'
        ],
        commands: context => ['sleep 60', FETCH_COMMAND(context.date)]
    },
    {
        id: 'reader-repair-no-progress',
        docRef: DOC_READER_RETRY,
        match: ({ text, codes }) => codes.some(code => [
            'READER_REPAIR_NO_PROGRESS', 'READER_REPAIR_ATTEMPTS_EXHAUSTED', 'READER_FULL_ATTEMPTS_EXHAUSTED'
        ].includes(code)) || /no[_\s-]?progress|无进展|修复.*没有再?进展/i.test(text),
        cause: 'Reader 修复多轮没有进展（同类问题反复出现），重试已按规则停止。',
        nextSteps: [
            '保留原稿、检查点、失败记录和费用，不要手填通过或删除失败标记。',
            '按错误明细区分可定位问题（表格、列头单位、消融表等），先修来源或表格证据，再走正常 Reader 入口。',
            '整批首轮结束后只对真实可重试失败集合重跑 Reader，已通过论文复用原结果。',
            '多轮仍顽固时走受控人工/签名修正，并绑定原来源、失败稿 SHA 与修改范围。'
        ],
        commands: context => [READER_COMMAND(context.date), DIGEST_STATUS_COMMAND(context.date)]
    },
    {
        id: 'reader-operator-correction-rejected',
        docRef: DOC_READER_RETRY,
        match: ({ text, codes }) => codes.includes('READER_OPERATOR_CORRECTION_REJECTED')
            || /operator correction|人工修正.*(?:被拒|拒绝)|受控修正.*(?:无效|拒绝)/i.test(text),
        cause: '受控人工修正被拒：修改范围或来源证据没有通过校验，原稿未被替换。',
        nextSteps: [
            '先看拒稿明细里的 readerIssues，定位是节点范围、逐字来源还是表格绑定不成立。',
            '修正只允许 1–8 个既有节点，且每个改动都要有真实逐字来源；不要新增节点或手写数值。',
            '重新走正常 Reader 入口并通过整篇资格与来源检查，不能跳过校验、手填成功或删失败记录。'
        ],
        commands: context => [READER_COMMAND(context.date), DIGEST_STATUS_COMMAND(context.date)]
    },
    {
        id: 'reader-table-adhesion',
        docRef: DOC_READER_WRITING,
        match: ({ text }) => /粘连复写|粘连|glued|duplicate(?:d)?\s+(?:cell|value)/i.test(text)
            && /表格|单元格|table|cell|列头|行/i.test(text),
        cause: '表格单元格出现粘连复写：提取时数字重复或列数据串位，当前内容不能直接采用。',
        nextSteps: [
            '核对完整原表 DOM/PDF 坐标，确认原值与列位置；不要按重复形状删数字。',
            '优先用完整原表或逐字引文重建该表，保留原条件、单位和数值列。',
            '重跑 Reader 后仍需通过来源、数字和整篇资格检查，再重新生成与审查博客。'
        ],
        commands: context => [READER_COMMAND(context.date), GENERATE_COMMAND(context.date)]
    },
    {
        id: 'reader-table-header-units',
        docRef: DOC_READER_WRITING,
        match: ({ text }) => /列头单位缺少|列头.*单位|表头.*单位|header.*unit/i.test(text),
        cause: '表格列头或单位缺少原文证据，当前数字的含义无法确认。',
        nextSteps: [
            '回到同篇真实来源补齐列头或单位，不接受用共享列头单位给任意裸值作证。',
            '不改数字、不造伪列、不把别处指标单位搬到本表。',
            '重跑 Reader 后重新执行页面审查，确认表格条件、指标和单位一致。'
        ],
        commands: context => [READER_COMMAND(context.date), REVIEW_COMMAND(context.date)]
    },
    {
        id: 'reader-table-ablation-missing',
        docRef: DOC_READER_WRITING,
        match: ({ text }) => /消融.*(?:缺少|没有保留|缺失|未保留)|缺少.*消融|ablation.*(?:missing|absent)/i.test(text),
        cause: '全文包含消融实验，但成稿没有保留关键消融或组件对照。',
        nextSteps: [
            '在结果/消融位置补一张来源明确、逐格可核验的对照表，并说明比较条件。',
            '只从本篇原表或逐字引文取数，不搬入数据、配置或成本表，保持原表数与绑定。',
            '重跑 Reader 并通过整篇资格后，再重新生成、审查和推送博客。'
        ],
        commands: context => [READER_COMMAND(context.date), GENERATE_COMMAND(context.date)]
    },
    {
        id: 'blog-repository-dirty',
        docRef: DOC_TROUBLESHOOTING,
        match: ({ text }) => /未提交改动|未提交|工作区.*(?:不干净|脏|污染|漂移)|工作树.*漂移|dirty\s+(?:worktree|repo)|not\s+clean|uncommitted|HEAD\s*\/?\s*工作区.*漂移|相对当前 HEAD.*漂移|没有未提交改动/i.test(text),
        cause: '博客仓库工作区不干净或停在非基线提交，发布器拒绝继续。',
        nextSteps: [
            '先在博客仓库查看改动，确认哪些是本次发布需要的、哪些是无关或人工修改。',
            '提交或恢复无关改动后回到基线；不要手删发布凭证、锁目录或强推远端。',
            '确认没有其他生成/审查/推送任务在跑，再按 generate→review→push 顺序重跑当前阶段。'
        ],
        commands: context => [
            'git -C "$PAPER_DIGEST_BLOG_REPO" status --short',
            blogStageCommand(context)
        ]
    },
    {
        id: 'blog-lock-busy',
        docRef: DOC_TROUBLESHOOTING,
        match: ({ text }) => /博客仓库或同日期事务正在运行|等待共享博客仓库锁超时|等待共享博客仓库回收锁超时|blog[_\s-]?lock.*(?:timeout|held|busy)/i.test(text),
        cause: '博客仓库或同日期发布事务正被其他任务持有，本次阶段已等待超时。',
        nextSteps: [
            '先确认是否有其他生成、审查或推送进程仍在运行，等它结束或自然释放。',
            '不要手删锁目录、发布凭证或强推；共享锁用于防止并发改博客。',
            '释放后按 generate→review→push 的顺序继续，审查凭证仍须匹配当前页面字节。'
        ],
        commands: context => [
            `ps -eo pid,etime,command | grep -E 'generate-blog|review-blog|push-blog|publish-to-blog' | grep -v grep`,
            blogStageCommand(context)
        ]
    },
    {
        id: 'paper-lock-busy',
        docRef: DOC_TROUBLESHOOTING,
        match: ({ text }) => /等待文件锁超时|文件锁.*超时|论文锁|paper[_\s-]?lock|锁.*被占用|锁.*占用|规范.*锁|lock.*(?:held|busy|timeout)/i.test(text),
        cause: '论文/文件锁被其他进程持有，或锁等待超时，本篇暂时无法继续。',
        nextSteps: [
            '先确认是否还有分析、Reader 刷新或发布进程在跑，不要同时改同一篇论文。',
            '不要手删锁目录或伪造锁记录；等待持锁进程结束，或按锁超时回收规则处理。',
            '锁释放后从原检查点继续同一篇，已成功的阶段与费用不清零。'
        ],
        commands: context => [
            `ps -eo pid,etime,command | grep -E 'deep-analysis-only|batch-analyze|reanalyze|refresh-api-reader|full-fetch' | grep -v grep`,
            DIGEST_STATUS_COMMAND(context.date)
        ]
    },
    {
        id: 'source-sha-mismatch',
        docRef: DOC_LOCKED_SOURCE,
        match: ({ text }) => /来源\s*SHA|source[_\s-]?sha|来源清单\s*SHA|sha-?256.*(?:不一致|不符|mismatch)|(?:不一致|不符|mismatch).*sha-?256|来源.*SHA.*不一致/i.test(text),
        cause: '来源文件 SHA 与分析记录不一致：封存来源被替换、缺失或没有刷新。',
        nextSteps: [
            '不要手改 SHA、补建来源文件或用旧文本/缓存顶替封存来源。',
            '核对 data/runtime 下本次批次的来源目录与清单是否完整，确认论文身份、日期与 SHA 对应。',
            '北京时间当天批次重新 prepare 生成新封存来源后再分析；历史日期保留失败记录，按历史维护流程处理。'
        ],
        commands: context => [
            'npm run validate:data',
            `npm run digest:prepare -- ${context.date}`
        ]
    },
    {
        id: 'generation-snapshot-stale',
        docRef: DOC_DATA_FORMAT,
        match: ({ text }) => /生成快照.*(?:未刷新|过期|stale|不一致)|快照未刷新|generation.*(?:snapshot|manifest).*(?:stale|outdated|mismatch)|(?:stale|outdated).*(?:generation|manifest|snapshot)|生成清单.*(?:无法读取|不是正式|日期不匹配|过期|不一致)|schema v3.*(?:不匹配|invalid)/i.test(text),
        cause: '生成快照/页面清单未刷新或已过期，审查和推送不能基于旧快照继续。',
        nextSteps: [
            '先重新生成页面与 schema v3 生成清单，不要手改清单或跳过生成阶段。',
            '生成后必须重新 review，审查凭证要匹配当前页面内容 SHA。',
            '只有 review 通过后才能 push；远端推送后还要核对部署与页面 HTTP 200。'
        ],
        commands: context => [
            GENERATE_COMMAND(context.date),
            REVIEW_COMMAND(context.date),
            PUSH_COMMAND(context.date)
        ]
    },
    {
        id: 'blog-review-receipt-missing',
        docRef: DOC_THREE_WORKFLOWS,
        match: ({ text }) => /审查凭证|review[_\s-]?receipt|未审查|尚未审查|没有.*审查通过/i.test(text),
        cause: '缺少与当前页面字节匹配的审查凭证，推送被拒绝。',
        nextSteps: [
            '先运行 review 生成审查凭证；页面内容 SHA 变化时必须重新审查。',
            '不要手填、复制或复用旧凭证，也不要跳过审查直接推送。',
            'review 通过后再 push，并核对远端 main OID 与部署结果。'
        ],
        commands: context => [REVIEW_COMMAND(context.date), PUSH_COMMAND(context.date)]
    },
    {
        id: 'upstream-rate-limit',
        docRef: DOC_TROUBLESHOOTING,
        match: ({ text, codes, status }) => status === 429 || /\b429\b|too many requests|rate[_\s-]?limit|限流/i.test(text)
            || codes.some(code => /RATE_LIMIT/.test(code)),
        cause: '上游服务限流（HTTP 429），请求被拒绝，当前阶段已暂停。',
        nextSteps: [
            '先等待冷却再重试，不要在已知限流条件下立刻循环请求。',
            '确认代理、账号和端点配置没有被额外限流，认证类错误不要按限流处理。',
            '恢复时只续当前阶段和失败集合，已成功结果不重跑。'
        ],
        commands: context => ['sleep 60', resumeCommand(context)]
    }
];

const FALLBACK = {
    id: 'generic-fallback',
    docRef: DOC_TROUBLESHOOTING,
    cause: '运行失败，且没有匹配到已知错误类型；请先保留完整错误输出与堆栈再处理。',
    nextSteps: [
        '保存本次完整 stdout/stderr 与日志文件，确认失败阶段和退出码没有被改写。',
        '核对工作区角色、.env、代理和依赖是否满足运行前检查，不要绕过运行守卫。',
        '用 digest:status 查看当前批次断点，修复后只续失败集合，不重跑已成功论文。',
        '把完整错误交给维护者时先删除密钥、认证头和个人路径。'
    ],
    commands: context => ['npm run workspace:role -- status', 'npm run validate:data', DIGEST_STATUS_COMMAND(context.date)]
};

function resultFromRule(rule, context) {
    return {
        cause: rule.cause,
        nextSteps: [...rule.nextSteps],
        // 命令全部是写死的 npm/git/ps 模板，只插入已校验的日期；不经过密钥抹除，
        // 以免把 `PAPER_ANALYZER_API_KEY=` 这类安全的环境变量名误伤成不可执行的命令。
        commands: rule.commands(context).map(String),
        docRef: rule.docRef
    };
}

/**
 * 匹配 error 链并返回 {cause, nextSteps, commands, docRef}。
 * 未匹配到规则时返回通用兜底；不会修改 error，也不会抛出。
 */
function guidanceFor(error, stage) {
    let context;
    try {
        context = buildContext(error, stage);
    } catch {
        context = { chain: [], text: '', codes: [], status: null, stage: stage || null, date: FALLBACK_DATE, arxivId: null };
    }
    for (const rule of RULES) {
        let matched = false;
        try {
            matched = Boolean(rule.match(context));
        } catch {
            matched = false;
        }
        if (matched) return resultFromRule(rule, context);
    }
    return resultFromRule(FALLBACK, context);
}

function formatGuidanceLines(guidance) {
    const lines = [`[下一步] 原因：${guidance.cause}`];
    guidance.nextSteps.forEach((step, index) => lines.push(`[下一步] ${index + 1}. ${step}`));
    for (const command of guidance.commands) lines.push(`[下一步] 可复制命令：${command}`);
    if (guidance.docRef) lines.push(`[下一步] 参考：${guidance.docRef}`);
    return lines;
}

/**
 * 在调用方已打印原始错误/堆栈之后追加 `[下一步] ...`。
 * 只写 stderr（或传入的 logger.error），绝不吞掉或替换原错误。
 */
function printErrorGuidance(error, options = {}) {
    const { stage, logger } = options || {};
    let guidance;
    try {
        guidance = guidanceFor(error, stage);
    } catch {
        guidance = { cause: FALLBACK.cause, nextSteps: [FALLBACK.nextSteps[0]], commands: [], docRef: DOC_TROUBLESHOOTING };
    }
    const write = line => {
        if (logger && typeof logger.error === 'function') logger.error(line);
        else console.error(line);
    };
    for (const line of formatGuidanceLines(guidance)) {
        try {
            write(line);
        } catch {
            // 打印指引绝不能掩盖原始错误。
        }
    }
    return guidance;
}

module.exports = {
    guidanceFor,
    printErrorGuidance,
    redactSensitive,
    collectErrorChain,
    formatGuidanceLines,
    FALLBACK_DATE
};
