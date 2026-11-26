#!/usr/bin/env node
// 招牌片（cuts/signature）的工具：Claude 寫好 reel.html 之後用它檢查、出每拍縮圖、算圖。
// 用法：
//   node signature.mjs beats  <out>/reel.html [--script <out>/script.md]   每拍一張縮圖＋自動檢查（沒過時結束碼 1）
//   node signature.mjs render <out>/reel.html [--fps 60] [--motion-blur 3] [--no-gif] [--no-open]
import { readFile, writeFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ffmpegPath from "ffmpeg-static";
import QRCode from "qrcode";
import { parseArgs, launchBrowser } from "./lib.mjs";
import { resultPage, loadCredit } from "./result-page.mjs";
import { soundtrack, toWav, SAMPLE_RATE } from "./soundtrack.mjs";

// ---------- 檢查（純函式，測試直接呼叫） ----------

const squash = (s) => String(s).replace(/\s+/g, "");
const COUNTER = /^[\d.,%+\-]+$/; // 數字跳動的中間值（1,382、93.9%）

/** 靜態檢查：每一格只能由 t 決定，不能有 CSS 動畫、計時器、亂數、時鐘。 */
export function staticProblems(html) {
  const rules = [
    [/@keyframes|animation\s*:|animation-name|transition\s*:/i, "用了 CSS 動畫或 transition；所有變化都要在 seek(t) 裡算"],
    [/setTimeout|setInterval|requestAnimationFrame/, "用了計時器；所有變化都要在 seek(t) 裡算"],
    [/Math\.random/, "用了 Math.random；要亂數時用骨架裡的 rng(seed)"],
    [/Date\.now|performance\.now|new Date\(/, "讀了時鐘；畫面只能由 t 決定"],
  ];
  return rules.filter(([re]) => re.test(html)).map(([, msg]) => msg);
}

/** SIGNATURE 欄位與關鍵句設定。 */
export function signatureProblems(sig, scriptText) {
  if (!sig) return ["reel.html 沒有 window.SIGNATURE"];
  const out = [];
  for (const key of ["width", "height", "duration", "beat"]) if (!(sig[key] > 0)) out.push(`SIGNATURE.${key} 要是正數`);
  if (!sig.concept || /（一行概念）/.test(sig.concept)) out.push("SIGNATURE.concept 還沒寫");
  if (out.length) return out;
  const bars = sig.duration / (sig.beat * 4);
  if (Math.abs(bars * 2 - Math.round(bars * 2)) > 1e-6) out.push(`duration ${sig.duration} 秒不是半小節的整數倍（一小節 ${sig.beat * 4} 秒）`);
  if (!Array.isArray(sig.lines) || !sig.lines.length) out.push("SIGNATURE.lines 是空的：答案、數字、片尾至少要列一句");
  const script = squash(scriptText);
  for (const line of sig.lines || []) {
    if (!script.includes(squash(line.text))) out.push(`關鍵句「${line.text}」不在 script.md 裡（要一字不差）`);
    if (!(line.to - line.from >= 0.5 - 1e-6)) out.push(`關鍵句「${line.text}」完整出現只有 ${(line.to - line.from).toFixed(2)} 秒，至少要 0.5 秒`);
    if (line.from < 0 || line.to > sig.duration) out.push(`關鍵句「${line.text}」的時間超出影片長度`);
  }
  return out;
}

/** 畫面上出現的字都要來自 script.md（數字跳動的中間值、SIGNATURE.extra 列的字除外）。 */
export function textProblems(seen, scriptText, extra = []) {
  const script = squash(scriptText);
  const allowed = extra.map(squash);
  const bad = [...new Set(seen.map(squash))].filter((s) => s && !script.includes(s) && !COUNTER.test(s) && !allowed.some((a) => a.includes(s)));
  return bad.map((s) => `畫面上的「${s}」不在 script.md 裡；文案要照腳本，不能自己加字（網址這類可以列在 SIGNATURE.extra）`);
}

/** ffmpeg psnr 的輸出 → 平均 PSNR（完全一樣時是 Infinity）。 */
export function parsePsnr(stderr) {
  const m = String(stderr).match(/average:(inf|[\d.]+)/);
  if (!m) return null;
  return m[1] === "inf" ? Infinity : Number(m[1]);
}

// ---------- 瀏覽器 ----------

function run(args) {
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    c.stderr.on("data", (d) => (err += d));
    c.on("close", (code) => (code === 0 ? resolve(err) : reject(new Error("ffmpeg 失敗：\n" + err.slice(-800)))));
  });
}
const psnr = async (a, b) => parsePsnr(await run(["-i", a, "-i", b, "-lavfi", "psnr", "-f", "null", "-"]));

// 這一格畫面上看得到的字（依 DOM 順序；被藏起來、透明、在畫面外的不算）
function visibleTexts() {
  const stage = document.getElementById("stage");
  const box = stage.getBoundingClientRect();
  const walker = document.createTreeWalker(stage, NodeFilter.SHOW_TEXT);
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const s = n.textContent.trim();
    if (!s) continue;
    const r = n.parentElement.getBoundingClientRect();
    if (!r.width || !r.height || r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
    let ok = true;
    for (let e = n.parentElement; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) { ok = false; break; }
    }
    if (ok) out.push(s);
  }
  return out;
}

// 位置、尺寸、路徑算成 NaN 時瀏覽器會默默忽略那個值，元素就卡在左上角；在設定的當下記下來
function watchBadValues() {
  window.__bad = [];
  const seen = new Set();
  const bad = (v) => /NaN|Infinity|undefined/.test(String(v));
  const note = (where, v) => {
    if (seen.has(where) || window.__bad.length >= 20) return;
    seen.add(where);
    window.__bad.push({ where, value: String(v).slice(0, 80), t: window.__t ?? null });
  };
  // Chromium 的 style 屬性沒辦法直接攔，改成讓 el.style 回傳一層 Proxy 記下設定的值
  for (const Base of [HTMLElement, SVGElement]) {
    const d = Object.getOwnPropertyDescriptor(Base.prototype, "style");
    if (!d?.get) continue;
    const proxies = new WeakMap();
    Object.defineProperty(Base.prototype, "style", {
      ...d,
      get() {
        const real = d.get.call(this);
        if (!proxies.has(real)) {
          const tag = this.tagName.toLowerCase();
          proxies.set(real, new Proxy(real, {
            get: (t, k) => { const v = Reflect.get(t, k, t); return typeof v === "function" ? v.bind(t) : v; },
            set: (t, k, v) => { if (typeof k === "string" && bad(v)) note(`<${tag}> style.${k}`, v); return Reflect.set(t, k, v, t); },
          }));
        }
        return proxies.get(real);
      },
    });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (k, v) { if (bad(v)) note(`<${this.tagName.toLowerCase()}> ${k}`, v); return setAttribute.call(this, k, v); };
}

async function openReel(htmlFile) {
  const browser = await launchBrowser();
  const sig = await (async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(watchBadValues);
    await page.goto(pathToFileURL(htmlFile).href);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 }).catch(() => errors.push("window.ready 一直沒有變成 true（字型載入失敗或程式出錯）"));
    const s = await page.evaluate(() => window.SIGNATURE ?? null);
    await page.setViewportSize({ width: s?.width || 720, height: s?.height || 1280 });
    return { page, s, errors };
  })();
  return { browser, ...sig };
}

async function beats(htmlFile, scriptFile) {
  const dir = path.dirname(htmlFile);
  const html = await readFile(htmlFile, "utf8");
  const scriptText = existsSync(scriptFile) ? await readFile(scriptFile, "utf8") : "";
  const problems = [...staticProblems(html)];
  if (!scriptText) problems.push(`找不到 ${scriptFile}；招牌片的文案要照腳本`);
  const { browser, page, s: sig, errors } = await openReel(htmlFile);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "mdv-sig-"));
  try {
    problems.push(...errors.map((e) => "頁面出錯：" + e));
    problems.push(...signatureProblems(sig, scriptText));
    if (!sig || errors.length) throw Object.assign(new Error("stop"), { stop: true });
    const seek = (t) => page.evaluate((x) => { window.__t = x; window.seek(x); }, t);
    const shot = async (t, file) => { await seek(t); await page.screenshot({ path: file }); };
    // 每拍縮圖左上角標拍號與秒數（標籤放在 #stage 外，不算進畫面上的字）
    const labeled = async (t, label, file) => {
      await seek(t);
      await page.evaluate((text) => {
        let tag = document.getElementById("__beat");
        if (!tag) { tag = document.createElement("div"); tag.id = "__beat"; tag.style.cssText = "position:fixed;left:0;top:0;z-index:99999;padding:8px 18px;border-radius:0 0 16px 0;background:rgba(0,0,0,.78);color:#fff;font:800 56px/1.1 system-ui,sans-serif"; document.body.appendChild(tag); }
        tag.textContent = text; tag.style.display = "";
      }, label);
      await page.screenshot({ path: file });
      await page.evaluate(() => { document.getElementById("__beat").style.display = "none"; });
    };
    const beatDir = path.join(dir, "beats");
    await mkdir(beatDir, { recursive: true });
    const count = Math.round(sig.duration / sig.beat);
    const seen = [];
    const rows = [];
    for (let k = 0; k < count; k++) {
      const at = k * sig.beat;
      // 縮圖取在拍子的 60% 處（動作大多已經落定）
      await labeled(at + sig.beat * 0.6, `${k + 1}・${at.toFixed(1)}s`, path.join(beatDir, `b${String(k).padStart(2, "0")}.png`));
      seen.push(...(await page.evaluate(visibleTexts)));
      // 每拍都要有動作：拍頭與拍尾不能一模一樣
      const a = path.join(tmp, "a.png"), b = path.join(tmp, "b.png");
      await shot(at + 0.02, a);
      seen.push(...(await page.evaluate(visibleTexts)));
      await shot(at + sig.beat - 0.02, b);
      const p = await psnr(a, b);
      if (p === Infinity || p > 50) problems.push(`第 ${k + 1} 拍（${at.toFixed(1)} 秒）整拍沒有動作；原提示詞要求每拍都有事發生，停留時也要慢慢推近或漂移`);
      const name = `beats/b${String(k).padStart(2, "0")}`;
      rows.push({ beat: k + 1, at, file: `${name}.png`, thumb: `${name}.jpg` });
    }
    // 關鍵句：從 from 到 to 都要整句看得到
    for (const line of sig.lines || []) {
      for (let t = line.from + 0.01; t <= line.to - 0.01; t += 0.1) {
        await seek(t);
        const now = squash((await page.evaluate(visibleTexts)).join(""));
        if (!now.includes(squash(line.text))) { problems.push(`關鍵句「${line.text}」在 ${t.toFixed(2)} 秒時畫面上看不到整句（SIGNATURE.lines 的時間要跟畫面對上）`); break; }
      }
    }
    problems.push(...textProblems(seen, scriptText, sig.extra || []));
    for (const b of await page.evaluate(() => window.__bad)) {
      const where = b.t == null ? "載入時" : `第 ${Math.floor(b.t / sig.beat) + 1} 拍（${b.t.toFixed(2)} 秒）`;
      problems.push(`${where}：${b.where} 算成「${b.value}」，瀏覽器會忽略這個值、元素跑到左上角；檢查算式有沒有少傳參數`);
    }
    // 循環：最後一格要回到第一格
    const first = path.join(tmp, "first.png"), last = path.join(tmp, "last.png");
    await shot(0, first);
    await shot(sig.duration - 1 / 60, last);
    const loop = await psnr(first, last);
    if (!(loop === Infinity || loop >= 35)) problems.push(`最後一格跟第一格不一樣（PSNR ${loop?.toFixed(1)}），影片接不回開頭`);
    const cols = 10;
    const small = sig.width > sig.height ? "256:144" : "144:256";
    await run(["-y", "-loglevel", "error", "-i", path.join(beatDir, "b%02d.png"), "-vf", `scale=${small},tile=${cols}x${Math.ceil(count / cols)}:padding=6:color=0x333333`, path.join(dir, "beats-sheet.png")]);
    // 面板的逐拍分鏡板用的小縮圖（VS Code 要包成 base64，面板輸出上限 256KB）
    await run(["-y", "-loglevel", "error", "-i", path.join(beatDir, "b%02d.png"), "-vf", `scale=${sig.width > sig.height ? "192:108" : "108:192"}`, "-q:v", "8", "-start_number", "0", path.join(beatDir, "b%02d.jpg")]);
    await writeFile(path.join(beatDir, "beats.json"), JSON.stringify({ concept: sig.concept, beat: sig.beat, duration: sig.duration, beats: rows, problems }, null, 2));
  } catch (err) {
    if (!err.stop) throw err;
  } finally {
    await browser.close();
    await rm(tmp, { recursive: true, force: true });
  }
  if (problems.length) {
    console.log("招牌片檢查沒過（先修掉再給使用者看）：\n- " + [...new Set(problems)].join("\n- "));
    process.exitCode = 1;
  } else {
    console.log(`檢查通過。每拍縮圖：${path.join(dir, "beats-sheet.png")}（單張在 beats/）`);
  }
}

// 結果頁的顏色與字型：招牌片不寫 style.json，從 reel.html 的 COL 與 #stage 的字型取
function reelLook() {
  /* global COL */
  const col = typeof COL === "object" && COL ? COL : {};
  const stage = document.getElementById("stage");
  const font = stage ? getComputedStyle(stage).fontFamily : "";
  const link = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href).find((h) => /^https:\/\/fonts\.googleapis\.com\//.test(h)) || null;
  return { col: Object.fromEntries(Object.entries(col).filter(([, v]) => typeof v === "string")), font, fontUrl: link };
}

/** 招牌片的結果頁設定：標題是腳本第一句（產品名），網址取 SIGNATURE.extra 裡像網址的字。 */
export function resultLook(sig, look, scriptText) {
  const first = String(scriptText).split("\n").map((l) => l.replace(/^\s*(?:\d+\s*[.、)）]|[-*•])\s*/, "").trim()).find((l) => l && !l.startsWith("#"));
  const site = (sig.extra || []).map(String).find((x) => /^(https?:\/\/)?[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(x.trim()));
  const col = look?.col || {};
  const hex = (v, d) => (/^#[0-9a-f]{3,8}$/i.test(String(v || "").trim()) ? v.trim() : d);
  const bg = hex(col.bg, "#f3efe6"), text = hex(col.ink ?? col.text, "#141210"), accent = hex(col.accent, "#ec5a12");
  const font = look?.font || '"Noto Sans TC", sans-serif';
  return {
    board: {
      title: first || "demo",
      url: site ? (/^https?:/.test(site.trim()) ? site.trim() : "https://" + site.trim()) : undefined,
      duration: sig.duration, width: sig.width, height: sig.height, portrait: sig.height > sig.width,
      raw: [], count: `${Math.round(sig.duration / sig.beat)} 拍`,
    },
    style: {
      id: "signature", name: "招牌片", description: sig.concept,
      colors: { bg, surface: hex(col.white ?? col.surface, "#ffffff"), text, muted: text, accent, accentText: "#ffffff", border: text },
      fonts: { display: font, body: font, mono: "ui-monospace, monospace" },
      fontUrl: look?.fontUrl || undefined, radius: 12,
    },
  };
}

async function render(htmlFile, args) {
  const dir = path.dirname(htmlFile);
  const fps = Number(args.fps || 60);
  const sub = Number(args["motion-blur"] || 3);
  const started = Date.now();
  const { browser, page, s: sig, errors } = await openReel(htmlFile);
  const look = await page.evaluate(reelLook).catch(() => null);
  const mp4 = path.join(dir, "demo.mp4");
  const wav = path.join(dir, "demo.music.wav");
  try {
    if (errors.length || !sig) throw new Error("reel.html 打不開：" + (errors.join("；") || "沒有 window.SIGNATURE"));
    // 配樂：頁面有 renderAudio 就用頁面寫的；沒有就照節拍用 soundtrack.mjs 合成（每小節一記重拍）
    const hasAudio = await page.evaluate(() => typeof window.renderAudio === "function");
    if (hasAudio) {
      const audio = await page.evaluate(() => window.renderAudio());
      const pcm = Buffer.from(audio.data, "base64");
      const samples = new Float32Array(pcm.length / 4);
      for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 4) / 32767;
      await writeFile(wav, toWav(samples, audio.sampleRate));
    } else {
      const bar = sig.beat * 4, starts = [];
      for (let t = 0; t < sig.duration - 1e-6; t += bar) starts.push(Math.round(t * 1000) / 1000);
      await writeFile(wav, toWav(soundtrack({ duration: sig.duration, beat: sig.beat, starts }), SAMPLE_RATE));
    }
    const ff = spawn(ffmpegPath, [
      "-y", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(fps * sub), "-c:v", "mjpeg", "-i", "-", "-i", wav,
      ...(sub > 1 ? ["-vf", `tmix=frames=${sub},select='eq(mod(n\\,${sub})\\,${sub - 1})',setpts=N/(${fps}*TB)`, "-r", String(fps)] : []),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", mp4,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    ff.stderr.on("data", (d) => (err += d));
    const closed = once(ff, "close");
    const frames = Math.round(sig.duration * fps);
    for (let i = 0; i < frames; i++) {
      // 招牌片沒有硬切，子格取滿一格（360 度快門）
      for (let j = 0; j < sub; j++) {
        await page.evaluate((t) => window.seek(t), Math.max(0, (i + (j - (sub - 1)) / sub) / fps));
        const buf = await page.screenshot({ type: "jpeg", quality: 92 });
        if (!ff.stdin.write(buf)) await once(ff.stdin, "drain");
      }
      if (i % fps === 0) process.stdout.write(`\r算圖中 ${Math.round((i / frames) * 100)}%`);
    }
    ff.stdin.end();
    const [code] = await closed;
    if (code !== 0) throw new Error("ffmpeg 失敗：\n" + err.slice(-800));
    process.stdout.write("\r算圖中 100%\n");
  } finally {
    await browser.close();
    await rm(wav, { force: true });
  }
  let gif = null;
  if (!args["no-gif"]) {
    gif = path.join(dir, "demo.gif");
    const width = sig.width > sig.height ? 640 : 360;
    await run(["-y", "-loglevel", "error", "-i", mp4, "-vf", `fps=12,scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`, gif]);
  }
  console.log(`完成，花了 ${((Date.now() - started) / 1000).toFixed(1)} 秒（影片 ${sig.duration} 秒、${fps}fps、每格 ${sub} 個子格）`);
  console.log(`MP4   ${mp4}`);
  if (gif) console.log(`GIF   ${gif}（${((await stat(gif)).size / 1048576).toFixed(1)} MB）`);
  const pageFile = path.join(dir, "demo.html");
  const scriptFile = path.join(dir, "script.md");
  const scriptText = existsSync(scriptFile) ? await readFile(scriptFile, "utf8") : "";
  const { board, style } = resultLook(sig, look, scriptText);
  await writeFile(pageFile, resultPage(board, style, {
    mp4: path.basename(mp4), mp4Bytes: (await stat(mp4)).size,
    gif: gif && path.basename(gif), gifBytes: gif && (await stat(gif)).size, gifWidth: gif && (sig.width > sig.height ? 640 : 360),
    qrSvg: board.url ? await QRCode.toString(board.url, { type: "svg", margin: 0 }) : "",
    credit: await loadCredit(board.url),
  }));
  console.log(`結果頁 ${pageFile}`);
  if (!args["no-open"] && process.platform === "darwin") spawn("open", [pageFile], { stdio: "ignore", detached: true }).unref();
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ["no-gif", "no-open"]);
  const [cmd, html] = args._;
  if (!["beats", "render"].includes(cmd) || !html) {
    console.error("用法：node signature.mjs beats <out>/reel.html [--script <out>/script.md]｜render <out>/reel.html [--fps 60] [--motion-blur 3] [--no-gif] [--no-open]");
    process.exit(2);
  }
  const htmlFile = path.resolve(html);
  if (cmd === "beats") await beats(htmlFile, path.resolve(args.script || path.join(path.dirname(htmlFile), "script.md")));
  else await render(htmlFile, args);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("\n" + err.message);
    process.exit(1);
  });
}
