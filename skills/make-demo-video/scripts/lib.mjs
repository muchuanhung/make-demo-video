import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const STYLES_DIR = path.join(SKILL_DIR, "styles");

export const KINDS = ["title", "terminal", "file", "browser", "points", "outro"];
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
  style.radius ??= 8;
  return style;
}

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

// 讀分鏡表並檢查；錯誤訊息要讓寫分鏡表的人（或 Claude）知道改哪一幕的哪個欄位。
export async function loadStoryboard(file) {
  const board = JSON.parse(await readFile(file, "utf8"));
  const dir = path.dirname(path.resolve(file));
  const size = SIZES[board.aspect || "16:9"];
  if (!size) throw new Error(`aspect 只能是 ${Object.keys(SIZES).join("、")}`);
  if (!Array.isArray(board.scenes) || !board.scenes.length) throw new Error("分鏡表沒有 scenes");
  const problems = [];
  for (const [i, scene] of board.scenes.entries()) {
    const where = `第 ${i + 1} 幕（${scene.id || scene.kind}）`;
    if (!KINDS.includes(scene.kind)) problems.push(`${where}：kind 只能是 ${KINDS.join("、")}`);
    if (!(scene.seconds >= 1 && scene.seconds <= 30)) problems.push(`${where}：seconds 要在 1 到 30 之間`);
    if (["title", "outro"].includes(scene.kind) && !scene.heading) problems.push(`${where}：少了 heading`);
    if (["terminal", "file"].includes(scene.kind) && !scene.lines?.length) problems.push(`${where}：少了 lines`);
    if (scene.kind === "points" && !scene.items?.length) problems.push(`${where}：少了 items`);
    if (scene.kind === "browser") {
      const image = scene.image && path.resolve(dir, scene.image);
      if (!image || !existsSync(image)) problems.push(`${where}：找不到 image「${scene.image}」（路徑相對於分鏡表）`);
      else {
        const mime = MIME[path.extname(image).toLowerCase()];
        if (!mime) problems.push(`${where}：image 只支援 png、jpg、webp、gif`);
        else scene.image = `data:${mime};base64,${(await readFile(image)).toString("base64")}`;
      }
    }
  }
  if (problems.length) throw new Error("分鏡表有問題：\n- " + problems.join("\n- "));
  return {
    ...board,
    width: size[0],
    height: size[1],
    portrait: size[1] > size[0],
    duration: board.scenes.reduce((sum, s) => sum + s.seconds, 0),
  };
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
