'use strict';
// Adapters prepare their own source fields; this layer neither normalizes input
// nor changes each workflow's saved prompt hash or legacy rendering contract.
function renderFilterPrompt(fields, promptPath) {
    return require('../utils.js').loadPrompt(promptPath, {
        title: fields.title, abstract: fields.abstract, categories: fields.categories
    });
}
module.exports = { renderFilterPrompt };
