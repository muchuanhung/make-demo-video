#!/usr/bin/env node
// 分鏡表 ＋ 風格 → MP4、GIF、結果頁。
// 用法：node render.mjs --storyboard <storyboard.json> --style <id 或風格檔> [--out <資料夾>] [--fps 20] [--no-gif] [--no-open]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import QRCode from "qrcode";
import { SKILL_DIR, parseArgs, loadStyle, loadStoryboard, launchBrowser, escapeHtml } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), ["no-gif", "no-open"]);
if (!args.storyboard || !args.style) {
  console.error("用法：node render.mjs --storyboard <storyboard.json> --style <id 或風格檔> [--out <資料夾>] [--fps 20] [--no-gif] [--no-open]");
  process.exit(2);
}

const started = Date.now();
const fps = Number(args.fps || 20);
const outDir = path.resolve(args.out || path.dirname(args.storyboard));
const name = args.name || "demo";

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 失敗：\n${err.slice(-800)}`))));
  });
}

async function buildPlayer(board, style) {
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
<head><meta charset="utf-8"><title>${escapeHtml(board.title || "demo")}</title><style>${css}</style></head>
<body><div id="stage"></div>
<script>window.__DATA__ = ${json};</script>
<script>${js}</script>
</body></html>`;
}

// 結果頁角落的「用 make-demo-video 做的」：網址取自 plugin.json 的 repository，影片本身就指向這個 repo 時不重複放。
async function loadCredit(boardUrl) {
  try {
    const plugin = JSON.parse(await readFile(path.join(SKILL_DIR, "..", "..", ".claude-plugin", "plugin.json"), "utf8"));
    const url = plugin.repository;
    if (!url || boardUrl?.replace(/\/$/, "") === url.replace(/\/$/, "")) return null;
    return { url, qrSvg: await QRCode.toString(url, { type: "svg", margin: 0 }) };
  } catch {
    return null; // 不是以 plugin 形式安裝（沒有 plugin.json）時就不放
  }
}

function resultPage(board, style, files) {
  const c = style.colors;
  const rows = board.scenes
    .map((s, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(s.kind)}</td><td>${s.seconds}s</td><td>${escapeHtml((s.caption || s.heading || "").replace(/\*\*/g, ""))}</td></tr>`)
    .join("");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(board.title || "demo")}</title>
<style>
  body { margin: 0; padding: 32px 16px; background: ${c.backdrop || c.bg}; color: ${c.text}; font-family: ${style.fonts.body}; }
  main { max-width: 1100px; margin: 0 auto; display: grid; gap: 24px; grid-template-columns: minmax(0, 3fr) minmax(220px, 1fr); align-items: start; }
  @media (max-width: 800px) { main { grid-template-columns: 1fr; } }
  video { width: 100%; max-height: 80vh; background: #000; border-radius: ${style.radius}px; border: 1px solid ${c.border}; }
  aside { background: ${c.surface}; border: 1px solid ${c.border}; border-radius: ${style.radius}px; padding: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p { margin: 4px 0 12px; color: ${c.muted}; font-size: 14px; }
  .qr { background: #fff; padding: 10px; border-radius: 8px; }
  .qr svg { display: block; width: 100%; height: auto; }
  a { color: ${c.text}; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 12px; }
  td { padding: 4px 6px; border-top: 1px solid ${c.border}; vertical-align: top; }
  .credit { display: grid; grid-template-columns: 112px 1fr; gap: 12px; align-items: center; margin: 4px 0 8px; padding-top: 16px; border-top: 1px solid ${c.border}; font-size: 13px; }
  .credit p { margin: 0 0 4px; color: ${c.text}; }
  .credit .qr { padding: 6px; }
</style>
</head>
<body>
<main>
  <video src="${files.mp4}" autoplay loop muted playsinline controls></video>
  <aside>
    <h1>${escapeHtml(board.title || "demo")}</h1>
    <p>風格：${escapeHtml(style.name || style.id)}・${board.duration.toFixed(0)} 秒・${board.width}×${board.height}</p>
    ${files.qrSvg ? `<div class="qr">${files.qrSvg}</div><p><a href="${escapeHtml(board.url)}">${escapeHtml(board.url)}</a></p>` : ""}
    <p>檔案：<a href="${files.mp4}">${files.mp4}</a>${files.gif ? `、<a href="${files.gif}">${files.gif}</a>` : ""}</p>
    ${files.credit ? `<div class="credit"><div class="qr">${files.credit.qrSvg}</div><div><p>用 <b>make-demo-video</b> 做的</p><a href="${escapeHtml(files.credit.url)}">${escapeHtml(files.credit.url.replace(/^https?:\/\//, ""))}</a></div></div>` : ""}
    <table>${rows}</table>
  </aside>
</main>
</body></html>`;
}

async function main() {
  const [board, style] = await Promise.all([loadStoryboard(args.storyboard), loadStyle(args.style)]);
  await mkdir(outDir, { recursive: true });
  const playerFile = path.join(outDir, `${name}.player.html`);
  await writeFile(playerFile, await buildPlayer(board, style));

  const browser = await launchBrowser();
  const mp4 = path.join(outDir, `${name}.mp4`);
  try {
    const page = await browser.newPage({ viewport: { width: board.width, height: board.height } });
    page.on("pageerror", (err) => { throw new Error("播放器出錯：" + err.message); });
    await page.goto("file://" + playerFile);
    await page.evaluate(() => window.ready);

    const ffmpeg = spawn(ffmpegPath, [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let ffmpegErr = "";
    ffmpeg.stderr.on("data", (d) => (ffmpegErr += d));
    const closed = once(ffmpeg, "close");

    const frames = Math.round(board.duration * fps);
    for (let i = 0; i < frames; i++) {
      await page.evaluate((t) => window.seek(t), i / fps);
      const shot = await page.screenshot({ type: "jpeg", quality: 92 });
      if (!ffmpeg.stdin.write(shot)) await once(ffmpeg.stdin, "drain");
      if (i % fps === 0) process.stdout.write(`\r算圖中 ${Math.round((i / frames) * 100)}%`);
    }
    ffmpeg.stdin.end();
    const [code] = await closed;
    if (code !== 0) throw new Error("ffmpeg 失敗：\n" + ffmpegErr.slice(-800));
    process.stdout.write("\r算圖中 100%\n");
  } finally {
    await browser.close();
  }

  let gif = null;
  if (!args["no-gif"]) {
    gif = path.join(outDir, `${name}.gif`);
    const width = Math.min(board.width, 720);
    await run(ffmpegPath, [
      "-y", "-loglevel", "error", "-i", mp4,
      "-vf", `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`,
      gif,
    ]);
  }

  const qrSvg = board.url ? await QRCode.toString(board.url, { type: "svg", margin: 0 }) : "";
  const page = path.join(outDir, `${name}.html`);
  const credit = await loadCredit(board.url);
  await writeFile(page, resultPage(board, style, { mp4: path.basename(mp4), gif: gif && path.basename(gif), qrSvg, credit }));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`完成，花了 ${seconds} 秒（影片 ${board.duration} 秒、${board.scenes.length} 幕、風格 ${style.id}）`);
  console.log(`MP4   ${mp4}`);
  if (gif) console.log(`GIF   ${gif}`);
  console.log(`結果頁 ${page}`);
  console.log(`預覽  ${playerFile}（瀏覽器直接開，不用重新算圖）`);
  if (!args["no-open"] && process.platform === "darwin") spawn("open", [page], { stdio: "ignore", detached: true }).unref();
}

main().catch((err) => {
  console.error("\n" + err.message);
  process.exit(1);
});
