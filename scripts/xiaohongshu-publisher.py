#!/usr/bin/env python3
from __future__ import annotations

from project_env import BROWSER_CHILD_ENV_KEYS, TRANSPORT_ENV_KEYS, build_child_process_env, load_project_env
load_project_env()

from log_setup import setup_script_logging
setup_script_logging(__file__)

"""
小红书自动发布脚本（基于 Playwright）

功能：
  1. 首次运行扫码登录，保存 Cookie
  2. 后续运行自动读取 Cookie 免登
  3. 读取生成的 markdown 文案，自动发布图文笔记

用法：
  python3 xiaohongshu-publisher.py                          # 发布今日 TOP5 文案
  python3 xiaohongshu-publisher.py --all                    # 发布完整汇总版
  python3 xiaohongshu-publisher.py --date 2026-05-01        # 指定日期
  python3 xiaohongshu-publisher.py --login                  # 仅执行登录，保存 Cookie
  python3 xiaohongshu-publisher.py --text "自定义文案"       # 发布自定义文案

依赖：
  pip install playwright
  playwright install chromium
"""

import argparse, base64, json, os, sys, re, asyncio
from pathlib import Path
from datetime import datetime, timezone, timedelta

from path_config import PROJECT_ROOT, atomic_write_text, xiaohongshu_markdown_path

try:
    from playwright.async_api import async_playwright, TimeoutError as PWTimeout
except ImportError:
    print("❌ 缺少 playwright，请先安装：")
    print("   pip install playwright")
    print("   playwright install chromium")
    sys.exit(1)

# ═══════════════════════════════════════════════════════
# 配置
# ═══════════════════════════════════════════════════════

PUBLISH_URL = "https://creator.xiaohongshu.com/publish/publish"
LOGIN_URL = "https://creator.xiaohongshu.com/"
ENV_FILE = PROJECT_ROOT / ".env"

# 小红书正文限制（标题 30 字，正文 1000 字）
MAX_TITLE_LEN = 30
MAX_BODY_LEN = 1000
BJ_TZ = timezone(timedelta(hours=8))


def today_bj():
    return datetime.now(BJ_TZ).strftime("%Y-%m-%d")


def find_screenshot_images(target_date):
    pic_dir = Path.home() / "Pictures"
    compact = target_date.replace("-", "")
    return sorted(str(p) for p in pic_dir.glob(f"微信图片_{compact}*.png"))


# ═══════════════════════════════════════════════════════
# .env 文件读写（保留其他配置）
# ═══════════════════════════════════════════════════════

def _load_env_file():
    """重新加载当前项目 .env，覆盖外层项目变量。"""
    load_project_env(ENV_FILE)


def _update_env_key(key: str, value: str):
    """原子更新 .env 中的指定 key，并完整保留其他配置。"""
    if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
        raise ValueError(f"非法环境变量名: {key!r}")
    if any(char in value for char in ('\n', '\r', '"', '\\')):
        raise ValueError("环境变量值包含无法安全写入双引号 .env 的字符")
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    lines = []
    found = False
    if ENV_FILE.exists():
        with open(ENV_FILE, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if stripped.startswith(f"{key}="):
                    lines.append(f'{key}="{value}"\n')
                    found = True
                else:
                    lines.append(line)
    if not found:
        # 在文件末尾追加，先加一个空行
        if lines and not lines[-1].endswith("\n"):
            lines[-1] += "\n"
        if lines and lines[-1].strip():
            lines.append("\n")
        lines.append(f'{key}="{value}"\n')
    atomic_write_text(ENV_FILE, ''.join(lines), mode=0o600)


# ═══════════════════════════════════════════════════════
# Cookie 管理（存放到 .env）
# ═══════════════════════════════════════════════════════

async def save_cookies(context):
    cookies = await context.cookies()
    # base64 编码 JSON，避免 .env 中出现换行和特殊字符
    cookies_b64 = base64.b64encode(json.dumps(cookies, ensure_ascii=False).encode("utf-8")).decode("ascii")
    _update_env_key("XIAOHONGSHU_COOKIES", cookies_b64)
    # 同时刷新当前进程的环境变量
    os.environ["XIAOHONGSHU_COOKIES"] = cookies_b64
    print(f"[xhs] Cookie 已保存到 .env (XIAOHONGSHU_COOKIES)")


async def load_cookies(context):
    # 优先从环境变量读取（已经被 loadEnvFile 或其他机制加载）
    cookies_b64 = os.environ.get("XIAOHONGSHU_COOKIES")
    if not cookies_b64:
        # 若当前进程没有，尝试重新加载 .env
        _load_env_file()
        cookies_b64 = os.environ.get("XIAOHONGSHU_COOKIES")
    if not cookies_b64:
        return False
    try:
        cookies_json = base64.b64decode(cookies_b64).decode("utf-8")
        cookies = json.loads(cookies_json)
        await context.add_cookies(cookies)
        print("[xhs] Cookie 已从 .env 加载")
        return True
    except Exception as e:
        print(f"[xhs] ⚠️ Cookie 解析失败: {e}")
        return False


# ═══════════════════════════════════════════════════════
# 登录流程
# ═══════════════════════════════════════════════════════

async def do_login(headless=False):
    """打开浏览器让用户扫码登录，保存 Cookie"""
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=headless,
            env=build_child_process_env(allowed_keys=(*BROWSER_CHILD_ENV_KEYS, *TRANSPORT_ENV_KEYS)),
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )
        page = await context.new_page()
        await page.goto(LOGIN_URL)
        print("[xhs] 已打开登录页面，请扫码登录...")
        print("[xhs] 浏览器窗口应该已弹出，请在窗口中完成扫码...")

        # 持续检测是否登录成功：页面中出现"发布笔记"按钮
        login_success = False
        for attempt in range(120):
            try:
                await page.wait_for_selector("text=发布笔记", timeout=1000)
                print("[xhs] ✅ 登录成功（检测到发布笔记按钮）")
                login_success = True
                break
            except PWTimeout:
                await page.wait_for_timeout(1000)
                # 每 10 秒提示一次
                if attempt > 0 and attempt % 10 == 0:
                    print(f"[xhs] 等待登录中... ({attempt}s / 120s)")

        if not login_success:
            print("[xhs] ⚠️ 登录超时（2分钟），请重新运行 --login")
            await browser.close()
            return False

        # 再等 2 秒让页面稳定
        await page.wait_for_timeout(2000)
        await save_cookies(context)
        await browser.close()
        return True


# ═══════════════════════════════════════════════════════
# 发布流程
# ═══════════════════════════════════════════════════════

async def publish_note(title: str, body: str, images: list[str] | None = None, headless: bool = False):
    """
    发布小红书笔记

    Args:
        title: 笔记标题（最多 20 字）
        body: 笔记正文（最多 1000 字）
        images: 图片路径列表（可选，至少传 1 张图效果更好）
        headless: 是否无头模式（调试用 False，定时跑可用 True）
    """
    if len(body) > MAX_BODY_LEN:
        print(f"[xhs] ❌ 正文共 {len(body)} 字，超过平台上限 {MAX_BODY_LEN} 字；已停止发布，禁止静默截断")
        return False

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=headless,
            env=build_child_process_env(allowed_keys=(*BROWSER_CHILD_ENV_KEYS, *TRANSPORT_ENV_KEYS)),
        )
        context = await browser.new_context(
            viewport={"width": 1280, "height": 800},
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )

        # 加载 Cookie
        has_cookie = await load_cookies(context)
        if not has_cookie:
            print("[xhs] ❌ 没有找到 Cookie，请先运行: python3 xiaohongshu-publisher.py --login")
            await browser.close()
            return False

        page = await context.new_page()

        # 先访问创作者首页，通过"发布笔记"按钮进入图文发布
        await page.goto("https://creator.xiaohongshu.com/")
        await page.wait_for_timeout(3000)

        # 检查是否跳转到了登录页（Cookie 失效）
        if "login" in page.url:
            print("[xhs] ❌ Cookie 已失效，请重新登录: python3 xiaohongshu-publisher.py --login")
            await browser.close()
            return False

        print(f"[xhs] 正在发布: {title[:30]}...")

        # 点击首页的"发布图文笔记"大按钮
        clicked = False
        try:
            # 策略1: 用get_by_text精确匹配并点击
            pic_btn = page.get_by_text("发布图文笔记", exact=False)
            if await pic_btn.count() > 0:
                # 找第一个可见的
                for i in range(await pic_btn.count()):
                    el = pic_btn.nth(i)
                    if await el.is_visible():
                        await el.click()
                        print("[xhs] 已点击发布图文笔记 (get_by_text)")
                        clicked = True
                        break
            if not clicked:
                # 策略2: mouse.click强制点击
                loc = page.locator('text=发布图文笔记').first
                if await loc.count() > 0:
                    box = await loc.bounding_box()
                    if box:
                        await page.mouse.click(box['x'] + box['width']/2, box['y'] + box['height']/2)
                        print("[xhs] 已强制点击发布图文笔记 (mouse)")
                        clicked = True
        except Exception as e:
            print(f"[xhs] 点击图文按钮异常: {e}")

        if not clicked:
            # 策略3: evaluate找可点击祖先
            try:
                result = await page.evaluate('''() => {
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
                    let node;
                    while (node = walker.nextNode()) {
                        if (node.textContent.trim() === '发布图文笔记') {
                            let el = node.parentElement;
                            // 向上找5层，找a/button/可点击div
                            for (let i = 0; i < 5; i++) {
                                if (!el) break;
                                const tag = el.tagName.toLowerCase();
                                if (tag === 'a' || tag === 'button' || el.onclick || el.getAttribute('role') === 'button') {
                                    el.click();
                                    const ev = new MouseEvent('click', {bubbles: true, cancelable: true, view: window});
                                    el.dispatchEvent(ev);
                                    return 'clicked: ' + tag;
                                }
                                el = el.parentElement;
                            }
                            // 如果没找到，点击文本节点所在的父元素
                            node.parentElement.click();
                            return 'clicked parent';
                        }
                    }
                    return 'not found';
                }''')
                print(f"[xhs] DOM点击图文: {result}")
                clicked = True
            except Exception as e2:
                print(f"[xhs] DOM点击异常: {e2}")

        await page.wait_for_timeout(3000)

        # 如果还是没进入发布页，尝试直接导航
        current_url = page.url
        if 'publish' not in current_url and not clicked:
            print("[xhs] ⚠️ 未进入发布页，尝试直接导航...")
            await page.goto(PUBLISH_URL)
            await page.wait_for_timeout(3000)

        # 等待页面完全加载
        await page.wait_for_timeout(3000)

        # 检测当前页面类型
        check = await page.evaluate('''() => {
            return {
                hasVideo: document.body.innerText.includes('视频大小'),
                hasPicHint: document.body.innerText.includes('拖拽图片到此') || document.body.innerText.includes('点击上传'),
                hasTitleInput: document.querySelector('input[maxlength="20"]') !== null,
                url: location.href
            };
        }''')
        print(f"[xhs] 页面状态: {check}")

        # 调试截图：页面加载后
        debug_dir = Path.home() / ".paper-digest" / "debug"
        debug_dir.mkdir(parents=True, exist_ok=True)
        screenshot_path = debug_dir / f"xhs_publish_{datetime.now().strftime('%H%M%S')}.png"
        await page.screenshot(path=str(screenshot_path), full_page=True)
        print(f"[xhs] 调试截图已保存: {screenshot_path}")

        # ── 1. 上传图片 ──
        if images:
            images = images[:18]
            uploaded = False
            try:
                # 策略1: 先点击"上传图片"按钮，再处理文件选择器
                upload_btn = await page.wait_for_selector('button:has-text("上传图片"), div:has-text("上传图片"), span:has-text("上传图片")', timeout=5000)
                if upload_btn:
                    # 使用 filechooser 事件来处理文件上传
                    async with page.expect_file_chooser() as fc_info:
                        await upload_btn.click()
                    file_chooser = await fc_info.value
                    await file_chooser.set_files(images)
                    print(f"[xhs] 已通过文件选择器上传 {len(images)} 张图片")
                    uploaded = True
            except Exception as e:
                print(f"[xhs] ⚠️ 文件选择器上传失败: {e}")

            # 策略2: 直接找 input[type="file"]
            if not uploaded:
                try:
                    file_input = await page.wait_for_selector('input[type="file"]', timeout=5000)
                    if file_input:
                        await file_input.set_input_files(images)
                        print(f"[xhs] 已直接上传 {len(images)} 张图片")
                        uploaded = True
                except Exception as e2:
                    print(f"[xhs] ⚠️ 直接上传也失败: {e2}")

            if uploaded:
                try:
                    await page.wait_for_selector(".upload-item, .delete-icon, img[alt='preview']", timeout=30000)
                except PWTimeout:
                    pass
                await page.wait_for_timeout(2000)
            else:
                print("[xhs] ⚠️ 图片上传失败，将暂停让你手动上传")
        else:
            print("[xhs] ⚠️ 未提供图片，小红书图文笔记建议至少 1 张图")

        # ── 2. 填写标题 ──
        title_filled = False
        try:
            # 策略A: 多种CSS选择器
            title_selectors = [
                'input[placeholder*="标题"]', 'input[placeholder*="填写标题"]',
                'textarea[placeholder*="标题"]', 'textarea[placeholder*="填写标题"]',
                '[class*="title"] input, [class*="title"] textarea',
                '[class*="Title"] input, [class*="Title"] textarea',
                'input[maxlength="20"]', 'input[maxlength="40"]',
                '[data-testid*="title"]',
                'input[type="text"]',
                'textarea',
            ]
            title_input = None
            for sel in title_selectors:
                els = await page.query_selector_all(sel)
                for el in els:
                    if el:
                        ph = await el.get_attribute('placeholder') or ''
                        cls = await el.get_attribute('class') or ''
                        if '标题' in ph or 'title' in cls.lower() or 'Title' in cls:
                            title_input = el
                            break
                if title_input:
                    break
                # 也试试直接取第一个可见的
                try:
                    title_input = await page.wait_for_selector(sel, timeout=1500)
                    if title_input:
                        break
                except PWTimeout:
                    continue

            if title_input:
                await title_input.fill(title[:MAX_TITLE_LEN])
                await title_input.press('End')
                print(f"[xhs] 标题已填写: {title[:MAX_TITLE_LEN]}")
                title_filled = True
            else:
                print("[xhs] ⚠️ 未找到标题输入框（CSS选择器）")
        except Exception as e:
            print(f"[xhs] ⚠️ 填写标题失败: {e}")

        # 策略B: 通过evaluate直接操作DOM（兜底）
        if not title_filled:
            try:
                await page.evaluate(f'''
                    (title) => {{
                        // 方法1: 找placeholder含"标题"的input/textarea
                        const inputs = document.querySelectorAll('input, textarea');
                        for (const el of inputs) {{
                            const ph = el.getAttribute('placeholder') || '';
                            if (ph.includes('标题') || ph.includes('title')) {{
                                el.value = title;
                                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                                return 'found by placeholder';
                            }}
                        }}
                        // 方法2: 找maxlength=20的input
                        const m20 = document.querySelector('input[maxlength="20"]');
                        if (m20) {{
                            m20.value = title;
                            m20.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            return 'found by maxlength';
                        }}
                        // 方法3: 第一个type=text的input
                        const firstText = document.querySelector('input[type="text"]');
                        if (firstText) {{
                            firstText.value = title;
                            firstText.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            return 'found first text input';
                        }}
                        return 'not found';
                    }}
                ''', title[:MAX_TITLE_LEN])
                print(f"[xhs] 标题已通过DOM evaluate填写")
                title_filled = True
            except Exception as e2:
                print(f"[xhs] ⚠️ DOM evaluate填写标题也失败: {e2}")

        # ── 3. 填写正文 ──
        body_filled = False
        try:
            # 策略A: CSS选择器
            body_selectors = [
                'div[contenteditable="true"]',
                'div[contenteditable=""]',
                '[class*="content"] div[contenteditable]',
                '[class*="editor"] div[contenteditable]',
                '[class*="Editor"] div[contenteditable]',
                '[class*="desc"] div[contenteditable]',
                'div[role="textbox"]',
                '[data-testid*="content"]',
                '[data-testid*="editor"]',
                'textarea[placeholder*="正文"]', 'textarea[placeholder*="描述"]',
                'textarea[placeholder*="内容"]',
            ]
            body_input = None
            for sel in body_selectors:
                try:
                    body_input = await page.wait_for_selector(sel, timeout=1500)
                    if body_input:
                        break
                except PWTimeout:
                    continue

            if body_input:
                await body_input.fill(body[:MAX_BODY_LEN])
                await body_input.press('End')
                print(f"[xhs] 正文已填写 ({len(body[:MAX_BODY_LEN])} 字)")
                body_filled = True
            else:
                print("[xhs] ⚠️ 未找到正文输入框（CSS选择器）")
        except Exception as e:
            print(f"[xhs] ⚠️ 填写正文失败: {e}")

        # 策略B: DOM evaluate兜底
        if not body_filled:
            try:
                await page.evaluate(f'''
                    (text) => {{
                        // 方法1: contenteditable
                        const eds = document.querySelectorAll('div[contenteditable]');
                        for (const el of eds) {{
                            if (el.offsetHeight > 50) {{
                                el.innerText = text;
                                el.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
                                return 'found contenteditable';
                            }}
                        }}
                        // 方法2: role=textbox
                        const tbs = document.querySelectorAll('[role="textbox"]');
                        for (const el of tbs) {{
                            if (el.offsetHeight > 50) {{
                                el.innerText = text;
                                el.dispatchEvent(new InputEvent('input', {{ bubbles: true }}));
                                return 'found role=textbox';
                            }}
                        }}
                        // 方法3: 大textarea
                        const tas = document.querySelectorAll('textarea');
                        for (const el of tas) {{
                            if (el.offsetHeight > 50 || el.getAttribute('maxlength') > 100) {{
                                el.value = text;
                                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                return 'found textarea';
                            }}
                        }}
                        return 'not found';
                    }}
                ''', body[:MAX_BODY_LEN])
                print(f"[xhs] 正文已通过DOM evaluate填写")
                body_filled = True
            except Exception as e2:
                print(f"[xhs] ⚠️ DOM evaluate填写正文也失败: {e2}")

        # 如果都没填上，提示手动复制
        if not title_filled or not body_filled:
            print("[xhs] ❌ 自动填写失败，请手动复制以下内容到小红书:")
            print("=" * 40)
            print(f"【标题】{title[:MAX_TITLE_LEN]}")
            print(f"【正文】\n{body[:MAX_BODY_LEN]}")
            print("=" * 40)

        # ── 4. 暂停等待用户手动上传图片 ──
        print("\n" + "=" * 50)
        print("[xhs] ⏸️  脚本已暂停，请在浏览器窗口中:")
        print("      1. 手动上传至少 1 张封面图片")
        print("      2. 确认标题和正文已正确填写")
        print("      3. 完成后在终端按回车键，脚本将自动点击发布")
        print("=" * 50 + "\n")

        # 尝试等待用户输入（交互式终端）
        try:
            import sys
            if sys.stdin.isatty():
                # 在另一个线程等待输入，不阻塞事件循环
                await asyncio.to_thread(input, "[xhs] 按回车键继续发布...")
            else:
                # 非交互式环境，等待30秒后自动继续
                print("[xhs] 非交互式环境，30秒后自动继续...")
                await asyncio.sleep(30)
        except (EOFError, OSError):
            print("[xhs] 无法读取输入，30秒后自动继续...")
            await asyncio.sleep(30)

        # ── 5. 点击发布 ──
        publish_clicked = False
        try:
            publish_selectors = [
                'button:has-text("发布")',
                'button:has-text("立即发布")',
                '[class*="publish"] button',
                '[class*="Publish"] button',
                'button[type="submit"]',
                'div:has-text("发布")',
                'span:has-text("发布")',
            ]
            publish_btn = None
            for sel in publish_selectors:
                try:
                    publish_btn = await page.wait_for_selector(sel, timeout=2000)
                    if publish_btn:
                        break
                except PWTimeout:
                    continue

            if publish_btn:
                await publish_btn.click()
                print("[xhs] ✅ 已点击发布")
                publish_clicked = True
                await page.wait_for_timeout(5000)
            else:
                print("[xhs] ⚠️ 未找到发布按钮（CSS选择器）")
        except Exception as e:
            print(f"[xhs] ⚠️ 点击发布失败: {e}")

        # 兜底：DOM evaluate找发布按钮
        if not publish_clicked:
            try:
                result = await page.evaluate('''() => {
                    const btns = document.querySelectorAll('button, div, span');
                    for (const el of btns) {
                        if (el.innerText && el.innerText.trim() === '发布' && el.offsetHeight > 20) {
                            el.click();
                            return 'clicked';
                        }
                    }
                    return 'not found';
                }''')
                if result == 'clicked':
                    print("[xhs] ✅ 已通过DOM evaluate点击发布")
                    publish_clicked = True
                    await page.wait_for_timeout(5000)
                else:
                    print("[xhs] ❌ 未找到发布按钮")
                    await browser.close()
                    return False
            except Exception as e2:
                print(f"[xhs] ❌ 发布彻底失败: {e2}")
                await browser.close()
                return False

        # 保存可能更新的 Cookie
        await save_cookies(context)
        await browser.close()
        return True


# ═══════════════════════════════════════════════════════
# Markdown 文案解析
# ═══════════════════════════════════════════════════════

def parse_xiaohongshu_md(md_path: Path) -> tuple[str, str]:
    """
    解析生成的小红书 markdown 文案，提取标题和正文

    Returns:
        (title, body) 元组
    """
    text = md_path.read_text(encoding="utf-8")

    # 第一行通常是大标题，如 "✅ 2026-05-01 语音/AI论文速递 | 21篇精选"
    lines = text.strip().split("\n")
    title = ""
    body = text

    # 尝试提取一个简洁标题
    first_line = lines[0].strip() if lines else ""
    # 去掉 emoji 前缀
    title_clean = re.sub(r'^[✅📦🔥✨🏷️📄🛠️📋📈💬👇\s]+', '', first_line)
    # 去掉 | 及后面的内容
    title_clean = re.sub(r'\s*\|.*$', '', title_clean).strip()
    # 限制长度
    title = title_clean[:MAX_TITLE_LEN]

    if not title:
        title = "论文速递"

    # 正文去掉最后的标签行（#论文速递 #语音技术...）
    body = re.sub(r'\n#[^\n]+$', '', text).strip()
    # 去掉 markdown 链接语法 [text](url) → text
    body = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', body)
    # 去掉 markdown 图片语法
    body = re.sub(r'!\[([^\]]*)\]\([^)]+\)', '', body)

    return title, body


# ═══════════════════════════════════════════════════════
# 主入口
# ═══════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(prog='xiaohongshu-publisher.py', allow_abbrev=False)
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument('--login', action='store_true')
    mode_group.add_argument('--all', action='store_true')
    parser.add_argument('--date')
    parser.add_argument('--text')
    parser.add_argument('--headless', action='store_true')
    args = parser.parse_args()
    if args.login and (args.date or args.text or args.headless):
        parser.error('--login 不能与 --date、--text 或 --headless 同时使用')
    if args.all and args.text:
        parser.error('--all 不能与 --text 同时使用')
    if args.date:
        try:
            datetime.strptime(args.date, '%Y-%m-%d')
        except ValueError:
            parser.error(f'--date 必须是有效的 YYYY-MM-DD 日期: {args.date!r}')

    mode = 'login' if args.login else ('publish_all' if args.all else 'publish')
    target_date = args.date
    custom_text = args.text
    headless = args.headless

    if mode == "login":
        result = asyncio.run(do_login(headless=False))
        sys.exit(0 if result else 1)

    if mode == "publish":
        today = target_date or today_bj()
        if custom_text:
            title = custom_text[:MAX_TITLE_LEN]
            body = custom_text
        else:
            # 读取今日文案
            md_path = xiaohongshu_markdown_path(today, "top5")
            if not md_path.exists():
                # 尝试 all 版本
                md_path = xiaohongshu_markdown_path(today, "all")
            if not md_path.exists():
                print(f"[xhs] ❌ 未找到文案文件: {md_path}")
                print(f"[xhs] 请先生成文案: npm run xiaohongshu -- --date {today}")
                sys.exit(1)
            title, body = parse_xiaohongshu_md(md_path)

        # 自动使用 ~/Pictures/ 下的博客截图（按时间顺序）
        image_files = find_screenshot_images(today)
        if len(image_files) >= 4:
            images = image_files[:4]
            print(f"[xhs] 将上传 {len(images)} 张图片")
        else:
            images = None
            print("[xhs] ⚠️ 未找到博客截图图片")

        result = asyncio.run(publish_note(title, body, images=images, headless=headless))
        sys.exit(0 if result else 1)

    if mode == "publish_all":
        today = target_date or today_bj()
        md_path = xiaohongshu_markdown_path(today, "all")
        if not md_path.exists():
            md_path = xiaohongshu_markdown_path(today, "top5")
        if not md_path.exists():
            print(f"[xhs] ❌ 未找到文案文件")
            sys.exit(1)
        title, body = parse_xiaohongshu_md(md_path)

        image_files = find_screenshot_images(today)
        images = image_files[:4] if len(image_files) >= 4 else None

        result = asyncio.run(publish_note(title, body, images=images, headless=headless))
        sys.exit(0 if result else 1)


if __name__ == "__main__":
    main()
