"""Literal author-release footnotes from authenticated PDF bytes; no URL fetching."""
if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('reader-authenticated-pdf-footnote-evidence')

import base64
import hashlib
import json
import os
import re
import stat
import sys
import fitz

CONTRACT = 'reader-authenticated-pdf-footnote-extraction-v1'
REPOSITORY = re.compile(r'https://(?:github\.com|gitlab\.com|huggingface\.co|modelscope\.cn)/[A-Za-z0-9._~-]+/[A-Za-z0-9._~/-]+')
UNRELEASED = re.compile(r"\b(?:not|never|no longer|will|would|plans?|planned|intends?|soon|forthcoming|private|unreleased|cannot|can.t|unable|upon acceptance|upon publication)\b", re.I)
EXTERNAL = re.compile(r'\b(?:third.party|baseline|prior work|previous work|other authors?|another author|their|according to|quoted?|quotation|claims?|states?|stated|reports?|reported|says?|said|writes?|wrote|documentation|announcement)\b|et\s+al\b', re.I)
RELEASE = re.compile(r'\b(?:is|are)\s+(?:now\s+)?(?:publicly\s+)?(?:available|released|open[- ]sourced?)(?:\s+(?:as\s+open\s+source|to\s+the\s+community|at))?\s*[.!]?\s*$', re.I)
RESOURCE = re.compile(r'\b(?:codes?|implementation|software|scripts?|datasets?|data|corpus|corpora|benchmarks?|models?|weights?|checkpoints?|audio samples?|demo(?:nstration)?(?: website)?|training recipes|evaluation protocols|prompts?)\b', re.I)


def need(condition, reason):
    if not condition:
        raise ValueError(reason)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def stable(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def normalized(value):
    # Restore a word split by PDF line wrapping; the raw fragment remains saved.
    value = re.sub(r'(?<=[A-Za-z])[-‐]\n(?=[A-Za-z])', '', value)
    return re.sub(r'\s+', ' ', value).strip()


def facets_for(statement, before='', after=''):
    """A release predicate governs only the enumerated resource subject."""
    value = normalized(statement)
    match = RELEASE.search(value)
    if not match or UNRELEASED.search(value) or EXTERNAL.search(value) or re.search(r'["“”‘’]|(?:^|\s)[\'>]', value):
        return [], 'not_current_author_release'
    subject = value[:match.start()].strip(' ,;:')
    # A preceding purpose/method clause is not another released resource.
    if ',' in subject:
        pieces = subject.split(',')
        if not RESOURCE.search(pieces[0]):
            subject = ','.join(pieces[1:]).strip()
    subject = re.sub(r'^and\s+', '', subject, flags=re.I)
    if re.search(r'\b(?:from|by|of)\b', subject, re.I):
        return [], 'external_resource_possessor'
    facet_subject = re.split(r'\b(?:for|to|on|using)\b', subject, maxsplit=1, flags=re.I)[0].strip()
    bare_subject = re.sub(r'^(?:our|the|all)\s+', '', facet_subject, flags=re.I)
    vocabulary = r'(?:source|code|codes|implementation|software|inference|scripts?|datasets?|data|corpus|corpora|benchmarks?|pre[- ]trained|models?|weights?|checkpoints?|audio|samples?|demo(?:nstration)?|website|training|recipes|evaluation|protocols|prompts?|reproduction|materials|artifacts?|and|our|the|all|,|\s)'
    explicit_our = bool(re.match(r'^our\b', subject, re.I))
    generic_subject = bool(re.fullmatch(vocabulary + '+', bare_subject, re.I))
    named_owned = False
    first_resource = RESOURCE.search(bare_subject)
    if first_resource and first_resource.start() > 0:
        name = bare_subject[:first_resource.start()].strip()
        if re.fullmatch(r'[A-Za-z][A-Za-z0-9 -]{1,63}', name):
            for sentence in re.split(r'(?<=[.!?])\s+', normalized(before)):
                if re.search(r'\bwe\s+(?:propose|present|introduce|develop)\b', sentence, re.I) \
                        and re.search(r'(?<!\w)' + re.escape(name) + r'(?!\w)', sentence, re.I) \
                        and not UNRELEASED.search(sentence) and not EXTERNAL.search(sentence) \
                        and not re.search(r'["“”‘’]', sentence):
                    named_owned = True
    if not (explicit_our or generic_subject or named_owned) or not RESOURCE.search(subject) or len(subject) > 260:
        return [], 'resource_subject_not_explicit'
    # Quoted/example releases and immediate retractions cannot be borrowed.
    intro = normalized(before)[-320:]
    if re.search(r'(?:according to|quot(?:e|es|ed|ation)|following statement|other authors?|another (?:paper|work)|states?|stated|reported|says?|said|writes?|wrote|claims?)\b[^.!?]{0,180}:?\s*$', intro, re.I):
        return [], 'external_or_quoted_introduction'
    if intro.rstrip().endswith(':'):
        return [], 'quoted_introduction'
    previous_sentence = re.split(r'(?<=[.!?])\s+', intro.rstrip('.!? '))[-1]
    if not re.search(r'\bour\b', subject, re.I) and re.search(r'\b(?:we (?:use|used|adopt|adopted|reuse|reused)|third.party|baseline|prior work|previous work|other authors?|their)\b', previous_sentence, re.I):
        return [], 'adjacent_third_party_attribution'
    for sentence in re.split(r'(?<=[.!?])\s+', normalized(after))[:2]:
        same_release = re.search(r'\b(?:this|the|our|above|earlier)\s+(?:(?:release|availability|open[- ]source)\s+)?(?:statement|declaration|claim|announcement)\b|\b(?:this|our|the)\s+(?:code\s+|resource\s+)?release\b', sentence, re.I)
        if same_release and re.search(r'\b(?:retract(?:ed)?|withdrawn|revoked|false|incorrect|not (?:accurate|true|correct)|no longer (?:accurate|true|valid))\b', sentence, re.I):
            return [], 'adjacent_release_statement_retraction'
        if re.search(r'\b(?:our|this|the)\s+(?:source\s+)?(?:code|repository|repo|dataset|data|model|weights|checkpoint|resources?)\b', sentence, re.I) and UNRELEASED.search(sentence):
            return [], 'adjacent_resource_retraction'
    # Purpose clauses do not release their objects: code for dataset collection
    # is a code declaration, not a dataset release.
    facets = []
    if re.search(r'\b(?:codes?|implementation|software|scripts?)\b', facet_subject, re.I):
        facets.append('code')
    if re.search(r'\b(?:(?:pre[- ]trained\s+)?models?(?!\s+code)|weights?|checkpoints?)\b', facet_subject, re.I):
        facets.append('model')
    if re.search(r'\b(?:data|datasets?|corpus|corpora|benchmarks?)\b', facet_subject, re.I):
        facets.append('dataset')
    if re.search(r'\b(?:audio samples?|demo(?:nstration)?(?: website)?)\b', facet_subject, re.I):
        facets.append('demo')
    if re.search(r'\b(?:training recipes|evaluation protocols|prompts?|reproduction materials|artifacts?)\b', facet_subject, re.I):
        facets.append('reproduction')
    return facets, None if facets else 'resource_facet_not_explicit'


def bbox(value):
    return [round(float(x), 5) for x in value]


def page_lines(page):
    result = []
    words = page.get_text('words', sort=False, flags=fitz.TEXTFLAGS_TEXT)
    for block_index, block in enumerate(page.get_text('dict', flags=fitz.TEXTFLAGS_TEXT)['blocks']):
        for line_index, line in enumerate(block.get('lines', [])):
            spans = [{'text': span['text'], 'bbox': bbox(span['bbox']), 'size': round(span['size'], 5),
                      'origin': bbox(span['origin'])} for span in line['spans']]
            if not spans or not ''.join(span['text'] for span in spans).strip():
                continue
            box = bbox(line['bbox'])
            # A line crossing the gutter has no unambiguous column capability.
            column = 'left' if box[2] <= page.rect.width / 2 else 'right' if box[0] >= page.rect.width / 2 else None
            contained = [{'text': word[4], 'bbox': bbox(word[:4]), 'block': word[5], 'line': word[6], 'word': word[7]}
                         for word in words if word[5] == block_index and word[6] == line_index]
            result.append({'block': block_index, 'line': line_index, 'bbox': box, 'column': column,
                           'rawText': ''.join(span['text'] for span in spans), 'spans': spans, 'words': contained})
    return result


def extract(pdf):
    need(isinstance(pdf, bytes) and pdf.startswith(b'%PDF-') and len(pdf) <= 64 * 1024 * 1024, 'pdf_invalid')
    doc = fitz.open(stream=pdf, filetype='pdf')
    need(len(doc) <= 256, 'pdf_page_limit')
    candidates, rejected = [], []
    try:
        for page in doc:
            lines = page_lines(page)
            need(len(lines) <= 3000, 'pdf_line_limit')
            notes, calls = [], []
            for line in lines:
                spans = line['spans']
                for index, marker in enumerate(spans):
                    if not re.fullmatch(r'[1-9]\d{0,2}', marker['text']) or line['column'] is None:
                        continue
                    prior = next((span for span in reversed(spans[:index]) if span['text'].strip()), None)
                    following = ''.join(span['text'] for span in spans[index+1:]).strip()
                    # Footnote marker must start its own lower-page URL line.
                    if prior is None and line['bbox'][1] >= page.rect.height * .65:
                        url_match = REPOSITORY.fullmatch(following.rstrip('.,;'))
                        if url_match and marker['size'] <= max(span['size'] for span in spans[index+1:]) * .9:
                            notes.append({'marker': marker, 'line': line, 'url': url_match.group()})
                        continue
                    if prior is None or marker['size'] > prior['size'] * .85 or marker['bbox'][0] - prior['bbox'][2] > max(4, prior['size'] * .6):
                        continue
                    if marker['origin'][1] >= prior['origin'][1] - .5:
                        continue
                    column_lines = sorted([row for row in lines if row['column'] == line['column']], key=lambda row: (round(row['bbox'][1], 1), row['bbox'][0]))
                    position = column_lines.index(line)
                    preceding = []
                    # Only adjacent lines from the same physical column.
                    for row in reversed(column_lines[max(0,position-16):position]):
                        next_row = preceding[-1] if preceding else line
                        if next_row['bbox'][1] - row['bbox'][3] > max(16, prior['size'] * 2.2):
                            break
                        preceding.append(row)
                    preceding.reverse()
                    prefix = ''.join(span['text'] for span in spans[:index])
                    raw = '\n'.join([row['rawText'] for row in preceding] + [prefix]).rstrip()
                    # A terminal period before a superscript is part of this sentence.
                    content = raw.rstrip('.!? ')
                    boundaries = list(re.finditer(r'[.!?](?:\d{1,3})?\s+(?=[A-Z])', content))
                    start = boundaries[-1].end() if boundaries else 0
                    statement = content[start:].strip()
                    if not RESOURCE.search(normalized(statement)) or not re.search(r'available|released|open[- ]source', statement, re.I):
                        continue
                    before = content[:start]
                    tail = ''.join(span['text'] for span in spans[index+1:]).lstrip('.!? ')
                    next_rows = column_lines[position+1:position+4]
                    after = '\n'.join([tail] + [row['rawText'] for row in next_rows])
                    facets, reason = facets_for(statement, before, after)
                    call = {'marker': marker, 'line': line, 'statementRawText': statement,
                            'statementNormalizedText': normalized(statement), 'contextBeforeRaw': before[-2000:],
                            'contextAfterRaw': after[:500], 'statementLines': preceding + [line], 'facets': facets, 'reason': reason}
                    calls.append(call)
            for call in calls:
                number = call['marker']['text']
                matching_notes = [note for note in notes if note['marker']['text'] == number]
                same_calls = [other for other in calls if other['marker']['text'] == number]
                reason = call['reason']
                if len(matching_notes) != 1 or len(same_calls) != 1:
                    reason = reason or 'marker_or_footnote_not_unique'
                note = matching_notes[0] if len(matching_notes) == 1 else None
                if note and (note['line']['column'] != call['line']['column'] or note['line']['bbox'][1] <= call['line']['bbox'][3]):
                    reason = reason or 'footnote_not_below_same_column'
                result = {'page': page.number + 1, 'pageWidth': round(page.rect.width,5), 'pageHeight': round(page.rect.height,5),
                          'column': call['line']['column'], 'marker': number, 'statementMarker': call['marker'],
                          'statementRawText': call['statementRawText'], 'statementNormalizedText': call['statementNormalizedText'],
                          'contextBeforeRaw': call['contextBeforeRaw'], 'contextAfterRaw': call['contextAfterRaw'],
                          'statementLines': call['statementLines'], 'resourceFacets': call['facets'],
                          'pageTextSha256': sha(page.get_text('text', sort=False, flags=fitz.TEXTFLAGS_TEXT).encode())}
                if note:
                    result.update({'url': note['url'], 'footnoteMarker': note['marker'], 'footnoteLine': note['line']})
                if reason:
                    rejected.append({**result, 'reason': reason})
                else:
                    candidates.append(result)
    finally:
        doc.close()
    need(len(candidates) <= 128 and len(rejected) <= 512, 'pdf_candidate_limit')
    return {'contract': CONTRACT, 'pdfSha256': sha(pdf), 'backend': {'name': 'pymupdf', 'version': fitz.version[0],
            'method': 'dict_spans_and_original_words_same_page_same_half_column_v1', 'flags': fitz.TEXTFLAGS_TEXT},
            'candidates': candidates, 'rejected': rejected}


def main():
    from runtime_guard import require_external_runtime, require_workspace_role
    require_external_runtime('reader-authenticated-pdf-footnote-evidence')
    require_workspace_role('daily')
    need(len(sys.argv) == 2 and sys.argv[1].isdigit() and int(sys.argv[1]) >= 3, 'private_descriptor_required')
    fd = int(sys.argv[1])
    info = os.fstat(fd)
    need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_mode & 0o077 == 0
         and 2 <= info.st_size <= 96 * 1024 * 1024, 'private_bounded_descriptor_required')
    chunks, left = [], info.st_size
    while left:
        chunk = os.read(fd, left)
        need(bool(chunk), 'descriptor_truncated')
        chunks.append(chunk)
        left -= len(chunk)
    data = json.loads(b''.join(chunks))
    need(set(data) == {'pdfBase64', 'pdfSha256'}, 'descriptor_fields_invalid')
    pdf = base64.b64decode(data['pdfBase64'], validate=True)
    need(sha(pdf) == data['pdfSha256'], 'pdf_sha_changed')
    print(json.dumps(extract(pdf), ensure_ascii=False, separators=(',', ':')))


if __name__ == '__main__':
    main()
