#!/usr/bin/env python3
"""Render a source-bound conference paper without inventing an arXiv identity."""

import hashlib
import json
import re
import sys

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


PAPER_ID = re.compile(r'^conference:[a-z0-9-]+:\d{4}:[a-z0-9-]+:[A-Za-z0-9_-]+$')
WEAK = {'fullText': 'weak', 'tables': 'unavailable', 'formulas': 'unavailable', 'figures': 'unavailable'}


def stable_sha(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()
    return hashlib.sha256(raw).hexdigest()


def render_packet(packet):
    paper, assignment = packet.get('paper'), packet.get('taxonomy')
    paper_id, conference, capabilities = packet.get('paper_id'), packet.get('conference'), packet.get('capabilities')
    if not isinstance(paper, dict) or not isinstance(assignment, dict) or not PAPER_ID.fullmatch(str(paper_id or '')):
        raise ValueError('generic conference paper projection is required')
    if paper.get('id') != paper_id or paper.get('conferencePaperId') != paper_id \
            or paper.get('arxivId') is not None or paper.get('paper_id') != paper_id:
        raise ValueError('conference paper must not carry an arXiv alias')
    if assignment.get('status') != 'assigned' or assignment.get('paperId') != paper_id or capabilities != WEAK:
        raise ValueError('taxonomy/capability projection is not source-bound weak conference data')
    manifest, plan, article = paper.get('analysisManifest'), paper.get('apiReaderPlan'), paper.get('apiReaderArticle')
    stage = ((manifest or {}).get('stages') or {}).get('apiReaderArticle') or {}
    if not isinstance(plan, dict) or not isinstance(article, str) or not article.strip() \
            or ((manifest or {}).get('contracts') or {}).get('apiReaderArticle') != 'beginner-researcher-v3' \
            or plan.get('contract') != 'beginner-researcher-v3' or stage.get('status') != 'complete' \
            or hashlib.sha256(article.encode()).hexdigest() != paper.get('apiReaderArticleSha256') \
            or stage.get('articleSha256') != paper.get('apiReaderArticleSha256') \
            or stable_sha(plan) != paper.get('apiReaderPlanSha256') or stage.get('planSha256') != paper.get('apiReaderPlanSha256') \
            or paper.get('apiReaderFigures') != [] or plan.get('formulaBindings') != [] \
            or stage.get('figureCount') != 0 or stage.get('formulaBindingCount') != 0:
        raise ValueError('conference Reader bytes/plan/weak unavailable structure are not sealed')
    concepts = {item['id']: item for item in assignment.get('concepts', [])}
    ordered = []
    for concept_id in [assignment.get('primaryTaskId'), assignment.get('primaryMethodId'), *assignment.get('conceptIds', [])]:
        if concept_id and concept_id not in ordered:
            ordered.append(concept_id)
    if any(cid not in concepts for cid in ordered):
        raise ValueError('taxonomy labels are incomplete')
    labels = [concepts[cid]['preferredLabel']['zh'] for cid in ordered]
    parsed = paper.get('parsed') or {}
    title, summary, score = str(paper.get('title') or '').strip(), str(parsed.get('summary') or '').strip(), str(parsed.get('score') or '').strip()
    if not title or not summary or not re.fullmatch(r'\d+(?:\.\d)?', score):
        raise ValueError('canonical title/summary/score are incomplete')
    publisher = load_publish_to_blog()
    category = f'{conference["id"]} 论文'
    lines = ['---', f'title: "{publisher.yaml_escape(title)}"', f'date: {packet["date"]}', 'draft: false',
             f'tags: {json.dumps(labels, ensure_ascii=False)}', f'categories: {json.dumps([category], ensure_ascii=False)}',
             'paper_digest_pipeline_owned: true', 'paper_digest_page_type: paper',
             f'paper_digest_paper_id: {json.dumps(paper_id, ensure_ascii=False)}', 'paper_digest_source_kind: conference',
             f'paper_digest_conference_id: {json.dumps(conference["id"])}',
             'paper_digest_conference_structure: weak-text-only-v1', '---', '',
             f'# 📄 {plan["readerTitle"].strip()}', '', f'> 英文题目：*{title}*', '',
             f'> 会议身份：`{paper_id}`', '', '> ⚠️ 来源为会议 PDF 弱结构纯文本；表格、公式与 Figure 均不可用，本文不会据此重建这些结构。', '',
             f'标签：{" ".join("#" + label for label in labels)}', '', f'评分：{score}/10', '',
             '## 📌 核心摘要', '', summary, '', '## 🧭 深度解读', '', article.strip(), '']
    scoring = str(parsed.get('scoringReason') or '').strip()
    if scoring:
        lines.extend(['## ⚖️ 评分明细', '', scoring, ''])
    lines.extend(['---', '', f'[← 返回 {conference["id"]} 论文汇总]({packet["aggregateUrl"]})', ''])
    return {'markdown': publisher.sanitize_markdown_for_publish('\n'.join(lines)), 'assets': []}


def main():
    require_external_runtime('conference-page-render.py')
    raw = sys.stdin.buffer.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError('conference renderer packet exceeds 64 MiB')
    packet = json.loads(raw.decode('utf-8'))
    sys.stdout.write(json.dumps(render_packet(packet), ensure_ascii=False))


if __name__ == '__main__':
    main()
