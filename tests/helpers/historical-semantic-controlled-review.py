# coding: utf-8
"""仅将模型的页面内容审查替换为本地结果；请求、页面检查点和通过记录均由项目程序处理。"""
import importlib.util
import sys
import types
from pathlib import Path
source = Path(sys.argv[1])
sys.path.insert(0, str(source.parent))
from runtime_guard import require_external_runtime
require_external_runtime('历史语义审查本地测试')
spec = importlib.util.spec_from_file_location('actual_historical_review', source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
args = sys.argv[2:]
def option(name):
    return args[args.index(name) + 1]
outcome = option('--controlled-outcome')
passed = outcome in ('passed', 'reuse')
# 第二次成功运行必须复用实际页面检查点，不得再调用测试模型函数。
def local_review(*args, **kwargs):
    if outcome == 'reuse':
        raise AssertionError('已有通过页面检查点时不应再次调用测试模型函数')
    return passed, ([] if passed else [{'severity': 'blocking', 'message': '本地测试：本次审查未通过'}])
mock = types.SimpleNamespace(split_review_content=lambda content, size: [content],
    get_blog_review_chunk_chars=lambda: 10000, parse_markdown_images=lambda content: [],
    _llm_review_post_chunk=local_review)
module.load_publish_to_blog = lambda: mock
result = module.run(option('--request'), option('--output'), option('--checkpoint-dir'),
                    int(option('--concurrency')))
sys.exit(0 if result['passed'] else 1)
