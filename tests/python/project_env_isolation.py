"""把 project_env 写进 os.environ 的东西挡在单个用例之外。

publish-to-blog.py 的第一行就调用 load_project_env()，把仓库 .env 灌进
os.environ。真实命令行入口靠这一步把配置交给 git、hugo 等子进程，但测试在同一
进程里加载同一个模块时，.env 会一直留到后面的用例，连
PD_WORKSPACE_ALLOW_CROSS_ROLE 这种开关都能漏出去，于是整批测试的结果取决于
模块的执行顺序。
"""

import os
from contextlib import contextmanager


@contextmanager
def project_env_scope():
    """块里允许写 os.environ，退出时还原成进入前的样子（新增的删掉，改过的改回）。"""
    saved = dict(os.environ)
    try:
        yield
    finally:
        for key in list(os.environ):
            if key not in saved:
                del os.environ[key]
        os.environ.update(saved)


def restore_environment_after(testcase):
    """把还原挂到用例的 addCleanup 上。"""
    saved = dict(os.environ)

    def restore():
        for key in list(os.environ):
            if key not in saved:
                del os.environ[key]
        os.environ.update(saved)

    testcase.addCleanup(restore)
