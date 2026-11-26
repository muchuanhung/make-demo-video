#!/usr/bin/env node
// 分鏡表 ＋ 風格 → MP4、GIF、結果頁。
// 用法：node render.mjs --storyboard <storyboard.json> --style <id 或風格檔> [--out <資料夾>] [--fps 30] [--music] [--motion-blur 6] [--gif-width 640（直式 360）] [--gif-fps 12] [--no-gif] [--no-open]
import { readFile, writeFile, mkdir, stat, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import QRCode from "qrcode";
import { SKILL_DIR, parseArgs, loadStyle, loadStoryboard, launchBrowser, buildPlayer, formatWarnings } from "./lib.mjs";
import { resultPage, loadCredit } from "./result-page.mjs";
import { soundtrack, toWav, musicPlan, SAMPLE_RATE } from "./soundtrack.mjs";

const args = parseArgs(process.argv.slice(2), ["no-gif", "no-open", "music"]);
if (!args.storyboard || !args.style) {
  console.error("用法：node render.mjs --storyboard <storyboard.json> --style <id 或風格檔> [--out <資料夾>] [--fps 30] [--music] [--motion-blur 6] [--gif-width 640（直式 360）] [--gif-fps 12] [--no-gif] [--no-open]");
  process.exit(2);
}

const started = Date.now();
const fps = Number(args.fps || 30);
// 動態模糊：每格多拍幾張（子格）再平均；1 就是不加
const sub = Number(args["motion-blur"] || 1);
if (!(Number.isInteger(sub) && sub >= 1 && sub <= 8)) {
  console.error("--motion-blur 要是 1–8 的整數（每格拍幾張再平均，建議 6）");
  process.exit(2);
}
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

async function main() {
  const [board, style] = await Promise.all([loadStoryboard(args.storyboard), loadStyle(args.style)]);
  const warn = formatWarnings(board.warnings);
  if (warn) console.log(warn);
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

    // 配樂照節拍與每一句的起點合成，先寫成暫存的 WAV 再跟畫面一起交給 ffmpeg
    const wav = args.music ? path.join(outDir, `${name}.music.wav`) : null;
    if (wav) {
      const samples = soundtrack(musicPlan(board));
      await writeFile(wav, toWav(samples, SAMPLE_RATE));
    }
    const ffmpeg = spawn(ffmpegPath, [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps * sub), "-c:v", "mjpeg", "-i", "-",
      ...(wav ? ["-i", wav] : []),
      // 每 sub 張子格平均成一格（tmix），再只留每組的最後一張
      ...(sub > 1 ? ["-vf", `tmix=frames=${sub},select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/(${fps}*TB)`, "-r", String(fps)] : []),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
      ...(wav ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
      "-movflags", "+faststart", mp4,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let ffmpegErr = "";
    ffmpeg.stderr.on("data", (d) => (ffmpegErr += d));
    const closed = once(ffmpeg, "close");

    const frames = Math.round(board.duration * fps);
    // 每一幕的起點：子格不能跨過換幕，否則硬切會被平均成兩幕疊在一起
    const cuts = [];
    board.scenes.reduce((t, s) => (cuts.push(t), t + s.seconds), 0);
    const sceneStart = (t) => cuts.findLast((c) => c <= t + 1e-6) ?? 0;
    for (let i = 0; i < frames; i++) {
      // 子格往前取半格（像 180 度快門），模糊拖在動作後面
      const t0 = i / fps, from = sceneStart(t0);
      for (let j = 0; j < sub; j++) {
        await page.evaluate((t) => window.seek(t), Math.max(from, t0 - (0.5 * (sub - 1 - j)) / sub / fps));
        const shot = await page.screenshot({ type: "jpeg", quality: 92 });
        if (!ffmpeg.stdin.write(shot)) await once(ffmpeg.stdin, "drain");
      }
      if (i % fps === 0) process.stdout.write(`\r算圖中 ${Math.round((i / frames) * 100)}%`);
    }
    ffmpeg.stdin.end();
    const [code] = await closed;
    if (wav) await rm(wav, { force: true });
    if (code !== 0) throw new Error("ffmpeg 失敗：\n" + ffmpegErr.slice(-800));
    process.stdout.write("\r算圖中 100%\n");
  } finally {
    await browser.close();
  }

  let gif = null;
  let gifWidth = null;
  if (!args["no-gif"]) {
    gif = path.join(outDir, `${name}.gif`);
    // README 動圖的預設尺寸：橫式 640 寬、直式 360 寬（12 秒約 3–5 MB）
    const width = gifWidth = Math.min(board.width, Number(args["gif-width"] || (board.portrait ? 360 : 640)));
    const gifFps = Number(args["gif-fps"] || 12);
    // stats_mode=diff、diff_mode=rectangle：調色盤以會動的部分為主、每格只重畫有變的區塊，檔案小一成、畫質不變。
    await run(ffmpegPath, [
      "-y", "-loglevel", "error", "-i", mp4,
      "-vf", `fps=${gifFps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
      gif,
    ]);
  }

  const qrSvg = board.url ? await QRCode.toString(board.url, { type: "svg", margin: 0 }) : "";
  const page = path.join(outDir, `${name}.html`);
  const credit = await loadCredit(board.url);
  await writeFile(page, resultPage(board, style, {
    mp4: path.basename(mp4), mp4Bytes: (await stat(mp4)).size,
    gif: gif && path.basename(gif), gifBytes: gif && (await stat(gif)).size, gifWidth,
    qrSvg, credit,
  }));

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`完成，花了 ${seconds} 秒（影片 ${board.duration} 秒、${board.raw.length} 幕、風格 ${style.id}）`);
  console.log(`MP4   ${mp4}`);
  if (gif) {
    const mb = (await stat(gif)).size / 1048576;
    console.log(`GIF   ${gif}（${mb.toFixed(1)} MB）`);
    // README 裡的 GIF 太大會載很久：超過 5 MB 時提醒縮小
    if (mb > 5) console.log(`提醒：GIF 有 ${mb.toFixed(1)} MB，放 README 偏大；重跑時加 --gif-width ${board.portrait ? 300 : 480} --gif-fps 10 可以再小一半左右`);
  }
  console.log(`結果頁 ${page}`);
  console.log(`預覽  ${playerFile}（瀏覽器直接開，不用重新算圖）`);
  if (!args["no-open"] && process.platform === "darwin") spawn("open", [page], { stdio: "ignore", detached: true }).unref();
}

main().catch((err) => {
  console.error("\n" + err.message);
  process.exit(1);
});
