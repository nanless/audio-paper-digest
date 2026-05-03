#!/usr/bin/env python3
"""
全面审计所有博客中的图片问题
"""
import os, re, json, glob

BLOG_DIR = '/Users/francis7999/code/github_repos/audio-paper-digest-blog/content/posts'

def audit_blog(path):
    issues = []
    with open(path) as f:
        content = f.read()
    lines = content.split('\n')
    filename = os.path.basename(path)

    # 1. 检查残留的 icassp-img://
    if 'icassp-img://' in content:
        issues.append(('unconverted-url', '存在未转换的 icassp-img:// URL'))

    # 2. 收集所有图片行
    img_lines = []
    for i, line in enumerate(lines):
        if re.match(r'\s*!\[.*?\]\(.*?\)\s*$', line):
            img_lines.append((i, line))

    # 3. 检查图片是否夹在表格中间
    for i, line in img_lines:
        prev_non_empty = None
        next_non_empty = None
        for j in range(i-1, -1, -1):
            if lines[j].strip():
                prev_non_empty = lines[j].strip()
                break
        for j in range(i+1, len(lines)):
            if lines[j].strip():
                next_non_empty = lines[j].strip()
                break
        if prev_non_empty and prev_non_empty.startswith('|') and next_non_empty and next_non_empty.startswith('|'):
            issues.append(('image-in-table', f'第{i+1}行图片夹在表格中间: {line[:80]}'))

    # 4. 检查图片前后是否有空行（不在列表项中）
    for i, line in img_lines:
        # 检查前一行
        if i > 0 and lines[i-1].strip() and not lines[i-1].strip().startswith('#') and not lines[i-1].strip().startswith('- ') and not lines[i-1].strip().startswith('* '):
            issues.append(('no-blank-before', f'第{i+1}行图片前无空行: {line[:80]}'))
        # 检查后一行
        if i + 1 < len(lines) and lines[i+1].strip() and not lines[i+1].strip().startswith('![') and not lines[i+1].strip().startswith('- ') and not lines[i+1].strip().startswith('* ') and not lines[i+1].strip().startswith('|'):
            issues.append(('no-blank-after', f'第{i+1}行图片后无空行: {line[:80]}'))

    # 5. 检查文本中提到的图号与实际图片数量
    # 收集文本中提到的所有 "图X"
    fig_mentions = set()
    for line in lines:
        for m in re.finditer(r'[（(]?(?:如图|图)\s*(\d+)[）)]?', line):
            fig_mentions.add(int(m.group(1)))
        for m in re.finditer(r'Figure\s*(\d+)', line, re.I):
            fig_mentions.add(int(m.group(1)))

    # 统计实际图片数量
    actual_img_count = len(img_lines)
    # 如果文本中提到了图号但博客中没有对应数量的图片
    if fig_mentions:
        max_fig = max(fig_mentions)
        if max_fig > actual_img_count:
            issues.append(('missing-figures', f'文本提到图{max_fig}但博客只有{actual_img_count}张图片'))

    # 6. 检查图片描述是否过于泛泛
    for i, line in img_lines:
        m = re.match(r'!\[(.*?)\]\(', line)
        if m:
            desc = m.group(1).strip()
            if desc in ['论文中的图片', '论文配图', '图片', '']:
                issues.append(('generic-desc', f'第{i+1}行图片描述过于泛泛: "{desc}"'))

    # 7. 检查图片描述是否与周围文本矛盾
    # 例如：文本提到"图1"但图片在完全不同的上下文中
    for i, line in img_lines:
        m = re.match(r'!\[(.*?)\]\(', line)
        if not m:
            continue
        desc = m.group(1).lower()
        # 检查前后5行文本
        context = '\n'.join(lines[max(0,i-5):min(len(lines),i+6)])
        # 如果图片描述包含"频谱图"但上下文完全没有提到频谱
        if '频谱' in desc and '频谱' not in context.lower() and 'spectrogram' not in context.lower():
            issues.append(('desc-context-mismatch', f'第{i+1}行图片描述为频谱图但上下文未提及: {line[:80]}'))
        # 如果图片描述包含"架构"但上下文在讲实验结果
        if '架构' in desc and '架构' not in context.lower() and 'architecture' not in context.lower():
            # 检查是否在实验结果section
            section = ''
            for j in range(i, -1, -1):
                if lines[j].startswith('##') or lines[j].startswith('###'):
                    section = lines[j].lower()
                    break
            if '实验' in section or '结果' in section:
                issues.append(('wrong-section', f'第{i+1}行架构图出现在实验结果部分: {line[:80]}'))

    return issues, img_lines


def main():
    blogs = sorted(glob.glob(os.path.join(BLOG_DIR, '2026-05-03-*.md')))
    total_blogs = 0
    total_issues = 0
    issue_counts = {}
    blogs_with_issues = []

    for path in blogs:
        filename = os.path.basename(path)
        total_blogs += 1
        issues, img_lines = audit_blog(path)
        if issues:
            total_issues += len(issues)
            blogs_with_issues.append((filename, issues, len(img_lines)))
            for issue_type, _ in issues:
                issue_counts[issue_type] = issue_counts.get(issue_type, 0) + 1

    print(f'总博客数: {total_blogs}')
    print(f'有问题的博客: {len(blogs_with_issues)}')
    print(f'总问题数: {total_issues}')
    print()
    print('问题类型统计:')
    for t, c in sorted(issue_counts.items(), key=lambda x: -x[1]):
        print(f'  {t}: {c}')
    print()

    # 打印详细问题
    for filename, issues, img_count in blogs_with_issues:
        print(f'\n=== {filename} ({img_count}张图片) ===')
        for issue_type, detail in issues[:10]:  # 每篇最多显示10个
            print(f'  [{issue_type}] {detail}')
        if len(issues) > 10:
            print(f'  ... 还有 {len(issues)-10} 个问题')


if __name__ == '__main__':
    main()
