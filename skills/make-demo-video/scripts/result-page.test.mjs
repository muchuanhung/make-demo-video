import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resultPage, readableMuted, contrast } from "./result-page.mjs";

const studio = JSON.parse(await readFile(new URL("../styles/studio.json", import.meta.url), "utf8"));
const neon = JSON.parse(await readFile(new URL("../styles/neon.json", import.meta.url), "utf8"));

const board = (portrait, extra = {}) => ({
  title: "示範 <片>", url: "https://example.com/", portrait,
  width: portrait ? 720 : 1280, height: portrait ? 1280 : 720, duration: 12, raw: [{}, {}, {}], ...extra,
});
const files = { mp4: "demo.mp4", mp4Bytes: 2 * 1048576, gif: "demo.gif", gifBytes: 3 * 1048576, gifWidth: 640, qrSvg: "<svg></svg>", credit: { url: "https://github.com/x/make-demo-video" } };

test("直式用左影片右介紹，橫式用影片全寬加下載卡", () => {
  assert.match(resultPage(board(true), studio, files), /<main class="portrait">/);
  const land = resultPage(board(false), studio, files);
  assert.match(land, /<main class="landscape">/);
  assert.match(land, /2\.0 MB · 1280×720/);
  assert.match(land, /3\.0 MB · 640 寬/);
  assert.doesNotMatch(land, /複製 README/);
});

test("顏色取自風格檔，換風格就換色", () => {
  const a = resultPage(board(true), studio, files);
  const b = resultPage(board(true), neon, files);
  assert.match(a, new RegExp(`--bg: ${studio.colors.bg};`));
  assert.match(a, new RegExp(`--accent: ${studio.colors.accent};`));
  assert.match(b, new RegExp(`--bg: ${neon.colors.bg};`));
  assert.match(b, /風格：/);
});

test("次要文字對比不夠時調深，夠的時候不動", () => {
  const fixed = readableMuted(studio.colors);
  assert.notEqual(fixed, studio.colors.muted);
  assert.ok(contrast(fixed, studio.colors.surface) >= 4.5);
  assert.ok(contrast(fixed, studio.colors.bg) >= 4.5);
  assert.equal(readableMuted({ ...studio.colors, muted: "#555555" }), "#555555");
  assert.equal(readableMuted({ ...studio.colors, muted: "rgb(1 2 3)" }), "rgb(1 2 3)");
});

test("深色風格往亮的方向調", () => {
  const colors = { ...neon.colors, muted: "#4a3d66" };
  const fixed = readableMuted(colors);
  assert.ok(contrast(fixed, colors.bg) >= 4.5 && contrast(fixed, colors.surface) >= 4.5);
});

test("沒有網址就不放 QR，也不放 README 語法", () => {
  const html = resultPage(board(false, { url: "" }), studio, { mp4: "demo.mp4" });
  assert.doesNotMatch(html, /class="qr"/);
  assert.doesNotMatch(html, /複製 README/);
});

test("非 http 網址不放進連結", () => {
  const html = resultPage(board(true, { url: "javascript:alert(1)" }), studio, files);
  assert.doesNotMatch(html, /javascript:/);
});

test("按鈕字在強調色上對比不夠時換成主文字色，夠的時候不動", async () => {
  const { readableOnAccent } = await import("./result-page.mjs");
  const warm = { ...studio.colors, accent: "#ff7928", accentText: "#ffffff" };
  assert.equal(readableOnAccent(warm), warm.text);
  assert.equal(readableOnAccent(neon.colors), neon.colors.accentText);
});

test("出處分行顯示，並請大家到 repo 點 Star", () => {
  for (const portrait of [true, false]) {
    const html = resultPage(board(portrait), studio, files);
    assert.match(html, /<span>用 <b>make-demo-video<\/b> 做的<\/span>\s*<a href="https:\/\/github\.com\/x\/make-demo-video">/);
    assert.match(html, /class="btn star" href="https:\/\/github\.com\/x\/make-demo-video">⭐ GitHub 點星/);
  }
});
