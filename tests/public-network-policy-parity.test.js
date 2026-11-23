'use strict';

process.env.VERIFY_PROJECT_DISABLE_FILE_LOGS = '1';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { installTmpOnlyWriteGuard } = require('./helpers/isolated-tmp-write-guard.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const GUARD_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'public-network-policy-suite-')));
installTmpOnlyWriteGuard(GUARD_ROOT);

const policyModule = require('../scripts/lib/public-network-policy.js');
const { collectWorkflowImplementationFiles } = require('../scripts/lib/workflow-implementation-files.js');
const deepAnalyzer = require('../scripts/deep-analyzer.js');

process.on('exit', () => {
    try {
        fs.rmSync(GUARD_ROOT, { recursive: true, force: true });
    } catch (_) {
        // ignore cleanup errors at exit
    }
});

test('config/public-network-policy.json 包含完整 15 段非公网 IPv4、2000::/3 全球单播及双栈 Fake-IP 声明', () => {
    const compiled = policyModule.loadPublicNetworkPolicy();
    assert.equal(compiled.raw.ipv6GlobalUnicastCidr, '2000::/3');
    assert.equal(compiled.raw.nonGlobalIpv4Cidrs.length, 15);
    assert.deepEqual(compiled.raw.nonGlobalIpv4Cidrs, [
        '0.0.0.0/8',
        '10.0.0.0/8',
        '100.64.0.0/10',
        '127.0.0.0/8',
        '169.254.0.0/16',
        '172.16.0.0/12',
        '192.0.0.0/24',
        '192.0.2.0/24',
        '192.88.99.0/24',
        '192.168.0.0/16',
        '198.18.0.0/15',
        '198.51.100.0/24',
        '203.0.113.0/24',
        '224.0.0.0/4',
        '240.0.0.0/4'
    ]);
    assert.deepEqual(compiled.raw.proxyFakeIpCidrs, ['198.18.0.0/15', '2001:2::/48']);
});

test('策略读取器强制 O_NOFOLLOW、拒绝符号链接/Markdown 围栏/坏 UTF-8/重复键，且统一抛出 PublicNetworkPolicyError', t => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(GUARD_ROOT, 'policy-fs-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const validContent = fs.readFileSync(policyModule.DEFAULT_POLICY_PATH, 'utf8');
    const realFile = path.join(dir, 'real-policy.json');
    fs.writeFileSync(realFile, validContent, 'utf8');
    assert.equal(policyModule.loadPublicNetworkPolicy(realFile).raw.ipv6GlobalUnicastCidr, '2000::/3');

    // 1. 拒绝文件级符号链接
    const symlinkFile = path.join(dir, 'symlink-policy.json');
    fs.symlinkSync(realFile, symlinkFile);
    assert.throws(
        () => policyModule.loadPublicNetworkPolicy(symlinkFile),
        err => err instanceof policyModule.PublicNetworkPolicyError
            && err.code === 'PUBLIC_NETWORK_POLICY_UNSAFE_FILE'
            && /符号链接/.test(err.message)
    );
    fs.unlinkSync(symlinkFile);

    // 2. 拒绝父目录级符号链接
    const realSubdir = path.join(dir, 'real-config');
    fs.mkdirSync(realSubdir);
    fs.writeFileSync(path.join(realSubdir, 'public-network-policy.json'), validContent, 'utf8');
    const symlinkDir = path.join(dir, 'linked-config');
    fs.symlinkSync(realSubdir, symlinkDir, 'dir');
    assert.throws(
        () => policyModule.loadPublicNetworkPolicy(path.join(symlinkDir, 'public-network-policy.json')),
        err => err instanceof policyModule.PublicNetworkPolicyError
            && err.code === 'PUBLIC_NETWORK_POLICY_SYMLINK'
            && /符号链接/.test(err.message)
    );
    fs.unlinkSync(symlinkDir);

    // 3. 禁止剥离 Markdown 代码围栏，统一抛出 PUBLIC_NETWORK_POLICY_SCHEMA
    const fencedFile = path.join(dir, 'fenced.json');
    fs.writeFileSync(fencedFile, `\`\`\`json\n${validContent.trim()}\n\`\`\`\n`, 'utf8');
    assert.throws(
        () => policyModule.loadPublicNetworkPolicy(fencedFile),
        err => err instanceof policyModule.PublicNetworkPolicyError
            && err.code === 'PUBLIC_NETWORK_POLICY_SCHEMA'
    );

    // 4. 非法 UTF-8 字节统一抛出 PUBLIC_NETWORK_POLICY_SCHEMA
    const badUtf8File = path.join(dir, 'bad-utf8.json');
    fs.writeFileSync(badUtf8File, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    assert.throws(
        () => policyModule.loadPublicNetworkPolicy(badUtf8File),
        err => err instanceof policyModule.PublicNetworkPolicyError
            && err.code === 'PUBLIC_NETWORK_POLICY_SCHEMA'
    );

    // 5. 损坏 JSON 语法统一抛出 PUBLIC_NETWORK_POLICY_SCHEMA
    const brokenJsonFile = path.join(dir, 'broken.json');
    fs.writeFileSync(brokenJsonFile, '{"ipv6GlobalUnicastCidr": "2000::/3", }', 'utf8');
    assert.throws(
        () => policyModule.loadPublicNetworkPolicy(brokenJsonFile),
        err => err instanceof policyModule.PublicNetworkPolicyError
            && err.code === 'PUBLIC_NETWORK_POLICY_SCHEMA'
    );

    // 6. 拒绝 UTF-8 BOM（\xef\xbb\xbf），统一抛出 PUBLIC_NETWORK_POLICY_SCHEMA
    const bomFile = path.join(dir, 'bom.json');
    fs.writeFileSync(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(validContent, 'utf8')]));
    assert.throws(
        () => policyModule.loadPublicNetworkPolicy(bomFile),
        err => err instanceof policyModule.PublicNetworkPolicyError
            && err.code === 'PUBLIC_NETWORK_POLICY_SCHEMA'
    );

    // 7. 拒绝重复 JSON 键，统一抛出 PUBLIC_NETWORK_POLICY_SCHEMA
    const dupKeyFile = path.join(dir, 'dup-key.json');
    fs.writeFileSync(
        dupKeyFile,
        '{"ipv6GlobalUnicastCidr":"2000::/3","ipv6GlobalUnicastCidr":"2000::/3","nonGlobalIpv4Cidrs":[],"nonGlobalIpv6Cidrs":[],"proxyFakeIpCidrs":[]}',
        'utf8'
    );
    assert.throws(
        () => policyModule.loadPublicNetworkPolicy(dupKeyFile),
        err => err instanceof policyModule.PublicNetworkPolicyError
            && err.code === 'PUBLIC_NETWORK_POLICY_SCHEMA'
            && /重复字段/.test(err.message)
    );
});

test('Node 与 Python 双栈对拍：单 IP、Unicode 数字、闭区间覆盖、禁止本机/私网 Fake-IP 及代理变量优先级 100% 同构', () => {
    const baseRawPolicy = JSON.parse(fs.readFileSync(policyModule.DEFAULT_POLICY_PATH, 'utf8'));

    const singleIpVectors = [
        // 公网 IPv4
        ['1.1.1.1', true, false],
        ['8.8.8.8', true, false],
        ['9.255.255.255', true, false],
        ['11.0.0.1', true, false],
        ['100.63.255.255', true, false],
        ['100.128.0.0', true, false],
        ['172.15.255.255', true, false],
        ['172.32.0.0', true, false],
        ['192.0.1.1', true, false],
        ['198.17.255.255', true, false],
        ['198.20.0.0', true, false],
        ['223.255.255.254', true, false],
        // 15 段非全局 IPv4
        ['0.0.0.0', false, false],
        ['0.255.255.255', false, false],
        ['10.0.0.8', false, false],
        ['100.64.0.1', false, false],
        ['100.127.255.254', false, false],
        ['127.0.0.1', false, false],
        ['169.254.169.254', false, false],
        ['172.16.0.1', false, false],
        ['172.31.255.254', false, false],
        ['192.0.0.1', false, false],
        ['192.0.2.1', false, false],
        ['192.88.99.1', false, false],
        ['192.168.1.1', false, false],
        ['198.18.0.1', false, true],
        ['198.19.255.254', false, true],
        ['198.51.100.1', false, false],
        ['203.0.113.1', false, false],
        ['224.0.0.1', false, false],
        ['240.0.0.1', false, false],
        ['255.255.255.255', false, false],
        // 公网 IPv6
        ['2001:4860:4860::8888', true, false],
        ['2606:4700:4700::1111', true, false],
        ['2001:200::1', true, false],
        ['3ffe::1', true, false],
        // 非全局 IPv6
        ['::', false, false],
        ['::1', false, false],
        ['::ffff:127.0.0.1', false, false],
        ['::ffff:7f00:1', false, false],
        ['::ffff:8.8.8.8', false, false],
        ['::ffff:198.18.0.7', false, false],
        ['::127.0.0.1', false, false],
        ['::7f00:1', false, false],
        ['64:ff9b::7f00:1', false, false],
        ['64:ff9b::8.8.8.8', false, false],
        ['64:ff9b:1::1', false, false],
        ['100::1', false, false],
        ['2001::1', false, false],
        ['2001:2::1', false, true],
        ['2001:2:0:ffff::1', false, true],
        ['2001:2:1::1', false, false],
        ['2001:db8::1', false, false],
        ['2002:7f00:1::', false, false],
        ['2002:0808:0808::1', false, false],
        ['3fff::1', false, false],
        ['fc00::1', false, false],
        ['fd12:3456::1', false, false],
        ['fe80::1', false, false],
        ['fe80::1%lo0', false, false],
        ['2001:4860:4860::8888%en0', false, false],
        ['fec0::1', false, false],
        ['ff02::1', false, false],
        // 非 ASCII Unicode 数字与非法字符串（Reviewer 1A 必测向量）
        ['1१.0.0.1', false, false],
        ['１98.18.0.1', false, false],
        ['8.8.8.８', false, false],
        ['2001:2::१', false, false],
        ['[2001:4860:4860::8888]', false, false],
        ['010.0.0.1', false, false],
        ['127.1', false, false],
        ['not-an-ip', false, false],
        ['', false, false],
        [' 8.8.8.8 ', false, false]
    ];

    const dnsSetCases = [
        { addresses: [], proxyEnabled: false, ok: false, code: 'PUBLIC_NETWORK_EMPTY_DNS' },
        { addresses: [], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_EMPTY_DNS' },
        { addresses: ['8.8.8.8', '1.1.1.1'], proxyEnabled: false, ok: true, mode: 'global', address: '8.8.8.8' },
        { addresses: ['2001:4860:4860:0:0:0:0:8888', '8.8.8.8'], proxyEnabled: true, ok: true, mode: 'global', address: '2001:4860:4860::8888' },
        { addresses: ['198.18.0.7'], proxyEnabled: false, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '198.18.0.7' },
        { addresses: ['2001:2::1'], proxyEnabled: false, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '2001:2::1' },
        { addresses: ['198.18.0.7'], proxyEnabled: true, ok: true, mode: 'proxy_fake_ip', address: '198.18.0.7' },
        { addresses: ['2001:0002:0000::0001'], proxyEnabled: true, ok: true, mode: 'proxy_fake_ip', address: '2001:2::1' },
        { addresses: ['198.18.0.7', '2001:2::1'], proxyEnabled: true, ok: true, mode: 'proxy_fake_ip', address: '198.18.0.7' },
        { addresses: ['198.18.0.7', '10.0.0.8'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '10.0.0.8' },
        { addresses: ['198.18.0.7', '127.0.0.1'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '127.0.0.1' },
        { addresses: ['2001:2::1', '192.168.1.5'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '192.168.1.5' },
        { addresses: ['198.18.0.7', '::ffff:127.0.0.1'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '::ffff:127.0.0.1' },
        { addresses: ['8.8.8.8', '198.18.0.7'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '198.18.0.7' },
        { addresses: ['198.18.0.7', '8.8.8.8'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '198.18.0.7' },
        { addresses: ['2001:4860:4860::8888', '2001:2::1'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '2001:2::1' },
        { addresses: ['::ffff:198.18.0.7'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '::ffff:198.18.0.7' },
        { addresses: ['8.8.8.8', '127.0.0.1'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_NON_GLOBAL_IP', offendingIp: '127.0.0.1' },
        // 非 ASCII 数字在 DNS 记录中必须触发 PUBLIC_NETWORK_INVALID_IP
        { addresses: ['1१.0.0.1'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_INVALID_IP', offendingIp: '1१.0.0.1' },
        { addresses: ['１98.18.0.1'], proxyEnabled: true, ok: false, code: 'PUBLIC_NETWORK_INVALID_IP', offendingIp: '１98.18.0.1' }
    ];

    // 策略编译正反例（含闭区间空洞与本机/私网重叠阻断、Unicode CIDR 前缀阻断、相邻子网无间隙归并放行）
    const schemaCases = [
        { name: 'valid-default', raw: baseRawPolicy, ok: true },
        {
            name: 'valid-adjacent-split-198-18-16-and-198-19-16',
            raw: {
                ...baseRawPolicy,
                nonGlobalIpv4Cidrs: [
                    ...baseRawPolicy.nonGlobalIpv4Cidrs.filter(c => c !== '198.18.0.0/15'),
                    '198.18.0.0/16',
                    '198.19.0.0/16'
                ],
                proxyFakeIpCidrs: ['198.18.0.0/15']
            },
            ok: true
        },
        // 首尾均落在 nonGlobalIpv4（198.16/16 与 198.19/16），但中间 198.17-198.18 存在公网空洞 -> 必须被闭区间检查拒绝
        {
            name: 'reject-middle-gap-endpoints-covered',
            raw: {
                ...baseRawPolicy,
                nonGlobalIpv4Cidrs: [
                    ...baseRawPolicy.nonGlobalIpv4Cidrs.filter(c => c !== '198.18.0.0/15'),
                    '198.16.0.0/16',
                    '198.19.0.0/16'
                ],
                proxyFakeIpCidrs: ['198.16.0.0/14']
            },
            ok: false
        },
        ...['0.0.0.0/0', '0.0.0.0/1', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
            '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4', '240.0.0.0/4',
            '::/0', '2000::/3', 'fc00::/7', '::/128', '::1/128', 'fe80::/10', 'ff00::/8',
            '::ffff:0:0/96', '198.18.0.1/15', '8.8.8.0/24', '2000::/1२', '１98.18.0.0/15'
        ].map(badCidr => ({
            name: `reject-fake-cidr-${badCidr}`,
            raw: { ...baseRawPolicy, proxyFakeIpCidrs: [badCidr] },
            ok: false
        })),
        {
            name: 'reject-unicode-global-unicast-prefix',
            raw: { ...baseRawPolicy, ipv6GlobalUnicastCidr: '2000::/1२' },
            ok: false
        }
    ];

    const proxyEnvCases = [
        { env: {}, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://127.0.0.1:7897' }, expected: true, url: 'http://127.0.0.1:7897' },
        { env: { https_proxy: 'https://proxy.example:8443', HTTP_PROXY: 'socks5://127.0.0.1:1080' }, expected: true, url: 'https://proxy.example:8443' },
        // 高优先级变量为 socks5 或非法 URL 时立即拒绝，绝不向低优先级 HTTP_PROXY 穿透
        { env: { HTTPS_PROXY: 'socks5://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { https_proxy: 'socks5://127.0.0.1:7897', HTTPS_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { https_proxy: 'not-a-valid-url', HTTPS_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://127.0.0.1:99999', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://127.0.0.1:abc', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http:///127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://proxy\xa0.local:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://proxy\u3000.local:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://proxy\uff3c.local:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://proxy\uff3b\uff3d.local:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://-proxy.local:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://proxy..local:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://proxy%2eexample:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://proxy.local%20:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://[::1%25eth0]:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { HTTPS_PROXY: 'http://user%40:pass%2F@proxy.example:7897' }, expected: true, url: 'http://user%40:pass%2F@proxy.example:7897' },
        { env: { HTTPS_PROXY: ' http://127.0.0.1:7897 ', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { https_proxy: '   ', HTTPS_PROXY: 'http://127.0.0.1:7897' }, expected: false, url: null },
        { env: { https_proxy: '', HTTPS_PROXY: 'http://127.0.0.1:7897' }, expected: true, url: 'http://127.0.0.1:7897' },
        { env: { ALL_PROXY: 'socks5h://127.0.0.1:7897', HTTP_PROXY: 'http://127.0.0.1:7897' }, expected: true, url: 'http://127.0.0.1:7897' }
    ];

    const nodeSingleResults = singleIpVectors.map(([ip, expectedGlobal, expectedFake]) => {
        const actualGlobal = policyModule.isGloballyRoutableIp(ip);
        const actualFake = policyModule.isProxyFakeIp(ip);
        assert.equal(actualGlobal, expectedGlobal, `Node isGloballyRoutableIp(${ip})`);
        assert.equal(actualFake, expectedFake, `Node isProxyFakeIp(${ip})`);
        return { ip, global: actualGlobal, fake: actualFake };
    });

    const nodeDnsResults = dnsSetCases.map(testCase => {
        try {
            const res = policyModule.selectValidatedPublicIp(testCase.addresses, {
                proxyEnabled: testCase.proxyEnabled
            });
            assert.equal(testCase.ok, true, `Node expected failure for ${JSON.stringify(testCase)}`);
            assert.equal(res.mode, testCase.mode);
            assert.equal(res.address, testCase.address);
            return { ok: true, mode: res.mode, address: res.address, addresses: res.addresses };
        } catch (err) {
            assert.equal(testCase.ok, false, `Node unexpected error for ${JSON.stringify(testCase)}: ${err.message}`);
            assert.equal(err.code, testCase.code);
            if (testCase.offendingIp !== undefined) {
                assert.equal(err.offendingIp, testCase.offendingIp);
            }
            return { ok: false, code: err.code, offendingIp: err.offendingIp ?? null };
        }
    });

    const nodeSchemaResults = schemaCases.map(item => {
        try {
            policyModule.compilePublicNetworkPolicy(item.raw);
            assert.equal(item.ok, true, `Node schema case ${item.name} should have failed`);
            return { name: item.name, ok: true, code: null };
        } catch (err) {
            assert.equal(item.ok, false, `Node schema case ${item.name} failed unexpectedly: ${err.message}`);
            assert(err instanceof policyModule.PublicNetworkPolicyError);
            assert.equal(err.code, 'PUBLIC_NETWORK_POLICY_SCHEMA', item.name);
            return { name: item.name, ok: false, code: err.code };
        }
    });

    const nodeProxyEnvResults = proxyEnvCases.map(item => {
        const actualBool = policyModule.hasHttpConnectProxy(item.env);
        const actualUrl = policyModule.resolveHttpConnectProxyUrl(item.env);
        assert.equal(actualBool, item.expected);
        assert.equal(actualUrl, item.url);
        return { hasProxy: actualBool, url: actualUrl };
    });

    const pythonCode = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(REPO_ROOT, 'scripts'))})
import public_network_policy as pnp

payload = json.loads(sys.argv[1])
single_out = []
for ip, _, _ in payload['singleIpVectors']:
    single_out.append({
        'ip': ip,
        'global': pnp.isGloballyRoutableIp(ip),
        'fake': pnp.isProxyFakeIp(ip),
    })

dns_out = []
for case in payload['dnsSetCases']:
    try:
        res = pnp.selectValidatedPublicIp(case['addresses'], {'proxyEnabled': case['proxyEnabled']})
        dns_out.append({
            'ok': True,
            'mode': res['mode'],
            'address': res['address'],
            'addresses': res['addresses'],
        })
    except pnp.PublicNetworkPolicyError as exc:
        dns_out.append({
            'ok': False,
            'code': exc.code,
            'offendingIp': exc.offending_ip,
        })

schema_out = []
for item in payload['schemaCases']:
    try:
        pnp.compilePublicNetworkPolicy(item['raw'])
        schema_out.append({'name': item['name'], 'ok': True, 'code': None})
    except pnp.PublicNetworkPolicyError as exc:
        schema_out.append({'name': item['name'], 'ok': False, 'code': exc.code})

proxy_out = []
for item in payload['proxyEnvCases']:
    proxy_out.append({
        'hasProxy': pnp.hasHttpConnectProxy(item['env']),
        'url': pnp.resolveHttpConnectProxyUrl(item['env']),
    })

print(json.dumps({
    'single': single_out,
    'dns': dns_out,
    'schema': schema_out,
    'proxy': proxy_out,
}))
`;
    const env = { ...process.env };
    delete env.CODEX_SANDBOX;
    const pyRun = spawnSync(
        'bash',
        [
            path.join(REPO_ROOT, 'scripts', 'python-runtime.sh'),
            '-c',
            pythonCode,
            JSON.stringify({ singleIpVectors, dnsSetCases, schemaCases, proxyEnvCases })
        ],
        { cwd: REPO_ROOT, env, encoding: 'utf8', timeout: 10000 }
    );
    assert.equal(pyRun.status, 0, pyRun.stderr);
    const pyParsed = JSON.parse(pyRun.stdout);
    assert.deepEqual(pyParsed.single, nodeSingleResults);
    assert.deepEqual(pyParsed.dns, nodeDnsResults);
    assert.deepEqual(pyParsed.schema, nodeSchemaResults);
    assert.deepEqual(pyParsed.proxy, nodeProxyEnvResults);
});

test('deep-analyzer.js 正确传递 proxyEnabled、遵守显式 proxyEnabled:false 约束，且策略异常立即 Fail-Closed 不降级重试', async () => {
    const fakeLookup = async () => [{ address: '198.18.0.9', family: 4 }];
    const mixedLookup = async () => [{ address: '198.18.0.9', family: 4 }, { address: '127.0.0.1', family: 4 }];

    await assert.rejects(
        () => deepAnalyzer.validatePublicHttpUrl('https://demo.example.org/page', { lookupImpl: fakeLookup }),
        /非公网 IP: 198\.18\.0\.9/
    );

    const validated = await deepAnalyzer.validatePublicHttpUrl('https://demo.example.org/page', {
        proxyEnabled: true,
        lookupImpl: fakeLookup
    });
    assert.equal(validated.validatedHostname, 'demo.example.org');
    assert.equal(validated.validatedAddress, '198.18.0.9');
    assert.equal(validated.validationMode, 'proxy_fake_ip');

    await assert.rejects(
        () => deepAnalyzer.validatePublicHttpUrl('https://demo.example.org/page', {
            proxyEnabled: true,
            lookupImpl: mixedLookup
        }),
        /非公网 IP: 127\.0\.0\.1/
    );

    await assert.rejects(
        () => deepAnalyzer.validatePublicHttpUrl('https://198.18.0.9/page', { proxyEnabled: true }),
        /URL 指向非公网 IP: 198\.18\.0\.9/
    );

    // 显式 { proxyEnabled: false } 时，即使外层环境变量设置了 HTTPS_PROXY，内层默认 requestPinnedPublicHttps 也绝不穿透使用该代理
    const savedHttpsProxy = process.env.HTTPS_PROXY;
    try {
        process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
        const seenValidateOptions = [];
        await assert.rejects(
            () => deepAnalyzer.verifyApiReaderResourceUrl('https://8.8.8.8/repo', {
                proxyEnabled: false,
                validateUrlImpl: async (raw, opts) => {
                    seenValidateOptions.push(opts);
                    return Object.assign(new URL(raw), {
                        validatedAddress: '8.8.8.8',
                        validatedHostname: '8.8.8.8'
                    });
                }
            }),
            err => err.code === 'PROXY_CONFIG_ERROR'
        );
        // 外层与内层两次校验拿到的 proxyEnabled 都必须严格为 false
        assert.deepEqual(seenValidateOptions, [{ proxyEnabled: false }, { proxyEnabled: false }]);
    } finally {
        if (savedHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = savedHttpsProxy;
    }

    // PUBLIC_NETWORK_POLICY_* 安全策略配置故障在四大调用链路中均必须立即原样抛出（Fail-Closed），不重试、不降级
    const policyFault = new policyModule.PublicNetworkPolicyError(
        '模拟策略文件损坏',
        'PUBLIC_NETWORK_POLICY_SCHEMA'
    );

    await assert.rejects(
        () => deepAnalyzer.verifyApiReaderResourceUrl('https://github.com/example/repo', {
            validateUrlImpl: async () => { throw policyFault; }
        }),
        err => err === policyFault
    );

    await assert.rejects(
        () => deepAnalyzer.verifyApiReaderResourceUrl('https://github.com/example/repo', {
            validateUrlImpl: async raw => new URL(raw),
            requestImpl: async () => { throw policyFault; }
        }),
        err => err === policyFault
    );

    let imageAttempts = 0;
    await assert.rejects(
        () => deepAnalyzer.downloadImageBase64('https://8.8.8.8/uncached-policy-fault-test.png', 3, 1024 * 1024, async () => {
            imageAttempts += 1;
            throw policyFault;
        }),
        err => err === policyFault
    );
    assert.equal(imageAttempts, 1, 'PUBLIC_NETWORK_POLICY_* 故障必须首轮立即失败，禁止睡眠重试');

    await assert.rejects(
        () => deepAnalyzer.downloadImagesSerial(
            ['https://8.8.8.8/serial-policy-fault-test.png'],
            3,
            1024 * 1024,
            2 * 1024 * 1024,
            { downloadImageDetailed: async () => { throw policyFault; } }
        ),
        err => err === policyFault
    );

    await assert.rejects(
        () => deepAnalyzer.checkDemoPageForOpensource('https://demo.example.org/page', {
            detectProxyImpl: () => 'http://127.0.0.1:7897',
            validateUrlImpl: async () => { throw policyFault; }
        }),
        err => err === policyFault
    );

    // checkDemoPageForOpensource 向内层 requestImpl 透传 { validateUrlImpl, detectProxyImpl }
    const demoValidateFn = async raw => new URL(raw);
    const demoDetectProxyFn = () => 'http://127.0.0.1:7897';
    const seenDemoDeps = [];
    const demoLinks = await deepAnalyzer.checkDemoPageForOpensource('https://demo.example.org/page', {
        validateUrlImpl: demoValidateFn,
        detectProxyImpl: demoDetectProxyFn,
        requestImpl: async (_url, _reqOpts, deps) => {
            seenDemoDeps.push(deps);
            return {
                status: 200,
                headers: { get: name => (name === 'content-type' ? 'text/html' : null) },
                arrayBuffer: async () => Buffer.from('<a href="https://github.com/org/repo">code</a>', 'utf8')
            };
        }
    });
    assert.deepEqual(demoLinks, ['https://github.com/org/repo']);
    assert.equal(seenDemoDeps.length, 1);
    assert.equal(seenDemoDeps[0].validateUrlImpl, demoValidateFn);
    assert.equal(seenDemoDeps[0].detectProxyImpl, demoDetectProxyFn);

    // buildApiReaderResourceIdentity 的仓库文档分支遇到 PUBLIC_NETWORK_POLICY_* 必须原样抛出（不吞为 null 警告）
    await assert.rejects(
        () => deepAnalyzer.buildApiReaderResourceIdentity(
            [
                '## 开源详情',
                '- 代码：https://github.com/example/repo',
                '- 模型权重：论文中未提及',
                '- 数据集：论文中未提及',
                '- Demo：论文中未提及',
                '- 复现材料：论文中未提及',
                '- 论文中引用的开源项目：未提及'
            ].join('\n'),
            'Code is available at https://github.com/example/repo.',
            {},
            {
                paper: {
                    sources: ['huggingface'],
                    hf_github_repo: 'https://github.com/example/repo'
                },
                validateUrlImpl: async raw => new URL(raw),
                requestImpl: async () => ({ status: 200, headers: { get: () => null } }),
                documentationInspector: async () => { throw policyFault; }
            }
        ),
        err => err === policyFault
    );
});

test('workflow-implementation-files 依赖闭包纳入 public-network-policy 与 config/public-network-policy.json 且不污染无关入口', t => {
    const deepClosure = collectWorkflowImplementationFiles({
        root: REPO_ROOT,
        entryFiles: ['scripts/deep-analyzer.js']
    });
    assert(deepClosure.includes('scripts/lib/public-network-policy.js'));
    assert(deepClosure.includes('config/public-network-policy.json'));

    const publishClosure = collectWorkflowImplementationFiles({
        root: REPO_ROOT,
        entryFiles: ['scripts/publish-to-blog.py']
    });
    assert(publishClosure.includes('scripts/public_network_policy.py'));
    assert(publishClosure.includes('config/public-network-policy.json'));

    const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(GUARD_ROOT, 'closure-isolation-')));
    t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
    fs.mkdirSync(path.join(tempRoot, 'scripts', 'lib'), { recursive: true });
    fs.copyFileSync(
        path.join(REPO_ROOT, 'scripts', 'lib', 'workflow-implementation-files.js'),
        path.join(tempRoot, 'scripts', 'lib', 'workflow-implementation-files.js')
    );
    fs.writeFileSync(path.join(tempRoot, 'scripts', 'unrelated.js'), "'use strict';\n", 'utf8');
    const unrelatedClosure = collectWorkflowImplementationFiles({
        root: tempRoot,
        entryFiles: ['scripts/unrelated.js']
    });
    assert.deepEqual(unrelatedClosure, [
        'scripts/lib/workflow-implementation-files.js',
        'scripts/unrelated.js'
    ]);
});
