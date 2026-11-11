"""「双实现」对照测试的 Python 侧探针。

从标准输入读取 Node 侧生成的同一批语料任务，调用 publish_common.py 的公开入口，
把结论以 JSON 打到标准输出。它自身不是 unittest 用例（文件名不以 test_ 开头），
同时被 tests/python/test_parity_contract_double_implementation.py 以模块方式复用。

用法（由 JS 测试或人工调用）：
    bash scripts/python-runtime.sh tests/python/parity_contract_probe.py < tasks.json
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import publish_common  # noqa: E402


def evaluate_task(task):
    """按任务类型调用 Python 侧同一入口，返回与 Node 侧可比的结论。"""
    kind = task.get('kind')
    if kind == 'manual-numeral':
        # Python 没有单独导出量词扫描函数；发布闸会把命中写成
        # “manual v4 <section> 精确定量必须使用阿拉伯数字: <surface>”。
        issue = publish_common.validate_manual_reader_quality(
            '## 核心摘要\n' + task['text'] + '\n')
        return bool(issue and '精确定量必须使用阿拉伯数字' in issue)
    if kind == 'experiment-table':
        issue = publish_common.validate_experiment_table_contract(
            task['analysis'],
            contract_version=publish_common.EXPERIMENT_TABLE_CONTRACT_VERSION,
            document_type=task['documentType'],
            source_text=task['sourceText'],
        )
        return issue or None
    raise ValueError(f'未知对照任务类型: {kind!r}')


def evaluate_tasks(tasks):
    return [
        {'rule': task['rule'], 'case': task['case'], 'py': evaluate_task(task)}
        for task in tasks
    ]


def main():
    payload = json.load(sys.stdin)
    tasks = payload.get('tasks')
    if not isinstance(tasks, list):
        raise SystemExit('输入缺少 tasks 数组')
    sys.stdout.write(json.dumps({'results': evaluate_tasks(tasks)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
