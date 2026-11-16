"""外部图片 URL 的 fake-IP 双栈放行规则回归测试。

2026-11-16 审计：本机代理（Clash/Surge 等）在 fake-IP 模式下会把域名解析成
198.18.0.0/15（IPv4）或 2001:2::/48（IPv6）的合成地址，真正的域名解析发生在
上游代理侧。`_validate_public_image_url` 只在**配置了 HTTP(S) 代理**且
**整组解析结果都落在保留段**时放行；混入真实私网地址或未配置代理时仍拒绝，
避免代理模式把私网拦截整体失效。测试用 mock 替换 DNS 解析，不联网。
"""
import importlib.util
import os
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
_SPEC = importlib.util.spec_from_file_location(
    'fake_ip_publish', ROOT / 'scripts/publish-to-blog.py'
)
publish = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(publish)

PROXY_KEYS = ('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy')
URL = 'https://example.org/paper-figure.png'


def resolver(addresses):
    """构造与 socket.getaddrinfo 返回值同形的 DNS 结果，并记录被查询的域名。"""
    calls = []

    def fake_getaddrinfo(host, port, *args, **kwargs):
        calls.append((host, port))
        records = []
        for address in addresses:
            if ':' in address:
                records.append((socket.AF_INET6, socket.SOCK_STREAM, 6, '',
                                (address, 0, 0, 0)))
            else:
                records.append((socket.AF_INET, socket.SOCK_STREAM, 6, '',
                                (address, 0)))
        return records

    fake_getaddrinfo.calls = calls
    return fake_getaddrinfo


class PublicImageFakeIpTest(unittest.TestCase):
    def setUp(self):
        self._saved_proxy = {key: os.environ.get(key) for key in PROXY_KEYS}
        for key in PROXY_KEYS:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self._saved_proxy.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def _validate(self, addresses, proxy=None):
        if proxy is not None:
            os.environ['HTTPS_PROXY'] = proxy
        fake = resolver(addresses)
        with mock.patch.object(publish.socket, 'getaddrinfo', side_effect=fake):
            result = publish._validate_public_image_url(URL)
        self.assertEqual(fake.calls, [('example.org', None)])
        return result

    def test_proxy_configured_and_whole_set_is_fake_ip_is_allowed(self):
        # IPv4 与 IPv6 两个保留段都要放行：Clash 等代理会同时返回两种合成地址。
        resolved = self._validate(
            ['198.18.0.7', '2001:2::1'], proxy='http://127.0.0.1:7897'
        )
        self.assertEqual(resolved, {'198.18.0.7', '2001:2::1'})

    def test_proxy_configured_but_one_real_private_address_still_rejected(self):
        # 混入真实私网地址时，整组不再全是 fake-IP，必须拒绝。
        with self.assertRaisesRegex(publish.PublishDataValidationError, '非公网地址'):
            self._validate(['198.18.0.7', '192.168.1.5'], proxy='http://127.0.0.1:7897')
        with self.assertRaisesRegex(publish.PublishDataValidationError, '非公网地址'):
            self._validate(['2001:2::1', '10.0.0.8'], proxy='http://127.0.0.1:7897')

    def test_without_proxy_fake_ip_is_still_rejected(self):
        # 没有显式代理时必须按普通地址处理；fake-IP 保留段不是公网地址。
        with self.assertRaisesRegex(
            publish.PublishDataValidationError,
            r'非公网地址: 198\.18\.0\.7',
        ):
            self._validate(['198.18.0.7'])


if __name__ == '__main__':
    unittest.main()
