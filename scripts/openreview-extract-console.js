/**
 * OpenReview ICML 2026 Paper Extractor
 * 
 * 在 OpenReview ICML 2026 页面浏览器控制台粘贴运行，提取所有论文 ID 和 PDF 链接。
 * 结果会自动下载为 JSON 文件。
 * 
 * 使用方法:
 * 1. 打开 https://openreview.net/group?id=ICML.cc/2026/Conference#tab-accept-regular
 * 2. 按 F12 打开开发者工具，切换到 Console 标签
 * 3. 粘贴以下全部代码，按回车运行
 * 4. 等待自动下载 JSON 文件（约5-10分钟，取决于论文数量）
 * 5. 把下载的 JSON 文件放到项目 data/ 目录下
 */

(async function() {
    const API_BASE = 'https://api2.openreview.net';
    const INVITATION = 'ICML.cc/2026/Conference/-/Submission';
    const CATEGORIES = [
        { venue: 'ICML 2026 regular', label: 'regular' },
        { venue: 'ICML 2026 spotlight', label: 'spotlight' },
        { venue: 'ICML 2026 oral', label: 'oral' },
    ];

    const allPapers = [];
    const seen = new Set();

    async function fetchPage(venue, offset = 0) {
        const url = `${API_BASE}/notes?invitation=${encodeURIComponent(INVITATION)}&content.venue=${encodeURIComponent(venue)}&limit=1000&offset=${offset}&sort=cdate:desc&details=presentation`;
        const resp = await fetch(url, { credentials: 'include' });
        const data = await resp.json();
        return data;
    }

    for (const cat of CATEGORIES) {
        console.log(`\n📥 Fetching ${cat.label} papers...`);
        let offset = 0;
        while (true) {
            const data = await fetchPage(cat.venue, offset);
            const notes = data.notes || [];
            if (notes.length === 0) break;
            
            let count = 0;
            for (const note of notes) {
                const c = note.content || {};
                const paperId = note.id || note.forum;
                if (seen.has(paperId)) continue;
                seen.add(paperId);
                
                const paper = {
                    id: paperId,
                    title: c.title || '',
                    authors: c.authors || [],
                    authorids: c.authorids || [],
                    abstract: c.abstract || '',
                    pdf: c.pdf || '',
                    venue: c.venue || cat.venue,
                    venueid: c.venueid || '',
                    keywords: c.keywords || [],
                    tldr: c.tldr || '',
                    category: cat.label,
                    forum_url: `https://openreview.net/forum?id=${paperId}`
                };
                allPapers.push(paper);
                count++;
            }
            
            console.log(`  ${cat.label}: ${allPapers.length} papers so far (fetched ${offset + notes.length})`);
            offset += notes.length;
            
            if (notes.length < 1000) break;
            await new Promise(r => setTimeout(r, 500));
        }
    }

    console.log(`\n✅ Total: ${allPapers.length} papers`);

    // Download as JSON
    const output = {
        conference: 'ICML 2026',
        source: 'OpenReview',
        count: allPapers.length,
        fetched_at: new Date().toISOString(),
        papers: allPapers
    };
    
    const blob = new Blob([JSON.stringify(output, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'icml2026_openreview_papers.json';
    a.click();
    
    console.log('📥 下载已开始: icml2026_openreview_papers.json');
    console.log(`   共 ${allPapers.length} 篇论文`);
    console.log(`   带PDF: ${allPapers.filter(p => p.pdf).length} 篇`);
    console.log(`   带摘要: ${allPapers.filter(p => p.abstract).length} 篇`);
})();
