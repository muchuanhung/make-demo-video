// 配樂產生器的測試：node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";

import { cues, soundtrack, toWav, musicPlan } from "./soundtrack.mjs";

const rms = (s, sr, from, to) => {
  let sum = 0;
  const a = Math.round(from * sr), b = Math.round(to * sr);
  for (let i = a; i < b; i++) sum += s[i] * s[i];
  return Math.sqrt(sum / (b - a));
};

test("cues：每拍一個大鼓，換句時重拍，最後一句前四拍有上升音", () => {
  const c = cues({ duration: 4, beat: 0.4, starts: [0, 1.2, 2.8] });
  assert.deepEqual(c.kicks.map((t) => +t.toFixed(2)), [0, 0.4, 0.8, 1.2, 1.6, 2, 2.4, 2.8, 3.2, 3.6]);
  assert.deepEqual(c.hits, [1.2, 2.8]);
  assert.deepEqual(c.riser, { from: 1.2, to: 2.8 });
});

test("cues：只有一句時不加上升音；最後一句太前面時上升音從 0 開始", () => {
  assert.equal(cues({ duration: 3, beat: 0.4, starts: [0] }).riser, null);
  assert.deepEqual(cues({ duration: 3, beat: 0.4, starts: [0, 0.8] }).riser, { from: 0, to: 0.8 });
});

test("cues：有 drop 時上升音接到 drop、前兩拍抽掉大鼓，drop 之後的硬切各一記重拍", () => {
  const c = cues({ duration: 6, beat: 0.5, starts: [0, 1, 3, 4.5], drop: 3, accents: [3.5, 4] });
  assert.deepEqual(c.riser, { from: 1, to: 3 });
  assert.equal(c.drop, 3);
  // 2 與 2.5 秒的大鼓抽掉（drop 前兩拍），drop 那一拍照打
  assert.ok(!c.kicks.includes(2) && !c.kicks.includes(2.5));
  assert.ok(c.kicks.includes(1.5) && c.kicks.includes(3));
  // drop 本身不算一般重拍（另外打一記更重的）；accents 與其他句的起點都是重拍
  assert.deepEqual(c.hits, [1, 3.5, 4, 4.5]);
});

test("cues：沒有 drop、或 drop 在片頭片尾之外時照舊（上升音接到最後一句）", () => {
  const c = cues({ duration: 4, beat: 0.4, starts: [0, 1.2, 2.8], drop: 0 });
  assert.equal(c.drop, null);
  assert.deepEqual(c.riser, { from: 1.2, to: 2.8 });
  assert.equal(c.kicks.length, 10);
});

test("musicPlan：操作示範的 burst 第一拍是 drop，burst 裡每一張截圖的硬切是 accents", () => {
  const board = {
    duration: 8, beat: 0.5,
    rows: [{ start: 0, seconds: 3, shot: "home" }, { start: 3, seconds: 1.5, shot: "burst" }, { start: 4.5, seconds: 3.5, shot: "click" }],
    scenes: [{ seconds: 3, shot: "home" }, { seconds: 0.5, shot: "burst" }, { seconds: 0.5, shot: "burst" }, { seconds: 0.5, shot: "burst" }, { seconds: 3.5, shot: "click" }],
  };
  assert.deepEqual(musicPlan(board), { duration: 8, beat: 0.5, starts: [0, 3, 4.5], drop: 3, accents: [3.5, 4] });
  // 沒有 burst：沒有 drop
  const plain = musicPlan({ ...board, rows: [board.rows[0]], scenes: [board.scenes[0]] });
  assert.equal(plain.drop, null);
  assert.deepEqual(plain.accents, []);
});

test("soundtrack：drop 那一記比一般換句的重拍響，前兩拍（抽掉大鼓）比較空", () => {
  const sr = 8000;
  const s = soundtrack({ duration: 6, beat: 0.5, starts: [0, 1, 3], drop: 3, sampleRate: sr });
  assert.ok(rms(s, sr, 3, 3.3) > 1.2 * rms(s, sr, 1, 1.3), "drop 比一般重拍響");
  const plain = soundtrack({ duration: 6, beat: 0.5, starts: [0, 1, 3], sampleRate: sr });
  assert.ok(rms(s, sr, 2, 2.1) < rms(plain, sr, 2, 2.1), "drop 前兩拍沒有大鼓");
});

test("soundtrack：長度對、不爆音，同樣的輸入每次算出一樣的聲音", () => {
  const opts = { duration: 2, beat: 0.4, starts: [0, 1.2], sampleRate: 8000 };
  const a = soundtrack(opts), b = soundtrack(opts);
  assert.equal(a.length, 16000);
  assert.deepEqual(a, b);
  assert.ok(a.every((v) => Math.abs(v) <= 1));
});

test("soundtrack：大鼓落在拍點上（拍點比拍與拍之間響）", () => {
  const sr = 8000;
  const s = soundtrack({ duration: 2, beat: 0.4, starts: [0], sampleRate: sr });
  assert.ok(rms(s, sr, 0.4, 0.45) > 4 * rms(s, sr, 0.7, 0.75));
});

test("toWav：16 位元雙聲道 WAV，檔頭寫對", () => {
  const buf = toWav(new Float32Array([0, 0.5, -0.5, 1]), 8000);
  assert.equal(buf.length, 44 + 4 * 4);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt16LE(22), 2);
  assert.equal(buf.readUInt32LE(24), 8000);
  assert.equal(buf.readInt16LE(44 + 4 * 3), 32767);
});
