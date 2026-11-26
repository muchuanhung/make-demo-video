// 分鏡表讀取與欄位檢查（loadStoryboard）的測試：node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadStoryboard, fullPageSlices } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** 在暫存資料夾寫一份只有一幕手機鏡頭的分鏡表（截圖借用剪法縮圖），回傳分鏡表路徑。 */
async function phoneBoard(phoneScale) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mdv-lib-"));
  await copyFile(path.join(here, "../cuts/fast-tour/thumb.png"), path.join(dir, "shot.png"));
  const file = path.join(dir, "storyboard.json");
  const scene = { kind: "phone", seconds: 2, heading: "標題", image: "shot.png", ...(phoneScale === undefined ? {} : { phoneScale }) };
  await writeFile(file, JSON.stringify({ aspect: "9:16", scenes: [scene] }));
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("phoneScale：0.4–1.2 的數字可以用，沒寫也可以", async () => {
  for (const value of [undefined, 0.4, 0.85, 1.2]) {
    const { file, cleanup } = await phoneBoard(value);
    try {
      const board = await loadStoryboard(file);
      assert.equal(board.scenes[0].phoneScale, value);
    } finally {
      await cleanup();
    }
  }
});

test("phoneScale：超出範圍或不是數字時擋下，並說明範圍", async () => {
  for (const value of [0.3, 1.5, "0.8"]) {
    const { file, cleanup } = await phoneBoard(value);
    try {
      await assert.rejects(loadStoryboard(file), /phoneScale 要是 0\.4–1\.2 的數字/);
    } finally {
      await cleanup();
    }
  }
});

test("fullPageSlices：長圖在瀏覽器的單張上限內就一次截完", () => {
  assert.deepEqual(fullPageSlices(5821, 1), [{ y: 0, height: 5821 }]);
  assert.deepEqual(fullPageSlices(8000, 2), [{ y: 0, height: 8000 }]);
});

test("fullPageSlices：超過上限（手機 2 倍圖 8524 高）時分段，每段乘上倍率不超過上限，接起來剛好是整頁", () => {
  const slices = fullPageSlices(8524, 2);
  assert.ok(slices.length > 1);
  for (const s of slices) assert.ok(s.height * 2 <= 16000, `一段 ${s.height} 太高`);
  assert.equal(slices[0].y, 0);
  for (let i = 1; i < slices.length; i++) assert.equal(slices[i].y, slices[i - 1].y + slices[i - 1].height);
  const last = slices.at(-1);
  assert.equal(last.y + last.height, 8524);
});
