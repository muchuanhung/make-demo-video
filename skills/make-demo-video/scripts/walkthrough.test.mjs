// 操作示範的八個鏡頭模板：展開的結構直接測；整支走一次 loadStoryboard（假截圖＋錨點檔），確認排得出來、沒有提醒。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PNG } from "pngjs";

import { expandShots, lintShots } from "./shots.mjs";
import { loadStoryboard } from "./lib.mjs";

// 一整支：結果先上 → 首頁 → 找 → 重拍 → 點 → 展開 → 細節 → 收尾
const BOARD = {
  title: "walkthrough",
  aspect: "16:9",
  beat: 0.5,
  url: "https://example.com",
  scenes: [
    { shot: "reveal", image: "result-full.png", to: "現在天氣" },
    { shot: "home", image: "home-full.png", heading: "台灣天氣，" },
    { shot: "seek", image: "home-full.png", to: "切換城市" },
    { shot: "burst", images: [{ image: "a-full.png", to: "現在天氣" }, { image: "b-full.png", to: "現在天氣" }, { image: "result-full.png", to: "現在天氣" }] },
    { shot: "click", image: "home-full.png", to: "切換城市" },
    { shot: "expand", image: "result-full.png", to: "現在天氣" },
    { shot: "focus", image: "result-full.png", mark: "現在天氣", press: "複製連結", after: "copied-full.png", afterTo: "已複製" },
    { shot: "dock", heading: "weather-board", sub: "台灣天氣，一眼看完" },
  ],
};

test("expandShots：八個模板都展開成 page 幕（收尾是結尾幕），秒數照拍數", () => {
  const { scenes, rows, problems } = expandShots(BOARD);
  assert.deepEqual(problems, []);
  assert.deepEqual(rows.map((r) => r.seconds), [1, 3, 2, 1.5, 2.5, 2.5, 3, 6]);
  assert.ok(rows.every((r) => r.walk));
  // burst 三張各一拍、expand 拆成「推近」與「新的一頁」兩幕
  assert.deepEqual(scenes.map((s) => s.kind), ["page", "page", "page", "page", "page", "page", "page", "page", "page", "page", "outro"]);
  assert.deepEqual(scenes.filter((s) => s.shot === "burst").map((s) => s.seconds), [0.5, 0.5, 0.5]);
  const [push, open] = scenes.filter((s) => s.shot === "expand");
  assert.equal(push.image, "home-full.png", "expand 先用前一幕（click）的截圖推近");
  assert.equal(open.image, "result-full.png");
  // click：跟在 burst 後面，先縮回原位；點擊在最後 1.5 拍
  const click = scenes.find((s) => s.shot === "click");
  assert.ok(click.start);
  assert.deepEqual(click.clicks, [{ at: 1.75, to: "切換城市" }]);
  // focus：推近 → 螢光筆 → 按按鈕
  const focus = scenes.find((s) => s.shot === "focus");
  assert.equal(focus.marks[0].at, 1.11);
  assert.equal(focus.presses[0].at, 2.31);
  assert.equal(focus.marks[0].style, undefined, "沒寫 markStyle 時照截圖深淺自動選");
  const styled = expandShots({ beat: 0.5, scenes: [{ shot: "focus", image: "x.png", mark: "x", markStyle: "under" }] }).scenes[0];
  assert.equal(styled.marks[0].style, "under");
  // 收尾用橫搖接進來，不放 QR code
  assert.equal(scenes.at(-1).transition, "pan");
  assert.equal(scenes.at(-1).qr, false);
  // 快節奏導覽的規則（一個鏡頭最長 3 秒、平均太慢）不套用
  assert.deepEqual(lintShots({ rows, beat: 0.5 }), []);
});

test("expandShots：缺東西時說清楚", () => {
  const say = (scenes) => expandShots({ beat: 0.5, scenes }).problems.join("\n");
  assert.match(say([{ shot: "expand", image: "x.png" }]), /expand 要接在 click 後面/);
  assert.match(say([{ shot: "focus", image: "x.png" }]), /mark.*或 press/);
  assert.match(say([{ shot: "focus", image: "x.png", press: "複製" }]), /寫了 press 就要寫 after/);
  assert.match(say([{ shot: "burst" }]), /要寫 images.*或 image/);
  assert.match(say([{ shot: "home", image: "x.png" }]), /少了 heading/);
  assert.match(say([{ shot: "seek", image: "x.png" }]), /少了 to/);
});

test("lintShots：burst 不在拍點上時提醒（配樂的重拍會對不齊）", () => {
  const board = { beat: 0.5, scenes: [{ shot: "home", image: "h.png", heading: "x", seconds: 2.7 }, { shot: "burst", image: "h.png" }] };
  const notes = lintShots(expandShots(board));
  assert.match(notes.map((n) => n.message).join(), /重拍從 2.7 秒開始，不在拍點上/);
  assert.deepEqual(lintShots(expandShots({ ...board, scenes: [{ ...board.scenes[0], seconds: 3 }, board.scenes[1]] })), []);
});

test("burst 只有一張截圖時是推近重拍：推近 1.3 倍、停一下、回到 seek 的縮放", () => {
  const { scenes } = expandShots({ beat: 0.5, scenes: [{ shot: "seek", image: "h.png", to: "x", zoom: 2 }, { shot: "burst", image: "h.png" }] });
  assert.deepEqual(scenes[1].camera.map((m) => m.zoom), [2.6, 2]);
});

// 假的網頁截圖：1280×2560 白底，按鈕的位置畫一塊；copied 那張的按鈕是另一個顏色（按了之後變了）
async function fixture(dir) {
  const anchors = [
    { text: "切換城市", y: 0.05, box: [129, 129, 28, 28], click: true },
    { text: "現在天氣", y: 0.1, box: [64, 250, 57, 17] },
    { text: "複製連結", y: 0.2, box: [600, 500, 100, 40], click: true },
  ];
  const pages = { "home-full": 255, "result-full": 255, "a-full": 255, "b-full": 255, "copied-full": 255 };
  for (const [name, bg] of Object.entries(pages)) {
    const png = new PNG({ width: 1280, height: 2560 });
    png.data.fill(bg);
    const copied = name === "copied-full";
    for (let y = 500; y < 540; y++) for (let x = 600; x < 700; x++) {
      const k = (y * 1280 + x) * 4;
      png.data[k] = copied ? 40 : 20;
      png.data[k + 1] = copied ? 140 : 20;
      png.data[k + 2] = copied ? 80 : 20;
    }
    await writeFile(path.join(dir, name + ".png"), PNG.sync.write(png));
    const list = copied ? anchors.map((a) => (a.text === "複製連結" ? { ...a, text: "已複製" } : a)) : anchors;
    await writeFile(path.join(dir, name + ".json"), JSON.stringify({ width: 1280, height: 2560, scale: 1, anchors: list }));
  }
}

test("loadStoryboard：整支操作示範排得出來，攝影機與游標一路接著走、沒有提醒", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "walk-"));
  try {
    await fixture(dir);
    const file = path.join(dir, "storyboard.json");
    await writeFile(file, JSON.stringify(BOARD));
    const board = await loadStoryboard(file);
    assert.deepEqual(board.warnings, []);
    assert.equal(board.duration, 21.5);
    const pages = board.scenes.filter((s) => s.kind === "page");
    assert.ok(pages.every((s) => s.cam?.length >= 2), "每一幕 page 都排好攝影機");
    // 游標從 click 才出場，之後一路接著（展開、細節），收尾沒有
    const withCursor = board.scenes.map((s) => (s.cursor ? s.shot : null)).filter(Boolean);
    assert.deepEqual(withCursor, ["click", "expand", "expand", "focus"]);
    const focus = board.scenes.find((s) => s.shot === "focus");
    assert.equal(focus.markAt.length, 1);
    assert.equal(focus.swaps.length, 1);
    assert.ok(board.images["copied-full.png"], "按了之後的截圖要嵌進頁面");
    // 收尾的網址膠囊從 focus 按的「複製連結」長出來
    const dock = board.scenes.at(-1);
    assert.equal(dock.shot, "dock");
    assert.equal(dock.pillFrom.length, 4);
    assert.ok(dock.pillFrom[0] < dock.pillFrom[2] && dock.pillFrom[1] < dock.pillFrom[3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
