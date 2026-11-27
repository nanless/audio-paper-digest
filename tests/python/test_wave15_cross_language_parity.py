"""Wave 15 跨语言（JS ↔ Python）五大核心域一致性回归测试。

覆盖原先缺少直接跨语言断言的五个双实现领域：
1. `.env` 文件解析（`scripts/env-loader.js` vs `scripts/project_env.py`）
2. 评分体系 `type-aware-v2`（`scripts/lib/scoring-rubric.js` vs `scripts/scoring_rubric.py`）
3. 工作区角色契约与命令路由（`config/workspace-roles.json` + `scripts/workspace-role.js` / `env-loader.js` vs `scripts/runtime_guard.py`）
4. 单元格公式与双写折叠（`scripts/lib/reader-source-display.js` vs `scripts/blog_formula_tex_display.py`，含 `\\overline{x} ...; d_{z}` 顺序回归）
5. 日志/密钥脱敏与工作流泄露模式（`scripts/log-setup.js` vs `scripts/log_setup.py` + `config/workflow-leak-patterns.json`）
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import blog_formula_tex_display as py_tex  # noqa: E402
import log_setup as py_log  # noqa: E402
import project_env as py_env  # noqa: E402
import runtime_guard as py_guard  # noqa: E402
import scoring_rubric as py_scoring  # noqa: E402


def _run_node_json(js_code, payload=None):
    env = {k: v for k, v in os.environ.items() if k != 'CODEX_SANDBOX'}
    env['VERIFY_PROJECT_DISABLE_FILE_LOGS'] = '1'
    proc = subprocess.run(
        ['node', '-e', js_code],
        cwd=str(ROOT),
        input=json.dumps(payload, ensure_ascii=False) if payload is not None else '',
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )
    if proc.returncode != 0:
        raise AssertionError(f'Node parity probe failed ({proc.returncode}):\n{proc.stderr}')
    return json.loads(proc.stdout)


class CrossLanguageParityWave15Tests(unittest.TestCase):
    def test_dotenv_parsing_parity(self):
        sample = '\n'.join([
            '# comment line',
            '  PLAIN_KEY = value_one  ',
            'DOUBLE_QUOTED="hello=world # keep"',
            "SINGLE_QUOTED='inner \"quote\"'",
            'INLINE_HASH=5 # not stripped',
            'DUP_KEY=first',
            'DUP_KEY=second',
            'EMPTY_VAL=',
            'export EXPORTED=kept_with_prefix',
        ]) + '\n'
        with tempfile.TemporaryDirectory(prefix='parity-env-') as tmp:
            env_path = Path(tmp) / '.env'
            env_path.write_text(sample, encoding='utf-8')
            os.chmod(env_path, 0o600)
            py_result = py_env.parse_env_file(env_path)
            js_result = _run_node_json(
                "const fs=require('node:fs');"
                "const {parseEnvContent}=require('./scripts/env-loader.js');"
                "const input=JSON.parse(fs.readFileSync(0,'utf8'));"
                "process.stdout.write(JSON.stringify(parseEnvContent(input.text)));",
                {'text': sample},
            )
            self.assertEqual(py_result, js_result)
            self.assertEqual(py_result['DUP_KEY'], 'second')
            self.assertEqual(py_result['INLINE_HASH'], '5 # not stripped')

    def test_scoring_v2_parity_across_document_types_and_half_up_boundaries(self):
        doc_types = list(py_scoring.SPEC['documentTypes'].keys())
        score_sets = [
            {'innovation': 8.25, 'technicalRigor': 7.75, 'experimentalSufficiency': 8.0,
             'clarity': 7.5, 'impact': 8.5, 'reproducibility': 7.0, 'engineering': 6.5, 'openSource': 10.0},
            {'innovation': 6.55, 'technicalRigor': 8.45, 'experimentalSufficiency': 9.15,
             'clarity': 8.0, 'impact': 7.5, 'reproducibility': 9.0, 'engineering': 8.5, 'openSource': 6.0},
            {'innovation': 7.0, 'technicalRigor': 7.5, 'experimentalSufficiency': 7.5,
             'clarity': 9.25, 'impact': 8.75, 'reproducibility': 6.0, 'engineering': 5.0, 'openSource': 0.0},
            {'innovation': 7.35, 'technicalRigor': 8.05, 'experimentalSufficiency': 8.15,
             'clarity': 7.95, 'impact': 8.0, 'reproducibility': 7.5, 'engineering': 9.5, 'openSource': 1.5},
        ]
        cases = [[doc_type, score_sets[idx % len(score_sets)]] for idx, doc_type in enumerate(doc_types)]
        js_results = _run_node_json(
            "const fs=require('node:fs');"
            "const s=require('./scripts/lib/scoring-rubric.js');"
            "const cases=JSON.parse(fs.readFileSync(0,'utf8'));"
            "const out=cases.map(([docType, dims]) => ({"
            "  weights: s.formatDocumentTypeWeightsSummary(docType),"
            "  result: s.calculateWeightedTotal(docType, dims),"
            "  anchors: Object.fromEntries([0,1.5,3,6,8,10,5.5].map(v => [String(v), s.isOpenSourceAnchor(v)]))"
            "}));"
            "process.stdout.write(JSON.stringify(out));",
            cases,
        )
        for (doc_type, dims), js_item in zip(cases, js_results):
            self.assertEqual(py_scoring.format_document_type_weights_summary(doc_type), js_item['weights'])
            self.assertEqual(py_scoring.calculate_weighted_total(doc_type, dims), js_item['result'])
            for v_str, js_anchor in js_item['anchors'].items():
                self.assertEqual(py_scoring.is_open_source_anchor(float(v_str)), js_anchor)

    def test_workspace_role_contract_single_source_parity(self):
        spec = json.loads((ROOT / 'config' / 'workspace-roles.json').read_text(encoding='utf-8'))
        js_meta = _run_node_json(
            "const wr=require('./scripts/workspace-role.js');"
            "process.stdout.write(JSON.stringify({"
            "  contract: wr.CONTRACT, schemaFingerprint: wr.SCHEMA_FINGERPRINT,"
            "  roles: wr.ROLES, markerName: wr.MARKER_NAME, crossRoleEnv: wr.CROSS_ROLE_ENV"
            "}));"
        )
        self.assertEqual(py_guard.WORKSPACE_ROLE_CONTRACT, spec['contract'])
        self.assertEqual(py_guard.WORKSPACE_ROLE_SCHEMA_FINGERPRINT, spec['schemaFingerprint'])
        self.assertEqual(list(py_guard.WORKSPACE_ROLES), spec['roles'])
        self.assertEqual(py_guard.WORKSPACE_ROLE_MARKER, spec['markerName'])
        self.assertEqual(py_guard.CROSS_ROLE_ENV, spec['crossRoleEnv'])
        self.assertEqual(js_meta['contract'], py_guard.WORKSPACE_ROLE_CONTRACT)
        self.assertEqual(js_meta['schemaFingerprint'], py_guard.WORKSPACE_ROLE_SCHEMA_FINGERPRINT)
        self.assertEqual(js_meta['roles'], list(py_guard.WORKSPACE_ROLES))
        self.assertEqual(js_meta['markerName'], py_guard.WORKSPACE_ROLE_MARKER)
        self.assertEqual(js_meta['crossRoleEnv'], py_guard.CROSS_ROLE_ENV)
        self.assertEqual(py_guard.required_workspace_role_for_command('publish-to-blog.py'), 'daily')
        self.assertEqual(py_guard.required_workspace_role_for_command('history-inventory.py'), 'history')

    def test_reader_cell_tex_display_parity_including_overline_semicolon_case(self):
        samples = [
            r'\overline{x} with a long description padding over forty chars; d_{z}',
            r'x¯\overline{x} = 0.84; ŷ\hat{y} = 0.91',
            r'd_{z}',
            r'10^{-4}',
            r'r≥r\geq 0.85',
            r'(−1.4)(-1.4)',
            r'55{,}00855{,}008',
            r'I2{}^{\text{2}}S',
        ]
        js_outputs = _run_node_json(
            "const fs=require('node:fs');"
            "const d=require('./scripts/lib/reader-source-display.js');"
            "const samples=JSON.parse(fs.readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(samples.map(s => d.projectReaderCellTexDisplay(s))));",
            samples,
        )
        for sample, js_out in zip(samples, js_outputs):
            py_out = py_tex._project_reader_cell_tex_display(sample)
            self.assertEqual(py_out, js_out, f'JS/Python drift on cell TeX display: {sample!r}')

    def test_log_redaction_and_workflow_leak_contract_parity(self):
        samples = [
            'proxy=http://alice:supersecret@127.0.0.1:7897/path',
            'Authorization: Bearer sk-abc1234567890',
            'token=oc_sk_TestPoolKey_9876543210',
            'PAPER_ANALYZER_API_KEY=plain-secret-value',
        ]
        js_redacted = _run_node_json(
            "const fs=require('node:fs');"
            "const l=require('./scripts/log-setup.js');"
            "const samples=JSON.parse(fs.readFileSync(0,'utf8'));"
            "process.stdout.write(JSON.stringify(samples.map(s => l.redactLogText(s))));",
            samples,
        )
        for sample, js_out in zip(samples, js_redacted):
            py_out = py_log.redact_log_text(sample)
            self.assertEqual(py_out, js_out, f'Redaction drift on: {sample!r}')
            for leaked in ('supersecret', 'sk-abc1234567890', 'oc_sk_TestPoolKey_9876543210', 'plain-secret-value'):
                self.assertNotIn(leaked, py_out)

        leak_spec = json.loads((ROOT / 'config' / 'workflow-leak-patterns.json').read_text(encoding='utf-8'))
        self.assertIn('script', leak_spec['structuredSpecForbiddenHtmlTags'])
        self.assertIn('manual_complete', leak_spec['structuredSpecWorkflowLeakPattern'])


if __name__ == '__main__':
    unittest.main()
