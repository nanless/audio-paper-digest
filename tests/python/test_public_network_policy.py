"""Python 公网 CIDR 与代理 Fake-IP 安全策略及 `_validate_public_image_url` / peer 校验单元测试。"""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / 'scripts'
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import public_network_policy as pnp  # noqa: E402

_PUBLISH_SPEC = importlib.util.spec_from_file_location(
    'publish_to_blog_policy_test', SCRIPTS / 'publish-to-blog.py'
)
publish_to_blog = importlib.util.module_from_spec(_PUBLISH_SPEC)
_PUBLISH_SPEC.loader.exec_module(publish_to_blog)

PROXY_KEYS = ('HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy')


def _mock_getaddrinfo(addresses):
    def fake_getaddrinfo(_host, _port, *_args, **_kwargs):
        out = []
        for addr in addresses:
            if ':' in addr:
                out.append((socket.AF_INET6, socket.SOCK_STREAM, 6, '', (addr, 0, 0, 0)))
            else:
                out.append((socket.AF_INET, socket.SOCK_STREAM, 6, '', (addr, 0)))
        return out

    return fake_getaddrinfo


class PublicNetworkPolicyPythonTest(unittest.TestCase):
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

    def test_direct_execution_rejects_codex_sandbox(self):
        env = dict(os.environ, CODEX_SANDBOX='test-seatbelt')
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / 'public_network_policy.py')],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('必须在沙箱外运行', result.stdout + result.stderr)

    def test_safe_file_reading_rejects_symlinks_hardlinks_fences_and_duplicate_keys(self):
        raw_text = pnp.DEFAULT_POLICY_PATH.read_text(encoding='utf-8')
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp).resolve()
            real_file = base / 'policy.json'
            real_file.write_text(raw_text, encoding='utf-8')
            loaded = pnp.load_public_network_policy(real_file)
            self.assertEqual(loaded.raw['ipv6GlobalUnicastCidr'], '2000::/3')
            self.assertEqual(len(loaded.raw['nonGlobalIpv4Cidrs']), 15)

            symlink_file = base / 'symlink-policy.json'
            symlink_file.symlink_to(real_file)
            with self.assertRaisesRegex(pnp.PublicNetworkPolicyError, '符号链接') as ctx:
                pnp.load_public_network_policy(symlink_file)
            self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_POLICY_UNSAFE_FILE')

            real_dir = base / 'real-dir'
            real_dir.mkdir()
            (real_dir / 'policy.json').write_text(raw_text, encoding='utf-8')
            symlink_dir = base / 'symlink-dir'
            symlink_dir.symlink_to(real_dir, target_is_directory=True)
            with self.assertRaisesRegex(pnp.PublicNetworkPolicyError, '符号链接') as ctx:
                pnp.load_public_network_policy(symlink_dir / 'policy.json')
            self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_POLICY_SYMLINK')

            hardlink_file = base / 'hardlink-policy.json'
            os.link(real_file, hardlink_file)
            try:
                with self.assertRaisesRegex(pnp.PublicNetworkPolicyError, '单硬链接'):
                    pnp.load_public_network_policy(hardlink_file)
            finally:
                hardlink_file.unlink()

            fenced_file = base / 'fenced.json'
            fenced_file.write_text(f'```json\n{raw_text.strip()}\n```\n', encoding='utf-8')
            with self.assertRaises(pnp.PublicNetworkPolicyError) as ctx:
                pnp.load_public_network_policy(fenced_file)
            self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_POLICY_SCHEMA')

            bom_file = base / 'bom.json'
            bom_file.write_bytes(b'\xef\xbb\xbf' + raw_text.encode('utf-8'))
            with self.assertRaises(pnp.PublicNetworkPolicyError) as ctx:
                pnp.load_public_network_policy(bom_file)
            self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_POLICY_SCHEMA')

            dup_file = base / 'dup.json'
            dup_file.write_text(
                '{"ipv6GlobalUnicastCidr":"2000::/3","ipv6GlobalUnicastCidr":"2000::/3",'
                '"nonGlobalIpv4Cidrs":[],"nonGlobalIpv6Cidrs":[],"proxyFakeIpCidrs":[]}',
                encoding='utf-8',
            )
            with self.assertRaisesRegex(pnp.PublicNetworkPolicyError, '重复字段') as ctx:
                pnp.load_public_network_policy(dup_file)
            self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_POLICY_SCHEMA')

    def test_unicode_digits_and_closed_interval_fake_ip_validation(self):
        for non_ascii_ip in ('1१.0.0.1', '１98.18.0.1', '8.8.8.８', '2001:2::१'):
            self.assertFalse(pnp.is_globally_routable_ip(non_ascii_ip), non_ascii_ip)
            self.assertFalse(pnp.is_proxy_fake_ip(non_ascii_ip), non_ascii_ip)
            with self.assertRaises(pnp.PublicNetworkPolicyError) as ctx:
                pnp.select_validated_public_ip([non_ascii_ip], proxy_enabled=True)
            self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_INVALID_IP')

        raw_base = json.loads(pnp.DEFAULT_POLICY_PATH.read_text(encoding='utf-8'))
        for bad_fake_cidr in (
            '0.0.0.0/0', '0.0.0.0/1', '10.0.0.0/8', '100.64.0.0/10',
            '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16',
            '224.0.0.0/4', '240.0.0.0/4', '::/0', '2000::/3', 'fc00::/7',
            '::/128', '::1/128', 'fe80::/10', 'ff00::/8', '::ffff:0:0/96',
            '1.1.1.0/24', '2000::/1२', '１98.18.0.0/15',
        ):
            bad_policy = dict(raw_base, proxyFakeIpCidrs=[bad_fake_cidr])
            with self.assertRaises(pnp.PublicNetworkPolicyError, msg=bad_fake_cidr) as ctx:
                pnp.compile_public_network_policy(bad_policy)
            self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_POLICY_SCHEMA')

        # 中间存在公网空洞（首尾落在保留段内）也必须被闭区间合并判定拒绝
        gap_policy = dict(
            raw_base,
            nonGlobalIpv4Cidrs=[
                *(c for c in raw_base['nonGlobalIpv4Cidrs'] if c != '198.18.0.0/15'),
                '198.16.0.0/16',
                '198.19.0.0/16',
            ],
            proxyFakeIpCidrs=['198.16.0.0/14'],
        )
        with self.assertRaises(pnp.PublicNetworkPolicyError) as ctx:
            pnp.compile_public_network_policy(gap_policy)
        self.assertEqual(ctx.exception.code, 'PUBLIC_NETWORK_POLICY_SCHEMA')

    def test_proxy_priority_matches_get_required_fetch_proxy(self):
        # 高优先级变量非法时立即返回 False，绝不向低优先级变量穿透
        self.assertFalse(pnp.has_http_connect_proxy({
            'HTTPS_PROXY': 'socks5://127.0.0.1:7897',
            'HTTP_PROXY': 'http://127.0.0.1:7897',
        }))
        self.assertFalse(pnp.has_http_connect_proxy({
            'https_proxy': 'socks5://127.0.0.1:7897',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }))
        self.assertFalse(pnp.has_http_connect_proxy({
            'HTTPS_PROXY': 'http://127.0.0.1:99999',
            'HTTP_PROXY': 'http://127.0.0.1:7897',
        }))
        self.assertFalse(pnp.has_http_connect_proxy({
            'HTTPS_PROXY': 'http://127.0.0.1:abc',
            'HTTP_PROXY': 'http://127.0.0.1:7897',
        }))
        self.assertTrue(pnp.has_http_connect_proxy({
            'https_proxy': '',
            'HTTPS_PROXY': 'http://127.0.0.1:7897',
        }))
        self.assertTrue(pnp.has_http_connect_proxy({
            'ALL_PROXY': 'socks5h://127.0.0.1:7897',
            'HTTP_PROXY': 'http://127.0.0.1:7897',
        }))

    def test_validate_public_image_url_and_peer_transport_integration(self):
        os.environ['HTTPS_PROXY'] = 'http://127.0.0.1:7897'
        with mock.patch.object(
            publish_to_blog.socket, 'getaddrinfo', side_effect=_mock_getaddrinfo(['198.18.0.7', '2001:2::1'])
        ):
            self.assertEqual(
                publish_to_blog._validate_public_image_url('https://example.org/fig.png'),
                {'198.18.0.7', '2001:2::1'},
            )

        # HTTPS_PROXY 为 socks5 且 HTTP_PROXY 为 http 时，不穿透激活 Fake-IP
        os.environ['HTTPS_PROXY'] = 'socks5://127.0.0.1:7897'
        os.environ['HTTP_PROXY'] = 'http://127.0.0.1:7897'
        with mock.patch.object(
            publish_to_blog.socket, 'getaddrinfo', side_effect=_mock_getaddrinfo(['198.18.0.7'])
        ):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, r'非公网地址: 198\.18\.0\.7'):
                publish_to_blog._validate_public_image_url('https://example.org/fig.png')

        # 策略配置异常（PUBLIC_NETWORK_POLICY_*）在字面量分支和 DNS 分支都必须报“公网安全策略异常”，不伪装成域名解析非公网
        policy_fault = pnp.PublicNetworkPolicyError('策略文件已损坏', 'PUBLIC_NETWORK_POLICY_SCHEMA')
        with mock.patch.object(publish_to_blog, 'is_globally_routable_ip', side_effect=policy_fault):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '公网安全策略异常'):
                publish_to_blog._validate_public_image_url('https://8.8.8.8/fig.png')

        with mock.patch.object(
            publish_to_blog.socket, 'getaddrinfo', side_effect=_mock_getaddrinfo(['8.8.8.8'])
        ), mock.patch.object(publish_to_blog, 'select_validated_public_ip', side_effect=policy_fault):
            with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '公网安全策略异常'):
                publish_to_blog._validate_public_image_url('https://example.org/fig.png')

        # _validate_response_peer_with_transport（直连分支 proxy_addresses=None）复用统一策略并做 canonical 归一化
        def make_resp(peer_ip):
            sock = mock.Mock()
            sock.getpeername.return_value = (peer_ip, 443)
            resp = mock.Mock()
            resp.connection.sock = sock
            return resp

        self.assertEqual(
            publish_to_blog._validate_response_peer_with_transport(
                make_resp('2001:4860:4860:0:0:0:0:8888'),
                {'2001:4860:4860::8888'},
                proxy_addresses=None,
            ),
            '2001:4860:4860::8888',
        )
        for non_global_peer in ('3fff::1', '198.18.0.7', '127.0.0.1'):
            with self.assertRaisesRegex(
                publish_to_blog.PublishDataValidationError,
                '命中非公网 peer',
                msg=non_global_peer,
            ):
                publish_to_blog._validate_response_peer_with_transport(
                    make_resp(non_global_peer),
                    {non_global_peer},
                    proxy_addresses=None,
                )

    def test_validate_public_image_url_rejects_noncanonical_ipv4_empty_userinfo_and_port_zero(self):
        import blog_review_image_loader
        os.environ['HTTPS_PROXY'] = 'http://127.0.0.1:7897'
        self.assertFalse(pnp.is_valid_http_connect_proxy_url('http://127.0.0.1:0'))
        self.assertFalse(pnp.has_http_connect_proxy({
            'HTTPS_PROXY': 'http://127.0.0.1:0',
            'HTTP_PROXY': 'http://127.0.0.1:7897',
        }))
        with mock.patch.object(
            blog_review_image_loader.socket, 'getaddrinfo',
            side_effect=_mock_getaddrinfo(['198.18.0.1']),
        ) as mocked_dns:
            for bad_url in (
                'https://0xc6120001/fig.png',
                'https://3323068417/fig.png',
                'https://0306.022.0.1/fig.png',
                'https://198.18.1/fig.png',
                'https://127.1/fig.png',
                'https://0x7f000001/fig.png',
            ):
                with self.assertRaisesRegex(
                    publish_to_blog.PublishDataValidationError,
                    '非公网地址',
                    msg=bad_url,
                ):
                    blog_review_image_loader.validate_public_image_url(bad_url)
            mocked_dns.assert_not_called()

        with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '无认证信息'):
            blog_review_image_loader.validate_public_image_url('https://@example.org/fig.png')
        with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '端口非法'):
            blog_review_image_loader.validate_public_image_url('https://example.org:0/fig.png')

    def test_download_review_image_wraps_urllib3_http_error(self):
        import urllib3.exceptions
        import blog_review_image_loader

        def raise_urllib3(*_args, **_kwargs):
            raise urllib3.exceptions.ProtocolError('synthetic disconnect')

        with self.assertRaisesRegex(publish_to_blog.PublishDataValidationError, '图片下载失败'):
            blog_review_image_loader.download_review_image(
                'https://example.org/fig.png',
                hooks={
                    'get_required_fetch_proxy': lambda: 'http://127.0.0.1:7897',
                    '_resolve_proxy_addresses': lambda _proxy: {'127.0.0.1'},
                    '_validate_public_image_url': lambda _url: {'93.184.216.34'},
                    '_read_pinned_review_image': raise_urllib3,
                },
            )


if __name__ == '__main__':
    unittest.main()
