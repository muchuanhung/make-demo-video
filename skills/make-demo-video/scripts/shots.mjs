// 鏡頭模板（shot）：分鏡表的每一幕挑一個模板、填內容，這裡把它展開成播放器看得懂的低階分鏡。
// 模板包好了文字效果、底色、轉場、手機怎麼捲，Claude 只要選模板、寫字、指定錨點，品質才穩。
// 也負責自動檢查（lintShots）：可讀時間、相鄰兩幕太像、畫面沒對上這句話、節奏太慢。
// 操作示範剪法的八個模板在 walkthrough.mjs（展開成 page 幕，檢查在 camera.mjs）。
import { WALK_SHOTS, expandWalk } from "./walkthrough.mjs";

/** 跟 player.js 一致的時間常數（秒）。改這裡要一起改播放器。 */
export const TIMING = {
  headDur: { blur: 0.16, rise: 0.22 }, // 標題一行的進場時間
  lineGap: 0.15, // 多行標題每行間隔
  copyAt: { title: 0.15, phone: 0.1, card: 0.08 }, // 字從這一幕的第幾秒開始出來
  pill: 0.15,
  kicker: 0.08,
  animDelay: { zoom: 0.18, blur: 0.12 }, // 這兩種轉場先讓前一幕走，新一幕的動畫晚一點開始
  readable: 0.5, // 標題完整出現後至少要停的秒數（字少時）
  readPerUnit: 0.06, // 字多時：每個字（英文、數字一個詞算一個）完整出現後要停的秒數，12 字約 0.72 秒（參考影片 9 字停 0.56 秒）
  extraWeight: 0.5, // 小標、標籤、膠囊是輔助資訊，閱讀量算一半
  stat: { numAt: 0.1, count: 0.9, labelAt: 0.35 }, // stat：數字從 numAt 開始跳、跳 count 秒；說明那行 labelAt 進場
};

export const SHOTS = {
  hook: { label: "開場標語", beats: 3, kind: "title", tone: "accent", fx: "rise" },
  intro: { label: "介紹", beats: 5, kind: "phone", tone: "invert", fx: "blur", needs: ["image"] },
  card: { label: "作品卡", beats: 3, kind: "card", fx: "blur" },
  toggle: { label: "狀態切換", beats: 4, kind: "phone", fx: "rise", needs: ["image", "after"] },
  feature: { label: "功能標註", beats: 5, kind: "phone", tone: "base", fx: "blur", needs: ["image"] },
  content: { label: "內容頁", beats: 4, kind: "phone", tone: "invert", fx: "rise", layout: "left", needs: ["image"] },
  cta: { label: "號召行動", beats: 3, kind: "phone", tone: "base", fx: "rise", layout: "big", needs: ["image"] },
  outro: { label: "結尾", beats: 5, kind: "outro", tone: "accent", fx: "blur" },
  stat: { label: "數字", beats: 4, kind: "stat", tone: "invert", fx: "rise", needs: ["value"] },
  ...WALK_SHOTS,
};
const PHONE_SHOTS = new Set(["intro", "toggle", "feature", "content", "cta"]);
// 這些鏡頭的字要在截圖上找得到（畫面證明這句話）；toggle 的證據是切換本身，不用對字。
const LINKED_SHOTS = new Set(["intro", "feature", "content", "cta"]);

/**
 * 拆解 stat 的數字（例如 "1,534"、"6,000+"、"96.8%"、"$1.2M"）：前綴、數值、小數位、千分位、後綴。
 * 播放器照這個格式逐格畫出跳動中的數字，最後一格一定等於原本的字。看不懂時回傳 null。
 */
export function parseStat(value) {
  const m = String(value ?? "").trim().match(/^([^\d]*?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?([^\d]*)$/);
  if (!m) return null;
  const [, prefix, int, dec = "", suffix] = m;
  return { prefix, to: Number(int.replace(/,/g, "") + (dec ? "." + dec : "")), decimals: dec.length, group: int.includes(","), suffix };
}

// 比對用：拿掉空白、標點、**粗體** 記號，英文轉小寫。
const norm = (text) => String(text ?? "").replace(/\*\*/g, "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/**
 * 在截圖的錨點裡找一段字，找不到回傳 null。比對（忽略空白、標點）的優先順序：
 * 完全相同 > 錨點包含這段字 > 這段字包含錨點（錨點越長越好）；同分取最上面的。
 */
export function findAnchor(anchors, text) {
  const needle = norm(text);
  if (!anchors || needle.length < 2) return null;
  let best = null;
  for (const a of anchors) {
    const hay = norm(a.text);
    if (hay.length < 2) continue;
    const score = hay === needle ? 3e6 : hay.includes(needle) ? 2e6 - hay.length : needle.includes(hay) ? 1e6 + hay.length : 0;
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && a.y < best.a.y)) best = { score, a };
  }
  return best?.a ?? null;
}

const round = (x) => Math.round(x * 1000) / 1000;
// 捲動位置往下挪一點（錨點或比例都可以）：手機「停住」時其實要慢慢捲，完全不動的畫面會像當掉。
const nudge = (p, d) => (p.a != null ? { a: round(p.a + d) } : { y: round((p.y ?? 0) + d) });
const lineCount = (text) => String(text ?? "").split("\n").length;

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/g;
/** 閱讀量：中日文一個字算一個，英文、數字一個詞算一個；**粗體**記號與標點不算。 */
export function readingUnits(...texts) {
  const s = texts.flat().filter(Boolean).join(" ").replace(/\*\*/g, "");
  const cjk = (s.match(CJK) || []).length;
  const words = (s.replace(CJK, " ").match(/[A-Za-z0-9][A-Za-z0-9.,'%+$-]*/g) || []).length;
  return cjk + words;
}

/** 標題完整出現後要停多久才讀得完（秒）。 */
export function holdNeeded(units) {
  return Math.round(Math.max(TIMING.readable, units * TIMING.readPerUnit) * 100) / 100;
}

function defaultTransition(shot, prevShot, index) {
  if (index === 0) return "cut";
  if (prevShot === "hook") return "push";
  if (shot === "outro") return "iris";
  if (shot === "card") return prevShot === "card" ? "flash" : PHONE_SHOTS.has(prevShot) ? "zoom" : "flash";
  if (shot === "feature" || shot === "content" || shot === "cta") return "blur";
  return "cut";
}

// 標題從這一句開始算、完整出現要多久（秒）。
function textFullIn(scene, fx, transition) {
  if (!scene.heading) return null;
  const delay = TIMING.animDelay[transition] || 0;
  let at;
  if (scene.kind === "stat") {
    const t = TIMING.stat;
    return delay + Math.max(t.numAt + t.count, t.labelAt + (TIMING.headDur[fx] ?? 0.4));
  }
  if (scene.kind === "title" || scene.kind === "outro") at = TIMING.copyAt.title;
  else {
    at = scene.kind === "card" ? TIMING.copyAt.card : TIMING.copyAt.phone;
    if (scene.pill) at += TIMING.pill;
    if (scene.kicker) at += TIMING.kicker;
    at += 0.05;
  }
  return delay + at + (lineCount(scene.heading) - 1) * TIMING.lineGap + (TIMING.headDur[fx] ?? 0.4);
}

/**
 * 把有 shot 的分鏡表展開成低階分鏡。
 * @param board 分鏡表（scenes 裡可以混用 shot 與舊的 kind）
 * @param opts.anchorsOf (image) => 這張截圖的錨點陣列，沒有錨點檔時回傳 null
 * @returns { scenes, rows, problems }：scenes 是低階分鏡（每一幕帶 row＝原本第幾句），rows 是每一句的起點與長度
 */
export function expandShots(board, { anchorsOf = () => null } = {}) {
  const beat = board.beat || 0.4;
  const problems = [];
  const scenes = [];
  const rows = [];
  let start = 0;
  let prevCardTone = null;
  const raw = board.scenes || [];

  raw.forEach((s, i) => {
    const where = `第 ${i + 1} 幕（${s.shot || s.kind}）`;
    if (!s.shot) {
      // 舊格式：原樣通過
      scenes.push({ ...s, row: i });
      rows.push({ start, seconds: s.seconds, shot: null, kind: s.kind, heading: s.heading || s.caption || "" });
      start = round(start + (s.seconds || 0));
      prevCardTone = null;
      return;
    }
    const def = SHOTS[s.shot];
    if (!def) {
      problems.push(`${where}：shot 只能是 ${Object.keys(SHOTS).join("、")}`);
      return;
    }
    for (const need of def.needs || []) if (!s[need]) problems.push(`${where}：少了 ${need}`);
    if (!s.heading && !def.walk) problems.push(`${where}：少了 heading（這一句腳本）`);

    const seconds = round(s.seconds ?? (s.beats ?? def.beats) * beat);
    if (def.walk) {
      // 操作示範：畫面上的字幾乎都是網頁自己的字，只有 home、dock 有 heading
      const out = expandWalk(s, { seconds, beat, prev: raw[i - 1], row: i, say: (m) => problems.push(`${where}：${m}`) });
      scenes.push(...out);
      rows.push({ start, seconds, shot: s.shot, heading: s.heading || "", image: s.image, walk: true });
      start = round(start + seconds);
      prevCardTone = null;
      return;
    }
    const prevShot = raw[i - 1]?.shot || null;
    const transition = s.transition || defaultTransition(s.shot, prevShot, i);
    const fx = s.textFx || def.fx;
    const layout = s.layout || def.layout || "right";
    const anchors = s.image ? anchorsOf(s.image) : null;

    // 錨點：寫了 to／from 就一定要找得到，找不到時列出截圖裡有的字，方便改。
    const resolve = (text, img = s.image, list = anchors) => {
      if (text == null) return null;
      if (!list) {
        problems.push(`${where}：「${text}」要對到截圖 ${img} 的錨點，但沒有錨點檔（用 capture.mjs --full 重新截圖會一起產生 .json）`);
        return null;
      }
      const hit = findAnchor(list, text);
      if (!hit) {
        const have = list.slice(0, 12).map((a) => a.text).join("、");
        problems.push(`${where}：在 ${img} 裡找不到「${text}」。截圖裡有：${have}`);
        return null;
      }
      return { a: hit.y };
    };

    let tone = s.tone || def.tone || "base";
    if (s.shot === "card" && !s.tone) tone = prevShot === "card" && prevCardTone === "invert" ? "accent" : "invert";
    prevCardTone = s.shot === "card" ? tone : null;

    const common = {
      heading: s.heading, kicker: s.kicker, sub: s.sub, pill: s.pill, tags: s.tags, caption: s.caption,
      textFx: fx, layout, phoneScale: s.phoneScale, row: i, shot: s.shot,
    };
    for (const k of Object.keys(common)) if (common[k] === undefined) delete common[k];

    // 跨鏡頭銜接（match cut）：上一句的字如果也出現在這張截圖上，手機先停在那裡。
    const prevHeading = raw[i - 1]?.heading;
    const matchStart = s.from ? resolve(s.from) : (prevHeading && findAnchor(anchors, prevHeading) ? { a: findAnchor(anchors, prevHeading).y } : null);
    const top = { y: 0 };

    let out;
    if (s.shot === "stat") {
      const count = parseStat(s.value);
      if (s.value != null && !count) problems.push(`${where}：value「${s.value}」看不懂，寫成數字加前後綴，例如 1,534、6,000+、96.8%`);
      const from = Number(s.start ?? 0);
      out = [{ kind: "stat", seconds, tone, transition, ...common, value: String(s.value ?? ""), count: count && { ...count, from: Number.isFinite(from) ? from : 0 } }];
    } else if (s.shot === "hook") {
      out = [{ kind: "title", seconds, tone, transition, ...common, align: s.align }];
    } else if (s.shot === "outro") {
      out = [{
        kind: "outro", seconds, tone, transition, ...common, url: s.url, qr: s.qr ?? false,
        from: s.irisFrom || { x: 0.5, y: 0.7 },
      }];
    } else if (s.shot === "card") {
      out = [{ kind: "card", seconds, tone, transition, ...common, label: s.label, icon: s.icon, year: s.year, cardTone: s.cardTone, ...(s.align === "center" ? { align: "center" } : {}) }];
    } else if (s.shot === "toggle") {
      // 一句話、兩個畫面：切換前停 40%，斜切到切換後（字已經在畫面上，不重新進場）。
      // 狀態切換要讓人看到「同一個畫面變了」：不自動銜接上一句，沒寫 to 就停在頁面頂端。
      const pos = resolve(s.to) || (s.from ? matchStart : null) || top;
      const afterPos = s.to ? resolve(s.to, s.after, anchorsOf(s.after)) || pos : pos;
      const a = round(seconds * 0.4);
      // 前後兩半都慢慢往下捲，而且斜切那一刻兩張圖停在同一個位置，看起來是同一個畫面變了色。
      out = [
        { kind: "phone", seconds: a, tone: s.tone || "invert", transition, ...common, image: s.image, scroll: [{ at: 0, ...pos }, { at: 1, ...nudge(pos, 0.012) }] },
        { kind: "phone", seconds: round(seconds - a), tone: s.afterTone || "base", transition: "wipe", settled: true, ...common, image: s.after, scroll: [{ at: 0, ...nudge(afterPos, 0.012) }, { at: 1, ...nudge(afterPos, 0.04) }] },
      ];
    } else {
      const to = resolve(s.to);
      let keys;
      if (s.shot === "intro") {
        const from = matchStart || top;
        // 前 45% 從銜接的位置慢慢開始捲（讓人看清楚上一句也在這裡），後半加速捲到 to
        const end = to || nudge(from, 0.1);
        keys = [{ at: 0, ...from }, { at: 0.45, ...nudge(from, 0.015) }, { at: 0.95, ...end }, { at: 1, ...end }];
      } else if (s.shot === "feature") {
        const from = matchStart || top;
        keys = [{ at: 0, ...from }, { at: 0.3, ...nudge(from, 0.01) }, { at: 1, ...(to || { y: 0.3 }) }];
      } else if (s.shot === "content") {
        const from = matchStart || top;
        keys = [{ at: 0, ...from }, { at: 0.15, ...nudge(from, 0.005) }, { at: 0.9, ...(to || { y: 0.15 }) }, { at: 1, ...(to || { y: 0.15 }) }];
      } else {
        // cta：很快捲到聯絡區，停住
        const from = matchStart || top;
        keys = [{ at: 0, ...from }, { at: 0.45, ...(to || from) }, { at: 1, ...(to || from) }];
      }
      out = [{ kind: "phone", seconds, tone, transition, ...common, image: s.image, scroll: keys, phoneIn: s.shot === "cta" ? "zoomin" : undefined }];
      if (!out[0].phoneIn) delete out[0].phoneIn;
    }

    scenes.push(...out);
    // 畫面有沒有對上這句話：手機鏡頭的字在截圖裡找得到，或寫了 to／from 錨點
    let linked = null;
    if (LINKED_SHOTS.has(s.shot) && anchors) linked = Boolean(s.to || s.from || findAnchor(anchors, s.heading));
    const lastKey = out.at(-1).scroll?.at(-1);
    rows.push({
      start, seconds, shot: s.shot, heading: s.heading, image: s.image, layout, tone,
      endAt: lastKey ? lastKey.a ?? lastKey.y ?? null : null,
      phone: PHONE_SHOTS.has(s.shot), linked, fullIn: textFullIn(out[0], fx, transition),
      units: readingUnits(s.heading), extraUnits: readingUnits(s.kicker, s.pill, s.tags || []),
    });
    start = round(start + seconds);
  });

  return { scenes, rows, problems, beat };
}

/** 自動檢查：回傳 [{ row: 第幾句（0 起算，null＝整支影片）, message }]。 */
export function lintShots({ rows, beat = 0.4 }) {
  const out = [];
  const say = (row, message) => out.push({ row, message });
  const name = (i) => `第 ${i + 1} 幕`;
  let toneRun = 0;
  rows.forEach((r, i) => {
    // 操作示範的鏡頭不套快節奏的規則（一個鏡頭最長 3 秒、平均 1–1.8 秒）；它的檢查在 camera.mjs。
    // 只檢查 burst 有沒有落在拍點上：配樂的 drop 落在它的第一拍，不在拍點上就跟大鼓對不齊
    if (r.walk) {
      const k = r.start / beat;
      if (r.shot === "burst" && Math.abs(k - Math.round(k)) > 1e-3) {
        say(i, `${name(i)}：重拍從 ${r.start} 秒開始，不在拍點上（一拍 ${beat} 秒），配樂的重拍會對不齊；前面幾幕改用 beats 而不是 seconds`);
      }
      return;
    }
    const prev = rows[i - 1];
    if (r.fullIn != null) {
      // 停多久照字數算：字越多停越久；小標、標籤算一半
      const left = round(r.seconds - r.fullIn);
      const units = (r.units ?? 0) + (r.extraUnits ?? 0) * TIMING.extraWeight;
      const need = holdNeeded(units);
      if (left < need - 1e-6) {
        const add = Math.max(1, Math.ceil((need - left) / beat - 1e-6));
        const what = r.extraUnits ? `${r.units} 個字加上小標、標籤` : `${r.units} 個字`;
        say(i, `${name(i)}：標題完整出現後只停 ${Math.max(0, left).toFixed(2)} 秒，${units > TIMING.readable / TIMING.readPerUnit ? `${what}要停 ${need.toFixed(2)} 秒才讀得完` : `至少要 ${need} 秒`}；加 ${add} 拍（beats +${add}）或刪字`);
      }
    }
    // 一幕只講一件事：字太多就算停得夠久，快節奏也消化不了
    if (r.shot && r.shot !== "outro") {
      if (r.units > 16) say(i, `${name(i)}：標題 ${r.units} 個字，快節奏一眼讀不完；縮到 12 字以內，或拆成兩幕`);
      else if (r.units + r.extraUnits > 16) say(i, `${name(i)}：這一幕字太多（標題 ${r.units} 個字，小標、標籤 ${r.extraUnits} 個），一幕只講一件事；刪掉小標或標籤，或拆成兩幕`);
    }
    // 單頁網站用同一張長圖、捲到不同段落是正常的；捲到的位置也差不多時才算重複
    if (r.phone && prev?.phone && r.image === prev.image && r.layout === prev.layout && (r.endAt == null || prev.endAt == null || Math.abs(r.endAt - prev.endAt) < 0.08)) {
      say(i, `${name(i)}：跟前一幕用同一張截圖、同一個版面、捲到差不多的位置，看起來會一樣；用 to 捲到別的段落、換一頁截圖，或換 layout`);
    }
    if (r.shot && i >= 2 && rows[i - 1].shot === r.shot && rows[i - 2].shot === r.shot) {
      say(i, `${name(i)}：連續 3 幕都是 ${r.shot}，畫面太單調；中間換一種模板`);
    }
    if (r.linked === false) {
      say(i, `${name(i)}：手機畫面上找不到「${String(r.heading).replace(/\n/g, "")}」，畫面沒有對應這句話；用 to 指定截圖上對應的那段字`);
    }
    if (r.shot && r.shot !== "outro" && r.seconds > 3) say(i, `${name(i)}：${r.seconds} 秒太長，快節奏的鏡頭最長 3 秒`);
    toneRun = prev && prev.tone && prev.tone === r.tone ? toneRun + 1 : 1;
    if (r.tone && toneRun > 3) say(i, `${name(i)}：連續 ${toneRun} 幕都是 ${r.tone} 底色，換一個 tone 讓節奏有起伏`);
  });
  const shots = rows.filter((r) => r.shot && !r.walk);
  if (shots.length) {
    const avg = shots.reduce((sum, r) => sum + r.seconds, 0) / shots.length;
    if (avg > 1.8) say(null, `平均一個鏡頭 ${avg.toFixed(1)} 秒，太慢；快節奏平均 1–1.8 秒（刪字讓每幕短一點、減少拍數，或在 ① 選短一點的秒數）`);
  }
  return out;
}
