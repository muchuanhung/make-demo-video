// 影片的每一格都是時間 t 的純函式：window.seek(t) 畫出第 t 秒。
// 算圖腳本逐格呼叫 seek 再截圖，所以這裡不能用 CSS animation 或計時器。
(() => {
  const D = window.__DATA__;
  const S = D.style;
  const M = S.motion || {};
  const stage = document.getElementById("stage");
  const root = document.documentElement.style;

  root.setProperty("--w", D.width + "px");
  root.setProperty("--h", D.height + "px");
  document.documentElement.style.fontSize = (D.portrait ? D.width / 36 : D.width / 64) + "px";
  const c = S.colors;
  for (const [name, value] of Object.entries({
    bg: c.bg, backdrop: c.backdrop || c.bg, surface: c.surface, text: c.text, muted: c.muted,
    accent: c.accent, "accent-text": c.accentText, "accent-ink": c.accentInk || c.accent, border: c.border,
    mark: c.accentInk || c.accent, paper: c.surface, ink: c.text,
    "font-display": S.fonts.display, "font-body": S.fonts.body, "font-mono": S.fonts.mono,
    radius: S.radius + "px", shadow: S.shadow || "none",
  })) root.setProperty("--" + name, value);
  document.body.dataset.decor = S.decor || "none";
  document.body.dataset.caption = S.caption || "plain";
  document.body.dataset.mark = S.mark || "box";
  document.body.dataset.align = S.align || "center";
  if (D.portrait) document.body.dataset.portrait = "";

  // 每一幕可以換底色（tone）：base 用風格原色，invert 深淺反過來，accent 是滿版重點色。
  const mix = (a, b, pct) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;
  const TONES = {
    base: {},
    invert: {
      bg: c.invertBg || c.text, surface: mix(c.bg, c.invertBg || c.text, 8), text: c.bg,
      muted: mix(c.bg, c.invertBg || c.text, 62), border: mix(c.bg, "transparent", 10),
      "accent-ink": c.accent, mark: c.accent,
    },
    accent: {
      bg: c.accent, surface: c.surface, text: c.accentText, muted: mix(c.accentText, c.accent, 72),
      border: mix(c.accentText, "transparent", 16), "accent-ink": c.accentText, mark: "#fff",
    },
  };

  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (k) => 1 - Math.pow(1 - k, 3);
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  const easeBack = (k) => 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2);
  const lerp = (a, b, k) => a + (b - a) * k;
  // 關鍵格內插：keys 是 [{ at: 0–1, ...值 }]，回傳 p 這個進度時各欄位的值。
  function track(keys, p, fields, curve = ease) {
    let from = keys[0], to = keys[0];
    for (const key of keys) { if (key.at <= p) from = key; else { to = key; break; } to = key; }
    const span = to.at - from.at;
    const k = span > 0 ? curve(clamp((p - from.at) / span)) : 1;
    const out = {};
    for (const [f, dflt] of Object.entries(fields)) out[f] = lerp(from[f] ?? dflt, to[f] ?? dflt, k);
    return out;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  // **粗體** 轉成重點標記，其餘一律當純文字，避免分鏡表裡的字被當成 HTML。
  function rich(node, text) {
    String(text).split(/\*\*(.+?)\*\*/g).forEach((part, i) => {
      node.append(i % 2 ? el("mark", "", part) : document.createTextNode(part));
    });
    return node;
  }

  const scenes = [];
  const floating = []; // 放在整個畫面上的東西（網址膠囊）：不是這一幕時藏起來
  let cursorTime = 0;
  const enterDur = M.duration || 0.4;

  // 幕與幕之間的轉場：wipe、push、blur 會讓前一幕和這一幕同時出現一小段。
  // 秒數照參考影片逐格量的：快節奏的轉場大多 0.2–0.4 秒，太慢會覺得拖。
  const TRANSITIONS = { cut: 0, fade: 0.3, slide: 0.3, blur: 0.2, wipe: 0.4, push: 0.33, zoom: 0.18, iris: 0.24, flash: 0, pan: 0.5 };
  const OVERLAP = new Set(["wipe", "push", "blur", "zoom", "iris", "pan"]);
  const FLASH = 0.2; // zoom、flash 之後新一幕蒙一層白、0.2 秒退掉

  // 技術標籤的落點（畫面比例）、樣式與角度，依序取用；直式另一組。
  const TAG_SLOTS = D.portrait
    ? [[0.74, 0.4], [0.16, 0.47], [0.8, 0.6], [0.18, 0.68], [0.72, 0.8], [0.26, 0.88]]
    : [[0.6, 0.18], [0.1, 0.6], [0.69, 0.5], [0.37, 0.66], [0.5, 0.84], [0.25, 0.82]];
  const TAG_LOOKS = ["dark", "accent", "light", "dark", "accent", "light"];
  const TAG_TILT = [-5, 4, -3, 5, -4, 3];

  function build(scene, index) {
    const node = el("section", "scene");
    const anims = [];
    // settled：這一幕接在同一句的前半幕後面（toggle 切換後），字已經在畫面上，不重新進場。
    const enter = (n, at, how, dur) => { anims.push({ kind: "enter", n, at: scene.settled ? -10 : at, how, dur }); return n; };
    const type = (n, text, at, cps) => { anims.push({ kind: "type", n, text, at, cps }); return n; };
    const dur = scene.seconds;
    const prev = D.scenes[index - 1];
    // page 幕（一鏡到底）預設硬切：同一台攝影機、換一張截圖，看起來是同一個畫面變了，不是換場。
    const tr = index === 0 ? "cut" : scene.transition || (scene.kind === "page" ? "cut" : M.transition || "fade");
    // 內容多到排不進這一幕時，等比壓縮出場時間，不讓字還沒出完就切走。
    const fit = (times) => {
      const last = Math.max(...times, 0);
      const room = Math.max(0.3, dur - Math.min(1.2, dur * 0.4));
      return last > room ? room / last : 1;
    };
    // 標題：用換行分成幾行時一行一行出來；標題的進場方式可以跟其他元素不同（motion.heading）。
    // 參考影片的標題是 0.16 秒內俐落彈進來、之後完全不動：時間拉長或一直縮放，字的邊緣會閃，看起來像在抖。
    // 時間跟 scripts/shots.mjs 的 TIMING 一致（自動檢查靠它算可讀時間）。
    const fx = scene.textFx || M.heading;
    const how = fx === "rise" ? "snap" : fx;
    const headDur = fx === "blur" ? 0.16 : fx === "rise" ? 0.22 : enterDur;
    const heading = (tag, text, at, firstAt = at) => {
      const h = el(tag);
      const lines = String(text).split("\n");
      if (lines.length === 1) return enter(rich(h, text), firstAt, how, headDur);
      lines.forEach((line, i) => h.append(enter(rich(el("span", "ln"), line), i === 0 ? firstAt : at + i * 0.15, how, headDur)));
      return h;
    };

    const tone = TONES[scene.tone] ? scene.tone : "base";
    node.dataset.tone = tone;
    for (const [k, v] of Object.entries(TONES[tone])) node.style.setProperty("--" + k, v);
    if (S.decor === "halo") node.append(el("div", "halo"));

    if (scene.step) {
      const chip = el("div", "step");
      chip.append(el("b", "", scene.step.label || "STEP " + scene.step.n), scene.step.name || "");
      node.append(enter(chip, 0));
    }

    const kind = scene.kind;
    if (kind === "title" || kind === "outro") {
      node.classList.add("stack", "is-" + kind);
      if (scene.align) node.dataset.align = scene.align;
      // 第一幕的第一行在第 0 格就已經在畫面上（GIF 的封面才不會是空白），其他行照樣一行一行出來。
      const isFirst = index === 0;
      if (scene.kicker) node.append(enter(el("div", "kicker", scene.kicker), isFirst ? -1 : 0.05));
      node.append(isFirst ? heading("h1", scene.heading, 0.1, -1) : heading("h1", scene.heading, 0.15));
      if (scene.sub) node.append(enter(rich(el("div", "sub"), scene.sub), 0.55));
      if (kind === "outro") {
        if (D.qrSvg && scene.qr !== false) {
          const qr = el("div", "qr");
          qr.innerHTML = D.qrSvg;
          node.append(enter(qr, 0.85));
        }
        const url = scene.url || D.url;
        const urlText = url && url.replace(/^https?:\/\//, "") + (scene.qr === false ? " ↗" : "");
        if (url && scene.pillFrom) {
          // 網址膠囊（操作示範的收尾）：剛才按的那顆按鈕留在畫面上，等網頁滑走，再長成網址停在標語下面。
          // 真正的網址先藏著，膠囊長到位那一格才換上，看起來是同一個東西。
          const real = el("div", "url dot", urlText);
          real.style.opacity = "0";
          const ghost = el("div", "url dot pg-pill");
          const label = el("span", "", urlText);
          ghost.append(label);
          // 膠囊放在整個畫面上（不在這一幕裡）：橫搖時這一幕還在畫面右邊，放在幕裡會被切掉
          node.append(real);
          stage.append(ghost);
          floating.push(ghost);
          anims.push({ kind: "pill", real, ghost, label, from: scene.pillFrom });
        } else if (url) node.append(enter(el("div", "url", urlText), 0.95));
      }
    } else if (kind === "stat") {
      // 大數字從 from 跳到目標值，下面一行說明。時間跟 scripts/shots.mjs 的 TIMING.stat 一致。
      node.classList.add("stack", "is-stat");
      if (scene.align) node.dataset.align = scene.align;
      if (scene.kicker) node.append(enter(el("div", "kicker", scene.kicker), 0.05));
      const num = el("div", "num", scene.value);
      if (scene.count) anims.push({ kind: "count", n: num, at: 0.1, dur: 0.9, ...scene.count });
      node.append(enter(num, 0.1, "snap", 0.22));
      const rule = el("div", "rule");
      anims.push({ kind: "rule", n: rule, at: 0.1, dur: 0.9 });
      node.append(rule);
      node.append(heading("h2", scene.heading, 0.35));
    } else if (kind === "phone" || kind === "card") {
      node.classList.add("split", "is-" + kind, "lay-" + (kind === "phone" ? scene.layout || "right" : "right"));
      // 作品卡寫了 align: "center"：卡片與字整組放在畫面正中央，字也置中。
      if (kind === "card" && scene.align === "center") node.classList.add("card-center");
      const copy = el("div", "copy");
      const device = el("div", "device");
      // 手機：字在左（直式在上）、手機在右；作品卡：卡在左（直式在上）、字在右。
      if (kind === "phone") node.append(copy, device); else node.append(device, copy);
      let at = kind === "card" ? 0.08 : 0.1;
      if (scene.pill) { copy.append(enter(el("div", "pill", scene.pill), at, "pop")); at += 0.15; }
      if (scene.kicker) { copy.append(enter(el("div", "kicker", scene.kicker), at)); at += 0.08; }
      if (scene.heading) { copy.append(heading("h1", scene.heading, at + 0.05)); at += 0.3; }
      if (scene.sub) copy.append(enter(rich(el("div", "sub"), scene.sub), at + 0.1));

      if (kind === "phone") {
        const phone = el("div", "phone");
        // phoneScale：只縮放這一幕的手機（等比例），例如 0.85 讓直式畫面的手機整台露出來。
        if (scene.phoneScale) phone.style.setProperty("--phone-scale", String(scene.phoneScale));
        const screen = el("div", "screen");
        const img = el("img");
        img.src = D.images?.[scene.image] ?? scene.image;
        screen.append(img);
        phone.append(screen, el("i", "island"));
        device.append(phone);
        // 前一幕也是手機時手機留在原位，不重新進場，看起來像同一支手機一直在畫面上。
        // 同一支手機接著用（cut、wipe）時留在原位；其他時候手機的進場方向跟著轉場走：
        // push 從下面大幅升上來、blur 從右邊滑進來、其他放大淡入。
        const keep = prev && prev.kind === "phone" && (tr === "cut" || tr === "wipe");
        const phoneIn = scene.phoneIn || (keep ? "keep" : tr === "push" ? "lift" : tr === "blur" ? "right" : "zoomin");
        if (phoneIn !== "keep") enter(phone, phoneIn === "right" ? 0.1 : 0, phoneIn);
        const keys = scene.scroll && scene.scroll.length ? scene.scroll : [{ at: 0, y: 0 }, { at: 1, y: 0.04 }];
        anims.push({ kind: "phone", phone, screen, img, keys, seed: index });
        const tags = scene.tags || [];
        if (tags.length) node.classList.add("has-tags");
        const k = fit(tags.map((_, i) => 0.35 + i * 0.22));
        tags.forEach((text, i) => {
          const tag = el("div", "tag " + TAG_LOOKS[i % TAG_LOOKS.length], text);
          const [x, y] = TAG_SLOTS[i % TAG_SLOTS.length];
          tag.style.left = x * 100 + "%";
          tag.style.top = y * 100 + "%";
          node.append(tag);
          anims.push({ kind: "tag", n: tag, at: scene.settled ? -10 : (0.35 + i * 0.22) * k, tilt: TAG_TILT[i % TAG_TILT.length], i });
        });
      } else {
        const card = el("div", "pcard " + (scene.cardTone || (tone === "accent" ? "light" : "accent")));
        card.append(el("span", "lab", scene.label || ""), el("span", "glyph", scene.icon || "＋"), el("span", "yr", scene.year || ""), el("span", "go", "↗"));
        device.append(card);
        anims.push({ kind: "card", n: card, seed: index });
      }
    } else if (kind === "terminal" || kind === "file") {
      const win = el("div", "win");
      const bar = el("div", "bar");
      bar.append(el("i"), el("i"), el("i"), el("span", "name", scene.name || (kind === "terminal" ? "Claude Code" : "")));
      const body = el("div", "body");
      win.append(bar, body);
      const plan = [];
      let at = 0.4;
      for (const raw of scene.lines || []) {
        const line = typeof raw === "string" ? { text: raw } : raw;
        const isCmd = kind === "terminal" && line.type !== "out";
        const cps = 30;
        plan.push({ line, isCmd, at, cps });
        at += isCmd ? line.text.length / cps + 0.35 : kind === "file" ? 0.16 : 0.14;
      }
      const k = fit(plan.map((p) => p.at + (p.isCmd ? p.line.text.length / p.cps : 0)));
      for (const p of plan) {
        const row = el("div", "line " + (kind === "file" ? "" : p.isCmd ? "cmd" : "out"));
        if (p.isCmd) type(row, p.line.text, p.at * k, p.cps / k);
        else { row.textContent = p.line.text; enter(row, p.at * k); }
        if (p.line.highlight) anims.push({ kind: "class", n: row, cls: "hl", at: Math.min(dur - 0.8, at * k + 0.3) });
        body.append(row);
      }
      node.classList.add("stack");
      node.append(enter(win, 0.1));
    } else if (kind === "browser") {
      const win = el("div", "win browser");
      const bar = el("div", "bar");
      bar.append(el("i"), el("i"), el("i"), el("span", "address", scene.address || ""));
      const view = el("div", "viewport");
      const img = el("img");
      img.src = D.images?.[scene.image] ?? scene.image;
      view.append(img);
      const cursor = el("div", "cursor");
      const ripple = el("div", "ripple");
      if ((scene.clicks || []).length) view.append(ripple, cursor);
      win.append(bar, view);
      node.classList.add("stack");
      node.append(enter(win, 0.1));
      anims.push({ kind: "browser", view, img, cursor, ripple, focus: scene.focus || [], clicks: scene.clicks || [] });
    } else if (kind === "page") {
      // 網頁鋪滿畫面，攝影機照 scene.cam（lib.mjs 排好的關鍵格）在截圖上平移、推近、拉遠。
      node.classList.add("is-page");
      const img = el("img");
      img.src = D.images?.[scene.image] ?? scene.image;
      node.append(img);
      // 游標與點擊光圈畫在畫面上（不跟著縮放），位置照游標在截圖上的點換算。
      let cursor = null, ring = null;
      if (scene.cursor?.length) {
        ring = el("div", "pg-ring");
        cursor = el("div", "pg-cursor");
        cursor.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 2.5 L3 19.5 L7.6 15.4 L10.6 22 L13.6 20.7 L10.7 14.2 L17 14.2 Z"/></svg>';
        node.append(ring, cursor);
      }
      // 螢光筆：畫在圖片上面、游標下面
      const marks = (scene.markAt || []).map((m) => ({ ...m, n: el("div", "pg-mark") }));
      for (const m of marks) img.after(m.n);
      // 按按鈕：從按了之後的截圖剪一塊蓋在按鈕上（框是蓋的位置，裡面的圖是整張按了之後的截圖，移到剪的那一塊）
      const swaps = (scene.swaps || []).map((w) => {
        const n = el("div", "pg-swap");
        const inner = el("img");
        inner.src = D.images?.[w.image] ?? w.image;
        n.append(inner);
        return { ...w, n, inner };
      });
      for (const w of swaps) (marks.at(-1)?.n || img).after(w.n);
      anims.push({ kind: "page", img, keys: scene.cam || [], cursor, ring, path: scene.cursor || [], clickAt: scene.clickAt || [], marks, swaps });
    } else if (kind === "points") {
      node.classList.add("stack");
      if (scene.heading) node.append(enter(rich(el("h2"), scene.heading), 0.2));
      const list = el("div", "points");
      const items = scene.items || [];
      const k = fit(items.map((_, i) => 0.8 + i * 0.7));
      items.forEach((text, i) => {
        const item = el("div", "point");
        item.append(el("b", "", String(i + 1)), rich(el("span"), text));
        list.append(enter(item, (0.8 + i * 0.7) * k));
      });
      node.append(list);
    } else {
      throw new Error("不認得的幕別：" + kind);
    }

    if (scene.caption) {
      const cap = el("div", "caption");
      cap.append(rich(el("span"), scene.caption));
      node.append(enter(cap, 0.25));
    }
    stage.append(node);
    // zoom、blur 轉場先讓前一幕走：新一幕的動畫晚一點開始（跟 shots.mjs 的 TIMING.animDelay 一致）。
    const delay = scene.settled ? 0 : ({ zoom: 0.18, blur: 0.12 })[tr] || 0;
    scenes.push({ node, anims, start: cursorTime, dur, tr, delay, from: scene.from || { x: 0.5, y: 0.62 }, halo: node.querySelector(".halo") });
    cursorTime += dur;
  }

  D.scenes.forEach(build);
  const total = cursorTime;
  const bar = el("div", "progress");
  if (S.progress !== false) stage.append(bar);

  function applyEnter(n, k, how = M.enter) {
    if (how === "step") { n.style.opacity = k > 0 ? 1 : 0; return; }
    if (how === "lift" || how === "right") {
      // 整塊不透明地滑進來：lift 從畫面下方、right 從右邊。
      const e = ease(k);
      n.style.opacity = k > 0 ? 1 : 0;
      n.style.translate = how === "lift" ? `0 ${(1 - e) * 60}%` : `${(1 - e) * 140}% 0`;
      return;
    }
    if (how === "zoomin") {
      const e = ease(k);
      n.style.opacity = e;
      n.style.scale = String(0.9 + 0.1 * e);
      return;
    }
    if (how === "snap") {
      // 往上彈進來：稍微超過再回來，俐落；之後不動。
      n.style.opacity = String(clamp(k * 2));
      n.style.translate = "0 " + (1 - easeBack(k)) * 1.4 + "rem";
      return;
    }
    const e = ease(k);
    n.style.opacity = e;
    if (how === "blur") {
      // 糊轉清楚加上往上彈一小段；不縮放（縮放會讓字每一格重新點陣化，邊緣閃動）。
      n.style.filter = e < 1 ? `blur(${(1 - e) * 0.6}rem)` : "";
      n.style.translate = "0 " + (1 - e) * 1.2 + "rem";
    } else if (how === "pop") n.style.scale = String(0.86 + 0.14 * easeBack(k));
    else n.style.translate = "0 " + (1 - e) * (how === "rise" ? 3 : 1.5) + "rem";
  }

  function applyBrowser(a, lt, dur) {
    const p = clamp(lt / dur);
    const keys = a.focus.length ? a.focus : [{ at: 0, x: 0.5, y: 0.5, zoom: 1 }];
    const { zoom, x, y } = track(keys, p, { zoom: 1, x: 0.5, y: 0.5 });
    const vw = a.view.clientWidth, vh = a.view.clientHeight;
    const ih = a.img.naturalHeight ? (vw * a.img.naturalHeight) / a.img.naturalWidth : vh;
    // 把畫面上 (x, y) 這一點移到視窗正中，再夾住邊界，避免露出圖片外的空白。
    const tx = Math.min(0, Math.max(vw - vw * zoom, vw / 2 - x * vw * zoom));
    const ty = Math.min(0, Math.max(vh - ih * zoom, vh / 2 - y * ih * zoom));
    a.img.style.transform = `translate(${tx}px, ${ty}px) scale(${zoom})`;
    if (!a.clicks.length) return;
    let prev = { at: 0, x: 0.5, y: 0.9 }, next = a.clicks[0], clickedAt = -1;
    for (const click of a.clicks) {
      if (click.at <= p) { prev = click; next = click; clickedAt = click.at; } else { next = click; break; }
    }
    const moveSpan = next.at - prev.at;
    const mk = moveSpan > 0 ? ease(clamp((p - prev.at) / moveSpan)) : 1;
    const cx = lerp(prev.x, next.x, mk), cy = lerp(prev.y, next.y, mk);
    const px = tx + cx * vw * zoom, py = ty + cy * ih * zoom;
    a.cursor.style.left = px + "px"; a.cursor.style.top = py + "px";
    const since = clickedAt < 0 ? 9 : (p - clickedAt) * dur;
    const rk = clamp(since / 0.5);
    a.ripple.style.left = px + "px"; a.ripple.style.top = py + "px";
    a.ripple.style.opacity = since < 0.5 ? 1 - rk : 0;
    a.ripple.style.scale = String(0.3 + rk);
  }

  // 手機：螢幕裡的長截圖照 scroll 關鍵格捲動。
  // 關鍵格寫 y：螢幕頂端對到截圖高度的比例；寫 a（錨點）：那段字停在螢幕上方 22% 的位置。
  function applyPhone(a, lt, dur, t) {
    const sh = a.screen.clientHeight, sw = a.screen.clientWidth;
    const ih = a.img.naturalWidth ? (sw * a.img.naturalHeight) / a.img.naturalWidth : sh;
    const keys = a.keys.map((key) => ({ at: key.at, ty: key.a != null ? key.a * ih - 0.22 * sh : (key.y ?? 0) * ih }));
    const { ty: raw } = track(keys, clamp(lt / dur), { ty: 0 }, easeInOut);
    const ty = Math.max(0, Math.min(ih - sh, raw));
    a.img.style.transform = `translateY(${-ty}px)`;
    a.phone.style.rotate = "3.5deg"; // 固定的傾斜；不晃動，螢幕裡的字才不會閃
  }

  // page：攝影機的位置與夾邊在 scripts/camera.mjs（cameraRuntime），跟 Node 端的檢查用同一份程式。
  function applyPage(a, lt) {
    const img = { w: a.img.naturalWidth || D.width, h: a.img.naturalHeight || D.height };
    const { s, tx, ty } = window.__CAMERA__.view(window.__CAMERA__.at(a.keys, lt), { w: D.width, h: D.height }, img);
    a.img.style.width = img.w + "px";
    a.img.style.height = img.h + "px";
    a.img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    // 按按鈕：照兩張截圖各自的寬換算（同一個 CSS 寬，像素可能不同）；直接換上去（真的按鈕也是一按就變，淡入會疊出兩層字）
    for (const w of a.swaps) {
      const aw = w.inner.naturalWidth || img.w, ah = w.inner.naturalHeight || img.h;
      const sa = s * (img.w / aw);
      const [x0, y0, x1, y1] = w.rect, [u0, v0] = w.src;
      Object.assign(w.n.style, {
        left: tx + x0 * img.w * s + "px",
        top: ty + y0 * img.h * s + "px",
        width: (x1 - x0) * img.w * s + "px",
        height: (y1 - y0) * img.h * s + "px",
        opacity: lt >= w.t ? "1" : "0",
      });
      Object.assign(w.inner.style, { left: -u0 * aw * sa + "px", top: -v0 * ah * sa + "px", width: aw * sa + "px", height: ah * sa + "px" });
    }
    // 螢光筆從左掃到右；上下各多 15%、左右多一點，像真的用筆劃過去
    for (const m of a.marks) {
      const k = ease(clamp((lt - m.t) / m.dur));
      const [x0, y0, x1, y1] = m.rect;
      const h = (y1 - y0) * img.h * s, w = (x1 - x0) * img.w * s;
      // fill：整段蓋過去（淺底）；under：字底下一條粗底線（深底），高度是字高的 18%
      const under = m.style === "under";
      const padX = h * 0.2, padY = under ? 0 : h * 0.15;
      m.n.className = "pg-mark" + (under ? " under" : "");
      Object.assign(m.n.style, {
        left: tx + x0 * img.w * s - padX + "px",
        top: ty + y0 * img.h * s + (under ? h * 1.08 : -padY) + "px",
        width: (w + padX * 2) * k + "px",
        height: (under ? Math.max(3, h * 0.18) : h + padY * 2) + "px",
        opacity: lt >= m.t ? "1" : "0",
      });
    }
    if (!a.cursor) return;
    const p = window.__CAMERA__.at(a.path, lt);
    const x = tx + p.x * img.w * s, y = ty + p.y * img.h * s;
    a.cursor.style.left = a.ring.style.left = x + "px";
    a.cursor.style.top = a.ring.style.top = y + "px";
    // 按下去：游標縮一下 0.12 秒；重點色光圈 0.5 秒內放大、淡掉
    let since = Infinity;
    for (const c of a.clickAt) if (lt >= c) since = lt - c;
    a.cursor.style.scale = since < 0.12 ? "0.82" : "1";
    const k = clamp(since / 0.5);
    a.ring.style.opacity = since < 0.5 ? String(1 - k) : "0";
    a.ring.style.scale = String(0.4 + 1.4 * ease(k));
  }

  // 網址膠囊：0–0.5 秒網頁往左滑走時留在按鈕原本的位置（抵銷這一幕滑進來的位移），0.5–1.1 秒長成網址的大小與位置。
  const PILL = { hold: 0.5, morph: 0.6 };
  function applyPill(a, lt) {
    if (!a.to) return;
    const W = D.width, H = D.height;
    const f = { x: a.from[0] * W, y: a.from[1] * H, w: (a.from[2] - a.from[0]) * W, h: (a.from[3] - a.from[1]) * H };
    const k = clamp((lt - PILL.hold) / PILL.morph);
    const e = k <= 0 ? 0 : k >= 1 ? 1 : k < 0.5 ? Math.pow(2, 20 * k - 10) / 2 : (2 - Math.pow(2, -20 * k + 10)) / 2;
    Object.assign(a.ghost.style, {
      left: lerp(f.x, a.to.x, e) + "px",
      top: lerp(f.y, a.to.y, e) + "px",
      width: lerp(f.w, a.to.w, e) + "px",
      height: lerp(f.h, a.to.h, e) + "px",
      display: k >= 1 ? "none" : "flex",
      // 一開始是重點色（跟點擊光圈同一個顏色，看得出是剛才互動的那個東西），長大時變成網址的樣子
      background: `color-mix(in srgb, var(--accent) ${Math.round((1 - e) * 100)}%, var(--surface))`,
    });
    a.label.style.opacity = String(clamp((e - 0.6) / 0.4));
    a.real.style.opacity = k >= 1 ? "1" : "0";
  }

  // 作品卡：從放大、傾斜的位置落到定位，落定之後就不動（卡片上有字，一直漂會閃）。
  function applyCard(a, lt) {
    const k = ease(clamp(lt / 0.45));
    a.n.style.opacity = String(0.3 + 0.7 * clamp(lt / 0.15));
    a.n.style.transform = k < 1
      ? `perspective(60rem) translate(${(1 - k) * -8}%, ${(1 - k) * 10}%) rotateX(${(1 - k) * 16}deg) rotate(${(1 - k) * -8}deg) scale(${1.3 - 0.3 * k})`
      : "";
  }

  // stat 的數字：前快後慢地跳到目標值，最後一格一定是原本的字（不會因為小數誤差差一位）。
  function formatCount(a, x) {
    let text = x.toFixed(a.decimals);
    if (a.group) {
      const [int, dec] = text.split(".");
      text = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (dec ? "." + dec : "");
    }
    return a.prefix + text + a.suffix;
  }
  function applyCount(a, lt) {
    const k = clamp((lt - a.at) / a.dur);
    a.n.textContent = k >= 1 ? formatCount(a, a.to) : formatCount(a, lerp(a.from, a.to, ease(k)));
  }

  // 技術標籤：0.25 秒彈出（稍微超過再回來），之後停住。
  function applyTag(a, lt) {
    const k = clamp((lt - a.at) / 0.25);
    a.n.style.opacity = String(clamp(k * 3));
    a.n.style.transform = `translate(-50%, -50%) rotate(${a.tilt + (1 - ease(k)) * -10}deg) scale(${k > 0 ? 0.4 + 0.6 * easeBack(k) : 0.4})`;
  }

  // 把一幕畫在它自己的第 lt 秒；t 是整支影片的時間，給一直在動的背景與漂動用。
  function draw(s, lt, t) {
    s.node.classList.add("on");
    for (const a of s.anims) {
      if (a.kind === "enter") applyEnter(a.n, clamp((lt - a.at) / (a.dur || enterDur)), a.how);
      else if (a.kind === "class") a.n.classList.toggle(a.cls, lt >= a.at);
      else if (a.kind === "type") {
        const count = Math.floor(Math.max(0, lt - a.at) * a.cps);
        const typing = lt >= a.at && count < a.text.length;
        a.n.style.opacity = lt >= a.at ? 1 : 0;
        a.n.textContent = a.text.slice(0, count);
        if (typing) a.n.append(el("span", "caret"));
      } else if (a.kind === "browser") applyBrowser(a, lt, s.dur);
      else if (a.kind === "phone") applyPhone(a, lt, s.dur, t);
      else if (a.kind === "page") applyPage(a, lt);
      else if (a.kind === "pill") applyPill(a, lt);
      else if (a.kind === "card") applyCard(a, lt);
      else if (a.kind === "tag") applyTag(a, lt);
      else if (a.kind === "count") applyCount(a, lt);
      else if (a.kind === "rule") a.n.style.scale = `${ease(clamp((lt - a.at) / a.dur))} 1`;
    }
    if (s.halo) {
      s.halo.style.transform = `translate(${Math.sin(t * 0.7) * 1.2}rem, ${Math.cos(t * 0.6) * 1}rem) scale(${1 + Math.sin(t * 1.4) * 0.05})`;
    }
  }

  function reset(s) {
    Object.assign(s.node.style, { opacity: "", translate: "", transform: "", transformOrigin: "", filter: "", clipPath: "", zIndex: "" });
    s.node.style.setProperty("--flash", "0");
  }

  window.seek = (t) => {
    t = Math.max(0, Math.min(total - 0.001, t));
    let i = scenes.findIndex((s) => t >= s.start && t < s.start + s.dur);
    if (i < 0) i = scenes.length - 1;
    for (const s of scenes) { s.node.classList.remove("on"); reset(s); }
    for (const n of floating) n.style.display = "none";
    const s = scenes[i];
    const lt = t - s.start;
    const trDur = TRANSITIONS[s.tr] ?? 0.3;
    const k = trDur ? clamp(lt / trDur) : 1;
    draw(s, lt - s.delay, t);

    // 轉場前半段：需要前一幕的轉場（wipe、push、blur）把前一幕停在最後一格一起畫。
    if (OVERLAP.has(s.tr) && k < 1 && i > 0) {
      const p = scenes[i - 1];
      draw(p, p.dur - 0.001, t);
      const e = easeInOut(k);
      if (s.tr === "zoom") {
        // 往鏡頭衝：前一幕朝手機的位置越放越快，衝滿畫面後切到新一幕（再閃白）。
        p.node.style.zIndex = 2;
        p.node.style.transformOrigin = D.portrait ? "50% 62%" : "74% 50%";
        p.node.style.transform = `scale(${1 + 1.4 * k * k})`;
      } else if (s.tr === "iris") {
        // 圓形展開：新的一幕從 from 這一點長出一個圓，越長越快，蓋滿畫面。
        s.node.style.zIndex = 2;
        s.node.style.clipPath = `circle(${k * k * 150}% at ${s.from.x * 100}% ${s.from.y * 100}%)`;
      } else if (s.tr === "wipe") {
        // 斜切：新的一幕從左邊斜斜地掃過來，蓋住前一幕。
        s.node.style.zIndex = 2;
        const x = lerp(0, 125, e);
        s.node.style.clipPath = `polygon(0 0, ${x}% 0, ${x - 22}% 100%, 0 100%)`;
      } else if (s.tr === "pan") {
        // 橫搖：前一幕往左滑走、新一幕從右邊跟著進來（操作示範的收尾：網頁滑走、露出產品名）。
        // 兩幕並排不重疊；新一幕放上面，它的網址膠囊才不會被滑走中的網頁蓋住
        s.node.style.zIndex = 2;
        p.node.style.translate = `${-e * 100}% 0`;
        s.node.style.translate = `${(1 - e) * 100}% 0`;
      } else if (s.tr === "push") {
        // 往上推：前一幕帶著斜的底邊往上滑走，露出底下的新一幕（新一幕的手機同時從下面升上來）。
        p.node.style.zIndex = 2;
        p.node.style.clipPath = "polygon(0 0, 100% 0, 100% 86%, 0 100%)";
        p.node.style.translate = `0 ${-e * 115}%`;
      } else {
        // 糊掉：前一幕很快地糊掉淡出，底下的新一幕各自進場（手機從右邊滑進來）。
        p.node.style.zIndex = 2;
        p.node.style.opacity = 1 - k;
        p.node.style.filter = `blur(${k * 1.2}rem)`;
      }
    } else if (s.tr === "fade" || s.tr === "slide") {
      s.node.style.opacity = k;
      if (s.tr === "slide") s.node.style.translate = (1 - ease(k)) * 3 + "rem 0";
    }
    // zoom、flash：新一幕一開始蒙一層白，很快退掉。
    if (s.tr === "zoom" || s.tr === "flash") {
      const since = lt - (TRANSITIONS[s.tr] || 0);
      if (since >= 0) s.node.style.setProperty("--flash", String(0.6 * (1 - clamp(since / FLASH))));
    }
    // 下一幕用淡入時，這一幕最後 0.2 秒先淡出。
    const next = scenes[i + 1];
    if ((next ? next.tr === "fade" : s.tr === "fade") && s.dur - lt < 0.2) {
      s.node.style.opacity = Math.min(Number(s.node.style.opacity || 1), clamp((s.dur - lt) / 0.2));
    }
    bar.style.width = (t / total) * 100 + "%";
  };
  window.duration = total;

  // 直接用瀏覽器打開 player.html 時自動循環播放，方便不算圖就先預覽。
  // 中文網路字體是切成很多小檔、用到才下載：先把每一幕（包括還沒出場的）用到的字都載好。
  function loadFonts() {
    const loads = [];
    for (const n of stage.querySelectorAll("h1, h2, .num, .kicker, .sub, .caption, .pill, .tag, .url, .pcard, .point, .body")) {
      const cs = getComputedStyle(n);
      if (n.textContent.trim()) loads.push(document.fonts.load(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`, n.textContent).catch(() => {}));
    }
    return Promise.all(loads).then(() => document.fonts.ready);
  }

  // 靠左版面與 phone／card 幕的標題：每一行都不換行，放不下就等比縮小（最多縮到 60%），再小就改回自動換行。
  function fitHeadings() {
    for (const s of scenes) {
      const heads = s.node.querySelectorAll(".split h1, body[data-align='left'] .stack:not([data-align='center']) h1, .stack[data-align='left'] h1, .is-stat .num");
      if (!heads.length) continue;
      s.node.classList.add("on");
      for (const h of heads) {
        h.style.whiteSpace = "nowrap";
        h.style.maxWidth = "100%";
        const ratio = h.clientWidth / h.scrollWidth;
        if (ratio >= 1) continue;
        if (ratio >= 0.6) h.style.fontSize = parseFloat(getComputedStyle(h).fontSize) * ratio * 0.98 + "px";
        else h.style.whiteSpace = "";
      }
      s.node.classList.remove("on");
    }
  }

  window.ready = Promise.all([
    loadFonts(),
    ...[...document.images].map((img) => img.decode().catch(() => {})),
  ]).then(() => {
    fitHeadings();
    // 網址膠囊要長到的位置：真正網址在這一幕裡的位置（版面排好之後量一次）
    for (const s of scenes) for (const a of s.anims) {
      if (a.kind !== "pill") continue;
      s.node.classList.add("on");
      const box = s.node.getBoundingClientRect(), r = a.real.getBoundingClientRect();
      a.to = { x: r.left - box.left, y: r.top - box.top, w: r.width, h: r.height };
      s.node.classList.remove("on");
    }
    // 瀏覽器幕的視窗比例跟著截圖走：橫的截圖是橫視窗，手機截圖是直視窗。
    for (const s of scenes) for (const a of s.anims) {
      if (a.kind === "browser" && a.img.naturalWidth) a.view.parentNode.style.setProperty("--ratio", String(a.img.naturalWidth / a.img.naturalHeight));
    }
    window.seek(0);
    if (new URLSearchParams(location.search).has("still")) return;
    if (!navigator.webdriver) {
      const fitStage = () => {
        stage.style.scale = String(Math.min(innerWidth / D.width, innerHeight / D.height));
      };
      fitStage();
      addEventListener("resize", fitStage);
      const t0 = performance.now();
      const tick = (now) => { window.seek(((now - t0) / 1000) % total); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }
  });
})();
