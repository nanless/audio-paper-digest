#!/usr/bin/env python3
"""Render one fresh historical paper page from a sealed projection packet."""

import json
import base64
import hashlib
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


DIRECT_PUBLICATION_SOURCE_CONTRACT = 'historical-direct-publication-source-v1'
DIRECT_PUBLICATION_METADATA_CONTRACT = 'historical-arxiv-publication-metadata-v1'
SHA256_RE = re.compile(r'^[a-f0-9]{64}$')


def canonical_iso_z(value):
    if not isinstance(value, str) or not value.endswith('Z'):
        return False
    try:
        parsed = datetime.fromisoformat(value[:-1] + '+00:00')
    except ValueError:
        return False
    return parsed.tzinfo is not None \
        and parsed.astimezone(timezone.utc).isoformat(timespec='milliseconds') \
        .replace('+00:00', 'Z') == value


def inject_direct_publication_source(projected, publication_source):
    arxiv_id = projected.get('arxivId')
    if not arxiv_id:
        if publication_source is not None:
            raise ValueError('direct conference packet cannot carry arXiv publication source')
        return projected
    fields = {
        'contract', 'version', 'paperId', 'sourceSnapshotSha256',
        'sourceTextSha256', 'abstract', 'abstractSha256',
    }
    has_metadata_sidecar = isinstance(publication_source, dict) \
        and 'metadataSidecar' in publication_source
    fields.add('metadataSidecar')
    if not isinstance(publication_source, dict) \
            or set(publication_source) != fields:
        raise ValueError('direct arXiv publication source proof is required')
    abstract = publication_source.get('abstract')
    abstract_sha = publication_source.get('abstractSha256')
    provenance = projected.get('freshRewriteProvenance')
    if publication_source.get('contract') != DIRECT_PUBLICATION_SOURCE_CONTRACT \
            or publication_source.get('version') != 1 \
            or publication_source.get('paperId') != projected.get('directPaperId') \
            or publication_source.get('paperId') != f'arxiv:{arxiv_id}' \
            or not SHA256_RE.fullmatch(str(publication_source.get('sourceSnapshotSha256') or '')) \
            or not SHA256_RE.fullmatch(str(publication_source.get('sourceTextSha256') or '')) \
            or not isinstance(provenance, dict) \
            or publication_source.get('sourceSnapshotSha256') \
                != provenance.get('sourceSnapshotSha256') \
            or publication_source.get('sourceTextSha256') \
                != provenance.get('sourceSha256') \
            or not isinstance(abstract, str) or not abstract \
            or abstract != abstract.strip() or '\r' in abstract or '\0' in abstract \
            or len(abstract.encode('utf-8')) > 200000 \
            or not SHA256_RE.fullmatch(str(abstract_sha or '')) \
            or hashlib.sha256(abstract.encode('utf-8')).hexdigest() != abstract_sha:
        raise ValueError('direct arXiv publication source proof is invalid')
    if not has_metadata_sidecar:
        raise ValueError('direct arXiv publication metadata sidecar proof is required')
    if has_metadata_sidecar:
        sidecar = publication_source.get('metadataSidecar')
        sidecar_fields = {
            'contract', 'paperId', 'manifestSha256', 'atomResponseSha256',
            'metadataRecordSha256', 'abstractSha256', 'sourceName', 'querySourceId',
            'sourceManifestSha256', 'sourceSnapshotSha256',
            'sourceTextSha256', 'sourceId', 'entryVersion', 'entryUpdatedAt',
            'publishedAt', 'observedAt', 'sourceCapturedAt', 'sourceEarliestCapturedAt',
            'sourceLatestCapturedAt',
            'generation',
        }
        expected_source_name = (
            'https://export.arxiv.org/api/query?'
            f'id_list={sidecar.get("querySourceId")}&max_results=1'
        )
        if not isinstance(sidecar, dict) or set(sidecar) != sidecar_fields \
                or sidecar.get('contract') != DIRECT_PUBLICATION_METADATA_CONTRACT \
                or sidecar.get('paperId') != publication_source.get('paperId') \
                or not isinstance(sidecar.get('entryVersion'), int) \
                or isinstance(sidecar.get('entryVersion'), bool) \
                or sidecar.get('entryVersion') < 1 \
                or any(not SHA256_RE.fullmatch(str(sidecar.get(field) or ''))
                       for field in (
                           'manifestSha256', 'atomResponseSha256',
                           'metadataRecordSha256', 'abstractSha256',
                           'sourceManifestSha256')) \
                or sidecar.get('abstractSha256') != abstract_sha \
                or sidecar.get('sourceManifestSha256') \
                    != provenance.get('sourceManifestSha256') \
                or sidecar.get('sourceSnapshotSha256') \
                    != publication_source.get('sourceSnapshotSha256') \
                or sidecar.get('sourceTextSha256') \
                    != publication_source.get('sourceTextSha256') \
                or any(not canonical_iso_z(sidecar.get(field))
                       for field in ('entryUpdatedAt', 'publishedAt', 'observedAt',
                                     'sourceCapturedAt',
                                     'sourceEarliestCapturedAt',
                                     'sourceLatestCapturedAt')) \
                or sidecar.get('publishedAt') > sidecar.get('entryUpdatedAt') \
                or sidecar.get('entryUpdatedAt') > sidecar.get('observedAt') \
                or sidecar.get('entryUpdatedAt') \
                    > sidecar.get('sourceEarliestCapturedAt') \
                or sidecar.get('sourceEarliestCapturedAt') \
                    > sidecar.get('sourceLatestCapturedAt') \
                or not isinstance(sidecar.get('sourceId'), str) \
                or not re.fullmatch(rf'{re.escape(arxiv_id)}(?:v[1-9]\d*)?',
                                    sidecar.get('sourceId')) \
                or (re.search(r'v([1-9]\d*)$', sidecar.get('sourceId')) is not None
                    and int(re.search(r'v([1-9]\d*)$', sidecar.get('sourceId')).group(1))
                    != sidecar.get('entryVersion')) \
                or (re.search(r'v([1-9]\d*)$', sidecar.get('sourceId')) is None
                    and sidecar.get('observedAt')
                    < sidecar.get('sourceLatestCapturedAt')) \
                or sidecar.get('querySourceId') != sidecar.get('sourceId') \
                or sidecar.get('generation') != provenance.get('sourceGeneration') \
                or sidecar.get('sourceName') != expected_source_name:
            raise ValueError('direct arXiv publication metadata sidecar proof is invalid')
    if projected.get('abstract') not in (None, abstract):
        raise ValueError('direct arXiv publication source conflicts with analysis abstract')
    projected['abstract'] = abstract
    return projected


def render_packet(packet):
    paper = packet.get('paper')
    assignment = packet.get('taxonomy')
    date = packet.get('cohortDate')
    direct = packet.get('directStaging') is True
    if not isinstance(paper, dict):
        raise ValueError('paper object is required')
    if direct:
        # Direct historical rewrites are sealed to an independently captured
        # source/run packet in Node. They deliberately do not have a legacy
        # crosswalk or postprocess taxonomy-assignment prerequisite. The
        # taxonomy surface is already part of the sealed canonical analysis
        # and is reparsed below rather than imported from an old page.
        if not isinstance(paper.get('directPaperId'), str) or not paper['directPaperId']:
            raise ValueError('direct staging paper identity is required')
        projected = dict(paper)
        projected = inject_direct_publication_source(
            projected, packet.get('publicationSource')
        )
    else:
        if packet.get('publicationSource') is not None:
            raise ValueError('non-direct packet cannot carry publication source proof')
        if not isinstance(assignment, dict):
            raise ValueError('taxonomy object is required')
        if assignment.get('status') != 'assigned' or assignment.get('paperId') != f'arxiv:{paper.get("arxivId")}':
            raise ValueError('assigned taxonomy belongs to another paper')
        concepts = {item['id']: item for item in assignment.get('concepts', [])}
        ordered = []
        for concept_id in [assignment.get('primaryTaskId'), assignment.get('primaryMethodId'), *assignment.get('conceptIds', [])]:
            if concept_id and concept_id not in ordered:
                ordered.append(concept_id)
        if any(concept_id not in concepts for concept_id in ordered):
            raise ValueError('taxonomy concept labels are incomplete')
        if not isinstance(assignment.get('registryVersion'), str) \
                or not isinstance(assignment.get('registrySha256'), str):
            raise ValueError('taxonomy assignment registry identity is incomplete')
        labels = [f'#{concepts[concept_id]["preferredLabel"]["zh"]}' for concept_id in ordered]
        projected = dict(paper)
    publisher = load_publish_to_blog()
    if direct and not projected.get('arxivId'):
        # Conference-only direct sources have no arXiv identity.  The normal
        # publisher intentionally requires one for its citation/workbench
        # sidecars, so render the same reader-first page surface here without
        # inventing an arXiv ID or touching any old conference post.  The Node
        # adapter has already replayed the sealed Reader/source/projection
        # bindings before this renderer is called.
        parsed = publisher.parse_analysis(projected.get('analysis', ''))
        if not isinstance(parsed, dict):
            raise ValueError('sealed direct conference analysis cannot be reparsed')
        taxonomy = publisher.build_flat_taxonomy_compat_metadata(parsed, required=True)
        title = publisher.plain_title_for_publish(projected.get('title', ''))
        if not title:
            raise ValueError('direct conference title is required')
        reader_title = str((projected.get('apiReaderPlan') or {}).get('readerTitle') or title).strip()
        article = str(projected.get('apiReaderArticle') or '').strip()
        if not article:
            raise ValueError('direct conference Reader article is required')
        figures = projected.get('apiReaderFigures')
        article = publisher.render_ephemeral_api_reader_figures(
            article, [] if figures is None else figures
        )
        tags = [str(item).lstrip('#') for item in parsed.get('tags', []) if str(item).strip()]
        score = parsed.get('score')
        summary = str(parsed.get('summary') or '').strip()
        frontmatter = [
            '---', f'title: {json.dumps(title, ensure_ascii=False)}', f'date: {date}',
            'draft: false', f'tags: {json.dumps(tags, ensure_ascii=False)}',
            'categories: [论文速递]', 'paper_digest_pipeline_owned: true',
            'paper_digest_page_type: paper', f'paper_digest_direct_paper_id: {json.dumps(projected["directPaperId"], ensure_ascii=False)}',
            f'paper_digest_taxonomy_contract: {json.dumps(taxonomy["contract"])}',
            f'paper_digest_taxonomy_selection_contract: {json.dumps(taxonomy["selectionContract"])}',
            f'paper_digest_taxonomy_registry_version: {json.dumps(taxonomy["registryVersion"])}',
            f'paper_digest_taxonomy_registry_sha256: {json.dumps(taxonomy["registrySha256"])}',
            f'paper_digest_taxonomy_concepts: {json.dumps(taxonomy["concepts"], ensure_ascii=False, separators=(",", ":"), sort_keys=True)}',
            f'paper_digest_primary_task: {json.dumps(taxonomy["primaryTask"], ensure_ascii=False)}',
            f'paper_digest_primary_method: {json.dumps(taxonomy["primaryMethod"], ensure_ascii=False)}',
            '---', '', f'# 📄 {reader_title}', '', f'> 会议论文 ID：`{projected["directPaperId"]}`', ''
        ]
        if tags:
            frontmatter.extend([f'标签：{" ".join("#" + tag for tag in tags)}', ''])
        if isinstance(score, (int, float)):
            frontmatter.extend([f'评分：{score:.1f}/10', ''])
        if summary:
            frontmatter.extend(['## 📌 核心摘要', '', summary, ''])
        frontmatter.extend(['## 🧭 深度解读', '', article, '', '---',
            f'[← 返回 {date} 语音/音乐/音频论文速递](/posts/{date}/)', ''])
        return {'markdown': publisher.sanitize_markdown_for_publish('\n'.join(frontmatter)), 'assets': []}
    # Historical staging must not trust a cached ``parsed`` object for scores,
    # summaries, dimensions, or prose.  Rebuild every publication field from
    # the sealed canonical analysis, then apply only the deterministic current
    # taxonomy projection below.
    projected['parsed'] = publisher.parse_analysis(paper.get('analysis', ''))
    if not isinstance(projected['parsed'], dict):
        raise ValueError('sealed canonical analysis cannot be reparsed for publication')
    if not direct:
        projected['parsed']['tags'] = labels
        projected['parsed']['primaryTaskTag'] = f'#{concepts[assignment["primaryTaskId"]]["preferredLabel"]["zh"]}'
        projected['parsed']['primaryMethodTag'] = f'#{concepts[assignment["primaryMethodId"]]["preferredLabel"]["zh"]}'
        projected['parsed']['taxonomyValidation'] = {
            'valid': True,
            'errors': [],
            'registryVersion': assignment['registryVersion'],
            'registrySha256': assignment['registrySha256'],
            'primaryTaskId': assignment['primaryTaskId'],
            'primaryMethodId': assignment['primaryMethodId'],
            'conceptIds': ordered,
        }
    markdown, _ = publisher.generate_paper_page(projected, date, '论文速递')
    assets = []
    with tempfile.TemporaryDirectory(prefix='historical-page-render-') as temporary:
        root = Path(temporary)
        publisher.prepare_api_reader_staged_assets([projected], root)
        publisher.prepare_researcher_workbench_staged_assets([projected], date, root)
        for filename in sorted(item for item in root.rglob('*') if item.is_file()):
            assets.append({'path': filename.relative_to(root).as_posix(),
                           'base64': base64.b64encode(filename.read_bytes()).decode('ascii')})
    return {'markdown': markdown, 'assets': assets}


def main():
    require_external_runtime('historical-page-render.py')
    raw = sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('projection packet is too large')
    rendered = render_packet(json.loads(raw.decode('utf-8')))
    sys.stdout.write(json.dumps(rendered, ensure_ascii=False))


if __name__ == '__main__':
    main()
