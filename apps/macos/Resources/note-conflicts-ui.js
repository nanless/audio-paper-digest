// Pure-DOM WebView Note Conflict Resolution controller.
// Never uses innerHTML; all untrusted note text and device metadata are bound via textContent.
export function mountNoteConflicts({
  document = globalThis.document,
  state,
  call,
  getOwner,
  isCurrent,
  getEditorValue,
  setEditorValue,
  getEditorRevision,
  setEditorRevision,
  getNoteDirty,
  setNoteDirty,
  setNoteStatus,
  cancelPendingAutoSave,
  isNoteWriteInFlight,
  waitForPendingWrites,
  onResolved,
  onSnapshotSynced,
  onError,
}) {
  const conflicts = state.noteConflicts instanceof Map ? state.noteConflicts : new Map();
  state.noteConflicts = conflicts;

  let refreshSequence = 0;
  let conflictResolving = false;
  let resolvingPaperID = '';
  let resolvingPromise = null;
  let revertingDraft = false;
  let revertingPaperID = '';
  let renderedKey = '';
  let dirtyGuardNode = null;
  let revertButtonNode = null;
  let actionButtonNodes = [];
  const expandedKeys = new Set();

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function normalizeRemoteEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const remoteNote = typeof raw.remoteNote === 'string'
      ? raw.remoteNote
      : (typeof raw.text === 'string' ? raw.text : '');
    const remoteDeviceID = typeof raw.remoteDeviceID === 'string'
      ? raw.remoteDeviceID.trim()
      : (typeof raw.deviceID === 'string' ? raw.deviceID.trim() : '');
    const rawRev = Number.isSafeInteger(raw.remoteRevision) ? raw.remoteRevision : raw.revision;
    const remoteRevision = Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0;
    const remoteUpdatedAt = typeof raw.remoteUpdatedAt === 'string' && raw.remoteUpdatedAt.trim()
      ? raw.remoteUpdatedAt.trim()
      : '';
    return { remoteNote, remoteDeviceID, remoteRevision, remoteUpdatedAt };
  }

  function normalizeConflict(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const paperID = typeof raw.paperID === 'string' && raw.paperID.trim()
      ? raw.paperID.trim()
      : (typeof raw.paperId === 'string' && raw.paperId.trim() ? raw.paperId.trim() : '');
    if (!paperID) return null;
    const localNote = typeof raw.localNote === 'string' ? raw.localNote : '';
    const remoteNote = typeof raw.remoteNote === 'string' ? raw.remoteNote : '';
    const remoteDeviceID = typeof raw.remoteDeviceID === 'string'
      ? raw.remoteDeviceID.trim()
      : (typeof raw.remoteDeviceId === 'string' ? raw.remoteDeviceId.trim() : '');
    const remoteRevision = Number.isSafeInteger(raw.remoteRevision) && raw.remoteRevision >= 0
      ? raw.remoteRevision
      : 0;
    const remoteUpdatedAt = typeof raw.remoteUpdatedAt === 'string' && raw.remoteUpdatedAt.trim()
      ? raw.remoteUpdatedAt.trim()
      : '';
    const hasExplicitBaseRevision = Number.isSafeInteger(raw.baseRevision) && raw.baseRevision >= 0;
    const storedRev = state.personal?.notes?.[paperID]?.revision;
    const baseRevision = hasExplicitBaseRevision
      ? raw.baseRevision
      : (Number.isSafeInteger(storedRev) && storedRev >= 0 ? storedRev : 0);
    const additionalRemotes = Array.isArray(raw.additionalRemotes)
      ? raw.additionalRemotes.map(normalizeRemoteEntry).filter(Boolean)
      : [];
    return {
      paperID,
      localNote,
      remoteNote,
      remoteDeviceID,
      remoteRevision,
      remoteUpdatedAt,
      baseRevision,
      hasExplicitBaseRevision,
      additionalRemotes,
    };
  }

  function conflictKey(c) {
    if (!c) return '';
    const extras = c.additionalRemotes
      .map(r => `${r.remoteDeviceID}:${r.remoteRevision}:${r.remoteUpdatedAt}:${r.remoteNote}`)
      .join('|');
    return `${c.paperID}\u0000${c.baseRevision}\u0000${c.remoteDeviceID}\u0000${c.remoteRevision}\u0000${c.remoteUpdatedAt}\u0000${c.localNote}\u0000${c.remoteNote}\u0000${extras}`;
  }

  function expansionKey(c) {
    return `${c.paperID}|${c.baseRevision}|${c.remoteDeviceID}|${c.remoteRevision}|${c.additionalRemotes.length}`;
  }

  function applyConflicts(rawList) {
    const entries = Array.isArray(rawList)
      ? rawList
      : (Array.isArray(rawList?.conflicts) ? rawList.conflicts : []);
    conflicts.clear();
    for (const item of entries) {
      const normalized = normalizeConflict(item);
      if (normalized) conflicts.set(normalized.paperID, normalized);
    }
    render();
    return conflicts;
  }

  async function refresh(personalPromise = null) {
    const seq = ++refreshSequence;
    try {
      const [reply, personal] = await Promise.all([
        call('personal.noteConflicts', {}),
        personalPromise ? Promise.resolve(personalPromise) : Promise.resolve(undefined),
      ]);
      if (personal && typeof personal === 'object') {
        state.personal = personal;
      }
      if (seq !== refreshSequence) return conflicts;
      return applyConflicts(reply?.conflicts ?? reply);
    } catch {
      return conflicts;
    }
  }

  function currentConflict() {
    const id = state.paper?.id;
    if (!id) return null;
    const existing = conflicts.get(id);
    if (!existing) return null;
    if (!existing.hasExplicitBaseRevision) {
      const storedRev = state.personal?.notes?.[id]?.revision;
      const resolvedRev = Number.isSafeInteger(storedRev) && storedRev >= 0 ? storedRev : 0;
      if (resolvedRev !== existing.baseRevision) {
        return { ...existing, baseRevision: resolvedRev };
      }
    }
    return existing;
  }

  function isEditorLockedForCurrentPaper() {
    const activeID = state.paper?.id || '';
    if (!activeID) return false;
    return (conflictResolving && resolvingPaperID === activeID) ||
      (revertingDraft && revertingPaperID === activeID);
  }

  function syncEditorLock() {
    const locked = isEditorLockedForCurrentPaper();
    const editor = document.getElementById('note-editor');
    if (editor) editor.readOnly = locked;
    const insertCitation = document.getElementById('insert-citation');
    if (insertCitation) insertCitation.disabled = locked;
  }

  function isEditorDirtyFor(conflict) {
    if (!conflict) return false;
    return Boolean(getNoteDirty() || getEditorValue() !== conflict.localNote);
  }

  function updateTabBadge(conflict) {
    const tab = document.getElementById('tab-note');
    const badge = document.getElementById('tab-note-conflict-badge');
    const active = Boolean(conflict);
    if (badge) {
      badge.hidden = !active;
      badge.textContent = active ? '冲突' : '';
    }
    if (tab) {
      if (active) {
        tab.dataset.hasConflict = 'true';
        tab.setAttribute('aria-label', '研究笔记（待处理同步冲突）');
      } else {
        delete tab.dataset.hasConflict;
        tab.removeAttribute('aria-label');
      }
    }
  }

  function buildVersionMeta(parts, updatedAt) {
    const meta = el('span', 'note-conflict-version-meta');
    const filtered = parts.filter(Boolean);
    meta.textContent = filtered.join(' · ');
    if (updatedAt) {
      if (filtered.length) meta.append(document.createTextNode(' · '));
      const timeNode = el('time', 'note-conflict-time', updatedAt);
      timeNode.dateTime = updatedAt;
      meta.append(timeNode);
    }
    return meta;
  }

  function buildVersionBlock({ kind, label, metaParts, updatedAt, text, previewAttr }) {
    const block = el('section', 'note-conflict-version');
    block.dataset.conflictVersion = kind;
    const head = el('div', 'note-conflict-version-head');
    head.append(el('strong', '', label), buildVersionMeta(metaParts, updatedAt));
    const pre = el('pre', 'note-conflict-pre', text.length > 0 ? text : '（空笔记）');
    if (previewAttr) pre.setAttribute(previewAttr, '');
    block.append(head, pre);
    return block;
  }

  function syncInteractiveState(conflict) {
    syncEditorLock();
    if (!conflict) return;
    const dirty = isEditorDirtyFor(conflict);
    const writeBusy = Boolean(isNoteWriteInFlight?.());
    if (dirtyGuardNode) dirtyGuardNode.hidden = !dirty;
    if (revertButtonNode) revertButtonNode.disabled = conflictResolving || revertingDraft || writeBusy;
    const disableActions = conflictResolving || revertingDraft || writeBusy || dirty;
    for (const button of actionButtonNodes) {
      button.disabled = disableActions;
    }
  }

  function syncEditorState() {
    syncInteractiveState(currentConflict());
  }

  async function revertDraftToBaseline() {
    if (conflictResolving || revertingDraft) return false;
    const owner = getOwner();
    if (!owner?.id) return false;
    if (!currentConflict()) return false;
    cancelPendingAutoSave();
    revertingDraft = true;
    revertingPaperID = owner.id;
    syncEditorState();
    try {
      if (isNoteWriteInFlight?.()) {
        await waitForPendingWrites();
      }
      if (!isCurrent(owner)) return false;
      const conflict = currentConflict();
      if (!conflict || conflict.paperID !== owner.id) return false;
      cancelPendingAutoSave();
      setEditorValue(conflict.localNote);
      setNoteDirty(false);
      const storedRev = state.personal?.notes?.[conflict.paperID]?.revision;
      setEditorRevision(
        Number.isSafeInteger(storedRev) && storedRev >= 0 ? storedRev : conflict.baseRevision
      );
      setNoteStatus('已恢复冲突基线');
      return true;
    } finally {
      revertingDraft = false;
      revertingPaperID = '';
      render();
    }
  }

  async function resolve(strategy) {
    if (conflictResolving || revertingDraft) return false;
    const owner = getOwner();
    if (!owner?.id) return false;
    const conflict = currentConflict();
    if (!conflict || conflict.paperID !== owner.id) return false;
    cancelPendingAutoSave();
    if (isEditorDirtyFor(conflict) || Boolean(isNoteWriteInFlight?.())) {
      render();
      return false;
    }

    conflictResolving = true;
    resolvingPaperID = owner.id;
    if (isCurrent(owner)) setNoteStatus('正在处理冲突…');
    render();

    const task = (async () => {
      try {
        await waitForPendingWrites();
        if (!isCurrent(owner)) return false;
        const activeConflict = currentConflict();
        if (!activeConflict || activeConflict.paperID !== owner.id || isEditorDirtyFor(activeConflict)) {
          return false;
        }
        const expectedRevision = Number.isSafeInteger(activeConflict.baseRevision) && activeConflict.baseRevision >= 0
          ? activeConflict.baseRevision
          : getEditorRevision();
        const payload = {
          paperID: owner.id,
          strategy,
          expectedRevision,
          expectedLocalNote: activeConflict.localNote,
        };
        const result = await call('personal.resolveNoteConflict', payload);
        ++refreshSequence;
        if (Array.isArray(result?.conflicts)) {
          applyConflicts(result.conflicts);
        } else {
          conflicts.delete(owner.id);
        }
        await onResolved({
          paperID: owner.id,
          owner,
          strategy,
          note: result?.note,
          hasExplicitConflicts: Array.isArray(result?.conflicts),
        });
        return true;
      } catch (err) {
        const [conflictsSettled, snapshotSettled] = await Promise.allSettled([
          call('personal.noteConflicts', {}),
          call('personal.snapshot'),
        ]);
        if (snapshotSettled.status === 'fulfilled' && snapshotSettled.value && typeof snapshotSettled.value === 'object') {
          onSnapshotSynced(snapshotSettled.value, owner);
        }
        if (conflictsSettled.status === 'fulfilled') {
          ++refreshSequence;
          applyConflicts(conflictsSettled.value?.conflicts ?? conflictsSettled.value);
        }
        if (isCurrent(owner) && !getNoteDirty()) {
          setNoteStatus('冲突尚未解决');
        }
        onError(err);
        return false;
      } finally {
        conflictResolving = false;
        resolvingPaperID = '';
        resolvingPromise = null;
        render();
      }
    })();

    resolvingPromise = task;
    return task;
  }

  function render() {
    syncEditorLock();
    const card = document.getElementById('note-conflict-card');
    const conflict = currentConflict();
    updateTabBadge(conflict);
    if (!card) return;

    if (!conflict) {
      card.hidden = true;
      if (renderedKey) {
        card.replaceChildren();
        renderedKey = '';
        dirtyGuardNode = null;
        revertButtonNode = null;
        actionButtonNodes = [];
      }
      return;
    }

    const nextKey = conflictKey(conflict);
    card.hidden = false;
    if (renderedKey === nextKey && actionButtonNodes.length === 3) {
      syncInteractiveState(conflict);
      return;
    }

    renderedKey = nextKey;
    const expKey = expansionKey(conflict);

    const header = el('div', 'note-conflict-header');
    const titleWrap = el('div', 'note-conflict-title-wrap');
    titleWrap.append(
      el('span', 'note-conflict-pill', '同步冲突'),
      el('strong', 'note-conflict-title', '检测到 WebDAV 笔记并发冲突')
    );
    const extraCount = conflict.additionalRemotes.length;
    const metaLabel = `基准修订 r${conflict.baseRevision} · 本机与远端并发修改${extraCount > 0 ? ` · +${extraCount} 份其他设备远端版本` : ''}`;
    header.append(titleWrap, el('span', 'note-conflict-meta', metaLabel));

    const summaryText = extraCount > 0
      ? `WebDAV 同步检测到本机与 ${1 + extraCount} 台远端设备并发修改同一篇笔记（基准修订 r${conflict.baseRevision} · +${extraCount} 份其他设备远端版本）。本机保留版本未被覆盖；推荐使用「合并双方版本」无损保留全部并发内容。`
      : `WebDAV 同步检测到本机与远端并发修改同一篇笔记（基准修订 r${conflict.baseRevision}）。本机保留版本未被覆盖；可展开核对双方全文后选择处理方式。`;
    const summary = el('p', 'note-conflict-summary', summaryText);

    const details = el('details', 'note-conflict-details');
    if (expandedKeys.has(expKey)) details.open = true;
    details.addEventListener('toggle', () => {
      if (details.open) expandedKeys.add(expKey);
      else expandedKeys.delete(expKey);
    });
    const detailsSummary = el(
      'summary',
      'note-conflict-toggle',
      extraCount > 0
        ? `查看本机与 ${1 + extraCount} 份远端冲突版本全文`
        : '查看本机与远端冲突版本全文'
    );
    const versions = el('div', 'note-conflict-versions');
    versions.append(
      buildVersionBlock({
        kind: 'local',
        label: '本机保留版本',
        metaParts: [`r${conflict.baseRevision}`],
        updatedAt: '',
        text: conflict.localNote,
        previewAttr: 'data-conflict-local-preview',
      }),
      buildVersionBlock({
        kind: 'remote',
        label: '远端冲突版本',
        metaParts: [
          `r${conflict.remoteRevision}`,
          conflict.remoteDeviceID ? `设备 ${conflict.remoteDeviceID.slice(0, 8)}` : '',
        ],
        updatedAt: conflict.remoteUpdatedAt,
        text: conflict.remoteNote,
        previewAttr: 'data-conflict-remote-preview',
      })
    );
    conflict.additionalRemotes.forEach((extra, index) => {
      versions.append(
        buildVersionBlock({
          kind: 'additional-remote',
          label: `其他设备远端版本 #${index + 1}`,
          metaParts: [
            `r${extra.remoteRevision}`,
            extra.remoteDeviceID ? `设备 ${extra.remoteDeviceID.slice(0, 8)}` : '',
          ],
          updatedAt: extra.remoteUpdatedAt,
          text: extra.remoteNote,
          previewAttr: 'data-conflict-additional-preview',
        })
      );
    });
    details.append(detailsSummary, versions);

    const dirtyGuard = el('div', 'note-conflict-dirty-guard');
    dirtyGuard.id = 'note-conflict-dirty-guard';
    const dirtyNotice = el(
      'p',
      'note-conflict-dirty-text',
      '当前编辑器内容与冲突基线不一致。直接保存笔记将以当前草稿为准并清除本次冲突；若要使用下方冲突解决按钮，请先恢复冲突基线。'
    );
    const revertButton = el('button', 'secondary-button', '放弃未保存草稿并恢复冲突基线');
    revertButton.type = 'button';
    revertButton.id = 'note-conflict-revert-draft';
    revertButton.addEventListener('click', () => {
      revertDraftToBaseline().catch(onError);
    });
    dirtyGuard.append(dirtyNotice, revertButton);

    const actions = el('div', 'note-conflict-actions');
    const keepLocalBtn = el('button', 'secondary-button', '保留本机版本');
    keepLocalBtn.type = 'button';
    keepLocalBtn.id = 'note-conflict-keep-local';
    keepLocalBtn.dataset.conflictStrategy = 'keep_local';
    keepLocalBtn.addEventListener('click', () => resolve('keep_local'));

    const adoptRemoteBtn = el('button', 'secondary-button', '采用远端版本');
    adoptRemoteBtn.type = 'button';
    adoptRemoteBtn.id = 'note-conflict-adopt-remote';
    adoptRemoteBtn.dataset.conflictStrategy = 'adopt_remote';
    adoptRemoteBtn.addEventListener('click', () => resolve('adopt_remote'));

    const mergeBothBtn = el('button', 'primary-button', '合并双方版本');
    mergeBothBtn.type = 'button';
    mergeBothBtn.id = 'note-conflict-merge-both';
    mergeBothBtn.dataset.conflictStrategy = 'merge_both';
    mergeBothBtn.addEventListener('click', () => resolve('merge_both'));

    actions.append(keepLocalBtn, adoptRemoteBtn, mergeBothBtn);

    dirtyGuardNode = dirtyGuard;
    revertButtonNode = revertButton;
    actionButtonNodes = [keepLocalBtn, adoptRemoteBtn, mergeBothBtn];

    card.replaceChildren(header, summary, details, dirtyGuard, actions);
    syncInteractiveState(conflict);
  }

  return {
    refresh,
    applyConflicts,
    render,
    syncEditorState,
    revertDraftToBaseline,
    resolve,
    clearPaper(paperID) {
      if (paperID && conflicts.delete(paperID)) {
        ++refreshSequence;
        render();
      }
    },
    get resolving() {
      return conflictResolving;
    },
    isEditorLocked() {
      return isEditorLockedForCurrentPaper();
    },
    waitForIdle() {
      return resolvingPromise ? resolvingPromise.catch(() => {}) : Promise.resolve();
    },
  };
}
