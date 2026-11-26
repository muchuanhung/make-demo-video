import { readingUnits, holdNeeded } from "./shots.mjs";

// 攝影機軌：網頁截圖鋪滿畫面，一台攝影機在上面平移、推近、拉遠（操作示範剪法用）。
//
// 攝影機的狀態是 { x, y, z }：x、y 是畫面正中對到截圖的哪一點（0–1，截圖寬高的比例），
// z 是縮放（1＝截圖的寬剛好塞滿畫面寬，2＝推近兩倍）；縮放在對數上內插，推近、拉遠的速度才會均勻。
//
// 分兩半：
// - planCamera（Node 端）：把分鏡寫的運鏡（「第 0.5 秒起花 1 秒推近到『高雄市』、2 倍」）排成關鍵格，
//   檢查「同一時間只有一種運鏡」、換方向前有沒有停、會不會推出截圖外；沒有運鏡的空檔自動補上慢慢推近的漂移。
// - cameraRuntime（瀏覽器與 Node 共用）：照關鍵格算第 t 秒的攝影機與圖片的位置。整個函式會被轉成字串
//   塞進播放器頁面，所以裡面不能用到外面的變數或 import。

export function cameraRuntime() {
  const clamp01 = (k) => Math.max(0, Math.min(1, k));
  // 指數緩動（進出都是指數）：起步與收尾都很乾脆，不回彈。
  const eio = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2);
  const lerp = (a, b, k) => a + (b - a) * k;

  /** 第 t 秒（這一幕自己的時間）的攝影機。keys：[{ t, x, y, z, ease }]，ease 是「到這一格」那一段的緩動。 */
  function at(keys, t) {
    if (!keys.length) return { x: 0.5, y: 0.5, z: 1 };
    if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y, z: keys[0].z };
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      if (t > b.t) continue;
      const span = b.t - a.t;
      const k = span > 0 ? clamp01((t - a.t) / span) : 1;
      const e = b.ease === "move" ? eio(k) : k;
      return { x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), e)) };
    }
    const last = keys[keys.length - 1];
    return { x: last.x, y: last.y, z: last.z };
  }

  /**
   * 攝影機 → 圖片要怎麼擺：回傳 { s, tx, ty }，圖片（原始像素 img.w × img.h）先縮放 s 再平移 (tx, ty)。
   * 一定夾在截圖範圍內，畫面上不會露出截圖外的空白；截圖比畫面還矮時置中。
   */
  function view(cam, frame, img) {
    const s = (Math.max(cam.z, minZoom(frame, img)) * frame.w) / img.w;
    const fit = (want, size, room) => (size <= room ? (room - size) / 2 : Math.min(0, Math.max(room - size, want)));
    return {
      s,
      tx: fit(frame.w / 2 - cam.x * img.w * s, img.w * s, frame.w),
      ty: fit(frame.h / 2 - cam.y * img.h * s, img.h * s, frame.h),
    };
  }

  // 最小縮放：寬要塞滿畫面；截圖很矮（比畫面比例還扁）時，高也要塞滿。
  function minZoom(frame, img) {
    return Math.max(1, (frame.h / frame.w) * (img.w / img.h));
  }

  return { at, view, minZoom, eio };
}

const { at: cameraAt, view: cameraView, minZoom } = cameraRuntime();
export { cameraAt, cameraView };

// 停住的時候也要慢慢動：每秒推近 1.5%，完全靜止的畫面會像當掉。
export const DRIFT_PER_SECOND = 0.015;
const MAX_ZOOM = 4;

const round = (x) => Math.round(x * 10000) / 10000;

/** 把攝影機夾在截圖範圍內：縮放不小於塞滿畫面，畫面正中不能靠邊靠到露出截圖外。 */
export function clampCamera(cam, frame, page) {
  const z = Math.min(MAX_ZOOM, Math.max(minZoom(frame, page), cam.z));
  const hw = 0.5 / z;
  const hh = (0.5 * (frame.h / frame.w) * (page.w / page.h)) / z;
  const inside = (v, half) => (half >= 0.5 ? 0.5 : Math.max(half, Math.min(1 - half, v)));
  return { x: round(inside(cam.x, hw)), y: round(inside(cam.y, hh)), z: round(z) };
}

/**
 * 從錨點找運鏡的目標：寫字就對到錨點的中心（錨點檔要有 box，capture.mjs 新版才有），
 * 寫 x、y 就直接用（截圖寬高的比例）。回傳 { x, y } 或 { error }。
 */
export function targetOf(move, page, findAnchor) {
  if (move.to == null) return { x: move.x, y: move.y };
  // 寫成陣列：幾段字一起入鏡，對準它們合起來的範圍中心（planCamera 會把縮放限制在放得下的大小）
  if (Array.isArray(move.to)) {
    const parts = move.to.map((to) => targetOf({ to }, page, findAnchor));
    const bad = parts.find((p) => p.error);
    if (bad) return bad;
    const rect = [Math.min(...parts.map((p) => p.rect[0])), Math.min(...parts.map((p) => p.rect[1])), Math.max(...parts.map((p) => p.rect[2])), Math.max(...parts.map((p) => p.rect[3]))];
    return { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2, rect, group: true };
  }
  const hit = findAnchor(page.anchors, move.to);
  if (!hit) {
    const have = (page.anchors || []).slice(0, 12).map((a) => a.text).join("、");
    return { error: `截圖裡找不到「${move.to}」。截圖裡有：${have}` };
  }
  if (!hit.box) return { error: `「${move.to}」的錨點沒有位置（box）；用新版 capture.mjs --full 重新截圖` };
  const [bx, by, bw, bh] = hit.box;
  // rect：目標在截圖上的範圍（比例），檢查推近之後它還在不在畫面裡
  return { x: (bx + bw / 2) / page.w, y: (by + bh / 2) / page.h, rect: [bx / page.w, by / page.h, (bx + bw) / page.w, (by + bh) / page.h] };
}

/**
 * 排一幕的攝影機。
 * @param scene.seconds 這一幕幾秒
 * @param scene.camera 運鏡：[{ at, dur, to | x,y, zoom }]，at、dur 是秒（這一幕自己的時間）
 * @param opts.start 開場的攝影機（接上一幕的最後一格）；沒有時用 scene.start（同樣可以寫 to／x、y、zoom），再沒有就是整頁寬、頁首
 * @param opts.page { w, h, anchors }：截圖的頁面大小（CSS 像素）與錨點
 * @param opts.frame { w, h }：影片畫面大小
 * @param opts.beat 一拍幾秒（換方向前要停半拍）
 * @param opts.findAnchor 找錨點的函式（shots.mjs 的 findAnchor）
 * @returns { keys, end, problems, warnings }：problems 擋算圖，warnings 只提醒
 */
export function planCamera(scene, { start, page, frame, beat = 0.5, findAnchor }) {
  const problems = [];
  const warnings = [];
  const seconds = scene.seconds;
  const clamp = (cam) => clampCamera(cam, frame, page);

  let cur;
  if (start) cur = clamp(start);
  else {
    const s = scene.start || {};
    const t = targetOf(s, page, findAnchor);
    if (t.error) problems.push(`開場的位置：${t.error}`);
    const z = s.zoom ?? 1;
    // 沒寫位置時從頁首開始（畫面上緣對齊截圖上緣）
    cur = clamp({ x: t.x ?? 0.5, y: t.y ?? 0, z });
  }
  const keys = [{ t: 0, ...cur }];
  const drift = (cam, dt) => clamp({ ...cam, z: cam.z * (1 + DRIFT_PER_SECOND * dt) });

  const moves = [...(scene.camera || [])].sort((a, b) => a.at - b.at);
  let t = 0;
  let lastDir = null;
  moves.forEach((m, i) => {
    const label = `第 ${i + 1} 個運鏡（${m.at} 秒）`;
    if (!(m.dur > 0)) { problems.push(`${label}：dur 要大於 0`); return; }
    if (m.at < t - 1e-6) { problems.push(`${label}：跟前一個運鏡重疊（前一個到 ${round(t)} 秒才結束）；同一時間只能有一種運鏡`); return; }
    if (m.at + m.dur > seconds + 1e-6) problems.push(`${label}：到 ${round(m.at + m.dur)} 秒才結束，超過這一幕的 ${seconds} 秒`);
    const target = targetOf(m, page, findAnchor);
    if (target.error) { problems.push(`${label}：${target.error}`); return; }

    // 運鏡之前的空檔：慢慢漂移
    if (m.at > t) {
      cur = drift(cur, m.at - t);
      keys.push({ t: round(m.at), ...cur, ease: "drift" });
    }
    const want = { x: target.x ?? cur.x, y: target.y ?? cur.y, z: m.zoom ?? cur.z };
    // 幾段字一起入鏡：縮放不超過放得下它們（四周留 15%）的大小
    if (target.group) want.z = Math.min(want.z, fitZoom(target.rect, frame, page));
    const next = clamp(want);
    // 目標靠邊時攝影機會停在截圖邊緣、目標不在正中，這沒關係；目標整個看得到才行
    const name = m.to ? `「${[].concat(m.to).join("」「")}」` : `(${want.x}, ${want.y})`;
    if (want.z > MAX_ZOOM) warnings.push(`${label}：推近 ${want.z} 倍太多，最多 ${MAX_ZOOM} 倍`);
    else if (!visible(target.rect || [want.x, want.y, want.x, want.y], next, frame, page)) {
      warnings.push(`${label}：推近 ${next.z} 倍時${name}不在畫面裡（攝影機到截圖邊緣就停了，${describe(next)}）；縮放改小一點`);
    }
    // 換方向（推近變拉遠、往右變往左）前要先停半拍，不然看起來像晃動
    const dir = direction(cur, next);
    if (dir && lastDir && dot(dir, lastDir) < 0.5 && m.at - t < beat / 2 - 1e-6) {
      warnings.push(`${label}：跟前一個運鏡方向不同，中間只隔 ${round(m.at - t)} 秒；換方向前先停半拍（${beat / 2} 秒）`);
    }
    if (dir) lastDir = dir;
    cur = next;
    t = m.at + m.dur;
    keys.push({ t: round(t), ...cur, ease: "move" });
  });
  if (t < seconds) {
    cur = drift(cur, seconds - t);
    keys.push({ t: round(seconds), ...cur, ease: "drift" });
  }
  return { keys, end: cur, problems, warnings };
}

// 範圍（截圖的比例）整個放得進畫面、四周留 15% 的最大縮放
function fitZoom([x0, y0, x1, y1], frame, page) {
  const w = Math.max(1e-4, x1 - x0), h = Math.max(1e-4, y1 - y0);
  return Math.min(0.85 / w, (0.85 * (frame.h / frame.w) * (page.w / page.h)) / h);
}

// 推近後畫面看得到的範圍（截圖的比例），rect 整個在裡面才算看得到。
function visible([x0, y0, x1, y1], cam, frame, page) {
  const hw = 0.5 / cam.z;
  const hh = (0.5 * (frame.h / frame.w) * (page.w / page.h)) / cam.z;
  const e = 1e-4;
  return x0 >= cam.x - hw - e && x1 <= cam.x + hw + e && y0 >= cam.y - hh - e && y1 <= cam.y + hh + e;
}

const describe = (c) => `x ${c.x}、y ${c.y}、${c.z} 倍`;

// 運鏡方向：平移（x、y）與縮放（log z）合成一個向量，算方向用。
function direction(a, b) {
  const v = [b.x - a.x, b.y - a.y, Math.log(b.z / a.z) / 4];
  const len = Math.hypot(...v);
  return len > 1e-4 ? v.map((n) => n / len) : null;
}
const dot = (a, b) => a.reduce((sum, n, i) => sum + n * b[i], 0);

// ---------- 游標與點擊 ----------
// 游標貼在網頁上（位置是截圖的比例），攝影機推近時跟著內容走；畫面上的大小固定，不跟著縮放。
// 每次點擊前，游標先移過去、停 1 拍，讓看的人知道它要點哪裡。

// 沒有接上一幕的游標時，從畫面右下這一點出場（畫面的比例）。
export const CURSOR_ENTRY = { x: 0.72, y: 0.8 };
const CURSOR_MOVE = { min: 0.25, max: 0.8 }; // 游標移過去花幾秒
const PRESS = 0.15; // 按下去到可以再移動

/** 截圖上的一點 → 畫面上的一點（畫面的比例），用第 t 秒的攝影機。 */
export function toScreen(point, cam, frame, page) {
  const { s, tx, ty } = cameraView(cam, frame, page);
  return { x: (tx + point.x * page.w * s) / frame.w, y: (ty + point.y * page.h * s) / frame.h };
}
/** 畫面上的一點 → 截圖上的一點。 */
export function toPage(point, cam, frame, page) {
  const { s, tx, ty } = cameraView(cam, frame, page);
  return { x: round((point.x * frame.w - tx) / (page.w * s)), y: round((point.y * frame.h - ty) / (page.h * s)) };
}

/**
 * 排一幕的游標。
 * @param scene.clicks [{ at, to | x,y }]：at 是按下去的那一刻（秒）
 * @param opts.cam 這一幕攝影機的關鍵格（planCamera 的 keys）
 * @param opts.start 接上一幕的游標（畫面的比例）；沒有時從 CURSOR_ENTRY 出場
 * @returns { keys, clicks, end, problems, warnings }：keys 是游標在截圖上的關鍵格，clicks 是按下去的秒數，end 是最後一格在畫面上的位置
 */
export function planCursor(scene, { cam, start, page, frame, beat = 0.5, findAnchor }) {
  const problems = [];
  const warnings = [];
  const camAt = (t) => cameraAt(cam, t);
  const list = [...(scene.clicks || [])].sort((a, b) => a.at - b.at);
  // 新出場的游標：用「開始移動那一刻」的攝影機算出場位置，攝影機先推近時游標才不會被推出畫面
  const firstMove = start || !list.length ? 0 : Math.max(0, list[0].at - beat - CURSOR_MOVE.max);
  let cur = toPage(start || CURSOR_ENTRY, camAt(firstMove), frame, page);
  const keys = [{ t: 0, ...cur, z: 1 }];
  const clicks = [];
  let free = 0; // 游標從這一刻起可以移動
  list.forEach((c, i) => {
    const label = `第 ${i + 1} 個點擊（${c.at} 秒）`;
    if (!(c.at >= 0 && c.at <= scene.seconds)) { problems.push(`${label}：at 要在 0 到 ${scene.seconds} 秒之間`); return; }
    const target = targetOf(c, page, findAnchor);
    if (target.error) { problems.push(`${label}：${target.error}`); return; }
    if (target.x == null || target.y == null) { problems.push(`${label}：要寫 to（截圖上的字）或 x、y`); return; }
    const name = c.to ? `「${c.to}」` : `(${target.x}, ${target.y})`;

    // 停 1 拍再按：游標要在 at − 1 拍之前到；移動至少 0.25 秒、最多 0.8 秒
    let arrive = c.at - beat;
    if (arrive - free < CURSOR_MOVE.min - 1e-6) {
      warnings.push(`${label}：離前一個點擊（或這一幕開頭）太近，游標來不及移過去再停 1 拍；at 往後挪到 ${round(free + CURSOR_MOVE.min + beat)} 秒以後`);
      arrive = Math.min(c.at, free + CURSOR_MOVE.min);
    }
    const leave = Math.max(free, arrive - CURSOR_MOVE.max);
    if (leave > keys[keys.length - 1].t) keys.push({ t: round(leave), ...cur, z: 1, ease: "drift" });
    cur = { x: round(target.x), y: round(target.y) };
    keys.push({ t: round(arrive), ...cur, z: 1, ease: "move" });
    clicks.push(round(c.at));
    free = c.at + PRESS;

    // 按下去的那一刻：攝影機要停著，目標要整個在畫面裡
    if (moving(cam, c.at)) warnings.push(`${label}：攝影機正在運鏡；點擊要等攝影機停下來（運鏡結束後再點，或把運鏡挪開）`);
    const camNow = camAt(c.at);
    if (!visible(target.rect || [target.x, target.y, target.x, target.y], clampCamera(camNow, frame, page), frame, page)) {
      warnings.push(`${label}：按下去時${name}不在畫面裡；先用 camera 把攝影機移過去`);
    }
  });
  const last = keys[keys.length - 1];
  if (last.t < scene.seconds) keys.push({ t: round(scene.seconds), x: last.x, y: last.y, z: 1, ease: "drift" });
  const endScreen = toScreen(cur, camAt(scene.seconds), frame, page);
  return { keys, clicks, end: { x: round(endScreen.x), y: round(endScreen.y) }, problems, warnings };
}

// 第 t 秒攝影機在不在運鏡（漂移不算）
function moving(keys, t) {
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].ease === "move" && t > keys[i - 1].t + 1e-6 && t < keys[i].t - 1e-6) return true;
  }
  return false;
}

// ---------- 螢光筆 ----------
// 在截圖上的一段字劃一道重點色（從左到右掃過去），劃完留在畫面上到這一幕結束。貼在網頁上，攝影機推近時跟著放大。
// 淺底整段蓋過去（相乘混色，字看得清楚）；深底（深色卡片上的白字）相乘會變成一塊髒色，改成字底下一條粗底線。

const MARK_SWEEP = 0.4; // 掃過去預設幾秒

/**
 * 排一幕的螢光筆。
 * @param scene.marks [{ at, dur?, to }]：at 開始劃，to 是截圖上的字（整個錨點的範圍）
 * @returns { marks: [{ t, dur, rect }], problems, warnings }：rect 是截圖上的範圍（比例）[x0, y0, x1, y1]
 */
export function planMarks(scene, { cam, page, frame, findAnchor, lumaOf = () => 1 }) {
  const problems = [];
  const warnings = [];
  const marks = [];
  [...(scene.marks || [])].sort((a, b) => a.at - b.at).forEach((m, i) => {
    const label = `第 ${i + 1} 道螢光筆（${m.at} 秒）`;
    const dur = m.dur ?? MARK_SWEEP;
    if (!(m.at >= 0 && m.at + dur <= scene.seconds + 1e-6)) { problems.push(`${label}：要在這一幕的 ${scene.seconds} 秒內劃完（at ＋ dur）`); return; }
    if (m.to == null) { problems.push(`${label}：要寫 to（截圖上要劃的字）`); return; }
    const target = targetOf(m, page, findAnchor);
    if (target.error) { problems.push(`${label}：${target.error}`); return; }
    const end = m.at + dur;
    const style = m.style || (lumaOf(target.rect) < 0.5 ? "under" : "fill");
    marks.push({ t: round(m.at), dur: round(dur), rect: target.rect.map(round), style });

    if (cam.some((k, j) => j > 0 && k.ease === "move" && cam[j - 1].t < end - 1e-6 && k.t > m.at + 1e-6)) {
      warnings.push(`${label}：劃的時候攝影機正在運鏡；等攝影機停下來再劃`);
    }
    if (!visible(target.rect, clampCamera(cameraAt(cam, end), frame, page), frame, page)) {
      warnings.push(`${label}：劃完時「${m.to}」不在畫面裡；先用 camera 把攝影機移過去`);
    }
    // 劃完要停夠讓人讀完（跟快節奏導覽同一個算法：每個字 0.06 秒，至少 0.5 秒）
    const need = holdNeeded(readingUnits(m.to));
    if (scene.seconds - end < need - 1e-6) {
      warnings.push(`${label}：劃完只剩 ${round(scene.seconds - end)} 秒，「${m.to}」要停 ${need} 秒才讀得完；提早劃或把這一幕拉長`);
    }
  });
  return { marks, problems, warnings };
}

// ---------- 按鈕狀態變化 ----------
// 按下去之後只換掉按鈕那一塊：從「按了之後」的截圖（capture.mjs --click 截的）剪出同一塊貼上去。
// 不直接硬切成整張「按了之後」：兩次截圖之間網站上的即時資料（氣溫、時間）會變，整張換會連別的地方一起跳。
// 不自己畫一顆按鈕：畫面上只放網站上真的有的東西。

const PRESS_PAD = 4; // 按鈕那一塊往外多剪幾個 CSS 像素，邊框、陰影才不會被切掉
export const SWAP_AT = 0.06; // 按下去之後多久換（游標先縮一下）

/**
 * 排一幕的按鈕狀態變化。
 * @param scene.presses [{ at, to, after, afterTo? }]：at 按下去的那一刻；to 是按鈕上的字；after 是按了之後的截圖；
 *        afterTo 是按了之後按鈕上的字（按鈕變寬變窄、或位置變了時用來對位置；不寫就用同一個位置）
 * @param opts.afterPageOf (圖檔) => { w, h, anchors } 或 null
 * @param opts.changed (前一塊, 後一塊) => 前後有沒有看得出來的差別（讀不到圖時回傳 true）；塊是 { image, rect }
 * @returns { swaps: [{ t, rect, image, src }], clicks: [{ at, to }], problems, warnings }：rect 是這張截圖上要蓋掉的範圍、
 *          src 是 after 截圖上剪下來的範圍（都是比例 [x0, y0, x1, y1]）；clicks 要併進游標的點擊
 */
export function planPresses(scene, { page, afterPageOf, findAnchor, changed = () => true }) {
  const problems = [];
  const warnings = [];
  const swaps = [];
  const clicks = [];
  [...(scene.presses || [])].sort((a, b) => a.at - b.at).forEach((p, i) => {
    const label = `第 ${i + 1} 次按按鈕（${p.at} 秒）`;
    if (!(p.at >= 0 && p.at <= scene.seconds)) { problems.push(`${label}：at 要在 0 到 ${scene.seconds} 秒之間`); return; }
    if (p.to == null || !p.after) { problems.push(`${label}：要寫 to（按鈕上的字）與 after（按了之後的截圖，用 capture.mjs --click 截）`); return; }
    const before = findAnchor(page.anchors, p.to);
    if (!before?.box) { problems.push(`${label}：${targetOf({ to: p.to }, page, findAnchor).error || `找不到「${p.to}」`}`); return; }
    const after = afterPageOf(p.after);
    if (!after?.w || !after?.h) { problems.push(`${label}：${p.after} 沒有新版錨點檔；用 capture.mjs --full --click 重新截圖`); return; }
    let afterBox = before.box;
    if (p.afterTo != null) {
      const hit = findAnchor(after.anchors, p.afterTo);
      if (!hit?.box) {
        const have = (after.anchors || []).filter((a) => a.click).slice(0, 12).map((a) => a.text).join("、");
        problems.push(`${label}：在 ${p.after} 裡找不到「${p.afterTo}」。能點的有：${have}`);
        return;
      }
      afterBox = hit.box;
    }
    // 兩塊一樣大（取比較大的），各自從自己的左上角開始剪
    const w = Math.max(before.box[2], afterBox[2]) + PRESS_PAD * 2;
    const h = Math.max(before.box[3], afterBox[3]) + PRESS_PAD * 2;
    const cut = (box, pg) => [(box[0] - PRESS_PAD) / pg.w, (box[1] - PRESS_PAD) / pg.h, (box[0] - PRESS_PAD + w) / pg.w, (box[1] - PRESS_PAD + h) / pg.h].map(round);
    const rect = cut(before.box, page);
    const src = cut(afterBox, after);
    if (!changed({ image: null, rect }, { image: p.after, rect: src })) {
      warnings.push(`${label}：「${p.to}」按了之後看起來跟按之前一樣；確認 ${p.after} 是按了之後截的（capture.mjs --click "${p.to}"），或寫 afterTo 對到按了之後的字`);
    }
    swaps.push({ t: round(p.at + SWAP_AT), rect, image: p.after, src });
    clicks.push({ at: p.at, to: p.to });
  });
  return { swaps, clicks, problems, warnings };
}

// ---------- 網址膠囊的起點 ----------

/**
 * 這一幕最後互動的東西（按按鈕、點擊、螢光筆，取時間最晚的；同一刻按按鈕優先）在畫面上的範圍，收尾的網址膠囊從這裡長出來。
 * 都沒有時用游標最後的位置（一顆按鈕大小，游標要在畫面裡）；再沒有就回傳 null（網址照一般方式出場）。
 * @returns [x0, y0, x1, y1]（畫面的比例）或 null
 */
export function handoffRect(scene, { cam, page, frame, findAnchor, cursorEnd }) {
  const all = [...(scene.presses || []).map((p) => ({ ...p, rank: 2 })), ...(scene.clicks || []).map((c) => ({ ...c, rank: 1 })), ...(scene.marks || []).map((m) => ({ ...m, rank: 0 }))];
  const hit = all.sort((a, b) => a.at - b.at || a.rank - b.rank).at(-1);
  const camEnd = cameraAt(cam, scene.seconds);
  if (hit?.to != null) {
    const t = targetOf({ to: hit.to }, page, findAnchor);
    if (t.rect) {
      const a = toScreen({ x: t.rect[0], y: t.rect[1] }, camEnd, frame, page);
      const b = toScreen({ x: t.rect[2], y: t.rect[3] }, camEnd, frame, page);
      if (a.x < 1 && a.y < 1 && b.x > 0 && b.y > 0) return [a.x, a.y, b.x, b.y].map((v) => round(Math.max(0, Math.min(1, v))));
    }
  }
  if (cursorEnd && cursorEnd.x > 0 && cursorEnd.x < 1 && cursorEnd.y > 0 && cursorEnd.y < 1) {
    const w = 120 / frame.w, h = 40 / frame.h;
    return [cursorEnd.x - w / 2, cursorEnd.y - h / 2, cursorEnd.x + w / 2, cursorEnd.y + h / 2].map((v) => round(Math.max(0, Math.min(1, v))));
  }
  return null;
}
