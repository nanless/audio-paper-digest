#!/usr/bin/env node
/**
 * 迁移脚本：从 deep_analyzer_input_output 中提取 ICASSP 图片
 * 保存到 data/current/icassp-images/{paperId}/ 目录
 */

const fs = require('fs');
const path = require('path');
const Config = require('./config.js');

const IO_DIR = path.join(Config.CURRENT_DIR, 'deep_analyzer_input_output');
const IMAGE_DIR = path.join(Config.CURRENT_DIR, 'icassp-images');

if (!fs.existsSync(IMAGE_DIR)) {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
}

const files = fs.readdirSync(IO_DIR).filter(f => f.endsWith('_input.json'));
console.log(`[migrate] 发现 ${files.length} 个 input 文件`);

let successCount = 0;
let failCount = 0;
let totalImages = 0;

for (const file of files) {
    const paperId = file.replace('_input.json', '');
    const inputPath = path.join(IO_DIR, file);

    try {
        const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
        const msgs = data.messages || [];

        const images = [];
        for (const m of msgs) {
            if (m.role === 'user') {
                const content = m.content || [];
                for (const c of content) {
                    if (c.type === 'image_url') {
                        const url = c.image_url?.url || '';
                        if (url.startsWith('data:')) {
                            const parts = url.split(',', 2);
                            if (parts.length === 2) {
                                const header = parts[0];
                                const mime = header.split(';')[0].replace('data:', '');
                                images.push({ mime, base64: parts[1] });
                            }
                        }
                    }
                }
            }
        }

        if (images.length === 0) {
            continue;
        }

        const paperDir = path.join(IMAGE_DIR, paperId);
        if (!fs.existsSync(paperDir)) {
            fs.mkdirSync(paperDir, { recursive: true });
        }

        for (let i = 0; i < images.length; i++) {
            const img = images[i];
            const ext = img.mime.includes('jpeg') || img.mime.includes('jpg') ? 'jpg' : 'png';
            const filename = `${i}.${ext}`;
            const filepath = path.join(paperDir, filename);
            const buf = Buffer.from(img.base64, 'base64');
            fs.writeFileSync(filepath, buf);
            totalImages++;
        }

        successCount++;
        console.log(`[migrate] ✅ ${paperId}: 提取 ${images.length} 张图片`);
    } catch (e) {
        failCount++;
        console.log(`[migrate] ❌ ${paperId}: ${e.message}`);
    }
}

console.log(`\n[migrate] 完成: ${successCount} 篇论文, ${totalImages} 张图片, ${failCount} 失败`);
