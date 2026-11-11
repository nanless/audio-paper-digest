"""「双实现」对照测试（Python 侧，unittest discover 可跑）。

同一批语料先由 Node 侧语料库（tests/parity-contract-corpus.cjs）生成并给出 Node 结论，
这里用 publish_common.py 的同一入口重算，逐条断言两侧结论一致；不一致时打印
「哪条语料、Node 结果、Python 结果」。

当前 13 条语料两侧不一致，登记在语料库的 KNOWN_DIVERGENCES 中并动态 skip；
其余 63 条为硬断言。上游实现修好后，已登记语料自然转入普通断言；新增的未登记
分歧会让本测试失败。

运行：
    bash scripts/python-runtime.sh -m unittest discover -s tests/python -p "test_parity_*.py"
"""

import json
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from parity_contract_probe import evaluate_task  # noqa: E402


def describe(value):
    if value is None:
        return 'null（通过）'
    if isinstance(value, bool):
        return 'true（命中规则）' if value else 'false（未命中规则）'
    return json.dumps(value, ensure_ascii=False)


def run_node_probe():
    result = subprocess.run(
        ['node', str(ROOT / 'tests' / 'parity-contract-corpus.cjs')],
        cwd=str(ROOT), capture_output=True, text=True, timeout=180,
    )
    if result.returncode != 0:
        raise AssertionError(
            f'Node 对照探针执行失败（退出码 {result.returncode}）:\n{result.stderr.strip()}')
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(
            f'Node 对照探针输出不是 JSON: {error}\n{result.stdout[:2000]}') from error
    for field in ('rules', 'tasks', 'jsResults', 'knownDivergences'):
        if not isinstance(payload.get(field), list):
            raise AssertionError(f'Node 对照探针缺少 {field} 数组')
    return payload


def rule_hit(rule_id, value):
    return value is True if rule_id == 'manual-numeral' else value is not None


class ParityContractDoubleImplementationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload = run_node_probe()
        cls.node_results = {
            (item['rule'], item['case']): item['js']
            for item in cls.payload['jsResults']
        }
        cls.known_divergences = {
            (item['rule'], item['case']): item
            for item in cls.payload['knownDivergences']
        }
        cls.tasks_by_rule = {}
        for task in cls.payload['tasks']:
            cls.tasks_by_rule.setdefault(task['rule'], []).append(task)

    def assert_rule_parity(self, rule_id):
        tasks = self.tasks_by_rule.get(rule_id) or []
        self.assertGreaterEqual(len(tasks), 4, f'规则 {rule_id} 的语料少于 4 条')
        divergent = 0
        converged = 0
        for task in tasks:
            key = (task['rule'], task['case'])
            with self.subTest(rule=task['rule'], case=task['case']):
                self.assertIn(key, self.node_results, f'Node 侧缺少语料结果: {key}')
                node = self.node_results[key]
                py = evaluate_task(task)
                detail = (
                    f"规则「{task['rule']}」的语料「{task['case']}」两侧结论不一致\n"
                    f'Node  : {describe(node)}\n'
                    f'Python: {describe(py)}\n'
                    f'语料  : {json.dumps(task, ensure_ascii=False)}'
                )
                if node != py:
                    documented = self.known_divergences.get(key)
                    if documented is None:
                        self.fail(detail + '\n未登记的新分歧：请先确认语义，'
                                  '修实现（不在本测试范围）或登记到 KNOWN_DIVERGENCES。')
                    divergent += 1
                    self.skipTest(
                        f'当前不一致（已登记，未改实现）: {key}\n'
                        f'Node  : {describe(node)}\nPython: {describe(py)}\n'
                        f"说明  : {documented.get('note', '')}")
                if key in self.known_divergences:
                    converged += 1
                self.assertEqual(node, py, detail)
        if converged:
            print(f'[parity] {rule_id}: 已收敛并转为硬断言 {converged} 条（仍登记在 KNOWN_DIVERGENCES）',
                  file=sys.stderr)
        if divergent:
            self.skipTest(
                f'{divergent} 条语料当前不一致，已登记在 tests/parity-contract-corpus.cjs 的 '
                f'KNOWN_DIVERGENCES；其余 {len(tasks) - divergent} 条已按硬断言核对')

    def test_parity_table_identifier(self):
        self.assert_rule_parity('table-identifier')

    def test_parity_latent_space_header(self):
        self.assert_rule_parity('latent-space-header')

    def test_parity_ablation_switch(self):
        self.assert_rule_parity('ablation-switch')

    def test_parity_table_boundary(self):
        self.assert_rule_parity('table-boundary')

    def test_parity_negative_evidence(self):
        self.assert_rule_parity('negative-evidence')

    def test_parity_manual_numeral(self):
        self.assert_rule_parity('manual-numeral')

    def test_corpus_is_not_degenerate(self):
        self.assertEqual(len(self.payload['rules']), 6, '对照规则应固定为 6 组')
        for rule in self.payload['rules']:
            rule_id = rule['id']
            tasks = self.tasks_by_rule.get(rule_id) or []
            values = [self.node_results[(task['rule'], task['case'])] for task in tasks]
            hits = sum(1 for value in values if rule_hit(rule_id, value))
            self.assertGreater(hits, 0, f'规则 {rule_id} 没有“命中规则”的语料')
            self.assertLess(hits, len(values), f'规则 {rule_id} 没有“通过”的语料')
        rule_ids = {rule['id'] for rule in self.payload['rules']}
        for key, documented in self.known_divergences.items():
            self.assertIn(key[0], rule_ids, f'KNOWN_DIVERGENCES 引用了未知规则: {key[0]}')
            self.assertTrue(
                any((task['rule'], task['case']) == key for task in self.payload['tasks']),
                f'KNOWN_DIVERGENCES 引用了不存在的语料: {key}')
            self.assertTrue(documented.get('note'), f'KNOWN_DIVERGENCES 缺少说明: {key}')

    def test_python_entries_are_callable(self):
        import publish_common
        self.assertTrue(callable(publish_common.validate_experiment_table_contract))
        self.assertTrue(callable(publish_common.validate_manual_reader_quality))
        self.assertEqual(len(self.node_results), len(self.payload['tasks']),
                         'Node 结果条数与语料条数不一致')


if __name__ == '__main__':
    unittest.main()
