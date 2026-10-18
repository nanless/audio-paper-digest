"""Immutable publication-only figure views.

Authority is the fixed local Node replay, never this module's hashes or tests.
Raw process_bundle must pass before the publisher calls this module. Nothing in
this module changes Reader/stage/source/fees or creates analysis permission.
"""

if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('conference_publication_figure_view.py')
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import copy
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

CONTRACT = 'conference-publication-figure-view-v1'
CROP_CONTRACT = 'conference-publication-figure-crops-v1'
SHA = re.compile(r'^[a-f0-9]{64}$')


class FigureViewRejected(ValueError):
    pass


def sha(data):
    return hashlib.sha256(data).hexdigest()


def stable(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def require(value, message):
    if not value:
        raise FigureViewRejected(message)


def image_path(value):
    require(isinstance(value, str) and re.fullmatch(
        r'[a-z0-9-]+/[a-f0-9]{12}/figure-[1-9][0-9]*\.png', value), 'unsafe image path')
    return value


def records(records):
    require(isinstance(records, list), 'record list missing')
    require(len({r['path'] for r in records}) == len(records), 'duplicate paths')
    return sorted(copy.deepcopy(records), key=lambda r: r['path'])


def raw_identity(bundle):
    return stable({'completionReceiptSha256': bundle['completion']['receiptSha256'],
                   'files': records(bundle['files']), 'imageFiles': records(bundle['imageFiles'])})


def derived_url(item):
    old, new = image_path(item['originalImagePath']), image_path(item['newImagePath'])
    parsed = urlsplit(item['originalUrl'])
    require(parsed.scheme == 'https' and parsed.netloc and not parsed.query and not parsed.fragment
            and not parsed.username and not parsed.password and parsed.path.endswith('/' + old),
            'original URL does not bind the image')
    require(old != new and old.split('/')[0] == new.split('/')[0], 'derivative namespace changed')
    result = item['originalUrl'][:-len(old)] + new
    require(item['newUrl'] == result, 'derived image URL changed origin or namespace')
    return result


def project_image_nodes(content, replacements, parse_images):
    """Change only exact standalone canonical image nodes + fixed Node source note."""
    parsed = parse_images(content)
    actions, seen = [], set()
    for item in replacements:
        old, new = item['originalUrl'], derived_url(item)
        require(old not in seen, 'duplicate original URL')
        seen.add(old)
        hits = [r for r in parsed if r['url'] == old]
        require(len(hits) == 1, 'image node missing or ambiguous')
        hit = hits[0]
        start, end, raw = hit['start'], hit['end'], hit['raw']
        require(content[start:end] == raw and raw.count(old) == 1, 'image parser span not exact')
        node = raw.replace(old, new, 1)
        if start > 0 and content[start-1:start] == '[':
            tail = '](' + old + ')'
            require(content[end:end+len(tail)] == tail, 'unknown image link wrapper')
            start -= 1; end += len(tail)
            node = '[' + node + '](' + new + ')'
        line_start = content.rfind('\n', 0, start) + 1
        line_end = content.find('\n', end)
        if line_end < 0:
            line_end = len(content)
        require(not content[line_start:start].strip() and not content[end:line_end].strip(),
                'image must be a standalone node')
        # This string is obtained directly from the real Node cold replay. The
        # strict grammar also prevents caller-controlled Markdown/HTML injection.
        note = item['sourceNote']
        require(isinstance(note, str) and re.fullmatch(
            r'原论文 PDF 第 [1-9][0-9]* 页(?: Figure [1-9][0-9]*（出版显示裁切）|，本文讨论 Figure [1-9][0-9]*（完整原页(?:；图注未完整抽取，以原页为准)?）)', note),
            'noncanonical authenticated source note')
        actions.append((start, end, node + '\n\n> **图片来源：** ' + note + '。'))
    ordered = sorted(actions)
    require(all(a[1] <= b[0] for a, b in zip(ordered, ordered[1:])), 'overlapping replacements')
    output = content
    for start, end, value in reversed(ordered):
        output = output[:start] + value + output[end:]
    replacement_map = {r['originalUrl']: r['newUrl'] for r in replacements}
    require([r['url'] for r in parse_images(output)] ==
            [replacement_map.get(r['url'], r['url']) for r in parsed],
            'image order or untargeted node changed')
    return output


def page_metadata(content, raw_page_sha, derivation_sha):
    """Preserve original Reader signature; separately hash real publication body."""
    require(content.startswith('---\n'), 'canonical frontmatter required')
    end = content.find('\n---\n', 4)
    require(end >= 0, 'frontmatter closing delimiter missing')
    front, body = content[:end], content[end + len('\n---\n'):]
    require('paper_digest_publication_view_' not in front, 'raw page is already a view')
    # Original signed Reader fields are untouched. The publication body is not a
    # new signed Reader, so its SHA uses its own explicit namespace.
    addition = '\n'.join([
        f'paper_digest_publication_view_contract: "{CONTRACT}"',
        f'paper_digest_publication_view_raw_page_sha256: "{raw_page_sha}"',
        f'paper_digest_publication_view_derivation_sha256: "{derivation_sha}"',
        f'paper_digest_publication_view_article_sha256: "{sha(body.encode())}"',
    ])
    return front + '\n' + addition + '\n---\n' + body


def project_page_bytes(raw, raw_page_sha, actions, derivation_sha, parse_images):
    """Pure shared bytes projection; never grants authority to its input data."""
    require(sha(raw) == raw_page_sha and SHA.fullmatch(str(derivation_sha)), 'page/derivation byte identity missing')
    if not actions:
        return raw
    projected = project_image_nodes(raw.decode('utf-8'), actions, parse_images)
    return page_metadata(projected, raw_page_sha, derivation_sha).encode('utf-8')


def materialize_view(bundle, node_result, *, root, conference_id, process_id,
                     manifest_path, parse_images, read_bytes, write_exact,
                     expected_declaration=None, replay=False, require_ready=False):
    """Caller MUST supply result of fresh fixed Node derive/replay, never JSON input.

    `replay=True` does not write. Every view/image file is recomputed and compared
    byte-for-byte. `require_ready` is true for review/push; partial crop outputs
    cannot wash unresolved semantic failures by changing a page's image URL.
    """
    require(isinstance(node_result, dict) and node_result.get('contract') == CROP_CONTRACT
            and node_result.get('purpose') == 'publication-display-only'
            and node_result.get('conferenceId') == conference_id
            and node_result.get('processId') == process_id, 'Node derivation identity mismatch')
    body = {k: v for k, v in node_result.items() if k != 'derivationSha256'}
    require(node_result.get('derivationSha256') == stable(body), 'Node result damaged in transit')
    require(isinstance(node_result.get('derivations'), list), 'derivations missing')
    # Updated crop API supplies full-failure routes and blocked diagnostics. Do
    # not accept old outcomes omitting the readiness fields for publication.
    if require_ready:
        require(node_result.get('status') == 'complete' and node_result.get('blocked') == []
                and node_result.get('unresolvedRoutes') == [] and node_result.get('publicationPassed') is False,
                'image issues remain unresolved; publication is blocked')
    root = Path(root)
    view_root = root / 'data/runtime/conference-publications' / conference_id / process_id / 'figure-publication-views' / node_result['derivationSha256']
    cursor = view_root
    while cursor != root:
        require(not cursor.is_symlink(), 'publication view ancestor is a symlink')
        require(not cursor.exists() or cursor.is_dir(), 'publication view ancestor is not a directory')
        cursor = cursor.parent
        require(cursor != cursor.parent or cursor == root, 'view root escaped repository')
    files, images = records(bundle['files']), records(bundle['imageFiles'])
    old_images = {r['path']: r for r in images}
    paper_pages = {r['paperId']: r for r in files if r['kind'] == 'paper'}
    require(len(paper_pages) == sum(r['kind'] == 'paper' for r in files), 'duplicate paper pages')
    actions_by_paper, new_paths = {}, set()
    for item in node_result['derivations']:
        require(item['paperId'] in paper_pages, 'derivative paper missing from raw bundle')
        old = old_images.get(item['originalImagePath'])
        require(old is not None and old['paperId'] == item['paperId'], 'old image ownership differs')
        derived_url(item)
        require(item['newImagePath'] not in old_images and item['newImagePath'] not in new_paths,
                'derivative overwrites or collides with an image')
        new_paths.add(item['newImagePath'])
        require(SHA.fullmatch(str(item.get('sha256', ''))) and type(item.get('size')) is int
                and item['size'] > 0, 'derivative byte identity missing')
        data = read_bytes(Path(item['derivedSourcePath']))
        require(sha(data) == item['sha256'] and len(data) == item['size'], 'derived PNG bytes changed')
        actions_by_paper.setdefault(item['paperId'], []).append(item)
        images.append({'kind': 'asset', 'paperId': item['paperId'], 'path': item['newImagePath'],
                       'sourcePath': item['derivedSourcePath'], 'manifestSha256': item['proofSha256'],
                       'sourceSha256': item['sha256'], 'size': item['size']})
    all_actions = node_result['derivations']
    changed = []
    for i, record in enumerate(files):
        if record['kind'] not in {'paper', 'aggregate'}:
            continue
        raw = read_bytes(Path(record['sourcePath']))
        require(sha(raw) == record['sourceSha256'] and len(raw) == record['size'], 'raw page changed')
        text = raw.decode('utf-8')
        if record['kind'] == 'paper':
            actions = actions_by_paper.get(record['paperId'], [])
        else:
            # Summaries normally contain no images. Only exact actually present
            # nodes may be changed; prose URLs or unrelated summaries stay exact.
            present = {r['url'] for r in parse_images(text)}
            actions = [a for a in all_actions if a['originalUrl'] in present]
        if not actions:
            continue
        data = project_page_bytes(raw, record['sourceSha256'], actions, node_result['derivationSha256'], parse_images)
        require(data != raw, 'view did not change actual publication bytes')
        filename = view_root / (sha(data) + '.md')
        if replay:
            require(read_bytes(filename) == data, 'saved publication view differs from exact recomputation')
        else:
            write_exact(filename, data)
        files[i] = {**record, 'sourcePath': str(filename), 'sourceSha256': sha(data), 'size': len(data)}
        changed.append({'path': record['path'], 'paperId': record.get('paperId'),
                        'rawPageSha256': record['sourceSha256'], 'publicationViewSha256': sha(data)})
    require(len(changed) >= len(actions_by_paper), 'not all derivative papers were projected')
    declaration = {'contract': CONTRACT, 'version': 1, 'conferenceId': conference_id, 'processId': process_id,
                   'manifestPath': str(manifest_path), 'manifestFileSha256': node_result['manifestFileSha256'],
                   'baseGenerationSha256': node_result['baseGenerationSha256'],
                   'baseGenerationFileSha256': node_result['baseGenerationFileSha256'],
                   'rawBundleSha256': raw_identity(bundle), 'rawFiles': records(bundle['files']),
                   'rawImageFiles': records(bundle['imageFiles']), 'nodeDerivation': node_result,
                   'changedPages': changed}
    declaration['viewSha256'] = stable(declaration)
    if replay:
        require(declaration == expected_declaration, 'publication view declaration differs from live replay')
    result = {**bundle, 'files': records(files), 'imageFiles': records(images), 'figurePublicationView': declaration}
    return result


def review_contexts_from_generation(generation):
    """Publisher-only: use after validate_generation's fresh real Node replay.

    This function adds no qualification. It never accepts a free Markdown note
    as authority, and cannot substitute for the required live Node consumer.
    """
    declaration = generation.get('figurePublicationView')
    if declaration is None:
        return {}
    outcome = declaration['nodeDerivation']
    result = {}
    for item in outcome['derivations']:
        target = item.get('reviewTarget')
        limited = isinstance(target, dict) and target.get('displayMode') == 'source-pdf-attested-source-page-only-v1'
        fields = {'displayMode', 'pdfPage', 'targetPrintedFigureNumber', 'originalPdfSha256', 'completeTargetCaption'}
        if limited:
            fields.add('captionExtractionStatus')
        require(isinstance(target, dict) and set(target) == fields,
                'Node derivation lacks exact figure review target')
        require(target['displayMode'] in {'source-pdf-full-page-v1', 'source-pdf-figure-crop-v1', 'source-pdf-attested-source-page-only-v1'}
                and type(target['pdfPage']) is int and target['pdfPage'] > 0
                and type(target['targetPrintedFigureNumber']) is int and target['targetPrintedFigureNumber'] > 0
                and SHA.fullmatch(str(target['originalPdfSha256'])), 'invalid typed publication target')
        if not limited:
            require(isinstance(target['completeTargetCaption'], str) and target['completeTargetCaption'].strip()
                    and len(target['completeTargetCaption']) <= 16000, 'complete-caption mode requires actual complete text')
        if limited:
            require(target['completeTargetCaption'] is None and target['captionExtractionStatus'] in {'unavailable', 'partial'},
                    'limited source page cannot claim a complete extracted caption')
        require(target['targetPrintedFigureNumber'] == item['figureNumber'], 'review target printed number changed')
        require(item['newUrl'] not in result, 'duplicate publication review URL')
        result[item['newUrl']] = {'paperId': item['paperId'], 'imageSha256': item['sha256'],
                                  'sourceNote': item['sourceNote'], 'reviewTarget': copy.deepcopy(target)}
    return result


def review_contexts_for_page(contexts, record, content, parse_images):
    """Only actual image nodes consume their authenticated target, even summary."""
    present = {image['url'] for image in parse_images(content)}
    selected = {url: item for url, item in contexts.items() if url in present}
    if record['kind'] == 'paper':
        require(all(item['paperId'] == record['paperId'] for item in selected.values()),
                'publication figure review context belongs to another paper')
    else:
        require(record['kind'] == 'aggregate' or not selected, 'figure context outside publication page')
    return selected
