'use strict';

// 只识别账目格式。已保存的事件不改写，调用方继续核验原文件 SHA 和事件身份。
const formats = require('./protocol-codec');
const EVENT_CONTRACT = 'llm-usage';

function usageEventHeader() {
    return formats.recordHeader(EVENT_CONTRACT, EVENT_CONTRACT);
}

function isUsageEventFormat(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const current = Object.hasOwn(event, 'contract');
    return formats.hasValidHeader(event, EVENT_CONTRACT, current ? 'contract' : 'version');
}

module.exports = { EVENT_CONTRACT, usageEventHeader, isUsageEventFormat };
