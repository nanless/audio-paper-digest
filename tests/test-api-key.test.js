const { describe, it } = require('node:test');
const assert = require('node:assert');

const {
    parseArgs,
    resolveApiKeyTestConfig
} = require('../scripts/test-api-key.js');

describe('test-api-key secondary account boundary', () => {
    const primaryGo = {
        PAPER_ANALYZER_ENDPOINT: 'https://opencode.ai/zen/go/v1',
        PAPER_ANALYZER_API_KEY: 'primary-key',
        PAPER_ANALYZER_FALLBACK_API_KEYS: 'primary-fallback-key',
        PAPER_ANALYZER_MODEL: 'muse-spark-1.2-contributor',
        PAPER_ANALYZER_SECONDARY_MODEL: 'muse-spark-1.2-contributor'
    };

    it('参数解析只接受主模型默认或 --secondary', () => {
        assert.deepStrictEqual(parseArgs([]), { secondary: false });
        assert.deepStrictEqual(parseArgs(['--secondary']), { secondary: true });
        assert.throws(() => parseArgs(['--unknown']), /未知参数/);
    });

    it('同一 canonical OpenCode Go 服务继承主账号池', () => {
        const config = resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://opencode.ai/zen/go/v1/responses'
        }, true);
        assert.strictEqual(config.key, 'primary-key');
        assert.deepStrictEqual(config.apiKeys, ['primary-key', 'primary-fallback-key']);
    });

    it('主账号池将第三顺位追加在原备用账号之后', () => {
        const config = resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_TERTIARY_FALLBACK_API_KEY: 'primary-third-key'
        }, false);
        assert.deepStrictEqual(config.apiKeys, [
            'primary-key',
            'primary-fallback-key',
            'primary-third-key'
        ]);
    });

    it('Go 到非 Go 且无显式 secondary key 时 typed fail-closed', () => {
        assert.throws(() => resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://api.example.com/v1',
            PAPER_ANALYZER_SECONDARY_MODEL: 'image-model'
        }, true), error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
            && /必须显式配置 PAPER_ANALYZER_SECONDARY_API_KEY/.test(error.message));
    });

    it('主非 Go 到副 Go 且无显式 secondary key 时 typed fail-closed', () => {
        assert.throws(() => resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_ENDPOINT: 'https://api.primary.example/v1',
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://opencode.ai/zen/go/v1'
        }, true), error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
            && /必须显式配置 PAPER_ANALYZER_SECONDARY_API_KEY/.test(error.message));
    });

    it('不同服务显式 secondary fallback 但缺 secondary key 时 typed fail-closed', () => {
        assert.throws(() => resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://api.example.com/v1',
            PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: 'secondary-fallback-key'
        }, true), error => error.code === 'LLM_ACCOUNT_POOL_CONFIG_ERROR'
            && error.retryable === false
            && /必须显式配置 PAPER_ANALYZER_SECONDARY_API_KEY/.test(error.message));
    });

    it('显式 secondary key 不继承主池，并可形成自己的同服务池', () => {
        const single = resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://api.example.com/v1',
            PAPER_ANALYZER_SECONDARY_API_KEY: 'secondary-key'
        }, true);
        assert.deepStrictEqual(single.apiKeys, ['secondary-key']);

        const pooled = resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://opencode.ai/zen/go/v1',
            PAPER_ANALYZER_SECONDARY_API_KEY: 'secondary-key',
            PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: 'secondary-fallback-key'
        }, true);
        assert.deepStrictEqual(pooled.apiKeys, ['secondary-key', 'secondary-fallback-key']);

        const nonGoToGo = resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_ENDPOINT: 'https://api.primary.example/v1',
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://opencode.ai/zen/go/v1',
            PAPER_ANALYZER_SECONDARY_API_KEY: 'secondary-go-key'
        }, true);
        assert.deepStrictEqual(nonGoToGo.apiKeys, ['secondary-go-key']);
    });

    it('未配置 secondary model 时不因遗留 endpoint/fallback 配置误报', () => {
        const config = resolveApiKeyTestConfig({
            ...primaryGo,
            PAPER_ANALYZER_SECONDARY_MODEL: '',
            PAPER_ANALYZER_SECONDARY_ENDPOINT: 'https://api.example.com/v1',
            PAPER_ANALYZER_SECONDARY_FALLBACK_API_KEYS: 'orphan-fallback-key'
        }, true);
        assert.strictEqual(config.model, '');
        assert.deepStrictEqual(config.apiKeys, ['primary-key']);
    });
});
