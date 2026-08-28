"""Deterministic Markdown and rendered-Hugo gates for tutorial pages.

The functions are intentionally read-only.  They validate exact source or
rendered bytes and never repair content, so review remains an immutable
attestation step rather than another rewriting path.
"""

import html
import re
from pathlib import Path

from publish_common import (
    MANUAL_DEPTH_CONTRACT_VERSION_V5,
    PublishDataValidationError,
)
from tutorial_payload_verifier import (
    FRESH_AUTHORING_CONTRACT,
    MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT,
    TUTORIAL_FORMAT_CONTRACT,
)


LEGACY_TUTORIAL_FORMAT_CONTRACTS = frozenset({
    'graduate-researcher-tutorial-quality-v1',
})
TUTORIAL_SCORE_DIMENSIONS = (
    ('创新', '2'),
    ('技术严谨', '1.5'),
    ('实验充分', '1.5'),
    ('清晰度', '1'),
    ('影响力', '1.5'),
    ('开源', '1.5'),
    ('可复现', '0.5'),
    ('工程/实践', '1.5'),
)


def parse_frontmatter_content(path, content):
    """Parse frontmatter from already-read UTF-8 text without touching disk."""
    path = Path(path)
    try:
        import yaml
    except ImportError as exc:
        raise PublishDataValidationError(
            '缺少 PyYAML，无法执行确定性 frontmatter 门禁'
        ) from exc

    class UniqueKeyLoader(yaml.SafeLoader):
        pass

    def construct_mapping(loader, node, deep=False):
        mapping = {}
        for key_node, value_node in node.value:
            key = loader.construct_object(key_node, deep=deep)
            if key in mapping:
                raise PublishDataValidationError(
                    f'{path.name} frontmatter 存在重复字段: {key}'
                )
            mapping[key] = loader.construct_object(value_node, deep=deep)
        return mapping

    UniqueKeyLoader.add_constructor(
        yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
        construct_mapping,
    )
    match = re.match(r'^---\n(.*?)\n---\n', content, flags=re.DOTALL)
    if not match:
        raise PublishDataValidationError(f'{path.name} 缺少合法 YAML frontmatter')
    try:
        frontmatter = yaml.load(match.group(1), Loader=UniqueKeyLoader)
    except (yaml.YAMLError, PublishDataValidationError) as exc:
        raise PublishDataValidationError(
            f'{path.name} YAML 解析失败: {exc}'
        ) from exc
    if not isinstance(frontmatter, dict):
        raise PublishDataValidationError(f'{path.name} frontmatter 必须是对象')
    return frontmatter, content[match.end():]


def load_frontmatter(path):
    path = Path(path)
    content = path.read_text(encoding='utf-8')
    return parse_frontmatter_content(path, content)


def strip_fenced_code_for_format_gate(text):
    """Exclude fenced code: its delimiters are literal examples, not syntax."""
    return re.sub(
        r'(^|\n)(?:```|~~~).*?(?:\n(?:```|~~~)(?=\n|$)|\Z)',
        r'\1', text, flags=re.DOTALL,
    )


def format_gate_is_tutorial(frontmatter):
    return (
        isinstance(frontmatter, dict)
        and frontmatter.get('paper_digest_tutorial_contract') in {
            TUTORIAL_FORMAT_CONTRACT, *LEGACY_TUTORIAL_FORMAT_CONTRACTS,
        }
    )


def format_gate_is_current_tutorial(frontmatter):
    return (
        isinstance(frontmatter, dict)
        and frontmatter.get('paper_digest_tutorial_contract')
        == TUTORIAL_FORMAT_CONTRACT
    )


def markdown_table_count(text):
    return sum(
        1 for line in text.splitlines()
        if re.match(r'^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$', line)
    )


def markdown_image_count(text):
    return len(re.findall(r'(?<!\\)!\[[^\]\n]*\]\([^\)\n]+\)', text))


def heading_figure_table_number_issues(text, label):
    """Figures/tables belong in captions, never in a reader-section heading."""
    issues = []
    heading_re = re.compile(r'^#{1,6}\s+(.+?)\s*#*\s*$', re.MULTILINE)
    marker_re = re.compile(
        r'(?<![A-Za-z0-9])(?:图|Figure|表|Table)\s*\d+\b', re.IGNORECASE,
    )
    markdown_headings = heading_re.findall(text)
    headings = markdown_headings if markdown_headings else text.splitlines()
    for heading in headings:
        if marker_re.search(heading):
            issues.append(
                f'{label} 章节标题不得包含图/表编号: {heading.strip()}'
            )
    return issues


def math_and_emphasis_issues(text, label):
    """Fail closed on syntax Hugo may otherwise render as broken plain text."""
    clean = strip_fenced_code_for_format_gate(text)
    issues = []
    for opening, closing, name in (
            (r'\(', r'\)', r'\(…\)'), (r'\[', r'\]', r'\[…\]')):
        opens = len(re.findall(r'(?<!\\)' + re.escape(opening), clean))
        closes = len(re.findall(r'(?<!\\)' + re.escape(closing), clean))
        if opens != closes:
            issues.append(
                f'{label} 公式定界符 {name} 未配对: 开={opens}, 闭={closes}'
            )
    display_dollars = len(re.findall(r'(?<!\\)\$\$', clean))
    if display_dollars:
        issues.append(
            f'{label} 包含裸 $$；块级公式必须使用 \\[…\\] 而非 $$…$$'
        )
    if re.search(r'(?<![\\$])\$(?!\$)', clean):
        issues.append(
            f'{label} 包含裸 $；行内公式必须使用 \\(…\\) 而非 $…$'
        )
    bold_markers = len(re.findall(r'(?<!\\)\*\*', clean))
    if bold_markers % 2:
        issues.append(
            f'{label} Markdown 加粗标记 ** 未配对: {bold_markers} 个'
        )
    for match in re.finditer(r'\*\*[^*\n]+\*\*', clean):
        next_char = clean[match.end():match.end() + 1]
        if next_char and (
                next_char.isalnum() or '\u3400' <= next_char <= '\u9fff'):
            issues.append(
                f'{label} Markdown 加粗结束符后紧贴正文，必须补空格或标点'
            )
            break
    return issues


def tutorial_score_issues(text, label):
    if not re.search(r'(?:\*\*)?八维分项(?:：|:)(?:\*\*)?', text):
        return [f'{label} 缺少八维分项评分']
    issues = []
    for dimension, maximum in TUTORIAL_SCORE_DIMENSIONS:
        escaped = re.escape(dimension)
        if not re.search(
                rf'{escaped}\s+\d+(?:\.\d+)?\s*/\s*{re.escape(maximum)}\b',
                text):
            issues.append(
                f'{label} 八维评分缺少或格式非法: {dimension}/ {maximum}'
            )
    return issues


def validate_markdown_format_gate(path, frontmatter, body):
    """Validate reader-visible Markdown before Hugo can hide defects."""
    label = Path(path).name
    issues = math_and_emphasis_issues(body, label)
    is_manual_v5 = (
        isinstance(frontmatter, dict)
        and frontmatter.get('paper_digest_manual_depth')
        == MANUAL_DEPTH_CONTRACT_VERSION_V5
    )
    if not (format_gate_is_current_tutorial(frontmatter) or is_manual_v5):
        return issues
    if frontmatter.get('paper_digest_tutorial_contract') \
            != TUTORIAL_FORMAT_CONTRACT:
        issues.append(
            f'{label} Manual v5 缺少或降级了 {TUTORIAL_FORMAT_CONTRACT} 教程格式契约'
        )
    if frontmatter.get('paper_digest_fresh_authoring_contract') \
            != FRESH_AUTHORING_CONTRACT:
        issues.append(
            f'{label} 当前教程缺少 {FRESH_AUTHORING_CONTRACT} 冷启动作者凭证；'
            '旧 analysis/readerArticle/blog post 不得通过重排升级为新教程'
        )
    if frontmatter.get('paper_digest_tutorial_payload_contract') \
            != MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT:
        issues.append(
            f'{label} 当前教程缺少 {MANUAL_V5_TUTORIAL_PAYLOAD_CONTRACT} sealed payload'
        )
    for field in (
            'paper_digest_fresh_authoring_sha256',
            'paper_digest_reader_article_sha256',
            'paper_digest_tutorial_payload_sha256',
            'paper_digest_tutorial_quality_sha256',
            'paper_digest_tutorial_artifact_plan_sha256'):
        if not re.fullmatch(r'[a-f0-9]{64}', str(frontmatter.get(field) or '')):
            issues.append(
                f'{label} 当前教程缺少合法 64 位 SHA-256: {field}'
            )
    issues.extend(tutorial_score_issues(body, label))
    issues.extend(heading_figure_table_number_issues(body, label))
    return issues


def html_to_text(value):
    without_tags = re.sub(r'<[^>]+>', ' ', value or '')
    return re.sub(r'\s+', ' ', html.unescape(without_tags)).strip()


def rendered_page_candidates(output_dir, title, source_path=None):
    """Bind by deterministic post slug first, title scan only as fallback."""
    if source_path:
        direct = Path(output_dir) / 'posts' / Path(source_path).stem / 'index.html'
        if direct.is_file():
            try:
                return [(direct, direct.read_text(encoding='utf-8'))]
            except (OSError, UnicodeDecodeError):
                return []
    title = html_to_text(str(title or ''))
    if not title:
        return []
    candidates = []
    for path in Path(output_dir).rglob('*.html'):
        try:
            rendered = path.read_text(encoding='utf-8')
        except (OSError, UnicodeDecodeError):
            continue
        if title in html_to_text(rendered):
            candidates.append((path, rendered))
    return candidates


def rendered_article_fragment(rendered):
    """Avoid theme JavaScript/CSS when validating reader-visible HTML."""
    for tag in ('article', 'main'):
        match = re.search(
            rf'<{tag}\b[^>]*>(.*?)</{tag}>', rendered,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if match:
            return match.group(1)
    body = re.search(
        r'<body\b[^>]*>(.*?)</body>', rendered,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return body.group(1) if body else rendered


def validate_hugo_rendered_html_gate(output_dir, source_artifacts):
    """Validate tutorial artifacts in Hugo's actual rendered HTML."""
    issues = []
    for artifact in source_artifacts:
        frontmatter = artifact['frontmatter']
        if not format_gate_is_current_tutorial(frontmatter):
            continue
        source_label = Path(artifact['path']).name
        candidates = rendered_page_candidates(
            output_dir, frontmatter.get('title'), artifact.get('path'),
        )
        if len(candidates) != 1:
            issues.append(
                f'{source_label} Hugo 渲染页无法唯一按标题绑定: '
                f'{len(candidates)} 个候选'
            )
            continue
        rendered_path, rendered = candidates[0]
        reader_html = rendered_article_fragment(rendered)
        rendered_label = f'{source_label} -> {rendered_path.name}'
        issues.extend(math_and_emphasis_issues(reader_html, rendered_label))
        if '**' in reader_html:
            issues.append(
                f'{rendered_label} Hugo HTML 残留 Markdown 加粗标记 **'
            )
        rendered_text = html_to_text(reader_html)
        issues.extend(tutorial_score_issues(rendered_text, rendered_label))
        expected_tables = markdown_table_count(artifact['body'])
        expected_images = markdown_image_count(artifact['body'])
        actual_tables = len(re.findall(
            r'<table\b', reader_html, flags=re.IGNORECASE,
        ))
        actual_images = len(re.findall(
            r'<img\b', reader_html, flags=re.IGNORECASE,
        ))
        if actual_tables < expected_tables:
            issues.append(
                f'{rendered_label} Hugo 表格数量不足: '
                f'Markdown={expected_tables}, HTML={actual_tables}'
            )
        if actual_images < expected_images:
            issues.append(
                f'{rendered_label} Hugo 图片数量不足: '
                f'Markdown={expected_images}, HTML={actual_images}'
            )
        headings = '\n'.join(
            html_to_text(value)
            for value in re.findall(
                r'<h[1-6]\b[^>]*>(.*?)</h[1-6]>', reader_html,
                flags=re.IGNORECASE | re.DOTALL,
            )
        )
        issues.extend(
            heading_figure_table_number_issues(headings, rendered_label)
        )
    return issues
