import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import QRCode from "qrcode";
import { expandShots, lintShots } from "./shots.mjs";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STYLES_DIR = path.join(SKILL_DIR, "styles");

export const KINDS = ["title", "terminal", "file", "browser", "phone", "card", "points", "outro"];
export const TONES = ["base", "invert", "accent"];
export const TRANSITIONS = ["cut", "fade", "slide", "blur", "wipe", "push", "zoom", "flash", "iris"];
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
  const anchorMap = new Map();
  for (const s of board.scenes) {
    for (const img of [s.image, s.after]) {
      if (!img || anchorMap.has(img)) continue;
      const json = path.resolve(dir, img.replace(/\.[^.]+$/, ".json"));
      anchorMap.set(img, existsSync(json) ? JSON.parse(await readFile(json, "utf8")).anchors ?? null : null);
    }
  }
  const expanded = expandShots(board, { anchorsOf: (img) => anchorMap.get(img) ?? null });
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
    if (scene.tone && !TONES.includes(scene.tone)) problems.push(`${where}：tone 只能是 ${TONES.join("、")}`);
    if (scene.transition && !TRANSITIONS.includes(scene.transition)) problems.push(`${where}：transition 只能是 ${TRANSITIONS.join("、")}`);
    if (scene.layout && !LAYOUTS.includes(scene.layout)) problems.push(`${where}：layout 只能是 ${LAYOUTS.join("、")}`);
    if (scene.kind === "phone" && scene.tags?.length > 6) problems.push(`${where}：tags 最多 6 個`);
    if (["terminal", "file"].includes(scene.kind) && !scene.lines?.length) problems.push(`${where}：少了 lines`);
    if (scene.kind === "points" && !scene.items?.length) problems.push(`${where}：少了 items`);
    if (scene.kind === "browser" || scene.kind === "phone") {
      const image = scene.image && path.resolve(dir, scene.image);
      if (!image || !existsSync(image)) problems.push(`${where}：找不到 image「${scene.image}」（路徑相對於分鏡表）`);
      else if (!images[scene.image]) {
        const mime = MIME[path.extname(image).toLowerCase()];
        if (!mime) problems.push(`${where}：image 只支援 png、jpg、webp、gif`);
        // 同一張截圖只嵌一次，各幕用檔名對到 images
        else images[scene.image] = `data:${mime};base64,${(await readFile(image)).toString("base64")}`;
      }
    }
  }
  if (problems.length) throw new Error("分鏡表有問題：\n- " + problems.join("\n- "));
  return {
    ...board,
    raw: board.scenes,
    scenes,
    images,
    rows: expanded.rows,
    warnings: lintShots(expanded),
    width: size[0],
    height: size[1],
    portrait: size[1] > size[0],
    // 0.7、0.6 這類秒數相加會有浮點誤差（11.999999…），四捨五入到毫秒。
    duration: Math.round(scenes.reduce((sum, s) => sum + s.seconds, 0) * 1000) / 1000,
  };
}

/** 自動檢查的提醒，印給 Claude 看（不擋算圖）。 */
export function formatWarnings(warnings) {
  if (!warnings.length) return "";
  return "分鏡檢查提醒（先修掉再交出去）：\n- " + warnings.map((w) => w.message).join("\n- ");
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
<script>${js}</script>
</body></html>`;
}
