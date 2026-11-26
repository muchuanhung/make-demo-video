// 結果頁 demo.html：顏色、字型、圓角都取自這支影片的風格檔，換風格重出時結果頁跟著換。
// 直式（9:16）影片窄，左影片右介紹；橫式和 1:1 影片寬，影片全寬、下載卡片排在下面。
import { readFile } from "node:fs/promises";
import path from "node:path";
import QRCode from "qrcode";
import { escapeHtml, SKILL_DIR } from "./lib.mjs";

function luminance(hex) {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [la, lb] = [luminance(a), luminance(b)];
  if (la == null || lb == null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function mix(a, b, t) {
  const pa = a.replace("#", "").match(/../g).map((x) => parseInt(x, 16));
  const pb = b.replace("#", "").match(/../g).map((x) => parseInt(x, 16));
  return "#" + pa.map((x, i) => Math.round(x + (pb[i] - x) * t).toString(16).padStart(2, "0")).join("");
}

const full = (hex) => hex.trim().replace(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i, "#$1$1$2$2$3$3");

// 次要文字（秒數、尺寸）在背景和卡片上都要有 4.5:1；不夠就往主文字色調深（或調亮），不改風格檔本身。
// 顏色不是 #rrggbb（例如 rgb()、色名）時算不了對比，原樣回傳。
export function readableMuted(colors, min = 4.5) {
  const muted = full(colors.muted);
  const text = full(colors.text);
  const backs = [colors.bg, colors.surface].map(full);
  if (![muted, text, ...backs].every((c) => luminance(c) != null)) return colors.muted;
  const ok = (c) => backs.every((b) => contrast(c, b) >= min);
  if (ok(muted)) return colors.muted;
  for (let t = 0.05; t < 1; t += 0.05) {
    const c = mix(muted, text, t);
    if (ok(c)) return c;
  }
  return colors.text;
}

// 主要按鈕的字：風格的 accentText 在 accent 上不到 4.5:1 時（例如白字配亮橘），改用 text 或 bg 裡對比較高的那個。
export function readableOnAccent(colors, min = 4.5) {
  const ratio = (fg) => contrast(full(fg), full(colors.accent)) ?? Infinity;
  if (ratio(colors.accentText) >= min) return colors.accentText;
  return [colors.accentText, colors.text, colors.bg].reduce((best, c) => (ratio(c) > ratio(best) ? c : best));
}

const mb = (bytes) => (bytes / 1048576).toFixed(1) + " MB";
const safeHref = (url) => (/^https?:\/\//i.test(url || "") ? escapeHtml(url) : "");
const bare = (url) => url.replace(/^https?:\/\//i, "").replace(/\/$/, "");

// 結果頁角落的「用 make-demo-video 做的」：網址取自 plugin.json 的 repository，影片本身就指向這個 repo 時不重複放。
export async function loadCredit(boardUrl) {
  try {
    const plugin = JSON.parse(await readFile(path.join(SKILL_DIR, "..", "..", ".claude-plugin", "plugin.json"), "utf8"));
    const url = plugin.repository;
    if (!url || boardUrl?.replace(/\/$/, "") === url.replace(/\/$/, "")) return null;
    return { url, qrSvg: await QRCode.toString(url, { type: "svg", margin: 0 }) };
  } catch {
    return null; // 不是以 plugin 形式安裝（沒有 plugin.json）時就不放
  }
}

// files：{ mp4, mp4Bytes?, gif?, gifBytes?, gifWidth?, qrSvg?, credit? }（credit 由 loadCredit 產生）
export function resultPage(board, style, files) {
  const c = style.colors;
  const muted = readableMuted(c);
  const onAccent = readableOnAccent(c);
  const r = style.radius;
  const title = escapeHtml(board.title || "demo");
  const href = safeHref(board.url);
  const meta = [escapeHtml(style.name || style.id), `${board.duration.toFixed(0)} 秒`, board.count ?? `${board.raw.length} 幕`, `${board.width}×${board.height}`].join(" · ");
  const sizeOf = (bytes) => (bytes ? ` · ${mb(bytes)}` : "");

  // 出處卡片：左邊是 repo 的 QR code（手機掃了就到 repo），右邊兩行字和點星按鈕：誰做的、請喜歡的人點 Star（skill 開源後用來讓更多人看到）。
  // 有出處時它取代「用手機掃描開啟」的網站 QR 卡；沒有出處（影片介紹的就是這個 repo、或不是以 plugin 安裝）時照舊放網站的 QR。
  const creditQr = files.credit?.qrSvg
    ? `<div class="qr" role="img" aria-label="${escapeHtml(bare(files.credit.url))} 的 QR code">${files.credit.qrSvg}</div>`
    : "";
  const credit = files.credit
    ? `<section class="card credit" aria-label="make-demo-video">
      ${creditQr}<div class="credit-text">
      <span>用 <b>make-demo-video</b> 做的</span>
      <span>有用的話點個星，我會很開心，讓下一個需要的人也找得到</span>
      <a class="btn star" href="${safeHref(files.credit.url)}">⭐ GitHub 點星</a>
      </div>
    </section>`
    : "";
  const video = `<video src="${escapeHtml(files.mp4)}" autoplay loop muted playsinline controls></video>`;
  const qrLink = (label) =>
    files.qrSvg && href
      ? `<div class="qr-row"><div class="qr" role="img" aria-label="${escapeHtml(bare(board.url))} 的 QR code">${files.qrSvg}</div><div class="stack"><span class="muted">${label}</span><a class="strong" href="${href}">${escapeHtml(bare(board.url))} ↗</a></div></div>`
      : "";

  const body = board.portrait ? portraitBody() : landscapeBody();

  function portraitBody() {
    const swatches = Object.entries(c)
      .filter(([, v]) => typeof v === "string")
      .map(([k, v]) => `<span class="swatch"><span class="dot" style="background:${escapeHtml(v)}"></span>${escapeHtml(k)} ${escapeHtml(v)}</span>`)
      .join("");
    const font = style.fonts.body.split(",")[0].replace(/["']/g, "").trim();
    return `<main class="portrait">
  <div class="player">${video}</div>
  <div class="info">
    <div class="stack gap-10">
      <span class="muted">Demo 影片 · ${meta.split(" · ").slice(1).join(" · ")}</span>
      <h1>${title}</h1>
      <div class="buttons">
        <a class="btn primary" href="${escapeHtml(files.mp4)}" download>下載 MP4${sizeOf(files.mp4Bytes)}</a>
        ${files.gif ? `<a class="btn" href="${escapeHtml(files.gif)}" download>下載 GIF${sizeOf(files.gifBytes)}</a>` : ""}
      </div>
    </div>
    <section class="card stack gap-12" aria-label="風格">
      <div class="spread"><b class="lg">風格：${escapeHtml(style.name || style.id)}</b><span class="muted sm">${escapeHtml(font)} · 圓角 ${r}</span></div>
      ${style.description ? `<p>${escapeHtml(style.description)}</p>` : ""}
      <div class="swatches">${swatches}</div>
    </section>
    ${credit || (files.qrSvg && href ? `<section class="card">${qrLink("用手機掃描開啟")}</section>` : "")}
  </div>
</main>`;
  }

  function landscapeBody() {
    return `<main class="landscape">
  <header class="stack center">
    <span class="muted">影片做好了</span>
    <h1>${title}</h1>
    <span class="muted">${meta}</span>
  </header>
  <div class="player">${video}</div>
  <div class="downloads">
    <section class="card stack gap-12">
      <div class="stack"><b class="lg">MP4 影片</b><span class="muted sm">${[files.mp4Bytes && mb(files.mp4Bytes), `${board.width}×${board.height}`, "適合社群、簡報、網站"].filter(Boolean).join(" · ")}</span></div>
      <a class="btn primary" href="${escapeHtml(files.mp4)}" download>下載 ${escapeHtml(files.mp4)}</a>
    </section>
    ${files.gif ? `<section class="card stack gap-12">
      <div class="stack"><b class="lg">GIF 動圖</b><span class="muted sm">${[files.gifBytes && mb(files.gifBytes), files.gifWidth && `${files.gifWidth} 寬`, "放進 README 會自動播放"].filter(Boolean).join(" · ")}</span></div>
      <a class="btn" href="${escapeHtml(files.gif)}" download>下載 ${escapeHtml(files.gif)}</a>
    </section>` : ""}
  </div>
  ${credit || qrLink("影片裡介紹的網站") ? `<div class="bottom">${credit || qrLink("影片裡介紹的網站")}</div>` : ""}
</main>`;
  }

  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${style.fontUrl ? `<link rel="stylesheet" href="${safeHref(style.fontUrl)}">` : ""}
<style>
  :root { --bg: ${c.bg}; --surface: ${c.surface}; --text: ${c.text}; --muted: ${muted}; --border: ${c.border}; --accent: ${c.accent}; --accent-text: ${onAccent}; --r: ${r}px; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 16px; background: var(--bg); color: var(--text); font-family: ${style.fonts.body}; font-size: 14px; }
  h1 { margin: 0; font-family: ${style.fonts.display}; font-weight: 800; line-height: 1.2; }
  p { margin: 0; line-height: 1.7; }
  a { color: var(--text); overflow-wrap: anywhere; }
  .muted { color: var(--muted); font-size: 13px; }
  .sm { font-size: 12px; }
  .lg { font-size: 16px; }
  .strong { font-size: 16px; font-weight: 500; }
  .stack { display: flex; flex-direction: column; gap: 4px; }
  .gap-10 { gap: 10px; } .gap-12 { gap: 12px; }
  .center { text-align: center; }
  .spread { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 4px 12px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); padding: 20px; }
  .player { border-radius: var(--r); overflow: hidden; border: 1px solid var(--border); background: #000; box-shadow: 0 12px 32px rgb(0 0 0 / 10%); }
  video { display: block; width: 100%; height: 100%; aspect-ratio: ${board.width} / ${board.height}; object-fit: contain; background: #000; }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 20px; border-radius: min(var(--r), 12px); background: var(--surface); border: 1px solid var(--border); text-decoration: none; }
  .btn.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }
  .btn:hover { filter: brightness(0.96); }
  .qr-row { display: flex; align-items: center; gap: 16px; }
  .qr { flex: none; width: 96px; padding: 8px; background: #fff; border-radius: 10px; border: 1px solid var(--border); }
  .qr svg { display: block; width: 100%; height: auto; }
  .credit { display: flex; align-items: center; gap: 16px; font-size: 13px; color: var(--muted); }
  .card.credit .qr { width: 96px; padding: 8px; }
  .credit-text { min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
  .credit .star { min-height: 36px; padding: 0 14px; margin-top: 4px; font-size: 13px; color: var(--text); }
  .credit b { color: var(--text); }
  .swatches { display: flex; flex-wrap: wrap; gap: 10px; }
  .swatch { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .dot { width: 20px; height: 20px; border-radius: 6px; border: 1px solid var(--border); }

  main.portrait { max-width: 1100px; margin: 0 auto; display: flex; flex-wrap: wrap; gap: 40px; align-items: center; }
  .portrait .player { flex: 0 1 400px; margin: 0 auto; }
  .portrait .info { flex: 999 1 420px; min-width: 0; display: flex; flex-direction: column; gap: 24px; }
  .portrait h1 { font-size: clamp(30px, 5vw, 44px); }

  main.landscape { max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
  .landscape h1 { font-size: clamp(22px, 4vw, 28px); }
  .landscape video { max-height: 80vh; }
  .downloads { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
  .bottom { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-start; justify-content: space-between; padding-top: 16px; border-top: 1px solid var(--border); }
  .bottom .qr { width: 64px; padding: 5px; }
</style>
</head>
<body>
${body}
</body></html>`;
}
