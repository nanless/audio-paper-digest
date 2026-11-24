'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const https = require('https');
const { ANALYSIS_CONFIG } = require('../config.js');
const { createProxyAgent } = require('../utils.js');
const {
    PAPER_EVALUATION_TITLE,
    normalizeAnalysisSectionTitle,
    analysisSectionTitlePattern,
    analysisSectionHeadings,
    extractAnalysisSection,
    getPaperEvaluationHeadingIssue
} = require('./analysis-section-titles.js');
const {
    RESERVED_HF_PREFIXES,
    RESOURCE_NOT_RELEASED,
    THIRD_PARTY_RESOURCE,
    stripComparativeClosedSourceContrast,
    demoPlatformForToken,
    hasFollowingResourceRetraction,
    hasInlineTailRetraction,
    hasPrecedingResourceRetractionOrDeferral,
    hasExplicitThirdPartySourceAttribution,
    inferContextFacetsForRetraction,
    classifyRepositoryHostFacets,
    extractPaperSourceRepositoryCandidates,
    normalizePaperSourceRepositoryToken,
    normalizedSourceUrlBinding,
    paperSourceQuoteBindsOriginalUrl,
    paperSourceResourceFacets,
    paperSourceResourceQuote,
    resourceClassificationIsCurrent
} = require('./reader-resource-binding.js');
const readerIdentityFormat = require('./reader-identity-format');
const {
    canonicalizeIp: canonicalizePublicPolicyIp,
    hasHttpConnectProxy,
    isGloballyRoutableIp,
    isIpLiteral: isPublicPolicyIpLiteral,
    isValidHttpConnectProxyUrl,
    resolveHttpConnectProxyUrl,
    selectValidatedPublicIp
} = require('./public-network-policy.js');

const {
    imageDownloadTimeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
    imageMaxBytes: IMAGE_MAX_BYTES
} = ANALYSIS_CONFIG;

const API_READER_RESOURCE_IDENTITY_CONTRACT = readerIdentityFormat.header('resources').contract;
const REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT = 'repository-documentation-evidence-v1';

function recoverySha256(value) {
    return /^[0-9a-f]{64}$/.test(String(value || ''));
}

function stableFingerprint(value) {
    const normalize = item => {
        if (Array.isArray(item)) return item.map(normalize);
        if (!item || typeof item !== 'object') return item;
        return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    };
    return crypto.createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function contractRejectedError(message) {
    const error = new Error(message);
    error.code = 'CONTRACT_REJECTED';
    return error;
}

function findSectionBounds(analysis, title) {
    if (normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE) {
        if (getPaperEvaluationHeadingIssue(analysis)) return null;
        const headings = analysisSectionHeadings(analysis);
        const heading = headings.find(item => item.section === PAPER_EVALUATION_TITLE);
        if (!heading) return null;
        const next = headings.find(item => item.start >= heading.end);
        return { start: heading.start, contentStart: heading.end, end: next ? next.start : analysis.length };
    }
    const heading = new RegExp(
        `(^|\\n)((#{2,3})\\s*(?:\\d+[.\\s]+)?(?:${analysisSectionTitlePattern(title)})[：:\\s]*\\n)`,
        'm'
    );
    const match = heading.exec(analysis);
    if (!match) return null;
    const start = match.index + match[1].length;
    const contentStart = start + match[2].length;
    const rest = analysis.slice(contentStart);
    const level = match[3].length;
    const next = new RegExp(`\\n#{2,${level}}\\s`).exec(rest);
    const end = next ? contentStart + next.index : analysis.length;
    return { start, contentStart, end };
}

function extractSectionByTitle(analysis, title, followingTitles = []) {
    if (!analysis) return '';
    if (normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE) {
        return extractAnalysisSection(analysis, title);
    }
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?(?:${analysisSectionTitlePattern(title)})[：:\\s]*\\n)`,
        'm'
    );
    const match = heading.exec(analysis);
    if (!match) return '';

    const contentStart = match.index + match[1].length + match[2].length;
    const rest = analysis.slice(contentStart);
    let end = rest.length;
    const titleAlternation = followingTitles.map(analysisSectionTitlePattern).join('|');
    const nextSpecific = titleAlternation
        ? new RegExp(`\\n#{2,3}\\s*(?:\\d+[.\\s]+)?(?:${titleAlternation})[：:\\s]*\\n`)
        : null;
    const nextAny = /\n#{2,3}\s/g;
    const specificMatch = nextSpecific ? nextSpecific.exec(rest) : null;
    const anyMatch = nextAny.exec(rest);
    if (specificMatch) {
        end = specificMatch.index;
    } else if (anyMatch) {
        end = anyMatch.index;
    }
    return rest.slice(0, end).trim();
}

function normalizeSectionContent(title, newContent) {
    const heading = new RegExp(
        `^#{1,6}\\s*(?:\\d+[.\\s]+)?(?:${analysisSectionTitlePattern(title)})[：:\\s]*\\n*`,
        'i'
    );
    return (newContent || '').replace(heading, '').trim();
}

function mergeSectionByTitle(analysis, title, newContent) {
    if (normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE) {
        const issue = getPaperEvaluationHeadingIssue(analysis);
        if (issue) throw contractRejectedError(issue);
    }
    const cleanContent = normalizeSectionContent(title, newContent);
    if (normalizeAnalysisSectionTitle(title) === PAPER_EVALUATION_TITLE) {
        const bounds = findSectionBounds(analysis, title);
        if (bounds) {
            return `${analysis.slice(0, bounds.contentStart)}${cleanContent}\n\n${analysis.slice(bounds.end)}`;
        }
        return `${analysis.trim()}\n\n## ${PAPER_EVALUATION_TITLE}\n${cleanContent}`;
    }
    const heading = new RegExp(
        `(^|\\n)(#{2,3}\\s*(?:\\d+[.\\s]+)?(?:${analysisSectionTitlePattern(title)})[：:\\s]*\\n)([\\s\\S]*?)(?=\\n#{2,3}\\s|$)`
    );
    if (heading.test(analysis)) {
        return analysis.replace(heading, (match, prefix, header) => `${prefix}${header}${cleanContent}\n`);
    }
    return `${analysis.trim()}\n\n## ${title}\n${cleanContent}`;
}

function appendSectionByTitle(analysis, title, newContent) {
    const existing = extractSectionByTitle(analysis, title);
    const addition = normalizeSectionContent(title, newContent);
    if (!addition || existing.includes(addition)) return analysis;
    return mergeSectionByTitle(analysis, title, [existing, addition].filter(Boolean).join('\n\n'));
}

function setMachineSummaryField(analysis, key, value) {
    const bounds = findSectionBounds(analysis, '机器摘要');
    if (!bounds) return analysis;
    const section = analysis.slice(bounds.contentStart, bounds.end);
    const fieldPattern = new RegExp(`^${escapeRegExp(key)}\\s*[：:].*$`, 'm');
    const updatedSection = fieldPattern.test(section)
        ? section.replace(fieldPattern, `${key}: ${value}`)
        : `${key}: ${value}\n${section.replace(/^\s+/, '')}`;
    return analysis.slice(0, bounds.contentStart) + updatedSection + analysis.slice(bounds.end);
}

function isPublicNetworkPolicyConfigError(error) {
    return String(error?.code || '').startsWith('PUBLIC_NETWORK_POLICY_');
}

function isGloballyRoutableIpAddress(address) {
    return isGloballyRoutableIp(address);
}

function isPrivateIpAddress(address) {
    return !isGloballyRoutableIpAddress(address);
}

async function validatePublicHttpUrl(rawUrl, options = {}) {
    require('./conference-reader-operator-correction').assertMayAccessNetwork();
    require('./conference-source-resource-correction').assertMayAccessNetwork();
    const proxyEnabled = options?.proxyEnabled === true;
    const lookupImpl = options?.lookupImpl || dns.lookup;
    const policyOptions = {
        ...(options?.policy ? { policy: options.policy } : {}),
        ...(options?.policyPath ? { policyPath: options.policyPath } : {})
    };
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`不支持的公网 URL 协议: ${url.protocol}`);
    }
    if (url.username || url.password) {
        throw new Error('公网 URL 不允许包含用户名或密码');
    }
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const normalizedHostname = hostname.replace(/\.+$/, '');
    if (normalizedHostname === 'localhost'
        || normalizedHostname.endsWith('.localhost')
        || normalizedHostname.endsWith('.local')) {
        throw new Error('公网 URL 指向 localhost');
    }
    if (net.isIP(hostname) || isPublicPolicyIpLiteral(hostname) || hostname.includes('%')) {
        if (!isGloballyRoutableIp(hostname, policyOptions)) {
            throw new Error(`URL 指向非公网 IP: ${hostname}`);
        }
        const canonical = canonicalizePublicPolicyIp(hostname);
        url.validatedHostname = canonical;
        url.validatedAddress = canonical;
        url.validationMode = 'global';
        return url;
    }
    const records = await lookupImpl(hostname, { all: true, verbatim: false });
    if (!Array.isArray(records) || records.length === 0) {
        throw new Error(`公网 URL DNS 解析为空: ${hostname}`);
    }
    const selected = selectValidatedPublicIp(
        records.map(record => (typeof record === 'string' ? record : record?.address)),
        { proxyEnabled, ...policyOptions }
    );
    url.validatedHostname = hostname;
    url.validatedAddress = selected.address;
    url.validationMode = selected.mode;
    return url;
}

function nodeHeadersView(headers) {
    return {
        get(name) {
            const value = headers[String(name).toLowerCase()];
            if (Array.isArray(value)) return value.join(', ');
            return value === undefined ? null : String(value);
        }
    };
}

async function requestPinnedPublicHttps(rawUrl, options = {}, dependencies = {}) {
    require('./conference-reader-operator-correction').assertMayAccessNetwork();
    require('./conference-source-resource-correction').assertMayAccessNetwork();
    const {
        headers = {},
        timeoutMs = 15000,
        maxBytes = 1024 * 1024,
        method = 'GET',
        responseBodyMode = 'buffer'
    } = options;
    if (!['GET', 'HEAD'].includes(method)) {
        throw new Error(`公网资源请求方法不受支持: ${method}`);
    }
    if (!['buffer', 'headers_only'].includes(responseBodyMode)) {
        throw new Error(`公网资源响应模式不受支持: ${responseBodyMode}`);
    }
    const validateUrlImpl = dependencies.validateUrlImpl || validatePublicHttpUrl;
    const detectProxyImpl = dependencies.detectProxyImpl || resolveHttpConnectProxyUrl;
    const createAgentImpl = dependencies.createAgentImpl || createProxyAgent;
    const requestImpl = dependencies.requestImpl || https.request;
    const rawProxyUrl = detectProxyImpl();
    const proxyUrl = isValidHttpConnectProxyUrl(rawProxyUrl) ? rawProxyUrl : null;
    const parsedUrl = await validateUrlImpl(rawUrl, { proxyEnabled: Boolean(proxyUrl) });
    if (parsedUrl.protocol !== 'https:') {
        throw new Error(`任意公网资源只允许 HTTPS，收到: ${parsedUrl.protocol}`);
    }
    if (!proxyUrl) {
        const error = new Error('公网图片与 Demo 页面必须通过当前项目 .env 中 HTTPS_PROXY/HTTP_PROXY 配置 HTTP CONNECT 代理');
        error.code = 'PROXY_CONFIG_ERROR';
        throw error;
    }
    const port = Number.parseInt(parsedUrl.port, 10) || 443;
    const agent = createAgentImpl(
        proxyUrl,
        parsedUrl.validatedAddress,
        port,
        parsedUrl.validatedHostname
    );

    return new Promise((resolve, reject) => {
        let settled = false;
        let total = 0;
        let deadline = null;
        const chunks = [];
        let request;
        const finish = (handler, value, responseToCancel = null) => {
            if (settled) return;
            settled = true;
            if (deadline) clearTimeout(deadline);
            if (responseToCancel && !responseToCancel.destroyed) responseToCancel.destroy();
            if (responseToCancel && request && !request.destroyed) request.destroy();
            agent.destroy();
            handler(value);
        };
        request = requestImpl({
            hostname: parsedUrl.validatedHostname,
            port,
            path: `${parsedUrl.pathname}${parsedUrl.search}`,
            method,
            headers: {
                ...headers,
                Host: parsedUrl.host
            },
            agent
        }, response => {
            response.on('error', error => finish(reject, error));
            if (responseBodyMode === 'headers_only') {
                const bodyUnavailable = async () => {
                    const error = new Error('headers_only 响应不提供正文');
                    error.code = 'RESPONSE_BODY_NOT_AVAILABLE';
                    throw error;
                };
                finish(resolve, {
                    status: response.statusCode || 0,
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    headers: nodeHeadersView(response.headers),
                    body: null,
                    arrayBuffer: bodyUnavailable
                }, response);
                return;
            }
            response.on('data', chunk => {
                total += chunk.length;
                if (maxBytes > 0 && total > maxBytes) {
                    const error = new Error(`response body ${(total / 1024 / 1024).toFixed(1)}MB exceeds limit`);
                    error.code = 'RESPONSE_TOO_LARGE';
                    response.destroy(error);
                    request.destroy(error);
                    finish(reject, error);
                    return;
                }
                chunks.push(chunk);
            });
            response.on('end', () => {
                const buffer = Buffer.concat(chunks);
                finish(resolve, {
                    status: response.statusCode || 0,
                    ok: response.statusCode >= 200 && response.statusCode < 300,
                    headers: nodeHeadersView(response.headers),
                    body: null,
                    arrayBuffer: async () => buffer
                });
            });
        });
        deadline = setTimeout(() => {
            const error = new Error(`公网资源请求超过绝对截止时间 ${timeoutMs}ms`);
            error.code = 'PUBLIC_RESOURCE_DEADLINE_EXCEEDED';
            request.destroy(error);
            finish(reject, error);
        }, timeoutMs);
        deadline.unref?.();
        request.setTimeout(timeoutMs, () => {
            const error = new Error(`公网资源连接空闲超时 ${timeoutMs}ms`);
            error.code = 'PUBLIC_RESOURCE_SOCKET_TIMEOUT';
            request.destroy(error);
            finish(reject, error);
        });
        request.on('error', error => finish(reject, error));
        request.end();
    });
}

async function fetchPublicImageResponse(imageUrl, maxRedirects = 5, requestImpl = requestPinnedPublicHttps, options = {}) {
    let currentUrl = String(imageUrl || '');
    const validateUrlImpl = options?.validateUrlImpl || validatePublicHttpUrl;
    const proxyEnabled = options?.proxyEnabled !== undefined
        ? Boolean(options.proxyEnabled)
        : options?.detectProxyImpl
            ? isValidHttpConnectProxyUrl(options.detectProxyImpl())
            : hasHttpConnectProxy();
    const requestDeps = (options?.validateUrlImpl || options?.detectProxyImpl || options?.proxyEnabled !== undefined)
        ? {
            validateUrlImpl,
            detectProxyImpl: options?.proxyEnabled === false
                ? () => null
                : (options?.detectProxyImpl || resolveHttpConnectProxyUrl)
        }
        : undefined;
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        await validateUrlImpl(currentUrl, { proxyEnabled });
        const requestOptions = {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PaperDigest/1.0)' },
            timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
            maxBytes: IMAGE_MAX_BYTES
        };
        const response = requestDeps
            ? await requestImpl(currentUrl, requestOptions, requestDeps)
            : await requestImpl(currentUrl, requestOptions);
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        if (response.body && typeof response.body.cancel === 'function') {
            try {
                await response.body.cancel();
            } catch (_) {
                // 清理重定向响应体失败，不影响校验结果。
            }
        }
        if (!location) throw new Error(`图片重定向 ${response.status} 缺少 Location`);
        if (redirectCount >= maxRedirects) throw new Error(`图片重定向超过 ${maxRedirects} 次`);
        currentUrl = new URL(location, currentUrl).toString();
    }
    throw new Error('图片重定向校验失败');
}

function isTransientDemoHttpStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

const RESERVED_REPO_OWNERS = new Set([
    'user-attachments', 'sponsors', 'features', 'topics', 'settings', 'orgs',
    'marketplace', 'apps', 'about', 'pricing', 'login', 'join', 'site',
    'security', 'collections', 'explore', 'enterprise', 'issues', 'pulls',
    'notifications', 'users', 'gitlab-org', 'help', 'public', 'snippets', 'groups'
]);
const PROJECT_PAGE_TEMPLATE_SLUGS = new Set([
    'nerfies', 'nerfies.github.io', 'academic-project-page-template',
    'project-page-template', 'bulma', 'fontawesome', 'font-awesome', 'academicons',
    'mathjax', 'katex', 'jquery', 'bootstrap', 'reveal.js', 'highlight.js', 'jekyll'
]);
const GENERIC_MEDIA_PLATFORM_HOSTS = new Set([
    'ximalaya.com', 'xiaoyuzhoufm.com', 'youtube.com', 'youtu.be', 'bilibili.com',
    'podcasts.apple.com', 'open.spotify.com', 'spotify.com', 'soundcloud.com',
    'music.163.com', 'y.qq.com', 'tiktok.com', 'douyin.com'
]);

function normalizePublicHost(hostname) {
    return String(hostname || '').toLowerCase().replace(/^(?:www|m)\./, '');
}

function isGenericMediaPlatformHost(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        const host = normalizePublicHost(parsed.hostname);
        return GENERIC_MEDIA_PLATFORM_HOSTS.has(host);
    } catch (_) {
        return false;
    }
}

function isGenericMediaRootHomepage(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        const host = normalizePublicHost(parsed.hostname);
        if (!GENERIC_MEDIA_PLATFORM_HOSTS.has(host)) return false;
        const segments = parsed.pathname.split('/').filter(Boolean);
        return segments.length === 0 && !parsed.search;
    } catch (_) {
        return false;
    }
}

function hasOpenSourceLinks(analysis) {
    const repoUrlRe = /https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/[^\s`<>()\[\]{}"'，。；：！？、（）【】《》“”‘’\u3400-\u9fff]+|(?:^|[\s`(（[【<：:])(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?/giu;
    const section = extractSectionByTitle(analysis, '开源详情');
    const firstPartyRe = /^\s*(?:[-*+]\s*)?[*_`]*\s*(?:代码|模型权重|数据集|复现材料)\s*[*_`]*\s*[：:]/;
    const thirdPartyRe = /^\s*(?:[-*+]\s*)?[*_`]*\s*(?:其他资源链接|论文中引用的开源项目|第三方资源|论文所列链接)\s*[*_`]*\s*[：:]/;
    const lines = String(section || analysis || '').split('\n');
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        if (thirdPartyRe.test(line)) continue;
        if (section && !firstPartyRe.test(line)) continue;
        for (const match of line.matchAll(repoUrlRe)) {
            const rawToken = match[0]
                .replace(/^[\s`(（[【<：:]+/, '')
                .replace(/[` ),.;:!?，。；：！？、）》】」』]+$/u, '');
            let url = /^https?:\/\//i.test(rawToken) ? rawToken : `https://${rawToken}`;
            url = url.replace(/^http:\/\//i, 'https://').replace(/^https:\/\/www\./i, 'https://');
            if (classifyRepositoryHostFacets(url)) return true;
        }
    }
    return false;
}

function extractDemoUrls(analysis) {
    const urls = [];
    const urlSuffix = '[^\\s<>\\u3000\\uff08\\uff09\\u3010\\u3011\\u300c\\u300d\\u300e\\u300f'
        + '\\uff0c\\u3002\\uff1b\\uff1a\\uff01\\uff1f\\u3001\\u300b\\u3009]+';
    const patterns = [
        new RegExp(`Demo[：:]\\s*<?(https?:\\/\\/${urlSuffix})>?`, 'gi'),
        new RegExp(`项目主页[：:]\\s*<?(https?:\\/\\/${urlSuffix})>?`, 'gi'),
        new RegExp(`在线演示[：:]\\s*<?(https?:\\/\\/${urlSuffix})>?`, 'gi'),
        new RegExp(`Homepage[：:]\\s*<?(https?:\\/\\/${urlSuffix})>?`, 'gi'),
        new RegExp(`Project[：:]\\s*<?(https?:\\/\\/${urlSuffix})>?`, 'gi'),
        new RegExp(`页面[：:]\\s*<?(https?:\\/\\/${urlSuffix})>?`, 'gi')
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(analysis)) !== null) {
            const url = match[1].trim().replace(/[>),.;:!?，。；：！？、）》】》」』]+$/u, '');
            if (!url.includes('arxiv.org')
                && !url.includes('github.com')
                && !url.includes('huggingface.co')
                && !url.includes('modelscope.cn')) {
                urls.push(url);
            }
        }
    }

    return [...new Set(urls)];
}

function isSafePublicCommentHostname(host) {
    const clean = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!clean || clean.endsWith('.') || !clean.includes('.')
        || clean.split('.').some(label => !label)
        || clean === 'localhost'
        || clean.endsWith('.localhost') || clean.endsWith('.local')
        || clean.endsWith('.internal') || net.isIP(clean) !== 0 || isPublicPolicyIpLiteral(clean)) {
        return false;
    }
    return true;
}

const COMMENT_NON_DEMO_BASE_HOSTS = new Set([
    'arxiv.org', 'doi.org', 'dx.doi.org', 'orcid.org', 'creativecommons.org',
    'github.com', 'gitlab.com', 'huggingface.co', 'modelscope.cn', 'bitbucket.org'
]);

function isExcludedCommentDemoHost(canonicalHost) {
    for (const base of COMMENT_NON_DEMO_BASE_HOSTS) {
        if (canonicalHost === base || canonicalHost.endsWith(`.${base}`)) return true;
    }
    return false;
}

function extractCommentResourceUrls(comment) {
    const text = String(comment || '').trim();
    if (!text) return { repoUrls: [], demoUrls: [] };
    const repoUrls = [];
    const demoUrls = [];
    const validSeg = segment => /^[A-Za-z0-9._-]+$/.test(segment)
        && segment !== '.' && segment !== '..' && !segment.endsWith('.');
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'()[\]{}`]+/gi)) {
        const raw = match[0].replace(/[),.;:!?`*，。；：！？、）》】」』]+$/u, '');
        let parsed;
        try {
            parsed = new URL(raw);
        } catch (_) {
            continue;
        }
        if (parsed.username || parsed.password || parsed.port) continue;
        const host = parsed.hostname.toLowerCase();
        if (!isSafePublicCommentHostname(host)) continue;
        // Upgrade http:// only for well-known HTTPS hosts (github.com, huggingface.co, modelscope.cn, *.github.io); otherwise require https:.
        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (
            host === 'github.com' || host === 'www.github.com'
            || host === 'huggingface.co' || host === 'www.huggingface.co'
            || host === 'modelscope.cn' || host === 'www.modelscope.cn'
            || host.endsWith('.github.io')
        ))) {
            continue;
        }
        const canonicalHost = host.startsWith('www.') ? host.slice(4) : host;
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (canonicalHost === 'github.com' && segments.length >= 2) {
            const owner = segments[0];
            const cleanRepo = segments[1].replace(/\.git$/i, '');
            const allowedSubpath = segments.length === 2
                || (segments.length >= 3 && ['tree', 'blob'].includes(segments[2].toLowerCase()));
            if (allowedSubpath && validSeg(owner) && validSeg(cleanRepo)
                && !RESERVED_REPO_OWNERS.has(owner.toLowerCase())) {
                repoUrls.push(`https://github.com/${owner}/${cleanRepo}`);
            }
            continue;
        }
        if (canonicalHost === 'huggingface.co' && segments.length === 3 && segments[0].toLowerCase() === 'spaces'
            && segments.slice(1).every(validSeg)) {
            demoUrls.push(`https://huggingface.co/spaces/${segments[1]}/${segments[2]}`);
            continue;
        }
        if (canonicalHost === 'huggingface.co') {
            if (segments.length === 2 && segments.every(validSeg)
                && !RESERVED_HF_PREFIXES.has(segments[0].toLowerCase())) {
                repoUrls.push(`https://huggingface.co/${segments[0]}/${segments[1]}`);
            } else if (segments.length === 3
                && ['datasets', 'models', 'collections'].includes(segments[0].toLowerCase())
                && segments.slice(1).every(validSeg)) {
                const kind = segments[0].toLowerCase();
                const prefix = kind === 'models' ? '' : `${kind}/`;
                repoUrls.push(`https://huggingface.co/${prefix}${segments[1]}/${segments[2]}`);
            }
            continue;
        }
        if (canonicalHost === 'modelscope.cn' && segments.length === 3
            && ['models', 'datasets', 'studios'].includes(segments[0].toLowerCase())
            && segments.slice(1).every(validSeg)) {
            repoUrls.push(`https://modelscope.cn/${segments[0].toLowerCase()}/${segments[1]}/${segments[2]}`);
            continue;
        }
        if (canonicalHost.endsWith('.github.io') || /\b(?:demo|project|webpage|homepage|website|samples?|audio)\b/i.test(text.slice(Math.max(0, match.index - 48), match.index))) {
            if (!isExcludedCommentDemoHost(canonicalHost)) {
                demoUrls.push(`https://${host}${parsed.pathname}${parsed.search}`);
            }
        }
    }
    return {
        repoUrls: [...new Set(repoUrls)],
        demoUrls: [...new Set(demoUrls)]
    };
}

function resolveMetadataResourceLinks(paper) {
    const links = [];
    const hasVerifiedHfSource = (paper?.sources || []).includes('huggingface') || paper?.hfDetailEnriched === true;
    if (hasVerifiedHfSource) {
        const raw = String(paper?.hf_github_repo || '').trim();
        if (classifyRepositoryHostFacets(raw)) {
            try {
                const parsed = new URL(raw);
                const segments = parsed.pathname.split('/').filter(Boolean);
                if (parsed.protocol === 'https:' && parsed.hostname === 'github.com'
                    && !parsed.username && !parsed.password && !parsed.port && !parsed.search && !parsed.hash
                    && segments.length === 2
                    && !segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment)
                        || segment === '.' || segment === '..' || segment.endsWith('.'))) {
                    links.push(`https://github.com/${segments.join('/')}`);
                }
            } catch (_) {}
        }
    }
    if (typeof paper?.comment === 'string' && paper.comment.trim()) {
        const fromComment = extractCommentResourceUrls(paper.comment);
        for (const repoUrl of fromComment.repoUrls) {
            if (classifyRepositoryHostFacets(repoUrl)) {
                links.push(repoUrl);
            }
        }
    }
    return [...new Set(links)];
}

function resolveDemoPageCandidates(paper, analysis) {
    const urls = extractDemoUrls(analysis);
    const projectPage = String(paper?.hf_project_page || '').trim();
    const hasVerifiedHfSource = (paper?.sources || []).includes('huggingface') || paper?.hfDetailEnriched === true;
    if (hasVerifiedHfSource
        && /^https:\/\/[^\s]+$/i.test(projectPage)) {
        urls.push(projectPage);
    }
    if (typeof paper?.comment === 'string' && paper.comment.trim()) {
        const fromComment = extractCommentResourceUrls(paper.comment);
        urls.push(...fromComment.demoUrls);
    }
    const repository = resolveMetadataResourceLinks(paper).find(link => link.startsWith('https://github.com/'));
    if (repository) {
        const parsed = new URL(repository);
        const [owner, name] = parsed.pathname.split('/').filter(Boolean);
        urls.push(`https://raw.githubusercontent.com/${owner}/${name}/main/README.md`);
    }
    return [...new Set(urls)];
}

function isMetadataResourceDiscoveryLink(paper, rawUrl, options = {}) {
    if (typeof rawUrl !== 'string' || /[\s\u0000-\u001f\u007f?#\\%]/.test(rawUrl)) return false;
    const schemeMatch = /^https:\/\/([^/]+)(\/.*)?$/i.exec(rawUrl);
    if (!schemeMatch) return false;
    const rawPath = schemeMatch[2] || '';
    if (/(?:^|\/)\.\.?(?:\/|$)/.test(rawPath) || /\/\//.test(rawPath)) return false;
    const metadataLinks = new Set(resolveMetadataResourceLinks(paper).map(link => link.replace(/\/$/, '')));
    const allowProjectPageRepos = options?.allowProjectPageRepos === true;
    const validSegment = segment => /^[A-Za-z0-9._-]+$/.test(segment)
        && segment !== '.' && segment !== '..' && !segment.endsWith('.');
    try {
        const parsed = new URL(rawUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
            || parsed.search || parsed.hash) return false;
        if (schemeMatch[1].toLowerCase() !== parsed.hostname.toLowerCase()) return false;
        if (parsed.pathname.replace(/\/$/, '') !== rawPath.replace(/\/$/, '')) return false;
        const normalized = rawUrl.replace(/\/$/, '').replace(/^https:\/\/[^/]+/i, m => m.toLowerCase());
        if (!classifyRepositoryHostFacets(normalized)) return false;
        if (metadataLinks.has(normalized)) {
            return true;
        }
        if (parsed.hostname === 'github.com' || parsed.hostname === 'gitlab.com') {
            if (!allowProjectPageRepos || segments.length !== 2 || !segments.every(validSegment)) {
                return false;
            }
            const [owner, repo] = segments.map(s => s.toLowerCase());
            const repoBase = repo.replace(/\.git$/, '');
            if (RESERVED_REPO_OWNERS.has(owner)
                || PROJECT_PAGE_TEMPLATE_SLUGS.has(owner)
                || PROJECT_PAGE_TEMPLATE_SLUGS.has(repo)
                || PROJECT_PAGE_TEMPLATE_SLUGS.has(repoBase)
                || repo.endsWith('.github.io')
                || repoBase.endsWith('.github.io')
                || repo.endsWith('.gitlab.io')
                || repoBase.endsWith('.gitlab.io')) {
                return false;
            }
            return true;
        }
        if (parsed.hostname === 'huggingface.co') {
            if (segments.length === 2) {
                return !RESERVED_HF_PREFIXES.has(segments[0].toLowerCase())
                    && segments.every(validSegment);
            }
            if (segments.length === 3) {
                return ['collections', 'datasets', 'spaces'].includes(segments[0].toLowerCase())
                    && segments.slice(1).every(validSegment);
            }
            return false;
        }
        return parsed.hostname === 'modelscope.cn'
            && segments.length === 3
            && ['models', 'datasets', 'studios'].includes(segments[0].toLowerCase())
            && segments.slice(1).every(validSegment);
    } catch (_) {
        return false;
    }
}

const AUDIO_FILE_EXT_RE = /\.(wav|mp3|flac|ogg|opus|m4a)(?:$|[?#])/i;
const DEMO_METADATA_COLUMN_RE = /^(?:#|no\.?|id|idx|index|sample(?:\s*(?:id|#|no\.?))?|audio|clip|file|text|transcript(?:ion)?|prompt|caption|description|desc|input|source\s*text|reference\s*text|target\s*text|content|utterance|sentence|speaker|language|lang|category|task|condition|setting|metric|notes?|remark|duration|length|emotion|style|snr|pitch|tempo|bitrate|sample\s*rate|gender|age|accent|文本|输入|提示|描述|样本|序号|编号|类别|语言|说话人|任务|时长)$/i;

function decodeSimpleHtmlEntities(value) {
    return String(value || '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'");
}

const HF_SPACE_STAGE_ALLOW_RE = /^[A-Z0-9_-]{1,48}$/;
const HF_SPACE_HARDWARE_ALLOW_RE = /^[A-Za-z0-9._ -]{1,48}$/;
const SKIP_AUDIO_SCAN_RAWTEXT_TAGS = new Set([
    'script', 'style', 'noscript', 'textarea', 'iframe', 'xmp', 'title', 'noframes', 'noembed', 'plaintext'
]);
const SKIP_AUDIO_SCAN_FOREIGN_TAGS = new Set(['template', 'svg', 'math']);

function parseValidHuggingFaceSpaceUrl(rawUrl) {
    try {
        const raw = String(rawUrl || '').trim();
        if (!raw || /(?:^|\/)\.\.(?:\/|$|[?#])|%2[ef]|%5c/i.test(raw)) return null;
        const parsed = new URL(raw);
        const host = parsed.hostname.toLowerCase();
        if (parsed.protocol !== 'https:' || (host !== 'huggingface.co' && host !== 'www.huggingface.co')
            || parsed.username || parsed.password || parsed.port) return null;
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (segments.length !== 3 || segments[0].toLowerCase() !== 'spaces') return null;
        const [, owner, space] = segments;
        const validSeg = s => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..' && !s.endsWith('.');
        if (!validSeg(owner) || !validSeg(space)) return null;
        return {
            owner,
            space,
            spaceId: `${owner}/${space}`,
            canonicalUrl: `https://huggingface.co/spaces/${owner}/${space}`
        };
    } catch (_) {
        return null;
    }
}

function extractHuggingFaceSpaceUrls(analysis) {
    const urls = [];
    const section = extractSectionByTitle(analysis, '开源详情');
    const sourceText = section || String(analysis || '');
    const thirdPartyRe = /^\s*(?:[-*+]\s*)?[*_`]*\s*(?:其他资源链接|论文中引用的开源项目|第三方资源|论文所列链接)\s*[*_`]*\s*[：:]/;
    for (const rawLine of sourceText.split('\n')) {
        const line = rawLine.trim();
        if (!line || thirdPartyRe.test(line)) continue;
        for (const match of line.matchAll(/https:\/\/(?:www\.)?huggingface\.co\/spaces\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/gi)) {
            const cleaned = match[0].replace(/[),.;:!?，。；：！？、）》】》」』]+$/u, '');
            const parsed = parseValidHuggingFaceSpaceUrl(cleaned);
            if (parsed) urls.push(parsed.canonicalUrl);
        }
    }
    return [...new Set(urls)];
}

function analyzeDemoPageAudioCapabilities(html, baseUrl) {
    const doc = String(html || '');
    const len = doc.length;

    const resolveSafeHttps = candidate => {
        const trimmed = decodeSimpleHtmlEntities(String(candidate || '').trim());
        if (!trimmed || /^(?:javascript|data|blob|mailto|tel):/i.test(trimmed)) return '';
        try {
            const resolved = new URL(trimmed, baseUrl);
            if (resolved.protocol !== 'https:' || resolved.username || resolved.password) return '';
            return resolved.href;
        } catch (_) {
            return '';
        }
    };

    const sampleUrlSet = new Set();
    const formatSet = new Set();
    const recordSample = candidate => {
        const href = resolveSafeHttps(candidate);
        if (!href) return;
        const extMatch = AUDIO_FILE_EXT_RE.exec(href);
        if (extMatch) formatSet.add(extMatch[1].toLowerCase());
        if (sampleUrlSet.size < 12) sampleUrlSet.add(href);
    };

    const spaceUrlSet = new Set();
    const baseSpace = parseValidHuggingFaceSpaceUrl(baseUrl);
    if (baseSpace) spaceUrlSet.add(baseSpace.canonicalUrl);
    const recordSpacesFromText = text => {
        if (!text || !text.toLowerCase().includes('huggingface.co/spaces/')) return;
        for (const m of text.matchAll(/https:\/\/(?:www\.)?huggingface\.co\/spaces\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/gi)) {
            const cleaned = m[0].replace(/[),.;:!?，。；：！？、）》】》」』]+$/u, '');
            const parsed = parseValidHuggingFaceSpaceUrl(cleaned);
            if (parsed && spaceUrlSet.size < 4) spaceUrlSet.add(parsed.canonicalUrl);
        }
    };

    const comparisonSystemSet = new Set();
    let hasBaselineComparison = false;
    let audioTagCount = 0;
    let inAudioDepth = 0;
    const tableStack = [];
    let inTh = false;
    let thChunks = [];

    const flushTh = () => {
        if (!inTh) return;
        const top = tableStack.length > 0 ? tableStack[tableStack.length - 1] : null;
        if (top && top.inTr) {
            const label = decodeSimpleHtmlEntities(thChunks.join(' '))
                .replace(/\s+/g, ' ')
                .trim();
            if (label) top.trThLabels.push(label);
        }
        inTh = false;
        thChunks = [];
    };

    const flushTr = tbl => {
        if (!tbl || !tbl.inTr) return;
        flushTh();
        if (tbl.trThLabels.length > 0 && (tbl.inThead || !tbl.trHasTd)) {
            if (!tbl.lockedHeader || tbl.inThead) {
                tbl.headerLabels = tbl.trThLabels.slice();
                if (!tbl.inThead) tbl.lockedHeader = true;
            }
        }
        tbl.inTr = false;
        tbl.trHasTd = false;
        tbl.trThLabels = [];
    };

    const finalizeTable = tbl => {
        if (!tbl) return;
        flushTr(tbl);
        if (!tbl.hasAudio) return;
        const tableSystems = new Set();
        for (const label of tbl.headerLabels) {
            if (!label || label.length > 64 || DEMO_METADATA_COLUMN_RE.test(label)) continue;
            tableSystems.add(label);
        }
        if (tableSystems.size >= 2) {
            hasBaselineComparison = true;
            for (const sys of tableSystems) {
                if (comparisonSystemSet.size < 12) comparisonSystemSet.add(sys);
            }
        }
    };

    // Single-pass O(N) HTML tokenizer: immune to ReDoS and handles HTML5 comments + unclosed RAWTEXT/SVG/MathML safely.
    let i = 0;
    while (i < len) {
        if (doc[i] !== '<') {
            const nextLt = doc.indexOf('<', i);
            const end = nextLt < 0 ? len : nextLt;
            const textSlice = doc.slice(i, end);
            if (inTh) thChunks.push(textSlice);
            recordSpacesFromText(textSlice);
            i = end;
            continue;
        }
        const startLt = i;
        i += 1;
        if (i >= len) break;
        const ch = doc[i];

        if (ch === '!') {
            if (doc.startsWith('!--', i)) {
                if (doc.startsWith('!-->', i)) {
                    i += 4;
                } else if (doc.startsWith('!--->', i)) {
                    i += 5;
                } else {
                    const endStd = doc.indexOf('-->', i + 3);
                    const endBang = doc.indexOf('--!>', i + 3);
                    if (endStd >= 0 && (endBang < 0 || endStd <= endBang)) {
                        i = endStd + 3;
                    } else if (endBang >= 0) {
                        i = endBang + 4;
                    } else {
                        // Unclosed HTML comment runs to EOF.
                        i = len;
                    }
                }
            } else {
                const end = doc.indexOf('>', i + 1);
                i = end < 0 ? len : end + 1;
            }
            continue;
        }
        if (ch === '?') {
            const end = doc.indexOf('>', i + 1);
            i = end < 0 ? len : end + 1;
            continue;
        }
        if (ch === '/') {
            i += 1;
            const nameStart = i;
            while (i < len && /[A-Za-z0-9:-]/.test(doc[i])) i += 1;
            const closeName = doc.slice(nameStart, i).toLowerCase();
            const gt = doc.indexOf('>', i);
            i = gt < 0 ? len : gt + 1;
            if (closeName === 'audio') {
                if (inAudioDepth > 0) inAudioDepth -= 1;
            } else if (closeName === 'th') {
                flushTh();
            } else if (closeName === 'tr') {
                if (tableStack.length > 0) flushTr(tableStack[tableStack.length - 1]);
            } else if (closeName === 'thead') {
                if (tableStack.length > 0) {
                    const top = tableStack[tableStack.length - 1];
                    flushTr(top);
                    top.inThead = false;
                }
            } else if (closeName === 'table') {
                if (tableStack.length > 0) finalizeTable(tableStack.pop());
            }
            continue;
        }
        if (!/[A-Za-z]/.test(ch)) {
            if (inTh) thChunks.push('<');
            continue;
        }

        const nameStart = i;
        while (i < len && /[A-Za-z0-9:-]/.test(doc[i])) i += 1;
        // Preserve autolinks like <https://...> as text rather than HTML tags.
        if (doc[i - 1] === ':' && doc.startsWith('//', i)) {
            const gt = doc.indexOf('>', i);
            const slice = doc.slice(startLt, gt < 0 ? len : gt + 1);
            if (inTh) thChunks.push(slice);
            recordSpacesFromText(slice);
            i = gt < 0 ? len : gt + 1;
            continue;
        }
        if (i < len && !/[\s/>]/.test(doc[i])) {
            if (inTh) thChunks.push(doc.slice(startLt, i));
            continue;
        }
        const tagName = doc.slice(nameStart, i).toLowerCase();
        const attrs = new Map();
        let selfClosing = false;
        let closedTag = false;
        while (i < len) {
            while (i < len && /\s/.test(doc[i])) i += 1;
            if (i >= len) break;
            if (doc[i] === '>') {
                closedTag = true;
                i += 1;
                break;
            }
            if (doc[i] === '/') {
                selfClosing = true;
                i += 1;
                continue;
            }
            const attrStart = i;
            while (i < len && !/[\s=/>"'<]/.test(doc[i])) i += 1;
            if (i === attrStart) {
                i += 1;
                continue;
            }
            selfClosing = false;
            const attrName = doc.slice(attrStart, i).toLowerCase();
            while (i < len && /\s/.test(doc[i])) i += 1;
            let attrValue = '';
            if (i < len && doc[i] === '=') {
                i += 1;
                while (i < len && /\s/.test(doc[i])) i += 1;
                if (i < len && (doc[i] === '"' || doc[i] === "'")) {
                    const quote = doc[i];
                    i += 1;
                    const vStart = i;
                    const closeQ = doc.indexOf(quote, i);
                    attrValue = doc.slice(vStart, closeQ < 0 ? len : closeQ);
                    i = closeQ < 0 ? len : closeQ + 1;
                } else {
                    const vStart = i;
                    while (i < len && !/[\s>]/.test(doc[i])) i += 1;
                    attrValue = doc.slice(vStart, i);
                }
            }
            if (!attrs.has(attrName)) attrs.set(attrName, attrValue);
        }
        if (!closedTag) break;

        if (SKIP_AUDIO_SCAN_RAWTEXT_TAGS.has(tagName) || SKIP_AUDIO_SCAN_FOREIGN_TAGS.has(tagName)) {
            if (tagName === 'plaintext') {
                i = len;
                break;
            }
            if (SKIP_AUDIO_SCAN_FOREIGN_TAGS.has(tagName)) {
                if (selfClosing) continue;
                let depth = 1;
                const tagBoundaryRe = new RegExp(`<(/?)${tagName}(?=[\\s/>])`, 'gi');
                tagBoundaryRe.lastIndex = i;
                while (depth > 0) {
                    const m = tagBoundaryRe.exec(doc);
                    if (!m) {
                        i = len;
                        break;
                    }
                    const gt = doc.indexOf('>', m.index + m[0].length);
                    if (gt < 0) {
                        i = len;
                        break;
                    }
                    const isClose = m[1] === '/';
                    if (isClose) {
                        depth -= 1;
                    } else {
                        const rawTagInner = doc.slice(m.index + m[0].length, gt);
                        if (!/\/\s*$/.test(rawTagInner)) {
                            depth += 1;
                        }
                    }
                    i = gt + 1;
                    tagBoundaryRe.lastIndex = i;
                }
                continue;
            }
            const closeRe = new RegExp(`</${tagName}(?=[\\s/>])`, 'gi');
            closeRe.lastIndex = i;
            const closeMatch = closeRe.exec(doc);
            if (!closeMatch) {
                // Unclosed RAWTEXT/script consumes to EOF.
                i = len;
                break;
            }
            const closeGt = doc.indexOf('>', closeMatch.index + closeMatch[0].length);
            i = closeGt < 0 ? len : closeGt + 1;
            continue;
        }

        const topTable = tableStack.length > 0 ? tableStack[tableStack.length - 1] : null;
        if (tagName === 'audio') {
            audioTagCount += 1;
            if (!selfClosing) inAudioDepth += 1;
            if (topTable) topTable.hasAudio = true;
            if (attrs.has('src')) recordSample(attrs.get('src'));
        } else if (tagName === 'source') {
            if (inAudioDepth > 0 && attrs.has('src')) {
                recordSample(attrs.get('src'));
                if (topTable) topTable.hasAudio = true;
            }
        } else if (tagName === 'a') {
            if (attrs.has('href')) {
                const rawHref = attrs.get('href');
                if (AUDIO_FILE_EXT_RE.test(rawHref)) {
                    recordSample(rawHref);
                    if (topTable) topTable.hasAudio = true;
                }
                recordSpacesFromText(rawHref);
            }
        } else if (tagName === 'table') {
            if (tableStack.length < 16) {
                tableStack.push({
                    hasAudio: false,
                    inThead: false,
                    inTr: false,
                    trHasTd: false,
                    trThLabels: [],
                    headerLabels: [],
                    lockedHeader: false
                });
            }
        } else if (tagName === 'thead') {
            if (topTable) topTable.inThead = true;
        } else if (tagName === 'tr') {
            if (topTable) {
                flushTr(topTable);
                topTable.inTr = true;
            }
        } else if (tagName === 'td') {
            if (topTable) {
                flushTh();
                if (!topTable.inTr) topTable.inTr = true;
                topTable.trHasTd = true;
            }
        } else if (tagName === 'th') {
            if (topTable) {
                flushTh();
                if (!topTable.inTr) topTable.inTr = true;
                inTh = true;
                thChunks = [];
            }
        }
    }

    while (tableStack.length > 0) {
        finalizeTable(tableStack.pop());
    }

    const sampleUrls = [...sampleUrlSet];
    const comparisonSystems = [...comparisonSystemSet];
    return {
        audioTagCount,
        audioSampleCount: sampleUrls.length,
        sampleUrls,
        audioFormats: [...formatSet].sort(),
        hasBaselineComparison,
        comparisonSystems,
        spaceUrls: [...spaceUrlSet]
    };
}

async function probeAudioSampleUrls(sampleUrls, options = {}) {
    const validateUrlImpl = options.validateUrlImpl || validatePublicHttpUrl;
    const requestImpl = options.requestImpl || requestPinnedPublicHttps;
    const detectProxyImpl = options.detectProxyImpl || resolveHttpConnectProxyUrl;
    const maxSamples = Math.max(1, Math.min(4, Number.isInteger(options.maxSamples) ? options.maxSamples : 2));
    const proxyEnabled = isValidHttpConnectProxyUrl(detectProxyImpl());
    const urls = (Array.isArray(sampleUrls) ? sampleUrls : []).slice(0, maxSamples);
    const results = [];

    for (const rawUrl of urls) {
        let currentUrl = String(rawUrl || '').trim();
        let entry = { url: currentUrl, status: null, contentType: '', ok: false };
        try {
            let response = null;
            for (const method of ['HEAD', 'GET']) {
                let targetUrl = currentUrl;
                let hopRes = null;
                for (let hop = 0; hop <= 2; hop += 1) {
                    const parsedUrl = await validateUrlImpl(targetUrl, { proxyEnabled });
                    if (parsedUrl.protocol !== 'https:') {
                        throw new Error('任意公网资源只允许 HTTPS');
                    }
                    const reqHeaders = {
                        'User-Agent': 'Mozilla/5.0 (compatible; AudioPaperDigest/1.0)',
                        ...(method === 'GET' ? { Range: 'bytes=0-63' } : {})
                    };
                    const res = await requestImpl(targetUrl, {
                        method,
                        headers: reqHeaders,
                        timeoutMs: 8000,
                        maxBytes: 4096,
                        responseBodyMode: 'headers_only'
                    }, { validateUrlImpl, detectProxyImpl });
                    const status = Number(res?.status || 0);
                    const location = res?.headers?.get ? res.headers.get('location') : null;
                    const ct = String(res?.headers?.get ? (res.headers.get('content-type') || '') : '').split(';')[0].trim().toLowerCase();
                    if (res?.body && typeof res.body.cancel === 'function') {
                        try { await res.body.cancel(); } catch (_) {}
                    }
                    hopRes = { status, contentType: ct, location };
                    if (status >= 300 && status < 400 && location && hop < 2) {
                        targetUrl = new URL(location, parsedUrl).href;
                        continue;
                    }
                    break;
                }
                response = hopRes;
                if (method === 'HEAD' && response && (response.status === 405 || response.status === 501)) continue;
                break;
            }
            if (response) {
                const isAudioType = !response.contentType
                    || /^(?:audio\/|application\/octet-stream|binary\/octet-stream|video\/(?:ogg|mp4|webm))/i.test(response.contentType);
                entry = {
                    url: currentUrl,
                    status: response.status,
                    contentType: response.contentType,
                    ok: (response.status === 200 || response.status === 206) && isAudioType
                };
            }
        } catch (err) {
            if (err?.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(err)) throw err;
            entry = { url: currentUrl, status: null, contentType: '', ok: false, error: err?.message || 'probe failed' };
        }
        results.push(entry);
    }

    const reachableCount = results.filter(r => r.ok).length;
    return {
        probedCount: results.length,
        reachableCount,
        audioSamplesReachable: results.length > 0 ? reachableCount > 0 : null,
        results
    };
}

async function probeHuggingFaceSpaceStatus(spaceUrl, options = {}) {
    const parsed = parseValidHuggingFaceSpaceUrl(spaceUrl);
    if (!parsed) {
        return { spaceUrl: String(spaceUrl || ''), spaceId: '', ok: false, status: null, stage: '', hardware: '', isRunning: false, error: 'invalid_space_url' };
    }
    const validateUrlImpl = options.validateUrlImpl || validatePublicHttpUrl;
    const requestImpl = options.requestImpl || requestPinnedPublicHttps;
    const detectProxyImpl = options.detectProxyImpl || resolveHttpConnectProxyUrl;
    const proxyEnabled = isValidHttpConnectProxyUrl(detectProxyImpl());
    const apiUrl = `https://huggingface.co/api/spaces/${parsed.owner}/${parsed.space}`;

    try {
        let currentUrl = apiUrl;
        let status = 0;
        let bodyText = '';
        for (let hop = 0; hop <= 2; hop += 1) {
            const parsedHop = await validateUrlImpl(currentUrl, { proxyEnabled });
            const res = await requestImpl(currentUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; AudioPaperDigest/1.0)',
                    'Accept': 'application/json'
                },
                timeoutMs: 10000,
                maxBytes: 256 * 1024
            }, { validateUrlImpl, detectProxyImpl });
            status = Number(res?.status || 0);
            const location = res?.headers?.get ? res.headers.get('location') : null;
            if (status >= 300 && status < 400 && location && hop < 2) {
                if (res?.body && typeof res.body.cancel === 'function') {
                    try { await res.body.cancel(); } catch (_) {}
                }
                const next = new URL(location, parsedHop);
                const nextHost = next.hostname.toLowerCase();
                if (next.protocol !== 'https:'
                    || (nextHost !== 'huggingface.co' && nextHost !== 'www.huggingface.co')
                    || next.username || next.password || next.port
                    || !next.pathname.startsWith('/api/spaces/')) {
                    return { spaceUrl: parsed.canonicalUrl, spaceId: parsed.spaceId, ok: false, status, stage: '', hardware: '', isRunning: false, error: 'unexpected_redirect_host' };
                }
                currentUrl = next.href;
                continue;
            }
            bodyText = Buffer.from(await res.arrayBuffer()).toString('utf8');
            break;
        }
        if (status !== 200) {
            return { spaceUrl: parsed.canonicalUrl, spaceId: parsed.spaceId, ok: false, status, stage: '', hardware: '', isRunning: false };
        }
        const json = JSON.parse(bodyText);
        const rawStage = String(json?.runtime?.stage || '').trim().toUpperCase();
        const rawHardware = String(json?.runtime?.hardware?.current || json?.runtime?.hardware?.requested || '').trim();
        const stage = HF_SPACE_STAGE_ALLOW_RE.test(rawStage) ? rawStage : '';
        const hardware = HF_SPACE_HARDWARE_ALLOW_RE.test(rawHardware) ? rawHardware : '';
        const isRunning = stage === 'RUNNING' || stage === 'RUNNING_APP_STARTING';
        return {
            spaceUrl: parsed.canonicalUrl,
            spaceId: parsed.spaceId,
            ok: Boolean(stage),
            status,
            stage,
            hardware,
            isRunning
        };
    } catch (err) {
        if (err?.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(err)) throw err;
        return { spaceUrl: parsed.canonicalUrl, spaceId: parsed.spaceId, ok: false, status: null, stage: '', hardware: '', isRunning: false, error: err?.message || 'space_probe_failed' };
    }
}

async function inspectDemoPageDetailed(demoUrl, options = {}) {
    const seg = '[A-Za-z0-9_-](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?';
    const lead = '(?<![A-Za-z0-9._~@/\\\\?#&:;%+-])(?:https?:\\/\\/)?(?:www\\.)?';
    const safeHtmlEnt = '(?:nbsp|lt|gt|quot|apos|mdash|ndash|hellip|middot|bull|copy|reg|#160|#x0*a0|#60|#62|#34|#39);';
    const tail = `(?:\\/(?![/\\\\\\w?#%~@:.+=$!*|(\\^[\\{\`-]|&(?!${safeHtmlEnt}))|(?![/\\\\\\w?#%~@:+=$!*|(\\^[\\{\`-]|&(?!${safeHtmlEnt})|\\.(?=[/\\\\\\w?#%~@:.+=$!*|(\\^[\\{\`-])))`;
    const openSourcePatterns = [
        new RegExp(`${lead}(github\\.com\\/${seg}\\/${seg})${tail}`, 'gi'),
        new RegExp(`${lead}(huggingface\\.co\\/(?:(?:collections|datasets|spaces)\\/)?${seg}\\/${seg})${tail}`, 'gi'),
        new RegExp(`${lead}(modelscope\\.cn\\/(?:models|datasets|studios)\\/${seg}\\/${seg})${tail}`, 'gi'),
        new RegExp(`${lead}(gitlab\\.com\\/${seg}\\/${seg})${tail}`, 'gi')
    ];
    const validateUrlImpl = options.validateUrlImpl || validatePublicHttpUrl;
    const requestImpl = options.requestImpl || requestPinnedPublicHttps;
    const detectProxyImpl = options.detectProxyImpl || resolveHttpConnectProxyUrl;

    try {
        console.log(`    [deep] 🔍 检查 demo 页面: ${demoUrl}`);
        let currentUrl = demoUrl;
        let response;
        const proxyEnabled = isValidHttpConnectProxyUrl(detectProxyImpl());
        for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
            const parsedUrl = await validateUrlImpl(currentUrl, { proxyEnabled });

            const pageResponse = await requestImpl(currentUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                },
                timeoutMs: 15000,
                maxBytes: 1024 * 1024
            }, {
                validateUrlImpl,
                detectProxyImpl
            });
            const contentType = String(pageResponse.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
            const data = Buffer.from(await pageResponse.arrayBuffer()).toString('utf8');
            response = contentType && !['text/html', 'application/xhtml+xml', 'application/xml', 'text/plain'].includes(contentType)
                ? { status: pageResponse.status, data: '', location: pageResponse.headers.get('location'), skipped: `Content-Type=${contentType}` }
                : { status: pageResponse.status, data, location: pageResponse.headers.get('location') };

            if (response.status >= 300 && response.status < 400 && response.location) {
                if (redirectCount >= 3) {
                    console.log('    [deep] ⚠️  Demo 页面重定向超过 3 次');
                    return { demoUrl, finalUrl: currentUrl, reachable: false, status: response.status, links: [], audioDemo: null };
                }
                const nextUrl = new URL(response.location, parsedUrl).href;
                console.log(`    [deep] ↪ Demo 页面重定向: ${currentUrl} → ${nextUrl}`);
                currentUrl = nextUrl;
                continue;
            }
            break;
        }

        if (response.skipped) {
            console.log(`    [deep] ⚠️  Demo 页面跳过: ${response.skipped}`);
            return { demoUrl, finalUrl: currentUrl, reachable: false, status: response.status, links: [], audioDemo: null };
        }
        if (response.status !== 200) {
            console.log(`    [deep] ⚠️  Demo 页面返回 ${response.status}`);
            if (isTransientDemoHttpStatus(response.status)) {
                const transientError = new Error(`Demo 页面瞬时 HTTP ${response.status}`);
                transientError.code = 'DEMO_TRANSIENT_FAILURE';
                throw transientError;
            }
            return { demoUrl, finalUrl: currentUrl, reachable: false, status: response.status, links: [], audioDemo: null };
        }

        const html = response.data;
        const foundLinks = [];
        const URL_ATTR_NAMES = new Set([
            'href', 'xlink:href', 'src', 'action', 'formaction', 'cite', 'poster',
            'data', 'ping', 'background', 'longdesc', 'data-href', 'data-url', 'data-link'
        ]);
        const RAWTEXT_TAGS = new Set([
            'script', 'style', 'xmp', 'textarea', 'title',
            'iframe', 'noscript', 'noframes', 'noembed', 'plaintext'
        ]);
        // Exact single-pass O(N) HTML start-tag attribute-value, rawtext span, and real tag-end indexer (built lazily on first URL match).
        let attrSpans = null;
        let rawTextSpans = null;
        let tagEndOffsets = null;
        const buildHtmlSpans = doc => {
            const spans = [];
            const rawSpans = [];
            const tagEnds = [];
            const len = doc.length;
            let i = 0;
            while (i < len) {
                const lt = doc.indexOf('<', i);
                if (lt < 0) break;
                i = lt + 1;
                if (i >= len) break;
                const ch = doc[i];
                if (ch === '!') {
                    if (doc.startsWith('!--', i)) {
                        if (doc.startsWith('!-->', i)) {
                            i += 4;
                        } else if (doc.startsWith('!--->', i)) {
                            i += 5;
                        } else {
                            const endStd = doc.indexOf('-->', i + 3);
                            const endBang = doc.indexOf('--!>', i + 3);
                            if (endStd >= 0 && (endBang < 0 || endStd <= endBang)) {
                                i = endStd + 3;
                            } else if (endBang >= 0) {
                                i = endBang + 4;
                            } else {
                                i = len;
                            }
                        }
                    } else {
                        const end = doc.indexOf('>', i + 1);
                        i = end < 0 ? len : end + 1;
                    }
                    tagEnds.push(i);
                    continue;
                }
                if (ch === '?' || ch === '/') {
                    const end = doc.indexOf('>', i + 1);
                    i = end < 0 ? len : end + 1;
                    tagEnds.push(i);
                    continue;
                }
                if (!/[A-Za-z]/.test(ch)) continue;
                const nameStart = i;
                while (i < len && /[A-Za-z0-9:-]/.test(doc[i])) i += 1;
                // Do not treat autolinks like <https://...> as HTML start tags.
                if (doc[i - 1] === ':' && doc.startsWith('//', i)) continue;
                if (i < len && !/[\s/>]/.test(doc[i])) continue;
                const tagName = doc.slice(nameStart, i).toLowerCase();
                while (i < len) {
                    while (i < len && /[\s/]/.test(doc[i])) i += 1;
                    if (i >= len || doc[i] === '>') {
                        if (i < len) i += 1;
                        break;
                    }
                    const attrStart = i;
                    while (i < len && !/[\s=/>"'<]/.test(doc[i])) i += 1;
                    if (i === attrStart) {
                        i += 1;
                        continue;
                    }
                    const attrName = doc.slice(attrStart, i).toLowerCase();
                    while (i < len && /\s/.test(doc[i])) i += 1;
                    if (i < len && doc[i] === '=') {
                        i += 1;
                        while (i < len && /\s/.test(doc[i])) i += 1;
                        if (i < len && (doc[i] === '"' || doc[i] === "'")) {
                            const quote = doc[i];
                            i += 1;
                            const valueStart = i;
                            const closeIdx = doc.indexOf(quote, i);
                            const valueEnd = closeIdx < 0 ? len : closeIdx;
                            spans.push({ name: attrName, quote, valueStart, valueEnd, jsonValueStrings: undefined });
                            i = closeIdx < 0 ? len : closeIdx + 1;
                        } else {
                            const valueStart = i;
                            while (i < len && !/[\s>]/.test(doc[i])) i += 1;
                            const valueEnd = i;
                            spans.push({ name: attrName, quote: '', valueStart, valueEnd, jsonValueStrings: undefined });
                        }
                    }
                }
                tagEnds.push(i);
                // HTML5 RAWTEXT / RCDATA / PLAINTEXT elements never self-close on '/>'.
                if (RAWTEXT_TAGS.has(tagName)) {
                    const contentStart = i;
                    if (tagName === 'plaintext') {
                        rawSpans.push({ tagName, contentStart, contentEnd: len, scriptStrings: null, jsonValueStrings: undefined });
                        break;
                    }
                    const closeRe = new RegExp(`</${tagName}(?=[\\s/>])`, 'gi');
                    closeRe.lastIndex = i;
                    const closeMatch = closeRe.exec(doc);
                    const contentEnd = closeMatch ? closeMatch.index : len;
                    rawSpans.push({ tagName, contentStart, contentEnd, scriptStrings: null, jsonValueStrings: undefined });
                    if (!closeMatch) break;
                    const closeGt = doc.indexOf('>', closeMatch.index + closeMatch[0].length);
                    i = closeGt < 0 ? len : closeGt + 1;
                    tagEnds.push(i);
                }
            }
            return { spans, rawSpans, tagEnds };
        };
        const ensureHtmlSpans = () => {
            if (attrSpans === null) {
                const built = buildHtmlSpans(html);
                attrSpans = built.spans;
                rawTextSpans = built.rawSpans;
                tagEndOffsets = built.tagEnds;
            }
        };
        const findLastTagEndBefore = pos => {
            ensureHtmlSpans();
            let lo = 0;
            let hi = tagEndOffsets.length - 1;
            let best = 0;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (tagEndOffsets[mid] <= pos) {
                    best = tagEndOffsets[mid];
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }
            return best;
        };
        const findAttrSpanAt = pos => {
            ensureHtmlSpans();
            let lo = 0;
            let hi = attrSpans.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const s = attrSpans[mid];
                if (pos < s.valueStart) hi = mid - 1;
                else if (pos >= s.valueEnd) lo = mid + 1;
                else return s;
            }
            return null;
        };
        const findRawTextSpanAt = pos => {
            ensureHtmlSpans();
            let lo = 0;
            let hi = rawTextSpans.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const s = rawTextSpans[mid];
                if (pos < s.contentStart) hi = mid - 1;
                else if (pos >= s.contentEnd) lo = mid + 1;
                else return s;
            }
            return null;
        };
        const scanScriptStringSpans = (doc, start, end) => {
            const strSpans = [];
            const regexPrevKinds = new Set(['', 'punct_open', 'punct_sep', 'op', 'kw_expr', 'punct_close_ctrl']);
            const objOpenPrevKinds = new Set(['', 'punct_open', 'punct_sep', 'op', 'kw_expr']);
            const exprKeywords = new Set([
                'return', 'case', 'typeof', 'void', 'delete', 'in', 'of',
                'throw', 'new', 'yield', 'await', 'else', 'do'
            ]);
            const ctrlParenKeywords = new Set(['if', 'while', 'for', 'with']);
            const lexRange = (startPos, stopAtCloseBrace) => {
                const tokens = [];
                const parenStack = [];
                const braceStack = [];
                let i = startPos;
                let lastKind = '';
                const curObjFrame = () => {
                    const top = braceStack.length ? braceStack[braceStack.length - 1] : null;
                    return top && top.isObj ? top : null;
                };
                const anyMalformedObj = () => braceStack.some(f => f.isObj && f.malformed);
                while (i < end) {
                    const ch = doc[i];
                    if (ch <= ' ') { i += 1; continue; }
                    if (ch === '/' && doc[i + 1] === '/') {
                        const nl = doc.indexOf('\n', i + 2);
                        i = (nl < 0 || nl >= end) ? end : nl + 1;
                        continue;
                    }
                    if (ch === '/' && doc[i + 1] === '*') {
                        const close = doc.indexOf('*/', i + 2);
                        i = (close < 0 || close + 2 > end) ? end : close + 2;
                        continue;
                    }
                    if (ch === '}' && stopAtCloseBrace && braceStack.length === 0) {
                        return i + 1;
                    }
                    if (ch === '"' || ch === "'") {
                        const quote = ch;
                        const tokStart = i;
                        const contentStartPos = i + 1;
                        i += 1;
                        let closed = false;
                        while (i < end) {
                            const c = doc[i];
                            if (c === '\\') { i += 2; continue; }
                            if (c === quote) { closed = true; break; }
                            if (c === '\n' || c === '\r') break;
                            i += 1;
                        }
                        const contentEndPos = Math.min(i, end);
                        if (closed) i += 1;
                        const prevTok = tokens.length ? tokens[tokens.length - 1] : null;
                        const prevPrevTok = tokens.length >= 2 ? tokens[tokens.length - 2] : null;
                        const prev3Tok = tokens.length >= 3 ? tokens[tokens.length - 3] : null;
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0) {
                            if (objF.state === 'after_val') objF.malformed = true;
                            else if (objF.state === 'expect_key') objF.state = 'after_str_key';
                            else if (objF.state === 'expect_val') objF.state = 'after_val';
                        }
                        strSpans.push({
                            quote, tokStart, contentStart: contentStartPos, contentEnd: contentEndPos,
                            closed, gluedToInterp: false, inMalformedObj: anyMalformedObj(),
                            prevTok, prevPrevTok, prev3Tok
                        });
                        tokens.push({ kind: 'str', text: quote, start: tokStart, end: i });
                        lastKind = 'str';
                        continue;
                    }
                    if (ch === '`') {
                        const tokStart = i;
                        i += 1;
                        let segStart = i;
                        let isAfterInterp = false;
                        let templateClosed = false;
                        const prevTok = tokens.length ? tokens[tokens.length - 1] : null;
                        const prevPrevTok = tokens.length >= 2 ? tokens[tokens.length - 2] : null;
                        const prev3Tok = tokens.length >= 3 ? tokens[tokens.length - 3] : null;
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0) {
                            if (objF.state === 'after_val' || objF.state === 'expect_key') objF.malformed = true;
                            else if (objF.state === 'expect_val') objF.state = 'after_val';
                        }
                        const inBadObj = anyMalformedObj();
                        while (i < end) {
                            const c = doc[i];
                            if (c === '\\') { i += 2; continue; }
                            if (c === '`') {
                                strSpans.push({
                                    quote: '`', tokStart, contentStart: segStart, contentEnd: i,
                                    closed: true, gluedToInterp: isAfterInterp, inMalformedObj: inBadObj,
                                    prevTok, prevPrevTok, prev3Tok
                                });
                                i += 1;
                                templateClosed = true;
                                break;
                            }
                            if (c === '$' && doc[i + 1] === '{') {
                                strSpans.push({
                                    quote: '`', tokStart, contentStart: segStart, contentEnd: i,
                                    closed: true, gluedToInterp: isAfterInterp, inMalformedObj: inBadObj,
                                    prevTok, prevPrevTok, prev3Tok
                                });
                                i = lexRange(i + 2, true);
                                segStart = i;
                                isAfterInterp = true;
                                continue;
                            }
                            i += 1;
                        }
                        if (!templateClosed) {
                            strSpans.push({
                                quote: '`', tokStart, contentStart: segStart, contentEnd: end,
                                closed: false, gluedToInterp: isAfterInterp, inMalformedObj: inBadObj,
                                prevTok, prevPrevTok, prev3Tok
                            });
                        }
                        tokens.push({ kind: 'str', text: '`', start: tokStart, end: i });
                        lastKind = 'str';
                        continue;
                    }
                    if (ch === '/' && regexPrevKinds.has(lastKind)) {
                        const tokStart = i;
                        i += 1;
                        let inClass = false;
                        while (i < end) {
                            const c = doc[i];
                            if (c === '\\') { i += 2; continue; }
                            if (c === '[') inClass = true;
                            else if (c === ']') inClass = false;
                            else if (c === '/' && !inClass) { i += 1; break; }
                            else if (c === '\n' || c === '\r') break;
                            i += 1;
                        }
                        while (i < end && /[a-z]/i.test(doc[i])) i += 1;
                        tokens.push({ kind: 'regex', text: '/', start: tokStart, end: i });
                        lastKind = 'regex';
                        continue;
                    }
                    if (/[A-Za-z_$]/.test(ch)) {
                        const tokStart = i;
                        while (i < end && /[A-Za-z0-9_$]/.test(doc[i])) i += 1;
                        const word = doc.slice(tokStart, i);
                        const kind = ctrlParenKeywords.has(word)
                            ? 'kw_ctrl'
                            : (exprKeywords.has(word) ? 'kw_expr' : 'ident');
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0) {
                            if (objF.state === 'after_val') {
                                if (!exprKeywords.has(word)) objF.malformed = true;
                                else objF.state = 'expect_val';
                            } else if (objF.state === 'expect_key') {
                                objF.state = 'after_ident_key';
                            } else if (objF.state === 'expect_val') {
                                if (exprKeywords.has(word)) objF.state = 'expect_val';
                                else objF.state = 'after_val';
                            }
                        }
                        tokens.push({ kind, text: word, start: tokStart, end: i });
                        lastKind = kind;
                        continue;
                    }
                    if (/[0-9]/.test(ch)) {
                        const tokStart = i;
                        while (i < end && /[0-9A-Za-z._]/.test(doc[i])) i += 1;
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0) {
                            if (objF.state === 'after_val') objF.malformed = true;
                            else if (objF.state === 'expect_key') objF.state = 'after_num_key';
                            else if (objF.state === 'expect_val') objF.state = 'after_val';
                        }
                        tokens.push({ kind: 'num', text: '0', start: tokStart, end: i });
                        lastKind = 'num';
                        continue;
                    }
                    const tokStart = i;
                    i += 1;
                    let kind = 'op';
                    if (ch === '(') {
                        kind = 'punct_open';
                        parenStack.push(lastKind === 'kw_ctrl');
                        const objF = curObjFrame();
                        if (objF) {
                            if (objF.exprDepth > 0) objF.exprDepth += 1;
                            else if (objF.state === 'after_ident_key') {
                                objF.state = 'method_params';
                                objF.exprDepth = 1;
                            } else if (objF.state === 'expect_val' || objF.state === 'after_val') {
                                objF.exprDepth = 1;
                            }
                        }
                    } else if (ch === '[') {
                        kind = 'punct_open';
                        const objF = curObjFrame();
                        if (objF) {
                            if (objF.exprDepth > 0) objF.exprDepth += 1;
                            else if (objF.state === 'expect_key') {
                                objF.state = 'computed_key';
                                objF.exprDepth = 1;
                            } else if (objF.state === 'expect_val' || objF.state === 'after_val') {
                                objF.exprDepth = 1;
                                objF.state = 'after_val';
                            }
                        }
                    } else if (ch === '{') {
                        kind = 'punct_open';
                        const objF = curObjFrame();
                        const isMethodBody = Boolean(objF && objF.exprDepth === 0 && objF.state === 'method_body');
                        const isObj = !isMethodBody && objOpenPrevKinds.has(lastKind);
                        if (objF && objF.exprDepth === 0 && (objF.state === 'expect_val' || isMethodBody)) {
                            objF.state = 'after_val';
                        }
                        braceStack.push({ isObj, state: 'expect_key', malformed: false, exprDepth: 0, ternaryDepth: 0 });
                    } else if (ch === ')') {
                        const closesCtrl = parenStack.pop() === true;
                        kind = closesCtrl ? 'punct_close_ctrl' : 'punct_close';
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth > 0) {
                            objF.exprDepth -= 1;
                            if (objF.exprDepth === 0) {
                                if (objF.state === 'method_params') objF.state = 'method_body';
                                else if (objF.state === 'expect_val') objF.state = 'after_val';
                            }
                        }
                    } else if (ch === ']') {
                        kind = 'punct_close';
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth > 0) {
                            objF.exprDepth -= 1;
                            if (objF.state === 'computed_key' && objF.exprDepth === 0) {
                                objF.state = 'after_ident_key';
                            }
                        }
                    } else if (ch === '}') {
                        kind = 'punct_close';
                        const popped = braceStack.pop();
                        if (popped && popped.isObj && (popped.state === 'after_str_key' || popped.state === 'after_num_key')) {
                            popped.malformed = true;
                        }
                    } else if (ch === ':') {
                        kind = 'punct_sep';
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0) {
                            if (objF.state === 'after_str_key' || objF.state === 'after_ident_key' || objF.state === 'after_num_key') {
                                objF.state = 'expect_val';
                            } else if (objF.ternaryDepth > 0) {
                                objF.ternaryDepth -= 1;
                                objF.state = 'expect_val';
                            } else {
                                objF.malformed = true;
                            }
                        }
                    } else if (ch === ',') {
                        kind = 'punct_sep';
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0) {
                            if (objF.state === 'after_str_key' || objF.state === 'after_num_key' || objF.state === 'expect_val') {
                                objF.malformed = true;
                            } else {
                                objF.state = 'expect_key';
                                objF.ternaryDepth = 0;
                            }
                        }
                    } else if (ch === '?') {
                        kind = 'op';
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0 && (objF.state === 'expect_val' || objF.state === 'after_val')) {
                            objF.ternaryDepth += 1;
                            objF.state = 'expect_val';
                        }
                    } else if (ch === ';') {
                        kind = 'punct_sep';
                    } else {
                        const objF = curObjFrame();
                        if (objF && objF.exprDepth === 0 && objF.state === 'after_val' && /[.+*\-/%&|^!<>=]/.test(ch)) {
                            objF.state = 'expect_val';
                        }
                    }
                    tokens.push({ kind, text: ch, start: tokStart, end: i });
                    lastKind = kind;
                }
                return i;
            };
            lexRange(start, false);
            return strSpans;
        };
        const findScriptStringSpanAt = (rawSpan, pos) => {
            if (rawSpan.scriptStrings === null) {
                rawSpan.scriptStrings = scanScriptStringSpans(html, rawSpan.contentStart, rawSpan.contentEnd);
            }
            const arr = rawSpan.scriptStrings;
            let lo = 0;
            let hi = arr.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const s = arr[mid];
                if (pos < s.contentStart) hi = mid - 1;
                else if (pos >= s.contentEnd) lo = mid + 1;
                else return s;
            }
            return null;
        };
        // Strictly single-pass O(N) full RFC 8259 JSON validator + value-slot string span indexer.
        // Returns sorted [{ contentStart, contentEnd }] if the ENTIRE container is valid RFC 8259 JSON, else null.
        const jsonPrimRe = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
        const indexValidJsonValueStrings = (doc, start, end) => {
            const valStrings = [];
            const stack = [];
            let lastTok = '';
            let rootClosed = false;
            let i = start;
            while (i < end) {
                const ch = doc[i];
                if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i += 1; continue; }
                if (rootClosed) return null;
                if (ch === '"') {
                    const top = stack[stack.length - 1];
                    let role = '';
                    if (top === '{' && (lastTok === '{' || lastTok === ',')) role = 'key';
                    else if ((top === '[' && (lastTok === '[' || lastTok === ','))
                        || (top === '{' && lastTok === ':')) role = 'val';
                    else return null;
                    i += 1;
                    const contentStart = i;
                    let closed = false;
                    while (i < end) {
                        const c = doc[i];
                        const code = c.charCodeAt(0);
                        if (code < 0x20) return null;
                        if (c === '\\') {
                            if (i + 1 >= end) return null;
                            const esc = doc[i + 1];
                            if ('"\\/bfnrt'.includes(esc)) {
                                i += 2;
                                continue;
                            }
                            if (esc === 'u' && i + 5 < end && /^[0-9a-fA-F]{4}$/.test(doc.slice(i + 2, i + 6))) {
                                i += 6;
                                continue;
                            }
                            return null;
                        }
                        if (c === '"') {
                            closed = true;
                            break;
                        }
                        i += 1;
                    }
                    if (!closed) return null;
                    if (role === 'val') valStrings.push({ contentStart, contentEnd: i });
                    i += 1;
                    lastTok = role === 'key' ? 'key_str' : 'val_str';
                    continue;
                }
                if (ch === '{' || ch === '[') {
                    if (stack.length === 0) {
                        if (lastTok !== '') return null;
                    } else if (lastTok !== '[' && lastTok !== ',' && lastTok !== ':') {
                        return null;
                    }
                    stack.push(ch);
                    lastTok = ch;
                    i += 1;
                    continue;
                }
                if (ch === '}' || ch === ']') {
                    const expected = ch === '}' ? '{' : '[';
                    if (!stack.length || stack[stack.length - 1] !== expected) return null;
                    if (lastTok !== expected && lastTok !== 'val_str' && lastTok !== 'val' && lastTok !== 'prim') {
                        return null;
                    }
                    stack.pop();
                    lastTok = 'val';
                    if (stack.length === 0) rootClosed = true;
                    i += 1;
                    continue;
                }
                if (ch === ':') {
                    if (stack[stack.length - 1] !== '{' || lastTok !== 'key_str') return null;
                    lastTok = ':';
                    i += 1;
                    continue;
                }
                if (ch === ',') {
                    if (!stack.length || (lastTok !== 'val_str' && lastTok !== 'val' && lastTok !== 'prim')) return null;
                    lastTok = ',';
                    i += 1;
                    continue;
                }
                if (/[0-9tfn-]/.test(ch)) {
                    if (!stack.length || (lastTok !== '[' && lastTok !== ',' && lastTok !== ':')) return null;
                    jsonPrimRe.lastIndex = i;
                    const prim = jsonPrimRe.exec(doc);
                    if (!prim || i + prim[0].length > end) return null;
                    i += prim[0].length;
                    lastTok = 'prim';
                    continue;
                }
                return null;
            }
            return (rootClosed && stack.length === 0) ? valStrings : null;
        };
        const matchesIndexedJsonValueString = (valStrings, startPos, endPos) => {
            if (!Array.isArray(valStrings) || valStrings.length === 0) return false;
            let lo = 0;
            let hi = valStrings.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const s = valStrings[mid];
                if (startPos < s.contentStart) hi = mid - 1;
                else if (startPos > s.contentStart) lo = mid + 1;
                else return s.contentEnd === endPos || (s.contentEnd === endPos + 1 && html[endPos] === '/');
            }
            return false;
        };
        const hasGluedPriorUrlInToken = tok => (
            /(?:https?:\/\/|(?:^|["'<=])\.{0,2}\/)/i.test(tok)
        );
        const SCRIPT_VALUE_END_KINDS = new Set(['punct_close', 'punct_close_ctrl', 'ident', 'str', 'num', 'regex']);

        for (const pattern of openSourcePatterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                const matchEnd = match.index + match[0].length;
                const attrSpan = findAttrSpanAt(match.index);
                if (attrSpan) {
                    // Reject srcset="..." and HTML5 imagesrcset="..." candidate lists unconditionally
                    if (attrSpan.name === 'srcset' || attrSpan.name === 'imagesrcset') continue;
                    if (URL_ATTR_NAMES.has(attrSpan.name)) {
                        const rawPrefix = html.slice(attrSpan.valueStart, match.index);
                        const rawSuffix = html.slice(matchEnd, attrSpan.valueEnd);
                        if (rawPrefix.trim().length > 0) continue;
                        if (rawSuffix.trim().length > 0) continue;
                    } else {
                        const inSingleQuotedAttr = attrSpan.quote === "'";
                        const inDoubleQuotedAttr = attrSpan.quote === '"';
                        const shortSuffix = html.slice(matchEnd, Math.min(attrSpan.valueEnd, matchEnd + 32));
                        if (inDoubleQuotedAttr && /^'/.test(shortSuffix)) continue;
                        if (!inDoubleQuotedAttr && /^'[A-Za-z0-9._~/@#?&=%+-]/.test(shortSuffix)) continue;
                        const attrHead = html.slice(attrSpan.valueStart, Math.min(attrSpan.valueEnd, attrSpan.valueStart + 64));
                        const looksLikeSingleQuotedJson = inSingleQuotedAttr
                            && /^\s*(?:\{\s*(?:"|\})|\[\s*(?:"|[\d{\[-]|true\b|false\b|null\b|\]))/.test(attrHead);
                        if (looksLikeSingleQuotedJson) {
                            if (attrSpan.jsonValueStrings === undefined) {
                                attrSpan.jsonValueStrings = indexValidJsonValueStrings(html, attrSpan.valueStart, attrSpan.valueEnd);
                            }
                            if (!matchesIndexedJsonValueString(attrSpan.jsonValueStrings, match.index, matchEnd)) {
                                continue;
                            }
                        } else {
                            // Strictly O(len(tok)) linear backward scan to last whitespace (eliminates ReDoS on rawPrefix).
                            let tIdx = match.index;
                            while (tIdx > attrSpan.valueStart && !/\s/.test(html[tIdx - 1])) tIdx -= 1;
                            const tok = html.slice(tIdx, match.index);
                            const boundedPrefix = html.slice(Math.max(attrSpan.valueStart, match.index - 140), match.index);
                            const isMarkdownLinkOpen = /(?:^|\s)\[[^\]\r\n<>]{1,120}\]\($/i.test(boundedPrefix);
                            const eqPrefix = tok.endsWith('=') && /(?:https?:\/\/|[?&#/])/i.test(tok);
                            const lastCh = tok.length ? tok[tok.length - 1] : '';
                            const hasSpoofDelim = inSingleQuotedAttr
                                ? /[!$*|,("'[{\^`\]})<>]/.test(lastCh)
                                : inDoubleQuotedAttr
                                    ? /[!$*|,('[{\^`\]})<>]/.test(lastCh)
                                    : /[!$*|,("'[{\^`\]})<>=]/.test(lastCh);
                            const spoofedPrefixedUrl = hasSpoofDelim
                                && /(?:https?:\/\/|^\.{0,2}\/|(?<=[<=])\.{0,2}\/)/i.test(tok);
                            if (eqPrefix || (!isMarkdownLinkOpen && spoofedPrefixedUrl)) continue;
                        }
                    }
                } else {
                    const rawTextSpan = findRawTextSpanAt(match.index);
                    const afterLimit = rawTextSpan
                        ? Math.min(rawTextSpan.contentEnd, matchEnd + 64)
                        : Math.min(html.length, matchEnd + 64);
                    const afterMatch = html.slice(matchEnd, afterLimit);
                    if (/^'[A-Za-z0-9._~/@#?&=%+-]/.test(afterMatch)) continue;

                    if (rawTextSpan && rawTextSpan.tagName === 'script') {
                        // If the <script> payload itself starts with { or [, validate & index it ONCE as RFC 8259 JSON.
                        let firstNonWs = rawTextSpan.contentStart;
                        while (firstNonWs < rawTextSpan.contentEnd && html[firstNonWs] <= ' ') firstNonWs += 1;
                        if (firstNonWs < rawTextSpan.contentEnd && (html[firstNonWs] === '{' || html[firstNonWs] === '[')) {
                            if (rawTextSpan.jsonValueStrings === undefined) {
                                rawTextSpan.jsonValueStrings = indexValidJsonValueStrings(
                                    html, firstNonWs, rawTextSpan.contentEnd
                                );
                            }
                            if (!matchesIndexedJsonValueString(rawTextSpan.jsonValueStrings, match.index, matchEnd)) {
                                continue;
                            }
                        } else {
                            const strSpan = findScriptStringSpanAt(rawTextSpan, match.index);
                            if (strSpan) {
                                if (!strSpan.closed || strSpan.inMalformedObj) continue;
                                if (strSpan.gluedToInterp && strSpan.contentStart === match.index) continue;
                                if (strSpan.contentStart === match.index) {
                                    // Standalone JS string literal beginning at match.index:
                                    // reject computed subscripting (obj["url"], {"a":"b"}["url"]), adjacent strings ("a""url"),
                                    // and malformed chained colons (: "v" : "url").
                                    if (strSpan.prevTok?.kind === 'str') continue;
                                    if (strSpan.prevTok?.text === '['
                                        && strSpan.prevPrevTok && SCRIPT_VALUE_END_KINDS.has(strSpan.prevPrevTok.kind)) {
                                        continue;
                                    }
                                    if (strSpan.prevTok?.text === ':' && strSpan.prev3Tok?.text === ':') {
                                        continue;
                                    }
                                } else {
                                    const inStrPrefixStart = Math.max(strSpan.contentStart, match.index - 4096);
                                    const inStrPrefix = html.slice(inStrPrefixStart, match.index);
                                    const isMarkdownLinkOpen = /(?:^|\s)\[[^\]\r\n<>]{1,120}\]\($/i.test(inStrPrefix);
                                    let tIdx = inStrPrefix.length;
                                    while (tIdx > 0 && !/\s/.test(inStrPrefix[tIdx - 1])) tIdx -= 1;
                                    const tok = inStrPrefix.slice(tIdx);
                                    const eqPrefix = tok.endsWith('=') && /(?:https?:\/\/|[?&#/])/i.test(tok);
                                    if (eqPrefix || (!isMarkdownLinkOpen && hasGluedPriorUrlInToken(tok))) continue;
                                }
                            } else {
                                // Inside JS comment or bare script text: bounded linear token check
                                const beforeStart = Math.max(rawTextSpan.contentStart, match.index - 4096);
                                const beforeMatch = html.slice(beforeStart, match.index);
                                const isMarkdownLinkOpen = /(?:^|\s)\[[^\]\r\n<>]{1,120}\]\($/i.test(beforeMatch);
                                let tIdx = beforeMatch.length;
                                while (tIdx > 0 && !/\s/.test(beforeMatch[tIdx - 1])) tIdx -= 1;
                                const tok = beforeMatch.slice(tIdx);
                                const eqPrefix = tok.endsWith('=') && /(?:https?:\/\/|[?&#/])/i.test(tok);
                                if (eqPrefix || (!isMarkdownLinkOpen && hasGluedPriorUrlInToken(tok))) continue;
                            }
                        }
                    } else {
                        const minBound = rawTextSpan
                            ? rawTextSpan.contentStart
                            : findLastTagEndBefore(match.index);
                        const beforeStart = Math.max(minBound, match.index - 4096);
                        const beforeMatch = html.slice(beforeStart, match.index);
                        const isMarkdownLinkOpen = /(?:^|[\s>])\[[^\]\r\n<>]{1,120}\]\($/i.test(beforeMatch);
                        // Strictly O(1) bounded linear scan of contiguous non-whitespace prefix token (<= 4096 chars).
                        // Never break on bare literal '<' or '>' in body text (real tag ends are bounded by minBound).
                        let tIdx = beforeMatch.length;
                        while (tIdx > 0 && !/\s/.test(beforeMatch[tIdx - 1])) {
                            tIdx -= 1;
                        }
                        const tok = beforeMatch.slice(tIdx);
                        const eqPrefix = tok.endsWith('=') && /(?:https?:\/\/|[?&#/])/i.test(tok);
                        let spoofedPrefixedUrl = false;
                        if (hasGluedPriorUrlInToken(tok)) {
                            // Only allow glued prior URLs in plain text / rawtext if they are a complete valid RFC 8259 JSON structure
                            // (e.g. compact `{"a":"https://...","b":"https://github.com/org/repo"}`).
                            const jsonRelStart = tok.search(/[\[{]/);
                            let validCompactJson = false;
                            if (jsonRelStart >= 0) {
                                const jsonAbsStart = beforeStart + tIdx + jsonRelStart;
                                const maxJsonEnd = rawTextSpan
                                    ? Math.min(rawTextSpan.contentEnd, jsonAbsStart + 8192)
                                    : Math.min(html.length, jsonAbsStart + 8192);
                                // Single linear pass to find where the root JSON container closes, then validate ONCE.
                                let depth = 0;
                                let inStr = false;
                                let esc = false;
                                let jsonAbsEnd = -1;
                                for (let p = jsonAbsStart; p < maxJsonEnd; p += 1) {
                                    const c = html[p];
                                    if (inStr) {
                                        if (esc) { esc = false; continue; }
                                        if (c === '\\') { esc = true; continue; }
                                        if (c === '"') inStr = false;
                                        continue;
                                    }
                                    if (c === '"') { inStr = true; continue; }
                                    if (c === '{' || c === '[') depth += 1;
                                    else if (c === '}' || c === ']') {
                                        depth -= 1;
                                        if (depth === 0) {
                                            jsonAbsEnd = p + 1;
                                            break;
                                        }
                                        if (depth < 0) break;
                                    }
                                }
                                if (jsonAbsEnd >= matchEnd) {
                                    const vals = indexValidJsonValueStrings(html, jsonAbsStart, jsonAbsEnd);
                                    if (vals && matchesIndexedJsonValueString(vals, match.index, matchEnd)) {
                                        validCompactJson = true;
                                    }
                                }
                            }
                            spoofedPrefixedUrl = !validCompactJson;
                        }
                        if (eqPrefix || (!isMarkdownLinkOpen && spoofedPrefixedUrl)) continue;
                    }
                }
                const candidate = `https://${match[1].replace(/\/$/, '').replace(/^[^/]+/, host => host.toLowerCase())}`;
                if (classifyRepositoryHostFacets(candidate)) {
                    foundLinks.push(candidate);
                }
            }
        }

        const links = [...new Set(foundLinks)];
        const isPlainTextReadme = /raw\.githubusercontent\.com/i.test(currentUrl);
        let audioDemo = null;
        if (!isPlainTextReadme && options.analyzeAudioCapabilities !== false) {
            const capabilities = analyzeDemoPageAudioCapabilities(html, currentUrl);
            let sampleProbe = null;
            if (options.probeAudioSamples === true && capabilities.sampleUrls.length > 0) {
                sampleProbe = await probeAudioSampleUrls(capabilities.sampleUrls, {
                    validateUrlImpl,
                    requestImpl,
                    detectProxyImpl,
                    maxSamples: options.maxAudioSampleProbes
                });
            }
            const spaceStatuses = [];
            if (options.probeSpaceStatus === true && capabilities.spaceUrls.length > 0) {
                for (const spaceUrl of capabilities.spaceUrls.slice(0, 2)) {
                    spaceStatuses.push(await probeHuggingFaceSpaceStatus(spaceUrl, {
                        validateUrlImpl,
                        requestImpl,
                        detectProxyImpl
                    }));
                }
            }
            audioDemo = {
                ...capabilities,
                ...(sampleProbe ? { sampleProbe } : {}),
                ...(spaceStatuses.length > 0 ? { spaceStatuses } : {})
            };
        }

        return {
            demoUrl,
            finalUrl: currentUrl,
            reachable: true,
            status: 200,
            links,
            audioDemo
        };
    } catch (err) {
        console.log(`    [deep] ⚠️  访问 demo 页面失败: ${err.message}`);
        if (err.code === 'DEMO_TRANSIENT_FAILURE'
            || err.code === 'PROXY_CONFIG_ERROR'
            || isPublicNetworkPolicyConfigError(err)) {
            throw err;
        }
        if (err.code === 'RESPONSE_TOO_LARGE') {
            console.log('    [deep] ℹ️  Demo 页面超过 1MB 安全上限，按确定性跳过处理');
            return { demoUrl, finalUrl: demoUrl, reachable: false, status: null, links: [], audioDemo: null };
        }
        if (/非公网|localhost|不支持的公网 URL 协议|任意公网资源只允许 HTTPS|用户名或密码|重定向超过/.test(err.message)) {
            return { demoUrl, finalUrl: demoUrl, reachable: false, status: null, links: [], audioDemo: null };
        }
        const transientError = new Error(`Demo 页面瞬时访问失败: ${err.message}`);
        transientError.code = 'DEMO_TRANSIENT_FAILURE';
        transientError.cause = err;
        throw transientError;
    }
}

async function checkDemoPageForOpensource(demoUrl, options = {}) {
    const detailed = await inspectDemoPageDetailed(demoUrl, {
        ...options,
        analyzeAudioCapabilities: false,
        probeAudioSamples: false,
        probeSpaceStatus: false
    });
    return detailed.links;
}

function extractApiReaderResourceCandidates(analysis) {
    const section = extractSectionByTitle(analysis, '开源详情');
    const typeByLabel = {
        '代码': 'code', '模型权重': 'model', '数据集': 'dataset',
        'Demo': 'demo', '复现材料': 'reproduction', '论文中引用的开源项目': 'third_party', '其他资源链接': 'third_party'
    };
    const candidates = [];
    for (const line of String(section || '').split('\n')) {
        const label = Object.keys(typeByLabel).find(item => line.includes(`${item}：`) || line.includes(`${item}:`));
        if (!label) continue;
        for (const match of line.matchAll(
            /https:\/\/[^\s<>()\[\]{}"'，。；：！？、（）【】《》“”‘’\u3400-\u9fff]+/giu
        )) {
            const url = match[0].replace(/[),.;:!?，。；：！？、）》】》」』]+$/u, '');
            if (isGenericMediaRootHomepage(url)) continue;
            let candidateType = typeByLabel[label];
            if (isGenericMediaPlatformHost(url)
                && ['code', 'model', 'dataset', 'reproduction'].includes(candidateType)) {
                candidateType = 'third_party';
            }
            candidates.push({ type: candidateType, url, line: line.trim() });
        }
    }
    return [...new Map(candidates.map(item => [`${item.type}:${item.url}`, item])).values()];
}

function extractWeakConferenceSourceResourceCandidates(sourceText) {
    return extractPaperSourceRepositoryCandidates(sourceText);
}

function isUrlContinuationAt(source, idx) {
    const ch = source[idx];
    if (!ch) return false;
    if (/[A-Za-z0-9_~%+-]/.test(ch)) return true;
    if (ch === '.') return Boolean(source[idx + 1] && /[A-Za-z0-9_~%+-]/.test(source[idx + 1]));
    if (ch === '/') {
        const next = source[idx + 1];
        return Boolean(next && (/[A-Za-z0-9_~%+-]/.test(next)
            || (next === '.' && source[idx + 2] && /[A-Za-z0-9._~%+-]/.test(source[idx + 2]))));
    }
    return false;
}

function isBoundedSourceTokenAt(text, idx, len, tok) {
    if (idx < 0 || len <= 0) return false;
    const beforeCh = idx > 0 ? text[idx - 1] : '';
    const afterBlocked = isUrlContinuationAt(text, idx + len);
    const beforeBlocked = !/^https?:\/\//i.test(tok) && Boolean(beforeCh && /[A-Za-z0-9._~%+-/]/.test(beforeCh));
    return !afterBlocked && !beforeBlocked;
}

function findBoundedSourceToken(source, token, searchFrom = 0) {
    if (!source || !token) return -1;
    let pos = searchFrom;
    while (pos < source.length) {
        const idx = source.indexOf(token, pos);
        if (idx < 0) return -1;
        if (isBoundedSourceTokenAt(source, idx, token.length, token)) return idx;
        pos = idx + 1;
    }
    return -1;
}

function exactResourceSourceQuote(sourceText, url, maxChars = 1200) {
    const source = String(sourceText || '');
    const index = findBoundedSourceToken(source, url);
    if (index < 0) return '';
    const lowerBound = Math.max(0, index - Math.floor(maxChars / 2));
    const upperBound = Math.min(source.length, index + url.length + Math.floor(maxChars / 2));
    const before = source.slice(lowerBound, index);
    const after = source.slice(index + url.length, upperBound);
    const boundaryBefore = Math.max(
        before.lastIndexOf('\n'), before.lastIndexOf('。'), before.lastIndexOf('. ')
    );
    const afterMatches = [after.indexOf('\n'), after.indexOf('。'), after.indexOf('. ')]
        .filter(value => value >= 0);
    const start = index - before.length + (boundaryBefore >= 0 ? boundaryBefore + 1 : 0);
    const end = index + url.length + (afterMatches.length > 0 ? Math.min(...afterMatches) + 1 : after.length);
    let quote = source.slice(start, end).trim();
    if (quote.length > maxChars) {
        const relative = findBoundedSourceToken(quote, url);
        const quoteStart = Math.max(0, Math.min(relative >= 0 ? relative : 0, quote.length - maxChars));
        quote = quote.slice(quoteStart, quoteStart + maxChars).trim();
    }
    if (findBoundedSourceToken(quote, url) < 0) throw new Error('开源资源 exact sourceQuote 截取丢失 URL');
    return quote;
}

async function verifyApiReaderResourceUrl(rawUrl, options = {}) {
    require('./conference-reader-operator-correction').assertMayAccessNetwork();
    require('./conference-source-resource-correction').assertMayAccessNetwork();
    const requestImpl = options.requestImpl || requestPinnedPublicHttps;
    const validateUrlImpl = options.validateUrlImpl || validatePublicHttpUrl;
    const detectProxyImpl = options.detectProxyImpl || resolveHttpConnectProxyUrl;
    const proxyEnabled = options.proxyEnabled !== undefined
        ? Boolean(options.proxyEnabled)
        : isValidHttpConnectProxyUrl(detectProxyImpl());
    let currentUrl = String(rawUrl || '');
    const redirects = [];
    for (let count = 0; count <= 3; count++) {
        let parsed;
        try {
            parsed = await validateUrlImpl(currentUrl, { proxyEnabled });
        } catch (error) {
            if (error?.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(error)) {
                throw error;
            }
            if (/非公网|localhost|不支持的公网 URL 协议|用户名或密码|必须使用 HTTPS/i
                .test(String(error?.message || ''))) throw error;
            return {
                originalUrl: rawUrl, finalUrl: currentUrl, redirects,
                status: null, availability: 'temporarily_unreachable', retryable: true,
                failureCode: String(error?.code || 'RESOURCE_DNS_TRANSIENT_FAILURE').slice(0, 100)
            };
        }
        if (parsed.protocol !== 'https:') throw new Error('开源资源 URL 必须使用 HTTPS');
        const remainingMs = Number.isFinite(options.deadlineAt)
            ? options.deadlineAt - Date.now() : 15000;
        if (remainingMs <= 0) {
            return {
                originalUrl: rawUrl, finalUrl: currentUrl, redirects,
                status: null, availability: 'temporarily_unreachable', retryable: true,
                failureCode: 'RESOURCE_VERIFICATION_BUDGET_EXHAUSTED'
            };
        }
        let response;
        try {
            response = await requestImpl(currentUrl, {
                headers: { 'User-Agent': 'PaperDigest/1.0' },
                method: 'GET',
                responseBodyMode: 'headers_only',
                timeoutMs: Math.min(15000, remainingMs)
            }, {
                validateUrlImpl,
                detectProxyImpl: options.proxyEnabled === false ? () => null : detectProxyImpl
            });
        } catch (error) {
            if (error?.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(error)) {
                throw error;
            }
            return {
                originalUrl: rawUrl, finalUrl: currentUrl, redirects,
                status: null, availability: 'temporarily_unreachable', retryable: true,
                failureCode: String(error?.code || 'RESOURCE_REQUEST_TRANSIENT_FAILURE').slice(0, 100)
            };
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = response.headers.get('location');
            if (!location || count >= 3) throw new Error('资源重定向缺少目标地址，或超过允许的三次重定向');
            const nextUrl = new URL(location, currentUrl).toString();
            redirects.push({ from: currentUrl, to: nextUrl, status: response.status });
            currentUrl = nextUrl;
            continue;
        }
        const temporary = [408, 425, 429].includes(response.status) || response.status >= 500;
        return {
            originalUrl: rawUrl,
            finalUrl: currentUrl,
            redirects,
            status: response.status,
            availability: response.status >= 200 && response.status < 400
                ? 'available' : temporary ? 'temporarily_unreachable' : 'unavailable',
            retryable: temporary
        };
    }
    throw new Error('检查资源地址后，仍未取得最终访问结果');
}

function githubRepositoryReadmeCandidateUrls(repositoryUrl) {
    try {
        const parsed = new URL(repositoryUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
            || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
            || segments.length !== 2
            || segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment))) return [];
        const base = `https://raw.githubusercontent.com/${segments[0]}/${segments[1]}`;
        return [
            `${base}/main/README.md`,
            `${base}/master/README.md`,
            `${base}/main/readme.md`,
            `${base}/master/readme.md`,
            `${base}/main/README.rst`,
            `${base}/master/README.rst`
        ];
    } catch (_) {
        return [];
    }
}

function githubRepositoryReadmeUrl(repositoryUrl) {
    return githubRepositoryReadmeCandidateUrls(repositoryUrl)[0] || '';
}

function isPlaceholderComingSoonReadme(readme) {
    const cleaned = String(readme || '').replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!cleaned || cleaned.length >= 2500) return false;
    const hasPlaceholderPhrase = /\b(?:coming\s+soon|will\s+be\s+released|to\s+be\s+released|stay\s+tuned|under\s+construction|code\s+soon|releasing\s+soon|placeholder)\b|即将开源|即将发布|敬请期待/i.test(cleaned);
    if (!hasPlaceholderPhrase) return false;
    const hasRunnableCommands = /\b(?:pip|uv\s+pip|npm)\s+install\b|\bconda\s+create\b|\bgit\s+clone\b|\brequirements\.txt\b|\benvironment\.ya?ml\b|\bfrom\s+transformers\b|\bAutoModel\b|\bpython3?\s+\S+\.py\b|\b(?:bash|sh)\s+\S+\.sh\b|\b(?:torchrun|deepspeed|accelerate\s+launch|docker\s+(?:build|pull|run))\b/i.test(cleaned);
    return !hasRunnableCommands;
}

function validRepositoryDocumentationEvidence(evidence, repositoryUrl) {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
    const expectedKeys = [
        'contract', 'repositoryUrl', 'sourceUrl', 'status', 'sourceSha256',
        'capabilities', 'completeness'
    ];
    if (Object.keys(evidence).sort().join(',') !== expectedKeys.sort().join(',')) return false;
    const capabilities = evidence.capabilities;
    const capabilityKeys = ['installation', 'inference', 'fineTuning'];
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)
        || Object.keys(capabilities).sort().join(',') !== capabilityKeys.sort().join(',')
        || capabilityKeys.some(key => typeof capabilities[key] !== 'boolean')) return false;
    const complete = capabilityKeys.every(key => capabilities[key]);
    const allowedSourceUrls = githubRepositoryReadmeCandidateUrls(repositoryUrl);
    return evidence.contract === REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT
        && evidence.repositoryUrl === repositoryUrl
        && allowedSourceUrls.includes(evidence.sourceUrl)
        && evidence.status === 200
        && recoverySha256(evidence.sourceSha256)
        && evidence.completeness === (complete ? 'complete' : 'partial');
}

async function inspectGitHubRepositoryDocumentation(repositoryUrl, options = {}) {
    require('./conference-reader-operator-correction').assertMayAccessNetwork();
    require('./conference-source-resource-correction').assertMayAccessNetwork();
    const candidateUrls = githubRepositoryReadmeCandidateUrls(repositoryUrl);
    if (!candidateUrls.length) return null;
    const deadlineAt = Number.isFinite(options.deadlineAt)
        ? options.deadlineAt : Date.now() + 15000;
    const requestImpl = options.requestImpl || requestPinnedPublicHttps;
    const validateUrlImpl = options.validateUrlImpl || validatePublicHttpUrl;
    const detectProxyImpl = options.detectProxyImpl || resolveHttpConnectProxyUrl;
    let response = null;
    let sourceUrl = '';
    for (const candidateUrl of candidateUrls) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) return null;
        const attempt = await requestImpl(candidateUrl, {
            headers: {
                'User-Agent': 'PaperDigest/1.0',
                'Accept': 'text/plain,text/markdown;q=0.9,*/*;q=0.1'
            },
            timeoutMs: Math.min(15000, remainingMs),
            maxBytes: 1024 * 1024
        }, {
            validateUrlImpl,
            detectProxyImpl: options.proxyEnabled === false ? () => null : detectProxyImpl
        });
        if (attempt.status === 200) {
            response = attempt;
            sourceUrl = candidateUrl;
            break;
        }
        if (attempt.status !== 404) return null;
    }
    if (!response) return null;
    const contentType = String(response.headers.get('content-type') || '')
        .split(';')[0].trim().toLowerCase();
    if (contentType && !['text/plain', 'text/markdown', 'text/x-rst', 'application/octet-stream']
        .includes(contentType)) return null;
    const readme = Buffer.from(await response.arrayBuffer()).toString('utf8');
    const placeholder = isPlaceholderComingSoonReadme(readme);
    const capabilities = placeholder
        ? { installation: false, inference: false, fineTuning: false }
        : {
            installation: /(?:^|\n)#{1,4}\s+(?:installation|install|setup|getting\s+started|environment|dependencies|requirements)\b|\b(?:pip|uv\s+pip)\s+install\b|\bconda\s+create\b|\brequirements\.txt\b|\benvironment\.ya?ml\b|\bgit\s+clone\b|\bdocker\s+(?:build|pull|run)\b/i.test(readme),
            inference: /(?:^|\n)#{1,4}\s+(?:inference|quick\s*start|usage|evaluation|eval|demo|examples?|run(?:ning)?|reproduc(?:tion|ing))\b|\binfer(?:ence)?\.py\b|\beval(?:uate|uation)?\.py\b|\bdemo\.py\b|\bfrom\s+(?:auk|transformers)\b|\bAutoModel\b|\bpython3?\s+(?:[^\n\s]*\/)?(?:infer(?:ence)?|eval(?:uate|uation)?|predict|generate|synthesize|demo|run|test|sample)[^\n\s]*\.py\b/i.test(readme),
            fineTuning: /(?:^|\n)#{1,4}\s+(?:fine[- ]?tun(?:ing|e)|training|train|pre[- ]?train(?:ing)?|sft|data\s+preparation)\b|\btrain(?:ing)?\.py\b|\bfinetune\.py\b|\b(?:deepspeed|torchrun|accelerate\s+launch)\b/i.test(readme)
        };
    const evidence = {
        contract: REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT,
        repositoryUrl,
        sourceUrl,
        status: response.status,
        sourceSha256: crypto.createHash('sha256').update(readme).digest('hex'),
        capabilities,
        completeness: Object.values(capabilities).every(Boolean) ? 'complete' : 'partial'
    };
    return validRepositoryDocumentationEvidence(evidence, repositoryUrl) ? evidence : null;
}

function isConferenceReaderResourceUrlShape(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl || rawUrl !== rawUrl.trim()) return false;
    let parsed;
    try { parsed = new URL(rawUrl); } catch (_) { return false; }
    const hostname = String(parsed.hostname || '').toLowerCase();
    const labels = hostname.split('.');
    const validDns = labels.length > 1 && labels.every(label =>
        /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    );
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password
        && !parsed.port && !parsed.fragment && !net.isIP(hostname)
        && hostname !== 'localhost' && !hostname.endsWith('.localhost') && validDns;
}

async function buildApiReaderResourceIdentity(analysis, sourceText, demoStage = {}, options = {}) {
    const conference = require('./conference-analysis-context.js');
    const weakConferencePolicy = options.paper
        ? conference.conferenceWeakReaderCapabilityPolicy(options.paper, options.structuredArtifacts)
        : null;
    const analysisCandidates = extractApiReaderResourceCandidates(analysis);
    const includeDailySourceCandidates = !weakConferencePolicy
        && options.paper?.source !== 'conference'
        && Boolean(options.paper?.arxivId);
    const analysisCanonUrls = includeDailySourceCandidates
        ? new Set(analysisCandidates.map(c => canonicalRepositoryDedupUrl(c.url)))
        : null;
    const dailyMissingSourceCandidates = includeDailySourceCandidates
        ? extractWeakConferenceSourceResourceCandidates(sourceText)
            .filter(c => c.type !== 'third_party'
                && !isGenericMediaRootHomepage(c.url)
                && !(isGenericMediaPlatformHost(c.url)
                    && ['code', 'model', 'dataset', 'reproduction'].includes(c.type))
                && !analysisCanonUrls.has(canonicalRepositoryDedupUrl(c.url)))
        : [];
    const sourceCandidates = [
        ...(weakConferencePolicy ? extractWeakConferenceSourceResourceCandidates(sourceText) : []),
        ...dailyMissingSourceCandidates,
        ...require('./reader-authenticated-pdf-footnote-evidence').deriveCandidates(sourceText)
    ];
    const demoHostResourceType = rawUrl => {
        const facets = classifyRepositoryHostFacets(rawUrl);
        return Array.isArray(facets) && facets.length > 0 ? facets[0] : null;
    };
    const canonicalDedupUrl = url => canonicalRepositoryDedupUrl(url);
    const canonKeyForSourceLookup = rawUrl => {
        const s = String(rawUrl || '').trim();
        if (!s) return '';
        const noFragQuery = /^https?:\/\/(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)\//i.test(s)
            ? s.replace(/[?#].*$/, '')
            : s;
        return canonicalDedupUrl(noFragQuery);
    };
    const retractionRepoRootKey = rawUrl => {
        const folded = String(rawUrl || '').replace(/\r?\n[ \t]*/g, '').trim();
        if (!folded) return '';
        let parsed;
        try {
            parsed = new URL(/^https?:\/\//i.test(folded) ? folded : `https://${folded}`);
        } catch (_) {
            return '';
        }
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const segments = parsed.pathname.split('/').filter(Boolean);
        if ((host === 'github.com' || host === 'gitlab.com') && segments.length >= 2) {
            return `https://${host}/${segments[0].toLowerCase()}/${segments[1].replace(/\.git$/i, '').toLowerCase()}`;
        }
        if (host === 'huggingface.co' && segments.length >= 2) {
            const first = segments[0].toLowerCase();
            if ((first === 'datasets' || first === 'spaces' || first === 'collections') && segments.length >= 3) {
                return `https://${host}/${first}/${segments[1].toLowerCase()}/${segments[2].replace(/\.git$/i, '').toLowerCase()}`;
            }
            return `https://${host}/${first}/${segments[1].replace(/\.git$/i, '').toLowerCase()}`;
        }
        if (host === 'modelscope.cn' && segments.length >= 2) {
            const first = segments[0].toLowerCase();
            if ((first === 'models' || first === 'datasets' || first === 'studios') && segments.length >= 3) {
                return `https://${host}/${first}/${segments[1].toLowerCase()}/${segments[2].replace(/\.git$/i, '').toLowerCase()}`;
            }
            return `https://${host}/${first}/${segments[1].replace(/\.git$/i, '').toLowerCase()}`;
        }
        return `https://${host}${parsed.pathname.replace(/\/+$/, '').toLowerCase()}`;
    };
    const rawSourceTextStr = String(sourceText || '');
    const isBoundedTokenAt = (text, idx, len, tok) => isBoundedSourceTokenAt(text, idx, len, tok);
    const hasBoundedExactToken = (text, tok) => findBoundedSourceToken(text, tok) >= 0;
    const sourceTokensByCanonUrl = new Map();
    const retractionOccurrencesByRepoRoot = new Map();
    const recordSourceOccurrence = (rawTok, idx) => {
        if (!rawTok || idx < 0) return;
        const normalized = normalizePaperSourceRepositoryToken(rawTok) || rawTok;
        const canonKey = canonKeyForSourceLookup(normalized);
        if (canonKey) {
            let list = sourceTokensByCanonUrl.get(canonKey);
            if (!list) {
                list = [];
                sourceTokensByCanonUrl.set(canonKey, list);
            }
            if (!list.some(item => item.index === idx && item.length === rawTok.length)) {
                list.push({ token: rawTok, index: idx, length: rawTok.length });
            }
        }
        const rootKey = retractionRepoRootKey(rawTok);
        if (rootKey) {
            let rlist = retractionOccurrencesByRepoRoot.get(rootKey);
            if (!rlist) {
                rlist = [];
                retractionOccurrencesByRepoRoot.set(rootKey, rlist);
            }
            if (!rlist.some(item => item.index === idx && item.length === rawTok.length)) {
                rlist.push({ token: rawTok, index: idx, length: rawTok.length });
            }
        }
    };
    for (const m of rawSourceTextStr.matchAll(/https?:\/\/[^\s<>"'\]})>,;]+/gi)) {
        const rawTok = m[0].replace(/[),.;:!?，。；：！？、）》】」』]+$/u, '');
        if (rawTok) recordSourceOccurrence(rawTok, m.index);
    }
    for (const m of rawSourceTextStr.matchAll(/(?<![A-Za-z0-9._~@/-])(?:https?(?:\r?\n[ \t]*)?:(?:\r?\n[ \t]*)?\/(?:\r?\n[ \t]*)?\/(?:\r?\n[ \t]*)?)?(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)(?:\r?\n[ \t]*)?\/(?:\r?\n[ \t]*)?[A-Za-z0-9._~-]+(?:\r?\n[ \t]*)?\/(?:\r?\n[ \t]*)?[A-Za-z0-9._~-]+(?:(?:\r?\n[ \t]*)?\/(?:\r?\n[ \t]*)?[A-Za-z0-9._~-]+)*/giu)) {
        const rawTok = m[0].replace(/[),.;:!?，。；：！？、）》】」』]+$/u, '');
        if (rawTok && isBoundedTokenAt(rawSourceTextStr, m.index, rawTok.length, rawTok)) {
            recordSourceOccurrence(rawTok, m.index);
        }
    }
    for (const cand of sourceCandidates) {
        const tok = cand?.sourceToken || cand?.url || '';
        if (!tok) continue;
        let pos = 0;
        while (pos < rawSourceTextStr.length) {
            const idx = rawSourceTextStr.indexOf(tok, pos);
            if (idx < 0) break;
            if (isBoundedTokenAt(rawSourceTextStr, idx, tok.length, tok)) {
                recordSourceOccurrence(tok, idx);
            }
            pos = idx + Math.max(1, tok.length);
        }
    }
    const isBindableTokenForUrl = (tok, url) => {
        if (!tok || !url) return false;
        if (tok === url) return true;
        const normalized = normalizePaperSourceRepositoryToken(tok);
        return Boolean(normalized && canonicalDedupUrl(normalized) === canonicalDedupUrl(url));
    };
    const resolveSourceTokenForUrl = (url, explicitToken = '') => {
        if (explicitToken && hasBoundedExactToken(rawSourceTextStr, explicitToken)
            && isBindableTokenForUrl(explicitToken, url)) {
            return explicitToken;
        }
        const occurrences = sourceTokensByCanonUrl.get(canonKeyForSourceLookup(url));
        if (occurrences && occurrences.length > 0) {
            const exact = occurrences.find(item => item.token === url);
            if (exact) return exact.token;
            const bindable = occurrences.find(item => isBindableTokenForUrl(item.token, url));
            if (bindable) return bindable.token;
        }
        if (url && hasBoundedExactToken(rawSourceTextStr, url)) return url;
        return explicitToken || url;
    };
    const demoLinks = new Set((Array.isArray(demoStage?.discoveredLinks) ? demoStage.discoveredLinks : [])
        .filter(url => Boolean(demoHostResourceType(url))));
    const demoLinksCanon = new Set([...demoLinks].map(canonicalDedupUrl));
    const demoCandidates = [...demoLinks].flatMap(url => {
        const hostType = demoHostResourceType(url);
        if (!hostType) return [];
        const resolvedToken = resolveSourceTokenForUrl(url);
        const hasSourceMention = Boolean(exactResourceSourceQuote(sourceText, resolvedToken));
        const sourceFacets = hasSourceMention
            ? paperSourceResourceFacets(sourceText, resolvedToken).filter(facet => facet !== 'third_party')
            : [];
        const types = sourceFacets.length > 0 ? sourceFacets : [hostType];
        return types.map(type => ({
            type,
            url: hasSourceMention ? (normalizePaperSourceRepositoryToken(resolvedToken) || url) : url,
            ...(hasSourceMention && resolvedToken !== url ? { sourceToken: resolvedToken } : {}),
            line: `validated project metadata: ${url}`
        }));
    });
    const candidateByTypeAndUrl = new Map();
    for (const candidate of [...analysisCandidates, ...sourceCandidates, ...demoCandidates]) {
        const canonUrl = canonicalDedupUrl(candidate.url);
        const key = `${candidate.type}:${canonUrl}`;
        const previous = candidateByTypeAndUrl.get(key);
        const preferNonTrailingSlash = previous && previous.url.endsWith('/') && !candidate.url.endsWith('/')
            && !previous.authenticatedPdfFootnoteEvidence
            && (Boolean(candidate.sourceToken) || Boolean(exactResourceSourceQuote(sourceText, candidate.url)));
        if (!previous || (candidate.authenticatedPdfFootnoteEvidence && !previous.authenticatedPdfFootnoteEvidence)
            || preferNonTrailingSlash
            || (candidate.sourceToken && !previous.sourceToken && !previous.authenticatedPdfFootnoteEvidence)) {
            candidateByTypeAndUrl.set(key, candidate);
        }
    }
    const typedUrls = new Set([...candidateByTypeAndUrl.values()]
        .filter(candidate => candidate.type !== 'third_party').map(candidate => canonicalDedupUrl(candidate.url)));
    const extractedCandidates = [...candidateByTypeAndUrl.values()].filter(candidate => (
        candidate.type !== 'third_party' || !typedUrls.has(canonicalDedupUrl(candidate.url))
    ));
    const deadlineAt = Number.isFinite(options.deadlineAt)
        ? options.deadlineAt : Date.now() + 60000;
    const rawBoundCandidates = extractedCandidates.map(candidate => {
        const footnoteProof = candidate.authenticatedPdfFootnoteEvidence;
        if (footnoteProof) require('./reader-authenticated-pdf-footnote-evidence').assertEvidence({
            origin: 'paper_source', type: candidate.type, originalUrl: candidate.url,
            sourceQuote: footnoteProof.sourceQuote, sourceQuoteSha256: footnoteProof.sourceQuoteSha256,
            authenticatedPdfFootnoteEvidence: footnoteProof
        }, sourceText);
        const effectiveSourceToken = resolveSourceTokenForUrl(candidate.url, candidate.sourceToken || '');
        const sourceLine = footnoteProof?.sourceQuote || exactResourceSourceQuote(
            sourceText,
            effectiveSourceToken
        );
        const resolvedUrl = sourceLine && !footnoteProof && effectiveSourceToken !== candidate.url
            ? (normalizePaperSourceRepositoryToken(effectiveSourceToken) || candidate.url)
            : candidate.url;
        const resolvedSourceToken = sourceLine && !footnoteProof && effectiveSourceToken !== resolvedUrl
            ? effectiveSourceToken
            : candidate.sourceToken;
        const canBindAsPaperSource = Boolean(footnoteProof)
            || (Boolean(sourceLine) && (effectiveSourceToken === resolvedUrl
                || normalizePaperSourceRepositoryToken(effectiveSourceToken) === resolvedUrl));
        let origin = canBindAsPaperSource ? 'paper_source'
            : (demoLinks.has(candidate.url) || demoLinksCanon.has(canonicalDedupUrl(candidate.url)))
                ? 'validated_demo' : null;
        const sourceFacets = origin === 'paper_source'
            ? footnoteProof?.pdfFootnote.resourceFacets
                || paperSourceResourceFacets(sourceText, effectiveSourceToken) : [];
        const firstPartyFacets = sourceFacets.filter(facet => facet !== 'third_party');
        const demotedThirdPartyWouldBeStale = origin === 'paper_source'
            && !sourceFacets.includes(candidate.type)
            && firstPartyFacets.length > 0
            && !resourceClassificationIsCurrent({
                ...candidate,
                type: 'third_party',
                origin,
                originalUrl: resolvedUrl,
                sourceUrlToken: effectiveSourceToken
            }, sourceText);
        const staleFirstPartyClassification = origin === 'paper_source'
            && candidate.type === 'third_party'
            && firstPartyFacets.length > 0
            && !resourceClassificationIsCurrent({
                ...candidate,
                origin,
                originalUrl: resolvedUrl,
                sourceUrlToken: effectiveSourceToken
            }, sourceText);
        let type = (staleFirstPartyClassification || demotedThirdPartyWouldBeStale)
            ? firstPartyFacets[0]
            : origin === 'paper_source' && !sourceFacets.includes(candidate.type)
                ? 'third_party' : candidate.type;
        // 论文正文中仅有裸 URL 提及（且多行上下文无否定/第三方归属），且元数据/项目页已验证该官方链接
        // 且主机类型匹配时，允许使用 validated_demo 印证其官方资源类型，不再被误降为 third_party。
        const expectedHostType = demoHostResourceType(resolvedUrl);
        if (origin === 'validated_demo') {
            if (!expectedHostType) {
                origin = null;
            } else {
                type = expectedHostType;
            }
        }
        const restrictedDomainGuard = '(?!\\s+to\\s+(?:non[- ]?commercial|research|academic|educational|personal|evaluation|scientific|\\d|monophonic|single|clean|short|english|speech|audio|fixed|causal|offline|synthetic|in-domain)\\b)';
        const RETRACTED_OR_CLOSED_SOURCE = new RegExp(`\\b(?:(?:isn[’']t|aren[’']t|hasn[’']t|haven[’']t|didn[’']t|cannot|can[’']t|won[’']t|don[’']t|doesn[’']t|unable\\s+to)\\s+(?:(?:currently|still|yet)\\s+)*(?:be(?:en)?\\s+)?(?:public(?:ly)?\\s+|openly\\s+)?(?:available|release[d]?|open[- ]source[d]?|publish(?:ed)?|share[d]?|provide[d]?|accessible|(?:made|make)\\s+(?:(?:our|this|the|these|it|them)\\b[^.!?\\n]{0,60}\\s+)?(?:publicly\\s+|openly\\s+)?available)|(?:is|are|remains?|kept|currently|still)\\s+(?:(?:currently|still|strictly|presently)\\s+)*(?:private|withheld|pending(?:\\s+(?:approval|review|release))?|tbd|restricted${restrictedDomainGuard})|closed[- ]source|unreleased|unavailable|proprietary|confidential|internal\\s+only|withheld|to\\s+be\\s+released|pending\\s+(?:approval|review|release)|tbd|under\\s+(?:anonymous\\s+)?review|private\\s+(?:repo(?:sitory)?|codes?|models?|weights?|checkpoints?|datasets?|benchmarks?)|(?:access\\s+(?:is\\s+|to\\s+[^.!?\\n]{0,40}is\\s+)?restricted${restrictedDomainGuard}|restricted\\s+(?:access|repo(?:sitory)?|codes?|models?|weights?|checkpoints?|datasets?)|(?:repo(?:sitory)?|codes?|models?|weights?|checkpoints?|datasets?)\\s+(?:is|are|remains?)\\s+(?:currently\\s+)?restricted${restrictedDomainGuard})|not\\s+(?:(?:yet|currently|still)\\s+)*(?:public(?:ly)?|available|release[d]?|open[- ]source[d]?|shared|accessible))\\b`, 'i');
        const tokenForWindow = effectiveSourceToken;
        const rawSourceText = rawSourceTextStr;
        const tokenMatches = [];
        const seenMatchSpan = new Set();
        const addTokenMatch = (index, length) => {
            const key = `${index}:${length}`;
            if (index >= 0 && length > 0 && !seenMatchSpan.has(key)) {
                seenMatchSpan.add(key);
                tokenMatches.push({ index, length });
            }
        };
        if (origin === 'paper_source' || origin === 'validated_demo') {
            for (const lookupUrl of [resolvedUrl, candidate.url]) {
                const indexed = sourceTokensByCanonUrl.get(canonKeyForSourceLookup(lookupUrl)) || [];
                for (const item of indexed) addTokenMatch(item.index, item.length);
                const rootIndexed = retractionOccurrencesByRepoRoot.get(retractionRepoRootKey(lookupUrl)) || [];
                for (const item of rootIndexed) addTokenMatch(item.index, item.length);
            }
            if (origin === 'paper_source' && tokenForWindow) {
                let searchFrom = 0;
                while (searchFrom < rawSourceText.length) {
                    const idx = rawSourceText.indexOf(tokenForWindow, searchFrom);
                    if (idx < 0) break;
                    if (isBoundedTokenAt(rawSourceText, idx, tokenForWindow.length, tokenForWindow)) {
                        addTokenMatch(idx, tokenForWindow.length);
                    }
                    searchFrom = idx + Math.max(1, tokenForWindow.length);
                }
            }
        }
        const followRetractionOpts = {
            demoPlatform: demoPlatformForToken(resolvedUrl),
            repoHostDemo: Boolean(classifyRepositoryHostFacets(resolvedUrl)?.includes('code'))
        };
        const hasBlockingSourceContext = tokenMatches.length > 0
            ? tokenMatches.some(({ index: idx, length: len }) => {
                const win = stripComparativeClosedSourceContrast(
                    rawSourceText.slice(Math.max(0, idx - 240), Math.min(rawSourceText.length, idx + len + 120))
                );
                const contextFacets = inferContextFacetsForRetraction(rawSourceText, idx, expectedHostType, idx + len);
                return RESOURCE_NOT_RELEASED.test(win) || THIRD_PARTY_RESOURCE.test(win)
                    || RETRACTED_OR_CLOSED_SOURCE.test(win)
                    || hasExplicitThirdPartySourceAttribution(rawSourceText, idx, idx + len)
                    || hasFollowingResourceRetraction(rawSourceText, idx + len, contextFacets, followRetractionOpts)
                    || contextFacets.some(f => hasInlineTailRetraction(rawSourceText, idx + len, f, followRetractionOpts))
                    || hasPrecedingResourceRetractionOrDeferral(rawSourceText, idx, contextFacets, followRetractionOpts);
            })
            : (() => {
                const cleanedLine = stripComparativeClosedSourceContrast(String(sourceLine || ''));
                return RESOURCE_NOT_RELEASED.test(cleanedLine) || THIRD_PARTY_RESOURCE.test(cleanedLine)
                    || RETRACTED_OR_CLOSED_SOURCE.test(cleanedLine);
            })();
        if (origin === 'validated_demo' && hasBlockingSourceContext) {
            origin = null;
        } else if (origin === 'paper_source' && type === 'third_party'
            && sourceFacets.every(facet => facet === 'third_party')
            && expectedHostType && candidate.type === expectedHostType
            && (demoLinks.has(candidate.url) || demoLinksCanon.has(canonicalDedupUrl(candidate.url)))
            && !hasBlockingSourceContext) {
            origin = 'validated_demo';
            type = expectedHostType;
        }
        return {
            ...candidate,
            url: resolvedUrl,
            ...(resolvedSourceToken ? { sourceToken: resolvedSourceToken } : {}),
            type,
            sourceLine,
            origin
        };
    }).filter(candidate => candidate.origin);
    // 最终类型归位后再次按 (type, canonicalUrl) 去重，且优先保留已识别的一方类型而非重复 third_party。
    const finalTypedUrls = new Set(rawBoundCandidates
        .filter(candidate => candidate.type !== 'third_party')
        .map(candidate => canonicalDedupUrl(candidate.url)));
    const boundByKey = new Map();
    for (const candidate of rawBoundCandidates) {
        const canonUrl = canonicalDedupUrl(candidate.url);
        if (candidate.type === 'third_party' && finalTypedUrls.has(canonUrl)) continue;
        const key = `${candidate.type}:${canonUrl}`;
        const existing = boundByKey.get(key);
        const existingPriority = !existing ? -1
            : existing.authenticatedPdfFootnoteEvidence ? 3
            : existing.origin === 'paper_source' ? 2 : 1;
        const candidatePriority = candidate.authenticatedPdfFootnoteEvidence ? 3
            : candidate.origin === 'paper_source' ? 2 : 1;
        const preferNonTrailingSlashSameOrigin = existing
            && candidatePriority === existingPriority
            && existing.url.endsWith('/') && !candidate.url.endsWith('/')
            && !existing.authenticatedPdfFootnoteEvidence;
        if (!existing || candidatePriority > existingPriority || preferNonTrailingSlashSameOrigin) {
            boundByKey.set(key, candidate);
        }
    }
    const boundCandidates = [...boundByKey.values()];
    const candidates = boundCandidates.slice(0, 12);
    if (boundCandidates.length > candidates.length) {
        console.log(
            `    [deep] 符合来源要求的资源链接共有 ${boundCandidates.length} 项；本次按原顺序检查前 12 项。`
        );
    }
    const resources = [];
    const verifiedByUrl = new Map();
    const documentationByUrl = new Map();
    const metadataRepositories = new Set(resolveMetadataResourceLinks(options.paper).map(canonicalDedupUrl).filter(Boolean));
    for (const candidate of candidates) {
        const { sourceLine, origin } = candidate;
        if (!isConferenceReaderResourceUrlShape(candidate.url)) {
            console.warn(`    [deep] 资源地址不符合允许的格式，已跳过：${candidate.url}`);
            continue;
        }
        let verified = verifiedByUrl.get(candidate.url);
        try {
            if (!verified) {
                const verifyUrlImpl = options.verifyUrlImpl || verifyApiReaderResourceUrl;
                verified = await verifyUrlImpl(candidate.url, {
                    ...options,
                    deadlineAt
                });
                verifiedByUrl.set(candidate.url, verified);
            }
        } catch (error) {
            if (error?.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(error)) {
                throw error;
            }
            if (/非公网|localhost|不支持的公网 URL 协议|用户名或密码|必须使用 HTTPS|资源重定向缺少目标地址，或超过允许的三次重定向|检查资源地址后，仍未取得最终访问结果/i
                .test(String(error?.message || ''))) {
                console.warn(`    [deep] 资源地址未通过安全检查，或未取得有效的重定向及访问结果，已跳过：${candidate.url}`);
                continue;
            }
            throw error;
        }
        let documentationEvidence = null;
        if (candidate.type === 'code' && options.paper && !weakConferencePolicy
            && (metadataRepositories.has(canonicalDedupUrl(candidate.url))
                || (verified.availability === 'available' && Boolean(githubRepositoryReadmeUrl(candidate.url))))) {
            if (!documentationByUrl.has(candidate.url)) {
                try {
                    const inspectDocumentation = options.documentationInspector
                        || inspectGitHubRepositoryDocumentation;
                    const inspected = await inspectDocumentation(candidate.url, {
                        ...options, deadlineAt
                    });
                    documentationByUrl.set(
                        candidate.url,
                        validRepositoryDocumentationEvidence(inspected, candidate.url)
                            ? inspected : null
                    );
                } catch (error) {
                    if (error?.code === 'PROXY_CONFIG_ERROR' || isPublicNetworkPolicyConfigError(error)) {
                        throw error;
                    }
                    console.warn(`    [deep] 本次未能检查仓库文档：${candidate.url}；原因：${error.message}`);
                    documentationByUrl.set(candidate.url, null);
                }
            }
            documentationEvidence = documentationByUrl.get(candidate.url);
            if (verified.availability !== 'available'
                && documentationEvidence?.completeness === 'complete'
                && validRepositoryDocumentationEvidence(
                    documentationEvidence, candidate.url
                )) {
                const { failureCode: _transientFailure, ...verifiedWithoutFailure } = verified;
                verified = {
                    ...verifiedWithoutFailure,
                    finalUrl: candidate.url,
                    redirects: [],
                    status: documentationEvidence.status,
                    availability: 'available',
                    retryable: false
                };
                verifiedByUrl.set(candidate.url, verified);
            }
        }
        const sourceQuote = origin === 'paper_source'
            ? candidate.authenticatedPdfFootnoteEvidence?.sourceQuote
                || paperSourceResourceQuote(sourceText, candidate.sourceToken || candidate.url)
            : (sourceLine && sourceLine.includes(candidate.url)
                ? sourceLine.trim()
                : `validated project metadata: ${candidate.url}`);
        resources.push({
            type: candidate.type,
            origin,
            sourceQuote,
            sourceQuoteSha256: crypto.createHash('sha256')
                .update(sourceQuote).digest('hex'),
            ...(origin === 'paper_source'
                ? normalizedSourceUrlBinding(candidate.sourceToken || candidate.url, candidate.url)
                : {}),
            ...(documentationEvidence ? { documentationEvidence } : {}),
            ...(candidate.authenticatedPdfFootnoteEvidence
                ? { authenticatedPdfFootnoteEvidence: structuredClone(candidate.authenticatedPdfFootnoteEvidence) } : {}),
            ...verified
        });
    }
    const identity = {
        ...readerIdentityFormat.header('resources'),
        sourceTextSha256: crypto.createHash('sha256').update(String(sourceText || '')).digest('hex'),
        resources
    };
    return { ...identity, identitySha256: stableFingerprint(identity) };
}

function canonicalRepositoryDedupUrl(url) {
    const raw = String(url || '');
    return classifyRepositoryHostFacets(raw)
        ? raw.replace(/\/$/, '').replace(/^https:\/\/[^/]+/i, match => match.toLowerCase())
        : raw;
}

function applyApiReaderResourceAvailability(analysis, identity) {
    if (!readerIdentityFormat.hasIdentity(identity, 'resources') || !Array.isArray(identity.resources)
        || !recoverySha256(identity.identitySha256)
        || identity.resources.some(resource => resource.origin === 'paper_source'
            && !paperSourceQuoteBindsOriginalUrl(resource))) {
        throw new Error('同步资源状态需要符合格式的资源核验记录；记录缺失时，不能按空资源列表处理。');
    }
    let updated = String(analysis || '');
    const acceptedUrls = new Set((identity?.resources || [])
        .map(item => item.originalUrl).filter(Boolean));
    const acceptedCanonUrls = new Set((identity?.resources || [])
        .map(item => canonicalRepositoryDedupUrl(item.originalUrl)).filter(Boolean));
    for (const candidate of extractApiReaderResourceCandidates(updated)) {
        if (!acceptedUrls.has(candidate.url)
            && !acceptedCanonUrls.has(canonicalRepositoryDedupUrl(candidate.url))) {
            updated = updated.split(candidate.url).join(
                '未找到论文原文或已验证 Demo 中的精确链接'
            );
        }
    }
    // 清理被 extractApiReaderResourceCandidates 丢弃的泛商业/媒体根域名，保持正文与 resources 一致。
    // 仅在「开源详情」节按完整 URL token 原子替换，绝不破坏同主机上的完整具体路径（如 /watch?v=...）。
    const rawOpenSourceSection = extractSectionByTitle(updated, '开源详情');
    if (rawOpenSourceSection) {
        const scrubbedSection = rawOpenSourceSection.replace(
            /https:\/\/[^\s`<>()\[\]{}"'，。；：！？、（）【】《》“”‘’\u3400-\u9fff]+/giu,
            full => {
                const trimmed = full.replace(/[),.;:!?，。；：！？、）》】」』]+$/u, '');
                const suffix = full.slice(trimmed.length);
                if (isGenericMediaRootHomepage(trimmed) && !acceptedUrls.has(trimmed)) {
                    return `未找到论文原文或已验证 Demo 中的精确链接${suffix}`;
                }
                return full;
            }
        );
        if (scrubbedSection !== rawOpenSourceSection) {
            updated = mergeSectionByTitle(updated, '开源详情', scrubbedSection);
        }
    }
    const availableTypes = new Set((identity?.resources || [])
        .filter(item => item.availability === 'available').map(item => item.type));
    for (const [field, type] of [['has_code', 'code'], ['has_model', 'model'], ['has_dataset', 'dataset']]) {
        updated = setMachineSummaryField(updated, field, availableTypes.has(type) ? '是' : '否');
    }
    const resourceLines = [
        ['code', '代码'],
        ['model', '模型权重'],
        ['dataset', '数据集'],
        ['demo', 'Demo'],
        ['reproduction', '复现材料'],
        ['third_party', '其他资源链接']
    ];
    const resourceDescription = resource => {
        const status = Number.isInteger(resource.status) ? `，HTTP ${resource.status}` : '';
        const documentation = resource.documentationEvidence?.completeness === 'complete'
            && validRepositoryDocumentationEvidence(
                resource.documentationEvidence, resource.originalUrl
            )
            ? '，README 已验证包含安装、推理与微调文档' : '';
        const availability = resource.availability === 'available'
            ? '已验证可访问'
            : resource.availability === 'unavailable'
                ? '当前不可用'
                : '本次暂时无法确认可达';
        return `<${resource.originalUrl}>（${availability}${status}${documentation}）`;
    };
    const summary = (identity?.resources || []).length === 0
        ? '未发现可验证的官方 HTTPS 资源 URL。'
        : identity.resources.map(item => (
            `${item.type}=${item.availability}${item.status === null ? '' : `(HTTP ${item.status})`}`
        )).join('；');
    const section = extractSectionByTitle(updated, '开源详情');
    let cleaned = String(section || '').replace(/^[-*]\s*资源可达性验证[：:].*$/gm, '').trim();
    const thirdPartyEntry = '<https:\\/\\/[^<>\\s]+>（(?:已验证可访问|当前不可用|本次暂时无法确认可达)(?:，HTTP \\d{3})?）';
    const generatedThirdPartyLineRe = new RegExp(`^- 其他资源链接：${thirdPartyEntry}(?:；${thirdPartyEntry})*（未据此确认作者已开放资源）$`);
    cleaned = cleaned.split('\n').map(line => {
        const candidates = extractApiReaderResourceCandidates(`## 开源详情\n${line}`);
        const generatedThirdPartyLine = generatedThirdPartyLineRe.test(line.trim());
        const urlEntryCount = (line.match(/<https:\/\/[^<>\s]+>/g) || []).length;
        if (generatedThirdPartyLine && candidates.length >= 1 && candidates.length === urlEntryCount
            && candidates.every(candidate => candidate.type === 'third_party'
                && identity.resources.some(resource => canonicalRepositoryDedupUrl(resource.originalUrl) === canonicalRepositoryDedupUrl(candidate.url)
                    && ((resource.origin === 'paper_source'
                        && (Object.hasOwn(resource, 'authenticatedPdfFootnoteEvidence')
                            ? require('./reader-authenticated-pdf-footnote-evidence').assertEvidence(resource)
                            : ['code', 'model', 'dataset', 'demo', 'reproduction'].includes(resource.type)
                                && (paperSourceResourceFacets(
                                    resource.sourceQuote, resource.sourceUrlToken || resource.originalUrl
                                ).includes(resource.type)
                                    || !resourceClassificationIsCurrent({
                                        ...resource, type: 'third_party'
                                    }, resource.sourceQuote))))
                        || (resource.origin === 'validated_demo'
                            && ['code', 'model', 'dataset', 'demo', 'reproduction'].includes(resource.type)))))) {
            return '';
        }
        return candidates.some(candidate => candidate.type !== 'third_party'
            && !identity.resources.some(resource => canonicalRepositoryDedupUrl(resource.originalUrl) === canonicalRepositoryDedupUrl(candidate.url)
                && resource.type === candidate.type))
            ? '- 其他资源链接：来源未确认属于作者已开放的资源；不据此判断技术缺陷。' : line;
    }).join('\n');
    for (const [type, label] of resourceLines) {
        const resources = identity.resources.filter(resource => resource.type === type);
        if (!resources.length) continue;
        const projected = `- ${label}：${resources.map(resourceDescription).join('；')}`
            + (type === 'third_party' ? '（未据此确认作者已开放资源）' : '');
        const lines = cleaned.split('\n');
        const pattern = new RegExp(
            `^\\s*(?:[-*]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*[：:]`
        );
        const matching = lines.map((line, index) => pattern.test(line) ? index : -1)
            .filter(index => index >= 0);
        if (matching.length === 0) {
            lines.push(projected);
        } else {
            lines[matching[0]] = projected;
            for (let index = matching.length - 1; index >= 1; index--) {
                lines.splice(matching[index], 1);
            }
        }
        cleaned = lines.join('\n').trim();
    }
    return mergeSectionByTitle(
        updated,
        '开源详情',
        `${cleaned}\n- 资源可达性验证：${summary}`.trim()
    );
}

function updateOpensourceFromDemoLinks(analysis, foundLinks) {
    if (!foundLinks || foundLinks.length === 0) return analysis;

    let updated = analysis;

    let hasCode = false, hasModel = false, hasDataset = false;
    const linkDescriptions = [];
    const repoHosts = new Set(['github.com', 'gitlab.com', 'huggingface.co', 'modelscope.cn']);
    for (const link of foundLinks) {
        const facets = classifyRepositoryHostFacets(link);
        if (facets) {
            if (facets.includes('code')) {
                hasCode = true;
                linkDescriptions.push(`- **代码仓库**：${link}`);
            } else if (facets.includes('dataset')) {
                hasDataset = true;
                linkDescriptions.push(`- **数据集**：${link}`);
            } else if (facets.includes('demo')) {
                linkDescriptions.push(`- **在线演示**：${link}`);
            } else if (facets.includes('model')) {
                hasModel = true;
                linkDescriptions.push(`- **模型权重**：${link}`);
            }
            continue;
        }
        let host = '';
        try { host = new URL(link).hostname.toLowerCase(); } catch (_) { host = ''; }
        if (!repoHosts.has(host)) {
            linkDescriptions.push(`- **相关链接**：${link}`);
        }
    }

    if (hasCode) {
        updated = updated.replace(/(has_code\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }
    if (hasModel) {
        updated = updated.replace(/(has_model\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }
    if (hasDataset) {
        updated = updated.replace(/(has_dataset\s*[：:]\s*)(否|no|n|无|未说明|unknown|否\b)/i, '$1是');
    }

    if (linkDescriptions.length > 0) {
        const previousResourceBlock = normalizeSectionContent(
            '开源详情',
            `\n\n**从 demo/项目页面验证发现（已更新开源评分）：**\n${linkDescriptions.join('\n')}`
        );
        const existingResourceDetails = extractSectionByTitle(updated, '开源详情');
        if (!existingResourceDetails.includes(previousResourceBlock)) {
            const newContent = `\n\n**发现的资源链接：**\n${linkDescriptions.join('\n')}`;
            updated = appendSectionByTitle(updated, '开源详情', newContent);
        }
    }

    return updated;
}

function getStructuredOpenSourceValue(openSourceText, label) {
    const pattern = new RegExp(`^(?:[-*+]\\s*)?(?:\\*\\*)?${escapeRegExp(label)}(?:\\*\\*)?\\s*[:：]\\s*(.+)$`, 'mi');
    return pattern.exec(String(openSourceText || ''))?.[1]?.trim() || '';
}

function inferResourceState(value) {
    const text = String(value || '').replace(/\*\*/g, '').trim();
    if (!text || /^(?:论文中)?未提及|未说明|未提供|无|none\b|not\s+(?:mentioned|provided)/i.test(text)) {
        return '未说明';
    }
    if (/https?:\/\/\S+|(?:github|gitlab)\.com\/\S+|(?:huggingface|modelscope)\.(?:co|cn)\/\S+/i.test(text)) {
        return '是';
    }
    if (/(?:已公开|已开源|可下载|可访问|获取方式|申请获取)/.test(text)) return '是';
    return '未说明';
}

function syncResourceFieldsFromOpenSource(analysis, openSourceText) {
    const resources = [
        ['has_code', '代码'],
        ['has_model', '模型权重'],
        ['has_dataset', '数据集']
    ];
    return resources.reduce((updated, [machineKey, label]) => {
        const resourceValue = getStructuredOpenSourceValue(openSourceText, label);
        if (!resourceValue) return updated;
        const state = inferResourceState(resourceValue);
        return setMachineSummaryField(updated, machineKey, state);
    }, analysis);
}

module.exports = {
    API_READER_RESOURCE_IDENTITY_CONTRACT,
    REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT,
    recoverySha256,
    stableFingerprint,
    escapeRegExp,
    findSectionBounds,
    extractSectionByTitle,
    normalizeSectionContent,
    mergeSectionByTitle,
    appendSectionByTitle,
    setMachineSummaryField,
    isPublicNetworkPolicyConfigError,
    isGloballyRoutableIpAddress,
    isPrivateIpAddress,
    validatePublicHttpUrl,
    nodeHeadersView,
    requestPinnedPublicHttps,
    fetchPublicImageResponse,
    isTransientDemoHttpStatus,
    isGenericMediaPlatformHost,
    isGenericMediaRootHomepage,
    hasOpenSourceLinks,
    extractDemoUrls,
    extractHuggingFaceSpaceUrls,
    analyzeDemoPageAudioCapabilities,
    probeAudioSampleUrls,
    probeHuggingFaceSpaceStatus,
    inspectDemoPageDetailed,
    extractCommentResourceUrls,
    resolveMetadataResourceLinks,
    resolveDemoPageCandidates,
    isMetadataResourceDiscoveryLink,
    checkDemoPageForOpensource,
    extractApiReaderResourceCandidates,
    extractWeakConferenceSourceResourceCandidates,
    exactResourceSourceQuote,
    verifyApiReaderResourceUrl,
    githubRepositoryReadmeCandidateUrls,
    githubRepositoryReadmeUrl,
    isPlaceholderComingSoonReadme,
    validRepositoryDocumentationEvidence,
    inspectGitHubRepositoryDocumentation,
    isConferenceReaderResourceUrlShape,
    buildApiReaderResourceIdentity,
    applyApiReaderResourceAvailability,
    updateOpensourceFromDemoLinks,
    getStructuredOpenSourceValue,
    inferResourceState,
    syncResourceFieldsFromOpenSource
};
