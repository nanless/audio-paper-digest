"""Shared Reader presentation after each workflow authenticates its source records.

This module projects a verified record. It neither grants publication eligibility
nor changes source capabilities, identities, saved counts or evidence hashes.
"""

import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from blog_entry_loader import load_publish_to_blog


def replay_resource_presentation(paper, source_text, publication_evidence=None):
    """复用同一只读来源及声明核验桥；返回临时视图，不改原身份。"""
    if not isinstance(source_text, str) or hashlib.sha256(source_text.encode()).hexdigest() != paper.get('sourceSha256'):
        raise ValueError('资源展示必须绑定同篇封存全文 SHA。')
    publisher = load_publish_to_blog()
    node = shutil.which('node')
    if not node:
        raise ValueError('资源展示的公共声明重放需要 Node.js。')
    root = Path(__file__).resolve().parents[1]
    request = {'paper': paper, 'sourceText': source_text, 'resourcePresentation': True}
    if publication_evidence is not None:
        request['publicationEvidence'] = publication_evidence
    payload = json.dumps(request,
                         ensure_ascii=False, separators=(',', ':')).encode()
    if len(payload) > 128 * 1024 * 1024:
        raise ValueError('资源展示的来源重放输入超过上限。')
    with tempfile.TemporaryFile() as source:
        source.write(payload); source.flush(); source.seek(0)
        result = publisher._run_bounded_subprocess(
            [node, str(root / 'scripts/lib/reader-resource-claims-replay-cli.js'), str(source.fileno())],
            cwd=str(root), env={key: value for key, value in os.environ.items()
                               if key not in {'NODE_OPTIONS', 'NODE_PATH'}},
            # Cold conference evidence replays the authenticated original PDF
            # twice; keep the ordinary resource-only bridge at its short bound.
            timeout_seconds=180 if publication_evidence is not None else 30,
            max_output_bytes=1024 * 1024, pass_fds=(source.fileno(),))
    try:
        value = json.loads(result.stdout)
    except (ValueError, TypeError) as error:
        raise ValueError('资源展示的公共来源重放响应无效。') from error
    if result.returncode != 0 or result.timed_out or result.output_truncated \
            or value.get('verified') is not True or not isinstance(value.get('resources'), list):
        raise ValueError('资源展示或正文声明未通过当前封存来源核验：' + str(value.get('message', '')))
    if publication_evidence is not None:
        # Only this fresh response from the source-replaying generic worker may
        # supplement the quality check. Original plan/bindings stay untouched.
        if not isinstance(value.get('tableEvidence'), dict):
            raise ValueError('会议出版补充引文缺少公共来源重放结果。')
        publisher._validate_api_reader_source_bindings(paper,
            publication_table_evidence=value.get('tableEvidence'))
    return value['resources']


def build_reader_presentation(paper, *, plan, resources, authors,
                              exclude_resource_url=None, source_note='', source_text=None,
                              publication_evidence=None):
    """Use daily presentation rules without inventing an arXiv source identity.

    Callers must first validate their Reader and source contracts. Requiring the
    exact saved objects here prevents accidental substitution of a display view
    for the original author or resource evidence.
    """
    if not isinstance(paper, dict) or plan != paper.get('apiReaderPlan'):
        raise ValueError('Reader 展示计划必须对应本篇保存的原计划。')
    raw_authors = paper.get('apiReaderAuthors')
    raw_resources = paper.get('apiReaderResources')
    if not isinstance(raw_authors, dict) or authors != raw_authors.get('authors'):
        raise ValueError('Reader 展示作者必须对应本篇保存的原作者记录。')
    if not isinstance(raw_resources, dict) or resources != raw_resources.get('resources'):
        raise ValueError('Reader 展示资源必须对应本篇保存的原资源记录。')
    publisher = load_publish_to_blog()
    parsed = publisher.parse_analysis(paper.get('analysis', ''))
    if not isinstance(parsed, dict):
        raise ValueError('Reader 展示需要可重新解析的正式分析正文。')
    if publication_evidence is not None and source_text is None:
        raise ValueError('会议出版补充引文不能脱离同篇封存来源。')
    visible_resources = (replay_resource_presentation(paper, source_text, publication_evidence) if source_text is not None
                         else copy.deepcopy(resources))
    excluded = False
    if exclude_resource_url is not None:
        visible_resources = [resource for resource in visible_resources
                             if not exclude_resource_url(resource.get('originalUrl'))
                             and not exclude_resource_url(resource.get('finalUrl'))]
        excluded = len(visible_resources) != len(resources)
    summary = publisher._validated_detailed_core_summary(paper, parsed)
    summary = summary or str(plan.get('oneSentenceThesis') or '').strip()
    resource_block = publisher.render_verified_reader_resources(visible_resources, paper=paper)
    if source_text is not None:
        # A mentioned project URL does not prove third-party ownership or release.
        resource_block = resource_block.replace('- 第三方资源：', '- 论文所列链接：')
    if excluded:
        resource_block += ('\n\n预印本/扩展版链接未在会议页展示；'
                           '会议版来源见页首官方记录与 PDF。')
    return {
        'summary': summary,
        'authors': copy.deepcopy(authors),
        'authorBlock': publisher.render_verified_reader_authors(authors, source_note=source_note),
        'resourceBlock': resource_block,
        'scoringBlock': publisher.render_verified_reader_scoring_notes(paper, parsed=parsed),
    }


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('paper_reader_presentation.py')
    raise SystemExit('此模块由三流程页面生成器调用，不是独立任务入口。')
