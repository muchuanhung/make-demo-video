// capture.mjs 的 --click：把「搜尋城市 > type:台北 > 台北市」拆成一步一步的動作，並從網頁上的元素裡挑出要點的那一個。
// 瀏覽器那一側只負責列出候選元素（字、能不能點、面積），挑哪一個在這裡決定，才能不開瀏覽器就測。

// 比對用：拿掉空白、標點，英文轉小寫（跟 shots.mjs 找錨點的規則一樣）。
export const norm = (text) => String(text ?? "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/**
 * 「搜尋城市 > type:台北 > 台北市」→ [{ click: "搜尋城市" }, { type: "台北" }, { click: "台北市" }]
 * 用 > 分開每一步；type: 開頭的是在剛點的輸入框打字，其他都是「點這段字」。
 */
export function parseSteps(spec) {
  const steps = String(spec ?? "")
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^type\s*[:：]\s*(.*)$/i);
      return m ? { type: m[1] } : { click: part };
    });
  if (!steps.length) throw new Error("--click 沒有寫要點什麼，例如 --click \"搜尋城市 > type:台北 > 台北市\"");
  const empty = steps.find((s) => s.type === "");
  if (empty) throw new Error("type: 後面要寫要打的字");
  if (steps[0].type != null) throw new Error("第一步要先點一個輸入框，才能 type");
  return steps;
}

/**
 * 從候選元素裡挑要點的那一個，找不到回傳 null。
 * 候選：{ index, text, clickable, area }。比對忽略空白與標點：
 * 字完全相同 > 元素的字包含要找的字（越短越好）；同分時能點的（連結、按鈕、輸入框）優先，再來是面積小的（最內層）。
 */
export function pickTarget(candidates, text) {
  const needle = norm(text);
  if (!needle) return null;
  let best = null;
  for (const c of candidates) {
    const hay = norm(c.text);
    if (!hay) continue;
    const match = hay === needle ? 2 : hay.includes(needle) ? 1 : 0;
    if (!match) continue;
    const key = [match, -(match === 1 ? hay.length : 0), c.clickable ? 1 : 0, -c.area];
    if (!best || compare(key, best.key) > 0) best = { key, c };
  }
  return best?.c ?? null;
}

const compare = (a, b) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};
