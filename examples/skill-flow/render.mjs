#!/usr/bin/env node
// README 的操作示範：把 flow.html 逐格截圖，合成 skill-flow.mp4 與 skill-flow.gif。
// 用法（repo 根目錄）：node examples/skill-flow/render.mjs [--fps 20]
// 會先確認 out/demo.mp4（source/ 裡 claude.tw 的分鏡表用 studio 算的影片）與 frames/（分鏡縮圖）在不在，沒有就先算。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const skill = path.join(root, "skills/make-demo-video");
const { launchBrowser, parseArgs } = await import(path.join(skill, "scripts/lib.mjs"));
const { default: ffmpegPath } = await import(path.join(skill, "node_modules/ffmpeg-static/index.js"));

const args = parseArgs(process.argv.slice(2));
const fps = Number(args.fps || 20);
const board = path.join(here, "source/storyboard.json");

function run(cmd, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} 結束碼 ${code}`))));
  });
}

if (!existsSync(path.join(here, "frames/scene-1.png"))) {
  await run("node", [path.join(skill, "scripts/frames.mjs"), "--storyboard", board, "--style", "studio", "--out", path.join(here, "frames")]);
}
if (!existsSync(path.join(here, "out/demo.mp4"))) {
  // 示範裡在分鏡板按了第 5 幕的 ↑，所以結果頁播的影片是第 4、5 幕對調後的版本
  const src = JSON.parse(await readFile(board, "utf8"));
  const scenes = src.scenes.map((s) => (s.image ? { ...s, image: path.resolve(path.dirname(board), s.image) } : s));
  [scenes[3], scenes[4]] = [scenes[4], scenes[3]];
  await mkdir(path.join(here, "out"), { recursive: true });
  const swapped = path.join(here, "out/storyboard.json");
  await writeFile(swapped, JSON.stringify({ ...src, scenes }, null, 2));
  await run("node", [path.join(skill, "scripts/render.mjs"), "--storyboard", swapped, "--style", "studio", "--out", path.join(here, "out"), "--no-gif", "--no-open"]);
}

const mp4 = path.join(here, "skill-flow.mp4");
const gif = path.join(here, "skill-flow.gif");
const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (err) => { throw new Error("flow.html 出錯：" + err.message); });
  await page.goto("file://" + path.join(here, "flow.html"));
  await page.evaluate(() => window.ready);
  const duration = await page.evaluate(() => window.DURATION);

  const ffmpeg = spawn(ffmpegPath, [
    "-y", "-loglevel", "error",
    "-f", "image2pipe", "-framerate", String(fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", mp4,
  ], { stdio: ["pipe", "ignore", "inherit"] });
  const closed = once(ffmpeg, "close");
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.seek(t), i / fps);
    const shot = await page.screenshot({ type: "jpeg", quality: 92 });
    if (!ffmpeg.stdin.write(shot)) await once(ffmpeg.stdin, "drain");
    if (i % fps === 0) process.stdout.write(`\r算圖中 ${Math.round((i / frames) * 100)}%`);
  }
  ffmpeg.stdin.end();
  const [code] = await closed;
  if (code !== 0) throw new Error("ffmpeg 失敗");
  process.stdout.write("\r算圖中 100%\n");
} finally {
  await browser.close();
}

await run(ffmpegPath, [
  "-y", "-loglevel", "error", "-i", mp4,
  "-vf", "fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
  gif,
]);
console.log(`MP4  ${mp4}\nGIF  ${gif}`);
