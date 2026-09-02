'use strict';

const crypto = require('crypto');
if (require.main === module) {
    require('../../scripts/env-loader.js').requireExternalRuntime('manual-signature-contract.js');
}

const MANUAL_SIGNATURE_CONTRACT = 'stable-json-ascii-keys-exact-ieee754-nfkc-text-v2';
const SAFE_INTEGER_LIMIT = Number.MAX_SAFE_INTEGER;
const ASCII_KEY_RE = /^[\x20-\x7e]+$/;

function assertUnicodeScalarString(value, label) {
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`${label} 含非法 Unicode 高代理项`);
            index++;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            throw new Error(`${label} 含非法 Unicode 低代理项`);
        }
    }
    return value;
}

function canonicalValue(value, label = 'signature') {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return assertUnicodeScalarString(value, label);
    if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)
            || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
            throw new Error(`${label} 签名对象禁止 NaN/Infinity、负零和非安全整数`);
        }
        return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => canonicalValue(item, `${label}[${index}]`));
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
        throw new Error(`${label} 含不可签名类型`);
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
        assertUnicodeScalarString(key, `${label}.key`);
        if (!ASCII_KEY_RE.test(key)) throw new Error(`${label} 签名对象 key 必须是可见 ASCII: ${key}`);
        result[key] = canonicalValue(value[key], `${label}.${key}`);
    }
    return result;
}

function canonicalNumber(value) {
    if (Number.isSafeInteger(value)) return String(value);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, false);
    const bits = view.getBigUint64(0, false);
    const negative = (bits >> 63n) === 1n;
    const exponentBits = Number((bits >> 52n) & 0x7ffn);
    const fraction = bits & ((1n << 52n) - 1n);
    const significand = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
    const exponent2 = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
    let digits;
    let scale = 0;
    if (exponent2 >= 0) {
        digits = significand << BigInt(exponent2);
    } else {
        scale = -exponent2;
        digits = significand * (5n ** BigInt(scale));
        while (scale > 0 && digits % 10n === 0n) {
            digits /= 10n;
            scale--;
        }
    }
    let text = digits.toString();
    if (scale > 0) {
        text = text.padStart(scale + 1, '0');
        text = `${text.slice(0, -scale)}.${text.slice(-scale)}`;
    }
    return negative ? `-${text}` : text;
}

function serializeCanonical(value) {
    if (typeof value === 'number') return canonicalNumber(value);
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => (
        `${JSON.stringify(key)}:${serializeCanonical(value[key])}`
    )).join(',')}}`;
}

function canonicalJson(value, label) {
    return serializeCanonical(canonicalValue(value, label));
}

function stableSignatureSha256(value, label) {
    return crypto.createHash('sha256').update(canonicalJson(value, label), 'utf8').digest('hex');
}

function normalizeNfkcText(value) {
    return assertUnicodeScalarString(String(value ?? ''), 'NFKC text')
        .normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

module.exports = {
    MANUAL_SIGNATURE_CONTRACT,
    SAFE_INTEGER_LIMIT,
    canonicalValue,
    canonicalJson,
    stableSignatureSha256,
    normalizeNfkcText
};
