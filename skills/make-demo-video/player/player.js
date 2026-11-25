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
  let cursorTime = 0;
  const enterDur = M.duration || 0.4;

  // 幕與幕之間的轉場：wipe、push、blur 會讓前一幕和這一幕同時出現一小段。
  // 秒數照參考影片逐格量的：快節奏的轉場大多 0.2–0.4 秒，太慢會覺得拖。
  const TRANSITIONS = { cut: 0, fade: 0.3, slide: 0.3, blur: 0.2, wipe: 0.4, push: 0.33, zoom: 0.18, iris: 0.24, flash: 0 };
  const OVERLAP = new Set(["wipe", "push", "blur", "zoom", "iris"]);
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
    const tr = index === 0 ? "cut" : scene.transition || M.transition || "fade";
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
        if (url) node.append(enter(el("div", "url", url.replace(/^https?:\/\//, "") + (scene.qr === false ? " ↗" : "")), 0.95));
      }
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

  // 作品卡：從放大、傾斜的位置落到定位，落定之後就不動（卡片上有字，一直漂會閃）。
  function applyCard(a, lt) {
    const k = ease(clamp(lt / 0.45));
    a.n.style.opacity = String(0.3 + 0.7 * clamp(lt / 0.15));
    a.n.style.transform = k < 1
      ? `perspective(60rem) translate(${(1 - k) * -8}%, ${(1 - k) * 10}%) rotateX(${(1 - k) * 16}deg) rotate(${(1 - k) * -8}deg) scale(${1.3 - 0.3 * k})`
      : "";
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
      else if (a.kind === "card") applyCard(a, lt);
      else if (a.kind === "tag") applyTag(a, lt);
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
    for (const n of stage.querySelectorAll("h1, h2, .kicker, .sub, .caption, .pill, .tag, .url, .pcard, .point, .body")) {
      const cs = getComputedStyle(n);
      if (n.textContent.trim()) loads.push(document.fonts.load(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`, n.textContent).catch(() => {}));
    }
    return Promise.all(loads).then(() => document.fonts.ready);
  }

  // 靠左版面與 phone／card 幕的標題：每一行都不換行，放不下就等比縮小（最多縮到 60%），再小就改回自動換行。
  function fitHeadings() {
    for (const s of scenes) {
      const heads = s.node.querySelectorAll(".split h1, body[data-align='left'] .stack:not([data-align='center']) h1, .stack[data-align='left'] h1");
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
