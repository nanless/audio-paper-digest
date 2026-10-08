"""把 project_env 写进 os.environ 的东西挡在用例之外。

脚本入口读配置的方式就是把仓库 .env 灌进 os.environ：publish-to-blog.py 的第一
行、log_setup.setup_script_logging() 都会调 load_project_env()。真实命令行靠这一
步把配置交给 git、hugo 等子进程，但测试在同一进程里加载模块或调 main()，.env 就
会留到后面的用例，连 PD_WORKSPACE_ALLOW_CROSS_ROLE 这种开关都能漏出去，于是整批
测试的结果取决于模块的执行顺序。
"""

import os
from contextlib import contextmanager


def _restore_environment(saved):
    for key in list(os.environ):
        if key not in saved:
            del os.environ[key]
    os.environ.update(saved)


@contextmanager
def project_env_scope():
    """块里允许写 os.environ，退出时还原成进入前的样子（新增的删掉，改过的改回）。"""
    saved = dict(os.environ)
    try:
        yield
    finally:
        _restore_environment(saved)


def restore_environment_after(testcase):
    """把还原挂到用例的 addCleanup 上，等于一个用例一个作用域。"""
    saved = dict(os.environ)
    testcase.addCleanup(_restore_environment, saved)


def isolate_module_environment():
    """生成 setUpModule/tearDownModule，在模块边界还原 os.environ。

    用例调 generate/review/push 等入口的 main() 时，log_setup 会再读一次 .env；
    这类污染点分散在几十个用例里，按模块收口最省事，也能挡住以后新加的 main()
    调用。
    """
    saved = {}

    def setUpModule():
        saved['env'] = dict(os.environ)

    def tearDownModule():
        env = saved.pop('env', None)
        if env is not None:
            _restore_environment(env)

    return setUpModule, tearDownModule
