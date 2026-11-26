// 招牌片檢查的測試：node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { staticProblems, signatureProblems, textProblems, parsePsnr, resultLook } from "./signature.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = "# 腳本\n\n1. 去哪吃好\n2. 宵夜吃什麼？\n3. 打開去哪吃好就知道。\n4. 1,534 個地點\n";
const sig = (over = {}) => ({ concept: "一個點，長成一頓飯", width: 720, height: 1280, duration: 15, beat: 0.5, lines: [{ text: "打開去哪吃好就知道。", from: 9, to: 9.6 }], ...over });

test("staticProblems：骨架本身沒有違規", async () => {
  assert.deepEqual(staticProblems(await readFile(path.join(here, "../cuts/signature/kit.html"), "utf8")), []);
});

test("staticProblems：擋下 CSS 動畫、計時器、亂數、時鐘", () => {
  assert.equal(staticProblems(".a { animation: spin 1s }").length, 1);
  assert.equal(staticProblems(".a { transition: opacity .2s }").length, 1);
  assert.equal(staticProblems("setTimeout(f, 10)").length, 1);
  assert.equal(staticProblems("x = Math.random()").length, 1);
  assert.equal(staticProblems("t = Date.now()").length, 1);
});

test("signatureProblems：設定正確時沒有問題", () => {
  assert.deepEqual(signatureProblems(sig(), SCRIPT), []);
});

test("signatureProblems：概念沒寫、關鍵句不在腳本、停不到 0.5 秒都擋下", () => {
  assert.match(signatureProblems(sig({ concept: "（一行概念）" }), SCRIPT)[0], /concept/);
  assert.match(signatureProblems(sig({ lines: [{ text: "打開就知道", from: 9, to: 10 }] }), SCRIPT).join(), /不在 script\.md/);
  assert.match(signatureProblems(sig({ lines: [{ text: "1,534 個地點", from: 9, to: 9.4 }] }), SCRIPT).join(), /只有 0\.40 秒/);
  assert.match(signatureProblems(sig({ lines: [] }), SCRIPT).join(), /lines 是空的/);
});

test("signatureProblems：長度要是半小節的整數倍", () => {
  assert.match(signatureProblems(sig({ duration: 14.2 }), SCRIPT).join(), /半小節/);
  assert.deepEqual(signatureProblems(sig({ duration: 15 }), SCRIPT), []);
});

test("textProblems：腳本裡的字、拆開的字、數字跳動的中間值都可以", () => {
  assert.deepEqual(textProblems(["去", "哪", "宵夜吃什", "1,382", "93.9%", "打開去哪吃好\n就知道。"], SCRIPT), []);
});

test("textProblems：自己加的字擋下，列在 extra 的可以", () => {
  assert.equal(textProblems(["晨光早午餐"], SCRIPT).length, 1);
  assert.deepEqual(textProblems(["example.com"], SCRIPT, ["example.com"]), []);
});

test("parsePsnr：讀出平均值，完全一樣是 Infinity", () => {
  assert.equal(parsePsnr("[Parsed_psnr_0] PSNR y:40.1 u:41 v:42 average:41.23 min:39 max:43"), 41.23);
  assert.equal(parsePsnr("PSNR y:inf u:inf v:inf average:inf min:inf max:inf"), Infinity);
  assert.equal(parsePsnr("nothing"), null);
});

test("resultLook：結果頁標題是腳本第一句、網址取 extra、顏色取 reel.html 的 COL，拍數取代幕數", () => {
  const sig = { concept: "一條線", width: 720, height: 1280, duration: 15, beat: 0.5, extra: ["kinutabi.jp"] };
  const look = { col: { bg: "#F2EEE4", ink: "#23392F", accent: "#A64036", white: "#ffffff" }, font: '"Noto Sans TC"', fontUrl: "https://fonts.googleapis.com/css2?family=Noto+Sans+TC" };
  const { board, style } = resultLook(sig, look, "# 腳本\n1. KINU TABI\n2. 第一次穿和服？\n");
  assert.equal(board.title, "KINU TABI");
  assert.equal(board.url, "https://kinutabi.jp");
  assert.equal(board.count, "30 拍");
  assert.equal(board.portrait, true);
  assert.equal(style.colors.bg, "#F2EEE4");
  assert.equal(style.colors.text, "#23392F");
  assert.equal(style.colors.accent, "#A64036");
  // 拿不到 COL 時用預設色，結果頁照樣產生
  assert.equal(resultLook(sig, null, "").style.colors.bg, "#f3efe6");
  assert.equal(resultLook({ ...sig, extra: [] }, null, "").board.url, undefined);
});
