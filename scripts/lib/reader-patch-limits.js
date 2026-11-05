'use strict';

// 人工/受控 Reader 修正每篇最多 8 个已有节点；这不是模型请求或全文额度。
const MAX_READER_PATCH_NODES = 8;
const MIN_READER_PATCH_NODES = 1;

module.exports = { MAX_READER_PATCH_NODES, MIN_READER_PATCH_NODES };
