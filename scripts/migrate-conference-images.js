#!/usr/bin/env node

/** Move already-published conference PNGs to the dedicated image repository. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const blogRepo = path.resolve(process.env.PAPER_DIGEST_BLOG_REPO ||
    path.join(os.homedir(), 'code/github_repos/audio-paper-digest-blog'));
const imageRepo = path.resolve(process.env.PAPER_DIGEST_IMAGE_REPO ||
    path.join(os.homedir(), 'code/github_repos/audio-paper-digest-images'));
const imageBaseUrl = (process.env.PAPER_DIGEST_IMAGE_BASE_URL ||
    'https://raw.githubusercontent.com/nanless/audio-paper-digest-images/main').replace(/\/$/, '');
const conferences = ['aistats-2026', 'uai-2026'];
const imageRef = /!\[([^\]]*)\]\((\/images\/conference\/(aistats-2026|uai-2026)\/([a-f0-9]{12})\/(figure-\d+\.png))\)/g;

function fail(message) {
  throw new Error(message);
}

function sameBytes(left, right) {
  return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function writeAtomic(filename, data) {
  const temporary = `${filename}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o644 });
  fs.renameSync(temporary, filename);
}

const postsDir = path.join(blogRepo, 'content/posts');
const changedPages = [];
const copiedAssets = [];
for (const conference of conferences) {
  const pageNames = fs.readdirSync(postsDir)
      .filter(name => name.startsWith(`conference-${conference}-`) && name.endsWith('.md'));
  if (pageNames.length === 0) fail(`未找到 ${conference} 单篇页面`);
  for (const pageName of pageNames) {
    const pagePath = path.join(postsDir, pageName);
    const before = fs.readFileSync(pagePath, 'utf8');
    let after = before;
    for (const match of before.matchAll(imageRef)) {
      const url = match[2];
      const conferenceId = match[3];
      const relativeAsset = `${conferenceId}/${match[4]}/${match[5]}`;
      const source = path.join(blogRepo, 'static/images/conference', relativeAsset);
      const target = path.join(imageRepo, relativeAsset);
      if (!fs.statSync(source).isFile() || fs.lstatSync(source).isSymbolicLink()) {
        fail(`会议图片源文件不安全或不存在: ${source}`);
      }
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
      if (fs.existsSync(target)) {
        if (!sameBytes(source, target)) fail(`拒绝覆盖图片仓库中的不同字节: ${target}`);
      } else {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        copiedAssets.push(relativeAsset);
      }
      const replacement = `${imageBaseUrl}/${relativeAsset}`;
      after = after.split(url).join(replacement);
    }
    if (after !== before) {
      writeAtomic(pagePath, after);
      changedPages.push(pageName);
    }
  }
}
console.log(JSON.stringify({status: 'migrated', changedPages, copiedAssets}, null, 2));
