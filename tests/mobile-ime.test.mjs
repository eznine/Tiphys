import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("..", import.meta.url));
let browser;
let script;

before(async () => {
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { MobileBottomCard } from "./src/mobile/MobileBottomCard";
        import { MobileComposer } from "./src/components/MobileComposer";
        import { MobileMapAskBar } from "./src/mobile/MobileMapAskBar";
        import { createMobileBackStack } from "./src/mobile/mobileBack";
        window.__ime.stack = createMobileBackStack();
        window.__ime.stack.subscribe(() => false);
        function Harness() {
          const [value, onChange] = useState("test message");
          const Composer = window.__ime.kind === "map" ? MobileMapAskBar : MobileComposer;
          return <div className="app-shell mobile"><div className="m-shell">
            <MobileBottomCard active="chat" onChange={() => {}} running={0} pending={0}
              status={<div>status</div>}>
              <Composer value={value} onChange={onChange} busy={false} connected unconfigured={false}
                onSend={async () => { window.__ime.sends++; return true; }}
                onCancelTurn={() => {}} onActions={() => {}} onOpenActions={() => {}} />
            </MobileBottomCard>
            <button id="outside">outside</button>
          </div></div>;
        }
        createRoot(document.getElementById("root")).render(<Harness />);
      `,
    },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{
      name: "native-keyboard-events",
      setup(builder) {
        builder.onResolve({ filter: /^@capacitor\/(core|keyboard|app)$/ }, args => ({ path: args.path, namespace: "ime" }));
        builder.onLoad({ filter: /.*/, namespace: "ime" }, args => ({
          contents: args.path.endsWith("core")
            ? `export const Capacitor = {
                isNativePlatform: () => window.__ime.native,
                isPluginAvailable: () => window.__ime.native
              };`
            : `export const ${args.path.endsWith("app") ? "App" : "Keyboard"} = { addListener: async (name, listener) => {
                const listeners = window.__ime.listeners[name] ??= new Set();
                listeners.add(listener);
                return { remove: async () => listeners.delete(listener) };
              }};`,
        }));
      },
    }],
  });
  script = result.outputFiles[0].text;
  const executablePath = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/opt/google/chrome/chrome"]
    .find(candidate => candidate && existsSync(candidate));
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
});

after(async () => { await browser?.close(); });

async function composer(t, { native = true, kind = "chat" } = {}) {
  const page = await browser.newPage({ viewport: { width: 412, height: 800 }, hasTouch: true });
  t.after(() => page.close());
  await page.route("http://ime.test/", route => route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://ime.test/");
  await page.addStyleTag({ content: readFileSync(new URL("../src/styles/mobile.css", import.meta.url), "utf8") });
  await page.evaluate(({ native, kind }) => {
    window.__ime = { native, kind, sends: 0, listeners: {} };
    // Model independent Android IME insets and Capacitor's content-child resize.
    window.__ime.vv = new EventTarget();
    window.__ime.vv.height = 800;
    Object.defineProperty(window, "visualViewport", { configurable: true, value: window.__ime.vv });
    const vk = new EventTarget();
    vk.boundingRect = { height: 0 };
    Object.defineProperty(navigator, "virtualKeyboard", { configurable: true, value: vk });
  }, { native, kind });
  await page.addScriptTag({ content: script });
  await page.waitForSelector(".m-bottom-card input");
  if (native) await page.waitForFunction(() => window.__ime.listeners.keyboardDidHide?.size === 1);
  await page.locator(".m-bottom-card input").tap();
  await page.waitForFunction(() => document.querySelector(".m-bottom-card").dataset.inputFocused === "true");
  return page;
}

async function emit(page, name) {
  await page.evaluate(name => {
    for (const listener of window.__ime.listeners[name] ?? []) listener({ keyboardHeight: 300 });
  }, name);
}

async function state(page) {
  return page.evaluate(() => ({
    focused: document.activeElement === document.querySelector(".m-bottom-card input"),
    folded: document.querySelector(".m-bottom-card").dataset.inputFocused === "true",
    dockHidden: getComputedStyle(document.querySelector(".m-dock")).display === "none",
  }));
}

for (const kind of ["chat", "map"]) {
  test(`${kind}: native WebView resize during IME opening preserves focus and fold`, async t => {
    const page = await composer(t, { kind });
    await emit(page, "keyboardWillShow");
    await page.evaluate(() => {
      window.__ime.vv.height = 500;
      window.__ime.vv.dispatchEvent(new Event("resize"));
      Object.defineProperty(window, "innerHeight", { configurable: true, value: 500 });
      window.dispatchEvent(new Event("resize"));
    });
    assert.deepEqual(await state(page), { focused: true, folded: true, dockHidden: true });
    await page.evaluate(() => navigator.virtualKeyboard.dispatchEvent(new Event("geometrychange")));
    assert.deepEqual(await state(page), { focused: true, folded: true, dockHidden: true });
    await emit(page, "keyboardDidShow");
    await emit(page, "keyboardWillHide");
    await page.waitForFunction(() => document.querySelector(".m-bottom-card").dataset.inputFocused === "false");
    assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
  });
}

test("native hide before any show cannot cancel a slow IME after 700ms", async t => {
  const page = await composer(t);
  await page.evaluate(() => { const now = Date.now(); Date.now = () => now + 2000; });
  await emit(page, "keyboardWillHide");
  await emit(page, "keyboardDidHide");
  assert.deepEqual(await state(page), { focused: true, folded: true, dockHidden: true });
});

test("web viewport shrink then recover still restores the dock", async t => {
  const page = await composer(t, { native: false });
  await page.evaluate(() => {
    window.__ime.vv.height = 500;
    window.__ime.vv.dispatchEvent(new Event("resize"));
    window.__ime.vv.height = 800;
    window.__ime.vv.dispatchEvent(new Event("resize"));
  });
  await page.waitForFunction(() => document.querySelector(".m-bottom-card").dataset.inputFocused === "false");
  assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
});

test("web VirtualKeyboard requires a visible-to-hidden transition", async t => {
  const page = await composer(t, { native: false });
  await page.evaluate(() => navigator.virtualKeyboard.dispatchEvent(new Event("geometrychange")));
  assert.equal((await state(page)).focused, true);
  await page.evaluate(() => {
    navigator.virtualKeyboard.boundingRect.height = 300;
    navigator.virtualKeyboard.dispatchEvent(new Event("geometrychange"));
    navigator.virtualKeyboard.boundingRect.height = 0;
    navigator.virtualKeyboard.dispatchEvent(new Event("geometrychange"));
  });
  await page.waitForFunction(() => document.querySelector(".m-bottom-card").dataset.inputFocused === "false");
  assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
});

test("native didHide works without willHide on repeated keyboard sessions", async t => {
  const page = await composer(t);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await page.locator(".m-bottom-card input").click();
    await emit(page, "keyboardDidShow");
    await emit(page, "keyboardDidHide");
    await page.waitForFunction(() => document.querySelector(".m-bottom-card").dataset.inputFocused === "false");
    assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
  }
});

test("queued blur cleanup cannot cancel a newly focused composer", async t => {
  const page = await composer(t);
  await emit(page, "keyboardWillShow");
  await page.evaluate(() => {
    for (const listener of window.__ime.listeners.keyboardWillHide) listener();
    document.querySelector(".m-bottom-card input").focus();
  });
  // Flush the blur handler's animation-frame + timer, then focusout's 50ms check.
  await page.waitForTimeout(100);
  assert.deepEqual(await state(page), { focused: true, folded: true, dockHidden: true });
});

test("outside tap and send restore immediately even before a native show", async t => {
  const page = await composer(t);
  await page.locator("#outside").click();
  assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
  await page.locator(".m-bottom-card input").click();
  await page.locator(".mobile-composer-send").click();
  assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
  assert.equal(await page.evaluate(() => window.__ime.sends), 1);
});

test("Back restores the dock before the keyboard has shown", async t => {
  const page = await composer(t);
  await page.evaluate(() => history.back());
  await page.waitForFunction(() => document.querySelector(".m-bottom-card").dataset.inputFocused === "false");
  assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
});

test("Capacitor Back / side-swipe consumes the fold immediately", async t => {
  const page = await composer(t);
  await emit(page, "backButton");
  await page.waitForFunction(() => document.querySelector(".m-bottom-card").dataset.inputFocused === "false");
  assert.deepEqual(await state(page), { focused: false, folded: false, dockHidden: false });
});
