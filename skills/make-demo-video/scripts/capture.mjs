#!/usr/bin/env node
// 把一個網址截成幾張圖，給分鏡表的 browser、phone 幕用。
// 用法：node capture.mjs <網址> --out <資料夾> [--shots 2] [--full] [--mobile] [--scheme dark|light] [--name 檔名]
// --mobile：用手機寬度截圖（390×693、2 倍解析度），給 9:16 直式影片與 phone 幕用。
// --full：另外截一張整頁長圖（shot-full.png），phone 幕用它往下捲；同時寫一份錨點檔（shot-full.json），
//         記下每個標題與大字在頁面上的高度比例，分鏡表用 to／from 寫「捲到哪段字」，不用猜數字。
// --scheme：模擬系統的深色／淺色模式，網站跟著系統切主題時可以各截一組。
// --name：檔名前綴，預設 shot（shot-1.png、shot-full.png）；同一個資料夾截多頁時用來分開。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, launchBrowser } from "./lib.mjs";

const args = parseArgs(process.argv.slice(2), ["full", "mobile"]);
const url = args._[0];
if (!url || !/^https?:\/\//.test(url)) {
  console.error("用法：node capture.mjs <http(s) 網址> --out <資料夾> [--shots 2] [--full] [--mobile] [--scheme dark|light] [--name 檔名]");
  process.exit(2);
}
if (args.scheme && !["dark", "light"].includes(args.scheme)) {
  console.error("--scheme 只能是 dark 或 light");
  process.exit(2);
}
const outDir = path.resolve(args.out || ".");
const shots = Math.max(0, Math.min(6, Number(args.shots ?? 2)));
const name = args.name || "shot";

const browser = await launchBrowser();
try {
  await mkdir(outDir, { recursive: true });
  const viewport = args.mobile ? { width: 390, height: 693 } : { width: 1280, height: 720 };
  const page = await browser.newPage({
    viewport,
    ...(args.mobile ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    ...(args.scheme ? { colorScheme: args.scheme } : {}),
  });
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => page.waitForLoadState("load"));
  await page.waitForTimeout(800);
  if (args.full) {
    // 進場動畫常常要捲到才觸發：先慢慢捲到底再回頂端，長圖才不會有一半是空白。
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 600));
      // 整頁截圖時固定／黏性定位的導覽列會跑到頁面中間：釘在回到頂端時的位置。
      for (const node of document.querySelectorAll("body *")) {
        const pos = getComputedStyle(node).position;
        if (pos !== "fixed" && pos !== "sticky") continue;
        // sticky 本來就佔著版面位置，改回 relative 就停在原位。
        if (pos === "sticky") { Object.assign(node.style, { transition: "none", position: "relative", top: "0px", bottom: "auto" }); continue; }
        const r = node.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        // 先關掉 transition：導覽列常有 transition: all，改位置會變成一段動畫，量到半路的位置。
        Object.assign(node.style, { transition: "none", position: "absolute", top: "0px", left: "0px", width: r.width + "px", bottom: "auto", right: "auto", margin: "0", transform: "none" });
        // 絕對定位是相對於最近的定位祖先：先放在 (0, 0) 量出偏移，再補回原本的位置。
        const at = node.getBoundingClientRect();
        node.style.top = r.top - at.top + "px";
        node.style.left = r.left - at.left + "px";
      }
    });
    await page.waitForTimeout(300);
    const file = path.join(outDir, `${name}-full.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(file);
    const anchors = await page.evaluate(() => {
      const height = document.documentElement.scrollHeight;
      const seen = new Set();
      const out = [];
      for (const n of document.querySelectorAll("body *")) {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.tagName)) continue;
        const isHeading = /^H[1-4]$/.test(n.tagName) || n.getAttribute("role") === "heading";
        const cs = getComputedStyle(n);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const own = [...n.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
        const size = parseFloat(cs.fontSize), weight = Number(cs.fontWeight) || 400;
        // 收這幾種：標題；20px 以上的大字（標語、作品名）；13px 以上的粗體短標籤（「現在天氣」「日出與日落」這種區塊名稱）；
        // 輸入框與按鈕的提示文字（「搜尋城市…」）。
        const hint = /^(INPUT|TEXTAREA|BUTTON)$/.test(n.tagName) ? (n.getAttribute("placeholder") || n.getAttribute("aria-label") || "") : "";
        const label = own && size >= 13 && weight >= 500;
        if (!isHeading && !hint && !(own && size >= 20) && !label) continue;
        const text = (hint || n.innerText).replace(/\s+/g, " ").replace(/[.…]+$/, "").trim();
        if (text.length < 2 || text.length > 60) continue;
        // 純數字（氣溫、價格、日期）下次截圖就變了，不能當錨點
        if (/^[\d\s°%.,:\/+\-−℃℉$¥€£]+$/.test(text)) continue;
        const r = n.getBoundingClientRect();
        if (!r.height) continue;
        const y = Math.round(((r.top + window.scrollY) / height) * 10000) / 10000;
        const key = text + "@" + Math.round(y * 200);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ text, y });
      }
      return { height, anchors: out.sort((a, b) => a.y - b.y) };
    });
    const json = path.join(outDir, `${name}-full.json`);
    await writeFile(json, JSON.stringify({ url, ...anchors }, null, 1) + "\n");
    console.log(json);
  }
  for (let i = 0; i < shots; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * (viewport.height - 80));
    await page.waitForTimeout(400);
    const file = path.join(outDir, `${name}-${i + 1}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} catch (err) {
  console.error("截圖失敗：" + err.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
