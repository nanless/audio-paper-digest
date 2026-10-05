#!/usr/bin/env python3
"""根据历史论文记录及其来源证明生成单篇论文页面。"""

import json
import base64
import hashlib
import os
import re
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from blog_entry_loader import load_publish_to_blog
from runtime_guard import require_external_runtime


DIRECT_PUBLICATION_SOURCE_CONTRACT = 'historical-direct-publication-source-v1'
DIRECT_PUBLICATION_METADATA_CONTRACT = 'historical-arxiv-publication-metadata-v1'
SHA256_RE = re.compile(r'^[a-f0-9]{64}$')
MAX_PACKET_BYTES = 64 * 1024 * 1024


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
            raise ValueError('未使用 arXiv 标识的历史页面输入不能携带 arXiv 发布来源记录。')
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
        raise ValueError('历史 arXiv 发布来源记录缺失、不是对象，或字段集合不符合要求。')
    abstract = publication_source.get('abstract')
    abstract_sha = publication_source.get('abstractSha256')
    fresh_source_details = projected.get('freshRewriteProvenance')
    if publication_source.get('contract') != DIRECT_PUBLICATION_SOURCE_CONTRACT \
            or publication_source.get('version') != 1 \
            or publication_source.get('paperId') != projected.get('directPaperId') \
            or publication_source.get('paperId') != f'arxiv:{arxiv_id}' \
            or not SHA256_RE.fullmatch(str(publication_source.get('sourceSnapshotSha256') or '')) \
            or not SHA256_RE.fullmatch(str(publication_source.get('sourceTextSha256') or '')) \
            or not isinstance(fresh_source_details, dict) \
            or publication_source.get('sourceSnapshotSha256') \
                != fresh_source_details.get('sourceSnapshotSha256') \
            or publication_source.get('sourceTextSha256') \
                != fresh_source_details.get('sourceSha256') \
            or not isinstance(abstract, str) or not abstract \
            or abstract != abstract.strip() or '\r' in abstract or '\0' in abstract \
            or len(abstract.encode('utf-8')) > 200000 \
            or not SHA256_RE.fullmatch(str(abstract_sha or '')) \
            or hashlib.sha256(abstract.encode('utf-8')).hexdigest() != abstract_sha:
        raise ValueError('历史 arXiv 发布来源记录的格式、论文对应关系、摘要内容或 SHA 不符合要求。')
    if not has_metadata_sidecar:
        raise ValueError('历史 arXiv 发布来源缺少元数据记录。')
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
                    != fresh_source_details.get('sourceManifestSha256') \
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
                or sidecar.get('generation') != fresh_source_details.get('sourceGeneration') \
                or sidecar.get('sourceName') != expected_source_name:
            raise ValueError('历史 arXiv 元数据记录的格式、日期顺序、来源版本或 SHA 对应关系不符合要求。')
    if projected.get('abstract') not in (None, abstract):
        raise ValueError('历史 arXiv 发布来源中的摘要与分析记录中的摘要不一致。')
    projected['abstract'] = abstract
    return projected


def render_packet(packet):
    paper = packet.get('paper')
    if 'tagMetadata' in packet and 'taxonomy' in packet:
        raise ValueError('页面生成输入不能同时包含 tagMetadata 和旧字段 taxonomy。')
    assignment = packet.get('tagMetadata') if 'tagMetadata' in packet else packet.get('taxonomy')
    date = packet.get('cohortDate')
    direct = packet.get('directStaging') is True
    if not isinstance(paper, dict):
        raise ValueError('历史页面生成输入中的论文记录必须为对象。')
    if direct:
        # 上游 Node 将直接历史重写结果与独立保存的来源及运行记录绑定。
        # 这一路径不读取旧页面对应表，也不另外导入后处理标签；
        # 下文从分析正文中的标签节和主标签字段重新解析。
        if not isinstance(paper.get('directPaperId'), str) or not paper['directPaperId']:
            raise ValueError('直接生成历史页面时，论文 ID 必须为非空字符串。')
        projected = dict(paper)
        projected = inject_direct_publication_source(
            projected, packet.get('publicationSource')
        )
    else:
        if packet.get('publicationSource') is not None:
            raise ValueError('非直接生成的历史页面输入不能携带发布来源记录。')
        if not isinstance(assignment, dict):
            raise ValueError('历史论文缺少有效的标签选择记录。')
        if assignment.get('status') != 'assigned' or assignment.get('paperId') != f'arxiv:{paper.get("arxivId")}':
            raise ValueError('历史论文的标签尚未完成分配，或标签记录属于另一篇论文。')
        concepts = {item['id']: item for item in assignment.get('concepts', [])}
        ordered = []
        for concept_id in [assignment.get('primaryTaskId'), assignment.get('primaryMethodId'), *assignment.get('conceptIds', [])]:
            if concept_id and concept_id not in ordered:
                ordered.append(concept_id)
        if any(concept_id not in concepts for concept_id in ordered):
            raise ValueError('历史论文的标签记录中，部分主标签或已选概念没有对应的概念记录。')
        if not isinstance(assignment.get('registryVersion'), str) \
                or not isinstance(assignment.get('registrySha256'), str):
            raise ValueError('历史论文的标签记录中，词表版本或 SHA 缺失，或不是字符串。')
        labels = [f'#{concepts[concept_id]["preferredLabel"]["zh"]}' for concept_id in ordered]
        projected = dict(paper)
    publisher = load_publish_to_blog()
    if direct and not projected.get('arxivId'):
        # 直接生成的会议论文没有 arXiv 标识，常规发布器生成引用资料时却需要它。
        # 因此这里直接生成会议论文的页面，不伪造 ID，也不修改已有会议页面。
        # 调用前，上游 Node 已核对解读正文、来源及展示记录的对应关系。
        parsed = publisher.parse_analysis(projected.get('analysis', ''))
        if not isinstance(parsed, dict):
            raise ValueError('无法将历史会议论文的分析正文解析为对象。')
        tag_metadata = publisher.build_flat_tag_compat_metadata(parsed, required=True)
        title = publisher.plain_title_for_publish(projected.get('title', ''))
        if not title:
            raise ValueError('历史会议论文的标题不能为空。')
        reader_title = str((projected.get('apiReaderPlan') or {}).get('readerTitle') or title).strip()
        article = str(projected.get('apiReaderArticle') or '').strip()
        if not article:
            raise ValueError('历史会议论文的解读正文不能为空。')
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
            f'paper_digest_tags_contract: {json.dumps(tag_metadata["contract"])}',
            f'paper_digest_tags_selection_contract: {json.dumps(tag_metadata["selectionContract"])}',
            f'paper_digest_tags_registry_version: {json.dumps(tag_metadata["registryVersion"])}',
            f'paper_digest_tags_registry_sha256: {json.dumps(tag_metadata["registrySha256"])}',
            f'paper_digest_tags_concepts: {json.dumps(tag_metadata["concepts"], ensure_ascii=False, separators=(",", ":"), sort_keys=True)}',
            f'paper_digest_primary_task: {json.dumps(tag_metadata["primaryTask"], ensure_ascii=False)}',
            f'paper_digest_primary_method: {json.dumps(tag_metadata["primaryMethod"], ensure_ascii=False)}',
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
    # 评分、摘要和正文须重新从保存的分析正文解析，不能直接使用缓存 parsed。
    # 非直接生成分支随后按已核对的标签记录更新标签元数据。
    projected['parsed'] = publisher.parse_analysis(paper.get('analysis', ''))
    if not isinstance(projected['parsed'], dict):
        raise ValueError('无法将历史论文的分析正文解析为对象，不能据此生成页面。')
    if not direct:
        projected['parsed']['tags'] = labels
        projected['parsed']['primaryTaskTag'] = f'#{concepts[assignment["primaryTaskId"]]["preferredLabel"]["zh"]}'
        projected['parsed']['primaryMethodTag'] = f'#{concepts[assignment["primaryMethodId"]]["preferredLabel"]["zh"]}'
        projected['parsed']['tagValidation'] = {
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


def read_packet_bytes(argv):
    if len(argv) == 1:
        raw = sys.stdin.buffer.read(MAX_PACKET_BYTES + 1)
    elif len(argv) == 3 and argv[1] == '--input-file':
        filename = Path(argv[2])
        if not filename.is_absolute():
            raise ValueError('页面生成输入文件必须使用绝对路径。')
        flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
        descriptor = os.open(filename, flags)
        try:
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                raise ValueError('页面生成输入必须是普通文件。')
            with os.fdopen(descriptor, 'rb', closefd=False) as handle:
                raw = handle.read(MAX_PACKET_BYTES + 1)
        finally:
            os.close(descriptor)
    else:
        raise ValueError('请通过标准输入提供页面生成数据，或使用 --input-file 指定 JSON 文件的绝对路径。')
    if len(raw) > MAX_PACKET_BYTES:
        raise ValueError('页面生成输入大小超过允许上限。')
    return raw


def main():
    require_external_runtime('historical-page-render.py')
    raw = read_packet_bytes(sys.argv)
    rendered = render_packet(json.loads(raw.decode('utf-8')))
    sys.stdout.write(json.dumps(rendered, ensure_ascii=False))


if __name__ == '__main__':
    main()
