#!/usr/bin/env node
// 把一個網址截成幾張圖，給分鏡表的 browser、phone 幕用。
// 用法：node capture.mjs <網址> --out <資料夾> [--shots 2] [--full] [--mobile] [--scheme dark|light] [--name 檔名] [--click "字 > type:字 > 字"]
// --mobile：用手機寬度截圖（390×693、2 倍解析度），給 9:16 直式影片與 phone 幕用。
// --full：另外截一張整頁長圖（shot-full.png），phone 幕用它往下捲；同時寫一份錨點檔（shot-full.json），
//         記下每個標題、大字、連結與按鈕在頁面上的高度比例（y）與位置（box：x、y、寬、高，CSS 像素；
//         圖上的像素要乘以 scale），分鏡表用 to／from 寫「捲到哪段字」、游標用 box 對準要點的東西，不用猜數字。
//         能點的（連結、按鈕、輸入框）標 click: true。
// --scheme：模擬系統的深色／淺色模式，網站跟著系統切主題時可以各截一組。
// --name：檔名前綴，預設 shot（shot-1.png、shot-full.png）；同一個資料夾截多頁時用來分開。
// --click：截圖前先照順序操作網頁，用 > 分開每一步；寫字就是點畫面上那段字（連結、按鈕、輸入框的提示字），
//          type:台北 是在剛點的輸入框打字。例如 --click "搜尋城市 > type:台北 > 台北市"。
//          操作示範一步截一張：第 N 步就把前 N 步都寫上，每次都從網址重新開始，結果才會一樣。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PNG } from "pngjs";
import { parseArgs, launchBrowser, fullPageSlices } from "./lib.mjs";
import { parseSteps, pickTarget } from "./page-actions.mjs";

const args = parseArgs(process.argv.slice(2), ["full", "mobile"]);
const url = args._[0];
if (!url || !/^https?:\/\//.test(url)) {
  console.error("用法：node capture.mjs <http(s) 網址> --out <資料夾> [--shots 2] [--full] [--mobile] [--scheme dark|light] [--name 檔名] [--click \"字 > type:字 > 字\"]");
  process.exit(2);
}
let steps = [];
try {
  if ("click" in args) steps = parseSteps(args.click);
} catch (err) {
  console.error(err.message);
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
  // 網站設了 scroll-behavior: smooth 時，scrollTo 會變成一段捲動動畫：還沒捲到就截圖，
  // 長圖從頁面中間開始、捲到才載入的圖片也來不及出現。截圖只要瞬間跳到位。
  await page.addStyleTag({ content: "html, body { scroll-behavior: auto !important; }" });
  for (const step of steps) await act(page, step);
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
    await shootFullPage(page, file);
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
        // 連結與按鈕不管字多大都收：操作示範的游標要點的就是它們
        const click = /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(n.tagName) || /^(button|link|tab|option|menuitem)$/.test(n.getAttribute("role") || "");
        if (!isHeading && !hint && !click && !(own && size >= 20) && !label) continue;
        const text = (hint || n.innerText || n.getAttribute("aria-label") || "").replace(/\s+/g, " ").replace(/[.…]+$/, "").trim();
        if (text.length < 2 || text.length > 60) continue;
        // 純數字（氣溫、價格、日期）下次截圖就變了，不能當錨點
        if (/^[\d\s°%.,:\/+\-−℃℉$¥€£]+$/.test(text)) continue;
        const r = n.getBoundingClientRect();
        if (!r.height || !r.width) continue;
        // 被捲動容器整個遮住的（下拉選單裡還沒捲到的選項）看不到，不能當錨點，游標也點不到
        let hidden = false;
        for (let p = n.parentElement; p && p !== document.body && !hidden; p = p.parentElement) {
          const ps = getComputedStyle(p);
          if (!/hidden|auto|scroll|clip/.test(ps.overflowX + ps.overflowY)) continue;
          const pr = p.getBoundingClientRect();
          hidden = r.bottom <= pr.top + 1 || r.top >= pr.bottom - 1 || r.right <= pr.left + 1 || r.left >= pr.right - 1;
        }
        if (hidden) continue;
        const y = Math.round(((r.top + window.scrollY) / height) * 10000) / 10000;
        const key = text + "@" + Math.round(y * 200);
        if (seen.has(key)) continue;
        seen.add(key);
        // 一般的字量字本身的範圍（區塊元素的框常常比字寬很多，螢光筆會劃到字外面）；按鈕、連結量整個元素（點哪裡都算）
        let b = r;
        if (!click && !hint) {
          const range = document.createRange();
          range.selectNodeContents(n);
          const t = range.getBoundingClientRect();
          if (t.width && t.height) b = t;
        }
        const box = [b.left + window.scrollX, b.top + window.scrollY, b.width, b.height].map(Math.round);
        out.push({ text, y, box, ...(click ? { click: true } : {}) });
      }
      const width = document.documentElement.scrollWidth;
      return { width, height, scale: window.devicePixelRatio, anchors: out.sort((a, b) => a.y - b.y) };
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

// 做一步操作：點一段字，或在剛點的輸入框打字。每一步之後等網頁穩定下來。
async function act(page, step) {
  if (step.type != null) {
    await page.keyboard.type(step.type, { delay: 40 });
  } else {
    // 列出畫面上看得到、字不太長的元素，挑出要點的那一個（規則在 page-actions.mjs）。
    const candidates = await page.evaluate(() => {
      const CLICKABLE = "a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=option],[role=menuitem],[onclick]";
      const out = [];
      document.querySelectorAll("body *").forEach((n, index) => {
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(n.tagName)) return;
        const r = n.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const cs = getComputedStyle(n);
        if (cs.visibility === "hidden" || cs.display === "none") return;
        const field = /^(INPUT|TEXTAREA)$/.test(n.tagName);
        const text = field ? n.getAttribute("placeholder") || n.getAttribute("aria-label") || n.value || "" : n.getAttribute("aria-label") || n.innerText || "";
        if (!text.trim() || text.length > 80) return;
        out.push({ index, text: text.replace(/\s+/g, " ").trim(), clickable: n.matches(CLICKABLE) || cs.cursor === "pointer", area: r.width * r.height });
      });
      return out;
    });
    const target = pickTarget(candidates, step.click);
    if (!target) {
      const seen = [...new Set(candidates.filter((c) => c.clickable).map((c) => c.text))].slice(0, 20);
      throw new Error(`畫面上找不到「${step.click}」。能點的有：${seen.join("、") || "（沒有）"}`);
    }
    const handle = await page.evaluateHandle((i) => document.querySelectorAll("body *")[i], target.index);
    await handle.asElement().click({ timeout: 5000 });
    console.log(`點了「${target.text}」`);
  }
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(600);
}

// 整頁長圖：在瀏覽器單張上限內就一次截；超過時（手機 2 倍圖常見）分段截，再照順序接成一張。
async function shootFullPage(page, file) {
  const { width, height, scale } = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    scale: window.devicePixelRatio,
  }));
  const slices = fullPageSlices(height, scale);
  if (slices.length === 1) return page.screenshot({ path: file, fullPage: true });
  // Playwright 的 fullPage 就算加了 clip，也會先把整頁撐成一張超過上限的畫面；
  // 直接叫 Chrome 只渲染這一段（captureBeyondViewport），每段才真的在上限內。
  const cdp = await page.context().newCDPSession(page);
  const parts = [];
  for (const s of slices) {
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: s.y, width, height: s.height, scale },
    });
    parts.push(PNG.sync.read(Buffer.from(data, "base64")));
  }
  await cdp.detach();
  const out = new PNG({ width: parts[0].width, height: parts.reduce((sum, p) => sum + p.height, 0) });
  let row = 0;
  for (const p of parts) {
    PNG.bitblt(p, out, 0, 0, p.width, p.height, 0, row);
    row += p.height;
  }
  await writeFile(file, PNG.sync.write(out));
}
