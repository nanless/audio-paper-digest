#!/usr/bin/env node
/**
 * Fetch ICML 2026 papers from OpenReview using user's Chrome profile (preserves login)
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const USER_DATA_DIR = path.join(require('os').homedir(), 'Library/Application Support/Google/Chrome');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'icml2026_openreview_papers.json');

const INVITATION = 'ICML.cc/2026/Conference/-/Submission';
const CATEGORIES = [
    { venue: 'ICML 2026 regular', label: 'regular' },
    { venue: 'ICML 2026 spotlight', label: 'spotlight' },
    { venue: 'ICML 2026 oral', label: 'oral' },
];

async function fetchAllPapers(page) {
    const allPapers = [];
    const seen = new Set();

    for (const cat of CATEGORIES) {
        console.log(`\n📥 Fetching ${cat.label} papers...`);
        let offset = 0;
        
        while (true) {
            const url = `https://api2.openreview.net/notes?invitation=${encodeURIComponent(INVITATION)}&content.venue=${encodeURIComponent(cat.venue)}&limit=1000&offset=${offset}&sort=cdate:desc&details=presentation`;
            
            const result = await page.evaluate(async (url) => {
                const resp = await fetch(url, { credentials: 'include' });
                return await resp.json();
            }, url);
            
            const notes = result.notes || [];
            if (notes.length === 0) break;
            
            for (const note of notes) {
                const c = note.content || {};
                const paperId = note.id || note.forum;
                if (seen.has(paperId)) continue;
                seen.add(paperId);
                
                allPapers.push({
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
                });
            }
            
            console.log(`  ${cat.label}: ${allPapers.length} papers (fetched ${offset + notes.length})`);
            offset += notes.length;
            if (notes.length < 1000) break;
            
            await new Promise(r => setTimeout(r, 500));
        }
    }
    
    return allPapers;
}

async function main() {
    console.log('🚀 Launching Chrome with your profile (preserves OpenReview login)...');
    console.log('⚠️  Close Chrome first if it\'s running!\n');
    
    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: false,
        userDataDir: USER_DATA_DIR,
        args: [
            '--no-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--profile-directory=Default',
        ]
    });

    try {
        const pages = await browser.pages();
        const page = pages[0] || await browser.newPage();
        
        // Navigate to OpenReview to verify login
        console.log('📄 Checking OpenReview login...');
        await page.goto('https://openreview.net/group?id=ICML.cc/2026/Conference', { 
            waitUntil: 'networkidle2', timeout: 60000 
        });
        await new Promise(r => setTimeout(r, 3000));
        
        // Check if we're logged in (no challenge page)
        const pageContent = await page.content();
        if (pageContent.includes('Verifying your browser') || pageContent.includes('cf-turnstile')) {
            console.log('❌ Still getting Cloudflare challenge. You may need to solve it in the browser window.');
            console.log('   The browser window is open - please solve the challenge, then the script will continue.');
            console.log('   Waiting 60 seconds for you to solve...');
            await new Promise(r => setTimeout(r, 60000));
            
            // Check again
            const pageContent2 = await page.content();
            if (pageContent2.includes('Verifying your browser')) {
                console.log('❌ Challenge not solved. Exiting.');
                return;
            }
        }
        
        console.log('✅ Logged in successfully!\n');
        
        // Fetch all papers via API
        const papers = await fetchAllPapers(page);
        
        console.log(`\n✅ Total: ${papers.length} papers`);
        
        // Save
        const output = {
            conference: 'ICML 2026',
            source: 'OpenReview',
            count: papers.length,
            fetched_at: new Date().toISOString(),
            papers: papers
        };
        
        fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
        console.log(`📁 Saved to ${OUTPUT_FILE}`);
        
        const withPdf = papers.filter(p => p.pdf).length;
        const withAbstract = papers.filter(p => p.abstract).length;
        console.log(`   带PDF: ${withPdf}/${papers.length}`);
        console.log(`   带摘要: ${withAbstract}/${papers.length}`);
        
    } finally {
        console.log('\n🔒 Closing browser...');
        await browser.close();
    }
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
