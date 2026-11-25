'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_POLICY_PATH = path.resolve(__dirname, '../../config/public-network-policy.json');
const MAX_POLICY_BYTES = 64 * 1024;
const POLICY_KEYS = 'ipv6GlobalUnicastCidr,nonGlobalIpv4Cidrs,nonGlobalIpv6Cidrs,proxyFakeIpCidrs';
const HTTP_CONNECT_PROXY_ENV_VARS = Object.freeze([
    'https_proxy',
    'HTTPS_PROXY',
    'http_proxy',
    'HTTP_PROXY'
]);
const FORBIDDEN_PROXY_FAKE_IP_CIDR_LITERALS = Object.freeze([
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '::/128',
    '::1/128',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
    '::ffff:0:0/96'
]);

class PublicNetworkPolicyError extends Error {
    constructor(message, code, offendingIp = null) {
        super(message);
        this.name = 'PublicNetworkPolicyError';
        this.code = code;
        this.offendingIp = offendingIp;
    }
}

function parseIpv4Strict(raw) {
    if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(raw)) {
        return null;
    }
    const octets = raw.split('.').map(part => Number.parseInt(part, 10));
    if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        return null;
    }
    const value = octets.reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
    return {
        version: 4,
        value,
        bits: 32,
        canonical: `${octets[0]}.${octets[1]}.${octets[2]}.${octets[3]}`
    };
}

function formatIpv6Canonical(groups) {
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0
        && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff) {
        const hi = groups[6];
        const lo = groups[7];
        return `::ffff:${(hi >>> 8) & 0xff}.${hi & 0xff}.${(lo >>> 8) & 0xff}.${lo & 0xff}`;
    }
    let bestStart = -1;
    let bestLength = 0;
    let currentStart = -1;
    let currentLength = 0;
    for (let i = 0; i < 8; i++) {
        if (groups[i] === 0) {
            if (currentStart < 0) {
                currentStart = i;
                currentLength = 1;
            } else {
                currentLength += 1;
            }
            if (currentLength > bestLength) {
                bestStart = currentStart;
                bestLength = currentLength;
            }
        } else {
            currentStart = -1;
            currentLength = 0;
        }
    }
    if (bestLength < 2) {
        return groups.map(group => group.toString(16)).join(':');
    }
    const left = groups.slice(0, bestStart).map(group => group.toString(16)).join(':');
    const right = groups.slice(bestStart + bestLength).map(group => group.toString(16)).join(':');
    if (!left && !right) return '::';
    if (!left) return `::${right}`;
    if (!right) return `${left}::`;
    return `${left}::${right}`;
}

function parseIpv6Strict(raw) {
    if (typeof raw !== 'string' || !/^[\x21-\x7e]+$/.test(raw) || raw.includes('%')) {
        return null;
    }
    if (net.isIP(raw) !== 6) {
        return null;
    }
    let normalized = raw.toLowerCase();
    const dottedMatch = /(?:^|:)([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/.exec(normalized);
    if (dottedMatch) {
        const tail = parseIpv4Strict(dottedMatch[1]);
        if (!tail) return null;
        const ipv4 = Number(tail.value);
        normalized = normalized.slice(0, -dottedMatch[1].length)
            + `${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
    }
    const halves = normalized.split('::');
    if (halves.length > 2) return null;
    const head = halves[0] ? halves[0].split(':') : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    if (halves.length === 2) {
        if (head.length + tail.length >= 8) return null;
    } else if (head.length !== 8) {
        return null;
    }
    const parts = halves.length === 2
        ? [...head, ...Array(8 - head.length - tail.length).fill('0'), ...tail]
        : head;
    if (parts.length !== 8 || parts.some(part => !/^[0-9a-f]{1,4}$/.test(part))) {
        return null;
    }
    const groups = parts.map(part => Number.parseInt(part, 16));
    const value = groups.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n);
    return {
        version: 6,
        value,
        bits: 128,
        canonical: formatIpv6Canonical(groups)
    };
}

function parseIpAddress(raw) {
    if (typeof raw !== 'string' || !/^[\x21-\x7e]+$/.test(raw) || raw.includes('%')) {
        return null;
    }
    return parseIpv4Strict(raw) || parseIpv6Strict(raw);
}

function isIpLiteral(raw) {
    return parseIpAddress(raw) !== null;
}

function canonicalizeIp(raw) {
    const parsed = parseIpAddress(raw);
    if (!parsed) {
        throw new PublicNetworkPolicyError(
            `非法 IP 地址: ${String(raw)}`,
            'PUBLIC_NETWORK_INVALID_IP',
            String(raw)
        );
    }
    return parsed.canonical;
}

function parseCidrStrict(raw, expectedVersion = null) {
    if (typeof raw !== 'string' || !/^[\x21-\x7e]+$/.test(raw) || !raw.includes('/')) {
        throw new PublicNetworkPolicyError(`非法 CIDR 声明: ${String(raw)}`, 'PUBLIC_NETWORK_POLICY_SCHEMA');
    }
    const parts = raw.split('/');
    if (parts.length !== 2 || !/^(?:0|[1-9][0-9]{0,2})$/.test(parts[1])) {
        throw new PublicNetworkPolicyError(`非法 CIDR 前缀: ${raw}`, 'PUBLIC_NETWORK_POLICY_SCHEMA');
    }
    const ip = parseIpAddress(parts[0]);
    if (!ip || (expectedVersion !== null && ip.version !== expectedVersion)) {
        throw new PublicNetworkPolicyError(`非法 CIDR 网络地址: ${raw}`, 'PUBLIC_NETWORK_POLICY_SCHEMA');
    }
    const prefix = Number.parseInt(parts[1], 10);
    if (prefix < 0 || prefix > ip.bits) {
        throw new PublicNetworkPolicyError(`CIDR 前缀超出范围: ${raw}`, 'PUBLIC_NETWORK_POLICY_SCHEMA');
    }
    const hostBits = ip.bits - prefix;
    const hostMask = hostBits === 0 ? 0n : ((1n << BigInt(hostBits)) - 1n);
    if ((ip.value & hostMask) !== 0n) {
        throw new PublicNetworkPolicyError(`CIDR 主机位必须全为 0: ${raw}`, 'PUBLIC_NETWORK_POLICY_SCHEMA');
    }
    return Object.freeze({
        cidr: `${ip.canonical}/${prefix}`,
        version: ip.version,
        network: ip.value,
        end: ip.value | hostMask,
        prefix,
        bits: ip.bits
    });
}

function ipInCidr(parsedIp, cidr) {
    if (!parsedIp || parsedIp.version !== cidr.version) return false;
    return parsedIp.value >= cidr.network && parsedIp.value <= cidr.end;
}

function mergeClosedCidrIntervals(cidrs) {
    if (cidrs.length === 0) return [];
    const sorted = cidrs
        .map(item => [item.network, item.end])
        .sort((left, right) => (
            left[0] < right[0] ? -1 : left[0] > right[0] ? 1
                : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0
        ));
    const merged = [[sorted[0][0], sorted[0][1]]];
    for (let i = 1; i < sorted.length; i++) {
        const [nextStart, nextEnd] = sorted[i];
        const current = merged[merged.length - 1];
        if (nextStart <= current[1] + 1n) {
            if (nextEnd > current[1]) current[1] = nextEnd;
        } else {
            merged.push([nextStart, nextEnd]);
        }
    }
    return merged;
}

function isClosedIntervalCovered(start, end, mergedIntervals) {
    if (start > end) return true;
    return mergedIntervals.some(([mStart, mEnd]) => mStart <= start && end <= mEnd);
}

function parseStrictPolicyJsonBytes(bytes) {
    let source;
    try {
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
        throw new PublicNetworkPolicyError(
            '公网安全策略配置不是有效 UTF-8 编码',
            'PUBLIC_NETWORK_POLICY_SCHEMA'
        );
    }
    if (source.charCodeAt(0) === 0xfeff) {
        throw new PublicNetworkPolicyError(
            '公网安全策略配置禁止包含 UTF-8 BOM',
            'PUBLIC_NETWORK_POLICY_SCHEMA'
        );
    }
    const trimmed = source.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        throw new PublicNetworkPolicyError(
            '公网安全策略配置必须是纯 JSON 对象且禁止使用 Markdown 代码围栏',
            'PUBLIC_NETWORK_POLICY_SCHEMA'
        );
    }
    const stack = [];
    for (const match of source.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        const top = stack[stack.length - 1];
        if (token === '{') {
            stack.push({ object: true, keys: new Set(), expectKey: true });
        } else if (token === '[') {
            stack.push({ object: false });
        } else if (token === '}' || token === ']') {
            stack.pop();
        } else if (token === ',' && top?.object) {
            top.expectKey = true;
        } else if (token.startsWith('"') && top?.object && top.expectKey) {
            let key;
            try {
                key = JSON.parse(token);
            } catch (error) {
                throw new PublicNetworkPolicyError(
                    `公网安全策略配置不是有效 UTF-8 JSON: ${error.message}`,
                    'PUBLIC_NETWORK_POLICY_SCHEMA'
                );
            }
            if (top.keys.has(key)) {
                throw new PublicNetworkPolicyError(
                    `公网安全策略配置存在重复字段: ${key}`,
                    'PUBLIC_NETWORK_POLICY_SCHEMA'
                );
            }
            top.keys.add(key);
            top.expectKey = false;
        }
    }
    try {
        return JSON.parse(source);
    } catch (error) {
        throw new PublicNetworkPolicyError(
            `公网安全策略配置不是有效 UTF-8 JSON: ${error.message}`,
            'PUBLIC_NETWORK_POLICY_SCHEMA'
        );
    }
}

function readPolicyFileSafe(policyPath) {
    const target = path.resolve(String(policyPath || DEFAULT_POLICY_PATH));
    const statBefore = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!statBefore) {
        throw new PublicNetworkPolicyError(`公网安全策略文件不存在: ${target}`, 'PUBLIC_NETWORK_POLICY_MISSING');
    }
    if (!statBefore.isFile()
        || statBefore.isSymbolicLink()
        || (process.platform !== 'win32' && statBefore.nlink !== 1)) {
        throw new PublicNetworkPolicyError(
            `公网安全策略文件必须是单硬链接普通文件且禁止符号链接: ${target}`,
            'PUBLIC_NETWORK_POLICY_UNSAFE_FILE'
        );
    }
    let resolvedReal;
    try {
        resolvedReal = fs.realpathSync(target);
    } catch (error) {
        throw new PublicNetworkPolicyError(
            `无法解析公网安全策略文件真实路径: ${target}`,
            'PUBLIC_NETWORK_POLICY_SYMLINK'
        );
    }
    if (resolvedReal !== target) {
        throw new PublicNetworkPolicyError(
            `公网安全策略文件路径禁止包含符号链接: ${target}`,
            'PUBLIC_NETWORK_POLICY_SYMLINK'
        );
    }
    if (statBefore.size <= 0 || statBefore.size > MAX_POLICY_BYTES) {
        throw new PublicNetworkPolicyError(
            `公网安全策略文件大小超出安全范围: ${statBefore.size}`,
            'PUBLIC_NETWORK_POLICY_SIZE'
        );
    }
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    let fd;
    let bytes;
    try {
        fd = fs.openSync(target, flags);
        const statOpened = fs.fstatSync(fd);
        if (!statOpened.isFile()
            || (process.platform !== 'win32' && statOpened.nlink !== 1)
            || statOpened.dev !== statBefore.dev
            || statOpened.ino !== statBefore.ino
            || statOpened.size !== statBefore.size) {
            throw new PublicNetworkPolicyError(
                `公网安全策略文件在读取前状态异常: ${target}`,
                'PUBLIC_NETWORK_POLICY_TOCTOU'
            );
        }
        const expectedSize = statOpened.size;
        const chunks = [];
        let readSize = 0;
        while (true) {
            const buf = Buffer.alloc(Math.min(65536, expectedSize - readSize + 1));
            const n = fs.readSync(fd, buf, 0, buf.length, null);
            if (n === 0) break;
            if (n > expectedSize - readSize) {
                throw new PublicNetworkPolicyError(
                    `公网安全策略文件读取期间超过声明大小: ${target}`,
                    'PUBLIC_NETWORK_POLICY_TOCTOU'
                );
            }
            chunks.push(buf.subarray(0, n));
            readSize += n;
        }
        bytes = Buffer.concat(chunks, readSize);
        const statAfter = fs.fstatSync(fd);
        const statNamed = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!statNamed
            || bytes.length !== statOpened.size
            || statAfter.dev !== statOpened.dev
            || statAfter.ino !== statOpened.ino
            || statAfter.size !== statOpened.size
            || statAfter.mtimeMs !== statOpened.mtimeMs
            || statNamed.dev !== statOpened.dev
            || statNamed.ino !== statOpened.ino
            || statNamed.isSymbolicLink()
            || fs.realpathSync(target) !== target) {
            throw new PublicNetworkPolicyError(
                `公网安全策略文件在读取期间发生并发变化: ${target}`,
                'PUBLIC_NETWORK_POLICY_TOCTOU'
            );
        }
    } catch (error) {
        if (error instanceof PublicNetworkPolicyError) throw error;
        throw new PublicNetworkPolicyError(
            `读取公网安全策略文件失败: ${error.message}`,
            'PUBLIC_NETWORK_POLICY_READ_ERROR'
        );
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
    return parseStrictPolicyJsonBytes(bytes);
}

function isParsedGloballyRoutable(parsedIp, compiled) {
    if (!parsedIp) return false;
    if (parsedIp.version === 4) {
        return !compiled.nonGlobalIpv4.some(cidr => ipInCidr(parsedIp, cidr));
    }
    if (parsedIp.version === 6) {
        if (!ipInCidr(parsedIp, compiled.ipv6GlobalUnicast)) return false;
        return !compiled.nonGlobalIpv6.some(cidr => ipInCidr(parsedIp, cidr));
    }
    return false;
}

const FORBIDDEN_PROXY_FAKE_IP_CIDRS = Object.freeze(
    FORBIDDEN_PROXY_FAKE_IP_CIDR_LITERALS.map(item => parseCidrStrict(item, null))
);

function compilePublicNetworkPolicy(rawPolicy) {
    if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)
        || Object.keys(rawPolicy).sort().join(',') !== POLICY_KEYS) {
        throw new PublicNetworkPolicyError(
            '公网安全策略配置字段不完整或包含未知字段',
            'PUBLIC_NETWORK_POLICY_SCHEMA'
        );
    }
    if (!Array.isArray(rawPolicy.nonGlobalIpv4Cidrs) || rawPolicy.nonGlobalIpv4Cidrs.length < 15
        || !Array.isArray(rawPolicy.nonGlobalIpv6Cidrs) || rawPolicy.nonGlobalIpv6Cidrs.length === 0
        || !Array.isArray(rawPolicy.proxyFakeIpCidrs) || rawPolicy.proxyFakeIpCidrs.length === 0) {
        throw new PublicNetworkPolicyError(
            '公网安全策略 CIDR 列表不能为空且 IPv4 保留段不少于 15 段',
            'PUBLIC_NETWORK_POLICY_SCHEMA'
        );
    }
    const ipv6GlobalUnicast = parseCidrStrict(rawPolicy.ipv6GlobalUnicastCidr, 6);
    const nonGlobalIpv4 = Object.freeze(rawPolicy.nonGlobalIpv4Cidrs.map(item => parseCidrStrict(item, 4)));
    const nonGlobalIpv6 = Object.freeze(rawPolicy.nonGlobalIpv6Cidrs.map(item => parseCidrStrict(item, 6)));
    const proxyFakeIp = Object.freeze(rawPolicy.proxyFakeIpCidrs.map(item => parseCidrStrict(item, null)));

    const mergedNonGlobalIpv4 = mergeClosedCidrIntervals(nonGlobalIpv4);
    const mergedNonGlobalIpv6 = mergeClosedCidrIntervals(nonGlobalIpv6);

    for (const fakeCidr of proxyFakeIp) {
        for (const forbidden of FORBIDDEN_PROXY_FAKE_IP_CIDRS) {
            if (fakeCidr.version === forbidden.version
                && fakeCidr.network <= forbidden.end
                && forbidden.network <= fakeCidr.end) {
                throw new PublicNetworkPolicyError(
                    `proxyFakeIpCidrs 禁止覆盖私网、本机或多播保留地址段: ${fakeCidr.cidr} 与 ${forbidden.cidr} 重叠`,
                    'PUBLIC_NETWORK_POLICY_SCHEMA'
                );
            }
        }
        if (fakeCidr.version === 4) {
            if (!isClosedIntervalCovered(fakeCidr.network, fakeCidr.end, mergedNonGlobalIpv4)) {
                throw new PublicNetworkPolicyError(
                    `proxyFakeIpCidrs 不能覆盖公网可路由地址: ${fakeCidr.cidr}`,
                    'PUBLIC_NETWORK_POLICY_SCHEMA'
                );
            }
        } else {
            const intersectStart = fakeCidr.network > ipv6GlobalUnicast.network
                ? fakeCidr.network : ipv6GlobalUnicast.network;
            const intersectEnd = fakeCidr.end < ipv6GlobalUnicast.end
                ? fakeCidr.end : ipv6GlobalUnicast.end;
            if (intersectStart <= intersectEnd
                && !isClosedIntervalCovered(intersectStart, intersectEnd, mergedNonGlobalIpv6)) {
                throw new PublicNetworkPolicyError(
                    `proxyFakeIpCidrs 不能覆盖公网可路由地址: ${fakeCidr.cidr}`,
                    'PUBLIC_NETWORK_POLICY_SCHEMA'
                );
            }
        }
    }

    return Object.freeze({
        ipv6GlobalUnicast,
        nonGlobalIpv4,
        nonGlobalIpv6,
        proxyFakeIp,
        raw: Object.freeze({
            ipv6GlobalUnicastCidr: ipv6GlobalUnicast.cidr,
            nonGlobalIpv4Cidrs: Object.freeze(nonGlobalIpv4.map(item => item.cidr)),
            nonGlobalIpv6Cidrs: Object.freeze(nonGlobalIpv6.map(item => item.cidr)),
            proxyFakeIpCidrs: Object.freeze(proxyFakeIp.map(item => item.cidr))
        })
    });
}

let cachedDefaultPolicy = null;

function loadPublicNetworkPolicy(policyPath = DEFAULT_POLICY_PATH) {
    const resolved = path.resolve(String(policyPath || DEFAULT_POLICY_PATH));
    if (resolved === DEFAULT_POLICY_PATH && cachedDefaultPolicy) {
        return cachedDefaultPolicy;
    }
    const compiled = compilePublicNetworkPolicy(readPolicyFileSafe(resolved));
    if (resolved === DEFAULT_POLICY_PATH) {
        cachedDefaultPolicy = compiled;
    }
    return compiled;
}

function resolvePolicy(options = {}) {
    if (options && options.policy) {
        return options.policy.nonGlobalIpv4 ? options.policy : compilePublicNetworkPolicy(options.policy);
    }
    if (options && options.policyPath) {
        return loadPublicNetworkPolicy(options.policyPath);
    }
    return loadPublicNetworkPolicy(DEFAULT_POLICY_PATH);
}

const STRICT_DNS_LABEL_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

function isStrictProxyHostname(rawHostname) {
    if (typeof rawHostname !== 'string' || !rawHostname || rawHostname.includes('%')) return false;
    if (rawHostname.startsWith('[') && rawHostname.endsWith(']')) {
        const inner = rawHostname.slice(1, -1);
        return Boolean(inner) && !inner.includes('%') && /^[0-9a-fA-F:.]+$/.test(inner) && !inner.includes(':::');
    }
    if (rawHostname.includes(':')) return false;
    const lower = rawHostname.toLowerCase();
    const host = lower.endsWith('.') ? lower.slice(0, -1) : lower;
    if (!host || host.length > 253 || /[^a-z0-9._-]/.test(host)) return false;
    return host.split('.').every(label => STRICT_DNS_LABEL_RE.test(label));
}

function isValidHttpConnectProxyUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || /[\u0000-\u0020\u007f\\]/.test(rawUrl)) return false;
    const authMatch = /^https?:\/\/([^/?#]+)/i.exec(rawUrl);
    if (!authMatch) return false;
    const rawHostPort = authMatch[1].includes('@')
        ? authMatch[1].slice(authMatch[1].lastIndexOf('@') + 1)
        : authMatch[1];
    if (!rawHostPort || rawHostPort.includes('%')) return false;
    try {
        const parsed = new URL(rawUrl);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isStrictProxyHostname(parsed.hostname)
            && parsed.port !== '0';
    } catch (_) {
        return false;
    }
}

function resolveHttpConnectProxyUrl(env = process.env) {
    const source = env || {};
    const firstKey = HTTP_CONNECT_PROXY_ENV_VARS.find(key => Boolean(source[key]));
    if (!firstKey) return null;
    const value = String(source[firstKey]);
    return isValidHttpConnectProxyUrl(value) ? value : null;
}

function hasHttpConnectProxy(env = process.env) {
    return resolveHttpConnectProxyUrl(env) !== null;
}

function isGloballyRoutableIp(ip, options = {}) {
    const policy = resolvePolicy(options);
    const parsed = parseIpAddress(ip);
    return isParsedGloballyRoutable(parsed, policy);
}

function isPrivateIpAddress(ip, options = {}) {
    return !isGloballyRoutableIp(ip, options);
}

function isProxyFakeIp(ip, options = {}) {
    const policy = resolvePolicy(options);
    const parsed = parseIpAddress(ip);
    if (!parsed) return false;
    return policy.proxyFakeIp.some(cidr => ipInCidr(parsed, cidr));
}

function selectValidatedPublicIp(addresses, options = {}) {
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
        throw new TypeError('selectValidatedPublicIp options 必须为对象');
    }
    const { proxyEnabled = false } = options;
    if (typeof proxyEnabled !== 'boolean') {
        throw new TypeError('proxyEnabled 必须为布尔值');
    }
    if (addresses === null || addresses === undefined || typeof addresses === 'string'
        || typeof addresses[Symbol.iterator] !== 'function') {
        throw new PublicNetworkPolicyError('公网 URL DNS 解析为空', 'PUBLIC_NETWORK_EMPTY_DNS');
    }
    const rawList = Array.from(addresses);
    if (rawList.length === 0) {
        throw new PublicNetworkPolicyError('公网 URL DNS 解析为空', 'PUBLIC_NETWORK_EMPTY_DNS');
    }
    const policy = resolvePolicy(options);
    const parsedList = [];
    for (const rawItem of rawList) {
        const parsed = parseIpAddress(rawItem);
        if (!parsed) {
            throw new PublicNetworkPolicyError(
                `公网 URL DNS 解析到非公网 IP: ${String(rawItem)}`,
                'PUBLIC_NETWORK_INVALID_IP',
                String(rawItem)
            );
        }
        parsedList.push(parsed);
    }

    const uniqueCanonical = [];
    const seen = new Set();
    for (const item of parsedList) {
        if (!seen.has(item.canonical)) {
            seen.add(item.canonical);
            uniqueCanonical.push(item.canonical);
        }
    }

    const allGlobal = parsedList.every(item => isParsedGloballyRoutable(item, policy));
    if (allGlobal) {
        return {
            address: uniqueCanonical[0],
            addresses: uniqueCanonical,
            mode: 'global'
        };
    }

    const allFakeIp = parsedList.every(item => policy.proxyFakeIp.some(cidr => ipInCidr(item, cidr)));
    if (proxyEnabled === true && allFakeIp) {
        return {
            address: uniqueCanonical[0],
            addresses: uniqueCanonical,
            mode: 'proxy_fake_ip'
        };
    }

    const offending = proxyEnabled === true
        ? (parsedList.find(item => !isParsedGloballyRoutable(item, policy)
            && !policy.proxyFakeIp.some(cidr => ipInCidr(item, cidr)))
            || parsedList.find(item => !isParsedGloballyRoutable(item, policy)))
        : parsedList.find(item => !isParsedGloballyRoutable(item, policy));
    const offendingIp = offending ? offending.canonical : uniqueCanonical[0];
    throw new PublicNetworkPolicyError(
        `公网 URL DNS 解析到非公网 IP: ${offendingIp}`,
        'PUBLIC_NETWORK_NON_GLOBAL_IP',
        offendingIp
    );
}

module.exports = {
    DEFAULT_POLICY_PATH,
    HTTP_CONNECT_PROXY_ENV_VARS,
    PublicNetworkPolicyError,
    canonicalizeIp,
    compilePublicNetworkPolicy,
    hasHttpConnectProxy,
    isGloballyRoutableIp,
    isIpLiteral,
    isPrivateIpAddress,
    isProxyFakeIp,
    isValidHttpConnectProxyUrl,
    loadPublicNetworkPolicy,
    resolveHttpConnectProxyUrl,
    selectValidatedPublicIp
};
