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
    else:
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
