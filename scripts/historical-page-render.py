#!/usr/bin/env python3
"""Render one fresh historical paper page from a sealed projection packet."""

import json
import base64
import sys
import tempfile
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


def render_packet(packet):
    paper = packet.get('paper')
    assignment = packet.get('taxonomy')
    date = packet.get('cohortDate')
    if not isinstance(paper, dict) or not isinstance(assignment, dict):
        raise ValueError('paper and taxonomy objects are required')
    if assignment.get('status') != 'assigned' or assignment.get('paperId') != f'arxiv:{paper.get("arxivId")}':
        raise ValueError('assigned taxonomy belongs to another paper')
    concepts = {item['id']: item for item in assignment.get('concepts', [])}
    ordered = []
    for concept_id in [assignment.get('primaryTaskId'), assignment.get('primaryMethodId'), *assignment.get('conceptIds', [])]:
        if concept_id and concept_id not in ordered:
            ordered.append(concept_id)
    if any(concept_id not in concepts for concept_id in ordered):
        raise ValueError('taxonomy concept labels are incomplete')
    labels = [f'#{concepts[concept_id]["preferredLabel"]["zh"]}' for concept_id in ordered]
    projected = dict(paper)
    publisher = load_publish_to_blog()
    # Historical staging must not trust a cached ``parsed`` object for scores,
    # summaries, dimensions, or prose.  Rebuild every publication field from
    # the sealed canonical analysis, then apply only the deterministic current
    # taxonomy projection below.
    projected['parsed'] = publisher.parse_analysis(paper.get('analysis', ''))
    if not isinstance(projected['parsed'], dict):
        raise ValueError('sealed canonical analysis cannot be reparsed for publication')
    projected['parsed']['tags'] = labels
    projected['parsed']['primaryTaskTag'] = f'#{concepts[assignment["primaryTaskId"]]["preferredLabel"]["zh"]}'
    projected['parsed']['primaryMethodTag'] = f'#{concepts[assignment["primaryMethodId"]]["preferredLabel"]["zh"]}'
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
