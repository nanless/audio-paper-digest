#!/usr/bin/env python3
"""详细核心摘要（含全景导读）语义、来源数值核对与 Node 只读重放核验模块。

从 scripts/publish-to-blog.py 拆出；保持与 scripts/analysis-contract.js 同构的语义与
来源边界检查，经由 ContextVar 钩子与 publish-to-blog.py 协作以完整保留 monkeypatch 与
AST 隔离测试兼容性。
"""

from __future__ import annotations

if __name__ == '__main__':
    import sys as _sys
    from pathlib import Path as _Path
    _scripts_dir = str(_Path(__file__).resolve().parent)
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from runtime_guard import require_external_runtime
    require_external_runtime(__file__)
    raise SystemExit('This pure helper is imported by the normal publisher, not a direct CLI.')

import contextvars
import json
import math
import os
import re
import shutil
import sys
import tempfile
from collections.abc import Mapping
from contextlib import contextmanager
from pathlib import Path

_SHARED_SCRIPTS_DIR = str(Path(__file__).resolve().parent)
if _SHARED_SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SHARED_SCRIPTS_DIR)

_ACTIVE_HOOKS: contextvars.ContextVar[Mapping | None] = contextvars.ContextVar(
    'blog_core_summary_verifier_hooks', default=None,
)


@contextmanager
def _hooks_scope(hooks: Mapping | None):
    if hooks is None:
        yield
        return
    token = _ACTIVE_HOOKS.set(hooks)
    try:
        yield
    finally:
        _ACTIVE_HOOKS.reset(token)


class _HookAccessor:
    def __getattr__(self, name: str):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        if name in globals():
            return globals()[name]
        raise RuntimeError(f'blog_core_summary_verifier 缺少必需运行钩子: {name}')

    def get(self, name: str, default=None):
        hooks = _ACTIVE_HOOKS.get()
        if hooks is not None and name in hooks:
            return hooks[name]
        return globals().get(name, default)


_H = _HookAccessor()


def _analysis_sha256_ignoring_core_summary_body(analysis):
    matches = list(re.finditer(r'^##\s*核心摘要\s*\r?\n', str(analysis or ''), re.MULTILINE))
    if len(matches) != 1:
        return None
    start = matches[0].end()
    following = re.search(r'^##\s+', analysis[start:], re.MULTILINE)
    end = start + following.start() if following else len(analysis)
    projected = analysis[:start] + '<CORE_SUMMARY_BODY>' + analysis[end:]
    return _H._javascript_string_sha256(projected)


def _nearest_core_summary_metric_label(segment, from_right):
    # 像 PESQ 这样的裸词，可能指指标，也可能指基线方法。
    # 这里只有明确的 "X分数/X得分/X指标" 标签才可以安全比较。
    candidates = []
    custom = re.compile(
        r'(?<![A-Za-z0-9_])([A-Za-z][A-Za-z0-9_-]{1,39})(?=\s*(?:分数|得分|指标))'
    )
    candidates.extend(
        (match.start(), re.sub(r'[\s_-]+', '', match.group(1).lower()))
        for match in custom.finditer(str(segment or ''))
    )
    if not candidates:
        return ''
    candidates.sort(key=lambda item: item[0])
    return candidates[-1 if from_right else 0][1]


def _has_cross_metric_directional_comparison(sentence):
    sentence = str(sentence or '')
    for match in re.finditer(r'(?:高于|低于|超过|优于|领先)', sentence):
        left = _nearest_core_summary_metric_label(
            sentence[max(0, match.start() - 80):match.start()], True
        )
        right = _nearest_core_summary_metric_label(
            sentence[match.end():match.end() + 80], False
        )
        if left and right and left != right:
            return True
    return False


def _strip_core_summary_non_result_numerals(text):
    value = str(text or '')
    value = re.sub(r'https?://\S+', ' ', value)
    value = re.sub(r'\[[0-9,;\s-]+\]', ' ', value)
    value = re.sub(r'§\s*\d+(?:\.\d+)*', ' ', value)
    value = re.sub(
        r'\b(?:theorem|lemma|proposition|corollary|definition|assumption|equation|fig(?:ure)?\.?|table|section|appendix)\s*\d+(?:\.\d+)*',
        ' ', value, flags=re.IGNORECASE,
    )
    value = re.sub(
        r'(?:定理|引理|命题|推论|公理|定义|假设|公式|方程|等式|式|图|表|章节|附录)\s*(?:编号)?\s*\d+(?:\.\d+)*',
        ' ', value,
    )
    # 与 Node 的 stripCoreSummaryNonResultNumerals 保持同一口径：参考文献的卷、期和
    # 页码范围是文献定位，不是测量值。双栏 PDF 抽取会把文献行粘进正文句子，
    # 页码于是成了句内唯一数值，与指标词拼成一条并不存在的结果。
    value = re.sub(r'\b(?:pp?\.|pages?)\s*\d+(?:\s*[–—~-]\s*\d+)?', ' ', value, flags=re.IGNORECASE)
    value = re.sub(r'\b(?:vol|no)\.\s*\d+(?:\s*[–—~-]\s*\d+)?', ' ', value, flags=re.IGNORECASE)
    value = re.sub(
        r'(?<![A-Za-z0-9_])\d+(?:,\d{3})*(?:\.\d+)?\s*(?:种\s*)?(?:languages?|语言)(?![A-Za-z0-9_])',
        ' ', value, flags=re.IGNORECASE,
    )
    return re.sub(r'(?<![A-Za-z0-9_])(?:19|20)\d{2}(?![A-Za-z0-9_])', ' ', value)


def _complete_corpus_curation_summary(summary):
    """这里只核清洗计数的表达完整性；真实数值由 Node 对封存来源核验。"""
    text = re.sub(r'(?<=\d),(?=\d)', '', str(summary or ''))
    if not re.search(r'(?:语料|句子|文本)', text):
        return False
    for sentence in re.split(r'[。！？!?\n]', text):
        if re.search(r'(?:未发现|没有发现|尚未检查|计划|预计|假设|拟检查)', sentence):
            continue
        forward = re.search(
            r'(?<![\d.])(\d{1,15})(?![\d.])\s*(?:行|句)[^。]{0,20}(?:中有|其中有|中)\s*'
            r'(?<![\d.])(\d{1,15})(?![\d.])\s*(?:行|句)[^。]{0,20}(?:不符合|不满足|未采用)\s*NFC',
            sentence, re.IGNORECASE,
        )
        reverse = re.search(
            r'(?<![\d.])(\d{1,15})(?![\d.])\s*(?:行|句)[^。]{0,15}(?:不符合|不满足|未采用)\s*NFC'
            r'[^。]{0,30}(?:原有|原始|共|全部)\s*(?<![\d.])(\d{1,15})(?![\d.])\s*(?:行|句)',
            sentence, re.IGNORECASE,
        )
        clean = re.search(
            r'(?:修复|清洗|规范化|去重)[^。]{0,30}后[^。]{0,12}'
            r'(?:得到|保留|剩余|形成|共有)\s*(?<![\d.])(\d{1,15})(?![\d.])\s*(?:个)?(?:唯一)?(?:句子|句|行)',
            sentence,
        )
        cleaning_negated = clean and re.search(
            r'(?:未|未曾|从未|没有|尚未|不)(?:进行|完成)?\s*$',
            sentence[max(0, clean.start() - 12):clean.start()],
        )
        if not clean or cleaning_negated or not re.search(r'(?:发现|检查|清洗|统计)', sentence):
            continue
        if forward:
            original, invalid = map(int, forward.groups())
        elif reverse:
            invalid, original = map(int, reverse.groups())
        else:
            continue
        cleaned = int(clean.group(1))
        if 0 < invalid <= original and 0 < cleaned <= original:
            return True
    return False


def _has_block_layout_product_chain(summary, max_sentence_chars=320):
    # 布局、筛出的键块和内核必须真实交接，不把组件罗列当处理链。
    for sentence in re.split(r'[。！？!?；;\n]', str(summary or '')):
        if len(sentence) > max_sentence_chars or re.search(
            r'(?:讨论|提及|不实现|尚不|不负责|不参与|不承担|并非|并未|不是|没有|不能|不会|尚未|未曾|假设|设想|如果|若|可能|预计|计划|未来|建议)'
            r'|(?:不|未)(?:曾|实际|直接|真正|会|能)*\s*(?:进入|计算|筛选|补充|恢复)', sentence,
        ):
            continue
        if re.search(
            r'(?:该|此)布局(?:经[^，,。；]{1,16}(?:置换|重排))?进入查询块与键块筛选[，,]\s*'
            r'以块(?:级)?均值特征计算块分数并用混合Top-k与Top-p为[^，,。；]{1,30}补充键块[，,]\s*选中键块进入稀疏注意力内核计算'
            r'(?:再|并)经逆置换恢复原序', sentence,
        ):
            return True
    return False


def _has_posterior_update_product_chain(summary, max_sentence_chars=320):
    # 当前模型先产生后验功率，再把同一产物交给参数更新。
    for sentence in re.split(r'[。！？!?；;\n]', str(summary or '')):
        if len(sentence) > max_sentence_chars or re.search(
            r'(?:假定|是否|讨论|提及|并非|并未|不是|没有|不能|不会|尚未|未曾|假设|如果|可能|计划|未来)'
            r'|(?:不|未)(?:曾|实际|直接|真正|确实|被)*\s*(?:算出|计算|进入|更新)', sentence,
        ):
            continue
        if re.search(r'由当前模型方差(?:算出|计算)(?:成分占模型方差的)?贡献比与后验功率[，,]\s*(?:该|此)后验功率作为固定输入进入同一成分的幅度与衰减率更新', sentence):
            return True
    return False


def _has_recorded_dissonance_comparison(sentence):
    if re.search(r'(?:假设|假想|假定|如果|若|预计|预期|可能|讨论|提及|计划|未来|并非|不是|未测|未报告|未记录|未实测|尚未|没有|(?:不|未)(?:曾|实际|真正)?(?:在|于|进行|测|报告|记录)|将(?:会|要)?(?:在|于|进行))', sentence):
        return False
    if not re.search(r'(?:在|于)[^，,。！？!?\n]{1,100}(?:录音|听辨|听测|实验|测试)(?:比较|评测)?中', sentence):
        return False
    pair = re.search(r'(?:塞萨里斯|Sethares)\s*(?:感觉)?不协和度(?:从|由)\s*(\d+(?:\.\d+)?)(?:\s*任意单位)?\s*(增至|升至|降至|减至)\s*(\d+(?:\.\d+)?)(?:\s*任意单位)?(?=\s*(?:[，,；;]|$))', sentence, re.I)
    return bool(pair and (float(pair[3]) > float(pair[1]) if pair[2] in ('增至', '升至') else float(pair[3]) < float(pair[1])))


def _has_mean_room_simulation_comparison(sentence):
    if re.search(r'(?:假设|假想|假定|如果|若|预计|预期|可能|讨论|提及|计划|未来|并非|不是|未测|未报告|未记录|未实测|尚未|没有|(?:不|未)(?:曾|实际|真正)?(?:在|于|进行|测|报告|记录)|将(?:会|要)?(?:在|于|进行))', sentence):
        return False
    context = re.search(r'(?:在|于)([^，,。！？!?\n]{1,120})上(?:按|以)\s*[1-9]\d*\s*个房间平均(?:的)?(?:单房间)?(?:平均)?空间房间脉冲响应仿真耗时', sentence)
    if not context or not re.search(r'(?:Apple|MacBook|Intel|AMD|NVIDIA|CPU|GPU|Jetson|Raspberry)', context[1], re.I):
        return False
    values = list(re.finditer(r'(?:镜像源)?([1-9]\d*)阶\s*(\d+(?:\.\d+)?)\s*(秒|毫秒|s|ms)(?![A-Za-z\d.])', sentence, re.I))
    if len(values) < 2 or len({value[1] for value in values}) != len(values) or any(float(value[2]) <= 0 for value in values):
        return False
    seconds = {value[1]: float(value[2]) * (0.001 if value[3].lower() in ('毫秒', 'ms') else 1) for value in values}
    comparison = re.search(r'([1-9]\d*)阶(?:明显)?(高于|低于)([1-9]\d*)阶(?:和([1-9]\d*)阶)?(?![\d.])', sentence)
    if not comparison:
        return False
    compared = [order for order in (comparison[3], comparison[4]) if order]
    return bool(comparison[1] in seconds and all(order in seconds and (seconds[comparison[1]] > seconds[order] if comparison[2] == '高于' else seconds[comparison[1]] < seconds[order]) for order in compared))


def _has_concrete_core_summary_setting(sentence, metric_pattern=None, conference_metric_pattern=None):
    if re.search(r'(?:讨论|提及|并非|不是|不能|假想|设想|假设|计划|未来|无关|文件目录|如果|若在|预计|预期|可能|未在|没有|未进行|未做|不进行|不做|否认|反驳|引用|引述)', sentence):
        return False
    if re.search(r'(?:在|于)(?:[\u4e00-\u9fff]{1,8}语)\s*[A-Z][A-Za-z0-9._-]{2,}(?:上|中)', sentence) \
            or re.search(r'(?:在|于)\s*每(?:模型|权重)\s*[1-9][0-9]*\s*组(?:留存|留出)对话(?:上|中)', sentence):
        return True
    experiment_scope = re.search(r'(?:在|于)[^，,。！？!?；;\n]{1,150}(?:实验|测量)(?:中|上)', sentence)
    format_scope = re.search(r'(?:在|于)([^，,。！？!?；;\n]{1,110}(?:语音|音频|音乐))(?:上|中)', sentence)
    scopes = [experiment_scope if experiment_scope and re.search(r'[1-9][0-9]{0,5}\s*名[^，,。！？!?；;\n]{0,45}(?:参与者|听者|受试者|母语者|说话人)', experiment_scope[0]) and re.search(r'(?:聆听|听辨|听测|主观|重复)[^，,。！？!?；;\n]{0,45}实验', experiment_scope[0]) else None, re.search(r'(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}\s*(?:匹配|失配|跨域|未见说话人)测试[^，,。！？!?；;\n]{0,60}(?:下|中|上)', sentence),
        format_scope if format_scope and re.search(r'采样', format_scope[1]) and re.search(r'(?:[1-9][0-9]{0,2}|[一二两三四五六七八九十百]{1,5})位', format_scope[1]) and re.search(r'[0-9]+(?:\.[0-9]+)?\s*(?:kHz|Hz)(?![A-Za-z])', format_scope[1]) else None]
    if metric_pattern is not None and conference_metric_pattern is not None and not re.search(r'(?:假设|假想|假定|设想|如果|若|是否|预计|预期|可能|计划|未来|讨论|提及|并非|不是|不能|未进行|未测|未报告|没有|将(?:会|要)?(?:在|于))', sentence):
        for scope in filter(None, scopes):
            previous_metric_header = False
            for raw in re.split(r'[，,；;]', sentence[scope.end():]):
                clause = raw.strip()
                metric = any(re.search(r'^(?:(?:指标|分数|得分))?(?:(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?|下(?:有|无)[^，,；;。]{1,24}(?:刺激|条件)(?:为|是)\s*[-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.])', clause[match.end():], re.I) for pattern in (metric_pattern, conference_metric_pattern) for match in pattern.finditer(clause))
                if re.search(r'(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?(?:\s*(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分|x|×))?(?![A-Za-z0-9_.])', clause, re.I) and not re.search(r'(?:参数(?:量|值|个数)?|学习率|批量|批大小|样本(?:量|数)|训练|推理|部署|迭代|步数|轮数|GPU|CPU|显存|内存|硬件|时长|小时|batch)', clause, re.I) and (metric or (previous_metric_header and re.search(r'^(?:(?:本方法|本文方法|所提方法|提出的方法|本系统|该方法|该系统)(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?|[A-Z][A-Za-z0-9_-]{1,40}(?:为|是|从|升至|降至)\s*[-+]?[0-9]+(?:\.[0-9]+)?\s*(?:%|％|dB|ms|s|秒|分钟|倍|点|分|x|×)(?![A-Za-z0-9_])|(?:元音|辅音|鼻音|擦音|音段)\s*`?/[A-Za-z]+/`?(?:为|是)\s*[-+]?[0-9]+(?:\.[0-9]+)?)(?![A-Za-z0-9_.])', clause, re.I))):
                    return True
                previous_metric_header = bool(re.search(r'^(?:以|用)(?:' + metric_pattern.pattern + '|' + conference_metric_pattern.pattern + r')(?:计|衡量)$', clause, re.I))
    return bool(re.search(
        r'(?<![A-Za-z0-9_])[A-Z][A-Za-z0-9._-]{1,39}-Bench(?![A-Za-z0-9_])全部\s*[1-9][0-9]*个请求的评估中'
        r'|(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}\s*标准(?:[1-9][0-9]*|[一二两三四五六七八九十]+)名留出说话人[^，,。！？!?；;\n]{0,100}比较中', sentence,
    ))


def _has_symbolic_geometry_method_chain(summary):
    sentences = [text.strip() for text in re.split(r'[。！？!?；;\n]', str(summary or '')) if text.strip()]
    denied = re.compile(r'讨论|提及|如果|若|是否|应该|应当|建议|假设|假想|假定|设想|预计|预期|可能|计划|拟将|拟把|未来|准备|并非|不是|另一(?:个|种|套|组|批)|(?:不同|其他|无关)的?点集|独立方法|(?:不|未|没有)(?:曾|实际|直接|真正|进行|再|被|确实|把|将|会|能|以)*\s*(?:转为|转成|转换|编码|生成|输出|进入|作为|检验|判断|收成|映射)')
    producer = re.compile(r'^编码(?:先)?(?:把|将)(?:每个|每一|各个)?音(?:符)?(?:转为|转成|转换为|编码为)(?:二维|音高时间平面上的)点(?:集)?')
    transfer = re.compile(r'(?:输出的|得到的|形成的|组合的)?点集(?:直接)?(?:进入几何(?:匹配|判定)|作为(?:下一步)?几何(?:匹配|判定)的输入)')
    process = re.compile(r'^(?:几何(?:匹配|判定)|匹配)(?:在[^，,]{1,75}上(?:以)?)?(?:检验|判断|能否)[^，,]{0,80}变换[^，,]{0,50}(?:重合|映射)')
    for index, sentence in enumerate(sentences):
        encoding = re.split(r'[，,]', sentence)[0]
        if denied.search(encoding) or not producer.search(encoding):
            continue
        if not any(not denied.search(clause) and transfer.search(clause) for clause in re.split(r'[，,]', sentence)):
            continue
        next_sentence = sentences[index + 1] if index + 1 < len(sentences) else ''
        clauses = [clause for text in [sentence, next_sentence] for clause in re.split(r'[，,]', text)]
        if any(not denied.search(clause) and process.search(clause) for clause in clauses):
            return True
    return False


def _has_scoped_symbolic_demonstration(summary):
    # 这里只镜像摘要的表达完整性；无实测来源分类仍由Node绑定来源门核验。
    if not _has_symbolic_geometry_method_chain(summary):
        return False
    sentences = re.split(r'[。！？!?；;\n]', str(summary or ''))
    scalar_metric = re.compile('(?:(?<![A-Za-z0-9_])(?:(?:cp|tcp)?WER|SWER|AER|CER|PER|DER|JER|F1|F[- ]?Scores?|BLEU|COMET|ROUGE|MOS(?:[- ]?[PT])?|PCC|FAD(?:CLAP|Vggish)|CQT1-PCC|LPAPS|CDPAM|PESQ|STOI|SI-SDR|CA-SDRi|SDRi|SNRi|SDR|SNR|EER|UAR|PPL|NLL|negative[ -]log[ -]likelihood|false[ -]acceptance[ -]rate|unsafe[ -]response[ -]rate|safety[ -]understanding[ -]rate|deepfake[ ]+FAR|TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S|ILD[- ]W|ASR|mAP|gAP|AUROC|AUC|GMR|GMC|ECE|mIoU|IoU|J&F|MJ|MF|Jaccard|LangRank|Exact Match|Pearson|Spearman|Kendall|PSNR|SSIM|MSE|MAE|RMSE|FGD|BeatAlign|Diversity|R1@(?:0(?:\\.\\d+)?|1(?:\\.0+)?)(?![.\\d@])|R@\\d+(?:\\.\\d+)?|SAR|DAR|PISR|RtA|NBS|OIC|PAR|Fair[ -]?Rate|BMSR|JSR|RSF|OH|n?TVD|SpkSim|LPS|SBS|UTMOS|PLCMOS|precision|recall|MSR|FVD|FID|Acc(?:[_ -]?(?:macro|num))?|CLAP(?:[_ -](?:MS|LAION))?|VISQOL|MCD|SPK[_ -]?SIM|Mel(?:[ -]Dist(?:ance)?)?|STFT(?:[ -]Dist(?:ance)?)?|DeSync|MotionQ|IB|accuracy|error rate|success rate|win rate|compression[ -](?:ratio|rate)|real[ -]time factor|scores?|latency|throughput|RTF|FPS|performance|metrics?)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])E2E(?=[ ]*(?:比例|命中率|成功率))|(?:皮尔逊(?:积矩)?相关系数|斯皮尔曼(?:秩)?相关系数|肯德尔(?:秩相关|和谐|协调|一致性)系数)(?!\\s*(?:的)?(?:模型|方法|基线|算法|网络))|字错率|评估损失(?:终值)?(?=[^。；\\n]{0,90}(?:[二两三四五六七八九十百1-9][0-9]*(?:\\.\\d+)?倍|(?:为|是|从)\\s*\\d+(?:\\.\\d+)?))|不安全回答率|安全理解率|伪造假接受率|耳间强度差(?:Wasserstein)?距离|平均绝对误差|端到端命中率|有用性偏好率|均方根误差|词(?:字)?错率|困惑度|负对数似然|攻击成功率|准确率|正确率|错误率|误差率|期望校准误差|召回率|精确率|总体分|总分|得分|分数|胜率|成功率|延迟|吞吐|实时率|对数谱失真|两耳声级差误差|正确拒绝率|真负率|真阳性率|检出率|(?:人类|人工)(?:语义)?评分|主观评分|客观评分|相似度|相似分数|性能|指标)', re.IGNORECASE)
    for sentence in sentences:
        metric_surface = re.sub(r'(?:\u53d8\u6362)?\u7b49\u4ef7\u7ec4\u89c4\u6a21\u4e3a\u6307\u6807', ' ', sentence)
        if scalar_metric.search(metric_surface) and re.search(r'\d|(?:\u767e\u5206\u4e4b|\u5343\u5206\u4e4b|\u96f6\u70b9)[\u96f6\u4e00\u4e8c\u4e24\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341\u767e\u5343\u4e07\u70b9]+', sentence):
            return False
    scoped = any(not re.search(r'假设|假想|预计|可能|未来|讨论|提及|不只|并非|不是', sentence)
                 and re.search(r'结论(?:只|仅)在[^。]{0,55}(?:该曲|作品|主题实例|实例)[^。]{0,25}(?:有证据|成立|得到支持|得到验证)', sentence)
                 for sentence in sentences)
    limit = any(not re.search(r'并非|不是|不能|已经|已(?:经|得到)?验证', clause)
                and re.search(r'跨作品[^，,。]{0,45}(?:尚未|未)(?:得到)?验证', clause)
                for sentence in sentences for clause in re.split(r'[，,]', sentence))
    return bool(scoped and limit)


def _has_concrete_product_handoff(summary, max_sentence_chars=320):
    sentences = [s.strip() for s in re.split(r'[。！？!?；;\n]', re.sub(r'（[^）]*）|\([^)]*\)', '', str(summary or ''))) if s.strip()]
    denied = re.compile(r'(?:假设|设想|假定|如果|可能|未来|拟采用|计划|预计|预期|应当|应该|并非|并未|没有|不能|尚未|未曾|另一(?:种|套)|独立方法|讨论|提及|对比|比较|相关工作|先前工作|文献|未(?:实现|执行|实施)|不负责|不用于|不与|未与)|(?:^|[。；，,])\s*建议|(?:不|未)(?:被|曾|直接|实际|真正|会|能|再)*\s*(?:生成|输出|预测|提取|抽取|转成|送入|配对|拼接|作用于|统计|计算|重建|合并)')
    neural_tokens = re.compile(r'解码器[^。；]{0,140}(?:预测|输出|生成)(?:源内容对应的)?(?:离散)?声学令牌[^。；]{0,140}(?:所得|这些|该)(?:声学)?令牌(?:再)?送入(?:神经音频)?编解码器(?:解码器)?(?:重建|解码)(?:为|成)?波形')
    frame_production = re.compile(r'编码器[^。；]{0,120}(?:输出|转成|提取|抽取)(?:为|成)?帧级(?:编码)?表示')
    frame_consumption = re.compile(r'听众嵌入[^。；]{0,100}与(?:每帧编码|帧级(?:编码)?表示)拼接[，,]\s*拼接序列送入[^。；]{0,45}(?:长短期记忆网络|BiLSTM|回归头)[^。；]{0,20}(?:得到|输出|预测)帧级分数')
    mask_processing = re.compile(r'(?:录音|清洁语音|干净语音)[^。；]{0,90}(?:生成|得到)二值时频掩码[，,]\s*(?:再|随后)?(?:(?:将|把)(?:该|所得)?(?:二值时频)?掩码)?作用于[^。；]{0,60}统计(?:语音帧与噪声帧|语音与噪声)(?:的)?功率[^。；]{0,70}(?:算出|计算)[^。；]{0,50}信噪比')
    text_production = re.compile(r'问答[^。；]{0,70}以[^。；]{0,50}为输入(?:转成|重构成)一问一答[^。；]{0,100}整体反馈[^。；]{0,90}合并成[^。；]{0,60}辅导文本')
    text_consumption = re.compile(r'两类文本[^。；]{0,35}与对应录音配对[^。；]{0,100}指令微调')
    for index in range(len(sentences)):
        for size in (1, 2):
            parts = sentences[index:index + size]
            if len(parts) != size or any(len(s) > max_sentence_chars for s in parts):
                continue
            window = '。'.join(parts)
            if denied.search(window):
                continue
            if (not re.search(r'(?:若|假想|假定|设想|是否|相互独立|无关(?:的)?(?:波形|方法))|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:回归|预测|输出|求|计算|得到)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)|(?:不|未|没有)(?:再|实际|直接|继续)?(?:使用|采用|处理|传递|送入)(?:该|此|所得)?(?:估计)?(?:基频)?波形|(?:丢弃|弃用)(?:了)?(?:该|此|所得)?(?:估计)?(?:基频)?波形|(?:不|未|没有)(?:再|实际|直接|继续)?(?:将|把)(?:该|此|所得)(?:估计)?(?:基频)?波形[^，,。；]{0,12}(?:送入|用于|交给)', window) and re.search(r'(?:编码器|解码器|网络)[^。；]{0,180}(?:回归|预测|输出)(?:估计的)?(?:基频)?波形', parts[0])
                    and re.search(r'(?:由|将|把)(?:该|此|估计得到的)(?:估计)?(?:基频)?波形[^，,。；]{0,12}(?:求|计算|得到)解析信号并(?:计算|求取)相位导数(?:即得|得到)(?:瞬时频率|连续基频)', parts[-1])):
                return True
            if (neural_tokens.search(window) or mask_processing.search(window)
                    or frame_production.search(parts[0]) and frame_consumption.search(parts[-1])
                    or text_production.search(parts[0]) and text_consumption.search(parts[-1])):
                return True
    return False


def _has_explicit_artifact_handoff(summary, max_sentence_chars=320):
    sentences = [text.strip() for text in re.split(r'[。！？!?；;\n]', re.sub(r'（[^）]*）|\([^)]*\)', '', str(summary or ''))) if text.strip()]
    denied = re.compile(r'(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|讨论|提及|并非|不是|没有|未曾|尚未|独立方法|无关)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再)*(?:生成|输出|得到|形成|取出|提取|编码|使用|接收|承接|送入|进入|作为|用于|计算|分成|分派)')
    production = re.compile(r'(?:生成|得到|输出|形成|统一为|压缩为|池化得|取出|提取|抽取)')
    processing = re.compile(r'(?:修复|合成|重采样|预处理|构造|编码|池化|变换|搬移|变频|检测器|分类头)')
    consumer_action = re.compile(r'(?:分成|分派|编码|计算|训练|学习|分类|回归|去噪|评分|解码|重合成)')
    artifacts = [r'(?:刺激)?语音', r'配对(?:监督)?信号', r'(?:双|两)视图', r'(?:utterance|输入)?嵌入', r'(?:数值|定长|固定维数)?向量']
    for index, first in enumerate(sentences):
        second = sentences[index + 1] if index + 1 < len(sentences) else ''
        if len(first) > max_sentence_chars or len(second) > max_sentence_chars:
            continue
        if not denied.search(first) and re.search(r'(?:预载|载入)[^。]{1,80}(?:历史|上下文)[^。]{0,60}(?:实时流入|逐帧处理|滚动输入)[^。]{0,50}(?:该|此)阶段产生的[^。]{1,80}(?:、|与|和)[^。]{1,60}直接进入评分', first):
            return True
        for family in artifacts:
            for artifact in re.finditer(family, first):
                before = first[:artifact.start()]
                immediate = re.split(r'[，,]', before)[-1]
                if not production.search(immediate) or not processing.search(before) or denied.search(before):
                    continue
                product_tail = first[artifact.end():]
                following = product_tail + ('。' + second if second else '')
                references = [rf'(?:该|这些|上述|所得|取出的|得到的|形成的)(?:每个|每一|输入)?{family}[^，,。]{{0,65}}']
                count = re.search(r'([1-9][0-9]{0,5})\s*(?:段|个|条|维|种)?\s*$', immediate)
                if count:
                    references.append(rf'{count[1]}\s*(?:段|个|条|种)?{family}[^，,。]{{0,65}}')
                if re.fullmatch(r'(?:双|两)视图', artifact[0]):
                    references.append(r'两视图[^，,。]{0,65}')
                for pattern in references:
                    used = re.search(pattern, following)
                    if used and not denied.search(following[max(0, used.start() - 20):used.end()]) and consumer_action.search(used[0]):
                        return True
                if re.search(r'^[，,]\s*直接作为[^，,。]{0,20}(?:分类器|回归器|解码器|编码器)输入', product_tail) and not denied.search(re.split(r'[。；]', product_tail)[0]):
                    return True
                received = re.search(rf'(?:训练时)?承接该{family}[^。]{{0,180}}', second)
                if received and not denied.search(received[0]) and re.search(r'(?:分支|模型|网络)[^。]{0,140}(?:学习|训练|去噪)', received[0]):
                    return True
    return False


def _has_natural_scoped_boundary(summary):
    for sentence in re.split(r'[。！？!?\n]', str(summary or '')):
        if re.search(r'(?:并非|不是|不能说|不能认为|不应认为|否认)[^，,；;]{0,30}(?:限于|仅在|未经)', sentence):
            continue
        if re.search(r'(?:未经证实|效果未知)[^。]{0,30}(?:说法|表述|观点|判断)[^。]{0,20}(?:不成立|不正确|有误|错误)', sentence):
            continue
        measured_scope = re.search(r'(?:结论|研究结果|研究发现|该提升|这些结果)(?:只|仅)在[^。！？!?；;\n]{1,140}(?:测试集|评测集|实录数据)[^。！？!?；;\n]{0,40}?(?:内|上|下|中)(?:得到)?(?:验证|成立)', sentence)
        if (measured_scope and not re.search(r'(?:并非|不是|不能|不应|否认|尚未|未经|没有|未曾|未被|假设|假想|假定|设想|如果|若|可能|预计|预期|计划|未来|讨论|声称|据说)', sentence[:measured_scope.end()])
                and not re.search(r'(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:不成立|不正确|不属实|不是事实|错误|有误)|^(?:是|为)?(?:不成立|不正确|不属实|错误|有误)', sentence[measured_scope.end():measured_scope.end() + 50])):
            return True
        if (re.search(r'(?:结论|研究结果|研究发现|该提升|这些结果)(?:只|仅)?在[^。]{1,100}(?:条件|语料|数据集|设置|说话人)[^。]{0,30}(?:下验证|中验证|得到验证|成立)', sentence)
                or re.search(r'(?:该提升|这些结果|上述结论)(?:只|仅)?限于[^。]{1,100}(?:评测|语料|数据集|问答|场景|条件|设置|样本|任务)', sentence)
                or re.search(r'(?:跨语言|跨说话人|新说话人|新硬件|词表外|开放式生成)[^。]{0,80}(?:效果未经证实|效果未知|尚未得到验证)', sentence)):
            return True
    return False




def _has_conditional_metric_delta_direction(sentence, metric_pattern):
    if re.search(r'(?:假设|假想|如果|可能|预计|计划|未来|并非|并未|未报告|未测|没有观察到)', sentence):
        return False
    pattern = re.compile(r'(?:准确率|正确率|错误率|词错率|(?<![A-Za-z0-9_])(?:WER|EER|UAR|accuracy)(?![A-Za-z0-9_]))(?:差|差值|差距)?在([^，,。；;]{1,60}?)(?:时|条件下)比([^，,。；;]{1,60}?)(?:时|条件下)(?:平均|总体)?(?:高|低)(?:了|出)?\s*(\d+(?:\.\d+)?)\s*(?:个百分点|百分比点|pp)(?![A-Za-z])', re.I)
    return any(match[1].strip() != match[2].strip() and float(match[3]) > 0
               and not metric_pattern.search(match[1] + match[2]) for match in pattern.finditer(sentence))


def _has_generated_input_model_head_chain(summary, max_sentence_chars=320):
    sentences = [text.strip() for text in re.split(r'[。！？!?；;\n]', str(summary or '')) if text.strip()]
    denied = re.compile(r'(?:并非|并未|没有|不能|尚未|未曾|假设|如果|可能|计划|未来|讨论|提及|独立方法|无关|相关工作)|(?:不|未)(?:曾|实际|直接|真正|再|会|能)*(?:送给|送入|生成|形成|作为|输出|预测)')
    for first, second in zip(sentences, sentences[1:]):
        if len(first) > max_sentence_chars or len(second) > max_sentence_chars or denied.search(first) or denied.search(second):
            continue
        if not re.search(r'(?:生成|构造|形成)[^。]{1,100}(?:流|序列|样本|查询)[^。]{0,120}(?:特征|表示)[^。]{0,50}作为模型输入', first):
            continue
        handoff = re.search(r'^(?:该|此)输入(?:送给|送入)([^，,。]{1,100})[，,]\s*(?:模型输出|其输出)(?:再|随后)?(?:送给|送入|送)[^，,。]{1,60}分类器(?:预测|输出|判别)[^，,。]{1,50}', second)
        if handoff and re.search(r'(?:模型|网络|记忆|注意力)', handoff[1]):
            return True
    return False


def _has_explicit_edited_vector_handoff(summary, max_sentence_chars=320):
    sentences = [s.strip() for s in re.split(r'[。！？!?；;\n]', str(summary or '')) if s.strip()]
    denied = re.compile(r'(?:并非|并未|不是|不会|不能|尚未|未曾|不再|假设|假想|假定|设想|如果|若|是否|可能|预计|预期|计划|未来|讨论|提及|相关工作|独立方法|无关)|(?:不|未|没有)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:输出|生成|得到|编辑|变换|移动|映射|使用|接收|承接|送入|作为|合成|重合成|重建)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)')
    for i in range(len(sentences) - 2):
        parts = sentences[i:i + 3]
        if any(len(s) > max_sentence_chars or denied.search(s) for s in parts):
            continue
        produced = re.search(r'编码器[^，,。；]{0,80}(?:输出|生成|得到)(?:身份|说话人|潜在|特征)?向量\s*([A-Z][A-Z0-9_]{0,7})(?![A-Za-z0-9_′’\x27])', parts[0])
        if not produced:
            continue
        variable = re.escape(produced[1])
        edit = re.compile(r'(?:编辑|变换|适配|投影)(?:阶段|模块|器)?以(?:上一步的|该|此)?' + variable + r'为输入[^。；]{0,160}(?:移动|平移|变换|映射|编辑)[^。；]{0,60}(?:得到|输出|生成)' + variable + r'[′’\x27](?![A-Za-z0-9_′’\x27])')
        consumer = re.compile(r'^(?:解码器|声码器)(?:以|将|把)(?:上一步的)?(?:(?:离散)?(?:语义|内容)?(?:单元|表示|特征|编码)(?:和|与))?' + variable + r'[′’\x27](?![A-Za-z0-9_′’\x27])' + r'(?:共同)?(?:为条件输入|作为条件输入|作为输入)[^。；]{0,100}(?:合成|重合成|重建|输出)波形')
        unused = re.compile(r'(?:丢弃|弃用|忽略|不使用|未使用|没有使用)(?:了)?(?:该|此)?(?:向量)?' + variable + r'(?:[′’\x27](?![A-Za-z0-9_′’\x27]))?')
        if not any(unused.search(s) for s in parts) and edit.search(parts[1]) and consumer.search(parts[2]):
            return True
    return False


def _has_typed_natural_product_handoff(summary, max_sentence_chars=320):
    """Mirror the closed, artifact-owned handoffs used by the analysis guard."""
    sentences = [s.strip() for s in re.split(r'[。！？!?；;\n]', str(summary or '')) if s.strip()]
    denied = re.compile(r'(?:假设|假想|假定|设想|如果|可能|预计|预期|计划|未来|讨论|提及|相关工作|独立方法|他人|另一(?:个|种|套)(?:模型|方法|系统)|其他(?:模型|方法|系统)|并非|并未|不是|没有|不能|尚未|未曾)|(?:不|未)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:输出|生成|得到|形成|读取|接收|送入|作为|检索|插入|转写|打分)|(?:丢弃|弃用|忽略)(?:了)?(?:该|此|这些|两种)|(?:说法|表述|观点|判断)[^。；]{0,20}(?:错误|有误|不成立|不正确)')
    for index, first in enumerate(sentences):
        second = sentences[index + 1] if index + 1 < len(sentences) else ''
        revoked_or_foreign = re.compile(r'(?:否认|否定|反驳|驳斥|引用|引述|转述)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)|(?:基线|对照|其他|另一个|另一种)(?:的)?(?:自回归)?解码器')
        if len(first) > max_sentence_chars or denied.search(first) or revoked_or_foreign.search(first):
            continue
        if re.search(r'调用头判断[^。；]{1,100}[，,]触发后检索[^，,。；]{1,30}范例并作为引导插入生成序列', first):
            return True
        if not second or len(second) > max_sentence_chars or denied.search(second) or revoked_or_foreign.search(second):
            continue
        memories = set(re.findall(r'([\u4e00-\u9fff]{1,8}记忆)(?:保留|表示|编码)', first))
        if re.search(r'交叉注意力[^。；]{0,120}输出', first) and len(memories) == 2 \
                and re.search(r'解码器[^。；]{0,60}(?:交替)?读取(?:这)?两种记忆[^。；]{0,80}(?:预测|输出|生成)[^，,。；]{1,30}', second):
            return True
        if re.search(r'编码器[^。；]{0,120}输出[^，,。；]{0,30}(?:表示|特征)序列', first) \
                and re.search(r'^(?:该|此)(?:表示|特征)序列作为(?:因果)?(?:Conformer|Transformer|循环网络|时序模型)的?输入[^。；]{0,120}末态映射为[^，,。；]{1,30}', second):
            return True
        if re.search(r'语音合成[^。；]{0,100}生成音频[^。；]{0,100}(?:同一|该|此)音频直接作为[^，,。；]{0,30}(?:自动语音识别|ASR)的输入被转写为文本', first) \
                and re.search(r'^转写文本与原始文字分别送入同一[^，,。；]{0,20}(?:大语言模型|LLM)作答[，,]两种回答再交由同一[^，,。；]{0,20}验证器打分得到', second):
            return True
    return False


def _has_typed_processing_product_chain(summary, max_sentence_chars=320):
    """Mirror only the closed, artifact-owned signal/representation paths."""
    denied = re.compile(r'(?:假设|假想|假定|设想|如果|可能|预计|预期|计划|未来|建议|讨论|提及|相关工作|先前工作|他人|独立方法|无关|另一|其他(?:模型|方法|系统|病人|数据|信号|样本)|并非|并未|不是|没有|不能|不会|尚未|未曾|不再|否认|否定|反驳|驳斥|引用|引述|转述)|(?:不|未|没)(?:被|曾|实际|真正|直接|会|能|再|继续)*(?:统计|计算|形成|生成|输出|送入|进入|作为|使用|采用|处理|池化|注入|承接|给出|锁定|确定|执行|发生|应用|实现|实施|进行|完成)|(?:丢弃|弃用|忽略)|(?:说法|表述|观点|判断|过程|流程)[^。；]{0,20}(?:错误|有误|不成立|不正确|未执行)')
    normalize_notice = lambda value: re.sub(r'^(?:不过|然而|但是|可是|但|实际上)[，,]?\s*', '', str(value or ''))
    revoked = re.compile(r'^(?:上述|以上|前述|该|此|这一|这些|所述)(?:方法|流程|链|步骤|过程|说法|表述|处理|交接|轮廓|表示|隐表示|候选集合|解释集合)[^。；]{0,35}(?:不成立|不正确|错误|有误|没有|被弃用|被丢弃|不代表|不属于|(?:未|不)(?:被|曾|实际|真正|根本|直接|再|继续)*(?:使用|采用|输入|消费|送入|注入|应用|发生|执行|实施|实现))')
    forward_revoked = re.compile(r'^(?:(?:下述|如下|以下|后述)(?:方法|流程|链|步骤|过程)[^。；]{0,50}(?:不成立|没有|并未|未执行|未发生|只是设计|只是示意|仅为示意|尚待实现|有待实现)|(?:对照|基线|先前|相关|其他|另一)(?:系统|模型|方法|工作|研究)[^。；]{0,40}(?:方法|流程|步骤)[^。；]{0,15}(?:如下|所示))')

    def safe(parts, object_kind=''):
        if not all(part and len(part) <= max_sentence_chars for part in parts):
            return False
        text = '。'.join(parts)
        if object_kind == 'candidates':
            text = re.sub(r'(?:意图(?:与|和)槽位|意图|槽位|标签)假设(?=[，,]|$)', '候选对象', text, count=1)
        if object_kind == 'pooled':
            text = re.sub(r'与录音数无关的(?:病人级|患者级)隐表示', '固定尺寸隐表示', text, count=1)
        return not denied.search(text) and not re.search(r'(?:^|[，,])\s*(?:但|然而|不过|可是|却)', text)

    for paragraph in re.split(r'\n\s*\n', str(summary or '')):
        if re.search(r'[！？!?]', paragraph):
            continue
        parts = [part.strip() for part in re.split(r'[。；;\n]', paragraph) if part.strip()]
        for index, first in enumerate(parts):
            if forward_revoked.search(normalize_notice(parts[index - 1] if index else '')):
                continue
            second = parts[index + 1] if index + 1 < len(parts) else ''
            third = parts[index + 2] if index + 2 < len(parts) else ''
            clauses = [clause.strip() for clause in re.split(r'[，,]', first)]
            if safe([first]) and not revoked.search(normalize_notice(second)):
                if re.fullmatch(r'梯度归因(?:统计|计算)各频点对[^，,。；]{1,24}(?:影响|贡献)(?:权重)?(?:并)?(?:形成|生成|得到)(?:加权|频率权重)轮廓', clauses[0]) \
                        and re.search(r'^(?:该|此)(?:加权|频率权重)?轮廓(?:作为|被用作)加权函数(?:进入|用于)(?:经典与神经|经典|神经)?(?:广义互相关|GCC|互相关)(?:流水线(?:对比|比较)?|计算|处理)$', clauses[1] if len(clauses) > 1 else ''):
                    return True
                if re.fullmatch(r'(?:前端|编码前端)(?:将|把)[^，,。；]{1,160}(?:拼接|融合)(?:并|后|再)(?:经|通过)(?:二维|2D)卷积(?:编码|处理)?', clauses[0]) \
                        and re.search(r'^(?:输出|得到|生成)融合(表示|特征)(?:并(?:将|把)(?:该|此)\1)?(?:送入|交给)(?:基于[A-Za-z][A-Za-z0-9-]{0,30}的)?(?:时频(?:网格)?主干|分离网络|分离主干)(?:处理|编码|变换)(?:为|得到|生成)(?:待调制的)?分离(?:表示|特征)$', clauses[1] if len(clauses) > 1 else ''):
                    return True
                epoch = re.fullmatch(r'脑电(?:分析|处理)对目标(?:音|刺激)锁定取(-?[0-9]+(?:\.[0-9]+)?)至(-?[0-9]+(?:\.[0-9]+)?)(?:毫秒|ms)(?:计算|生成)(?:事件相关谱扰动|ERSP)', clauses[0])
                baseline = re.fullmatch(r'以(?:语境前|刺激前|目标前)(-?[0-9]+(?:\.[0-9]+)?)至(-?[0-9]+(?:\.[0-9]+)?)(?:毫秒|ms)(?:作为)?基线(?:作|进行)(?:时频变换|时频分析)', clauses[1] if len(clauses) > 1 else '')
                clusters = re.search(r'^(?:经|通过)([1-9][0-9]*)次置换检验(?:确定|识别|得到)显著(?:性)?簇(?=$|并(?:比较|分析|检验))', clauses[2] if len(clauses) > 2 else '')
                if epoch and baseline and clusters:
                    start, end, baseline_start, baseline_end, iterations = map(float, (*epoch.groups(), *baseline.groups(), clusters[1]))
                    if all(math.isfinite(value) for value in (start, end, baseline_start, baseline_end, iterations)) \
                            and start < end and start <= baseline_start < baseline_end <= end:
                        return True
            if safe([first, second], 'pooled') and not revoked.search(normalize_notice(third)) \
                    and re.fullmatch(r'(?:同一病人的|同一患者的)(?:多录音|多部位录音)(?:编码|声学)特征(?:经)?展平后(?:送入|交给)(?:感知)?重采样器', clauses[0]) \
                    and re.fullmatch(r'由固定数量(?:的)?可学习查询(?:经)?交叉注意力(?:池化|汇聚|压缩)(?:为|得到)(?:与录音数无关的)?(?:病人级|患者级)隐表示', clauses[1] if len(clauses) > 1 else '') \
                    and len(re.findall(r'隐表示', first)) == 1 \
                    and (re.search(r'^(?:冻结的)?(?:大)?语言模型[^，,。；]{0,60}[，,]\s*(?:以|通过|使用)(?:可训练)?门控交叉注意力(?:适配器)?(?:把|将)(?:该|此)隐表示注入(?:其)?各层', second) \
                         or re.search(r'^门控交叉注意力(?:适配器)?(?:把|将)(?:该|此)隐表示注入冻结的(?:大)?语言模型(?:的)?各层', second)):
                return True
            following = parts[index + 3] if index + 3 < len(parts) else ''
            if safe([first, second, third], 'candidates') and not revoked.search(normalize_notice(following)) \
                    and re.fullmatch(r'(?:候选列举|候选枚举|枚举阶段)(?:从|依据|根据)[^，,。；]{1,90}(?:挑出|列出|筛出)[^，,。；]{1,70}(?:候选|假设)', clauses[0]) \
                    and re.fullmatch(r'(?:输出|生成|形成)(?:包含正确标签(?:在内)?的)?候选集合', clauses[1] if len(clauses) > 1 else '') \
                    and re.search(r'^(?:否决推理|排除推理|辨析阶段)以(?:上述|该|此)候选集合为输入[，,]', second) \
                    and re.search(r'为每个(?:错误|竞争)候选(?:生成|写出)[^，,。；]{1,70}(?:理由|解释)[，,]\s*(?:形成|输出|得到)解释集合$', second) \
                    and re.fullmatch(r'(?:最终标签|标签阶段|标签预测)(?:承接|依据|使用)(?:前述辨析|上述解释集合|该解释集合)(?:给出|输出|预测)(?:结构化)?(?:意图(?:与|和)槽位(?:-槽值)?|语义标签|最终标签|标签|意图|槽位|语义框)(?:结果)?', third):
                return True
    return False


def _has_explicit_natural_product_chain(summary, max_sentence_chars=320):
    if _has_typed_processing_product_chain(summary, max_sentence_chars):
        return True
    if _has_typed_natural_product_handoff(summary, max_sentence_chars):
        return True
    if _has_explicit_edited_vector_handoff(summary, max_sentence_chars):
        return True
    if _has_generated_input_model_head_chain(summary, max_sentence_chars):
        return True
    if _has_explicit_artifact_handoff(summary, max_sentence_chars):
        return True
    if _has_concrete_product_handoff(summary, max_sentence_chars):
        return True
    if _has_posterior_update_product_chain(summary, max_sentence_chars):
        return True
    if _has_block_layout_product_chain(summary, max_sentence_chars):
        return True
    # 与 Node 相同：必须有实际产物及下一模块对同一产物的使用。
    sentences = [s.strip() for s in re.split(r'[。！？!?；;\n]', str(summary or '')) if s.strip()]
    denied = re.compile(
        r'(?:并非|并未|不是|没有|不能|不会|尚未|未曾|不再|是否|讨论|提及|另一(?:个)?专家|假设|设想|假定|如果|若|可能|预计|预期|计划|未来|建议|应当|应该)'
        r'|(?:不|未)(?:被|能|曾|直接|实际|真正|也|只|还|再|会)*\s*(?:预测|计算|给出|输出|生成|得到|形成|池化|标准化|送入|拼接|融合)'
    )
    for i, first in enumerate(sentences):
        if len(first) <= max_sentence_chars and not denied.search(first) and re.search(
            r'编码器[^，,。；]{0,45}帧(?:级)?表示经均值和标准差池化形成定长向量[，,]\s*该向量标准化后送入[^，,。；]{0,30}逻辑回归输出类别', first,
        ):
            return True
        if i + 1 >= len(sentences):
            continue
        second = sentences[i + 1]
        if len(first) > max_sentence_chars or len(second) > max_sentence_chars or denied.search(first) or denied.search(second):
            continue
        produced = re.search(r'([\u4e00-\u9fff]{1,8}专家)(?:(?!专家|基线|交给|转交|负责|由)[^，,。；]){0,200}?(?:预测|计算|给出|输出|生成|得到)(?:对应的|单曲的|歌曲的|一个)?质量分', first)
        consumed = re.search(r'^([\u4e00-\u9fff]{1,8}专家)(?:把|将)该质量分与(?:(?!专家|基线|交给|转交|负责|由)[^，,。；]){1,180}?(?:拼接|融合)', second)
        if (produced and consumed
                and not produced.group(1).endswith(consumed.group(1))
                and not consumed.group(1).endswith(produced.group(1))):
            return True
    return False


def _core_summary_sentence_view(text):
    # 发布器只做同一窄句法识别；实际同名来源由 Node 摘要阶段和既有来源证明核验。
    return re.sub(
        r'(?<![A-Za-z0-9_])([A-Z][A-Za-z0-9_-]{0,39}(?:[ \t]+[A-Za-z][A-Za-z0-9_-]{0,39}){0,3})!(?=的)',
        lambda match: match.group(0)[:-1] + '\uE000', str(text or ''),
    )


def _has_concrete_runtime_disclosure(summary):
    """按明确运行次数或实测时间识别运行负担。"""
    for sentence in re.split(r'[。！？!?\n]', str(summary or '')):
        if re.search(r'(?:否认|否定|反驳|驳斥|引用|引述|转述)|(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:错误|有误|不成立|不正确|不属实)|(?:错误|有误|不成立|不正确)(?:的)?(?:说法|表述|观点|判断)', sentence):
            continue
        if re.search(r'(?:(?:未|不)(?:曾|实际|直接)?(?:需|需要|进行|执行)|讨论|假说|预计|预期|可能|假设|如果|未来|计划|建议|不需|无需|不能|不会|不进行|不执行|不耗|尚未|没有|未曾|并非|未测|未披露|未报告|未记录|未提供|未给出|未公布|未说明|未统计|不报告|不记录|不披露|不提供|尚无|不代表)', sentence):
            continue
        measured_duration = re.search(r'(?:训练|推理|部署|(?:监督)?微调|强化学习)(?:平均|每轮|每个epoch)?(?:时间|耗时|用时)?(?:约|大约|为|是|分别为)?\s*(?:[0-9]+(?:\.[0-9]+)?)\s*(?:小时|分钟|毫秒|秒|hours?|minutes?|seconds?|ms|h|s)(?![A-Za-z0-9]|\s*的?\s*(?:(?:训练|测试|验证|评测)(?:用|集)?\s*)?(?:音频|语音|录音|数据|样本|语料|材料))', sentence, re.I)
        if (measured_duration and not re.search(r'(?:假定|假想|设想)', sentence)
                and not re.search(r'(?:说法|表述|观点|判断|结论)[^。！？!?；;\n]{0,20}(?:不成立|不正确|不属实|不是事实|错误|有误)|^(?:是|为)?(?:不成立|不正确|不属实|错误|有误)', sentence[measured_duration.end():measured_duration.end() + 50])):
            return True
        if any(re.search(pattern, sentence) for pattern in (
            r'(?:推理(?:为|采用|使用)|以)(?:一|单)次语音前向',
            r'训练可训练参数(?:量)?为\s*[0-9]+(?:\.[0-9]+)?\s*[kKmMbB](?![A-Za-z0-9])',
            r'(?:训练|推理|部署)[^。！？!?；;]{0,40}(?:需要|需|进行|执行)(?:[1-9][0-9]*|[一二两三四五六七八九十]+)次(?:完整(?:的)?|(?:经过|通过)(?:共享)?(?:[A-Za-z0-9_-]+\s*)?(?:编码器|主干|网络|模型)(?:的)?(?:提示条件)?|提示条件(?:的)?)?前向(?:传播|计算)?',
            r'(?:训练|推理|部署)(?:平均|每轮|每个epoch)?时间(?:约|为|是|分别为)?\s*[0-9]+:[0-5][0-9](?![0-9:])',
            r'(?:训练|推理|部署)(?:平均|每轮|每个epoch)?时间[（(](?:毫秒|秒|分钟)(?:/文件)?[）)](?:约|为|是|分别为)?\s*[0-9]+(?:\.[0-9]+)?(?![0-9.])',
        )):
            return True
    return False


def _has_bound_former_latter_comparison(sentence, metric_pattern):
    if re.search(r'(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|并非|不是|不等于|不代表|并未|未进行|未报告|未测|没有)', sentence):
        return False
    metric = r'(?:均方根误差|平均绝对误差|RMSE|MAE|词错误率|WER)'
    number = r'[-+]?\d+(?:\.\d+)?'
    value = rf'({number})(?:\s*±\s*{number})?\s*(%|％|dB|ms|s)?'
    match = re.search(metric + r'比较[，,]\s*([^，,。；]{1,40}?)(?:为|是)\s*' + value
        + r'[，,]\s*([^，,。；]{1,40}?)(?:为|是)\s*' + value
        + r'[，,]\s*(前者|后者)(更高|更低)', sentence, re.IGNORECASE)
    if not match:
        return False
    first, a, unit_a, second, b, unit_b, referent, direction = match.groups()
    named_object = re.compile(r'拟合|模型|系统|方法|基线|对照|条件|分支|输入|编码器')
    if (first.strip() == second.strip() or not named_object.search(first) or not named_object.search(second)
            or (unit_a or '').replace('％', '%') != (unit_b or '').replace('％', '%')
            or metric_pattern.search(first) or metric_pattern.search(second)):
        return False
    left, right = (float(a), float(b)) if referent == '前者' else (float(b), float(a))
    if not math.isfinite(left) or not math.isfinite(right) or left < 0 or right < 0:
        return False
    return left < right if direction == '更低' else left > right


def _has_bound_disjoint_interval_comparison(sentence, metric_pattern):
    # Same closed grammar and interval ordering as the Node core-summary guard.
    clause = re.split(r'[；;。！？!?\n]', str(sentence or ''))[0]
    if len(clause) > 800 or re.search(r'(?:假设|假想|假定|设想|如果|预计|预期|可能|未来|计划|并非|不是|不等于|不代表|并未|未进行|未报告|未测|没有)', clause):
        return False
    surface = re.sub(r'（[^（）]{0,180}）|\([^()]{0,180}\)', '', clause)
    metric = r'(?:词错误率|词错率|字错率|准确率|正确率|错误率|召回率|精确率|WER|CER|EER|UAR|accuracy|precision|recall|均方根误差|平均绝对误差|RMSE|MAE|SNR|SI-SDR|延迟|latency)'
    number = r'[-+]?\d+(?:\.\d+)?'
    interval = rf'({number})\s*(%|％|dB|ms|s)\s*[–—~～至到-]\s*({number})\s*(%|％|dB|ms|s)'
    measured = rf'([^，,。；;]{{1,80}}?)的({metric})(?:大约为|大约|约为|约|为|是)\s*{interval}'
    match = re.search(r'(?:^|[，,])\s*' + measured + r'[，,]\s*' + measured + r'[，,]\s*(前者|后者)(更高|更低)\s*$', surface, re.IGNORECASE)
    if not match:
        return False
    first, metric_a, a0, ua0, a1, ua1, second, metric_b, b0, ub0, b1, ub1, referent, direction = match.groups()
    named_object = re.compile(r'拟合|模型|系统|方法|基线|对照|条件|分支|编码器|提示|微调|算法|网络')
    if first.strip() == second.strip() or not named_object.search(first) or not named_object.search(second) or metric_pattern.search(first) or metric_pattern.search(second):
        return False
    aliases = {'词错率':'wer','词错误率':'wer','字错率':'cer','准确率':'accuracy','正确率':'accuracy','召回率':'recall','精确率':'precision','均方根误差':'rmse','平均绝对误差':'mae','延迟':'latency'}
    key = aliases.get(metric_a, metric_a.lower())
    unit = ua0.replace('％', '%')
    if key != aliases.get(metric_b, metric_b.lower()) or any(value.replace('％', '%') != unit for value in (ua1, ub0, ub1)):
        return False
    if (key in ('wer','cer','eer','uar','accuracy','precision','recall','错误率') and unit != '%') or (key in ('snr','si-sdr') and unit != 'dB') or (key == 'latency' and unit not in ('s','ms')):
        return False
    values = [float(value) for value in (a0, a1, b0, b1)]
    if any(not math.isfinite(value) or value < 0 or (unit == '%' and value > 100) for value in values) or values[0] >= values[1] or values[2] >= values[3]:
        return False
    left_min, left_max, right_min, right_max = values if referent == '前者' else [values[2], values[3], values[0], values[1]]
    return left_max < right_min if direction == '更低' else left_min > right_max


_EXECUTIVE_ABSTRACT_BOLD_LEAD_RE = re.compile(
    r'^\s*(?:\*\*[^*\n]{2,36}[：:]\*\*[ \t]*|\*\*[^*\n]{2,36}\*\*[ \t]*[：:][ \t]*)'
)


def _strip_executive_abstract_bold_lead_ins(raw_summary):
    paragraphs = re.split(r'\r?\n[ \t]*\r?\n', str(raw_summary or ''))
    return '\n\n'.join(
        _EXECUTIVE_ABSTRACT_BOLD_LEAD_RE.sub('', p.strip()).strip()
        for p in paragraphs if p.strip()
    )


def _validate_executive_abstract_surface_structure(raw_summary):
    raw = str(raw_summary or '')
    issues = []
    if re.search(r'^\s*#{1,6}\s', raw, flags=re.MULTILINE):
        issues.append('核心摘要内禁止使用 # 等 Markdown 标题，请改用段首粗体引导词')
    if re.search(r'^\s*\d+\.\s*\*\*[^*\n]+\*\*\s*$', raw, flags=re.MULTILINE):
        issues.append('核心摘要内禁止使用独立编号标题行（如 1. **...**），请直接以粗体引导词开启自然段')
    if re.search(r'^\s*(?:---+|\*\*\*+|___+)\s*$', raw, flags=re.MULTILINE):
        issues.append('核心摘要内禁止使用水平分隔线')
    trimmed = raw.strip()
    if re.search(r'\r?\n(?:[ \t]*\r?\n){2,}', trimmed):
        issues.append('核心摘要自然段之间只能保留一个空行（\\n\\n）')
    paragraphs = [p.strip() for p in re.split(r'\r?\n[ \t]*\r?\n', trimmed) if p.strip()] if trimmed else []
    if len(paragraphs) < 3 or len(paragraphs) > 4:
        issues.append(f'自然段数必须为 3–4 段（以空行分隔），当前 {len(paragraphs)} 段')
    else:
        if any(re.search(r'\r?\n', p) for p in paragraphs):
            issues.append('核心摘要每个自然段须写成连贯散文段落，段间以空行分隔，段内不拆行或列点')
        if not all(_EXECUTIVE_ABSTRACT_BOLD_LEAD_RE.search(p) for p in paragraphs):
            issues.append('核心摘要每个自然段须以粗体引导词开头（如 **问题与瓶颈：**）')
    return issues


def _has_executive_method_architecture(content_body):
    component_re = re.compile(
        r'(?:编码器|解码器|声码器|分词器|量化器|转换器|变换器|Transformer|Conformer|Mamba|UNet|'
        r'扩散|流匹配|注意力|网络|主干|骨干|适配器|投影层|投影头|模块|分支|前端|后端|分类头|回归头|'
        r'预测头|判别器|生成器|检索器|规划器|求解器|滤波器|估计器|识别器|合成器|谱均衡|引擎|探针|矩阵|子空间|表征|特征|嵌入|'
        r'隐状态|隐变量|码本|令牌|token|掩码|掩膜|损失|目标函数|正则|采样器|蒸馏|'
        r'知识图谱|大模型|智能体|工具链|后台工具|对话系统|管线|流水线)',
        re.IGNORECASE,
    )
    action_re = re.compile(
        r'(?:输入|接收|提取|编码|映射|投影|压缩|量化|池化|聚合|融合|拼接|注入|调制|对齐|检索|筛选|'
        r'路由|分解|预测|估计|重构|重建|解码|合成|生成|输出|优化|更新|训练|微调|冻结|约束|抑制|消除|解耦|'
        r'提炼|写入|记录|组装|重写)'
    )
    denied_re = re.compile(
        r'(?:假设|假想|假定|设想|如果|预计|预期|可能|未来实验|计划采用|第三方|他人研究|先前工作|相关工作|'
        r'现有(?:主流|方法|方案|路线|编解码器|模型|系统|工作)|传统(?:方法|方案|路线|指标|编解码器|模型|系统|工作)|'
        r'以往(?:方法|方案|路线|模型|工作|研究)|主流(?:方法|方案|路线|编解码器|模型)|任务需要将|任务以[^。]{1,48}为输入)'
    )
    for paragraph in re.split(r'\n\s*\n', str(content_body or '')):
        sentences = [s.strip() for s in re.split(r'[。！？!?\n]', paragraph) if s.strip()]
        valid = [s for s in sentences if len(s) <= 520 and not denied_re.search(s)]
        if not valid:
            continue
        joined = '。'.join(valid)
        components = {m.group(0).lower() for m in component_re.finditer(joined)}
        actions = list(action_re.finditer(joined))
        if len(components) >= 2 and len(actions) >= 3:
            return True
    return False


def _validate_core_summary_source_grounded_claims(summary, source_text):
    src_raw = str(source_text or '').strip()
    if not src_raw:
        return None

    def _normalize_thousands(text):
        current = str(text or '')
        prev = None
        while current != prev:
            prev = current
            current = re.sub(r'(?<=\d)\{,\}(?=\d{3}(?![0-9]))', '', current)
            current = re.sub(r'(?<=\d),(?=\d{3}(?![0-9]))', '', current)
        return current

    def _build_surfaces(base_text):
        normalized = _normalize_thousands(base_text)
        tex_merged = re.sub(r'\\!', '', normalized)
        tex_merged = re.sub(r'\\pm\s*', '±', tex_merged)
        tex_merged = re.sub(r'\\times\s*', '×', tex_merged)
        deduped = re.sub(
            r'(?<![0-9])(?<!\d\.)((?:\d{1,16}\.\d{1,16}|\.\d{1,16}|\d{1,16})(?:[±×/+-](?:\d{1,16}\.\d{1,16}|\.\d{1,16}|\d{1,16})){0,4})\1(?![0-9]|\.\d)',
            r'\1', tex_merged,
        )
        sandwich_split = re.sub(
            r'([±+-]|(?<![0-9]))(\.\d{1,16}|\d{1,16}\.\d{1,16}|\d{1,16})(\d{1,16}\.\d{1,16}|\.\d{1,16}|\d{1,16})(?:\\!|\s)*(?:\\pm|±)(?:\\!|\s)*\2(?![0-9]|\.\d)',
            r'\1\2 \3 ± \2', normalized,
        )
        tex_spaced = re.sub(r'\\[,;!:]', ' ', normalized)
        tex_spaced = re.sub(r'\\[A-Za-z]+', ' ', tex_spaced)
        tex_spaced = re.sub(r'[{}]', ' ', tex_spaced)
        return (normalized, deduped, sandwich_split, tex_spaced)

    exact_tokens = set()
    percent_tokens = set()
    non_percent_tokens = set()
    non_citation_tokens = set()
    token_re = re.compile(r'(?<![A-Za-z0-9])(?<![A-Za-z0-9]\.)([+-]?(?:\d+\.\d+|\.\d+|\d+))(\s*(?:%|\\%))?(?![0-9]|\.\d)')
    pct_range_re = re.compile(
        r'(?<![A-Za-z0-9])(?<![A-Za-z0-9]\.)([+-]?(?:\d+\.\d+|\.\d+|\d+))\s*(?:to|and|or|[–—-])\s*[+-]?(?:\d+\.\d+|\.\d+|\d+)\s*\\?%(?![0-9]|\.\d)',
        re.IGNORECASE,
    )
    for surface in _build_surfaces(src_raw):
        for match in token_re.finditer(surface):
            unsigned = re.sub(r'^[+-]', '', match.group(1))
            norm = f'0{unsigned}' if unsigned.startswith('.') else unsigned
            exact_tokens.add(norm)
            exact_tokens.add(unsigned)
            if match.group(2):
                percent_tokens.add(norm)
            else:
                non_percent_tokens.add(norm)
        for match in pct_range_re.finditer(surface):
            unsigned = re.sub(r'^[+-]', '', match.group(1))
            percent_tokens.add(f'0{unsigned}' if unsigned.startswith('.') else unsigned)
    citation_stripped = re.sub(r'\[\s*\d+(?:\s*[,;–—-]\s*\d+)*\s*\]', ' ', src_raw)
    for surface in _build_surfaces(citation_stripped):
        for match in token_re.finditer(surface):
            unsigned = re.sub(r'^[+-]', '', match.group(1))
            norm = f'0{unsigned}' if unsigned.startswith('.') else unsigned
            non_citation_tokens.add(norm)
            non_citation_tokens.add(unsigned)
    normalized_src = _normalize_thousands(src_raw)
    percent_table_context_re = re.compile(
        r'(?:\(\s*\\?%[^)\n]{0,16}\)|\[\s*\\?%\s*\]|/\s*\\?%(?![0-9A-Za-z])|'
        r'(?<![A-Za-z0-9_])in\s+\\?%(?![A-Za-z0-9_])|'
        r'(?<![A-Za-z0-9_])(?:in|as)\s+percent(?:age|ages)?(?![A-Za-z0-9_])|'
        r'(?<![A-Za-z0-9_])(?:WER|CER|EER|UAR|DER|PER|ACC|Accuracy|Precision|Recall|F1)\s*\\?%(?![0-9]))',
        re.IGNORECASE,
    )
    paired_rate_table_header_re = re.compile(
        r'(?<![A-Za-z0-9_])(?:WER|CER|PER|EER)\s*\/\s*(?:WER|CER|PER|EER)(?![A-Za-z0-9_])',
        re.IGNORECASE,
    )
    source_has_percent_table_context = bool(percent_table_context_re.search(normalized_src)) or (
        bool(percent_tokens) and bool(paired_rate_table_header_re.search(normalized_src))
    )
    p_value_re = re.compile(
        r'(?<![A-Za-z0-9_])(?:p(?:-?values?)?|q(?:-?values?)?|α|alpha)\s*'
        r'(?:<=|>=|<|>|=|≤|≥|(?:\\leq|\\le|\\geq|\\ge|\\ll|\\lt|\\gt)(?![A-Za-z]))\s*0?\.\d+',
        re.IGNORECASE,
    )

    def _strip_p_values(text):
        current = str(text or '')
        for _ in range(4):
            nxt = p_value_re.sub(' ', current)
            if nxt == current:
                break
            current = nxt
        return current

    p_value_stripped_src = _strip_p_values(citation_stripped)
    unit_decimal_tokens = set()
    for surface in _build_surfaces(p_value_stripped_src):
        for match in token_re.finditer(_strip_p_values(surface)):
            if match.group(2):
                continue
            unsigned = re.sub(r'^[+-]', '', match.group(1))
            norm = f'0{unsigned}' if unsigned.startswith('.') else unsigned
            if re.fullmatch(r'0\.\d{2}', norm):
                unit_decimal_tokens.add(norm)
    non_percent_unit_after_re = re.compile(
        r'^\s*(?:epochs?|layers?|steps?|speakers?|samples?|hours?|hrs?|minutes?|mins?|seconds?|secs?|'
        r'ms|Hz|kHz|MHz|GHz|dB|GiB|GB|MB|KB|TB|params?|parameters?|blocks?|heads?|dims?|dimensions?|'
        r'channels?|frames?|tokens?|utterances?|files?|clips?|sentences?|words?|classes?|models?|'
        r'datasets?|runs?|seeds?|folds?|GPUs?|CPUs?)(?![A-Za-z0-9_])',
        re.IGNORECASE,
    )
    non_percent_prefix_before_re = re.compile(
        r'(?:(?<![A-Za-z0-9_])(?:batch[\s_-]*size|bsz|mini-?batch|top|table|tab\.?|fig(?:ure)?\.?|'
        r'sec(?:tion)?\.?|eq(?:uation)?\.?|alg(?:orithm)?\.?|appendix|step|layer|epoch|seed|fold|'
        r'beam|head|dim(?:ension)?|channel|block|stage|rank|order|num(?:ber)?(?:\s+of)?|size|length|'
        r'width|height|depth|stride|kernel|window)\s*[-:=]?\s*|(?<![A-Za-z0-9_])(?:k|n|m|d|r|b)\s*[-:=]\s*|#)\s*$',
        re.IGNORECASE,
    )
    percent_table_nearby_tokens = set()
    if source_has_percent_table_context:
        normalized_citation_stripped_src = _normalize_thousands(citation_stripped)
        for ctx_match in percent_table_context_re.finditer(normalized_citation_stripped_src):
            win_start = max(0, ctx_match.start() - 1500)
            win_end = min(len(normalized_citation_stripped_src), ctx_match.start() + 2500)
            window_text = normalized_citation_stripped_src[win_start:win_end]
            for m in token_re.finditer(window_text):
                unsigned = re.sub(r'^[+-]', '', m.group(1))
                if not re.fullmatch(r'\d{1,2}', unsigned):
                    continue
                before = window_text[max(0, m.start() - 28):m.start()]
                if non_percent_prefix_before_re.search(before):
                    continue
                after = window_text[m.end():]
                if non_percent_unit_after_re.search(after):
                    continue
                percent_table_nearby_tokens.add(unsigned)
    cleaned = _normalize_thousands(str(summary or ''))
    cleaned = re.sub(r'https?://\S+', ' ', cleaned)
    cleaned = re.sub(
        r'(?<![A-Za-z0-9_])(?:Qwen|Llama|Gemma|Phi|GPT|Claude|Mistral|Whisper|HuBERT|WavLM|Wan|LTX|Python|PyTorch|CUDA|IEEE|P|v|ver|version)\s*[-_.]?\d+(?:\.\d+)*(?:\s*[-_.]?\d+(?:\.\d+)*\s*[BbMmKk](?![A-Za-z0-9_]))?',
        ' ', cleaned, flags=re.IGNORECASE,
    )
    cleaned = re.sub(r'(?<![A-Za-z0-9_])[A-Za-z][A-Za-z0-9_-]*[-_.]\d+(?:\.\d+)*[A-Za-z0-9_.-]*', ' ', cleaned)
    cleaned = re.sub(r'(?:§|第|图|表|式|公式|章节|附录)\s*\d+(?:\.\d+)*', ' ', cleaned)
    for match in re.finditer(
        r'(?<![A-Za-z0-9._])(?<!(?<![0-9A-Za-z])[+-])([+-]?(?:\d+\.\d+|\d+))(\s*(?:%|％))?(?=\s*(?:dB|ms|s|Hz|kHz|MHz|GHz|kbps|bps|fps|GiB|GB|MB|KB|TB|B|M|K|G|倍|点|分)?(?![A-Za-z0-9]|\.\d))',
        cleaned,
        re.IGNORECASE,
    ):
        full = match.group(0).strip()
        num = re.sub(r'^[+-]', '', match.group(1))
        has_pct = bool(match.group(2))
        has_unit_after = bool(re.match(r'^\s*(?:dB|ms|Hz|kHz|MHz|GHz|kbps|bps|fps|GiB|GB|MB|KB|TB)(?![A-Za-z])', cleaned[match.end():], re.IGNORECASE))
        is_decimal = '.' in num
        if not is_decimal and not has_pct and not has_unit_after:
            continue
        if num not in exact_tokens:
            return f'核心摘要数值“{full}”未在原文中以相同精度出现（禁止编造、四舍五入或转换小数与百分数）'
        if has_pct and num not in percent_tokens:
            scaled_from_unit_decimal = (
                bool(re.fullmatch(r'\d{1,2}', num))
                and f'0.{num.zfill(2)}' in unit_decimal_tokens
                and num not in percent_table_nearby_tokens
            )
            if not source_has_percent_table_context or num not in non_citation_tokens or scaled_from_unit_decimal:
                return f'核心摘要数值“{full}”添加了原文不存在的百分号'
        if not has_pct and is_decimal and num in percent_tokens and num not in non_percent_tokens:
            return f'核心摘要数值“{full}”遗漏了原文的百分号'
    return None


def _detailed_core_summary_semantic_issue(summary, *, summary_header=None, source_text=None):
    raw_summary = str(summary or '')
    use_executive = (
        False if summary_header is None
        else (_H.get('core_summary_formats') or __import__('core_summary_format')).is_executive_abstract_header(summary_header)
    )
    summary = _core_summary_sentence_view(raw_summary)
    content_body = _core_summary_sentence_view(_strip_executive_abstract_bold_lead_ins(raw_summary)) if use_executive else summary
    count = len(re.findall(r'[\u4e00-\u9fa5\u3000-\u303f\uff00-\uffef]', summary))
    sentences = len(re.findall(r'[。！？!?]', summary))
    min_chars, max_chars = (700, 1400) if use_executive else (320, 600)
    min_sentences, max_sentences = (10, 26) if use_executive else (6, 12)
    max_method_sentence_chars = 520 if use_executive else 320
    issues = []
    if count < min_chars or count > max_chars:
        issues.append(f'中文字符必须为 {min_chars}–{max_chars}，当前 {count}')
    if sentences < min_sentences or sentences > max_sentences:
        issues.append(f'句数必须为 {min_sentences}–{max_sentences}，当前 {sentences}')
    if use_executive:
        issues.extend(_validate_executive_abstract_surface_structure(raw_summary))
        for sentence in re.split(r'[。！？!?\n]', content_body):
            trimmed_sentence = sentence.strip()
            if len(trimmed_sentence) > 520 and re.search(
                r'(?:编码器|解码器|声码器|分词器|量化器|Transformer|Conformer|注意力|网络|主干|模块|分支|前端|后端|表征|特征|嵌入|令牌|token)',
                trimmed_sentence, re.IGNORECASE,
            ):
                issues.append(f'方法机制单句过长（{len(trimmed_sentence)}/520），请按信号流拆分为多句自然表达')
                break
    # 与 Node 规则一致：具体用途本身也能说明目的，不要求固定写“任务”或“输入输出”。
    purpose_pattern = (
        r'(?:用于|用来|用以)(?:从[^。！？!?.;；,，\n]{1,24}中)?'
        r'(?:筛查|诊断|检测|识别|转写|翻译|分离|定位|合成|预测|估计)'
        r"(?![的了地得吧呢而但并或不未没非])(?:[“‘\"'「『])?[A-Za-z0-9\u4e00-\u9fff]{2,48}"
    )
    # 只检查同一分句；明确否定的说法和单字对象不能替代具体目的。
    concrete_purpose = any(
        re.search(purpose_pattern, clause)
        and not re.search(
            r'(?:并非|并未|不是|不再|不会|不能|不曾|未曾|并不|没有|未被|不成立|不正确|不存在|不属于|不适用)',
            clause,
        )
        and not re.search(
            r'(?:不|未)(?:被|直接|主要|实际|真正|仅|只|也|还|曾|能|会|再|尚)*\s*(?:用于|用来|用以)',
            clause,
        )
        for clause in re.split(r'[。！？!?.;；,，\n]|而(?:不是|是)|但(?=不能替代)', content_body)
    )
    problem_pattern = (
        r'(?:问题|难点|瓶颈|症结|失效|缺陷|受限|局限|挑战|任务|目标|输入|输出|旨在|针对|解决|误选|错分|偏差|风险)'
        if use_executive else r'(?:问题|难点|任务|目标|输入|输出|旨在|针对|解决)'
    )
    if not re.search(problem_pattern, content_body) and not concrete_purpose:
        issues.append('缺少任务问题、输入输出或实际难点')
    chain = re.findall(r'(?:第一|第二|第三|第四|首先|其次|然后|随后|接着|最后|先|再|阶段|步骤|模块|组件)', content_body)
    roles = re.findall(r'(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|计算|平滑|展平|丢弃)', content_body)
    tier_role_stages = {
        match.group(1).upper()
        for match in re.finditer(
            r'(?<![A-Za-z0-9_])Tier[-‐‑‒–—]([LMH])(?![A-Za-z0-9_])'
            r'[^；。！？!?\n]{0,120}'
            r'(?:负责|用于|承担|提取|编码|定位|筛选|生成|融合|对比|优化|校准|解码|预测|输出|构建|约束|传递|送入|打分|匹配|投票|检索|推理|判决|路由)',
            content_body, flags=re.IGNORECASE,
        )
    }
    has_numbered_method_chain = (
        (len(chain) >= 2 or re.search(r'分(?:\d+|[一二三四五六七八九十]+)步', content_body))
        and len(roles) >= 2
    )
    if (not has_numbered_method_chain
            and len(tier_role_stages) < 2
            and not _has_explicit_natural_product_chain(content_body, max_method_sentence_chars)
            and not _has_symbolic_geometry_method_chain(content_body)
            and not (use_executive and _has_executive_method_architecture(content_body))):
        issues.append('缺少 2–4 步方法链的分工与衔接')
    # 这份白名单要和 scripts/analysis-contract.js 保持同步。
    # 发布器在 Node 分析阶段之后按同一份 v3/v4 正文规则再次检查，
    # 所以上游已经接受的指标，不能仅仅因为它用了
    # 更新的别名（例如 PPL、CA-SDRi 或压缩率）就在这里被拒。
    import os as _os
    import sys as _sys
    _scripts_dir = _os.path.dirname(_os.path.abspath(__file__)) if '__file__' in globals() else _os.path.join(_os.getcwd(), 'scripts')
    if _scripts_dir not in _sys.path:
        _sys.path.insert(0, _scripts_dir)
    from publish_common import (
        _has_adjacent_affirmative_evidence_withdrawal,
        _own_observed_source_scope,
    )
    ascii_model_words = r'(?:model|method|system|baseline|network)(?![A-Za-z0-9_])'
    metric = re.compile(
        rf'(?:(?<![A-Za-z0-9_])(?:(?:cp|tcp)?WER|SWER|AER|CER|PER|DER|JER|F1|F[- ]?Scores?|BLEU|COMET|ROUGE|MOS(?:[- ]?[PT])?|CCC(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|{ascii_model_words}))|PCC|FAD(?:CLAP|Vggish)|CQT1-PCC|LPAPS|CDPAM|PESQ|STOI|SI-SDR|CA-SDRi|SDRi|SNRi|SDR|SNR|EER|UAR|PPL|NLL|negative[ -]log[ -]likelihood|false[ -]acceptance[ -]rate|unsafe[ -]response[ -]rate|safety[ -]understanding[ -]rate|deepfake[ ]+FAR|TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S|ILD[- ]W|ASR|mAP|gAP|AUROC|AUC|GMR|GMC|ECE|mIoU|IoU|J&F|MJ|MF|Jaccard|LangRank|Exact Match|Pearson|Spearman|Kendall|PSNR|SSIM|MSE|MAE|RMSE|FGD|BeatAlign|Diversity|R1@(?:0(?:\.\d+)?|1(?:\.0+)?)(?![.\d@])|R@\d+(?:\.\d+)?|SAR|DAR|PISR|RtA|NBS|OIC|PAR|Fair[ -]?Rate|BMSR|JSR|RSF|OH|n?TVD|SpkSim|LPS|SBS|UTMOS|PLCMOS|precision|recall|MSR|FVD|FID|Acc(?:[_ -]?(?:macro|num))?|CLAP(?:[_ -](?:MS|LAION))?|VISQOL|MCD|SPK[_ -]?SIM|Mel(?:[ -]Dist(?:ance)?)?|STFT(?:[ -]Dist(?:ance)?)?|DeSync|MotionQ|IB|accuracy|error rate|success rate|win rate|compression[ -](?:ratio|rate)|real[ -]time factor|scores?|latency|throughput|RTF|FPS|performance|metrics?)(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])E2E(?=[ ]*(?:比例|命中率|成功率))|(?:皮尔逊(?:积矩)?相关系数|斯皮尔曼(?:秩)?相关系数|肯德尔(?:秩相关|和谐|协调|一致性)系数)(?!\s*(?:的)?(?:模型|方法|基线|算法|网络))|一致性相关系数(?![ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|{ascii_model_words}))|字错率|评估损失(?:终值)?(?=[^。；\n]{{0,90}}(?:[二两三四五六七八九十百1-9][0-9]*(?:\.\d+)?倍|(?:为|是|从)\s*\d+(?:\.\d+)?))|不安全回答率|安全理解率|伪造假接受率|耳间强度差(?:Wasserstein)?距离|平均绝对误差|端到端命中率|有用性偏好率|均方根误差|词(?:字)?错率|困惑度|负对数似然|攻击成功率|准确率|正确率|错误率|误差率|期望校准误差|召回率|精确率|总体分|总分|得分|分数|胜率|成功率|延迟|吞吐|实时率|对数谱失真|两耳声级差误差|正确拒绝率|真负率|真阳性率|检出率|(?:人类|人工)(?:语义)?评分|主观评分|客观评分|相似度|相似分数|性能|指标)',
        re.IGNORECASE | re.ASCII,
    )
    additional_metric_name = r'(?:DAP|DLP|AMLt|F-measure|F-Measure|Fmeasure|Fmeter|MV2H[45]|OMR-NED|R(?:²|\^2)(?:_[VA])?|MSS|决定系数(?:[ \t]*R(?:²|\^2)(?:_[VA])?)?|(?:目标字|字符|音节|音素|单词)时长(?:均值|平均值)|自然度平均意见分)'
    model_suffix_pattern = rf'(?:模型|方法|系统|基线(?![ \t]*[-+]?[0-9])|算法|网络|{ascii_model_words})'
    additional_metric = re.compile(
        rf'(?<![A-Za-z0-9_]){additional_metric_name}(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?{model_suffix_pattern})',
        re.IGNORECASE | re.ASCII,
    )
    additional_mention_re = re.compile(
        rf'(?<![A-Za-z0-9_]){additional_metric_name}(?![A-Za-z0-9_.-])(?:[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?({model_suffix_pattern}))?(?:[ \t]*(?:指标|分数|得分))?',
        re.IGNORECASE | re.ASCII,
    )
    additional_denied_re = re.compile(
        r'\b(?:if|suppose|assuming|hypothetical|(?:future|planned|proposed)\s+experiments?|not\s+(?:observed|reported)|(?:previous|prior|related|other)\s+(?:work|stud(?:y|ies)|research)|third[- ]party|quoted|retracted)\b|'
        r'(?:假设|假想|假定|设想|如果|若(?:在|用|以)|可能|预计|预期|(?:未来|后续)(?:计划|实验|评测|测量)|计划(?:比较|评估|测量|报告)|讨论|提及|引用|引述|转述|他人|第三方|其他研究|先前(?:工作|研究)|旧(?:工作|研究)|既有(?:工作|研究)|相关(?:工作|研究)|并非|并未|不是|没有|不能|尚未|否认|撤回|不成立|未报告|未观察)',
        re.IGNORECASE | re.ASCII,
    )
    ccc_denied_re = re.compile(
        r'\b(?:if|suppose|assuming|hypothetical|(?:future|planned|proposed)\s+experiments?|not\s+(?:observed|reported)|third[- ]party|quoted|retracted)\b|'
        r'(?:假设|假想|假定|设想|如果|若(?:在|用|以)|可能|预计|预期|(?:未来|后续)(?:计划|实验|评测|测量)|计划(?:比较|评估|测量|报告)|讨论|提及|引用|引述|转述|他人|第三方|其他研究|先前研究|相关工作|并非|并未|不是|没有|不能|尚未|否认|撤回|不成立|未报告|未观察|(?:未|没有|不)(?:能|曾|实际|真正)?(?:测量|报告|观察到|观察|检验|比较))',
        re.IGNORECASE | re.ASCII,
    )
    vertex_gesture_denied_re = re.compile(
        r'(?:假设|假想|如果|预计|预期|可能|计划|未来|引用|引述|转述|他人|第三方|其他研究|先前研究|相关工作|并非|并未|不是|没有|尚未|未报告|否认|撤回|不成立|错误说法)|'
        r'\b(?:hypothetical|assuming|if|planned|quoted|third[- ]party|not reported)\b',
        re.IGNORECASE | re.ASCII,
    )
    conference_metric = re.compile(
        r'包络相关(?:性)?|抖动|计数偏差|总误差|频率误差|衰减误差|增益误差|相对误差|平均误差|压缩率|谐波失真|频谱对比度损失|起音时间(?:对数)?偏差|(?:对数似然比代价(?:[ \t]*[Cc][Ll][Ll][Rr](?![A-Za-z0-9_])|(?![ \t-]*[Cc][Ll][Ll][Rr]))|声对比度|声压级)(?=[ \t]*(?:指标|分数|得分)?(?:为|是|从|升至|降至)[ \t]*[-+]?[0-9]+(?:\.[0-9]+)?(?![A-Za-z0-9_.]))'
    )
    vertex_gesture_metric = re.compile(
        rf'(?<![A-Za-z0-9_])(?:LVE|MVE|Lip[ -]+Vertex[ -]+Error|Mean[ -]+Vertex[ -]+Error|Fr[eé]chet[ -]+Gesture[ -]+Distance|Beat[ -]+Consistency)(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作|这个|这一|那个|这种|一种|一个|该)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|{ascii_model_words}))|(?:平均)?(?:唇顶点误差|全脸顶点误差)(?![ \t]*(?:的|这个|这一|那个|这种|一种|一个|该)?(?:模型|方法|系统|基线|算法|网络))',
        re.IGNORECASE | re.ASCII,
    )
    dnsmos_metric = re.compile(
        rf'(?<![A-Za-z0-9_.-])DNSMOS(?:[ \t]+P\.835)?[ \t]+(?:SIG|BAK|OVL)(?:\/(?:SIG|BAK|OVL))*(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?(?:模型|方法|系统|基线|算法|网络|{ascii_model_words}))',
        re.IGNORECASE | re.ASCII,
    )
    dnsmos_strip_re = re.compile(
        r'(?<![A-Za-z0-9_.-])DNSMOS(?:[ \t]+P\.835)?(?:[ \t]+(?:SIG|BAK|OVL)(?:\/(?:SIG|BAK|OVL))*)?(?![A-Za-z0-9_.-])(?:[ \t]*(?:指标|分数|得分))?',
        re.IGNORECASE | re.ASCII,
    )
    dnsmos_denied = re.compile(
        r'假设|假想|假定|设想|如果|若(?:在|用|以)|可能|预计|预期|计划|未来实验|后续实验|建议|讨论|提及|引用|引述|转述|他人|第三方|外部团队|其他研究|先前(?:工作|研究)|相关(?:工作|研究)|并非|并未|不是|没有|不能|尚未|否认|否定|撤回|不成立|不正确|错误|有误|未报告|未观察|\b(?:if|suppose|assuming|hypothetical|planned|quoted|retracted|withdrawn|third[- ]party|external team|(?:previous|prior|related|other)\s+(?:work|stud(?:y|ies)|research)|not\s+(?:observed|reported|used))\b',
        re.IGNORECASE | re.ASCII,
    )
    dnsmos_withdrawal_subject = r'(?:上述|以上|前述|该|此|这一)(?:DNSMOS)?(?:指标|测量|评测|结果|结论|边界|说法|表述)'

    def _has_affirmative_dnsmos_statement(raw_text, pattern, preceding='', following=''):
        raw = str(raw_text or '')
        parts = re.split(r'[。！？!?\n]', raw)
        offset = 0
        for part in parts:
            start = offset
            offset += len(part) + 1
            prior_parts = re.split(r'[。！？!?\n]', raw[:start].rstrip())
            previous = prior_parts[-1] if prior_parts and prior_parts[-1] else preceding
            heading = (
                previous
                if (re.search(r'[:：]$|^\s*(?:#{1,6}\s|\*\*|__)', previous)
                    or (len(previous) <= 100 and dnsmos_denied.search(previous)))
                else ''
            )
            if (pattern.search(part)
                    and not dnsmos_denied.search(heading + part)
                    and _own_observed_source_scope(heading + part)
                    and not _has_adjacent_affirmative_evidence_withdrawal(
                        raw + '。' + following, start + len(part), dnsmos_withdrawal_subject)):
                return True
        return False

    source_defined_dnsmos = any(
        re.search(r'\bwe use the reference-free DNSMOS P\.835 \(SIG/BAK/OVL\)', line, re.IGNORECASE | re.ASCII)
        and not dnsmos_denied.search(((lines[idx - 1] if idx > 0 else '') + '\n' + line))
        and _own_observed_source_scope(line)
        and not re.search(r'\b(?:withdrawn|revoked|false statement|not used)\b|撤回|不成立|有误', lines[idx + 1] if idx + 1 < len(lines) else '', re.IGNORECASE | re.ASCII)
        for lines in [str(source_text or '').splitlines()]
        for idx, line in enumerate(lines)
    )

    def _has_statistical_result(sentence):
        stat_metric = r'(?<![A-Za-z0-9_])(?:rate|odds|risk)\s+ratio(?![A-Za-z0-9_])|率比|几率比|比值比|优势比|风险比'
        if not re.search(stat_metric, sentence, re.IGNORECASE | re.ASCII) or re.search(
            r'\b(?:prior|hyperparameters?|hypothetical|illustrative|formula|defined?|assum(?:e|ed)|previous\s+stud(?:y|ies)|cited|references?)\b|先验|超参数|假设值|示意|公式|定义|文献引用|既有研究',
            sentence, re.IGNORECASE | re.ASCII,
        ):
            return False
        return bool(
            re.search(rf'(?:{stat_metric})\s*(?:\((?:IRR|RR|OR)\)\s*)?(?:of|=|:|为|是)?\s*[-+]?\d+(?:\.\d+)?', sentence, re.IGNORECASE | re.ASCII)
            and re.search(r'(?:(?<![A-Za-z0-9_])(?:confidence\s+interval|CI)(?![A-Za-z0-9_])|置信区间)[^。！？!?\n]{0,20}\d+(?:\.\d+)?\s*(?:[-–—至]|(?<![A-Za-z0-9_])to(?![A-Za-z0-9_]))\s*\d+(?:\.\d+)?', sentence, re.IGNORECASE | re.ASCII)
            and re.search(r'\b(?:adjusted|estimated|observed|reported|interaction|association)\b|调整后|经[^。！？!?\n]{0,20}调整|估计|观测|实测|交互项|组别效应', sentence, re.IGNORECASE | re.ASCII)
        )

    def _has_source_bound_hit_count_metric(sentence):
        if not re.search(r'(?:按|以|用)[^，,。；]{0,24}?命中(?:地点|位置|片段|录音|包|时刻|窗口|流|单元)(?:数|比例|率)?', sentence):
            return False
        if re.search(r'(?:假设|假想|假定|设想|如果|若在|预计|预期|可能|计划|未来|讨论|提及|并非|不是|没有|未|不能|他人|第三方|先前(?:研究|工作)|相关工作|引用|引述|转述)', sentence):
            return False
        src = str(source_text or '')
        return bool(
            re.search(r'\b(?:hit|hits|place[sd]?|clips?|packets?)\b[^.\n]{0,100}\bwithin\s+[0-9]+(?:\.[0-9]+)?\s*(?:km|m)\b', src, re.IGNORECASE | re.ASCII)
            or re.search(r'\bwithin\s+[0-9]+(?:\.[0-9]+)?\s*(?:km|m)\b[^.\n]{0,100}\b(?:hit|hits|place[sd]?)\b', src, re.IGNORECASE | re.ASCII)
        )
    comparison = re.compile(
        r'(?:from\b[^。！？!?]{0,50}\bto\b|improv(?:e|es|ed|ement)|outperform(?:s|ed)?|reduc(?:e|es|ed|tion)|increase[sd]?|decrease[sd]?|degrad(?:e|es|ed|ation)|on par|comparable|(?:由|从)[^。！？!?]{0,40}(?:升至|升到|降至|降到|提升至|提高到)|相比|相较|优于|超过|反超|低于|高于|提升|提高|改善|改进|降低|下降|减少|达到|增至|减至|领先|持平|相当|接近)',
        re.IGNORECASE | re.ASCII,
    )
    baseline_transition = re.compile(
        r'(?:基线|对照|原方法|已有方法|先前方法)'
        r'[^。！？!?\n]{0,40}(?:为|达到)\s*[-+]?\d+(?:\.\d+)?'
        r'[^。！？!?\n]{0,50}(?:升至|降至)\s*[-+]?\d',
    )
    number = re.compile(r'(?<![A-Za-z0-9])[-+]?\d+(?:\.\d+)?(?:\s*(?:%|％|dB|ms|s|秒|分钟|小时|倍|点|分))?(?![A-Za-z0-9])')
    # 处理紧挨中文的英文设置项标签时，要和 JavaScript 一致：
    # Python 把汉字当作 `\w`，而 JS 的 `\b` 不这么认为。
    setting = re.compile(r'(?:数据集|测试集|验证集|基准|评测|评价|协议|设置|条件|场景|任务|语料|套件|主干|对照|数据点|样本点|观测(?:点|值)|同一|相同|公开|内部|外部|语言|口音|性别|选项顺序|码切换|单语|多语|语言对|组合|(?<![A-Za-z0-9_])(?:on|test|benchmark|evaluation)(?![A-Za-z0-9_]))', re.IGNORECASE | re.ASCII)
    named_setting = re.compile(
        r'(?:[A-Z][A-Za-z0-9._-]{2,}\s*[\u3400-\u9fff]{0,8}(?:集|数据集|语料|任务|基准)'
        r'|(?:在|于)\s*[A-Z][A-Za-z0-9._-]{2,}(?:\s*[上中下])'
        r'|(?<![A-Za-z0-9_])[1-9][0-9]*[A-Za-z][A-Za-z0-9._-]{0,39}-(?:Bench|Benchmark)(?![A-Za-z0-9_])(?:上|中|下))',
        re.IGNORECASE | re.ASCII,
    )
    numeric_named_setting = re.compile(r'(?<![A-Za-z0-9_])[1-9][0-9]*[A-Za-z][A-Za-z0-9._-]{0,39}-(?:Bench|Benchmark)(?![A-Za-z0-9_])(?:上|中|下)', re.IGNORECASE | re.ASCII)

    def _matches_defined_metric_acronyms(surface_text, defined_acronyms):
        for acronym in defined_acronyms:
            if re.search(
                rf'(?<![A-Za-z0-9_]){re.escape(acronym)}(?![A-Za-z0-9_.-]|[ \t]*(?:(?:的|为|是|作为|用作)[ \t]*)?{model_suffix_pattern})',
                surface_text,
            ):
                return True
        return False

    def _admitted_metric_surface(result_sentence):
        metric_sentence = re.sub(
            r'(?:\bCLAP\s*(?:基线|模型|(?:baseline|model)(?![A-Za-z0-9_]))|\bNLL\s*(?:基线|模型|方法|(?:baseline|model|method)(?![A-Za-z0-9_]))|(?<![A-Za-z0-9_])(?:TNR|TPR|LSD|ILD[ -]+error|Human[ ]+S)\s*(?:基线|模型|方法|(?:baseline|model|method)(?![A-Za-z0-9_])))',
            '', result_sentence, flags=re.IGNORECASE | re.ASCII,
        )
        additional_denied = bool(additional_denied_re.search(result_sentence))
        measured_metric_text = additional_mention_re.sub(
            lambda m: ' ' if (additional_denied or m.group(1)) else m.group(0),
            metric_sentence,
        )
        if ccc_denied_re.search(result_sentence):
            admitted_metric_text = re.sub(
                r'(?<![A-Za-z0-9_])CCC(?![A-Za-z0-9_])|一致性相关系数',
                ' ', measured_metric_text, flags=re.IGNORECASE | re.ASCII,
            )
        else:
            admitted_metric_text = measured_metric_text
        return metric_sentence, admitted_metric_text

    def _candidate_complete(sentence, defined_acronyms=(), preceding='', following=''):
        result_sentence = _H._strip_core_summary_non_result_numerals(sentence)
        metric_sentence, admitted_metric_text = _admitted_metric_surface(result_sentence)
        numeric_result_sentence = metric.sub(
            lambda match: re.sub(r'\d+(?:\.\d+)?', '', match.group(0)),
            metric_sentence,
        )
        numbers = number.findall(_strip_defined_metric_acronym_numbers(numeric_result_sentence, defined_acronyms))
        has_direction = _has_conditional_metric_delta_direction(result_sentence, metric) or comparison.search(result_sentence) or _has_bound_former_latter_comparison(result_sentence, metric) or _has_bound_disjoint_interval_comparison(result_sentence, metric) or (
            len(numbers) >= 2 and baseline_transition.search(result_sentence)
        )
        narrow_measured_result = _has_recorded_dissonance_comparison(result_sentence) or _has_mean_room_simulation_comparison(result_sentence)
        measured_cross_validation = not re.search(
            r'(?:假设|假想|如果|若在|预计|预期|可能|计划|未来|并非|不是|未进行|未做|没有)', result_sentence,
        ) and re.search(
            r'(?:在|于)[^。！？!?\n]{1,160}(?:[1-9][0-9]*|[一二两三四五六七八九十]+)折交叉验证(?:下|中|上)', result_sentence,
        )
        has_metric = bool(result_sentence and (
            narrow_measured_result
            or metric.search(dnsmos_strip_re.sub(' ', admitted_metric_text))
            or additional_metric.search(admitted_metric_text)
            or conference_metric.search(admitted_metric_text)
            or (not vertex_gesture_denied_re.search(result_sentence) and vertex_gesture_metric.search(result_sentence))
            or _matches_defined_metric_acronyms(admitted_metric_text, defined_acronyms)
            or (source_defined_dnsmos and _has_affirmative_dnsmos_statement(sentence, dnsmos_metric, preceding, following))
            or _has_statistical_result(metric_sentence)
            or _has_source_bound_hit_count_metric(result_sentence)
        ))
        return bool(
            has_metric and has_direction and numbers
            and (narrow_measured_result or measured_cross_validation or setting.search(result_sentence) or named_setting.search(result_sentence) or numeric_named_setting.search(sentence) or _has_concrete_core_summary_setting(result_sentence, metric, conference_metric))
            and (len(numbers) >= 2 or re.search(
                r'(?:基线|对照|相比|相较|原方法|已有方法|先前方法|本文方法|本方法|所提方法|移除|完整模型|竞品)', result_sentence
            )) and not _has_cross_metric_directional_comparison(result_sentence)
        )

    operational_re = re.compile(
        r'(?:\b(?:train(?:ing)?|inference|deployment|hardware|gpu|cpu|tpu|npu|parameter(?:s)?|layers?|hidden(?:\s+units?)?|batch(?:\s+size)?|learning\s+rate|epochs?|steps?|iterations?|sampling\s+rate|window(?:\s+size)?|channels?|dimensions?|memory|vram|flops?|macs?|rtf|latency|throughput|fps|runtime|duration|cost|overhead)\b|训练|推理|部署|硬件|显存|内存|参数量|层数|隐藏单元|批量|学习率|轮次|步数|迭代|采样率|窗口|通道|维度|耗时|延迟|吞吐|实时率|计算量|成本|开销)',
        re.IGNORECASE | re.ASCII,
    )
    generic_english_metric_re = re.compile(r'(?<![A-Za-z0-9_])(?:scores?|performance|metrics?)(?![A-Za-z0-9_])', re.IGNORECASE | re.ASCII)

    def _strip_defined_metric_acronym_numbers(surface_text, defined_acronyms):
        out = surface_text
        for acronym in defined_acronyms or ():
            out = re.sub(
                rf'(?<![A-Za-z0-9_]){re.escape(acronym)}(?![A-Za-z0-9_])',
                lambda m: re.sub(r'[-_.]?\d+(?:\.\d+)?', '', m.group(0)),
                out,
            )
        return out

    def _extract_paragraph_defined_metric_acronyms(paragraph_text, denied_re):
        found = []
        def_re = re.compile(
            r'(?:用|以|通过|采用)[^，,。；\n]{1,28}?(?:误差|差异|距离|偏差|失真|得分|分数|系数|比率|率|度|量|熵)[ \t]*([A-Z][A-Z0-9_-]{2,10})[ \t]*(?:衡量|评估|评测|度量|表征|量化)'
        )
        for p_sent in (s.strip() for s in re.split(r'[。！？!?\n]', paragraph_text) if s.strip()):
            if denied_re.search(p_sent):
                continue
            for m_def in def_re.finditer(p_sent):
                acronym = m_def.group(1)
                if source_text and not re.search(rf'(?<![A-Za-z0-9_]){re.escape(acronym)}(?![A-Za-z0-9_])', str(source_text)):
                    continue
                if acronym not in found:
                    found.append(acronym)
        return found

    def _sentence_has_executive_metric(raw_sentence, defined_acronyms=(), preceding='', following=''):
        cleaned_s = _H._strip_core_summary_non_result_numerals(raw_sentence.strip())
        if not cleaned_s:
            return False
        without_models, admitted_surface = _admitted_metric_surface(cleaned_s)
        without_generic = generic_english_metric_re.sub(' ', admitted_surface)
        return bool(
            metric.search(dnsmos_strip_re.sub(' ', without_generic))
            or additional_metric.search(without_generic)
            or conference_metric.search(without_generic)
            or (not vertex_gesture_denied_re.search(cleaned_s) and vertex_gesture_metric.search(cleaned_s))
            or _matches_defined_metric_acronyms(without_generic, defined_acronyms)
            or (source_defined_dnsmos and _has_affirmative_dnsmos_statement(raw_sentence, dnsmos_metric, preceding, following))
            or _has_statistical_result(without_models)
            or _has_source_bound_hit_count_metric(cleaned_s)
        )

    def _sentence_has_executive_metric_and_number(raw_sentence, defined_acronyms=(), preceding='', following=''):
        cleaned_s = _H._strip_core_summary_non_result_numerals(raw_sentence.strip())
        if not cleaned_s:
            return False
        non_op = _strip_defined_metric_acronym_numbers(operational_re.sub(' ', cleaned_s), defined_acronyms)
        if not number.findall(non_op):
            return False
        return _sentence_has_executive_metric(raw_sentence, defined_acronyms, preceding, following)

    raw_body_sentences = re.split(r'[。！？!?\n]', content_body)
    has_complete_result = any(
        _candidate_complete(
            sentence,
            preceding=raw_body_sentences[idx - 1] if idx > 0 else '',
            following=raw_body_sentences[idx + 1] if idx + 1 < len(raw_body_sentences) else '',
        )
        for idx, sentence in enumerate(raw_body_sentences)
    )
    if use_executive and not has_complete_result:
        denied_window_re = re.compile(r'(?:假设|假想|假定|设想|如果|若在|预计|预期|可能|计划|未来|先前研究|相关工作|第三方|他人|引用|引述|转述|并非|并未|不是|未测|未报告|未进行)')
        operational_clause_re = re.compile(
            r'(?:\d+(?:\.\d+)?\s*(?:kbps|bps|kHz|MHz|Hz)(?![A-Za-z0-9_])|'
            r'(?:训练|推理|部署|单卡|单核|多卡|冷启动|前瞻(?:窗口)?|首次编译|图编译|编译|显存|内存|硬件|参数(?:量|规模|开销)?|'
            r'实时率|(?<![A-Za-z0-9_])RTF(?![A-Za-z0-9_])|延迟|(?<![A-Za-z0-9_])latency(?![A-Za-z0-9_])|'
            r'吞吐|(?<![A-Za-z0-9_])throughput(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])FLOPs?(?![A-Za-z0-9_])|(?<![A-Za-z0-9_])MACs?(?![A-Za-z0-9_]))'
            r'[^，,；;。！？!?\n]{0,36})',
            re.IGNORECASE,
        )
        explicit_counterpart_re = re.compile(
            r'(?:基线|对照|相比|相较|原方法|已有方法|先前方法|竞品|移除|消融|完整模型|次优|'
            r'(?<![A-Za-z0-9_])(?:baseline|versus|vs\.?)(?![A-Za-z0-9_])|'
            r'(?:传统|主流|现有|以往)[^，,。；\n]{0,18}(?:方法|模型|系统|基线|代理|方案|编解码器)|'
            r'与\s*[A-Za-z0-9\u4e00-\u9fa5_-]{2,30}\s*(?:相比|对照|对比|比较)|'
            r'比较\s*\d+\s*个(?:系统|模型|方法)|'
            r'(?:高于|低于|优于|超过|领先)(?:最优|最佳|最强|次优|经典|传统|内置|原生|原始|单一|基础|随机|零样本|微调前|基线|对照|同量|同规模)[^，,。；\n]{0,16}的)',
            re.IGNORECASE,
        )
        for paragraph in re.split(r'\n\s*\n', content_body):
            p_sentences = [s.strip() for s in re.split(r'[。！？!?\n]', paragraph) if s.strip()]
            defined_acronyms = _extract_paragraph_defined_metric_acronyms(paragraph, denied_window_re)
            for win_size in (1, 2, 3, 4):
                for idx in range(len(p_sentences) - win_size + 1):
                    win = p_sentences[idx:idx + win_size]
                    if any(denied_window_re.search(part) or _has_cross_metric_directional_comparison(part) for part in win):
                        continue
                    has_same_sentence_metric_comp = any(
                        _sentence_has_executive_metric_and_number(part, defined_acronyms)
                        and (comparison.search(part) or baseline_transition.search(part))
                        for part in win
                    )
                    has_split_metric_comp = (
                        not has_same_sentence_metric_comp
                        and len(win) >= 2
                        and any(_sentence_has_executive_metric(part, defined_acronyms) for part in win)
                        and any(
                            (comparison.search(part) or baseline_transition.search(part))
                            and len(number.findall(_strip_defined_metric_acronym_numbers(
                                metric.sub(
                                    lambda m: re.sub(r'\d+(?:\.\d+)?', '', m.group(0)),
                                    operational_re.sub(' ', operational_clause_re.sub(' ', _H._strip_core_summary_non_result_numerals(part))),
                                ),
                                defined_acronyms,
                            ))) >= 2
                            for part in win
                        )
                    )
                    if not has_same_sentence_metric_comp and not has_split_metric_comp:
                        continue
                    combined = '，'.join(win)
                    if not explicit_counterpart_re.search(combined):
                        continue
                    non_op_win = _H._strip_core_summary_non_result_numerals(combined)
                    non_op_win = operational_clause_re.sub(' ', non_op_win)
                    non_op_win = operational_re.sub(' ', non_op_win)
                    non_op_win = metric.sub(lambda m: re.sub(r'\d+(?:\.\d+)?', '', m.group(0)), non_op_win)
                    non_op_win = _strip_defined_metric_acronym_numbers(non_op_win, defined_acronyms)
                    if len(number.findall(non_op_win)) < 2:
                        continue
                    if _candidate_complete(combined, defined_acronyms):
                        has_complete_result = True
                        break
                if has_complete_result:
                    break
            if has_complete_result:
                break
    corpus_result = _complete_corpus_curation_summary(content_body)
    if corpus_result and '原文未提供可核对的关键定量结果' in content_body:
        issues.append('摘要已报告语料清洗质量结果，不能笼统声明没有关键定量结果')
    if not has_complete_result and not corpus_result and not _has_scoped_symbolic_demonstration(content_body) and '原文未提供可核对的关键定量结果' not in content_body:
        issues.append('缺少完整关键定量结果或明确不可得声明')
    if use_executive and source_text:
        grounded_issue = _H._validate_core_summary_source_grounded_claims(raw_summary, source_text)
        if grounded_issue:
            issues.append(grounded_issue)
    prior_method_sentence_re = re.compile(
        r'(?:现有|已有|传统|以往|先前|主流)(?:主流)?[^。！？!?\n]{0,28}(?:方法|方案|路线|模型|系统|编解码器|指标|代理|工作|研究)'
    )
    technical_boundary_compound_re = re.compile(
        r'(?:训练与冻结|冻结与更新|冻结与微调|训练|冻结|音素|音节|词|字|帧|分块|切分|窗口|时序|频带|声学|决策|分类|判别|模块|层间|梯度|相位|周期|起止|静音|语音活动)边界'
    )
    if use_executive:
        stripped_boundary = technical_boundary_compound_re.sub(' ', content_body)
        boundary_body = '。'.join(
            s for s in re.split(r'[。！？!?\n]', stripped_boundary)
            if s.strip() and not prior_method_sentence_re.search(s)
        )
    else:
        boundary_body = content_body
    explicit_boundary = (
        re.search(r'(?:边界|局限|适用|失败|尚未|尚不覆盖|未覆盖|未验证|外推|仅限|受限)', boundary_body)
        and not (use_executive and re.search(r'(?:任何场景都适用|所有条件下均成立|不会失效|不存在局限|无适用限制)', content_body))
    )
    separated_unverified_boundary = re.search(
        r'(?:尚未|未曾|未能|未|没有)[^。！？!?\n]{0,60}(?:验证|覆盖|评估|测试)',
        boundary_body,
    )
    conditional_failure = re.search(
        r'(?:但|不过|然而)[^。！？!?\n]{0,80}(?:在|对)[^。！？!?\n]{1,60}'
        r'(?:时|下|中|上)[^。！？!?\n]{0,60}(?:可能|易|会|明显)?'
        r'(?:失真|退化|恶化|不稳定|不可靠|失效|下降|受损|偏差)',
        boundary_body,
    )
    scoped_conclusion_boundary = re.search(
        r'(?:结论|研究结果|研究发现)[^。！？!?\n]{0,40}(?<!不)(?<!非)限于'
        r'[^。！？!?\n]{1,80}(?:语音|语料|数据|场景|条件|设置|样本|任务)',
        boundary_body,
    )
    attention_scope_boundary = any(
        not re.search(r'(?:并非|不是|不能认为|不可认为|不应认为|没有)|(?:并不|不|未|没有|不会|不能)(?:曾|实际|一直|始终|确实|能|会)*保持不变', sentence)
        and re.search(r'(?:结论|研究结果|研究发现)(?<!不)(?<!非)限于(?:视频|音频|图像)(?:自|交叉|跨模态)注意力(?:的)?(?:稀疏化|计算|处理)', sentence)
        and re.search(r'(?:音频|视频|图像)(?:自|交叉|跨模态)注意力[^。！？!?\n]{0,30}保持不变', sentence)
        for sentence in re.split(r'[。！？!?\n]', boundary_body)
    )
    observational_causal_boundary = re.search(
        r'(?:观察性|非实验|非干预)[^。！？!?\n]{0,40}'
        r'(?:不建立|不能建立|不支持|不能证明)[^。！？!?\n]{0,20}因果',
        boundary_body,
    )
    uncovered_scope_boundary = any(
        re.search(r'未涵盖[^。！？!?\n]{1,60}(?:语音|语料|数据|场景|条件|设置|样本|任务|攻击|环境|设备|人群|语种|语言|录音)', sentence)
        and not re.search(r'(?:并非|不是|不存在|没有|并不|不能说|不能认为|无法断言)[^，,；;。！？!?\n]{0,20}未涵盖', sentence)
        and not re.search(r'未涵盖[^。！？!?\n]{0,90}(?:说法|表述|观点|判断|结论)[^。！？!?\n]{0,20}(?:不成立|不正确|不属实|并非事实|不符合事实|错误|有误)', sentence)
        and not re.search(r'未涵盖[^。！？!?\n]{0,60}(?:并非事实|不是事实|并不属实|不属实|不是真的)', sentence)
        for sentence in re.split(r'[。！？!?\n]', boundary_body)
    )
    failure_condition_boundary = re.search(r'(?<![不未没])(?:可能|会|将|易|容易|仍会)(?:(?![不未没])[^。！？!?\n]){0,10}(?:失效|失灵|失准|退化|恶化)', boundary_body)
    unverified_scope_boundary = re.search(r'(?:不在|不属于|未纳入|不纳入)[^。！？!?\n]{0,12}(?:验证|覆盖|评估|评测|测试)范围', boundary_body)
    executive_pending_or_uncovered_boundary = use_executive and any(
        (
            re.search(r'(?:仍需|尚需|尚待|有待)[^。！？!?\n]{0,60}(?:验证|评估|测试)', sentence)
            and not re.search(r'(?:无需|不需|不必|已完成|已经完成|不再需要)', sentence)
        )
        or (
            re.search(r'不覆盖[^。！？!?\n]{1,60}', sentence)
            and not re.search(r'(?:并非|不是|并不|不存在|没有|未曾|不能说|无法断言)[^，,；;。！？!?\n]{0,20}不覆盖', sentence)
        )
        for sentence in re.split(r'[。！？!?\n]', boundary_body)
    )
    if not any((explicit_boundary, separated_unverified_boundary, conditional_failure,
                scoped_conclusion_boundary, attention_scope_boundary, observational_causal_boundary,
                uncovered_scope_boundary, failure_condition_boundary, unverified_scope_boundary,
                executive_pending_or_uncovered_boundary,
                _has_natural_scoped_boundary(boundary_body))):
        issues.append('缺少结论适用边界、失败条件或未验证范围')
    cost_body = (
        '。'.join(s for s in re.split(r'[。！？!?\n]', content_body) if s.strip() and not prior_method_sentence_re.search(s))
        if use_executive else content_body
    )
    scoped_resource_disclosure = any(
        re.search(r'(?:训练|推理|部署)', sentence)
        and re.search(r'\d', sentence)
        and re.search(
            r'(?:计算量|计算复杂度|MACs?|FLOPs?|GPU|CPU|TPU|NPU|RTX|显卡|'
            r'(?:训练|推理|采样|优化|迭代)步数|'
            r'\d\s*(?:[kKmMgG]\s*)?\s*(?:步|轮|次))',
            sentence,
            re.IGNORECASE,
        )
        for sentence in re.split(r'[。！？!?\n]', cost_body)
    )
    executive_computation_or_tradeoff = use_executive and any(
        not re.search(r'(?:并非|并未|不是|不能|不采用|不涉及|假设|如果|未记录)', sentence)
        and re.search(
            r'(?:(?:额外|新增|引入|付出)[^。！？!?\n]{0,24}(?:参数开销|计算开销|内存开销|通信开销|编译开销|延迟|耗时|代价)|'
            r'(?:多花\s*\d+(?:\.\d+)?\s*(?:秒|毫秒|ms|s)|(?:多出|额外)(?:的)?[^。！？!?\n]{0,20}(?:渲染时间|生成时间|推理时间))|'
            r'代价是|作为代价|以[^。！？!?\n]{1,24}为代价|指标折损|'
            r'(?:移除|去掉|消融)[^。！？!?\n]{1,36}(?:回升|恶化|回落|折损)|'
            r'免训练|无需(?:任何)?(?:神经网络)?训练|零样本(?:直接)?推理|'
            r'闭式(?:解|求解|奇异值分解|计算|诊断)|解析解|'
            r'冻结(?:权重|编码器|骨干|主干)?[^。！？!?\n]{0,20}(?:直接推理|零样本推理|无需训练)|'
            r'离线统计检验|'
            r'(?:未披露|未报告)[^。！？!?\n]{0,24}(?:训练|推理|部署)?(?:成本|开销|延迟|耗时|算力|显存))',
            sentence, re.IGNORECASE,
        )
        for sentence in re.split(r'[。！？!?\n]', cost_body)
    )
    cost = _has_concrete_runtime_disclosure(cost_body) \
        or '原文未披露训练、推理或部署成本' in cost_body \
        or re.search(r'(?:成本|代价|开销|硬件|算力|显存|内存|延迟|吞吐|实时率|(?<![A-Za-z0-9_])RTF(?![A-Za-z0-9_])|能耗)', cost_body, re.IGNORECASE) \
        or re.search(r'(?:训练|推理|部署)[^。！？!?]{0,24}(?:需要|增加|额外|占用|耗时|更高|更低|受限|负担)', cost_body) \
        or scoped_resource_disclosure \
        or executive_computation_or_tradeoff
    if not cost:
        issues.append('缺少关键代价、资源开销或实际计算方式说明' if use_executive else '缺少训练、推理或部署成本或未披露声明')
    return '；'.join(issues) if issues else None


_CORE_SUMMARY_NODE_REPLAY_CACHE = {}


def _source_bound_core_summary_semantic_issue(paper, summary, *, source_text=None):
    """Use the same current semantic rules as analysis for an actual sealed source."""
    proof = paper.get('freshRewriteProvenance') or {}
    manifest = paper.get('analysisManifest') if isinstance(paper.get('analysisManifest'), dict) else {}
    contracts = manifest.get('contracts') if isinstance(manifest.get('contracts'), dict) else {}
    has_declaration = 'coreSummary' in contracts
    declaration = contracts.get('coreSummary') if has_declaration else _H.core_summary_formats.current_header()
    summary_header = _H.core_summary_formats.read_declaration(declaration)
    stage = (manifest.get('stages') or {}).get('coreSummaryRepair') or {}
    if ('operatorLiteralCorrection' in stage
            or (stage.get('paidDiagnosticReplay') or {}).get('operatorLiteralCorrectionRequired') is not None) \
            and not _H.is_fresh_source_provenance(proof):
        raise _H.PublishDataValidationError('已付核心术语修正只接受完整日更封存来源。')
    if source_text is not None:
        # This explicit display route is supplied only after its workflow has
        # authenticated the original source. It is never a daily paid-replay
        # authorization, and it always runs the full original stage binding.
        if 'operatorLiteralCorrection' in stage \
                or (isinstance(stage.get('paidDiagnosticReplay'), dict)
                    and 'operatorLiteralCorrectionRequired' in stage['paidDiagnosticReplay']):
            raise _H.PublishDataValidationError('日更专属核心修正不能改走通用来源展示。')
        if not isinstance(source_text, str) or not source_text \
                or _H._javascript_string_sha256(source_text) != paper.get('sourceSha256') \
                or (proof.get('sourceSha256') is not None
                    and proof['sourceSha256'] != paper.get('sourceSha256')):
            raise _H.PublishDataValidationError('核心摘要展示的全文与原论文来源 SHA 不一致。')
        return _H._run_core_summary_node_replay(paper, summary, source_text, stage_replay=True, core_summary=declaration)
    if not _H.is_fresh_source_provenance(proof):
        return _H._detailed_core_summary_semantic_issue(summary, summary_header=summary_header)
    run_id = proof.get('runId')
    if not isinstance(run_id, str) or not re.fullmatch(
            r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', run_id) \
            or proof.get('sourceGeneration') != 1:
        raise _H.PublishDataValidationError('核心摘要重放缺少日更封存来源身份。')
    paper_id = _H._daily_fresh_normalized_paper_id(paper)
    source_dir = _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id / 'sources' / paper_id / 'generation-000001'
    for directory in (_H.DAILY_FRESH_SOURCE_RUNS_DIR, _H.DAILY_FRESH_SOURCE_RUNS_DIR / run_id,
                      source_dir.parent.parent, source_dir.parent, source_dir):
        _H._daily_fresh_safe_directory(directory, '核心摘要来源目录')
    source_bytes = _H._daily_fresh_read_private_file(source_dir / 'source.txt',
        '核心摘要原文', 64 * 1024 * 1024)
    if _H._daily_fresh_sha256(source_bytes) != proof.get('sourceSha256') \
            or paper.get('sourceSha256') != proof.get('sourceSha256'):
        raise _H.PublishDataValidationError('核心摘要重放原文 SHA 与本篇记录不一致。')
    source_text = source_bytes.decode('utf-8')
    return _H._run_core_summary_node_replay(paper, summary, source_text,
        stage_replay='operatorLiteralCorrection' in stage or 'paidDiagnosticReplay' in stage,
        core_summary=declaration)


def _run_core_summary_node_replay(paper, summary, source_text, *, stage_replay, core_summary=None):
    from publication_local_replay import publication_replay_result
    same_render = publication_replay_result(paper, source_text) if stage_replay else None
    if same_render is not None:
        # The actual source-bound worker ran the same normal stage validator.
        return same_render['coreSummaryIssue']
    cli = _H.SHARED_SCRIPTS_DIR / 'lib' / 'core-summary-semantic-replay-cli.js'
    implementations = (
        _H._sha256_file(cli),
        _H._sha256_file(_H.SHARED_SCRIPTS_DIR / 'analysis-contract.js'),
        _H._sha256_file(_H.SHARED_SCRIPTS_DIR / 'lib' / 'analysis-contract-paper-exemptions.js'),
        _H._sha256_file(_H.SHARED_SCRIPTS_DIR / 'lib' / 'core-summary-format.js'),
        _H._sha256_file(_H.SHARED_SCRIPTS_DIR.parent / 'config' / 'protocols' / 'summary.json'),
        _H._sha256_file(_H.SHARED_SCRIPTS_DIR / 'lib' / 'core-symbolic-source-numerals.js'),
        _H._sha256_file(_H.SHARED_SCRIPTS_DIR / 'lib' / 'analysis-section-titles.js'),
    )
    header_key = json.dumps(core_summary, ensure_ascii=False, sort_keys=True, separators=(',', ':')) if core_summary is not None else ''
    key = (_H._javascript_string_sha256(summary), _H._javascript_string_sha256(source_text), header_key, implementations)
    # An operator replay must re-read its original paid files and authorization
    # every time; a semantic-only cache cannot attest those mutable files.
    cache = _H._CORE_SUMMARY_NODE_REPLAY_CACHE
    if not stage_replay and key in cache:
        return cache[key]
    semantic_body = {'summary': summary, 'sourceText': source_text}
    if core_summary is not None:
        semantic_body['coreSummary'] = core_summary
    payload = _H._daily_fresh_compact_json_bytes(
        {'mode': 'stage-binding', 'paper': paper, 'sourceText': source_text}
        if stage_replay else semantic_body)
    if len(payload) > 16 * 1024 * 1024:
        raise _H.PublishDataValidationError('核心摘要只读重放输入超过上限。')
    node = _H.shutil.which('node')
    if not node:
        raise _H.PublishDataValidationError('核心摘要规则重放需要 Node.js。')
    source_correction = paper.get('conferenceSourceCorrection')
    from conference_source_correction_format import locator_family
    source_correction_stage = stage_replay and bool(locator_family(source_correction))
    replay_env = {key: value for key, value in _H.os.environ.items() if key not in {'NODE_OPTIONS', 'NODE_PATH'}}
    replay_timeout = 180 if source_correction_stage else 30
    replay_runner = _H.get('_run_node_replay_cli')
    if replay_runner is not None:
        result = replay_runner(
            cli, payload, node=node, cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
            env=replay_env, timeout_seconds=replay_timeout,
            max_output_bytes=64 * 1024, use_named_temp=True,
        )
    else:
        with _H.tempfile.NamedTemporaryFile(mode='w+b') as source_file:
            source_file.write(payload); source_file.flush(); source_file.seek(0)
            result = _H._run_bounded_subprocess([node, str(cli), str(source_file.fileno())],
                cwd=str(_H.SHARED_SCRIPTS_DIR.parent),
                env=replay_env,
                timeout_seconds=replay_timeout,
                max_output_bytes=64 * 1024, pass_fds=(source_file.fileno(),))
    from publication_local_replay import checked_replay_response
    response = checked_replay_response(result, worker='core-summary-semantic-replay-cli.js',
                                      timeout_seconds=180 if source_correction_stage else 30,
                                      failure_label='核心摘要当前语义规则无法完整重放。')
    if not isinstance(response, dict) or set(response) != {'issue'} \
            or not (response['issue'] is None or isinstance(response['issue'], str)):
        raise _H.PublishDataValidationError('核心摘要当前语义规则返回字段无效。')
    if not stage_replay:
        cache[key] = response['issue']
    return response['issue']


def _validated_detailed_core_summary(paper, parsed, *, source_text=None):
    """核验详细摘要的正文和阶段记录，并返回摘要文本。

    记录未声明当前详细摘要协议时，本函数返回 None。声明了该协议后，
    页面必须使用分析正文中经过本函数核验的详细摘要，不能改用编辑计划的一句话摘要。
    一句话摘要仍供页面元数据和简介使用；本函数不代表整篇分析或页面已通过所有检查。
    """
    manifest = paper.get('analysisManifest')
    contracts = manifest.get('contracts') if isinstance(manifest, dict) else None
    if not isinstance(contracts, dict) or 'coreSummary' not in contracts:
        return None
    declaration = contracts['coreSummary']
    stages = manifest.get('stages')
    stage = stages.get('coreSummaryRepair') if isinstance(stages, dict) else None
    scoring = stages.get('scoringAudit') if isinstance(stages, dict) else None
    if not isinstance(stage, dict) \
            or stage.get('status') not in {'complete', 'not_needed'} \
            or not (summary_header := _H.core_summary_formats.read_stage(declaration, stage)):
        raise _H.PublishDataValidationError('详细核心摘要阶段未完成，或声明与阶段格式不一致。')
    analysis = paper.get('analysis')
    heading_issue = _H.evaluation_heading_issue(analysis)
    if heading_issue:
        raise _H.PublishDataValidationError(heading_issue)
    stored_analysis_fields = _H.parse_analysis(analysis) if isinstance(analysis, str) else None
    summary = stored_analysis_fields.get('summary') if isinstance(stored_analysis_fields, dict) else None
    if not isinstance(summary, str) or not summary.strip():
        raise _H.PublishDataValidationError('读者文章缺少有效的详细核心摘要正文。')
    summary = summary.strip()
    semantic_issue = (_H._source_bound_core_summary_semantic_issue(paper, summary, source_text=source_text)
                      if source_text is not None else _H._source_bound_core_summary_semantic_issue(paper, summary))
    if semantic_issue:
        raise _H.PublishDataValidationError(
            '读者文章的核心摘要未达到详细摘要规则：'
            f'{semantic_issue}'
        )
    if isinstance(parsed, dict) and parsed.get('summary') != summary:
        raise _H.PublishDataValidationError('读者文章的已解析核心摘要与分析正文中的摘要不一致。')
    summary_sha = _H._javascript_string_sha256(summary)
    if stage.get('summarySha256') != summary_sha:
        raise _H.PublishDataValidationError('读者文章的详细核心摘要 SHA 与阶段记录不一致。')
    required_stage_shas = (
        'fingerprint', 'inputAnalysisSha256', 'outputAnalysisSha256',
        'inputSummarySha256', 'inputStructureProjectionSha256',
        'outputStructureProjectionSha256', 'bindingSha256',
    )
    if any(not re.fullmatch(r'[0-9a-f]{64}', str(stage.get(field) or ''))
           for field in required_stage_shas):
        raise _H.PublishDataValidationError('读者文章的详细核心摘要阶段记录中，输入指纹或相关 SHA 缺失，或格式无效。')
    if stage.get('inputStructureProjectionSha256') \
            != stage.get('outputStructureProjectionSha256'):
        raise _H.PublishDataValidationError('读者文章的详细核心摘要阶段记录中，输入与输出的其他章节 SHA 不一致。')
    binding_body = {
        **_H.core_summary_formats.stage_fields(summary_header),
        'inputAnalysisSha256': stage['inputAnalysisSha256'],
        'outputAnalysisSha256': stage['outputAnalysisSha256'],
        'inputSummarySha256': stage['inputSummarySha256'],
        'summarySha256': stage['summarySha256'],
        'inputStructureProjectionSha256': stage['inputStructureProjectionSha256'],
        'outputStructureProjectionSha256': stage['outputStructureProjectionSha256'],
    }
    if 'operatorLiteralCorrection' in stage:
        binding_body['operatorLiteralCorrection'] = stage['operatorLiteralCorrection']
        binding_body['paidDiagnosticReplay'] = stage.get('paidDiagnosticReplay')
    if stage.get('bindingSha256') != _H._stable_json_sha256(binding_body):
        raise _H.PublishDataValidationError('读者文章的详细核心摘要绑定 SHA 与按原字段重新计算的结果不一致。')
    structure = stages.get('structureRepair') if isinstance(stages, dict) else None
    try:
        tag_record = _H.read_tag_stage_record(manifest, paper.get('analysisStageCheckpoints'))
    except ValueError as error:
        raise _H.PublishDataValidationError(str(error)) from error
    tag_stage = tag_record['stage']
    tag_contract = contracts.get(tag_record['contractKey'])
    has_tag_stage = isinstance(stages, dict) and tag_record['stageKey'] in stages
    if tag_record['format'] == 'current' or tag_contract is not None or has_tag_stage:
        expected_contract = (tag_contract if tag_record['format'] == 'current'
                             else tag_stage.get('selectionContract') if isinstance(tag_stage, dict) else None)
        if (tag_record['format'] == 'current' and not _H.is_tag_stage_record_declaration(tag_contract)) \
                or tag_contract != expected_contract \
                or not isinstance(tag_stage, dict) \
                or not _H.is_supported_tag_selection_contract(tag_stage.get('selectionContract')) \
                or tag_stage.get('status') not in {'complete', 'not_needed'} \
                or not re.fullmatch(
                    r'[0-9a-f]{64}', str(tag_stage.get('outputAnalysisSha256') or '')
                ):
            raise _H.PublishDataValidationError(
                '读者文章的详细核心摘要所依赖的标签阶段记录缺失或无效。'
            )
        upstream = tag_stage
        upstream_label = tag_record['stageKey']
        upstream_checkpoint = tag_record['checkpoint']
        checkpoint_parsed = _H.parse_analysis(upstream_checkpoint) \
            if isinstance(upstream_checkpoint, str) else None
        checkpoint_summary = checkpoint_parsed.get('summary') \
            if isinstance(checkpoint_parsed, dict) else None
        if not isinstance(upstream_checkpoint, str) \
                or not isinstance(checkpoint_summary, str) \
                or _H._javascript_string_sha256(upstream_checkpoint) \
                != upstream.get('outputAnalysisSha256') \
                or _H._javascript_string_sha256(
                    checkpoint_summary.strip()
                ) != stage.get('inputSummarySha256') \
                or _H._analysis_sha256_ignoring_core_summary_body(upstream_checkpoint) \
                != stage.get('inputStructureProjectionSha256'):
            raise _H.PublishDataValidationError(
                '读者文章的详细核心摘要所依赖的标签阶段正文或摘要缺失、格式无效，或正文、摘要或其他章节的 SHA 与阶段记录不一致。'
            )
    else:
        # 旧记录的标签协议值为 None，且未保存旧标签阶段键时，
        # 摘要阶段可以直接连接 structureRepair。协议值不是 None 或阶段键已出现时，
        # 本函数必须检查标签阶段，不能回退到结构阶段；新格式也不使用此例外。
        upstream = structure
        upstream_label = 'structureRepair'
    if not isinstance(upstream, dict) \
            or upstream.get('outputAnalysisSha256') != stage.get('inputAnalysisSha256'):
       raise _H.PublishDataValidationError(
           f'读者文章的详细核心摘要输入与 {upstream_label} 阶段输出的 SHA 不一致，或上游阶段记录缺失。'
       )
    if not isinstance(scoring, dict):
        raise _H.PublishDataValidationError('读者文章的评分阶段记录缺失，或评分使用的正文或详细核心摘要 SHA 与阶段记录不一致。')
    if scoring.get('status') != _H.MANUAL_REVIEW_MODE:
        analysis_sha = _H._javascript_string_sha256(analysis)
        # 读者文章页面按来源记录展示官方图片。历史 imageSupplement=complete
        # 的成功记录没有保留添图前正文，本函数无法只凭三个 SHA 字段
        # 确认变化仅限图片。因此，非人工复核的评分输出仍须与最终分析正文绑定。
        scoring_binds_final = scoring.get('outputAnalysisSha256') == analysis_sha
        if not scoring_binds_final \
                or scoring.get('coreSummaryInputAnalysisSha256') != stage.get('outputAnalysisSha256') \
                or scoring.get('inputCoreSummarySha256') != summary_sha \
                or scoring.get('outputCoreSummarySha256') != summary_sha:
            raise _H.PublishDataValidationError('读者文章的评分阶段记录缺失，或评分使用的正文或详细核心摘要 SHA 与阶段记录不一致。')
    return summary
