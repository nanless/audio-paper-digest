/* Isolated WebView E2E verification for Note Conflict Resolution UI Card (`note-conflicts-ui.js` + `native.js`).
 * Uses real `index.html`, `styles.css`, `native.js`, and `note-conflicts-ui.js` with explicit isolated bridge fixtures.
 * Never touches user personal data, Keychain, network, Zotero, or model endpoints. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { server, installFixture, primary, fixture, repo } = require('./DesktopUI.test.cjs');

const output = path.join(repo, 'apps/macos/.qa/note-conflict-ui');
fs.mkdirSync(output, { recursive: true });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

const secondary = fixture.papers.find(p => p.id !== primary.id);
const androidDevice = '00000000-0000-4000-8000-000000000022';
const tabletDevice = '00000000-0000-4000-8000-000000000033';

const results = [];
let browser, base;

async function runCase(name, fn, initial = {}) {
  const context = await browser.newContext({ viewport: { width: initial.width || 1360, height: initial.height || 880 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => pageErrors.push(e.message));
  try {
    await installFixture(page, initial);
    await page.goto(base);
    await page.waitForSelector('[data-library-open="arxiv:2610.27491"]');
    await fn(page);
    assert.deepEqual(pageErrors, [], 'unexpected pageerror');
    assert.deepEqual(await page.evaluate(() => window.__unimplemented), [], 'unexpected unimplemented bridge commands');
    results.push({ name, passed: true });
    console.log('PASS ' + name);
  } catch (err) {
    results.push({ name, passed: false, error: err.message });
    console.error('FAIL ' + name + ': ' + err.message);
    await page.screenshot({ path: path.join(output, 'failure-' + results.length + '.png') }).catch(() => {});
  } finally {
    await context.close();
  }
}

async function openPaperInReader(page, id = primary.id) {
  await page.locator(`[data-library-open="${id}"]`).click();
  await page.waitForFunction(target => window.paperDigestArchiveHTML?.()?.paperID === target, id);
}

(async () => {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PD_MAC_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });

    await runCase(
      'conflict card renders tab indicator on guide pane, multi-remote previews, empty-note placeholder, and strict zero-XSS DOM',
      async page => {
        // Verify bootstrap fetched personal.noteConflicts
        assert.ok(await page.evaluate(() => window.__calls.some(c => c.command === 'personal.noteConflicts')));

        await openPaperInReader(page, primary.id);
        // User starts on #guide-pane: #tab-note must already show the conflict indicator!
        assert.equal(await page.locator('#guide-pane').isVisible(), true);
        assert.equal(await page.locator('#tab-note-conflict-badge').isVisible(), true);
        assert.equal(await page.locator('#tab-note-conflict-badge').innerText(), '冲突');
        assert.equal(await page.locator('#tab-note').getAttribute('aria-label'), '研究笔记（待处理同步冲突）');

        await page.locator('#tab-note').click();
        await page.waitForSelector('#note-pane:not([hidden])');
        const card = page.locator('#note-conflict-card');
        assert.equal(await card.isVisible(), true);
        assert.equal(await card.getAttribute('role'), 'region');
        assert.equal(await card.getAttribute('aria-label'), '笔记同步冲突');

        // Card must sit above #note-editor without horizontal overflow
        const layout = await page.evaluate(() => {
          const c = document.getElementById('note-conflict-card').getBoundingClientRect();
          const e = document.getElementById('note-editor').getBoundingClientRect();
          return { cardBottom: c.bottom, editorTop: e.top, overflowX: document.documentElement.scrollWidth > innerWidth };
        });
        assert.ok(layout.cardBottom <= layout.editorTop + 1, JSON.stringify(layout));
        assert.equal(layout.overflowX, false);

        const headerText = await card.innerText();
        assert.match(headerText, /基准修订 r3/);
        assert.match(headerText, /本机与远端并发修改/);
        assert.match(headerText, /\+1 份其他设备远端版本/);

        // Expand collapsible preview and verify XSS payloads remain literal text
        await card.locator('details > summary').click();
        assert.equal(await card.locator('[data-conflict-local-preview]').textContent(), 'Mac 本机笔记 <img src=x onerror="window.__xss=1">');
        assert.equal(await card.locator('[data-conflict-remote-preview]').textContent(), 'Android 远端异文 <script>window.__xss=2</script>');
        assert.equal(await card.locator('[data-conflict-additional-preview]').textContent(), '（空笔记）');
        assert.match(await card.locator('[data-conflict-version="remote"]').innerText(), /r5/);
        assert.match(await card.locator('[data-conflict-version="remote"]').innerText(), /2026-11-18T09:30:00Z/);
        assert.match(await card.locator('[data-conflict-version="additional-remote"]').innerText(), /r2/);
        assert.equal(await card.locator('img, script').count(), 0);
        assert.equal(await page.evaluate(() => window.__xss), undefined);

        // Switching to a non-conflicted paper hides both #note-conflict-card and #tab-note badge
        await page.locator('#back').click();
        await openPaperInReader(page, secondary.id);
        assert.equal(await page.locator('#tab-note-conflict-badge').isVisible(), false);
        assert.equal(await page.locator('#tab-note').getAttribute('aria-label'), null);
        await page.locator('#tab-note').click();
        assert.equal(await page.locator('#note-conflict-card').isVisible(), false);
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: { [primary.id]: { text: 'Mac 本机笔记 <img src=x onerror="window.__xss=1">', revision: 3 } },
          sessions: [],
          readingState: {},
          annotations: {},
        },
        initialNoteConflicts: [
          {
            paperID: primary.id,
            localNote: 'Mac 本机笔记 <img src=x onerror="window.__xss=1">',
            remoteNote: 'Android 远端异文 <script>window.__xss=2</script>',
            remoteDeviceID: androidDevice,
            remoteRevision: 5,
            remoteUpdatedAt: '2026-11-18T09:30:00Z',
            additionalRemotes: [
              { remoteNote: '', remoteDeviceID: tabletDevice, remoteRevision: 2, remoteUpdatedAt: '2026-11-18T09:35:00Z' },
            ],
          },
        ],
      }
    );

    await runCase(
      'dirty #note-editor disables conflict resolution until draft is reverted to baseline, and manual save clears conflict',
      async page => {
        await openPaperInReader(page, primary.id);
        await page.locator('#tab-note').click();

        const keepBtn = page.locator('#note-conflict-keep-local');
        const adoptBtn = page.locator('#note-conflict-adopt-remote');
        const mergeBtn = page.locator('#note-conflict-merge-both');
        const dirtyGuard = page.locator('#note-conflict-dirty-guard');
        const revertBtn = page.locator('#note-conflict-revert-draft');

        assert.equal(await keepBtn.isDisabled(), false);
        assert.equal(await adoptBtn.isDisabled(), false);
        assert.equal(await mergeBtn.isDisabled(), false);
        assert.equal(await dirtyGuard.isVisible(), false);

        // Expand preview first; typing in #note-editor must keep <details> open while disabling resolution buttons!
        await page.locator('#note-conflict-card details > summary').click();
        assert.equal(await page.locator('#note-conflict-card details').evaluate(d => d.open), true);

        await page.evaluate(() => {
          const box = document.getElementById('note-editor');
          box.value = '未保存的手工临时草稿';
          box.dispatchEvent(new Event('input', { bubbles: true }));
        });

        assert.equal(await dirtyGuard.isVisible(), true);
        assert.equal(await keepBtn.isDisabled(), true);
        assert.equal(await adoptBtn.isDisabled(), true);
        assert.equal(await mergeBtn.isDisabled(), true);
        assert.equal(await page.locator('#note-conflict-card details').evaluate(d => d.open), true);

        // Revert draft before 700ms debounce fires: must cancel pending auto-save and re-enable resolution!
        const noteCallsBeforeRevert = await page.evaluate(() => window.__calls.filter(c => c.command === 'personal.note').length);
        await revertBtn.click();
        assert.equal(await page.locator('#note-editor').inputValue(), '冲突基线本机原稿');
        assert.equal(await dirtyGuard.isVisible(), false);
        assert.equal(await keepBtn.isDisabled(), false);
        assert.equal(await adoptBtn.isDisabled(), false);
        assert.equal(await mergeBtn.isDisabled(), false);
        await page.waitForTimeout(820);
        assert.equal(
          await page.evaluate(() => window.__calls.filter(c => c.command === 'personal.note').length),
          noteCallsBeforeRevert,
          'reverting draft must cancel pending noteTimer auto-save'
        );

        // Now type a deliberate manual override and let auto-save persist it: conflict must clear cleanly!
        await page.locator('#note-editor').fill('用户手工定稿并直接保存的新笔记');
        await page.waitForFunction(() => window.__fixture.personal.notes['arxiv:2610.27491']?.text === '用户手工定稿并直接保存的新笔记');
        await page.waitForFunction(() => document.getElementById('note-conflict-card').hidden === true);
        assert.equal(await page.locator('#tab-note-conflict-badge').isVisible(), false);
        assert.equal(await page.locator('#note-status').innerText(), '已保存到本机');
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: { [primary.id]: { text: '冲突基线本机原稿', revision: 4 } },
          sessions: [],
          readingState: {},
          annotations: {},
        },
        initialNoteConflicts: [
          {
            paperID: primary.id,
            localNote: '冲突基线本机原稿',
            remoteNote: '远端并发草稿',
            remoteDeviceID: androidDevice,
            remoteRevision: 2,
          },
        ],
      }
    );

    for (const [strategy, buttonSelector, expectedMergedText] of [
      [
        'merge_both',
        '#note-conflict-merge-both',
        `本机并发实验结论\n\n--- 云端并发版本（设备 ${androidDevice} · 版本 6）---\n远端并发补充推导`,
      ],
      ['keep_local', '#note-conflict-keep-local', '本机并发实验结论'],
      ['adopt_remote', '#note-conflict-adopt-remote', '远端并发补充推导'],
    ]) {
      await runCase(
        `resolution strategy ${strategy} sends exact dual-CAS payload, updates editor, clears conflict, and survives personal.synced`,
        async page => {
          await openPaperInReader(page, primary.id);
          await page.locator('#tab-note').click();
          await page.waitForSelector('#note-conflict-card:not([hidden])');

          await page.locator(buttonSelector).click();
          await page.waitForFunction(() => document.getElementById('note-conflict-card').hidden === true);

          const resolveCalls = await page.evaluate(() =>
            window.__calls.filter(c => c.command === 'personal.resolveNoteConflict').map(c => c.payload)
          );
          assert.deepEqual(resolveCalls, [
            {
              paperID: primary.id,
              strategy,
              expectedRevision: 7,
              expectedLocalNote: '本机并发实验结论',
            },
          ]);

          assert.equal(await page.locator('#note-editor').inputValue(), expectedMergedText);
          assert.equal(await page.locator('#note-status').innerText(), '已解决冲突并保存');
          assert.equal(await page.locator('#tab-note-conflict-badge').isVisible(), false);
          assert.equal(await page.evaluate(id => window.__fixture.personal.notes[id].revision, primary.id), 8);

          // Trigger an explicit subsequent personal.synced event and verify conflict stays cleared and text survives!
          await page.evaluate(() => window.dispatchEvent(new Event('personal.synced')));
          await page.waitForTimeout(80);
          assert.equal(await page.locator('#note-conflict-card').isVisible(), false);
          assert.equal(await page.locator('#tab-note-conflict-badge').isVisible(), false);
          assert.equal(await page.locator('#note-editor').inputValue(), expectedMergedText);
          assert.equal(await page.locator('#note-status').innerText(), '已解决冲突并保存');

          // Verify #notes-view index reflects the resolved note text
          await page.locator('[data-view="notes"]').click();
          await page.waitForSelector('#notes-view:not([hidden])');
          assert.ok((await page.locator('#all-notes').textContent()).includes(expectedMergedText.slice(0, 24)));
        },
        {
          initialPersonal: {
            favorites: [],
            reading: [],
            notes: { [primary.id]: { text: '本机并发实验结论', revision: 7 } },
            sessions: [],
            readingState: {},
            annotations: {},
          },
          initialNoteConflicts: [
            {
              paperID: primary.id,
              localNote: '本机并发实验结论',
              remoteNote: '远端并发补充推导',
              remoteDeviceID: androidDevice,
              remoteRevision: 6,
            },
          ],
        }
      );
    }

    await runCase(
      'empty local note conflict displays （空笔记）, resolves cleanly, and error recovery preserves conflict card',
      async page => {
        await openPaperInReader(page, primary.id);
        await page.locator('#tab-note').click();
        await page.locator('#note-conflict-card details > summary').click();
        assert.equal(await page.locator('[data-conflict-local-preview]').textContent(), '（空笔记）');

        // Simulate 2 MiB / CAS error on first click: conflict card must survive and surface error toast
        await page.evaluate(() => {
          window.__fixture.failResolveConflict = '合并后的笔记超过 2 MiB 上限，未截断或覆盖原稿；请精简内容后再保存';
        });
        await page.locator('#note-conflict-merge-both').click();
        await page.waitForFunction(() => document.getElementById('toast').textContent.includes('2 MiB'));
        assert.equal(await page.locator('#note-conflict-card').isVisible(), true);
        assert.equal(await page.locator('#note-conflict-merge-both').isDisabled(), false);

        // Clear failure and resolve: empty local + single non-empty remote merges cleanly to remote text
        await page.evaluate(() => {
          window.__fixture.failResolveConflict = false;
        });
        await page.locator('#note-conflict-merge-both').click();
        await page.waitForFunction(() => document.getElementById('note-conflict-card').hidden === true);
        assert.equal(await page.locator('#note-editor').inputValue(), '远端唯一非空笔记');
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: {},
          sessions: [],
          readingState: {},
          annotations: {},
        },
        initialNoteConflicts: [
          {
            paperID: primary.id,
            localNote: '',
            remoteNote: '远端唯一非空笔记',
            remoteDeviceID: androidDevice,
            remoteRevision: 1,
          },
        ],
      }
    );

    await runCase(
      'in-flight resolution blocks duplicate clicks, guards paper switching A -> B, and syncAll surfaces newly arrived conflicts',
      async page => {
        await openPaperInReader(page, primary.id);
        await page.locator('#tab-note').click();
        await page.evaluate(() => {
          window.__fixture.holdResolveConflict = true;
        });

        await page.locator('#note-conflict-adopt-remote').click();
        await page.waitForFunction(() => window.__fixture.pendingConflictResolves.length === 1);
        assert.equal(await page.locator('#note-conflict-adopt-remote').isDisabled(), true);

        // Programmatic second click while in-flight must not issue a second bridge call
        await page.evaluate(() => document.getElementById('note-conflict-merge-both').click());
        assert.equal(
          await page.evaluate(() => window.__calls.filter(c => c.command === 'personal.resolveNoteConflict').length),
          1
        );

        // Switch from Paper A to Paper B before Paper A's resolution finishes
        await page.locator('#back').click();
        await openPaperInReader(page, secondary.id);
        await page.locator('#tab-note').click();
        assert.equal(await page.locator('#note-editor').inputValue(), 'Paper B 独立原稿');

        // Release Paper A's held resolution: Paper B's editor must remain completely untouched!
        await page.evaluate(() => {
          window.__fixture.holdResolveConflict = false;
          window.__fixture.pendingConflictResolves.shift()();
        });
        await page.waitForTimeout(80);
        assert.equal(await page.locator('#note-editor').inputValue(), 'Paper B 独立原稿');
        assert.equal(await page.evaluate(id => window.__fixture.personal.notes[id].text, primary.id), 'Paper A 远端异文');

        // Now simulate cloud.syncAll introducing a conflict on Paper B while user is on library -> reader
        await page.locator('#back').click();
        await page.evaluate(
          ({ id, device }) => {
            window.__fixture.cloudAccount = 'sync@example.test';
            window.__fixture.noteConflicts = [
              { paperID: id, localNote: 'Paper B 独立原稿', remoteNote: 'Paper B 云端并发版本', remoteDeviceID: device, remoteRevision: 3 },
            ];
          },
          { id: secondary.id, device: androidDevice }
        );
        await page.locator('#sync-personal').click();
        await page.waitForFunction(() => !document.getElementById('sync-personal').disabled);
        await openPaperInReader(page, secondary.id);
        assert.equal(await page.locator('#tab-note-conflict-badge').isVisible(), true);
        await page.locator('#tab-note').click();
        assert.equal(await page.locator('#note-conflict-card').isVisible(), true);
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: {
            [primary.id]: { text: 'Paper A 本机原稿', revision: 2 },
            [secondary.id]: { text: 'Paper B 独立原稿', revision: 1 },
          },
          sessions: [],
          readingState: {},
          annotations: {},
        },
        initialNoteConflicts: [
          {
            paperID: primary.id,
            localNote: 'Paper A 本机原稿',
            remoteNote: 'Paper A 远端异文',
            remoteDeviceID: androidDevice,
            remoteRevision: 4,
          },
        ],
      }
    );

    await runCase(
      'dual-CAS guard also activates when editor value differs from conflict.localNote and personal.changed refreshes conflicts',
      async page => {
        await openPaperInReader(page, primary.id);
        await page.locator('#tab-note').click();
        assert.equal(await page.locator('#note-conflict-card').isVisible(), true);
        // Editor loaded '已变更的本机新文本', while stale conflict snapshot has localNote: '旧冲突基线文本'
        assert.equal(await page.locator('#note-conflict-dirty-guard').isVisible(), true);
        assert.equal(await page.locator('#note-conflict-merge-both').isDisabled(), true);
        assert.equal(await page.locator('#note-conflict-keep-local').isDisabled(), true);
        assert.equal(await page.locator('#note-conflict-adopt-remote').isDisabled(), true);

        await page.locator('#note-conflict-revert-draft').click();
        assert.equal(await page.locator('#note-editor').inputValue(), '旧冲突基线文本');
        assert.equal(await page.locator('#note-conflict-dirty-guard').isVisible(), false);
        assert.equal(await page.locator('#note-conflict-merge-both').isDisabled(), false);

        // Simulate personal.changed (workspace restore) clearing conflicts
        const conflictReadsBefore = await page.evaluate(
          () => window.__calls.filter(c => c.command === 'personal.noteConflicts').length
        );
        await page.evaluate(() => {
          window.__fixture.noteConflicts = [];
          window.dispatchEvent(new Event('personal.changed'));
        });
        await page.waitForFunction(
          prev =>
            document.getElementById('library-view').hidden === false &&
            window.__calls.filter(c => c.command === 'personal.noteConflicts').length > prev,
          conflictReadsBefore
        );
        await openPaperInReader(page, primary.id);
        assert.equal(await page.locator('#tab-note-conflict-badge').isVisible(), false);
        await page.locator('#tab-note').click();
        assert.equal(await page.locator('#note-conflict-card').isVisible(), false);
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: { [primary.id]: { text: '已变更的本机新文本', revision: 2 } },
          sessions: [],
          readingState: {},
          annotations: {},
        },
        initialNoteConflicts: [
          {
            paperID: primary.id,
            localNote: '旧冲突基线文本',
            remoteNote: '远端并发文本',
            remoteDeviceID: androidDevice,
            remoteRevision: 3,
          },
        ],
      }
    );

    await runCase(
      'in-flight resolve locks #note-editor.readOnly and #insert-citation, unlocks on finish, and never wipes a concurrent dirty draft',
      async page => {
        await openPaperInReader(page, primary.id);
        await page.locator('#tab-note').click();
        assert.equal(await page.locator('#note-editor').evaluate(el => el.readOnly), false);
        assert.equal(await page.locator('#insert-citation').isDisabled(), false);

        await page.evaluate(() => {
          window.__fixture.holdResolveConflict = true;
        });
        await page.locator('#note-conflict-merge-both').click();
        await page.waitForFunction(() => window.__fixture.pendingConflictResolves.length === 1);

        // Editor must be readOnly and citation button disabled while resolveNoteConflict is in-flight!
        assert.equal(await page.locator('#note-editor').evaluate(el => el.readOnly), true);
        assert.equal(await page.locator('#insert-citation').isDisabled(), true);
        await page.evaluate(() => document.getElementById('insert-citation').click());
        assert.equal(await page.locator('#note-editor').inputValue(), '本机原稿锁定验证');

        // Release normal resolution: editor unlocks and displays merged text
        await page.evaluate(() => {
          window.__fixture.holdResolveConflict = false;
          window.__fixture.pendingConflictResolves.shift()();
        });
        await page.waitForFunction(() => document.getElementById('note-conflict-card').hidden === true);
        assert.equal(await page.locator('#note-editor').evaluate(el => el.readOnly), false);
        assert.equal(await page.locator('#insert-citation').isDisabled(), false);

        // Now verify defensive onResolved !state.noteDirty preservation under programmatic dirty edit
        await page.evaluate(
          ({ id, device }) => {
            const currentText = window.__fixture.personal.notes[id].text;
            window.__fixture.noteConflicts = [
              { paperID: id, localNote: currentText, remoteNote: '第二轮远端异文', remoteDeviceID: device, remoteRevision: 8 },
            ];
            window.__fixture.holdResolveConflict = true;
            window.dispatchEvent(new Event('personal.synced'));
          },
          { id: primary.id, device: androidDevice }
        );
        await page.waitForSelector('#note-conflict-card:not([hidden])');
        await page.locator('#note-conflict-adopt-remote').click();
        await page.waitForFunction(() => window.__fixture.pendingConflictResolves.length === 1);

        // Simulate a programmatic dirty mutation landing while resolution reply is arriving
        await page.evaluate(() => {
          const editor = document.getElementById('note-editor');
          editor.value = '程序并发未保存草稿不可被静默抹除';
          editor.dispatchEvent(new Event('input', { bubbles: true }));
          window.__fixture.strictNoteRevision = true;
          window.__fixture.holdResolveConflict = false;
          window.__fixture.pendingConflictResolves.shift()();
        });
        // Concurrent dirty draft must survive onResolved AND auto-save cleanly atop the advanced revision!
        assert.equal(await page.locator('#note-editor').inputValue(), '程序并发未保存草稿不可被静默抹除');
        await page.waitForFunction(
          id => window.__fixture.personal.notes[id]?.text === '程序并发未保存草稿不可被静默抹除',
          primary.id
        );
        assert.equal(await page.locator('#note-status').innerText(), '已保存到本机');
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: { [primary.id]: { text: '本机原稿锁定验证', revision: 2 } },
          sessions: [],
          readingState: {},
          annotations: {},
        },
        initialNoteConflicts: [
          {
            paperID: primary.id,
            localNote: '本机原稿锁定验证',
            remoteNote: '远端并发版本',
            remoteDeviceID: androidDevice,
            remoteRevision: 4,
          },
        ],
      }
    );

    await runCase(
      'in-flight noteSaving disables #note-conflict-revert-draft, prevents split-brain overwrite when save succeeds, and preserves newer edits in applyNoteSave',
      async page => {
        await openPaperInReader(page, primary.id);
        await page.locator('#tab-note').click();

        // 1. Failed in-flight saveNote: revert button is disabled during saveNote, then re-enables and restores baseline cleanly
        await page.evaluate(() => {
          window.__fixture.holdNote = true;
          window.__fixture.failNote = true;
        });
        await page.locator('#note-editor').fill('保存中尝试回退的草稿');
        await page.waitForFunction(() => window.__fixture.pendingNotes.length === 1);
        assert.equal(await page.locator('#note-conflict-revert-draft').isDisabled(), true);

        await page.evaluate(() => {
          window.__fixture.holdNote = false;
          window.__fixture.pendingNotes.shift()();
        });
        await page.waitForFunction(() => document.getElementById('note-conflict-revert-draft').disabled === false);
        await page.locator('#note-conflict-revert-draft').click();
        assert.equal(await page.locator('#note-editor').inputValue(), '初始冲突基线');
        assert.equal(await page.locator('#note-conflict-dirty-guard').isVisible(), false);

        // 2. Successful in-flight saveNote + concurrent typing during saveNote (applyNoteSave divergence + zero false-clean baseline overwrite)
        await page.evaluate(() => {
          window.__fixture.failNote = false;
          window.__fixture.holdNote = true;
          window.__fixture.strictNoteRevision = true;
        });
        await page.locator('#note-editor').fill('第一版手工保存草稿');
        await page.waitForFunction(() => window.__fixture.pendingNotes.length === 1);
        assert.equal(await page.locator('#note-conflict-revert-draft').isDisabled(), true);

        // User continues typing while first personal.note is still in-flight!
        await page.evaluate(() => {
          const box = document.getElementById('note-editor');
          box.value = '第一版手工保存草稿 + 保存期间继续输入的新段落';
          // Deliberately test applyNoteSave's else{state.noteDirty=true} even if noteDirty were cleared
          window.__fixture.holdNote = false;
          window.__fixture.pendingNotes.shift()();
        });

        await page.waitForFunction(
          id => window.__fixture.personal.notes[id]?.text === '第一版手工保存草稿 + 保存期间继续输入的新段落',
          primary.id
        );
        assert.equal(await page.locator('#note-editor').inputValue(), '第一版手工保存草稿 + 保存期间继续输入的新段落');
        assert.equal(await page.locator('#note-conflict-card').isVisible(), false);
        assert.equal(await page.evaluate(id => window.__fixture.personal.notes[id].revision, primary.id), 5);

        // 3. Programmatic revert racing an in-flight personalFlush that succeeds and clears the conflict must NOT overwrite saved text
        await page.evaluate(
          ({ id, device }) => {
            const current = window.__fixture.personal.notes[id].text;
            window.__fixture.noteConflicts = [
              { paperID: id, localNote: current, remoteNote: '另一轮远端异文', remoteDeviceID: device, remoteRevision: 6 },
            ];
            window.dispatchEvent(new Event('personal.synced'));
          },
          { id: primary.id, device: androidDevice }
        );
        await page.waitForSelector('#note-conflict-card:not([hidden])');
        await page.evaluate(() => {
          window.__fixture.holdNote = true;
          const box = document.getElementById('note-editor');
          box.value = '批量刷新保存的定稿笔记';
          box.dispatchEvent(new Event('input', { bubbles: true }));
          window.__flushRace = window.paperDigestFlushPendingNote(true);
        });
        await page.waitForFunction(() => window.__fixture.pendingNotes.length === 1);
        assert.equal(await page.locator('#note-conflict-revert-draft').isDisabled(), true);
        // Even if listener were bypassed/invoked at microtask boundary before disabled took effect:
        await page.evaluate(async () => {
          const btn = document.getElementById('note-conflict-revert-draft');
          btn.disabled = false;
          btn.click();
          window.__fixture.holdNote = false;
          window.__fixture.pendingNotes.shift()();
          await window.__flushRace;
        });
        await page.waitForTimeout(50);
        assert.equal(await page.locator('#note-editor').inputValue(), '批量刷新保存的定稿笔记');
        assert.equal(await page.locator('#note-conflict-card').isVisible(), false);
        assert.equal(await page.locator('#note-status').innerText(), '已保存到本机');
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: { [primary.id]: { text: '初始冲突基线', revision: 3 } },
          sessions: [],
          readingState: {},
          annotations: {},
        },
        initialNoteConflicts: [
          {
            paperID: primary.id,
            localNote: '初始冲突基线',
            remoteNote: '远端异文版本',
            remoteDeviceID: androidDevice,
            remoteRevision: 2,
          },
        ],
      }
    );

    await runCase(
      'conflict without explicit baseRevision dynamically derives baseRevision from synced state.personal.notes',
      async page => {
        await openPaperInReader(page, primary.id);
        await page.locator('#tab-note').click();

        // Simulate a conflict entry without explicit baseRevision arriving alongside updated personal.snapshot (revision 9)
        await page.evaluate(
          ({ id, device }) => {
            window.__fixture.omitConflictBaseRevision = true;
            window.__fixture.personal.notes[id] = { text: '同步后的本机修订 9', revision: 9 };
            window.__fixture.noteConflicts = [
              { paperID: id, localNote: '同步后的本机修订 9', remoteNote: '远端并发修订', remoteDeviceID: device, remoteRevision: 4 },
            ];
            window.dispatchEvent(new Event('personal.synced'));
          },
          { id: primary.id, device: androidDevice }
        );

        await page.waitForSelector('#note-conflict-card:not([hidden])');
        assert.match(await page.locator('#note-conflict-card').innerText(), /基准修订 r9/);
        assert.equal(await page.locator('#note-conflict-keep-local').isDisabled(), false);

        await page.locator('#note-conflict-keep-local').click();
        await page.waitForFunction(() => document.getElementById('note-conflict-card').hidden === true);
        const lastResolve = await page.evaluate(() =>
          window.__calls.filter(c => c.command === 'personal.resolveNoteConflict').at(-1).payload
        );
        assert.deepEqual(lastResolve, {
          paperID: primary.id,
          strategy: 'keep_local',
          expectedRevision: 9,
          expectedLocalNote: '同步后的本机修订 9',
        });
      },
      {
        initialPersonal: {
          favorites: [],
          reading: [],
          notes: {},
          sessions: [],
          readingState: {},
          annotations: {},
        },
      }
    );
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    const failed = results.filter(r => !r.passed).length;
    fs.writeFileSync(
      path.join(output, 'result.json'),
      JSON.stringify(
        {
          scope: 'real WebView index.html + native.js + note-conflicts-ui.js with explicit isolated bridge fixtures',
          sourceSHA256: {
            'native.js': sha(fs.readFileSync(path.join(repo, 'apps/macos/Resources/native.js'))),
            'note-conflicts-ui.js': sha(fs.readFileSync(path.join(repo, 'apps/macos/Resources/note-conflicts-ui.js'))),
            'index.html': sha(fs.readFileSync(path.join(repo, 'apps/macos/Resources/index.html'))),
            'styles.css': sha(fs.readFileSync(path.join(repo, 'apps/macos/Resources/styles.css'))),
          },
          passed: results.length - failed,
          failed,
          results,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`NoteConflict UI: ${results.length - failed} passed; ${failed} failed`);
    if (failed) process.exitCode = 1;
  }
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
