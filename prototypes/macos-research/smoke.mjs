import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { chromium } = await import(
  process.env.MAC_PROTOTYPE_PLAYWRIGHT || "playwright"
);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath =
  process.env.MAC_PROTOTYPE_BROWSER ||
  (existsSync(chrome) ? chrome : undefined);
const url = process.env.MAC_PROTOTYPE_URL || "http://127.0.0.1:8766/";
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), ".qa");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
const errors = [],
  externalRequests = [],
  checks = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => {
  if (!r.url().startsWith(url) && !r.url().startsWith("blob:"))
    externalRequests.push(r.url());
});
const check = async (name, run) => {
  await run();
  checks.push(name);
};
const shot = (name) =>
  page.screenshot({ path: path.join(output, `${name}.png`) });
const ready = async () => {
  await page.goto(url);
  await page.waitForSelector("html[data-ready=true]");
};
const selectView = (name) =>
  page.locator(`.nav-item[data-view="${name}"]`).click();
const pdfPage = async (n) => {
  await page.locator("#pdf-page").fill(String(n));
  await page.locator("#pdf-page").dispatchEvent("change");
  await page.waitForSelector(`#pdf-pane[data-rendered-page="${n}"]`);
};

try {
  await ready();
  await check("真实导读保留4公式4表3图，默认单栏", async () => {
    assert.equal(await page.locator("math").count(), 4);
    assert.equal(await page.locator(".article-body table").count(), 4);
    assert.equal(await page.locator("#article img").count(), 3);
    assert.equal(await page.locator("#pdf-pane").isVisible(), false);
    assert.equal(
      await page
        .locator("#article")
        .innerText()
        .then((t) => t.includes("MiCLA")),
      true,
    );
    await shot("single");
  });
  await check("原八维评分及原图注可见展开", async () => {
    await page.locator(".metadata-details summary").click();
    assert.match(
      await page.locator(".metadata-details").innerText(),
      /技术严谨 1.2\/1.5/,
    );
    await page.locator(".metadata-details summary").click();
    await page.locator(".original-caption summary").click();
    assert.match(
      await page.locator(".original-caption").innerText(),
      /Mixture-to-constituent/,
    );
    await page.locator(".original-caption summary").click();
  });
  await check("真实PDF页1/5/13各自渲染，文字可选且缩放改变画布", async () => {
    await page.locator("#pdf-toggle").click();
    await page.waitForSelector('#pdf-pane[data-rendered-page="1"]');
    const hashes = [];
    for (const n of [1, 5, 13]) {
      await pdfPage(n);
      hashes.push(
        await page
          .locator("#pdf-canvas")
          .evaluate((c) => c.toDataURL().slice(-500)),
      );
      assert.ok((await page.locator(".textLayer span").count()) > 30);
    }
    assert.equal(new Set(hashes).size, 3);
    await pdfPage(5);
    const before = await page.locator("#pdf-canvas").evaluate((c) => c.width);
    await page.locator("#pdf-plus").click();
    await page.waitForFunction(
      (before) => document.querySelector("#pdf-canvas").width > before,
      before,
    );
    await page.locator("#pdf-fit").click();
    await page.waitForFunction(
      (before) => document.querySelector("#pdf-canvas").width === before,
      before,
    );
    await shot("dual");
  });
  await check("原文选区与来源回跳绑定实际第5页", async () => {
    await page
      .locator("#pdf-text-layer span")
      .nth(15)
      .evaluate((span) => {
        const range = document.createRange();
        range.selectNodeContents(span);
        const s = getSelection();
        s.removeAllRanges();
        s.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    assert.match(await page.locator("#context-label").innerText(), /第 5 页/);
    await pdfPage(9);
    await page.locator('[data-mode="analysis"]').click();
    await page.locator("#source-page").click();
    await page.waitForSelector('#pdf-pane[data-rendered-page="5"]');
  });
  await check("解析输入在切换分栏后保留且不伪造响应", async () => {
    await page.locator("#question").fill("检查真实论文的实验条件");
    await page.locator("#pdf-close").click();
    await page.locator("#pdf-toggle").click();
    assert.equal(
      await page.locator("#question").inputValue(),
      "检查真实论文的实验条件",
    );
    await page.locator("#analyze").click();
    assert.match(
      await page.locator("#analysis-result").innerText(),
      /没有连接模型/,
    );
    await shot("analysis");
  });
  await check("笔记真实保存并在刷新后恢复", async () => {
    await page.locator('[data-mode="note"]').click();
    await page.locator("#note-editor").fill("独立回归笔记：复查残差对齐。");
    assert.match(
      await page.locator("#note-status").innerText(),
      /已保存到本机/,
    );
    await ready();
    await page.locator('[data-mode="note"]').click();
    assert.equal(
      await page.locator("#note-editor").inputValue(),
      "独立回归笔记：复查残差对齐。",
    );
    await shot("notes");
  });
  await check("收藏、标题/作者搜索和无结果", async () => {
    await page.locator("#favorite").click();
    await selectView("favorites");
    assert.equal(await page.locator("#paper-rows tr").count(), 1);
    await selectView("library");
    assert.equal(await page.locator("#paper-rows tr").count(), 15);
    await page.locator("#search-input").fill("Kohei Yamamoto");
    assert.ok((await page.locator("#paper-rows tr").count()) > 0);
    await page.locator("#search-input").fill("2610.27491");
    assert.equal(await page.locator("#paper-rows tr").count(), 1);
    await page.locator("#search-input").fill("no-matching-document-xyz");
    assert.equal(await page.locator("#library-empty").isVisible(), true);
    await page.locator("#reset-search").click();
    await page.locator("#sort").selectOption("score");
    await shot("library");
  });
  await check("其他论文提供真实详情，待读刷新恢复", async () => {
    await page.locator('[data-paper="2610.30682"]').click();
    assert.match(
      await page.locator("#detail-content").innerText(),
      /只缓存 MiCLA/,
    );
    await page.locator("#mark-reading").click();
    await ready();
    await selectView("reading-list");
    assert.equal(await page.locator("#paper-rows tr").count(), 1);
  });
  await check("设置是非模态独立窗口，密钥不保存且关闭清空", async () => {
    await page.keyboard.press("Meta+,");
    assert.equal(await page.locator("#settings-window").isVisible(), true);
    await page.locator('[data-setting="model"]').click();
    await page.locator("#api-key").fill("prototype-only-test-value");
    await page.locator("#endpoint").fill("https://example.com/v1");
    await page.locator("#model").fill("example-model");
    await page.locator("#check-config").click();
    assert.match(
      await page.locator("#config-result").innerText(),
      /未连接服务/,
    );
    assert.equal(
      await page.evaluate(() =>
        JSON.stringify(localStorage).includes("prototype-only-test-value"),
      ),
      false,
    );
    await shot("settings");
    await page.locator("#settings-close").click();
    assert.equal(await page.locator("#api-key").inputValue(), "");
  });
  await check("设置移到右下后缩窗，整个窗口仍然可达", async () => {
    await page.keyboard.press("Meta+,");
    const box = await page.locator(".settings-titlebar").boundingBox();
    await page.mouse.move(box.x + 350, box.y + 22);
    await page.mouse.down();
    await page.mouse.move(1370, 850);
    await page.mouse.up();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.waitForFunction(() => {
      const r = document
        .querySelector("#settings-window")
        .getBoundingClientRect();
      return (
        r.left >= 0 &&
        r.top >= 31 &&
        r.right <= innerWidth &&
        r.bottom <= innerHeight
      );
    });
    const next = await page.locator("#settings-window").boundingBox();
    assert.ok(
      next.x >= 0 &&
        next.y >= 31 &&
        next.x + next.width <= 1000 &&
        next.y + next.height <= 700,
    );
    await page.locator("#settings-close").click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.keyboard.press("Meta+,");
    const header = await page.locator(".settings-titlebar").boundingBox();
    await page.mouse.move(header.x + 350, header.y + 22);
    await page.mouse.down();
    await page.mouse.move(1380, 850);
    await page.mouse.up();
    await page.locator("#settings-close").click();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.keyboard.press("Meta+,");
    const reopened = await page.locator("#settings-window").boundingBox();
    assert.ok(
      reopened.x >= 0 &&
        reopened.y >= 31 &&
        reopened.x + reopened.width <= 1000 &&
        reopened.y + reopened.height <= 700,
    );
    await page.locator("#settings-close").click();
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  await check("Zotero未连接且无虚构写入", async () => {
    await selectView("reader");
    await page.locator("#archive-open").click();
    assert.match(
      await page.locator("#archive-dialog").innerText(),
      /不会写入文库/,
    );
    await shot("archive");
    await page.locator("#archive-connect").click();
    assert.equal(
      await page.locator('[data-setting-pane="zotero"]').isVisible(),
      true,
    );
    await page.locator("#settings-close").click();
  });
  await check("后台任务状态与筛选", async () => {
    await selectView("tasks");
    assert.equal(await page.locator(".task-row").count(), 3);
    await page.locator('[data-task-filter="active"]').click();
    assert.equal(await page.locator(".task-row").count(), 0);
    await page.locator('[data-task-filter="attention"]').click();
    assert.equal(await page.locator(".task-row").count(), 2);
    await page.locator('[data-task-filter="all"]').click();
    await shot("tasks");
  });
  await check("保存失败保留笔记并显示失败", async () => {
    await selectView("notes");
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("test", "QuotaExceededError");
      };
    });
    await page.locator("#note-editor").fill("故障中的编辑内容仍然保留");
    assert.match(await page.locator("#note-status").innerText(), /保存失败/);
    assert.equal(
      await page.locator("#note-editor").inputValue(),
      "故障中的编辑内容仍然保留",
    );
    await ready();
  });
  await check("快速开关双栏保持语义阅读位置", async () => {
    await page.locator(".table-scroll").first().scrollIntoViewIfNeeded();
    const before = await page
      .locator("#guide-pane")
      .evaluate((el) => el.scrollTop);
    for (let i = 0; i < 8; i++) await page.locator("#pdf-toggle").click();
    const after = await page
      .locator("#guide-pane")
      .evaluate((el) => el.scrollTop);
    assert.ok(Math.abs(before - after) < 3, `${before} → ${after}`);
  });
  await check("1000/1280/1728桌面宽度、深色、分隔线约束", async () => {
    for (const width of [1000, 1280, 1728]) {
      await page.setViewportSize({ width, height: 800 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      );
      assert.equal(overflow, false);
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator("#pdf-toggle").click();
    await page.waitForSelector("#pdf-pane[data-rendered-page]");
    await page.locator("#theme-toggle").click();
    await page.locator("#splitter").focus();
    for (let i = 0; i < 15; i++) await page.keyboard.press("ArrowRight");
    assert.ok((await page.locator("#pdf-pane").boundingBox()).width >= 519);
    await shot("dark-dual");
  });
  await check("缺PDF和篡改图片准确阻断归档与完成状态", async () => {
    const broken = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const p = await broken.newPage();
    await p.route("**/assets/*.pdf", (r) =>
      r.fulfill({ status: 404, body: "missing" }),
    );
    await p.route("**/assets/figure-3.png", (r) =>
      r.fulfill({ status: 200, body: "wrong-content" }),
    );
    await p.goto(url);
    await p.waitForSelector("html[data-ready=true]");
    await p.locator('.nav-item[data-view="tasks"]').click();
    assert.match(await p.locator("#task-list").innerText(), /样稿文件未齐/);
    await p.locator('.nav-item[data-view="reader"]').click();
    await p.locator("#archive-open").click();
    assert.equal(await p.locator("#archive-pdf").isDisabled(), true);
    assert.equal(await p.locator("#archive-guide").isDisabled(), true);
    assert.match(
      await p.locator("#archive-guide-detail").innerText(),
      /科学图缺失或内容不符/,
    );
    await broken.close();
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(externalRequests, []);
  await writeFile(
    path.join(output, "result.json"),
    JSON.stringify(
      { passed: checks.length, checks, errors, externalRequests },
      null,
      2,
    ) + "\n",
  );
  console.log(`${checks.length} 项原型回归通过；无页面异常，无外部服务请求。`);
} finally {
  await browser.close();
}
