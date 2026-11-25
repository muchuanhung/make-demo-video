#!/usr/bin/env node
// 分鏡板的縮圖：每一幕各截一格，不算整支影片，幾秒就好。進度面板在分鏡表改動後會自己跑這支。
// 用法：node frames.mjs --storyboard <storyboard.json> --style <id 或風格檔> [--out <資料夾>]
// 輸出 <out>/scene-1.png … scene-N.png（預設 <分鏡表所在資料夾>/frames），多出來的舊檔會刪掉。
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, loadStyle, loadStoryboard, launchBrowser, buildPlayer, formatWarnings } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.storyboard || !args.style) {
  console.error("用法：node frames.mjs --storyboard <storyboard.json> --style <id 或風格檔> [--out <資料夾>]");
  process.exit(2);
}
const started = Date.now();
const outDir = path.resolve(args.out || path.join(path.dirname(args.storyboard), "frames"));
// 縮圖寬 320（直式 180），用縮小的裝置像素比直接截，不必另外縮圖。
const SCALE = 0.25;

const [board, style] = await Promise.all([loadStoryboard(args.storyboard), loadStyle(args.style)]);
await mkdir(outDir, { recursive: true });
const playerFile = path.join(outDir, "frames.player.html");
await writeFile(playerFile, await buildPlayer(board, style));

const browser = await launchBrowser();
try {
  const page = await browser.newPage({ viewport: { width: board.width, height: board.height }, deviceScaleFactor: SCALE });
  page.on("pageerror", (err) => { throw new Error("播放器出錯：" + err.message); });
  await page.goto("file://" + playerFile);
  await page.evaluate(() => window.ready);
  // 一句一張（鏡頭模板可能把一句展開成兩幕）。取這一句 75% 的時間點：進場已經結束、捲動也走了大半。
  for (const [i, row] of board.rows.entries()) {
    const t = row.start + Math.min(row.seconds * 0.75, row.seconds - 0.3);
    await page.evaluate((x) => window.seek(x), t);
    await page.screenshot({ path: path.join(outDir, `scene-${i + 1}.png`) });
  }
} finally {
  await browser.close();
  await rm(playerFile, { force: true });
}

// 刪掉幕數變少後留下的舊縮圖
for (const name of await readdir(outDir)) {
  const n = Number(name.match(/^scene-(\d+)\.png$/)?.[1]);
  if (n > board.rows.length) await rm(path.join(outDir, name), { force: true });
}
// 自動檢查的結果給面板顯示在分鏡卡上
await writeFile(path.join(outDir, "lint.json"), JSON.stringify(board.warnings, null, 2) + "\n");
const warn = formatWarnings(board.warnings);
if (warn) console.log(warn);
console.log(`分鏡縮圖 ${board.rows.length} 張，花了 ${((Date.now() - started) / 1000).toFixed(1)} 秒：${outDir}`);
