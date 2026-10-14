'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// A copied workspace still needs the real Git objects referenced by its Prompt
// evidence index. Keep a private empty repository with an actual local alternate;
// do not restore retired files or replace any Prompt hashes.
function installFixtureGitObjectStore(folder, project = path.resolve(__dirname, '../..')) {
    const target = fs.realpathSync(folder), source = fs.realpathSync(project);
    if (target === source || fs.existsSync(path.join(target, '.git'))) {
        throw new Error('Fixture Git evidence requires a new isolated workspace');
    }
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
    const options = { env, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] };
    const objects = fs.realpathSync(execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects',
        '-C', source, 'rev-parse', '--path-format=absolute', '--git-path', 'objects'], options).trim());
    if (!fs.statSync(objects).isDirectory() || /[\r\n]/.test(objects)) {
        throw new Error('Fixture Git object store is not a real local directory');
    }
    execFileSync('git', ['--no-lazy-fetch', '--no-replace-objects', 'init', '--quiet', target], options);
    fs.writeFileSync(path.join(target, '.git/objects/info/alternates'), objects + '\n', { mode: 0o600 });
    return target;
}

module.exports = { installFixtureGitObjectStore };
