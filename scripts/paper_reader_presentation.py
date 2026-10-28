"""Shared Reader presentation after each workflow authenticates its source records.

This module projects a verified record. It neither grants publication eligibility
nor changes source capabilities, identities, saved counts or evidence hashes.
"""

import copy
import hashlib
import json
import math
import os
import re
from pathlib import Path
import shutil
import tempfile
from publication_local_replay import (checked_replay_response, publication_replay_result, publication_replay_scope)

from blog_entry_loader import load_publish_to_blog
from publish_common import escape_html_like_tags

SCORE_DIMENSIONS = (
    ('innovationScore', '创新', '2'), ('technicalRigorScore', '技术严谨', '1.5'),
    ('experimentalSufficiencyScore', '实验充分', '1.5'), ('clarityScore', '清晰度', '1'),
    ('impactScore', '影响力', '1.5'), ('openSourceScore', '开源', '1.5'),
    ('reproducibilityScore', '可复现', '0.5'), ('engineeringScore', '工程/实践', '1.5'),
)


def reader_score_line(parsed):
    """Format the same eight-dimensional scale after workflow qualification."""
    try:
        score = float(parsed.get('score'))
        dimensions = [(label, float(parsed.get(field)), maximum)
                      for field, label, maximum in SCORE_DIMENSIONS]
    except (TypeError, ValueError, OverflowError):
        raise ValueError('总分或八个评分维度缺失，或无法转换为数字。') from None
    if not math.isfinite(score) or not 0 <= score <= 10 or any(
            not math.isfinite(value) or not 0 <= value <= float(maximum)
            for _, value, maximum in dimensions):
        raise ValueError('总分或评分维度的数值不在允许范围内。')
    detail = ' | '.join(f'{label} {value:.1f}/{maximum}' for label, value, maximum in dimensions)
    return f'**{score:.1f}/10** | {detail}'


def build_aggregate_reader_presentations(records, *, publisher=None):
    """Display only; source/completion/set authority stays in each Node caller.

    Detailed summaries still run the same cold stage replay as a paper page.
    No success token, saved record, receipt or eligibility is returned.
    """
    if not isinstance(records, list) or not 1 <= len(records) <= 8:
        raise ValueError('汇总展示每批必须包含 1–8 篇已核验记录。')
    publisher = publisher if publisher is not None else load_publish_to_blog()
    output, seen = [], set()
    for record in records:
        if not isinstance(record, dict) or set(record) != {'paperKey', 'paper', 'resources', 'sourceText'}:
            raise ValueError('汇总展示记录必须精确包含论文键、原论文及可见资源。')
        key, paper, resources = record['paperKey'], record['paper'], record['resources']
        if not isinstance(key, str) or not key or len(key) > 500 or key in seen \
                or not isinstance(paper, dict) or not isinstance(resources, list) \
                or not isinstance(paper.get('apiReaderPlan'), dict) \
                or not isinstance(record['sourceText'], str) or not record['sourceText'] \
                or hashlib.sha256(record['sourceText'].encode()).hexdigest() != paper.get('sourceSha256'):
            raise ValueError('汇总展示记录的身份、原 Reader 计划或资源列表无效。')
        seen.add(key)
        parsed = publisher.parse_analysis(paper.get('analysis', ''))
        if not isinstance(parsed, dict):
            raise ValueError('汇总展示需要可重新解析的正式分析正文。')
        with publication_replay_scope(paper, record['sourceText'], publisher=publisher):
            decision = resolve_reader_decision_display(publisher, paper,
                plan=paper['apiReaderPlan'], resources=resources, parsed=parsed, source_text=record['sourceText'])
        output.append({'paperKey': key, **decision, 'scoreLine': reader_score_line(parsed)})
    return output


def normalize_repeated_bold_prefixes(value):
    """Project identical adjacent bold labels, preserving quoted/code bytes.

    Balanced inline-code atoms can belong to a repeated whole label; their
    bytes remain opaque and only exactly identical atoms compare equal.
    This only narrows the old daily display rule outside ordinary Reader prose.
    It does not normalize numeric values, TeX, source evidence or image labels.
    """
    pattern = re.compile(r'\*\*[ \t]*([^*\n]+?)([：:])\*\*'
                         r'(?:[ \t]*\*\*[ \t]*\1\2\*\*)+[ \t]*')
    protected = re.compile(
        r'`+'
        r'|!?\[(?:\\.|[^\]\\\n])*\]\((?:\\.|[^)\\\n])*\)'
        r'|<?https?://[^\s<>]+>?')
    output, fence = [], None
    for line in str(value or '').splitlines(keepends=True):
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', line)
        if fence is not None:
            output.append(line)
            if re.fullmatch(r' {0,3}' + re.escape(fence[0]) + '{' + str(len(fence))
                            + r',}[ \t]*', line.rstrip('\r\n')):
                fence = None
            continue
        if marker:
            fence = marker[1]; output.append(line); continue
        if re.match(r'^\s*(?:>\s*|\*论文图\s)', line) or re.match(r'^(?: {4}|\t)', line):
            output.append(line); continue
        # Mask complete code atoms within a prose segment, rather than splitting
        # a whole bold label at each atom. Equal raw atoms share a token so the
        # existing whole-label backreference still requires exact equality.
        prefix = '\x00reader-code:'
        while prefix in line:
            prefix += '\x00'
        atoms, prose, parts, start = {}, [], [], 0

        def flush_prose():
            projected = pattern.sub(r'**\1\2** ', ''.join(prose))
            for raw, token in atoms.items():
                projected = projected.replace(token, raw)
            parts.append(projected)
            prose.clear()

        while (match := protected.search(line, start)) is not None:
            end = match.end()
            prose.append(line[start:match.start()])
            if match[0].startswith('`'):
                cursor = match.start()
                while cursor > 0 and line[cursor - 1] == '\\':
                    cursor -= 1
                escaped = (match.start() - cursor) % 2 == 1
                closing = (None if escaped else
                           re.compile(r'(?<!`)' + re.escape(match[0]) + r'(?!`)').search(line, end))
                # Unknown/unclosed code-like text is left intact as a
                # conservative display restriction, not parsed as Markdown.
                if closing:
                    end = closing.end()
                    raw = line[match.start():end]
                    token = atoms.setdefault(raw, prefix + str(len(atoms)) + '\x00')
                    prose.append(token)
                    start = end
                    continue
                end = len(line)
            # Links, URLs and unclosed code remain barriers: no label match
            # may cross them or inspect their bytes.
            flush_prose()
            parts.append(line[match.start():end])
            start = end
        prose.append(line[start:])
        flush_prose()
        output.append(''.join(parts))
    return ''.join(output)


def replay_resource_presentation(paper, source_text, publication_evidence=None, *, publisher=None):
    """复用同一只读来源及声明核验桥；返回临时视图，不改原身份。"""
    if not isinstance(source_text, str) or hashlib.sha256(source_text.encode()).hexdigest() != paper.get('sourceSha256'):
        raise ValueError('资源展示必须绑定同篇封存全文 SHA。')
    publisher = publisher if publisher is not None else load_publish_to_blog()
    node = shutil.which('node')
    if not node:
        raise ValueError('资源展示的公共声明重放需要 Node.js。')
    root = Path(__file__).resolve().parents[1]
    request = {'paper': paper, 'sourceText': source_text, 'resourcePresentation': True}
    authenticated_pdf_tables = any(isinstance(binding, dict) and 'authenticatedPdfTableEvidence' in binding
                            for binding in (paper.get('apiReaderPlan') or {}).get('tableBindings', []))
    authenticated_pdf_resources = any(isinstance(resource, dict) and 'authenticatedPdfFootnoteEvidence' in resource
                                      for resource in (paper.get('apiReaderResources') or {}).get('resources', []))
    authenticated_pdf = authenticated_pdf_tables or authenticated_pdf_resources
    source_correction = paper.get('conferenceSourceCorrection')
    declared_source_correction = isinstance(source_correction, dict) and source_correction.get('contract') in {
        'conference-source-resource-correction-v1', 'conference-source-core-correction-v1'}
    if publication_evidence is not None:
        request['publicationEvidence'] = publication_evidence
    payload = json.dumps(request,
                         ensure_ascii=False, separators=(',', ':')).encode()
    if len(payload) > 128 * 1024 * 1024:
        raise ValueError('资源展示的来源重放输入超过上限。')
    value = publication_replay_result(paper, source_text, publication_evidence)
    if value is None:
        with tempfile.TemporaryFile() as source:
            source.write(payload); source.flush(); source.seek(0)
            timeout_seconds = 180 if publication_evidence is not None or authenticated_pdf or declared_source_correction else 30
            result = publisher._run_bounded_subprocess(
                [node, str(root / 'scripts/lib/reader-resource-claims-replay-cli.js'), str(source.fileno())],
                cwd=str(root), env={key: value for key, value in os.environ.items()
                                   if key not in {'NODE_OPTIONS', 'NODE_PATH'}},
                # Declared source corrections also replay their original canonical
                # source, even without table/footnote markers. Node still verifies
                # the complete chain; this declaration only selects its time bound.
                timeout_seconds=timeout_seconds,
                max_output_bytes=1024 * 1024, pass_fds=(source.fileno(),))
        value = checked_replay_response(result, worker='reader-resource-claims-replay-cli.js',
                                       timeout_seconds=timeout_seconds)
    if value.get('verified') is not True or not isinstance(value.get('resources'), list):
        raise ValueError('资源展示或正文声明未通过当前封存来源核验：' + str(value.get('message', '')))
    if publication_evidence is not None or authenticated_pdf_tables:
        # Only this fresh response from the source-replaying generic worker may
        # supplement the quality check. Original plan/bindings stay untouched.
        if not isinstance(value.get('tableEvidence'), dict):
            raise ValueError('会议出版补充引文缺少公共来源重放结果。')
        publisher._validate_api_reader_source_bindings(paper,
            publication_table_evidence=value.get('tableEvidence'))
    return value['resources']


def resolve_reader_decision_display(publisher, paper, *, plan, resources, parsed, source_text=None):
    """Resolve display fields through the caller's already loaded publisher.

    This is a read-only resolver, not pure computation: the detailed summary
    still undergoes its normal source/paid-stage replay. Callers retain their
    own Reader/source gates and resource filtering. The returned strings grant
    no publication eligibility and never replace saved evidence.
    """
    resource_block = publisher.render_verified_reader_resources(resources, paper=paper)
    if source_text is not None:
        resource_block = resource_block.replace('- 第三方资源：', '- 论文所列链接：')
    scoring_block = publisher.render_verified_reader_scoring_notes(paper, parsed=parsed)
    summary = (publisher._validated_detailed_core_summary(paper, parsed, source_text=source_text)
               if source_text is not None else publisher._validated_detailed_core_summary(paper, parsed))
    summary = summary or str(plan.get('oneSentenceThesis') or '').strip()
    # Display-only correction shared by daily, conference and historical pages.
    summary = summary.replace(
        '音频推测推测解码 Audio Speculative Speculative Decoding',
        '音频推测解码 Audio Speculative Decoding',
    )
    # Match paper-page literal-token display without altering signed summary bytes.
    summary = escape_html_like_tags(summary)
    return {'summary': summary, 'resourceBlock': resource_block,
            'scoringBlock': scoring_block}


def build_reader_presentation(paper, *, plan, resources, authors,
                              exclude_resource_url=None, source_note='', source_text=None,
                              publication_evidence=None, publisher=None):
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
    publisher = publisher if publisher is not None else load_publish_to_blog()
    parsed = publisher.parse_analysis(paper.get('analysis', ''))
    if not isinstance(parsed, dict):
        raise ValueError('Reader 展示需要可重新解析的正式分析正文。')
    if publication_evidence is not None and source_text is None:
        raise ValueError('会议出版补充引文不能脱离同篇封存来源。')
    visible_resources = (replay_resource_presentation(
        paper, source_text, publication_evidence, publisher=publisher) if source_text is not None
                         else copy.deepcopy(resources))
    excluded = False
    if exclude_resource_url is not None:
        visible_resources = [resource for resource in visible_resources
                             if not exclude_resource_url(resource.get('originalUrl'))
                             and not exclude_resource_url(resource.get('finalUrl'))]
        excluded = len(visible_resources) != len(resources)
    decision = resolve_reader_decision_display(
        publisher, paper, plan=plan, resources=visible_resources, parsed=parsed, source_text=source_text)
    resource_block = decision['resourceBlock']
    if source_text is not None:
        # A mentioned project URL does not prove third-party ownership or release.
        resource_block = resource_block.replace('- 第三方资源：', '- 论文所列链接：')
    if excluded:
        resource_block += ('\n\n预印本/扩展版链接未在会议页展示；'
                           '会议版来源见页首官方记录与 PDF。')
    return {
        'summary': decision['summary'],
        'authors': copy.deepcopy(authors),
        'authorBlock': publisher.render_verified_reader_authors(authors, source_note=source_note),
        'resourceBlock': resource_block,
        'scoringBlock': decision['scoringBlock'],
    }


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('paper_reader_presentation.py')
    raise SystemExit('此模块由三流程页面生成器调用，不是独立任务入口。')
