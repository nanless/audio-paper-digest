'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hasConcreteUnnumberedMethodChain, validateCoreSummarySemanticContract } = require('../scripts/analysis-contract');

const summary08760 = [
    "世界模型能连续生成交互视频，但画面往往没有声音，论文要解决的是为外部视觉流实时配上立体声。",
    "输入是每秒 30 帧的透视视频流和可中途改写的声音指令，输出是 48 kHz 双声道波形，难点在于不能看未来帧、指令会变、左右声道要随视角变化。",
    "WorldSonus 把生成按 100 ms 切块，自回归（Autoregressive，AR）变换器（Transformer）维护有界记忆以保持语义连续，整流流（Rectified Flow）头在块内合成 3 帧连续潜变量并直接读取帧对齐视觉细节。",
    "文本经 T5Gemma 2 编码后缓存，在块边界原位替换以保持声学连续，训练时加入中途切换、撤回、到达和保持四种提示调度。",
    "空间监督来自筛选后的野外立体声和全景一阶 Ambisonics（First-Order Ambisonics，FOA）旋转解码。",
    "与双向基线相比，WorldSonus 在 Interactive 30 s 上 VGGish 特征的 Fréchet 音频距离（Fréchet Audio Distance，FAD）为 2.03，低于 AudioX 的 5.52 和 PrismAudio 的 6.08，数值越低表示分布越接近参考。",
    "结论适用于透视视频的因果流式配音，未来帧可用的离线剪辑并非其优势场景，全景声场和因果声码器重建仍是短板。",
    "原文披露单张 NVIDIA H100 上每 100 ms 块耗时 41.2 ms，实时率为 0.41，10 s 会话含冷启动为 0.466。"
].join('');

const summary06433 = [
    "该任务的输入是在空气中传播的语音，输出是 0 到 9 的孤立数字标签，难点是在丢弃可重构波形细节后仍保留区分不同说话人发音的频谱与时序线索。",
    "Lyric 让在空气中传播的语音直接驱动五个调谐不同的无源亥姆霍兹共振器（Helmholtz resonators），腔内麦克风拾取共振压力，模拟交流有效值电路提取 10 ms 积分的缓慢幅度包络，五个包络以每通道 100 样本/秒数字化后送入因果时序网络做整句平均判决。",
    "该路径省去数字分帧、快速傅里叶变换、Mel 滤波和对数压缩，用通道身份携带粗略频率位置。",
    "在说话人互斥的 AudioMNIST 实测中，EdgeSpeechNet-A 从 40 通道对数 Mel 频谱（log-Mel spectrogram）的 99.28% 变为 Lyric 输入的 95.70%，在 Raspberry Pi 4 上预处理加推理时延从 454.31 ms 降至 6.56 ms。",
    "结论只适用于该回放录音的孤立数字测试，未验证连续语音与总体系统能耗，原文未披露训练成本，推理侧只估算了处理器动态能耗而排除了麦克风、模拟电路、模数转换与采集等待。"
].join('');

const summary05055 = [
    "学习型多声源定位与检测需要覆盖多种房间声学条件的大规模带标签数据，实测采集成本高，常用几何声学仿真替代训练，但仿真做到多复杂才能在真实房间泛化并不清楚。",
    "论文固定采用三阶 Ambisonics（三阶环境立体声，记录声场方向信息的球谐表示）输入的卷积循环网络和活动耦合直角坐标到达方向表示，用 2,000 个随机鞋盒房间生成 20 种训练集，控制镜像源法（image-source method，计算矩形房间镜面反射的几何声学方法）阶数、扩散晚期混响、传声器阵列建模和镜像源位置随机化，再到 3 个实测 Eigenmike 数据集检验。",
    "结果趋势是无混响训练在实测集失效，一阶和二阶镜像源带来大部分增益，12 阶加实测阵列传递函数和位置扰动取得最好实测表现并接近仿真域内水平。",
    "扰动幅度达正负 10 m 的随机化在不增加镜像源计算量的前提下改善了泛化。",
    "结论适用于鞋盒假设下的几何仿真与语音声源，对波形级仿真或非语音事件尚未验证。",
    "原文未披露训练、推理或部署成本，仿真侧报告了单房间平均 0.49 s 到 1.26 s 的耗时差异。"
].join('');

test('真实分块生成与物理前端摘要不必插入编号词', () => {
    for (const summary of [summary08760, summary06433]) {
        assert.equal(hasConcreteUnnumberedMethodChain(summary), true);
        const issue = validateCoreSummarySemanticContract('## 核心摘要\n' + summary);
        assert.equal(String(issue || '').includes('缺少 2–4 步方法链'), false);
    }
});

test('普通编码到判决的明确数据交接可以说明方法链', () => {
    assert.equal(hasConcreteUnnumberedMethodChain('编码器提取声学特征，这些特征送入解码器预测词级标签。'), true);
    assert.equal(hasConcreteUnnumberedMethodChain('电路提取幅度包络，包络数字化后送入因果时序网络做整句平均判决。'), true);
});

test('名词动作堆叠、独立对比和反事实不能充当方法链', () => {
    for (const summary of [
        '编码器和解码器组成系统，输入音频，输出标签。',
        '编码器提取信息，解码器处理结果。',
        '网络提取声学特征，这些特征送入同一网络预测词级标签。',
        '编码器提取声学特征，另一种方法用解码器预测词级标签。',
        '编码器的声学特征准确率更高，解码器延迟更低。',
        '编码器未提取声学特征，这些特征送入解码器预测词级标签。',
        '编码器提取声学特征，这些特征不送入解码器预测词级标签。',
        '假设编码器提取声学特征，这些特征送入解码器预测词级标签。',
        '未来编码器提取声学特征，这些特征送入解码器预测词级标签。',
        '状态网络维护有界记忆以保持语义连续，另一套独立方法的生成器在块内生成音频块。',
        '编码器提取声学特征，标签送入解码器预测词级标签。'
    ]) assert.equal(hasConcreteUnnumberedMethodChain(summary), false, summary);
});

test('方法链的新判据不能放掉其他定量证据问题', () => {
    const issue = validateCoreSummarySemanticContract('## 核心摘要\n' + summary05055,
        { sourceText: 'The real test dataset reports a baseline error of 50% and our method reduces it to 40%.' });
    assert.ok(issue);
    assert.match(issue, /定量结果|评测设置|比较对象|指标/);
});
