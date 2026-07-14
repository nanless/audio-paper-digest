const crypto = require('crypto');

/**
 * 筛选决定绑定的最小输入契约。
 *
 * 字段及序列化顺序属于持久化格式的一部分：filter-decisions.json 会保存
 * 此函数产生的 SHA-256，生成、断点复用与数据校验必须共同调用本实现。
 */
function buildFilterInputSha256(paper) {
    const categories = Array.isArray(paper?.categories)
        ? [...paper.categories].map(String).sort()
        : String(paper?.categories || paper?.category || '');
    const input = {
        title: String(paper?.title || '').trim(),
        abstract: String(paper?.abstract || paper?.summary || '').trim(),
        categories
    };
    return crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

module.exports = { buildFilterInputSha256 };
