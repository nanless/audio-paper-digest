import { marked } from "./vendor/marked.esm.js";

const $ = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const escapeHTML = (value = "") =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const storeKey = "paper-digest-mac-prototype-v1";
let sample,
  pdfModule,
  pdfDocument,
  pdfLoadPromise,
  renderSequence = 0,
  resizeTimer,
  toastTimer;
let pageNumber = 1,
  zoom = 1,
  pdfOpen = false,
  mode = "guide",
  view = "reader",
  manualSidebar = null;
let selectedPDFText = "",
  selectedSourcePage = 1,
  selectedDetail = null,
  taskFilter = "all";
let saved = {
  note: "",
  favorites: [],
  reading: [],
  appearance: "system",
  font: 18,
};
let storageIssue = false;
const assetChecks = new Map();
try {
  const parsed = JSON.parse(localStorage.getItem(storeKey) || "null");
  if (parsed && typeof parsed === "object") {
    saved.note = typeof parsed.note === "string" ? parsed.note : "";
    saved.favorites = Array.isArray(parsed.favorites)
      ? parsed.favorites.filter((x) => typeof x === "string")
      : [];
    saved.reading = Array.isArray(parsed.reading)
      ? parsed.reading.filter((x) => typeof x === "string")
      : [];
    saved.appearance = ["system", "light", "dark"].includes(parsed.appearance)
      ? parsed.appearance
      : "system";
    saved.font = Number.isFinite(parsed.font)
      ? Math.max(16, Math.min(22, parsed.font))
      : 18;
  }
} catch {
  storageIssue = true;
}
function persist() {
  try {
    localStorage.setItem(storeKey, JSON.stringify(saved));
    storageIssue = false;
    return true;
  } catch {
    storageIssue = true;
    return false;
  }
}
function icons() {
  globalThis.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $("toast").hidden = true;
  }, 4300);
}
function applyAppearance() {
  document.documentElement.classList.toggle(
    "appearance-dark",
    saved.appearance === "dark",
  );
  document.documentElement.classList.toggle(
    "appearance-light",
    saved.appearance === "light",
  );
  document.documentElement.style.setProperty(
    "--article-font",
    `${saved.font}px`,
  );
  $("appearance").value = saved.appearance;
  $("font-size").value = saved.font;
  $("font-size-value").textContent = saved.font;
}
applyAppearance();

function sanitizeArticle(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll(
      "script,style,iframe,object,embed,form,input,button,link,meta",
    )
    .forEach((el) => el.remove());
  for (const el of doc.body.querySelectorAll("*")) {
    for (const attribute of [...el.attributes]) {
      if (
        /^on/i.test(attribute.name) ||
        ["style", "srcset", "formaction"].includes(attribute.name)
      )
        el.removeAttribute(attribute.name);
    }
    if (el.hasAttribute("href")) {
      const href = el.getAttribute("href");
      if (href.startsWith("#")) continue;
      const url = new URL(
        href,
        "https://nanless.github.io/audio-paper-digest-blog/",
      );
      if (url.protocol !== "https:") {
        el.removeAttribute("href");
        continue;
      }
      el.setAttribute("href", url.href);
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src");
      const figure = sample.figures.find((f) => f.src === src);
      if (figure) {
        el.setAttribute("src", `assets/${figure.src}`);
        el.setAttribute("data-figure", figure.id);
      } else el.remove();
    }
  }
  return doc.body.innerHTML;
}
function renderArticle() {
  const p = sample.paper;
  let md = sample.articleMarkdown;
  const bodyStart = md.indexOf("## 📌 核心摘要");
  if (bodyStart >= 0) md = md.slice(bodyStart);
  for (const formula of sample.formulas) {
    const original = `\\[${formula.latex}\\]`;
    if (!md.includes(original))
      throw new Error(`原公式未匹配：${formula.label}`);
    md = md.replace(
      original,
      `\n<div class="formula" aria-label="论文公式 ${escapeHTML(formula.label)}">${formula.mathml}</div>\n`,
    );
  }
  const body = sanitizeArticle(marked.parse(md));
  $("article").innerHTML =
    `<header><div class="article-meta-top"><span class="topic-label">${escapeHTML(p.task)}</span><span>·</span><span>${escapeHTML(p.method)}</span><span>·</span><span>网站导读</span></div><h1>${escapeHTML(p.titleZh)}</h1><p class="original-title">${escapeHTML(p.title)}</p><p class="author-line">${p.authors.map((a) => escapeHTML(a.name)).join(" · ")}</p><div class="article-details"><a href="${escapeHTML(p.absUrl)}" target="_blank" rel="noopener">arXiv ${escapeHTML(p.id)}v1 ↗</a><span>网站发布 ${escapeHTML(p.date)}</span><a href="${escapeHTML(p.blogUrl)}" target="_blank" rel="noopener">查看网站 ↗</a><span class="score"><strong>${Number(p.score).toFixed(1)}</strong><span>/ 10 · 网站评分</span></span></div><p class="article-lead">${escapeHTML(p.summary)}</p></header><div class="article-body">${body}</div>`;
  all(".article-body h2,.article-body h3").forEach((h, i) => {
    h.textContent = h.textContent
      .replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, "")
      .trim();
    h.id = `section-${i}`;
  });
  const originalScore = sample.articleMarkdown
    .split("\n")
    .find((line) => line.startsWith("> 评分："));
  const metadata = document.createElement("details");
  metadata.className = "metadata-details";
  const summary = document.createElement("summary");
  summary.textContent = "书目与八维评分";
  metadata.append(summary);
  const details = document.createElement("div");
  const authorList = document.createElement("ul");
  for (const author of p.authors) {
    const item = document.createElement("li");
    item.textContent = `${author.name}：${author.affiliations.join("；")}`;
    authorList.append(item);
  }
  details.append(authorList);
  if (originalScore) {
    const score = document.createElement("div");
    score.innerHTML = sanitizeArticle(marked.parse(originalScore.slice(2)));
    details.append(score);
  }
  metadata.append(details);
  document.querySelector(".article-details").after(metadata);
  all(".article-body table").forEach((table) => {
    const wrap = document.createElement("div");
    wrap.className = "table-scroll";
    table.before(wrap);
    wrap.append(table);
  });
  // The original method figure is moved into the opening, keeping its caption and provenance.
  const methodImage = document.querySelector('[data-figure="figure-2"]');
  if (methodImage) {
    const originalParagraph = methodImage.closest("p");
    const caption = originalParagraph?.nextElementSibling;
    const figure = document.createElement("figure");
    figure.className = "opening-figure";
    const anchor = methodImage.closest("a");
    figure.append(anchor || methodImage);
    const label = document.createElement("figcaption");
    label.textContent = "方法总览 · 原论文 Fig. 2 · PDF 第 5 页";
    figure.append(label);
    $("article").querySelector("header").after(figure);
    if (originalParagraph && !originalParagraph.textContent.trim())
      originalParagraph.remove();
    if (caption?.tagName === "P" && caption.querySelector("em")) {
      const disclosure = document.createElement("details");
      disclosure.className = "original-caption";
      const captionSummary = document.createElement("summary");
      captionSummary.textContent = "查看原图注";
      disclosure.append(captionSummary, caption);
      figure.append(disclosure);
    }
  }
  all(".article img").forEach((img) => {
    const anchor = img.closest("a");
    if (anchor) {
      anchor.removeAttribute("target");
      anchor.href = `assets/${img.getAttribute("src").split("/").pop()}`;
    }
    img.addEventListener("click", (event) => {
      event.preventDefault();
      showFigure(img.dataset.figure);
    });
    img.addEventListener("error", () => {
      img.alt = "科学图未下载，请按原型说明准备真实资产";
    });
  });
  $("outline").innerHTML = all(".article-body h2")
    .map(
      (h) =>
        `<button data-section="${h.id}">${escapeHTML(h.textContent)}</button>`,
    )
    .join("");
  $("outline").addEventListener("click", (event) => {
    const button = event.target.closest("[data-section]");
    if (!button) return;
    navigate("reader");
    setMode("guide");
    $(button.dataset.section).scrollIntoView({ block: "start" });
    all("#outline button").forEach((b) =>
      b.classList.toggle("active", b === button),
    );
  });
}
async function verifyAssets() {
  const files = [
    { src: sample.pdf.src, sha256: sample.pdf.sha256 },
    ...sample.figures,
  ];
  await Promise.all(
    files.map(async (file) => {
      try {
        const response = await fetch(`assets/${file.src}`);
        if (!response.ok) throw new Error("文件不可读");
        const bytes = await response.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const hash = [...new Uint8Array(digest)]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        if (hash !== file.sha256) throw new Error("文件内容指纹不符");
        assetChecks.set(file.src, true);
      } catch {
        assetChecks.set(file.src, false);
      }
    }),
  );
  const available = assetChecks.get(sample.pdf.src);
  const storage = document.querySelector(
    '[data-setting-pane="storage"] .settings-group>div:last-child>span:last-child',
  );
  storage.textContent = available
    ? "1 份 PDF · 已核对内容指纹"
    : "原文未准备好";
}
function showFigure(id) {
  const f = sample.figures.find((x) => x.id === id);
  if (!f) return;
  $("detail-dialog").classList.add("figure-dialog");
  $("detail-content").innerHTML =
    `<img class="figure-full" src="assets/${escapeHTML(f.src)}" alt="${escapeHTML(f.caption)}"><p>${escapeHTML(f.caption)}</p><div class="detail-actions"><button class="secondary-button" id="figure-page">在 PDF 第 ${f.pdfPage} 页核对</button></div>`;
  $("detail-dialog").querySelector("h1").textContent = `原论文 ${f.label}`;
  $("figure-page").onclick = () => {
    $("detail-dialog").close();
    navigate("reader");
    togglePDF(true);
    goPage(f.pdfPage);
  };
  $("detail-dialog").showModal();
}

function updateCounts() {
  $("library-count").textContent = sample.librarySample.length;
  $("favorite-count").textContent = saved.favorites.length || "";
  $("reading-count").textContent = saved.reading.length || "";
  $("favorite").setAttribute(
    "aria-pressed",
    saved.favorites.includes(sample.paper.id),
  );
}
function navigate(next) {
  view = next;
  const actual = ["library", "favorites", "reading-list"].includes(view)
    ? "library"
    : view === "notes"
      ? "reader"
      : view;
  $("reader-view").hidden = actual !== "reader";
  $("library-view").hidden = actual !== "library";
  $("tasks-view").hidden = actual !== "tasks";
  all(".nav-item").forEach((b) =>
    b.setAttribute("aria-current", b.dataset.view === view ? "page" : "false"),
  );
  $("reader-tabs").hidden = actual !== "reader";
  all(".document-action").forEach((b) => (b.hidden = actual !== "reader"));
  $("toolbar-context").textContent = {
    library: "论文库",
    favorites: "已收藏",
    "reading-list": "待读",
    reader: "继续阅读",
    notes: "我的笔记",
    tasks: "后台任务",
  }[view];
  $("sidebar-outline").hidden = actual !== "reader";
  if (actual === "library") renderLibrary();
  if (view === "notes") setMode("note");
  if (view === "tasks") renderTasks();
  if (actual === "reader" && pdfOpen) queuePDFRender();
}
function setMode(next) {
  mode = next;
  const ids = {
    guide: "guide-pane",
    analysis: "analysis-pane",
    note: "note-pane",
  };
  for (const [key, id] of Object.entries(ids)) $(id).hidden = key !== mode;
  all("[data-mode]").forEach((b) =>
    b.setAttribute("aria-selected", b.dataset.mode === mode),
  );
}
function captureReaderAnchor() {
  const box = $("guide-pane").getBoundingClientRect();
  const anchors = all(
    "#article h1,#article h2,#article h3,#article p,#article figure",
  );
  const element = anchors.find(
    (el) => el.getBoundingClientRect().bottom > box.top + 5,
  );
  return element
    ? { element, delta: element.getBoundingClientRect().top - box.top }
    : null;
}
function restoreReaderAnchor(anchor) {
  if (!anchor) return;
  const delta =
    anchor.element.getBoundingClientRect().top -
    $("guide-pane").getBoundingClientRect().top;
  $("guide-pane").scrollTo({
    top: $("guide-pane").scrollTop + delta - anchor.delta,
    behavior: "instant",
  });
}
function adaptSidebar() {
  const hide =
    manualSidebar === null
      ? pdfOpen && window.innerWidth < 1320
      : manualSidebar;
  $("app-window").classList.toggle("sidebar-hidden", hide);
}
async function togglePDF(force) {
  const anchor = captureReaderAnchor();
  pdfOpen = typeof force === "boolean" ? force : !pdfOpen;
  $("reading-area").classList.toggle("is-split", pdfOpen);
  $("pdf-pane").hidden = !pdfOpen;
  $("splitter").hidden = !pdfOpen;
  $("pdf-toggle").setAttribute("aria-pressed", pdfOpen);
  $("pdf-toggle").querySelector("span").textContent = pdfOpen
    ? "关闭 PDF"
    : "打开 PDF";
  adaptSidebar();
  if (pdfOpen) setSplit(Number($("splitter").getAttribute("aria-valuenow")));
  restoreReaderAnchor(anchor);
  if (pdfOpen) await renderPDF();
}
async function loadPDF() {
  if (pdfDocument) return pdfDocument;
  if (pdfLoadPromise) return pdfLoadPromise;
  pdfLoadPromise = loadPDFDocument().catch((error) => {
    pdfLoadPromise = null;
    throw error;
  });
  return pdfLoadPromise;
}
async function loadPDFDocument() {
  pdfModule ||= await import("./vendor/pdf.min.mjs");
  pdfModule.GlobalWorkerOptions.workerSrc = new URL(
    "./vendor/pdf.worker.min.mjs",
    import.meta.url,
  ).href;
  pdfDocument = await pdfModule.getDocument({
    url: `assets/${sample.pdf.src}`,
    isEvalSupported: false,
    stopAtErrors: true,
  }).promise;
  $("pdf-total").textContent = `/ ${pdfDocument.numPages}`;
  $("pdf-page").max = pdfDocument.numPages;
  return pdfDocument;
}
async function renderPDF() {
  clearTimeout(resizeTimer);
  const sequence = ++renderSequence;
  if (!pdfOpen || $("reader-view").hidden) return;
  $("pdf-loading").hidden = false;
  $("pdf-loading").textContent = "正在渲染原始 PDF…";
  $("pdf-page-wrap").hidden = true;
  delete $("pdf-pane").dataset.renderedPage;
  try {
    const doc = await loadPDF();
    const page = await doc.getPage(pageNumber);
    const fit =
      Math.max(100, $("pdf-scroll").clientWidth - 34) /
      page.getViewport({ scale: 1 }).width;
    const scale = fit * zoom;
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const canvas = document.createElement("canvas");
    canvas.id = "pdf-canvas";
    canvas.setAttribute("aria-label", `原论文 PDF 第 ${pageNumber} 页`);
    canvas.width = Math.ceil(viewport.width * ratio);
    canvas.height = Math.ceil(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport,
      transform: [ratio, 0, 0, ratio, 0, 0],
    }).promise;
    if (sequence !== renderSequence || !pdfOpen) return;
    const layer = document.createElement("div");
    layer.id = "pdf-text-layer";
    layer.className = "textLayer";
    layer.style.setProperty("--total-scale-factor", scale);
    const text = await page.getTextContent();
    await new pdfModule.TextLayer({
      textContentSource: text,
      container: layer,
      viewport,
    }).render();
    if (sequence !== renderSequence || !pdfOpen) return;
    $("pdf-page-wrap").replaceChildren(canvas, layer);
    $("pdf-page-wrap").hidden = false;
    $("pdf-page-wrap").style.width = `${viewport.width}px`;
    $("pdf-page-wrap").style.height = `${viewport.height}px`;
    $("pdf-loading").hidden = true;
    $("pdf-page").value = pageNumber;
    $("pdf-zoom").textContent = `${Math.round(scale * 100)}%`;
    $("pdf-prev").disabled = pageNumber <= 1;
    $("pdf-next").disabled = pageNumber >= doc.numPages;
    $("pdf-pane").dataset.renderedPage = pageNumber;
  } catch (error) {
    if (sequence !== renderSequence) return;
    $("pdf-loading").textContent =
      "PDF 暂时无法读取。请检查本地样稿，或使用“打开原件”。";
    $("pdf-loading").hidden = false;
    console.error("PDF render failed:", error.message);
  }
}
function queuePDFRender() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (pdfOpen) renderPDF();
  }, 130);
}
async function goPage(next) {
  if (!Number.isInteger(Number(next))) {
    $("pdf-page").value = pageNumber;
    return;
  }
  pageNumber = Math.max(1, Math.min(sample.pdf.pageCount, Number(next)));
  if (pdfOpen) {
    $("pdf-scroll").scrollTop = 0;
    await renderPDF();
  }
}

function renderLibrary() {
  const text = $("search-input").value.toLocaleLowerCase().trim();
  let papers = sample.librarySample.filter((p) =>
    `${p.title} ${p.titleZh} ${p.id} ${p.authors.map((a) => a.name).join(" ")}`
      .toLocaleLowerCase()
      .includes(text),
  );
  if (view === "favorites")
    papers = papers.filter((p) => saved.favorites.includes(p.id));
  if (view === "reading-list")
    papers = papers.filter((p) => saved.reading.includes(p.id));
  const sort = $("sort").value;
  papers.sort((a, b) =>
    sort === "score"
      ? b.score - a.score
      : sort === "title"
        ? a.title.localeCompare(b.title)
        : b.date.localeCompare(a.date),
  );
  $("library-title").textContent =
    view === "favorites"
      ? "已收藏"
      : view === "reading-list"
        ? "待读"
        : "全部论文";
  $("paper-rows").innerHTML = papers
    .map(
      (p) =>
        `<tr${p.id === sample.paper.id ? ' class="selected"' : ""}><td><button class="paper-title-button" data-paper="${escapeHTML(p.id)}"><span class="paper-row-title">${escapeHTML(p.titleZh || p.title)}</span><span class="paper-row-meta">${escapeHTML(p.id)} · ${escapeHTML(
          p.authors
            .slice(0, 2)
            .map((a) => a.name)
            .join("、"),
        )}${p.authors.length > 2 ? " 等" : ""}</span></button></td><td>${escapeHTML(p.task || "未分类")}</td><td>${escapeHTML(p.date.slice(5))}</td><td class="numeric">${Number(p.score).toFixed(1)}</td><td>${p.id === sample.paper.id ? "正在阅读" : saved.reading.includes(p.id) ? "待读" : "未标记"}</td></tr>`,
    )
    .join("");
  $("library-empty").hidden = papers.length !== 0;
  $("result-count").textContent =
    `${papers.length} 篇 / ${sample.librarySample.length} 篇已发布样本`;
}
function showPaperDetail(id) {
  if (id === sample.paper.id) {
    navigate("reader");
    return;
  }
  const p = sample.librarySample.find((x) => x.id === id);
  if (!p) return;
  selectedDetail = p;
  $("detail-dialog").classList.remove("figure-dialog");
  $("detail-dialog").querySelector("h1").textContent = "论文详情";
  $("detail-content").innerHTML =
    `<h2>${escapeHTML(p.titleZh || p.title)}</h2><p>${escapeHTML(p.title)}</p><p>${escapeHTML(p.authors.map((a) => a.name).join(" · "))}</p><p>${escapeHTML(p.summary)}</p><p>网站发布 ${escapeHTML(p.date)} · 网站评分 ${Number(p.score).toFixed(1)} / 10</p><p>当前原型只缓存 MiCLA 的完整导读与 PDF；此条书目来自真实已发布记录。</p><div class="detail-actions"><a class="secondary-button" href="${escapeHTML(p.blogUrl)}" target="_blank" rel="noopener">阅读网站导读 ↗</a><button class="secondary-button" id="mark-reading">${saved.reading.includes(p.id) ? "移出待读" : "加入待读"}</button></div>`;
  $("mark-reading").onclick = () => {
    saved.reading = saved.reading.includes(p.id)
      ? saved.reading.filter((id) => id !== p.id)
      : [...saved.reading, p.id];
    const okay = persist();
    updateCounts();
    renderLibrary();
    $("detail-dialog").close();
    toast(okay ? "待读状态已保存在本机" : "本地存储不可用，待读状态仅本次有效");
  };
  $("detail-dialog").showModal();
}
function getTasks() {
  const ready = [sample.pdf, ...sample.figures].every((f) =>
    assetChecks.get(f.src),
  );
  return [
    {
      id: "download",
      icon: "file-check-2",
      title: "MiCLA · 离线样稿",
      description: ready
        ? "真实导读、3 张科学图与原始 PDF 已读取，并核对内容指纹。"
        : "部分样稿资产缺失或内容不符，请按说明准备文件后重新打开。",
      state: ready ? "complete" : "attention",
      label: ready ? "样稿文件已核对" : "样稿文件未齐",
      action: "查看论文",
    },
    {
      id: "analysis",
      icon: "sparkles",
      title: "个人解析",
      description:
        "配置自己的模型后，正式应用可基于原文继续研究。当前没有发起请求。",
      state: "attention",
      label: "需要模型配置 · 用量尚未产生",
      action: "前往设置",
    },
    {
      id: "archive",
      icon: "archive",
      title: "Zotero 存档",
      description: "等待连接客户端和选择目标分类。当前没有写入条目或附件。",
      state: "attention",
      label: "等待连接 · 未开始归档",
      action: "查看详情",
    },
  ];
}
function renderTasks() {
  const items = getTasks().filter(
    (t) =>
      taskFilter === "all" ||
      (taskFilter === "attention" && t.state === "attention"),
  );
  $("task-list").innerHTML = items.length
    ? items
        .map(
          (t) =>
            `<article class="task-row"><span class="task-icon"><i data-lucide="${t.icon}"></i></span><div class="task-row-main"><h2>${t.title}</h2><p>${t.description}</p><span class="task-state ${t.state}">${t.label}</span></div><button data-task="${t.id}">${t.action}</button></article>`,
        )
        .join("")
    : '<div class="empty-state"><h2>没有正在执行的任务</h2><p>新任务开始后会在这里显示。</p></div>';
  icons();
}
function openSettings(pane) {
  $("app-menu").hidden = true;
  $("app-menu-button").setAttribute("aria-expanded", "false");
  $("settings-window").hidden = false;
  clampSettingsWindow();
  if (pane) setSettingsPane(pane);
  $("settings-close").focus();
}
function setSettingsPane(pane) {
  all("[data-setting]").forEach((b) =>
    b.setAttribute(
      "aria-current",
      b.dataset.setting === pane ? "page" : "false",
    ),
  );
  all("[data-setting-pane]").forEach(
    (p) => (p.hidden = p.dataset.settingPane !== pane),
  );
}
function closeSettings() {
  $("settings-window").hidden = true;
  $("api-key").value = "";
  $("app-menu-button").focus();
}
function openArchive() {
  $("archive-note-detail").textContent = saved.note.trim()
    ? `${saved.note.length} 字本地笔记 · 尚未同步 Zotero`
    : "当前没有个人笔记";
  $("archive-note").disabled = !saved.note.trim();
  $("archive-note").checked = !!saved.note.trim();
  const pdfReady = !!assetChecks.get(sample.pdf.src);
  $("archive-pdf").disabled = !pdfReady;
  $("archive-pdf").checked = pdfReady;
  $("archive-pdf-detail").textContent = pdfReady
    ? `${sample.pdf.pageCount} 页 · ${(sample.pdf.bytes / 1024).toFixed(0)} KiB · 指定版本 v1`
    : "本地原文未准备好，暂不可归档";
  const guideReady = sample.figures.every((f) => assetChecks.get(f.src));
  $("archive-guide").disabled = !guideReady;
  $("archive-guide").checked = guideReady;
  $("archive-guide-detail").textContent = guideReady
    ? "保留真实图片、表格、公式和来源"
    : "部分科学图缺失或内容不符，暂不可归档";
  $("archive-dialog").showModal();
}
function saveNote() {
  saved.note = $("note-editor").value;
  $("note-count").textContent = `${saved.note.length} 字`;
  const okay = persist();
  $("note-status").textContent = okay
    ? "已保存到本机"
    : "保存失败 · 内容仍保留在编辑区";
  $("note-status").classList.toggle("save-failed", !okay);
}

async function init() {
  const response = await fetch("./sample.json");
  if (!response.ok) throw new Error("样稿数据无法读取");
  sample = await response.json();
  const p = sample.paper;
  $("sidebar-paper").textContent = p.titleZh;
  $("note-context").textContent = `${p.title} · arXiv ${p.id}v1`;
  $("pdf-name").textContent = `MiCLA · 原论文`;
  $("pdf-version").textContent = `${p.id}v1`;
  $("pdf-original").href = `assets/${sample.pdf.src}`;
  $("archive-title").textContent = p.title;
  $("archive-identity").textContent = `arXiv ${p.id}v1 · 网站导读 ${p.date}`;
  $("archive-pdf-detail").textContent =
    `${sample.pdf.pageCount} 页 · ${(sample.pdf.bytes / 1024).toFixed(0)} KiB · 指定版本 v1`;
  $("source-abstract").textContent = sample.abstract || p.summary;
  if (!sample.abstract)
    document.querySelector(".source-excerpt small").textContent =
      "来源：已发布网站核心摘要";
  $("note-editor").value = saved.note;
  $("note-count").textContent = `${saved.note.length} 字`;
  $("note-status").textContent = storageIssue
    ? "本地存储暂不可用"
    : saved.note
      ? "已从本机恢复"
      : "尚未编辑";
  renderArticle();
  updateCounts();
  navigate("reader");
  icons();
  await verifyAssets();
  document.documentElement.dataset.ready = "true";
}

all("[data-view]").forEach((b) =>
  b.addEventListener("click", () => navigate(b.dataset.view)),
);
all("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => setMode(b.dataset.mode)),
);
$("back").onclick = () => navigate("library");
$("pdf-toggle").onclick = () => togglePDF();
$("pdf-close").onclick = () => togglePDF(false);
all('[data-action="sidebar"]').forEach(
  (b) =>
    (b.onclick = () => {
      if (
        pdfOpen &&
        innerWidth < 1180 &&
        $("app-window").classList.contains("sidebar-hidden")
      ) {
        toast("当前双栏需要更多空间；扩大窗口后可展开资料侧栏。");
        return;
      }
      const anchor = captureReaderAnchor();
      manualSidebar = !$("app-window").classList.contains("sidebar-hidden");
      adaptSidebar();
      restoreReaderAnchor(anchor);
      queuePDFRender();
    }),
);
$("pdf-prev").onclick = () => goPage(pageNumber - 1);
$("pdf-next").onclick = () => goPage(pageNumber + 1);
$("pdf-page").onchange = (event) => goPage(event.target.value);
$("pdf-fit").onclick = () => {
  zoom = 1;
  renderPDF();
};
$("pdf-plus").onclick = () => {
  zoom = Math.min(2.5, zoom + 0.15);
  renderPDF();
};
$("pdf-minus").onclick = () => {
  zoom = Math.max(0.6, zoom - 0.15);
  renderPDF();
};
$("source-page").onclick = async () => {
  await togglePDF(true);
  await goPage(selectedSourcePage);
};
$("global-search").onclick = () => {
  navigate("library");
  $("search-input").focus();
};
$("search-input").oninput = renderLibrary;
$("sort").onchange = renderLibrary;
$("reset-search").onclick = () => {
  $("search-input").value = "";
  renderLibrary();
};
$("paper-rows").onclick = (event) => {
  const b = event.target.closest("[data-paper]");
  if (b) showPaperDetail(b.dataset.paper);
};
$("favorite").onclick = () => {
  const id = sample.paper.id;
  saved.favorites = saved.favorites.includes(id)
    ? saved.favorites.filter((x) => x !== id)
    : [...saved.favorites, id];
  const okay = persist();
  updateCounts();
  if (!okay) toast("本地保存失败，收藏状态仅本次有效");
};
$("sync").onclick = () => toast("当前展示已发布离线样本；联网同步接口尚未接入");
$("app-menu-button").onclick = () => {
  $("app-menu").hidden = !$("app-menu").hidden;
  $("app-menu-button").setAttribute("aria-expanded", !$("app-menu").hidden);
};
$("open-settings").onclick = () => openSettings();
$("settings-close").onclick = closeSettings;
$("model-settings").onclick = () => openSettings("model");
$("theme-toggle").onclick = () => {
  const dark =
    getComputedStyle(document.documentElement).colorScheme === "dark" ||
    (saved.appearance === "system" &&
      matchMedia("(prefers-color-scheme:dark)").matches);
  saved.appearance = dark ? "light" : "dark";
  applyAppearance();
  persist();
};
$("appearance").onchange = (event) => {
  saved.appearance = event.target.value;
  applyAppearance();
  persist();
};
$("font-size").oninput = (event) => {
  const anchor = captureReaderAnchor();
  saved.font = Number(event.target.value);
  applyAppearance();
  restoreReaderAnchor(anchor);
  persist();
};
$("reduce-motion").onchange = (event) =>
  document.documentElement.classList.toggle("no-motion", event.target.checked);
all("[data-setting]").forEach(
  (b) => (b.onclick = () => setSettingsPane(b.dataset.setting)),
);
$("check-config").onclick = () => {
  let url;
  try {
    url = new URL($("endpoint").value);
  } catch {
    /* shown below */
  }
  const local =
    url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const valid =
    url &&
    !url.username &&
    !url.password &&
    (url.protocol === "https:" || (url.protocol === "http:" && local));
  $("config-result").textContent = !valid
    ? "请输入 HTTPS 服务地址；本机服务可使用 localhost HTTP。"
    : !$("model").value.trim()
      ? "请填写模型名称。"
      : "格式检查通过。未连接服务，模型能力和凭据尚未验证。";
};
$("archive-open").onclick = openArchive;
$("settings-archive").onclick = () => {
  closeSettings();
  openArchive();
};
$("choose-collection").onclick = () =>
  toast("连接 Zotero 后才能读取分类；当前未访问文库");
$("archive-connect").onclick = () => {
  $("archive-dialog").close();
  openSettings("zotero");
};
$("detail-close").onclick = () => $("detail-dialog").close();
$("about").onclick = () => {
  $("app-menu").hidden = true;
  toast("Mac 交互原型：真实导读和 PDF；模型与 Zotero 未连接。");
};
all("[data-menu]").forEach(
  (b) =>
    (b.onclick = () => {
      const actions = {
        file: "从论文库打开文献，或使用“打开原件”查看 PDF。",
        edit: "笔记支持系统文本编辑与撤销；文档查找使用浏览器菜单。",
        view: "通过侧栏按钮和“打开 PDF”调整研究工作区。",
        window: "设置为可独立移动的非模态原型窗口。",
        help: "内容源于已发布论文，个人解析与 Zotero 为未连接状态。",
      };
      toast(actions[b.dataset.menu]);
    }),
);
$("note-editor").addEventListener("input", saveNote);
$("insert-citation").onclick = () => {
  const editor = $("note-editor"),
    text = `[${sample.paper.title}](${sample.paper.absUrl})`;
  editor.setRangeText(text, editor.selectionStart, editor.selectionEnd, "end");
  saveNote();
  editor.focus();
};
all("[data-question]").forEach(
  (b) =>
    (b.onclick = () => {
      $("question").value = b.dataset.question;
      $("question").focus();
    }),
);
$("analyze").onclick = () => {
  const question = $("question").value.trim();
  if (!question) {
    toast("先写下一个研究问题");
    $("question").focus();
    return;
  }
  $("analysis-result").innerHTML =
    `<section class="analysis-feedback"><h2>问题已准备好</h2><p>${escapeHTML(question)}</p><p>当前原型没有连接模型，未发送材料、未产生解析结果。正式应用将在确认模型与输入范围后运行。</p><button id="analysis-config">配置模型 API →</button></section>`;
  $("analysis-config").onclick = () => openSettings("model");
};
all("[data-task-filter]").forEach(
  (b) =>
    (b.onclick = () => {
      taskFilter = b.dataset.taskFilter;
      all("[data-task-filter]").forEach((x) =>
        x.setAttribute("aria-pressed", x === b),
      );
      renderTasks();
    }),
);
$("task-list").onclick = (event) => {
  const b = event.target.closest("[data-task]");
  if (!b) return;
  if (b.dataset.task === "download") navigate("reader");
  else if (b.dataset.task === "analysis") openSettings("model");
  else openArchive();
};
document.addEventListener("click", (event) => {
  if (
    !$("app-menu").contains(event.target) &&
    !$("app-menu-button").contains(event.target)
  ) {
    $("app-menu").hidden = true;
    $("app-menu-button").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === ",") {
    event.preventDefault();
    openSettings();
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.shiftKey &&
    event.key.toLowerCase() === "f"
  ) {
    event.preventDefault();
    navigate("library");
    $("search-input").focus();
  }
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key === "Enter" &&
    $("analysis-pane").contains(event.target)
  ) {
    event.preventDefault();
    $("analyze").click();
  }
  if (
    event.key === "Escape" &&
    !$("settings-window").hidden &&
    !$("archive-dialog").open &&
    !$("detail-dialog").open
  )
    closeSettings();
});
$("reader-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  const tabs = all("[data-mode]"),
    index = tabs.findIndex((b) => b.dataset.mode === mode);
  const next = tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
  event.preventDefault();
  setMode(next.dataset.mode);
  next.focus();
});
function setSplit(percent) {
  const width = $("reading-area").clientWidth;
  const minimum = Math.max(35, (360 / width) * 100),
    maximum = Math.min(60, ((width - 526) / width) * 100);
  const value = Math.max(
    minimum,
    Math.min(Math.max(minimum, maximum), percent),
  );
  $("reading-area").style.setProperty("--split", `${value}%`);
  $("splitter").setAttribute("aria-valuenow", Math.round(value));
  $("splitter").setAttribute("aria-valuemin", Math.ceil(minimum));
  $("splitter").setAttribute(
    "aria-valuemax",
    Math.floor(Math.max(minimum, maximum)),
  );
  queuePDFRender();
}
$("splitter").addEventListener("pointerdown", (event) => {
  $("splitter").setPointerCapture(event.pointerId);
  const move = (next) => {
    const box = $("reading-area").getBoundingClientRect();
    setSplit(((next.clientX - box.left) / box.width) * 100);
  };
  const end = () => {
    $("splitter").removeEventListener("pointermove", move);
    $("splitter").removeEventListener("pointerup", end);
  };
  $("splitter").addEventListener("pointermove", move);
  $("splitter").addEventListener("pointerup", end);
});
$("splitter").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
  event.preventDefault();
  setSplit(
    Number($("splitter").getAttribute("aria-valuenow")) +
      (event.key === "ArrowRight" ? 2 : -2),
  );
});
document.addEventListener("selectionchange", () => {
  const selection = getSelection();
  if (
    selection?.anchorNode &&
    selection.focusNode &&
    $("pdf-page-wrap").contains(selection.anchorNode) &&
    $("pdf-page-wrap").contains(selection.focusNode) &&
    selection.toString().trim()
  ) {
    const actualPage = Number($("pdf-pane").dataset.renderedPage);
    if (!Number.isInteger(actualPage) || actualPage < 1) return;
    selectedSourcePage = actualPage;
    selectedPDFText = selection.toString().trim().slice(0, 6000);
    $("context-label").textContent =
      `PDF 第 ${selectedSourcePage} 页 · 已选 ${selectedPDFText.length} 字符`;
    $("source-abstract").textContent = selectedPDFText;
    document.querySelector(".source-excerpt small").textContent =
      `来源：原始 PDF 第 ${selectedSourcePage} 页实际选区`;
    $("source-page").textContent = `打开 PDF · 第 ${selectedSourcePage} 页`;
  }
});
let draggingSettings = false;
document
  .querySelector(".settings-titlebar")
  .addEventListener("pointerdown", (event) => {
    if (event.target.closest("button")) return;
    const win = $("settings-window"),
      header = event.currentTarget,
      rect = win.getBoundingClientRect();
    const dx = event.clientX - rect.left,
      dy = event.clientY - rect.top;
    draggingSettings = true;
    header.setPointerCapture(event.pointerId);
    const move = (e) => {
      if (!draggingSettings) return;
      win.style.transform = "none";
      win.style.left = `${Math.max(0, Math.min(innerWidth - win.offsetWidth, e.clientX - dx))}px`;
      win.style.top = `${Math.max(31, Math.min(innerHeight - win.offsetHeight - 12, e.clientY - dy))}px`;
    };
    const end = () => {
      draggingSettings = false;
      header.removeEventListener("pointermove", move);
      header.removeEventListener("pointerup", end);
    };
    header.addEventListener("pointermove", move);
    header.addEventListener("pointerup", end);
  });
function clampSettingsWindow() {
  const win = $("settings-window");
  if (win.hidden) return;
  const rect = win.getBoundingClientRect();
  win.style.transform = "none";
  win.style.left = `${Math.max(0, Math.min(innerWidth - win.offsetWidth, rect.left))}px`;
  win.style.top = `${Math.max(31, Math.min(innerHeight - win.offsetHeight - 12, rect.top))}px`;
}
window.addEventListener("resize", () => {
  adaptSidebar();
  clampSettingsWindow();
  if (pdfOpen) setSplit(Number($("splitter").getAttribute("aria-valuenow")));
  queuePDFRender();
});
init().catch((error) => {
  $("article").innerHTML =
    `<div class="empty-state"><h1>样稿未能读取</h1><p>请通过本地预览服务打开原型，并检查 sample.json。</p></div>`;
  console.error(error.message);
});
