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
    extractPaperSourceRepositoryCandidates,
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

function hasOpenSourceLinks(analysis) {
    const patterns = [
        /github\.com\/[\w\-]+\/[\w\-]+/gi,
        /huggingface\.co\/[\w\-]+\/[\w\-]+/gi,
        /modelscope\.cn\/[\w\-]+\/[\w\-]+/gi
    ];

    for (const pattern of patterns) {
        if (pattern.test(analysis)) return true;
    }
    return false;
}

function extractDemoUrls(analysis) {
    const urls = [];
    const urlSuffix = '[^\\s\\u3000\\uff08\\uff09\\u3010\\u3011\\u300c\\u300d\\u300e\\u300f'
        + '\\uff0c\\u3002\\uff1b\\uff1a\\uff01\\uff1f\\u3001\\u300b\\u3009]+';
    const patterns = [
        new RegExp(`Demo[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`项目主页[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`在线演示[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`Homepage[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`Project[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi'),
        new RegExp(`页面[：:]\\s*(https?:\\/\\/${urlSuffix})`, 'gi')
    ];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(analysis)) !== null) {
            const url = match[1].trim().replace(/[),.;:!?，。；：！？、）》】》」』]+$/u, '');
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

function resolveMetadataResourceLinks(paper) {
    if (!(paper?.sources || []).includes('huggingface')) return [];
    const raw = String(paper?.hf_github_repo || '').trim();
    try {
        const parsed = new URL(raw);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
            || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
            || segments.length !== 2
            || segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment))) return [];
        return [`https://github.com/${segments.join('/')}`];
    } catch (_) {
        return [];
    }
}

function resolveDemoPageCandidates(paper, analysis) {
    const urls = extractDemoUrls(analysis);
    const projectPage = String(paper?.hf_project_page || '').trim();
    if ((paper?.sources || []).includes('huggingface')
        && /^https:\/\/[^\s]+$/i.test(projectPage)) {
        urls.push(projectPage);
    }
    const repository = resolveMetadataResourceLinks(paper)[0];
    if (repository) {
        const parsed = new URL(repository);
        const [owner, name] = parsed.pathname.split('/').filter(Boolean);
        urls.push(`https://raw.githubusercontent.com/${owner}/${name}/main/README.md`);
    }
    return [...new Set(urls)];
}

function isMetadataResourceDiscoveryLink(paper, rawUrl) {
    const repository = resolveMetadataResourceLinks(paper)[0];
    try {
        const parsed = new URL(rawUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
        if (parsed.hostname === 'github.com') return rawUrl.replace(/\/$/, '') === repository;
        if (parsed.hostname === 'huggingface.co') return segments.length === 2
            && !['spaces', 'datasets'].includes(segments[0].toLowerCase())
            && segments.every(segment => /^[A-Za-z0-9._-]+$/.test(segment));
        return parsed.hostname === 'modelscope.cn'
            && segments.length === 3
            && segments[0].toLowerCase() === 'models'
            && segments.slice(1).every(segment => /^[A-Za-z0-9._-]+$/.test(segment));
    } catch (_) {
        return false;
    }
}

async function checkDemoPageForOpensource(demoUrl, options = {}) {
    const openSourcePatterns = [
        /github\.com\/[\w\-]+\/[\w\-]+/gi,
        /huggingface\.co\/[\w\-]+\/[\w\-]+/gi,
        /modelscope\.cn\/(?:models|datasets)\/[\w\-]+\/[\w\-]+/gi,
        /gitlab\.com\/[\w\-]+\/[\w\-]+/gi
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
                    return [];
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
            return [];
        }
        if (response.status !== 200) {
            console.log(`    [deep] ⚠️  Demo 页面返回 ${response.status}`);
            if (isTransientDemoHttpStatus(response.status)) {
                const transientError = new Error(`Demo 页面瞬时 HTTP ${response.status}`);
                transientError.code = 'DEMO_TRANSIENT_FAILURE';
                throw transientError;
            }
            return [];
        }

        const html = response.data;
        const foundLinks = [];

        for (const pattern of openSourcePatterns) {
            let match;
            while ((match = pattern.exec(html)) !== null) {
                foundLinks.push(`https://${match[0]}`);
            }
        }

        return [...new Set(foundLinks)];
    } catch (err) {
        console.log(`    [deep] ⚠️  访问 demo 页面失败: ${err.message}`);
        if (err.code === 'DEMO_TRANSIENT_FAILURE'
            || err.code === 'PROXY_CONFIG_ERROR'
            || isPublicNetworkPolicyConfigError(err)) {
            throw err;
        }
        if (err.code === 'RESPONSE_TOO_LARGE') {
            console.log('    [deep] ℹ️  Demo 页面超过 1MB 安全上限，按确定性跳过处理');
            return [];
        }
        if (/非公网|localhost|不支持的公网 URL 协议|任意公网资源只允许 HTTPS|用户名或密码|重定向超过/.test(err.message)) {
            return [];
        }
        const transientError = new Error(`Demo 页面瞬时访问失败: ${err.message}`);
        transientError.code = 'DEMO_TRANSIENT_FAILURE';
        transientError.cause = err;
        throw transientError;
    }
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
            candidates.push({ type: typeByLabel[label], url, line: line.trim() });
        }
    }
    return [...new Map(candidates.map(item => [`${item.type}:${item.url}`, item])).values()];
}

function extractWeakConferenceSourceResourceCandidates(sourceText) {
    return extractPaperSourceRepositoryCandidates(sourceText);
}

function exactResourceSourceQuote(sourceText, url, maxChars = 1200) {
    const source = String(sourceText || '');
    const index = source.indexOf(url);
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
        const relative = quote.indexOf(url);
        const quoteStart = Math.max(0, Math.min(relative, quote.length - maxChars));
        quote = quote.slice(quoteStart, quoteStart + maxChars).trim();
    }
    if (!quote.includes(url)) throw new Error('开源资源 exact sourceQuote 截取丢失 URL');
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

function githubRepositoryReadmeUrl(repositoryUrl) {
    try {
        const parsed = new URL(repositoryUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
            || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
            || segments.length !== 2
            || segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment))) return '';
        return `https://raw.githubusercontent.com/${segments[0]}/${segments[1]}/main/README.md`;
    } catch (_) {
        return '';
    }
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
    return evidence.contract === REPOSITORY_DOCUMENTATION_EVIDENCE_CONTRACT
        && evidence.repositoryUrl === repositoryUrl
        && evidence.sourceUrl === githubRepositoryReadmeUrl(repositoryUrl)
        && evidence.status === 200
        && recoverySha256(evidence.sourceSha256)
        && evidence.completeness === (complete ? 'complete' : 'partial');
}

async function inspectGitHubRepositoryDocumentation(repositoryUrl, options = {}) {
    require('./conference-reader-operator-correction').assertMayAccessNetwork();
    require('./conference-source-resource-correction').assertMayAccessNetwork();
    const sourceUrl = githubRepositoryReadmeUrl(repositoryUrl);
    if (!sourceUrl) return null;
    const deadlineAt = Number.isFinite(options.deadlineAt)
        ? options.deadlineAt : Date.now() + 15000;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) return null;
    const requestImpl = options.requestImpl || requestPinnedPublicHttps;
    const validateUrlImpl = options.validateUrlImpl || validatePublicHttpUrl;
    const detectProxyImpl = options.detectProxyImpl || resolveHttpConnectProxyUrl;
    const response = await requestImpl(sourceUrl, {
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
    if (response.status !== 200) return null;
    const contentType = String(response.headers.get('content-type') || '')
        .split(';')[0].trim().toLowerCase();
    if (contentType && !['text/plain', 'text/markdown', 'application/octet-stream']
        .includes(contentType)) return null;
    const readme = Buffer.from(await response.arrayBuffer()).toString('utf8');
    const capabilities = {
        installation: /(?:^|\n)#{1,4}\s+(?:installation|install|setup)\b|\bpip\s+install\b|\bconda\s+create\b/i.test(readme),
        inference: /(?:^|\n)#{1,4}\s+(?:inference|quick\s*start|usage)\b|\binfer(?:ence)?\.py\b|\bfrom\s+auk\b/i.test(readme),
        fineTuning: /(?:^|\n)#{1,4}\s+(?:fine[- ]?tuning|training|train)\b|\btrain(?:ing)?\.py\b|\bdeepspeed\b/i.test(readme)
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
    const sourceCandidates = [...(weakConferencePolicy
        ? extractWeakConferenceSourceResourceCandidates(sourceText) : []),
    ...require('./reader-authenticated-pdf-footnote-evidence').deriveCandidates(sourceText)];
    const demoLinks = new Set(Array.isArray(demoStage?.discoveredLinks)
        ? demoStage.discoveredLinks : []);
    const demoCandidates = [...demoLinks].map(url => {
        let parsed;
        try { parsed = new URL(url); } catch (_) { return null; }
        const pathname = parsed.pathname.toLowerCase();
        let type = null;
        if (['github.com', 'gitlab.com'].includes(parsed.hostname)) type = 'code';
        else if (['huggingface.co', 'modelscope.cn'].includes(parsed.hostname)) {
            type = pathname.includes('/datasets/') ? 'dataset' : 'model';
        }
        return type ? { type, url, line: `validated project metadata: ${url}` } : null;
    }).filter(Boolean);
    const candidateByTypeAndUrl = new Map();
    for (const candidate of [...analysisCandidates, ...sourceCandidates, ...demoCandidates]) {
        const key = `${candidate.type}:${candidate.url}`;
        const previous = candidateByTypeAndUrl.get(key);
        if (!previous || (candidate.authenticatedPdfFootnoteEvidence && !previous.authenticatedPdfFootnoteEvidence)
            || (candidate.sourceToken && !previous.sourceToken && !previous.authenticatedPdfFootnoteEvidence)) {
            candidateByTypeAndUrl.set(key, candidate);
        }
    }
    const typedUrls = new Set([...candidateByTypeAndUrl.values()]
        .filter(candidate => candidate.type !== 'third_party').map(candidate => candidate.url));
    const extractedCandidates = [...candidateByTypeAndUrl.values()].filter(candidate => (
        candidate.type !== 'third_party' || !typedUrls.has(candidate.url)
    ));
    const deadlineAt = Number.isFinite(options.deadlineAt)
        ? options.deadlineAt : Date.now() + 60000;
    const boundCandidates = extractedCandidates.map(candidate => {
        const footnoteProof = candidate.authenticatedPdfFootnoteEvidence;
        if (footnoteProof) require('./reader-authenticated-pdf-footnote-evidence').assertEvidence({
            origin: 'paper_source', type: candidate.type, originalUrl: candidate.url,
            sourceQuote: footnoteProof.sourceQuote, sourceQuoteSha256: footnoteProof.sourceQuoteSha256,
            authenticatedPdfFootnoteEvidence: footnoteProof
        }, sourceText);
        const sourceLine = footnoteProof?.sourceQuote || exactResourceSourceQuote(
            sourceText,
            candidate.sourceToken || candidate.url
        );
        const origin = sourceLine ? 'paper_source' : demoLinks.has(candidate.url)
            ? 'validated_demo' : null;
        const sourceFacets = origin === 'paper_source'
            ? footnoteProof?.pdfFootnote.resourceFacets
                || paperSourceResourceFacets(sourceText, candidate.sourceToken || candidate.url) : [];
        const staleAuthorCodeClassification = origin === 'paper_source'
            && candidate.type === 'third_party' && sourceFacets.includes('code')
            && !resourceClassificationIsCurrent({
                ...candidate,
                origin,
                originalUrl: candidate.url,
                sourceUrlToken: candidate.sourceToken || candidate.url
            }, sourceText);
        const type = staleAuthorCodeClassification ? 'code'
            : origin === 'paper_source' && !sourceFacets.includes(candidate.type)
                ? 'third_party' : candidate.type;
        return { ...candidate, type, sourceLine, origin };
    }).filter(candidate => candidate.origin);
    const candidates = boundCandidates.slice(0, 12);
    if (boundCandidates.length > candidates.length) {
        console.log(
            `    [deep] 符合来源要求的资源链接共有 ${boundCandidates.length} 项；本次按原顺序检查前 12 项。`
        );
    }
    const resources = [];
    const verifiedByUrl = new Map();
    const documentationByUrl = new Map();
    const metadataRepository = resolveMetadataResourceLinks(options.paper)[0] || '';
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
        if (candidate.type === 'code' && candidate.url === metadataRepository) {
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
            : sourceLine?.trim() || candidate.line;
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
    for (const candidate of extractApiReaderResourceCandidates(updated)) {
        if (!acceptedUrls.has(candidate.url)) {
            updated = updated.split(candidate.url).join(
                '未找到论文原文或已验证 Demo 中的精确链接'
            );
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
    cleaned = cleaned.split('\n').map(line => {
        const candidates = extractApiReaderResourceCandidates(`## 开源详情\n${line}`);
        const generatedThirdPartyLine = /^- 其他资源链接：<https:\/\/[^<>\s]+>（(?:已验证可访问|当前不可用|本次暂时无法确认可达)(?:，HTTP \d{3})?）（未据此确认作者已开放资源）$/.test(line.trim());
        if (generatedThirdPartyLine && candidates.length === 1 && candidates.every(candidate => candidate.type === 'third_party'
            && identity.resources.some(resource => resource.originalUrl === candidate.url
                && resource.origin === 'paper_source'
                && (Object.hasOwn(resource, 'authenticatedPdfFootnoteEvidence')
                    ? require('./reader-authenticated-pdf-footnote-evidence').assertEvidence(resource)
                    : resource.type === 'code' && !resourceClassificationIsCurrent({
                        ...resource, type: 'third_party'
                    }, resource.sourceQuote))))) {
            return '';
        }
        return candidates.some(candidate => candidate.type !== 'third_party'
            && !identity.resources.some(resource => resource.originalUrl === candidate.url
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
    for (const link of foundLinks) {
        const lower = link.toLowerCase();
        if (lower.includes('github.com')) hasCode = true;
        if (lower.includes('huggingface.co')) {
            if (lower.includes('/datasets/')) hasDataset = true;
            else hasModel = true;
        }
        if (lower.includes('modelscope.cn')) {
            if (lower.includes('/datasets/')) hasDataset = true;
            else hasModel = true;
        }
        if (lower.includes('gitlab.com')) hasCode = true;
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

    const linkDescriptions = [];
    for (const link of foundLinks) {
        const lower = link.toLowerCase();
        if (lower.includes('github.com') || lower.includes('gitlab.com')) {
            linkDescriptions.push(`- **代码仓库**：${link}`);
        } else if (lower.includes('huggingface.co') || lower.includes('modelscope.cn')) {
            if (lower.includes('/datasets/')) {
                linkDescriptions.push(`- **数据集**：${link}`);
            } else {
                linkDescriptions.push(`- **模型权重**：${link}`);
            }
        } else {
            linkDescriptions.push(`- **相关链接**：${link}`);
        }
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
    hasOpenSourceLinks,
    extractDemoUrls,
    resolveMetadataResourceLinks,
    resolveDemoPageCandidates,
    isMetadataResourceDiscoveryLink,
    checkDemoPageForOpensource,
    extractApiReaderResourceCandidates,
    extractWeakConferenceSourceResourceCandidates,
    exactResourceSourceQuote,
    verifyApiReaderResourceUrl,
    githubRepositoryReadmeUrl,
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
