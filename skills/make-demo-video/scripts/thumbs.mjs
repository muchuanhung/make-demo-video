#!/usr/bin/env node
// 幫每個內建風格算一張縮圖（styles/thumbs/<id>.png），給 mod 面板挑風格用。改了風格檔就重跑一次。
// 用法：node thumbs.mjs
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { listStyles, STYLES_DIR } from "./lib.mjs";

const render = path.join(path.dirname(fileURLToPath(import.meta.url)), "render.mjs");
const outDir = path.join(STYLES_DIR, "thumbs");

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-800)))));
  });
}

await mkdir(outDir, { recursive: true });
const tmp = await mkdtemp(path.join(os.tmpdir(), "mdv-thumbs-"));
try {
  await Promise.all(
    (await listStyles()).map(async (style) => {
      const dir = path.join(tmp, style.id);
      await mkdir(dir);
      const board = path.join(dir, "storyboard.json");
      await writeFile(board, JSON.stringify({
        title: style.name,
        scenes: [{ kind: "title", seconds: 2, kicker: style.id, heading: `**${style.name}**`, sub: "demo 影片" }],
      }));
      await run(process.execPath, [render, "--storyboard", board, "--style", style.id, "--out", dir, "--no-gif", "--no-open"]);
      await run(ffmpegPath, ["-y", "-loglevel", "error", "-ss", "1.4", "-i", path.join(dir, "demo.mp4"), "-frames:v", "1", "-vf", "crop=640:360,scale=320:180", path.join(outDir, `${style.id}.png`)]);
      console.log(`✓ ${style.id}`);
    }),
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
console.log(`縮圖在 ${outDir}`);
