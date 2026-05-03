#!/usr/bin/env node
/**
 * 批量重新提取 ICLR 论文图片（使用新版 pdf-extractor）
 * 不调用 LLM，只更新图片和 imageUrls
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const Config = require('./config.js');

const DATA_FILE = path.join(Config.CURRENT_DIR, 'iclr_2026_deep_analyzers.json');
const PDF_DIR = process.env.ICLR_PDF_DIR || path.join(__dirname, '../../iclr2026-paper-scraper/data/pdfs');
const IMAGE_DIR = process.env.PAPER_IMAGE_DIR || path.join(Config.CURRENT_DIR, 'iclr-images');

function runPdfExtractor(pdfPath) {
    return new Promise((resolve, reject) => {
        const proc = spawn('python3', [
            path.join(__dirname, 'pdf-extractor.py'),
            pdfPath,
            '--max-images', '20',
            '--max-text-chars', '1000'  // 只需要图片，减少文本提取时间
        ], {
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            timeout: 60000
        });

        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => { stderr += d.toString(); });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`pdf-extractor exited ${code}: ${stderr}`));
                return;
            }
            try {
                const result = JSON.parse(stdout);
                resolve(result);
            } catch (e) {
                reject(new Error(`JSON parse error: ${e.message}`));
            }
        });

        proc.on('error', (e) => reject(e));
    });
}

function saveImages(images, paperId) {
    const paperDir = path.join(IMAGE_DIR, String(paperId));
    if (!fs.existsSync(paperDir)) {
        fs.mkdirSync(paperDir, { recursive: true });
    }
    // 清除旧图片
    for (const f of fs.readdirSync(paperDir)) {
        fs.unlinkSync(path.join(paperDir, f));
    }

    const saved = [];
    for (const img of images) {
        const ext = img.format === 'jpeg' || img.format === 'jpg' ? 'jpg' : 'png';
        const filename = `${img.index}.${ext}`;
        const filepath = path.join(paperDir, filename);
        try {
            const buf = Buffer.from(img.base64, 'base64');
            fs.writeFileSync(filepath, buf);
            saved.push({
                index: img.index,
                page: img.page,
                width: img.width,
                height: img.height,
                format: ext,
                filename,
                url: `icassp-img://${paperId}/${filename}`
            });
        } catch (e) {
            console.log(`  [save] ${paperId}: failed ${filename} - ${e.message}`);
        }
    }
    return saved;
}

async function main() {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const papers = data.papers;

    console.log(`[reextract] 开始重新提取 ${papers.length} 篇论文的图片`);
    console.log(`[reextract] PDF 目录: ${PDF_DIR}`);
    console.log(`[reextract] 图片目录: ${IMAGE_DIR}`);

    let success = 0;
    let failed = 0;

    for (let i = 0; i < papers.length; i++) {
        const paper = papers[i];
        const fid = paper.paper_id || paper.forum_id;
        const pdfPath = path.join(PDF_DIR, `${fid}.pdf`);

        if (!fs.existsSync(pdfPath)) {
            console.log(`[${i + 1}/${papers.length}] ⚠️ ${fid}: PDF 不存在`);
            failed++;
            continue;
        }

        try {
            const result = await runPdfExtractor(pdfPath);
            const images = result.images || [];

            if (images.length === 0) {
                console.log(`[${i + 1}/${papers.length}] ⚠️ ${fid}: 未提取到图片`);
                paper.imageUrls = [];
                success++;
                continue;
            }

            const saved = saveImages(images, fid);
            const imageUrls = saved.map(s => s.url);

            // 更新论文数据
            paper.imageUrls = imageUrls;
            paper.allImageUrls = imageUrls;
            paper.imageCount = saved.length;

            const oldCount = paper.imageCount || 0;
            console.log(`[${i + 1}/${papers.length}] ✅ ${fid}: ${saved.length} 张图片 (旧: ${oldCount})`);
            success++;

            // 每10篇保存一次
            if ((i + 1) % 10 === 0) {
                fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
                console.log(`[reextract] 已保存进度 (${i + 1}/${papers.length})`);
            }
        } catch (e) {
            console.log(`[${i + 1}/${papers.length}] ❌ ${fid}: ${e.message}`);
            failed++;
        }
    }

    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    console.log(`[reextract] 完成: ${success} 成功, ${failed} 失败`);
}

main().catch(e => {
    console.error('[reextract] 错误:', e);
    process.exit(1);
});
