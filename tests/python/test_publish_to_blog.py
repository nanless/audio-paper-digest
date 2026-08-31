import importlib.util
import contextlib
import copy
import hashlib
import io
import json
import os
import re
import subprocess
import struct
import sys
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MODULE_PATH = os.path.join(ROOT, 'scripts', 'publish-to-blog.py')
sys.path.insert(0, os.path.join(ROOT, 'scripts'))
from publish_common import (  # noqa: E402
    PublishDataValidationError,
    _manual_v6_hash,
    _validate_publish_image_exclusion_view,
    _manual_v6_text,
    _manual_v6_text_sha,
    validate_manual_v6_payload,
    validate_image_narrative_contract,
)
import markdown_hugo_gate  # noqa: E402
import tutorial_payload_verifier  # noqa: E402
SPEC = importlib.util.spec_from_file_location('publish_to_blog', MODULE_PATH)
publish_to_blog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publish_to_blog)
REVIEW_SPEC = importlib.util.spec_from_file_location(
    'review_blog_for_publish_test', os.path.join(ROOT, 'scripts', 'review-blog.py'),
)
review_blog = importlib.util.module_from_spec(REVIEW_SPEC)
REVIEW_SPEC.loader.exec_module(review_blog)


@contextlib.contextmanager
def manual_v5_fresh_files(paper, date_str, *, official_project_evidence=False):
    """Attach a real file-backed fresh-authoring receipt to a v5 fixture."""
    with tempfile.TemporaryDirectory() as tmp:
        current = Path(tmp) / 'current'
        paper_id = publish_to_blog.normalize_arxiv_id(paper['arxivId'])
        article = paper['analysisManifest']['manualTakeover']['readerArticle']
        article_path = current / 'manual-tutorial-previews' / date_str / paper_id / 'draft' / 'article.md'
        evidence_root = current / 'manual-full-text' / date_str
        source_path = evidence_root / f'{paper_id}.txt'
        artifact_path = evidence_root / 'artifacts' / f'{paper_id}.json'
        filtered_path = current / 'filtered-papers.json'
        for target in (article_path, source_path, artifact_path, filtered_path):
            target.parent.mkdir(parents=True, exist_ok=True)
        article_path.write_text(article, encoding='utf-8')
        source_path.write_text('current paper source evidence', encoding='utf-8')
        artifact_identity = 'd' * 64
        artifact_path.write_text(json.dumps({
            'paperId': paper_id,
            'inventoryHealth': {'status': 'complete', 'issues': []},
            'artifactIndexSha256': artifact_identity,
            'tables': [], 'figures': [], 'formulas': [],
        }, ensure_ascii=False), encoding='utf-8')
        filtered_path.write_text(json.dumps({
            'batchDate': date_str, 'status': 'complete',
            'papers': [{'arxivId': paper_id, 'title': paper['title']}],
        }, ensure_ascii=False), encoding='utf-8')
        paths = {
            'paper_metadata': filtered_path,
            'source_snapshot': source_path,
            'artifact_index': artifact_path,
            'authoring_prompt': Path(ROOT) / 'prompts' / 'manual-tutorial-article.md',
            'editorial_contract': Path(ROOT) / 'docs' / 'manual-editorial-reference-contract.md',
            'blank_schema': Path(ROOT) / 'scripts' / 'manual-tutorial-quality-contract.js',
        }
        if official_project_evidence:
            evidence_path = evidence_root / 'external-evidence' / f'{paper_id}-official-project.json'
            evidence_path.parent.mkdir(parents=True, exist_ok=True)
            evidence_path.write_text(json.dumps({
                'paperId': paper_id,
                'kind': 'official_project_evidence',
                'url': f'https://example.org/projects/{paper_id}',
            }, ensure_ascii=False), encoding='utf-8')
            paths['official_project_evidence'] = evidence_path
        normalize = lambda value: __import__('unicodedata').normalize(  # noqa: E731
            'NFKC', value.replace('\r\n', '\n').replace('\r', '\n')
        ).strip()
        receipt = {
            'contract': 'fresh-authoring-v1', 'mode': 'fresh_from_evidence',
            'authoringSessionId': f'fresh-{paper_id}-test-session',
            'articlePath': str(article_path.resolve()),
            'articleSha256': hashlib.sha256(normalize(article).encode('utf-8')).hexdigest(),
            'articleFileSha256': hashlib.sha256(article_path.read_bytes()).hexdigest(),
            'prohibitedProseInputs': [],
            'inputs': [{
                'kind': kind, 'path': str(target.resolve()),
                'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
            } for kind, target in paths.items()],
        }
        receipt['receiptSha256'] = publish_to_blog._stable_json_sha256(receipt)
        takeover = paper['analysisManifest']['manualTakeover']
        takeover['freshAuthoring'] = receipt
        takeover['freshAuthoringSha256'] = publish_to_blog._stable_json_sha256(receipt)
        payload_root = current / 'manual-tutorial-previews' / date_str / paper_id
        quality_path = payload_root / 'quality.json'
        plan_path = payload_root / 'artifact-plan.json'
        plan = {
            'version': 1, 'paperId': paper_id,
            'artifactIndexSha256': artifact_identity,
            'tables': [], 'figures': [], 'formulas': [],
            'coverageMatrix': {'tables': [], 'figures': [], 'formulas': []},
        }
        plan_binding_sha = hashlib.sha256(json.dumps(
            plan, ensure_ascii=False, separators=(',', ':'),
        ).encode('utf-8')).hexdigest()
        quality = {
            'version': 2,
            'contract': 'graduate-researcher-tutorial-quality-v2',
            'paperId': paper_id,
            'freshAuthoring': {
                key: receipt[key] for key in (
                    'contract', 'mode', 'authoringSessionId', 'articleSha256',
                    'articleFileSha256', 'prohibitedProseInputs', 'inputs',
                )
            },
            'artifactPlan': {
                'version': 1, 'paperId': paper_id, 'sha256': plan_binding_sha,
            },
            'artifactDisposition': {'tables': [], 'figures': []},
        }
        quality_path.write_text(json.dumps(quality, ensure_ascii=False, indent=2), encoding='utf-8')
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding='utf-8')
        normalized_article = normalize(article)
        validation = {
            'contract': 'graduate-researcher-tutorial-quality-v2',
            'paperId': paper_id,
            'articleSha256': receipt['articleSha256'],
            'articleCharacters': len(normalized_article),
            'sectionCount': len(re.findall(r'^###\s+[^#\n].*$', normalized_article, flags=re.MULTILINE)),
            'tableCount': 0, 'figureCount': 0,
        }
        payload = {
            'contract': 'manual-v5-tutorial-payload-v1',
            'orchestratorContract': 'manual-tutorial-validation-orchestrator-v1',
            'orchestratorFingerprint': publish_to_blog.MANUAL_TUTORIAL_ORCHESTRATOR_FINGERPRINT,
            'qualityContract': 'graduate-researcher-tutorial-quality-v2',
            'paperId': paper_id,
            'articleSha256': receipt['articleSha256'],
            'freshAuthoringReceiptSha256': receipt['receiptSha256'],
            'artifactIndexSha256': artifact_identity,
            'qualityPath': str(quality_path.resolve()),
            'qualityFileSha256': hashlib.sha256(quality_path.read_bytes()).hexdigest(),
            'qualityPacketSha256': publish_to_blog._stable_json_sha256(quality),
            'artifactPlanPath': str(plan_path.resolve()),
            'artifactPlanFileSha256': hashlib.sha256(plan_path.read_bytes()).hexdigest(),
            'artifactPlanSha256': publish_to_blog._stable_json_sha256(plan),
            'artifactPlanBindingSha256': plan_binding_sha,
            'validation': validation,
        }
        payload['receiptSha256'] = publish_to_blog._stable_json_sha256(payload)
        takeover['tutorialPayload'] = payload
        takeover['tutorialPayloadSha256'] = publish_to_blog._stable_json_sha256(payload)
        paper['analysisManifest']['contracts']['tutorialPayload'] = 'manual-v5-tutorial-payload-v1'
        with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
            yield paper


def manual_v6_publication_fixture():
    """Small but complete canonical v6 record using the real cross-runtime hashes."""
    paper_id = '2608.30001'
    matrix = [['系统', 'WER↓'], ['强基线', '8.4%'], ['完整方法', '7.1%']]
    matrix_sha = hashlib.sha256(json.dumps(
        matrix, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
    table = {
        'id': 'T1', 'kind': 'result', 'caption': 'LibriSpeech test-clean 完整结果',
        'matrix': matrix, 'matrixSha256': matrix_sha,
    }
    rendered_table = (
        '**LibriSpeech test-clean 完整结果**\n\n'
        '| 系统 | WER↓ |\n| --- | --- |\n| 强基线 | 8.4% |\n| 完整方法 | 7.1% |'
    )
    formula_raw = 'L = -log p(y|x)'
    formula_explanation = '这个负对数似然把目标序列概率转成可优化损失；概率越高损失越低，但它本身不等于最终词错率。'
    term = 'WER'
    definition = '词错误率，表示替换、删除与插入错误总数除以参考词数，数值越低越好。'
    relationship = '该引用提供同一语音识别任务上的强基线与常用评测设置。'
    difference = '本文的差异在于显式加入双路径声学表示，并报告同一测试集上的直接比较。'
    block_specs = [
        ('B1', 'prerequisites', '先补齐评测前提', f'{term} 指 {definition} 读者应先区分训练目标与最终任务指标：前者约束参数更新，后者才回答识别输出是否改善。本文后续所有百分比都限定在明确测试划分，不能跨语料直接比较。'),
        ('B2', 'problem', '论文究竟解决什么问题', '现有系统让同一表示同时承担声学细节保留与语言抽象，两种需求会争用容量。论文要检验的是：把职责拆成互补路径后，能否在相同训练数据与测试划分上降低识别错误，同时不把额外模块误说成普遍收益。'),
        ('B3', 'related_work', '相关工作与真正差异', f'{relationship} {difference} 这意味着读者应比较同条件数值与结构职责，而不是只看模型名称是否更新。引用只负责建立比较坐标，不替代本文自己的实验与消融证据。'),
        ('B4', 'architecture', '沿信号路径理解双分支', '输入波形先变换为声学特征，然后分别进入保留局部细节的声学分支与汇聚长程信息的语义分支；融合层在解码前对齐两种时间尺度，最终输出词序列。这个顺序说明每个组件接收什么、产生什么以及信息在哪里会合。'),
        ('B5', 'training', '训练目标如何约束组件', f'训练联合优化序列目标与辅助对齐项，其中 {formula_raw}。{formula_explanation} 两个分支共同反向传播，但评测结论仍必须来自解码后的 WER，不能用训练损失下降替代任务效果。'),
        ('B6', 'experiment_setup', '实验设置先限定比较边界', '实验在 LibriSpeech test-clean 上比较完整方法与强基线，报告相同方向的 WER，并保持数据划分和解码口径一致。这个设置能回答当前语料上的相对收益，却不能回答跨语言、噪声条件或真实设备延迟。'),
        ('B7', 'result', '逐行读取完整结果表', f'结果表保留表头、全部系统行与每一个报告数值，避免只摘最好数字。\n\n{rendered_table}\n\n完整方法由 8.4% 降到 7.1%，绝对改善 1.3 个百分点；方向与 WER 越低越好一致，但表中没有置信区间，不能据此声称统计显著。'),
        ('B8', 'reproduction', '复现时如何核对同一口径', '复现者应固定训练与测试划分、分词方式、解码参数和 WER 计算脚本，并逐项核对双分支输出形状与融合位置。若代码未公开，应把未报告超参数登记为风险，不应自行补值后仍声称完全复现。'),
        ('B9', 'limitation', '证据支持到哪里为止', '当前证据只覆盖单一公开测试划分，缺少跨语料泛化、统计区间和真实部署测量。结果支持双路径在该设置下降低 WER，却不支持对所有语言、噪声环境或硬件平台的普遍外推。后续工作需要补齐这些边界实验。'),
    ]
    blocks = []
    for block_id, kind, heading, markdown in block_specs:
        if len(markdown) < 120:
            markdown = (
                f'{markdown} 本节围绕“{heading}”补充输入、比较口径、可核对证据与不能外推的边界，'
                '使研究生能够从前一节点继续推导到下一节点，而不是只记住孤立术语。'
            )
        blocks.append({
            'id': block_id, 'kind': kind, 'heading': heading,
            'learningObjective': f'读完本节能够解释{heading}及其证据边界。',
            'markdown': markdown, 'evidenceSpanIds': [],
            'tableIds': ['T1'] if block_id == 'B7' else [],
            'figureIds': [], 'formulaIds': ['F1'] if block_id == 'B5' else [],
        })
    article = '\n\n'.join(
        f'### {block["heading"]}\n\n{block["markdown"]}' for block in blocks
    )
    article_sha = hashlib.sha256(article.encode('utf-8')).hexdigest()
    artifact = {
        'version': 1, 'parserVersion': 'manual-artifact-parser-v2-structured',
        'paperId': paper_id,
        'inputIdentity': {
            'sourceSha256': '1' * 64, 'sourceIdentitySha256': '2' * 64,
            'paperInputSha256': '3' * 64, 'structuredArtifactsSha256': '4' * 64,
        },
        'source': {'chars': 10000, 'bytes': 12000, 'kind': 'arxiv_html', 'sourceId': paper_id},
        'inventoryHealth': {'status': 'complete', 'issues': []},
        'sections': [{'id': 'SEC1'}], 'tables': [table], 'figures': [], 'images': [],
        'formulas': [{'id': 'F1', 'raw': formula_raw}], 'references': [],
        'acronyms': [{'id': 'A1', 'term': term}], 'citations': [{'id': 'C1'}],
        'baselines': [], 'datasets': [], 'metrics': [], 'sourceSpans': [],
        'counts': {'sections': 1, 'tables': 1, 'figures': 0, 'images': 0,
                   'formulas': 1, 'references': 0, 'acronyms': 1, 'citations': 1,
                   'baselines': 0, 'datasets': 0, 'metrics': 0},
    }
    artifact_payload = {key: value for key, value in artifact.items()
                        if key not in {'artifactIndexSha256', 'outputSha256'}}
    artifact_sha = hashlib.sha256(json.dumps(
        artifact_payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
    artifact['artifactIndexSha256'] = artifact_sha
    artifact['outputSha256'] = artifact_sha
    numeric_ids = []
    for row_index, row in enumerate(matrix):
        for column_index, cell in enumerate(row):
            if re.search(r'(?:^|[^A-Za-z])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?:\s*%|\b)', cell):
                numeric_ids.append(
                    f'T1:r{row_index}:c{column_index}:'
                    f'{hashlib.sha256(cell.encode("utf-8")).hexdigest()[:12]}'
                )
    provenance = {'specVersion': 6, 'runtimeMode': 'production', **{
        field: 'abcdef0'[index] * 64 for index, field in enumerate((
            'specRootSha256', 'paperSpecSha256', 'sealedRecordSha256',
            'recordFileSha256', 'artifactIndexFileSha256',
            'recordsEnvelopeFileSha256', 'taskEvidenceSha256',
        ))
    }, 'artifactIndexSha256': artifact_sha}
    bundle = {
        'version': 2, 'contract': 'reader-longform-v2', 'paperId': paper_id,
        'artifactIndexSha256': artifact_sha, 'blocks': blocks,
        'articleSha256': article_sha,
        'authorReceipt': {
            'paperId': paper_id, 'singlePaperOnly': True, 'isolatedContext': True,
            'model': 'gpt-5.6-terra', 'reasoningEffort': 'high',
            'taskName': 'paper_2608_30001_author', 'inputPacketSha256': 'f' * 64,
            'articleSha256': '9' * 64, 'queuedAt': '2026-08-28T09:00:00+08:00',
            'startedAt': '2026-08-28T09:01:00+08:00',
            'completedAt': '2026-08-28T09:20:00+08:00', 'revision': 1,
        },
        'finalRevisionAuthorReceipt': {
            'role': 'author_revision', 'paperId': paper_id,
            'singlePaperOnly': True, 'isolatedContext': True,
            'model': 'gpt-5.6-terra', 'reasoningEffort': 'high',
            'taskName': 'paper_2608_30001_author_revision',
            'consumedPacketSha256': '8' * 64, 'outputSha256': '7' * 64,
            'articleSha256': article_sha, 'queuedAt': '2026-08-28T10:00:00+08:00',
            'startedAt': '2026-08-28T10:01:00+08:00',
            'completedAt': '2026-08-28T10:20:00+08:00', 'revision': 1,
        },
        'tables': [{
            'sourceTableId': 'T1', 'disposition': 'inline', 'blockId': 'B7',
            'sourceMatrixSha256': matrix_sha, 'numericCellCount': len(numeric_ids),
            'coveredNumericCellIds': numeric_ids, 'renderedMarkdown': rendered_table,
            'renderedFragmentSha256': hashlib.sha256(rendered_table.encode('utf-8')).hexdigest(),
        }],
        'figures': [],
        'formulas': [{'id': 'F1', 'disposition': 'inline', 'blockId': 'B5',
                      'explanation': formula_explanation}],
        'terms': [{'id': 'A1', 'term': term, 'definition': definition,
                   'firstUseBlockId': 'B1'}],
        'relatedWorks': [{'citationId': 'C1', 'relationship': relationship,
                          'difference': difference, 'blockId': 'B3'}],
    }
    provenance.update({
        'readerLongformSha256': hashlib.sha256(json.dumps(
            bundle, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
        ).encode('utf-8')).hexdigest(),
        'readerLongformContract': 'reader-longform-v2',
        'readerLongformArticleSha256': article_sha,
        'taskNames': {
            'author': 'paper_2608_30001_author',
            'technicalScoring': 'paper_2608_30001_technical',
            'pedagogyReadability': 'paper_2608_30001_readability',
            'authorRevision': 'paper_2608_30001_author_revision',
        },
    })
    acquisition = {
        **{field: provenance[field] for field in (
            'specRootSha256', 'paperSpecSha256', 'sealedRecordSha256',
            'recordFileSha256', 'artifactIndexSha256', 'artifactIndexFileSha256',
        )},
        'sourceSha256': '1' * 64, 'sourceIdentitySha256': '2' * 64,
        'paperInputSha256': '3' * 64,
        'readerLongformSha256': provenance['readerLongformSha256'],
    }
    paper = {
        'title': 'Manual V6 Publisher Fixture', 'arxivId': paper_id,
        'manualDepth': 'full-text-evidence-v6', 'manualArtifactIndex': artifact,
        'manualReaderLongform': bundle, 'manualV6Provenance': provenance,
        'parsed': {
            'score': '8.3', 'tags': ['#语音识别'], 'primaryTaskTag': '#语音识别',
            'documentType': '方法研究',
            'summary': '本文把双路径声学表示、完整结果表与可复现边界组织成一条递进证据链。',
            'roast': '完整表格值得肯定，但单一测试集和缺失置信区间限制了结论力度。',
            'opensource': '代码尚未公开；复现需按正文登记数据划分与解码参数。',
            'scoringReason': '创新性与实验证据均有明确全文依据，扣分来自泛化与统计报告不足。',
        },
        'analysisManifest': {
            'contracts': {
                'manualDepth': 'full-text-evidence-v6', 'readerLongform': 'reader-longform-v2',
                'artifactIndex': 'manual-artifact-parser-v2-structured',
                'experimentTables': 'evidence-rich-v2', 'researcherFocus': 'audio-researcher-v1',
                'perPaperSubagent': 'isolated-single-paper-v1',
                'authorLineage': 'original-author-final-revision-v1',
            },
            'sourceAcquisition': acquisition,
            'manualTakeover': {
                'v6Provenance': copy.deepcopy(provenance),
                'researchBrief': {'editorialPlan': {
                    'version': 2, 'readerTitle': '从双路径信号流到完整结果证据',
                    'oneSentenceThesis': '双路径表示在固定测试集降低词错率，但泛化和统计边界仍待补齐。',
                }},
            },
        },
        'selectedImageUrls': [],
    }
    # Seal from the final in-memory blocks last.  Keeping this in one tail
    # step makes later fixture edits unable to leave an earlier article,
    # receipt, takeover copy or bundle semantic hash stale.
    final_article = '\n\n'.join(
        f'### {_manual_v6_text(block["heading"])}\n\n{_manual_v6_text(block["markdown"])}'
        for block in paper['manualReaderLongform']['blocks']
    )
    final_article_sha = hashlib.sha256(final_article.encode('utf-8')).hexdigest()
    paper['manualReaderLongform']['articleSha256'] = final_article_sha
    paper['manualReaderLongform']['finalRevisionAuthorReceipt']['articleSha256'] = final_article_sha
    takeover = paper['analysisManifest']['manualTakeover']
    takeover['readerArticle'] = final_article
    takeover['readerArticleSha256'] = final_article_sha
    provenance['readerLongformArticleSha256'] = final_article_sha
    provenance['readerLongformSha256'] = hashlib.sha256(json.dumps(
        paper['manualReaderLongform'], ensure_ascii=False, sort_keys=True,
        separators=(',', ':'),
    ).encode('utf-8')).hexdigest()
    acquisition['readerLongformSha256'] = provenance['readerLongformSha256']
    takeover['v6Provenance'] = copy.deepcopy(provenance)
    return paper


def llm_api_publication_fixture():
    paper_id = '2608.30002'
    headings = [
        ('background', '为什么混合声音需要先建立空间直觉？'),
        ('related_work', '已有路线在哪些线索上留下了空白？'),
        ('method_overview', '两段式流程怎样把输入变成可比较输出？'),
        ('training', '这里是否存在训练阶段，参数又从哪里来？'),
        ('experiment_setup', '读数字之前必须固定哪些实验口径？'),
        ('result', '主结果究竟支持了哪一段因果链？'),
        ('limitation', '模型预测与真实听感之间还隔着什么？'),
        ('reproduction', '复现时应该先核对哪些接口与配置？'),
        ('synthesis', '初学者下一步应该验证哪一个环节？'),
    ]
    article = '\n\n'.join(
        f'### {heading}\n\n这是围绕本篇论文证据展开的教学段落，说明输入、处理、输出、比较口径与不能外推的边界。'
        for _kind, heading in headings
    )
    plan = {
        'version': 1,
        'contract': 'beginner-researcher-v2',
        'readerTitle': '把空间线索调得更强，模型真的更容易分离音乐吗？',
        'oneSentenceThesis': '论文把频变双耳线索做成可调增强，并以受控模型实验说明收益与听损边界。',
        'sections': [{'kind': kind, 'heading': heading} for kind, heading in headings],
    }
    analysis = '## 评分\n**总分：6.1/10**\n\n## 核心摘要\n最终兼容 canonical。'
    article_sha = hashlib.sha256(article.encode('utf-8')).hexdigest()
    plan_sha = publish_to_blog._stable_json_sha256(plan)
    analysis_sha = hashlib.sha256(analysis.encode('utf-8')).hexdigest()
    source_sha = '1' * 64
    figures = []
    reader_authors = {
        'authors': [{'name': 'Researcher A', 'affiliations': ['Institute A']}],
        'sourceDomSha256': '4' * 64,
    }
    return {
        'title': 'LLM API Publisher Fixture',
        'arxivId': paper_id,
        'analysis': analysis,
        'sourceSha256': source_sha,
        'apiReaderArticle': article,
        'apiReaderPlan': plan,
        'apiReaderFigures': figures,
        'apiReaderAuthors': reader_authors,
        'apiReaderArticleSha256': article_sha,
        'apiReaderPlanSha256': plan_sha,
        'parsed': {
            'score': '6.1', 'tags': ['#空间音频'],
            'summary': '最终兼容 canonical 摘要。',
            'roast': '预测证据完整，但仍缺真人听音。',
            'opensource': '代码尚未公开。',
            'scoringReason': '评分严格绑定来源与审计证据。',
        },
        'analysisManifest': {
            'contracts': {'apiReaderArticle': 'beginner-researcher-v2'},
            'sourceAcquisition': {'sourceSha256': source_sha},
            'stages': {
                'scoringAudit': {
                    'status': 'complete',
                    'scoringContract': 'api-scoring-audit-v2',
                    'outputAnalysisSha256': analysis_sha,
                    'auditSha256': '2' * 64,
                    'evidenceSha256': '3' * 64,
                    'finalScore': 6.1,
                },
                'apiReaderArticle': {
                    'status': 'complete',
                    'articleSha256': article_sha,
                    'planSha256': plan_sha,
                    'figureCount': 0,
                    'figuresSha256': publish_to_blog._stable_json_sha256(figures),
                    'readerAuthorsSha256': publish_to_blog._stable_json_sha256(reader_authors),
                    'model': 'muse-spark-1.2-contributor',
                    'protocol': 'openai_responses',
                },
            },
        },
    }


def valid_png(payload_suffix=b'', width=768, height=1200):
    def chunk(kind, payload):
        return (
            struct.pack('>I', len(payload)) + kind + payload
            + struct.pack('>I', zlib.crc32(kind + payload) & 0xffffffff)
        )
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 0, 0, 0, 0)
    # Valid 8-bit grayscale rows. Change the final pixel to produce a distinct
    # but still structurally valid PNG when callers request a suffix.
    scanline = bytearray((width + 1) * height)
    if payload_suffix:
        scanline[-1] = zlib.crc32(payload_suffix) & 0xff
    return publish_to_blog.PNG_SIGNATURE + chunk(b'IHDR', ihdr) + chunk(
        b'IDAT', zlib.compress(bytes(scanline))
    ) + chunk(b'IEND', b'')


def git(repo, *args, check=True):
    return subprocess.run(
        ['git', *args], cwd=repo, check=check, capture_output=True, text=True,
    )


def init_blog_repo(root, with_remote=False):
    repo = Path(root) / 'blog'
    repo.mkdir()
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Publish Test')
    git(repo, 'config', 'user.email', 'publish@example.com')
    posts = repo / 'content' / 'posts'
    posts.mkdir(parents=True)
    readme = repo / 'README.md'
    readme.write_text('blog\n', encoding='utf-8')
    git(repo, 'add', '--', 'README.md')
    git(repo, 'commit', '-m', 'initial')
    remote = None
    if with_remote:
        remote = Path(root) / 'remote.git'
        git(root, 'init', '--bare', str(remote))
        git(repo, 'remote', 'add', 'origin', str(remote))
        git(repo, 'push', '-u', 'origin', 'main')
    return repo, posts, remote


def save_bound_review_receipt(date_str, paths, hugo_gate='hugo', expected_base_head=None):
    repo = Path(publish_to_blog.BLOG_REPO).resolve()
    paper_id = '2607.99999'
    paper_page = repo / 'content' / 'posts' / f'{date_str}-visual-gate-paper.md'
    paper_page.parent.mkdir(parents=True, exist_ok=True)
    paper_page.write_text(
        '---\npaper_digest_page_type: paper\n'
        f'paper_digest_arxiv_id: "{paper_id}"\n---\n'
        'body\n', encoding='utf-8',
    )
    index_page = repo / 'content' / 'posts' / f'{date_str}-visual-gate-index.md'
    index_page.write_text(
        '---\npaper_digest_page_type: index\n---\n'
        'index\n', encoding='utf-8',
    )
    paths.extend([paper_page, index_page])
    manifest = publish_to_blog.save_generation_manifest(date_str, paths)
    results = {}
    for path in paths:
        path = Path(path).resolve()
        if path.is_file():
            results[str(path)] = {
                'passed': True,
                'reviewedSha256': publish_to_blog._sha256_file(path),
            }
    return publish_to_blog.save_review_receipt(
        date_str, paths, hugo_gate,
        expected_base_head=expected_base_head,
        generation_manifest=manifest,
        reviewed_results=results,
    )


def create_verified_schema_v3_publication(date_str, posts, paper):
    paper_page = posts / f'{date_str}-published-paper.md'
    paper_page.write_text(
        '---\npaper_digest_page_type: paper\n'
        f'paper_digest_arxiv_id: "{paper["arxivId"]}"\n---\n'
        'reviewed body\n',
        encoding='utf-8',
    )
    index_page = posts / f'{date_str}.md'
    index_page.write_text(
        '---\npaper_digest_page_type: index\n---\nreviewed index\n',
        encoding='utf-8',
    )
    paths = [paper_page, index_page]
    base_head = publish_to_blog.validate_git_publish_branch()
    input_fingerprint = publish_to_blog.generation_input_fingerprint(
        [paper], date_str, '论文速递', False,
    )
    template_fingerprint = publish_to_blog.generation_template_fingerprint()
    manifest = publish_to_blog.save_generation_manifest(
        date_str, paths,
        input_fingerprint=input_fingerprint,
        template_fingerprint=template_fingerprint,
        base_head=base_head,
        published_papers=[paper],
        publication_mode=publish_to_blog.LEGACY_V5_MAINTENANCE_MODE,
    )
    reviewed_results = {
        str(path.resolve()): {
            'passed': True,
            'reviewedSha256': publish_to_blog._sha256_file(path),
            'imageReviewMode': 'deterministic_only',
        }
        for path in paths
    }
    receipt = publish_to_blog.save_review_receipt(
        date_str, paths, 'hugo',
        expected_base_head=base_head,
        generation_manifest=manifest,
        reviewed_results=reviewed_results,
    )
    if not publish_to_blog.git_push(date_str, paths):
        raise AssertionError('test publication failed remote verification')
    return {
        'paths': paths,
        'manifest': manifest,
        'receipt': receipt,
        'inputFingerprint': input_fingerprint,
        'templateFingerprint': template_fingerprint,
    }


class PublishToBlogReviewTest(unittest.TestCase):
    def test_extract_repo_urls_stops_at_chinese_sentence_punctuation(self):
        url = (
            'https://github.com/NVIDIA-NeMo/Speech/blob/main/scripts/'
            'asr_context_biasing/eval_greedy_decoding_with_context_biasing.py'
        )
        text = f'公开评测脚本为 {url}；正文未说明完整复现文档，按固定锚点计 1.2 分。'
        self.assertEqual(publish_to_blog.extract_repo_urls(text), [url])

    def test_visual_capability_preflight_rejects_legacy_before_daily_push(self):
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(publish_to_blog, 'CURRENT_DIR', Path(tmp)):
            manifest = publish_to_blog.generation_manifest_path('2026-07-10')
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps({
                'schemaVersion': 1,
                'date': '2026-07-10',
                'files': [{'path': 'content/posts/2026-07-10.md', 'deleted': False}],
                'category': '论文速递',
                'visualSummaryRequired': False,
                'digestCoverRequired': False,
            }), encoding='utf-8')
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertFalse(publish_to_blog.preflight_post_publish_visual_capability(
                    '2026-07-10', require_visual_plan=False,
                ))
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, '仅支持历史维护发布'
            ):
                publish_to_blog.preflight_post_publish_visual_capability(
                    '2026-07-10', require_visual_plan=True,
                )

    def test_schema_v3_visual_capability_preflight_accepts_bound_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'current'
            page = posts / '2026-07-10-paper.md'
            paper = manual_v6_publication_fixture()
            page.write_text(
                '---\npaper_digest_page_type: paper\n'
                f'paper_digest_arxiv_id: "{paper["arxivId"]}"\n---\nbody\n',
                encoding='utf-8',
            )
            published_papers = [paper]
            input_fingerprint = publish_to_blog.generation_input_fingerprint(
                published_papers, '2026-07-10', '论文速递', False,
            )
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_to_blog.save_generation_manifest(
                    '2026-07-10', [page],
                    input_fingerprint=input_fingerprint,
                    template_fingerprint='b' * 64,
                    base_head='c' * 40,
                    published_papers=published_papers,
                )
                self.assertTrue(publish_to_blog.preflight_post_publish_visual_capability(
                    '2026-07-10', require_visual_plan=True,
                ))

    def test_receipt_reports_actual_per_file_image_review_coverage(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            first = posts / '2026-07-10-first.md'
            second = posts / '2026-07-10-second.md'
            first.write_text('first\n', encoding='utf-8')
            second.write_text('second\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [first, second])
                results = {
                    str(first.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(first),
                        'imageReviewMode': 'deterministic_only',
                    },
                    str(second.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(second),
                        'imageReviewMode': 'multimodal',
                    },
                }
                receipt_path = publish_to_blog.save_review_receipt(
                    '2026-07-10', [first, second], 'hugo',
                    generation_manifest=manifest, reviewed_results=results,
                )
                receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
            self.assertEqual(receipt['imageReview']['mode'], 'mixed')
            self.assertEqual(
                receipt['postPublishVisuals'], 'not_applicable_legacy_maintenance'
            )
            self.assertEqual(
                {item['imageReviewMode'] for item in receipt['files']},
                {'deterministic_only', 'multimodal'},
            )

    def test_generation_cli_rejects_missing_unknown_and_duplicate_flags(self):
        for argv in (
            ['--date'],
            ['--unknown', 'value'],
            ['--cat', '论文速递'],
            ['--date', '2026-07-10', '--date', '2026-07-11'],
            ['--push'],
            ['--include-id', '2607.00001', '--include-id', '2607.00002'],
            ['--include-id', '2607.00001', '--exclude-id', '2607.00002'],
            ['--include-id', '2607.00001', '--all'],
            ['--sealed-tutorial-preview'],
            ['data.json', '--include-id', '2607.00001', '--sealed-tutorial-preview'],
            ['--include-id', '2607.00001', '--sealed-tutorial-preview',
             '--sealed-tutorial-preview'],
        ):
            with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    publish_to_blog.parse_generation_args(argv)
                self.assertEqual(caught.exception.code, 2)
        parsed = publish_to_blog.parse_generation_args([
            '--date', '2026-07-10',
            '--exclude-id', '2607.00001',
            '--exclude-id', '2607.00002',
        ])
        self.assertEqual(parsed['excluded_ids'], ['2607.00001', '2607.00002'])
        included = publish_to_blog.parse_generation_args([
            '--date', '2026-07-10', '--include-id', 'arXiv:2607.00001v2',
        ])
        self.assertEqual(included['include_id'], 'arXiv:2607.00001v2')
        sealed_preview = publish_to_blog.parse_generation_args([
            '--date', '2026-07-10', '--include-id', '2607.00001',
            '--sealed-tutorial-preview',
        ])
        self.assertTrue(sealed_preview['sealed_tutorial_preview'])

    def test_empty_generation_invalidates_same_date_stale_stage_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current'
            current.mkdir()
            names = (
                'blog-generation-manifest-2026-07-10.json',
                'blog-review-receipt-2026-07-10.json',
                'blog-review-failure-2026-07-10.json',
                'blog-generation-journal-2026-07-10.json',
            )
            for name in names:
                (current / name).write_text('{}', encoding='utf-8')
            stage = current / 'blog-generation-stage-2026-07-10'
            stage.mkdir()
            (stage / 'stale.md').write_text('stale', encoding='utf-8')
            options = {
                'data_file': None,
                'target_date': '2026-07-10',
                'category': '论文速递',
                'publish_all': False,
                'excluded_ids': [],
            }
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        publish_to_blog, 'validate_publish_target',
                        return_value=(Path(tmp), Path(tmp) / 'posts'),
                    ), \
                    mock.patch.object(publish_to_blog, 'load_papers', return_value=[]), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '没有论文可生成',
                ):
                    publish_to_blog.generate_main(options)
            for name in names:
                self.assertFalse((current / name).exists(), name)
            self.assertFalse(stage.exists())

    def test_empty_generation_preserves_remote_verified_publication_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current'
            current.mkdir()
            date_str = '2026-07-10'
            generation = current / f'blog-generation-manifest-{date_str}.json'
            receipt = current / f'blog-review-receipt-{date_str}.json'
            generation.write_text('{"schemaVersion":3}', encoding='utf-8')
            receipt.write_text(json.dumps({
                'schemaVersion': 3,
                'date': date_str,
                'publicationCommit': 'a' * 40,
                'remoteVerifiedOid': 'a' * 40,
                'remoteVerifiedAt': '2026-07-10T12:00:00+08:00',
            }), encoding='utf-8')
            options = {
                'data_file': None,
                'target_date': date_str,
                'category': '论文速递',
                'publish_all': False,
                'excluded_ids': [],
            }
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        publish_to_blog, 'validate_publish_target',
                        return_value=(Path(tmp), Path(tmp) / 'posts'),
                    ), \
                    mock.patch.object(publish_to_blog, 'load_papers', return_value=[]), \
                    contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '已保留既有 generation/review/push 证据',
                ):
                    publish_to_blog.generate_main(options)
            self.assertTrue(generation.is_file())
            self.assertTrue(receipt.is_file())

    def test_historical_generation_prefers_exact_controlled_archive_when_current_is_newer(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            current = root / 'current-deep.json'
            current.write_text(json.dumps({
                'papers': [{'arxivId': '2607.00002', 'fetchBatchDate': '2026-07-11'}],
            }), encoding='utf-8')
            archive = root / 'archive'
            archived = archive / '2026-07-10' / 'deep-analysis-result.json'
            archived.parent.mkdir(parents=True)
            archived.write_text(json.dumps({
                'papers': [{'arxivId': '2607.00001', 'fetchBatchDate': '2026-07-10'}],
            }), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'ARCHIVE_DIR', archive), \
                    mock.patch.object(
                        publish_to_blog, 'resolve_deep_analysis_result_path',
                        return_value=current,
                    ), \
                    contextlib.redirect_stdout(io.StringIO()):
                selected = publish_to_blog.select_generation_data_file(
                    None, '2026-07-10', publish_all=False,
                    legacy_v5_maintenance=True,
                )
            self.assertEqual(Path(selected), archived)

    def test_default_generation_uses_only_standard_current_canonical(self):
        with tempfile.TemporaryDirectory() as tmp:
            standard = Path(tmp) / 'current' / 'deep-analysis-result.json'
            with mock.patch.object(
                    publish_to_blog, 'DEEP_ANALYSIS_RESULT_FILE', standard):
                self.assertEqual(
                    Path(publish_to_blog.select_generation_data_file(
                        None, '2026-07-10', publish_all=False,
                    )),
                    standard,
                )

    def test_blog_review_concurrency_defaults_to_five_and_reads_project_env(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop('PD_BLOG_REVIEW_CONCURRENCY', None)
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CONCURRENCY': '12'}):
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 5)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CONCURRENCY': 'invalid'}):
            self.assertEqual(publish_to_blog.get_blog_review_concurrency(), 5)

    def test_index_review_chunks_run_concurrently_and_merge_in_source_order(self):
        import threading
        import time

        active = 0
        peak = 0
        lock = threading.Lock()

        def review_chunk(_chunk, _title, **kwargs):
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.03)
            with lock:
                active -= 1
            label = kwargs['chunk_label']
            return True, [{'severity': 'info', 'description': label}], _chunk

        with mock.patch.object(publish_to_blog, 'get_blog_review_concurrency', return_value=3), \
                mock.patch.object(publish_to_blog, 'get_blog_review_chunk_chars', return_value=4000), \
                mock.patch.object(publish_to_blog, '_llm_review_post_chunk', side_effect=review_chunk):
            passed, issues, _ = publish_to_blog.llm_review_post('A' * 9000, '汇总页')

        self.assertTrue(passed)
        self.assertGreater(peak, 1)
        self.assertEqual([issue['description'] for issue in issues], ['1/3', '2/3', '3/3'])

    def test_review_preserves_valid_table_rows_with_empty_group_cells(self):
        content = '''---
title: "Table"
---
| 方法 | 复杂度 | 参数量 | 阶段 | SI-SIR |
| :--- | :--- | :--- | :--- | :--- |
| TANGO | 65.65 | 1 M | SN-DNN | 3.1/0.0 |
| | | | Filter1 (GEVD) | 9.4/6.7 |
| | | | MN-DNN | 13.0/7.8 |
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            with open(path, 'r', encoding='utf-8') as handle:
                reviewed = handle.read()
            self.assertFalse(fixed)
            self.assertEqual(issues, [])
            self.assertIn('| | | | Filter1 (GEVD) | 9.4/6.7 |', reviewed)
            self.assertIn('| | | | MN-DNN | 13.0/7.8 |', reviewed)
        finally:
            os.unlink(path)

    def test_review_removes_exact_duplicate_long_prose(self):
        paragraph = '训练数据依赖冻结的预训练模型，并使用人工标注档案完成验证。' * 5
        content = f'''---
title: "Duplicate"
---
{paragraph}

中间段落用于分隔两处内容，并保留正常结构。

{paragraph}
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            with open(path, encoding='utf-8') as reviewed_file:
                reviewed = reviewed_file.read()
            self.assertTrue(fixed)
            self.assertEqual(reviewed.count(paragraph), 1)
            self.assertTrue(any('完全重复' in issue for issue in issues))
        finally:
            os.unlink(path)

    def test_review_dry_run_reports_fix_without_mutating_attested_bytes(self):
        paragraph = '这是一段足够长的重复正文，用于证明人工审查后的确定性检查保持只读。' * 5
        content = f'---\ntitle: "Dry run"\n---\n{paragraph}\n\n{paragraph}\n'
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path, dry_run=True)
            self.assertTrue(fixed)
            self.assertTrue(any('完全重复' in issue for issue in issues))
            self.assertEqual(Path(path).read_text(encoding='utf-8'), content)
        finally:
            os.unlink(path)

    def test_index_uses_selected_count_and_word_safe_ranking_title(self):
        title = 'A deliberately long English paper title that would otherwise end inside a ranking word'
        parsed = {
            'score': '8.0',
            'rankBucket': '前25%',
            'documentType': '方法研究',
            'primaryTaskTag': '#语音识别',
            'tags': ['#语音识别'],
            'roast': '值得肯定的是它把关键比较做得足够直接；但缺少跨域验证，因此结论仍应收在当前设置内。',
            'summary': '这篇论文用明确的实验设置回答了语音识别中的一个局部问题。',
            'opensource': '代码：尚未公开。',
        }
        reader_article = '### 先拆开关键矛盾\n\n' + '这里解释方法选择与实验边界。' * 8
        paper = {
            'arxivId': '2608.00001', 'title': title, 'parsed': parsed,
            'analysisManifest': {
                'contracts': {'manualDepth': 'full-text-evidence-v5'},
                'manualTakeover': {
                    'researchBrief': {'editorialPlan': {
                        'version': 2,
                        'readerFormatContract': 'graduate-researcher-tutorial-quality-v2',
                        'readerTitle': '先把语音识别的关键矛盾说清楚',
                        'oneSentenceThesis': '以可验证的分工处理当前设置中的识别冲突，并把无法外推的边界明确留在结论中。',
                    }},
                    'readerArticle': reader_article,
                    'readerArticleSha256': hashlib.sha256(reader_article.encode('utf-8')).hexdigest(),
                },
            },
        }
        with manual_v5_fresh_files(paper, '2026-08-25'):
            markdown = publish_to_blog.generate_index_page(
                [(8.0, paper, parsed)], [], '2026-08-25',
                {'2608.00001': 'long-title-2608-00001'},
            )
        compact = publish_to_blog.compact_title_for_ranking(title)
        self.assertIn('✅ 筛选入选 1 篇 → 🔬 深度分析完成', markdown)
        self.assertIn('paper_digest_reader_quality: "reader-facing-v1"', markdown)
        self.assertNotIn('📥 抓取 1 篇', markdown)
        self.assertLessEqual(len(compact), 55)
        self.assertTrue(compact.endswith('…'))
        self.assertIn(f'[{compact}](', markdown)
        self.assertIn('| 8.0 | 前25% |', markdown)
        self.assertNotIn('| 8.0分 |', markdown)
        self.assertNotRegex(compact[:-1], r'\botherwis$')
        self.assertIn('### 🥇 [先把语音识别的关键矛盾说清楚]', markdown)
        self.assertIn('> 英文题目：*[A deliberately long English paper title', markdown)
        for text in ('标签：#语音识别', '评分：**8.0/10**', '💡 **毒舌点评**', '📌 **核心摘要**', '🔗 **开源资源**'):
            self.assertIn(text, markdown)
        self.assertLess(markdown.index('> 英文题目：'), markdown.index('标签：#语音识别'))
        self.assertLess(markdown.index('标签：#语音识别'), markdown.index('评分：**8.0/10**'))
        self.assertLess(markdown.index('评分：**8.0/10**'), markdown.index('💡 **毒舌点评**'))
        self.assertLess(markdown.index('💡 **毒舌点评**'), markdown.index('📌 **核心摘要**'))
        self.assertLess(markdown.index('📌 **核心摘要**'), markdown.index('🔗 **开源资源**'))

    def test_review_removes_only_high_similarity_prose_and_keeps_table_continuations(self):
        first = (
            '该系统依次执行声学编码、上下文融合、置信度校准和序列解码，'
            '并在统一数据划分上报告错误率、实时率和跨域稳健性。'
        ) * 3
        near = first.replace('统一数据划分', '相同数据划分', 1)
        content = f'''---
title: "Near duplicate"
---
{first}

保留这一段不同的实验解释，它说明硬件条件和随机种子会影响结果。

{near}

| 方法 | 阶段 | 指标 |
| --- | --- | --- |
| TANGO | SN-DNN | 3.1 |
| | Filter1 | 9.4 |
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            reviewed = Path(path).read_text(encoding='utf-8')
            self.assertTrue(fixed)
            self.assertIn(first, reviewed)
            self.assertNotIn(near, reviewed)
            self.assertIn('| | Filter1 | 9.4 |', reviewed)
            self.assertTrue(any('近重复' in issue for issue in issues))
        finally:
            os.unlink(path)

    def test_review_keeps_near_duplicate_paragraphs_with_different_numeric_claims(self):
        first = (
            '统一评测在相同数据划分、训练轮数和解码参数下比较所有系统，'
            '主方法的错误率为 12.4%，并报告三次运行的均值。'
        ) * 3
        materially_different = first.replace('12.4%', '13.4%')
        content = f'''---
title: "Distinct evidence"
---
{first}

{materially_different}
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            reviewed = Path(path).read_text(encoding='utf-8')
            self.assertFalse(fixed)
            self.assertEqual(issues, [])
            self.assertIn('12.4%', reviewed)
            self.assertIn('13.4%', reviewed)
        finally:
            os.unlink(path)

    def test_review_repairs_backticked_latex_and_short_truncated_caption(self):
        caption = (
            'Figure 2: The encoder maps waveform patches into a continuous latent sequence '
            'before the decoder reconstructs the signal and the auxiliary branch predicts Spec'
        )
        content = f'''---
title: "Math and caption"
---
目标函数是 `\\(\\mathcal{{L}}_D + \\lambda \\mathcal{{L}}_A\\)`。

![{caption}](https://example.com/figure.png)
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            reviewed = Path(path).read_text(encoding='utf-8')
            self.assertTrue(fixed)
            self.assertIn(r'\(\mathcal{L}_D + \lambda \mathcal{L}_A\)', reviewed)
            self.assertNotIn(r'`\(\mathcal{L}_D', reviewed)
            self.assertNotIn('predicts Spec]', reviewed)
            self.assertTrue(any('反引号包裹' in issue for issue in issues))
            self.assertTrue(any('截断' in issue for issue in issues))
        finally:
            os.unlink(path)

    def test_review_preserves_complete_caption_bound_to_authoritative_image_manifest(self):
        source_caption = (
            r'Figure 5: Multi-stimulus listening test results for float32 (F) and '
            r'int8-quantized (Q) µNetMSE{}_{\text{MSE}} models. Subscripts indicate '
            r'algorithmic latencies; ”F” and ”Q” represent 32-bit floating-point and '
            r'8-bit integer quantization, respectively'
        )
        url = 'https://arxiv.org/html/2608.21155v1/rating_boxplotQ.png'
        rendered_alt = re.sub(
            r'^(?:fig(?:ure)?\.?\s*)\d+[a-z]?(?:\s*[:.\-\u2013\u2014]\s*|\s+)',
            '', source_caption, flags=re.IGNORECASE,
        ).replace('\\', '\\\\')
        content = f'''---
title: "Bound caption"
---
![{rendered_alt}]({url})
'''
        paper = {
            'imageManifest': {
                'selected': [{'url': url, 'caption': source_caption}],
            },
        }
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path, paper)
            reviewed = Path(path).read_text(encoding='utf-8')
            self.assertFalse(fixed)
            self.assertEqual(issues, [])
            self.assertEqual(reviewed, content)
            self.assertIn(
                '”F” and ”Q” represent 32-bit floating-point and 8-bit integer quantization, respectively',
                reviewed,
            )
        finally:
            os.unlink(path)

    def test_review_blocks_english_dominant_roast_without_inventing_translation(self):
        roast = (
            'This review explains why the evaluation is too narrow and why the claimed '
            'engineering benefit is not supported by latency, memory, or failure-case evidence. '
        ) * 3
        content = f'''---
title: "English roast"
---
### 💡 毒舌点评

{roast}

### 📌 核心摘要

这里是中文摘要。
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            reviewed = Path(path).read_text(encoding='utf-8')
            self.assertFalse(fixed)
            self.assertIn(roast, reviewed)
            self.assertTrue(any('必须改为简体中文' in issue for issue in issues))
        finally:
            os.unlink(path)

    def test_review_blocks_inconsistent_markdown_table_shape(self):
        content = '''---
title: "Bad table"
---
| 方法 | 指标 | 速度 |
| --- | --- | --- |
| Baseline | 1.0 |
'''
        with tempfile.NamedTemporaryFile('w+', suffix='.md', encoding='utf-8', delete=False) as handle:
            handle.write(content)
            path = handle.name
        try:
            fixed, issues = publish_to_blog.review_and_fix_post(path)
            self.assertFalse(fixed)
            self.assertTrue(any('表格列数不一致' in issue for issue in issues))
        finally:
            os.unlink(path)

    def test_review_filters_model_name_backtick_style_advice(self):
        issues = [{
            'severity': 'warning',
            'type': 'markdown',
            'description': '模型名称 gemini-2.5-flash 未使用反引号包裹',
            'auto_fixable': False
        }]
        self.assertEqual(publish_to_blog.filter_false_positive_review_issues('正文', issues), [])

    def test_review_filters_unclosed_fence_claim_when_fences_are_balanced(self):
        issues = [{
            'severity': 'error',
            'type': 'markdown',
            'description': '文档末尾存在孤立的代码块开始标记，但没有结束标记。',
            'auto_fixable': True,
        }]
        self.assertEqual(
            publish_to_blog.filter_false_positive_review_issues('正文没有代码块。', issues),
            [],
        )
        self.assertEqual(
            publish_to_blog.filter_false_positive_review_issues(
                '```text\n未闭合', issues,
            ),
            issues,
        )

    def test_required_text_review_fails_closed_on_non_json_and_missing_fields(self):
        with mock.patch.object(publish_to_blog, 'call_llm_api', return_value='无法判断'):
            passed, issues, _ = publish_to_blog.llm_review_post('正文', '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_required_text_review_retries_truncated_protocol_response(self):
        responses = iter([
            '{"passed": }',
            '{"passed": true, "issues": []}',
        ])
        with mock.patch.object(
            publish_to_blog,
            'call_llm_api',
            side_effect=lambda *args, **kwargs: next(responses),
        ) as call:
            passed, issues, reviewed = publish_to_blog.llm_review_post('正文', '标题', required=True)

        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, '正文')
        self.assertEqual(call.call_count, 2)
        self.assertIn('上一次响应不完整', call.call_args_list[1].args[0])

        malformed = '{"passed": true, "issues": [{"severity": "warning"}]}'
        with mock.patch.object(publish_to_blog, 'call_llm_api', return_value=malformed):
            passed, issues, _ = publish_to_blog.llm_review_post('正文', '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_required_text_review_retries_original_after_format_repair_fails(self):
        responses = iter([
            '审查结论存在，但不是 JSON；这是一个长度超过短响应阈值的非结构化审查结果，必须先尝试格式修复。',
            '{"passed": true, "issues": [',
            '{"passed": true, "issues": []}',
        ])
        with mock.patch.object(
            publish_to_blog,
            'call_llm_api',
            side_effect=lambda *args, **kwargs: next(responses),
        ) as call:
            passed, issues, reviewed = publish_to_blog.llm_review_post('正文', '标题', required=True)

        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, '正文')
        self.assertEqual(call.call_count, 3)
        self.assertIn('响应及其格式修复均无效', call.call_args_list[2].args[0])

    def test_required_repaired_text_review_filters_prompt_only_angle_tags(self):
        repaired_issue = {
            'passed': False,
            'issues': [{
                'severity': 'error',
                'type': 'html_tag',
                'description': '文本中出现了 `<S>`，未被反引号包裹。',
                'auto_fixable': False,
                'fix_instruction': '',
            }],
        }
        responses = iter([
            '这不是 JSON，但响应足够长，会先进入格式修复流程。',
            __import__('json').dumps(repaired_issue, ensure_ascii=False),
        ])
        with mock.patch.object(
            publish_to_blog,
            'call_llm_api',
            side_effect=lambda *args, **kwargs: next(responses),
        ):
            passed, issues, reviewed = publish_to_blog.llm_review_post('正文没有尖括号标签。', '标题', required=True)

        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')
        self.assertIn('passed=false', issues[0]['description'])
        self.assertEqual(reviewed, '正文没有尖括号标签。')

    def test_required_image_review_fails_closed_on_non_json_and_invalid_severity(self):
        content = '![结果图](https://arxiv.org/result.png)'
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value='大概没问题'):
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

        malformed = '{"passed": true, "issues": [{"severity": "critical", "description": "x"}]}'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=malformed):
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertFalse(passed)
        self.assertEqual(issues[0]['severity'], 'error')

    def test_generate_page_handles_missing_tags_without_key_error(self):
        markdown, slug = publish_to_blog.generate_paper_page({
            'title': 'No tags',
            'arxivId': '2607.00001',
            'parsed': {'score': '1'},
            'visualSummaryCards': [
                {'kind': kind, 'label': kind, 'url': f'/card/{kind}.png'}
                for kind in publish_to_blog.VISUAL_SUMMARY_KINDS
            ],
        }, '2026-07-10')
        self.assertEqual(slug, 'no-tags-2607-00001')
        self.assertIn('tags: []', markdown)

    def test_generate_page_renders_latex_degree_in_title_as_unicode(self):
        markdown, _slug = publish_to_blog.generate_paper_page({
            'title': r'Visually-Guided Spatial Audio for $360^\circ$ Scenes',
            'arxivId': '2608.24579',
            'parsed': {'score': '7.1', 'tags': []},
        }, '2026-08-26')
        self.assertIn('title: "Visually-Guided Spatial Audio for 360° Scenes"', markdown)
        self.assertIn('# 📄 Visually-Guided Spatial Audio for 360° Scenes', markdown)
        self.assertNotIn(r'360^\circ', markdown)

    def test_generate_page_renders_superscript_and_underline_title_as_plain_text(self):
        markdown, _slug = publish_to_blog.generate_paper_page({
            'title': r'EXAM$^2$: $\underline{Ex}tending$ Audio Understanding',
            'arxivId': '2608.23758',
            'parsed': {'score': '8.7', 'tags': []},
        }, '2026-08-26')
        self.assertIn('title: "EXAM²: Extending Audio Understanding"', markdown)
        self.assertIn('# 📄 EXAM²: Extending Audio Understanding', markdown)
        self.assertNotIn(r'\underline', markdown)

    def test_api_reader_article_is_the_reader_first_blog_body_and_sha_bound(self):
        article = (
            '### 为什么旧表示会在生成任务前失真？\n\n背景与任务的连续解释。\n\n'
            '### 既有路线把代价藏在了哪里？\n\n相关工作与论文位置的连续解释。\n\n'
            '### 分路表示如何重新安排信息流？\n\n方法全景、输入与输出的连续解释。\n\n'
            '### 比较数字之前要先统一哪些条件？\n\n实验协议与指标方向的连续解释。\n\n'
            '### 主结果支持了什么，又没有支持什么？\n\n结果、强基线与反证的连续解释。\n\n'
            '### 证据边界会怎样影响下一步复现？\n\n局限与复现入口的连续解释。\n\n'
            '### 读完以后应该沿着哪条线继续验证？\n\n研究行动与全文收束的连续解释。'
        )
        plan = {
            'version': 1,
            'contract': 'beginner-researcher-v1',
            'readerTitle': '当声学细节与语义理解不再挤在同一条路上',
            'oneSentenceThesis': '分路表示改善了目标设置中的主指标，但外部泛化与部署代价仍需额外证据。',
            'sections': [
                {'kind': kind, 'heading': heading}
                for kind, heading in (
                    ('background', '为什么旧表示会在生成任务前失真？'),
                    ('related_work', '既有路线把代价藏在了哪里？'),
                    ('method_overview', '分路表示如何重新安排信息流？'),
                    ('experiment_setup', '比较数字之前要先统一哪些条件？'),
                    ('result', '主结果支持了什么，又没有支持什么？'),
                    ('limitation', '证据边界会怎样影响下一步复现？'),
                    ('synthesis', '读完以后应该沿着哪条线继续验证？'),
                )
            ],
        }
        article_sha = hashlib.sha256(article.encode('utf-8')).hexdigest()
        plan_sha = publish_to_blog._stable_json_sha256(plan)
        paper = {
            'title': 'A Split Representation Model',
            'arxivId': '2608.30001',
            'parsed': {
                'score': '8.2', 'tags': ['#音频理解'],
                'summary': '旧 canonical 摘要仍承担兼容字段。',
                'roast': '证据很扎实，但还没有覆盖真实部署。',
                'opensource': '代码尚未公开。',
                'architecture': '这段固定栏目不应成为读者正文。',
                'scoringReason': '* 创新性：证据可追溯。',
            },
            'apiReaderArticle': article,
            'apiReaderPlan': plan,
            'apiReaderArticleSha256': article_sha,
            'apiReaderPlanSha256': plan_sha,
            'analysisManifest': {
                'contracts': {'apiReaderArticle': 'beginner-researcher-v1'},
                'stages': {'apiReaderArticle': {
                    'status': 'complete',
                    'articleSha256': article_sha,
                    'planSha256': plan_sha,
                }},
            },
        }
        markdown, _slug = publish_to_blog.generate_paper_page(paper, '2026-08-31')
        self.assertIn('paper_digest_api_reader_contract: "beginner-researcher-v1"', markdown)
        self.assertIn('# 📄 当声学细节与语义理解不再挤在同一条路上', markdown)
        self.assertIn('> 一句话：**分路表示改善了目标设置中的主指标', markdown)
        self.assertIn('### 为什么旧表示会在生成任务前失真？', markdown)
        self.assertNotIn('这段固定栏目不应成为读者正文。', markdown)

        paper['apiReaderArticle'] += '\n漂移'
        with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError,
                '文章/计划 SHA 或阶段状态不闭环'):
            publish_to_blog.generate_paper_page(paper, '2026-08-31')

    def test_api_reader_v2_places_authors_after_identity_and_uses_visible_heading_levels(self):
        paper = llm_api_publication_fixture()
        markdown, _slug = publish_to_blog.generate_paper_page(paper, '2026-08-31')
        self.assertIn('paper_digest_api_reader_contract: "beginner-researcher-v2"', markdown)
        self.assertIn('## 👥 作者与机构', markdown)
        self.assertIn('- Researcher A：Institute A', markdown)
        self.assertLess(markdown.index('> 标签：'), markdown.index('## 👥 作者与机构'))
        self.assertLess(markdown.index('## 👥 作者与机构'), markdown.index('## 💬 毒舌点评'))
        self.assertIn('## 🧭 深度解读', markdown)
        self.assertIn('### 为什么混合声音需要先建立空间直觉？', markdown)
        self.assertNotIn('#### 为什么混合声音需要先建立空间直觉？', markdown)
        self.assertEqual(markdown.count('Researcher A'), 1)

    def test_manual_v5_reader_plan_uses_reader_first_header_and_preserves_custom_subheads(self):
        reader_article = (
            '### 先解释表示冲突\n\n'
            '这里用完整段落解释理解与生成为何不能共享同一接口，并把论文的设计选择放回可检验的问题中。\n\n'
            '### 再追踪两条通路\n\n'
            '这里用完整段落追踪输入、共享推理与输出如何衔接，避免把模块名称直接堆给读者。'
        )
        paper = {
            'title': 'A General Purpose Audio Model',
            'arxivId': '2608.24168',
            'parsed': {
                'score': '8.7', 'tags': ['#音频理解'],
                'summary': '这是一篇读者版摘要。',
                'roast': '它把双路径的职责划分得很清楚，值得肯定；但没有组件消融，因而仍不足以证明每个分工都不可替代。',
                'opensource': '代码：尚未公开；复现需要依照正文的训练设置自行实现。',
                'architecture': '### 两条通路为何只在语言主干会合\n\n这里解释数据流。',
                'results': '### 哪项比较真正支持主张\n\n这里解释实验。',
                'scoringReason': '* 创新性 (1.7/2)：[E01] 机制与直接证据可追溯，但没有组件消融。',
            },
            'analysisManifest': {
                'contracts': {'manualDepth': 'full-text-evidence-v5'},
                'manualTakeover': {'researchBrief': {'editorialPlan': {
                    'version': 2,
                    'readerFormatContract': 'graduate-researcher-tutorial-quality-v2',
                    'readerTitle': '两条表示如何统一听懂与生成音频',
                    'oneSentenceThesis': '共享语言推理而分离音频表示，让理解压缩与生成还原不再争抢同一个接口。',
                }}, 'readerArticle': reader_article,
                'readerArticleSha256': hashlib.sha256(reader_article.encode('utf-8')).hexdigest()},
            },
        }
        with manual_v5_fresh_files(
                paper, '2026-08-26', official_project_evidence=True):
            markdown, _slug = publish_to_blog.generate_paper_page(paper, '2026-08-26')
            takeover = paper['analysisManifest']['manualTakeover']
            payload = takeover.pop('tutorialPayload')
            payload_sha = takeover.pop('tutorialPayloadSha256')
            paper['analysisManifest']['contracts'].pop('tutorialPayload')
            with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '历史 v5 只读兼容但不得重新包装'):
                publish_to_blog.generate_paper_page(paper, '2026-08-26')
            paper['analysisManifest']['contracts']['tutorialPayload'] = 'manual-v5-tutorial-payload-v1'
            takeover['tutorialPayload'] = payload
            takeover['tutorialPayloadSha256'] = payload_sha
            original_orchestrator = payload['orchestratorFingerprint']
            payload['orchestratorFingerprint'] = '0' * 64
            takeover['tutorialPayloadSha256'] = publish_to_blog._stable_json_sha256(payload)
            with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '统一质量 orchestrator 协议'):
                publish_to_blog.generate_paper_page(paper, '2026-08-26')
            payload['orchestratorFingerprint'] = original_orchestrator
            takeover['tutorialPayloadSha256'] = publish_to_blog._stable_json_sha256(payload)
            quality_path = Path(payload['qualityPath'])
            original_quality_bytes = quality_path.read_bytes()
            quality_path.write_text('{"paperId":"2608.00000"}', encoding='utf-8')
            with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    'qualityPath 文件 SHA 漂移'):
                publish_to_blog.generate_paper_page(paper, '2026-08-26')
            quality_path.write_bytes(original_quality_bytes)
            official_input = next(
                item for item in paper['analysisManifest']['manualTakeover']['freshAuthoring']['inputs']
                if item['kind'] == 'official_project_evidence'
            )
            official_path = Path(official_input['path'])
            original_official_bytes = official_path.read_bytes()
            official_path.write_text(json.dumps({
                'paperId': '2608.00000',
                'kind': 'official_project_evidence',
                'url': 'https://example.org/wrong-paper',
            }), encoding='utf-8')
            with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    'official_project_evidence paperId/kind/HTTPS URL 非法'):
                publish_to_blog.generate_paper_page(paper, '2026-08-26')
            official_path.write_bytes(original_official_bytes)
            article_path = Path(
                paper['analysisManifest']['manualTakeover']['freshAuthoring']['articlePath']
            )
            article_path.write_text(reader_article + '\n\n旧稿注入。', encoding='utf-8')
            with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    'fresh article.md raw/NFKC SHA 或正文发生漂移'):
                publish_to_blog.generate_paper_page(paper, '2026-08-26')
        self.assertIn('# 📄 两条表示如何统一听懂与生成音频', markdown)
        self.assertIn('> 英文题目：*[A General Purpose Audio Model](https://arxiv.org/abs/2608.24168)*', markdown)
        self.assertIn('> 一句话：**共享语言推理而分离音频表示', markdown)
        self.assertIn('> 标签：#音频理解', markdown)
        self.assertIn('> 评分：**8.7/10**', markdown)
        self.assertIn('### 💬 毒舌点评', markdown)
        self.assertIn('### 🔗 开源与复现资源', markdown)
        self.assertLess(markdown.index('> 英文题目：'), markdown.index('> 标签：#音频理解'))
        self.assertLess(markdown.index('> 标签：#音频理解'), markdown.index('> 评分：**8.7/10**'))
        self.assertLess(markdown.index('> 评分：**8.7/10**'), markdown.index('### 💬 毒舌点评'))
        self.assertLess(markdown.index('### 💬 毒舌点评'), markdown.index('### 📌 核心摘要'))
        self.assertIn('#### 先解释表示冲突', markdown)
        self.assertIn('#### 再追踪两条通路', markdown)
        self.assertNotRegex(markdown, r'(?m)^### 先解释表示冲突$')
        self.assertIn('## 🧭 深度解读', markdown)
        self.assertLess(markdown.index('### 📌 核心摘要'), markdown.index('### 🔗 开源与复现资源'))
        self.assertLess(markdown.index('### 🔗 开源与复现资源'), markdown.index('## 🧭 深度解读'))
        self.assertLess(markdown.index('## 🧭 深度解读'), markdown.index('#### 先解释表示冲突'))
        self.assertNotIn('### 🏗️ 方法概述和架构', markdown)
        self.assertIn('<summary>📎 论文与评分元数据</summary>', markdown)
        self.assertIn('### ⚖️ 评分依据与证据（展开查看）', markdown)
        self.assertGreater(
            markdown.index('### ⚖️ 评分依据与证据（展开查看）'),
            markdown.index('<summary>📎 论文与评分元数据</summary>'),
        )

    def test_manual_v5_never_falls_back_to_legacy_canonical_sections(self):
        paper = {
            'title': 'Legacy prose must not become a new tutorial',
            'arxivId': '2608.29999',
            'parsed': {
                'score': '7.0', 'tags': ['#音频理解'],
                'summary': '旧摘要。', 'architecture': '旧方法。',
                'innovation': '旧创新。', 'results': '旧结果。',
                'details': '旧细节。', 'limitations': '旧局限。',
            },
            'analysisManifest': {
                'contracts': {'manualDepth': 'full-text-evidence-v5'},
                'manualTakeover': {'researchBrief': {'editorialPlan': {
                    'version': 2,
                    'readerTitle': '缺少新正文的页面',
                    'oneSentenceThesis': '这条记录故意缺少可验证的新正文。',
                }}},
            },
        }
        with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError,
                '禁止从旧 canonical 固定章节回拼正文'):
            publish_to_blog.generate_paper_page(paper, '2026-08-27')

    def test_manual_v6_entry_render_uses_only_canonical_blocks_and_explicit_bindings(self):
        paper = manual_v6_publication_fixture()
        payload = validate_manual_v6_payload(paper)
        markdown, _slug = publish_to_blog.generate_paper_page(
            paper, '2026-08-28', '论文速递',
        )
        self.assertIn('paper_digest_manual_depth: "full-text-evidence-v6"', markdown)
        self.assertIn('paper_digest_v6_runtime_mode: "production"', markdown)
        self.assertIn('paper_digest_reader_longform: "reader-longform-v2"', markdown)
        self.assertIn(
            f'paper_digest_reader_article_sha256: "{payload["articleSha256"]}"',
            markdown,
        )
        self.assertIn('#### 逐行读取完整结果表', markdown)
        self.assertIn('**LibriSpeech test-clean 完整结果**', markdown)
        self.assertIn('| 完整方法 | 7.1% |', markdown)
        # The publisher nests canonical block headings but does not use a
        # separately supplied Markdown article as its rendering authority.
        self.assertNotRegex(markdown, r'(?m)^### 逐行读取完整结果表$')

        bindings = publish_to_blog.manual_v6_publication_bindings([paper])
        self.assertEqual(bindings[0]['manualDepth'], 'full-text-evidence-v6')
        self.assertEqual(bindings[0]['runtimeMode'], 'production')
        self.assertEqual(bindings[0]['recordSemanticSha256'], 'c' * 64)
        self.assertEqual(bindings[0]['readerArticleSha256'], payload['articleSha256'])

    def test_manual_v6_longform_string_sha_matches_node_raw_utf8_vector(self):
        # manual-longform-contract.js hashes String(value) bytes directly;
        # this guards against accidentally switching to workflow stable JSON.
        self.assertEqual(
            _manual_v6_text_sha('中|A\n'),
            '84996bd499282e0fed65f8ddee3bf3aae24edbe1cb31bea3496c723960d96dbf',
        )

    def test_manual_v6_declared_payload_never_falls_back_on_missing_or_tampered_data(self):
        missing = manual_v6_publication_fixture()
        del missing['manualReaderLongform']['formulas']
        with self.assertRaisesRegex(PublishDataValidationError, 'semantic SHA|formulas'):
            publish_to_blog.generate_paper_page(missing, '2026-08-28')

        tampered = manual_v6_publication_fixture()
        tampered['manualReaderLongform']['tables'][0]['renderedMarkdown'] = '| 篡改 | 0 |'
        with self.assertRaisesRegex(PublishDataValidationError, 'semantic SHA|确定性渲染'):
            publish_to_blog.generate_paper_page(tampered, '2026-08-28')

        provenance_drift = manual_v6_publication_fixture()
        provenance_drift['analysisManifest']['manualTakeover']['v6Provenance'][
            'recordFileSha256'
        ] = '0' * 64
        with self.assertRaisesRegex(PublishDataValidationError, 'provenance'):
            publish_to_blog.generate_paper_page(provenance_drift, '2026-08-28')

        shadow = manual_v6_publication_fixture()
        shadow['manualV6Provenance']['runtimeMode'] = 'shadow'
        shadow['analysisManifest']['manualTakeover']['v6Provenance']['runtimeMode'] = 'shadow'
        with self.assertRaisesRegex(PublishDataValidationError, 'shadow 禁止发布'):
            publish_to_blog.generate_paper_page(shadow, '2026-08-28')

        missing_revision = manual_v6_publication_fixture()
        del missing_revision['manualReaderLongform']['finalRevisionAuthorReceipt']
        longform_sha = _manual_v6_hash(missing_revision['manualReaderLongform'])
        missing_revision['manualV6Provenance']['readerLongformSha256'] = longform_sha
        missing_revision['analysisManifest']['manualTakeover']['v6Provenance'][
            'readerLongformSha256'
        ] = longform_sha
        missing_revision['analysisManifest']['sourceAcquisition'][
            'readerLongformSha256'
        ] = longform_sha
        with self.assertRaisesRegex(PublishDataValidationError, 'finalRevisionAuthorReceipt'):
            publish_to_blog.generate_paper_page(missing_revision, '2026-08-28')

        colliding_tasks = manual_v6_publication_fixture()
        colliding_tasks['manualReaderLongform']['finalRevisionAuthorReceipt'][
            'taskName'
        ] = colliding_tasks['manualReaderLongform']['authorReceipt']['taskName']
        longform_sha = _manual_v6_hash(colliding_tasks['manualReaderLongform'])
        colliding_tasks['manualV6Provenance']['readerLongformSha256'] = longform_sha
        colliding_tasks['analysisManifest']['manualTakeover']['v6Provenance'][
            'readerLongformSha256'
        ] = longform_sha
        colliding_tasks['analysisManifest']['sourceAcquisition'][
            'readerLongformSha256'
        ] = longform_sha
        with self.assertRaisesRegex(PublishDataValidationError, 'taskName 重复'):
            publish_to_blog.generate_paper_page(colliding_tasks, '2026-08-28')

    def test_manual_v6_final_page_gate_binds_exact_rendered_block_bytes(self):
        paper = manual_v6_publication_fixture()
        markdown, _slug = publish_to_blog.generate_paper_page(paper, '2026-08-28')
        sanitized = publish_to_blog.sanitize_markdown_for_publish(markdown)
        # This compact publisher fixture deliberately omits the large v5
        # resultClaims ledger, so a pristine page may fail later at that
        # independent gate.  It must first pass the v6 deterministic replay.
        pristine_issue = publish_to_blog.validate_final_manual_v4_markdown(
            sanitized, paper,
        ) or ''
        self.assertNotIn('确定性渲染', pristine_issue)
        altered = sanitized.replace('完整方法由 8.4% 降到 7.1%', '完整方法由 8.4% 降到 7.2%')
        self.assertIn(
            '确定性渲染',
            publish_to_blog.validate_final_manual_v4_markdown(altered, paper),
        )

    def test_generation_manifest_recomputes_v6_explicit_bindings(self):
        paper = manual_v6_publication_fixture()
        date_str = '2026-08-28'
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            page = posts / f'{date_str}-manual-v6.md'
            page.write_text('v6 page\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(
                        publish_to_blog, 'generation_manifest_path',
                        return_value=Path(tmp) / 'generation.json',
                    ), mock.patch.object(
                        publish_to_blog, 'review_receipt_path',
                        return_value=Path(tmp) / 'receipt.json',
                    ), mock.patch.object(
                        publish_to_blog, 'review_failure_path',
                        return_value=Path(tmp) / 'failure.json',
                    ), mock.patch.object(
                        publish_to_blog, 'save_review_pass_cache', return_value=None,
                    ):
                fingerprint = publish_to_blog.generation_input_fingerprint(
                    [paper], date_str, '论文速递', False,
                )
                manifest_path = publish_to_blog.save_generation_manifest(
                    date_str, [page], input_fingerprint=fingerprint,
                    template_fingerprint='1' * 64, base_head='2' * 40,
                    published_papers=[paper], publish_all=False,
                )
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                self.assertEqual(len(manifest['manualV6Bindings']), 1)
                self.assertEqual(manifest['publicationMode'], 'manual_v6_production')
                self.assertEqual(manifest['manualV6Production']['recordsVersion'], 4)
                self.assertEqual(
                    manifest['manualV6Production']['specMerkleRootSha256'],
                    paper['manualV6Provenance']['specRootSha256'],
                )
                publish_to_blog._validate_generation_input_integrity(manifest, date_str)
                manifest['manualV6Bindings'][0]['readerArticleSha256'] = '0' * 64
                with self.assertRaisesRegex(PublishDataValidationError, 'v6'):
                    publish_to_blog._validate_generation_input_integrity(manifest, date_str)

    def test_generation_manifest_recomputes_llm_api_production_bindings(self):
        paper = llm_api_publication_fixture()
        date_str = '2026-08-31'
        bindings = publish_to_blog.llm_api_publication_bindings([paper])
        self.assertEqual(len(bindings), 1)
        self.assertEqual(bindings[0]['readerContract'], 'beginner-researcher-v2')
        self.assertEqual(bindings[0]['scoringContract'], 'api-scoring-audit-v2')
        self.assertEqual(bindings[0]['model'], 'muse-spark-1.2-contributor')
        self.assertEqual(
            publish_to_blog.infer_generation_publication_mode([paper]),
            'llm_api_production',
        )
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            page = posts / f'{date_str}-llm-api.md'
            page.write_text('api page\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(
                        publish_to_blog, 'generation_manifest_path',
                        return_value=Path(tmp) / 'generation.json',
                    ), mock.patch.object(
                        publish_to_blog, 'review_receipt_path',
                        return_value=Path(tmp) / 'receipt.json',
                    ), mock.patch.object(
                        publish_to_blog, 'review_failure_path',
                        return_value=Path(tmp) / 'failure.json',
                    ), mock.patch.object(
                        publish_to_blog, 'save_review_pass_cache', return_value=None,
                    ):
                fingerprint = publish_to_blog.generation_input_fingerprint(
                    [paper], date_str, '论文速递', False,
                )
                manifest_path = publish_to_blog.save_generation_manifest(
                    date_str, [page], input_fingerprint=fingerprint,
                    template_fingerprint='1' * 64, base_head='2' * 40,
                    published_papers=[paper], publish_all=False,
                )
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                self.assertEqual(manifest['publicationMode'], 'llm_api_production')
                self.assertEqual(len(manifest['llmApiBindings']), 1)
                self.assertEqual(
                    manifest['llmApiProduction']['contract'],
                    'llm-api-production-publication-v1',
                )
                publish_to_blog._validate_generation_input_integrity(manifest, date_str)
                manifest['llmApiBindings'][0]['readerArticleSha256'] = '0' * 64
                with self.assertRaisesRegex(PublishDataValidationError, 'LLM API'):
                    publish_to_blog._validate_generation_input_integrity(manifest, date_str)

        tampered = llm_api_publication_fixture()
        tampered['analysisManifest']['stages']['scoringAudit'][
            'outputAnalysisSha256'
        ] = '0' * 64
        with self.assertRaisesRegex(PublishDataValidationError, '评分审计'):
            publish_to_blog.llm_api_production_proof([tampered])

    def test_manual_v5_renders_selected_figure_only_from_reader_article(self):
        url = 'https://arxiv.org/html/2608.29999/figure-1.png'
        legacy_lead = '摘要先概括论文问题，并说明为什么这张图只应在权威读者长文中负责图文论证。'
        legacy_explanation = '该图的解释应由读者长文独占，避免同一证据在摘要和正文重复出现。'
        reader_article = (
            '### 图只服务于长文论证\n\n'
            '长文先说明这张结构图回答的具体问题，并保留其解释边界。\n\n'
            f'![结构图]({url})\n\n'
            '图中箭头只支持已经绘出的模块连接，不能推出没有测量的训练或部署结论。'
        )
        paper = {
            'title': 'Reader-first Figure Ownership',
            'arxivId': '2608.29999',
            'selectedImageUrls': [url],
            'parsed': {
                'score': '8.0', 'tags': ['#音频理解'],
                'summary': (
                    f'{legacy_lead}\n\n'
                    f'![旧摘要中的重复图]({url})\n\n'
                    f'{legacy_explanation}'
                ),
                'roast': '优点是图文论证有明确机制；不足是没有额外的部署测量。',
                'opensource': '代码：尚未公开。',
                'scoringReason': '* 创新性 (1.6/2)：有明确机制与边界。',
            },
            'analysisManifest': {
                'contracts': {'manualDepth': 'full-text-evidence-v5'},
                'manualTakeover': {'researchBrief': {'editorialPlan': {
                    'version': 2,
                    'readerFormatContract': 'graduate-researcher-tutorial-quality-v2',
                    'readerTitle': '由读者长文唯一持有图文证据',
                    'oneSentenceThesis': '图应当只在绑定了问题、读法和边界的读者长文里出现一次。',
                }}, 'readerArticle': reader_article,
                'readerArticleSha256': hashlib.sha256(reader_article.encode('utf-8')).hexdigest()},
            },
            'imageManifest': {'selected': [{'index': 1, 'url': url}], 'insertionPlan': [{
                'imageNumber': 1, 'lead': legacy_lead, 'explanation': legacy_explanation,
            }]},
        }
        with manual_v5_fresh_files(paper, '2026-08-27'):
            markdown, _slug = publish_to_blog.generate_paper_page(paper, '2026-08-27')
        self.assertEqual(markdown.count(url), 1)
        self.assertIn(f'![结构图]({url})', markdown)
        self.assertNotIn('旧摘要中的重复图', markdown)
        summary = re.search(
            r'### 📌 核心摘要\n\n([\s\S]*?)(?=\n### 🔗 开源与复现资源)', markdown,
        )
        self.assertIsNotNone(summary)
        self.assertNotIn(legacy_lead, summary.group(1))
        self.assertNotIn(legacy_explanation, summary.group(1))

    def test_publish_image_exclusion_contract_rejects_broad_or_unexplained_entries(self):
        configured = publish_to_blog.load_publish_image_exclusions()
        self.assertEqual(configured, [{
            'normalizedArxivId': '2608.13610',
            'url': 'https://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg',
            'reason': '图片内含 “Manul debugging” 拼写错误',
        }])
        invalid_entries = (
            {
                'normalizedArxivId': '2608.13610v1',
                'url': 'https://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg',
                'reason': 'bad id',
            },
            {
                'normalizedArxivId': '2608.13610',
                'url': 'http://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg',
                'reason': 'insecure url',
            },
            {
                'normalizedArxivId': '2608.13610',
                'url': 'https://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg',
                'reason': '   ',
            },
        )
        for index, entry in enumerate(invalid_entries):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as tmp:
                config = Path(tmp) / 'exclusions.json'
                config.write_text(json.dumps({
                    'schemaVersion': 1,
                    'exclusions': [entry],
                }), encoding='utf-8')
                with self.assertRaises(publish_to_blog.PublishDataValidationError):
                    publish_to_blog.load_publish_image_exclusions(config)

    def test_generation_removes_only_exact_overridden_image_block_and_records_manifest(self):
        date_str = '2026-08-17'
        excluded_url = 'https://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg'
        retained_url = 'https://arxiv.org/html/2608.13610v1/Fig/2_framework.jpg'
        intro_lead = '传统手动维护需要工程师跨多个VSR阶段追踪故障，如下图所示。'
        intro_explanation = (
            '下图对比了人工调试与AI修复流程，显示LoopVSR如何通过定义修复目标、'
            '运行时证据和评估规则来指导编码代理进行验证修复。'
        )
        framework_lead = '架构包含 5 个关键组件，如下图所示。'
        framework_explanation = '下图展示了 LoopVSR 的总体架构与闭环修复流程。'
        summary = (
            f'{intro_lead}\n\n![错误动机图]({excluded_url})\n\n'
            f'{intro_explanation}\n\n保留的核心摘要。\n\n'
            f'{framework_lead}\n\n![合法框架图]({retained_url})\n\n'
            f'{framework_explanation}'
        )
        analysis = f'''## 评分
6.6/10

## 机器摘要
document_type: 方法研究
rank_bucket: 前50%
confidence: 中

## 标签
#音视频语音识别 #大语言模型

## 核心摘要
{summary}

## 方法概述和架构
{summary}

## 评分理由
* 创新性 (1/2)：具体理由充分
* 技术严谨性 (1/1.5)：具体理由充分
* 实验充分性 (0.8/1.5)：具体理由充分
* 清晰度 (0.8/1)：具体理由充分
* 影响力 (0.5/1.5)：具体理由充分
* 开源 (1.2/1.5)：具体理由充分
* 可复现性 (0.3/0.5)：具体理由充分
* 工程/实践价值 (1/1.5)：具体理由充分
'''
        source_paper = {
            'arxivId': '2608.13610v1',
            'title': 'LoopVSR',
            'fetchBatchDate': date_str,
            'analysis': analysis,
            'parsed': publish_to_blog.parse_analysis(analysis),
            'scoringRubricVersion': 'type-aware-v1',
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            options = {
                'data_file': 'unused-test-input.json',
                'target_date': date_str,
                'category': '论文速递',
                'publish_all': False,
                'excluded_ids': [],
                'legacy_v5_maintenance': True,
            }
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CONTENT_DIR', str(posts)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(
                        publish_to_blog, 'validate_publish_target',
                        return_value=(repo, posts),
                    ), mock.patch.object(
                        publish_to_blog, 'load_papers', return_value=[source_paper],
                    ), contextlib.redirect_stdout(io.StringIO()):
                publish_to_blog.generate_main(options)

                paper_page = next(posts.glob(f'{date_str}-loopvsr-*.md'))
                index_page = posts / f'{date_str}.md'
                for generated in (paper_page, index_page):
                    markdown = generated.read_text(encoding='utf-8')
                    self.assertEqual(markdown.count(excluded_url), 0)
                    self.assertNotIn(intro_lead, markdown)
                    self.assertNotIn(intro_explanation, markdown)
                    self.assertIn(retained_url, markdown)
                    self.assertIn(framework_lead, markdown)
                    self.assertIn(framework_explanation, markdown)

                manifest = json.loads(
                    publish_to_blog.generation_manifest_path(date_str).read_text(encoding='utf-8')
                )
                snapshot = manifest['publishedPapers'][0]
                self.assertEqual(snapshot['publishImageExclusions'], [{
                    'normalizedArxivId': '2608.13610',
                    'url': excluded_url,
                    'reason': '图片内含 “Manul debugging” 拼写错误',
                }])
                self.assertEqual(
                    snapshot['publishImageExclusionView']['excludedUrls'],
                    [excluded_url],
                )
                self.assertEqual(
                    snapshot['publishImageExclusionView']['analysisSha256'],
                    hashlib.sha256(snapshot['analysis'].encode('utf-8')).hexdigest(),
                )
                self.assertNotIn(excluded_url, snapshot['parsed']['summary'])
                self.assertIn(retained_url, snapshot['parsed']['summary'])
                self.assertNotIn(excluded_url, snapshot['analysis'])
                self.assertIn(retained_url, snapshot['analysis'])
                self.assertEqual(
                    manifest['inputFingerprint'],
                    publish_to_blog.generation_input_fingerprint(
                        manifest['publishedPapers'], date_str, '论文速递', False,
                    ),
                )

                tampered = json.loads(
                    publish_to_blog.generation_manifest_path(date_str).read_text(encoding='utf-8')
                )
                tampered['publishedPapers'][0]['publishImageExclusions'][0]['reason'] = (
                    'tampered without changing inputFingerprint'
                )
                publish_to_blog.generation_manifest_path(date_str).write_text(
                    json.dumps(tampered, ensure_ascii=False), encoding='utf-8',
                )
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '反向重算',
                ):
                    publish_to_blog.load_generation_manifest(date_str)

        self.assertIn(excluded_url, source_paper['parsed']['summary'])
        self.assertIn(excluded_url, source_paper['analysis'])

    def test_publish_image_exclusion_preserves_unrelated_adjacent_prose(self):
        excluded_url = 'https://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg'
        before = '该方法在多种输入条件下均保持稳定。'
        after = '消融实验进一步验证了闭环反馈的贡献。'
        cleaned = publish_to_blog._remove_publish_image_block(
            f'{before}\n\n![待排除图片]({excluded_url})\n\n{after}', excluded_url,
        )
        self.assertEqual(cleaned, f'{before}\n\n{after}')

    def test_publish_image_exclusion_synchronizes_selected_view_and_exact_plan_neighbors(self):
        url = 'https://arxiv.org/html/2608.13610v1/Fig/intro_1.jpg'
        lead = '承接 LoopVSR 的运行时证据，下图用于核对人工调试与代理修复两条分支。'
        explanation = '图中箭头显示两条分支进入同一评估器；该结构仅限图示流程，不能证明未报告阶段。'
        paper = {
            'arxivId': '2608.13610',
            'analysis': f'## 方法概述和架构\n正文。\n\n{lead}\n\n![流程]({url})\n\n{explanation}\n\n结论。',
            'selectedImageUrls': [url],
            'imageManifest': {
                'selected': [{'index': 1, 'url': url}],
                'insertionPlan': [{
                    'imageNumber': 1, 'lead': lead, 'explanation': explanation,
                }],
                'insertionDiagnostics': [{'imageNumber': 1, 'inserted': True}],
            },
        }
        derived = publish_to_blog.apply_publish_image_exclusions([paper], [{
            'normalizedArxivId': '2608.13610',
            'url': url,
            'reason': '图内拼写错误，发布视图必须排除。',
        }])[0]
        self.assertEqual(derived['selectedImageUrls'], [])
        self.assertNotIn(url, derived['analysis'])
        self.assertNotIn(lead, derived['analysis'])
        self.assertNotIn(explanation, derived['analysis'])
        self.assertEqual(derived['publishImageExclusionView']['excludedUrls'], [url])
        self.assertEqual(
            derived['publishImageExclusionView']['analysisSha256'],
            hashlib.sha256(derived['analysis'].encode('utf-8')).hexdigest(),
        )
        self.assertEqual(
            derived['publishImageExclusionView']['effectiveSelectedImageUrls'], [],
        )
        _validate_publish_image_exclusion_view(derived, '2608.13610')
        tampered = dict(derived)
        tampered['publishImageExclusionView'] = dict(
            derived['publishImageExclusionView'], analysisSha256='0' * 64,
        )
        with self.assertRaisesRegex(PublishDataValidationError, '当前 analysis 不一致'):
            _validate_publish_image_exclusion_view(tampered, '2608.13610')
        self.assertIsNone(validate_image_narrative_contract(derived))

        manifest_selected_only = dict(paper)
        manifest_selected_only.pop('selectedImageUrls')
        fallback = publish_to_blog.apply_publish_image_exclusions(
            [manifest_selected_only], [{
                'normalizedArxivId': '2608.13610',
                'url': url,
                'reason': '图内拼写错误，发布视图必须排除。',
            }],
        )[0]
        self.assertEqual(fallback['selectedImageUrls'], [])
        _validate_publish_image_exclusion_view(fallback, '2608.13610')

    def test_published_papers_fingerprint_matches_node_utf16_key_order_probe(self):
        probe = json.loads(
            (Path(ROOT) / 'tests' / 'fixtures' / 'published-papers-fingerprint-probe.json')
            .read_text(encoding='utf-8')
        )
        # Shared with the Node-side probe. U+E000 sorts before non-BMP keys by
        # Unicode code point, but after their leading surrogate by JS UTF-16.
        self.assertEqual(
            publish_to_blog.published_papers_fingerprint(probe),
            '3ee65da42ed04aa221d4429d960f7b60ed86fb5bee62f428ec67d2f8d2171882',
        )

    def test_same_title_slug_is_disambiguated_by_normalized_arxiv_id(self):
        first = publish_to_blog.paper_slug('Same title', '2607.00001v2')
        second = publish_to_blog.paper_slug('Same title', '2607.00002')
        self.assertEqual(first, 'same-title-2607-00001')
        self.assertEqual(second, 'same-title-2607-00002')

    def test_text_review_covers_every_chunk(self):
        content = 'A' * 7990 + '\nSECOND-CHUNK-MARKER\n' + 'B' * 100
        valid = '{"passed": true, "issues": []}'
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CHUNK_CHARS': '8000'}), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=valid) as call:
            passed, issues, reviewed = publish_to_blog.llm_review_post(content, '标题', required=True)
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(reviewed, content)
        self.assertGreater(call.call_count, 1)
        prompts = ''.join(item.args[0] for item in call.call_args_list)
        self.assertIn('SECOND-CHUNK-MARKER', prompts)
        self.assertIn('AAAA', prompts)
        self.assertTrue(all(item.kwargs['structured_output'] for item in call.call_args_list))

    def test_review_chunk_budget_defaults_to_8000_and_is_bounded(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(publish_to_blog.get_blog_review_chunk_chars(), 8000)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CHUNK_CHARS': '100'}):
            self.assertEqual(publish_to_blog.get_blog_review_chunk_chars(), 4000)
        with mock.patch.dict(os.environ, {'PD_BLOG_REVIEW_CHUNK_CHARS': '99999'}):
            self.assertEqual(publish_to_blog.get_blog_review_chunk_chars(), 16000)

    def test_review_split_keeps_table_header_with_separator(self):
        content = 'A' * 20 + '\n| 方法 | 得分 |\n| --- | --- |\n| A | 1 |\n'
        chunks = publish_to_blog.split_review_content(content, limit=36)
        table_chunk = next(chunk for chunk in chunks if '| 方法 | 得分 |' in chunk)
        self.assertIn('| --- | --- |', table_chunk)
        self.assertEqual(''.join(chunks), content)

    def test_image_review_sends_actual_image_payload(self):
        image = {'media_type': 'image/png', 'data': 'cG5nLWJ5dGVz'}
        response = '{"passed": true, "issues": []}'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=response) as call:
            passed, issues = publish_to_blog.multimodal_review_images(
                '![实验曲线](https://arxiv.org/curve.png)', '标题', required=True
            )
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        self.assertEqual(call.call_args.kwargs['images'], [image])
        self.assertTrue(call.call_args.kwargs['use_secondary'])
        self.assertTrue(call.call_args.kwargs['structured_output'])
        self.assertIn('正文附近上下文', call.call_args.args[0])

    def test_image_review_prompt_contains_nearby_body_context(self):
        image = {'media_type': 'image/png', 'data': 'cG5n'}
        response = '{"passed": true, "issues": []}'
        content = '## 实验结果\n前文指标提升 12%。\n![消融曲线](https://example.com/a.png)\n后文解释低频误差。'
        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', return_value=image), \
                mock.patch.object(publish_to_blog, 'call_llm_api', return_value=response) as call:
            publish_to_blog.multimodal_review_images(content, '标题', required=True)
        prompt = call.call_args.args[0]
        self.assertIn('前文指标提升 12%', prompt)
        self.assertIn('后文解释低频误差', prompt)

    def test_image_review_keeps_payload_and_context_aligned_after_download_failure(self):
        content = (
            '![失败图](https://example.com/failed.png)\n失败图上下文\n'
            '![成功图](https://example.com/ok.png)\n成功图上下文'
        )
        image = {'media_type': 'image/png', 'data': 'cG5n'}

        def load(url):
            if url.endswith('failed.png'):
                raise publish_to_blog.PublishDataValidationError('模拟超时')
            return image

        with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                mock.patch.object(publish_to_blog, '_load_review_image', side_effect=load), \
                mock.patch.object(
                    publish_to_blog,
                    'call_llm_api',
                    return_value='{"passed": true, "issues": []}',
                ) as call:
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题')

        self.assertTrue(passed)
        self.assertEqual(len(call.call_args.kwargs['images']), 1)
        prompt = call.call_args.args[0]
        self.assertIn('alt: `成功图`', prompt)
        self.assertNotIn('alt: `失败图`', prompt)
        self.assertEqual(issues[0]['severity'], 'warning')

    def test_image_review_skips_secondary_call_when_secondary_model_is_unconfigured(self):
        content = '![结果图](https://arxiv.org/result.png)'
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(publish_to_blog, 'call_llm_api') as call:
            passed, issues = publish_to_blog.multimodal_review_images(content, '标题', required=True)
        self.assertTrue(passed)
        self.assertEqual(issues, [])
        call.assert_not_called()

    def test_image_download_rejects_dns_rebinding_peer(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ('10.0.0.8', 443)
        response = mock.Mock()
        response.raw._connection.sock = sock
        response.status_code = 200
        response.headers = {'Content-Type': 'image/png'}
        session = mock.MagicMock()
        session.get.return_value = response
        with mock.patch.object(publish_to_blog.socket, 'getaddrinfo', return_value=[
            (publish_to_blog.socket.AF_INET, publish_to_blog.socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
        ]), mock.patch('requests.Session', return_value=session):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '已配置代理 peer'):
                publish_to_blog._download_review_image('https://example.com/a.png')
        response.close.assert_called_once()

    def test_image_download_rejects_global_peer_outside_validated_dns_set(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ('93.184.216.35', 443)
        response = mock.Mock()
        response.raw._connection.sock = sock
        response.status_code = 200
        response.headers = {'Content-Type': 'image/png'}
        session = mock.MagicMock()
        session.get.return_value = response
        with mock.patch.object(publish_to_blog.socket, 'getaddrinfo', return_value=[
            (publish_to_blog.socket.AF_INET, publish_to_blog.socket.SOCK_STREAM, 6, '', ('93.184.216.34', 443)),
        ]), mock.patch('requests.Session', return_value=session):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '已配置代理 peer'):
                publish_to_blog._download_review_image('https://example.com/a.png')

    def test_image_download_accepts_the_explicit_proxy_peer_after_public_url_validation(self):
        sock = mock.Mock()
        sock.getpeername.return_value = ('127.0.0.1', 7897)
        response = mock.Mock()
        response.raw._connection.sock = sock
        response.status_code = 200
        response.headers = {'Content-Type': 'image/png', 'Content-Length': '8'}
        response.iter_content.return_value = [b'\x89PNG\r\n\x1a\n']
        session = mock.MagicMock()
        session.get.return_value = response
        def resolve(host, *_args, **_kwargs):
            address = '127.0.0.1' if host == '127.0.0.1' else '93.184.216.34'
            return [(publish_to_blog.socket.AF_INET, publish_to_blog.socket.SOCK_STREAM, 6, '', (address, 443))]

        with mock.patch.object(publish_to_blog.socket, 'getaddrinfo', side_effect=resolve), \
                mock.patch('requests.Session', return_value=session), \
                mock.patch.object(publish_to_blog, 'get_required_fetch_proxy', return_value='http://127.0.0.1:7897'):
            image = publish_to_blog._download_review_image('https://example.com/a.png')
        self.assertEqual(image['media_type'], 'image/png')
        response.close.assert_called_once()

    def test_publish_date_and_content_target_are_strict(self):
        for invalid in ('2026-2-03', '2026-02-30', '../2026-07-10'):
            with self.assertRaises(publish_to_blog.PublishDataValidationError):
                publish_to_blog.validate_publish_date(invalid)
        self.assertEqual(publish_to_blog.validate_publish_date('2026-07-10'), '2026-07-10')

        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            repo.mkdir()
            with self.assertRaises(publish_to_blog.PublishDataValidationError):
                publish_to_blog.validate_publish_target(repo, Path(tmp) / 'outside')

    def test_install_deletes_only_explicitly_owned_stale_paper_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staged = root / 'staged'
            target = root / 'content' / 'posts'
            staged.mkdir()
            target.mkdir(parents=True)
            (staged / '2026-07-10.md').write_text('new index', encoding='utf-8')
            (staged / '2026-07-10-paper-2607-00001.md').write_text('new paper', encoding='utf-8')
            stale = target / '2026-07-10-old-title.md'
            stale.write_text('''---
title: old
date: 2026-07-10
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
---
old
''', encoding='utf-8')
            manual_same_date = target / '2026-07-10-manual-note.md'
            manual_same_date.write_text('manual', encoding='utf-8')
            other_date = target / '2026-07-09-keep.md'
            other_date.write_text('keep', encoding='utf-8')

            changes = publish_to_blog.install_staged_posts(staged, target, '2026-07-10')
            self.assertFalse(stale.exists())
            self.assertTrue(manual_same_date.exists())
            self.assertTrue(other_date.exists())
            self.assertTrue((target / '2026-07-10-paper-2607-00001.md').exists())
            self.assertIn(stale, changes)

    def test_yaml_gate_rejects_duplicate_keys_and_hugo_has_fallback(self):
        markdown = '''---
title: "Test"
title: "Duplicate"
date: 2026-07-10
draft: false
tags: []
categories: [test]
description: "test"
---
body
'''
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            (posts / '2026-07-10.md').write_text(markdown, encoding='utf-8')
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '重复字段'):
                publish_to_blog.validate_staged_posts(posts, '2026-07-10')
            with mock.patch.object(publish_to_blog.shutil, 'which', return_value=None):
                self.assertEqual(publish_to_blog.run_hugo_gate(tmp, posts), 'fallback')

    def test_staged_validation_reads_each_page_once_and_returns_bound_artifact(self):
        markdown = '''---
title: "Test"
date: 2026-07-10
draft: false
tags: []
categories: [test]
description: "test"
---
body
'''
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            page = posts / '2026-07-10.md'
            page.write_text(markdown, encoding='utf-8')
            artifacts = {}
            original_read_bytes = Path.read_bytes
            with mock.patch.object(
                    Path, 'read_bytes', autospec=True,
                    side_effect=lambda path: original_read_bytes(path),
                ) as read_bytes:
                publish_to_blog.validate_staged_posts(
                    posts, '2026-07-10', artifact_cache=artifacts,
                )
            self.assertEqual(read_bytes.call_count, 1)
            artifact = artifacts[str(page.resolve())]
            self.assertEqual(artifact['version'], 1)
            self.assertEqual(
                artifact['sha256'], hashlib.sha256(page.read_bytes()).hexdigest(),
            )
            self.assertEqual(artifact['frontmatter']['title'], 'Test')
            self.assertEqual(artifact['body'], 'body\n')

    def test_staged_gate_rechecks_marked_index_reader_quality(self):
        markdown = '''---
title: "Test"
date: 2026-07-10
draft: false
tags: []
categories: [test]
description: "test"
paper_digest_pipeline_owned: true
paper_digest_page_type: index
paper_digest_reader_quality: "reader-facing-v1"
---
# 论文速递

## ⚡ 今日概览

共分析三篇论文。

## 📋 论文列表

### Paper A

该论文讨论流式识别。
'''
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            (posts / '2026-07-10.md').write_text(markdown, encoding='utf-8')
            with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '汇总页读者质量门禁失败'):
                publish_to_blog.validate_staged_posts(posts, '2026-07-10')

    def test_manual_v4_marker_survives_render_and_final_staging_gate_blocks_bad_page(self):
        paper = {
            'arxivId': '2608.29999',
            'title': 'Manual V4 Reader Contract',
            'analysis': '',
            'analysisManifest': {
                'contracts': {'manualDepth': 'full-text-evidence-v4'},
            },
        }
        rendered, _slug = publish_to_blog.generate_paper_page(
            paper, '2026-07-10',
        )
        self.assertIn(
            'paper_digest_manual_depth: "full-text-evidence-v4"', rendered,
        )

        markdown = '''---
title: "Manual V4 Reader Contract"
date: 2026-07-10
draft: false
tags: []
categories: [test]
description: "test"
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
paper_digest_arxiv_id: "2608.29999"
paper_digest_manual_depth: "full-text-evidence-v4"
---
### 📌 核心摘要

只有摘要，没有最终读者页的其余必要章节。
'''
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            page = posts / '2026-07-10-manual-v4.md'
            page.write_text(markdown, encoding='utf-8')
            fixed, issues = publish_to_blog.review_and_fix_post(page)
            self.assertFalse(fixed)
            self.assertTrue(any('Manual v4 最终 Markdown 门禁失败' in issue for issue in issues))
            with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    'Manual v4 最终 Markdown 门禁失败'):
                publish_to_blog.validate_staged_posts(posts, '2026-07-10')

    def test_hugo_gate_uses_staging_destination_without_blog_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            completed = SimpleNamespace(returncode=0, stdout='', stderr='')
            with mock.patch.object(publish_to_blog.shutil, 'which', return_value='/usr/bin/hugo'), \
                    mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed) as run:
                self.assertEqual(publish_to_blog.run_hugo_gate(tmp, posts), 'hugo')
            command = run.call_args.args[0]
            self.assertIn('--contentDir', command)
            self.assertIn('--destination', command)
            self.assertIn('--noBuildLock', command)

    def test_tutorial_markdown_format_gate_catches_reader_visible_syntax_and_contract_defects(self):
        frontmatter = {
            'paper_digest_manual_depth': 'full-text-evidence-v5',
            'paper_digest_tutorial_contract': 'graduate-researcher-tutorial-quality-v2',
            'paper_digest_fresh_authoring_contract': 'fresh-authoring-v1',
            'paper_digest_fresh_authoring_sha256': 'a' * 64,
            'paper_digest_reader_article_sha256': 'b' * 64,
            'paper_digest_tutorial_payload_contract': 'manual-v5-tutorial-payload-v1',
            'paper_digest_tutorial_payload_sha256': 'c' * 64,
            'paper_digest_tutorial_quality_sha256': 'd' * 64,
            'paper_digest_tutorial_artifact_plan_sha256': 'e' * 64,
        }
        score_line = (
            '**八维分项：** 创新 1.5/2 ｜ 技术严谨 1.0/1.5 ｜ 实验充分 1.2/1.5 ｜ '
            '清晰度 0.8/1 ｜ 影响力 1.1/1.5 ｜ 开源 1.0/1.5 ｜ 可复现 0.4/0.5 ｜ 工程/实践 1.2/1.5'
        )
        valid = f'''{score_line}

### 方法流程

![流程图](https://example.com/figure.svg)

### 完整结果

| 方法 | 分数 |
| --- | --- |
| A | 1.0 |

公式为 \\(x+y\\)。
'''
        self.assertEqual(
            publish_to_blog.validate_markdown_format_gate('tutorial.md', frontmatter, valid), [],
        )
        missing_fresh = dict(frontmatter)
        missing_fresh.pop('paper_digest_fresh_authoring_contract')
        self.assertTrue(any(
            'fresh-authoring-v1' in issue
            for issue in publish_to_blog.validate_markdown_format_gate(
                'tutorial.md', missing_fresh, valid,
            )
        ))
        missing_tutorial = dict(frontmatter)
        missing_tutorial.pop('paper_digest_tutorial_contract')
        self.assertTrue(any(
            'graduate-researcher-tutorial-quality-v2' in issue
            for issue in publish_to_blog.validate_markdown_format_gate(
                'tutorial.md', missing_tutorial, valid,
            )
        ))
        missing_receipt_sha = dict(frontmatter)
        missing_receipt_sha.pop('paper_digest_fresh_authoring_sha256')
        self.assertTrue(any(
            'paper_digest_fresh_authoring_sha256' in issue
            for issue in publish_to_blog.validate_markdown_format_gate(
                'tutorial.md', missing_receipt_sha, valid,
            )
        ))
        cases = {
            'bare-dollar': valid.replace(r'\(x+y\)', '$x+y$'),
            'bare-display-dollar': valid.replace(r'\(x+y\)', '$$x+y$$'),
            'unpaired-delimiter': valid.replace(r'\(x+y\)', r'\(x+y'),
            'unpaired-bold': valid + '\n**残留加粗',
            'glued-bold': valid + '\n**关键判断。**论文随后给出实验。',
            'missing-score': valid.replace('工程/实践 1.2/1.5', ''),
            'numbered-section-heading': valid.replace('### 方法流程', '### 图 1：方法流程'),
        }
        for name, markdown in cases.items():
            with self.subTest(name=name):
                issues = publish_to_blog.validate_markdown_format_gate(
                    'tutorial.md', frontmatter, markdown,
                )
                self.assertTrue(issues)

    def test_complete_score_line_keeps_all_eight_dimensions_including_zero(self):
        parsed = {
            'score': 6.0,
            'innovationScore': 1.0,
            'technicalRigorScore': 1.0,
            'experimentalSufficiencyScore': 1.0,
            'clarityScore': 0.5,
            'impactScore': 1.0,
            'openSourceScore': 0,
            'reproducibilityScore': 0,
            'engineeringScore': 1.5,
        }
        rendered = publish_to_blog.format_complete_score_line(parsed)
        self.assertIn('开源 0/1.5', rendered)
        self.assertIn('可复现 0/0.5', rendered)
        self.assertEqual(rendered.count(' | '), 8)
        del parsed['engineeringScore']
        self.assertNotIn('工程/实践', publish_to_blog.format_complete_score_line(parsed))

    def test_hugo_rendered_html_gate_binds_source_and_catches_dropped_artifacts(self):
        frontmatter = {
            'title': 'Tutorial page',
            'paper_digest_tutorial_contract': 'graduate-researcher-tutorial-quality-v2',
            'paper_digest_fresh_authoring_contract': 'fresh-authoring-v1',
        }
        body = '''**八维分项：** 创新 1.5/2 ｜ 技术严谨 1.0/1.5 ｜ 实验充分 1.2/1.5 ｜ 清晰度 0.8/1 ｜ 影响力 1.1/1.5 ｜ 开源 1.0/1.5 ｜ 可复现 0.4/0.5 ｜ 工程/实践 1.2/1.5

### 方法流程

![流程图](https://example.com/figure.svg)

### 完整结果

| 方法 | 分数 |
| --- | --- |
| A | 1.0 |

公式为 \\(x+y\\)。
'''
        artifact = {
            'path': '/tmp/tutorial.md', 'frontmatter': frontmatter, 'body': body,
        }
        rendered_article = '''<article>
<h1>Tutorial page</h1>
<p>八维分项： 创新 1.5/2 ｜ 技术严谨 1.0/1.5 ｜ 实验充分 1.2/1.5 ｜ 清晰度 0.8/1 ｜ 影响力 1.1/1.5 ｜ 开源 1.0/1.5 ｜ 可复现 0.4/0.5 ｜ 工程/实践 1.2/1.5</p>
<h3>方法流程</h3><img src="https://example.com/figure.svg">
<h3>完整结果</h3><table><tr><td>A</td></tr></table><p>\\(x+y\\)</p>
</article>'''
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            page = output / 'posts' / 'tutorial' / 'index.html'
            page.parent.mkdir(parents=True)
            page.write_text(f'<html><body>{rendered_article}</body></html>', encoding='utf-8')
            self.assertEqual(
                publish_to_blog.validate_hugo_rendered_html_gate(output, [artifact]), [],
            )
            invalid_rendered_article = rendered_article.replace(
                '<img src="https://example.com/figure.svg">', '**',
            )
            page.write_text(
                f'<html><body>{invalid_rendered_article}</body></html>',
                encoding='utf-8',
            )
            issues = publish_to_blog.validate_hugo_rendered_html_gate(output, [artifact])
            self.assertTrue(any('图片数量不足' in issue for issue in issues))
            self.assertTrue(any('残留 Markdown 加粗标记' in issue for issue in issues))

    def test_run_hugo_gate_executes_rendered_html_contract_after_build(self):
        markdown = '''---
title: "Tutorial page"
date: 2026-07-10
draft: false
tags: []
categories: [test]
description: "test"
paper_digest_tutorial_contract: "graduate-researcher-tutorial-quality-v2"
paper_digest_fresh_authoring_contract: "fresh-authoring-v1"
paper_digest_fresh_authoring_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
paper_digest_reader_article_sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
paper_digest_tutorial_payload_contract: "manual-v5-tutorial-payload-v1"
paper_digest_tutorial_payload_sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
paper_digest_tutorial_quality_sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
paper_digest_tutorial_artifact_plan_sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
---
**八维分项：** 创新 1.5/2 ｜ 技术严谨 1.0/1.5 ｜ 实验充分 1.2/1.5 ｜ 清晰度 0.8/1 ｜ 影响力 1.1/1.5 ｜ 开源 1.0/1.5 ｜ 可复现 0.4/0.5 ｜ 工程/实践 1.2/1.5

### 方法流程

![流程图](https://example.com/figure.svg)

### 完整结果

| 方法 | 分数 |
| --- | --- |
| A | 1.0 |

公式为 \\(x+y\\)。
'''
        rendered = '''<html><body><article><h1>Tutorial page</h1>
<p>八维分项： 创新 1.5/2 ｜ 技术严谨 1.0/1.5 ｜ 实验充分 1.2/1.5 ｜ 清晰度 0.8/1 ｜ 影响力 1.1/1.5 ｜ 开源 1.0/1.5 ｜ 可复现 0.4/0.5 ｜ 工程/实践 1.2/1.5</p>
<h3>方法流程</h3><img src="https://example.com/figure.svg">
<h3>完整结果</h3><table><tr><td>A</td></tr></table><p>\\(x+y\\)</p>
</article></body></html>'''
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            (posts / '2026-07-10-tutorial.md').write_text(markdown, encoding='utf-8')

            def build_output(command, **_kwargs):
                destination = Path(command[command.index('--destination') + 1])
                page = destination / 'posts' / 'tutorial' / 'index.html'
                page.parent.mkdir(parents=True)
                page.write_text(rendered, encoding='utf-8')
                return SimpleNamespace(returncode=0, stdout='', stderr='')

            with mock.patch.object(publish_to_blog.shutil, 'which', return_value='/usr/bin/hugo'), \
                    mock.patch.object(publish_to_blog.subprocess, 'run', side_effect=build_output):
                self.assertEqual(publish_to_blog.run_hugo_gate(tmp, posts), 'hugo')

    def test_push_requires_hugo_but_skip_push_allows_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp) / 'content' / 'posts'
            posts.mkdir(parents=True)
            with mock.patch.object(publish_to_blog.shutil, 'which', return_value=None):
                self.assertEqual(publish_to_blog.run_hugo_gate(tmp, posts), 'fallback')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '要求 Hugo'):
                    publish_to_blog.run_hugo_gate(tmp, posts, required=True)

    def test_legacy_publish_entry_rejects_push_mode(self):
        with mock.patch.object(sys, 'argv', ['publish-to-blog.py', '--push']), \
                mock.patch.object(publish_to_blog, 'review_all_posts') as review, \
                mock.patch.object(publish_to_blog, 'git_push') as push, \
                contextlib.redirect_stderr(io.StringIO()) as output:
            with self.assertRaises(SystemExit) as raised:
                publish_to_blog.main()
        self.assertEqual(raised.exception.code, 2)
        self.assertIn('generate-blog.py', output.getvalue())
        review.assert_not_called()
        push.assert_not_called()

    def test_git_push_rejects_unreviewed_existing_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, remote = init_blog_repo(tmp, with_remote=True)
            (repo / 'README.md').write_text('local commit\n', encoding='utf-8')
            git(repo, 'add', '--', 'README.md')
            git(repo, 'commit', '-m', 'local pending')
            local_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'):
                self.assertFalse(publish_to_blog.git_push('2026-07-10', []))
            remote_head = git(remote, 'rev-parse', 'refs/heads/main').stdout.strip()
            self.assertNotEqual(remote_head, local_head)

    def test_git_push_stages_only_manifest_with_vcs_environment(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, remote = init_blog_repo(tmp, with_remote=True)
            path = posts / '2026-07-10.md'
            path.write_text('content', encoding='utf-8')
            original_env = publish_to_blog.build_child_process_env
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', Path(tmp) / 'data' / 'current'), \
                    mock.patch.object(publish_to_blog, 'build_child_process_env', side_effect=original_env) as env:
                paths = [path]
                save_bound_review_receipt('2026-07-10', paths)
                self.assertTrue(publish_to_blog.git_push('2026-07-10', paths))
            changed_paths = git(repo, 'show', '--pretty=format:', '--name-only', 'HEAD').stdout.splitlines()
            self.assertEqual(set(changed_paths), {
                'content/posts/2026-07-10.md',
                'content/posts/2026-07-10-visual-gate-index.md',
                'content/posts/2026-07-10-visual-gate-paper.md',
            })
            self.assertEqual(
                git(remote, 'rev-parse', 'refs/heads/main').stdout.strip(),
                git(repo, 'rev-parse', 'HEAD').stdout.strip(),
            )
            for call in env.call_args_list:
                self.assertEqual(
                    call.kwargs.get('allowed_keys'),
                    publish_to_blog.VCS_CHILD_ENV_KEYS,
                )

    def test_manifest_rejects_staged_unstaged_and_untracked_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            tracked = posts / '2026-07-10.md'
            tracked.write_text('head\n', encoding='utf-8')
            git(repo, 'add', '--', 'content/posts/2026-07-10.md')
            git(repo, 'commit', '-m', 'track post')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                tracked.write_text('unstaged\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head([tracked])
                git(repo, 'add', '--', 'content/posts/2026-07-10.md')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head([tracked])
                git(repo, 'reset', '--quiet', 'HEAD', '--', 'content/posts/2026-07-10.md')
                tracked.write_text('head\n', encoding='utf-8')
                pipeline = '---\npaper_digest_pipeline_owned: true\n---\ngenerated\n'
                tracked.write_text(pipeline, encoding='utf-8')
                tracked_relative = 'content/posts/2026-07-10.md'
                tracked_expected = publish_to_blog._sha256_file(tracked)
                publish_to_blog.validate_manifest_clean_against_head(
                    [tracked],
                    allow_exact_pipeline_untracked={tracked_relative: tracked_expected},
                )
                tracked.write_text(pipeline + 'manual drift\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head(
                        [tracked],
                        allow_exact_pipeline_untracked={tracked_relative: tracked_expected},
                    )
                tracked.write_text('head\n', encoding='utf-8')
                untracked = posts / '2026-07-10-new.md'
                untracked.write_text('manual\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head([untracked])
                untracked.write_text(pipeline, encoding='utf-8')
                relative = 'content/posts/2026-07-10-new.md'
                expected = publish_to_blog._sha256_file(untracked)
                publish_to_blog.validate_manifest_clean_against_head(
                    [untracked], allow_exact_pipeline_untracked={relative: expected},
                )
                untracked.write_text(pipeline + 'drift\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '人工'):
                    publish_to_blog.validate_manifest_clean_against_head(
                        [untracked], allow_exact_pipeline_untracked={relative: expected},
                    )

    def test_git_commit_failure_restores_preinstall_index_and_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            path = posts / '2026-07-10.md'
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                state = publish_to_blog.capture_git_publish_state([path])
                path.write_text('generated\n', encoding='utf-8')
                hook = repo / '.git' / 'hooks' / 'pre-commit'
                hook.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8')
                hook.chmod(0o755)
                self.assertFalse(publish_to_blog.git_push(
                    '2026-07-10', [path], rollback_state=state,
                ))
            self.assertFalse(path.exists())
            self.assertEqual(git(repo, 'diff', '--cached', '--name-only').stdout, '')
            self.assertEqual(git(repo, 'status', '--porcelain', '--', 'content/posts').stdout, '')

    def test_git_add_failure_restores_preinstall_index_and_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            path = posts / '2026-07-10.md'
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                state = publish_to_blog.capture_git_publish_state([path])
                path.write_text('generated\n', encoding='utf-8')
                original_run = publish_to_blog.subprocess.run

                def fail_git_add(command, *args, **kwargs):
                    if command[:2] == ['git', 'add']:
                        raise subprocess.CalledProcessError(1, command)
                    return original_run(command, *args, **kwargs)

                with mock.patch.object(publish_to_blog.subprocess, 'run', side_effect=fail_git_add):
                    self.assertFalse(publish_to_blog.git_push(
                        '2026-07-10', [path], rollback_state=state,
                    ))
            self.assertFalse(path.exists())
            self.assertEqual(git(repo, 'diff', '--cached', '--name-only').stdout, '')
            self.assertEqual(git(repo, 'status', '--porcelain', '--', 'content/posts').stdout, '')

    def test_push_failure_preserves_local_commit_and_reports_verifiable_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            git(repo, 'remote', 'add', 'origin', str(Path(tmp) / 'missing-remote.git'))
            path = posts / '2026-07-10.md'
            path.write_text('generated\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', Path(tmp) / 'data' / 'current'), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                paths = [path]
                save_bound_review_receipt('2026-07-10', paths)
                self.assertFalse(publish_to_blog.git_push('2026-07-10', paths))
            local_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            self.assertEqual(git(repo, 'show', '--format=%H', '-s', 'HEAD').stdout.strip(), local_head)
            self.assertEqual(git(repo, 'status', '--porcelain', '--', 'content/posts').stdout, '')
            report = output.getvalue()
            self.assertIn(local_head, report)
            self.assertIn('push origin HEAD:main', report)
            self.assertIn('ls-remote origin refs/heads/main', report)

    def test_formal_publish_rejects_non_main_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, _remote = init_blog_repo(tmp)
            git(repo, 'checkout', '-b', 'feature')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'main'):
                    publish_to_blog.validate_git_publish_branch()

    def test_generation_never_calls_review_or_push(self):
        paper = {
            'title': 'Blocked paper',
            'arxivId': '2607.00001',
            'parsed': {'score': '7', 'tags': []},
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo, content_dir, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            old_page = content_dir / '2026-07-10-old.md'
            old_page.write_text('original', encoding='utf-8')
            git(repo, 'add', '--', 'content/posts/2026-07-10-old.md')
            git(repo, 'commit', '-m', 'existing generated page')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CONTENT_DIR', str(content_dir)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'load_papers', return_value=[paper]), \
                    mock.patch.object(publish_to_blog, 'validate_papers_for_publish', return_value=[paper]), \
                    mock.patch.object(publish_to_blog, 'score_and_sort', return_value=([(7.0, paper, paper['parsed'])], [])), \
                    mock.patch.object(publish_to_blog, 'review_all_posts') as review, \
                    mock.patch.object(publish_to_blog, 'git_push') as push, \
                    mock.patch.object(sys, 'argv', [
                        'publish-to-blog.py', '--all', '--date', '2026-07-10',
                        '--legacy-v5-maintenance',
                    ]), \
                    contextlib.redirect_stdout(io.StringIO()):
                publish_to_blog.main()
            review.assert_not_called()
            push.assert_not_called()
            self.assertTrue((current_dir / 'blog-generation-manifest-2026-07-10.json').is_file())
            self.assertTrue((content_dir / '2026-07-10.md').is_file())

    def test_generation_explicit_exclusion_is_exact_and_fails_on_unknown_id(self):
        papers = [
            {'arxivId': '2607.00001v2', 'title': 'keep'},
            {'arxivId': '2607.00002', 'title': 'exclude'},
        ]
        kept, excluded = publish_to_blog.exclude_papers_for_publish(
            papers, ['arXiv:2607.00002v1']
        )
        self.assertEqual([paper['title'] for paper in kept], ['keep'])
        self.assertEqual(excluded, ['2607.00002'])
        with self.assertRaisesRegex(
            publish_to_blog.PublishDataValidationError, '未命中当前发布批次'
        ):
            publish_to_blog.exclude_papers_for_publish(papers, ['2607.99999'])

    def test_single_generation_selects_exactly_one_normalized_id(self):
        papers = [
            {'arxivId': '2607.00001v2', 'title': 'selected'},
            {'arxivId': '2607.00002', 'title': 'other'},
        ]
        selected, paper_id = publish_to_blog.include_single_paper_for_publish(
            papers, 'arXiv:2607.00001v1',
        )
        self.assertEqual([paper['title'] for paper in selected], ['selected'])
        self.assertEqual(paper_id, '2607.00001')
        with self.assertRaisesRegex(
            publish_to_blog.PublishDataValidationError, '未命中当前发布批次',
        ):
            publish_to_blog.include_single_paper_for_publish(papers, '2607.99999')
        with self.assertRaisesRegex(
            publish_to_blog.PublishDataValidationError, '重复规范化 ID',
        ):
            publish_to_blog.include_single_paper_for_publish(
                papers + [{'arxivId': '2607.00001v3', 'title': 'duplicate'}],
                '2607.00001',
            )

    def test_single_generation_state_and_manifest_paths_are_isolated(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'current'
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                batch = publish_to_blog.generation_manifest_path('2026-07-10')
                with publish_to_blog.publication_scope('arXiv:2607.00001v2'):
                    single = publish_to_blog.generation_manifest_path('2026-07-10')
                    receipt = publish_to_blog.review_receipt_path('2026-07-10')
                self.assertEqual(batch.name, 'blog-generation-manifest-2026-07-10.json')
                self.assertRegex(
                    single.name,
                    r'^blog-generation-manifest-2026-07-10-single-2607-00001-[0-9a-f]{10}\.json$',
                )
                self.assertIn('single-2607-00001', receipt.name)
                self.assertNotEqual(batch, single)

    def test_single_publish_manifest_never_adds_index_or_stale_deletions(self):
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / 'stage' / 'posts'
            posts = Path(tmp) / 'blog' / 'content' / 'posts'
            staged.mkdir(parents=True)
            posts.mkdir(parents=True)
            selected = staged / '2026-07-10-selected.md'
            selected.write_text('selected\n', encoding='utf-8')
            (posts / '2026-07-10-other.md').write_text('other\n', encoding='utf-8')
            paths = publish_to_blog.publish_manifest_paths(
                staged, posts, '2026-07-10', single_page=True,
            )
            self.assertEqual(paths, [(posts / selected.name).resolve()])
            (staged / '2026-07-10.md').write_text('index\n', encoding='utf-8')
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, '只含一个论文页',
            ):
                publish_to_blog.publish_manifest_paths(
                    staged, posts, '2026-07-10', single_page=True,
                )

    def test_single_generation_manifest_binds_scope_paper_and_only_page(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            posts = repo / 'content' / 'posts'
            posts.mkdir(parents=True)
            current = Path(tmp) / 'current'
            page = posts / '2026-07-10-selected.md'
            page.write_text(
                '---\npaper_digest_page_type: paper\n'
                'paper_digest_arxiv_id: "2607.00001"\n---\nbody\n',
                encoding='utf-8',
            )
            paper = {'arxivId': '2607.00001', 'title': 'Selected'}
            fingerprint = publish_to_blog.generation_input_fingerprint(
                [paper], '2026-07-10', '论文速递', False, '2607.00001',
            )
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    publish_to_blog.publication_scope('2607.00001'):
                manifest_path = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [page],
                    input_fingerprint=fingerprint,
                    template_fingerprint=publish_to_blog.generation_template_fingerprint(),
                    base_head='a' * 40,
                    category='论文速递', published_papers=[paper],
                    publish_all=False, include_id='2607.00001',
                    publication_mode=publish_to_blog.LEGACY_V5_MAINTENANCE_MODE,
                )
                payload = json.loads(manifest_path.read_text(encoding='utf-8'))
                loaded, loaded_manifest = publish_to_blog.load_generation_manifest(
                    '2026-07-10'
                )
            self.assertEqual(
                payload['publicationScope'],
                {'mode': 'single-paper', 'includeId': '2607.00001'},
            )
            self.assertEqual(len(payload['files']), 1)
            self.assertEqual(loaded, [page.resolve()])
            self.assertEqual(loaded_manifest, manifest_path)

    def test_single_publish_rejects_any_unrelated_git_worktree_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            target = posts / '2026-07-10-selected.md'
            target.write_text('selected\n', encoding='utf-8')
            extra = posts / '2026-07-10-other.md'
            extra.write_text('extra\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '清单外 Git 修改',
                ):
                    publish_to_blog.validate_single_publication_worktree([target])
            extra.unlink()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                publish_to_blog.validate_single_publication_worktree([target])

    def test_review_receipt_detects_any_post_review_file_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                paths, _receipt = publish_to_blog.load_verified_review_receipt('2026-07-10')
                self.assertEqual(set(paths), {path.resolve() for path in publish_paths})
                page.write_text('changed after review\n', encoding='utf-8')
                with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, 'review 后已变更'):
                    publish_to_blog.load_verified_review_receipt('2026-07-10')

    def test_index_blob_must_match_review_receipt_after_git_add(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                receipt, _path, _head = publish_to_blog._load_push_receipt('2026-07-10')
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                page.write_text('unreviewed race\n', encoding='utf-8')
                git(repo, 'add', '--', 'content/posts/2026-07-10.md')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'index.*review',
                ):
                    publish_to_blog.validate_git_index_against_review_receipt(receipt, publish_paths)

    def test_index_deletion_semantics_must_match_review_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10-old.md'
            page.write_text('old\n', encoding='utf-8')
            git(repo, 'add', '--', 'content/posts/2026-07-10-old.md')
            git(repo, 'commit', '-m', 'old page')
            page.unlink()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                receipt, _path, _head = publish_to_blog._load_push_receipt('2026-07-10')
                # Not staged yet: index still contains the supposedly deleted page.
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'index.*仍包含',
                ):
                    publish_to_blog.validate_git_index_against_review_receipt(receipt, publish_paths)
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                publish_to_blog.validate_git_index_against_review_receipt(receipt, publish_paths)

    def test_committed_blob_must_match_review_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                receipt, _path, _head = publish_to_blog._load_push_receipt('2026-07-10')
                page.write_text('changed by hook\n', encoding='utf-8')
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                git(repo, 'commit', '-m', 'tampered commit')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '提交.*review',
                ):
                    publish_to_blog.validate_git_commit_against_review_receipt(receipt, publish_paths)

    def test_incremental_review_selects_only_modified_failed_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            passed = posts / '2026-07-10-passed.md'
            failed = posts / '2026-07-10-failed.md'
            passed.write_text('passed\n', encoding='utf-8')
            failed.write_text('failed before fix\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [passed, failed],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [passed, failed], manifest, 'a' * 40, {
                        str(passed.resolve()): {
                            'passed': True,
                            'reviewedSha256': publish_to_blog._sha256_file(passed),
                        },
                        str(failed.resolve()): {'passed': False},
                    },
                )
                failed.write_text('failed after fix\n', encoding='utf-8')
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [passed, failed], manifest, 'a' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [failed.resolve()])
            self.assertEqual(plan['unchangedFailed'], [])
            self.assertTrue(plan['priorResults'][str(passed.resolve())]['passed'])

    def test_page_checkpoint_resumes_exact_sha_without_full_batch_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10-paper.md'
            page.write_text('reviewed exact bytes\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(
                        publish_to_blog, 'review_protocol_fingerprint',
                        return_value='9' * 64,
                    ):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [page],
                )
                page_sha = publish_to_blog._sha256_file(page)
                checkpoint = publish_to_blog.save_review_page_checkpoint(
                    '2026-07-10', page, {
                        'passed': True,
                        'completed': True,
                        'failureKind': None,
                        'reviewedSha256': page_sha,
                        'imageReviewMode': 'manual_semantic',
                    }, manifest, 'a' * 40,
                )
                self.assertTrue(checkpoint.is_file())
                self.assertFalse(
                    publish_to_blog.review_failure_path('2026-07-10').exists(),
                )
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [page], manifest, 'a' * 40,
                )
                self.assertEqual(plan['paths'], [])
                self.assertEqual(plan['reusedPassed'], 1)
                page.write_text('changed bytes\n', encoding='utf-8')
                stale_plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [page], manifest, 'a' * 40,
                )
            self.assertEqual(stale_plan['paths'], [page.resolve()])

    def test_incremental_review_rechecks_only_changed_passed_and_failed_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            passed = posts / '2026-07-10-passed.md'
            failed = posts / '2026-07-10-failed.md'
            passed.write_text('passed\n', encoding='utf-8')
            failed.write_text('failed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [passed, failed],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [passed, failed], manifest, 'b' * 40, {
                        str(passed.resolve()): {
                            'passed': True,
                            'reviewedSha256': publish_to_blog._sha256_file(passed),
                        },
                        str(failed.resolve()): {'passed': False},
                    },
                )
                passed.write_text('tampered\n', encoding='utf-8')
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [passed, failed], manifest, 'b' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertIsNone(plan['reason'])
            self.assertEqual(set(plan['paths']), {passed.resolve(), failed.resolve()})

    def test_incremental_review_reuses_passes_across_manifest_base_and_protocol_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            passed = posts / '2026-07-10-passed.md'
            pending = posts / '2026-07-10-pending.md'
            passed.write_text('passed\n', encoding='utf-8')
            pending.write_text('pending\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='1' * 64):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [passed, pending],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [passed, pending], manifest, 'a' * 40, {
                        str(passed.resolve()): {
                            'passed': True,
                            'reviewedSha256': publish_to_blog._sha256_file(passed),
                        },
                        str(pending.resolve()): {
                            'passed': False, 'completed': False, 'failureKind': 'pending',
                        },
                    },
                )
            manifest_data = json.loads(manifest.read_text(encoding='utf-8'))
            manifest_data['generatedAt'] = 'changed-without-changing-pages'
            manifest.write_text(json.dumps(manifest_data), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='2' * 64):
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [passed, pending], manifest, 'b' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [pending.resolve()])
            self.assertEqual(plan['reusedPassed'], 1)
            self.assertTrue(plan['priorResults'][str(passed.resolve())]['passed'])
            self.assertEqual(
                plan['priorResults'][str(passed.resolve())]['reviewProtocolFingerprint'],
                '1' * 64,
            )

    def test_successful_receipt_passes_survive_new_generation(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='3' * 64):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                reviewed = {
                    str(page.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(page),
                    },
                }
                publish_to_blog.save_review_receipt(
                    '2026-07-10', [page], 'hugo',
                    generation_manifest=manifest, reviewed_results=reviewed,
                )
                cache_path = publish_to_blog.review_pass_cache_path('2026-07-10')
                self.assertTrue(cache_path.is_file())
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                self.assertFalse(publish_to_blog.review_receipt_path('2026-07-10').exists())
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [page], manifest, 'f' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [])
            self.assertEqual(plan['reusedPassed'], 1)
            cache = json.loads(cache_path.read_text(encoding='utf-8'))
            self.assertEqual(cache['schemaVersion'], 1)
            self.assertEqual(cache['files'][0]['sha256'], publish_to_blog._sha256_file(page))

    def test_incremental_review_retries_unchanged_transient_but_blocks_unchanged_content_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            transient = posts / '2026-07-10-transient.md'
            content = posts / '2026-07-10-content.md'
            transient.write_text('same transient\n', encoding='utf-8')
            content.write_text('same content\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [transient, content],
                )
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [transient, content], manifest, 'c' * 40, {
                        str(transient.resolve()): {
                            'passed': False, 'completed': True, 'failureKind': 'transient',
                        },
                        str(content.resolve()): {
                            'passed': False, 'completed': True, 'failureKind': 'content',
                        },
                    },
                )
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [transient, content], manifest, 'c' * 40,
                )
            self.assertEqual(plan['mode'], 'incremental')
            self.assertEqual(plan['paths'], [transient.resolve()])
            self.assertEqual(plan['unchangedFailed'], [content.resolve()])

    def test_review_worker_exception_becomes_checkpointable_transient_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp)
            paper = posts / '2026-07-10-paper.md'
            paper.write_text('body\n', encoding='utf-8')
            callbacks = []
            with mock.patch.object(
                publish_to_blog, '_review_single_paper',
                side_effect=publish_to_blog.PublishLLMUnavailable('temporary'),
            ):
                fixed, blocking, details = publish_to_blog.review_all_posts(
                    '2026-07-10', {'2607.00001': 'paper'},
                    [(0.0, {'arxivId': '2607.00001', 'title': 'Paper'}, {})],
                    content_dir=str(posts), review_paths=[paper], return_details=True,
                    result_callback=lambda path, result: callbacks.append((path, result)),
                )
            self.assertEqual(fixed, 0)
            self.assertEqual(blocking, 1)
            result = details[str(paper.resolve())]
            self.assertEqual(result['failureKind'], 'transient')
            self.assertTrue(result['completed'])
            self.assertEqual(len(callbacks), 1)

    def test_final_single_page_review_is_read_only_and_blocks_proposed_fixes(self):
        with tempfile.TemporaryDirectory() as tmp:
            posts = Path(tmp)
            page = posts / '2026-07-10-paper.md'
            original = 'immutable final bytes\n'
            page.write_text(original, encoding='utf-8')
            with mock.patch.object(
                    publish_to_blog, 'review_and_fix_post',
                    return_value=(True, ['需要确定性修复']),
                ) as deterministic, mock.patch.object(
                    publish_to_blog, 'llm_review_post',
                    return_value=(False, [], 'LLM proposed replacement\n'),
                ), mock.patch.object(
                    publish_to_blog, 'multimodal_review_images',
                    return_value=(True, []),
                ), mock.patch.object(
                    publish_to_blog, 'atomic_write_text',
                ) as write:
                result = publish_to_blog._review_single_paper((
                    '2607.00001', 'paper', '2026-07-10', 'Paper', True,
                    str(posts), {'arxivId': '2607.00001'},
                ))
            self.assertEqual(page.read_text(encoding='utf-8'), original)
            self.assertEqual(result[2], 0)
            # Three independent blockers: deterministic defect, explicit
            # reviewer rejection, and attempted replacement of immutable bytes.
            self.assertEqual(result[3], 3)
            deterministic.assert_called_once_with(
                str(page), {'arxivId': '2607.00001'}, dry_run=True,
                source_content=original,
            )
            write.assert_not_called()

    def test_generation_install_journal_adopts_crash_after_replace_and_rejects_later_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            stage = current_dir / 'blog-generation-stage-2026-07-10' / 'posts'
            stage.mkdir(parents=True)
            staged_index = stage / '2026-07-10.md'
            staged_paper = stage / '2026-07-10-paper.md'
            staged_index.write_text('new index\n', encoding='utf-8')
            staged_paper.write_text('new paper\n', encoding='utf-8')
            journal_path = current_dir / 'blog-generation-journal-2026-07-10.json'
            journal = {'installation': None}
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                publish_to_blog.prepare_generation_installation(
                    journal, journal_path, stage, posts, '2026-07-10',
                )
                first_record = journal['installation']['files'][0]
                first_target = repo / first_record['path']
                first_source = stage / first_target.name
                # Simulate SIGKILL after target replacement but before installed=true flush.
                first_target.write_text(first_source.read_text(encoding='utf-8'), encoding='utf-8')
                installed = publish_to_blog.resume_generation_installation(
                    journal, journal_path, stage,
                )
                self.assertEqual(set(installed), {
                    (posts / '2026-07-10.md').resolve(),
                    (posts / '2026-07-10-paper.md').resolve(),
                })
                self.assertTrue(all(
                    record['installed'] for record in journal['installation']['files']
                ))
                first_target.write_text('manual edit\n', encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '人工修改',
                ):
                    publish_to_blog.resume_generation_installation(
                        journal, journal_path, stage,
                    )

    def test_generation_journal_restarts_changed_derived_stage_before_install_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            journal_path = root / 'journal.json'
            stage = root / 'stage' / 'posts'
            papers = [{'arxivId': '2607.00001', 'title': 'Restartable Paper'}]
            patches = (
                mock.patch.object(
                    publish_to_blog, 'generation_journal_path',
                    return_value=journal_path,
                ),
                mock.patch.object(
                    publish_to_blog, 'generation_stage_path',
                    return_value=stage,
                ),
            )
            with patches[0], patches[1]:
                first, _, _ = publish_to_blog.prepare_generation_journal(
                    '2026-07-10', papers, '论文速递', False,
                    'input-a', 'template-a', 'a' * 40,
                )
                (stage / 'derived.md').write_text('derived', encoding='utf-8')
                second, _, _ = publish_to_blog.prepare_generation_journal(
                    '2026-07-10', papers, '论文速递', False,
                    'input-b', 'template-b', 'a' * 40,
                )
                self.assertEqual(second['inputFingerprint'], 'input-b')
                self.assertFalse((stage / 'derived.md').exists())
                second['installation'] = {'files': []}
                publish_to_blog._save_generation_journal(journal_path, second)
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '安装已开始',
                ):
                    publish_to_blog.prepare_generation_journal(
                        '2026-07-10', papers, '论文速递', False,
                        'input-c', 'template-c', 'a' * 40,
                    )

    def test_completed_generation_manifest_is_reusable_only_for_identical_hashes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('generated\n', encoding='utf-8')
            base_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            published_papers = [{'arxivId': '2607.00001'}]
            input_fingerprint = publish_to_blog.generation_input_fingerprint(
                published_papers, '2026-07-10', '论文速递', False,
            )
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [page], input_fingerprint=input_fingerprint,
                    template_fingerprint='b' * 64, base_head=base_head,
                    published_papers=published_papers,
                    publication_mode=publish_to_blog.LEGACY_V5_MAINTENANCE_MODE,
                )
                reused = publish_to_blog.reusable_generation_manifest(
                    '2026-07-10', input_fingerprint, 'b' * 64, base_head,
                )
                self.assertEqual(reused, ([page.resolve()], manifest))
                page.write_text('manual review edit\n', encoding='utf-8')
                self.assertIsNone(publish_to_blog.reusable_generation_manifest(
                    '2026-07-10', input_fingerprint, 'b' * 64, base_head,
                ))

    def test_identical_nonempty_generate_review_push_chain_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp, with_remote=True)
            current_dir = Path(tmp) / 'data' / 'current'
            date_str = '2026-07-10'
            paper = {
                'arxivId': '2607.00001',
                'title': 'Published paper',
                'fetchBatchDate': date_str,
                'parsed': {'score': 8.0},
            }
            options = {
                'data_file': 'unused-test-input.json',
                'target_date': date_str,
                'category': '论文速递',
                'publish_all': False,
                'excluded_ids': [],
                'legacy_v5_maintenance': True,
            }
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CONTENT_DIR', str(posts)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                publication = create_verified_schema_v3_publication(
                    date_str, posts, paper,
                )
                manifest_before = publication['manifest'].read_bytes()
                receipt_before = publication['receipt'].read_bytes()
                head_before = git(repo, 'rev-parse', 'HEAD').stdout.strip()
                with mock.patch.object(
                        publish_to_blog, 'validate_publish_target',
                        return_value=(repo, posts),
                    ), mock.patch.object(
                        publish_to_blog, 'load_papers', return_value=[paper],
                    ), mock.patch.object(
                        publish_to_blog, 'validate_papers_for_publish', return_value=[paper],
                    ), mock.patch.object(
                        publish_to_blog, 'score_and_sort', return_value=([], []),
                    ), mock.patch.object(
                        publish_to_blog, 'generate_paper_page',
                        side_effect=AssertionError('identical published batch must not regenerate'),
                    ), mock.patch.object(
                        publish_to_blog, 'generate_index_page',
                        side_effect=AssertionError('identical published batch must not regenerate'),
                    ):
                    publish_to_blog.generate_main(options)

                with mock.patch.object(
                        publish_to_blog, 'review_all_posts',
                        side_effect=AssertionError('verified publication must not rerun LLM review'),
                    ):
                    reused_receipt = review_blog._run_review(
                        publish_to_blog, date_str,
                    )
                self.assertEqual(Path(reused_receipt), publication['receipt'])
                self.assertTrue(publish_to_blog.git_push(
                    date_str, publication['paths'],
                ))

                self.assertEqual(publication['manifest'].read_bytes(), manifest_before)
                self.assertEqual(git(repo, 'rev-parse', 'HEAD').stdout.strip(), head_before)
                self.assertIn('保留唯一发布凭证', output.getvalue())
                receipt_after = json.loads(publication['receipt'].read_text(encoding='utf-8'))
                receipt_before_payload = json.loads(receipt_before)
                self.assertEqual(receipt_after['publicationCommit'], head_before)
                self.assertEqual(receipt_after['baseHead'], receipt_before_payload['baseHead'])
                self.assertEqual(receipt_after['remoteVerifiedOid'], head_before)
                self.assertRegex(receipt_after['remoteIdentitySha256'], r'^[0-9a-f]{64}$')

    def test_published_generation_reuse_fails_closed_on_file_remote_or_origin_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp, with_remote=True)
            current_dir = Path(tmp) / 'data' / 'current'
            date_str = '2026-07-10'
            paper = {
                'arxivId': '2607.00001',
                'title': 'Published paper',
                'fetchBatchDate': date_str,
            }
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CONTENT_DIR', str(posts)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'), \
                    contextlib.redirect_stdout(io.StringIO()):
                publication = create_verified_schema_v3_publication(
                    date_str, posts, paper,
                )
                current_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
                expected_args = (
                    date_str,
                    publication['inputFingerprint'],
                    publication['templateFingerprint'],
                    current_head,
                )
                self.assertIsNotNone(
                    publish_to_blog.reusable_verified_publication_generation(*expected_args)
                )
                self.assertIsNone(
                    publish_to_blog.reusable_verified_publication_generation(
                        date_str, '0' * 64, publication['templateFingerprint'], current_head,
                    )
                )

                page = publication['paths'][0]
                reviewed_bytes = page.read_bytes()
                page.write_text('manual drift\n', encoding='utf-8')
                self.assertIsNone(
                    publish_to_blog.reusable_verified_publication_generation(*expected_args)
                )
                page.write_bytes(reviewed_bytes)

                receipt = json.loads(publication['receipt'].read_text(encoding='utf-8'))
                receipt['remoteVerifiedOid'] = 'f' * 40
                publication['receipt'].write_text(json.dumps(receipt), encoding='utf-8')
                self.assertIsNone(
                    publish_to_blog.reusable_verified_publication_generation(*expected_args)
                )

    def test_published_generation_reuse_rejects_changed_origin_even_with_same_oid(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, original_remote = init_blog_repo(tmp, with_remote=True)
            current_dir = Path(tmp) / 'data' / 'current'
            date_str = '2026-07-10'
            paper = {
                'arxivId': '2607.00001',
                'title': 'Published paper',
                'fetchBatchDate': date_str,
            }
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CONTENT_DIR', str(posts)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'), \
                    contextlib.redirect_stdout(io.StringIO()):
                publication = create_verified_schema_v3_publication(
                    date_str, posts, paper,
                )
                current_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
                expected_args = (
                    date_str,
                    publication['inputFingerprint'],
                    publication['templateFingerprint'],
                    current_head,
                )
                self.assertIsNotNone(
                    publish_to_blog.reusable_verified_publication_generation(*expected_args)
                )

                replacement_remote = Path(tmp) / 'replacement.git'
                git(tmp, 'init', '--bare', str(replacement_remote))
                git(repo, 'remote', 'add', 'replacement', str(replacement_remote))
                git(repo, 'push', 'replacement', 'HEAD:main')
                self.assertEqual(
                    git(replacement_remote, 'rev-parse', 'refs/heads/main').stdout.strip(),
                    current_head,
                )
                git(repo, 'remote', 'set-url', 'origin', str(replacement_remote))
                self.assertIsNone(
                    publish_to_blog.reusable_verified_publication_generation(*expected_args)
                )
                self.assertFalse(publish_to_blog.git_push(
                    date_str, publication['paths'],
                ))

                git(repo, 'remote', 'set-url', 'origin', str(original_remote))
                self.assertIsNotNone(
                    publish_to_blog.reusable_verified_publication_generation(*expected_args)
                )
                self.assertTrue(publish_to_blog.git_push(
                    date_str, publication['paths'],
                ))
                offline_remote = Path(tmp) / 'remote-offline.git'
                original_remote.rename(offline_remote)
                try:
                    self.assertIsNone(
                        publish_to_blog.reusable_verified_publication_generation(*expected_args)
                    )
                    receipt_before = publication['receipt'].read_bytes()
                    options = {
                        'data_file': 'unused-test-input.json',
                        'target_date': date_str,
                        'category': '论文速递',
                        'publish_all': False,
                        'excluded_ids': [],
                        'legacy_v5_maintenance': True,
                    }
                    with mock.patch.object(
                            publish_to_blog, 'validate_publish_target',
                            return_value=(repo, posts),
                        ), mock.patch.object(
                            publish_to_blog, 'load_papers', return_value=[paper],
                        ), mock.patch.object(
                            publish_to_blog, 'validate_papers_for_publish', return_value=[paper],
                        ), mock.patch.object(
                            publish_to_blog, 'score_and_sort', return_value=([], []),
                        ), self.assertRaisesRegex(
                            publish_to_blog.PublishDataValidationError,
                            '已保留既有 generation/receipt',
                        ):
                        publish_to_blog.generate_main(options)
                    with self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError,
                        '已保留既有 receipt',
                    ):
                        review_blog._run_review(publish_to_blog, date_str)
                    self.assertEqual(publication['receipt'].read_bytes(), receipt_before)
                finally:
                    offline_remote.rename(original_remote)

    def test_template_fingerprint_includes_base_path_and_dependency_hashes(self):
        with mock.patch.object(publish_to_blog, 'BASE_PATH', '/one'):
            first = publish_to_blog.generation_template_fingerprint()
        with mock.patch.object(publish_to_blog, 'BASE_PATH', '/two'):
            second = publish_to_blog.generation_template_fingerprint()
        self.assertNotEqual(first, second)
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='f' * 64):
            dependency_changed = publish_to_blog.generation_template_fingerprint()
        self.assertNotEqual(first, dependency_changed)

    def test_review_protocol_fingerprint_binds_model_code_hugo_and_is_cached(self):
        completed = SimpleNamespace(stdout='hugo v0.test', stderr='', returncode=0)
        publish_to_blog._REVIEW_PROTOCOL_CACHE.clear()
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='a' * 64), \
                mock.patch.object(publish_to_blog.shutil, 'which', return_value='/missing/hugo'), \
                mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed) as run, \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'model-a'}):
            first = publish_to_blog.review_protocol_fingerprint()
            self.assertEqual(first, publish_to_blog.review_protocol_fingerprint())
            self.assertEqual(run.call_count, 1)
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='a' * 64), \
                mock.patch.object(publish_to_blog.shutil, 'which', return_value='/missing/hugo'), \
                mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'model-b'}):
            second = publish_to_blog.review_protocol_fingerprint()
        self.assertNotEqual(first, second)
        publish_to_blog._REVIEW_PROTOCOL_CACHE.clear()
        with mock.patch.object(publish_to_blog, '_sha256_file', return_value='a' * 64), \
                mock.patch.object(publish_to_blog.shutil, 'which', return_value='/missing/hugo'), \
                mock.patch.object(publish_to_blog.subprocess, 'run', return_value=completed), \
                mock.patch.dict(os.environ, {'PAPER_ANALYZER_MODEL': 'model-a', 'PD_BLOG_REVIEW_MAX_TOKENS': '8000'}):
            third = publish_to_blog.review_protocol_fingerprint()
        self.assertNotEqual(first, third)

    def test_review_protocol_includes_manual_takeover_script_and_rejects_stale_generation_template(self):
        completed = SimpleNamespace(stdout='hugo v0.test', stderr='', returncode=0)
        publish_to_blog._REVIEW_PROTOCOL_CACHE.clear()
        with mock.patch.object(
                publish_to_blog, '_sha256_file', return_value='a' * 64,
        ) as digest, mock.patch.object(
                publish_to_blog.shutil, 'which', return_value='/missing/hugo',
        ), mock.patch.object(
                publish_to_blog.subprocess, 'run', return_value=completed,
        ):
            publish_to_blog.review_protocol_fingerprint()
        dependency_names = {Path(call.args[0]).name for call in digest.call_args_list}
        self.assertIn('manual-review-blog.py', dependency_names)

        current = publish_to_blog.generation_template_fingerprint()
        publish_to_blog.validate_current_generation_template({
            'schemaVersion': 3, 'templateFingerprint': current,
        })
        with mock.patch.object(
                publish_to_blog, 'generation_template_fingerprint', return_value='b' * 64,
        ), self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, '重新运行 generate-blog.py',
        ):
            publish_to_blog.validate_current_generation_template({
                'schemaVersion': 3, 'templateFingerprint': current,
            })

    def test_manual_review_provenance_accepts_generation_deletion_record(self):
        date_str = '2026-08-25'
        manifest_sha = 'a' * 64
        base_head = 'b' * 40
        file_checks = {
            'titleAndMetadata': True, 'technicalNarrative': True,
            'factualClaims': True, 'experimentComparisons': True,
            'reproducibility': True, 'limitations': True,
            'scoring': True, 'images': True,
        }
        batch_checks = {
            'generationManifestVerified': True, 'baseHeadVerified': True,
            'fileHashesVerified': True, 'frontmatterVerified': True,
            'markdownVerified': True, 'contentSemanticsVerified': True,
            'imageReferencesVerified': True, 'hugoGateVerified': True,
        }
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            page = repo / 'content/posts/2026-08-25-paper.md'
            page.parent.mkdir(parents=True)
            page.write_text(
                '---\npaper_digest_arxiv_id: "2608.12345"\n---\n正文报告 WER 7.1%。\n',
                encoding='utf-8',
            )
            existing_sha = publish_to_blog._sha256_file(page)
            receipt = {
                'reviewMode': 'manual_complete',
                'files': [
                    {'path': 'content/posts/2026-08-25-paper.md', 'deleted': False,
                     'sha256': existing_sha},
                    {'path': 'content/posts/2026-08-25-stale.md', 'deleted': True,
                     'sha256': None},
                ],
                'reviewProvenance': {
                    'version': 3, 'mode': 'manual_complete', 'agent': 'Codex',
                    'basis': 'deterministic_and_manual_semantic_review',
                    'reason': '逐页核对技术叙事、实验事实和受控删除语义后签发人工凭证。',
                    'completedAt': '2026-08-25T12:00:00.000+08:00',
                    'checks': batch_checks,
                    'generationManifestSha256': manifest_sha,
                    'baseHead': base_head,
                    'fileCount': 2,
                    'files': [
                        {
                            'path': 'content/posts/2026-08-25-paper.md',
                            'sha256': existing_sha, 'checks': file_checks,
                            'notes': '2608.12345：核对方法数据流、WER 7.1% 实验数字、开源范围与局限边界。',
                            'reviewSubagent': {
                                'version': 1, 'taskName': 'review-2608-12345',
                                'paperId': '2608.12345', 'singleFileOnly': True,
                                'isolatedContext': True,
                                'model': 'gpt-5.6-terra',
                                'reasoningEffort': 'high',
                            },
                            'imageFindings': [],
                        },
                        {
                            'path': 'content/posts/2026-08-25-stale.md',
                            'deleted': True, 'sha256': None,
                            'checks': {'deletionVerified': True},
                            'notes': '确认删除旧页面 2026-08-25-stale，且工作树已不存在该过期条目。',
                            'reviewSubagent': {
                                'version': 1, 'taskName': 'review-deleted-stale',
                                'singleFileOnly': True, 'isolatedContext': True,
                                'model': 'gpt-5.6-terra',
                                'reasoningEffort': 'high',
                            },
                            'imageFindings': [],
                        },
                    ],
                    'reviewedPathSetSha256': 'c' * 64,
                    'reviewProtocolFingerprint': 'd' * 64,
                },
            }
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                self.assertIsNone(publish_to_blog._manual_review_provenance_error(
                    receipt, date_str=date_str,
                    generation_manifest_sha256=manifest_sha,
                    expected_base_head=base_head,
                ))
                escaped = json.loads(json.dumps(receipt))
                escaped['files'][0]['path'] = '../escaped.md'
                escaped['reviewProvenance']['files'][0]['path'] = '../escaped.md'
                self.assertIn('路径越界', publish_to_blog._manual_review_provenance_error(
                    escaped, date_str=date_str,
                    generation_manifest_sha256=manifest_sha,
                    expected_base_head=base_head,
                ))
                wrong_model = json.loads(json.dumps(receipt))
                wrong_model['reviewProvenance']['files'][0]['reviewSubagent'][
                    'model'
                ] = 'gpt-5.6-sol'
                self.assertIn(
                    'reviewSubagent',
                    publish_to_blog._manual_review_provenance_error(
                        wrong_model, date_str=date_str,
                        generation_manifest_sha256=manifest_sha,
                        expected_base_head=base_head,
                    ),
                )
                duplicate_task = json.loads(json.dumps(receipt))
                duplicate_task['reviewProvenance']['files'][1]['reviewSubagent'][
                    'taskName'
                ] = 'review-2608-12345'
                self.assertIn(
                    'taskName 必须逐页全局唯一',
                    publish_to_blog._manual_review_provenance_error(
                        duplicate_task, date_str=date_str,
                        generation_manifest_sha256=manifest_sha,
                        expected_base_head=base_head,
                    ),
                )
                missing_paper_id = json.loads(json.dumps(receipt))
                del missing_paper_id['reviewProvenance']['files'][0][
                    'reviewSubagent'
                ]['paperId']
                self.assertIn(
                    'paperId 缺失或非法',
                    publish_to_blog._manual_review_provenance_error(
                        missing_paper_id, date_str=date_str,
                        generation_manifest_sha256=manifest_sha,
                        expected_base_head=base_head,
                    ),
                )
                receipt['reviewProvenance']['files'][1]['deleted'] = False
                self.assertIn('删除语义不一致', publish_to_blog._manual_review_provenance_error(
                    receipt, date_str=date_str,
                    generation_manifest_sha256=manifest_sha,
                    expected_base_head=base_head,
                ))

    def test_reusable_generation_manifest_rejects_empty_duplicate_and_bad_sha_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            manifest_path = current_dir / 'blog-generation-manifest-2026-07-10.json'
            base = {
                'schemaVersion': 2,
                'date': '2026-07-10',
                'inputFingerprint': 'a' * 64,
                'templateFingerprint': 'b' * 64,
                'baseHead': 'c' * 40,
            }
            cases = [
                [],
                [
                    {'path': 'content/posts/a.md', 'deleted': False, 'sha256': 'd' * 64},
                    {'path': 'content/posts/a.md', 'deleted': False, 'sha256': 'd' * 64},
                ],
                [{'path': 'content/posts/a.md', 'deleted': False, 'sha256': 'bad'}],
            ]
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                current_dir.mkdir(parents=True)
                for records in cases:
                    manifest_path.write_text(json.dumps({**base, 'files': records}), encoding='utf-8')
                    self.assertIsNone(publish_to_blog.reusable_generation_manifest(
                        '2026-07-10', 'a' * 64, 'b' * 64, 'c' * 40,
                    ))

    def test_reviewed_hash_gate_and_receipt_reject_post_review_deletion_or_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                reviewed = {
                    str(page.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(page),
                    },
                }
                publish_to_blog.validate_reviewed_file_hashes(
                    '2026-07-10', [page], manifest, reviewed,
                )
                page.write_text('changed after worker\n', encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'review 后发生变化',
                ):
                    publish_to_blog.validate_reviewed_file_hashes(
                        '2026-07-10', [page], manifest, reviewed,
                    )
                page.unlink()
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'review 期间消失',
                ):
                    publish_to_blog.save_review_receipt(
                        '2026-07-10', [page], 'hugo',
                        generation_manifest=manifest, reviewed_results=reviewed,
                    )

    def test_push_receipt_rejects_generation_manifest_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                save_bound_review_receipt('2026-07-10', [page])
                manifest_path = publish_to_blog.generation_manifest_path('2026-07-10')
                manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
                manifest['generatedAt'] = 'tampered'
                manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, 'manifest 缺失或已变化',
                ):
                    publish_to_blog.load_verified_review_receipt('2026-07-10')

    def test_same_date_blog_transaction_lock_is_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            current_dir = Path(tmp) / 'current'
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                with publish_to_blog.blog_transaction_lock('2026-07-10'):
                    with self.assertRaises(TimeoutError):
                        with publish_to_blog.blog_transaction_lock(
                            '2026-07-10', timeout_seconds=0.05,
                        ):
                            self.fail('same-date lock must not be acquired twice')
                with publish_to_blog.blog_transaction_lock(
                    '2026-07-11', timeout_seconds=0.05,
                ):
                    pass

    def test_repository_lock_serializes_different_publication_dates(self):
        with tempfile.TemporaryDirectory() as tmp:
            current_dir = Path(tmp) / 'current'
            repo = Path(tmp) / 'blog'
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                with publish_to_blog.blog_publication_lock('2026-07-10'):
                    with self.assertRaises(TimeoutError):
                        with publish_to_blog.blog_publication_lock(
                            '2026-07-11', timeout_seconds=0.05,
                        ):
                            self.fail('repository lock must serialize different dates')

    def test_corrupt_review_failure_kind_falls_back_to_full_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('content\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                state_path = publish_to_blog.save_review_failure_state(
                    '2026-07-10', [page], manifest, 'd' * 40, {
                        str(page.resolve()): {
                            'passed': False, 'completed': True, 'failureKind': 'content',
                        },
                    },
                )
                state = json.loads(state_path.read_text(encoding='utf-8'))
                state['files'][0]['failureKind'] = 'unknown-kind'
                state_path.write_text(json.dumps(state), encoding='utf-8')
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [page], manifest, 'd' * 40,
                )
            self.assertEqual(plan['mode'], 'full')
            self.assertIn('失败类型非法', plan['reason'])

    def test_push_retries_exact_publication_commit_without_second_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            missing_remote = Path(tmp) / 'later-remote.git'
            git(repo, 'remote', 'add', 'origin', str(missing_remote))
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('generated\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                self.assertFalse(publish_to_blog.git_push('2026-07-10', publish_paths))
                publication_head = git(repo, 'rev-parse', 'HEAD').stdout.strip()
                commit_count = git(repo, 'rev-list', '--count', 'HEAD').stdout.strip()
                subprocess.run(
                    ['git', 'init', '--bare', '--initial-branch=main', str(missing_remote)],
                    check=True, capture_output=True, text=True,
                )
                self.assertTrue(publish_to_blog.git_push('2026-07-10', publish_paths))
            self.assertEqual(git(repo, 'rev-parse', 'HEAD').stdout.strip(), publication_head)
            self.assertEqual(git(repo, 'rev-list', '--count', 'HEAD').stdout.strip(), commit_count)
            self.assertEqual(
                git(missing_remote, 'rev-parse', 'refs/heads/main').stdout.strip(),
                publication_head,
            )

    def test_review_receipt_rejects_base_head_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current_dir = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current_dir), \
                    self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError,
                        '基线发生变化',
                    ):
                save_bound_review_receipt(
                    '2026-07-10', [page], expected_base_head='f' * 40,
                )

    def test_visual_summary_manifest_stages_single_infographic_and_attests_review(self):
        png = valid_png()
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            archive = Path(tmp) / 'data' / 'archive'
            source_root = archive / '2026-07-10' / 'visual-summaries'
            source_root.mkdir(parents=True)
            paper = {'arxivId': '2607.00001', 'analysis': 'audited', 'parsed': {'score': '8'}}
            analysis_sha = publish_to_blog._visual_summary_analysis_sha256(paper)
            prompt_sha = publish_to_blog._sha256_file(Path(ROOT) / 'prompts' / 'visual-summary.md')
            cards = {}
            for kind in publish_to_blog.VISUAL_SUMMARY_KINDS:
                source = source_root / '01-2607.00001-paper.png'
                source.write_bytes(png)
                cards[kind] = {
                    'status': 'complete', 'analysisSha256': analysis_sha,
                    'promptSha256': prompt_sha,
                    'assetSha256': publish_to_blog._sha256_file(source),
                    'assetPath': str(source),
                }
            manifest = current / 'visual-summary-manifest.json'
            manifest.parent.mkdir(parents=True, exist_ok=True)
            manifest.write_text(json.dumps({
                'version': 2, 'batchDate': '2026-07-10', 'promptSha256': prompt_sha,
                'papers': {'2607.00001': {
                    'normalizedArxivId': '2607.00001', 'batchDate': '2026-07-10',
                    'rank': 1,
                    'analysisSha256': analysis_sha, 'promptSha256': prompt_sha,
                    'cards': cards,
                }},
            }), encoding='utf-8')
            stage_posts = current / 'blog-generation-stage-2026-07-10' / 'posts'
            stage_posts.mkdir(parents=True)
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'VISUAL_SUMMARY_ASSET_DIR', archive):
                enriched, assets = publish_to_blog.load_visual_summary_cards(
                    [paper], '2026-07-10', manifest,
                )
                self.assertEqual(len(enriched[0]['visualSummaryCards']), 1)
                self.assertNotIn('sourcePath', enriched[0]['visualSummaryCards'][0])
                staged_assets = publish_to_blog.stage_visual_summary_assets(assets, stage_posts)
                for source in staged_assets:
                    target = repo.resolve() / source.resolve().relative_to(stage_posts.parent.resolve())
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(source.read_bytes())
                page = posts / '2026-07-10-paper.md'
                page.write_text(
                    '---\npaper_digest_page_type: paper\n'
                    'paper_digest_arxiv_id: "2607.00001"\n---\n'
                    + '\n'.join(f'![card]({asset["url"]})' for asset in assets),
                    encoding='utf-8',
                )
                paths = [page, *(repo / asset['repoRelativePath'] for asset in assets)]
                generation = publish_to_blog.save_generation_manifest('2026-07-10', paths)
                page_sha = publish_to_blog._sha256_file(page)
                results = {str(page.resolve()): {
                    'passed': True, 'completed': True, 'failureKind': None,
                    'reviewedSha256': page_sha,
                }}
                self.assertEqual(publish_to_blog.attest_visual_summary_assets(
                    '2026-07-10', paths, generation, results,
                ), 0)
                self.assertTrue(all(
                    results[str(Path(path).resolve())]['passed'] for path in paths
                ))
                publish_to_blog.validate_reviewed_file_hashes(
                    '2026-07-10', paths, generation, results,
                )
                loaded = publish_to_blog._load_review_image(assets[0]['url'])
                self.assertEqual(loaded['media_type'], 'image/png')

                original_manifest = json.loads(manifest.read_text(encoding='utf-8'))
                incomplete = json.loads(json.dumps(original_manifest))
                incomplete['papers']['2607.00001']['cards']['infographic']['status'] = 'pending'
                manifest.write_text(json.dumps(incomplete), encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '未完成',
                ):
                    publish_to_blog.load_visual_summary_cards([paper], '2026-07-10', manifest)

                stale = json.loads(json.dumps(original_manifest))
                stale['papers']['2607.00001']['analysisSha256'] = '0' * 64
                manifest.write_text(json.dumps(stale), encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '指纹已失效',
                ):
                    publish_to_blog.load_visual_summary_cards([paper], '2026-07-10', manifest)

    def test_generate_rejects_missing_visual_summary_manifest(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = Path(tmp) / 'missing.json'
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError, '缺少强制视觉摘要',
            ):
                publish_to_blog.load_visual_summary_cards(
                    [{'arxivId': '2607.00001'}], '2026-07-10', missing,
                )

    def test_digest_cover_manifest_binds_summary_context_and_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp) / 'data' / 'current'
            archive = Path(tmp) / 'data' / 'archive'
            source = archive / '2026-07-10' / 'visual-summaries' / '00-digest-cover-2026-07-10.png'
            source.parent.mkdir(parents=True)
            source.write_bytes(valid_png())
            papers = [{
                'arxivId': '2607.00001', 'title': 'Top Paper',
                'parsed': {
                    'score': '9.0', 'primaryTaskTag': '#语音识别',
                    'tags': ['#语音识别'],
                },
            }]
            context = publish_to_blog._digest_cover_context(papers, '2026-07-10')
            data_sha = hashlib.sha256(json.dumps(
                context, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
            ).encode('utf-8')).hexdigest()
            prompt_sha = publish_to_blog._sha256_file(Path(ROOT) / 'prompts' / 'digest-cover.md')
            manifest = current / 'digest-cover-manifests' / '2026-07-10.json'
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({
                'version': 1, 'batchDate': '2026-07-10',
                'dataSha256': data_sha, 'promptSha256': prompt_sha,
                'generationContext': context,
                'cover': {
                    'status': 'complete', 'dataSha256': data_sha,
                    'promptSha256': prompt_sha,
                    'assetPath': str(source),
                    'assetSha256': publish_to_blog._sha256_file(source),
                },
            }), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'DIGEST_COVER_ASSET_DIR', archive):
                loaded = publish_to_blog.load_digest_cover(papers, '2026-07-10', manifest)
                self.assertEqual(loaded['kind'], 'digest-cover')
                self.assertTrue(loaded['url'].endswith('/images/digest-covers/2026-07-10/cover.png'))

            stale = json.loads(manifest.read_text(encoding='utf-8'))
            stale['dataSha256'] = '0' * 64
            manifest.write_text(json.dumps(stale), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'DIGEST_COVER_ASSET_DIR', archive), \
                    self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '指纹'):
                publish_to_blog.load_digest_cover(papers, '2026-07-10', manifest)

    def test_post_publish_visuals_do_not_enter_generation_fingerprint(self):
        papers = [{'arxivId': '2607.1', 'title': 'Paper'}]
        self.assertEqual(
            publish_to_blog.generation_input_fingerprint(
                papers, '2026-07-10', '论文速递', False,
            ),
            publish_to_blog.generation_input_fingerprint(
                papers, '2026-07-10', '论文速递', False,
            ),
        )

    def test_legacy_digest_cover_verifier_uses_same_top10_context(self):
        papers = [
            {
                'arxivId': f'2607.{index:05d}',
                'title': f'Paper {index}',
                'parsed': {
                    'score': f'{10 - index / 10:.1f}',
                    'primaryTaskTag': '#语音识别',
                    'tags': ['#语音识别'],
                },
            }
            for index in range(1, 13)
        ]
        context = publish_to_blog._digest_cover_context(papers, '2026-07-10')
        self.assertEqual(len(context['ranking']), 10)
        self.assertEqual([item['rank'] for item in context['ranking']], list(range(1, 11)))
        self.assertEqual(context['ranking'][-1]['title'], 'Paper 10')

    def test_post_publish_planner_start_failure_does_not_undo_blog_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            current = Path(tmp)
            with mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                manifest = publish_to_blog.generation_manifest_path('2026-07-10')
                manifest.parent.mkdir(parents=True, exist_ok=True)
                manifest.write_text(json.dumps({'category': '论文速递'}), encoding='utf-8')
                with mock.patch.object(
                    publish_to_blog.subprocess, 'run', side_effect=OSError('node missing'),
                ):
                    self.assertFalse(
                        publish_to_blog.plan_post_publish_visual_assets('2026-07-10')
                    )

    def test_digest_cover_local_bytes_are_allowed_for_required_review(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / 'blog'
            current = Path(tmp) / 'current'
            cover = repo / 'static/images/digest-covers/2026-07-10/cover.png'
            cover.parent.mkdir(parents=True)
            cover.write_bytes(valid_png())
            manifest_dir = current / 'digest-cover-manifests'
            manifest_dir.mkdir(parents=True)
            context = {
                'title': '语音/音乐/音频论文速递 2026-07-10',
                'batchDate': '2026-07-10', 'paperCount': 1,
                'hotDirections': [{'tag': '#语音识别', 'count': 1}],
                'ranking': [{'rank': 1, 'title': 'Paper', 'score': '8.0', 'primaryTask': '#语音识别'}],
            }
            (manifest_dir / '2026-07-10.json').write_text(json.dumps({
                'generationContext': context,
            }), encoding='utf-8')
            url = f'{publish_to_blog.BASE_PATH}/images/digest-covers/2026-07-10/cover.png'
            with mock.patch.dict(os.environ, {'PAPER_ANALYZER_SECONDARY_MODEL': 'vision-model'}), \
                    mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'DIGEST_COVER_MANIFEST_DIR', manifest_dir), \
                    mock.patch.object(
                        publish_to_blog, 'call_llm_api',
                        return_value='{"passed": true, "issues": []}',
                    ) as call:
                loaded = publish_to_blog._load_review_image(url)
                passed, issues = publish_to_blog.multimodal_review_images(
                    f'![cover]({url})', '汇总页', required=True,
                )
            self.assertEqual(loaded['media_type'], 'image/png')
            self.assertTrue(passed)
            self.assertEqual(issues, [])
            self.assertIn('TOP 10', call.call_args.args[0])
            self.assertIn('语音识别', call.call_args.args[0])

    def test_review_and_push_allow_generation_without_infographic(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10-paper.md'
            page.write_text('''---
paper_digest_page_type: paper
paper_digest_arxiv_id: "2607.00001"
---
body
''', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_to_blog.save_generation_manifest('2026-07-10', [page])
                loaded, _ = publish_to_blog.load_generation_manifest('2026-07-10')
                self.assertEqual(loaded, [page.resolve()])
                manifest_path = publish_to_blog.generation_manifest_path('2026-07-10')
                reviewed = {str(page.resolve()): {
                    'passed': True,
                    'reviewedSha256': publish_to_blog._sha256_file(page),
                }}
                publish_to_blog.save_review_receipt(
                    '2026-07-10', [page], 'hugo',
                    generation_manifest=manifest_path, reviewed_results=reviewed,
                )
                verified, _ = publish_to_blog.load_verified_review_receipt('2026-07-10')
                self.assertEqual(verified, [page.resolve()])

    def test_generation_rejects_duplicate_digest_cover_reference(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, _posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            paths = []
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                save_bound_review_receipt('2026-07-10', paths)
                index = next(
                    Path(item) for item in paths
                    if Path(item).name.endswith('visual-gate-index.md')
                )
                cover_url = f'{publish_to_blog.BASE_PATH}/images/digest-covers/2026-07-10/cover.png'
                index.write_text(
                    index.read_text(encoding='utf-8') + f'![duplicate]({cover_url})\n',
                    encoding='utf-8',
                )
                publish_to_blog.save_generation_manifest('2026-07-10', paths)
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '提前引用',
                ):
                    publish_to_blog.load_generation_manifest('2026-07-10')

    def test_review_and_push_reject_any_post_publish_visual_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            index = posts / '2026-07-10.md'
            index.write_text('index\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_paths = [index]
                save_bound_review_receipt('2026-07-10', publish_paths)
                asset = repo / 'static/images/visual-summaries/2026-07-10/2607.99999/infographic.png'
                asset.parent.mkdir(parents=True, exist_ok=True)
                asset.write_bytes(publish_to_blog.PNG_SIGNATURE)
                publish_paths.append(asset)
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', publish_paths,
                )
                reviewed = {
                    str(path.resolve()): {
                        'passed': True,
                        'reviewedSha256': publish_to_blog._sha256_file(path),
                    }
                    for path in publish_paths if path.is_file()
                }
                publish_to_blog.save_review_receipt(
                    '2026-07-10', publish_paths, 'hugo',
                    generation_manifest=manifest, reviewed_results=reviewed,
                )
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '发布后视觉资产',
                ):
                    publish_to_blog.load_generation_manifest('2026-07-10')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '发布后视觉资产',
                ):
                    publish_to_blog.load_verified_review_receipt('2026-07-10')

    def test_generation_install_crash_adopts_binary_visual_asset(self):
        png = valid_png()
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            stage_posts = current / 'blog-generation-stage-2026-07-10' / 'posts'
            stage_posts.mkdir(parents=True)
            (stage_posts / '2026-07-10.md').write_text('index\n', encoding='utf-8')
            staged_asset = stage_posts.parent / 'static/images/visual-summaries/2026-07-10/2607.1/infographic.png'
            staged_asset.parent.mkdir(parents=True)
            staged_asset.write_bytes(png)
            journal_path = current / 'journal.json'
            journal = {'installation': None}
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)):
                publish_to_blog.prepare_generation_installation(
                    journal, journal_path, stage_posts, posts, '2026-07-10',
                    staged_assets=[staged_asset],
                )
                record = next(item for item in journal['installation']['files'] if item['path'].endswith('.png'))
                target = repo / record['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(png)
                installed = publish_to_blog.resume_generation_installation(
                    journal, journal_path, stage_posts,
                )
                self.assertIn(target.resolve(), installed)
                self.assertEqual(target.read_bytes(), png)

    def test_precommit_hook_cannot_smuggle_unreviewed_commit_delta(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            hook = repo / '.git/hooks/pre-commit'
            hook.write_text('#!/bin/sh\necho injected > injected.txt\ngit add injected.txt\n', encoding='utf-8')
            hook.chmod(0o755)
            base = git(repo, 'rev-parse', 'HEAD').stdout.strip()
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                publish_paths = [page]
                save_bound_review_receipt('2026-07-10', publish_paths)
                self.assertFalse(publish_to_blog.git_push('2026-07-10', publish_paths))
            self.assertEqual(git(repo, 'rev-parse', 'HEAD').stdout.strip(), base)
            self.assertEqual(git(repo, 'diff', '--cached', '--name-only').stdout, '')

    def test_push_adopts_exact_commit_after_receipt_write_crash_window(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, remote = init_blog_repo(tmp, with_remote=True)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('reviewed\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'GITHUB_REMOTE', 'origin'):
                publish_paths = [page]
                receipt_path = save_bound_review_receipt('2026-07-10', publish_paths)
                git(repo, 'add', '--', *publish_to_blog._git_relative_manifest(publish_paths))
                git(repo, 'commit', '-m', 'simulated commit before receipt persistence')
                committed = git(repo, 'rev-parse', 'HEAD').stdout.strip()
                receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
                self.assertNotIn('publicationCommit', receipt)
                self.assertTrue(publish_to_blog.git_push('2026-07-10', publish_paths))
                adopted = json.loads(receipt_path.read_text(encoding='utf-8'))
                self.assertEqual(adopted['publicationCommit'], committed)
            self.assertEqual(git(remote, 'rev-parse', 'refs/heads/main').stdout.strip(), committed)

    def test_schema_v3_generation_tamper_fails_before_review_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            paper = {'arxivId': '2607.12345', 'title': 'Paper'}
            paper_page = posts / '2026-07-10-paper.md'
            paper_page.write_text(
                '---\npaper_digest_page_type: paper\n'
                'paper_digest_arxiv_id: "2607.12345"\n---\noriginal\n',
                encoding='utf-8',
            )
            index = posts / '2026-07-10.md'
            index.write_text(
                '---\npaper_digest_page_type: index\n---\nindex\n', encoding='utf-8',
            )
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                base_head = publish_to_blog.validate_git_publish_branch()
                manifest = publish_to_blog.save_generation_manifest(
                    '2026-07-10', [paper_page, index],
                    input_fingerprint=publish_to_blog.generation_input_fingerprint(
                        [paper], '2026-07-10', '论文速递', False,
                    ),
                    template_fingerprint=publish_to_blog.generation_template_fingerprint(),
                    base_head=base_head,
                    published_papers=[paper],
                    publication_mode=publish_to_blog.LEGACY_V5_MAINTENANCE_MODE,
                )
                paper_page.write_text(paper_page.read_text(encoding='utf-8') + 'tampered\n', encoding='utf-8')
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '文件字节与生成清单不一致',
                ):
                    publish_to_blog.load_generation_manifest('2026-07-10')
                reviewed = {str(paper_page.resolve()): {
                    'passed': True,
                    'reviewedSha256': publish_to_blog._sha256_file(paper_page),
                }}
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    'generation 后页面字节',
                ):
                    publish_to_blog.save_review_receipt(
                        '2026-07-10', [paper_page, index], 'hugo',
                        expected_base_head=base_head,
                        generation_manifest=manifest,
                        reviewed_results=reviewed,
                    )

    def test_manifest_rejects_cross_date_post_for_existing_and_deleted_paths(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            wrong = posts / '2026-07-11-paper.md'
            wrong.write_text('wrong date\n', encoding='utf-8')
            deleted = posts / '2026-07-12-stale.md'
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                for path in (wrong, deleted):
                    with self.subTest(path=path.name), self.assertRaisesRegex(
                        publish_to_blog.PublishDataValidationError, '不属于目标日期',
                    ):
                        publish_to_blog.save_generation_manifest('2026-07-10', [path])

    def test_legacy_published_receipt_is_read_only_generation_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10.md'
            page.write_text('historical\n', encoding='utf-8')
            current.mkdir(parents=True)
            receipt = current / 'blog-review-receipt-2026-07-10.json'
            receipt.write_text(json.dumps({
                'schemaVersion': 1,
                'date': '2026-07-10',
                'publicationCommit': 'a' * 40,
                'remoteVerifiedOid': 'a' * 40,
                'remoteVerifiedAt': '2026-07-10T12:00:00+08:00',
                'remoteIdentitySha256': 'b' * 64,
            }), encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current):
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError, '保持只读',
                ):
                    publish_to_blog.save_generation_manifest(
                        '2026-07-10', [page],
                    )
            self.assertTrue(receipt.is_file())

    def test_content_failure_retries_when_review_protocol_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo, posts, _remote = init_blog_repo(tmp)
            current = Path(tmp) / 'data' / 'current'
            page = posts / '2026-07-10-paper.md'
            page.write_text('same bytes\n', encoding='utf-8')
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='1' * 64):
                manifest = publish_to_blog.save_generation_manifest('2026-07-10', [page])
                publish_to_blog.save_review_failure_state(
                    '2026-07-10', [page], manifest, 'a' * 40, {
                        str(page.resolve()): {
                            'passed': False, 'completed': True, 'failureKind': 'content',
                        },
                    },
                )
            with mock.patch.object(publish_to_blog, 'BLOG_REPO', str(repo)), \
                    mock.patch.object(publish_to_blog, 'CURRENT_DIR', current), \
                    mock.patch.object(publish_to_blog, 'review_protocol_fingerprint', return_value='2' * 64):
                plan = publish_to_blog.plan_incremental_review(
                    '2026-07-10', [page], manifest, 'a' * 40,
                )
            self.assertEqual(plan['paths'], [page.resolve()])
            self.assertEqual(plan['unchangedFailed'], [])

    def test_extracted_publish_gates_keep_compatibility_facades_identical(self):
        frontmatter = {
            'paper_digest_manual_depth': 'full-text-evidence-v5',
            'paper_digest_tutorial_contract': 'graduate-researcher-tutorial-quality-v2',
            'paper_digest_fresh_authoring_contract': 'fresh-authoring-v1',
            'paper_digest_fresh_authoring_sha256': 'a' * 64,
            'paper_digest_reader_article_sha256': 'b' * 64,
            'paper_digest_tutorial_payload_contract': 'manual-v5-tutorial-payload-v1',
            'paper_digest_tutorial_payload_sha256': 'c' * 64,
            'paper_digest_tutorial_quality_sha256': 'd' * 64,
            'paper_digest_tutorial_artifact_plan_sha256': 'e' * 64,
        }
        body = (
            '**八维分项：** 创新 1.5/2 ｜ 技术严谨 1.0/1.5 ｜ '
            '实验充分 1.2/1.5 ｜ 清晰度 0.8/1 ｜ 影响力 1.1/1.5 ｜ '
            '开源 1.0/1.5 ｜ 可复现 0.4/0.5 ｜ 工程/实践 1.2/1.5\n\n'
            '### 方法流程\n\n公式为 \\(x+y\\)。\n'
        )
        self.assertEqual(
            publish_to_blog.validate_markdown_format_gate(
                'tutorial.md', frontmatter, body,
            ),
            markdown_hugo_gate.validate_markdown_format_gate(
                'tutorial.md', frontmatter, body,
            ),
        )

    def test_publish_renderer_byte_golden_survives_validator_extraction(self):
        markdown, slug = publish_to_blog.generate_paper_page({
            'title': 'No tags',
            'arxivId': '2607.00001',
            'parsed': {'score': '1'},
        }, '2026-07-10')
        self.assertEqual(slug, 'no-tags-2607-00001')
        self.assertEqual(len(markdown.encode('utf-8')), 430)
        self.assertEqual(
            hashlib.sha256(markdown.encode('utf-8')).hexdigest(),
            'bc5af5ef60d96ea735188539675b4377d0654688231d3b5290d207c7d2d75208',
        )


if __name__ == '__main__':
    unittest.main()
