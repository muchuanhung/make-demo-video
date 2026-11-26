// 鏡頭模板展開與自動檢查的測試：node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { expandShots, lintShots, findAnchor, readingUnits, holdNeeded } from "./shots.mjs";

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

test("stat：拆解數字的前後綴、小數位與千分位；看不懂的字回傳 null", async () => {
  const { parseStat } = await import("./shots.mjs");
  assert.deepEqual(parseStat("1,534"), { prefix: "", to: 1534, decimals: 0, group: true, suffix: "" });
  assert.deepEqual(parseStat("6,000+"), { prefix: "", to: 6000, decimals: 0, group: true, suffix: "+" });
  assert.deepEqual(parseStat("96.8%"), { prefix: "", to: 96.8, decimals: 1, group: false, suffix: "%" });
  assert.deepEqual(parseStat("$1.2M"), { prefix: "$", to: 1.2, decimals: 1, group: false, suffix: "M" });
  assert.deepEqual(parseStat("4.8 分"), { prefix: "", to: 4.8, decimals: 1, group: false, suffix: " 分" });
  assert.equal(parseStat("很多"), null);
  assert.equal(parseStat("1 到 3"), null);
});

test("stat：展開成 stat 幕，預設 4 拍、深色底、從 0 開始跳（start 可以改）；value 看不懂或沒寫時報錯", () => {
  const { scenes, problems } = expand([
    { shot: "hook", heading: "去哪吃好" },
    { shot: "stat", value: "1,534", heading: "個地點" },
    { shot: "stat", value: "96.8%", start: 50, heading: "好評", tone: "accent" },
  ]);
  assert.deepEqual(problems, []);
  assert.equal(scenes[1].kind, "stat");
  assert.equal(scenes[1].seconds, 1.6);
  assert.equal(scenes[1].tone, "invert");
  assert.deepEqual(scenes[1].count, { prefix: "", to: 1534, decimals: 0, group: true, suffix: "", from: 0 });
  assert.equal(scenes[2].count.from, 50);

  assert.match(expand([{ shot: "stat", value: "很多", heading: "使用者" }]).problems.join(), /看不懂/);
  assert.match(expand([{ shot: "stat", heading: "使用者" }]).problems.join(), /少了 value/);
});

test("stat：數字跳完（0.1＋0.9 秒）後要停夠 0.5 秒，3 拍太短會提醒", () => {
  const short = expand([{ shot: "stat", value: "1,534", heading: "個地點", beats: 3 }]);
  assert.match(lintShots(short).map((w) => w.message).join(), /只停 0\.20 秒/);
  const ok = expand([{ shot: "stat", value: "1,534", heading: "個地點" }]);
  assert.equal(lintShots(ok).filter((w) => w.row === 0).length, 0);
});

test("phoneScale：寫了就帶給播放器（只作用在那一幕），沒寫就不帶", () => {
  const { scenes } = expand([
    { shot: "feature", heading: "曉行 Dawnline", image: "project.png", phoneScale: 0.85 },
    { shot: "content", heading: "寫下來，才算真的想過。", image: "home.png" },
  ]);
  assert.equal(scenes[0].phoneScale, 0.85);
  assert.equal("phoneScale" in scenes[1], false);
});

test("閱讀量：中文一字一個、英文與數字一個詞一個，粗體記號與標點不算", () => {
  assert.equal(readingUnits("上傳照片，\n**先 AI 試穿**"), 8);
  assert.equal(readingUnits("曉行 Dawnline"), 3);
  assert.equal(readingUnits("AI STYLING", ["上傳照片", "腰帶"]), 8);
  assert.equal(readingUnits(undefined, []), 0);
  // 字少時至少 0.5 秒；字多時照字數，12 字 0.72 秒、20 字 1.2 秒
  assert.equal(holdNeeded(4), 0.5);
  assert.equal(holdNeeded(12), 0.72);
  assert.equal(holdNeeded(20), 1.2);
});

test("停留時間照字數算：字多的標題停不夠時，提醒要加幾拍", () => {
  const long = expand([{ shot: "content", heading: "選方案、預約付款、到店體驗一次搞定", image: "home.png", beats: 3, to: "x" }]);
  const msg = lintShots(long).filter((w) => w.row === 0).map((w) => w.message).join();
  assert.match(msg, /15 個字要停 0\.90 秒才讀得完；加 1 拍/);
  // 同一句給夠拍數就不提醒停留時間
  const ok = expand([{ shot: "content", heading: "選方案、預約付款、到店體驗一次搞定", image: "home.png", beats: 5, to: "x" }]);
  assert.doesNotMatch(lintShots(ok).map((w) => w.message).join(), /讀得完/);
});

test("一幕只講一件事：標題太長、或標題加小標與標籤總共超過 16 個字就提醒；名字加技術標籤這種短的不算", () => {
  const dense = expand([{ shot: "feature", kicker: "AI STYLING", heading: "上傳照片，\n**先 AI 試穿**", tags: ["上傳照片", "腰帶", "情侶", "收藏"], image: "home.png", to: "x", beats: 8 }]);
  assert.match(lintShots(dense).map((w) => w.message).join(), /這一幕字太多（標題 8 個字，小標、標籤 12 個）/);
  const long = expand([{ shot: "hook", heading: "第一次穿和服也可以很從容的旅程體驗開始" }]);
  assert.match(lintShots(long).map((w) => w.message).join(), /標題 19 個字，快節奏一眼讀不完/);
  const named = expand([{ shot: "feature", kicker: "01 / AI・2026", heading: "曉行 Dawnline", tags: ["GPX", "Next.js", "TypeScript", "Strava API", "Weather"], image: "home.png", to: "x" }]);
  assert.doesNotMatch(lintShots(named).map((w) => w.message).join(), /字太多/);
  // 結尾放名字、網址，不算
  const outro = expand([{ shot: "outro", heading: "穿上一段屬於你的日本旅程，從東京到京都的和服體驗" }]);
  assert.doesNotMatch(lintShots(outro).map((w) => w.message).join(), /一眼讀不完/);
});
