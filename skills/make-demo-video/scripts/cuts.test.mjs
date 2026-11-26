// 剪法包（cuts/<id>/）的格式檢查：剪法只能組合現有的鏡頭模板，寫了算圖器沒有的鏡頭就擋下來。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SHOTS } from "./shots.mjs";

const CUTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../cuts");
const SECTIONS = ["## 腳本", "## 鏡頭順序", "## 拍數"];
// 生成式剪法（mode: "generate"）不用鏡頭模板，由 Claude 照 kit.html 寫一份 reel.html
const GENERATE_SECTIONS = ["## 腳本", "## 概念", "## 逐拍", "## 檢查與修改"];

const ids = (await readdir(CUTS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

test("至少有一包剪法", () => {
  assert.ok(ids.length > 0);
});

for (const id of ids) {
  test(`剪法 ${id}：meta.json 欄位齊全、鏡頭都存在`, async () => {
    const meta = JSON.parse(await readFile(path.join(CUTS, id, "meta.json"), "utf8"));
    assert.equal(meta.id, id, "meta.json 的 id 要跟資料夾同名");
    for (const key of ["name", "description", "suits", "needs"]) {
      assert.ok(typeof meta[key] === "string" && meta[key], `少了 ${key}`);
    }
    assert.ok(Number.isInteger(meta.version) && meta.version > 0, "version 要是正整數");
    assert.ok([undefined, "generate"].includes(meta.mode), "mode 只能不寫或是 generate");
    assert.ok([undefined, true].includes(meta.fixedShots), "fixedShots 只能不寫或是 true");
    if (meta.aspects !== undefined) {
      assert.ok(
        Array.isArray(meta.aspects) && meta.aspects.length > 0 && meta.aspects.every((x) => ["16:9", "9:16"].includes(x)),
        "aspects 只能不寫，或是 16:9、9:16 組成的清單",
      );
      assert.ok(!meta.defaults?.aspect || meta.aspects.includes(meta.defaults.aspect), "defaults.aspect 要在 aspects 裡");
    }
    if (meta.mode === "generate") {
      assert.ok(existsSync(path.join(CUTS, id, "kit.html")), "生成式剪法要附 kit.html 骨架");
      return;
    }
    assert.ok(Array.isArray(meta.shots) && meta.shots.length > 0, "shots 不能是空的");
    const unknown = meta.shots.filter((s) => !(s in SHOTS));
    assert.deepEqual(unknown, [], `鏡頭表裡沒有：${unknown.join("、")}`);
  });

  test(`剪法 ${id}：cut.md 有必要的段落`, async () => {
    const file = path.join(CUTS, id, "cut.md");
    assert.ok(existsSync(file), "少了 cut.md");
    const text = await readFile(file, "utf8");
    const meta = JSON.parse(await readFile(path.join(CUTS, id, "meta.json"), "utf8"));
    for (const heading of meta.mode === "generate" ? GENERATE_SECTIONS : SECTIONS) assert.ok(text.includes(heading), `cut.md 少了「${heading}」`);
  });
}
