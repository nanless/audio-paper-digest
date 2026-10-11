'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const binding = require('../scripts/lib/reader-resource-binding');
const url = 'https://github.com/FernandoAze/LayerIt';
const paragraph = `We present LayerIt11\n 1\n ${url}: given a score–performance alignment, it places independently generated components onto this shared axis and merges them into a single, self-contained visualization. Each is handled as an independent layer that can be added, combined, or removed, making such composites straightforward to build and adapt. The library is open-source and composes the figure in Python.`;

test('同段作者同名软件的明确开源句恢复逐字引文且只确认代码资源', () => {
    assert.deepEqual(binding.paperSourceResourceFacets(paragraph, url), ['code']);
    assert.equal(binding.paperSourceResourceQuote(paragraph, url), paragraph);
    assert.equal(binding.paperSourceQuoteBindsOriginalUrl({
        type: 'code', originalUrl: url, sourceQuote: paragraph
    }), true);
    assert.deepEqual(binding.extractPaperSourceRepositoryCandidates(paragraph).map(item => item.type), ['code']);
});

test('跨段、其他软件、否定计划、多链接及第三方声明不恢复作者代码', () => {
    const invalidSources = [
        paragraph.replace('. The library', '.\n\nThe library'),
        paragraph.replace('We present LayerIt11', 'We present OtherLib11'),
        paragraph.replace('The library is open-source', 'The library will be open-source'),
        paragraph.replace('The library is open-source', 'The library is not open-source'),
        paragraph.replace('The library is open-source', 'OtherLib is open-source'),
        paragraph.replace('Each is handled as an independent layer that can be added, combined, or removed, making such composites straightforward to build and adapt.', 'Each is handled by ExternalLib, a library for exporting graphs.'),
        paragraph.replace('Each is handled as an independent layer that can be added, combined, or removed, making such composites straightforward to build and adapt.', 'ExternalLib is a library for exporting graphs.'),
        paragraph.replace('. The library', `. See https://github.com/Other/Other. The library`),
        paragraph.replace('We present', 'We use'),
        paragraph.replace('given a score', 'given a baseline score'),
        `We present LayerIt11\n 1\n ${url}: given ExternalLib, a library for exporting graphs. The library is open-source.`,
        paragraph.replace('The library is open-source', 'The library is useful'),
        paragraph.replace('11\n 1\n ', '11\n\n 1\n '),
    ];
    for (const source of invalidSources) {
        assert.deepEqual(binding.paperSourceResourceFacets(source, url), ['third_party'], source);
    }
});
