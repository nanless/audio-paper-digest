'use strict';

// 这里只识别格式，不授予来源、分析、费用或发布资格。
// 历史对象保持原样；校验者必须对原字段和原字节重算签名。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { strictJson } = require('./strict-json');
const DIRECTORY = path.resolve(__dirname, '../../config/protocols');
const NAME = /^[a-z][a-z0-9]*(?:[-.][a-z0-9]+)*(?![\s\S])/;
const NUMBERED = /(?:^|[-.])v\d+(?:$|[-.])/;
const RESERVED = new Set(['contract', 'schemaFingerprint', 'version', 'schemaVersion', 'policyVersion', '__proto__']);

function canonical(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        if (typeof value === 'string' && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
            throw new Error('协议声明不能包含不完整的 Unicode 字符');
        }
        return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const keys = Object.keys(value).sort();
        if (keys.some(key => !/^[\x20-\x7e]+$/.test(key) || key === '__proto__')) throw new Error('协议声明的字段名必须是普通 ASCII 字符');
        return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    }
    throw new Error('协议声明只能包含 JSON 值，数值必须是安全整数');
}

function createCodec(catalogs) {
    if (!Array.isArray(catalogs)) throw new Error('协议目录必须是数组');
    const entries = new Map();
    const fingerprint = (name, variant, schema) => crypto.createHash('sha256')
        .update(canonical({ name, currentVariant: variant, currentSchema: schema }), 'utf8').digest('hex');
    for (const catalog of catalogs) {
        if (!catalog || !Array.isArray(catalog.protocols) || Object.keys(catalog).some(key => key !== 'protocols')) throw new Error('协议目录格式不正确');
        for (const source of catalog.protocols) {
            if (!source || Object.keys(source).sort().join(',') !== 'currentSchema,currentVariant,historical,name'
                || typeof source.name !== 'string' || !NAME.test(source.name) || NUMBERED.test(source.name)
                || typeof source.currentVariant !== 'string' || !NAME.test(source.currentVariant) || NUMBERED.test(source.currentVariant)
                || !source.currentSchema || Array.isArray(source.currentSchema) || typeof source.currentSchema !== 'object'
                || !Object.keys(source.currentSchema).length || !Array.isArray(source.historical) || entries.has(source.name)) throw new Error('协议名、当前结构或历史登记不正确或重复');
            const hash = fingerprint(source.name, source.currentVariant, source.currentSchema);
            const current = { tag: source.name, variant: source.currentVariant, fp: hash,
                header: JSON.stringify({ contract: source.name, schemaFingerprint: hash }),
                schema: JSON.stringify(source.currentSchema) };
            const tags = new Map([[source.name, new Map([[hash, current]])]]), history = [];
            for (const item of source.historical) {
                if (!item || !['tag,variant', 'header,tag,variant', 'header,schema,tag,variant'].includes(Object.keys(item).sort().join(','))
                    || !(typeof item.tag === 'string' && item.tag && item.tag.length <= 256 && !/\s/.test(item.tag)
                        || typeof item.tag === 'number' && Number.isSafeInteger(item.tag) && item.tag >= 0 && item.header !== undefined)
                    || typeof item.variant !== 'string' || !NAME.test(item.variant) || NUMBERED.test(item.variant)) throw new Error('历史协议登记不正确');
                const header = item.header === undefined ? { contract: item.tag } : item.header;
                canonical(header);
                if (!header || Array.isArray(header) || typeof header !== 'object'
                    || Object.values(header).filter(value => value === item.tag).length !== 1) throw new Error('历史协议头必须精确包含原标签');
                const fp = Object.hasOwn(header, 'schemaFingerprint') ? header.schemaFingerprint : null;
                if (fp !== null) {
                    if (typeof fp !== 'string' || !/^[a-f0-9]{64}$/.test(fp) || !item.schema
                        || typeof item.schema !== 'object' || Array.isArray(item.schema) || !Object.keys(item.schema).length
                        || fingerprint(source.name, item.variant, item.schema) !== fp) throw new Error('历史结构指纹必须对应原结构声明');
                } else if (Object.hasOwn(header, 'schemaFingerprint') || Object.hasOwn(item, 'schema')) throw new Error('历史结构声明缺少精确指纹');
                const group = tags.get(item.tag) || new Map();
                if (group.has(fp)) throw new Error('同一协议标签和结构指纹不能重复登记');
                const descriptor = { tag: item.tag, variant: item.variant, fp, header: JSON.stringify(header),
                    schema: item.schema ? JSON.stringify(item.schema) : null };
                group.set(fp, descriptor); tags.set(item.tag, group); history.push(descriptor);
            }
            entries.set(source.name, { current, history, tags });
        }
    }
    function entry(name) {
        if (!entries.has(name)) throw new Error(`未登记的协议族：${String(name)}`);
        return entries.get(name);
    }
    function group(raw, name) {
        const value = entry(name);
        if (!(typeof raw === 'string' || typeof raw === 'number' && Number.isSafeInteger(raw))) return null;
        return value.tags.get(raw) || null;
    }
    function select(raw, name, selectors) {
        const choices = group(raw, name);
        if (!choices) throw new Error(`无法识别 ${name} 的格式`);
        if (!selectors.length) {
            if (choices.size !== 1) throw new Error(`${name} 同一标签有多种结构，读取时必须提供原结构指纹`);
            return choices.values().next().value;
        }
        const fp = selectors[0] == null ? null : selectors[0];
        if (!choices.has(fp)) throw new Error(`${name} 未登记该标签与结构指纹的组合`);
        return choices.get(fp);
    }
    const contract = name => { entry(name); return name; };
    const isContract = (raw, name, variant, ...selectors) => {
        const choices = group(raw, name);
        if (!choices) return false;
        if (selectors.length) {
            const value = choices.get(selectors[0] == null ? null : selectors[0]);
            return !!value && (variant === undefined || value.variant === variant);
        }
        return variant === undefined || [...choices.values()].every(value => value.variant === variant);
    };
    const format = (raw, name, ...selectors) => select(raw, name, selectors).variant;
    const identityDomain = (raw, name, ...selectors) => { select(raw, name, selectors); return raw; };
    const declaredSchema = (raw, name, ...selectors) => {
        const schema = select(raw, name, selectors).schema;
        if (schema === null) throw new Error(`${name} 的原格式没有登记完整结构声明`);
        return JSON.parse(schema);
    };
    const schemaFingerprint = name => entry(name).current.fp;
    const recordHeader = (raw, name, ...selectors) => {
        // Omitting the selector for the stable name is a writer request for the
        // current header. Readers pass their actual fingerprint, even if absent.
        const descriptor = raw === name && !selectors.length ? entry(name).current : select(raw, name, selectors);
        return JSON.parse(descriptor.header);
    };
    const hasValidHeader = (value, name, tagField = 'contract') => {
        entry(name);
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof tagField !== 'string') return false;
        let header;
        try { header = recordHeader(value[tagField], name, value.schemaFingerprint); } catch { return false; }
        if (Object.entries(header).some(([key, expected]) => !Object.hasOwn(value, key) || value[key] !== expected)) return false;
        return ['contract', 'schemaFingerprint', 'version', 'schemaVersion', 'policyVersion']
            .every(key => !Object.hasOwn(value, key) || Object.hasOwn(header, key));
    };
    const isCurrentHeader = (value, name, tagField = 'contract') => hasValidHeader(value, name, tagField)
        && value[tagField] === name && value.schemaFingerprint === schemaFingerprint(name);
    const historical = (name, variant, selectors) => {
        const found = entry(name).history.filter(value => value.variant === variant
            && (!selectors.length || value.fp === (selectors[0] == null ? null : selectors[0])));
        if (found.length !== 1) throw new Error(`历史协议 ${name}/${String(variant)} 未唯一确定`);
        return found[0];
    };
    const historicalHeader = (name, variant, ...selectors) => JSON.parse(historical(name, variant, selectors).header);
    const historicalContract = (name, variant) => {
        const descriptor = historical(name, variant, []);
        if (entry(name).tags.get(descriptor.tag).size !== 1 || descriptor.fp !== null) throw new Error('有结构指纹的历史格式必须读取完整原头，不能仅取标签');
        return descriptor.tag;
    };
    const record = (name, fields = {}) => {
        if (!fields || Object.getPrototypeOf(fields) !== Object.prototype || Object.keys(fields).some(key => RESERVED.has(key))) throw new Error('新协议字段不能覆盖格式声明或带入旧版本字段');
        return { ...recordHeader(name, name), ...fields };
    };
    return Object.freeze({ contract, isContract, format, identityDomain, declaredSchema, schemaFingerprint, recordHeader,
        hasValidHeader, isCurrentHeader, historicalHeader, record, historicalContract });
}

function readCatalogs(directory = DIRECTORY) {
    if (fs.realpathSync(directory) !== directory) throw new Error('协议目录不能经过符号链接');
    return fs.readdirSync(directory).filter(name => /^[a-z][a-z0-9-]*\.json$/.test(name)).sort().map(name => {
        const filename = path.join(directory, name), stat = fs.lstatSync(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) throw new Error('协议目录要求有界普通文件');
        const bytes = fs.readFileSync(filename);
        if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('协议目录不能带 UTF-8 BOM');
        return strictJson(bytes, '协议目录');
    });
}

let shared;
function codec() { if (!shared) shared = createCodec(readCatalogs()); return shared; }
module.exports = { createCodec, canonical, readCatalogs,
    ...Object.fromEntries(['contract', 'isContract', 'format', 'identityDomain', 'declaredSchema', 'schemaFingerprint', 'recordHeader', 'hasValidHeader', 'isCurrentHeader', 'historicalHeader', 'record', 'historicalContract']
        .map(name => [name, (...args) => codec()[name](...args)])) };
