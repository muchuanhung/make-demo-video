// 鏡頭模板展開與自動檢查的測試：node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandShots, lintShots, findAnchor } from "./shots.mjs";

const anchors = {
  "home.png": [{ text: "把想法 做成真的。", y: 0.02 }, { text: "做過一些 有意思的事。", y: 0.24 }, { text: "寫下來，才算真的想過。", y: 0.62 }],
  "home-dark.png": [{ text: "把想法 做成真的。", y: 0.02 }, { text: "做過一些 有意思的事。", y: 0.24 }],
  "project.png": [{ text: "曉行 Dawnline", y: 0.03 }, { text: "技術", y: 0.46 }, { text: "相關作品", y: 0.75 }],
};
const board = (scenes, extra = {}) => ({ beat: 0.4, scenes, ...extra });
const expand = (scenes, extra) => expandShots(board(scenes, extra), { anchorsOf: (img) => anchors[img] || null });

test("findAnchor：忽略空白、標點與換行，回傳最上面的那一個", () => {
  assert.equal(findAnchor(anchors["home.png"], "把想法\n**做成真的。**").y, 0.02);
  assert.equal(findAnchor(anchors["project.png"], "相關作品").y, 0.75);
  assert.equal(findAnchor(anchors["project.png"], "不存在的字"), null);
});

test("節拍：沒寫秒數時用模板的預設拍數 × beat；寫了 beats 就用 beats", () => {
  const { scenes } = expand([
    { shot: "hook", heading: "把想法\n做成真的。" },
    { shot: "card", heading: "曉行 Dawnline", beats: 3 },
  ]);
  assert.equal(scenes[0].seconds, 1.2);
  assert.equal(scenes[1].seconds, 1.2);
});

test("轉場預設：開場後 push、手機後的作品卡 zoom、作品卡接作品卡 flash、結尾 iris", () => {
  const { scenes } = expand([
    { shot: "hook", heading: "把想法做成真的。" },
    { shot: "intro", heading: "洪睦筌", image: "home-dark.png" },
    { shot: "card", heading: "曉行 Dawnline" },
    { shot: "card", heading: "Weather Board" },
    { shot: "outro", heading: "洪睦筌" },
  ]);
  assert.deepEqual(scenes.map((s) => s.transition), ["cut", "push", "zoom", "flash", "iris"]);
  assert.deepEqual(scenes.map((s) => s.tone), ["accent", "invert", "invert", "accent", "accent"]);
});

test("跨鏡頭銜接：intro 的手機先停在上一句出現的位置，後半才捲到 to", () => {
  const { scenes } = expand([
    { shot: "hook", heading: "把想法\n做成真的。" },
    { shot: "intro", heading: "洪睦筌", image: "home-dark.png", to: "做過一些有意思的事" },
  ]);
  const keys = scenes[1].scroll;
  assert.equal(keys[0].a, 0.02);
  // 前 45% 只慢慢捲一點點（不是死停，也不是馬上捲走）
  assert.ok(keys[1].at >= 0.4);
  assert.ok(keys[1].a > 0.02 && keys[1].a < 0.05, JSON.stringify(keys));
  assert.equal(keys.at(-1).a, 0.24);
});

test("狀態切換：一句話展開成兩幕（切換前、斜切到切換後），第二幕的字已經在畫面上", () => {
  const { scenes, rows } = expand([
    { shot: "hook", heading: "把想法做成真的。" },
    { shot: "toggle", heading: "切換深色／淺色模式", pill: "☾ 深色／淺色 ☀", image: "home-dark.png", after: "home.png" },
  ]);
  assert.equal(scenes.length, 3);
  assert.equal(rows.length, 2);
  const [before, after] = scenes.slice(1);
  assert.equal(before.image, "home-dark.png");
  assert.equal(before.tone, "invert");
  assert.equal(after.image, "home.png");
  assert.equal(after.transition, "wipe");
  assert.equal(after.tone, "base");
  assert.equal(after.settled, true);
  assert.equal(rows[1].start, 1.2);
  assert.equal(Math.round((before.seconds + after.seconds) * 100) / 100, rows[1].seconds);
});

test("舊格式（只有 kind、沒有 shot）原樣通過", () => {
  const old = { kind: "browser", seconds: 5, image: "shot-1.png", caption: "字幕" };
  const { scenes } = expand([old]);
  assert.deepEqual(scenes[0], { ...old, row: 0 });
});

test("檢查：錨點找不到是錯誤，並列出截圖裡有的字", () => {
  const { problems } = expand([{ shot: "feature", heading: "出發前判讀", image: "project.png", to: "不存在" }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /第 1 幕.*「不存在」/);
  assert.match(problems[0], /相關作品/);
});

test("檢查：toggle 少了 after、模板名稱打錯都是錯誤", () => {
  assert.match(expand([{ shot: "toggle", heading: "a", image: "home.png" }]).problems[0], /after/);
  assert.match(expand([{ shot: "nope", heading: "a" }]).problems[0], /shot 只能是/);
});

test("檢查：標題出完後停留不到 0.5 秒會警告", () => {
  const b = expand([{ shot: "intro", heading: "洪睦筌", image: "home.png" }, { shot: "card", heading: "曉行 Dawnline", beats: 1 }]);
  const w = lintShots(b);
  assert.ok(w.some((x) => x.row === 1 && /0\.5 秒/.test(x.message)), JSON.stringify(w));
});

test("檢查：相鄰兩個手機鏡頭用同一張圖又同一個版面會警告；同一種模板連用 3 次會警告", () => {
  const b = expand([
    { shot: "content", heading: "甲", image: "home.png", to: "做過一些" },
    { shot: "content", heading: "乙", image: "home.png", to: "寫下來" },
    { shot: "content", heading: "丙", image: "project.png" },
  ]);
  const w = lintShots(b);
  assert.ok(!w.some((x) => x.row === 1 && /同一張截圖/.test(x.message)), "捲到不同段落不算重複：" + JSON.stringify(w));
  assert.ok(w.some((x) => x.row === 2 && /連續 3 幕/.test(x.message)), JSON.stringify(w));
});

test("檢查：手機鏡頭的字在截圖裡找不到、也沒寫 to，提醒畫面沒有對上這句話；toggle 的證據是切換本身，不檢查", () => {
  const w = lintShots(expand([{ shot: "content", heading: "完全無關的一句", image: "home.png" }]));
  assert.ok(w.some((x) => /對應/.test(x.message)), JSON.stringify(w));
  const t = lintShots(expand([{ shot: "toggle", heading: "切換深淺色", image: "home-dark.png", after: "home.png" }]));
  assert.ok(!t.some((x) => /對應/.test(x.message)), JSON.stringify(t));
});

test("檢查：同一種底色連續超過 3 幕會警告", () => {
  const w = lintShots(expand([1, 2, 3, 4].map((n) => ({ shot: "card", heading: "卡片" + n, tone: "base" }))));
  assert.ok(w.some((x) => x.row === 3 && /底色/.test(x.message)), JSON.stringify(w));
});

test("檢查：平均一個鏡頭超過 1.6 秒會警告節奏太慢", () => {
  const w = lintShots(expand([{ shot: "card", heading: "a", seconds: 3 }, { shot: "card", heading: "b", seconds: 3 }]));
  assert.ok(w.some((x) => x.row === null && /平均/.test(x.message)), JSON.stringify(w));
});

test("狀態切換不自動銜接上一句（避免停在前一張作品卡的段落），沒寫 to 就停在頂端", () => {
  const { scenes } = expand([
    { shot: "card", heading: "做過一些有意思的事" },
    { shot: "toggle", heading: "切換深淺色", image: "home-dark.png", after: "home.png" },
  ]);
  assert.equal(scenes[1].scroll[0].y, 0);
  // 斜切那一刻兩張圖停在同一個位置，之後繼續慢慢捲
  assert.equal(scenes[1].scroll.at(-1).y, scenes[2].scroll[0].y);
  assert.ok(scenes[2].scroll.at(-1).y > scenes[2].scroll[0].y);
});

test("單頁網站：同一張長圖、捲到差不多的位置才警告", () => {
  const w = lintShots(expand([
    { shot: "content", heading: "甲", image: "home.png", to: "寫下來" },
    { shot: "content", heading: "乙", image: "home.png", to: "寫下來" },
  ]));
  assert.ok(w.some((x) => x.row === 1 && /同一張截圖/.test(x.message)), JSON.stringify(w));
});

test("findAnchor：完全相同優先，其次是錨點包含整句，最後才是被包含", () => {
  const list = [{ text: "日出", y: 0.1 }, { text: "日出與日落", y: 0.3 }, { text: "日出與日落與紫外線指數說明", y: 0.5 }];
  assert.equal(findAnchor(list, "日出與日落").y, 0.3);
  assert.equal(findAnchor(list, "日出與日落與紫外線").y, 0.5);
  assert.equal(findAnchor(list, "看日出").y, 0.1);
});

test("作品卡：寫了 align: center 就帶給 player（卡片與字整組置中），沒寫就不帶", () => {
  const { scenes } = expand([
    { shot: "card", heading: "曉行 Dawnline", align: "center" },
    { shot: "card", heading: "Weather Board" },
  ]);
  assert.equal(scenes[0].align, "center");
  assert.equal(scenes[1].align, undefined);
});
