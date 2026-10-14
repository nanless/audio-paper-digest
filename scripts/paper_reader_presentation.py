"""Shared Reader presentation after each workflow authenticates its source records.

This module projects a verified record. It neither grants publication eligibility
nor changes source capabilities, identities, saved counts or evidence hashes.
"""

import copy

from blog_entry_loader import load_publish_to_blog


def build_reader_presentation(paper, *, plan, resources, authors,
                              exclude_resource_url=None, source_note=''):
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
    visible_resources = copy.deepcopy(resources)
    excluded = False
    if exclude_resource_url is not None:
        visible_resources = [resource for resource in visible_resources
                             if not exclude_resource_url(resource.get('originalUrl'))
                             and not exclude_resource_url(resource.get('finalUrl'))]
        excluded = len(visible_resources) != len(resources)
    summary = publisher._validated_detailed_core_summary(paper, parsed)
    summary = summary or str(plan.get('oneSentenceThesis') or '').strip()
    resource_block = publisher.render_verified_reader_resources(visible_resources, paper=paper)
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
