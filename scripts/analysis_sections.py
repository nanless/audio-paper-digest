"""识别论文评价的章节标题，兼容旧标题而不改写原文。"""

import re


EVALUATION_TITLE = '论文评价'
LEGACY_EVALUATION_TITLE = '毒舌点评'
_RENDERED_HEADING = re.compile(
    r'^(?:#{1,6}[ \t]+(?:[💡💬][ \t]*)?(?:\*\*)?'
    r'(论文评价|毒舌点评)(?:\*\*)?'
    r'|[💡💬][ \t]*(?:\*\*)?(论文评价|毒舌点评)(?:\*\*)?'
    r'|\*\*(论文评价|毒舌点评)\*\*)[ \t]*[：:]?[ \t]*$'
)


def _visible_lines(text):
    """返回代码围栏以外各行的位置及内容，位置指向原字符串。"""
    offset = 0
    fence = None
    for line in str(text or '').splitlines(keepends=True):
        body = line.rstrip('\r\n')
        marker = re.match(r'^[ \t]{0,3}(`{3,}|~{3,})(.*)$', body)
        if fence is not None:
            if marker and marker.group(1)[0] == fence[0] \
                    and len(marker.group(1)) >= fence[1] \
                    and not marker.group(2).strip():
                fence = None
        elif marker:
            fence = (marker.group(1)[0], len(marker.group(1)))
        else:
            yield offset, offset + len(line), body
        offset += len(line)


def _analysis_headings(text):
    """用同一规则读取一级标题的位置和名称。"""
    for start, end, line in _visible_lines(text):
        match = re.fullmatch(r'##(?!#)[ \t]*([^\r\n]+?)[ \t]*', line)
        if match:
            title = match.group(1).strip()
            title = re.sub(r'[：:]$', '', title).strip()
            yield start, end, title


def find_evaluation_headings(text, *, rendered=False):
    """返回实际评价标题的位置；普通句子和代码示例不算章节。"""
    if not rendered:
        return [(start, end, title) for start, end, title in _analysis_headings(text)
                if title in {EVALUATION_TITLE, LEGACY_EVALUATION_TITLE}]
    headings = []
    for start, end, line in _visible_lines(text):
        match = _RENDERED_HEADING.fullmatch(line)
        if match:
            headings.append((start, end, next(value for value in match.groups() if value)))
    return headings


def analysis_heading_titles(text):
    """按原顺序读取围栏外的一级分析章节，不改变正文。"""
    return [title for _start, _end, title in _analysis_headings(text)]


def evaluation_heading_issue(text, *, rendered=False):
    """只检查新旧评价标题是否重复，缺节仍由各调用方按原规则判断。"""
    if len(find_evaluation_headings(text, rendered=rendered)) > 1:
        return '论文评价章节重复或混用了新旧标题，必须只保留一个章节。'
    return None


def extract_evaluation_section(text, *, rendered=False):
    """读取唯一评价章节；没有标题或标题冲突时不选择其中一段。"""
    headings = find_evaluation_headings(text, rendered=rendered)
    if len(headings) != 1:
        return ''
    source = str(text or '')
    start = headings[0][1]
    end = len(source)
    for offset, _line_end, line in _visible_lines(source):
        if offset < start:
            continue
        boundary = re.match(r'^#{1,6}[ \t]+', line) if rendered \
            else re.match(r'^##(?!#)[ \t]*', line)
        if rendered and (re.match(r'^(?:📌|🔗|🏗️|📊|🔬|⚖️|🚨|📎)[ \t]*\*\*', line)
                         or re.fullmatch(r'---[ \t]*', line)):
            boundary = True
        if boundary:
            end = offset
            break
    return source[start:end].strip()


def normalize_analysis_section_title(title):
    """仅把旧评价标题对应到新章节名，用于检查副本。"""
    return EVALUATION_TITLE if title == LEGACY_EVALUATION_TITLE else title


if __name__ == '__main__':
    from runtime_guard import require_external_runtime
    require_external_runtime('analysis_sections.py')
