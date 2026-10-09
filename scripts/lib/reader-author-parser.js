'use strict';

const crypto = require('node:crypto');
const cheerio = require('cheerio');
const API_READER_AUTHOR_IDENTITY_CONTRACT = 'api-reader-author-identity-v1';
const recoverySha256 = value => /^[a-f0-9]{64}$/.test(String(value || ''));
const stableFingerprint = value => sha256(JSON.stringify(canonical(value)));
const MAX_AUTHOR_SOURCE_HTML_BYTES = 8 * 1024 * 1024;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');


function normalizeReaderIdentityText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function readerIdentityKey(value) {
    return normalizeReaderIdentityText(value).normalize('NFKC').toLocaleLowerCase();
}

function readerIdentityTokens(value) {
    return readerIdentityKey(value).split(/\s+/).filter(Boolean);
}

function isLikelyAuthorEnumeration(value) {
    const text = normalizeReaderIdentityText(value);
    if (!/(?:\band\b|&)/i.test(text)
        || /\b(?:university|institute|institution|school|college|department|laborator(?:y|ies)|centre|center|hospital|academy|research|corporation|company|inc\.?|ltd\.?|gmbh|ai)\b/i.test(text)) {
        return false;
    }
    const parts = text.split(/\s*,\s*|\s+and\s+|\s*&\s*/i)
        .map(part => part.replace(/^and\s+/i, '').trim()).filter(Boolean);
    const nameLike = parts.filter(part => {
        const tokens = part.split(/\s+/).filter(Boolean);
        return tokens.length >= 2 && tokens.length <= 5
            && tokens.every(token => /^[\p{L}][\p{L}'’.-]*$/u.test(token));
    });
    return nameLike.length >= 2 && nameLike.length === parts.length;
}

function countKnownAuthorNames(value, authorNames) {
    const haystack = ` ${readerIdentityKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    return [...new Set((authorNames || []).map(readerIdentityKey).filter(Boolean))]
        .filter(name => {
            const needle = ` ${name.replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
            return needle.trim().split(/\s+/).length >= 2 && haystack.includes(needle);
        }).length;
}

function isReaderResourceAffiliationLabel(value) {
    const text = normalizeReaderIdentityText(value)
        .replace(/^(?:affiliation|institution)\s*[:：]?\s*/i, '');
    // 项目 URL 被删掉之后，可能留下一段看着挺像样的非空标签。这些显式资源标签不是机构
    // 证据。
    return /^(?:project\s+(?:page|website|webpage)|(?:code|demo|dataset)(?:\s+(?:page|website|url|link))?)(?:\s*[:：]\s*.*|\s*)$/i.test(text);
}

function sanitizeReaderAffiliationValue(value, authorNames = []) {
    const text = normalizeReaderIdentityText(value)
        .replace(/^(?:affiliation|institution)\s*[:：]?\s*/i, '');
    const normalizedText = readerIdentityKey(text).replace(/[,:;]+$/g, '').trim();
    const isExactKnownAuthorName = (authorNames || []).some(name => (
        normalizedText.length > 0
        && normalizedText === readerIdentityKey(name).replace(/[,:;]+$/g, '').trim()
    ));
    if (text.length < 3
        || isReaderResourceAffiliationLabel(text)
        || /https?:\/\/|www\./i.test(text)
        || /@/.test(text)
        || /,\s*,/.test(text)
        || isExactKnownAuthorName
        || countKnownAuthorNames(text, authorNames) >= 2
        || isLikelyAuthorEnumeration(text)) {
        return '';
    }
    return text;
}

function cleanReaderAffiliationNode($, node, authorNames = []) {
    const affiliation = $(node).clone();
    affiliation.find([
        '.ltx_contact_name', '.ltx_contact_email', '.ltx_role_email',
        '.ltx_note_mark', '.ltx_note', '.ltx_tag', 'sup',
        'a.ltx_url', 'a[href^="http://"]', 'a[href^="https://"]'
    ].join(', ')).remove();
    return sanitizeReaderAffiliationValue(affiliation.text(), authorNames);
}

function cleanReaderAuthorNameNode($, node) {
    const name = $(node).clone();
    name.find('.ltx_note_mark, .ltx_note, .ltx_tag, sup').remove();
    return normalizeReaderIdentityText(name.text())
        .replace(/\d*\s*(?:\\?footnotemark|footnotemark)\s*:?[\s\d]*.*$/i, '')
        .trim();
}

function parseReaderThanksAffiliations($) {
    const mappings = new Map();
    const sourceNodes = [];
    $('.ltx_title_document .ltx_pubnote.ltx_role_thanks').toArray().forEach(node => {
        sourceNodes.push($.html(node));
        const note = $(node).clone();
        note.find('.ltx_note_name, .ltx_note_mark, .ltx_note, .ltx_tag, sup').remove();
        const text = normalizeReaderIdentityText(note.text())
            .replace(/\s*\((?:e-?mail|email)\s*:[\s\S]*$/i, '')
            .replace(/[.;]\s*$/, '')
            .trim();
        const match = text.match(/^(.+?)\s+(is also with|is with|are with)\s+(.+)$/i);
        if (!match) return;
        const names = match[1].split(/\s*,\s*|\s+and\s+/i)
            .map(name => name.replace(/^and\s+/i, '').trim()).filter(Boolean);
        const affiliation = sanitizeReaderAffiliationValue(match[3], names);
        if (!affiliation || names.length === 0
            || names.some(name => readerIdentityTokens(name).length < 2)) return;
        for (const name of names) {
            const key = readerIdentityKey(name);
            const current = mappings.get(key) || { name, affiliations: [] };
            if (!current.affiliations.includes(affiliation)) current.affiliations.push(affiliation);
            mappings.set(key, current);
        }
    });
    return { mappings, sourceNodes };
}

function parseReaderAuthorTable($) {
    // 有些会议模板把作者块放进普通的导言区表格，既没有 ltx_authors 也没有引文元数据。
    // 只有明确的上标关联才算数；绝不按行序推断关联。
    const tables = [];
    let reachedSection = false;
    $('table, section, .ltx_section').each((_, node) => {
        if ($(node).is('section, .ltx_section')) reachedSection = true;
        else if (!reachedSection && !$(node).parents('table, .ltx_figure, .ltx_table').length) {
            tables.push(node);
        }
    });
    const candidates = [];
    for (const table of tables) {
        const rows = $(table).find('tr').toArray();
        if (rows.length < 2 || rows.length > 101
            || rows.some(row => $(row).children('td, th').length !== 1)) continue;
        const markedCellText = row => {
            const cell = $(row).children('td, th').first().clone();
            let valid = true;
            cell.find('sup').each((_, marker) => {
                const label = normalizeReaderIdentityText($(marker).text()).replace(/\s+/g, '');
                if (!/^[1-9]\d{0,2}(?:,[1-9]\d{0,2})*$/.test(label)) valid = false;
                $(marker).replaceWith(`[[AUTHOR_AFF:${label}]]`);
            });
            return valid ? normalizeReaderIdentityText(cell.text()) : '';
        };
        const nameText = markedCellText(rows[0]);
        const nameMatches = [...nameText.matchAll(/([^\[\]]+)\[\[AUTHOR_AFF:([\d,]+)\]\]/g)];
        if (!nameMatches.length || nameMatches.length > 100
            || nameMatches.map(match => match[0]).join('') !== nameText) continue;
        const entries = nameMatches.map(match => ({
            name: normalizeReaderIdentityText(match[1]).replace(/^(?:[,;]\s*|(?:and|&)\s+)/i, ''),
            labels: match[2].split(',')
        }));
        const names = entries.map(entry => entry.name);
        const isName = name => /^[\u3400-\u9fff]{2,8}$/.test(name)
            || /^(?:[\p{Lu}\p{Lt}][\p{L}’'.-]*\s+){1,7}[\p{Lu}\p{Lt}][\p{L}’'.-]*$/u.test(name);
        if (names.some(name => !isName(name))
            || new Set(names.map(readerIdentityKey)).size !== names.length) continue;
        const affiliations = new Map();
        let valid = true;
        for (const row of rows.slice(1)) {
            const match = markedCellText(row).match(/^\[\[AUTHOR_AFF:([1-9]\d{0,2})\]\]\s*([^\[\]]+)$/);
            const affiliation = match ? sanitizeReaderAffiliationValue(match[2], names) : '';
            if (!match || !affiliation || affiliations.has(match[1])) {
                valid = false;
                break;
            }
            affiliations.set(match[1], affiliation);
        }
        if (!valid || entries.some(entry => entry.labels.some(label => !affiliations.has(label)))) continue;
        candidates.push({
            authors: entries.map(entry => ({
                name: entry.name,
                affiliations: [...new Set(entry.labels.map(label => affiliations.get(label)))]
            })),
            sourceDomSha256: crypto.createHash('sha256').update($.html(table)).digest('hex')
        });
    }
    return candidates.length === 1 ? candidates[0] : null;
}

function parseArxivReaderAuthors($) {
    const wrapper = $('.ltx_authors').first();
    const cleanName = value => normalizeReaderIdentityText(value)
        .replace(/\d*\s*(?:\\?footnotemark|footnotemark)\s*:?[\s\d]*.*$/i, '')
        .trim();
    const metaAuthors = $('meta[name="citation_author"]').toArray()
        .map(node => cleanName($(node).attr('content'))).filter(Boolean);
    const thanksAffiliations = parseReaderThanksAffiliations($);
    const domAuthorNames = wrapper.length
        ? wrapper.find('.ltx_creator.ltx_role_author .ltx_personname').toArray()
            .map(node => cleanReaderAuthorNameNode($, node)).filter(Boolean)
        : [];
    const knownAuthorNames = [...metaAuthors, ...domAuthorNames,
        ...[...thanksAffiliations.mappings.values()].map(item => item.name)];
    const metadataGroups = [];
    $('meta[name="citation_author"], meta[name="citation_author_institution"]').each((_, node) => {
        if ($(node).attr('name') === 'citation_author') {
            metadataGroups.push({ name: cleanName($(node).attr('content')), affiliations: [] });
        } else if (metadataGroups.length > 0) {
            const affiliation = sanitizeReaderAffiliationValue($(node).attr('content'), knownAuthorNames);
            if (affiliation) metadataGroups.at(-1).affiliations.push(affiliation);
        }
    });
    // 多个姓名集中在前、机构集中在后时，元数据没有明确给出逐人对应关系。
    const unpairedMetadata = metadataGroups.length > 1
        && metadataGroups.slice(0, -1).every(group => group.affiliations.length === 0);
    const metadataAffiliationsForName = name => unpairedMetadata ? []
        : [...new Set(metadataGroups.filter(group => readerIdentityKey(group.name) === readerIdentityKey(name))
            .flatMap(group => group.affiliations))];
    const globalAffiliations = (wrapper.length
        ? wrapper.find('.ltx_role_affiliation, .ltx_affiliation').toArray()
            .filter(node => $(node).closest('.ltx_creator.ltx_role_author').length === 0)
        : []).map(node => cleanReaderAffiliationNode($, node, knownAuthorNames))
        .filter(Boolean);
    const dedupedGlobalAffiliations = [...new Set(globalAffiliations)];
    const authorElements = wrapper.length
        ? wrapper.find('.ltx_creator.ltx_role_author').toArray()
        : [];
    let authors = authorElements.map(element => {
        const creator = $(element);
        const nameNode = creator.find('.ltx_personname').first();
        const name = cleanReaderAuthorNameNode($, nameNode);
        const affiliationNodes = creator.find('.ltx_contact.ltx_role_affiliation').toArray();
        const rejectedResourceLabel = affiliationNodes.some(node => isReaderResourceAffiliationLabel($(node).text()));
        const affiliations = affiliationNodes
            .map(node => cleanReaderAffiliationNode($, node, knownAuthorNames))
            .filter(Boolean);
        const thanks = thanksAffiliations.mappings.get(readerIdentityKey(name));
        const metadataAffiliations = metadataAffiliationsForName(name);
        const fallbackAffiliations = rejectedResourceLabel ? [] : metadataAffiliations.length > 0
            ? metadataAffiliations
            : (dedupedGlobalAffiliations.length === 1 ? dedupedGlobalAffiliations : []);
        return {
            name,
            affiliations: [...new Set(thanks?.affiliations?.length > 0
                ? thanks.affiliations
                : (affiliations.length > 0 ? affiliations : fallbackAffiliations))]
        };
    }).filter(item => item.name);
    if (authors.length === 0 && metaAuthors.length > 0) {
        authors = metaAuthors.map(name => ({
            name,
            affiliations: metadataAffiliationsForName(name)
        }));
    }
    const existingNames = new Set(authors.map(item => readerIdentityKey(item.name)));
    for (const [key, item] of thanksAffiliations.mappings) {
        if (!existingNames.has(key)) {
            authors.push({ name: item.name, affiliations: [...item.affiliations] });
            existingNames.add(key);
        }
    }
    if (authors.length === 0) {
        const tableAuthors = parseReaderAuthorTable($);
        if (tableAuthors) return tableAuthors;
    }
    authors = authors.map(item => ({
        name: item.name,
        affiliations: item.affiliations.length > 0
            ? item.affiliations
            : ['机构信息未在 arXiv HTML 中可靠披露']
    }));
    const sourceNodes = wrapper.length
        ? [$.html(wrapper), ...thanksAffiliations.sourceNodes].filter(Boolean).join('\n')
        : $('meta[name="citation_author"], meta[name="citation_author_institution"]')
            .toArray().map(node => $.html(node)).join('\n');
    return {
        authors,
        sourceDomSha256: sourceNodes
            ? crypto.createHash('sha256').update(sourceNodes).digest('hex')
            : ''
    };
}

function normalizeReaderMetadataDisplayName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim()
        // 元数据里可能留着本该是 Unicode 拉丁重音字符外面的 TeX 分组（Ga{ë}l）。只去掉
        // 这种纯展示用的花括号，身份仍绑定原始元数据和 DOM SHA。
        .replace(/(?<=[A-Za-z])\{([\u00c0-\u024f])\}(?=[A-Za-z])/gu, '$1');
}


function resolveApiReaderAuthors(paper, sourceDetails) {
    const parsed = sourceDetails?.readerAuthors;
    const normalizeName = normalizeReaderMetadataDisplayName;
    const rawAuthors = Array.isArray(paper?.authors) ? paper.authors : [];
    let names = rawAuthors.map(author => (
        typeof author === 'string' ? author : author?.name
    )).map(normalizeName).filter(Boolean);
    const unavailableAffiliation = sourceDetails?.source === 'conference_pdf_text'
        ? '机构信息未能从会议 PDF 纯文本可靠映射'
        : sourceDetails?.analysisSource === 'pdf' || sourceDetails?.source === 'pdf'
            ? '机构信息未能从 arXiv PDF 文本可靠映射'
            : '机构信息未在 arXiv HTML 中可靠披露';
    if (parsed && Array.isArray(parsed.authors) && parsed.authors.length > 0
        && recoverySha256(parsed.sourceDomSha256)) {
        if (names.length === 0) names = parsed.authors.map(author => normalizeName(author?.name)).filter(Boolean);
        const knownAuthorNames = [...names, ...parsed.authors.map(author => author?.name)];
        const normalizedParsed = parsed.authors.map(author => ({
            name: normalizeName(author?.name),
            affiliations: Array.isArray(author?.affiliations)
                ? author.affiliations
                    .map(value => sanitizeReaderAffiliationValue(value, knownAuthorNames))
                    .filter(Boolean)
                : []
        })).filter(author => author.name);
        const authors = names.map(name => {
            const matches = normalizedParsed.filter(author => readerIdentityKey(author.name) === readerIdentityKey(name));
            const nameCount = names.filter(value => readerIdentityKey(value) === readerIdentityKey(name)).length;
            // 同名没有稳定作者标识，不能把首人的机构借给另一人，也不能凭顺序猜对应。
            const matched = matches.length === 1 && nameCount === 1 ? matches[0] : null;
            return {
                name,
                affiliations: matched?.affiliations?.length > 0
                    ? matched.affiliations
                    : [unavailableAffiliation]
            };
        });
        return bindApiReaderAuthorIdentity(paper, sourceDetails, {
            authors, sourceDomSha256: parsed.sourceDomSha256
        });
    }
    const sourceSha256 = crypto.createHash('sha256')
        .update(String(sourceDetails?.text || '')).digest('hex');
    return bindApiReaderAuthorIdentity(paper, sourceDetails, {
        authors: names.map(name => ({
            name,
            affiliations: [unavailableAffiliation]
        })),
        sourceDomSha256: sourceSha256
    });
}

function bindApiReaderAuthorIdentity(paper, sourceDetails, resolved) {
    const sourceTextSha256 = crypto.createHash('sha256')
        .update(String(sourceDetails?.text || '')).digest('hex');
    const metadataAuthors = Array.isArray(paper?.authors) ? paper.authors : [];
    const metadataSha256 = stableFingerprint(metadataAuthors);
    const parsedAuthors = Array.isArray(sourceDetails?.readerAuthors?.authors)
        ? sourceDetails.readerAuthors.authors : [];
    const sourceDomSha256 = sourceDetails?.readerAuthors?.sourceDomSha256;
    const isConferencePdf = sourceDetails?.source === 'conference_pdf_text';
    if (isConferencePdf && sourceDetails?.readerAuthors) {
        const evidence = sourceDetails.readerAuthors;
        if (evidence.sourceTextSha256 !== sourceTextSha256
            || typeof evidence.sourceEvidence !== 'string'
            || evidence.sourceEvidenceSha256 !== crypto.createHash('sha256')
                .update(evidence.sourceEvidence).digest('hex')
            || !String(sourceDetails.text || '').includes(evidence.sourceEvidence)) {
            throw new Error('会议 PDF 的作者证据与全文哈希不一致，或者引文缺失、格式无效、哈希不一致或没有完整出现在已保存全文中。');
        }
    }
    const isUnavailable = value => /^机构信息未/.test(String(value || ''));
    const authors = (resolved?.authors || []).map(author => {
        const matches = parsedAuthors.filter(item => readerIdentityKey(item?.name) === readerIdentityKey(author?.name));
        const sameNamed = (resolved?.authors || []).filter(item => readerIdentityKey(item?.name) === readerIdentityKey(author?.name));
        const metadataMatches = metadataAuthors.filter(item => readerIdentityKey(normalizeReaderMetadataDisplayName(
            typeof item === 'string' ? item : item?.name
        )) === readerIdentityKey(author?.name));
        const parsed = matches.length === 1 && sameNamed.length === 1
            && metadataMatches.length <= 1 ? matches[0] : null;
        const nameBinding = parsed && recoverySha256(sourceDomSha256)
            ? {
                sourceKind: isConferencePdf ? 'pdf_text' : 'html_dom',
                // 来源 DOM 中的作者姓名可能全部大写，而元数据和读者文章使用正常大小写。
                // 此处保存读者文章中的姓名，同时保留来源 DOM 的 SHA，以便核对同一作者。
                sourceValue: author.name,
                sourceDomSha256
            }
            : { sourceKind: 'paper_metadata', sourceValue: author.name, metadataSha256 };
        const affiliationBindings = (author.affiliations || []).map(affiliation => {
            if (isUnavailable(affiliation)) {
                return {
                    sourceKind: 'explicit_unavailable', sourceValue: affiliation,
                    sourceTextSha256
                };
            }
            const direct = parsed?.affiliations?.find(value => (
                readerIdentityKey(value) === readerIdentityKey(affiliation)
            ));
            if (!direct || !recoverySha256(sourceDomSha256)) {
                throw new Error(`作者 ${author.name} 的机构“${affiliation}”缺少对应的来源机构记录，或来源内容 SHA 格式无效。`);
            }
            return {
                sourceKind: isConferencePdf ? 'pdf_text' : 'html_dom',
                association: 'direct_author',
                sourceValue: direct,
                sourceDomSha256
            };
        });
        return { name: author.name, affiliations: author.affiliations, nameBinding, affiliationBindings };
    });
    const identity = {
        contract: API_READER_AUTHOR_IDENTITY_CONTRACT,
        sourceDomSha256: recoverySha256(sourceDomSha256) ? sourceDomSha256 : '',
        sourceTextSha256,
        metadataSha256,
        authors
    };
    return {
        authors: authors.map(item => ({ name: item.name, affiliations: item.affiliations })),
        sourceDomSha256: resolved?.sourceDomSha256 || sourceTextSha256,
        identity,
        identitySha256: stableFingerprint(identity)
    };
}

const CONFERENCE_PDF_AFFILIATION_HINT = /(?:univ(?:ersity)?|institute|research|school|college|department|laboratory|laborator(?:y|ies)|key laboratory|academy|centre|center|adobe|northwestern|xian|xi['’]an|france|china|usa|san francisco|evanston|lannion|vannes|lemans)/i;

function normalizeConferencePdfAuthorName(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/c¸/g, 'ç').replace(/C¸/g, 'Ç')
        .replace(/c´ı/g, 'cí').replace(/C´ı/g, 'Cí');
}

function validConferencePdfAuthorName(value) {
    const name = normalizeConferencePdfAuthorName(value);
    const tokens = name.split(/\s+/).filter(Boolean);
    return tokens.length >= 2 && tokens.length <= 8
        && tokens.every(token => /^[\p{L}\p{M}][\p{L}\p{M}'’.'-]*$/u.test(token));
}

function normalizeConferencePdfAffiliation(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
        .replace(/\s*(?:[|｜]|DOI\s*:).+$/i, '')
        // PDF 那一行在分栏处没有空白时，PyMuPDF 会把 DOI 直接接在
        // 机构名最后一个 token 后面。
        .replace(/\s*10\.\d{4,9}\/[\-._;()/:A-Z0-9]+$/i, '')
        .replace(/[.;,]+$/, '').trim();
}

/**
 * 只从保留下来的会议 PDF 里恢复肉眼可见的那块作者信息。
 * 它有意比通用的姓名 NER 收得更窄：作者行必须带上与相邻机构行
 * 相同的那套上标标记。返回的证据在交给 Reader 之前，会连同完整
 * 来源文本 SHA 和 preamble 的精确 SHA 一起绑定。
 */
function parseConferencePdfAuthors(text) {
    const sourceText = String(text || '');
    const abstractIndex = sourceText.search(/\n\s*ABSTRACT\b/i);
    const preamble = abstractIndex >= 0 ? sourceText.slice(0, abstractIndex) : sourceText.slice(0, 12000);
    const rawLines = preamble.split(/\n/);
    const lines = rawLines.map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const symbolAuthors = [];
    const numericAuthors = [];
    for (const line of lines) {
        if (CONFERENCE_PDF_AFFILIATION_HINT.test(line) || /@|DOI\s*:/i.test(line)) continue;
        const symbolMatches = [...line.matchAll(/([^,]+?)([†‡∗⋆*](?:\s*,\s*[†‡∗⋆*])*)(?=\s*,|\s*$)/gu)]
            .map(match => ({ name: normalizeConferencePdfAuthorName(match[1]), markers: [...match[2].matchAll(/[†‡∗⋆*]/gu)].map(marker => marker[0]) }))
            .filter(item => validConferencePdfAuthorName(item.name));
        const numericMatches = [...line.matchAll(/([^,\d]+?)(\d{1,3}(?:,\d{1,3})*)(?=\s*(?:,|$))/gu)]
            .map(match => ({ name: normalizeConferencePdfAuthorName(match[1]), markers: match[2].split(',') }))
            .filter(item => validConferencePdfAuthorName(item.name));
        if (symbolMatches.length) symbolAuthors.push(...symbolMatches);
        else if (numericMatches.length) numericAuthors.push(...numericMatches);
    }
    const authors = symbolAuthors.length ? symbolAuthors : numericAuthors;
    if (!authors.length) return null;
    const markerSet = new Set(authors.flatMap(item => item.markers));
    const affiliations = new Map();
    for (const line of lines) {
        if (!CONFERENCE_PDF_AFFILIATION_HINT.test(line)) continue;
        for (const match of line.matchAll(/([†‡∗⋆*])\s*([^†‡∗⋆*]+?)(?=[†‡∗⋆*]|$)/gu)) {
            const value = normalizeConferencePdfAffiliation(match[2]);
            if (markerSet.has(match[1]) && value && !/@|DOI\s*:/i.test(value)) affiliations.set(match[1], value);
        }
        for (const match of line.matchAll(/(?:^|\s)([1-9]\d{0,2})\s+(.+?)(?=\s+[1-9]\d{0,2}\s+|$)/gu)) {
            const value = normalizeConferencePdfAffiliation(match[2]);
            if (markerSet.has(match[1]) && value && !/@|DOI\s*:/i.test(value)) affiliations.set(match[1], value);
        }
    }
    const normalizedAuthors = authors.map(author => ({
        name: author.name,
        affiliations: [...new Set(author.markers.map(marker => affiliations.get(marker)).filter(Boolean))]
    }));
    const evidence = preamble.trim();
    const sourceTextSha256 = sha256(Buffer.from(sourceText, 'utf8'));
    return {
        contract: 'conference-pdf-author-evidence-v1',
        authors: normalizedAuthors,
        sourceTextSha256,
        sourceEvidence: evidence,
        sourceEvidenceSha256: sha256(Buffer.from(evidence, 'utf8')),
        sourceDomSha256: sha256(Buffer.from(evidence, 'utf8'))
    };
}

// 原 HTML 仅供本地身份重放，不是模型证据或图片缓存。
function canRetainAuthorSourceHtml(html) {
    if (typeof html !== 'string' || !html || Buffer.byteLength(html, 'utf8') > MAX_AUTHOR_SOURCE_HTML_BYTES
        || !/<html\b[^>]*>[\s\S]*<\/html\s*>/iu.test(html)
        || /data\s*:\s*image\/|<svg\b|<canvas\b/iu.test(html)) return false;
    const $ = cheerio.load(html);
    return !$('*').toArray().some(node => (
        Object.values(node.attribs || {}).some(value => /data\s*:\s*image\/|<svg\b|<canvas\b/iu.test(value))
    ));
}

function retainAuthorSourceHtml(parsed, html) {
    return canRetainAuthorSourceHtml(html) ? { ...parsed, sourceHtml: html } : parsed;
}

function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function replayHtmlReaderAuthors(details) {
    const html = details?.readerAuthors?.sourceHtml;
    const artifacts = details?.structuredArtifacts;
    if (details?.source !== 'html' || typeof details.text !== 'string'
        || !canRetainAuthorSourceHtml(html) || !artifacts || typeof artifacts !== 'object') return null;
    const { payloadSha256, ...body } = artifacts;
    if (sha256(html) !== artifacts.sourceHtmlSha256
        || sha256(details.text) !== artifacts.flattenedTextSha256
        || ![sha256(JSON.stringify(body)), sha256(JSON.stringify(canonical(body)))].includes(payloadSha256)) return null;
    return parseArxivReaderAuthors(cheerio.load(html));
}

function verifiedReaderAuthorDetails(details) {
    const readerAuthors = details?.source === 'conference_pdf_text'
        ? parseConferencePdfAuthors(details.text) : replayHtmlReaderAuthors(details);
    return { ...details, readerAuthors: readerAuthors || null };
}

function resolveVerifiedReaderAuthors(paper, details) {
    return resolveApiReaderAuthors(paper, verifiedReaderAuthorDetails(details));
}

const EXPLICIT_UNAVAILABLE_AFFILIATIONS = new Set([
    '机构信息未在 arXiv HTML 中可靠披露',
    '机构信息未能从 arXiv PDF 文本可靠映射',
    '机构信息未能从会议 PDF 纯文本可靠映射',
    '机构信息未在会议 PDF 中可靠披露',
    '机构信息未可靠披露'
]);

function readerAuthorUnavailableIdentityMatches(paper, { sourceSha256, metadataAuthors } = {}) {
    const saved = paper?.apiReaderAuthors;
    const identity = saved?.identity;
    const stage = paper?.analysisManifest?.stages?.apiReaderArticle;
    if (!recoverySha256(sourceSha256) || paper?.sourceSha256 !== sourceSha256
        || paper?.analysisManifest?.sourceAcquisition?.sourceSha256 !== sourceSha256
        || !Array.isArray(metadataAuthors) || !metadataAuthors.length
        || metadataAuthors.some(name => typeof name !== 'string' || !name.trim() || name !== name.trim())
        || JSON.stringify(paper.authors) !== JSON.stringify(metadataAuthors)
        || identity?.contract !== API_READER_AUTHOR_IDENTITY_CONTRACT
        || identity.sourceTextSha256 !== sourceSha256
        || identity.metadataSha256 !== stableFingerprint(metadataAuthors)
        || saved.identitySha256 !== stableFingerprint(identity)
        || stage?.readerAuthorIdentitySha256 !== saved.identitySha256
        || stage.readerAuthorsSha256 !== stableFingerprint(saved)
        || !Array.isArray(saved.authors) || saved.authors.length !== metadataAuthors.length
        || !Array.isArray(identity.authors) || identity.authors.length !== metadataAuthors.length) return false;
    const displayNames = metadataAuthors.map(normalizeReaderMetadataDisplayName);
    return saved.authors.every((author, index) => {
        const bound = identity.authors[index];
        return author?.name === displayNames[index] && bound?.name === displayNames[index]
            && JSON.stringify(author.affiliations) === JSON.stringify(bound.affiliations)
            && bound.nameBinding?.sourceKind === 'paper_metadata'
            && bound.nameBinding.sourceValue === displayNames[index]
            && bound.nameBinding.metadataSha256 === identity.metadataSha256
            && Array.isArray(author.affiliations) && author.affiliations.length > 0
            && Array.isArray(bound.affiliationBindings) && bound.affiliationBindings.length === author.affiliations.length
            && author.affiliations.every((value, offset) => typeof value === 'string' && EXPLICIT_UNAVAILABLE_AFFILIATIONS.has(value)
                && bound.affiliationBindings[offset]?.sourceKind === 'explicit_unavailable'
                && bound.affiliationBindings[offset].sourceValue === value
                && bound.affiliationBindings[offset].sourceTextSha256 === sourceSha256);
    });
}

function readerAuthorIdentityMatchesSource(paper, details) {
    if (!paper?.apiReaderAuthors) return false;
    if (typeof details?.text !== 'string' || sha256(details.text) !== paper.sourceSha256
        || paper.analysisManifest?.sourceAcquisition?.sourceSha256 !== paper.sourceSha256) return false;
    const stage = paper.analysisManifest?.stages?.apiReaderArticle;
    const artifacts = details.structuredArtifacts;
    if (stage?.structuredArtifactsSha256 !== artifacts?.payloadSha256
        || (paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256
            && paper.analysisManifest.sourceAcquisition.structuredArtifactsSha256 !== artifacts?.payloadSha256)) return false;
    const expected = resolveVerifiedReaderAuthors(paper, details);
    const saved = paper.apiReaderAuthors;
    if (saved.identitySha256 !== stableFingerprint(saved.identity)
        || stage?.readerAuthorIdentitySha256 !== saved.identitySha256
        || stage.readerAuthorsSha256 !== stableFingerprint(saved)) return false;
    if (stableFingerprint(saved) === stableFingerprint(expected)) return true;
    // 旧明确不可得提示语可以不同，但姓名全集、逐项绑定及封存 SHA 必须闭合。
    return saved.identity?.metadataSha256 === expected.identity.metadataSha256
        && readerAuthorUnavailableIdentityMatches(paper, {
            sourceSha256: paper.sourceSha256, metadataAuthors: paper.authors
        });
}

module.exports = {
    normalizeReaderIdentityText, readerIdentityKey, readerIdentityTokens,
    sanitizeReaderAffiliationValue, isReaderResourceAffiliationLabel, parseArxivReaderAuthors,
    resolveApiReaderAuthors, bindApiReaderAuthorIdentity, parseConferencePdfAuthors,
    verifiedReaderAuthorDetails, resolveVerifiedReaderAuthors, readerAuthorIdentityMatchesSource, readerAuthorUnavailableIdentityMatches,
    MAX_AUTHOR_SOURCE_HTML_BYTES, canRetainAuthorSourceHtml, retainAuthorSourceHtml, replayHtmlReaderAuthors
};
