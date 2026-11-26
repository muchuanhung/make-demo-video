import { readFile, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { expandShots, lintShots, findAnchor } from "./shots.mjs";
import { planCamera, planCursor, planMarks, planPresses, cameraRuntime, handoffRect } from "./camera.mjs";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STYLES_DIR = path.join(SKILL_DIR, "styles");

export const KINDS = ["title", "terminal", "file", "browser", "phone", "card", "points", "outro", "stat", "page"];
export const TONES = ["base", "invert", "accent"];
export const TRANSITIONS = ["cut", "fade", "slide", "blur", "wipe", "push", "zoom", "flash", "iris", "pan"];
export const LAYOUTS = ["right", "left", "big"];
const SIZES = { "16:9": [1280, 720], "9:16": [720, 1280], "1:1": [1080, 1080] };

export function parseArgs(argv, booleans = []) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    if (booleans.includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

export async function listStyles() {
  const files = (await readdir(STYLES_DIR)).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(STYLES_DIR, f), "utf8"))));
}

// 風格可以是內建的 id，也可以是一份自訂風格檔的路徑。
export async function loadStyle(idOrPath) {
  const builtin = path.join(STYLES_DIR, idOrPath + ".json");
  const file = existsSync(builtin) ? builtin : path.resolve(idOrPath);
  if (!existsSync(file)) {
    const ids = (await listStyles()).map((s) => s.id).join("、");
    throw new Error(`找不到風格「${idOrPath}」。內建風格：${ids}；或傳入自訂風格檔的路徑。`);
  }
  const style = JSON.parse(await readFile(file, "utf8"));
  for (const key of ["bg", "surface", "text", "muted", "accent", "accentText", "border"]) {
    if (!style.colors?.[key]) throw new Error(`風格檔 ${file} 少了 colors.${key}`);
  }
  for (const key of ["display", "body", "mono"]) {
    if (!style.fonts?.[key]) throw new Error(`風格檔 ${file} 少了 fonts.${key}`);
  }
  if (style.fontUrl && !/^https:\/\//.test(style.fontUrl)) throw new Error(`風格檔 ${file} 的 fontUrl 要是 https 網址（例如 Google Fonts 的 CSS 網址）`);
  style.radius ??= 8;
  return style;
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

// 讀分鏡表並檢查；錯誤訊息要讓寫分鏡表的人（或 Claude）知道改哪一幕的哪個欄位。
// 有 shot（鏡頭模板）的幕先展開成低階分鏡；回傳的 rows 是「每一句」的起點與長度（面板、縮圖用），
// warnings 是自動檢查的提醒（不擋算圖，但 Claude 要先修掉）。
export async function loadStoryboard(file) {
  const board = JSON.parse(await readFile(file, "utf8"));
  const dir = path.dirname(path.resolve(file));
  const size = SIZES[board.aspect || "16:9"];
  if (!size) throw new Error(`aspect 只能是 ${Object.keys(SIZES).join("、")}`);
  if (!Array.isArray(board.scenes) || !board.scenes.length) throw new Error("分鏡表沒有 scenes");

  // 截圖旁邊的錨點檔（home-full.png → home-full.json，capture.mjs --full 會一起產生）
  // pageMap 留整份錨點檔（頁面寬高給攝影機算位置），anchorsOf 只給錨點陣列。
  const pageMap = new Map();
  for (const s of board.scenes) {
    for (const img of [s.image, s.after, ...(s.presses || []).map((p) => p.after), ...(s.images || []).map((im) => im.image)]) {
      if (!img || pageMap.has(img)) continue;
      const json = path.resolve(dir, img.replace(/\.[^.]+$/, ".json"));
      pageMap.set(img, existsSync(json) ? JSON.parse(await readFile(json, "utf8")) : null);
    }
  }
  const expanded = expandShots(board, { anchorsOf: (img) => pageMap.get(img)?.anchors ?? null });
  const problems = [...expanded.problems];
  const scenes = expanded.scenes;
  const images = {};

  for (const scene of scenes) {
    const where = `第 ${scene.row + 1} 幕（${scene.shot || scene.id || scene.kind}）`;
    if (!KINDS.includes(scene.kind)) problems.push(`${where}：kind 只能是 ${KINDS.join("、")}`);
    // 模板展開出來的半幕（例如 toggle 的切換前）可以短到 0.3 秒；自己寫的幕最短 0.5 秒
    const min = scene.shot ? 0.3 : 0.5;
    if (!(scene.seconds >= min && scene.seconds <= 30)) problems.push(`${where}：seconds 要在 ${min} 到 30 之間`);
    if (["title", "outro", "card"].includes(scene.kind) && !scene.heading) problems.push(`${where}：少了 heading`);
    if (scene.kind === "stat" && !scene.shot && !scene.count) problems.push(`${where}：少了 value（要跳動的數字）`);
    if (scene.tone && !TONES.includes(scene.tone)) problems.push(`${where}：tone 只能是 ${TONES.join("、")}`);
    if (scene.transition && !TRANSITIONS.includes(scene.transition)) problems.push(`${where}：transition 只能是 ${TRANSITIONS.join("、")}`);
    if (scene.layout && !LAYOUTS.includes(scene.layout)) problems.push(`${where}：layout 只能是 ${LAYOUTS.join("、")}`);
    if (scene.phoneScale != null && !(typeof scene.phoneScale === "number" && scene.phoneScale >= 0.4 && scene.phoneScale <= 1.2)) problems.push(`${where}：phoneScale 要是 0.4–1.2 的數字（1 是原本大小）`);
    if (scene.kind === "phone" && scene.tags?.length > 6) problems.push(`${where}：tags 最多 6 個`);
    if (["terminal", "file"].includes(scene.kind) && !scene.lines?.length) problems.push(`${where}：少了 lines`);
    if (scene.kind === "points" && !scene.items?.length) problems.push(`${where}：少了 items`);
    if (scene.kind === "browser" || scene.kind === "phone" || scene.kind === "page") {
      const image = scene.image && path.resolve(dir, scene.image);
      if (!image || !existsSync(image)) problems.push(`${where}：找不到 image「${scene.image}」（路徑相對於分鏡表）`);
      else if (!images[scene.image]) {
        const mime = MIME[path.extname(image).toLowerCase()];
        if (!mime) problems.push(`${where}：image 只支援 png、jpg、webp、gif`);
        // 同一張截圖只嵌一次，各幕用檔名對到 images
        else images[scene.image] = `data:${mime};base64,${(await readFile(image)).toString("base64")}`;
      }
    }
    // 按按鈕：按了之後的截圖也要嵌進去（剪一塊蓋在按鈕上）
    for (const p of scene.kind === "page" ? scene.presses || [] : []) {
      if (!p.after || images[p.after]) continue;
      const file = path.resolve(dir, p.after);
      const mime = MIME[path.extname(file).toLowerCase()];
      if (!existsSync(file)) problems.push(`${where}：找不到 after「${p.after}」（路徑相對於分鏡表）`);
      else if (mime) images[p.after] = `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
    }
  }
  const cameraWarnings = planPages(scenes, { pageMap, frame: { w: size[0], h: size[1] }, beat: board.beat || 0.5, problems, dir });
  if (problems.length) throw new Error("分鏡表有問題：\n- " + problems.join("\n- "));
  return {
    ...board,
    raw: board.scenes,
    scenes,
    images,
    rows: expanded.rows,
    warnings: [...lintShots(expanded), ...cameraWarnings],
    width: size[0],
    height: size[1],
    portrait: size[1] > size[0],
    // 0.7、0.6 這類秒數相加會有浮點誤差（11.999999…），四捨五入到毫秒。
    duration: Math.round(scenes.reduce((sum, s) => sum + s.seconds, 0) * 1000) / 1000,
  };
}

// page 幕（網頁鋪滿畫面＋攝影機）：把運鏡排成關鍵格寫進 scene.cam，游標寫進 scene.cursor、scene.clickAt。
// 前一幕也是 page 時，攝影機從前一幕的最後一格接著走（一鏡到底），除非這一幕自己寫了 start；
// 游標也一樣接著（畫面上的位置不變）。有 clicks 或接到上一幕的游標才畫游標，寫 cursor: false 收起來。
function planPages(scenes, { pageMap, frame, beat, problems, dir }) {
  const warnings = [];
  let prevEnd = null;
  let prevCursor = null;
  let handoff = null; // 上一幕 page 最後按的東西在畫面上的位置（收尾的網址膠囊從這裡長出來）
  scenes.forEach((scene) => {
    if (scene.kind !== "page") {
      if (scene.shot === "dock" && handoff) scene.pillFrom = handoff;
      prevEnd = null; prevCursor = null; handoff = null;
      return;
    }
    handoff = null;
    const where = `第 ${scene.row + 1} 幕（page）`;
    const data = pageMap.get(scene.image);
    if (!data?.width || !data?.height) {
      problems.push(`${where}：${scene.image} 沒有新版錨點檔（要有頁面寬高與 box）；用 capture.mjs --full 重新截圖`);
      prevEnd = null;
      prevCursor = null;
      return;
    }
    const page = { w: data.width, h: data.height, anchors: data.anchors };
    const plan = planCamera(scene, { start: scene.start ? null : prevEnd, page, frame, beat, findAnchor });
    for (const p of plan.problems) problems.push(`${where}：${p}`);
    for (const w of plan.warnings) warnings.push({ row: scene.row, message: `${where}：${w}` });
    scene.cam = plan.keys;
    prevEnd = plan.end;

    if (scene.marks?.length) {
      const marks = planMarks(scene, { cam: plan.keys, page, frame, findAnchor, lumaOf: (rect) => luma(path.resolve(dir, scene.image), rect) });
      for (const p of marks.problems) problems.push(`${where}：${p}`);
      for (const w of marks.warnings) warnings.push({ row: scene.row, message: `${where}：${w}` });
      scene.markAt = marks.marks;
    }

    // 按按鈕：只換掉按鈕那一塊；按下去也算一次點擊（游標移過去、光圈）
    let clicks = scene.clicks || [];
    if (scene.presses?.length) {
      const afterPageOf = (img) => {
        const d = pageMap.get(img);
        return d?.width ? { w: d.width, h: d.height, anchors: d.anchors } : null;
      };
      const changed = (a, b) => !looksSame(path.resolve(dir, scene.image), a.rect, path.resolve(dir, b.image), b.rect);
      const presses = planPresses(scene, { page, afterPageOf, findAnchor, changed });
      for (const p of presses.problems) problems.push(`${where}：${p}`);
      for (const w of presses.warnings) warnings.push({ row: scene.row, message: `${where}：${w}` });
      scene.swaps = presses.swaps;
      clicks = [...clicks, ...presses.clicks];
    }

    const wantCursor = scene.cursor !== false && (clicks.length || prevCursor);
    handoff = handoffRect({ ...scene, clicks }, { cam: plan.keys, page, frame, findAnchor, cursorEnd: null });
    if (!wantCursor) { prevCursor = null; return; }
    const cursor = planCursor({ ...scene, clicks }, { cam: plan.keys, start: prevCursor, page, frame, beat, findAnchor });
    for (const p of cursor.problems) problems.push(`${where}：${p}`);
    for (const w of cursor.warnings) warnings.push({ row: scene.row, message: `${where}：${w}` });
    scene.cursor = cursor.keys;
    scene.clickAt = cursor.clicks;
    prevCursor = cursor.end;
    handoff ||= handoffRect({ ...scene, clicks: [] }, { cam: plan.keys, page, frame, findAnchor, cursorEnd: cursor.end });
  });
  return warnings;
}

// 讀截圖的像素（只讀 png，讀不到回傳 null）；同一張圖只解一次。
const pngCache = new Map();
function readPng(file) {
  if (!pngCache.has(file)) {
    let png = null;
    try {
      if (/\.png$/i.test(file)) png = PNG.sync.read(readFileSync(file));
    } catch {
      png = null;
    }
    pngCache.set(file, png);
  }
  return pngCache.get(file);
}

// 在一塊範圍（比例 [x0, y0, x1, y1]）裡取 9×5 個點的亮度（0 黑–1 白）
function sampleLuma(png, [x0, y0, x1, y1]) {
  const out = [];
  for (let j = 0; j <= 4; j++) for (let i = 0; i <= 8; i++) {
    const x = Math.max(0, Math.min(png.width - 1, Math.round((x0 + ((x1 - x0) * i) / 8) * png.width)));
    const y = Math.max(0, Math.min(png.height - 1, Math.round((y0 + ((y1 - y0) * j) / 4) * png.height)));
    const k = (y * png.width + x) * 4;
    out.push((0.2126 * png.data[k] + 0.7152 * png.data[k + 1] + 0.0722 * png.data[k + 2]) / 255);
  }
  return out;
}

// 平均亮度，螢光筆用來決定淺底還是深底的畫法；讀不到就當淺底。
function luma(file, rect) {
  const png = readPng(file);
  if (!png) return 1;
  const v = sampleLuma(png, rect);
  return v.reduce((a, b) => a + b, 0) / v.length;
}

// 兩張截圖上的兩塊看起來一不一樣（按按鈕前後）；讀不到圖時當作不一樣，不亂提醒。
function looksSame(fileA, rectA, fileB, rectB) {
  const a = readPng(fileA), b = readPng(fileB);
  if (!a || !b) return false;
  const va = sampleLuma(a, rectA), vb = sampleLuma(b, rectB);
  const diff = va.reduce((sum, v, i) => sum + Math.abs(v - vb[i]), 0) / va.length;
  return diff < 0.01;
}

/** 自動檢查的提醒，印給 Claude 看（不擋算圖）。 */
export function formatWarnings(warnings) {
  if (!warnings.length) return "";
  return "分鏡檢查提醒（先修掉再交出去）：\n- " + warnings.map((w) => w.message).join("\n- ");
}

// Chromium 一張截圖最高 16384 px（實際像素＝CSS 高度 × 倍率），超過的部分會錯位或重複。
// 整頁長圖超過時切成幾段各截一次再接起來；留一點餘裕，每段不超過 16000 px。
export const MAX_SHOT_PIXELS = 16000;
export function fullPageSlices(height, scale) {
  const step = Math.floor(MAX_SHOT_PIXELS / scale);
  const slices = [];
  for (let y = 0; y < height; y += step) slices.push({ y, height: Math.min(step, height - y) });
  return slices;
}

// 優先用使用者電腦上的 Chrome，不用另外下載瀏覽器；沒有才退回 Playwright 自己的 Chromium。
export async function launchBrowser() {
  const tries = [{ channel: "chrome" }, { channel: "msedge" }, {}];
  for (const options of tries) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch {
      // 換下一個
    }
  }
  throw new Error("找不到可用的瀏覽器。請安裝 Google Chrome，或執行 npx playwright install chromium。");
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

// 播放器頁面：分鏡表與風格內嵌在 HTML 裡，render.mjs 算影片、frames.mjs 算分鏡縮圖都用它。
export async function buildPlayer(board, style) {
  const [css, js] = await Promise.all([
    readFile(path.join(SKILL_DIR, "player/player.css"), "utf8"),
    readFile(path.join(SKILL_DIR, "player/player.js"), "utf8"),
  ]);
  const qrSvg = board.url ? await QRCode.toString(board.url, { type: "svg", margin: 0 }) : "";
  const data = { ...board, style, qrSvg };
  // </script> 出現在資料裡會提前結束 script 區塊，所以把 < 跳脫掉。
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>${escapeHtml(board.title || "demo")}</title>${style.fontUrl ? `<link rel="stylesheet" href="${escapeHtml(style.fontUrl)}">` : ""}<style>${css}</style></head>
<body><div id="stage"></div>
<script>window.__DATA__ = ${json};</script>
<script>window.__CAMERA__ = (${cameraRuntime.toString()})();</script>
<script>${js}</script>
</body></html>`;
}
