#!/usr/bin/env node
// 把幾段影片各剪一段接成合輯，當開場或比較風格用。兩種用法：
//   同一份分鏡表 × 多種風格：node reel.mjs --storyboard <storyboard.json> --styles screenplay,terminal,neon [--from 3] [--seconds 5] [--out <資料夾>]
//   多個專案 × 多種風格：    node reel.mjs --plan <reel.json> [--out <資料夾>]
// reel.json：{ "seconds": 5, "clips": [{ "storyboard": "a/storyboard.json", "style": "neon", "from": 3, "seconds": 4 }] }
// 路徑相對於 reel.json；style 可以是內建 id 或風格檔路徑；from、seconds 可省略。
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { parseArgs, listStyles, STYLES_DIR } from "./lib.mjs";

const USAGE = "用法：node reel.mjs --storyboard <storyboard.json> [--styles a,b,c] [--from 3] [--seconds 5] [--out <資料夾>]\n　　或 node reel.mjs --plan <reel.json> [--out <資料夾>]";
const args = parseArgs(process.argv.slice(2));
if (!args.storyboard && !args.plan) {
  console.error(USAGE);
  process.exit(2);
}

let clips;
let outDir;
if (args.plan) {
  const planDir = path.dirname(path.resolve(args.plan));
  const plan = JSON.parse(await readFile(args.plan, "utf8"));
  if (!Array.isArray(plan.clips) || !plan.clips.length) throw new Error(`${args.plan} 沒有 clips`);
  clips = plan.clips.map((c, i) => {
    if (!c.storyboard || !c.style) throw new Error(`${args.plan} 第 ${i + 1} 段少了 storyboard 或 style`);
    const builtin = existsSync(path.join(STYLES_DIR, c.style + ".json"));
    return {
      storyboard: path.resolve(planDir, c.storyboard),
      style: builtin ? c.style : path.resolve(planDir, c.style),
      from: Number(c.from ?? plan.from ?? 0),
      seconds: Number(c.seconds ?? plan.seconds ?? 5),
    };
  });
  outDir = path.resolve(args.out || plan.out && path.resolve(planDir, plan.out) || path.join(planDir, "reel"));
} else {
  const styles = args.styles ? args.styles.split(",") : (await listStyles()).map((s) => s.id);
  clips = styles.map((style) => ({
    storyboard: path.resolve(args.storyboard),
    style,
    from: Number(args.from || 0),
    seconds: Number(args.seconds || 5),
  }));
  outDir = path.resolve(args.out || path.join(path.dirname(args.storyboard), "reel"));
}

// 每段的輸出檔名：單一分鏡表時用風格 id（相容舊版），多個專案時加上專案資料夾名稱。
const multi = new Set(clips.map((c) => c.storyboard)).size > 1;
for (const c of clips) {
  const styleName = c.style.endsWith(".json") ? JSON.parse(await readFile(c.style, "utf8")).id || path.basename(c.style, ".json") : c.style;
  c.name = multi ? `${path.basename(path.dirname(c.storyboard))}-${styleName}` : styleName;
}
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
// 各段之間沒有相依，一起算比較快；同一組分鏡表＋風格只算一次。
const jobs = [...new Map(clips.map((c) => [c.name, c])).values()];
await Promise.all(
  jobs.map((c) =>
    run(process.execPath, [render, "--storyboard", c.storyboard, "--style", c.style, "--out", outDir, "--name", c.name, "--no-gif", "--no-open"]).then(() =>
      console.log(`✓ ${c.name}`),
    ),
  ),
);

const inputs = clips.flatMap((c) => ["-ss", String(c.from), "-t", String(c.seconds), "-i", path.join(outDir, `${c.name}.mp4`)]);
const fade = 0.4;
const chain = clips
  .map((c, i) => `[${i}:v]fade=t=in:d=${fade},fade=t=out:st=${c.seconds - fade}:d=${fade},setsar=1[v${i}]`)
  .join(";");
const filter = `${chain};${clips.map((_, i) => `[v${i}]`).join("")}concat=n=${clips.length}:v=1:a=0[out]`;
const reel = path.join(outDir, "reel.mp4");
await run(ffmpegPath, ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[out]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", reel]);
const total = clips.reduce((sum, c) => sum + c.seconds, 0);
console.log(`合輯完成（${clips.length} 段、${total} 秒），花了 ${((Date.now() - started) / 1000).toFixed(1)} 秒：${reel}`);
