#!/usr/bin/env node
// 把一個網址截成幾張圖，給分鏡表的 browser 幕用。
// 用法：node capture.mjs <網址> --out <資料夾> [--shots 2] [--full] [--mobile]
// --mobile：用手機寬度截圖（390×693、2 倍解析度），給 9:16 直式影片用。
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { parseArgs, launchBrowser } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), ["full", "mobile"]);
const url = args._[0];
if (!url || !/^https?:\/\//.test(url)) {
  console.error("用法：node capture.mjs <http(s) 網址> --out <資料夾> [--shots 2] [--full] [--mobile]");
  process.exit(2);
}
const outDir = path.resolve(args.out || ".");
const shots = Math.max(1, Math.min(6, Number(args.shots || 2)));

const browser = await launchBrowser();
try {
  await mkdir(outDir, { recursive: true });
  const viewport = args.mobile ? { width: 390, height: 693 } : { width: 1280, height: 720 };
  const page = await browser.newPage(args.mobile ? { viewport, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => page.waitForLoadState("load"));
  await page.waitForTimeout(800);
  if (args.full) {
    const file = path.join(outDir, "shot-full.png");
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
  }
  for (let i = 0; i < shots; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * (viewport.height - 80));
    await page.waitForTimeout(400);
    const file = path.join(outDir, `shot-${i + 1}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} catch (err) {
  console.error("截圖失敗：" + err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
