'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

function createLocalPublishedBlog(folder) {
    const blog = path.join(folder, 'blog');
    const origin = path.join(folder, 'origin.git');
    fs.mkdirSync(blog);
    const git = (...args) => execFileSync('git', ['-C', blog, ...args], { stdio: 'pipe' });
    execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', '本地测试');
    const writeBlog = (name, value) => {
        const filename = path.join(blog, name);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, value);
    };
    const citation = JSON.stringify({ arxivId: '2610.00026' });
    const citationSha = crypto.createHash('sha256').update(citation).digest('hex');
    writeBlog('static/data/papers/2026-10-03/2610-00026/citation.json', citation);
    writeBlog('content/posts/2026-10-03-paper.md', `---
date: 2026-10-03
paper_digest_pipeline_owned: true
paper_digest_page_type: paper
draft: false
paper_digest_arxiv_id: "2610.00026"
paper_digest_sidecars: {"citation.json":{"sha256":"${citationSha}"}}
---
`);
    writeBlog('content/posts/2026-10-03.md', `---
date: 2026-10-03
draft: false
paper_digest_pipeline_owned: true
paper_digest_page_type: index
---
共分析 **1** 篇论文
[x](/posts/2026-10-03-paper)
`);
    git('add', '.'); git('commit', '-m', '本地正式页面');
    git('remote', 'add', 'origin', origin); git('push', '-u', 'origin', 'main');
    return blog;
}

module.exports = { createLocalPublishedBlog };
