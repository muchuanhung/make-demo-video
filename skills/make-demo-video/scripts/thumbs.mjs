#!/usr/bin/env node
// 幫每個內建風格算一張縮圖（styles/thumbs/<id>.png），給 mod 面板挑風格用。改了風格檔就重跑一次。
// 用法：node thumbs.mjs          重算全部縮圖，並更新 thumbs/manifest.json
//       node thumbs.mjs --check  只檢查：有風格缺縮圖、或風格檔在縮圖產生後改過，就列出來並以代碼 1 結束
// manifest.json 記的是每個風格檔內容的 SHA-256，所以 git clone 後檔案時間改變也不影響判斷。
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { listStyles, parseArgs, STYLES_DIR } from "./lib.mjs";

const render = path.join(path.dirname(fileURLToPath(import.meta.url)), "render.mjs");
const outDir = path.join(STYLES_DIR, "thumbs");
const manifestPath = path.join(outDir, "manifest.json");
const args = parseArgs(process.argv.slice(2), ["check"]);

/** 每個風格檔內容的雜湊值，風格 id 對到雜湊。 */
async function styleHashes() {
  const hashes = {};
  for (const style of await listStyles()) {
    const text = await readFile(path.join(STYLES_DIR, `${style.id}.json`), "utf8");
    hashes[style.id] = createHash("sha256").update(text).digest("hex");
  }
  return hashes;
}

if (args.check) {
  const now = await styleHashes();
  const recorded = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
  const problems = Object.entries(now).flatMap(([id, hash]) => {
    if (!existsSync(path.join(outDir, `${id}.png`))) return [`${id}：沒有縮圖`];
    if (recorded[id] !== hash) return [`${id}：風格檔在縮圖產生後改過`];
    return [];
  });
  if (problems.length) {
    console.error("縮圖需要重算（跑 node scripts/thumbs.mjs）：\n- " + problems.join("\n- "));
    process.exit(1);
  }
  console.log(`縮圖都是最新的（${Object.keys(now).length} 個風格）`);
  process.exit(0);
}

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
await writeFile(manifestPath, JSON.stringify(await styleHashes(), null, 2) + "\n");
console.log(`縮圖在 ${outDir}`);
