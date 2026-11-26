import { test } from "node:test";
import assert from "node:assert/strict";

import { cameraAt, cameraView, clampCamera, planCamera, planCursor, planMarks, planPresses, SWAP_AT, handoffRect, toScreen, toPage, cameraRuntime, DRIFT_PER_SECOND, CURSOR_ENTRY } from "./camera.mjs";
import { findAnchor } from "./shots.mjs";

const frame = { w: 1280, h: 720 };
// 1280 寬、2560 高的長網頁：塞滿寬時畫面看得到上面 720 / 2560 ≈ 28%
const page = {
  w: 1280,
  h: 2560,
  anchors: [
    { text: "高雄市", y: 0.05, box: [32, 125, 90, 36] },
    { text: "複製連結", y: 0.5, box: [600, 1280, 80, 40] },
    { text: "舊錨點", y: 0.7 },
  ],
};
const plan = (scene, opts = {}) => planCamera({ seconds: 4, ...scene }, { page, frame, beat: 0.5, findAnchor, ...opts });
const near = (a, b, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);

test("cameraAt：縮放在對數上內插，一半時間是兩端的幾何平均；指數緩動兩端停得乾淨", () => {
  const keys = [{ t: 0, x: 0.5, y: 0.5, z: 1 }, { t: 2, x: 0.5, y: 0.5, z: 4, ease: "move" }];
  near(cameraAt(keys, 1).z, 2);
  assert.deepEqual(cameraAt(keys, -1), { x: 0.5, y: 0.5, z: 1 });
  assert.deepEqual(cameraAt(keys, 9), { x: 0.5, y: 0.5, z: 4 });
  // 指數緩動：前 10% 幾乎不動，後 10% 幾乎到了
  assert.ok(cameraAt(keys, 0.2).z < 1.01);
  assert.ok(cameraAt(keys, 1.8).z > 3.95);
  // 漂移段是等速的
  const drift = [{ t: 0, x: 0.5, y: 0.5, z: 1 }, { t: 2, x: 0.5, y: 0.5, z: 1.03, ease: "drift" }];
  near(cameraAt(drift, 1).z, Math.sqrt(1.03));
});

test("cameraView：畫面正中對到攝影機的點，夾在截圖範圍內", () => {
  const img = { w: 2560, h: 5120 }; // 2 倍解析度的截圖也一樣，用的是比例
  const mid = cameraView({ x: 0.5, y: 0.5, z: 2 }, frame, img);
  near(mid.s, 1);
  near(mid.tx + 0.5 * img.w * mid.s, 640);
  near(mid.ty + 0.5 * img.h * mid.s, 360);
  // 攝影機對到左上角：夾住，不露出截圖外
  const corner = cameraView({ x: 0, y: 0, z: 2 }, frame, img);
  assert.equal(corner.tx, 0);
  assert.equal(corner.ty, 0);
  // 縮放小於 1：還是塞滿寬
  near(cameraView({ x: 0.5, y: 0.5, z: 0.5 }, frame, img).s * img.w, 1280);
  // 很扁的截圖（比畫面還扁）：高也要塞滿
  const flat = cameraView({ x: 0.5, y: 0.5, z: 1 }, frame, { w: 1280, h: 400 });
  near(flat.s * 400, 720);
});

test("cameraRuntime 不用到外面的變數：轉成字串再執行一樣能算（播放器就是這樣塞進頁面的）", () => {
  const rt = new Function(`return (${cameraRuntime.toString()})();`)();
  const keys = [{ t: 0, x: 0.2, y: 0.3, z: 1 }, { t: 1, x: 0.6, y: 0.3, z: 3, ease: "move" }];
  assert.deepEqual(rt.at(keys, 0.5), cameraAt(keys, 0.5));
});

test("clampCamera：推近後畫面不能超出截圖", () => {
  assert.deepEqual(clampCamera({ x: 0.5, y: 0, z: 1 }, frame, page), { x: 0.5, y: round4(0.5 * (720 / 2560)), z: 1 });
  assert.deepEqual(clampCamera({ x: 0, y: 1, z: 2 }, frame, page), { x: 0.25, y: round4(1 - 0.25 * (720 / 2560)), z: 2 });
  assert.equal(clampCamera({ x: 0.5, y: 0.5, z: 9 }, frame, page).z, 4);
});

test("planCamera：沒寫開場時從頁首、整頁寬開始；空檔自動補漂移", () => {
  const { keys, end, problems, warnings } = plan({ camera: [] });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
  assert.equal(keys.length, 2);
  assert.equal(keys[0].z, 1);
  near(keys[0].y, 0.5 * (720 / 2560));
  assert.equal(keys[1].ease, "drift");
  near(end.z, 1 + DRIFT_PER_SECOND * 4);
});

test("planCamera：推近到錨點的中心，前後的空檔是漂移，下一個運鏡從漂移後的位置開始", () => {
  const { keys, problems } = plan({ camera: [{ at: 1, dur: 1, to: "複製連結", zoom: 2 }] });
  assert.deepEqual(problems, []);
  assert.deepEqual(keys.map((k) => [k.t, k.ease]), [[0, undefined], [1, "drift"], [2, "move"], [4, "drift"]]);
  near(keys[2].x, 640 / 1280);
  near(keys[2].y, 1300 / 2560);
  near(keys[2].z, 2);
  near(keys[1].z, 1 + DRIFT_PER_SECOND);
});

test("planCamera：接上一幕的最後一格", () => {
  const { keys } = plan({ camera: [] }, { start: { x: 0.5, y: 0.5, z: 2 } });
  assert.deepEqual({ x: keys[0].x, y: keys[0].y, z: keys[0].z }, { x: 0.5, y: 0.5, z: 2 });
});

test("planCamera：to 寫成陣列時幾段字一起入鏡，縮放限制在放得下的大小", () => {
  const wide = { ...page, anchors: [...page.anchors, { text: "左邊", y: 0.47, box: [100, 1200, 80, 40] }, { text: "右邊", y: 0.5, box: [900, 1300, 80, 40] }] };
  const run = (camera) => planCamera({ seconds: 4, camera }, { page: wide, frame, beat: 0.5, findAnchor });
  const { keys, warnings } = run([{ at: 0, dur: 1, to: ["左邊", "右邊"], zoom: 3 }]);
  assert.deepEqual(warnings, []);
  // 合起來從 x 100 到 980（佔畫面寬 69%）：最多 0.85 / 0.6875 ≈ 1.24 倍，對準合起來的中心
  near(keys[1].z, 0.85 / (880 / 1280));
  near(keys[1].x, 540 / 1280);
  near(keys[1].y, 1270 / 2560);
  // 合起來比畫面還高：放不下就提醒
  assert.match(run([{ at: 0, dur: 1, to: ["高雄市", "複製連結"] }]).warnings.join(), /「高雄市」「複製連結」不在畫面裡/);
  assert.match(run([{ at: 0, dur: 1, to: ["高雄市", "台南市"] }]).problems.join(), /找不到「台南市」/);
});

test("planCamera：同一時間兩個運鏡就擋下來", () => {
  const { problems } = plan({ camera: [{ at: 0, dur: 2, zoom: 2 }, { at: 1, dur: 1, x: 0.8 }] });
  assert.match(problems.join(), /重疊.*同一時間只能有一種運鏡/);
});

test("planCamera：找不到字、舊錨點沒有位置、超過這一幕的長度都擋下來", () => {
  assert.match(plan({ camera: [{ at: 0, dur: 1, to: "台南市" }] }).problems.join(), /找不到「台南市」.*高雄市/);
  assert.match(plan({ camera: [{ at: 0, dur: 1, to: "舊錨點" }] }).problems.join(), /沒有位置（box）/);
  assert.match(plan({ camera: [{ at: 3, dur: 2, zoom: 2 }] }).problems.join(), /超過這一幕的 4 秒/);
});

test("planCamera：目標靠邊時攝影機停在邊緣，目標還看得到就不提醒；看不到、推太近才提醒", () => {
  // 高雄市在左上角，推近 3 倍時畫面正中到不了那裡，但它還在畫面裡
  const edge = plan({ camera: [{ at: 0, dur: 1, to: "高雄市", zoom: 3 }] });
  assert.deepEqual(edge.warnings, []);
  near(edge.keys[1].x, 0.5 / 3);
  // 一個比畫面還寬的目標：推近後一定有一部分在畫面外
  const wide = planCamera({ seconds: 4, camera: [{ at: 0, dur: 1, to: "整排", zoom: 3 }] }, {
    page: { ...page, anchors: [{ text: "整排", y: 0.5, box: [0, 1280, 1280, 40] }] }, frame, beat: 0.5, findAnchor,
  });
  assert.match(wide.warnings.join(), /推近 3 倍時「整排」不在畫面裡/);
  assert.match(plan({ camera: [{ at: 0, dur: 1, zoom: 6 }] }).warnings.join(), /推近 6 倍太多，最多 4 倍/);
});

test("planCamera：換方向前沒停半拍就提醒，同方向接著走不提醒", () => {
  // 從頁面中間開始，第一個運鏡只有推近
  const start = { start: { x: 0.5, y: 0.5, z: 1 } };
  const back = plan({ camera: [{ at: 0, dur: 1, zoom: 2 }, { at: 1.1, dur: 1, zoom: 1 }] }, start);
  assert.match(back.warnings.join(), /方向不同.*先停半拍/);
  const ok = plan({ camera: [{ at: 0, dur: 1, zoom: 2 }, { at: 1.3, dur: 1, zoom: 1 }] }, start);
  assert.deepEqual(ok.warnings, []);
  const same = plan({ camera: [{ at: 0, dur: 1, zoom: 1.5 }, { at: 1, dur: 1, zoom: 2.5 }] }, start);
  assert.deepEqual(same.warnings, []);
});

// 游標：先排攝影機，再排游標
const cursorOf = (scene, opts = {}) => {
  const full = { seconds: 4, ...scene };
  const cam = planCamera(full, { page, frame, beat: 0.5, findAnchor, start: { x: 0.5, y: 0.5, z: 1 } }).keys;
  return { cam, ...planCursor(full, { cam, page, frame, beat: 0.5, findAnchor, ...opts }) };
};

test("toScreen／toPage：截圖上的點和畫面上的點互換", () => {
  const cam = { x: 0.5, y: 0.5, z: 2 };
  const p = { x: 0.47, y: 0.52 };
  const back = toPage(toScreen(p, cam, frame, page), cam, frame, page);
  near(back.x, p.x);
  near(back.y, p.y);
  // 畫面正中就是攝影機對著的點
  const c = toScreen({ x: 0.5, y: 0.5 }, cam, frame, page);
  near(c.x, 0.5);
  near(c.y, 0.5);
});

test("planCursor：從畫面右下出場，移到目標、停 1 拍再按", () => {
  const { keys, clicks, problems, warnings, cam } = cursorOf({ clicks: [{ at: 2, to: "複製連結" }] });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(clicks, [2]);
  // 開始移動那一刻（0.7 秒）游標在畫面右下
  const entry = toScreen(keys[0], cameraAt(cam, 0.7), frame, page);
  near(entry.x, CURSOR_ENTRY.x);
  near(entry.y, CURSOR_ENTRY.y);
  // 0.7 秒開始移、1.5 秒到（停 1 拍＝0.5 秒），到的地方是按鈕中心
  assert.deepEqual(keys.map((k) => [k.t, k.ease]), [[0, undefined], [0.7, "drift"], [1.5, "move"], [4, "drift"]]);
  near(keys[2].x, 640 / 1280);
  near(keys[2].y, 1300 / 2560);
});

test("planCursor：接上一幕的游標（畫面上的位置不變），最後一格回傳畫面上的位置", () => {
  const { keys, end, cam } = cursorOf({ clicks: [] }, { start: { x: 0.3, y: 0.4 } });
  const s = toScreen(keys[0], cameraAt(cam, 0), frame, page);
  near(s.x, 0.3);
  near(s.y, 0.4);
  // 攝影機一直慢慢推近，游標貼在網頁上，所以最後在畫面上的位置會往外一點點
  assert.ok(Math.abs(end.x - 0.3) < 0.02 && end.x < 0.3);
});

test("planCursor：兩個點擊太近、點擊時攝影機在動、目標不在畫面裡都提醒", () => {
  const dense = cursorOf({ clicks: [{ at: 1, to: "複製連結" }, { at: 1.4, to: "高雄市" }] });
  assert.match(dense.warnings.join(), /第 2 個點擊.*太近.*at 往後挪到 1.9 秒以後/);
  const during = cursorOf({ camera: [{ at: 1, dur: 2, zoom: 2 }], clicks: [{ at: 2, to: "複製連結" }] });
  assert.match(during.warnings.join(), /攝影機正在運鏡/);
  // 攝影機推近到頁面中間 3 倍時，左上角的高雄市不在畫面裡
  const away = cursorOf({ camera: [{ at: 0, dur: 1, zoom: 3 }], clicks: [{ at: 2, to: "高雄市" }] });
  assert.match(away.warnings.join(), /按下去時「高雄市」不在畫面裡/);
});

test("planCursor：找不到字、at 超出這一幕就擋下來", () => {
  assert.match(cursorOf({ clicks: [{ at: 2, to: "台南市" }] }).problems.join(), /找不到「台南市」/);
  assert.match(cursorOf({ clicks: [{ at: 5, to: "高雄市" }] }).problems.join(), /at 要在 0 到 4 秒之間/);
});

test("planCursor：攝影機先推近時，游標用開始移動那一刻的畫面出場，不會被推出畫面", () => {
  const { keys, cam } = cursorOf({ camera: [{ at: 0, dur: 1, zoom: 2 }], clicks: [{ at: 3, to: "複製連結" }] });
  // 1.7 秒開始移動，那時候游標在畫面右下
  const s = toScreen(keys[0], cameraAt(cam, 1.7), frame, page);
  near(s.x, CURSOR_ENTRY.x);
  near(s.y, CURSOR_ENTRY.y);
});

const marksOf = (scene) => {
  const full = { seconds: 4, ...scene };
  const cam = planCamera(full, { page, frame, beat: 0.5, findAnchor, start: { x: 0.5, y: 0.5, z: 1 } }).keys;
  return planMarks(full, { cam, page, frame, findAnchor });
};

test("planMarks：劃在錨點的範圍，預設 0.4 秒掃完", () => {
  const { marks, problems, warnings } = marksOf({ marks: [{ at: 1, to: "複製連結" }] });
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(marks, [{ t: 1, dur: 0.4, rect: [600 / 1280, 1280 / 2560, 680 / 1280, 1320 / 2560].map(round4), style: "fill" }]);
});

test("planMarks：深底改畫底線，也可以自己指定", () => {
  const full = { seconds: 4, marks: [{ at: 1, to: "複製連結" }, { at: 2, to: "高雄市", style: "fill" }] };
  const cam = planCamera(full, { page, frame, beat: 0.5, findAnchor }).keys;
  const { marks } = planMarks(full, { cam, page, frame, findAnchor, lumaOf: () => 0.2 });
  assert.deepEqual(marks.map((m) => m.style), ["under", "fill"]);
});

test("planMarks：找不到字、沒寫 to、超出這一幕就擋下來", () => {
  assert.match(marksOf({ marks: [{ at: 1, to: "台南市" }] }).problems.join(), /找不到「台南市」/);
  assert.match(marksOf({ marks: [{ at: 1, x: 0.5, y: 0.5 }] }).problems.join(), /要寫 to/);
  assert.match(marksOf({ marks: [{ at: 3.8, to: "複製連結" }] }).problems.join(), /4 秒內劃完/);
});

test("planMarks：劃的時候攝影機在動、劃完看不到、停不夠讀完都提醒", () => {
  assert.match(marksOf({ camera: [{ at: 0.8, dur: 1, zoom: 1.5 }], marks: [{ at: 1, to: "複製連結" }] }).warnings.join(), /攝影機正在運鏡/);
  assert.match(marksOf({ camera: [{ at: 0, dur: 0.5, zoom: 3 }], marks: [{ at: 1, to: "高雄市" }] }).warnings.join(), /劃完時「高雄市」不在畫面裡/);
  assert.match(marksOf({ marks: [{ at: 3.3, to: "複製連結" }] }).warnings.join(), /劃完只剩 0.3 秒.*要停 0.5 秒/);
});

// 按了之後的截圖：頁面高度不一樣（即時資料多了一行），「已複製」比「複製連結」窄、位置一樣
const afterPage = { w: 1280, h: 2600, anchors: [{ text: "已複製", y: 0.49, box: [600, 1280, 60, 40], click: true }] };
const pressOf = (presses, opts = {}) => planPresses({ seconds: 4, presses }, {
  page, findAnchor, afterPageOf: (img) => (img === "after.png" ? afterPage : null), ...opts,
});

test("planPresses：從按了之後的截圖剪同一塊（取兩顆按鈕比較大的那個大小）蓋上去，按下去也算一次點擊", () => {
  const { swaps, clicks, problems, warnings } = pressOf([{ at: 2, to: "複製連結", after: "after.png", afterTo: "已複製" }]);
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(clicks, [{ at: 2, to: "複製連結" }]);
  const [sw] = swaps;
  assert.equal(sw.t, round4(2 + SWAP_AT));
  assert.equal(sw.image, "after.png");
  // 80×40 的按鈕加上 4px 邊：88×48，各自從自己的左上角
  assert.deepEqual(sw.rect, [596 / 1280, 1276 / 2560, 684 / 1280, 1324 / 2560].map(round4));
  assert.deepEqual(sw.src, [596 / 1280, 1276 / 2600, 684 / 1280, 1324 / 2600].map(round4));
});

test("planPresses：沒寫 afterTo 時用同一個位置（CSS 像素），頁面高度不同也對得上", () => {
  const { swaps } = pressOf([{ at: 2, to: "複製連結", after: "after.png" }]);
  assert.equal(swaps[0].src[1], round4(1276 / 2600));
});

test("planPresses：缺欄位、找不到字、after 沒有錨點檔都擋；按了之後看起來一樣就提醒", () => {
  assert.match(pressOf([{ at: 2, to: "複製連結" }]).problems.join(), /要寫 to.*與 after/);
  assert.match(pressOf([{ at: 2, to: "分享", after: "after.png" }]).problems.join(), /找不到「分享」/);
  assert.match(pressOf([{ at: 2, to: "複製連結", after: "after.png", afterTo: "已分享" }]).problems.join(), /找不到「已分享」.*已複製/);
  assert.match(pressOf([{ at: 2, to: "複製連結", after: "nope.png" }]).problems.join(), /nope.png 沒有新版錨點檔/);
  const same = pressOf([{ at: 2, to: "複製連結", after: "after.png" }], { changed: () => false });
  assert.match(same.warnings.join(), /按了之後看起來跟按之前一樣/);
});

test("handoffRect：網址膠囊從最後按的按鈕長出來（按按鈕優先），沒有就從游標的位置，都沒有就不用", () => {
  const cam = [{ t: 0, x: 0.5, y: 0.5, z: 1 }];
  const opts = { cam, page, frame, findAnchor };
  // 攝影機在頁面正中、1 倍：複製連結（600,1280 到 680,1320）
  const r = handoffRect({ seconds: 4, clicks: [{ at: 1, to: "高雄市" }], presses: [{ at: 2, to: "複製連結" }] }, opts);
  near(r[0], 600 / 1280);
  near(r[2], 680 / 1280);
  // 按鈕中心在頁面 1300 / 2560；畫面看得到頁面高的 720 / 2560，所以在畫面正中往下一點
  near((r[1] + r[3]) / 2, 0.5 + (1300 / 2560 - 0.5) / (720 / 2560));
  const c = handoffRect({ seconds: 4 }, { ...opts, cursorEnd: { x: 0.7, y: 0.8 } });
  near((c[0] + c[2]) / 2, 0.7);
  assert.equal(handoffRect({ seconds: 4 }, { ...opts, cursorEnd: null }), null);
  // 游標被推出畫面時不用它
  assert.equal(handoffRect({ seconds: 4 }, { ...opts, cursorEnd: { x: -0.1, y: 0.5 } }), null);
  // 螢光筆比點擊晚：從螢光筆劃的那段字長出來
  const m = handoffRect({ seconds: 4, clicks: [{ at: 1, to: "高雄市" }], marks: [{ at: 2, to: "複製連結" }] }, opts);
  near(m[0], 600 / 1280);
});

function round4(x) {
  return Math.round(x * 10000) / 10000;
}
