#!/usr/bin/env node
// 同一份分鏡表用多種風格各算一支，再各剪一段接成合輯，當開場或比較風格用。
// 用法：node reel.mjs --storyboard <storyboard.json> --styles screenplay,terminal,neon [--from 3] [--seconds 5] [--out <資料夾>]
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { parseArgs, listStyles } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.storyboard) {
  console.error("用法：node reel.mjs --storyboard <storyboard.json> [--styles a,b,c] [--from 3] [--seconds 5] [--out <資料夾>]");
  process.exit(2);
}
const styles = args.styles ? args.styles.split(",") : (await listStyles()).map((s) => s.id);
const from = Number(args.from || 0);
const seconds = Number(args.seconds || 5);
const outDir = path.resolve(args.out || path.join(path.dirname(args.storyboard), "reel"));
const render = path.join(path.dirname(fileURLToPath(import.meta.url)), "render.mjs");

function run(cmd, cmdArgs, quiet = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["ignore", quiet ? "ignore" : "inherit", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-800)))));
  });
}

await mkdir(outDir, { recursive: true });
const started = Date.now();
// 各風格之間沒有相依，一起算比較快。
await Promise.all(
  styles.map((style) =>
    run(process.execPath, [render, "--storyboard", args.storyboard, "--style", style, "--out", outDir, "--name", style, "--no-gif", "--no-open"]).then(() =>
      console.log(`✓ ${style}`),
    ),
  ),
);

const inputs = styles.flatMap((s) => ["-ss", String(from), "-t", String(seconds), "-i", path.join(outDir, `${s}.mp4`)]);
const fade = 0.4;
const chain = styles
  .map((_, i) => `[${i}:v]fade=t=in:d=${fade},fade=t=out:st=${seconds - fade}:d=${fade},setsar=1[v${i}]`)
  .join(";");
const filter = `${chain};${styles.map((_, i) => `[v${i}]`).join("")}concat=n=${styles.length}:v=1:a=0[out]`;
const reel = path.join(outDir, "reel.mp4");
await run(ffmpegPath, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", reel]);
console.log(`合輯完成，花了 ${((Date.now() - started) / 1000).toFixed(1)} 秒：${reel}`);
