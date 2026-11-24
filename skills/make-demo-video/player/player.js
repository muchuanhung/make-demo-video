// 影片的每一格都是時間 t 的純函式：window.seek(t) 畫出第 t 秒。
// 算圖腳本逐格呼叫 seek 再截圖，所以這裡不能用 CSS animation 或計時器。
(() => {
  const D = window.__DATA__;
  const S = D.style;
  const stage = document.getElementById("stage");
  const root = document.documentElement.style;

  root.setProperty("--w", D.width + "px");
  root.setProperty("--h", D.height + "px");
  document.documentElement.style.fontSize = (D.portrait ? D.width / 36 : D.width / 64) + "px";
  const c = S.colors;
  for (const [name, value] of Object.entries({
    bg: c.bg, backdrop: c.backdrop || c.bg, surface: c.surface, text: c.text, muted: c.muted,
    accent: c.accent, "accent-text": c.accentText, "accent-ink": c.accentInk || c.accent, border: c.border,
    "font-display": S.fonts.display, "font-body": S.fonts.body, "font-mono": S.fonts.mono,
    radius: S.radius + "px", shadow: S.shadow || "none",
  })) root.setProperty("--" + name, value);
  document.body.dataset.decor = S.decor || "none";
  document.body.dataset.caption = S.caption || "plain";
  if (D.portrait) document.body.dataset.portrait = "";

  const clamp = (x) => Math.max(0, Math.min(1, x));
  const ease = (k) => 1 - Math.pow(1 - k, 3);
  const lerp = (a, b, k) => a + (b - a) * k;

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

  function build(scene, index) {
    const node = el("section", "scene");
    const anims = [];
    const enter = (n, at) => { anims.push({ kind: "enter", n, at }); return n; };
    const type = (n, text, at, cps) => { anims.push({ kind: "type", n, text, at, cps }); return n; };
    const dur = scene.seconds;
    // 內容多到排不進這一幕時，等比壓縮出場時間，不讓字還沒出完就切走。
    const fit = (times) => {
      const last = Math.max(...times, 0);
      const room = Math.max(0.5, dur - 1.2);
      return last > room ? room / last : 1;
    };

    if (scene.step) {
      const chip = el("div", "step");
      chip.append(el("b", "", scene.step.label || "STEP " + scene.step.n), scene.step.name || "");
      node.append(enter(chip, 0));
    }

    const kind = scene.kind;
    if (kind === "title" || kind === "outro") {
      if (scene.kicker) node.append(enter(el("div", "kicker", scene.kicker), 0.1));
      node.append(enter(rich(el("h1"), scene.heading), 0.3));
      if (scene.sub) node.append(enter(rich(el("div", "sub"), scene.sub), 0.8));
      if (kind === "outro") {
        if (D.qrSvg) {
          const qr = el("div", "qr");
          qr.innerHTML = D.qrSvg;
          node.append(enter(qr, 1.1));
        }
        const url = scene.url || D.url;
        if (url) node.append(enter(el("div", "url", url.replace(/^https?:\/\//, "")), 1.3));
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
      node.append(enter(win, 0.1));
    } else if (kind === "browser") {
      const win = el("div", "win browser");
      const bar = el("div", "bar");
      bar.append(el("i"), el("i"), el("i"), el("span", "address", scene.address || ""));
      const view = el("div", "viewport");
      const img = el("img");
      img.src = scene.image;
      view.append(img);
      const cursor = el("div", "cursor");
      const ripple = el("div", "ripple");
      if ((scene.clicks || []).length) view.append(ripple, cursor);
      win.append(bar, view);
      node.append(enter(win, 0.1));
      anims.push({ kind: "browser", view, img, cursor, ripple, focus: scene.focus || [], clicks: scene.clicks || [] });
    } else if (kind === "points") {
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
    scenes.push({ node, anims, start: cursorTime, dur });
    cursorTime += dur;
  }

  D.scenes.forEach(build);
  const total = cursorTime;
  const bar = el("div", "progress");
  stage.append(bar);

  const M = S.motion || {};
  const enterDur = M.duration || 0.4;

  function applyEnter(n, k) {
    if (M.enter === "step") { n.style.opacity = k > 0 ? 1 : 0; return; }
    const e = ease(k);
    n.style.opacity = e;
    if (M.enter === "pop") n.style.scale = String(0.86 + 0.14 * e);
    else n.style.translate = "0 " + (1 - e) * 1.5 + "rem";
  }

  function applyBrowser(a, lt, dur) {
    const p = clamp(lt / dur);
    const keys = a.focus.length ? a.focus : [{ at: 0, x: 0.5, y: 0.5, zoom: 1 }];
    let from = keys[0], to = keys[0];
    for (const key of keys) { if (key.at <= p) from = key; else { to = key; break; } to = key; }
    const span = to.at - from.at;
    const k = span > 0 ? ease(clamp((p - from.at) / span)) : 1;
    const zoom = lerp(from.zoom || 1, to.zoom || 1, k);
    const x = lerp(from.x, to.x, k), y = lerp(from.y, to.y, k);
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

  window.seek = (t) => {
    t = Math.max(0, Math.min(total - 0.001, t));
    for (const s of scenes) {
      const lt = t - s.start;
      const on = lt >= 0 && lt < s.dur;
      s.node.classList.toggle("on", on);
      if (!on) continue;
      const tr = M.transition || "fade";
      const inK = tr === "cut" ? 1 : clamp(lt / 0.3);
      const outK = tr === "cut" ? 1 : clamp((s.dur - lt) / 0.2);
      s.node.style.opacity = Math.min(inK, outK);
      if (tr === "slide") s.node.style.translate = (1 - ease(inK)) * 3 + "rem 0";
      for (const a of s.anims) {
        if (a.kind === "enter") applyEnter(a.n, clamp((lt - a.at) / enterDur));
        else if (a.kind === "class") a.n.classList.toggle(a.cls, lt >= a.at);
        else if (a.kind === "type") {
          const count = Math.floor(Math.max(0, lt - a.at) * a.cps);
          const typing = lt >= a.at && count < a.text.length;
          a.n.style.opacity = lt >= a.at ? 1 : 0;
          a.n.textContent = a.text.slice(0, count);
          if (typing) a.n.append(el("span", "caret"));
        } else if (a.kind === "browser") applyBrowser(a, lt, s.dur);
      }
    }
    bar.style.width = (t / total) * 100 + "%";
  };
  window.duration = total;

  // 直接用瀏覽器打開 player.html 時自動循環播放，方便不算圖就先預覽。
  window.ready = Promise.all([
    document.fonts.ready,
    ...[...document.images].map((img) => img.decode().catch(() => {})),
  ]).then(() => {
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
