#!/usr/bin/env python3
"""Fetch all ICML 2026 accepted papers from OpenReview API (with auth)"""
import subprocess, sqlite3, shutil, os, re, json, hashlib, time, sys
from Crypto.Cipher import AES
from curl_cffi.requests import Session

# --- Cookie decryption ---
result = subprocess.run(
    ['security', 'find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
    capture_output=True, text=True
)
chrome_key = result.stdout.strip()
salt = b'saltysalt'
aes_key = hashlib.pbkdf2_hmac('sha1', chrome_key.encode(), salt, 1003, 16)

def decrypt_cookie(encrypted_value):
    if not encrypted_value or len(encrypted_value) <= 19:
        return ''
    iv = encrypted_value[3:19]
    ciphertext = encrypted_value[19:]
    try:
        cipher = AES.new(aes_key, AES.MODE_CBC, iv)
        decrypted = cipher.decrypt(ciphertext)
        pad_len = decrypted[-1]
        if pad_len <= 16:
            decrypted = decrypted[:-pad_len]
        return decrypted.decode('utf-8', errors='replace')
    except:
        return ''

def extract_token(val):
    """Extract clean token from decrypted Chrome cookie value"""
    jwt_match = re.search(r'(eyJ[A-Za-z0-9._-]+)', val)
    if jwt_match:
        return jwt_match.group(1)
    return ''.join(c for c in val if ord(c) < 128 and c.isprintable()).strip()

# Get OpenReview auth cookies
tmp_db = '/tmp/chrome_cookies.sqlite'
profile = os.path.expanduser('~/Library/Application Support/Google/Chrome/Default/Cookies')
shutil.copy2(profile, tmp_db)
conn = sqlite3.connect(tmp_db)
cur = conn.cursor()
cur.execute("SELECT name, host_key, encrypted_value FROM cookies WHERE host_key LIKE '%openreview%' AND encrypted_value IS NOT NULL")
rows = cur.fetchall()
conn.close()

cookies = {}
for name, host, enc in rows:
    val = decrypt_cookie(enc)
    if not val:
        continue
    if name in ('openreview.accessToken', 'openreview.refreshToken'):
        token = extract_token(val)
        if token:
            cookies[name] = token
    elif name == 'GCILB':
        m = re.search(r'([0-9a-f]{16,})', val)
        if m:
            cookies[name] = m.group(1)
    else:
        clean = ''.join(c for c in val if ord(c) < 128 and c.isprintable())
        cookies[name] = clean.strip()

cookie_str = '; '.join(f'{n}={v}' for n, v in cookies.items() 
                        if v and all(ord(c) < 128 for c in v))
print(f'🔑 Auth cookies: {", ".join(cookies.keys())}')
print(f'   Token user: {cookies.get("openreview.user","unknown")[:60]}...')
print()

# --- Fetch papers ---
session = Session(impersonate="chrome131")
INVITATION = 'ICML.cc/2026/Conference/-/Submission'
CATEGORIES = [
    ('ICML 2026 regular', 'regular'),
    ('ICML 2026 spotlight', 'spotlight'),
    ('ICML 2026 oral', 'oral'),
]

all_papers = []
seen = set()

for venue, label in CATEGORIES:
    print(f'📥 Fetching {label} papers...')
    offset = 0
    while True:
        resp = session.get('https://api2.openreview.net/notes', params={
            'invitation': INVITATION,
            'content.venue': venue,
            'limit': 1000,
            'offset': offset,
            'sort': 'cdate:desc',
            'details': 'presentation'
        }, headers={'Cookie': cookie_str})
        
        if not resp.text.strip().startswith('{'):
            print(f'  ❌ Failed for {label} at offset {offset}: {resp.text[:100]}')
            break
        
        data = resp.json()
        notes = data.get('notes', [])
        if not notes:
            break
        
        count = 0
        for note in notes:
            c = note.get('content', {})
            pid = note.get('id') or note.get('forum')
            if pid in seen:
                continue
            seen.add(pid)
            
            paper = {
                'id': pid,
                'title': c.get('title', ''),
                'authors': c.get('authors', []),
                'authorids': c.get('authorids', []),
                'abstract': c.get('abstract', ''),
                'pdf': c.get('pdf', ''),
                'venue': c.get('venue', venue),
                'venueid': c.get('venueid', ''),
                'keywords': c.get('keywords', []),
                'tldr': c.get('tldr', ''),
                'category': label,
                'forum_url': f'https://openreview.net/forum?id={pid}'
            }
            all_papers.append(paper)
            count += 1
        
        print(f'  {label}: total={len(all_papers)} (fetched {offset+len(notes)})')
        offset += len(notes)
        
        if len(notes) < 1000:
            break
        time.sleep(0.3)

# Save
output = {
    'conference': 'ICML 2026',
    'source': 'OpenReview',
    'count': len(all_papers),
    'fetched_at': time.strftime('%Y-%m-%dT%H:%M:%S'),
    'papers': all_papers
}

os.makedirs('data', exist_ok=True)
output_file = 'data/icml2026_openreview_papers.json'
with open(output_file, 'w', encoding='utf-8') as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print(f'\n✅ Saved {len(all_papers)} papers to {output_file}')
print(f'   regular: {sum(1 for p in all_papers if p["category"]=="regular")}')
print(f'   spotlight: {sum(1 for p in all_papers if p["category"]=="spotlight")}')
print(f'   oral: {sum(1 for p in all_papers if p["category"]=="oral")}')
print(f'   with PDF: {sum(1 for p in all_papers if p["pdf"])}')
print(f'   with abstract: {sum(1 for p in all_papers if p["abstract"])}')
