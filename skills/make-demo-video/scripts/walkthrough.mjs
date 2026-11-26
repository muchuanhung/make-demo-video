// 操作示範剪法的八個鏡頭模板：每個模板展開成 page 幕（網頁鋪滿畫面＋攝影機、游標、螢光筆、按按鈕）。
// 分鏡只寫「哪張截圖、哪段字」，運鏡與點擊的秒數都照拍數在這裡算好；檢查交給 camera.mjs（lib.mjs 排 page 幕時跑）。
//
// 一整支的順序：reveal → home → seek → burst → click → expand → focus → dock（路徑長時 click → expand → focus 可以重複）。
// 整支片是一台攝影機：相鄰的 page 幕攝影機接著走（lib.mjs），所以模板大多不寫開場位置，只寫這一段要往哪裡去。

export const WALK_SHOTS = {
  reveal: { label: "結果先上", beats: 2, needs: ["image", "to"], walk: true },
  home: { label: "現場", beats: 6, needs: ["image", "heading"], walk: true },
  seek: { label: "找", beats: 4, needs: ["image", "to"], walk: true },
  burst: { label: "重拍", beats: 3, needs: [], walk: true },
  click: { label: "點", beats: 5, needs: ["image", "to"], walk: true },
  expand: { label: "展開", beats: 5, needs: ["image"], walk: true },
  focus: { label: "細節", beats: 6, needs: ["image"], walk: true },
  dock: { label: "收尾", beats: 12, needs: ["heading"], walk: true },
};

const ZOOM = { reveal: 2.5, seek: 2, burst: 1.6, focus: 2, punch: 1.3, expand: 4 };
const r = (x) => Math.round(x * 1000) / 1000;

/**
 * 展開一個操作示範鏡頭。
 * @param s 分鏡的這一幕
 * @param ctx.seconds 這一幕幾秒；ctx.beat 一拍幾秒；ctx.prev 前一幕（分鏡原本寫的）；ctx.row 第幾幕；ctx.say(問題)
 * @returns 低階分鏡陣列
 */
export function expandWalk(s, { seconds, beat, prev, row, say }) {
  const base = { kind: "page", row, shot: s.shot };
  const page = (extra) => ({ ...base, image: s.image, seconds, ...extra });
  const zoom = s.zoom ?? ZOOM[s.shot] ?? 2;

  switch (s.shot) {
    case "reveal":
      // 操作完的結果先推得很近，再拉遠變成整個網頁
      return [page({ start: { to: s.to, zoom }, camera: [{ at: r(seconds * 0.15), dur: r(seconds * 0.7), to: s.to, zoom: 1 }] })];

    case "home":
      // 首頁鋪滿、頁首開始，攝影機只有慢慢推近的漂移；產品名或標語前半落在畫面下方
      return [page({ start: { x: 0.5, y: 0, zoom: 1 }, caption: s.heading })];

    case "seek":
      // 先捲到目標（不縮放），停一下，再推近
      return [page({ camera: [
        { at: 0, dur: r(seconds * 0.4), to: s.to, zoom: 1 },
        { at: r(seconds * 0.55), dur: r(seconds * 0.3), to: s.to, zoom },
      ] })];

    case "burst": {
      if (s.images?.length) {
        // 配樂的重拍：幾個結果各一拍硬切（全片唯一的硬切），每張推近到自己的 to
        if (s.images.length < 2) say("images 至少要 2 張（建議 3 張）；只有一張時拿掉 images、改寫 image，會變成一記推近重拍");
        const each = r(seconds / s.images.length);
        return s.images.map((im, i) => ({
          ...base,
          image: im.image,
          seconds: i === s.images.length - 1 ? r(seconds - each * i) : each,
          start: im.to ? { to: im.to, zoom: im.zoom ?? zoom } : { x: 0.5, y: 0, zoom: im.zoom ?? 1 },
          cursor: false,
        }));
      }
      // 素材湊不到幾個結果：一記推近重拍（推近 1.3 倍、停半拍、回原位），不硬切
      if (!s.image) { say("要寫 images（幾個結果的截圖）或 image（一記推近重拍）"); return []; }
      const from = prev?.shot === "seek" ? prev.zoom ?? ZOOM.seek : 1;
      return [page({ camera: [
        { at: 0, dur: r(beat * 0.4), zoom: r(from * ZOOM.punch) },
        { at: r(beat * 0.9), dur: r(beat * 1.2), zoom: from },
      ] })];
    }

    case "click": {
      // 游標移過去、停 1 拍、點下去；點完還留 1 拍看光圈。跟在 burst 後面時先縮回原位
      const after = prev?.shot === "burst";
      return [page({
        ...(after ? { start: { to: s.to, zoom: r(zoom * ZOOM.punch) } } : {}),
        camera: [{ at: 0, dur: r(seconds * 0.25), to: s.to, zoom }],
        clicks: [{ at: r(seconds - beat * 1.5), to: s.to }],
      })];
    }

    case "expand": {
      // 點下去的那個東西放大展開成下一頁：前一張截圖推到很近 → 硬切成新的一頁 → 拉遠
      if (!prev?.image || !prev?.to) { say("expand 要接在 click 後面（用前一幕的截圖與 to 推近）"); return []; }
      const push = r(beat);
      return [
        { ...base, image: prev.image, seconds: push, camera: [{ at: 0, dur: r(beat * 0.8), to: prev.to, zoom: ZOOM.expand }] },
        { ...base, image: s.image, seconds: r(seconds - push), camera: [{ at: r(beat * 0.2), dur: r((seconds - push) * 0.5), ...(s.to ? { to: s.to } : {}), zoom: s.zoom ?? 1 }] },
      ];
    }

    case "focus": {
      // 推近到要看的地方，螢光筆劃一句，再按一個按鈕（「複製」→「已複製」）；兩個都有時一起入鏡
      const both = [s.mark, s.press].filter((x) => x != null);
      const target = both.length > 1 ? both : both[0];
      if (!target) { say("focus 要寫 mark（螢光筆劃的字）或 press（要按的按鈕），至少一個"); return []; }
      if (s.press && !s.after) say("寫了 press 就要寫 after（按了之後的截圖，用 capture.mjs --click 截）");
      return [page({
        camera: [{ at: 0, dur: r(seconds * 0.27), to: target, zoom }],
        ...(s.mark ? { marks: [{ at: r(seconds * 0.37), to: s.mark, ...(s.markStyle ? { style: s.markStyle } : {}) }] } : {}),
        ...(s.press && s.after ? { presses: [{ at: r(seconds * (s.mark ? 0.77 : 0.55)), to: s.press, after: s.after, afterTo: s.afterTo }] } : {}),
      })];
    }

    case "dock":
      // 頁面往左滑走，產品名與完整標語落下，最後一格是海報
      return [{ ...base, kind: "outro", seconds, tone: s.tone || "base", transition: s.transition || "pan", heading: s.heading, sub: s.sub, url: s.url, qr: false }];
  }
  return [];
}
